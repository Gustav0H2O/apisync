// Especificación compartida de tablas del sync v47 (change-feed).
// Los nombres de tabla del feed son los del CLIENTE (kDirtyTrackedTables);
// aquí se mapean a las tablas espejo de Turso y sus columnas sincronizables.
// Referencia: docs/informes/INFORME_API_SYNC.md + INFORME_TURSO_SCHEMA.md.

export const TABLE_SPECS = {
    clients: {
        remote: 'sync_clients',
        accountScoped: true,
        cols: ['name', 'phone', 'rif', 'address', 'discount_rate'],
    },
    suppliers: {
        remote: 'sync_suppliers',
        accountScoped: true,
        cols: ['name', 'rif', 'phone', 'email', 'address', 'contact_person'],
    },
    categories: {
        remote: 'sync_categories',
        accountScoped: true,
        cols: ['name'],
    },
    products: {
        remote: 'sync_products',
        accountScoped: true,
        cols: [
            'code', 'name', 'description', 'unit', 'sale_price', 'is_exempt',
            'supplier_uuid', 'stock', 'sales', 'category', 'barcode',
            'wholesale_price', 'wholesale_quantity', 'is_on_sale',
            'promo_price', 'promo_quantity', 'promo_start_date', 'promo_end_date',
            'promo_rules', 'promo_clients', 'tax_type', 'type', 'is_active',
        ],
        // Identidad de negocio: mismo código creado offline en dos dispositivos
        // se fusiona sobre la fila canónica en vez de duplicarse.
        businessKey: { cols: ['code'], notEmpty: 'code' },
    },
    invoices: {
        remote: 'sync_invoices',
        accountScoped: true,
        cols: [
            'number', 'client_uuid', 'client_name', 'client_address', 'client_rif',
            'client_phone', 'iva_enabled', 'payment_method', 'due_date', 'budget',
            'order_code', 'transport', 'salesperson', 'delivery_method', 'ship_to',
            'converted_from_uuid', 'observations', 'subtotal', 'tax', 'total',
            'exchange_rate', 'currency_symbol', 'working_currency', 'date', 'type',
            'document_type', 'discount_amount', 'discount_percentage', 'status',
            'related_invoice_uuid',
            // Campos fiscales SENIAT (migración v47 de Turso)
            'control_number', 'correlative_number', 'document_hash', 'sealed_at',
            'igtf_percentage', 'igtf_amount', 'igtf_base',
            'tax_base_general', 'tax_base_reduced', 'tax_base_additional',
            'tax_base_exempt', 'applied_retention_iva', 'applied_retention_islr',
            'emission_source',
        ],
        businessKey: { cols: ['document_type', 'number'], notEmpty: 'number' },
        sealed: true,
    },
    invoice_items: {
        remote: 'sync_invoice_items',
        accountScoped: false, // el alcance de cuenta viene por la factura padre
        parent: { table: 'sync_invoices', fk: 'invoice_uuid' },
        cols: [
            'invoice_uuid', 'product_uuid', 'code', 'description', 'quantity',
            'unit_price', 'total_price', 'is_exempt', 'discount', 'tax_type',
        ],
    },
    stock_movements: {
        remote: 'sync_stock_movements',
        accountScoped: true,
        cols: ['product_uuid', 'quantity', 'type', 'reason', 'reference_uuid', 'date'],
    },
    // v48: alícuotas IVA/IGTF personalizadas — no se sincronizaban en absoluto
    // (cada dispositivo calculaba totales con tasas distintas). Requiere la
    // tabla sync_taxes en Turso (scripts/migracion_taxes_turso.sql).
    taxes: {
        remote: 'sync_taxes',
        accountScoped: true,
        cols: ['name', 'rate', 'type', 'is_default'],
    },
    audit_logs: {
        remote: 'sync_audit_logs',
        accountScoped: true,
        cols: [
            'user_email', 'action', 'entity_type', 'entity_uuid',
            'old_value', 'new_value', 'occurred_at', 'device_id',
        ],
        // Trazabilidad SENIAT: los registros de auditoría son de solo-agregado.
        appendOnly: true,
    },
    expenses: {
        remote: 'sync_expenses',
        accountScoped: true,
        cols: [
            'supplier_uuid', 'supplier_name', 'supplier_rif', 'date',
            'control_number', 'invoice_number', 'subtotal',
            'tax_base_general', 'tax_base_reduced', 'tax_base_additional',
            'tax_base_exempt', 'tax_general', 'tax_reduced', 'tax_additional',
            'applied_retention_iva', 'applied_retention_islr', 'total',
        ],
    },
    fiscal_transmissions: {
        remote: 'fiscal_transmissions',
        accountScoped: true,
        cols: ['invoice_uuid', 'sent_at', 'status', 'response_code', 'retry_count', 'last_attempt_at'],
    },
    user_roles: {
        remote: 'user_roles',
        accountScoped: true,
        cols: ['email', 'role'],
    },
};

// Orden de aplicación: padres antes que hijos (FKs de Turso).
export const TABLE_ORDER = [
    'clients', 'suppliers', 'categories', 'products', 'invoices',
    'invoice_items', 'stock_movements', 'audit_logs', 'expenses',
    'fiscal_transmissions', 'user_roles', 'taxes',
];

export function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/// Sentencias del patrón change-feed: bump del cursor + entrada en change_log,
/// SIEMPRE dentro del mismo batch atómico que la escritura que registran.
export function changeLogStatements(email, tableName, rowUuid, op) {
    return [
        {
            sql: 'UPDATE account_cursor SET seq = seq + 1 WHERE account_email = ?',
            args: [email],
        },
        {
            sql: `INSERT INTO change_log (account_email, seq, table_name, row_uuid, op)
                  VALUES (?, (SELECT seq FROM account_cursor WHERE account_email = ?), ?, ?, ?)`,
            args: [email, email, tableName, rowUuid, op],
        },
    ];
}

export function ensureCursorStatement(email) {
    return {
        sql: 'INSERT OR IGNORE INTO account_cursor (account_email, seq) VALUES (?, 0)',
        args: [email],
    };
}
