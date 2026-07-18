/**
 * DEPRECADO (INFORME_API_SYNC.md §2.4): este endpoint tenía una tercera
 * política de conflictos distinta de sync.js y del push v47, causando
 * divergencia. Ningún cliente en producción lo usa (verificado por logs);
 * los clientes < v47 usan /api/sync y los >= v47 el change-feed.
 */
export default async function handler(req, res) {
    return res.status(410).json({
        error: 'GONE',
        message: 'Endpoint retirado. Use /api/sync (legacy) o /api/sync/changes (v47).',
    });
}
