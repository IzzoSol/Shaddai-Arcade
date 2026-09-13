'use strict';
/**
 * Self-running end-to-end test for the house rake added to settleIfDone()
 * in hall/routes.js (Shaddai-Arcade issue #4). Stubs the main backend's
 * /api/economy/{spend,grant} and plays real blackjack hands until a win or
 * blackjack lands, then checks the exact Sparks math: payout = pot - rake,
 * and the rake is separately granted to the house account. Run:
 *   node hall/tests/rake.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.SHADDAI_ADMIN_TOKEN = 'test-admin-token';

function stubEconomy() {
  const app = express();
  app.use(express.json());
  const grants = []; // { userId, amount, reason, idempotencyKey }
  app.post('/api/economy/spend', (req, res) => {
    res.json({ balance: 1000, replayed: false });
  });
  app.post('/api/economy/grant', (req, res) => {
    grants.push(req.body);
    res.json({ balance: 1000, replayed: false });
  });
  const server = http.createServer(app);
  server._grants = grants;
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

async function playUntilWinOrBlackjack(request, seatId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let r = await request('POST', '/api/hall/tables', { seatId, wager: 25 });
    let matchId = r.body.matchId;
    let settlement = r.body.settlement;
    while (settlement.score === null) {
      const legal = r.body.legal;
      // Stand on the first decision as often as possible to maximize the
      // chance of a clean two-card win without busting (busts are already
      // covered by lens-route.test.js) -- still probabilistic, bounded by
      // the outer retry loop.
      const move = legal.some((b) => b.id === 'stand') ? 'stand' : legal[0].id;
      r = await request('POST', `/api/hall/tables/${matchId}/move`, { move });
      settlement = r.body.settlement;
    }
    if (settlement.score === 'win' || settlement.score === 'blackjack') {
      return { matchId, settlement };
    }
  }
  throw new Error('did not observe a win/blackjack in 60 attempts');
}

async function run() {
  const stub = stubEconomy();
  const port = await listen(stub);
  process.env.SHADDAI_MAIN_BACKEND_URL = `http://127.0.0.1:${port}`;

  delete require.cache[require.resolve('../economy-client')];
  delete require.cache[require.resolve('../routes')];
  const hallRoutes = require('../routes');

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

  const seatRes = await request('POST', '/api/hall/seats', { kind: 'human', display_name: 'Rake Test Seat', sparks_ref: 'u1' });
  const seatId = seatRes.body.seat.id;

  stub._grants.length = 0;
  const { settlement } = await playUntilWinOrBlackjack(request, seatId);

  const pot = 25 * 2; // wager 25, doubled on a win
  const expectedRake = Math.floor((pot * 400) / 10000); // 4% of 50 = 2
  const expectedPayout = pot - expectedRake; // 48

  const playerGrant = stub._grants.find((g) => g.userId === 'u1');
  const houseGrant = stub._grants.find((g) => g.userId === 'house:hall');

  assert.ok(playerGrant, 'expected a grant call to the player');
  assert.strictEqual(playerGrant.amount, expectedPayout, `expected player payout ${expectedPayout}, got ${playerGrant.amount}`);
  assert.ok(houseGrant, 'expected a separate grant call to house:hall');
  assert.strictEqual(houseGrant.amount, expectedRake, `expected house rake ${expectedRake}, got ${houseGrant.amount}`);
  assert.strictEqual(playerGrant.amount + houseGrant.amount, pot, 'payout + rake must equal the full pot -- no Sparks created or destroyed');
  console.log(`PASS: a ${settlement.score} on a 25-wager hand pays ${playerGrant.amount} to the player and ${houseGrant.amount} to house:hall (pot=${pot})`);

  server.close();
  stub.close();
  console.log('\n1/1 rake checks passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
