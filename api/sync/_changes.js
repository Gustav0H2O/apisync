import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret } from '../_helpers.js';
import { TABLE_SPECS } from './_tables.js';

const MAX_LIMIT = 500;

/**
 * GET /api/sync/changes?since=<seq>&limit=<n>  (auth JWT)
 *
 * Devuelve el estado ACTUAL de las filas que cambiaron después de `since`,
 * agrupadas por tabla del cliente, más las notificaciones referidas por el
 * feed y el perfil si cambió. Idempotente y reanudable: repetir con el mismo
 * `since` produce el mismo resultado; el cliente avanza su cursor solo tras
 * aplicar el lote con éxito.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    if (await isDeviceRevoked(user)) {
        return res.status(401).json({ error: 'DEVICE_REVOKED' });
    }

    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || MAX_LIMIT));

    try {
        const connection = getConnection();

        const [entries] = await connection.execute(
            `SELECT seq, table_name, row_uuid FROM change_log
             WHERE account_email = ? AND seq > ?
             ORDER BY seq ASC LIMIT ?`,
            [user.email, since, limit]
        );

        if (!entries.length) {
            return res.status(200).json({
                nextSeq: since,
                hasMore: false,
                changes: {},
                notifications: [],
            });
        }

        const nextSeq = Number(entries[entries.length - 1].seq);
        const hasMore = entries.length === limit;

        // Agrupar uuids únicos por tabla (el estado actual de la fila cubre
        // todas sus entradas intermedias del feed).
        const uuidsByTable = new Map();
        let profileChanged = false;
        const notificationIds = new Set();

        for (const entry of entries) {
            const table = entry.table_name;
            if (table === 'profile') {
                profileChanged = true;
                continue;
            }
            if (table === 'app_notifications') {
                notificationIds.add(String(entry.row_uuid));
                continue;
            }
            if (!TABLE_SPECS[table]) continue; // tabla desconocida: ignorar
            if (!uuidsByTable.has(table)) uuidsByTable.set(table, new Set());
            uuidsByTable.get(table).add(String(entry.row_uuid));
        }

        const changes = {};
        for (const [table, uuidSet] of uuidsByTable) {
            const spec = TABLE_SPECS[table];
            const uuids = [...uuidSet];
            const placeholders = uuids.map(() => '?').join(',');

            let sql;
            let args;
            if (spec.accountScoped) {
                sql = `SELECT * FROM ${spec.remote}
                       WHERE account_email = ? AND uuid IN (${placeholders})`;
                args = [user.email, ...uuids];
            } else {
                // invoice_items: el alcance de cuenta viene por la factura padre.
                sql = `SELECT i.* FROM ${spec.remote} i
                       JOIN ${spec.parent.table} p ON p.uuid = i.${spec.parent.fk}
                       WHERE p.account_email = ? AND i.uuid IN (${placeholders})`;
                args = [user.email, ...uuids];
            }

            const [rows] = await connection.execute(sql, args);
            if (rows.length) changes[table] = rows;
        }

        // Notificaciones referidas por el feed — INCLUIDAS las desactivadas
        // (is_active = 0) para que la retracción viaje.
        let notifications = [];
        if (notificationIds.size) {
            const ids = [...notificationIds];
            const placeholders = ids.map(() => '?').join(',');
            const [rows] = await connection.execute(
                `SELECT * FROM app_notifications
                 WHERE id IN (${placeholders})
                 AND (target_email IS NULL OR target_email = ?)`,
                [...ids, user.email]
            );
            notifications = rows;
        }

        const payload = { nextSeq, hasMore, changes, notifications };

        if (profileChanged) {
            const [profileRows] = await connection.execute(
                `SELECT business_name, slogan, rif, address, user_name, email, user_phone,
                        accent_color, header_color, exchange_rate_mode, working_currency,
                        display_currency, print_currency, manual_rate, use_latest_rate,
                        usd_rate_latest, usd_rate_previous, show_banner_invoice,
                        show_banner_quote, show_banner_delivery, banner_color,
                        show_exchange_rate, config_style, products_by_stock,
                        catalog_document_title, catalog_layout_style, catalog_logo_path,
                        catalog_logo_position, catalog_banner_color, catalog_header_color,
                        catalog_show_stock, catalog_show_price_bs, catalog_show_price_usd,
                        catalog_show_iva, catalog_show_address, catalog_show_phone,
                        catalog_show_slogan, catalog_show_exchange_rate,
                        catalog_show_product_code, catalog_show_product_description,
                        catalog_show_promos, catalog_show_wholesale, catalog_footer_text,
                        catalog_grayscale_mode, invoice_print_currency,
                        estimate_print_currency, delivery_note_print_currency,
                        COALESCE(profile_change_limit, 3) AS profile_change_limit,
                        COALESCE(profile_change_count, 0) AS profile_change_count,
                        version, updated_at
                 FROM clientes WHERE email = ? LIMIT 1`,
                [user.email]
            );
            const profile = profileRows[0] || null;
            if (profile && profile.catalog_logo_path) {
                const logo = profile.catalog_logo_path;
                if (logo instanceof Buffer) {
                    profile.catalog_logo_path = logo.toString('base64');
                } else if (logo && logo.type === 'Buffer' && logo.data) {
                    profile.catalog_logo_path = Buffer.from(logo.data).toString('base64');
                } else if (logo instanceof ArrayBuffer) {
                    profile.catalog_logo_path = Buffer.from(logo).toString('base64');
                }
            }
            if (profile) payload.profile = profile;
        }

        return res.status(200).json(payload);
    } catch (e) {
        console.error('❌ [Changes Error]:', e.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
