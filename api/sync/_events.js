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

    // 1. Enviar evento inicial con el cursor vigente de la cuenta
    try {
        const connection = getConnection();
        const [rows] = await connection.execute(
            'SELECT COALESCE((SELECT seq FROM account_cursor WHERE account_email = ?), 0) AS seq',
            [user.email]
        );
        const currentSeq = Number(rows[0]?.seq || 0);
        res.write(`data: ${JSON.stringify({ type: 'init', seq: currentSeq })}\n\n`);
    } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'init', seq: 0 })}\n\n`);
    }

    // 2. Suscribirse al canal reactivo en memoria de esta cuenta
    const onChange = (seq) => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'sync', seq: Number(seq || 0) })}\n\n`);
        } catch (_) {}
    };

    syncBus.on('change:' + emailKey, onChange);

    // 3. Heartbeat cada 15 segundos para evitar que proxies o Vercel cierren la conexión
    const keepAliveTimer = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (_) {}
    }, 15000);

    // 4. Limpieza de memoria al desconectar el cliente
    req.on('close', () => {
        clearInterval(keepAliveTimer);
        syncBus.removeListener('change:' + emailKey, onChange);
    });
}
