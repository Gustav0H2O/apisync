// Test de Sincronizacion en Tiempo Real y Esquema Dinamico (Escalabilidad Horizontal y Vertical)
import jwt from 'jsonwebtoken';
import push from '../api/sync/_push.js';
import changes from '../api/sync/_changes.js';
import cursor from '../api/sync/_cursor.js';
import { getConnection } from '../api/_db.js';
import { ensureMirrorTables, autoMigrateColumns, getTableColumns } from '../api/sync/_ensure.js';
import { TABLE_SPECS } from '../api/sync/_tables.js';

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'dynamic-test-secret';
if (!process.env.TURSO_URL) process.env.TURSO_URL = 'file:test_dyn.db';

const EMAIL = 'commander@factuflow.dev';
const DEVICE = 'commander-device-1';
const LIC = 'lic-fleet-commander';

function req({ method = 'POST', body = {}, query = {}, headers = {} }) {
  const token = jwt.sign(
    { email: EMAIL, deviceId: DEVICE, licenseKey: LIC },
    process.env.JWT_SECRET,
  );
  return {
    method, body, query,
    headers: { authorization: 'Bearer ' + token, ...headers },
  };
}

function res() {
  const r = { statusCode: 200, payload: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  r.end = () => r;
  return r;
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('OK:', msg);
}

console.log('--- Iniciando Test de Tiempo Real y Escalabilidad Dinamica ---');
const db = getConnection();
await ensureMirrorTables(db, Object.keys(TABLE_SPECS));
await db.execute('CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, revoked INTEGER, license_key TEXT)', []);
await db.execute('INSERT OR REPLACE INTO devices(device_id, revoked, license_key) VALUES (?, 0, ?)', [DEVICE, LIC]);

// Limpieza inicial
await db.execute('DELETE FROM change_log WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM account_cursor WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM sync_clients WHERE account_email = ?', [EMAIL]);

// 1. Verificacion de adicion dinamica de columnas (Escalabilidad Horizontal y Vertical)
console.log('\n[1] Probando migracion dinamica de columnas sin downtime...');
const dynamicColName = 'loyalty_tier_' + Math.floor(Math.random() * 10000);
let r = res();
await push(req({
  body: {
    deviceId: DEVICE,
    changes: {
      clients: [{
        uuid: 'dyn-client-1',
        version: 1,
        name: 'Cliente VIP',
        phone: '0412-1234567',
        rif: 'J-99887766-0',
        address: 'Caracas',
        discount_rate: 15.5,
        [dynamicColName]: 'PLATINUM_MEMBER'
      }]
    }
  }
}), r);

assert(r.statusCode === 200, 'Push con columna dinamica aceptado con codigo 200');
assert(r.payload.applied.length === 1, 'Fila con columna dinamica fue aplicada');

// Comprobar que la columna existe en la base fisica
const cols = await getTableColumns(db, 'clients');
assert(cols.has(dynamicColName), 'Columna dinamica ' + dynamicColName + ' fue creada fisicamente en sync_clients');

// 2. Comprobar que pull (_changes.js) devuelve la columna dinamica
console.log('\n[2] Verificando que pull trae la columna dinamica agregada...');
r = res();
await changes(req({ method: 'GET', query: { since: '0' } }), r);
assert(r.statusCode === 200, 'Pull exitoso');
assert(r.payload.changes.clients && r.payload.changes.clients.length === 1, 'Pull trae el cliente insertado');
assert(r.payload.changes.clients[0][dynamicColName] === 'PLATINUM_MEMBER', 'Pull devuelve el valor de la columna dinamica');

// 3. Verificacion de Long-Polling Cursor en tiempo real
console.log('\n[3] Probando reactividad de cursor con Long-Polling (?wait)...');
const currentSeq = r.payload.nextSeq;

// Consulta con since = currentSeq y wait = 1 s (debe expirar sin cambios)
const t0 = Date.now();
r = res();
await cursor(req({ method: 'GET', query: { since: String(currentSeq), wait: '1' } }), r);
const elapsedMs = Date.now() - t0;
assert(r.statusCode === 200, 'Cursor long-poll respondio 200');
assert(r.payload.seq === currentSeq, 'Seq sin cambios');
assert(elapsedMs >= 900, 'Long-poll respeto el tiempo de espera (' + elapsedMs + 'ms)');

// 4. Concurrencia reactiva: un long-poll en espera es despertado por un push inmediato
console.log('\n[4] Probando despertar sub-segundo con Long-Polling concurrente...');
let pollResolved = false;
let pollResult = null;
const pollPromise = (async () => {
  const pollRes = res();
  await cursor(req({ method: 'GET', query: { since: String(currentSeq), wait: '4' } }), pollRes);
  pollResolved = true;
  pollResult = pollRes;
})();

// Esperar 400ms y luego hacer un push desde otro dispositivo simulado
await new Promise(r => setTimeout(r, 400));
assert(!pollResolved, 'Long poll sigue en espera antes del push');

const pushRes = res();
await push(req({
  body: {
    deviceId: DEVICE,
    changes: {
      clients: [{
        uuid: 'dyn-client-2',
        version: 1,
        name: 'Cliente 2 Concurrente',
        phone: '0414-0000000'
      }]
    }
  }
}), pushRes);

assert(pushRes.statusCode === 200, 'Push concurrente 200');

// Esperar que el long-poll se despierte
const tWakeStart = Date.now();
await pollPromise;
const wakeElapsed = Date.now() - tWakeStart;

assert(pollResult.payload.seq > currentSeq, 'Long-poll fue despertado por el nuevo seq (' + pollResult.payload.seq + ' > ' + currentSeq + ')');
console.log('Long-poll despertado reactivamente en ' + wakeElapsed + 'ms');

console.log('\n======================================================');
console.log('TODOS LOS TESTS DE ESCALABILIDAD Y TIEMPO REAL: OK');
console.log('======================================================\n');