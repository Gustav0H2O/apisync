import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiDir = path.join(__dirname, '..', 'api');

// 1. Update _tables.js
const tablesPath = path.join(apiDir, 'sync', '_tables.js');
let tables = fs.readFileSync(tablesPath, 'utf8');
if (!tables.includes('has_blister')) {
    tables = tables.replace(
        `'supplier_list_price', 'supplier_discount_percent', 'purchase_bcv_rate', 'purchase_usdt_rate',`,
        `'supplier_list_price', 'supplier_discount_percent', 'purchase_bcv_rate', 'purchase_usdt_rate',\n            'wholesale_unit_price', 'wholesale_unit_quantity', 'min_sale_quantity', 'min_sale_unit_quantity', 'has_blister', 'units_per_blister',`
    );
}
if (!tables.includes('is_paid')) {
    tables = tables.replace(
        `'client_trade_name', 'is_client_special_taxpayer',`,
        `'client_trade_name', 'is_client_special_taxpayer', 'is_paid',`
    );
}
fs.writeFileSync(tablesPath, tables, 'utf8');
console.log('✅ Updated _tables.js');

// 2. Update _ensure.js
const ensurePath = path.join(apiDir, 'sync', '_ensure.js');
let ensure = fs.readFileSync(ensurePath, 'utf8');
if (!ensure.includes('has_blister')) {
    ensure = ensure.replace(
        `supplier_list_price: 'REAL', supplier_discount_percent: 'REAL', purchase_bcv_rate: 'REAL', purchase_usdt_rate: 'REAL',`,
        `supplier_list_price: 'REAL', supplier_discount_percent: 'REAL', purchase_bcv_rate: 'REAL', purchase_usdt_rate: 'REAL',\n        wholesale_unit_price: 'REAL', wholesale_unit_quantity: 'REAL', min_sale_quantity: 'REAL', min_sale_unit_quantity: 'REAL', has_blister: 'INTEGER', units_per_blister: 'REAL',`
    );
}
if (!ensure.includes('is_paid')) {
    ensure = ensure.replace(
        `emission_source: 'TEXT',`,
        `emission_source: 'TEXT', is_paid: 'INTEGER',`
    );
}
fs.writeFileSync(ensurePath, ensure, 'utf8');
console.log('✅ Updated _ensure.js');

// 3. Update sync.js
const syncPath = path.join(apiDir, 'sync.js');
let sync = fs.readFileSync(syncPath, 'utf8');
if (!sync.includes('has_blister')) {
    sync = sync.replace(
        `supplier_list_price, supplier_discount_percent, purchase_bcv_rate, purchase_usdt_rate, deleted_at, version, updated_at)`,
        `supplier_list_price, supplier_discount_percent, purchase_bcv_rate, purchase_usdt_rate, wholesale_unit_price, wholesale_unit_quantity, min_sale_quantity, min_sale_unit_quantity, has_blister, units_per_blister, deleted_at, version, updated_at)`
    );
    // There are 46 placeholders originally in sync_products, now 52 placeholders
    const oldPlaceholders = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const newPlaceholders = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    sync = sync.replace(oldPlaceholders, newPlaceholders);

    sync = sync.replace(
        `purchase_usdt_rate  = CASE WHEN excluded.version >= sync_products.version THEN excluded.purchase_usdt_rate ELSE sync_products.purchase_usdt_rate END,`,
        `purchase_usdt_rate  = CASE WHEN excluded.version >= sync_products.version THEN excluded.purchase_usdt_rate ELSE sync_products.purchase_usdt_rate END,\n                    wholesale_unit_price = CASE WHEN excluded.version >= sync_products.version THEN excluded.wholesale_unit_price ELSE sync_products.wholesale_unit_price END,\n                    wholesale_unit_quantity = CASE WHEN excluded.version >= sync_products.version THEN excluded.wholesale_unit_quantity ELSE sync_products.wholesale_unit_quantity END,\n                    min_sale_quantity  = CASE WHEN excluded.version >= sync_products.version THEN excluded.min_sale_quantity ELSE sync_products.min_sale_quantity END,\n                    min_sale_unit_quantity = CASE WHEN excluded.version >= sync_products.version THEN excluded.min_sale_unit_quantity ELSE sync_products.min_sale_unit_quantity END,\n                    has_blister        = CASE WHEN excluded.version >= sync_products.version THEN excluded.has_blister ELSE sync_products.has_blister END,\n                    units_per_blister  = CASE WHEN excluded.version >= sync_products.version THEN excluded.units_per_blister ELSE sync_products.units_per_blister END,`
    );
    sync = sync.replace(
        `item.supplier_list_price, item.supplier_discount_percent, item.purchase_bcv_rate, item.purchase_usdt_rate,\r\n                    item.deleted_at, item.version, item.updated_at`,
        `item.supplier_list_price, item.supplier_discount_percent, item.purchase_bcv_rate, item.purchase_usdt_rate,\r\n                    item.wholesale_unit_price, item.wholesale_unit_quantity, item.min_sale_quantity, item.min_sale_unit_quantity,\r\n                    item.has_blister ? 1 : 0, item.units_per_blister,\r\n                    item.deleted_at, item.version, item.updated_at`
    );
    // Also handle LF just in case
    sync = sync.replace(
        `item.supplier_list_price, item.supplier_discount_percent, item.purchase_bcv_rate, item.purchase_usdt_rate,\n                    item.deleted_at, item.version, item.updated_at`,
        `item.supplier_list_price, item.supplier_discount_percent, item.purchase_bcv_rate, item.purchase_usdt_rate,\n                    item.wholesale_unit_price, item.wholesale_unit_quantity, item.min_sale_quantity, item.min_sale_unit_quantity,\n                    item.has_blister ? 1 : 0, item.units_per_blister,\n                    item.deleted_at, item.version, item.updated_at`
    );
}

if (!sync.includes('is_paid')) {
    sync = sync.replace(
        `client_trade_name, is_client_special_taxpayer, deleted_at, version, updated_at)`,
        `client_trade_name, is_client_special_taxpayer, is_paid, deleted_at, version, updated_at)`
    );
    // In invoices: 51 placeholders originally, now 52
    const oldInvPlaceholders = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const newInvPlaceholders = 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    sync = sync.replace(oldInvPlaceholders, newInvPlaceholders);

    sync = sync.replace(
        `is_client_special_taxpayer = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.is_client_special_taxpayer ELSE sync_invoices.is_client_special_taxpayer END,`,
        `is_client_special_taxpayer = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.is_client_special_taxpayer ELSE sync_invoices.is_client_special_taxpayer END,\n                    is_paid             = CASE WHEN excluded.version >= sync_invoices.version THEN excluded.is_paid ELSE sync_invoices.is_paid END,`
    );
    sync = sync.replace(
        `inv.client_trade_name, inv.is_client_special_taxpayer,\r\n                    inv.deleted_at, inv.version, inv.updated_at`,
        `inv.client_trade_name, inv.is_client_special_taxpayer,\r\n                    inv.is_paid ? 1 : 0,\r\n                    inv.deleted_at, inv.version, inv.updated_at`
    );
    sync = sync.replace(
        `inv.client_trade_name, inv.is_client_special_taxpayer,\n                    inv.deleted_at, inv.version, inv.updated_at`,
        `inv.client_trade_name, inv.is_client_special_taxpayer,\n                    inv.is_paid ? 1 : 0,\n                    inv.deleted_at, inv.version, inv.updated_at`
    );
}
fs.writeFileSync(syncPath, sync, 'utf8');
console.log('✅ Updated sync.js');
