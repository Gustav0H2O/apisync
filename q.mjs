import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const sql = process.argv[2];
const r = await db.execute({ sql, args: [] });
console.log(JSON.stringify(r.rows, null, 0));
console.log(`(${r.rows.length} rows)`);
