import { queryDB } from './_db.js';
import { verifyToken } from './_helpers.js';

export default async function handler(req, res) {
    console.log(`🚀 [API] ${req.method} request received`);
    if (req.method !== 'POST') return res.status(405).end();

    const { query, params, isActivation } = req.body;
    console.log(`🔍 [API] Query: ${query?.substring(0, 50)}...`);
    console.log(`🔐 [API] isActivation: ${isActivation}`);
    
    // Si NO es una consulta de activación (como SELECT licencias), validamos el token
    if (!isActivation) {
        const decoded = verifyToken(req);
        if (!decoded) {
            console.log('❌ [API] Unauthorized: Invalid or missing token');
            return res.status(401).json({ error: 'No autorizado o token inválido' });
        }
    } else {
        // SEGURIDAD: Solo permitimos consultas específicas de activación
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
            console.log('❌ [API] Forbidden: Non-allowed activation query');
            return res.status(403).json({ error: 'Consulta de activación no permitida' });
        }
    }

    try {
        const rows = await queryDB(query, params);
        console.log('✅ [API] Query executed successfully');
        return res.status(200).json({ rows });
    } catch (e) {
        console.error('❌ [API] Proxy Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
