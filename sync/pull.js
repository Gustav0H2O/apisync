import { getConnection } from '../_db.js';
import { verifyToken } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { last_sync } = req.body;
    let connection;

    try {
        connection = await getConnection();

        let clientsQuery = `SELECT * FROM sync_clients WHERE account_email = ?`;
        let invoicesQuery = `SELECT * FROM sync_invoices WHERE account_email = ?`;
        let params = [user.email];

        if (last_sync) {
            clientsQuery += ` AND updated_at > ?`;
            invoicesQuery += ` AND updated_at > ?`;
            params.push(last_sync);
        }

        const [clients] = await connection.execute(clientsQuery, params);
        const [invoices] = await connection.execute(invoicesQuery, params);

        // Get items for these invoices
        for (const inv of invoices) {
            const [items] = await connection.execute(`SELECT * FROM sync_invoice_items WHERE invoice_uuid = ?`, [inv.uuid]);
            inv.items = items;
        }

        // Log sync
        await connection.execute(
            `INSERT INTO sync_log (device_id, action, entity_type, records_count) VALUES (?, 'PULL', 'ALL', ?)`,
            [user.deviceId, clients.length + invoices.length]
        );

        await connection.end(); // Cerrar conexión
        return res.status(200).json({ clients, invoices });
    } catch (e) {
        if (connection) await connection.end();
        return res.status(500).json({ error: e.message });
    }
}
