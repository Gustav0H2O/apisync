import { getConnection } from '../_db.js';
import { verifyToken, requireJwtSecret, applyCors, parseExpirationDate } from '../_helpers.js';
import { signLicensePayload } from './_sign.js';

/**
 * POST /api/license/renew  (auth JWT, permite token expirado)
 *
 * Renovación SIN purga ni re-vinculación: extiende
 * detalles_saas.fecha_vencimiento sobre la MISMA license_key.
 * No toca devices / sync / email: los dispositivos siguen sincronizando
 * con el mismo cursor.
 *
 * ← { months?: 1..36, new_expiration?: ISO }
 * → 200 { status:'renewed', license_type, saas_expiration, signed_payload, signature }
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();
    if (!requireJwtSecret(res)) return;
    const user = verifyToken(req, { ignoreExpiration: true });
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { months = 12, new_expiration } = req.body || {};
    try {
        const connection = getConnection();
        const [rows] = await connection.execute(
            `SELECT l.id AS lic_id, l.tipo, ds.fecha_vencimiento FROM licencias l
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE l.license_key = ? LIMIT 1`, [user.licenseKey]);
        if (!rows.length) return res.status(404).json({ error: 'not_found' });
        const lic = rows[0];
        const tipo = String(lic.tipo || 'unique').trim().toLowerCase();

        let expiration = new_expiration ? parseExpirationDate(new_expiration) : null;
        if (!expiration || isNaN(expiration.getTime())) {
            const current = parseExpirationDate(lic.fecha_vencimiento);
            const base = current && current > new Date() ? current : new Date();
            expiration = new Date(base);
            expiration.setMonth(expiration.getMonth() + Math.max(1, Math.min(36, Number(months) || 12)));
        }
        const expSql = expiration.toISOString().slice(0, 19).replace('T', ' ');

        if (tipo === 'saas') {
            // detalles_saas.licencia_id no tiene UNIQUE: UPDATE y si no
            // afectó filas, INSERT.
            const [upd] = await connection.execute(
                `UPDATE detalles_saas SET fecha_vencimiento = ?, last_check = datetime('now') WHERE licencia_id = ?`,
                [expSql, lic.lic_id]);
            if (Number(upd.affectedRows || 0) === 0) {
                await connection.execute(
                    `INSERT INTO detalles_saas (licencia_id, fecha_vencimiento, last_check) VALUES (?, ?, datetime('now'))`,
                    [lic.lic_id, expSql]);
            }
        }
        const saasExpiration = tipo === 'saas' ? expiration.toISOString() : null;
        const { signed_payload, signature } = signLicensePayload({
            licenseKey: user.licenseKey, deviceId: user.deviceId, licenseType: tipo, saasExpiration });
        return res.status(200).json({ status: 'renewed', license_type: tipo, saas_expiration: saasExpiration, signed_payload, signature });
    } catch (e) {
        console.error('❌ [License Renew Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
