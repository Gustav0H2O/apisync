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
            const licenseKey = String(user.licenseKey || '').trim().toUpperCase();
            let clientRow = null;
            if (licenseKey) {
                try {
                    const [byLicense] = await connection.execute(
                        `SELECT 
                            c.business_change_limit, c.business_change_count,
                            c.account_change_limit, c.account_change_count,
                            c.profile_change_limit, c.profile_change_count
                         FROM licencias l
                         JOIN clientes c ON l.cliente_id = c.id
                         WHERE l.license_key = ? LIMIT 1`,
                        [licenseKey]
                    );
                    if (byLicense && byLicense.length > 0) clientRow = byLicense[0];
                } catch (_) {}
            }
            if (!clientRow) {
                try {
                    const [byEmail] = await connection.execute(
                        `SELECT 
                            business_change_limit, business_change_count,
                            account_change_limit, account_change_count,
                            profile_change_limit, profile_change_count
                         FROM clientes 
                         WHERE LOWER(email) = LOWER(?) 
                         ORDER BY id DESC LIMIT 1`,
                        [user.email]
                    );
                    if (byEmail && byEmail.length > 0) clientRow = byEmail[0];
                } catch (_) {}
            }

            const bLimit = Number(clientRow?.business_change_limit ?? clientRow?.profile_change_limit ?? 3);
            const bCount = Number(clientRow?.business_change_count ?? clientRow?.profile_change_count ?? 0);
            const aLimit = Number(clientRow?.account_change_limit ?? 3);
            const aCount = Number(clientRow?.account_change_count ?? 0);

            return {
                business_change_limit: bLimit,
                business_change_count: bCount,
                account_change_limit: aLimit,
                account_change_count: aCount,
                profile_change_limit: bLimit,
                profile_change_count: bCount,
            };
        }

        // El feed pertenece a la CUENTA (correo), NO a la licencia. Al renovar o
        // cambiar de clave, las entradas antiguas quedan guardadas con la clave
        // vieja: filtrarlas por licencia las volvía invisibles para los equipos
        // con la clave nueva (una caja veía los datos compartidos y la otra no).
        // El correo es la identidad estable de la cuenta.
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
            if (spec.accountScoped) {
                // Mismo criterio que el feed: el alcance es la cuenta (correo),
                // para no perder las filas guardadas bajo una clave anterior.
                sql = `SELECT * FROM ${remote}
                       WHERE account_email = ? AND uuid IN (${placeholders})`;
                args = [user.email, ...uuids];
            } else {
                // invoice_items: el alcance de cuenta viene por la factura padre si no tiene propio.
                sql = `SELECT i.* FROM ${remote} i
                       JOIN ${spec.parent.table} p ON p.uuid = i.${spec.parent.fk}
                       WHERE p.account_email = ? AND i.uuid IN (${placeholders})`;
                args = [user.email, ...uuids];
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
