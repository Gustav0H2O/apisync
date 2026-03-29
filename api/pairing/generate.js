import { verifyToken, queryDB } from '../_helpers.js';
import { v4 as uuidv4 } from 'uuid';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const sessionId = uuidv4();
    const secret = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits

    try {
        await queryDB(
            `INSERT INTO pairing_sessions (session_id, secret, device_id_source, license_key, expires_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
            [sessionId, secret, user.deviceId, user.licenseKey]
        );

        return res.status(200).json({ session_id: sessionId, secret });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
