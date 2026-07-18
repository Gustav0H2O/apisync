import jwt from 'jsonwebtoken';
import { getConnection } from '../_db.js';
import { requireJwtSecret } from '../_helpers.js';
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

        if (!isPlaceholder && clientEmail !== normalizedEmail) {
            return res.status(409).json({ error: 'already_used' });
        }

        let accountEmail = isPlaceholder ? normalizedEmail : clientEmail;

        if (!usado) {
            // Ganador atómico de la activación
            const [result] = await connection.execute(
                `UPDATE licencias SET usado = 1, fecha_activacion = datetime('now')
                 WHERE license_key = ? AND usado = 0`,
                [license_key]
            );
            const won = Number(result.affectedRows || 0) === 1;
            if (won) {
                if (isPlaceholder) {
                    await connection.execute(
                        `UPDATE clientes SET email = ? WHERE id = ?`,
                        [normalizedEmail, lic.cliente_id]
                    );
                }
                if (tipo === 'saas') {
                    await connection.execute(
                        `UPDATE detalles_saas SET last_check = datetime('now') WHERE licencia_id = ?`,
                        [lic.lic_id]
                    );
                }
            }
            // Si no ganó, otro dispositivo activó en paralelo: continúa como
            // re-activación (el correo ya fue validado arriba).
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
             ON CONFLICT(device_id) DO UPDATE SET
               license_key = excluded.license_key, name = excluded.name,
               revoked = 0, last_seen = datetime('now')`,
            [device_id, license_key, device_name || 'Nuevo Dispositivo']
        );

        const saasExpiration = tipo === 'saas' && lic.fecha_vencimiento
            ? new Date(lic.fecha_vencimiento).toISOString()
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
