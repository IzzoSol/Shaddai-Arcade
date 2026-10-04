'use strict';
/**
 * Self-running test for hall/packs/football.js + hall/packs/soccer.js
 * (Shaddai-Arcade issue #13). assert + console.log style, matching
 * hall/tests/skate.test.js's convention. Run:
 *   node hall/tests/playcall.test.js
 *
 * Both packs share one shape (offense calls / defense answers), so the shared
 * engine invariants are asserted once against football and spot-checked on
 * soccer rather than duplicated in full.
 */
const assert = require('assert');
const football = require('../packs/football');
const soccer = require('../packs/soccer');

// ── ENGINE CONTRACT (shared) ──────────────────────────────────────────────────

// 1. Both packs honour startMatch/seats.
{
  const fb = football.startMatch(['alice', 'bob'], 25);
  const sc = soccer.startMatch(['alice', 'bob'], 25);
  assert.deepStrictEqual(fb.seats, ['alice', 'bob']);
  assert.deepStrictEqual(sc.seats, ['alice', 'bob']);
  assert.strictEqual(fb.wager, 25);
  assert.strictEqual(sc.wager, 25);
  assert.throws(() => football.startMatch(['alice'], 10), /exactly two seats/);
  assert.throws(() => soccer.startMatch(['alice'], 10), /exactly two seats/);
  console.log('PASS: both packs require exactly two seats and carry the wager through');
}

// 2. The 3-button ceiling from ENGINE-VISION.md -- never more than 3, in any phase.
{
  let fb = football.startMatch(['alice', 'bob'], 10);
  for (let i = 0; i < 12; i++) {
    if (fb.phase === 'settled') break;
    const legal = fb ? football.getButtons(fb) : [];
    assert.ok(legal.length <= 3, 'football never offers more than 3 buttons');
    assert.strictEqual(legal.length, 3, 'football offers exactly 3 while in a call phase');
    const seat = fb.phase === 'offense-call' ? fb.offenseSeat : fb.defenseSeat;
    fb = football.applyMove(fb, seat, legal[0].id);
  }
  console.log('PASS: football stays within the 3-button ceiling for a whole match');
}

// 3. Football offence/defence rails are distinct and each is exactly 3.
{
  const fb = football.startMatch(['alice', 'bob'], 10);
  const off = football.getButtons(fb).map((b) => b.id);
  assert.deepStrictEqual(off, football.OFFENSE_RAIL);
  assert.strictEqual(off.length, 3);
  const def = football.getButtons(football.applyMove(fb, fb.offenseSeat, off[0])).map((b) => b.id);
  assert.deepStrictEqual(def, football.DEFENSE_RAIL);
  assert.strictEqual(def.length, 3);
  assert.ok(!off.some((id) => def.includes(id)), 'offence and defence rails do not overlap');
  console.log('PASS: football exposes 3 offence plays then 3 defence calls');
}

