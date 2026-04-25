import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { queryDB } from '../_db.js';
import { verifyToken, isDeviceRevoked } from '../_helpers.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '1h';
const DEFAULT_MAX_DEVICES = 2;
const DEFAULT_PAIR_COOLDOWN_DAYS = 2;

// --- HELPERS ---

async function getLicensePolicy(licenseKey) {
    try {
        const rows = await queryDB(
            `SELECT COALESCE(max_devices_allowed, ?) AS max_devices_allowed,
                    COALESCE(pair_cooldown_days, ?) AS pair_cooldown_days
             FROM licencias WHERE license_key = ? LIMIT 1`,
            [DEFAULT_MAX_DEVICES, DEFAULT_PAIR_COOLDOWN_DAYS, licenseKey]
        );
        if (!rows.length) return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS };
        return {
            maxDevicesAllowed: Number(rows[0].max_devices_allowed ?? DEFAULT_MAX_DEVICES),
            pairCooldownDays: Number(rows[0].pair_cooldown_days ?? DEFAULT_PAIR_COOLDOWN_DAYS),
        };
    } catch (_) { return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS }; }
}

// --- HANDLERS VINCULACION (PAIRING) ---

async function handleGenerate(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const sessionId = uuidv4();
    const secret = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        const policy = await getLicensePolicy(user.licenseKey);
        const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [user.licenseKey]);
        if (Number(active.c || 0) >= policy.maxDevicesAllowed) return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
        
        await queryDB(`INSERT INTO pairing_sessions (session_id, secret, device_id_source, license_key, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))`, [sessionId, secret, user.deviceId, user.licenseKey]);
        return res.status(200).json({ session_id: sessionId, secret });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleConfirm(req, res) {
    const { session_id, secret, device_id, device_name } = req.body;
    if (!session_id || !secret || !device_id) return res.status(400).json({ error: 'Faltan parámetros' });
    try {
        const [session] = await queryDB(`SELECT * FROM pairing_sessions WHERE session_id = ? AND secret = ? AND used = 0 AND expires_at > datetime('now') LIMIT 1`, [session_id, secret]);
        if (!session) return res.status(400).json({ error: 'Código inválido o expirado' });
        await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, datetime('now'), datetime('now'), 0) ON CONFLICT(device_id) DO UPDATE SET revoked = 0, license_key = excluded.license_key, name = excluded.name, last_seen = datetime('now')`, [device_id, session.license_key, device_name || 'Nuevo Dispositivo']);
        await queryDB(`UPDATE pairing_sessions SET used = 1 WHERE session_id = ?`, [session_id]);
        return res.status(200).json({ success: true, license_key: session.license_key });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleStatus(req, res) {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Falta session_id' });
    try {
        const [session] = await queryDB(`SELECT used FROM pairing_sessions WHERE session_id = ? LIMIT 1`, [session_id]);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        return res.status(200).json({ confirmed: session.used === 1 });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleLink(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { target_device_id, name } = req.body;
    if (!target_device_id) return res.status(400).json({ error: 'Falta target_device_id' });
    const maxDevices = (await getLicensePolicy(user.licenseKey)).maxDevicesAllowed;
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

async function handleDevicesList(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    try {
        const devices = await queryDB(`SELECT device_id, name, last_seen, COALESCE(paired_at, last_seen) AS paired_at, revoked FROM devices WHERE license_key = ? ORDER BY revoked ASC, paired_at ASC`, [user.licenseKey]);
        const policy = await getLicensePolicy(user.licenseKey);
        return res.status(200).json({ devices, current_device_id: user.deviceId, max_devices_allowed: policy.maxDevicesAllowed, cooldown_days: policy.pairCooldownDays, active_count: devices.filter(d => d.revoked === 0).length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleUnlink(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'Falta device_id' });
    try {
        await queryDB(`UPDATE devices SET revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE device_id = ? AND license_key = ?`, [device_id, user.licenseKey]);
        return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleRename(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { device_id, name } = req.body;
    if (!device_id || !name) return res.status(400).json({ error: 'Faltan parámetros' });
    try {
        await queryDB(`UPDATE devices SET name = ? WHERE device_id = ? AND license_key = ?`, [name, device_id, user.licenseKey]);
        return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

// --- HANDLER TOKEN (LOGIN) ---

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
        const policy = await getLicensePolicy(license_key);
        const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [license_key]);
        if (Number(active.c || 0) >= policy.maxDevicesAllowed) return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
        await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`, [device_id, license_key, name || 'Sin nombre']);
    } else {
        await queryDB(`UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE device_id = ?`, [device_id]);
    }
    const token = jwt.sign({ licenseKey: license_key, deviceId: device_id, email: lic.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    return res.status(200).json({ token, expiresIn: 3600 });
}

// --- MAIN HANDLER (ROUTER) ---

export default async function handler(req, res) {
    const { action } = req.query;
    const currentAction = action || 'token';
    try {
        switch (currentAction) {
            case 'token': return await handleToken(req, res);
            case 'link': return await handleLink(req, res);
            case 'device_status': return await handleDeviceStatus(req, res);
            case 'generate': return await handleGenerate(req, res);
            case 'confirm': return await handleConfirm(req, res);
            case 'status': return await handleStatus(req, res);
            case 'devices': return await handleDevicesList(req, res);
            case 'unlink': return await handleUnlink(req, res);
            case 'rename': return await handleRename(req, res);
            case 'count': 
                const user = await verifyToken(req);
                if (!user) return res.status(401).json({ error: 'No autorizado' });
                const [c] = await queryDB(`SELECT COUNT(*) as count FROM devices WHERE license_key = ? AND revoked = 0`, [user.licenseKey]);
                return res.status(200).json({ count: c.count });
            default:
                return res.status(404).json({ error: `Acción '${currentAction}' no soportada.` });
        }
    } catch (e) {
        console.error(`❌ [Auth Router Error] ${currentAction}:`, e.message);
        return res.status(500).json({ error: e.message });
    }
}
