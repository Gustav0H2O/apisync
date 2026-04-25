import { verifyToken, queryDB } from '../_helpers.js';

const DEFAULT_MAX_DEVICES = 2;

async function getMaxDevices(licenseKey) {
    try {
        const rows = await queryDB(
            `SELECT COALESCE(max_devices_allowed, ?) AS max_devices_allowed FROM licencias WHERE license_key = ? LIMIT 1`,
            [DEFAULT_MAX_DEVICES, licenseKey]
        );
        return Number(rows[0]?.max_devices_allowed ?? DEFAULT_MAX_DEVICES);
    } catch (_) {
        return DEFAULT_MAX_DEVICES;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const { target_device_id, name } = req.body;
    if (!target_device_id) return res.status(400).json({ error: 'Falta target_device_id' });

    try {
        const maxDevices = await getMaxDevices(user.licenseKey);

        const activeCountRows = await queryDB(
            `SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0 AND device_id != ?`,
            [user.licenseKey, target_device_id]
        );
        const activeCount = Number(activeCountRows[0]?.c || 0);

        if (activeCount >= maxDevices) {
            return res.status(403).json({ 
                error: 'Límite de dispositivos alcanzado',
                max_devices_allowed: maxDevices 
            });
        }

        // Registrar o actualizar el dispositivo como autorizado (revoked = 0)
        await queryDB(
            `INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
             ON CONFLICT(device_id) DO UPDATE SET 
                license_key = excluded.license_key,
                revoked     = 0,
                last_seen   = CURRENT_TIMESTAMP`,
            [target_device_id, user.licenseKey, name || 'Dispositivo vinculado']
        );

        return res.status(200).json({ success: true, message: 'Dispositivo autorizado correctamente' });
    } catch (e) {
        console.error('Link Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
