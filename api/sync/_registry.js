// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO DE SINCRONIZACIÓN (v2)
//
// Objetivo: agregar o quitar una TABLA o una COLUMNA del sync sin tocar una
// línea de código de la API ni desplegar.
//
// Antes, todo estaba escrito a mano:
//   * `_tables.js` declaraba, tabla por tabla, la lista de columnas y el
//     mapeo a su tabla espejo en Turso;
//   * `_push.js` tenía el `UPDATE clientes` con ~40 columnas escritas a mano;
//   * `sync.js` repetía la lista de columnas para el push legacy.
// Agregar un campo obligaba a editar tres archivos y desplegar.
//
// Ahora la fuente de verdad es la propia base de datos:
//   * `sync_table_registry` dice qué tabla local se sincroniza, con qué tabla
//     espejo, qué reglas y (opcionalmente) qué columnas;
//   * si la lista de columnas viene vacía, se DESCUBRE con `PRAGMA table_info`
//     de la tabla espejo: agregar una columna es un `ALTER TABLE` y nada más.
//
// Este módulo resuelve y cachea esa información. Si la tabla de registro no
// existe (instalaciones viejas) cae automáticamente en los valores de
// `_tables.js`, así que el comportamiento actual queda intacto.
// ─────────────────────────────────────────────────────────────────────────────

import { TABLE_SPECS, DEPENDENCY_GRAPH, CORE_TABLE_RULES } from './_tables.js';

const REGISTRY_TABLE = 'sync_table_registry';
const CACHE_MS = 60_000; // la lambda suele estar caliente; evita leer en cada push

let cache = { at: 0, registry: null, columns: new Map() };

function nowMs() {
    return Date.now();
}

async function tableExists(connection, name) {
    const rows = rowsOf(await connection.execute(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [name]
    ));
    return rows.length > 0;
}

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
    } catch (_) {
        return fallback;
    }
}

/**
 * Lee el registro desde la base. Devuelve `null` si la tabla no existe o hay
 * cualquier problema: en ese caso la API se comporta exactamente como antes.
 */
async function readRegistry(connection) {
    if (cache.registry && nowMs() - cache.at < CACHE_MS) return cache.registry;
    if (!(await tableExists(connection, REGISTRY_TABLE))) {
        cache = { at: nowMs(), registry: null, columns: new Map() };
        return null;
    }
    const rows = rowsOf(await connection.execute(
        `SELECT local_table, remote_table, columns, account_scoped, business_key,
                sealed, append_only, depends_on, sort_order
           FROM ${REGISTRY_TABLE}
          WHERE enabled = 1
          ORDER BY sort_order ASC, local_table ASC`
    ));
    const registry = new Map();
    for (const row of rows) {
        registry.set(String(row.local_table), {
            local: String(row.local_table),
            remote: String(row.remote_table),
            columns: parseJson(row.columns, null), // null = descubrir por PRAGMA
            accountScoped: Number(row.account_scoped ?? 1) === 1,
            businessKey: parseJson(row.business_key, null),
            sealed: Number(row.sealed ?? 0) === 1,
            appendOnly: Number(row.append_only ?? 0) === 1,
            dependsOn: parseJson(row.depends_on, []),
        });
    }
    cache = { at: nowMs(), registry, columns: cache.columns };
    return registry;
}

/** Invalida la caché (tests / escrituras de registro en caliente). */
export function clearRegistryCache() {
    cache = { at: 0, registry: null, columns: new Map() };
}

// La conexión de la API (`_db.js`) devuelve `[rows, ...]` al estilo mysql2,
// mientras que el cliente de @libsql/client devuelve un ResultSet. Este helper
// acepta las dos formas para que el módulo no dependa de cuál se le pase.
function rowsOf(result) {
    if (!result) return [];
    if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
    if (Array.isArray(result.rows)) return result.rows;
    return [];
}

/** Columnas físicas reales de una tabla de Turso (PRAGMA). */
export async function physicalColumns(connection, table) {
    if (cache.columns.has(table)) return cache.columns.get(table);
    const cols = new Set();
    try {
        for (const r of rowsOf(await connection.execute(`PRAGMA table_info(${table})`))) {
            if (r && r.name) cols.add(String(r.name));
        }
    } catch (_) {
        // Sin introspección: se devuelve vacío y el llamador decide.
    }
    cache.columns.set(table, cols);
    return cols;
}

/**
 * Devuelve la especificación efectiva de una tabla del sync, combinando:
 *   1. los valores de código (`_tables.js`, siempre presentes como base),
 *   2. el registro en base de datos (si existe), y
 *   3. las columnas físicas reales (filtro de seguridad: nunca se escribe una
 *      columna que no exista en la tabla espejo).
 *
 * Si el registro no declara columnas, se usan TODAS las físicas.
 */
export async function resolveSpec(connection, table) {
    const base = TABLE_SPECS[table] || {
        remote: `sync_${table}`,
        accountScoped: true,
        cols: null,
    };
    const rule = CORE_TABLE_RULES[table] || {};

    let registryEntry = null;
    try {
        const registry = await readRegistry(connection);
        if (registry) registryEntry = registry.get(table) || null;
    } catch (_) {
        registryEntry = null;
    }

    const remote = registryEntry?.remote || base.remote;
    const businessKey =
        registryEntry?.businessKey || base.businessKey || rule.businessKey || null;
    const sealed =
        registryEntry !== null && registryEntry !== undefined
            ? registryEntry.sealed
            : !!base.sealed || !!rule.sealed;
    const appendOnly =
        registryEntry !== null && registryEntry !== undefined
            ? registryEntry.appendOnly
            : !!base.appendOnly || !!rule.appendOnly;
    const accountScoped =
        registryEntry !== null && registryEntry !== undefined
            ? registryEntry.accountScoped
            : base.accountScoped !== false;

    // Columnas declaradas. OJO: si la entrada del REGISTRO existe y su lista es
    // NULL, significa explícitamente "descubrir todas las físicas" (no debe
    // heredarse la lista del código). Sin entrada en el registro se usa la del
    // código, que es el comportamiento histórico.
    const physical = await physicalColumns(connection, remote);
    const declared = registryEntry ? registryEntry.columns : base.cols;
    const cols = declared && declared.length
        ? declared.filter((c) => physical.size === 0 || physical.has(c))
        : Array.from(physical);

    return {
        local: table,
        remote,
        cols,
        accountScoped,
        businessKey,
        sealed,
        appendOnly,
        parent: base.parent || null,
        dependsOn: registryEntry?.dependsOn || DEPENDENCY_GRAPH[table] || [],
    };
}

/**
 * Resuelve varias tablas de una vez (mismo cacheo de conexión).
 */
export async function resolveSpecs(connection, tables) {
    const out = {};
    for (const t of tables) out[t] = await resolveSpec(connection, t);
    return out;
}

/**
 * Columnas que el cliente envió y que EXISTEN físicamente: la intersección es
 * la lista definitiva de campos a escribir. Así, agregar una columna en el
 * cliente empieza a sincronizarse sin tocar la API, y un cliente viejo que no
 * la conoce sigue funcionando (simplemente no la manda).
 */
export async function writableColumns(connection, spec, row) {
    const physical = await physicalColumns(connection, spec.remote);
    return Object.keys(row).filter(
        (c) => c !== 'uuid' && (physical.size === 0 || physical.has(c))
    );
}

/** ¿La tabla está registrada como sincronizable? (para el push legacy) */
export async function isSyncable(connection, table) {
    const registry = await readRegistry(connection);
    if (!registry) return !!TABLE_SPECS[table];
    return registry.has(table);
}
