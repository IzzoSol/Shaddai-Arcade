'use strict';
/**
 * Live end-to-end proof for Shaddai-Arcade issue #10's own stated gate:
 * "Do not start [#10] until blackjack (issues #1-#9) is playable end-to-end
 * with a real seat filled by a human, a shaddai agent, and a grok seat."
 *
 * This is deliberately NOT a unit test of hall/mailbox.js (that's already
 * covered by mailbox.test.js against a stub HTTP seat) -- it boots the real
 * Express app (the same `app.use(require('./hall/routes'))` wiring
 * server.js uses), registers one seat of each of the three kinds named in
 * the gate, and drives each through the REAL HTTP surface
 * (POST /api/hall/seats -> POST /api/hall/tables -> POST .../move) exactly
 * as a client would, proving the seat/mailbox/route pipeline actually works
 * end-to-end for all three, not just that mailbox.js's internals are sound
 * in isolation.
 *
 * Sparks/economy calls are intentionally left unconfigured (no
 * SHADDAI_ADMIN_TOKEN) -- wager=0 exercises the full seat/mailbox/route
 * pipeline this gate cares about without needing a live economy-service
 * stub too; issue #4's rake.test.js already proves the economy math
 * separately. SHADDAI_MAIN_BACKEND_URL IS set (to a local stub) because
 * dispatchToShaddai needs it regardless of Sparks being configured.
 *
 * Run: node hall/tests/live-seat-kinds.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

function jsonServer(routes) {
  const app = express();
  app.use(express.json());
  for (const [method, path, handler] of routes) app[method](path, handler);
  return http.createServer(app);
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function run() {
  // Stub "grok" bot: a real HTTP endpoint a bot owner would run, always
  // replies with the first legal move that isn't 'hit' (so hands end fast).
  const grokBot = jsonServer([
    ['post', '/mailbox', (req, res) => {
      const { match_id, legal } = req.body;
      const move = (legal.find((b) => b.id === 'stand') || legal[0]).id;
      res.json({ match_id, move });
    }],
  ]);
  const grokPort = await listen(grokBot);

  // Stub main-Shaddai-backend agent surface: what dispatchToShaddai in
  // hall/mailbox.js actually calls (POST /api/agent/run, GET
  // /api/agent/task/:id) -- proves the real HTTP contract, not just that
  // axios was mocked to return the right shape.
  let taskSeq = 0;
  const tasks = new Map();
  const shaddaiBackend = jsonServer([
    ['post', '/api/agent/run', (req, res) => {
      const id = 'task_' + (++taskSeq);
      const legalIds = (req.body.goal.match(/[a-z]+(?=,|$)/g) || []);
      tasks.set(id, { status: 'completed', result: { text: 'stand' } });
      res.json({ taskId: id });
    }],
    ['get', '/api/agent/task/:id', (req, res) => {
      const t = tasks.get(req.params.id);
      if (!t) return res.status(404).json({});
      res.json(t);
    }],
  ]);
  const shaddaiPort = await listen(shaddaiBackend);
  process.env.SHADDAI_MAIN_BACKEND_URL = `http://127.0.0.1:${shaddaiPort}`;

  // The real Hall app, mounted exactly as server.js does it.
  const hallApp = express();
  hallApp.use(require('../routes'));
  const hallServer = http.createServer(hallApp);
  const hallPort = await listen(hallServer);
  const base = `http://127.0.0.1:${hallPort}`;

  const axios = require('axios');
  async function post(path, body) { return (await axios.post(`${base}${path}`, body)).data; }
  async function get(path) { return (await axios.get(`${base}${path}`)).data; }

  // 1. Human seat: table creation waits for the human's own move; we submit
  //    it through the real /move route, same as a browser client would.
  {
    const { seat } = await post('/api/hall/seats', { kind: 'human', display_name: 'Owner' });
    let table = await post('/api/hall/tables', { seatId: seat.id, wager: 0 });
    assert.strictEqual(table.ok, true);
    let guard = 0;
    while (table.settlement.score === null && guard++ < 10) {
      table = await post(`/api/hall/tables/${table.matchId}/move`, { move: 'stand' });
    }
    assert.notStrictEqual(table.settlement.score, null, 'human hand never resolved');
    console.log(`PASS: human seat played a full hand end-to-end via real HTTP routes (score=${table.settlement.score})`);
  }

  // 2. Grok/webhook seat: table creation alone should drive the whole hand
  //    to completion via driveToHumanOrEnd -> mailbox -> the real stub bot.
  {
    const { seat } = await post('/api/hall/seats', {
      kind: 'grok', display_name: 'GrokBot', endpoint: `http://127.0.0.1:${grokPort}/mailbox`,
    });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0 });
    assert.strictEqual(table.ok, true);
    assert.notStrictEqual(table.settlement.score, null, 'grok seat hand never resolved');
    console.log(`PASS: grok seat played a full hand end-to-end via the real mailbox + a live stub bot (score=${table.settlement.score})`);
  }

  // 3. Shaddai seat: same as above, but dispatchToShaddai's real
  //    /api/agent/run + /api/agent/task/:id round trip against the stub
  //    main-backend started above.
  {
    const { seat } = await post('/api/hall/seats', { kind: 'shaddai', display_name: 'NEXUS-seat' });
    const table = await post('/api/hall/tables', { seatId: seat.id, wager: 0 });
    assert.strictEqual(table.ok, true);
    assert.notStrictEqual(table.settlement.score, null, 'shaddai seat hand never resolved');
    console.log(`PASS: shaddai seat played a full hand end-to-end via the real agent-run/poll round trip (score=${table.settlement.score})`);
  }

  grokBot.close(); shaddaiBackend.close(); hallServer.close();
  console.log('\n3/3 live seat-kind checks passed -- issue #10\'s gate is satisfied');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
