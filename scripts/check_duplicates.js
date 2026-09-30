import { createClient } from "@libsql/client";

const TURSO_URL = "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_TOKEN) { console.error("Falta TURSO_TOKEN en el entorno"); process.exit(1); }

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
  intMode: 'string',
});

async function main() {
  console.log("=== Comprobando duplicados en Turso ===");

  const dupProducts = await client.execute(`
    SELECT account_email, code, count(*) as count 
    FROM sync_products 
    WHERE code IS NOT NULL AND trim(code) != '' AND deleted_at IS NULL 
    GROUP BY account_email, code 
    HAVING count(*) > 1
  `);
  console.log("Productos duplicados:", dupProducts.rows);

  const dupInvoices = await client.execute(`
    SELECT account_email, document_type, number, count(*) as count 
    FROM sync_invoices 
    WHERE number IS NOT NULL AND deleted_at IS NULL 
    GROUP BY account_email, document_type, number 
    HAVING count(*) > 1
  `);
  console.log("Facturas duplicadas:", dupInvoices.rows);

  const dupClients = await client.execute(`
    SELECT account_email, rif, count(*) as count 
    FROM sync_clients 
    WHERE rif IS NOT NULL AND rif NOT IN ('V0', 'J0', 'v-0', 'j-0', '') AND deleted_at IS NULL 
    GROUP BY account_email, rif 
    HAVING count(*) > 1
  `);
  console.log("Clientes duplicados:", dupClients.rows);

  const dupSuppliers = await client.execute(`
    SELECT account_email, rif, count(*) as count 
    FROM sync_suppliers 
    WHERE rif IS NOT NULL AND rif NOT IN ('V0', 'J0', 'v-0', 'j-0', '') AND deleted_at IS NULL 
    GROUP BY account_email, rif 
    HAVING count(*) > 1
  `);
  console.log("Proveedores duplicados:", dupSuppliers.rows);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
