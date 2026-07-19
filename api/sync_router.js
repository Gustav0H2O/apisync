import changes from './sync/_changes.js';
import cursor from './sync/_cursor.js';
import pull from './sync/_pull.js';
import push from './sync/_push.js';

export default async function handler(req, res) {
    const { action } = req.query;
    if (action === 'changes') return changes(req, res);
    if (action === 'cursor') return cursor(req, res);
    if (action === 'pull') return pull(req, res);
    if (action === 'push') return push(req, res);
    return res.status(404).json({error: `Acción sync '${action}' no soportada.`});
}
