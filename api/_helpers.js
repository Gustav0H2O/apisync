import jwt from 'jsonwebtoken';
import { getConnection } from './_db.js';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Guard de configuración (INFORME_SEGURIDAD_ENDPOINTS.md §7): sin JWT_SECRET
 * cada login fallaría con un 500 genérico imposible de diagnosticar.
 * Devuelve false (y responde 500 explícito) si falta la env var.
 */
export function requireJwtSecret(res) {
    if (!process.env.JWT_SECRET) {
        res.status(500).json({ error: 'SERVER_MISCONFIGURED', detail: 'JWT_SECRET ausente' });
        return false;
    }
    return true;
}

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

// Cache en memoria del último estado conocido de revocación por device_id.
// En serverless sobrevive mientras la lambda esté caliente — suficiente para
// la ventana de gracia de 24 h ante un fallo transitorio de la BD.
const revokedStatusCache = new Map();
const REVOKED_GRACE_MS = 24 * 3600 * 1000;

/**
 * Verifica en la base de datos si el dispositivo del token ha sido revocado.
 * Fail-closed con gracia (INFORME_SEGURIDAD_ENDPOINTS.md §6): ante un error de
 * BD solo se permite el acceso si el último estado conocido (< 24 h) era
 * "no revocado"; sin ese dato, se niega.
 */
export async function isDeviceRevoked(user) {
    if (!user || !user.deviceId) return true; // El deviceId siempre es obligatorio

    try {
        const connection = getConnection();
        const [rows] = await connection.execute(
            `SELECT revoked, license_key FROM devices WHERE device_id = ? LIMIT 1`,
            [user.deviceId]
        );

        if (!rows.length) {
            console.warn(`⚠️ [Revoked Check] Dispositivo ${user.deviceId} no encontrado en DB.`);
            return true;
        }

        const device = rows[0];
        const revoked = Number(device.revoked) === 1;

        // Consistencia de licencia: token de una licencia distinta a la registrada
        if (!revoked && user.licenseKey && device.license_key && device.license_key !== user.licenseKey) {
            console.error(`❌ [Revoked Check] Conflicto de licencia para ${user.deviceId}.`);
            return true;
        }

        revokedStatusCache.set(user.deviceId, { revoked, checkedAt: Date.now() });
        return revoked;
    } catch (e) {
        console.error('❌ [Revoked Check Error]:', e.message);
        const cached = revokedStatusCache.get(user.deviceId);
        if (cached && !cached.revoked && Date.now() - cached.checkedAt < REVOKED_GRACE_MS) {
            return false; // gracia: último estado conocido era "no revocado"
        }
        return true; // fail-closed
    }
}

export async function queryDB(sql, params) {
  let connection;
  try {
    connection = getConnection();
    const [rows] = await connection.execute(sql, params || []);
    return rows;
  } catch (error) {
    console.error('Database Error:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.destroy();
    }
  }
}
