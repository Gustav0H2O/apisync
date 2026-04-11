import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await verifyToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  try {
    const devices = await queryDB(
      `SELECT device_id, name, last_seen, COALESCE(paired_at, last_seen) AS paired_at, revoked
       FROM devices
       WHERE license_key = ?
       ORDER BY revoked ASC, paired_at ASC`,
      [user.licenseKey]
    );

    // Obtener política de licencia de una vez (Ahorramos 1 petición HTTP extra desde Flutter)
    const policyRows = await queryDB(
      `SELECT COALESCE(max_devices_allowed, 5) AS max_devices_allowed,
              COALESCE(pair_cooldown_days, 2) AS pair_cooldown_days
       FROM licencias
       WHERE license_key = ?
       LIMIT 1`,
      [user.licenseKey]
    );

    const maxDevices = policyRows.length ? Number(policyRows[0].max_devices_allowed) : 5;
    const cooldownDays = policyRows.length ? Number(policyRows[0].pair_cooldown_days) : 2;
    const activeCount = devices.filter(d => d.revoked === 0).length;

    return res.status(200).json({
      devices: devices,
      current_device_id: user.deviceId,
      max_devices_allowed: maxDevices,
      cooldown_days: cooldownDays,
      active_count: activeCount
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
