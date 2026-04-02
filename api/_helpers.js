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
    if (!user || !user.deviceId) return true; // El deviceId siempre es obligatorio
    
    try {
        // Buscamos el dispositivo por su ID único.
        // Opcionalmente filtramos por licenseKey si viene en el token (modo estricto).
        // Si no viene, permitimos la migración suave siempre que el dispositivo exista y no esté revocado.
        let sql = `SELECT revoked, license_key FROM devices WHERE device_id = ? LIMIT 1`;
        let params = [user.deviceId];
        
        const rows = await queryDB(sql, params);
        if (!rows.length) {
            console.warn(`⚠️ [Revoked Check] Dispositivo ${user.deviceId} no encontrado en DB.`);
            return true; 
        }
        
        const device = rows[0];
        if (device.revoked === 1) return true;

        // Si el token tiene licenseKey, verificamos consistencia (si la DB tiene una asignada)
        if (user.licenseKey && device.license_key && device.license_key !== user.licenseKey) {
            console.error(`❌ [Revoked Check] Conflicto de licencia para ${user.deviceId}. Token: ${user.licenseKey}, DB: ${device.license_key}`);
            return true;
        }

        return false;
    } catch (e) {
        console.error('❌ [Revoked Check Error]:', e.message);
        return false; // Ante error crítico de DB, permitimos para evitar bloqueos falsos por infraestructura
    }
}

export { queryDB };
