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
    const safeTable = String(clientTable || '').toLowerCase().trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(safeTable)) return null;

    const spec = TABLE_SPECS[clientTable];
    const schema = TABLE_SCHEMAS[clientTable];
    
    if (spec && schema) {
        const base = spec.accountScoped ? COMMON_COLS : COMMON_COLS_CHILD;
        const cols = { ...base };
        for (const c of spec.cols) {
            cols[c] = schema[c] || 'TEXT';
        }
        const defs = Object.entries(cols).map(([name, type]) => `${name} ${type}`);
        return `CREATE TABLE IF NOT EXISTS ${spec.remote} (${defs.join(', ')})`;
    }

    // Tabla dinámica extensible: aprovisionar con envoltorio universal multi-inquilino
    const remoteTable = `sync_${safeTable}`;
    const defs = Object.entries(COMMON_COLS).map(([name, type]) => `${name} ${type}`);
    return `CREATE TABLE IF NOT EXISTS ${remoteTable} (${defs.join(', ')})`;
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
    `CREATE TABLE IF NOT EXISTS app_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, target_email TEXT,
        condition_key TEXT, condition_op TEXT, condition_val TEXT,
        title TEXT DEFAULT 'Notificación', message TEXT NOT NULL,
        type TEXT DEFAULT 'info', is_active INTEGER DEFAULT 1,
        show_once INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        start_date TEXT, end_date TEXT, repeat_interval INTEGER DEFAULT 0,
        route TEXT, action_data TEXT
    )`,
];

// Cache en memoria de columnas por tabla remota para evitar consultas repetitivas
const _tableColumnsCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

export async function getTableColumns(connection, clientTable) {
    const safeTable = String(clientTable || '').toLowerCase().trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(safeTable)) return new Set();

    const spec = TABLE_SPECS[clientTable];
    const remote = spec?.remote || `sync_${safeTable}`;

    const cached = _tableColumnsCache.get(remote);
    const now = Date.now();
    if (cached && (now - cached.time < CACHE_TTL_MS)) {
        return cached.cols;
    }

    try {
        const [rows] = await connection.execute(`PRAGMA table_info(${remote})`);
        const cols = new Set((rows || []).map(r => r.name));
        _tableColumnsCache.set(remote, { cols, time: now });
        return cols;
    } catch (e) {
        return new Set();
    }
}

/**
 * Auto-migración dinámica de columnas (Escalabilidad Horizontal y Vertical).
 * Si FactuFlow agrega campos a su esquema, se agregan automáticamente a Turso
 * mediante ALTER TABLE ADD COLUMN sin interrumpir la sincronización ni requerir
 * migraciones manuales en producción.
 */
export async function autoMigrateColumns(connection, clientTable, sampleRow = null) {
    const safeTable = String(clientTable || '').toLowerCase().trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(safeTable)) return new Set();

    const spec = TABLE_SPECS[clientTable];
    const remote = spec?.remote || `sync_${safeTable}`;
    const schema = TABLE_SCHEMAS[clientTable];

    const currentCols = await getTableColumns(connection, clientTable);
    if (!currentCols.size) return currentCols;

    // 1. Columnas declaradas en schema pero faltantes en la BD física
    if (schema) {
        for (const [col, type] of Object.entries(schema)) {
            if (!currentCols.has(col)) {
                try {
                    await connection.execute(`ALTER TABLE ${remote} ADD COLUMN ${col} ${type}`);
                    currentCols.add(col);
                    console.log(`✨ [AutoMigrate] Columna agregada a ${remote}: ${col} ${type}`);
                } catch (err) {
                    if (!err.message?.includes('duplicate column name')) {
                        console.warn(`⚠️ [AutoMigrate] No se pudo agregar columna ${col} a ${remote}: ${err.message}`);
                    }
                }
            }
        }
    }

    // 2. Escalabilidad dinámica: si sampleRow trae campos nuevos válidos
    if (sampleRow && typeof sampleRow === 'object') {
        for (const [key, val] of Object.entries(sampleRow)) {
            const safeCol = key.toLowerCase().trim();
            if (!/^[a-z][a-z0-9_]{1,40}$/.test(safeCol)) continue;
            if (currentCols.has(safeCol)) continue;
            if (['uuid', 'account_email', 'version', 'updated_at', 'deleted_at'].includes(safeCol)) continue;

            const inferredType = typeof val === 'number'
                ? (Number.isInteger(val) ? 'INTEGER' : 'REAL')
                : 'TEXT';
            try {
                await connection.execute(`ALTER TABLE ${remote} ADD COLUMN ${safeCol} ${inferredType}`);
                currentCols.add(safeCol);
                console.log(`✨ [AutoMigrate Dynamic] Columna dinámica agregada a ${remote}: ${safeCol} ${inferredType}`);
            } catch (err) {
                // Si otra lambda concurrente ya la agregó, se ignora pacíficamente
                if (!err.message?.includes('duplicate column name')) {
                    console.warn(`⚠️ [AutoMigrate] Fallo menor al agregar ${safeCol} a ${remote}:`, err.message);
                }
            }
        }
    }

    return currentCols;
}

/**
 * Asegura espejos + infraestructura para las tablas del cliente indicadas.
 * Best-effort por tabla: un fallo se registra y NO tumba el push.
 * Devuelve la lista de tablas aseguradas.
 */
export async function ensureMirrorTables(connection, clientTables, changes = null) {
    const ensured = [];
    for (const table of clientTables) {
        const ddl = mirrorDdl(table);
        if (!ddl) continue;
        try {
            await connection.execute(ddl, []);
            ensured.push(table);
            const sample = (changes && Array.isArray(changes[table]) && changes[table][0]) || null;
            await autoMigrateColumns(connection, table, sample);

            // Índice para tabla dinámica si no está en TABLE_SPECS
            if (!TABLE_SPECS[table]) {
                const remoteTable = `sync_${table.toLowerCase().trim()}`;
                try {
                    await connection.execute(`
                        CREATE INDEX IF NOT EXISTS idx_${remoteTable}_acc_uuid 
                        ON ${remoteTable} (account_email, uuid)
                    `);
                } catch (idxErr) {
                    // Ignore index creation race
                }
            }
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
