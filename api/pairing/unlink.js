import { verifyToken, queryDB } from '../_helpers.js';

const PAIR_COOLDOWN_HOURS = 48;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const { license_key, email, target_device_id } = req.body || {};
  if (!license_key || !email) {
    return res.status(400).json({ error: 'Faltan parámetros de validación' });
  }
  if (license_key !== user.licenseKey) {
    return res.status(403).json({ error: 'Licencia inválida para esta sesión' });
  }

  try {
    console.log(`🗑️ [Unlink] Attempting to unlink for License: ${license_key}, Email: ${email}, Target: ${target_device_id}`);
    const ownerRows = await queryDB(
      `SELECT c.email
       FROM licencias l
       JOIN clientes c ON c.id = l.cliente_id
       WHERE l.license_key = ?
       LIMIT 1`,
      [license_key]
    );
    if (!ownerRows.length) {
      console.warn(`❌ [Unlink] License not found: ${license_key}`);
      return res.status(404).json({ error: 'Licencia no encontrada' });
    }
    const ownerEmail = String(ownerRows[0].email || '').trim().toLowerCase();
    const inputEmail = String(email).trim().toLowerCase();
    
    if (ownerEmail !== inputEmail) {
      console.warn(`❌ [Unlink] Email mismatch. Owner: ${ownerEmail}, Input: ${inputEmail}`);
      return res.status(403).json({ error: 'Correo no coincide con la licencia' });
    }

    let rowToUnlink = null;
    if (target_device_id) {
      const targetRows = await queryDB(
        `SELECT device_id
         FROM devices
         WHERE license_key = ? AND device_id = ? AND revoked = 0
         LIMIT 1`,
        [license_key, target_device_id]
      );
      if (targetRows.length) rowToUnlink = targetRows[0];
    } else {
      const otherRows = await queryDB(
        `SELECT device_id
         FROM devices
         WHERE license_key = ? AND revoked = 0 AND device_id <> ?
         ORDER BY last_seen DESC
         LIMIT 1`,
        [license_key, user.deviceId]
      );
      if (otherRows.length) rowToUnlink = otherRows[0];
    }

    if (!rowToUnlink) {
      return res.status(404).json({ error: 'No se encontró otro dispositivo activo para desvincular' });
    }
    if (rowToUnlink.device_id === user.deviceId) {
      return res.status(400).json({ error: 'No puedes desvincular el dispositivo actual' });
    }

    await queryDB(
      `UPDATE devices
       SET revoked = 1, last_seen = NOW()
       WHERE license_key = ? AND device_id = ?`,
      [license_key, rowToUnlink.device_id]
    );

    const cooldownRows = await queryDB(
      `SELECT DATE_ADD(NOW(), INTERVAL ? HOUR) AS cooldown_until`,
      [PAIR_COOLDOWN_HOURS]
    );

    return res.status(200).json({
      ok: true,
      unlinked_device_id: rowToUnlink.device_id,
      cooldown_until: cooldownRows[0]?.cooldown_until || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
