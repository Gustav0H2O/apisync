import assert from 'assert';
import { applyCors } from '../api/_cors.js';
import tokenHandler from '../api/auth/token.js';
import syncRouterHandler from '../api/sync_router.js';
import syncHandler from '../api/sync.js';
import dbHandler from '../api/db.js';
import notificationsHandler from '../api/notifications.js';
import pushNotifyHandler from '../api/push-notify.js';
import activateHandler from '../api/license/activate.js';
import statusHandler from '../api/license/status.js';
import pinRecoveryHandler from '../api/auth/pin-recovery.js';
import pinVerifyHandler from '../api/auth/pin-verify.js';
import changesHandler from '../api/sync/_changes.js';
import cursorHandler from '../api/sync/_cursor.js';
import pushHandler from '../api/sync/_push.js';

function createMockReqRes({ method = 'GET', origin = 'http://localhost:54321', headers = {}, body = null, query = {} } = {}) {
    const req = {
        method,
        headers: {
            origin,
            'x-app-version': '47',
            'content-type': 'application/json',
            ...headers,
        },
        body,
        query,
    };

    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        ended: false,
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            this.ended = true;
            return this;
        },
        end() {
            this.ended = true;
            return this;
        },
    };

    return { req, res };
}

async function runTests() {
    console.log('--- TEST SUITE: CORS & PREFLIGHT VERIFICATION ---');

    // 1. Direct applyCors helper tests
    {
        const { req, res } = createMockReqRes({ method: 'OPTIONS', origin: 'http://localhost:52134' });
        const handled = applyCors(req, res);
        assert.strictEqual(handled, true, 'applyCors should return true for OPTIONS');
        assert.strictEqual(res.statusCode, 204, 'Preflight status must be 204');
        assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:52134');
        assert.ok(res.headers['access-control-allow-headers'].toLowerCase().includes('x-app-version'), 'Must allow x-app-version');
        assert.ok(res.headers['access-control-allow-headers'].toLowerCase().includes('authorization'), 'Must allow authorization');
        assert.ok(res.headers['access-control-allow-methods'].toUpperCase().includes('OPTIONS'), 'Must allow OPTIONS method');
        console.log('✓ applyCors helper: OPTIONS preflight sets 204 and headers correctly');
    }

    {
        const { req, res } = createMockReqRes({ method: 'GET', origin: null });
        const handled = applyCors(req, res);
        assert.strictEqual(handled, false, 'applyCors should return false for GET');
        assert.strictEqual(res.headers['access-control-allow-origin'], '*', 'Wildcard origin when no Origin header');
        console.log('✓ applyCors helper: Non-browser request defaults to wildcard origin');
    }

    // 2. Preflight on ALL serverless handlers
    const handlers = [
        { name: 'token', handler: tokenHandler },
        { name: 'sync_router', handler: syncRouterHandler },
        { name: 'sync', handler: syncHandler },
        { name: 'db', handler: dbHandler },
        { name: 'notifications', handler: notificationsHandler },
        { name: 'push_notify', handler: pushNotifyHandler },
        { name: 'license_activate', handler: activateHandler },
        { name: 'license_status', handler: statusHandler },
        { name: 'pin_recovery', handler: pinRecoveryHandler },
        { name: 'pin_verify', handler: pinVerifyHandler },
        { name: 'sync_changes', handler: changesHandler },
        { name: 'sync_cursor', handler: cursorHandler },
        { name: 'sync_push', handler: pushHandler },
    ];

    for (const { name, handler } of handlers) {
        const { req, res } = createMockReqRes({ method: 'OPTIONS', origin: 'http://localhost:53123' });
        await handler(req, res);
        assert.strictEqual(res.statusCode, 204, `Handler ${name} must return 204 on OPTIONS`);
        assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:53123', `Handler ${name} must reflect Origin`);
        assert.ok(res.headers['access-control-allow-headers'].toLowerCase().includes('x-app-version'), `Handler ${name} must allow x-app-version`);
        console.log(`✓ Handler ${name}: OPTIONS preflight handled cleanly with 204 No Content`);
    }

    // 3. Error response retains CORS headers (vital for Flutter Web error handling)
    {
        const { req, res } = createMockReqRes({ method: 'POST', origin: 'http://localhost:5000', body: {} });
        await tokenHandler(req, res);
        assert.strictEqual(res.statusCode, 400, 'Empty token request should return 400');
        assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:5000', 'Error 400 must still include CORS origin');
        console.log('✓ Token handler: Error 400 retains Access-Control-Allow-Origin');
    }

    // 4. Undefined req.body resilience in token handler
    {
        const { req, res } = createMockReqRes({ method: 'POST', origin: 'http://localhost:5000', body: undefined });
        await tokenHandler(req, res);
        assert.strictEqual(res.statusCode, 400, 'Undefined body in token handler must return 400 without crashing');
        assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:5000');
        console.log('✓ Token handler: Undefined req.body is safely handled (no 500 crash)');
    }

    console.log('\nALL CORS TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
