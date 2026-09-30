import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

// Siembra el registro de sincronización a partir de los valores actuales de
// `_tables.js`, para que el comportamiento sea EXACTAMENTE el mismo y a partir
// de aquí la configuración viva en la base.

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const sql = readFileSync(new URL('./_seed.sql', import.meta.url), 'utf8');
const statements = sql
  .split(';')
  // Quitar líneas de comentario ANTES de decidir si la sentencia está vacía:
  // si no, el INSERT (que va precedido de comentarios) se descartaba entero.
  .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
  .filter(Boolean);

for (const statement of statements) {
  const r = await db.execute(statement);
  console.log(
    `OK rowsAffected=${r.rowsAffected ?? 0}  ${statement.slice(0, 70).replace(/\s+/g, ' ')}...`,
  );
}

const check = await db.execute(
  'SELECT local_table, remote_table, account_scoped, sealed, append_only FROM sync_table_registry ORDER BY sort_order',
);
console.log('\nRegistros:', check.rows.length);
for (const row of check.rows) console.log(' ', JSON.stringify(row));
