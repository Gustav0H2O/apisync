import { createClient } from "@libsql/client";

const TURSO_URL = process.env.TURSO_URL || "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_TOKEN) { console.error("Falta TURSO_TOKEN en el entorno"); process.exit(1); }

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

  // 1. sync_products
  await runStep("1. Agregar wholesale_unit_price a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN wholesale_unit_price REAL DEFAULT 0.0;");
  });

  await runStep("2. Agregar wholesale_unit_quantity a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN wholesale_unit_quantity REAL DEFAULT 0.0;");
  });

  await runStep("3. Agregar min_sale_quantity a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN min_sale_quantity REAL DEFAULT 0.0;");
  });

  await runStep("4. Agregar min_sale_unit_quantity a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN min_sale_unit_quantity REAL DEFAULT 0.0;");
  });

  await runStep("5. Agregar has_blister a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN has_blister INTEGER DEFAULT 0;");
  });

  await runStep("6. Agregar units_per_blister a sync_products", async () => {
    return await client.execute("ALTER TABLE sync_products ADD COLUMN units_per_blister REAL DEFAULT 0.0;");
  });

  // 2. sync_invoices
  await runStep("7. Agregar is_paid a sync_invoices", async () => {
    return await client.execute("ALTER TABLE sync_invoices ADD COLUMN is_paid INTEGER DEFAULT 0;");
  });

  console.log("\n=================================================");
  console.log("🔍 VERIFICANDO NUEVAS COLUMNAS EN TURSO");
  console.log("=================================================\n");

  const prodCols = await client.execute('PRAGMA table_info("sync_products");');
  const invCols = await client.execute('PRAGMA table_info("sync_invoices");');

  console.log("Columnas sync_products nuevas:", prodCols.rows.filter(c => ['wholesale_unit_price', 'wholesale_unit_quantity', 'min_sale_quantity', 'min_sale_unit_quantity', 'has_blister', 'units_per_blister'].includes(c.name)).map(c => `${c.name} (${c.type})`));
  console.log("Columnas sync_invoices nuevas:", invCols.rows.filter(c => c.name === 'is_paid').map(c => `${c.name} (${c.type})`));
}

main().catch(err => {
  console.error("Error ejecutando migración:", err);
  process.exit(1);
});
