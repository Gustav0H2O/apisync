import { createClient } from '@libsql/client';
import { TABLE_SPECS } from './api/sync/_tables.js';
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
for (const [table, spec] of Object.entries(TABLE_SPECS)) {
  await db.execute({
    sql: 'UPDATE sync_table_registry SET columns = ? WHERE local_table = ?',
    args: [JSON.stringify(spec.cols), table],
  });
}
const r = await db.execute('SELECT local_table, remote_table, columns FROM sync_table_registry ORDER BY sort_order');
let bad = 0;
for (const row of r.rows) {
  const code = TABLE_SPECS[row.local_table];
  const same = code && JSON.stringify(JSON.parse(row.columns)) === JSON.stringify(code.cols);
  if (!same) { bad++; console.log('DIVERGE', row.local_table, row.columns); }
}
console.log(`registry verificada: ${r.rows.length} filas, ${bad} divergentes del codigo`);
