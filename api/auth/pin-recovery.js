import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { getConnection } from '../_db.js';
import { applyCors } from '../_cors.js';

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
 * viajan en la app — mata S15/S7).
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).end();

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid_email' });
    if (rateLimited(email)) return res.status(200).json({ ok: true }); // silencioso si excede rate limit

    try {
        const connection = getConnection();

        // Generar código CSPRNG de 6 dígitos
        const code = crypto.randomInt(100000, 1000000).toString();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');

        // Guardar o actualizar código en pin_recovery_codes
        await connection.execute(
            `INSERT INTO pin_recovery_codes (email, code_hash, expires_at, attempts, created_at)
             VALUES (?, ?, datetime('now', '+10 minutes'), 0, datetime('now'))
             ON CONFLICT(email) DO UPDATE SET
               code_hash = excluded.code_hash, expires_at = excluded.expires_at,
               attempts = 0, created_at = excluded.created_at`,
            [email, codeHash]
        );

        const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
        if (!SMTP_USER || !SMTP_PASS) {
            console.error('❌ [PIN Recovery] SMTP_USER o SMTP_PASS no configurado en Vercel.');
            return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'Credenciales SMTP no configuradas' });
        }

        const cleanPass = String(SMTP_PASS).replace(/\s+/g, '');
        const host = SMTP_HOST || 'smtp.gmail.com';
        const port = Number(SMTP_PORT || 465);
        const isSecure = port === 465;

        const transporter = nodemailer.createTransport({
            host,
            port,
            secure: isSecure,
            auth: {
                user: SMTP_USER,
                pass: cleanPass,
            },
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 15000,
        });

        await transporter.sendMail({
            from: MAIL_FROM || `"FactuFlow Soporte" <${SMTP_USER}>`,
            to: email,
            subject: 'FactuFlow — Código de recuperación de PIN',
            text: `Tu código de recuperación de PIN es: ${code}\n\n` +
                  'Este código vence en 10 minutos.\n' +
                  'Si tú no solicitaste este código, puedes ignorar este mensaje.',
            html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                <div style="text-align: center; margin-bottom: 24px;">
                    <h2 style="color: #1e293b; margin: 0; font-size: 22px;">FactuFlow</h2>
                    <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Recuperación de PIN de Seguridad</p>
                </div>
                <p style="color: #334155; font-size: 15px; line-height: 1.5;">
                    Has solicitado restablecer tu PIN de acceso en FactuFlow. Utiliza el siguiente código de 6 dígitos:
                </p>
                <div style="text-align: center; margin: 28px 0;">
                    <div style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; background-color: #eff6ff; padding: 12px 28px; border-radius: 8px; border: 1px dashed #3b82f6;">
                        ${code}
                    </div>
                </div>
                <p style="color: #64748b; font-size: 13px; text-align: center;">
                    ⏱️ Este código expirará en <strong>10 minutos</strong>.
                </p>
                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
                <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
                    Si no solicitaste este código, puedes ignorar este correo de forma segura.
                </p>
            </div>
            `,
        });

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('❌ [PIN Recovery Error]:', e.message);
        return res.status(500).json({
            error: 'email_send_failed',
            message: e.message || 'Error al enviar el correo de recuperación'
        });
    }
}
