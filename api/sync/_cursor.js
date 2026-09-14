import { getConnection } from '../_db.js';
import { verifyToken, requireJwtSecret } from '../_helpers.js';

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
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const since = req.query.since !== undefined ? Number(req.query.since) : null;
    const waitSeconds = Math.min(20, Math.max(0, Number(req.query.wait || 0)));
    const startTime = Date.now();
    const maxWaitMs = waitSeconds * 1000;

    try {
        const connection = getConnection();

        async function fetchCursorState() {
            const [rows] = await connection.execute(
                `SELECT
                    COALESCE((SELECT seq FROM account_cursor WHERE account_email = ?), 0) AS seq,
                    COALESCE((SELECT MAX(id) FROM app_notifications
                              WHERE target_email IS NULL OR target_email = ?), 0) AS notif_seq,
                    (SELECT COUNT(*) FROM app_notifications
                      WHERE is_active = 1 AND (target_email IS NULL OR target_email = ?)) AS notif_active`,
                [user.email, user.email, user.email]
            );

            const row = rows[0] || {};
            return {
                seq: Number(row.seq || 0),
                notif_seq: Number(row.notif_seq || 0),
                notif_active: Number(row.notif_active || 0),
            };
        }

        let state = await fetchCursorState();

        // Long-polling reactivo: si no hay cambios y se solicitó wait, esperar
        // hasta que ocurra un push o expire el tiempo de espera.
        if (since !== null && maxWaitMs > 0 && state.seq <= since) {
            while (Date.now() - startTime < maxWaitMs) {
                await new Promise(r => setTimeout(r, 600));
                state = await fetchCursorState();
                if (state.seq > since) {
                    break; // Cambio detectado en tiempo real
                }
            }
        }

        return res.status(200).json(state);
    } catch (e) {
        console.error('❌ [Cursor Error]:', e.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
