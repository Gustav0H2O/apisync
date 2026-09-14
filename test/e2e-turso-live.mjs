// Test E2E contra Turso Cloud Real (AWS US-EAST-1)
import jwt from 'jsonwebtoken';
import push from '../api/sync/_push.js';
import changes from '../api/sync/_changes.js';
import cursor from '../api/sync/_cursor.js';
import { getConnection } from '../api/_db.js';
import { ensureMirrorTables } from '../api/sync/_ensure.js';
import { TABLE_SPECS } from '../api/sync/_tables.js';

const TURSO_URL = 'libsql://factu-factu.aws-us-east-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk0MTQyODQsImlkIjoiMDE5ZDhhMzgtMGQwMS03ZmY4LTg4ZDQtZDc4MmMwZDNlYTU2Iiwia2lkIjoiRGtTRlRmQmFtcFFLenVXTkFtRk94MXF1ak4tMmJiLVdDZzFMMnlaTmFSVSIsInJpZCI6IjM0MzgzYzAzLTk5NWEtNGE3OC05MTliLWIzYzFhZTkyNTBlOSJ9.qrSJtS-mMDdtnvm8kCBwYYaEK_MoY1ZiQjtKmCyMQw1As3UoS7R82QWf-JTVUoVxAIhb2m8ELokqDsoph_pwCA';

process.env.JWT_SECRET = 'live-turso-test-secret';
process.env.TURSO_URL = TURSO_URL;
process.env.TURSO_TOKEN = TURSO_TOKEN;

const EMAIL = 'turso-live-fleet@factuflow.dev';
const DEVICE = 'turso-live-dev-1';
const LIC = 'lic-turso-live-1';

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
  if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); }
  console.log('✅ OK:', msg);
}

console.log('========================================================');
console.log(' Conectando con Turso Cloud:', TURSO_URL);
console.log('========================================================');

const db = getConnection();

// Limpieza de corridas anteriores de prueba
console.log('\n[1] Limpiando datos previos de prueba en Turso...');
await db.execute('DELETE FROM change_log WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM account_cursor WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM sync_invoices WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM sync_clients WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM devices WHERE device_id = ?', [DEVICE]);

// Registrar dispositivo de prueba
await db.execute('INSERT INTO devices (device_id, revoked, license_key, name) VALUES (?, 0, ?, ?)', [DEVICE, LIC, 'Fleet Live Test Device']);
console.log('Dispositivo registrado en Turso Cloud.');

// Asegurar tablas
await ensureMirrorTables(db, Object.keys(TABLE_SPECS));

// [2] Sincronizar Factura con Metadata Fiscal SENIAT en Turso Cloud
console.log('\n[2] Probando sincronizacion de factura fiscal con SENIAT Prov. 000102...');
const invoiceUuid = 'turso-inv-' + Date.now();
const docHash = 'SHA256-LIVE-TEST-HASH-' + Date.now();

let r = res();
await push(req({
  body: {
    deviceId: DEVICE,
    changes: {
      invoices: [{
        uuid: invoiceUuid,
        version: 1,
        number: 'FAC-2026-0001',
        document_type: 'factura',
        client_name: 'Inversiones Venezuela C.A.',
        client_rif: 'J-12345678-9',
        date: '2026-09-14 18:30:00',
        total: 116.0,
        subtotal: 100.0,
        tax: 16.0,
        tax_base_general: 100.0,
        tax_base_reduced: 0.0,
        tax_base_exempt: 0.0,
        control_number: '00-00000001',
        correlative_number: '00000001',
        document_hash: docHash,
        sealed_at: '2026-09-14 18:30:00',
        emission_source: 'factuflow_desktop'
      }]
    }
  }
}), r);

assert(r.statusCode === 200, 'Push de factura fiscal a Turso exitoso (200)');
assert(r.payload.applied.length === 1, 'Factura aplicada en Turso Cloud');
assert(r.payload.seq > 0, 'Cursor de cuenta incrementado en Turso: seq=' + r.payload.seq);

// [3] Validar Inmutabilidad Fiscal en Turso
console.log('\n[3] Validando inmutabilidad fiscal: rechazar modificacion de factura sellada...');
r = res();
await push(req({
  body: {
    deviceId: DEVICE,
    changes: {
      invoices: [{
        uuid: invoiceUuid,
        version: 2,
        number: 'FAC-2026-0001',
        document_type: 'factura',
        total: 200.0,
        document_hash: 'ALTERED-HASH',
        sealed_at: '2026-09-14 18:35:00'
      }]
    }
  }
}), r);

assert(r.statusCode === 200, 'Respuesta 200 recibida');
assert(r.payload.rejected.length === 1 && r.payload.rejected[0].reason === 'sealed', 'Turso Cloud rechazo la modificacion de la factura sellada');

// [4] Pull de cambios desde Turso
console.log('\n[4] Descargando change-feed desde Turso Cloud...');
r = res();
await changes(req({ method: 'GET', query: { since: '0' } }), r);
assert(r.statusCode === 200, 'Pull exitoso desde Turso');
assert(r.payload.changes.invoices && r.payload.changes.invoices.length === 1, 'Pull contiene la factura sincronizada');
const pulledInv = r.payload.changes.invoices[0];
assert(pulledInv.uuid === invoiceUuid, 'UUID coincide con el original');
assert(pulledInv.control_number === '00-00000001', 'Numero de control SENIAT preservado');
assert(pulledInv.document_hash === docHash, 'Hash criptografico SENIAT preservado');

// [5] Limpieza final en Turso
console.log('\n[5] Limpiando registros de prueba en Turso Cloud...');
await db.execute('DELETE FROM change_log WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM account_cursor WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM sync_invoices WHERE account_email = ?', [EMAIL]);
await db.execute('DELETE FROM devices WHERE device_id = ?', [DEVICE]);
console.log('Limpieza completada en Turso.');

console.log('\n========================================================');
console.log(' CONEXION Y SINCRONIZACION CON TURSO CLOUD: 100% EXITOSA');
console.log('========================================================\n');