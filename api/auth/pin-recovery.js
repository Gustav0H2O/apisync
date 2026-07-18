import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { getConnection } from '../_db.js';

// Rate-limit: 3 solicitudes/hora por email (mejor esfuerzo en memoria).
const requestLog = new Map();
function rateLimited(email) {
    const now = Date.now();
    const entries = (requestLog.get(email) || []).filter(t => now - t < 3600_000);
    entries.push(now);
    requestLog.set(email, entries);
    return entries.length > 3;
}

/**
 * POST /api/auth/pin-recovery  ← { email }  → 200 { ok: true }
 *
 * Genera un código de 6 dígitos (CSPRNG), guarda sha256(code) con expiración
 * de 10 min y lo envía por SMTP DESDE el servidor (las credenciales ya no
 * viajan en la app — mata S15/S7). Responde siempre { ok: true } para no
 * filtrar si el email existe.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid_email' });
    if (rateLimited(email)) return res.status(200).json({ ok: true }); // silencioso

    try {
        const connection = getConnection();

        // Solo se envía si la cuenta existe — la respuesta no lo revela.
        const [account] = await connection.execute(
            'SELECT email FROM clientes WHERE email = ? LIMIT 1', [email]
        );
        if (account.length) {
            const code = crypto.randomInt(100000, 1000000).toString();
            const codeHash = crypto.createHash('sha256').update(code).digest('hex');

            await connection.execute(
                `INSERT INTO pin_recovery_codes (email, code_hash, expires_at, attempts, created_at)
                 VALUES (?, ?, datetime('now', '+10 minutes'), 0, datetime('now'))
                 ON CONFLICT(email) DO UPDATE SET
                   code_hash = excluded.code_hash, expires_at = excluded.expires_at,
                   attempts = 0, created_at = excluded.created_at`,
                [email, codeHash]
            );

            const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
            if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
                console.error('❌ [PIN Recovery] SMTP_* no configurado en Vercel.');
                return res.status(500).json({ error: 'SERVER_MISCONFIGURED' });
            }

            const transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: Number(SMTP_PORT || 465),
                secure: Number(SMTP_PORT || 465) === 465,
                auth: { user: SMTP_USER, pass: SMTP_PASS },
            });

            await transporter.sendMail({
                from: MAIL_FROM || SMTP_USER,
                to: email,
                subject: 'FactuFlow — Código de recuperación de PIN',
                text: `Tu código de recuperación de PIN es: ${code}\n\n` +
                      'Vence en 10 minutos. Si no lo solicitaste, ignora este correo.',
            });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('❌ [PIN Recovery Error]:', e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
}
