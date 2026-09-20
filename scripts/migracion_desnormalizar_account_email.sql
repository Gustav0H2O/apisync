-- Migración: Desnormalizar account_email en sync_invoice_items
-- Permite que sync_invoice_items y cualquier tabla hija se sincronice y filtre
-- de manera uniforme por account_email sin necesidad de joins jerárquicos rígidos.

-- 1. Agregar columna account_email si no existe
ALTER TABLE sync_invoice_items ADD COLUMN account_email TEXT;

-- 2. Poblar account_email a partir de la factura padre
UPDATE sync_invoice_items 
SET account_email = (
    SELECT sync_invoices.account_email 
    FROM sync_invoices 
    WHERE sync_invoices.uuid = sync_invoice_items.invoice_uuid
)
WHERE account_email IS NULL;

-- 3. Crear índice compuesto para lectura y filtrado ultra-rápido por cuenta
CREATE INDEX IF NOT EXISTS idx_invoice_items_acc_uuid 
    ON sync_invoice_items(account_email, uuid);
