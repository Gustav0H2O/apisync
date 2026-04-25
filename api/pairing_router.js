import confirm from './_pairing/confirm.js';
import count from './_pairing/count.js';
import devices from './_pairing/devices.js';
import generate from './_pairing/generate.js';
import rename from './_pairing/rename.js';
import status from './_pairing/status.js';
import unlink from './_pairing/unlink.js';
import link from './_pairing/link.js';
import device_status from './_pairing/device_status.js';

export default async function handler(req, res) {
    // Extraer la acción de la URL (ej: /api/pairing/link -> link)
    const urlParts = req.url.split('?')[0].split('/');
    const action = urlParts[urlParts.length - 1];

    console.log(`🚀 [Pairing Router] Action: ${action}`);

    try {
        switch (action) {
            case 'confirm': return await confirm(req, res);
            case 'count': return await count(req, res);
            case 'devices': return await devices(req, res);
            case 'generate': return await generate(req, res);
            case 'rename': return await rename(req, res);
            case 'status': return await status(req, res);
            case 'unlink': return await unlink(req, res);
            case 'link': return await link(req, res);
            case 'device_status': return await device_status(req, res);
            default:
                return res.status(404).json({ error: `Acción '${action}' no encontrada en el router de vinculación.` });
        }
    } catch (e) {
        console.error(`❌ [Pairing Router Error] Action ${action}:`, e.message);
        return res.status(500).json({ error: e.message });
    }
}
