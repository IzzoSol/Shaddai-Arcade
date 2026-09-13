'use strict';
/**
 * Self-running test for hall/packs/blackjack.js (assert + process.exit style,
 * no test framework in this repo -- matches the main Shaddai backend's own
 * lib/*.test.js convention). Run: node hall/tests/blackjack.test.js
 */
const assert = require('assert');
const pack = require('../packs/blackjack');

function forceHand(state, cards) {
  // Test helper: force the player's hand to a known value by splicing the
  // deck so the next pop()s are controlled -- deck is drawn from the end.
  state.deck.push(...cards.slice().reverse());
  return state;
}

// 1. getButtons never returns more than 3, and only during player-turn.
{
  const state = pack.startMatch(['seatA'], 25);
  const legal = pack.getButtons(state);
  assert.ok(legal.length <= 3, 'never more than 3 buttons');
  assert.ok(legal.some((b) => b.id === 'hit'));
  assert.ok(legal.some((b) => b.id === 'stand'));
  console.log('PASS: getButtons returns <=3 legal moves including hit/stand');
}

// 2. Double is only legal on the first decision (2 cards).
{
  let state = pack.startMatch(['seatA'], 25);
  assert.ok(pack.getButtons(state).some((b) => b.id === 'double'), 'double legal on first decision');
  state = pack.applyMove(state, 'seatA', 'hit');
  const legalAfterHit = pack.getButtons(state);
  assert.ok(!legalAfterHit.some((b) => b.id === 'double'), 'double illegal after hitting once');
  console.log('PASS: double only legal on first decision');
}

// 3. applyMove rejects an illegal move id.
{
  const state = pack.startMatch(['seatA'], 25);
  assert.throws(() => pack.applyMove(state, 'seatA', 'split'), /illegal move/);
  console.log('PASS: applyMove rejects an illegal move id');
}

// 4. applyMove rejects a move from the wrong seat.
{
  const state = pack.startMatch(['seatA', 'seatB'], 25);
  assert.throws(() => pack.applyMove(state, 'seatB', 'hit'), /not this seat's turn/);
  console.log('PASS: applyMove rejects a move from the wrong seat');
}

// 5. Bust: player hits into >21, resolve reports 'bust' with a bust event.
{
  let state = pack.startMatch(['seatA'], 25);
  state.player.cards = [{ r: '10', s: 'S', v: 10 }, { r: '9', s: 'H', v: 9 }]; // 19
  forceHand(state, [{ r: 'K', s: 'D', v: 10 }]); // next hit busts to 29
  state = pack.applyMove(state, 'seatA', 'hit');
  const out = pack.resolve(state);
  assert.strictEqual(out.score, 'bust');
  assert.ok(out.events.includes('bust'));
  console.log('PASS: bust resolves correctly with a bust event');
}

// 6. Stand: dealer plays out to 17+, a clear player win resolves 'win'.
{
  let state = pack.startMatch(['seatA'], 25);
  state.player.cards = [{ r: '10', s: 'S', v: 10 }, { r: '9', s: 'H', v: 9 }]; // 19
  state.dealer = [{ r: '10', s: 'D', v: 10 }, { r: '6', s: 'C', v: 6 }]; // 16, must hit
  forceHand(state, [{ r: '2', s: 'H', v: 2 }]); // dealer draws to 18... still need player > dealer
  state.dealer = [{ r: '10', s: 'D', v: 10 }, { r: '5', s: 'C', v: 5 }]; // 15
  forceHand(state, [{ r: '3', s: 'H', v: 3 }]); // dealer hits to 18 < player's 19
  state = pack.applyMove(state, 'seatA', 'stand');
  const out = pack.resolve(state);
  assert.strictEqual(out.score, 'win');
  assert.ok(out.events.includes('win'));
  console.log('PASS: a clear player win resolves correctly with a win event');
}

// 7. resolve() before the hand is over reports no score, no events.
{
  const state = pack.startMatch(['seatA'], 25);
  const out = pack.resolve(state);
  assert.strictEqual(out.score, null);
  assert.deepStrictEqual(out.events, []);
  console.log('PASS: resolve() mid-hand reports no score/events yet');
}

// 8. resolve() is idempotent once settled (does not re-deal/re-score).
{
  let state = pack.startMatch(['seatA'], 25);
  state = pack.applyMove(state, 'seatA', 'stand');
  const first = pack.resolve(state);
  const second = pack.resolve(first.nextState);
  assert.strictEqual(second.score, first.score);
  assert.deepStrictEqual(second.events, []);
  console.log('PASS: resolve() is idempotent once settled');
}

console.log('\n8/8 blackjack pack tests passed');
