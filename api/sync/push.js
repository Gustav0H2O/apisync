import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { entity, data } = req.body;
    if (!entity || !data || !Array.isArray(data)) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }

    try {
        const mapP = (arr) => arr.map(v => v === undefined ? null : v);

        for (const item of data) {
            if (entity === 'clients') {
                await queryDB(
                    `INSERT INTO sync_clients (uuid, account_email, name, phone, rif, address, deleted_at, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET 
           name = CASE WHEN excluded.version > sync_clients.version THEN excluded.name ELSE sync_clients.name END,
           phone = CASE WHEN excluded.version > sync_clients.version THEN excluded.phone ELSE sync_clients.phone END,
           rif = CASE WHEN excluded.version > sync_clients.version THEN excluded.rif ELSE sync_clients.rif END,
           address = CASE WHEN excluded.version > sync_clients.version THEN excluded.address ELSE sync_clients.address END,
           deleted_at = CASE WHEN excluded.version > sync_clients.version THEN excluded.deleted_at ELSE sync_clients.deleted_at END,
           updated_at = CASE WHEN excluded.version > sync_clients.version THEN excluded.updated_at ELSE sync_clients.updated_at END,
           version = MAX(sync_clients.version, excluded.version)`,
                    mapP([item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.deleted_at, item.version, item.updated_at])
                );
            } else if (entity === 'invoices') {
                // Upsert Invoice
                await queryDB(
                    `INSERT INTO sync_invoices (uuid, account_email, number, client_uuid, client_name, date, type, document_type, total, deleted_at, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET 
           total = CASE WHEN excluded.version > sync_invoices.version THEN excluded.total ELSE sync_invoices.total END,
           deleted_at = CASE WHEN excluded.version > sync_invoices.version THEN excluded.deleted_at ELSE sync_invoices.deleted_at END,
           updated_at = CASE WHEN excluded.version > sync_invoices.version THEN excluded.updated_at ELSE sync_invoices.updated_at END,
           version = MAX(sync_invoices.version, excluded.version)`,
                    mapP([item.uuid, user.email, item.number, item.client_uuid, item.client_name, item.date, item.type, item.document_type, item.total, item.deleted_at, item.version, item.updated_at])
                );

                // Upsert Items if present
                if (item.items && Array.isArray(item.items)) {
                    for (const it of item.items) {
                        await queryDB(
                            `INSERT INTO sync_invoice_items (uuid, invoice_uuid, description, quantity, unit_price, total_price, deleted_at, version, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(uuid) DO UPDATE SET 
               description = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.description ELSE sync_invoice_items.description END,
               quantity = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.quantity ELSE sync_invoice_items.quantity END,
               unit_price = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.unit_price ELSE sync_invoice_items.unit_price END,
               total_price = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.total_price ELSE sync_invoice_items.total_price END,
               deleted_at = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.deleted_at ELSE sync_invoice_items.deleted_at END,
               updated_at = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.updated_at ELSE sync_invoice_items.updated_at END,
               version = MAX(sync_invoice_items.version, excluded.version)`,
                            mapP([it.uuid, item.uuid, it.description, it.quantity, it.unit_price, it.total_price, it.deleted_at, it.version, it.updated_at])
                        );
                    }
                }
            }
        }

        // Log sync
        await queryDB(
            `INSERT INTO sync_log (device_id, action, entity_type, records_count) VALUES (?, 'PUSH', ?, ?)`,
            [user.deviceId, entity, data.length]
        );

        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
