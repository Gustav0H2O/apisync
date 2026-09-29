import jwt from 'jsonwebtoken';
import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret, applyCors, parseExpirationDate } from '../_helpers.js';
import { signLicensePayload } from './_sign.js';

/**
 * GET /api/license/status  (auth JWT) — validación de licencia con payload
 * firmado para el modo offline (INFORME_SEGURIDAD_ENDPOINTS.md §3).
 *
 * → 200 { status:'active|expired|revoked', license_type, saas_expiration,
 *         signed_payload, signature, signed_at }
 *
 * La revocación se responde con 200 + status:'revoked' (no 401) para que el
 * cliente la distinga de una sesión expirada.
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    try {
        const connection = getConnection();

        const reqEmail = String(req.query?.email || req.headers['x-account-email'] || '').trim().toLowerCase();
        const tokenEmail = String(user.email || '').trim().toLowerCase();
        const tokenLicense = String(user.licenseKey || '').trim().toUpperCase();

        let [rows] = await connection.execute(
            `SELECT l.id AS lic_id, l.license_key, l.tipo, l.usado, c.email AS client_email,
                    ds.fecha_vencimiento
             FROM licencias l
             JOIN clientes c ON l.cliente_id = c.id
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE UPPER(TRIM(l.license_key)) = ? LIMIT 1`,
            [tokenLicense]
        );

        const currentLic = rows[0];
        const clientEmail = String(currentLic?.client_email || '').trim().toLowerCase();
        const searchEmail = (reqEmail && !reqEmail.startsWith('placeholder-'))
            ? reqEmail
            : ((tokenEmail && !tokenEmail.startsWith('placeholder-'))
                ? tokenEmail
                : (!clientEmail.startsWith('placeholder-') ? clientEmail : ''));

        // Si la licencia del token no existe o está vencida, y tenemos un email válido:
        // Buscar si existe otra licencia vigente (renovada o vitalicia) para esta misma cuenta de email.
        const currentExp = currentLic ? parseExpirationDate(currentLic.fecha_vencimiento) : null;
        const isCurrentExpired = !currentLic || (String(currentLic.tipo).toLowerCase() === 'saas' && currentExp && currentExp < new Date());

        let adoptedLicense = false;
        if (isCurrentExpired && searchEmail) {
            const [activeRows] = await connection.execute(
                `SELECT l.id AS lic_id, l.license_key, l.tipo, l.usado, c.email AS client_email,
                        ds.fecha_vencimiento
                 FROM licencias l
                 JOIN clientes c ON l.cliente_id = c.id
                 LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
                 WHERE LOWER(TRIM(c.email)) = ? AND l.usado = 1
                 ORDER BY CASE WHEN LOWER(TRIM(l.tipo)) = 'unique' THEN '9999-12-31' ELSE COALESCE(ds.fecha_vencimiento, '1970-01-01') END DESC, l.id DESC LIMIT 1`,
                [searchEmail]
            );
            if (activeRows.length) {
                const candidateExp = parseExpirationDate(activeRows[0].fecha_vencimiento);
                const candidateTipo = String(activeRows[0].tipo || '').toLowerCase();
                const isCandidateValid = candidateTipo === 'unique' || (candidateExp && candidateExp >= new Date());
                if (isCandidateValid) {
                    rows = activeRows;
                    adoptedLicense = true;
                }
            }
        }

        if (!rows.length) return res.status(404).json({ error: 'not_found' });

        const lic = rows[0];
        const effectiveLicenseKey = lic.license_key || user.licenseKey;
        const tipo = String(lic.tipo || 'unique').trim().toLowerCase();

        // Si se adoptó una clave renovada perteneciente al mismo email, actualizar registro del dispositivo
        if (effectiveLicenseKey !== user.licenseKey) {
            await connection.execute(
                `INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked)
                 VALUES (?, ?, 'Dispositivo Renovado', datetime('now'), datetime('now'), 0)
                 ON CONFLICT(device_id) DO UPDATE SET
                   license_key = excluded.license_key,
                   revoked = 0, last_seen = datetime('now')`,
                [user.deviceId, effectiveLicenseKey]
            );
        }

        // REGLA 1 del flujo original: el correo del token debe corresponder al
        // dueño actual de la licencia (omitida si la licencia fue adoptada legítimamente).
        const finalClientEmail = String(lic.client_email || '').trim().toLowerCase();
        if (!adoptedLicense && finalClientEmail && searchEmail &&
            !finalClientEmail.startsWith('placeholder-') &&
            finalClientEmail !== searchEmail) {
            return res.status(409).json({ error: 'email_mismatch' });
        }

        let status = 'active';
        if (await isDeviceRevoked({ deviceId: user.deviceId, licenseKey: effectiveLicenseKey })) {
            status = 'revoked';
        }

        const expDate = parseExpirationDate(lic.fecha_vencimiento);
        const saasExpiration = tipo === 'saas' && expDate
            ? expDate.toISOString()
            : null;
        if (status === 'active' && tipo === 'saas' && expDate &&
            expDate < new Date()) {
            status = 'expired';
        }

        if (status === 'active' && tipo === 'saas') {
            await connection.execute(
                `UPDATE detalles_saas SET last_check = datetime('now') WHERE licencia_id = ?`,
                [lic.lic_id]
            );
        }

        let newToken = null;
        if (effectiveLicenseKey !== user.licenseKey || !tokenEmail || tokenEmail.startsWith('placeholder-')) {
            newToken = jwt.sign(
                { licenseKey: effectiveLicenseKey, deviceId: user.deviceId, email: searchEmail || finalClientEmail || tokenEmail },
                process.env.JWT_SECRET,
                { expiresIn: '1h' }
            );
        }

        const { signed_payload, signature } = signLicensePayload({
            licenseKey: effectiveLicenseKey,
            deviceId: user.deviceId,
            licenseType: tipo,
            saasExpiration,
        });

        return res.status(200).json({
            status,
            license_key: effectiveLicenseKey,
            license_type: tipo,
            saas_expiration: saasExpiration,
            token: newToken,
            signed_payload,
            signature,
            signed_at: new Date().toISOString(),
        });
    } catch (e) {
        console.error('❌ [License Status Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
