// Pruebas del contrato del perfil (v50): la tabla `clientes` solo conserva
// columnas de identidad + control, y TODO lo cosmético vive en `config_data`.
//
// Cubren las dos reglas que se rompieron en producción:
//   1. `buildProfileUpdate` NUNCA escribe una columna que no exista (el
//      asesoramiento por PRAGMA evita el "no such column" que tumbaba el batch
//      atómico completo — productos, facturas y roles incluidos).
//   2. Con el límite de cambios de identidad agotado (`skipIdentity`) se
//      conserva la identidad de la nube pero la configuración SÍ se guarda.
//
// Es una prueba pura: la introspección se sirve con un PRAGMA simulado, sin
// tocar Turso.

import assert from 'node:assert/strict';
import { buildProfileUpdate, mergeProfileConfig } from '../api/sync/_profile.js';

const CLIENTES_COLS = [
    'id', 'email', 'business_name', 'slogan', 'rif', 'address', 'user_name',
    'user_phone', 'created_at', 'updated_at', 'version', 'catalog_logo_path',
    'profile_change_limit', 'profile_change_count', 'config_data',
];

const connection = {
    execute: async (sql) => {
        if (/PRAGMA\s+table_info\s*\(\s*clientes\s*\)/i.test(sql)) {
            return { rows: CLIENTES_COLS.map((name) => ({ name })) };
        }
        throw new Error(`consulta inesperada en la prueba: ${sql}`);
    },
};

const PROFILE = {
    business_name: 'Empresa X',
    slogan: 'Slogan',
    rif: 'J-12345678',
    address: 'Av 1',
    user_name: 'Ana',
    user_phone: '0414-1234567',
    email: 'nw@gmai.com',
    version: 99,
    // Config cosmética (vive en config_data)
    accent_color: '#C62828',
    working_currency: 'VES',
    config_style: 'new',
    history_new_button_action: 'nota_entrega',
    history_clients_button_action: 'products',
    clear_catalog_logo: false,
    // Campos de protocolo que JAMÁS deben copiarse del payload:
    id: 7,
    profile_change_count: 999,
    profile_change_limit: 999,
    config_data: '{"inyectado":true}',
    created_at: '2000-01-01',
    updated_at: '2000-01-01',
};

const IDENTITY = ['business_name', 'slogan', 'rif', 'address', 'user_name', 'user_phone'];

async function build(overrides = {}) {
    return buildProfileUpdate({
        connection,
        email: 'nw@gmai.com',
        profile: PROFILE,
        incomingVersion: 99,
        profileChangeCount: 3,
        ...overrides,
    });
}

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
}

console.log('\n\u2500\u2500 buildProfileUpdate: contrato de columnas\n');

const normal = await build();
check('escribe las 6 columnas de identidad', () => {
    for (const col of IDENTITY) {
        assert.match(normal.sql, new RegExp(`${col} = \\?`), `falta ${col}`);
    }
});
check('escribe config_data como JSON fusionado (json_patch)', () => {
    assert.match(normal.sql, /config_data = json_patch\(COALESCE\(config_data, '\{\}'\), \?\)/);
});
check('el número de argumentos coincide con los placeholders', () => {
    const placeholders = (normal.sql.match(/\?/g) || []).length;
    assert.equal(normal.args.length, placeholders);
});
check('la versión la fija el servidor', () => {
    assert.match(normal.sql, /version = \?/);
    assert.ok(normal.args.includes(99));
});
check('la condición de concurrencia usa la versión', () => {
    assert.match(normal.sql, /WHERE email = \? AND version < \?/);
});
check('nunca se copian columnas de protocolo del payload', () => {
    assert.doesNotMatch(normal.sql, /(^|, )id = \?/);
    assert.doesNotMatch(normal.sql, /email = \? WHERE/);
    assert.equal((normal.sql.match(/version = \?/g) || []).length, 1);
    assert.equal((normal.sql.match(/profile_change_count = \?/g) || []).length, 1);
    assert.doesNotMatch(normal.sql, /profile_change_limit = \?/);
    assert.doesNotMatch(normal.sql, /created_at = \?/);
    assert.doesNotMatch(normal.sql, /updated_at = \?/);
});

