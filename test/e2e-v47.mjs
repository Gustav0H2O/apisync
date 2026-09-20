// Harness E2E local del protocolo v47 (sin tocar producción).
// Usa libsql en archivo local + JWT de prueba. Cero secretos reales.
import jwt from 'jsonwebtoken';
import push from '../api/sync/_push.js';
import changes from '../api/sync/_changes.js';
import { getConnection } from '../api/_db.js';
import { ensureMirrorTables } from '../api/sync/_ensure.js';
import { TABLE_SPECS } from '../api/sync/_tables.js';

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'e2e-test-secret';

const EMAIL = 'test@e2e.dev';
const DEVICE = 'dev-e2e-1';
const LIC = 'lic-e2e-1';

function req({ method = 'POST', body = {}, query = {}, headers = {} }) {
  const token = jwt.sign(
    { email: EMAIL, deviceId: DEVICE, licenseKey: LIC },
    process.env.JWT_SECRET,
  );
  return {
    method, body, query,
    headers: { authorization: `Bearer ${token}`, ...headers },
  };
}
function res() {
  const r = { statusCode: 0, payload: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  r.end = () => r;
  return r;
}
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok:', msg);
}

const db = getConnection();
await ensureMirrorTables(db, Object.keys(TABLE_SPECS));
await db.execute('CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, revoked INTEGER, license_key TEXT)', []);

await db.execute('DELETE FROM change_log WHERE account_email IN (?, ?)', [EMAIL, 'otro@e2e.dev']);
await db.execute('DELETE FROM account_cursor WHERE account_email IN (?, ?)', [EMAIL, 'otro@e2e.dev']);
await db.execute("DELETE FROM sync_clients WHERE uuid IN ('c-1', 'c-x')", []);
await db.execute("DELETE FROM sync_invoices WHERE uuid IN ('inv-1', 'inv-2')", []);
await db.execute('INSERT OR REPLACE INTO devices(device_id, revoked, license_key) VALUES (?, 0, ?)', [DEVICE, LIC]);

// 1. Push inserta + cursor + change_log (auto-ensure crea sync_clients).
let r = res();
await push(req({ body: { deviceId: DEVICE, changes: { clients: [{ uuid: 'c-1', version: 1, name: 'ACME', phone: '0414', rif: 'J-1', address: 'x', discount_rate: 0 }] } } }), r);
assert(r.statusCode === 200, `push 200 (got ${r.statusCode} ${JSON.stringify(r.payload)?.slice(0, 120)})`);
assert(r.payload.seq === 1, `seq=1 (got ${r.payload.seq})`);
assert(r.payload.applied.length === 1 && r.payload.applied[0].version === 1, 'applied v1');
const [cur] = await db.execute('SELECT seq FROM account_cursor WHERE account_email = ?', [EMAIL]);
assert(Number(cur[0].seq) === 1, 'cursor=1 en BD');

// 2. Push idempotente (misma versión) no duplica ni falla.
r = res();
await push(req({ body: { deviceId: DEVICE, changes: { clients: [{ uuid: 'c-1', version: 1, name: 'ACME' }] } } }), r);
assert(r.statusCode === 200 && r.payload.applied.length === 1, 'retry idempotente applied');
assert(r.payload.conflicts.length === 1, 'retry reporta conflicts (realineación)');
const [cnt] = await db.execute('SELECT COUNT(*) AS c FROM sync_clients WHERE uuid = ?', ['c-1']);
assert(Number(cnt[0].c) === 1, 'sin duplicados');

// 3. Pull changes since=0 trae la fila; nextSeq avanza.
r = res();
await changes(req({ method: 'GET', query: { since: '0' } }), r);
assert(r.statusCode === 200, 'changes 200');
assert(r.payload.nextSeq === 1, `nextSeq=1 (got ${r.payload.nextSeq})`);
assert(r.payload.changes.clients?.length === 1, 'pull trae 1 cliente');
assert(r.payload.changes.clients[0].name === 'ACME', 'pull trae datos');

// 4. Versión vieja pierde (conflicto): servidor gana.
r = res();
await push(req({ body: { deviceId: DEVICE, changes: { clients: [{ uuid: 'c-1', version: 5, name: 'NUEVO' }] } } }), r);
assert(r.payload.applied.length === 1, 'v5 aplicada');
r = res();
await push(req({ body: { deviceId: DEVICE, changes: { clients: [{ uuid: 'c-1', version: 3, name: 'VIEJO' }] } } }), r);
assert(r.payload.applied.length === 0 && r.payload.conflicts.length === 1, 'v3 en conflicto');
const [row] = await db.execute('SELECT name, version FROM sync_clients WHERE uuid = ?', ['c-1']);
assert(row[0].name === 'NUEVO' && Number(row[0].version) === 5, 'servidor conserva v5');

// 5. Inmutabilidad SENIAT: factura sellada rechaza cambios con otro hash.
await db.execute(
  `INSERT INTO sync_invoices(uuid, account_email, version, updated_at, number, document_type, sealed_at, document_hash, total)
   VALUES ('inv-1', ?, 2, '2026-01-01', '7', 'factura', '2026-01-02', 'HASH-A', 100)`, [EMAIL]);
r = res();
await push(req({ body: { deviceId: DEVICE, changes: { invoices: [{ uuid: 'inv-1', version: 3, number: '7', document_type: 'factura', sealed_at: '2026-01-03', document_hash: 'HASH-B', total: 999 }] } } }), r);
assert(r.payload.rejected.length === 1 && r.payload.rejected[0].reason === 'sealed', 'sellada rechazada');
const [inv] = await db.execute('SELECT total FROM sync_invoices WHERE uuid = ?', ['inv-1']);
assert(Number(inv[0].total) === 100, 'sellada intacta');

// 6. Clave de negocio: mismo number+type offline fusiona (alias, no duplicado).
r = res();
await push(req({ body: { deviceId: DEVICE, changes: { invoices: [{ uuid: 'inv-2', version: 1, number: '7', document_type: 'factura', total: 50 }] } } }), r);
assert(r.payload.aliases.length === 1 && r.payload.aliases[0].canonicalUuid === 'inv-1', 'fusión por clave de negocio');

// 7. Cuenta ajena jamás se toca.
await db.execute('INSERT INTO sync_clients(uuid, account_email, version, updated_at, name) VALUES (?, ?, 1, ?, ?)', ['c-x', 'otro@e2e.dev', '2026-01-01', 'OTRO']);
const tokenOtro = jwt.sign({ email: 'otro@e2e.dev', deviceId: DEVICE, licenseKey: LIC }, process.env.JWT_SECRET);
r = res();
await push({ method: 'POST', body: { deviceId: DEVICE, changes: { clients: [{ uuid: 'c-1', version: 9, name: 'HACK' }] } }, query: {}, headers: { authorization: `Bearer ${tokenOtro}` } }, r);
const [hack] = await db.execute('SELECT name FROM sync_clients WHERE uuid = ?', ['c-1']);
// c-1 es de test@e2e.dev; el push de otro@ debe rechazar por forbidden.
assert(r.payload.rejected.length === 1 && r.payload.rejected[0].reason === 'forbidden', 'aislamiento por cuenta');
assert(hack[0].name === 'NUEVO', 'fila ajena intacta');

console.log('\nE2E v47: TODO OK');
