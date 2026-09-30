import { createClient } from '@libsql/client';
import { writeFileSync } from 'node:fs';

// FASE 3 — limpiar `clientes` de Turso.
//
// `config_data` (JSON) es la fuente de verdad de la configuración. Las ~43
// columnas de preferencias ya están replicadas ahí, así que se pueden borrar.
// Se conservan las de identidad, las del protocolo de sync, las marcas de
// tiempo y `catalog_logo_path` (BLOB: el logo no cabe en un JSON).
//
// Reglas de seguridad:
//  1. Copia de seguridad completa antes de tocar nada.
//  2. config_data GANA siempre: las columnas antiguas solo rellenan las claves
//     que falten (si no, una columna NULL borraría un valor bueno).
//  3. Verificación posterior clave por clave antes de borrar.

const KEEP = new Set([
  'id', 'email', 'business_name', 'slogan', 'rif', 'address', 'user_name',
  'user_phone', 'created_at', 'updated_at', 'version', 'profile_change_limit',
  'profile_change_count', 'config_data',
  'catalog_logo_path', // BLOB binario: fuera del JSON por diseño
]);

const NEVER_MERGE = new Set([
  'id', 'email', 'created_at', 'updated_at', 'version', 'config_data',
  'profile_change_limit', 'profile_change_count', 'catalog_logo_path',
]);

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DRY = process.argv.includes('--dry');

const cols = (await db.execute('PRAGMA table_info(clientes)')).rows.map((r) => String(r.name));
const toDrop = cols.filter((c) => !KEEP.has(c));
console.log(`clientes tiene ${cols.length} columnas; se borran ${toDrop.length}`);
console.log(`  se conservan: ${cols.filter((c) => KEEP.has(c)).join(', ')}`);

if (DRY) {
    console.log('\n[MODO PRUEBA] no se escribe nada.');
    process.exit(0);
}

// ── 1. Respaldo ──────────────────────────────────────────────────────────────
await db.execute('DROP TABLE IF EXISTS clientes_backup_pre_v3');
await db.execute('CREATE TABLE clientes_backup_pre_v3 AS SELECT * FROM clientes');
const backupRows = (await db.execute('SELECT * FROM clientes_backup_pre_v3')).rows;
writeFileSync(
    new URL('./backup_clientes_pre_v3.json', import.meta.url),
    JSON.stringify(backupRows, null, 1),
    'utf8',
);
console.log(`\n1. Respaldo: clientes_backup_pre_v3 con ${backupRows.length} filas + JSON en disco`);

// ── 2. Volcar columnas antiguas dentro de config_data (config_data gana) ────
const rows = (await db.execute('SELECT * FROM clientes')).rows;
let merged = 0;
let addedKeys = 0;
for (const row of rows) {
    let config = {};
    try {
        config = row.config_data ? JSON.parse(row.config_data) : {};
    } catch (_) {
        config = {};
    }
    const doc = {};
    for (const [key, value] of Object.entries(row)) {
        if (NEVER_MERGE.has(key)) continue;
        if (value === null || value === undefined) continue;
        doc[key] = typeof value === 'bigint' || typeof value === 'object'
            ? String(value)
            : value;
    }
    // config_data tiene prioridad absoluta.
    const finalDoc = { ...doc, ...config };
    const added = Object.keys(finalDoc).length - Object.keys(config).length;
    if (added > 0) {
        addedKeys += added;
        merged++;
        await db.execute({
            sql: 'UPDATE clientes SET config_data = ? WHERE id = ?',
            args: [JSON.stringify(finalDoc), row.id],
        });
    }
}
console.log(`2.=config_data poblado en ${merged} filas (+${addedKeys} claves heredadas de columnas)`);

// ── 3. Verificar antes de borrar ─────────────────────────────────────────────
const after = (await db.execute('SELECT * FROM clientes')).rows;
let mismatches = 0;
for (const row of after) {
    const config = row.config_data ? JSON.parse(row.config_data) : {};
    for (const col of toDrop) {
        const value = row[col];
        if (value === null || value === undefined) continue;
        if (!(col in config)) {
            console.log(`   ✗ ${row.email}: ${col} = ${value} NO está en config_data`);
            mismatches++;
        }
    }
}
if (mismatches > 0) {
    console.error(`\nABORTADO: ${mismatches} valores no están respaldados en config_data.`);
    process.exit(1);
}
console.log('3. Verificación OK: todo valor no nulo está en config_data');

// ── 4. Borrar columnas ───────────────────────────────────────────────────────
let dropped = 0;
for (const col of toDrop) {
    try {
        await db.execute(`ALTER TABLE clientes DROP COLUMN ${col}`);
        dropped++;
    } catch (e) {
        console.log(`   ! no se pudo borrar ${col}: ${e.message.slice(0, 80)}`);
    }
}
console.log(`4. Columnas borradas: ${dropped}/${toDrop.length}`);

const finalCols = (await db.execute('PRAGMA table_info(clientes)')).rows.map((r) => r.name);
console.log(`\nclientes queda con ${finalCols.length} columnas:\n  ${finalCols.join(', ')}`);
