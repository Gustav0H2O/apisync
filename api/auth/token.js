import jwt from 'jsonwebtoken';
import { queryDB } from '../_db.js';
import { verifyToken, isDeviceRevoked } from '../_helpers.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '1h';
const DEFAULT_MAX_DEVICES = 2;

// --- HELPERS PARA PAIRING ---
async function getMaxDevices(licenseKey) {
    try {
        const rows = await queryDB(
            `SELECT COALESCE(max_devices_allowed, ?) AS max_devices_allowed FROM licencias WHERE license_key = ? LIMIT 1`,
            [DEFAULT_MAX_DEVICES, licenseKey]
        );
        return Number(rows[0]?.max_devices_allowed ?? DEFAULT_MAX_DEVICES);
    } catch (_) { return DEFAULT_MAX_DEVICES; }
}

// --- HANDLERS INDIVIDUALES ---

async function handleLink(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { target_device_id, name } = req.body;
    if (!target_device_id) return res.status(400).json({ error: 'Falta target_device_id' });
    const maxDevices = await getMaxDevices(user.licenseKey);
    const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0 AND device_id != ?`, [user.licenseKey, target_device_id]);
    if (Number(active.c || 0) >= maxDevices) return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
    await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0) ON CONFLICT(device_id) DO UPDATE SET license_key = excluded.license_key, revoked = 0, last_seen = CURRENT_TIMESTAMP`, [target_device_id, user.licenseKey, name || 'Dispositivo vinculado']);
    return res.status(200).json({ success: true });
}

async function handleDeviceStatus(req, res) {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'Falta device_id' });
    const rows = await queryDB(`SELECT d.license_key, c.email, l.tipo AS license_type FROM devices d JOIN licencias l ON d.license_key = l.license_key JOIN clientes c ON l.cliente_id = c.id WHERE d.device_id = ? AND d.revoked = 0 LIMIT 1`, [device_id]);
    if (!rows.length) return res.status(200).json({ authorized: false });
    return res.status(200).json({ authorized: true, license_key: rows[0].license_key, email: rows[0].email, license_type: rows[0].license_type });
}

async function handleToken(req, res) {
    const { license_key, device_id, name } = req.body;
    if (!license_key || !device_id) return res.status(400).json({ error: 'Faltan parámetros' });
    const rows = await queryDB(`SELECT l.id, l.tipo, c.email, ds.fecha_vencimiento FROM licencias l JOIN clientes c ON l.cliente_id = c.id LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id WHERE l.license_key = ? AND l.usado = 1`, [license_key]);
    if (!rows.length) return res.status(401).json({ error: 'Licencia inválida o no activa' });
    const lic = rows[0];
    if (lic.tipo === 'SAAS' && lic.fecha_vencimiento && new Date(lic.fecha_vencimiento) < new Date()) return res.status(401).json({ error: 'Licencia vencida' });
    
    const known = await queryDB(`SELECT revoked FROM devices WHERE device_id = ? AND license_key = ? LIMIT 1`, [device_id, license_key]);
    if (known.length && known[0].revoked === 1) return res.status(401).json({ error: 'DEVICE_REVOKED' });

    if (!known.length) {
        const max = await getMaxDevices(license_key);
        const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [license_key]);
        if (Number(active.c || 0) >= max) return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
        await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`, [device_id, license_key, name || 'Sin nombre']);
    } else {
        await queryDB(`UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE device_id = ?`, [device_id]);
    }

    const token = jwt.sign({ licenseKey: license_key, deviceId: device_id, email: lic.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    return res.status(200).json({ token, expiresIn: 3600 });
}

// --- MAIN HANDLER ---

export default async function handler(req, res) {
    const { action } = req.query;
    
    // Si no hay action, por defecto es 'token' (Retrocompatibilidad con POST /api/auth/token)
    const currentAction = action || 'token';

    try {
        switch (currentAction) {
            case 'token': return await handleToken(req, res);
            case 'link': return await handleLink(req, res);
            case 'device_status': return await handleDeviceStatus(req, res);
            // Redirigir el resto de pairing a la lógica consolidada si fuera necesario
            default:
                return res.status(404).json({ error: `Acción '${currentAction}' no soportada.` });
        }
    } catch (e) {
        console.error(`❌ [Auth Router Error] ${currentAction}:`, e.message);
        return res.status(500).json({ error: e.message });
    }
}
