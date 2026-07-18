import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret } from '../_helpers.js';
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
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    try {
        const connection = getConnection();

        const [rows] = await connection.execute(
            `SELECT l.id AS lic_id, l.tipo, l.usado, c.email AS client_email,
                    ds.fecha_vencimiento
             FROM licencias l
             JOIN clientes c ON l.cliente_id = c.id
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE l.license_key = ? LIMIT 1`,
            [user.licenseKey]
        );
        if (!rows.length) return res.status(404).json({ error: 'not_found' });

        const lic = rows[0];
        const tipo = String(lic.tipo || 'unique').trim().toLowerCase();

        // REGLA 1 del flujo original: el correo del token debe corresponder al
        // dueño actual de la licencia.
        const clientEmail = String(lic.client_email || '').trim().toLowerCase();
        const tokenEmail = String(user.email || '').trim().toLowerCase();
        if (clientEmail && tokenEmail && !clientEmail.startsWith('placeholder-') &&
            clientEmail !== tokenEmail) {
            return res.status(409).json({ error: 'email_mismatch' });
        }

        let status = 'active';
        if (await isDeviceRevoked(user)) {
            status = 'revoked';
        }

        const saasExpiration = tipo === 'saas' && lic.fecha_vencimiento
            ? new Date(lic.fecha_vencimiento).toISOString()
            : null;
        if (status === 'active' && tipo === 'saas' && saasExpiration &&
            new Date(saasExpiration) < new Date()) {
            status = 'expired';
        }

        if (status === 'active' && tipo === 'saas') {
            await connection.execute(
                `UPDATE detalles_saas SET last_check = datetime('now') WHERE licencia_id = ?`,
                [lic.lic_id]
            );
        }

        const { signed_payload, signature } = signLicensePayload({
            licenseKey: user.licenseKey,
            deviceId: user.deviceId,
            licenseType: tipo,
            saasExpiration,
        });

        return res.status(200).json({
            status,
            license_type: tipo,
            saas_expiration: saasExpiration,
            signed_payload,
            signature,
            signed_at: new Date().toISOString(),
        });
    } catch (e) {
        console.error('❌ [License Status Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
