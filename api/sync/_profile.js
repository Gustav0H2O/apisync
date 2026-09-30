// ─────────────────────────────────────────────────────────────────────────────
// PERFIL DEL NEGOCIO — construcción del UPDATE (fuente única)
//
// Antes de v3 esta lógica estaba DUPLICADA: una copia en `sync/push/_push.js`
// (protocolo v47) y otra en `sync.js` (legacy), cada una con ~40 columnas
// escritas a mano. Duplicar el "contrato" de columnas fue justo lo que rompió
// cuando se limpiaron las columnas antiguas de `clientes`: el legacy siguió
// pidiendo `accent_color` y tumbó el push entero —con los roles dentro—.
//
// Aquí vive una sola implementación. Reglas:
//   * Solo se escriben columnas que EXISTEN físicamente (`PRAGMA`).
//   * Todo lo no identitario se guarda además en `config_data` (JSON), que es
//     la representation que los clientes ya saben leer.
//   * Los campos de protocolo (`version`, contadores, timestamps) los lleva el
//     servidor; el cliente nunca los impone.
// ─────────────────────────────────────────────────────────────────────────────

import { physicalColumns } from './_registry.js';

const IDENTIDAD = ['business_name', 'slogan', 'rif', 'address', 'user_name', 'user_phone'];

/** Campos de identidad que cambiaron (para el límite de cambios de perfil). */
export function identityChanged(current = {}, incoming = {}) {
    return IDENTIDAD.some((k) => String(current[k] ?? '') !== String(incoming[k] ?? ''));
}

/**
 * Prepara una fila de `clientes` para enviarla al cliente.
 *
 *  * mezcla `config_data` (JSON) en el nivel superior, que es donde el cliente
 *    lee su configuración;
 *  * convierte el logo binario a base64 para que viaje en JSON.
 *
 * La comparten el pull legacy y el change-feed: duplicar esto también
 * había causado lecturas rotas al cambiar el esquema.
 */
export function mergeProfileConfig(row) {
    if (!row) return null;
    const out = { ...row };

    if (out.config_data) {
        try {
            const parsed = typeof out.config_data === 'string'
                ? JSON.parse(out.config_data)
                : out.config_data;
            if (parsed && typeof parsed === 'object') Object.assign(out, parsed);
        } catch (_) { /* documento inválido: se sigue con las columnas */ }
    }

    if (out.catalog_logo_path) {
        const logo = out.catalog_logo_path;
        if (Buffer.isBuffer(logo)) {
            out.catalog_logo_path = logo.toString('base64');
        } else if (logo && logo.type === 'Buffer' && logo.data) {
            out.catalog_logo_path = Buffer.from(logo.data).toString('base64');
        } else if (logo instanceof ArrayBuffer) {
            out.catalog_logo_path = Buffer.from(logo).toString('base64');
        }
    }
    return out;
}

/**
 * Construye el statement que actualiza el perfil de `clientes`.
 *
 * @returns {{sql: string, args: any[]}|null} null si no hay nada que escribir.
 */
export async function buildProfileUpdate({
    connection,
    email,
    profile,
    incomingVersion,
    profileChangeCount,
    // El legacy reenvía el perfil en cada ciclo con la misma versión, así que
    // usa '<=' (hay que reescribir). El v47 solo avanza versión: '<'.
    versionOp = '<',
}) {
    const cols = await physicalColumns(connection, 'clientes');
    if (!cols.size) return null;

    // Nunca se copian del payload: los controla el servidor.
    // `catalog_logo_path` se excluye porque es binario y tiene su propio
    // tratamiento más abajo.
    const RESERVED = new Set([
        'id', 'email', 'version', 'created_at', 'updated_at', 'config_data',
        'profile_change_count', 'profile_change_limit', 'clear_catalog_logo',
        'catalog_logo_path',
    ]);

    const set = [];
    const args = [];

    // 1) Columnas físicas que el cliente envió.
    for (const [key, value] of Object.entries(profile)) {
        if (RESERVED.has(key)) continue;
        if (!cols.has(key)) continue; // la columna ya no existe: se ignora
        set.push(`${key} = ?`);
        args.push(value === undefined ? null : value);
    }

    // 2) El logo es binario y no cabe en el JSON, así que viaja aparte.
    //    - `clear_catalog_logo` lo anula;
    //    - un Buffer recibido lo reemplaza (subida por multipart en el legacy);
    //    - una ruta local de texto NO se escribe (no son los bytes del logo);
    //    - si no llega nada, se conserva el que hay.
    if (cols.has('catalog_logo_path')) {
        const incomingLogo = profile.catalog_logo_path;
        const isBinary =
            (typeof Buffer !== 'undefined' && Buffer.isBuffer(incomingLogo)) ||
            incomingLogo instanceof Uint8Array ||
            (incomingLogo && typeof incomingLogo === 'object' && incomingLogo.type === 'Buffer' && incomingLogo.data);
        if (profile.clear_catalog_logo === true) {
            set.push('catalog_logo_path = NULL');
        } else if (isBinary) {
            set.push('catalog_logo_path = ?');
            args.push(incomingLogo);
        } else {
            set.push('catalog_logo_path = catalog_logo_path');
        }
    }

    // 3) La versión es control de concurrencia del servidor: si no se
    //    escribiera, la fila quedaría clavada y un push con versión menor
    //    sobrescribiría datos más nuevos.
    if (cols.has('version')) {
        set.push('version = ?');
        args.push(incomingVersion);
    }

    if (cols.has('profile_change_count')) {
        set.push('profile_change_count = ?');
        args.push(profileChangeCount);
    }

    // 4) Configuración en JSON: lo que un cliente viejo no conoce igual queda
    //    disponible para los nuevos, y a la inversa.
    if (cols.has('config_data')) {
        const configDataObj = {};
        for (const [k, v] of Object.entries(profile)) {
            if (k === 'version' || k === 'email' || IDENTIDAD.includes(k)) continue;
            configDataObj[k] = v;
        }
        set.push(`config_data = json_patch(COALESCE(config_data, '{}'), ?)`);
        args.push(JSON.stringify(configDataObj));
    }

    if (cols.has('updated_at')) {
        set.push('updated_at = CURRENT_TIMESTAMP');
    }

    if (!set.length) return null;

    const args2 = [...args, email, incomingVersion];
    return {
        sql: `UPDATE clientes SET ${set.join(', ')} WHERE email = ? AND version ${versionOp} ?`,
        args: args2.map((v) => (v === undefined ? null : v)),
    };
}
