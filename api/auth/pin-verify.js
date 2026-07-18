import crypto from 'crypto';
import { getConnection } from '../_db.js';

/**
 * POST /api/auth/pin-verify  ← { email, code }
 * → 200 { valid:true } | 401 { valid:false } | 429 { error:'too_many_attempts' }
 *
 * El código se compara por hash con ventana de expiración de 10 min; máximo
 * 5 intentos por código; la fila se borra al verificar con éxito.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'missing_params' });

    try {
        const connection = getConnection();
        const [rows] = await connection.execute(
            `SELECT code_hash, attempts,
                    (expires_at > datetime('now')) AS is_valid_window
             FROM pin_recovery_codes WHERE email = ? LIMIT 1`,
            [email]
        );
        if (!rows.length) return res.status(401).json({ valid: false });

        const row = rows[0];
        if (Number(row.attempts) >= 5) {
            return res.status(429).json({ error: 'too_many_attempts' });
        }

        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const matches = Number(row.is_valid_window) === 1 && codeHash === row.code_hash;

        if (!matches) {
            await connection.execute(
                'UPDATE pin_recovery_codes SET attempts = attempts + 1 WHERE email = ?',
                [email]
            );
            return res.status(401).json({ valid: false });
        }

        await connection.execute('DELETE FROM pin_recovery_codes WHERE email = ?', [email]);
        return res.status(200).json({ valid: true });
    } catch (e) {
        console.error('❌ [PIN Verify Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