console.log('\n\u2500\u2500 buildProfileUpdate: límite de identidad agotado (skipIdentity)\n');

const blocked = await build({ skipIdentity: true, versionOp: '<=' });
check('NO escribe ninguna columna de identidad', () => {
    for (const col of IDENTITY) {
        assert.doesNotMatch(blocked.sql, new RegExp(`${col} = \\?`), `no debe escribir ${col}`);
    }
});
check('SÍ escribe la configuración (config_data)', () => {
    assert.match(blocked.sql, /config_data = json_patch/);
});
check('SÍ avanza la versión y el contador', () => {
    assert.match(blocked.sql, /version = \?/);
    assert.match(blocked.sql, /profile_change_count = \?/);
});
check('argumentos y placeholders cuadran', () => {
    assert.equal(blocked.args.length, (blocked.sql.match(/\?/g) || []).length);
});
check('el legacy usa "version <=" para reescribir la misma versión', () => {
    assert.match(blocked.sql, /AND version <= \?/);
});

console.log('\n\u2500\u2500 config_data: lo que viaja dentro del JSON\n');

check('el JSON incluye accesos directos, estilo y cosmética', () => {
    const jsonArg = normal.args.find(
        (a) => typeof a === 'string' && a.includes('history_new_button_action'),
    );
    assert.ok(jsonArg, 'no se encontró el JSON de configuración');
    const parsed = JSON.parse(jsonArg);
    assert.equal(parsed.history_new_button_action, 'nota_entrega');
    assert.equal(parsed.history_clients_button_action, 'products');
    assert.equal(parsed.config_style, 'new');
    assert.equal(parsed.accent_color, '#C62828');
    assert.equal(parsed.working_currency, 'VES');
});
check('el JSON NO incluye identidad, versión ni correo', () => {
    const jsonArg = normal.args.find(
        (a) => typeof a === 'string' && a.includes('history_new_button_action'),
    );
    const parsed = JSON.parse(jsonArg);
    for (const col of IDENTITY) assert.equal(parsed[col], undefined, col);
    assert.equal(parsed.version, undefined);
    assert.equal(parsed.email, undefined);
});

console.log('\n\u2500\u2500 logo (binario) y bandera de borrado\n');

const cleared = await build({ profile: { ...PROFILE, clear_catalog_logo: true } });
check('clear_catalog_logo anula el logo', () => {
    assert.match(cleared.sql, /catalog_logo_path = NULL/);
});

const withPath = await build({ profile: { ...PROFILE, catalog_logo_path: 'C:/local/logo.png' } });
check('una ruta local NO se escribe como bytes del logo', () => {
    assert.match(withPath.sql, /catalog_logo_path = catalog_logo_path/);
});

console.log('\n\u2500\u2500 mergeProfileConfig: lo que el cliente lee de vuelta\n');

const fila = mergeProfileConfig({
    business_name: 'Empresa X',
    profile_change_limit: '3',
    profile_change_count: '2',
    config_data: JSON.stringify({
        history_new_button_action: 'presupuesto',
        working_currency: 'VES',
    }),
    catalog_logo_path: Buffer.from('logo-bytes'),
});
check('aplana config_data al nivel superior', () => {
    assert.equal(fila.history_new_button_action, 'presupuesto');
    assert.equal(fila.working_currency, 'VES');
});
check('conserva las columnas reales', () => {
    assert.equal(fila.business_name, 'Empresa X');
    assert.equal(fila.profile_change_limit, '3');
});
check('convierte el logo binario a base64', () => {
    assert.equal(fila.catalog_logo_path, Buffer.from('logo-bytes').toString('base64'));
});
check('una fila nula devuelve null', () => {
    assert.equal(mergeProfileConfig(null), null);
});

console.log(`\nPROFILE SYNC TESTS PASSED (${passed} comprobaciones)\n`);
