import { getConnection } from './_db.js';
import { verifyToken, isDeviceRevoked } from './_helpers.js';

/**
 * GET /api/notifications
 * Recupera solo las notificaciones activas para el usuario.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    
    if (await isDeviceRevoked(user)) {
        return res.status(401).json({ error: 'DEVICE_REVOKED' });
    }

    try {
        const connection = getConnection();

        const [notifications] = await connection.execute(
            `SELECT * FROM app_notifications 
             WHERE is_active = 1 
             AND (target_email IS NULL OR target_email = ?)
             AND (start_date IS NULL OR start_date <= CURRENT_TIMESTAMP)
             AND (end_date IS NULL OR end_date >= CURRENT_TIMESTAMP)`,
            [user.email]
        );

        if (typeof connection.end === 'function') {
            await connection.end();
        } else if (typeof connection.destroy === 'function') {
            connection.destroy();
        }

        return res.status(200).json({ 
            success: true,
            notifications: notifications || []
        });
    } catch (e) {
        console.error('Error fetching notifications:', e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
