import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Envío de notificaciones push vía Firebase Cloud Messaging (HTTP v1).
 *
 * Autenticación por CUENTA DE SERVICIO: la variable de entorno
 * `FIREBASE_SERVICE_ACCOUNT` contiene el JSON descargado de Firebase
 * o bien se lee directamente de firebase-service-account.json.
 */

let _cachedAccessToken = null;
let _cachedExpiry = 0; // epoch segundos

function getServiceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (_) {
            try {
                return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
            } catch (_) {}
        }
    }

    const possiblePaths = [
        path.resolve(__dirname, '../firebase-service-account.json'),
        path.resolve(process.cwd(), 'firebase-service-account.json'),
        path.resolve(process.cwd(), '../factuflow/flactuflow-firebase-adminsdk-fbsvc-60b89746cc.json'),
        path.resolve(process.cwd(), '../FactuDev/firebase-service-account.json')
    ];

    for (const p of possiblePaths) {
        try {
            if (fs.existsSync(p)) {
                return JSON.parse(fs.readFileSync(p, 'utf8'));
            }
        } catch (_) {}
    }

    return null;
}

export function fcmConfigured() {
    return !!getServiceAccount();
}

function getProjectId() {
    const sa = getServiceAccount();
    return (sa && sa.project_id) || process.env.FIREBASE_PROJECT_ID || 'flactuflow';
}

async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (_cachedAccessToken && now < _cachedExpiry - 60) return _cachedAccessToken;

    const sa = getServiceAccount();
    if (!sa || !sa.client_email || !sa.private_key) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT ausente o inválido');
    }

    const assertion = jwt.sign(
        {
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/firebase.messaging',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
        },
        sa.private_key,
        { algorithm: 'RS256' }
    );

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
    });
    const data = await resp.json();
    if (!resp.ok) {
        throw new Error('OAuth FCM falló: ' + JSON.stringify(data));
    }
    _cachedAccessToken = data.access_token;
    _cachedExpiry = now + (data.expires_in || 3600);
    return _cachedAccessToken;
}

/**
 * Envía a una lista de tokens. Devuelve { sent, invalidTokens }.
 * - `notification`: {title, body} → el sistema la muestra aunque la app esté
 *    cerrada. Omitir para un mensaje SILENCIOSO de solo-datos (despierta la
 *    app para sincronizar sin mostrar nada).
 * - `data`: pares clave/valor (se fuerzan a String, requisito de FCM).
 */
export async function sendToTokens(tokens, { notification, data, priority = 'high', image = null, channelId = 'factuflow_system_alerts' } = {}) {
    const unique = [...new Set((tokens || []).filter(Boolean))];
    if (!unique.length) return { sent: 0, invalidTokens: [] };
    if (!fcmConfigured()) {
        console.warn('[FCM] Service account ausente; push omitido.');
        return { sent: 0, invalidTokens: [] };
    }

    let accessToken;
    try {
        accessToken = await getAccessToken();
    } catch (e) {
        console.error('[FCM] No se pudo obtener access token:', e.message);
        return { sent: 0, invalidTokens: [] };
    }

    const projectId = getProjectId();
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const dataStr = {};
    if (data) for (const k of Object.keys(data)) dataStr[k] = String(data[k]);

    const invalidTokens = [];
    let sent = 0;

    await Promise.all(
        unique.map(async (token) => {
            const message = { token };
            if (notification) {
                message.notification = {
                    title: notification.title,
                    body: notification.body,
                    ...(image ? { image } : {})
                };
            }
            if (Object.keys(dataStr).length) message.data = dataStr;

            // Android configuration compatible con FactuFlow (ic_notification + channel)
            message.android = {
                priority: priority === 'normal' ? 'normal' : 'high',
            };
            if (notification) {
                message.android.notification = {
                    icon: 'ic_notification',
                    color: '#1E88E5',
                    sound: 'default',
                    channelId: channelId || 'factuflow_system_alerts',
                    ...(image ? { imageUrl: image } : {})
                };
            }

            // WebPush configuration para clientes web
            message.webpush = {
                notification: {
                    icon: '/assets/images/ic_notification.png',
                    badge: '/assets/images/ic_notification.png',
                    ...(image ? { image } : {})
                }
            };

            if (!notification) {
                // Solo-datos: content-available para que iOS despierte en background.
                message.apns = {
                    headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
                    payload: { aps: { 'content-available': 1 } },
                };
            }

            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message }),
                });
                if (resp.ok) {
                    sent++;
                } else {
                    const err = await resp.json().catch(() => ({}));
                    const status = err && err.error && err.error.status;
                    // Token muerto: marcar para limpieza.
                    if (
                        resp.status === 404 ||
                        status === 'NOT_FOUND' ||
                        status === 'UNREGISTERED' ||
                        /not-registered|invalid-registration|invalid-argument/i.test(
                            JSON.stringify(err)
                        )
                    ) {
                        invalidTokens.push(token);
                    }
                    console.warn('[FCM] envío falló:', resp.status, status || '');
                }
            } catch (e) {
                console.warn('[FCM] error de red:', e.message);
            }
        })
    );

    return { sent, invalidTokens };
}

/**
 * Envía a todos los dispositivos ACTIVOS de una licencia, opcionalmente
 * excluyendo el emisor. Limpia de la BD los tokens que FCM reporta muertos.
 * Tolerante: si la columna fcm_token no existe todavía, devuelve {sent:0}.
 */
export async function sendToLicense(connection, licenseKey, { excludeDeviceId, notification, data } = {}) {
    if (!licenseKey || !fcmConfigured()) return { sent: 0 };

    let rows;
    try {
        [rows] = await connection.execute(
            `SELECT device_id, fcm_token FROM devices
             WHERE license_key = ? AND revoked = 0 AND fcm_token IS NOT NULL`,
            [licenseKey]
        );
    } catch (e) {
        console.warn('[FCM] No se pudieron leer tokens (¿migración pendiente?):', e.message);
        return { sent: 0 };
    }

    const tokens = rows
        .filter((r) => String(r.device_id) !== String(excludeDeviceId))
        .map((r) => r.fcm_token);

    const { sent, invalidTokens } = await sendToTokens(tokens, { notification, data });

    for (const t of invalidTokens) {
        try {
            await connection.execute('UPDATE devices SET fcm_token = NULL WHERE fcm_token = ?', [t]);
        } catch (_) {}
    }
    return { sent };
}
