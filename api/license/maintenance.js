import { getConnection } from '../_db.js';
import { verifyToken, requireJwtSecret, applyCors, parseExpirationDate } from '../_helpers.js';
import { signLicensePayload } from './_sign.js';

// ─────────────────────────────────────────────────────────────────────────────
// MANTENIMIENTO DE LICENCIAS — lógica compartida
//
// `renew` y `rotate-key` eran dos endpoints diminutos (59 líneas cada uno) que
// en Vercel cuentan como dos FUNCIONES serverless. El plan Hobby permite 12, y
// con el cron de la tasa BCV el proyecto se pasó de 12: a partir de ahí NINGÚN
// despliegue se publicaba.
//
// Aquí viven las dos operaciones y una sola función (`license/maintenance.js`)
// las despacha por `?action=`, de modo que el plan tenga margen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/license/renew  (auth JWT, permite token expirado)
 *
 * Renovación SIN purga ni re-vinculación: extiende
 * detalles_saas.fecha_vencimiento sobre la MISMA license_key.
 * ← { months?: 1..36, new_expiration?: ISO }
 * → 200 { status:'renewed', license_type, saas_expiration, signed_payload, signature }
 */
export async function handleRenew(req, res) {
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

/**
 * POST /api/license/rotate-key  (auth JWT con la clave ACTUAL)
 *
 * Rotación explícita old_key -> new_key SIN purga del cliente: migra en Turso
 * licencias, devices, tablas sync, cursores, roles y sesiones.
 * ← { new_key }
 * → 200 { status:'rotated', old_key, new_key }
 */
export async function handleRotateKey(req, res) {
    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { new_key } = req.body || {};
    const newKey = String(new_key || '').trim().toUpperCase();
    if (!newKey) return res.status(400).json({ error: 'missing new_key' });
    const oldKey = String(user.licenseKey || '').trim().toUpperCase();
    if (newKey === oldKey) return res.status(400).json({ error: 'same_key' });
    try {
        const connection = getConnection();
        const [oldRows] = await connection.execute(
            `SELECT id, cliente_id FROM licencias WHERE license_key = ? LIMIT 1`, [oldKey]);
        const [newRows] = await connection.execute(
            `SELECT id, cliente_id, usado FROM licencias WHERE license_key = ? LIMIT 1`, [newKey]);
        if (!oldRows.length || !newRows.length) return res.status(404).json({ error: 'not_found' });
        if (Number(oldRows[0].cliente_id) !== Number(newRows[0].cliente_id)) {
            return res.status(403).json({ error: 'different_owner' });
        }
        const stmts = [
            { sql: `UPDATE licencias SET usado = 1, previous_license_key = ? WHERE license_key = ?`, args: [oldKey, newKey] },
            // v49: DELETE previo anti-colisión de PK compuesta (license_key, device_id)
            { sql: `DELETE FROM devices WHERE license_key = ? AND device_id IN (SELECT device_id FROM devices WHERE license_key = ?)`, args: [newKey, oldKey] },
            { sql: `UPDATE devices SET license_key = ? WHERE license_key = ?`, args: [newKey, oldKey] },
            { sql: `UPDATE account_cursor SET account_key = ? WHERE account_key = ? OR account_email = ?`, args: [newKey, oldKey, String(user.email || '').toLowerCase()] },
            { sql: `UPDATE change_log SET account_key = ? WHERE account_key = ?`, args: [newKey, oldKey] },
            { sql: `UPDATE device_role_assignments SET account_key = ? WHERE account_key = ?`, args: [newKey, oldKey] },
            { sql: `UPDATE pairing_sessions SET license_key = ? WHERE license_key = ?`, args: [newKey, oldKey] },
            { sql: `INSERT OR IGNORE INTO license_key_rotations (old_key, new_key, cliente_id, migrated_by_device) VALUES (?, ?, ?, ?)`, args: [oldKey, newKey, newRows[0].cliente_id, user.deviceId] },
        ];
        for (const t of ['sync_clients', 'sync_invoices', 'sync_suppliers', 'sync_categories', 'sync_products', 'sync_stock_movements', 'sync_audit_logs', 'user_roles']) {
            stmts.push({ sql: `UPDATE ${t} SET account_key = ? WHERE account_key = ?`, args: [newKey, oldKey] });
        }
        await connection.batch(stmts);
        return res.status(200).json({ status: 'rotated', old_key: oldKey, new_key: newKey });
    } catch (e) {
        console.error('❌ [Rotate Key Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}

const ACTIONS = {
    renew: handleRenew,
    'rotate-key': handleRotateKey,
};

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const action = String(req.query.action || '').trim();
    const fn = ACTIONS[action];
    if (!fn) {
        return res.status(404).json({
            error: 'unknown_action',
            available: Object.keys(ACTIONS),
        });
    }
    return fn(req, res);
}
