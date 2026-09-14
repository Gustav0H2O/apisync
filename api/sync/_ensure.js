// Auto-aprovisionamiento de tablas espejo (escalabilidad horizontal).
//
// Regla: agregar una tabla al sync = UNA entrada en TABLE_SPECS (+ su
// espejo en el cliente). Este módulo deriva el DDL del spec y ejecuta
// CREATE TABLE IF NOT EXISTS de forma best-effort ANTES de cada push,
// así ningún despliegue nuevo exige migraciones manuales en Turso.
//
// Los tipos viven junto al spec (una sola fuente de verdad). Si la tabla ya
// existe, IF NOT EXISTS lo vuelve no-op: jamás altera esquemas existentes.
import { TABLE_SPECS } from './_tables.js';

// Tipos por defecto cuando el spec no declara `schema`: TEXT seguro para
// identificadores y fechas; los números van en REAL/INTEGER explícitos.
const COMMON_COLS = {
    uuid: 'TEXT PRIMARY KEY',
    account_email: 'TEXT',
    version: 'INTEGER DEFAULT 1',
    updated_at: 'TEXT',
    deleted_at: 'TEXT',
};

const COMMON_COLS_CHILD = {
    uuid: 'TEXT PRIMARY KEY',
    version: 'INTEGER DEFAULT 1',
    updated_at: 'TEXT',
    deleted_at: 'TEXT',
};

export const TABLE_SCHEMAS = {
    clients: {
        name: 'TEXT', phone: 'TEXT', rif: 'TEXT', address: 'TEXT',
        discount_rate: 'REAL',
    },
    suppliers: {
        name: 'TEXT', rif: 'TEXT', phone: 'TEXT', email: 'TEXT',
        address: 'TEXT', contact_person: 'TEXT',
    },
    categories: { name: 'TEXT' },
    products: {
        code: 'TEXT', name: 'TEXT', description: 'TEXT', unit: 'TEXT',
        sale_price: 'REAL', is_exempt: 'INTEGER', supplier_uuid: 'TEXT',
        stock: 'REAL', sales: 'REAL', category: 'TEXT', barcode: 'TEXT',
        wholesale_price: 'REAL', wholesale_quantity: 'REAL',
        is_on_sale: 'INTEGER', promo_price: 'REAL', promo_quantity: 'REAL',
        promo_start_date: 'TEXT', promo_end_date: 'TEXT',
        promo_rules: 'TEXT', promo_clients: 'TEXT',
        tax_type: 'TEXT', type: 'TEXT', is_active: 'INTEGER',
    },
    invoices: {
        number: 'TEXT', client_uuid: 'TEXT', client_name: 'TEXT',
        client_address: 'TEXT', client_rif: 'TEXT', client_phone: 'TEXT',
        iva_enabled: 'INTEGER', payment_method: 'TEXT', due_date: 'TEXT',
        budget: 'TEXT', order_code: 'TEXT', transport: 'TEXT',
        salesperson: 'TEXT', delivery_method: 'TEXT', ship_to: 'TEXT',
        converted_from_uuid: 'TEXT', observations: 'TEXT',
        subtotal: 'REAL', tax: 'REAL', total: 'REAL',
        exchange_rate: 'REAL', currency_symbol: 'TEXT',
        working_currency: 'TEXT', date: 'TEXT', type: 'TEXT',
        document_type: 'TEXT', discount_amount: 'REAL',
        discount_percentage: 'REAL', status: 'TEXT',
        related_invoice_uuid: 'TEXT',
        control_number: 'TEXT', correlative_number: 'TEXT',
        document_hash: 'TEXT', sealed_at: 'TEXT',
        igtf_percentage: 'REAL', igtf_amount: 'REAL', igtf_base: 'REAL',
        tax_base_general: 'REAL', tax_base_reduced: 'REAL',
        tax_base_additional: 'REAL', tax_base_exempt: 'REAL',
        applied_retention_iva: 'REAL', applied_retention_islr: 'REAL',
        emission_source: 'TEXT',
    },
    invoice_items: {
        invoice_uuid: 'TEXT', product_uuid: 'TEXT', code: 'TEXT',
        description: 'TEXT', quantity: 'REAL', unit_price: 'REAL',
        total_price: 'REAL', is_exempt: 'INTEGER', discount: 'REAL',
        tax_type: 'TEXT',
    },
    stock_movements: {
        product_uuid: 'TEXT', quantity: 'REAL', type: 'TEXT',
        reason: 'TEXT', reference_uuid: 'TEXT', date: 'TEXT',
    },
    taxes: {
        name: 'TEXT', rate: 'REAL', type: 'TEXT', is_default: 'INTEGER',
    },
    audit_logs: {
        user_email: 'TEXT', action: 'TEXT', entity_type: 'TEXT',
        entity_uuid: 'TEXT', old_value: 'TEXT', new_value: 'TEXT',
        occurred_at: 'TEXT', device_id: 'TEXT',
    },
    expenses: {
        supplier_uuid: 'TEXT', supplier_name: 'TEXT', supplier_rif: 'TEXT',
        date: 'TEXT', control_number: 'TEXT', invoice_number: 'TEXT',
        subtotal: 'REAL', tax_base_general: 'REAL',
        tax_base_reduced: 'REAL', tax_base_additional: 'REAL',
        tax_base_exempt: 'REAL', tax_general: 'REAL', tax_reduced: 'REAL',
        tax_additional: 'REAL', applied_retention_iva: 'REAL',
        applied_retention_islr: 'REAL', total: 'REAL',
    },
    fiscal_transmissions: {
        invoice_uuid: 'TEXT', sent_at: 'TEXT', status: 'TEXT',
        response_code: 'TEXT', retry_count: 'INTEGER',
        last_attempt_at: 'TEXT',
    },
    user_roles: { email: 'TEXT', role: 'TEXT' },
};

