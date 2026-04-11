import { getConnection } from './_db.js';
import { verifyToken, isDeviceRevoked } from './_helpers.js';

export default async function handler(req, res) {
    console.log(`🚀 [API] ${req.method} request received`);
    if (req.method !== 'POST') return res.status(405).end();

    const { query, params, isActivation } = req.body;
    
    const authHeader = req.headers.authorization;
    const isMaster = authHeader === `Bearer ${process.env.JWT_SECRET}`;

    // Si NO es una consulta de activación (como SELECT licencias), validamos el token
    if (!isActivation && !isMaster) {
        const decoded = verifyToken(req);
        if (!decoded) {
            return res.status(401).json({ error: 'No autorizado o token inválido' });
        }
        
        // VERIFICAR ESTADO DEL DISPOSITIVO
        if (await isDeviceRevoked(decoded)) {
            return res.status(401).json({ 
                error: 'DEVICE_REVOKED', 
                message: 'Este dispositivo ha sido desvinculado por el administrador' 
            });
        }
    } else if (isActivation && !isMaster) {
        // SEGURIDAD: Solo permitimos consultas específicas de activación si NO es maestro
        const upperQuery = query.toUpperCase();
        const isSelect = upperQuery.includes('SELECT');
        const isUpdate = upperQuery.includes('UPDATE');
        const isAllowedTable = upperQuery.includes('LICENCIAS') || 
                              upperQuery.includes('CLIENTES') || 
                              upperQuery.includes('DETALLES_SAAS');
        
        const isAllowedActivationQuery = (isSelect || isUpdate) && isAllowedTable &&
                                        !upperQuery.includes('DELETE') && 
                                        !upperQuery.includes('DROP');
        
        if (!isAllowedActivationQuery) {
            return res.status(403).json({ error: 'Consulta de activación no permitida' });
        }
    }
    // Si isMaster es true, se salta todas las validaciones y ejecuta la query


    let connection;
    try {
        connection = await getConnection();
        const safeParams = (params || []).map(p => p === undefined ? null : p);
        const [rows] = await connection.execute(query, safeParams);
        await connection.destroy(); // IMPORTANTÍSIMO AQUÍ
        return res.status(200).json({ rows });
    } catch (e) {
        if (connection) await connection.destroy();
        console.error('❌ [API] Proxy Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
