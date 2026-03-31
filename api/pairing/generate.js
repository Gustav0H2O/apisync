import { verifyToken, queryDB } from '../_helpers.js';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_MAX_DEVICES = 2;
const DEFAULT_PAIR_COOLDOWN_DAYS = 2;

async function getLicensePolicy(licenseKey) {
    try {
        const rows = await queryDB(
            `SELECT 
                COALESCE(max_devices_allowed, ?) AS max_devices_allowed,
                COALESCE(pair_cooldown_days, ?) AS pair_cooldown_days
             FROM licencias
             WHERE license_key = ?
             LIMIT 1`,
            [DEFAULT_MAX_DEVICES, DEFAULT_PAIR_COOLDOWN_DAYS, licenseKey]
        );
        if (!rows.length) {
            return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS };
        }
        return {
            maxDevicesAllowed: Number(rows[0].max_devices_allowed || DEFAULT_MAX_DEVICES),
            pairCooldownDays: Number(rows[0].pair_cooldown_days || DEFAULT_PAIR_COOLDOWN_DAYS),
        };
    } catch (_) {
        return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS };
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });

    const sessionId = uuidv4();
    const secret = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits

    try {
        const policy = await getLicensePolicy(user.licenseKey);
        const cooldownHours = Math.max(1, policy.pairCooldownDays) * 24;

        const activeCountRows = await queryDB(
            `SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`,
            [user.licenseKey]
        );
        const activeCount = Number(activeCountRows[0]?.c || 0);
        if (activeCount >= policy.maxDevicesAllowed) {
            return res.status(403).json({
                error: 'Límite de dispositivos alcanzado',
                max_devices_allowed: policy.maxDevicesAllowed,
                active_devices: activeCount,
            });
        }

        const recentRevoked = await queryDB(
            `SELECT DATE_ADD(last_seen, INTERVAL ? HOUR) AS cooldown_until
             FROM devices
             WHERE license_key = ? AND revoked = 1
               AND TIMESTAMPDIFF(HOUR, last_seen, NOW()) < ?
             ORDER BY last_seen DESC
             LIMIT 1`,
            [cooldownHours, user.licenseKey, cooldownHours]
        );
        if (recentRevoked.length) {
            return res.status(429).json({
                error: 'Debes esperar 2 días para vincular un nuevo dispositivo',
                code: 'PAIR_COOLDOWN',
                cooldown_until: recentRevoked[0].cooldown_until,
            });
        }

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
