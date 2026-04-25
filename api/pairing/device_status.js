import { queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();

    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'Falta device_id' });

    try {
        // Verificar si el dispositivo existe y no está revocado
        const rows = await queryDB(
            `SELECT d.license_key, c.email, l.tipo AS license_type
             FROM devices d
             JOIN licencias l ON d.license_key = l.license_key
             JOIN clientes c ON l.cliente_id = c.id
             WHERE d.device_id = ? AND d.revoked = 0
             LIMIT 1`,
            [device_id]
        );

        if (!rows.length) {
            return res.status(200).json({ authorized: false });
        }

        return res.status(200).json({ 
            authorized: true, 
            license_key: rows[0].license_key,
            email: rows[0].email,
            license_type: rows[0].license_type
        });
    } catch (e) {
        console.error('Status Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
