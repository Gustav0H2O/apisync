import { getConnection } from './_db.js';
import { verifyToken, isDeviceRevoked } from './_helpers.js';

/**
 * POST /api/sync
 * Cuerpo: { 
 *   push: { 
 *     clients: [...], 
 *     invoices: [...],
 *     profile: { ... }
 *   }, 
 *   last_sync: "ISO_STRING" 
 * }
 * Respuesta: { 
 *   clients: [...], 
 *   invoices: [...],
 *   profile: { ... }
 * }
 *
 * TODO en UNA SOLA CONEXIÓN de base de datos:
 *  1. Hace PUSH de clientes
 *  2. Hace PUSH de facturas + ítems
 *  3. Hace PUSH del perfil de negocio (si se proporciona)
 *  4. Hace PULL de todos los datos del usuario (incluyendo perfil)
 *  5. Cierra la conexión
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    
    // VERIFICAR ESTADO DEL DISPOSITIVO
    if (await isDeviceRevoked(user)) {
        return res.status(401).json({ error: 'DEVICE_REVOKED', message: 'Este dispositivo ha sido desvinculado' });
    }

    const { push = {}, last_sync } = req.body;
    const { clients = [], invoices = [], profile = null } = push;

    let connection;
    try {
        // ─── ABRIR UNA SOLA CONEXIÓN ─────────────────────────────────────
        connection = await getConnection();

        // ─── FASE 0: PUSH PROFILE ────────────────────────────────────────
        if (profile) {
            await connection.execute(
                `UPDATE clientes SET 
                    business_name = ?,
                    slogan = ?,
                    rif = ?,
                    address = ?,
                    user_name = ?,
                    user_phone = ?,
                    accent_color = ?,
                    header_color = ?,
                    version = ?, -- Añadido para compatibilidad
                    updated_at = NOW()
                 WHERE email = ?`,
                [
                    profile.business_name,
                    profile.slogan,
                    profile.rif,
                    profile.address,
                    profile.user_name,
                    profile.user_phone,
                    profile.accent_color,
                    profile.header_color,
                    profile.version,
                    user.email
                ]
            );
        }

        // ─── FASE 1: PUSH CLIENTES ────────────────────────────────────────
        for (const item of clients) {
            await connection.execute(
                `INSERT INTO sync_clients 
                    (uuid, account_email, name, phone, rif, address, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    name       = IF(version < VALUES(version), VALUES(name), name),
                    phone      = IF(version < VALUES(version), VALUES(phone), phone),
                    rif        = IF(version < VALUES(version), VALUES(rif), rif),
                    address    = IF(version < VALUES(version), VALUES(address), address),
                    deleted_at = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
                    updated_at = IF(version < VALUES(version), VALUES(updated_at), updated_at),
                    version    = GREATEST(version, VALUES(version))`,
                [item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.deleted_at, item.version, item.updated_at]
            );
        }

        // ─── FASE 2: PUSH FACTURAS + ÍTEMS ───────────────────────────────
        for (const inv of invoices) {
            await connection.execute(
                `INSERT INTO sync_invoices 
                    (uuid, account_email, number, client_uuid, client_name, date, type, document_type, total, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    number         = IF(version < VALUES(version), VALUES(number), number),
                    client_uuid    = IF(version < VALUES(version), VALUES(client_uuid), client_uuid),
                    client_name    = IF(version < VALUES(version), VALUES(client_name), client_name),
                    date           = IF(version < VALUES(version), VALUES(date), date),
                    type           = IF(version < VALUES(version), VALUES(type), type),
                    document_type  = IF(version < VALUES(version), VALUES(document_type), document_type),
                    total          = IF(version < VALUES(version), VALUES(total), total),
                    deleted_at     = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
                    updated_at     = IF(version < VALUES(version), VALUES(updated_at), updated_at),
                    version        = GREATEST(version, VALUES(version))`,
                [inv.uuid, user.email, inv.number, inv.client_uuid, inv.client_name, inv.date, inv.type, inv.document_type, inv.total, inv.deleted_at, inv.version, inv.updated_at]
            );

            if (inv.items && Array.isArray(inv.items)) {
                for (const it of inv.items) {
                    await connection.execute(
                        `INSERT INTO sync_invoice_items 
                            (uuid, invoice_uuid, description, quantity, unit_price, total_price, deleted_at, version, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE 
                            description = IF(version < VALUES(version), VALUES(description), description),
                            quantity    = IF(version < VALUES(version), VALUES(quantity), quantity),
                            unit_price  = IF(version < VALUES(version), VALUES(unit_price), unit_price),
                            total_price = IF(version < VALUES(version), VALUES(total_price), total_price),
                            deleted_at  = IF(version < VALUES(version), VALUES(deleted_at), deleted_at),
                            updated_at  = IF(version < VALUES(version), VALUES(updated_at), updated_at),
                            version     = GREATEST(version, VALUES(version))`,
                        [it.uuid, inv.uuid, it.description, it.quantity, it.unit_price, it.total_price, it.deleted_at, it.version, it.updated_at]
                    );
                }
            }
        }

        // ─── FASE 3: PULL (devolver todo al dispositivo) ─────────────────
        let clientParams = [user.email];
        let invoiceParams = [user.email];

        const baseClientSql  = `SELECT * FROM sync_clients  WHERE account_email = ?`;
        const baseInvoiceSql = `SELECT * FROM sync_invoices WHERE account_email = ?`;

        const [remoteClients]  = await connection.execute(baseClientSql,  clientParams);
        const [remoteInvoices] = await connection.execute(baseInvoiceSql, invoiceParams);

        for (const inv of remoteInvoices) {
            const [items] = await connection.execute(
                `SELECT * FROM sync_invoice_items WHERE invoice_uuid = ?`,
                [inv.uuid]
            );
            inv.items = items;
        }

        // PULL PROFILE
        const [profileRows] = await connection.execute(
            `SELECT business_name, slogan, rif, address, user_name, user_phone, accent_color, header_color, version, updated_at 
             FROM clientes WHERE email = ? LIMIT 1`,
            [user.email]
        );

        // ─── LOG ──────────────────────────────────────────────────────────
        await connection.execute(
            `INSERT INTO sync_log (device_id, action, entity_type, records_count) 
             VALUES (?, 'SYNC', 'ALL', ?)`,
            [user.deviceId || 'unknown', clients.length + invoices.length + remoteClients.length + remoteInvoices.length]
        );

        // ─── CERRAR CONEXIÓN ANTES DE RESPONDER ───────────────────────────
        connection.destroy();

        return res.status(200).json({
            clients:  remoteClients,
            invoices: remoteInvoices,
            profile:  profileRows[0] || null,
        });

    } catch (e) {
        if (connection) connection.destroy();
        console.error('❌ [Sync Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
