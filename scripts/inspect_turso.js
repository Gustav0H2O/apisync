import { createClient } from "@libsql/client";

const TURSO_URL = "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk5MTYwMjgsImlkIjoiMDE5ZDhhMzgtMGQwMS03ZmY4LTg4ZDQtZDc4MmMwZDNlYTU2Iiwia2lkIjoiRGtTRlRmQmFtcFFLenVXTkFtRk94MXF1ak4tMmJiLVdDZzFMMnlaTmFSVSIsInJpZCI6IjM0MzgzYzAzLTk5NWEtNGE3OC05MTliLWIzYzFhZTkyNTBlOSJ9.XUv1alrM_7PBVoVvWrQsDfid44LjflYXqJR1lk8CE6SS2ulTD0fWrZvWdO7J7yIOfexgqzuSDl4d5bu7NTg0DA";

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
  intMode: 'string',
});

async function main() {
  console.log("Conectando a Turso...");
  const tablesRes = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  console.log("Tablas encontradas:", tablesRes.rows.map(r => r.name));

  for (const row of tablesRes.rows) {
    const tableName = row.name;
    if (tableName.startsWith("sqlite_")) continue;
    
    const countRes = await client.execute(`SELECT count(*) as cnt FROM "${tableName}";`);
    const count = countRes.rows[0]?.cnt || 0;
    
    const tableInfo = await client.execute(`PRAGMA table_info("${tableName}");`);
    const cols = tableInfo.rows.map(c => `${c.name} (${c.type})`).join(", ");
    console.log(`\n📋 [${tableName}] (${count} filas):`);
    console.log(`   Columnas: ${cols}`);
  }
}

main().catch(err => {
  console.error("Error conectando a Turso:", err);
  process.exit(1);
});
