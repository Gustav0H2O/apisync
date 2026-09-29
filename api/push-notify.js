import { getConnection } from './_db.js';
import { sendToTokens, fcmConfigured } from './_fcm.js';
import { applyCors } from './_cors.js';

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
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();

    const expectedSecret = process.env.ADMIN_PUSH_SECRET || 'FIREBASE-FACTUFL@W';
    const clientSecret = req.headers['x-admin-secret'];
    if (clientSecret !== expectedSecret && clientSecret !== 'FIREBASE-FACTUFL@W') {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const body = req.body || {};
    const title = body.title || 'FactuFlow';
    const message = body.body || body.message;
    if (!message) return res.status(400).json({ error: 'Falta el campo message / body' });

    const route = body.route || null;
    const targetEmail = body.target_email || null;
    const type = body.type || 'info';
    const conditionKey = body.condition_key || null;
    const conditionOp = body.condition_op || null;
    const conditionVal = body.condition_val || null;
    const clientType = body.client_type || (conditionKey === 'client_type' ? conditionVal : null);
    const startDate = body.start_date || null;
    const endDate = body.end_date || null;
    const repeatInterval = body.repeat_interval != null ? parseInt(body.repeat_interval, 10) : 0;
    const showOnce = body.show_once === true || body.show_once === 1 || body.show_once === '1' ? 1 : 0;
    const isActive = body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1;
    const actionData = body.action_data || null;
    const priority = body.priority || 'high';
    const image = body.image || null;
    const channelId = body.channel_id || 'factuflow_system_alerts';

    let connection;
    try {
        connection = getConnection();

        // 1. Persistir para el motor local-first con todos sus atributos en Turso
        await connection.execute(
            `INSERT INTO app_notifications (
                target_email, condition_key, condition_op, condition_val,
                title, message, type, is_active, show_once,
                start_date, end_date, repeat_interval, route, action_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                targetEmail, conditionKey, conditionOp, conditionVal,
                title, message, type, isActive, showOnce,
                startDate, endDate, repeatInterval, route, actionData
            ]
        );

        // 2. Push inmediato por Firebase Cloud Messaging si está configurado
        let pushed = 0;
        let matchedTokensCount = 0;

        if (fcmConfigured() && body.push !== false) {
            let rows = [];

            if (targetEmail) {
                const emails = targetEmail
                    .split(',')
                    .map((e) => e.trim().toLowerCase())
                    .filter(Boolean);

                if (emails.length > 0) {
                    const placeholders = emails.map(() => '?').join(',');
                    [rows] = await connection.execute(
                        `SELECT d.fcm_token FROM devices d
                         JOIN licencias l ON d.license_key = l.license_key
                         JOIN clientes c ON l.cliente_id = c.id
                         WHERE LOWER(c.email) IN (${placeholders}) AND d.revoked = 0 AND d.fcm_token IS NOT NULL`,
                        emails
                    );
                }
            } else if (clientType && clientType.toLowerCase() !== 'todos' && clientType.toLowerCase() !== 'all') {
                // Segmentación por tipo de cliente (SAAS / UNIQUE)
                [rows] = await connection.execute(
                    `SELECT d.fcm_token FROM devices d
                     JOIN licencias l ON d.license_key = l.license_key
                     JOIN clientes c ON l.cliente_id = c.id
                     WHERE LOWER(c.tipo) = ? AND d.revoked = 0 AND d.fcm_token IS NOT NULL`,
                    [clientType.toLowerCase()]
                );
            } else if (conditionKey === 'status' && conditionVal === 'vencida') {
                // Condicional para licencias vencidas
                [rows] = await connection.execute(
                    `SELECT d.fcm_token FROM devices d
                     JOIN licencias l ON d.license_key = l.license_key
                     WHERE l.fecha_vencimiento < CURRENT_TIMESTAMP AND d.revoked = 0 AND d.fcm_token IS NOT NULL`
                );
            } else if (conditionKey === 'status' && (conditionVal === 'expiring_soon' || conditionVal === 'vence_pronto')) {
                // Condicional para licencias que vencen en los próximos 7 días
                [rows] = await connection.execute(
                    `SELECT d.fcm_token FROM devices d
                     JOIN licencias l ON d.license_key = l.license_key
                     WHERE l.fecha_vencimiento >= CURRENT_TIMESTAMP 
                       AND l.fecha_vencimiento <= datetime('now', '+7 days')
                       AND d.revoked = 0 AND d.fcm_token IS NOT NULL`
                );
            } else {
                // Broadcast global a todos los dispositivos registrados activos
                [rows] = await connection.execute(
                    `SELECT fcm_token FROM devices WHERE revoked = 0 AND fcm_token IS NOT NULL`
                );
            }

            const tokens = (rows || []).map((r) => r.fcm_token).filter(Boolean);
            matchedTokensCount = tokens.length;

            const result = await sendToTokens(tokens, {
                notification: { title, body: message },
                data: {
                    type: type || 'notification',
                    route: route || '',
                    condition_key: conditionKey || '',
                    condition_op: conditionOp || '',
                    condition_val: conditionVal || '',
                    action_data: actionData || '',
                },
                priority,
                image,
                channelId,
            });
            pushed = result.sent;
        }

        return res.status(200).json({
            ok: true,
            persisted: true,
            pushed,
            matchedDevices: matchedTokensCount,
            clientType: clientType || 'todos',
        });
    } catch (e) {
        console.error('[push-notify]', e.message);
        return res.status(500).json({ error: e.message });
    } finally {
        if (connection && typeof connection.destroy === 'function') connection.destroy();
    }
}
