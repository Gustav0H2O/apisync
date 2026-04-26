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
import Busboy from 'busboy';

/**
 * POST /api/sync
 * Soporta JSON tradicional y Multipart/Form-Data para Blobs.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    // Validación de tamaño de payload (10MB) para prevenir ataques DoS o payloads corruptos gigantes
    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > 10 * 1024 * 1024) {
        return res.status(413).json({ error: 'Payload too large (> 10MB)' });
    }

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    
    if (await isDeviceRevoked(user)) {
        return res.status(401).json({ error: 'DEVICE_REVOKED', message: 'Este dispositivo ha sido desvinculado' });
    }

    let push = {};
    let lastSync = null;
    let catalogLogoBuffer = null;

    // --- PROCESAR MULTIPART O JSON ---
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
        await new Promise((resolve, reject) => {
            const bb = Busboy({ headers: req.headers });
            bb.on('field', (name, val) => {
                if (name === 'payload') {
                    const payload = JSON.parse(val);
                    push = payload.push || {};
                    lastSync = payload.last_sync;
                }
            });
            bb.on('file', (name, file, info) => {
                if (name === 'catalog_logo') {
                    const chunks = [];
                    file.on('data', (data) => chunks.push(data));
                    file.on('end', () => {
                        catalogLogoBuffer = Buffer.concat(chunks);
                    });
                } else {
                    file.resume();
                }
            });
            bb.on('finish', resolve);
            bb.on('error', reject);
            req.pipe(bb);
        });
    } else {
        push = req.body?.push || {};
        lastSync = req.body?.last_sync;
    }

    const { clients = [], invoices = [], profile = null, products = [], suppliers = [], categories = [], stock_movements = [] } = push;

    let connection;
    try {
        // ─── ABRIR UNA SOLA CONEXIÓN ─────────────────────────────────────
        connection = getConnection();

        // Función auxiliar para forzar undefined a null y evitar caídas en mysql2
        const mapP = (arr) => arr.map(v => v === undefined ? null : v);

        const batchStatements = [];

        // ─── FASE 0: PUSH PROFILE ────────────────────────────────────────
        if (profile) {
            batchStatements.push({
                sql: `UPDATE clientes SET 
                    business_name = ?, slogan = ?, rif = ?, address = ?, user_name = ?,
                    user_phone = ?, accent_color = ?, header_color = ?, version = ?,
                    exchange_rate_mode = ?, working_currency = ?, display_currency = ?, print_currency = ?,
                    manual_rate = ?, use_latest_rate = ?, usd_rate_latest = ?, usd_rate_previous = ?,
                    show_banner_invoice = ?, show_banner_quote = ?, show_banner_delivery = ?,
                    banner_color = ?, show_exchange_rate = ?, config_style = ?,
                    products_by_stock = ?, 
                    catalog_document_title = ?, catalog_layout_style = ?, 
                    catalog_logo_path = CASE 
                        WHEN ? = 1 THEN NULL 
                        WHEN ? IS NOT NULL THEN ? 
                        ELSE catalog_logo_path 
                    END,
                    catalog_logo_position = ?, catalog_banner_color = ?, catalog_header_color = ?,
                    catalog_show_stock = ?, catalog_show_price_bs = ?, catalog_show_price_usd = ?,
                    catalog_show_iva = ?, catalog_show_address = ?, catalog_show_phone = ?,
                    catalog_show_slogan = ?, catalog_show_exchange_rate = ?, catalog_show_product_code = ?,
                    catalog_show_product_description = ?, catalog_show_promos = ?, catalog_show_wholesale = ?,
                    catalog_footer_text = ?, catalog_grayscale_mode = ?,
                    updated_at = CURRENT_TIMESTAMP
                  WHERE email = ? AND version <= ?`,
                args: mapP([
                    profile.business_name, profile.slogan, profile.rif, profile.address, profile.user_name,
                    profile.user_phone, profile.accent_color, profile.header_color, profile.version,
                    profile.exchange_rate_mode, profile.working_currency, profile.display_currency, profile.print_currency,
                    profile.manual_rate, profile.use_latest_rate, profile.usd_rate_latest, profile.usd_rate_previous,
                    profile.show_banner_invoice, profile.show_banner_quote, profile.show_banner_delivery,
                    profile.banner_color, profile.show_exchange_rate, profile.config_style,
                    profile.products_by_stock || 0,
                    profile.catalog_document_title, profile.catalog_layout_style,
                    profile.clear_catalog_logo ? 1 : 0, catalogLogoBuffer, catalogLogoBuffer,
                    profile.catalog_logo_position, profile.catalog_banner_color, profile.catalog_header_color,
                    profile.catalog_show_stock, profile.catalog_show_price_bs, profile.catalog_show_price_usd,
                    profile.catalog_show_iva, profile.catalog_show_address, profile.catalog_show_phone,
                    profile.catalog_show_slogan, profile.catalog_show_exchange_rate, profile.catalog_show_product_code,
                    profile.catalog_show_product_description, profile.catalog_show_promos, profile.catalog_show_wholesale,
                    profile.catalog_footer_text, profile.catalog_grayscale_mode,
                    user.email, profile.version
                ])
            });
        }

        // ─── FASE 1: PUSH CLIENTES ────────────────────────────────────────
        for (const item of clients) {
            batchStatements.push({
                sql: `INSERT INTO sync_clients 
                    (uuid, account_email, name, phone, rif, address, discount_rate, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET
                    name          = CASE WHEN excluded.version >= sync_clients.version THEN excluded.name ELSE sync_clients.name END,
                    phone         = CASE WHEN excluded.version >= sync_clients.version THEN excluded.phone ELSE sync_clients.phone END,
                    rif           = CASE WHEN excluded.version >= sync_clients.version THEN excluded.rif ELSE sync_clients.rif END,
                    address       = CASE WHEN excluded.version >= sync_clients.version THEN excluded.address ELSE sync_clients.address END,
                    discount_rate = CASE WHEN excluded.version >= sync_clients.version THEN excluded.discount_rate ELSE sync_clients.discount_rate END,
                    deleted_at    = CASE WHEN excluded.version >= sync_clients.version THEN excluded.deleted_at ELSE sync_clients.deleted_at END,
                    updated_at    = CASE WHEN excluded.version >= sync_clients.version THEN excluded.updated_at ELSE sync_clients.updated_at END,
                    version       = CASE WHEN excluded.version >= sync_clients.version THEN excluded.version ELSE sync_clients.version END`,
                args: mapP([item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.discount_rate, item.deleted_at, item.version, item.updated_at])
            });
        }

        // ─── FASE 1.1: PUSH PROVEEDORES ───────────────────────────────────
        for (const item of suppliers) {
            batchStatements.push({
                sql: `INSERT INTO sync_suppliers 
                    (uuid, account_email, name, phone, rif, address, email, contact_person, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET
                    name           = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.name ELSE sync_suppliers.name END,
                    phone          = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.phone ELSE sync_suppliers.phone END,
                    rif            = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.rif ELSE sync_suppliers.rif END,
                    address        = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.address ELSE sync_suppliers.address END,
                    email          = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.email ELSE sync_suppliers.email END,
                    contact_person = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.contact_person ELSE sync_suppliers.contact_person END,
                    deleted_at     = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.deleted_at ELSE sync_suppliers.deleted_at END,
                    updated_at     = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.updated_at ELSE sync_suppliers.updated_at END,
                    version        = CASE WHEN excluded.version >= sync_suppliers.version THEN excluded.version ELSE sync_suppliers.version END`,
                args: mapP([item.uuid, user.email, item.name, item.phone, item.rif, item.address, item.email, item.contact_person, item.deleted_at, item.version, item.updated_at])
            });
        }

        // ─── FASE 1.2: PUSH PRODUCTOS ──────────────────────────────────────
        for (const item of products) {
            batchStatements.push({
                sql: `INSERT INTO sync_products 
                    (uuid, account_email, code, name, description, unit, sale_price, is_exempt, supplier_uuid, stock, sales, category, wholesale_price, wholesale_quantity, is_on_sale, promo_price, promo_quantity, promo_start_date, promo_end_date, barcode, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET
                    code               = CASE WHEN excluded.version >= sync_products.version THEN excluded.code ELSE sync_products.code END,
                    name               = CASE WHEN excluded.version >= sync_products.version THEN excluded.name ELSE sync_products.name END,
                    description        = CASE WHEN excluded.version >= sync_products.version THEN excluded.description ELSE sync_products.description END,
                    unit               = CASE WHEN excluded.version >= sync_products.version THEN excluded.unit ELSE sync_products.unit END,
                    sale_price         = CASE WHEN excluded.version >= sync_products.version THEN excluded.sale_price ELSE sync_products.sale_price END,
                    is_exempt          = CASE WHEN excluded.version >= sync_products.version THEN excluded.is_exempt ELSE sync_products.is_exempt END,
                    supplier_uuid      = CASE WHEN excluded.version >= sync_products.version THEN excluded.supplier_uuid ELSE sync_products.supplier_uuid END,
                    stock              = CASE WHEN excluded.version >= sync_products.version THEN excluded.stock ELSE sync_products.stock END,
                    sales              = CASE WHEN excluded.version >= sync_products.version THEN excluded.sales ELSE sync_products.sales END,
                    category           = CASE WHEN excluded.version >= sync_products.version THEN excluded.category ELSE sync_products.category END,
                    wholesale_price    = CASE WHEN excluded.version >= sync_products.version THEN excluded.wholesale_price ELSE sync_products.wholesale_price END,
                    wholesale_quantity = CASE WHEN excluded.version >= sync_products.version THEN excluded.wholesale_quantity ELSE sync_products.wholesale_quantity END,
                    is_on_sale         = CASE WHEN excluded.version >= sync_products.version THEN excluded.is_on_sale ELSE sync_products.is_on_sale END,
                    promo_price        = CASE WHEN excluded.version >= sync_products.version THEN excluded.promo_price ELSE sync_products.promo_price END,
                    promo_quantity     = CASE WHEN excluded.version >= sync_products.version THEN excluded.promo_quantity ELSE sync_products.promo_quantity END,
                    promo_start_date   = CASE WHEN excluded.version >= sync_products.version THEN excluded.promo_start_date ELSE sync_products.promo_start_date END,
                    promo_end_date     = CASE WHEN excluded.version >= sync_products.version THEN excluded.promo_end_date ELSE sync_products.promo_end_date END,
                    barcode            = CASE WHEN excluded.version >= sync_products.version THEN excluded.barcode ELSE sync_products.barcode END,
                    deleted_at         = CASE WHEN excluded.version >= sync_products.version THEN excluded.deleted_at ELSE sync_products.deleted_at END,
                    updated_at         = CASE WHEN excluded.version >= sync_products.version THEN excluded.updated_at ELSE sync_products.updated_at END,
                    version            = CASE WHEN excluded.version >= sync_products.version THEN excluded.version ELSE sync_products.version END`,
                args: mapP([
                    item.uuid, user.email, item.code, item.name, item.description, item.unit, item.sale_price, 
                    item.is_exempt, item.supplier_uuid, item.stock, item.sales, item.category, 
                    item.wholesale_price, item.wholesale_quantity, item.is_on_sale, item.promo_price,
                    item.promo_quantity, item.promo_start_date, item.promo_end_date, item.barcode,
                    item.deleted_at, item.version, item.updated_at
                ])
            });
        }

        // ─── FASE 1.3: PUSH CATEGORÍAS ────────────────────────────────────
        for (const item of categories) {
            batchStatements.push({
                sql: `INSERT INTO sync_categories 
                    (uuid, account_email, name, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET
                    name       = CASE WHEN excluded.version >= sync_categories.version THEN excluded.name ELSE sync_categories.name END,
                    deleted_at = CASE WHEN excluded.version >= sync_categories.version THEN excluded.deleted_at ELSE sync_categories.deleted_at END,
                    updated_at = CASE WHEN excluded.version >= sync_categories.version THEN excluded.updated_at ELSE sync_categories.updated_at END,
                    version    = CASE WHEN excluded.version >= sync_categories.version THEN excluded.version ELSE sync_categories.version END`,
                args: mapP([item.uuid, user.email, item.name, item.deleted_at, item.version, item.updated_at])
            });
        }

        // ─── FASE 1.4: PUSH MOVIMIENTOS STOCK ────────────────────────────
        for (const item of stock_movements) {
            batchStatements.push({
                sql: `INSERT INTO sync_stock_movements 
                    (uuid, account_email, product_uuid, quantity, type, reason, reference_uuid, date, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET
                    quantity       = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.quantity ELSE sync_stock_movements.quantity END,
                    type           = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.type ELSE sync_stock_movements.type END,
                    reason         = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.reason ELSE sync_stock_movements.reason END,
                    reference_uuid = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.reference_uuid ELSE sync_stock_movements.reference_uuid END,
                    date           = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.date ELSE sync_stock_movements.date END,
                    deleted_at     = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.deleted_at ELSE sync_stock_movements.deleted_at END,
                    updated_at     = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.updated_at ELSE sync_stock_movements.updated_at END,
                    version        = CASE WHEN excluded.version >= sync_stock_movements.version THEN excluded.version ELSE sync_stock_movements.version END`,
                args: mapP([
                    item.uuid, user.email, item.product_uuid, item.quantity, item.type, item.reason, 
                    item.reference_uuid, item.date, item.deleted_at, item.version, item.updated_at
                ])
            });
        }

        // ─── FASE 2: PUSH FACTURAS + ÍTEMS ───────────────────────────────
        for (const inv of invoices) {
            batchStatements.push({
                sql: `INSERT INTO sync_invoices 
                    (uuid, account_email, number, client_uuid, client_name, client_address, client_rif, client_phone, iva_enabled, payment_method, due_date, budget, order_code, transport, salesperson, delivery_method, ship_to, observations, subtotal, tax, total, discount_amount, discount_percentage, exchange_rate, currency_symbol, working_currency, converted_from_uuid, date, type, document_type, deleted_at, version, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(uuid) DO UPDATE SET 
                    number              = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.number ELSE sync_invoices.number END,
                    client_uuid         = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.client_uuid ELSE sync_invoices.client_uuid END,
                    client_name         = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.client_name ELSE sync_invoices.client_name END,
                    client_address      = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.client_address ELSE sync_invoices.client_address END,
                    client_rif          = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.client_rif ELSE sync_invoices.client_rif END,
                    client_phone        = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.client_phone ELSE sync_invoices.client_phone END,
                    iva_enabled         = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.iva_enabled ELSE sync_invoices.iva_enabled END,
                    payment_method      = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.payment_method ELSE sync_invoices.payment_method END,
                    due_date            = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.due_date ELSE sync_invoices.due_date END,
                    budget              = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.budget ELSE sync_invoices.budget END,
                    order_code          = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.order_code ELSE sync_invoices.order_code END,
                    transport           = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.transport ELSE sync_invoices.transport END,
                    salesperson         = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.salesperson ELSE sync_invoices.salesperson END,
                    delivery_method     = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.delivery_method ELSE sync_invoices.delivery_method END,
                    ship_to             = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.ship_to ELSE sync_invoices.ship_to END,
                    observations        = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.observations ELSE sync_invoices.observations END,
                    subtotal            = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.subtotal ELSE sync_invoices.subtotal END,
                    tax                 = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.tax ELSE sync_invoices.tax END,
                    total               = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.total ELSE sync_invoices.total END,
                    discount_amount     = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.discount_amount ELSE sync_invoices.discount_amount END,
                    discount_percentage = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.discount_percentage ELSE sync_invoices.discount_percentage END,
                    exchange_rate       = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.exchange_rate ELSE sync_invoices.exchange_rate END,
                    currency_symbol     = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.currency_symbol ELSE sync_invoices.currency_symbol END,
                    working_currency    = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.working_currency ELSE sync_invoices.working_currency END,
                    converted_from_uuid = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.converted_from_uuid ELSE sync_invoices.converted_from_uuid END,
                    date                = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.date ELSE sync_invoices.date END,
                    type                = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.type ELSE sync_invoices.type END,
                    document_type       = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.document_type ELSE sync_invoices.document_type END,
                    deleted_at          = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.deleted_at ELSE sync_invoices.deleted_at END,
                    updated_at          = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.updated_at ELSE sync_invoices.updated_at END,
                    version             = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.version ELSE sync_invoices.version END`,
                args: mapP([
                    inv.uuid, user.email, inv.number, inv.client_uuid, inv.client_name, inv.client_address, inv.client_rif, inv.client_phone,
                    inv.iva_enabled, inv.payment_method, inv.due_date, inv.budget, inv.order_code, inv.transport, inv.salesperson, inv.delivery_method,
                    inv.ship_to, inv.observations, inv.subtotal, inv.tax, inv.total, inv.discount_amount, inv.discount_percentage, inv.exchange_rate, inv.currency_symbol, inv.working_currency,
                    inv.converted_from_uuid, inv.date, inv.type, inv.document_type, inv.deleted_at, inv.version, inv.updated_at
                ])
            });

            if (inv.deleted_at && Array.isArray(inv.items)) {
                for (const it of inv.items) {
                    batchStatements.push({
                        sql: `UPDATE sync_invoice_items SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE uuid = ? AND deleted_at IS NULL`,
                        args: [inv.deleted_at, inv.updated_at, it.uuid]
                    });
                }
            } else if (inv.items && Array.isArray(inv.items)) {
                for (const it of inv.items) {
                    batchStatements.push({
                        sql: `INSERT INTO sync_invoice_items 
                            (uuid, invoice_uuid, code, description, quantity, unit_price, total_price, is_exempt, product_uuid, discount, deleted_at, version, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(uuid) DO UPDATE SET 
                             code         = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.code ELSE sync_invoice_items.code END,
                             description  = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.description ELSE sync_invoice_items.description END,
                             quantity     = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.quantity ELSE sync_invoice_items.quantity END,
                             unit_price   = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.unit_price ELSE sync_invoice_items.unit_price END,
                             total_price  = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.total_price ELSE sync_invoice_items.total_price END,
                             is_exempt    = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.is_exempt ELSE sync_invoice_items.is_exempt END,
                             product_uuid = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.product_uuid ELSE sync_invoice_items.product_uuid END,
                             discount     = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.discount ELSE sync_invoice_items.discount END,
                             deleted_at   = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.deleted_at ELSE sync_invoice_items.deleted_at END,
                             updated_at   = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.updated_at ELSE sync_invoice_items.updated_at END,
                             version      = CASE WHEN excluded.version >= sync_invoice_items.version THEN excluded.version ELSE sync_invoice_items.version END`,
                        args: mapP([it.uuid, inv.uuid, it.code, it.description, it.quantity, it.unit_price, it.total_price, it.is_exempt, it.product_uuid, it.discount, it.deleted_at, it.version, it.updated_at])
                    });
                }
            }
        }

        // Ejecutar todo el PUSH en una sola transacción batch si hay algo que enviar
        if (batchStatements.length > 0) {
            if (typeof connection.batch !== 'function') {
                console.error('❌ [Sync Critical]: connection.batch no es una función. Métodos disponibles:', Object.keys(connection));
                throw new Error('El driver de base de datos no soporta operaciones en lote (batch). Verifique api/_db.js');
            }
            await connection.batch(batchStatements);
        }

        // ─── FASE 3: PULL (devolver todo al dispositivo o solo los cambios desde last_sync) ───────
        const lastSyncVal = lastSync || req.body?.last_sync;
        let syncDate = null;
        
        let clientSql = `SELECT * FROM sync_clients WHERE account_email = ?`;
        let invoiceSql = `SELECT * FROM sync_invoices WHERE account_email = ?`;
        let supplierSql = `SELECT * FROM sync_suppliers WHERE account_email = ?`;
        let productSql = `SELECT * FROM sync_products WHERE account_email = ?`;
        let categorySql = `SELECT * FROM sync_categories WHERE account_email = ?`;
        let movementSql = `SELECT * FROM sync_stock_movements WHERE account_email = ?`;

        if (lastSyncVal) {
            syncDate = new Date(lastSyncVal).toISOString().slice(0, 19).replace('T', ' ');
            clientSql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
            invoiceSql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
            supplierSql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
            productSql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
            categorySql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
            movementSql += ` AND (updated_at >= ? OR deleted_at >= ?)`;
        }

        const queryParams = [user.email];
        if (syncDate) queryParams.push(syncDate, syncDate);

        const [remoteClients]    = await connection.execute(clientSql, queryParams);
        const [remoteInvoices]   = await connection.execute(invoiceSql, queryParams);
        const [remoteSuppliers]  = await connection.execute(supplierSql, queryParams);
        const [remoteProducts]   = await connection.execute(productSql, queryParams);
        const [remoteCategories] = await connection.execute(categorySql, queryParams);
        const [remoteMovements]  = await connection.execute(movementSql, queryParams);

        // ─── OPTIMIZACIÓN N+1: Cargar todos los ítems de las facturas devueltas en UNA sola consulta ───
        if (remoteInvoices.length > 0) {
            const invoiceUuids = remoteInvoices.map(inv => inv.uuid);
            // Creamos los placeholders (?, ?, ?) para el IN
            const placeholders = invoiceUuids.map(() => '?').join(',');
            const [allItems] = await connection.execute(
                `SELECT * FROM sync_invoice_items WHERE invoice_uuid IN (${placeholders})`,
                invoiceUuids
            );

            // Agrupar ítems por su invoice_uuid
            const itemsByInvoice = {};
            for (const item of allItems) {
                if (!itemsByInvoice[item.invoice_uuid]) itemsByInvoice[item.invoice_uuid] = [];
                itemsByInvoice[item.invoice_uuid].push(item);
            }

            // Asignar los ítems a cada factura
            for (const inv of remoteInvoices) {
                inv.items = itemsByInvoice[inv.uuid] || [];
            }
        }

        // PULL PROFILE
        const [profileRows] = await connection.execute(
            `SELECT business_name, slogan, rif, address, user_name, email, user_phone, accent_color, header_color,
                    exchange_rate_mode, working_currency, display_currency, print_currency,
                    manual_rate, use_latest_rate, usd_rate_latest, usd_rate_previous,
                    show_banner_invoice, show_banner_quote, show_banner_delivery,
                    banner_color, show_exchange_rate, config_style, products_by_stock,
                    catalog_document_title, catalog_layout_style, catalog_logo_path,
                    catalog_logo_position, catalog_banner_color, catalog_header_color,
                    catalog_show_stock, catalog_show_price_bs, catalog_show_price_usd,
                    catalog_show_iva, catalog_show_address, catalog_show_phone,
                    catalog_show_slogan, catalog_show_exchange_rate, catalog_show_product_code,
                    catalog_show_product_description, catalog_show_promos, catalog_show_wholesale,
                    catalog_footer_text, catalog_grayscale_mode,
                    version, updated_at 
             FROM clientes WHERE email = ? LIMIT 1`,
            [user.email]
        );

        // Procesar el perfil para convertir el logo Blob a Base64 para la transmisión de vuelta
        const profileResponse = profileRows[0] || null;
        if (profileResponse && profileResponse.catalog_logo_path) {
            const logo = profileResponse.catalog_logo_path;
            if (logo instanceof Buffer) {
                profileResponse.catalog_logo_path = logo.toString('base64');
            } else if (logo && logo.type === 'Buffer' && logo.data) {
                profileResponse.catalog_logo_path = Buffer.from(logo.data).toString('base64');
            }
        }

        // PULL NOTIFICATIONS
        const [notifications] = await connection.execute(
            `SELECT * FROM app_notifications 
             WHERE is_active = 1 
             AND (target_email IS NULL OR target_email = ?)
             AND (start_date IS NULL OR start_date <= CURRENT_TIMESTAMP)
             AND (end_date IS NULL OR end_date >= CURRENT_TIMESTAMP)`,
            [user.email]
        );

        // ─── FASE 4: CHECKSUM GLOBAL (Suma de versiones de TODO lo que el usuario tiene en la nube) ───
        // Esto permite que el dispositivo detecte si le falta algo (incluso registros viejos) y fuerce re-sync.
        const [checksumResults] = await connection.execute(`
            SELECT (
                (SELECT COALESCE(SUM(version), 0) FROM sync_clients WHERE account_email = ?) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_invoices WHERE account_email = ?) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_invoice_items WHERE invoice_uuid IN (SELECT uuid FROM sync_invoices WHERE account_email = ?)) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_suppliers WHERE account_email = ?) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_products WHERE account_email = ?) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_categories WHERE account_email = ?) + 
                (SELECT COALESCE(SUM(version), 0) FROM sync_stock_movements WHERE account_email = ?)
            ) as global_checksum`, 
            [user.email, user.email, user.email, user.email, user.email, user.email, user.email]
        );

        const globalChecksum = parseInt(checksumResults[0]?.global_checksum || 0);

        // ─── CERRAR CONEXIÓN ANTES DE RESPONDER ───────────────────────────
        connection.destroy();

        return res.status(200).json({
            clients:    remoteClients,
            invoices:   remoteInvoices,
            suppliers:  remoteSuppliers,
            products:   remoteProducts,
            categories: remoteCategories,
            stock_movements: remoteMovements,
            profile:    profileResponse,
            notifications: notifications,
            checksum:   globalChecksum
        });

    } catch (e) {
        if (connection) connection.destroy();
        console.error('❌ [Sync Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
