import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { session_id } = req.query;

    try {
        const rows = await queryDB(
            `SELECT confirmed FROM pairing_sessions WHERE session_id = ? AND device_id_source = ?`,
            [session_id, user.deviceId]
        );

        if (!rows.length) return res.status(404).json({ error: 'Sesión no encontrada' });

        return res.status(200).json({ confirmed: rows[0].confirmed === 1 });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