// 4. Wrong-seat and illegal-move rejection, both packs.
{
  const fb = football.startMatch(['alice', 'bob'], 10);
  assert.throws(() => football.applyMove(fb, 'bob', football.OFFENSE_RAIL[0]), /not the offense's turn/);
  assert.throws(() => football.applyMove(fb, 'alice', 'quarterback_snipe'), /illegal move/);

  const sc = soccer.startMatch(['alice', 'bob'], 10);
  assert.throws(() => soccer.applyMove(sc, 'bob', soccer.ATTACK_RAIL[0]), /not the attacking seat's turn/);
  assert.throws(() => soccer.applyMove(sc, 'alice', 'bicycle_kick'), /illegal move/);
  console.log('PASS: both packs reject wrong-seat and illegal moves');
}

// 5. Football reuses playbook.js's real risk/reward/pressure/weakness values.
{
  // Copied verbatim from the main repo's backend/sports/football/playbook.js.
  assert.strictEqual(football.OFFENSE.short_pass.risk, 0.25);
  assert.strictEqual(football.OFFENSE.short_pass.reward, 0.55);
  assert.strictEqual(football.OFFENSE.play_action.risk, 0.45);
  assert.strictEqual(football.OFFENSE.play_action.reward, 0.75);
  assert.strictEqual(football.DEFENSE.blitz.pressure, 0.85);
  assert.strictEqual(football.DEFENSE.blitz.weakness, 'quick_pass');
  console.log("PASS: football's numbers match playbook.js's OFFENSE_PLAYS/DEFENSE_CALLS verbatim");
}

// 6. The counter matrix is driven by playbook's own `weakness` field: short_pass
//    beats blitz (blitz's stated weakness) better than it beats man.
{
  const vsWeakness = football.successChance('short_pass', 'blitz');
  const vsStrong = football.successChance('short_pass', 'man');
  assert.ok(vsWeakness > vsStrong,
    'short_pass is more likely to work against blitz than man (blitz.weakness === quick_pass)');
  // Blitz is the high-pressure call, so it must beat zone for a deep attempt.
  assert.ok(football.successChance('deep_pass', 'zone') > football.successChance('deep_pass', 'blitz'),
    'high-pressure blitz suppresses deep_pass more than zone does');
  console.log('PASS: football counter matrix follows playbook.js weakness/pressure fields');
}

// 7. Football terminates and settles, and resolve() is idempotent.
{
  const orig = Math.random;
  Math.random = () => 0.9; // forces failures -> turnovers -> drives run out
  let fb = football.startMatch(['alice', 'bob'], 10);
  let guard = 0;
  while (fb.phase !== 'settled' && guard++ < 200) {
    const legal = football.getButtons(fb);
    if (!legal.length) break;
    const seat = fb.phase === 'offense-call' ? fb.offenseSeat : fb.defenseSeat;
    fb = football.applyMove(fb, seat, legal[0].id);
  }
  Math.random = orig;
  assert.strictEqual(fb.phase, 'settled', 'football always terminates (worst-case roll)');
  assert.ok(['win', 'lose', 'push'].includes(fb.result));
  const first = football.resolve(fb);
  const second = football.resolve(first.nextState);
  assert.deepStrictEqual(second.events, [], 'repeat resolve() reports no events');
  console.log('PASS: football terminates under the worst roll and resolve() is idempotent');
}

// 8. Soccer obeys the vision doc's "shot or tackle only" event vocabulary.
{
  const orig = Math.random;
  const seen = new Set();
  for (const roll of [0.0, 0.5, 0.8, 0.99]) {
    Math.random = () => roll;
    let sc = soccer.startMatch(['alice', 'bob'], 10);
    let guard = 0;
    while (sc.phase !== 'settled' && guard++ < 50) {
      const legal = soccer.getButtons(sc);
      if (!legal.length) break;
      const seat = sc.phase === 'attack-call' ? sc.attackSeat : sc.defendSeat;
      sc = soccer.applyMove(sc, seat, legal[0].id);
      for (const e of soccer.resolve(sc).events) seen.add(e);
    }
  }
  Math.random = orig;
  assert.ok(seen.size > 0, 'soccer emitted at least one event');
  for (const e of seen) {
    assert.ok(e === 'shot' || e === 'tackle', `unexpected soccer event '${e}' (vision doc allows only shot|tackle)`);
  }
  console.log(`PASS: soccer emits only 'shot'/'tackle' events (saw: ${[...seen].join(', ')})`);
}

// 9. Soccer's rail is exactly the vision doc's 3 buttons, and it terminates.
{
  assert.deepStrictEqual(soccer.ATTACK_RAIL, ['shoot', 'square', 'skill_move']);
  const sc = soccer.startMatch(['alice', 'bob'], 10);
  assert.deepStrictEqual(soccer.getButtons(sc).map((b) => b.id), ['shoot', 'square', 'skill_move']);
  assert.ok(soccer.shotChance('shoot', 'press') < soccer.shotChance('shoot', 'contain'),
    'press closes hardest (closing 0.85), so shoot scores less against it than against contain');
  assert.ok(soccer.shotChance('square', 'press') > soccer.shotChance('square', 'tackle'),
    "square exploits press's 'width' weakness, while tackle's weakness is 'power'");
  assert.ok(soccer.shotChance('skill_move', 'contain') > soccer.shotChance('skill_move', 'tackle'),
    "skill_move exploits contain's 'dribble' weakness");

  const orig = Math.random;
  Math.random = () => 0.99; // always fails and always loses the ball
  let s2 = soccer.startMatch(['alice', 'bob'], 10);
  let guard = 0;
  while (s2.phase !== 'settled' && guard++ < 50) {
    const legal = soccer.getButtons(s2);
    if (!legal.length) break;
    const seat = s2.phase === 'attack-call' ? s2.attackSeat : s2.defendSeat;
    s2 = soccer.applyMove(s2, seat, legal[0].id);
  }
  Math.random = orig;
  assert.strictEqual(s2.phase, 'settled', 'soccer always terminates');
  assert.strictEqual(s2.attackIndex, soccer.ATTACKS_PER_MATCH);
  console.log('PASS: soccer rail matches the vision doc and the match always terminates');
}

console.log('\n9/9 play-call pack tests passed');