'use strict';
/**
 * Self-running test for hall/packs/skate.js (assert + process.exit style,
 * matching hall/tests/blackjack.test.js's convention). Run:
 *   node hall/tests/skate.test.js
 */
const assert = require('assert');
const pack = require('../packs/skate');

// 1. getButtons never returns more than 3 during setter-pick, and exactly
//    3 (this pack's spots are all 3-trick pools).
{
  const state = pack.startMatch(['alice', 'bob'], 10);
  const legal = pack.getButtons(state);
  assert.strictEqual(legal.length, 3, 'setter is offered exactly 3 tricks');
  console.log('PASS: getButtons offers exactly 3 tricks to the setter');
}

// 2. Once the setter lands, the follower is offered exactly 1 legal move --
//    "or fewer if rules force it", matching ENGINE-VISION.md.
{
  const orig = Math.random;
  Math.random = () => 0; // guarantees a land (0 < any positive land chance)
  let state = pack.startMatch(['alice', 'bob'], 10);
  const legal = pack.getButtons(state);
  state = pack.applyMove(state, 'alice', legal[0].id);
  Math.random = orig;
  assert.strictEqual(state.phase, 'follower-attempt');
  const followerLegal = pack.getButtons(state);
  assert.strictEqual(followerLegal.length, 1, 'follower gets exactly 1 legal move');
  assert.strictEqual(followerLegal[0].id, 'attempt');
  console.log('PASS: follower is offered exactly 1 legal move after a landed setter attempt');
}

// 3. applyMove rejects a move from the wrong seat.
{
  const state = pack.startMatch(['alice', 'bob'], 10);
  const legal = pack.getButtons(state);
  assert.throws(() => pack.applyMove(state, 'bob', legal[0].id), /not the setter's turn/);
  console.log('PASS: applyMove rejects a move from the wrong seat');
}

// 4. applyMove rejects an illegal move id.
{
  const state = pack.startMatch(['alice', 'bob'], 10);
  assert.throws(() => pack.applyMove(state, 'alice', 'nonsense_id'), /illegal move/);
  console.log('PASS: applyMove rejects an illegal move id');
}

// 5. Setter bail: no letter assigned, same spot re-offered to the other seat.
{
  const orig = Math.random;
  Math.random = () => 0.999; // guarantees a bail (below no trick's land chance)
  let state = pack.startMatch(['alice', 'bob'], 10);
  const spotBefore = state.spotIndex;
  const legal = pack.getButtons(state);
  state = pack.applyMove(state, 'alice', legal[0].id);
  Math.random = orig;
  assert.strictEqual(state.phase, 'setter-pick', 'still setter-pick, not follower-attempt');
  assert.strictEqual(state.spotIndex, spotBefore, 'same spot re-offered, not advanced');
  assert.strictEqual(state.setterSeat, 'bob', 'setter role passed to the other seat');
  assert.deepStrictEqual(state.letters.alice, [], 'no letter for a setter bail');
  console.log('PASS: setter bail passes the spot to the other seat with no letter');
}

// 6. Full-match reachability: a player who bails as follower on every one of
//    their ~5 opportunities (across 9 spots) actually spells out S-K-A-T-E
//    and loses -- this is the fix for the original 5-spot design, where
//    ceil(5/2)=3 made the headline win condition mathematically unreachable.
{
  const orig = Math.random;
  let toggle = 0;
  Math.random = () => { toggle++; return toggle % 2 === 1 ? 0 : 0.999; }; // setter always lands, follower always bails
  let state = pack.startMatch(['alice', 'bob'], 10);
  let guard = 0;
  while (state.phase !== 'settled' && guard < 200) {
    const legal = pack.getButtons(state);
    assert.ok(legal.length >= 1 && legal.length <= 3, 'legal buttons always between 1 and 3');
    const seatId = state.phase === 'setter-pick'
      ? state.setterSeat
      : (state.seats[0] === state.setterSeat ? state.seats[1] : state.seats[0]);
    state = pack.applyMove(state, seatId, legal[0].id);
    const out = pack.resolve(state);
    state = out.nextState;
    guard++;
  }
  Math.random = orig;
  assert.ok(guard < 200, 'match settled within the bounded spot count');
  const maxLetters = Math.max(state.letters.alice.length, state.letters.bob.length);
  assert.strictEqual(maxLetters, 5, 'spelling the full S-K-A-T-E is reachable');
  assert.strictEqual(state.result, 'win', 'seats[0] (alice) wins when bob spells SKATE');
  console.log('PASS: full S-K-A-T-E spell-out is reachable and resolves correctly');
}

// 7. resolve() is idempotent: calling it twice on the chained nextState does
//    not re-report the same event (same property blackjack.test.js checks).
{
  let state = pack.startMatch(['alice', 'bob'], 10);
  const legal = pack.getButtons(state);
  state = pack.applyMove(state, 'alice', legal[0].id);
  const first = pack.resolve(state);
  const second = pack.resolve(first.nextState);
  assert.ok(first.events.length === 1 && (first.events[0] === 'land' || first.events[0] === 'bail'));
  assert.deepStrictEqual(second.events, [], 'repeat resolve() call reports no events');
  console.log('PASS: resolve() is idempotent on an unchanged state');
}

// 8. resolve() before any move reports no score, no events.
{
  const state = pack.startMatch(['alice', 'bob'], 10);
  const out = pack.resolve(state);
  assert.strictEqual(out.score, null);
  assert.deepStrictEqual(out.events, []);
  console.log('PASS: resolve() before any move reports no score/events yet');
}

console.log('\n8/8 skate pack tests passed');
