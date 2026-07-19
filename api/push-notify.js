import { getConnection } from './_db.js';
import { sendToTokens, fcmConfigured } from './_fcm.js';

/**
 * POST /api/push-notify   (solo administrador)
 *
 * Envía una notificación a los dispositivos Y la persiste en app_notifications
 * (para que el motor local-first también la muestre al abrir la app). Es el
 * camino para que una notificación de administrador llegue EN TIEMPO REAL
 * aunque la app esté cerrada, sin tener que insertarla a mano por SQL.
 *
 * Seguridad: cabecera `x-admin-secret` == variable de entorno
 * `ADMIN_PUSH_SECRET` (configúrala en Vercel). Sin ese secreto no hay auth de
 * usuario aquí, así que el endpoint queda cerrado si la variable no existe.
 *
 * Body JSON:
 *   { "title": "...", "body": "...", "route": "/config"?, "target_email": "x@y"? }
 *   - target_email omitido → broadcast a TODOS los dispositivos.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const secret = process.env.ADMIN_PUSH_SECRET;
    if (!secret || req.headers['x-admin-secret'] !== secret) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const body = req.body || {};
    const title = body.title || 'FactuFlow';
    const message = body.body || body.message;
    const route = body.route || null;
    const targetEmail = body.target_email || null;
    if (!message) return res.status(400).json({ error: 'Falta el campo body' });

    let connection;
    try {
        connection = getConnection();

        // 1. Persistir para el motor local-first (visible también al abrir la app).
        await connection.execute(
            `INSERT INTO app_notifications (target_email, title, message, type, is_active, route)
             VALUES (?, ?, ?, 'info', 1, ?)`,
            [targetEmail, title, message, route]
        );

        // 2. Push inmediato (app cerrada incluida) si FCM está configurado.
        let pushed = 0;
        if (fcmConfigured()) {
            let rows;
            if (targetEmail) {
                [rows] = await connection.execute(
                    `SELECT d.fcm_token FROM devices d
                     JOIN licencias l ON d.license_key = l.license_key
                     JOIN clientes c ON l.cliente_id = c.id
                     WHERE c.email = ? AND d.revoked = 0 AND d.fcm_token IS NOT NULL`,
                    [targetEmail]
                );
            } else {
                [rows] = await connection.execute(
                    `SELECT fcm_token FROM devices WHERE revoked = 0 AND fcm_token IS NOT NULL`
                );
            }
            const tokens = rows.map((r) => r.fcm_token);
            const result = await sendToTokens(tokens, {
                notification: { title, body: message },
                data: route ? { type: 'notification', route } : { type: 'notification' },
            });
            pushed = result.sent;
        }

        return res.status(200).json({ ok: true, persisted: true, pushed });
    } catch (e) {
        console.error('[push-notify]', e.message);
        return res.status(500).json({ error: e.message });
    } finally {
        if (connection && typeof connection.destroy === 'function') connection.destroy();
    }
}
