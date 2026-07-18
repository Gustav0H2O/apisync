import crypto from 'crypto';

/**
 * Firma de estado de licencia para validación offline anti-manipulación de
 * reloj (INFORME_SEGURIDAD_ENDPOINTS.md §3).
 *
 * - `signed_payload` = base64 de { license_key_hash, device_id, license_type,
 *   saas_expiration, signed_at }.
 * - `signature` = HMAC-SHA256(signed_payload, LICENSE_SIGNING_KEY) en hex.
 *
 * LICENSE_SIGNING_KEY debe ser una env var DISTINTA de JWT_SECRET; si aún no
 * está configurada se usa JWT_SECRET como transición (con warning en logs).
 */
export function signLicensePayload({ licenseKey, deviceId, licenseType, saasExpiration }) {
    const signingKey = process.env.LICENSE_SIGNING_KEY || process.env.JWT_SECRET;
    if (!process.env.LICENSE_SIGNING_KEY) {
        console.warn('⚠️ [License Sign] LICENSE_SIGNING_KEY no configurada; usando JWT_SECRET (transición).');
    }
    if (!signingKey) return { signed_payload: null, signature: null };

    const payload = {
        license_key_hash: crypto.createHash('sha256').update(licenseKey || '').digest('hex'),
        device_id: deviceId,
        license_type: licenseType,
        saas_expiration: saasExpiration || null,
        signed_at: new Date().toISOString(),
    };
    const signedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const signature = crypto.createHmac('sha256', signingKey).update(signedPayload).digest('hex');
    return { signed_payload: signedPayload, signature };
}
