import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { device_id, name } = req.body || {};
    if (!device_id || !name) {
        return res.status(400).json({ error: 'Faltan parámetros (device_id, name)' });
    }

    try {
        // Solo permitir renombrar dispositivos asociados a la misma licencia del usuario actual
        const result = await queryDB(
            `UPDATE devices 
             SET name = ? 
             WHERE device_id = ? AND license_key = ?`,
            [name, device_id, user.licenseKey]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Dispositivo no encontrado o no pertenece a esta licencia' });
        }

        return res.status(200).json({ ok: true, message: 'Dispositivo renombrado exitosamente' });
    } catch (e) {
        console.error('❌ [Rename Error]:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
