-- =====================================================
-- FactuFlow Turso — Restruct v49 (vinculación/desvinculación + sync estable)
-- Decisiones aplicadas:
--  1) Identidad canónica = license_key (account_key), email solo display.
--  2) devices PK compuesta (license_key, device_id).
--  3) user_roles solo humanos; roles de terminal en device_role_assignments.
--  4) Desvinculación = revoked inmediato + revoked_at + cooldown configurable.
--  5) Renovación: misma key (extend) + rotación explícita old->new sin purga.
-- =====================================================

-- ---------- 0. Infra que faltaba ----------
CREATE TABLE IF NOT EXISTS account_cursor (
  account_email TEXT PRIMARY KEY,
  account_key TEXT,
  seq INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_email TEXT,
  account_key TEXT,
  seq INTEGER,
  table_name TEXT,
  row_uuid TEXT,
  op TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_log_account_seq ON change_log (account_key, account_email, seq);
CREATE INDEX IF NOT EXISTS idx_cursor_key ON account_cursor (account_key);

-- Backfill account_key desde licencias<->clientes donde sea posible
-- (cuando account_email coincide con clientes.email).
UPDATE account_cursor SET account_key = (
  SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id
  WHERE c.email = account_cursor.account_email
) WHERE account_key IS NULL;
UPDATE change_log SET account_key = (
  SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id
  WHERE c.email = change_log.account_email
) WHERE account_key IS NULL;

-- ---------- 1. licencias: política controlable + rotación ----------
ALTER TABLE licencias ADD COLUMN previous_license_key TEXT;
-- revoked_at no aplica a licencias; pero sí trazabilidad de renovación:
-- (si falla por columna existente, ignorar error y continuar)
-- ALTER TABLE detalles_saas ADD COLUMN last_check ya existe en algunas BDs.

CREATE TABLE IF NOT EXISTS license_key_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_key TEXT NOT NULL,
  new_key TEXT NOT NULL,
  cliente_id INTEGER,
  migrated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  migrated_by_device TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rotations_new ON license_key_rotations (new_key);
CREATE INDEX IF NOT EXISTS idx_rotations_old ON license_key_rotations (old_key);

-- ---------- 2. devices: PK compuesta + revoked_at ----------
-- Turso/SQLite no permite ALTER PRIMARY KEY: recrear tabla.
CREATE TABLE IF NOT EXISTS devices_new (
  device_id TEXT NOT NULL,
  license_key TEXT NOT NULL,
  name TEXT,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked INTEGER DEFAULT 0,
  paired_at TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  unlink_reason TEXT,
  fcm_token TEXT,
  PRIMARY KEY (license_key, device_id),
  FOREIGN KEY (license_key) REFERENCES licencias(license_key) ON UPDATE CASCADE ON DELETE CASCADE
);
INSERT OR IGNORE INTO devices_new (device_id, license_key, name, last_seen, revoked, paired_at, revoked_at)
  SELECT device_id, license_key, name, last_seen, revoked, paired_at,
         CASE WHEN revoked = 1 THEN last_seen ELSE NULL END
  FROM devices;
DROP TABLE IF EXISTS devices;
ALTER TABLE devices_new RENAME TO devices;
CREATE INDEX IF NOT EXISTS idx_devices_key_revoked ON devices (license_key, revoked);
CREATE INDEX IF NOT EXISTS idx_devices_id ON devices (device_id);

-- ---------- 3. Roles de terminal fuera de user_roles ----------
CREATE TABLE IF NOT EXISTS device_role_assignments (
  uuid TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operador',
  terminal_prefix TEXT,
  terminal_name TEXT,
  version INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (account_key, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devroles_account ON device_role_assignments (account_key, deleted_at);

-- Migrar filas hackeadas device:/device_cfg: desde user_roles (si existe esa tabla espejo)
-- device:ID -> rol base; device_cfg:ID:prefix:name -> config de terminal.
INSERT OR IGNORE INTO device_role_assignments (uuid, account_key, device_id, role, updated_at)
  SELECT uuid, account_email, substr(email, 8), role, updated_at
  FROM user_roles WHERE email LIKE 'device:%' AND email NOT LIKE 'device_cfg:%';
-- Nota: device_cfg: se reconcilia en API (tiene prefix y name embebidos); no se borra aquí.
-- Limpieza opcional (descomentar tras verificar migración):
-- DELETE FROM user_roles WHERE email LIKE 'device:%' OR email LIKE 'device_cfg:%';

-- user_roles espejo: asegurar columnas de cuenta dual
ALTER TABLE user_roles ADD COLUMN account_key TEXT;
UPDATE user_roles SET account_key = account_email WHERE account_key IS NULL;

-- ---------- 4. account_key en todas las tablas sync ----------
ALTER TABLE sync_clients ADD COLUMN account_key TEXT;
ALTER TABLE sync_invoices ADD COLUMN account_key TEXT;
ALTER TABLE sync_invoice_items ADD COLUMN account_key TEXT;
ALTER TABLE sync_suppliers ADD COLUMN account_key TEXT;
ALTER TABLE sync_categories ADD COLUMN account_key TEXT;
ALTER TABLE sync_products ADD COLUMN account_key TEXT;
ALTER TABLE sync_stock_movements ADD COLUMN account_key TEXT;
ALTER TABLE sync_audit_logs ADD COLUMN account_key TEXT;

UPDATE sync_clients SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_clients.account_email) WHERE account_key IS NULL;
UPDATE sync_invoices SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_invoices.account_email) WHERE account_key IS NULL;
UPDATE sync_suppliers SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_suppliers.account_email) WHERE account_key IS NULL;
UPDATE sync_categories SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_categories.account_email) WHERE account_key IS NULL;
UPDATE sync_products SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_products.account_email) WHERE account_key IS NULL;
UPDATE sync_stock_movements SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_stock_movements.account_email) WHERE account_key IS NULL;
UPDATE sync_audit_logs SET account_key = (SELECT l.license_key FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE c.email = sync_audit_logs.account_email) WHERE account_key IS NULL;
-- sync_invoice_items hereda por padre:
UPDATE sync_invoice_items SET account_key = (SELECT s.account_key FROM sync_invoices s WHERE s.uuid = sync_invoice_items.invoice_uuid) WHERE account_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_clients_key ON sync_clients (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_invoices_key ON sync_invoices (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_products_key ON sync_products (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_suppliers_key ON sync_suppliers (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_categories_key ON sync_categories (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_stock_key ON sync_stock_movements (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_audit_key ON sync_audit_logs (account_key, uuid);
CREATE INDEX IF NOT EXISTS idx_items_key ON sync_invoice_items (account_key, invoice_uuid);

-- ---------- 5. pairing_sessions: FK explícita ----------
ALTER TABLE pairing_sessions ADD COLUMN account_key TEXT;
UPDATE pairing_sessions SET account_key = license_key WHERE account_key IS NULL;
