import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret, applyCors } from '../_helpers.js';
import { TABLE_SPECS } from './_tables.js';
import { resolveSpec } from './_registry.js';
import { mergeProfileConfig } from './_profile.js';

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
    if (applyCors(req, res)) return;
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

        // Contadores del protocolo de cambios de perfil: los fija la nube y
        // soporte puede ajustarlos editando la BD directamente. Un ajuste así
        // NO crea entrada en `change_log` ni sube `version`, de modo que el
        // cliente jamás se enteraría por el feed: viajan en CADA respuesta.
        async function profileCounters() {
            const [rows] = await connection.execute(
                `SELECT COALESCE(profile_change_limit, 3) AS profile_change_limit,
                        COALESCE(profile_change_count, 0) AS profile_change_count
                 FROM clientes WHERE email = ? LIMIT 1`,
                [user.email]
            );
            const r = rows[0] || {};
            return {
                profile_change_limit: Number(r.profile_change_limit ?? 3),
                profile_change_count: Number(r.profile_change_count ?? 0),
            };
        }

        const accountKey = String(user.licenseKey || '').trim().toUpperCase() || null;
        const [entries] = await connection.execute(
            `SELECT seq, table_name, row_uuid FROM change_log
             WHERE (account_key = ? OR (account_key IS NULL AND account_email = ?)) AND seq > ?
             ORDER BY seq ASC LIMIT ?`,
            [accountKey, user.email, since, limit]
        );

        if (!entries.length) {
            return res.status(200).json({
                nextSeq: since,
                hasMore: false,
                changes: {},
                notifications: [],
                ...(await profileCounters()),
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
            // Validar que el nombre de tabla sea un identificador seguro
            const safeTable = String(table || '').toLowerCase().trim();
            if (!/^[a-z][a-z0-9_]{1,40}$/.test(safeTable)) continue;

            if (!uuidsByTable.has(table)) uuidsByTable.set(table, new Set());
            uuidsByTable.get(table).add(String(entry.row_uuid));
        }

        const changes = {};
        for (const [table, uuidSet] of uuidsByTable) {
            // Especificación desde el registro (base de datos), no desde código.
            const spec = await resolveSpec(connection, table);
            const remote = spec.remote;
            const uuids = [...uuidSet];
            const placeholders = uuids.map(() => '?').join(',');

            let sql;
            let args;
            const accountKey = String(user.licenseKey || '').trim().toUpperCase() || null;
            if (spec.accountScoped) {
                sql = `SELECT * FROM ${remote}
                       WHERE (account_key = ? OR (account_key IS NULL AND account_email = ?)) AND uuid IN (${placeholders})`;
                args = [accountKey, user.email, ...uuids];
            } else {
                // invoice_items: el alcance de cuenta viene por la factura padre si no tiene propio.
                sql = `SELECT i.* FROM ${remote} i
                       JOIN ${spec.parent.table} p ON p.uuid = i.${spec.parent.fk}
                       WHERE (p.account_key = ? OR (p.account_key IS NULL AND p.account_email = ?)) AND i.uuid IN (${placeholders})`;
                args = [accountKey, user.email, ...uuids];
            }

            try {
                const [rows] = await connection.execute(sql, args);
                if (rows && rows.length) changes[table] = rows;
            } catch (e) {
                console.warn(`⚠️ [Changes Feed] No se pudo consultar ${remote}: ${e.message}`);
            }
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

        const payload = {
            nextSeq,
            hasMore,
            changes,
            notifications,
            ...(await profileCounters()),
        };

        if (profileChanged) {
            const [profileRows] = await connection.execute(
                `SELECT *, COALESCE(profile_change_limit, 3) AS profile_change_limit,
                         COALESCE(profile_change_count, 0) AS profile_change_count
                 FROM clientes WHERE email = ? LIMIT 1`,
                [user.email]
            );
            // Mezcla del JSON + logo en base64: función compartida con el pull
            // legacy para que no vuelvan a divergir.
            const profile = mergeProfileConfig(profileRows[0] || null);
            if (profile) payload.profile = profile;
        }

        return res.status(200).json(payload);
    } catch (e) {
        console.error('❌ [Changes Error]:', e.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
