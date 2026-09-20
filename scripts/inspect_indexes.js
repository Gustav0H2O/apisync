import { createClient } from "@libsql/client";

const TURSO_URL = "libsql://factu-factu.aws-us-east-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk5MTYwMjgsImlkIjoiMDE5ZDhhMzgtMGQwMS03ZmY4LTg4ZDQtZDc4MmMwZDNlYTU2Iiwia2lkIjoiRGtTRlRmQmFtcFFLenVXTkFtRk94MXF1ak4tMmJiLVdDZzFMMnlaTmFSVSIsInJpZCI6IjM0MzgzYzAzLTk5NWEtNGE3OC05MTliLWIzYzFhZTkyNTBlOSJ9.XUv1alrM_7PBVoVvWrQsDfid44LjflYXqJR1lk8CE6SS2ulTD0fWrZvWdO7J7yIOfexgqzuSDl4d5bu7NTg0DA";

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
