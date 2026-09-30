import { getConnection } from './_db.js';
import { sendToTokens, fcmConfigured } from './_fcm.js';
import { applyCors } from './_cors.js';

/**
 * GET/POST /api/cron-bcv
 * 
 * Automatización diaria de Tasa BCV (programada a las 6:00 AM VET / 10:00 UTC).
 * Consulta la tasa oficial más reciente y la envía en tiempo real vía Firebase Push
 * a todos los dispositivos registrados activos, además de persistirla en app_notifications.
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    let rateValue = null;
    let rateDate = new Date().toLocaleDateString('es-VE');

    // 1. Obtener la tasa oficial del BCV desde el servicio centralizado
    try {
        const bcvResp = await fetch('https://api-bcv-sua.vercel.app/v1/usd', {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'FactuFlow-Automations/1.0',
            }
        });

        if (bcvResp.ok) {
            const data = await bcvResp.json();
            const record = Array.isArray(data) ? data[0] : data;
            if (record && record.valor) {
                rateValue = parseFloat(record.valor).toFixed(2);
                if (record.fecha) rateDate = record.fecha;
            }
        }
    } catch (e) {
        console.warn('[cron-bcv] Error al obtener tasa de api-bcv-sua:', e.message);
    }

    // Fallback secundario si la API de BCV no responde
    if (!rateValue) {
        try {
            const fbResp = await fetch('https://pydolarve.org/api/v1/dollar?page=bcv');
            if (fbResp.ok) {
                const data = await fbResp.json();
                if (data && data.monitors && data.monitors.usd && data.monitors.usd.price) {
                    rateValue = parseFloat(data.monitors.usd.price).toFixed(2);
                }
            }
        } catch (_) {}
    }

    const title = rateValue 
        ? `📈 Tasa Oficial BCV: ${rateValue} Bs.` 
        : '📈 Actualización de Tasa Oficial BCV';
        
    const message = rateValue
        ? `Buenos días. La tasa cambiaria oficial para hoy (${rateDate}) es de ${rateValue} Bs/USD. Tus precios y conversiones están sincronizados.`
        : 'Buenos días. La tasa cambiaria oficial del BCV ha sido actualizada para la jornada de hoy. Revisa tu lista de precios.';

    let connection;
    try {
        connection = getConnection();

        // 2. Persistir en app_notifications para que los clientes la vean también al abrir la app
        await connection.execute(
            `INSERT INTO app_notifications (
                title, message, type, is_active, show_once,
                repeat_interval, route
            ) VALUES (?, ?, 'info', 1, 0, 1440, '/config')`,
            [title, message]
        );

        // 3. Enviar Push FCM a todos los dispositivos
        let pushed = 0;
        let matched = 0;
        if (fcmConfigured()) {
            const [rows] = await connection.execute(
                `SELECT fcm_token FROM devices WHERE revoked = 0 AND fcm_token IS NOT NULL`
            );
            const tokens = (rows || []).map(r => r.fcm_token).filter(Boolean);
            matched = tokens.length;

            if (tokens.length > 0) {
                const result = await sendToTokens(tokens, {
                    notification: { title, body: message },
                    data: {
                        type: 'info',
                        route: '/config',
                        rate: rateValue || '',
                        source: 'bcv_cron_6am'
                    },
                    priority: 'high',
                    channelId: 'factuflow_system_alerts'
                });
                pushed = result.sent;
            }
        }

        return res.status(200).json({
            ok: true,
            automation: 'BCV_DAILY_6AM',
            rate: rateValue,
            title,
            message,
            pushed,
            matchedDevices: matched,
            executedAt: new Date().toISOString()
        });
    } catch (e) {
        console.error('[cron-bcv] Error:', e.message);
        return res.status(500).json({ error: e.message });
    } finally {
        if (connection && typeof connection.destroy === 'function') connection.destroy();
    }
}
