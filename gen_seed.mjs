import { TABLE_SPECS, DEPENDENCY_GRAPH, CORE_TABLE_RULES } from './api/sync/_tables.js';
import { writeFileSync } from 'node:fs';

// Genera la semilla del registro a partir de `_tables.js`, para que sea
// imposible que la base y el código diverjan en la primera siembra.

// En SQLite un literal con comillas dobles se interpreta como IDENTIFICADOR,
// así que el JSON va como cadena simple (con las comillas internas duplicadas).
const sqlStr = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const esc = sqlStr;
const lines = [];

let order = 0;
for (const [table, spec] of Object.entries(TABLE_SPECS)) {
  const rule = CORE_TABLE_RULES[table] || {};
  const deps = DEPENDENCY_GRAPH[table] || [];
  const businessKey = spec.businessKey || rule.businessKey || null;
  const sealed = spec.sealed || rule.sealed ? 1 : 0;
  const appendOnly = rule.appendOnly ? 1 : 0;
  const cols = spec.cols ? esc(JSON.stringify(spec.cols)) : 'NULL';
  const bk = businessKey ? esc(JSON.stringify(businessKey)) : 'NULL';
  const dep = deps.length ? esc(JSON.stringify(deps)) : 'NULL';
  order += 10;
  lines.push(
    `  ('${table}', '${spec.remote}', ${cols}, ${spec.accountScoped === false ? 0 : 1}, ${bk}, ${sealed}, ${appendOnly}, ${dep}, ${order})`
  );
}

const createTable = [
  'CREATE TABLE IF NOT EXISTS sync_table_registry (',
  '  local_table TEXT PRIMARY KEY,',
  '  remote_table TEXT NOT NULL,',
  '  columns TEXT,',
  '  account_scoped INTEGER NOT NULL DEFAULT 1,',
  '  business_key TEXT,',
  '  sealed INTEGER NOT NULL DEFAULT 0,',
  '  append_only INTEGER NOT NULL DEFAULT 0,',
  '  depends_on TEXT,',
  '  sort_order INTEGER NOT NULL DEFAULT 0,',
  '  enabled INTEGER NOT NULL DEFAULT 1,',
  '  updated_at TEXT DEFAULT CURRENT_TIMESTAMP',
  ');',
  '',
  '',
].join('\n');

const sql = createTable + `-- GENERADO AUTOMÁTICAMENTE desde api/sync/_tables.js (no editar a mano).
-- Regenerar: node gen_seed.mjs
--
-- A partir de este registro, agregar tablas o columnas al sync es una
-- operación de base de datos (INSERT/UPDATE), sin tocar ni desplegar la API.
-- columns = NULL significa "descubrir con PRAGMA table_info".

INSERT OR REPLACE INTO sync_table_registry
  (local_table, remote_table, columns, account_scoped, business_key, sealed, append_only, depends_on, sort_order)
VALUES
${lines.join(',\n')};
`;

writeFileSync(new URL('./_seed.sql', import.meta.url), sql, 'utf8');
console.log(sql);
