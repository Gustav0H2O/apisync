import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { queryDB } from '../_db.js';
import { verifyToken, isDeviceRevoked, applyCors, parseExpirationDate } from '../_helpers.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '1h';
const DEFAULT_MAX_DEVICES = 2;
const DEFAULT_PAIR_COOLDOWN_DAYS = 2;

// --- HELPERS ---

async function getLicensePolicy(licenseKey) {
    try {
        const rows = await queryDB(
            `SELECT COALESCE(max_devices_allowed, ?) AS max_devices_allowed,
                    COALESCE(pair_cooldown_days, ?) AS pair_cooldown_days
             FROM licencias WHERE license_key = ? LIMIT 1`,
            [DEFAULT_MAX_DEVICES, DEFAULT_PAIR_COOLDOWN_DAYS, licenseKey]
        );
        if (!rows.length) return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS };
        return {
            maxDevicesAllowed: Number(rows[0].max_devices_allowed ?? DEFAULT_MAX_DEVICES),
            pairCooldownDays: Number(rows[0].pair_cooldown_days ?? DEFAULT_PAIR_COOLDOWN_DAYS),
        };
    } catch (e) { 
        console.warn('⚠️ [Policy Check] Error al obtener política, usando valores por defecto:', e.message);
        return { maxDevicesAllowed: DEFAULT_MAX_DEVICES, pairCooldownDays: DEFAULT_PAIR_COOLDOWN_DAYS }; 
    }
}

// --- HANDLERS VINCULACION (PAIRING) ---

