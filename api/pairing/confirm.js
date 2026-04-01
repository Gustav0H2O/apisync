import { queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { session_id, secret, device_id } = req.body;

    if (!session_id || !secret || !device_id) {
        return res.status(400).json({ error: 'Faltan parámetros críticos (session_id, secret, device_id)' });
    }

    try {
        const rows = await queryDB(
            `SELECT license_key, device_id_source FROM pairing_sessions 
       WHERE session_id = ? AND secret = ? AND confirmed = 0 AND expires_at > NOW()`,
            [session_id, secret]
        );

        if (!rows.length) return res.status(401).json({ error: 'Sesión inválida o expirada' });

        const licenseKey = rows[0].license_key;

        // VERIFICACIÓN DE SEGURIDAD: ¿Este dispositivo fue revocado previamente para esta licencia?
        const revokedRows = await queryDB(
            `SELECT revoked FROM devices WHERE device_id = ? AND license_key = ? AND revoked = 1 LIMIT 1`,
            [device_id, licenseKey]
        );

        if (revokedRows.length) {
            return res.status(403).json({ 
                error: 'Este dispositivo ha sido revocado. Contacta al soporte técnico para reactivarlo.',
                code: 'DEVICE_REVOKED'
            });
        }

        await queryDB(
            `UPDATE pairing_sessions SET confirmed = 1 WHERE session_id = ?`,
            [session_id]
        );

        return res.status(200).json({
            license_key: licenseKey,
            confirm: true
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
