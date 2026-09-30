import jwt from 'jsonwebtoken';
import { getConnection } from './_db.js';

export { applyCors } from './_cors.js';

/**
 * Parsea una fecha de vencimiento de BD respetando la zona horaria del negocio
 * (Venezuela / UTC-4 por defecto cuando no se indica offset).
 *
 * 1. "YYYY-MM-DD" → 23:59:59.999 en UTC-4 (válida todo el día calendario).
 * 2. "YYYY-MM-DD HH:MM:SS" → interpretada en UTC-4 (no en UTC crudo de Vercel).
 * 3. ISO con 'Z' o desplazamiento → se respeta su timezone original.
 */
export function parseExpirationDate(val) {
    if (!val) return null;
    const str = String(val).trim();
    if (!str) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return new Date(`${str}T23:59:59.999-04:00`);
    }

    if (/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(str)) {
        const iso = str.replace(/\s+/, 'T');
        return new Date(`${iso}-04:00`);
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

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

export function verifyToken(req, options = {}) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.split(' ')[1];
    try {
        return jwt.verify(token, process.env.JWT_SECRET || JWT_SECRET, options);
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
        // v49: PK compuesta (license_key, device_id). Buscar scoped por licencia
        // para evitar colisión cross-cuenta; fallback legacy por device_id solo.
        const licenseKey = user.licenseKey || user.effectiveKey || null;
        let rows = [];
        if (licenseKey) {
            [rows] = await connection.execute(
                `SELECT revoked, license_key, revoked_at FROM devices WHERE license_key = ? AND device_id = ? LIMIT 1`,
                [licenseKey, user.deviceId]
            );
        }
        if (!rows.length) {
            // v49r2: fallback consciente de cuenta. El mismo device_id puede
            // existir bajo varias licencias (rotaciones/renovaciones): una
            // fila revocada VIEJA de otra licencia jamás debe marcar como
            // revocado un equipo vivo. Orden: activas primero; entre ellas,
            // las de la MISMA cuenta (mismo email) primero.
            const email = String(user.email || '').trim().toLowerCase();
            const [fb] = await connection.execute(
                `SELECT d.revoked, d.license_key,
                        CASE WHEN ? != '' AND LOWER(TRIM(COALESCE(c2.email, ''))) = ? THEN 1 ELSE 0 END AS same_account
                 FROM devices d
                 LEFT JOIN licencias l2 ON l2.license_key = d.license_key
                 LEFT JOIN clientes c2 ON c2.id = l2.cliente_id
                 WHERE d.device_id = ?
                 ORDER BY d.revoked ASC, same_account DESC, d.last_seen DESC LIMIT 1`,
                [email, email, user.deviceId]
            );
            rows = fb;
            if (rows.length && Number(rows[0].revoked) === 0 && Number(rows[0].same_account) !== 1) {
                // Fila activa pero de OTRA cuenta: fail-closed (no conceder),
                // igual que el chequeo de licencia anterior.
                console.error(`❌ [Revoked Check] Dispositivo ${user.deviceId} activo en otra cuenta.`);
                revokedStatusCache.set(user.deviceId, { revoked: true, checkedAt: Date.now() });
                return true;
            }
        }

        if (!rows.length) {
            console.warn(`⚠️ [Revoked Check] Dispositivo ${user.deviceId} no encontrado en DB.`);
            return true;
        }

        const device = rows[0];
        const revoked = Number(device.revoked) === 1;

        // Consistencia de licencia: token de una licencia distinta a la
        // registrada, en OTRA cuenta, no concede (fail-closed). Una fila
        // activa de la MISMA cuenta (rotación/renovación) sí vale: el
        // fallback ya ordenó por (activas, misma cuenta) primero.
        if (!revoked && user.licenseKey && device.license_key &&
            device.license_key !== user.licenseKey &&
            Number(device.same_account ?? 1) !== 1) {
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

/**
 * Identidad canónica de cuenta v49: license_key (estable ante cambios de
 * email o rotaciones). El email queda como display/fallback para clientes viejos.
 */
export function accountKeyOf(user) {
    const k = String(user?.licenseKey || user?.effectiveKey || user?.license_key || '').trim().toUpperCase();
    return k || null;
}

export function accountEmailOf(user) {
    return String(user?.email || '').trim().toLowerCase() || null;
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
