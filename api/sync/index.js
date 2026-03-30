import { getConnection } from '../_db.js';
import { verifyToken } from '../_helpers.js';

export default async function handler(req, res) {
    console.log('--- START SYNC ---');
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) {
        console.log('No autorizado');
        return res.status(401).json({ error: 'No autorizado' });
    }

    const body = req.body || {};
    const push = body.push || {};
    const clients = push.clients || [];
    const invoices = push.invoices || [];
    const last_sync = body.last_sync;

    let connection;
    try {
        console.log('Abriendo conexion DB');
        connection = await getConnection();

        console.log('Pushing clients', clients.length);
        for (const item of clients) {
            await connection.execute(
                `INSERT INTO sync_clients 
                    (uuid, account_email, name, phone, rif, address, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    name       = IF(version <= VALUES(version), VALUES(name), name),
                    phone      = IF(version <= VALUES(version), VALUES(phone), phone),
                    rif        = IF(version <= VALUES(version), VALUES(rif), rif),
                    address    = IF(version <= VALUES(version), VALUES(address), address),
                    deleted_at = IF(version <= VALUES(version), VALUES(deleted_at), deleted_at),
                    updated_at = IF(version <= VALUES(version), VALUES(updated_at), updated_at),
                    version    = GREATEST(version, VALUES(version))`,
                [
                    item.uuid, 
                    user.email, 
                    item.name || null, 
                    item.phone || null, 
                    item.rif || null, 
                    item.address || null, 
                    item.deleted_at || null, 
                    item.version || 1, 
                    item.updated_at || null
                ]
            );
        }

        console.log('Pushing invoices', invoices.length);
        for (const inv of invoices) {
            await connection.execute(
                `INSERT INTO sync_invoices 
                    (uuid, account_email, number, client_uuid, client_name, date, type, document_type, total, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    total      = IF(version <= VALUES(version), VALUES(total), total),
                    deleted_at = IF(version <= VALUES(version), VALUES(deleted_at), deleted_at),
                    updated_at = IF(version <= VALUES(version), VALUES(updated_at), updated_at),
                    version    = GREATEST(version, VALUES(version))`,
                [
                    inv.uuid, 
                    user.email, 
                    inv.number || null, 
                    inv.client_uuid || null, 
                    inv.client_name || null, 
                    inv.date || null, 
                    inv.type || null, 
                    inv.document_type || null, 
                    inv.total || 0, 
                    inv.deleted_at || null, 
                    inv.version || 1, 
                    inv.updated_at || null
                ]
            );

            if (inv.items && Array.isArray(inv.items)) {
                for (const it of inv.items) {
                    await connection.execute(
                        `INSERT INTO sync_invoice_items 
                            (uuid, invoice_uuid, description, quantity, unit_price, total_price, deleted_at, version, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE 
                            description = IF(version <= VALUES(version), VALUES(description), description),
                            quantity    = IF(version <= VALUES(version), VALUES(quantity), quantity),
                            unit_price  = IF(version <= VALUES(version), VALUES(unit_price), unit_price),
                            total_price = IF(version <= VALUES(version), VALUES(total_price), total_price),
                            deleted_at  = IF(version <= VALUES(version), VALUES(deleted_at), deleted_at),
                            updated_at  = IF(version <= VALUES(version), VALUES(updated_at), updated_at),
                            version     = GREATEST(version, VALUES(version))`,
                        [
                            it.uuid, 
                            inv.uuid, 
                            it.description || null, 
                            it.quantity || 1, 
                            it.unit_price || 0, 
                            it.total_price || 0, 
                            it.deleted_at || null, 
                            it.version || 1, 
                            it.updated_at || null
                        ]
                    );
                }
            }
        }

        console.log('Pulling clients');
        let clientParams = [user.email];
        let invoiceParams = [user.email];

        if (last_sync) {
            // Uncomment next lines if implementing delta pull
            // baseClientSql += ` AND updated_at > ?`;
            // baseInvoiceSql += ` AND updated_at > ?`;
            // clientParams.push(last_sync);
            // invoiceParams.push(last_sync);
        }

        const [remoteClients]  = await connection.execute(`SELECT * FROM sync_clients WHERE account_email = ?`,  clientParams);
        const [remoteInvoices] = await connection.execute(`SELECT * FROM sync_invoices WHERE account_email = ?`, invoiceParams);

        console.log('Pulling items', remoteInvoices.length);
        for (const inv of remoteInvoices) {
            const [items] = await connection.execute(
                `SELECT * FROM sync_invoice_items WHERE invoice_uuid = ?`,
                [inv.uuid]
            );
            inv.items = items;
        }

        console.log('Insertando log');
        try {
            await connection.execute(
                `INSERT INTO sync_log (device_id, action, entity_type, records_count) 
                 VALUES (?, 'SYNC', 'ALL', ?)`,
                [user.deviceId || 'unknown', clients.length + invoices.length + remoteClients.length + remoteInvoices.length]
            );
        } catch (logErr) {
            console.error('Error insertando en sync_log', logErr);
            // Si el FK falla por unknown device, no abortar la sínc.
        }

        console.log('Cerrando BD y devolviendo');
        connection.end();

        return res.status(200).json({
            clients:  remoteClients,
            invoices: remoteInvoices,
        });

    } catch (e) {
        console.error('❌ [Sync Error]:', e);
        if (connection) connection.end();
        return res.status(500).json({ error: String(e.message || e) });
    }
}
