import { createClient } from '@libsql/client';
import { TABLE_SPECS } from './api/sync/_tables.js';
import { resolveSpec, physicalColumns, clearRegistryCache } from './api/sync/_registry.js';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const connection = await db.client ?? db;
clearRegistryCache();

let ok = 0;
let fail = 0;
for (const table of Object.keys(TABLE_SPECS)) {
    const spec = await resolveSpec(connection, table);
    const code = TABLE_SPECS[table];
    const sameCols = JSON.stringify(spec.cols) === JSON.stringify(code.cols);
    const sameRemote = spec.remote === code.remote;
    const sameScoped = spec.accountScoped === (code.accountScoped !== false);
    const sameSealed = spec.sealed === !!code.sealed;
    const good = sameCols && sameRemote && sameScoped && sameSealed;
    if (good) ok++;
    else {
        fail++;
        console.log(`✗ ${table}`);
        if (!sameCols) console.log(`   cols código=${JSON.stringify(code.cols)}\n   cols registro=${JSON.stringify(spec.cols)}`);
        if (!sameRemote) console.log(`   remote ${code.remote} != ${spec.remote}`);
        if (!sameScoped) console.log(`   accountScoped ${code.accountScoped} != ${spec.accountScoped}`);
        if (!sameSealed) console.log(`   sealed ${code.sealed} != ${spec.sealed}`);
    }
}
console.log(`\nSpecs idénticas al código: ${ok} correctas, ${fail} con diferencias`);

// Prueba del requisito: una columna nueva debe entrar SOLO por base de datos.
console.log('\n--- Prueba: agregar una columna sin tocar código ---');
try {
    await db.execute(`ALTER TABLE sync_clients ADD COLUMN campo_nuevo TEXT`);
    console.log('ALTER aplicado (la columna no existía)');
} catch (e) {
    console.log('La columna ya existía de una corrida previa:', e.message.slice(0, 40));
}
clearRegistryCache();
const colsDespues = await physicalColumns(connection, 'sync_clients');
console.log('¿aparece en PRAGMA?', colsDespues.has('campo_nuevo'));

// Con la lista explícita en el registro, la columna NO se sincroniza todavía...
const specConLista = await resolveSpec(connection, 'clients');
console.log('con lista explícita → sincroniza campo_nuevo:', specConLista.cols.includes('campo_nuevo'));

// ...pero si el registro pide descubrimiento (columns = NULL), sí.
await db.execute(`UPDATE sync_table_registry SET columns = NULL WHERE local_table = 'clients'`);
clearRegistryCache();
const specDescubierta = await resolveSpec(connection, 'clients');
console.log('con columns=NULL → sincroniza campo_nuevo:', specDescubierta.cols.includes('campo_nuevo'));
console.log('  (y sigue trayendo las que ya existían:', specDescubierta.cols.includes('name'), specDescubierta.cols.includes('rif'), ')');

// Restaurar
await db.execute(`UPDATE sync_table_registry SET columns = ? WHERE local_table = 'clients'`,
    [JSON.stringify(TABLE_SPECS.clients.cols)]);
clearRegistryCache();
