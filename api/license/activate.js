import jwt from 'jsonwebtoken';
import { getConnection } from '../_db.js';
import { requireJwtSecret, applyCors, parseExpirationDate } from '../_helpers.js';
import { signLicensePayload } from './_sign.js';

const DEFAULT_MAX_DEVICES = 2;

// Rate-limit por IP: 5/min (mejor esfuerzo en memoria de la lambda caliente).
const rateBuckets = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const bucket = rateBuckets.get(ip) || [];
    const recent = bucket.filter(t => now - t < 60_000);
    recent.push(now);
    rateBuckets.set(ip, recent);
    return recent.length > 5;
}

/**
 * POST /api/license/activate  (sin token — bootstrap)
 *
 * ← { license_key, email, device_id, device_name }
 * → 200 { status:'activated', license_type, saas_expiration, token,
 *         signed_payload, signature }
 * → 404 { error:'not_found' } | 409 { error:'already_used' }
 * → 423 { error:'device_limit' } | 429 rate-limit
 *
 * Activación ATÓMICA (mata S9): `UPDATE ... WHERE usado = 0` — de dos
 * dispositivos simultáneos exactamente UNO gana; el otro cae a la rama de
 * re-activación (mismo correo) o a `already_used`.
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) {
        return res.status(429).json({ error: 'too_many_requests', retry_after_seconds: 60 });
    }

    const { license_key, email, device_id, device_name } = req.body || {};
    if (!license_key || !email || !device_id) {
        return res.status(400).json({ error: 'missing_params' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    try {
        const connection = getConnection();

        const [rows] = await connection.execute(
            `SELECT l.id AS lic_id, l.tipo, l.usado, l.cliente_id,
                    COALESCE(l.max_devices_allowed, ?) AS max_devices,
                    c.email AS client_email, ds.fecha_vencimiento
             FROM licencias l
             JOIN clientes c ON l.cliente_id = c.id
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE l.license_key = ? LIMIT 1`,
            [DEFAULT_MAX_DEVICES, license_key]
        );
        if (!rows.length) return res.status(404).json({ error: 'not_found' });

        const lic = rows[0];
        const tipo = String(lic.tipo || 'unique').trim().toLowerCase();
        const clientEmail = String(lic.client_email || '').trim().toLowerCase();
        const isPlaceholder = clientEmail.startsWith('placeholder-');
        const usado = Number(lic.usado) === 1;
        const maxDevices = Number(lic.max_devices) || DEFAULT_MAX_DEVICES;

        if (clientEmail && !isPlaceholder && clientEmail !== normalizedEmail) {
            return res.status(409).json({
                error: 'already_used',
                message: 'Esta licencia ya fue activada con otro correo electrónico.'
            });
        }

        const expDate = parseExpirationDate(lic.fecha_vencimiento);
        if (tipo === 'saas') {
            if (!expDate || expDate < new Date()) {
                return res.status(403).json({
                    error: 'expired',
                    message: 'Esta licencia está vencida. Adquiere una nueva clave o renueva tu suscripción.'
                });
            }
        }

        let accountEmail = isPlaceholder ? normalizedEmail : clientEmail;
        let effectiveClienteId = Number(lic.cliente_id);

        if (isPlaceholder && normalizedEmail && !normalizedEmail.startsWith('placeholder-')) {
            // Renovación con clave nueva y correo que YA tiene cliente:
            // `clientes.email` es UNIQUE, así que un UPDATE directo revienta
            // con 500 y la renovación queda sin efecto. Se hace MERGE: la
            // licencia se re-apunta al cliente real y el placeholder vacío se
            // elimina (guardado: nunca borrar un cliente que aún tenga licencias).
            const [dupRows] = await connection.execute(
                `SELECT id FROM clientes WHERE LOWER(TRIM(email)) = ? AND id != ? LIMIT 1`,
                [normalizedEmail, lic.cliente_id]
            );
            if (dupRows.length) {
                effectiveClienteId = Number(dupRows[0].id);
                await connection.execute(
                    `UPDATE licencias SET cliente_id = ? WHERE id = ?`,
                    [effectiveClienteId, lic.lic_id]
                );
                await connection.execute(
                    `DELETE FROM clientes WHERE id = ? AND NOT EXISTS (
                       SELECT 1 FROM licencias WHERE cliente_id = ? AND id != ?)`,
                    [lic.cliente_id, lic.cliente_id, lic.cliente_id]
                );
            } else {
                await connection.execute(
                    `UPDATE clientes SET email = ? WHERE id = ?`,
                    [normalizedEmail, lic.cliente_id]
                );
            }
            accountEmail = normalizedEmail;
        }

        // ── Reglas de identidad de la cuenta ────────────────────────────────
        // El par (correo, licencia) identifica UNA cuenta, y sus equipos se
        // agregan VINCULÁNDOSE desde uno ya autorizado. Un equipo que fue
        // desvinculado queda fuera: no puede reactivarse por esta vía con la
        // misma licencia ni con otra del mismo negocio; solo el administrador
        // puede volver a autorizarlo (reactivación en Turso o vinculación).
        const [wasRevoked] = await connection.execute(
            `SELECT 1 AS x FROM devices d
               JOIN licencias l ON l.license_key = d.license_key
              WHERE l.cliente_id = ? AND d.device_id = ? AND d.revoked = 1
              LIMIT 1`,
            [effectiveClienteId, device_id]
        );
        if (wasRevoked.length) {
            return res.status(409).json({
                error: 'device_revoked',
                message: 'Este equipo fue desvinculado de la cuenta. Pide al '
                    + 'administrador que lo autorice de nuevo, o activa una '
                    + 'cuenta distinta.',
            });
        }

        if (!usado) {
            // Ganador atómico de la activación
            const [result] = await connection.execute(
                `UPDATE licencias SET usado = 1, fecha_activacion = datetime('now')
                 WHERE license_key = ? AND usado = 0`,
                [license_key]
            );
            const won = Number(result.affectedRows || 0) === 1;
            if (won && tipo === 'saas') {
                await connection.execute(
                    `UPDATE detalles_saas SET last_check = datetime('now') WHERE licencia_id = ?`,
                    [lic.lic_id]
                );
            }
        }

        // Si este cliente renueva y tiene otros dispositivos activos en una licencia previa,
        // migrarlos atómicamente a la nueva clave para sincronización inmediata.
        // v49: a prueba de colisiones de PK compuesta (license_key, device_id):
        // primero se eliminan las filas destino que colisionarían.
        // Nota: usa effectiveClienteId — tras el merge de renovación, la clave
        // vieja y la nueva comparten cliente (antes cada placeholder tenía el
        // suyo y la migración no encontraba nada).
        try {
            await connection.execute(
                `DELETE FROM devices WHERE license_key = ? AND device_id IN (
                     SELECT device_id FROM devices WHERE revoked = 0 AND license_key IN (
                       SELECT license_key FROM licencias WHERE cliente_id = ? AND license_key != ?
                     ))`,
                [license_key, effectiveClienteId, license_key]
            );
            await connection.execute(
                `UPDATE devices SET license_key = ?, revoked = 0, revoked_at = NULL, last_seen = datetime('now')
                 WHERE revoked = 0 AND license_key IN (
                   SELECT license_key FROM licencias WHERE cliente_id = ? AND license_key != ?
                 )`,
                [license_key, effectiveClienteId, license_key]
            );
        } catch (_) {}

        // La licencia ya está en uso por OTRO equipo: este debe VINCULARSE, no
        // activarse como si fuera nuevo. Así el par correo+licencia se mantiene
        // único y el alta de equipos pasa siempre por el administrador.
        if (usado) {
            const [mine] = await connection.execute(
                `SELECT 1 AS x FROM devices
                  WHERE license_key = ? AND device_id = ? AND revoked = 0
                  LIMIT 1`,
                [license_key, device_id]
            );
            if (!mine.length) {
                const [activeRows] = await connection.execute(
                    `SELECT COUNT(*) AS c FROM devices
                      WHERE license_key = ? AND revoked = 0`,
                    [license_key]
                );
                if (Number(activeRows[0]?.c || 0) > 0) {
                    return res.status(409).json({
                        error: 'already_used',
                        message: 'Esta licencia ya está en uso. Para usar este '
                            + 'equipo, vincúlalo desde un dispositivo '
                            + 'autorizado (Código QR o vinculación manual).',
                    });
                }
            }
        }

        // Registro del dispositivo con límite (423 = device_limit)
        const [active] = await connection.execute(
            `SELECT COUNT(*) AS c FROM devices
             WHERE license_key = ? AND revoked = 0 AND device_id != ?`,
            [license_key, device_id]
        );
        if (Number(active[0]?.c || 0) >= maxDevices) {
            return res.status(423).json({ error: 'device_limit' });
        }

        await connection.execute(
            `INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked)
             VALUES (?, ?, ?, datetime('now'), datetime('now'), 0)
             ON CONFLICT(license_key, device_id) DO UPDATE SET
               name = excluded.name,
               revoked = 0, revoked_at = NULL, last_seen = datetime('now'), paired_at = datetime('now')`,
            [device_id, license_key, device_name || 'Nuevo Dispositivo']
        );

        const saasExpiration = tipo === 'saas' && expDate
            ? expDate.toISOString()
            : null;

        const token = jwt.sign(
            { licenseKey: license_key, deviceId: device_id, email: accountEmail },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        const { signed_payload, signature } = signLicensePayload({
            licenseKey: license_key,
            deviceId: device_id,
            licenseType: tipo,
            saasExpiration,
        });

        return res.status(200).json({
            status: 'activated',
            license_type: tipo,
            saas_expiration: saasExpiration,
            token,
            signed_payload,
            signature,
        });
    } catch (e) {
        console.error('❌ [License Activate Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
