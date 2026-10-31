import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret, applyCors } from '../_helpers.js';
import {
    TABLE_SPECS, TABLE_ORDER, toNumber, normalizeRole,
    changeLogStatements, ensureCursorStatement,
    resolveTableOrder, CORE_TABLE_RULES,
} from './_tables.js';
import { ensureMirrorTables, getTableColumns } from './_ensure.js';
import { resolveSpec, physicalColumns, writableColumns } from './_registry.js';
import { buildProfileUpdate, mergeProfileConfig } from './_profile.js';
import { sendToLicense } from '../_fcm.js';
import { syncBus } from './_bus.js';

// undefined -> NULL antes de enviar a Turso (libsql no acepta undefined).
const mapP = (arr) => arr.map(v => v === undefined ? null : v);

/**
 * POST /api/sync/push  (auth JWT) — protocolo v47 (change-feed)
 *
 * ← { deviceId, changes: { clients: [...], invoices: [...], ... }, profile }
 * → { seq, applied: [{table,uuid,version}], conflicts: [{table,uuid,authoritative}],
 *     rejected: [{table,uuid,reason,authoritative}], aliases: [{table,incomingUuid,canonicalUuid}] }
 *
 * Reglas (INFORME_API_SYNC.md):
 *  1. El servidor asigna `updated_at` y la versión final; el cliente alinea la
 *     suya con la respuesta (`applied[].version`).
 *  2. Conflicto por uuid: gana la versión mayor; a igualdad gana el servidor y
 *     la fila autoritativa completa viaja en `conflicts`.
 *  3. Inmutabilidad SENIAT: una factura sellada solo acepta actualizaciones
 *     selladas con el MISMO document_hash (anulación por NC, retenciones) —
 *     cualquier otro cambio se rechaza con reason:"sealed".
 *  4. Identidad de negocio: un uuid nuevo cuya clave de negocio ya existe viva
 *     (facturas: document_type+number; productos: code) se fusiona sobre la
 *     fila canónica y el mapeo viaja en `aliases`.
 *  5. Cada cambio aplicado registra su entrada en change_log con bump del
 *     cursor, TODO dentro de un único batch atómico.
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > 10 * 1024 * 1024) {
        return res.status(413).json({ error: 'Payload too large (> 10MB)' });
    }

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    if (await isDeviceRevoked(user)) {
        return res.status(401).json({ error: 'DEVICE_REVOKED' });
    }

    const body = req.body || {};
    const changes = body.changes && typeof body.changes === 'object' ? body.changes : {};
    const profile = body.profile || null;

    const applied = [];
    const conflicts = [];
    const rejected = [];
    const aliases = [];
    const accountKey = String(user.licenseKey || '').trim().toUpperCase() || null;
    const statements = [ensureCursorStatement(user.email, accountKey)];
    const now = new Date().toISOString();

    let connection;
    try {
        connection = getConnection();

        // Escalabilidad horizontal y vertical: auto-aprovisiona los espejos de
        // las tablas que trae el push de forma segura y sanitizada.
        const incomingTableNames = Object.keys(changes)
            .map(t => t.trim())
            .filter(t => /^[a-z][a-z0-9_]{1,40}$/i.test(t));

        await ensureMirrorTables(
            connection,
            incomingTableNames,
            changes,
        );

        // ─── Pre-lecturas por tabla con resolución topológica (anti-FK crash) ──
        const orderedTables = resolveTableOrder(incomingTableNames);
        for (const table of orderedTables) {
            const rows = changes[table];
            if (!Array.isArray(rows) || !rows.length) continue;

            const rule = CORE_TABLE_RULES[table] || {};
            // La especificación se resuelve desde el REGISTRO en base de datos
            // (con descubrimiento físico de columnas). Si la tabla no está
            // registrada se cae al comportamiento de siempre: se infieren las
            // columnas de la primera fila que llega.
            let spec = await resolveSpec(connection, table);
            if (!TABLE_SPECS[table] && !spec.cols.length) {
                spec = {
                    ...spec,
                    cols: Object.keys(rows[0] || {}).filter(
                        c => !['uuid', 'account_email', 'version', 'updated_at', 'deleted_at'].includes(c)
                    ),
                    businessKey: rule.businessKey || null,
                    sealed: rule.sealed || false,
                    appendOnly: rule.appendOnly || false,
                };
            }
            const physicalCols = await getTableColumns(connection, table);

            const uuids = rows.map(r => String(r.uuid || '')).filter(Boolean);
            if (!uuids.length) continue;

            // Estado actual de las filas entrantes.
            // Tolerante a esquema viejo: si la tabla espejo aún no existe en
            // Turso (p. ej. sync_taxes con la migración pendiente), se omite
            // SOLO esa tabla en vez de tumbar el push completo.
            const placeholders = uuids.map(() => '?').join(',');
            let existingRows;
            try {
                if (spec.conflictTarget && spec.conflictTarget.includes('account_email')) {
                    [existingRows] = await connection.execute(
                        `SELECT * FROM ${spec.remote} WHERE account_email = ? AND uuid IN (${placeholders})`,
                        [user.email, ...uuids]
                    );
                } else if (spec.accountScoped) {
                    [existingRows] = await connection.execute(
                        `SELECT * FROM ${spec.remote} WHERE uuid IN (${placeholders})`,
                        [...uuids]
                    );
                } else {
                    [existingRows] = await connection.execute(
                        `SELECT i.*, p.account_email AS parent_account, p.sealed_at AS parent_sealed
                         FROM ${spec.remote} i
                         LEFT JOIN ${spec.parent.table} p ON p.uuid = i.${spec.parent.fk}
                         WHERE i.uuid IN (${placeholders})`,
                        [...uuids]
                    );
                }
            } catch (e) {
                console.warn(`⚠️ [Push v47] Tabla ${spec.remote} no disponible (${e.message}). Omitida.`);
                continue;
            }
            const existingByUuid = new Map(existingRows.map(r => [String(r.uuid), r]));

            // Padres de items nuevos (validación de cuenta + sellado)
            let parentByUuid = new Map();
            if (spec.parent) {
                const parentUuids = [...new Set(rows.map(r => String(r[spec.parent.fk] || '')).filter(Boolean))];
                if (parentUuids.length) {
                    const ph = parentUuids.map(() => '?').join(',');
                    const [parents] = await connection.execute(
                        `SELECT uuid, account_email, sealed_at FROM ${spec.parent.table} WHERE uuid IN (${ph})`,
                        parentUuids
                    );
                    parentByUuid = new Map(parents.map(p => [String(p.uuid), p]));
                }
            }

            for (const row of rows) {
                const uuid = String(row.uuid || '');
                if (!uuid) continue;
                // v49r3: normalizar roles para no violar el CHECK de user_roles
                // y tumbar el batch atómico completo (p. ej. 'supervisor').
                if (table === 'user_roles') {
                    if (row.role !== undefined) {
                        row.role = normalizeRole(row.role);
                    }
                }
                const existing = existingByUuid.get(uuid) || null;
                // Se calcula ANTES de heredar columnas: la rama de lápida sin
                // fila remota lo usaba antes de su declaración (TDZ) y lanzaba
                // un ReferenceError que tumbaba el push completo con 500.
                const incomingVersion = toNumber(row.version, 1);

                // Robustez contra restricciones NOT NULL de Turso:
                if (existing) {
                    // Si la fila entrante es una lápida (tombstone) o carece de ciertas columnas,
                    // heredar los valores de la fila existente para que el INSERT / ON CONFLICT no falle.
                    for (const col of Object.keys(existing)) {
                        if (col === 'deleted_at') {
                            // `deleted_at: null` es un valor EXPLÍCITO: significa
                            // "restaurado". Antes se trataba como ausente y se
                            // heredaba la fecha de papelera, así que Turso volvía
                            // a borrar la fila y el pull la devolvía a la
                            // papelera ("sigue devolviéndose").
                            if (row.deleted_at === undefined) {
                                row.deleted_at = existing.deleted_at;
                            }
                            continue;
                        }
                        if (row[col] === undefined || row[col] === null) {
                            row[col] = existing[col];
                        }
                    }
                } else if (row.deleted_at) {
                    // Si la fila ya fue borrada físicamente por el cliente y ni siquiera existe en Turso,
                    // no insertar un fantasma con campos NULL para evitar violar restricciones NOT NULL o FK.
                    applied.push({ table, uuid, version: Math.max(incomingVersion, 1) });
                    continue;
                } else {
                    // Fila nueva: garantizar valores válidos en columnas NOT NULL habituales
                    if (table === 'user_roles') {
                        if (!row.email) row.email = (user.email || 'user@sync.local').trim().toLowerCase();
                        if (!row.role) row.role = 'cajero';
                        else row.role = normalizeRole(row.role);
                    } else if (table === 'clients') {
                        if (!row.name) row.name = 'Cliente sin nombre';
                    } else if (table === 'products') {
                        if (!row.name) row.name = 'Producto sin nombre';
                        if (!row.code) row.code = 'PRD-' + uuid.slice(0, 8);
                    } else if (table === 'suppliers') {
                        if (!row.name) row.name = 'Proveedor';
                    } else if (table === 'invoices') {
                        if (!row.number) row.number = 'FAC-' + uuid.slice(0, 8);
                    } else if (table === 'warehouses') {
                        if (!row.name) row.name = 'Depósito';
                        if (!row.code) row.code = 'DEP-' + uuid.slice(0, 6);
                    } else if (table === 'transfers') {
                        if (!row.transfer_number) row.transfer_number = 'TRS-' + uuid.slice(0, 6);
                    }
                }

                // Alcance de cuenta v49: la identidad estable de la cuenta es el correo (account_email).
                // Si el correo coincide, ES la misma cuenta (incluso al renovar o rotar licencias).
                // Si la fila no tiene email, se contrasta contra la licencia (account_key).
                const rowEmail = (existing?.account_email || '').trim().toLowerCase();
                const curEmail = (user.email || '').trim().toLowerCase();
                const rowKey = (existing?.account_key || '').trim().toUpperCase();
                const curKey = (accountKey || '').trim().toUpperCase();

                let isSameAccount = false;
                if (rowEmail && curEmail) {
                    isSameAccount = (rowEmail === curEmail);
                } else if (rowKey && curKey) {
                    isSameAccount = (rowKey === curKey);
                }

                if (existing && spec.accountScoped && (rowEmail || rowKey) && !isSameAccount) {
                    rejected.push({ table, uuid, reason: 'forbidden' });
                    continue;
                }
                const parentEmail = (existing?.parent_account || '').trim().toLowerCase();
                if (existing && spec.parent && parentEmail && parentEmail !== curEmail) {
                    rejected.push({ table, uuid, reason: 'forbidden' });
                    continue;
                }

                // ── Inmutabilidad SENIAT ──
                if (spec.sealed && existing && existing.sealed_at) {
                    const hashPreserved = row.sealed_at && row.document_hash &&
                        row.document_hash === existing.document_hash;
                    if (!hashPreserved) {
                        rejected.push({ table, uuid, reason: 'sealed', authoritative: existing });
                        continue;
                    }
                }
                if (spec.parent && existing && existing.parent_sealed) {
                    // Items de factura sellada: inmutables (el contenido sellado
                    // incluye sus items en el hash).
                    rejected.push({ table, uuid, reason: 'sealed', authoritative: existing });
                    continue;
                }
                if (spec.parent && !existing) {
                    const parent = parentByUuid.get(String(row[spec.parent.fk] || ''));
                    if (parent && parent.account_email && parent.account_email !== user.email) {
                        rejected.push({ table, uuid, reason: 'forbidden' });
                        continue;
                    }
                    // Item NUEVO de factura sellada: permitido solo si la factura
                    // padre viene sellada en este mismo push (primer envío del
                    // documento sellado completo); si no, rechazado.
                    if (parent && parent.sealed_at) {
                        const parentInPush = (changes.invoices || []).some(
                            inv => String(inv.uuid) === String(parent.uuid) && inv.sealed_at
                        );
                        if (!parentInPush) {
                            rejected.push({ table, uuid, reason: 'sealed' });
                            continue;
                        }
                    }
                }

                // ── Conflicto por versión ──
                if (existing) {
                    const existingVersion = toNumber(existing.version, 1);
                    if (incomingVersion < existingVersion) {
                        conflicts.push({ table, uuid, authoritative: existing });
                        continue;
                    }
                    if (incomingVersion === existingVersion) {
                        applied.push({ table, uuid, version: existingVersion });
                        conflicts.push({ table, uuid, authoritative: existing });
                        continue;
                    }

                    statements.push(upsertStatement(spec, user.email, row, uuid, incomingVersion, now, physicalCols, accountKey));
                    statements.push(...changeLogStatements(
                        user.email, table, uuid, row.deleted_at ? 'delete' : 'upsert', accountKey
                    ));
                    applied.push({ table, uuid, version: incomingVersion });
                    continue;
                }

                // ── Fila nueva: fusión por clave de negocio ──
                let canonical = null;
                if (spec.businessKey && !row.deleted_at) {
                    const keyVals = spec.businessKey.cols.map(c => row[c]);
                    const notEmptyVal = row[spec.businessKey.notEmpty];
                    const isIgnored = spec.businessKey.ignoreValues &&
                        spec.businessKey.ignoreValues.map(v => String(v).trim().toLowerCase()).includes(String(notEmptyVal || '').trim().toLowerCase());

                    if (!isIgnored && notEmptyVal !== null && notEmptyVal !== undefined && String(notEmptyVal).trim() !== '') {
                        const where = spec.businessKey.cols.map(c => `${c} = ?`).join(' AND ');
                        const [found] = await connection.execute(
                            `SELECT * FROM ${spec.remote}
                             WHERE (account_email = ? OR account_key = ?) AND ${where} AND deleted_at IS NULL
                             ORDER BY version DESC LIMIT 1`,
                            [user.email, accountKey, ...keyVals]
                        );
                        canonical = found[0] || null;
                    }
                }

                if (canonical) {
                    const canonicalUuid = String(canonical.uuid);
                    aliases.push({ table, incomingUuid: uuid, canonicalUuid });

                    if (spec.sealed && canonical.sealed_at) {
                        rejected.push({ table, uuid: canonicalUuid, reason: 'sealed', authoritative: canonical });
                        continue;
                    }
                    const finalVersion = toNumber(canonical.version, 1) + 1;
                    statements.push(upsertStatement(spec, user.email, row, canonicalUuid, finalVersion, now, physicalCols, accountKey));
                    // Re-apuntar dependencias relacionales del uuid entrante al canónico
                    if (table === 'invoices') {
                        statements.push({
                            sql: 'UPDATE sync_invoice_items SET invoice_uuid = ? WHERE invoice_uuid = ?',
                            args: [canonicalUuid, uuid],
                        });
                    } else if (table === 'products') {
                        statements.push({
                            sql: 'UPDATE sync_invoice_items SET product_uuid = ? WHERE product_uuid = ?',
                            args: [canonicalUuid, uuid],
                        });
                        statements.push({
                            sql: 'UPDATE sync_stock_movements SET product_uuid = ? WHERE product_uuid = ?',
                            args: [canonicalUuid, uuid],
                        });
                    } else if (table === 'clients') {
                        statements.push({
                            sql: 'UPDATE sync_invoices SET client_uuid = ? WHERE client_uuid = ? AND account_email = ?',
                            args: [canonicalUuid, uuid, user.email],
                        });
                    } else if (table === 'suppliers') {
                        statements.push({
                            sql: 'UPDATE sync_products SET supplier_uuid = ? WHERE supplier_uuid = ? AND account_email = ?',
                            args: [canonicalUuid, uuid, user.email],
                        });
                        statements.push({
                            sql: 'UPDATE sync_expenses SET supplier_uuid = ? WHERE supplier_uuid = ? AND account_email = ?',
                            args: [canonicalUuid, uuid, user.email],
                        });
                    }
                    statements.push(...changeLogStatements(
                        user.email, table, canonicalUuid, row.deleted_at ? 'delete' : 'upsert', accountKey
                    ));
                    applied.push({ table, uuid: canonicalUuid, version: finalVersion });
                    continue;
                }

                // Inserción limpia
                const finalVersion = Math.max(incomingVersion, 1);
                statements.push(upsertStatement(spec, user.email, row, uuid, finalVersion, now, physicalCols, accountKey));
                statements.push(...changeLogStatements(
                    user.email, table, uuid, row.deleted_at ? 'delete' : 'upsert', accountKey
                ));
                applied.push({ table, uuid, version: finalVersion });
            }
        }

        // ─── Perfil de negocio ───────────────────────────────────────────────
        let profileResult = null;
        if (profile) {
            profileResult = await buildProfileStatements(
                connection, user.email, profile, statements, accountKey
            );
        }

        // ─── Batch atómico: upserts + change_log + cursor ───────────────────
        if (statements.length > 1) {
            await connection.batch(statements);
        }

        const [seqRows] = await connection.execute(
            'SELECT COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) AS seq',
            [user.email]
        );
        const currentSeq = Number(seqRows[0]?.seq || 0);

        // Notificación instantánea en memoria para peticiones long-polling activas (0ms de latencia)
        if (applied.length > 0 || profileResult?.status === 'applied') {
            syncBus.emit('change:' + String(user.email).trim().toLowerCase(), currentSeq);
        }

        // Tiempo real: si algo cambió, despertar a los OTROS dispositivos de la
        // cuenta con un push SILENCIOSO (solo-datos) para que sincronicen aunque
        // estén cerrados. Best-effort: nunca rompe la respuesta del push.
        if (applied.length > 0 ||
            profileResult?.status === 'applied' ||
            profileResult?.status === 'change_limit') {
            try {
                await sendToLicense(connection, user.licenseKey, {
                    accountEmail: user.email,
                    excludeDeviceId: user.deviceId,
                    data: { type: 'sync', seq: String(Number(seqRows[0]?.seq || 0)) },
                });
            } catch (e) {
                console.warn('[Push v47] Aviso FCM falló:', e.message);
            }
        }

        const response = {
            seq: Number(seqRows[0]?.seq || 0),
            applied, conflicts, rejected, aliases,
        };
        if (profileResult) {
            response.profile_status = profileResult.status;
            // El límite y el contador vigentes en la nube viajan en TODA
            // respuesta de push: son los que fija soporte (editando la BD) y no
            // dependen de la versión del documento, así que la caja los refleja
            // sin esperar a un pull que nunca llegaría.
            if (profileResult.limit !== undefined) {
                response.profile_change_limit = profileResult.limit;
            }
            if (profileResult.count !== undefined) {
                response.profile_change_count = profileResult.count;
            }
            // Identidad rechazada por el límite: la caja debe volver al perfil
            // autoritativo de la nube. Su versión local ya quedó alineada con
            // la del servidor, así que ni el pull (misma versión) ni el push
            // siguiente (unchanged) volverían a reconciliarla.
            if (profileResult.status === 'change_limit') {
                try {
                    const [pr] = await connection.execute(
                        `SELECT *, COALESCE(profile_change_limit, 3) AS profile_change_limit,
                                COALESCE(profile_change_count, 0) AS profile_change_count
                         FROM clientes WHERE email = ? LIMIT 1`,
                        [user.email]
                    );
                    const authProfile = mergeProfileConfig(pr[0] || null);
                    if (authProfile) response.profile = authProfile;
                } catch (e) {
                    console.warn('[Push v47] No se pudo leer el perfil autoritativo:', e.message);
                }
            }
        }
        return res.status(200).json(response);
    } catch (e) {
        console.error('❌ [Push v47 Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

function upsertStatement(spec, email, row, uuid, version, now, physicalCols = null, accountKey = null) {
    const cols = ['uuid'];
    const vals = [uuid];
    if (spec.accountScoped) {
        cols.push('account_email');
        vals.push(email);
        if (!physicalCols || physicalCols.has('account_key')) {
            cols.push('account_key');
            vals.push(accountKey);
        }
    }

    // Filtrar columnas contra las columnas físicas reales de Turso
    const allowed = spec.cols.filter(c => !physicalCols || physicalCols.has(c));

    // Si la fila trae columnas dinámicas que ya fueron auto-migradas en Turso:
    if (physicalCols) {
        for (const key of Object.keys(row)) {
            if (physicalCols.has(key) && !allowed.includes(key) &&
                !['uuid', 'account_email', 'version', 'updated_at', 'deleted_at'].includes(key)) {
                allowed.push(key);
            }
        }
    }

    for (const c of allowed) {
        cols.push(c);
        let val = row[c];
        if (val !== null && typeof val === 'object') {
            try {
                val = JSON.stringify(val);
            } catch (err) {
                val = String(val);
            }
        }
        vals.push(val === undefined ? null : val);
    }
    cols.push('version', 'updated_at', 'deleted_at');
    vals.push(version, now, row.deleted_at === undefined ? null : row.deleted_at);

    const conflictTarget = spec.conflictTarget || '(uuid)';
    const updatable = cols.filter(c => c !== 'uuid' && c !== 'account_email');
    // REGLA DE CONFLICTO: gana la version MAYOR (igual que el push legacy).
    // Antes se hacia `col = excluded.col` SIN COMPARAR: un dispositivo con
    // datos viejos (o un tombstone de un borrado anterior) pisaba una
    // restauracion valida y el elemento volvia a la papelera al instante.
    let sql = `INSERT INTO ${spec.remote} (${cols.join(', ')})
               VALUES (${cols.map(() => '?').join(', ')})
               ON CONFLICT ${conflictTarget} DO UPDATE SET
               ${updatable.map(c => `${c} = CASE WHEN excluded.version >= ${spec.remote}.version THEN excluded.${c} ELSE ${spec.remote}.${c} END`).join(', ')}`;

    // Cinturón de seguridad en SQL además de la decisión en JS: una factura
    // sellada solo se reescribe si el sello y el hash se preservan.
    if (spec.sealed) {
        sql += ` WHERE ${spec.remote}.sealed_at IS NULL
                 OR (excluded.sealed_at IS NOT NULL
                     AND excluded.document_hash = ${spec.remote}.document_hash)`;
    } else if (spec.parent) {
        sql += ` WHERE NOT EXISTS (
                    SELECT 1 FROM ${spec.parent.table} p
                    WHERE p.uuid = ${spec.remote}.${spec.parent.fk}
                      AND p.sealed_at IS NOT NULL)`;
    }
    return { sql, args: vals };
}

async function buildProfileStatements(connection, email, profile, statements, accountKey = null) {
    let current = null;
    const licenseKey = accountKey ? String(accountKey).trim().toUpperCase() : null;
    if (licenseKey) {
        try {
            const [byLic] = await connection.execute(
                `SELECT c.*,
                        COALESCE(c.business_change_limit, c.profile_change_limit, 3) AS business_change_limit,
                        COALESCE(c.business_change_count, c.profile_change_count, 0) AS business_change_count,
                        COALESCE(c.account_change_limit, 3) AS account_change_limit,
                        COALESCE(c.account_change_count, 0) AS account_change_count,
                        COALESCE(c.profile_change_limit, 3) AS profile_change_limit,
                        COALESCE(c.profile_change_count, 0) AS profile_change_count,
                        COALESCE(c.version, 1) AS version
                 FROM licencias l
                 JOIN clientes c ON l.cliente_id = c.id
                 WHERE l.license_key = ? LIMIT 1`,
                [licenseKey]
            );
            if (byLic && byLic.length > 0) current = byLic[0];
        } catch (_) {}
    }
    if (!current) {
        try {
            const [byEmail] = await connection.execute(
                `SELECT c.*,
                        COALESCE(c.business_change_limit, c.profile_change_limit, 3) AS business_change_limit,
                        COALESCE(c.business_change_count, c.profile_change_count, 0) AS business_change_count,
                        COALESCE(c.account_change_limit, 3) AS account_change_limit,
                        COALESCE(c.account_change_count, 0) AS account_change_count,
                        COALESCE(c.profile_change_limit, 3) AS profile_change_limit,
                        COALESCE(c.profile_change_count, 0) AS profile_change_count,
                        COALESCE(c.version, 1) AS version
                 FROM clientes c WHERE LOWER(c.email) = LOWER(?) ORDER BY c.id DESC LIMIT 1`,
                [email]
            );
            if (byEmail && byEmail.length > 0) current = byEmail[0];
        } catch (_) {}
    }
    if (!current) return { status: 'not_found' };

    const incomingVersion = toNumber(profile.version, 1);
    const bLimit = toNumber(current.business_change_limit, 3);
    const bCount = toNumber(current.business_change_count, 0);
    const aLimit = toNumber(current.account_change_limit, 3);
    const aCount = toNumber(current.account_change_count, 0);

    if (incomingVersion <= toNumber(current.version, 1)) {
        return {
            status: 'unchanged',
            business_change_limit: bLimit,
            business_change_count: bCount,
            account_change_limit: aLimit,
            account_change_count: aCount,
            limit: bLimit,
            count: bCount,
        };
    }

    const businessChanged =
        (current.business_name || '').trim() !== (profile.business_name || '').trim() ||
        (current.slogan || '').trim() !== (profile.slogan || '').trim() ||
        (current.rif || '').trim() !== (profile.rif || '').trim() ||
        (current.address || '').trim() !== (profile.address || '').trim();

    const accountChanged =
        (current.user_name || '').trim() !== (profile.user_name || '').trim() ||
        (current.user_phone || '').trim() !== (profile.user_phone || '').trim();

    const businessBlocked = businessChanged && bCount >= bLimit;
    const accountBlocked = accountChanged && aCount >= aLimit;

    const newBusinessCount = businessBlocked ? bCount : (businessChanged ? bCount + 1 : bCount);
    const newAccountCount = accountBlocked ? aCount : (accountChanged ? aCount + 1 : aCount);

    const profileUpdate = await buildProfileUpdate({
        connection,
        email,
        clientId: current.id,
        profile,
        incomingVersion,
        businessChangeCount: newBusinessCount,
        accountChangeCount: newAccountCount,
        profileChangeCount: newBusinessCount,
        versionOp: '<',
        skipBusiness: businessBlocked,
        skipAccount: accountBlocked,
    });
    if (profileUpdate) statements.push(profileUpdate);
    statements.push(...changeLogStatements(email, 'profile', email, 'upsert', accountKey));

    return {
        status: (businessBlocked || accountBlocked) ? 'change_limit' : 'applied',
        business_change_limit: bLimit,
        business_change_count: newBusinessCount,
        account_change_limit: aLimit,
        account_change_count: newAccountCount,
        limit: bLimit,
        count: newBusinessCount,
    };
}
