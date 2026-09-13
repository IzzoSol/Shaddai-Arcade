'use strict';
/**
 * Self-running test for hall/mailbox.js against a REAL stub HTTP seat
 * (docs/HALL-PHASE1-SPEC.md's own testing guidance: "mailbox round-trip
 * against a stub HTTP seat (fake 'grok' endpoint)"). Run:
 *   node hall/tests/mailbox.test.js
 */
const assert = require('assert');
const http = require('http');
const { dispatchTurn } = require('../mailbox');

const LEGAL = [{ id: 'hit', label: 'Hit' }, { id: 'stand', label: 'Stand' }];

function stubSeatServer(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const reply = handler(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

async function run() {
  // 1. A well-behaved seat replies legally on the first try -- 0 strikes.
  {
    const server = stubSeatServer((payload) => ({ match_id: payload.match_id, move: 'stand' }));
    const port = await listen(server);
    const seat = { id: 'seatA', kind: 'webhook', endpoint: `http://127.0.0.1:${port}/move` };
    const out = await dispatchTurn(seat, { match_id: 'm1', pack: 'blackjack', legal: LEGAL, state: {}, timeout_ms: 2000 }, 'stand');
    assert.strictEqual(out.moveId, 'stand');
    assert.strictEqual(out.strikes, 0);
    assert.strictEqual(out.autoResolved, false);
    server.close();
    console.log('PASS: well-behaved seat replies legally, 0 strikes');
  }

  // 2. Illegal first reply, legal second reply -- 1 strike, still honored.
  {
    let calls = 0;
    const server = stubSeatServer((payload) => {
      calls++;
      if (calls === 1) return { match_id: payload.match_id, move: 'split' }; // illegal
      return { match_id: payload.match_id, move: 'hit' };
    });
    const port = await listen(server);
    const seat = { id: 'seatB', kind: 'webhook', endpoint: `http://127.0.0.1:${port}/move` };
    const out = await dispatchTurn(seat, { match_id: 'm2', pack: 'blackjack', legal: LEGAL, state: {}, timeout_ms: 2000 }, 'stand');
    assert.strictEqual(out.moveId, 'hit');
    assert.strictEqual(out.strikes, 1);
    assert.strictEqual(out.autoResolved, false);
    server.close();
    console.log('PASS: illegal-then-legal reply is honored on the second try (1 strike)');
  }

  // 3. Two illegal replies -- auto-resolves to the pack default, never stalls.
  {
    const server = stubSeatServer((payload) => ({ match_id: payload.match_id, move: 'free text nonsense' }));
    const port = await listen(server);
    const seat = { id: 'seatC', kind: 'webhook', endpoint: `http://127.0.0.1:${port}/move` };
    const out = await dispatchTurn(seat, { match_id: 'm3', pack: 'blackjack', legal: LEGAL, state: {}, timeout_ms: 2000 }, 'stand');
    assert.strictEqual(out.moveId, 'stand'); // the pack's default
    assert.strictEqual(out.strikes, 2);
    assert.strictEqual(out.autoResolved, true);
    server.close();
    console.log('PASS: two illegal replies auto-resolve to the pack default');
  }

  // 4. A dead/unreachable endpoint (connection refused) also auto-resolves,
  //    not throws -- a broken bot must never crash the table.
  {
    const seat = { id: 'seatD', kind: 'webhook', endpoint: 'http://127.0.0.1:1/move' }; // nothing listens on port 1
    const out = await dispatchTurn(seat, { match_id: 'm4', pack: 'blackjack', legal: LEGAL, state: {}, timeout_ms: 1000 }, 'stand');
    assert.strictEqual(out.moveId, 'stand');
    assert.strictEqual(out.autoResolved, true);
    console.log('PASS: an unreachable seat endpoint auto-resolves instead of throwing');
  }

  // 5. A stale reply for a different match_id is rejected (treated illegal).
  {
    const server = stubSeatServer(() => ({ match_id: 'WRONG_MATCH', move: 'hit' }));
    const port = await listen(server);
    const seat = { id: 'seatE', kind: 'webhook', endpoint: `http://127.0.0.1:${port}/move` };
    const out = await dispatchTurn(seat, { match_id: 'm5', pack: 'blackjack', legal: LEGAL, state: {}, timeout_ms: 2000 }, 'stand');
    assert.strictEqual(out.moveId, 'stand');
    assert.strictEqual(out.autoResolved, true);
    server.close();
    console.log('PASS: a reply for the wrong match_id is rejected, not silently accepted');
  }

  console.log('\n5/5 mailbox tests passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
