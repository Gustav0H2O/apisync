import { getConnection } from '../_db.js';
import { verifyToken, isDeviceRevoked, requireJwtSecret, applyCors } from '../_helpers.js';
import { syncBus } from './_bus.js';

/**
 * GET /api/sync/events  (auth JWT)
 *
 * Stream Server-Sent Events (SSE) para sincronización en tiempo real (<50ms).
 * Notifica a los terminales de una cuenta el nuevo `seq` del feed en cuanto
 * otra caja emite un cobro, factura o cambio de inventario.
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

    // Cabeceras HTTP estándar para SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const emailKey = String(user.email || '').trim().toLowerCase();
    let lastSeq = 0;

    // 1. Enviar evento inicial con el cursor vigente de la cuenta
    try {
        const connection = getConnection();
        const [rows] = await connection.execute(
            'SELECT COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) AS seq',
            [user.email]
        );
        lastSeq = Number(rows[0]?.seq || 0);
        res.write(`data: ${JSON.stringify({ type: 'init', seq: lastSeq })}\n\n`);
    } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'init', seq: 0 })}\n\n`);
    }

    // 2. Suscribirse al canal reactivo en memoria de esta cuenta (0ms de latencia en la misma instancia)
    const onChange = (seq) => {
        try {
            const num = Number(seq || 0);
            if (num > lastSeq) {
                lastSeq = num;
                res.write(`data: ${JSON.stringify({ type: 'sync', seq: num })}\n\n`);
            }
        } catch (_) {}
    };

    syncBus.on('change:' + emailKey, onChange);

    // 3. Puente multi-instancia Serverless (Vercel):
    // Verifica si el cursor avanzó en Turso por pushes recibidos en otros contenedores Lambda
    let isChecking = false;
    const bridgeTimer = setInterval(async () => {
        if (isChecking) return;
        isChecking = true;
        try {
            const connection = getConnection();
            const [rows] = await connection.execute(
                'SELECT COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) AS seq',
                [user.email]
            );
            const dbSeq = Number(rows[0]?.seq || 0);
            if (dbSeq > lastSeq) {
                lastSeq = dbSeq;
                res.write(`data: ${JSON.stringify({ type: 'sync', seq: dbSeq })}\n\n`);
            }
        } catch (_) {
        } finally {
            isChecking = false;
        }
    }, 1200);

    // 4. Heartbeat cada 15 segundos para evitar que proxies o Vercel cierren la conexión
    const keepAliveTimer = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (_) {}
    }, 15000);

    // 5. Rotación elegante ANTES del límite de 300 s del runtime serverless
    // (plan Hobby): Vercel abortaba la función y registraba "Vercel Runtime
    // Timeout Error: Task timed out after 300 seconds" en cada conexión. El
    // cliente SSE reconecta solo con backoff (1 s tras el primer corte), así
    // que el stream se rota de forma transparente y el dashboard queda limpio.
    const SSE_MAX_LIFE_MS = 240 * 1000;
    const lifetimeTimer = setTimeout(() => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'rotate' })}\n\n`);
            res.end();
        } catch (_) {}
        clearInterval(bridgeTimer);
        clearInterval(keepAliveTimer);
        syncBus.removeListener('change:' + emailKey, onChange);
    }, SSE_MAX_LIFE_MS);

    // 6. Limpieza de memoria al desconectar el cliente
    req.on('close', () => {
        clearTimeout(lifetimeTimer);
        clearInterval(bridgeTimer);
        clearInterval(keepAliveTimer);
        syncBus.removeListener('change:' + emailKey, onChange);
    });
}
