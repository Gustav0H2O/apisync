CREATE TABLE IF NOT EXISTS sync_table_registry (
  local_table TEXT PRIMARY KEY,
  remote_table TEXT NOT NULL,
  columns TEXT,
  account_scoped INTEGER NOT NULL DEFAULT 1,
  business_key TEXT,
  sealed INTEGER NOT NULL DEFAULT 0,
  append_only INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- GENERADO AUTOMÁTICAMENTE desde api/sync/_tables.js (no editar a mano).
-- Regenerar: node gen_seed.mjs
--
-- A partir de este registro, agregar tablas o columnas al sync es una
-- operación de base de datos (INSERT/UPDATE), sin tocar ni desplegar la API.
-- columns = NULL significa "descubrir con PRAGMA table_info".

INSERT OR REPLACE INTO sync_table_registry
  (local_table, remote_table, columns, account_scoped, business_key, sealed, append_only, depends_on, sort_order)
VALUES
  ('clients', 'sync_clients', '["name","phone","rif","address","discount_rate"]', 1, '{"cols":["rif"],"notEmpty":"rif","ignoreValues":["v-0","j-0","v0","j0"]}', 0, 0, NULL, 10),
  ('suppliers', 'sync_suppliers', '["name","rif","phone","email","address","contact_person"]', 1, '{"cols":["rif"],"notEmpty":"rif","ignoreValues":["v-0","j-0","v0","j0"]}', 0, 0, NULL, 20),
  ('categories', 'sync_categories', '["name"]', 1, NULL, 0, 0, NULL, 30),
  ('products', 'sync_products', '["code","name","description","unit","sale_price","is_exempt","supplier_uuid","stock","sales","category","barcode","wholesale_price","wholesale_quantity","is_on_sale","promo_price","promo_quantity","promo_start_date","promo_end_date","promo_rules","promo_clients","tax_type","type","is_active"]', 1, '{"cols":["code"],"notEmpty":"code"}', 0, 0, NULL, 40),
  ('invoices', 'sync_invoices', '["number","client_uuid","client_name","client_address","client_rif","client_phone","iva_enabled","payment_method","due_date","budget","order_code","transport","salesperson","delivery_method","ship_to","converted_from_uuid","observations","subtotal","tax","total","exchange_rate","currency_symbol","working_currency","date","type","document_type","discount_amount","discount_percentage","status","related_invoice_uuid","control_number","correlative_number","document_hash","sealed_at","igtf_percentage","igtf_amount","igtf_base","tax_base_general","tax_base_reduced","tax_base_additional","tax_base_exempt","applied_retention_iva","applied_retention_islr","emission_source"]', 1, '{"cols":["document_type","number"],"notEmpty":"number"}', 1, 0, NULL, 50),
  ('invoice_items', 'sync_invoice_items', '["invoice_uuid","product_uuid","code","description","quantity","unit_price","total_price","is_exempt","discount","tax_type"]', 0, NULL, 0, 0, '["invoices"]', 60),
  ('stock_movements', 'sync_stock_movements', '["product_uuid","quantity","type","reason","reference_uuid","date"]', 1, NULL, 0, 0, '["products"]', 70),
  ('taxes', 'sync_taxes', '["name","rate","type","is_default"]', 1, NULL, 0, 0, NULL, 80),
  ('audit_logs', 'sync_audit_logs', '["user_email","action","entity_type","entity_uuid","old_value","new_value","occurred_at","device_id"]', 1, NULL, 0, 1, NULL, 90),
  ('expenses', 'sync_expenses', '["supplier_uuid","supplier_name","supplier_rif","date","control_number","invoice_number","subtotal","tax_base_general","tax_base_reduced","tax_base_additional","tax_base_exempt","tax_general","tax_reduced","tax_additional","applied_retention_iva","applied_retention_islr","total"]', 1, NULL, 0, 0, NULL, 100),
  ('fiscal_transmissions', 'fiscal_transmissions', '["invoice_uuid","sent_at","status","response_code","retry_count","last_attempt_at"]', 1, NULL, 0, 0, '["invoices"]', 110),
  ('user_roles', 'user_roles', '["email","role"]', 1, NULL, 0, 0, NULL, 120);
