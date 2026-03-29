import jwt from 'jsonwebtoken';
import { queryDB } from '../_db.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '1h';

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
       WHERE l.license_key = ?`,
            [license_key]
        );

        if (!rows.length) return res.status(401).json({ error: 'Licencia inválida o no activa' });

        const lic = rows[0];

        if (lic.tipo === 'saas' && lic.fecha_vencimiento) {
            if (new Date(lic.fecha_vencimiento) < new Date()) {
                return res.status(401).json({ error: 'Licencia vencida' });
            }
        }

        // Registrar dispositivo
        await queryDB(
            `INSERT INTO devices (device_id, license_key, last_seen)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE last_seen = NOW()`,
            [device_id, license_key]
        );

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
