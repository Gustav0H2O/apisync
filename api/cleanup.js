import { getConnection } from './_db.js';
import { verifyToken } from './_helpers.js';

export default async function handler(req, res) {
    const user = verifyToken(req);
    if (!user || user.email !== 'suadeveloper@gmail.com') { // Solo el admin
        return res.status(401).json({ error: 'No autorizado' });
    }

    const conn = getConnection();
    const LIMIT = 999999999;
    let deletedCount = 0;

    try {
        // 1. Productos
        const [products] = await conn.execute('SELECT id FROM products WHERE stock > ? OR stock < ?', [LIMIT, -LIMIT]);
        for (const p of products) {
            await conn.execute('DELETE FROM products WHERE id = ?', [p.id]);
            deletedCount++;
        }

        // 2. Movimientos
        const [movements] = await conn.execute('SELECT id FROM stock_movements WHERE quantity > ? OR quantity < ?', [LIMIT, -LIMIT]);
        for (const m of movements) {
            await conn.execute('DELETE FROM stock_movements WHERE id = ?', [m.id]);
            deletedCount++;
        }

        // 3. Items
        const [items] = await conn.execute('SELECT id FROM invoice_items WHERE quantity > ? OR quantity < ?', [LIMIT, -LIMIT]);
        for (const i of items) {
            await conn.execute('DELETE FROM invoice_items WHERE id = ?', [i.id]);
            deletedCount++;
        }

        res.json({ success: true, deleted_records: deletedCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        conn.close();
    }
}
