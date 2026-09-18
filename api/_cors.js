/**
 * Helper CORS universal para endpoints de Vercel Serverless.
 * Responde inmediatamente a peticiones preflight OPTIONS con 204 No Content
 * y establece los encabezados CORS indispensables en todas las respuestas
 * (éxito, errores de cliente 4xx o servidor 5xx).
 *
 * Compatible con:
 * - FactuFlow Web en producción (Vercel, dominios personalizados, Firebase Hosting)
 * - FactuFlow Web en desarrollo local (http://localhost:<puerto>, http://127.0.0.1:<puerto>)
 * - Clientes móviles y desktop nativos (Android, Windows, iOS, Linux)
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} true si la petición era OPTIONS y ya fue respondida
 */
export function applyCors(req, res) {
    const origin = req.headers?.origin;

    if (typeof res.setHeader === 'function') {
        if (origin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        } else {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }

        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, x-app-version, x-admin-secret, Accept, Origin, X-Requested-With'
        );
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 horas
    }

    if (req.method === 'OPTIONS') {
        if (typeof res.status === 'function') {
            res.status(204).end();
        } else if (typeof res.end === 'function') {
            res.statusCode = 204;
            res.end();
        }
        return true;
    }

    return false;
}
