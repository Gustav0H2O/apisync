import { getConnection } from '../api/_db.js';

async function main() {
    const conn = getConnection();
    console.log('Ensuring sync_transfers table...');
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS sync_transfers (
            uuid TEXT PRIMARY KEY,
            account_email TEXT,
            account_key TEXT,
            transfer_number TEXT,
            from_warehouse_id INTEGER,
            to_warehouse_id INTEGER,
            date TEXT,
            reason TEXT,
            observations TEXT,
            items_json TEXT,
            status TEXT,
            version INTEGER DEFAULT 1,
            created_at TEXT,
            updated_at TEXT,
            deleted_at TEXT
        )
    `);
    console.log('✅ sync_transfers table ensured');

    console.log('Registering warehouses and transfers in sync_table_registry...');
    await conn.execute(`
        INSERT OR REPLACE INTO sync_table_registry (
            local_table, remote_table, columns, account_scoped,
            business_key, sealed, append_only, depends_on, sort_order, enabled, updated_at
        ) VALUES (
            'warehouses', 'sync_warehouses',
            '["code","name","description","is_default","allow_sale","is_active","created_at"]',
            1, NULL, 0, 0, NULL, 140, 1, datetime('now')
        )
    `);

    await conn.execute(`
        INSERT OR REPLACE INTO sync_table_registry (
            local_table, remote_table, columns, account_scoped,
            business_key, sealed, append_only, depends_on, sort_order, enabled, updated_at
        ) VALUES (
            'transfers', 'sync_transfers',
            '["transfer_number","from_warehouse_id","to_warehouse_id","date","reason","observations","items_json","status","created_at"]',
            1, NULL, 0, 0, '["warehouses"]', 150, 1, datetime('now')
        )
    `);

    console.log('✅ warehouses & transfers successfully registered in Turso');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
