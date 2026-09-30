import { getConnection } from '../_db.js';
import { verifyToken, requireJwtSecret, applyCors } from '../_helpers.js';

/**
 * POST /api/license/rotate-key  (auth JWT con la clave ACTUAL)
 *
 * Rotación explícita old_key -> new_key SIN purga del cliente:
 * - new_key debe existir, pertenecer al mismo cliente y estar sin activar
 *   (o ya adoptada por flujo de renovación).
 * - Migra en Turso: licencias.usado + previous_license_key, devices,
 *   sync_*.account_key, account_cursor/change_log, device_role_assignments,
 *   pairing_sessions. Registra en license_key_rotations.
 * - El cliente, al recibir { new_key }, solo actualiza prefs licenseKey y
 *   sigue con el MISMO cursor y datos locales (sin re-vincular).
 *
 * ← { new_key }
 * → 200 { status:'rotated', old_key, new_key }
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();
    if (!requireJwtSecret(res)) return;
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
