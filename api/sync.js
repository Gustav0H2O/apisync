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

    const push = req.body.push || {};
    const { clients = [], invoices = [], profile = null, products = [], suppliers = [], categories = [], stock_movements = [] } = push;

    let connection;
    try {
        // ─── ABRIR UNA SOLA CONEXIÓN ─────────────────────────────────────
        connection = await getConnection();

        // Función auxiliar para forzar undefined a null y evitar caídas en mysql2
        const mapP = (arr) => arr.map(v => v === undefined ? null : v);

        // ─── FASE 0: PUSH PROFILE ────────────────────────────────────────
        if (profile) {
            await connection.execute(
                `UPDATE clientes SET 
                    business_name = ?, slogan = ?, rif = ?, address = ?, user_name = ?,
                    user_phone = ?, accent_color = ?, header_color = ?, version = ?,
                    exchange_rate_mode = ?, working_currency = ?, display_currency = ?, print_currency = ?,
                    manual_rate = ?, use_latest_rate = ?, usd_rate_latest = ?, usd_rate_previous = ?,
                    show_banner_invoice = ?, show_banner_quote = ?, show_banner_delivery = ?,
                    banner_color = ?, show_exchange_rate = ?, config_style = ?,
                    products_by_stock = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE email = ?`,
                mapP([
                    profile.business_name, profile.slogan, profile.rif, profile.address, profile.user_name,
                    profile.user_phone, profile.accent_color, profile.header_color, profile.version,
                    profile.exchange_rate_mode, profile.working_currency, profile.display_currency, profile.print_currency,
                    profile.manual_rate, profile.use_latest_rate, profile.usd_rate_latest, profile.usd_rate_previous,
                    profile.show_banner_invoice, profile.show_banner_quote, profile.show_banner_delivery,
                    profile.banner_color, profile.show_exchange_rate, profile.config_style,
                    profile.products_by_stock || 0,
                    user.email
                ])
            );
        }

        // ─── FASE 1: PUSH CLIENTES ────────────────────────────────────────
        for (const item of clients) {
            await connection.execute(
                `INSERT INTO sync_clients 
                    (uuid, account_email, name, phone, rif, address, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET
                    name       = CASE WHEN excluded.version > sync_clients.version THEN excluded.name ELSE sync_clients.name END,
                    phone      = CASE WHEN excluded.version > sync_clients.version THEN excluded.phone ELSE sync_clients.phone END,
                    rif        = CASE WHEN excluded.version > sync_clients.version THEN excluded.rif ELSE sync_clients.rif END,
                    address    = CASE WHEN excluded.version > sync_clients.version THEN excluded.address ELSE sync_clients.address END,
                    deleted_at = CASE WHEN excluded.version > sync_clients.version THEN excluded.deleted_at ELSE sync_clients.deleted_at END,
                    updated_at = CASE WHEN excluded.version > sync_clients.version THEN excluded.updated_at ELSE sync_clients.updated_at END,
                    version    = CASE WHEN excluded.version > sync_clients.version THEN excluded.version ELSE sync_clients.version END`,
                mapP([item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.deleted_at, item.version, item.updated_at])
            );
        }

        // ─── FASE 1.1: PUSH PROVEEDORES ───────────────────────────────────
        for (const item of suppliers) {
            await connection.execute(
                `INSERT INTO sync_suppliers 
                    (uuid, account_email, name, phone, rif, address, email, contact_person, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET
                    name           = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.name ELSE sync_suppliers.name END,
                    phone          = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.phone ELSE sync_suppliers.phone END,
                    rif            = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.rif ELSE sync_suppliers.rif END,
                    address        = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.address ELSE sync_suppliers.address END,
                    email          = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.email ELSE sync_suppliers.email END,
                    contact_person = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.contact_person ELSE sync_suppliers.contact_person END,
                    deleted_at     = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.deleted_at ELSE sync_suppliers.deleted_at END,
                    updated_at     = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.updated_at ELSE sync_suppliers.updated_at END,
                    version        = CASE WHEN excluded.version > sync_suppliers.version THEN excluded.version ELSE sync_suppliers.version END`,
                mapP([item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.email, item.contact_person, item.deleted_at, item.version, item.updated_at])
            );
        }

        // ─── FASE 1.2: PUSH PRODUCTOS ──────────────────────────────────────
        for (const item of products) {
            await connection.execute(
                `INSERT INTO sync_products 
                    (uuid, account_email, code, name, description, unit, sale_price, is_exempt, supplier_uuid, stock, sales, category, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET
                    code           = CASE WHEN excluded.version > sync_products.version THEN excluded.code ELSE sync_products.code END,
                    name           = CASE WHEN excluded.version > sync_products.version THEN excluded.name ELSE sync_products.name END,
                    description    = CASE WHEN excluded.version > sync_products.version THEN excluded.description ELSE sync_products.description END,
                    unit           = CASE WHEN excluded.version > sync_products.version THEN excluded.unit ELSE sync_products.unit END,
                    sale_price     = CASE WHEN excluded.version > sync_products.version THEN excluded.sale_price ELSE sync_products.sale_price END,
                    is_exempt      = CASE WHEN excluded.version > sync_products.version THEN excluded.is_exempt ELSE sync_products.is_exempt END,
                    supplier_uuid  = CASE WHEN excluded.version > sync_products.version THEN excluded.supplier_uuid ELSE sync_products.supplier_uuid END,
                    stock          = CASE WHEN excluded.version > sync_products.version THEN excluded.stock ELSE sync_products.stock END,
                    sales          = CASE WHEN excluded.version > sync_products.version THEN excluded.sales ELSE sync_products.sales END,
                    category       = CASE WHEN excluded.version > sync_products.version THEN excluded.category ELSE sync_products.category END,
                    deleted_at     = CASE WHEN excluded.version > sync_products.version THEN excluded.deleted_at ELSE sync_products.deleted_at END,
                    updated_at     = CASE WHEN excluded.version > sync_products.version THEN excluded.updated_at ELSE sync_products.updated_at END,
                    version        = CASE WHEN excluded.version > sync_products.version THEN excluded.version ELSE sync_products.version END`,
                mapP([
                    item.uuid, user.email, item.code, item.name, item.description, item.unit, item.sale_price, 
                    item.is_exempt, item.supplier_uuid, item.stock, item.sales, item.category, 
                    item.deleted_at, item.version, item.updated_at
                ])
            );
        }

        // ─── FASE 1.3: PUSH CATEGORÍAS ────────────────────────────────────
        for (const item of categories) {
            await connection.execute(
                `INSERT INTO sync_categories 
                    (uuid, account_email, name, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET
                    name       = CASE WHEN excluded.version > sync_categories.version THEN excluded.name ELSE sync_categories.name END,
                    deleted_at = CASE WHEN excluded.version > sync_categories.version THEN excluded.deleted_at ELSE sync_categories.deleted_at END,
                    updated_at = CASE WHEN excluded.version > sync_categories.version THEN excluded.updated_at ELSE sync_categories.updated_at END,
                    version    = CASE WHEN excluded.version > sync_categories.version THEN excluded.version ELSE sync_categories.version END`,
                mapP([item.uuid, user.email, item.name, item.deleted_at, item.version, item.updated_at])
            );
        }

        // ─── FASE 1.4: PUSH MOVIMIENTOS STOCK ────────────────────────────
        for (const item of stock_movements) {
            await connection.execute(
                `INSERT INTO sync_stock_movements 
                    (uuid, account_email, product_uuid, quantity, type, reason, reference_uuid, date, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET
                    quantity       = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.quantity ELSE sync_stock_movements.quantity END,
                    type           = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.type ELSE sync_stock_movements.type END,
                    reason         = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.reason ELSE sync_stock_movements.reason END,
                    reference_uuid = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.reference_uuid ELSE sync_stock_movements.reference_uuid END,
                    date           = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.date ELSE sync_stock_movements.date END,
                    deleted_at     = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.deleted_at ELSE sync_stock_movements.deleted_at END,
                    updated_at     = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.updated_at ELSE sync_stock_movements.updated_at END,
                    version        = CASE WHEN excluded.version > sync_stock_movements.version THEN excluded.version ELSE sync_stock_movements.version END`,
                mapP([
                    item.uuid, user.email, item.product_uuid, item.quantity, item.type, item.reason, 
                    item.reference_uuid, item.date, item.deleted_at, item.version, item.updated_at
                ])
            );
        }

        // ─── FASE 2: PUSH FACTURAS + ÍTEMS ───────────────────────────────
        for (const inv of invoices) {
            await connection.execute(
                `INSERT INTO sync_invoices 
                    (uuid, account_email, number, client_uuid, client_name, client_address, client_rif, client_phone, iva_enabled, payment_method, due_date, budget, order_code, transport, salesperson, delivery_method, ship_to, observations, subtotal, tax, total, exchange_rate, currency_symbol, working_currency, converted_from_uuid, date, type, document_type, deleted_at, version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO UPDATE SET 
                    number         = CASE WHEN excluded.version > sync_invoices.version THEN excluded.number ELSE sync_invoices.number END,
                    client_uuid    = CASE WHEN excluded.version > sync_invoices.version THEN excluded.client_uuid ELSE sync_invoices.client_uuid END,
                    client_name    = CASE WHEN excluded.version > sync_invoices.version THEN excluded.client_name ELSE sync_invoices.client_name END,
                    client_address = CASE WHEN excluded.version > sync_invoices.version THEN excluded.client_address ELSE sync_invoices.client_address END,
                    client_rif     = CASE WHEN excluded.version > sync_invoices.version THEN excluded.client_rif ELSE sync_invoices.client_rif END,
                    client_phone   = CASE WHEN excluded.version > sync_invoices.version THEN excluded.client_phone ELSE sync_invoices.client_phone END,
                    iva_enabled    = CASE WHEN excluded.version > sync_invoices.version THEN excluded.iva_enabled ELSE sync_invoices.iva_enabled END,
                    payment_method = CASE WHEN excluded.version > sync_invoices.version THEN excluded.payment_method ELSE sync_invoices.payment_method END,
                    due_date       = CASE WHEN excluded.version > sync_invoices.version THEN excluded.due_date ELSE sync_invoices.due_date END,
                    budget         = CASE WHEN excluded.version > sync_invoices.version THEN excluded.budget ELSE sync_invoices.budget END,
                    order_code     = CASE WHEN excluded.version > sync_invoices.version THEN excluded.order_code ELSE sync_invoices.order_code END,
                    transport      = CASE WHEN excluded.version > sync_invoices.version THEN excluded.transport ELSE sync_invoices.transport END,
                    salesperson    = CASE WHEN excluded.version > sync_invoices.version THEN excluded.salesperson ELSE sync_invoices.salesperson END,
                    delivery_method= CASE WHEN excluded.version > sync_invoices.version THEN excluded.delivery_method ELSE sync_invoices.delivery_method END,
                    ship_to        = CASE WHEN excluded.version > sync_invoices.version THEN excluded.ship_to ELSE sync_invoices.ship_to END,
                    observations   = CASE WHEN excluded.version > sync_invoices.version THEN excluded.observations ELSE sync_invoices.observations END,
                    subtotal       = CASE WHEN excluded.version > sync_invoices.version THEN excluded.subtotal ELSE sync_invoices.subtotal END,
                    tax            = CASE WHEN excluded.version > sync_invoices.version THEN excluded.tax ELSE sync_invoices.tax END,
                    total          = CASE WHEN excluded.version > sync_invoices.version THEN excluded.total ELSE sync_invoices.total END,
                    exchange_rate  = CASE WHEN excluded.version > sync_invoices.version THEN excluded.exchange_rate ELSE sync_invoices.exchange_rate END,
                    currency_symbol= CASE WHEN excluded.version > sync_invoices.version THEN excluded.currency_symbol ELSE sync_invoices.currency_symbol END,
                    working_currency= CASE WHEN excluded.version > sync_invoices.version THEN excluded.working_currency ELSE sync_invoices.working_currency END,
                    converted_from_uuid= CASE WHEN excluded.version > sync_invoices.version THEN excluded.converted_from_uuid ELSE sync_invoices.converted_from_uuid END,
                    date           = CASE WHEN excluded.version > sync_invoices.version THEN excluded.date ELSE sync_invoices.date END,
                    type           = CASE WHEN excluded.version > sync_invoices.version THEN excluded.type ELSE sync_invoices.type END,
                    document_type  = CASE WHEN excluded.version > sync_invoices.version THEN excluded.document_type ELSE sync_invoices.document_type END,
                    deleted_at     = CASE WHEN excluded.version > sync_invoices.version THEN excluded.deleted_at ELSE sync_invoices.deleted_at END,
                    updated_at     = CASE WHEN excluded.version > sync_invoices.version THEN excluded.updated_at ELSE sync_invoices.updated_at END,
                    version        = CASE WHEN excluded.version > sync_invoices.version THEN excluded.version ELSE sync_invoices.version END`,
                mapP([
                    inv.uuid, user.email, inv.number, inv.client_uuid, inv.client_name, inv.client_address, inv.client_rif, inv.client_phone,
                    inv.iva_enabled, inv.payment_method, inv.due_date, inv.budget, inv.order_code, inv.transport, inv.salesperson, inv.delivery_method,
                    inv.ship_to, inv.observations, inv.subtotal, inv.tax, inv.total, inv.exchange_rate, inv.currency_symbol, inv.working_currency,
                    inv.converted_from_uuid, inv.date, inv.type, inv.document_type, inv.deleted_at, inv.version, inv.updated_at
                ])
            );

            if (inv.items && Array.isArray(inv.items)) {
                for (const it of inv.items) {
                    await connection.execute(
                        `INSERT INTO sync_invoice_items 
                            (uuid, invoice_uuid, code, description, quantity, unit_price, total_price, is_exempt, deleted_at, version, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(uuid) DO UPDATE SET 
                             code        = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.code ELSE sync_invoice_items.code END,
                             description = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.description ELSE sync_invoice_items.description END,
                             quantity    = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.quantity ELSE sync_invoice_items.quantity END,
                             unit_price  = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.unit_price ELSE sync_invoice_items.unit_price END,
                             total_price = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.total_price ELSE sync_invoice_items.total_price END,
                             is_exempt   = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.is_exempt ELSE sync_invoice_items.is_exempt END,
                             deleted_at  = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.deleted_at ELSE sync_invoice_items.deleted_at END,
                             updated_at  = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.updated_at ELSE sync_invoice_items.updated_at END,
                             version     = CASE WHEN excluded.version > sync_invoice_items.version THEN excluded.version ELSE sync_invoice_items.version END`,
                        mapP([it.uuid, inv.uuid, it.code, it.description, it.quantity, it.unit_price, it.total_price, it.is_exempt, it.deleted_at, it.version, it.updated_at])
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
        const [remoteSuppliers]= await connection.execute(`SELECT * FROM sync_suppliers WHERE account_email = ?`, [user.email]);
        const [remoteProducts] = await connection.execute(`SELECT * FROM sync_products WHERE account_email = ?`, [user.email]);
        const [remoteCategories]=await connection.execute(`SELECT * FROM sync_categories WHERE account_email = ?`, [user.email]);
        const [remoteMovements] = await connection.execute(`SELECT * FROM sync_stock_movements WHERE account_email = ?`, [user.email]);

        for (const inv of remoteInvoices) {
            const [items] = await connection.execute(
                `SELECT * FROM sync_invoice_items WHERE invoice_uuid = ?`,
                [inv.uuid]
            );
            inv.items = items;
        }

        // PULL PROFILE
        const [profileRows] = await connection.execute(
            `SELECT business_name, slogan, rif, address, user_name, email, user_phone, accent_color, header_color,
                    exchange_rate_mode, working_currency, display_currency, print_currency,
                    manual_rate, use_latest_rate, usd_rate_latest, usd_rate_previous,
                    show_banner_invoice, show_banner_quote, show_banner_delivery,
                    banner_color, show_exchange_rate, config_style, products_by_stock,
                    version, updated_at 
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
            clients:    remoteClients,
            invoices:   remoteInvoices,
            suppliers:  remoteSuppliers,
            products:   remoteProducts,
            categories: remoteCategories,
            stock_movements: remoteMovements,
            profile:    profileRows[0] || null,
        });

    } catch (e) {
        if (connection) connection.destroy();
        console.error('❌ [Sync Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
