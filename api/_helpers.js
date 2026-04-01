import jwt from 'jsonwebtoken';
import { queryDB } from './_db.js';

const JWT_SECRET = process.env.JWT_SECRET;

export function verifyToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.split(' ')[1];
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

/**
 * Verifica en la base de datos si el dispositivo del token ha sido revocado.
 * Esto previene que una sesión siga activa después de la desvinculación.
 */
export async function isDeviceRevoked(user) {
    if (!user || !user.deviceId || !user.licenseKey) return true;
    
    try {
        const rows = await queryDB(
            `SELECT revoked FROM devices WHERE device_id = ? AND license_key = ? LIMIT 1`,
            [user.deviceId, user.licenseKey]
        );
        if (!rows.length) return true; // Si desapareció, lo tratamos como revocado
        return rows[0].revoked === 1;
    } catch (e) {
        console.error('❌ [Revoked Check Error]:', e.message);
        return false; // Ante error de DB, permitimos por ahora para evitar bloqueos falsos
    }
}

export { queryDB };
