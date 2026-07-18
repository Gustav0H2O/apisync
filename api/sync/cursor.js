import { getConnection } from '../_db.js';
import { verifyToken, requireJwtSecret } from '../_helpers.js';

/**
 * GET /api/sync/cursor  (auth JWT)
 *
 * Latido del tiempo real: devuelve el último `seq` del change-feed de la
 * cuenta en UNA sola consulta. El cliente lo pollea cada 4 s y solo dispara
 * un ciclo de sync cuando el seq avanza.
 *
 * Además devuelve el estado agregado de notificaciones (`notif_seq` = MAX(id)
 * visible para la cuenta y `notif_active` = cuántas están activas) para que
 * las notificaciones y sus retracciones (is_active=0) lleguen con la misma
 * latencia sin un poll dedicado — cubre también las insertadas a mano en la
 * BD, que no pasan por change_log.
 *
 * No consulta revocación de dispositivo a propósito: este endpoint no entrega
 * datos (solo contadores); la revocación se aplica en /sync/changes, /sync/push
 * y en el refresh del token.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    if (!requireJwtSecret(res)) return;

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    try {
        const connection = getConnection();
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
        return res.status(200).json({
            seq: Number(row.seq || 0),
            notif_seq: Number(row.notif_seq || 0),
            notif_active: Number(row.notif_active || 0),
        });
    } catch (e) {
        console.error('❌ [Cursor Error]:', e.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
