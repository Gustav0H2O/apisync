import jwt from 'jsonwebtoken';
import { queryDB } from '../_db.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '1h';
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
        // Fallback para esquemas viejos donde no existan columnas nuevas.
        return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS };
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { license_key, device_id } = req.body;
    if (!license_key || !device_id) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }

    try {
        const rows = await queryDB(
            `SELECT l.id, l.tipo, c.email, ds.fecha_vencimiento
       FROM licencias l
       JOIN clientes c ON l.cliente_id = c.id
       LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
       WHERE l.license_key = ? AND l.usado = 1`,
            [license_key]
        );

        if (!rows.length) return res.status(401).json({ error: 'Licencia inválida o no activa' });

        const lic = rows[0];

        if (lic.tipo === 'saas' && lic.fecha_vencimiento) {
            if (new Date(lic.fecha_vencimiento) < new Date()) {
                return res.status(401).json({ error: 'Licencia vencida' });
            }
        }

        const policy = await getLicensePolicy(license_key);
        const cooldownHours = Math.max(1, policy.pairCooldownDays) * 24;

        const knownDeviceRows = await queryDB(
            `SELECT device_id, revoked FROM devices WHERE device_id = ? AND license_key = ? LIMIT 1`,
            [device_id, license_key]
        );

        if (knownDeviceRows.length) {
            const known = knownDeviceRows[0];
            await queryDB(
                `UPDATE devices SET revoked = 0, last_seen = NOW() WHERE device_id = ? AND license_key = ?`,
                [known.device_id, license_key]
            );
        } else {
            const activeCountRows = await queryDB(
                `SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`,
                [license_key]
            );
            const activeCount = Number(activeCountRows[0]?.c || 0);
            if (activeCount >= policy.maxDevicesAllowed) {
                return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
            }

            const recentRevoked = await queryDB(
                `SELECT last_seen
                 FROM devices
                 WHERE license_key = ? AND revoked = 1
                   AND TIMESTAMPDIFF(HOUR, last_seen, NOW()) < ?
                 ORDER BY last_seen DESC
                 LIMIT 1`,
                [license_key, cooldownHours]
            );

            if (recentRevoked.length) {
                return res.status(429).json({
                    error: 'Debes esperar 2 días para vincular un nuevo dispositivo',
                    code: 'PAIR_COOLDOWN',
                });
            }

            await queryDB(
                `INSERT INTO devices (device_id, license_key, last_seen, revoked)
                 VALUES (?, ?, NOW(), 0)`,
                [device_id, license_key]
            );
        }

        const token = jwt.sign(
            { licenseKey: license_key, deviceId: device_id, email: lic.email },
            JWT_SECRET,
            { expiresIn: TOKEN_EXPIRY }
        );

        return res.status(200).json({ token, expiresIn: 3600 });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
