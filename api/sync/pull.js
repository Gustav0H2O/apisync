import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { last_sync } = req.body;

    try {
        let clientsQuery = `SELECT * FROM sync_clients WHERE account_email = ?`;
        let invoicesQuery = `SELECT * FROM sync_invoices WHERE account_email = ?`;
        let params = [user.email];

        if (last_sync) {
            clientsQuery += ` AND updated_at > ?`;
            invoicesQuery += ` AND updated_at > ?`;
            params.push(last_sync);
        }

        const clients = await queryDB(clientsQuery, params);
        const invoices = await queryDB(invoicesQuery, params);

        // Get items for these invoices
        for (const inv of invoices) {
            inv.items = await queryDB(`SELECT * FROM sync_invoice_items WHERE invoice_uuid = ?`, [inv.uuid]);
        }

        // Log sync
        await queryDB(
            `INSERT INTO sync_log (device_id, action, entity_type, records_count) VALUES (?, 'PULL', 'ALL', ?)`,
            [user.deviceId, clients.length + invoices.length]
        );

        return res.status(200).json({ clients, invoices });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
