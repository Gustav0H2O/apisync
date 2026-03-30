import { getConnection } from '../_db.js';
import { verifyToken } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { entity, data } = req.body;
    if (!entity || !data || !Array.isArray(data)) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }

    let connection;
    try {
        connection = await getConnection();
        
        for (const item of data) {
            if (entity === 'clients') {
                await connection.execute(
                    `INSERT INTO sync_clients (uuid, account_email, name, phone, rif, address, deleted_at, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
           name = IF(version < VALUES(version), VALUES(name), name),
           phone = IF(version < VALUES(version), VALUES(phone), phone),
           rif = IF(version < VALUES(version), VALUES(rif), rif),
           address = IF(version < VALUES(version), VALUES(address), address),
           deleted_at = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
           updated_at = IF(version < VALUES(version), VALUES(updated_at), updated_at),
           version = GREATEST(version, VALUES(version))`,
                    [item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.deleted_at, item.version, item.updated_at]
                );
            } else if (entity === 'invoices') {
                // Upsert Invoice
                await connection.execute(
                    `INSERT INTO sync_invoices (uuid, account_email, number, client_uuid, client_name, date, type, document_type, total, deleted_at, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
           total = IF(version < VALUES(version), VALUES(total), total),
           deleted_at = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
           updated_at = IF(version < VALUES(version), VALUES(updated_at), updated_at),
           version = GREATEST(version, VALUES(version))`,
                    [item.uuid, user.email, item.number, item.client_uuid, item.client_name, item.date, item.type, item.document_type, item.total, item.deleted_at, item.version, item.updated_at]
                );

                // Upsert Items if present
                if (item.items && Array.isArray(item.items)) {
                    for (const it of item.items) {
                        await connection.execute(
                            `INSERT INTO sync_invoice_items (uuid, invoice_uuid, description, quantity, unit_price, total_price, deleted_at, version, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE 
               description = IF(version < VALUES(version), VALUES(description), description),
               quantity = IF(version < VALUES(version), VALUES(quantity), quantity),
               unit_price = IF(version < VALUES(version), VALUES(unit_price), unit_price),
               total_price = IF(version < VALUES(version), VALUES(total_price), total_price),
               deleted_at = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
               updated_at = IF(version < VALUES(version), VALUES(updated_at), updated_at),
               version = GREATEST(version, VALUES(version))`,
                            [it.uuid, item.uuid, it.description, it.quantity, it.unit_price, it.total_price, it.deleted_at, it.version, it.updated_at]
                        );
                    }
                }
            }
        }

        // Log sync
        await connection.execute(
            `INSERT INTO sync_log (device_id, action, entity_type, records_count) VALUES (?, 'PUSH', ?, ?)`,
            [user.deviceId, entity, data.length]
        );

        await connection.destroy(); // Cerrar a la fuerza antes del response
        return res.status(200).json({ success: true });
    } catch (e) {
        if (connection) await connection.destroy();
        return res.status(500).json({ error: e.message });
    }
}
