import { verifyToken, queryDB } from '../_helpers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  try {
    const rows = await queryDB(
      `SELECT device_id, name, last_seen, COALESCE(paired_at, last_seen) AS paired_at, revoked
       FROM devices
       WHERE license_key = ?
       ORDER BY revoked ASC, paired_at ASC`,
      [user.licenseKey]
    );

    return res.status(200).json({
      devices: rows,
      current_device_id: user.deviceId,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
