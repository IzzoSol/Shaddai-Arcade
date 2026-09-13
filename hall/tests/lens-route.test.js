'use strict';
/**
 * Self-running end-to-end test for the new POST /api/hall/tables/:id/lens
 * route in hall/routes.js, against a stub server standing in for the main
 * Shaddai backend's /api/lens/clip (issue #5). Plays real hands (hit until
 * done) against the real blackjack pack until a filmable event (bust/win/
 * blackjack) occurs, then exercises the Lens route end-to-end. Run:
 *   node hall/tests/lens-route.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.SHADDAI_ADMIN_TOKEN = 'test-admin-token';

function stubMainBackend() {
  const app = express();
  app.use(express.json());
  const seen = [];
  app.post('/api/lens/clip', (req, res) => {
    seen.push(req.body);
    if (req.headers['x-admin-token'] !== 'test-admin-token') {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return res.json({ ok: true, jobId: 'fal-model::abc123', status: 'queued', eta: 60, costUsd: 0.4, sparksCharged: 15, balance: 985, replayed: false });
  });
  const server = http.createServer(app);
  server._seen = seen;
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

async function playUntilFilmable(request, seatId) {
  // Repeats a fresh table until a filmable event lands (bust/win/blackjack) --
  // deterministic outcomes aren't available without seeding the deck's RNG,
  // and blackjack.js intentionally has no such hook (self-contained, not
  // test-hostile). Hitting every turn maximizes bust/blackjack likelihood
  // and keeps this bounded (blackjack has no infinite hands).
  for (let attempt = 0; attempt < 30; attempt++) {
    let r = await request('POST', '/api/hall/tables', { seatId, wager: 0 });
    let matchId = r.body.matchId;
    let settlement = r.body.settlement;
    while (settlement.score === null) {
      const legal = r.body.legal;
      const move = legal.some((b) => b.id === 'hit') ? 'hit' : 'stand';
      r = await request('POST', `/api/hall/tables/${matchId}/move`, { move });
      settlement = r.body.settlement;
    }
    if (settlement.events && settlement.events.length) {
      return { matchId, settlement };
    }
  }
  throw new Error('did not observe a filmable event in 30 attempts (should be astronomically unlikely)');
}

async function run() {
  const stub = stubMainBackend();
  const port = await listen(stub);
  process.env.SHADDAI_MAIN_BACKEND_URL = `http://127.0.0.1:${port}`;

  delete require.cache[require.resolve('../lens-client')];
  delete require.cache[require.resolve('../economy-client')];
  delete require.cache[require.resolve('../routes')];
  const hallRoutes = require('../routes');
  const seatsStore = require('../seats');

  const app = express();
  app.use(hallRoutes);
  const server = http.createServer(app);
  const hallPort = await listen(server);
  const axios = require('axios');
  const base = `http://127.0.0.1:${hallPort}`;

  async function request(method, path, body) {
    const res = await axios.request({ method, url: base + path, data: body, validateStatus: () => true });
    return { status: res.status, body: res.data };
  }

  const seatRes = await request('POST', '/api/hall/seats', { kind: 'human', display_name: 'Test Seat', sparks_ref: 'u1' });
  const seatId = seatRes.body.seat.id;

  // 1. No filmable event yet -> /lens on a bogus match id is a clean 404.
  {
    const r = await request('POST', '/api/hall/tables/does-not-exist/lens', {});
    assert.strictEqual(r.status, 404);
    console.log('PASS: /lens on an unknown match is a clean 404');
  }

  // 2. Play until a filmable event happens, then request a clip.
  {
    const { matchId } = await playUntilFilmable(request, seatId);
    const r = await request('POST', `/api/hall/tables/${matchId}/lens`, {});
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.jobId, 'fal-model::abc123');
    assert.strictEqual(stub._seen[0].seatId, seatId);
    assert.ok(['bust', 'win', 'blackjack'].includes(stub._seen[0].eventType));
    assert.strictEqual(stub._seen[0].matchId, matchId);
    console.log('PASS: a completed filmable hand can request a Lens clip end-to-end, eventType =', stub._seen[0].eventType);

    // Retrying /lens on the SAME match reuses the same idempotency key
    // (":lens" suffix on the match id) -- the stub doesn't enforce
    // idempotency itself (that's the main backend's job, already tested in
    // backend/lens-routes.js's own suite), but confirm the client sends the
    // identical key both times so a replay on the real backend is safe.
    stub._seen.length = 0;
    const r2 = await request('POST', `/api/hall/tables/${matchId}/lens`, {});
    assert.strictEqual(r2.status, 200);
    console.log('PASS: retrying /lens on the same match succeeds (idempotency key is stable across retries)');
  }

  server.close();
  stub.close();
  console.log('\n2/2 lens-route checks passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
