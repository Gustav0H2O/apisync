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
  const indexes = await client.execute("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%';");
  console.log("Índices existentes:");
  for (const row of indexes.rows) {
    console.log(`- [${row.tbl_name}] ${row.name}: ${row.sql}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