export function mirrorDdl(clientTable) {
    const spec = TABLE_SPECS[clientTable];
    const schema = TABLE_SCHEMAS[clientTable];
    if (!spec || !schema) return null;
    const base = spec.accountScoped ? COMMON_COLS : COMMON_COLS_CHILD;
    const cols = { ...base };
    for (const c of spec.cols) {
        cols[c] = schema[c] || 'TEXT';
    }
    const defs = Object.entries(cols).map(([name, type]) => `${name} ${type}`);
    return `CREATE TABLE IF NOT EXISTS ${spec.remote} (${defs.join(', ')})`;
}

export const INFRA_DDL = [
    `CREATE TABLE IF NOT EXISTS account_cursor (
        account_email TEXT PRIMARY KEY, seq INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_email TEXT,
        seq INTEGER, table_name TEXT, row_uuid TEXT, op TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_change_log_account_seq
        ON change_log (account_email, seq)`,
];

/**
 * Asegura espejos + infraestructura para las tablas del cliente indicadas.
 * Best-effort por tabla: un fallo se registra y NO tumba el push (la tabla
 * se omite igual que con esquema viejo, ver _push.js).
 * Devuelve la lista de tablas aseguradas.
 */
export async function ensureMirrorTables(connection, clientTables) {
    const ensured = [];
    for (const table of clientTables) {
        const ddl = mirrorDdl(table);
        if (!ddl) continue;
        try {
            await connection.execute(ddl, []);
            ensured.push(table);
        } catch (e) {
            console.warn(`⚠️ [Ensure] No se pudo asegurar ${table}: ${e.message}`);
        }
    }
    for (const ddl of INFRA_DDL) {
        try {
            await connection.execute(ddl, []);
        } catch (e) {
            console.warn(`⚠️ [Ensure] Infra no asegurada: ${e.message}`);
        }
    }
    return ensured;
}
