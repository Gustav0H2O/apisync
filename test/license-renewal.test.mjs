import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import activateHandler from '../api/license/activate.js';
import statusHandler from '../api/license/status.js';
import tokenHandler from '../api/auth/token.js';
import { getConnection } from '../api/_db.js';

const dbPath = 'file::memory:';
process.env.TURSO_URL = dbPath;
process.env.TURSO_TOKEN = '';
process.env.JWT_SECRET = 'license-renewal-test-secret';
process.env.LICENSE_SIGNING_KEY = 'license-renewal-signing-test-secret';

const db = getConnection();
const email = 'renewal@factuflow.test';
const otherEmail = 'other@factuflow.test';
const oldKey = 'SAAS-OLD-TEST';
const newKey = 'SAAS-NEW-TEST';
const revokedKey = 'SAAS-REVOKED-TEST';
const deviceIds = ['renewal-device-1', 'renewal-device-2'];

function makeRequest({ method = 'POST', body = {}, query = {}, user, headers = {} } = {}) {
    const authorization = user
        ? `Bearer ${jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' })}`
        : undefined;
    return {
        method,
        body,
        query,
        headers: {
            ...(authorization ? { authorization } : {}),
            ...headers,
        },
    };
}

function makeResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.payload = data; return this; },
        end() { return this; },
    };
}

async function invoke(handler, request) {
    const response = makeResponse();
    await handler(request, response);
    return response;
}

