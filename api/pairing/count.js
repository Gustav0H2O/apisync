import { verifyToken, queryDB } from '../_helpers.js';

const DEFAULT_MAX_DEVICES = 2;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await verifyToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  try {
    let maxDevices = DEFAULT_MAX_DEVICES;
    let pairCooldownDays = 2;
    try {
      const policyRows = await queryDB(
        `SELECT COALESCE(max_devices_allowed, ?) AS max_devices_allowed,
                COALESCE(pair_cooldown_days, 2) AS pair_cooldown_days
         FROM licencias
         WHERE license_key = ?
         LIMIT 1`,
        [DEFAULT_MAX_DEVICES, user.licenseKey]
      );
      if (policyRows.length) {
        maxDevices = Number(policyRows[0].max_devices_allowed || DEFAULT_MAX_DEVICES);
        pairCooldownDays = Number(policyRows[0].pair_cooldown_days || 2);
      }
    } catch (_) {}

    const rows = await queryDB(
      `SELECT COUNT(*) AS c FROM devices WHERE license_key = ? AND revoked = 0`,
      [user.licenseKey]
    );

    return res.status(200).json({
      count: Number(rows[0]?.c || 0),
      max_devices_allowed: maxDevices,
      cooldown_days: pairCooldownDays,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
