import { queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { session_id, secret } = req.body;

    try {
        const rows = await queryDB(
            `SELECT license_key, device_id_source FROM pairing_sessions 
       WHERE session_id = ? AND secret = ? AND confirmed = 0 AND expires_at > NOW()`,
            [session_id, secret]
        );

        if (!rows.length) return res.status(401).json({ error: 'Sesión inválida o expirada' });

        await queryDB(
            `UPDATE pairing_sessions SET confirmed = 1 WHERE session_id = ?`,
            [session_id]
        );

        return res.status(200).json({
            license_key: rows[0].license_key,
            confirm: true
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
