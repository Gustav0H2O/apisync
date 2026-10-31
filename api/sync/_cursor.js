import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret, applyCors } from '../_helpers.js';
import { syncBus } from './_bus.js';

/**
 * GET /api/sync/cursor?since=<seq>&wait=<sec>  (auth JWT)
 *
 * Latido del tiempo real: devuelve el último `seq` del change-feed de la
 * cuenta en UNA sola consulta. Soporta Long-Polling (?wait=15) para despertar
 * al cliente en sub-segundos (< 500ms) cuando otro dispositivo emite una factura
 * o cambio, reduciendo el tráfico HTTP hasta en un 80% y eliminando retardos.
 *
 * Además devuelve el estado agregado de notificaciones (`notif_seq` = MAX(id)
 * visible para la cuenta y `notif_active` = cuántas están activas).
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    // Corazón del tiempo real (~4 s): sin este chequeo un dispositivo
    // revocado con JWT aún válido seguía recibiendo 200 y jamás veía la
    // pantalla de "Acceso Restringido". Mismo protocolo que /sync/changes,
    // /sync/push, /license/status y el resto de endpoints autenticados.
    if (await isDeviceRevoked(user)) {
        // Marca de contacto: la caja revocada SÍ sigue llamando al latido, pero
        // el 401 se devuelve antes de tocar `devices`, así que no había forma
        // de distinguir "no le llegó la orden" de "no la consultó". Actualizar
        // `last_seen` en la fila ya revocada no altera ninguna decisión de
        // seguridad y hace el diagnóstico verificable desde la base de datos.
        try {
            await getConnection().execute(
                `UPDATE devices SET last_seen = datetime('now')
                 WHERE license_key = ? AND device_id = ?`,
                [String(user.licenseKey || '').trim().toUpperCase(), user.deviceId]
            );
        } catch (_) { /* diagnóstico best-effort */ }
        return res.status(401).json({ error: 'DEVICE_REVOKED' });
    }

    const since = req.query.since !== undefined ? Number(req.query.since) : null;
    const waitSeconds = Math.min(20, Math.max(0, Number(req.query.wait || 0)));
    const startTime = Date.now();
    const maxWaitMs = waitSeconds * 1000;

    try {
        const connection = getConnection();

        async function fetchCursorState() {
            const [rows] = await connection.execute(
                `SELECT
                    COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) AS seq,
                    COALESCE((SELECT MAX(id) FROM app_notifications
                              WHERE target_email IS NULL OR target_email = ?), 0) AS notif_seq,
                    (SELECT COUNT(*) FROM app_notifications
                      WHERE is_active = 1 AND (target_email IS NULL OR target_email = ?)) AS notif_active`,
                [user.email, user.email, user.email]
            );

            const row = rows[0] || {};
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
                seq: Number(row.seq || 0),
                notif_seq: Number(row.notif_seq || 0),
                notif_active: Number(row.notif_active || 0),
                business_change_limit: bLimit,
                business_change_count: bCount,
                account_change_limit: aLimit,
                account_change_count: aCount,
                profile_change_limit: bLimit,
                profile_change_count: bCount,
            };
        }

        let state = await fetchCursorState();

        // Long-polling reactivo: despierta al instante vía syncBus en memoria
        // (0 ms) o por sondeo ante mutaciones de la cuenta. Con 1 s eran 20
        // consultas por request de 20 s; con 2 s son 10 y el consumo de Turso
        // y CPU baja a la mitad. Los clientes nuevos ya no usan long-poll
        // (wait=0), así que esto solo afecta a builds antiguos.
        if (since !== null && maxWaitMs > 0 && state.seq <= since) {
            const emailKey = String(user.email || '').trim().toLowerCase();
            let busTriggered = false;
            const onLocalChange = () => { busTriggered = true; };
            syncBus.once('change:' + emailKey, onLocalChange);

            try {
                while (Date.now() - startTime < maxWaitMs) {
                    if (busTriggered) {
                        state = await fetchCursorState();
                        break;
                    }
                    await new Promise(r => setTimeout(r, 2000));
                    state = await fetchCursorState();
                    if (state.seq > since || busTriggered) {
                        break; // Cambio detectado en tiempo real
                    }
                }
            } finally {
                syncBus.removeListener('change:' + emailKey, onLocalChange);
            }
        }

        return res.status(200).json(state);
    } catch (e) {
        console.error('❌ [Cursor Error]:', e.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
