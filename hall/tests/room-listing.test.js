'use strict';
/**
 * Self-running test for GET /api/hall/tables (room listing) and
 * GET /api/hall/tables/:id/lens/:jobId (clip status proxy), added for the
 * mobile Hall (Shaddai-Arcade #6 follow-up). Real HTTP against the real
 * routes.js app, same style as the other hall/tests/*.test.js files.
 * Run: node hall/tests/room-listing.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function run() {
  const hallApp = express();
  hallApp.use(require('../routes'));
  const hallServer = http.createServer(hallApp);
  const hallPort = await listen(hallServer);
  const base = `http://127.0.0.1:${hallPort}`;
  const axios = require('axios');
  async function post(path, body) { return (await axios.post(`${base}${path}`, body)).data; }
  async function get(path) { return (await axios.get(`${base}${path}`)).data; }

  // 1. Empty room -- no matches created yet on this fresh app instance.
  {
    const { tables } = await get('/api/hall/tables');
    assert.strictEqual(Array.isArray(tables), true);
    console.log('PASS: GET /api/hall/tables returns an array with no matches yet');
  }

  // 2. A live blackjack table shows up with a spectator-safe summary --
  //    playerTotal/dealerUpcard present, no deck, no dealer hole card, no
  //    seat/wager/deck leak beyond what summary() explicitly allows.
  {
    const { seat } = await post('/api/hall/seats', { kind: 'human', display_name: 'RoomTest' });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0 });
    const { tables } = await get('/api/hall/tables');
    const row = tables.find((t) => t.matchId === table.matchId);
    assert.ok(row, 'new match should appear in the room listing');
    assert.strictEqual(row.seatKind, 'human');
    assert.strictEqual(row.seatName, 'RoomTest');
    assert.strictEqual(typeof row.playerTotal, 'number');
    assert.strictEqual(row.deck, undefined, 'deck must never leak into the public listing');
    if (row.phase !== 'settled') {
      assert.strictEqual(row.dealerTotal, undefined, 'dealer hole card must not leak before it is revealed');
    }
    console.log('PASS: a live blackjack table appears in the room listing with a spectator-safe summary');
  }

  // 3. A hoops_bet table never leaks winner/scores before it settles.
  {
    const gamesApp = express();
    gamesApp.get('/api/skillplay/:game/kit/:id', (req, res) => {
      res.json({ ok: true, abilities: [{ match: req.params.id === 'NEXUS' ? 0.9 : 0.1 }] });
    });
    const gamesServer = http.createServer(gamesApp);
    const gamesPort = await listen(gamesServer);
    process.env.SHADDAI_GAMES_URL = `http://127.0.0.1:${gamesPort}`;

    const { seat } = await post('/api/hall/seats', { kind: 'human', display_name: 'BetTest' });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0, pack: 'hoops_bet' });
    const { tables } = await get('/api/hall/tables');
    const row = tables.find((t) => t.matchId === table.matchId);
    assert.ok(row);
    assert.strictEqual(row.winner, undefined, 'winner must not leak before the bettor has even picked');
    assert.strictEqual(row.scores, undefined, 'scores must not leak before settlement');
    assert.deepStrictEqual(row.contenders, { A: 'NEXUS', B: 'PIKADON' });
    console.log('PASS: an unsettled hoops_bet table never leaks winner/scores in the room listing');
    gamesServer.close();
  }

  // 4. Clip status proxy: Sparks not configured in this test process -> 503,
  //    not a crash (mirrors the existing /lens POST route's own posture).
  {
    try {
      await get('/api/hall/tables/whatever/lens/job_123');
      assert.fail('expected a 503');
    } catch (e) {
      assert.strictEqual(e.response.status, 503);
      console.log('PASS: clip status proxy fails closed (503) when Sparks/Lens is not configured');
    }
  }

  hallServer.close();
  console.log('\n4/4 room-listing checks passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
