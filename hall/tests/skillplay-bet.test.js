'use strict';
/**
 * Self-running test for hall/skillplay-client.js + hall/packs/skillplay-bet.js
 * (Shaddai-Arcade issue #10, re-scoped to spectator/bet packs). Boots a real
 * stub HTTP server implementing shaddai-games' actual GET
 * /api/skillplay/:game/kit/:id contract, points SHADDAI_GAMES_URL at it, and
 * drives a full bet through the real Hall routes -- same style as
 * hall/tests/live-seat-kinds.test.js (real HTTP, not mocked axios).
 * Run: node hall/tests/skillplay-bet.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function run() {
  // Stub shaddai-games: NEXUS scores higher than PIKADON at 'hoops' every
  // time (fixed abilities -> deterministic average match score), so the
  // "correct" pick is always known in advance for the assertions below.
  const KITS = {
    NEXUS: [{ match: 0.9 }, { match: 0.8 }],   // avg 0.85
    PIKADON: [{ match: 0.3 }, { match: 0.2 }], // avg 0.25
  };
  const gamesApp = express();
  gamesApp.get('/api/skillplay/:game/kit/:id', (req, res) => {
    const abilities = KITS[req.params.id];
    if (!abilities) return res.status(404).json({ ok: false, error: 'unknown agent' });
    res.json({ ok: true, game: req.params.game, abilities });
  });
  const gamesServer = http.createServer(gamesApp);
  const gamesPort = await listen(gamesServer);
  process.env.SHADDAI_GAMES_URL = `http://127.0.0.1:${gamesPort}`;

  const { resolveContest } = require('../skillplay-client');

  // 1. resolveContest is deterministic and picks the higher-average side.
  {
    const out = await resolveContest('hoops', 'NEXUS', 'PIKADON');
    assert.strictEqual(out.winner, 'A'); // NEXUS is contenderA, and scores higher
    assert.strictEqual(out.scoreA, 0.85);
    assert.strictEqual(out.scoreB, 0.25);
    const out2 = await resolveContest('hoops', 'NEXUS', 'PIKADON');
    assert.deepStrictEqual(out, out2); // same inputs -> same outcome, every time
    console.log('PASS: resolveContest is deterministic and picks the higher-scoring contender');
  }

  // 2. Full bet, real HTTP, through hall/routes.js: correct pick pays out.
  {
    const hallApp = express();
    hallApp.use(require('../routes'));
    const hallServer = http.createServer(hallApp);
    const hallPort = await listen(hallServer);
    const base = `http://127.0.0.1:${hallPort}`;
    const axios = require('axios');
    async function post(path, body) { return (await axios.post(`${base}${path}`, body)).data; }

    const { seat } = await post('/api/hall/seats', { kind: 'human', display_name: 'Bettor' });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0, pack: 'hoops_bet' });
    assert.strictEqual(table.ok, true);
    assert.strictEqual(table.legal.length, 2); // A/B pick, exactly like the spec's "always <=3 buttons" rule

    const settled = await post(`/api/hall/tables/${table.matchId}/move`, { move: 'A' }); // NEXUS -- the real winner
    assert.strictEqual(settled.settlement.score, 'win');
    console.log('PASS: a correct pick on a real hoops_bet table (real HTTP, real routes.js) settles as a win');

    hallServer.close();
  }

  // 3. Wrong pick loses -- fresh table (winner is re-resolved, but the stub
  //    kits are fixed, so it's still deterministically NEXUS).
  {
    const hallApp = express();
    hallApp.use(require('../routes'));
    const hallServer = http.createServer(hallApp);
    const hallPort = await listen(hallServer);
    const base = `http://127.0.0.1:${hallPort}`;
    const axios = require('axios');
    async function post(path, body) { return (await axios.post(`${base}${path}`, body)).data; }

    const { seat } = await post('/api/hall/seats', { kind: 'human', display_name: 'Bettor2' });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0, pack: 'hoops_bet' });
    const settled = await post(`/api/hall/tables/${table.matchId}/move`, { move: 'B' }); // PIKADON -- not the winner
    assert.strictEqual(settled.settlement.score, 'lose');
    console.log('PASS: an incorrect pick settles as a loss');

    hallServer.close();
  }

  // 4. Unknown pack key is a clean 400, not a crash.
  {
    const hallApp = express();
    hallApp.use(require('../routes'));
    const hallServer = http.createServer(hallApp);
    const hallPort = await listen(hallServer);
    const base = `http://127.0.0.1:${hallPort}`;
    const axios = require('axios');
    const { seat } = (await axios.post(`${base}/api/hall/seats`, { kind: 'human', display_name: 'X' })).data;
    try {
      await axios.post(`${base}/api/hall/tables`, { seatId: seat.id, wager: 0, pack: 'not_a_real_pack' });
      assert.fail('expected a 400');
    } catch (e) {
      assert.strictEqual(e.response.status, 400);
      console.log('PASS: an unknown pack key is a clean 400');
    }
    hallServer.close();
  }

  gamesServer.close();
  console.log('\n4/4 skillplay-bet checks passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