async function handleGenerate(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const sessionId = uuidv4();
    const secret = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        const policy = await getLicensePolicy(user.licenseKey);
        const cooldownHours = policy.pairCooldownDays * 24;
        const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [user.licenseKey]);
        const activeCount = Number(active.c || 0);

        if (activeCount >= policy.maxDevicesAllowed) {
            return res.status(403).json({ 
                error: 'Límite de dispositivos alcanzado', 
                max_devices_allowed: policy.maxDevicesAllowed, 
                active_devices: activeCount 
            });
        }
        
        const recentRevoked = await queryDB(`SELECT datetime(COALESCE(revoked_at, last_seen), '+' || ? || ' hours') AS cooldown_until FROM devices WHERE license_key = ? AND revoked = 1 AND (julianday('now') - julianday(COALESCE(revoked_at, last_seen))) * 24 < ? ORDER BY COALESCE(revoked_at, last_seen) DESC LIMIT 1`, [cooldownHours, user.licenseKey, cooldownHours]);
        if (recentRevoked.length) {
            return res.status(429).json({ 
                error: `Debes esperar ${policy.pairCooldownDays} días para vincular un nuevo dispositivo`, 
                code: 'PAIR_COOLDOWN', 
                cooldown_until: recentRevoked[0].cooldown_until 
            });
        }

        await queryDB(`INSERT INTO pairing_sessions (session_id, secret, device_id_source, license_key, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))`, [sessionId, secret, user.deviceId, user.licenseKey]);
        return res.status(200).json({ session_id: sessionId, secret });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleConfirm(req, res) {
    const { session_id, secret, device_id, device_name } = req.body || {};
    if (!session_id || !secret || !device_id) return res.status(400).json({ error: 'Faltan parámetros críticos (session_id, secret, device_id)' });
    try {
        const rows = await queryDB(`SELECT license_key FROM pairing_sessions WHERE session_id = ? AND secret = ? AND confirmed = 0 AND expires_at > CURRENT_TIMESTAMP`, [session_id, secret]);
        if (!rows.length) return res.status(401).json({ error: 'Sesión inválida o expirada' });
        const licenseKey = rows[0].license_key;
        
        const revoked = await queryDB(`SELECT revoked FROM devices WHERE device_id = ? AND license_key = ? AND revoked = 1 LIMIT 1`, [device_id, licenseKey]);
        if (revoked.length) {
            return res.status(403).json({ 
                error: 'Este dispositivo ha sido revocado. Contacta al soporte técnico para reactivarlo.', 
                code: 'DEVICE_REVOKED' 
            });
        }

        // v49: confirm NO bypasea límite/cooldown. Verificación best-effort
        // (el reintento del mismo dispositivo ya activo siempre se permite).
        const policy = await getLicensePolicy(licenseKey);
        const [cnt] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0 AND device_id != ?`, [licenseKey, device_id]);
        const alreadyActive = await queryDB(`SELECT 1 AS x FROM devices WHERE license_key = ? AND device_id = ? AND revoked = 0 LIMIT 1`, [licenseKey, device_id]);
        if (!alreadyActive.length && Number(cnt.c || 0) >= policy.maxDevicesAllowed) {
            return res.status(403).json({ error: 'Límite de dispositivos alcanzado', max_devices_allowed: policy.maxDevicesAllowed });
        }
        if (!alreadyActive.length && policy.pairCooldownDays > 0) {
            const cooldownHours = policy.pairCooldownDays * 24;
            const recentRevoked = await queryDB(`SELECT 1 AS x FROM devices WHERE license_key = ? AND revoked = 1 AND (julianday('now') - julianday(COALESCE(revoked_at, last_seen))) * 24 < ? LIMIT 1`, [licenseKey, cooldownHours]);
            if (recentRevoked.length) {
                return res.status(429).json({ error: `Debes esperar ${policy.pairCooldownDays} días para vincular un nuevo dispositivo`, code: 'PAIR_COOLDOWN' });
            }
        }
        
        await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, datetime('now'), datetime('now'), 0) ON CONFLICT(license_key, device_id) DO UPDATE SET revoked = 0, revoked_at = NULL, paired_at = datetime('now'), name = excluded.name, last_seen = datetime('now')`, [device_id, licenseKey, device_name || 'Nuevo Dispositivo']);
        await queryDB(`UPDATE pairing_sessions SET confirmed = 1, confirmed_device_id = ? WHERE session_id = ?`, [device_id, session_id]);
        
        const licRows = await queryDB(
            `SELECT c.email, l.tipo AS license_type, ds.fecha_vencimiento AS saas_expiration 
             FROM licencias l 
             JOIN clientes c ON l.cliente_id = c.id 
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE l.license_key = ? LIMIT 1`, 
            [licenseKey]
        );
        const licData = licRows[0] || {};
        const saasExp = parseExpirationDate(licData.saas_expiration);
        return res.status(200).json({ 
            license_key: licenseKey, 
            email: licData.email,
            license_type: licData.license_type,
            saas_expiration: saasExp ? saasExp.toISOString() : null,
            confirm: true 
        });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleStatus(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Falta session_id' });
    try {
        const [session] = await queryDB(`SELECT confirmed, confirmed_device_id FROM pairing_sessions WHERE session_id = ? AND device_id_source = ? LIMIT 1`, [session_id, user.deviceId]);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        return res.status(200).json({ 
            confirmed: session.confirmed === 1,
            target_device_id: session.confirmed_device_id || null
        });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleLink(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { target_device_id, name } = req.body || {};
    if (!target_device_id) return res.status(400).json({ error: 'Falta target_device_id' });
    const policy = await getLicensePolicy(user.licenseKey);
    // v49 fix off-by-one: contar TODOS los activos; si el target ya está
    // activo, permitir (re-link). El conteo anterior excluía al target y
    // permitía max+1 dispositivos.
    const [allActive] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [user.licenseKey]);
    const [target] = await queryDB(`SELECT revoked FROM devices WHERE license_key = ? AND device_id = ? LIMIT 1`, [user.licenseKey, target_device_id]);
    const targetIsActive = target && Number(target.revoked) === 0;
    if (!targetIsActive && Number(allActive.c || 0) >= policy.maxDevicesAllowed) return res.status(403).json({ error: 'Límite de dispositivos alcanzado', max_devices_allowed: policy.maxDevicesAllowed, active_devices: Number(allActive.c || 0) });
    await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0) ON CONFLICT(license_key, device_id) DO UPDATE SET revoked = 0, revoked_at = NULL, paired_at = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP`, [target_device_id, user.licenseKey, name || 'Dispositivo vinculado']);
    return res.status(200).json({ success: true });
}

async function handleDeviceStatus(req, res) {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'Falta device_id' });
    const rows = await queryDB(
        `SELECT d.license_key, c.email, l.tipo AS license_type, ds.fecha_vencimiento AS saas_expiration, d.paired_at, d.revoked 
         FROM devices d 
         JOIN licencias l ON d.license_key = l.license_key 
         JOIN clientes c ON l.cliente_id = c.id 
         LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
         WHERE d.device_id = ? AND d.revoked = 0 LIMIT 1`, 
        [device_id]
    );
    if (!rows.length) return res.status(200).json({ authorized: false });
    
    let pairedAtIso = null;
    if (rows[0].paired_at) {
        const raw = String(rows[0].paired_at).trim();
        pairedAtIso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    }

    const saasExp = parseExpirationDate(rows[0].saas_expiration);
    return res.status(200).json({ 
        authorized: true, 
        license_key: rows[0].license_key, 
        email: rows[0].email, 
        license_type: rows[0].license_type,
        saas_expiration: saasExp ? saasExp.toISOString() : null,
        paired_at: pairedAtIso
    });
}

async function handleDevicesList(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    try {
        const devices = await queryDB(`SELECT device_id, name, last_seen, COALESCE(paired_at, last_seen) AS paired_at, revoked FROM devices WHERE license_key = ? ORDER BY revoked ASC, paired_at ASC`, [user.licenseKey]);
        const policy = await getLicensePolicy(user.licenseKey);
        return res.status(200).json({ 
            devices, 
            current_device_id: user.deviceId, 
            max_devices_allowed: policy.maxDevicesAllowed, 
            cooldown_days: policy.pairCooldownDays, 
            active_count: devices.filter(d => Number(d.revoked) === 0).length
        });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleUnlink(req, res) {
    let user = await verifyToken(req);
    const { license_key, email, target_device_id, allow_self } = req.body || {};

    // Si no hay token de usuario (o el token ya expiró/desconectado), permitir desvinculación si
    // se envían explícitamente target_device_id y license_key válidos en la BD:
    if (!user) {
        const devId = target_device_id;
        const lic = (license_key || '').trim().toUpperCase();
        if (devId && lic) {
            const devRows = await queryDB(
                `SELECT device_id FROM devices WHERE device_id = ? AND UPPER(TRIM(license_key)) = ? AND revoked = 0 LIMIT 1`,
                [devId, lic]
            );
            if (devRows.length) {
                await queryDB(
                    `UPDATE devices SET revoked = 1, revoked_at = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP WHERE UPPER(TRIM(license_key)) = ? AND device_id = ?`,
                    [lic, devId]
                );
                // El ROL del terminal también se desvincula, igual que en el
                // camino con token: sin esto, al volver a vincular la caja la
                // nube le devolvía el rol que tenía ANTES de revocarla y
                // quedaba operando con permisos que el administrador ya le
                // había quitado. Se acota por dueño de la licencia para no
                // tocar filas de otra cuenta.
                const ownerRows = await queryDB(
                    `SELECT c.email FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE UPPER(TRIM(l.license_key)) = ? LIMIT 1`,
                    [lic]
                );
                const ownerEmail = String(ownerRows[0]?.email || '').trim().toLowerCase();
                const roleRows = await queryDB(
                    `SELECT uuid FROM user_roles
                      WHERE (email = ? OR email LIKE ?)
                        AND (account_key = ? OR (account_key IS NULL AND account_email = ?))`,
                    [`device:${devId}`, `device_cfg:${devId}:%`, lic, ownerEmail]
                );
                for (const r of roleRows) {
                    await queryDB(
                        `UPDATE user_roles
                            SET deleted_at = CURRENT_TIMESTAMP,
                                updated_at = CURRENT_TIMESTAMP,
                                version = COALESCE(version, 0) + 1
                          WHERE uuid = ?`,
                        [r.uuid]
                    );
                    await queryDB(
                        `INSERT INTO change_log (account_email, account_key, seq, table_name, row_uuid, op)
                         SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) + 1,
                                'user_roles', ?, 'delete'`,
                        [ownerEmail, lic, ownerEmail, r.uuid]
                    );
                }
                return res.status(200).json({ ok: true, unlinked_device_id: devId });
            }
        }
        return res.status(401).json({ error: 'No autorizado' });
    }

    // Fallback: si el cliente no envió license_key/email en el body (o llegaron
    // vacíos — p.ej. prefs con la cuenta a medio persistir), se usan los claims
    // del JWT, que ya son fuente de verdad tras verificar el token. El email
    // además se puede recuperar del dueño registrado de la licencia en la BD.
    let effectiveLicense = (license_key || '').trim().toUpperCase() || String(user.licenseKey || '').trim().toUpperCase();
    let effectiveEmail = (email || '').trim().toLowerCase() || String(user.email || '').trim().toLowerCase();

    if (!effectiveLicense) return res.status(400).json({ error: 'Faltan parámetros de validación (license_key)' });

    if (effectiveLicense !== String(user.licenseKey || '').trim().toUpperCase()) {
        return res.status(403).json({ error: 'Licencia inválida para esta sesión' });
    }

    try {
        const ownerRows = await queryDB(`SELECT c.email FROM licencias l JOIN clientes c ON c.id = l.cliente_id WHERE UPPER(TRIM(l.license_key)) = ? LIMIT 1`, [effectiveLicense]);
        if (!ownerRows.length) return res.status(404).json({ error: 'Licencia no encontrada' });

        const ownerEmail = String(ownerRows[0].email || '').trim().toLowerCase();
        if (!effectiveEmail) effectiveEmail = ownerEmail; // último respaldo: dueño en BD
        if (!effectiveEmail) return res.status(400).json({ error: 'Faltan parámetros de validación (email)' });

        if (ownerEmail && !ownerEmail.startsWith('placeholder-') && ownerEmail !== effectiveEmail) {
            return res.status(403).json({ error: 'Correo no coincide con la licencia' });
        }

        let rowToUnlink = null;
        if (target_device_id) {
            const targetRows = await queryDB(`SELECT device_id, revoked FROM devices WHERE license_key = ? AND device_id = ? LIMIT 1`, [effectiveLicense, target_device_id]);
            if (targetRows.length) {
                rowToUnlink = targetRows[0];
            } else {
                return res.status(200).json({ 
                    ok: true, 
                    unlinked_device_id: target_device_id,
                    note: 'Dispositivo no registrado en nube'
                });
            }
        } else {
            const otherRows = await queryDB(`SELECT device_id, revoked FROM devices WHERE license_key = ? AND revoked = 0 AND device_id <> ? ORDER BY last_seen DESC LIMIT 1`, [effectiveLicense, user.deviceId]);
            if (otherRows.length) rowToUnlink = otherRows[0];
        }

        if (!rowToUnlink) {
            return res.status(200).json({ ok: true, unlinked_device_id: target_device_id || null });
        }
        if (rowToUnlink.device_id === user.deviceId && !allow_self && target_device_id !== user.deviceId) {
            return res.status(400).json({ error: 'No puedes desvincular el dispositivo actual' });
        }

        // v49: revoked_at canónico (antes solo last_seen, que se reescribía con
        // heartbeats y rompía el cálculo del cooldown).
        await queryDB(`UPDATE devices SET revoked = 1, revoked_at = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP WHERE license_key = ? AND device_id = ?`, [effectiveLicense, rowToUnlink.device_id]);

        // El estado del TERMINAL también se desvincula.
        //
        // `user_roles` guarda el rol y la configuración por caja con el email
        // `device:<id>` (y `device_cfg:<id>:<prefijo>:<nombre>`). Sin borrarlo,
        // al volver a vincular la caja la nube le devolvía el rol, el nombre y
        // el prefijo que tenía ANTES de desvincularla, y quedaba operando con
        // permisos que el administrador ya le había quitado.
        //
        // Se limita a ESTA cuenta: el mismo equipo puede aparecer en filas de
        // otra cuenta (cambio de correo) y esas no se deben tocar aquí.
        const unlinkedId = rowToUnlink.device_id;
        const roleRows = await queryDB(
            `SELECT uuid FROM user_roles
              WHERE (email = ? OR email LIKE ?)
                AND (account_key = ? OR (account_key IS NULL AND account_email = ?))`,
            [`device:${unlinkedId}`, `device_cfg:${unlinkedId}:%`, effectiveLicense, user.email]
        );
        for (const r of roleRows) {
            await queryDB(
                `UPDATE user_roles
                    SET deleted_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        version = COALESCE(version, 0) + 1
                  WHERE uuid = ?`,
                [r.uuid]
            );
            // Mismo formato que el push del cliente: el feed reparte la baja
            // igual que cualquier otro cambio.
            await queryDB(
                `INSERT INTO change_log (account_email, account_key, seq, table_name, row_uuid, op)
                 SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM change_log WHERE account_email = ?), 0) + 1,
                        'user_roles', ?, 'delete'`,
                [user.email, effectiveLicense, user.email, r.uuid]
            );
        }
        
        const policy = await getLicensePolicy(effectiveLicense);
        const [cooldown] = await queryDB(`SELECT datetime('now', '+' || ? || ' hours') AS cooldown_until`, [policy.pairCooldownDays * 24]);

        return res.status(200).json({ 
            ok: true, 
            unlinked_device_id: rowToUnlink.device_id,
            cooldown_until: cooldown?.cooldown_until || null
        });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleFcmRegister(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { device_id, fcm_token } = req.body || {};
    if (!device_id || !fcm_token) {
        return res.status(400).json({ error: 'Faltan device_id o fcm_token' });
    }
    try {
        // Ligar el token a ESTE dispositivo dentro de la licencia del token JWT
        // (evita que un dispositivo registre el token bajo otra cuenta).
        await queryDB(
            'UPDATE devices SET fcm_token = ? WHERE device_id = ? AND license_key = ?',
            [fcm_token, device_id, user.licenseKey]
        );
        return res.status(200).json({ ok: true });
    } catch (e) {
        // Columna ausente (migración pendiente): no romper el flujo del cliente.
        console.warn('[FCM Register]', e.message);
        return res.status(200).json({ ok: false, note: 'fcm_token no disponible aún' });
    }
}

async function handleRename(req, res) {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { device_id, name } = req.body || {};
    if (!device_id || !name) return res.status(400).json({ error: 'Faltan parámetros' });
    try {
        const result = await queryDB(`UPDATE devices SET name = ? WHERE device_id = ? AND license_key = ?`, [name, device_id, user.licenseKey]);
        return res.status(200).json({ ok: true, message: 'Dispositivo renombrado exitosamente' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}

// --- HANDLER TOKEN (LOGIN) ---

async function handleToken(req, res) {
    const { license_key, device_id, name, email } = req.body || {};
    if (!license_key || !device_id) return res.status(400).json({ error: 'Faltan parámetros' });
    const cleanKey = String(license_key).trim().toUpperCase();
    const reqEmail = String(email || '').trim().toLowerCase();

    let rows = await queryDB(`SELECT l.id, l.license_key, l.tipo, c.email, ds.fecha_vencimiento FROM licencias l JOIN clientes c ON l.cliente_id = c.id LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id WHERE UPPER(TRIM(l.license_key)) = ? AND l.usado = 1`, [cleanKey]);
    
    if (!rows.length && reqEmail && !reqEmail.startsWith('placeholder-')) {
        rows = await queryDB(
            `SELECT l.id, l.license_key, l.tipo, c.email, ds.fecha_vencimiento
             FROM licencias l
             JOIN clientes c ON l.cliente_id = c.id
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE LOWER(TRIM(c.email)) = ? AND l.usado = 1
             ORDER BY CASE WHEN LOWER(TRIM(l.tipo)) = 'unique' THEN '9999-12-31' ELSE COALESCE(ds.fecha_vencimiento, '1970-01-01') END DESC, l.id DESC LIMIT 1`,
            [reqEmail]
        );
    }

    if (!rows.length) return res.status(401).json({ error: 'Licencia inválida o no activa' });
    const lic = rows[0];
    const tipo = String(lic.tipo || 'unique').trim().toLowerCase();
    const expDate = parseExpirationDate(lic.fecha_vencimiento);
    const isExpired = tipo === 'saas' && expDate && expDate < new Date();

    let effectiveKey = (lic.license_key ? String(lic.license_key).trim().toUpperCase() : cleanKey);
    let effectiveTipo = tipo;
    let effectiveExpDate = expDate;
    let effectiveIsExpired = isExpired;

    // El email de la LICENCIA manda. El que trae el cliente se usa solo para
    // el alcance del token, nunca para decidir a qué cuenta pertenece la caja.
    const licenseEmail = (lic.email && !String(lic.email).startsWith('placeholder-'))
        ? String(lic.email).trim().toLowerCase()
        : ((reqEmail && !reqEmail.startsWith('placeholder-')) ? String(reqEmail).trim().toLowerCase() : '');

    if (isExpired && licenseEmail) {
        // Solo se consideran licencias de ESTA misma cuenta. Antes se buscaba
        // por el email que enviaba el cliente, así que una caja con una sesión
        // vieja (email de otra cuenta) se emparejaba contra la cuenta que
        // fuera: el dispositivo cambiaba de dueño sin que nadie lo pidiera.
        const altRows = await queryDB(
            `SELECT l.id, l.license_key, l.tipo, ds.fecha_vencimiento
             FROM licencias l
             JOIN clientes c ON l.cliente_id = c.id
             LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
             WHERE LOWER(TRIM(c.email)) = ? AND l.usado = 1
             ORDER BY CASE WHEN LOWER(TRIM(l.tipo)) = 'unique' THEN '9999-12-31' ELSE COALESCE(ds.fecha_vencimiento, '1970-01-01') END DESC, l.id DESC LIMIT 1`,
            [licenseEmail]
        );
        if (altRows.length) {
            const altExp = parseExpirationDate(altRows[0].fecha_vencimiento);
            const altTipo = String(altRows[0].tipo || 'unique').trim().toLowerCase();
            const altValid = altTipo === 'unique' || (altExp && altExp >= new Date());
            if (altValid) {
                effectiveKey = String(altRows[0].license_key).trim().toUpperCase();
                effectiveTipo = altTipo;
                effectiveExpDate = altExp;
                effectiveIsExpired = false;
            }
        }
    }
    
    // Una sola clave por cuenta.
//
// La cuenta del usuario acumula una clave por renovacion/rotacion, y el
// ambito de sincronizacion es la clave de licencia. Con varias claves vivas,
// cada caja que emparejaba con una distinta escribia en un ambito diferente:
// los datos quedaban partidos entre claves y las cajas no se veian entre si.
// Ahora el token siempre lleva la clave canonica de la cuenta (la vigente mas
// larga), de modo que da igual con que clave se haya emparejado la caja.
if (licenseEmail) {
    const canonRows = await queryDB(
        `SELECT l.license_key FROM licencias l
         JOIN clientes c ON l.cliente_id = c.id
         LEFT JOIN detalles_saas ds ON ds.licencia_id = l.id
         WHERE LOWER(TRIM(c.email)) = ? AND l.usado = 1
         ORDER BY CASE WHEN LOWER(TRIM(l.tipo)) = 'unique' THEN '9999-12-31' ELSE COALESCE(ds.fecha_vencimiento, '1970-01-01') END DESC, l.id DESC LIMIT 1`,
        [licenseEmail]
    );
    if (canonRows.length) {
        const canonKey = String(canonRows[0].license_key).trim().toUpperCase();
        if (canonKey && canonKey !== effectiveKey) {
            effectiveKey = canonKey;
        }
    }
}

// v49r2: la revocación solo vale contra la licencia EFECTIVA. La fila de
    // la licencia efectiva manda; las filas de OTRAS licencias de la MISMA
    // cuenta (mismo email: rotaciones/renovaciones) jamás bloquean — antes un
    // LIMIT 1 sin orden podía devolver una fila revocada vieja y el equipo
    // quedaba como DEVICE_REVOKED justo al renovar. Si TODA la cuenta solo
    // tiene filas revocadas, el veto del admin se respeta (401).
    // El alcance es el de la LICENCIA, no el que dice el cliente: buscar
    // revocaciones por un email ajeno hacía que la caja ignorase su propia
    // revocación o se saltara el veto de una cuenta que no es la suya.
    const scopeEmail = licenseEmail;
    let known = [];
    {
        const effRows = await queryDB(
            `SELECT revoked FROM devices WHERE device_id = ? AND license_key = ? LIMIT 1`,
            [device_id, effectiveKey]);
        if (effRows.length) known = effRows;
    }
    if (!known.length && scopeEmail) {
        const scopeRows = await queryDB(
            `SELECT revoked FROM devices WHERE device_id = ? AND license_key IN (
                 SELECT l2.license_key FROM licencias l2
                 JOIN clientes c2 ON l2.cliente_id = c2.id
                 WHERE LOWER(TRIM(c2.email)) = ?
             ) ORDER BY revoked ASC, last_seen DESC LIMIT 1`,
            [device_id, scopeEmail]);
        if (scopeRows.length && Number(scopeRows[0].revoked) === 0) {
            known = scopeRows; // adopción: hay registro ACTIVO en la misma cuenta
        } else if (scopeRows.length) {
            return res.status(401).json({ error: 'DEVICE_REVOKED' }); // todo revocado en la cuenta
        }
        // Sin filas en la cuenta: dispositivo realmente nuevo → sigue al registro.
    }
    // Number(): libsql (intMode 'string') devuelve revoked como "1" — con la
    // comparación estricta un dispositivo desvinculado seguía obteniendo token.
    if (known.length && Number(known[0].revoked) === 1) return res.status(401).json({ error: 'DEVICE_REVOKED' });

    const policy = await getLicensePolicy(effectiveKey);

    if (!known.length) {
        const cooldownHours = policy.pairCooldownDays * 24;
        const [active] = await queryDB(`SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`, [effectiveKey]);
        const activeCount = Number(active.c || 0);

        if (activeCount >= policy.maxDevicesAllowed) {
            return res.status(403).json({ error: 'Límite de dispositivos alcanzado' });
        }

        const recentRevoked = await queryDB(`SELECT datetime(COALESCE(revoked_at, last_seen), '+' || ? || ' hours') AS cooldown_until FROM devices WHERE license_key = ? AND revoked = 1 AND (julianday('now') - julianday(COALESCE(revoked_at, last_seen))) * 24 < ? ORDER BY COALESCE(revoked_at, last_seen) DESC LIMIT 1`, [cooldownHours, effectiveKey, cooldownHours]);
        if (recentRevoked.length) {
            return res.status(429).json({ 
                error: `Debes esperar ${policy.pairCooldownDays} días para vincular un nuevo dispositivo`, 
                code: 'PAIR_COOLDOWN', 
                cooldown_until: recentRevoked[0].cooldown_until 
            });
        }

        await queryDB(`INSERT INTO devices (device_id, license_key, name, last_seen, paired_at, revoked) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0) ON CONFLICT(license_key, device_id) DO UPDATE SET name = excluded.name, revoked = 0, revoked_at = NULL, last_seen = CURRENT_TIMESTAMP`, [device_id, effectiveKey, name || 'Sin nombre']);
    } else {
        // v49r2: consolidación a UNA sola fila por cuenta (rotación old->new)
        // a prueba de colisiones de PK compuesta y limitada a la MISMA
        // cuenta: un equipo usado en dos empresas distintas jamás mueve ni
        // borra filas ajenas. Gana la fila de la clave efectiva; en su
        // defecto, la heredada más reciente.
        const scope = `SELECT l2.license_key FROM licencias l2
                       JOIN clientes c2 ON l2.cliente_id = c2.id
                       WHERE LOWER(TRIM(c2.email)) = ?`;
        if (scopeEmail) {
            await queryDB(
                `DELETE FROM devices
                 WHERE device_id = ? AND (license_key = ? OR license_key IN (${scope}))
                   AND rowid NOT IN (
                       SELECT rowid FROM devices
                       WHERE device_id = ? AND (license_key = ? OR license_key IN (${scope}))
                       ORDER BY (license_key = ?) DESC, last_seen DESC LIMIT 1)`,
                [device_id, effectiveKey, scopeEmail, device_id, effectiveKey, scopeEmail, effectiveKey]);
        }
        await queryDB(
            `UPDATE devices SET license_key = ?, last_seen = CURRENT_TIMESTAMP
             WHERE device_id = ? AND (license_key = ? OR license_key IN (${scope}))`,
            [effectiveKey, device_id, effectiveKey, scopeEmail || 'none']);
    }
    const token = jwt.sign({ licenseKey: effectiveKey, deviceId: device_id, email: scopeEmail || lic.email, isExpired: effectiveIsExpired }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    return res.status(200).json({ token, expiresIn: 3600, is_expired: effectiveIsExpired, license_key: effectiveKey });
}

// --- MAIN HANDLER (ROUTER) ---

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    const { action } = req.query;
    const currentAction = action || 'token';
    try {
        switch (currentAction) {
            case 'token': return await handleToken(req, res);
            case 'link': return await handleLink(req, res);
            case 'device_status': return await handleDeviceStatus(req, res);
            case 'generate': return await handleGenerate(req, res);
            case 'confirm': return await handleConfirm(req, res);
            case 'status': return await handleStatus(req, res);
            case 'devices': return await handleDevicesList(req, res);
            case 'unlink': return await handleUnlink(req, res);
            case 'rename': return await handleRename(req, res);
            case 'fcm_register': return await handleFcmRegister(req, res);
            case 'count': 
                const userCount = await verifyToken(req);
                if (!userCount) return res.status(401).json({ error: 'No autorizado' });
                const [c] = await queryDB(`SELECT COUNT(*) as count FROM devices WHERE license_key = ? AND revoked = 0`, [userCount.licenseKey]);
                const policyCount = await getLicensePolicy(userCount.licenseKey);
                return res.status(200).json({ 
                    count: Number(c.count || 0),
                    max_devices_allowed: policyCount.maxDevicesAllowed
                });
            default:
                return res.status(404).json({ error: `Acción '${currentAction}' no soportada.` });
        }
    } catch (e) {
        console.error(`❌ [Auth Router Error] ${currentAction}:`, e.message);
        return res.status(500).json({ error: e.message });
    }
}
