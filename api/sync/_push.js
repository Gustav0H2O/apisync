import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret } from '../_helpers.js';
import {
    TABLE_SPECS, TABLE_ORDER, toNumber,
    changeLogStatements, ensureCursorStatement,
} from './_tables.js';
import { sendToLicense } from '../_fcm.js';

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
    const statements = [ensureCursorStatement(user.email)];
    const now = new Date().toISOString();

    let connection;
    try {
        connection = getConnection();

        // ─── Pre-lecturas por tabla (fuera del batch; el batch es write-atomic
        //     y la política es idempotente ante carreras) ────────────────────
        for (const table of TABLE_ORDER) {
            const rows = changes[table];
            if (!Array.isArray(rows) || !rows.length) continue;
            const spec = TABLE_SPECS[table];

            const uuids = rows.map(r => String(r.uuid || '')).filter(Boolean);
            if (!uuids.length) continue;

            // Estado actual de las filas entrantes.
            // Tolerante a esquema viejo: si la tabla espejo aún no existe en
            // Turso (p. ej. sync_taxes con la migración pendiente), se omite
            // SOLO esa tabla en vez de tumbar el push completo.
            const placeholders = uuids.map(() => '?').join(',');
            let existingRows;
            try {
                if (spec.accountScoped) {
                    [existingRows] = await connection.execute(
                        `SELECT * FROM ${spec.remote} WHERE uuid IN (${placeholders})`,
                        uuids
                    );
                } else {
                    [existingRows] = await connection.execute(
                        `SELECT i.*, p.account_email AS parent_account, p.sealed_at AS parent_sealed
                         FROM ${spec.remote} i
                         LEFT JOIN ${spec.parent.table} p ON p.uuid = i.${spec.parent.fk}
                         WHERE i.uuid IN (${placeholders})`,
                        uuids
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
                const existing = existingByUuid.get(uuid) || null;

                // Alcance de cuenta: una fila de OTRA cuenta jamás se toca.
                if (existing && spec.accountScoped && existing.account_email &&
                    existing.account_email !== user.email) {
                    rejected.push({ table, uuid, reason: 'forbidden' });
                    continue;
                }
                if (existing && spec.parent && existing.parent_account &&
                    existing.parent_account !== user.email) {
                    rejected.push({ table, uuid, reason: 'forbidden' });
                    continue;
                }

                const incomingVersion = toNumber(row.version, 1);

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
                        // idempotencia (retry) — confirmar sin reescribir. La fila
                        // autoritativa viaja igual (regla 2: a igualdad gana el
                        // servidor): si fue una edición concurrente con la MISMA
                        // versión, el cliente se realinea en vez de divergir en
                        // silencio; en un retry puro el merge es un no-op.
                        applied.push({ table, uuid, version: existingVersion });
                        conflicts.push({ table, uuid, authoritative: existing });
                        continue;
                    }

                    statements.push(upsertStatement(spec, user.email, row, uuid, incomingVersion, now));
                    statements.push(...changeLogStatements(
                        user.email, table, uuid, row.deleted_at ? 'delete' : 'upsert'
                    ));
                    applied.push({ table, uuid, version: incomingVersion });
                    continue;
                }

                // ── Fila nueva: fusión por clave de negocio ──
                let canonical = null;
                if (spec.businessKey && !row.deleted_at) {
                    const keyVals = spec.businessKey.cols.map(c => row[c]);
                    const notEmptyVal = row[spec.businessKey.notEmpty];
                    if (notEmptyVal !== null && notEmptyVal !== undefined && String(notEmptyVal) !== '') {
                        const where = spec.businessKey.cols.map(c => `${c} = ?`).join(' AND ');
                        const [found] = await connection.execute(
                            `SELECT * FROM ${spec.remote}
                             WHERE account_email = ? AND ${where} AND deleted_at IS NULL
                             ORDER BY version DESC LIMIT 1`,
                            [user.email, ...keyVals]
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
                    statements.push(upsertStatement(spec, user.email, row, canonicalUuid, finalVersion, now));
                    // Re-apuntar los items del uuid entrante al canónico
                    if (table === 'invoices') {
                        statements.push({
                            sql: 'UPDATE sync_invoice_items SET invoice_uuid = ? WHERE invoice_uuid = ?',
                            args: [canonicalUuid, uuid],
                        });
                    }
                    statements.push(...changeLogStatements(
                        user.email, table, canonicalUuid, row.deleted_at ? 'delete' : 'upsert'
                    ));
                    applied.push({ table, uuid: canonicalUuid, version: finalVersion });
                    continue;
                }

                // Inserción limpia
                const finalVersion = Math.max(incomingVersion, 1);
                statements.push(upsertStatement(spec, user.email, row, uuid, finalVersion, now));
                statements.push(...changeLogStatements(
                    user.email, table, uuid, row.deleted_at ? 'delete' : 'upsert'
                ));
                applied.push({ table, uuid, version: finalVersion });
            }
        }

        // ─── Perfil de negocio ───────────────────────────────────────────────
        let profileResult = null;
        if (profile) {
            profileResult = await buildProfileStatements(
                connection, user.email, profile, statements
            );
        }

        // ─── Batch atómico: upserts + change_log + cursor ───────────────────
        if (statements.length > 1) {
            await connection.batch(statements);
        }

        const [seqRows] = await connection.execute(
            'SELECT COALESCE((SELECT seq FROM account_cursor WHERE account_email = ?), 0) AS seq',
            [user.email]
        );

        // Tiempo real: si algo cambió, despertar a los OTROS dispositivos de la
        // cuenta con un push SILENCIOSO (solo-datos) para que sincronicen aunque
        // estén cerrados. Best-effort: nunca rompe la respuesta del push.
        if (applied.length > 0 || (profileResult === 'applied')) {
            try {
                await sendToLicense(connection, user.licenseKey, {
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
        if (profileResult) response.profile_status = profileResult;
        return res.status(200).json(response);
    } catch (e) {
        console.error('❌ [Push v47 Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

function upsertStatement(spec, email, row, uuid, version, now) {
    const cols = ['uuid'];
    const vals = [uuid];
    if (spec.accountScoped) {
        cols.push('account_email');
        vals.push(email);
    }
    for (const c of spec.cols) {
        cols.push(c);
        vals.push(row[c] === undefined ? null : row[c]);
    }
    cols.push('version', 'updated_at', 'deleted_at');
    vals.push(version, now, row.deleted_at === undefined ? null : row.deleted_at);

    const updatable = cols.filter(c => c !== 'uuid' && c !== 'account_email');
    let sql = `INSERT INTO ${spec.remote} (${cols.join(', ')})
               VALUES (${cols.map(() => '?').join(', ')})
               ON CONFLICT(uuid) DO UPDATE SET
               ${updatable.map(c => `${c} = excluded.${c}`).join(', ')}`;

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

async function buildProfileStatements(connection, email, profile, statements) {
    const [rows] = await connection.execute(
        `SELECT business_name, slogan, rif, address, user_name, user_phone,
                COALESCE(profile_change_count, 0) AS profile_change_count,
                COALESCE(profile_change_limit, 3) AS profile_change_limit,
                COALESCE(version, 1) AS version
         FROM clientes WHERE email = ? LIMIT 1`,
        [email]
    );
    if (!rows.length) return 'not_found';

    const current = rows[0];
    const incomingVersion = toNumber(profile.version, 1);
    if (incomingVersion <= toNumber(current.version, 1)) {
        return 'unchanged'; // el servidor ya tiene esta versión o una más nueva
    }

    const identityChanged =
        (current.business_name || '') !== (profile.business_name || '') ||
        (current.slogan || '') !== (profile.slogan || '') ||
        (current.rif || '') !== (profile.rif || '') ||
        (current.address || '') !== (profile.address || '') ||
        (current.user_name || '') !== (profile.user_name || '') ||
        (current.user_phone || '') !== (profile.user_phone || '');

    const count = toNumber(current.profile_change_count, 0);
    const limit = toNumber(current.profile_change_limit, 3);
    if (identityChanged && count >= limit) {
        // A diferencia del legacy, NO aborta el push completo: los datos
        // operativos se sincronizan y solo el perfil queda rechazado.
        return 'change_limit';
    }

    const mapP = (arr) => arr.map(v => v === undefined ? null : v);
    statements.push({
        sql: `UPDATE clientes SET
                business_name = ?, slogan = ?, rif = ?, address = ?, user_name = ?,
                user_phone = ?, accent_color = ?, header_color = ?, version = ?,
                exchange_rate_mode = ?, working_currency = ?, display_currency = ?,
                print_currency = ?, invoice_print_currency = ?, estimate_print_currency = ?,
                delivery_note_print_currency = ?, manual_rate = ?, use_latest_rate = ?,
                usd_rate_latest = ?, usd_rate_previous = ?, show_banner_invoice = ?,
                show_banner_quote = ?, show_banner_delivery = ?, banner_color = ?,
                show_exchange_rate = ?, config_style = ?, products_by_stock = ?,
                catalog_document_title = ?, catalog_layout_style = ?,
                catalog_logo_path = CASE WHEN ? = 1 THEN NULL ELSE catalog_logo_path END,
                catalog_logo_position = ?, catalog_banner_color = ?, catalog_header_color = ?,
                catalog_show_stock = ?, catalog_show_price_bs = ?, catalog_show_price_usd = ?,
                catalog_show_iva = ?, catalog_show_address = ?, catalog_show_phone = ?,
                catalog_show_slogan = ?, catalog_show_exchange_rate = ?,
                catalog_show_product_code = ?, catalog_show_product_description = ?,
                catalog_show_promos = ?, catalog_show_wholesale = ?,
                catalog_footer_text = ?, catalog_grayscale_mode = ?,
                history_new_button_action = ?, history_clients_button_action = ?,
                profile_change_count = ?, updated_at = CURRENT_TIMESTAMP
              WHERE email = ? AND version < ?`,
        args: mapP([
            profile.business_name, profile.slogan, profile.rif, profile.address,
            profile.user_name, profile.user_phone, profile.accent_color,
            profile.header_color, incomingVersion, profile.exchange_rate_mode,
            profile.working_currency, profile.display_currency, profile.print_currency,
            profile.invoice_print_currency, profile.estimate_print_currency,
            profile.delivery_note_print_currency, profile.manual_rate,
            profile.use_latest_rate, profile.usd_rate_latest, profile.usd_rate_previous,
            profile.show_banner_invoice, profile.show_banner_quote,
            profile.show_banner_delivery, profile.banner_color,
            profile.show_exchange_rate, profile.config_style,
            (profile.products_by_stock !== undefined) ? profile.products_by_stock : 1,
            profile.catalog_document_title, profile.catalog_layout_style,
            profile.clear_catalog_logo ? 1 : 0,
            profile.catalog_logo_position, profile.catalog_banner_color,
            profile.catalog_header_color, profile.catalog_show_stock,
            profile.catalog_show_price_bs, profile.catalog_show_price_usd,
            profile.catalog_show_iva, profile.catalog_show_address,
            profile.catalog_show_phone, profile.catalog_show_slogan,
            profile.catalog_show_exchange_rate, profile.catalog_show_product_code,
            profile.catalog_show_product_description, profile.catalog_show_promos,
            profile.catalog_show_wholesale, profile.catalog_footer_text,
            profile.catalog_grayscale_mode, profile.history_new_button_action,
            profile.history_clients_button_action,
            identityChanged ? count + 1 : count,
            email, incomingVersion,
        ]),
    });
    statements.push(...changeLogStatements(email, 'profile', email, 'upsert'));
    return 'applied';
}
