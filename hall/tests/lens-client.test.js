'use strict';
/**
 * Self-running test for hall/lens-client.js against a stub HTTP server
 * standing in for the main Shaddai backend's /api/lens/clip. Run:
 *   node hall/tests/lens-client.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.SHADDAI_ADMIN_TOKEN = 'test-admin-token';

function stubLensServer(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const adminOk = req.headers['x-admin-token'] === 'test-admin-token';
      const { status, payload } = handler(parsed, req, adminOk);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

async function run() {
  // 1. Missing SHADDAI_MAIN_BACKEND_URL -> throws before any network call.
  {
    delete process.env.SHADDAI_MAIN_BACKEND_URL;
    delete require.cache[require.resolve('../lens-client')];
    const { requestClip } = require('../lens-client');
    await assert.rejects(
      () => requestClip('u1', { matchId: 'm1', pack: 'blackjack', eventType: 'bust', seatId: 's1' }, 'k1'),
      /SHADDAI_MAIN_BACKEND_URL not configured/
    );
    console.log('PASS: missing SHADDAI_MAIN_BACKEND_URL fails closed, no network call attempted');
  }

  // 2. Admin token sent correctly; happy path returns the clip payload.
  {
    const server = stubLensServer((body, req, adminOk) => {
      if (!adminOk) return { status: 401, payload: { ok: false, error: 'Unauthorized' } };
      assert.strictEqual(body.eventType, 'win');
      assert.strictEqual(body.matchId, 'm2');
      assert.strictEqual(body.idempotencyKey, 'k2');
      // Never a chat/prompt field -- lens-client's own request shape has none.
      assert.strictEqual(body.prompt, undefined);
      assert.strictEqual(body.chatText, undefined);
      return { status: 200, payload: { ok: true, jobId: 'fal-model::req123', status: 'queued', eta: 75, costUsd: 0.4, sparksCharged: 15, balance: 85, replayed: false } };
    });
    const port = await listen(server);
    process.env.SHADDAI_MAIN_BACKEND_URL = `http://127.0.0.1:${port}`;
    const { requestClip } = require('../lens-client');
    const out = await requestClip('u1', { matchId: 'm2', pack: 'blackjack', eventType: 'win', seatId: 's1' }, 'k2');
    assert.strictEqual(out.jobId, 'fal-model::req123');
    assert.strictEqual(out.sparksCharged, 15);
    server.close();
    console.log('PASS: happy path sends only the event shape and admin header, never chat/prompt text');
  }

  // 3. Server-side 402 (insufficient Sparks) surfaces as err.status=402.
  {
    const server = stubLensServer(() => ({ status: 402, payload: { ok: false, error: 'insufficient Sparks', code: 'INSUFFICIENT_FUNDS' } }));
    const port = await listen(server);
    process.env.SHADDAI_MAIN_BACKEND_URL = `http://127.0.0.1:${port}`;
    delete require.cache[require.resolve('../lens-client')];
    const { requestClip } = require('../lens-client');
    try {
      await requestClip('u1', { matchId: 'm3', pack: 'blackjack', eventType: 'bust', seatId: 's1' }, 'k3');
      assert.fail('expected requestClip to throw on 402');
    } catch (e) {
      assert.strictEqual(e.status, 402);
      assert.strictEqual(e.code, 'INSUFFICIENT_FUNDS');
    }
    server.close();
    console.log('PASS: a 402 from the main backend surfaces with err.status=402');
  }

  console.log('\n3/3 lens-client tests passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
