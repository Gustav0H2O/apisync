import { createClient } from "@libsql/client";

const TURSO_URL = "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk5MTYwMjgsImlkIjoiMDE5ZDhhMzgtMGQwMS03ZmY4LTg4ZDQtZDc4MmMwZDNlYTU2Iiwia2lkIjoiRGtTRlRmQmFtcFFLenVXTkFtRk94MXF1ak4tMmJiLVdDZzFMMnlaTmFSVSIsInJpZCI6IjM0MzgzYzAzLTk5NWEtNGE3OC05MTliLWIzYzFhZTkyNTBlOSJ9.XUv1alrM_7PBVoVvWrQsDfid44LjflYXqJR1lk8CE6SS2ulTD0fWrZvWdO7J7yIOfexgqzuSDl4d5bu7NTg0DA";

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