try {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS licencias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id INTEGER NOT NULL,
            license_key TEXT NOT NULL UNIQUE,
            tipo TEXT NOT NULL,
            usado INTEGER DEFAULT 0,
            fecha_activacion TEXT,
            max_devices_allowed INTEGER DEFAULT 2,
            pair_cooldown_days INTEGER DEFAULT 2
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS detalles_saas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            licencia_id INTEGER NOT NULL,
            fecha_vencimiento TEXT NOT NULL,
            last_check TEXT
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT NOT NULL,
            license_key TEXT NOT NULL,
            name TEXT,
            last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked INTEGER DEFAULT 0,
            paired_at TEXT DEFAULT CURRENT_TIMESTAMP,
            fcm_token TEXT,
            revoked_at TEXT,
            unlink_reason TEXT,
            PRIMARY KEY (license_key, device_id)
        )
    `);

    await db.execute('DELETE FROM devices WHERE device_id IN (?, ?, ?)', [...deviceIds, 'revoked-renewal-device']);
    await db.execute('DELETE FROM detalles_saas WHERE licencia_id IN (SELECT id FROM licencias WHERE license_key IN (?, ?, ?))', [oldKey, newKey, revokedKey]);
    await db.execute('DELETE FROM licencias WHERE license_key IN (?, ?, ?)', [oldKey, newKey, revokedKey]);
    await db.execute('DELETE FROM clientes WHERE email IN (?, ?)', [email, otherEmail]);

    const [clientResult] = await db.execute('INSERT INTO clientes (email) VALUES (?)', [email]);
    const clientId = clientResult.insertId;
    await db.execute('INSERT INTO licencias (cliente_id, license_key, tipo, usado, max_devices_allowed) VALUES (?, ?, ?, 1, 2)', [clientId, oldKey, 'SAAS']);
    const [oldLicense] = await db.execute('SELECT id FROM licencias WHERE license_key = ?', [oldKey]);
    await db.execute('INSERT INTO detalles_saas (licencia_id, fecha_vencimiento) VALUES (?, ?)', [oldLicense[0].id, '2020-01-01']);
    await db.execute('INSERT INTO devices (device_id, license_key, name, fcm_token, revoked) VALUES (?, ?, ?, ?, 0)', [deviceIds[0], oldKey, 'Primary', 'fcm-primary']);
    await db.execute('INSERT INTO devices (device_id, license_key, name, fcm_token, revoked) VALUES (?, ?, ?, ?, 0)', [deviceIds[1], oldKey, 'Secondary', 'fcm-secondary']);

    const [placeholderClientResult] = await db.execute('INSERT INTO clientes (email) VALUES (?)', [`placeholder-${email}`]);
    const placeholderClientId = placeholderClientResult.insertId;
    await db.execute('INSERT INTO licencias (cliente_id, license_key, tipo, usado, max_devices_allowed) VALUES (?, ?, ?, 0, 2)', [placeholderClientId, newKey, 'SAAS']);
    const [newLicense] = await db.execute('SELECT id FROM licencias WHERE license_key = ?', [newKey]);
    const futureDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await db.execute('INSERT INTO detalles_saas (licencia_id, fecha_vencimiento) VALUES (?, ?)', [newLicense[0].id, futureDate]);

    let response = await invoke(activateHandler, makeRequest({
        body: { license_key: newKey, email, device_id: deviceIds[0], device_name: 'Primary' },
    }));
    assert.equal(response.statusCode, 200, `Renewal activation succeeds (${JSON.stringify(response.payload)})`);
    assert.equal(response.payload.license_type, 'saas');
    const [renewedLicenseOwner] = await db.execute('SELECT cliente_id FROM licencias WHERE license_key = ?', [newKey]);
    assert.equal(Number(renewedLicenseOwner[0].cliente_id), Number(clientId), 'renewal license joins the existing account owner');

    const [migratedDevices] = await db.execute('SELECT device_id, license_key, revoked, fcm_token FROM devices WHERE device_id IN (?, ?) ORDER BY device_id', deviceIds);
    assert.equal(migratedDevices.length, 2);
    for (const device of migratedDevices) {
        assert.equal(device.license_key, newKey, 'all active account devices adopt renewed key');
        assert.equal(Number(device.revoked), 0, 'migration keeps devices active');
    }
    assert.ok(migratedDevices.some((device) => device.fcm_token === 'fcm-secondary'), 'migration preserves device metadata');

    const statusToken = jwt.sign({ licenseKey: oldKey, deviceId: deviceIds[1], email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    response = await invoke(statusHandler, makeRequest({
        method: 'GET',
        query: { email },
        headers: { authorization: `Bearer ${statusToken}` },
    }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.license_key, newKey, 'stale device token adopts renewed license');
    assert.equal(response.payload.status, 'active');
    assert.ok(response.payload.token, 'status returns replacement JWT');

    const otherClientResult = await db.execute('INSERT INTO clientes (email) VALUES (?)', [otherEmail]);
    const otherClientId = otherClientResult[0].insertId;
    await db.execute('INSERT INTO licencias (cliente_id, license_key, tipo, usado, max_devices_allowed) VALUES (?, ?, ?, 1, 2)', [otherClientId, revokedKey, 'UNIQUE']);
    await db.execute('INSERT INTO devices (device_id, license_key, revoked) VALUES (?, ?, 1)', ['revoked-renewal-device', revokedKey]);
    response = await invoke(activateHandler, makeRequest({
        body: { license_key: revokedKey, email: otherEmail, device_id: 'revoked-renewal-device' },
    }));
    assert.equal(response.statusCode, 409, 'revoked device cannot reactivate through license activation');

    const staleToken = jwt.sign({ licenseKey: oldKey, deviceId: deviceIds[1], email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    response = await invoke(statusHandler, makeRequest({
        method: 'GET',
        query: { email: otherEmail },
        headers: { authorization: `Bearer ${staleToken}` },
    }));
    assert.equal(response.statusCode, 409, 'status rejects an email that differs from the JWT');

    console.log('License renewal tests passed.');
} finally {
    await db.execute('DELETE FROM devices WHERE device_id IN (?, ?, ?)', [...deviceIds, 'revoked-renewal-device']).catch(() => {});
    await db.execute('DELETE FROM detalles_saas WHERE licencia_id IN (SELECT id FROM licencias WHERE license_key IN (?, ?, ?))', [oldKey, newKey, revokedKey]).catch(() => {});
    await db.execute('DELETE FROM licencias WHERE license_key IN (?, ?, ?)', [oldKey, newKey, revokedKey]).catch(() => {});
    await db.execute('DELETE FROM clientes WHERE email IN (?, ?, ?)', [email, otherEmail, `placeholder-${email}`]).catch(() => {});
}
