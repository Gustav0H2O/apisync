import { createClient } from '@libsql/client';

const path = process.argv[2];
const sql = process.argv[3] || 'SELECT name FROM sqlite_master WHERE type="table"';
const db = createClient({ url: `file:${path}` });
const r = await db.execute(sql);
console.log(JSON.stringify(r.rows, null, 0));
console.log(`(${r.rows.length} rows)`);
