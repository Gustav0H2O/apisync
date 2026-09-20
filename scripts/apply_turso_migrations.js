import { createClient } from "@libsql/client";

const TURSO_URL = "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk5MTYwMjgsImlkIjoiMDE5ZDhhMzgtMGQwMS03ZmY4LTg4ZDQtZDc4MmMwZDNlYTU2Iiwia2lkIjoiRGtTRlRmQmFtcFFLenVXTkFtRk94MXF1ak4tMmJiLVdDZzFMMnlaTmFSVSIsInJpZCI6IjM0MzgzYzAzLTk5NWEtNGE3OC05MTliLWIzYzFhZTkyNTBlOSJ9.XUv1alrM_7PBVoVvWrQsDfid44LjflYXqJR1lk8CE6SS2ulTD0fWrZvWdO7J7yIOfexgqzuSDl4d5bu7NTg0DA";

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
  intMode: 'string',
});

async function runStep(name, fn) {
  process.stdout.write(`⏳ ${name}... `);
  try {
    const res = await fn();
    console.log("✅ OK", res ? `(${res})` : "");
  } catch (err) {
    if (err.message && (err.message.includes("duplicate column") || err.message.includes("already exists"))) {
      console.log("ℹ️ Ya existe (ignorado pacíficamente)");
    } else {
      console.log("❌ ERROR:", err.message);
      throw err;
    }
  }
}

async function main() {
  console.log("=================================================");
  console.log("🚀 APLICANDO MIGRACIONES DE ESQUEMA EN TURSO");
  console.log("=================================================\n");

  // 1. Agregar columna config_data a clientes
  await runStep("1. Agregar columna config_data a tabla clientes", async () => {
    return await client.execute("ALTER TABLE clientes ADD COLUMN config_data TEXT DEFAULT '{}';");
  });

  // 2. Agregar columna account_email a sync_invoice_items
  await runStep("2. Agregar columna account_email a sync_invoice_items", async () => {
    return await client.execute("ALTER TABLE sync_invoice_items ADD COLUMN account_email TEXT;");
  });

  // 3. Poblar account_email en sync_invoice_items existentes
  await runStep("3. Poblar account_email en sync_invoice_items existentes", async () => {
    const res = await client.execute(`
      UPDATE sync_invoice_items 
      SET account_email = (
          SELECT sync_invoices.account_email 
          FROM sync_invoices 
          WHERE sync_invoices.uuid = sync_invoice_items.invoice_uuid
      )
      WHERE account_email IS NULL;
    `);
    return `${res.rowsAffected} filas actualizadas`;
  });

  // 4. Crear índice compuesto en sync_invoice_items (account_email, uuid)
  await runStep("4. Crear índice idx_invoice_items_acc_uuid", async () => {
    return await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_invoice_items_acc_uuid 
      ON sync_invoice_items(account_email, uuid);
    `);
  });

  // 5. Crear índice único de negocio para facturas (cero duplicados)
  await runStep("5. Crear índice único sync_invoices_business", async () => {
    return await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS sync_invoices_business
      ON sync_invoices(account_email, document_type, number)
      WHERE number IS NOT NULL AND deleted_at IS NULL;
    `);
  });

  // 6. Crear índice único de negocio para productos por código/SKU (cero duplicados)
  await runStep("6. Crear índice único sync_products_code", async () => {
    return await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS sync_products_code
      ON sync_products(account_email, code)
      WHERE code IS NOT NULL AND code <> '' AND deleted_at IS NULL;
    `);
  });

  // 7. Crear índice para clientes por RIF
  await runStep("7. Crear índice sync_clients_rif", async () => {
    return await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_clients_rif
      ON sync_clients(account_email, rif);
    `);
  });

  // 8. Crear índice para proveedores por RIF
  await runStep("8. Crear índice sync_suppliers_rif", async () => {
    return await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_suppliers_rif
      ON sync_suppliers(account_email, rif);
    `);
  });

  console.log("\n=================================================");
  console.log("🔍 VERIFICACIÓN FINAL EN TURSO");
  console.log("=================================================\n");

  // Verificación clientes
  const cliCols = await client.execute("PRAGMA table_info('clientes');");
  const hasConfigData = cliCols.rows.some(c => c.name === 'config_data');
  console.log(`- Tabla clientes.config_data: ${hasConfigData ? '✅ PRESENTE' : '❌ FALTA'}`);

  // Verificación sync_invoice_items
  const itemsCols = await client.execute("PRAGMA table_info('sync_invoice_items');");
  const hasAccountEmail = itemsCols.rows.some(c => c.name === 'account_email');
  console.log(`- Tabla sync_invoice_items.account_email: ${hasAccountEmail ? '✅ PRESENTE' : '❌ FALTA'}`);

  // Verificación items poblados
  const unassigned = await client.execute("SELECT count(*) as c FROM sync_invoice_items WHERE account_email IS NULL;");
  console.log(`- Items sin account_email: ${unassigned.rows[0]?.c === 0 || unassigned.rows[0]?.c === '0' ? '✅ 0 (Todos asignados)' : `⚠️ ${unassigned.rows[0]?.c}`}`);

  // Verificación índices creados
  const indexes = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_invoice_items_acc_uuid', 'sync_invoices_business', 'sync_products_code', 'sync_clients_rif', 'sync_suppliers_rif');");
  console.log(`- Índices verificados:`, indexes.rows.map(r => `✅ ${r.name}`).join(", "));

  console.log("\n🎉 TODAS LAS MIGRACIONES EN TURSO SE HAN COMPLETADO CON ÉXITO.");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
