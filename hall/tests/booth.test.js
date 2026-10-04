'use strict';
/**
 * Self-running test for hall/packs/booth.js + hall/writer-client.js
 * (Shaddai-Arcade issue #11 -- the Hall's first `generative` pack).
 * assert + console.log style, matching hall/tests/skate.test.js's convention.
 * Run:
 *   node hall/tests/booth.test.js
 *
 * Runs with NO writer configured, so every bar comes from the seeded fallback.
 * That is deliberate: the generative contract (strategies as buttons, content
 * generated, pure judging) must hold identically whether the content came
 * from the model or the seed, or the pack is only correct when the network is
 * up.
 */
const assert = require('assert');
const booth = require('../packs/booth');
const writer = require('../writer-client');

// ── WRITER-CLIENT DEFENSIVE PARSING ───────────────────────────────────────────

// 1. parseCompletion accepts a clean JSON object and drops bad rows.
{
  const good = writer.parseCompletion(JSON.stringify({
    bars: [
      { strategy: 'punch', text: 'that bar was filler', content: 8, cadence: 7, rebound: 6 },
      { strategy: 'flip', text: 'you said no shortcuts', content: 7, cadence: 6, rebound: 9 },
    ],
  }));
  assert.strictEqual(good.length, 2);
  assert.strictEqual(good[0].strategy, 'punch');
  assert.strictEqual(good[1].rebound, 9);

  // Unknown strategy / non-string text / non-object rows are all discarded.
  const mixed = writer.parseCompletion(JSON.stringify({
    bars: [
      { strategy: 'freestyle', text: 'nope', content: 10, cadence: 10, rebound: 10 },
      { strategy: 'punch', text: 42, content: 10, cadence: 10, rebound: 10 },
      'garbage',
      null,
      { strategy: 'story', text: 'kept', content: 'x', cadence: null, rebound: -5 },
    ],
  }));
  assert.strictEqual(mixed.length, 1, 'only the one well-formed row survives');
  assert.strictEqual(mixed[0].strategy, 'story');
  assert.strictEqual(mixed[0].content, 0, 'non-numeric rubric coerces to 0, not NaN');
  assert.strictEqual(mixed[0].rebound, 0, 'negative rubric clamps to 0');
  console.log('PASS: parseCompletion keeps only well-formed rows and clamps the rubric to 0..10');
}

// 2. parseCompletion survives every way an LLM misbehaves.
{
  for (const junk of ['', null, undefined, 'not json at all', '{oops', '[]', '{"bars":"nope"}', 42]) {
    assert.deepStrictEqual(writer.parseCompletion(junk), [], `tolerates ${JSON.stringify(junk)}`);
  }
  // Fenced code blocks are common and legitimate -- unwrap them.
  const fenced = writer.parseCompletion(
    '```json\n{"bars":[{"strategy":"punch","text":"fenced bar","content":6,"cadence":6,"rebound":6}]}\n```');
  assert.strictEqual(fenced.length, 1);
  assert.strictEqual(fenced[0].text, 'fenced bar');
  console.log('PASS: parseCompletion tolerates prose/garbage and unwraps fenced JSON');
}

// 3. Generated text is sanitized and length-capped.
{
  assert.strictEqual(writer.sanitizeBar('a\u0000b\u001fc'), 'a b c', 'control chars stripped');
  assert.strictEqual(writer.sanitizeBar('   '), null);
  assert.strictEqual(writer.sanitizeBar(123), null, 'non-strings rejected');
  const long = writer.sanitizeBar('x'.repeat(writer.MAX_BAR_CHARS * 2));
  assert.ok(long.length <= writer.MAX_BAR_CHARS, 'bar capped at MAX_BAR_CHARS');
  console.log('PASS: sanitizeBar strips control chars, rejects junk, caps length');
}

// 4. The prompt asks for exactly the vision doc's strategies and the rubric.
{
  const p = writer.buildPrompt(['punch', 'flip', 'story'], 3, 'you said no shortcuts');
  for (const k of ['punch', 'flip', 'story']) assert.ok(p.includes(k), `prompt names ${k}`);
  for (const k of ['content', 'cadence', 'rebound']) assert.ok(p.includes(k), `prompt names rubric axis ${k}`);
  assert.ok(p.includes('no slurs') || p.includes('No slurs'), 'prompt carries the no-slurs constraint');
  assert.ok(p.includes('you said no shortcuts'), 'prompt quotes the opponent line');
  console.log('PASS: writer prompt names all 3 strategies, the 3 rubric axes, and the opponent line');
}

// ── GENERATIVE PACK CONTRACT ──────────────────────────────────────────────────

// booth.startMatch is async (the precedent skillplay-bet.js set for doing
// external work up front), so these are inside an async main.
async function main() {
  // 5. The defining generative invariant: getButtons returns STRATEGIES, never content.
  {
    const st = await booth.startMatch(['alice', 'bob'], 50);
    const legal = booth.getButtons(st);
    assert.strictEqual(legal.length, 3, 'exactly 3 buttons');
    assert.deepStrictEqual(legal.map((b) => b.id), ['punch', 'flip', 'story']);
    for (const b of legal) {
      assert.ok(typeof b.label === 'string' && b.label.length < 40,
        'a button is a short strategy label, not a generated bar');
    }
    console.log('PASS: booth buttons are strategies (punch/flip/story), not content');
  }

  // 6. Cast is original-only and matches the main repo's CAST_LOCK entries.
  {
    const st = await booth.startMatch(['alice', 'bob'], 50);
    assert.strictEqual(st.characters['alice'], 'Player (red beanie)');
    assert.strictEqual(st.characters['bob'], 'Gunner');
    console.log("PASS: booth cast is 'Player (red beanie)' vs 'Gunner' (original cast only)");
  }

  // 7. Unconfigured writer -> seeded bars, and the source is disclosed, not hidden.
  {
    const st = await booth.startMatch(['alice', 'bob'], 50);
    assert.strictEqual(st.sources['alice'], 'seeded', 'no writer configured => source disclosed as seeded');
    for (const s of booth.RAIL) {
      assert.ok(st.libraries['alice'][s].length > 0, `seeded library covers strategy ${s}`);
    }
    console.log('PASS: with no writer configured the pack falls back to seeded bars and says so');
  }

  // 8. Judging is PURE: scoreBar is a pure function of bar + strategy.
  {
    const bar = { content: 10, cadence: 5, rebound: 0 };
    // punch = .55/.25/.20 -> 5.5 + 1.25 + 0 = 6.75
    assert.strictEqual(booth.scoreBar(bar, 'punch'), 6.75);
    const same = booth.scoreBar({ ...bar }, 'punch');
    assert.strictEqual(same, 6.75, 'same input, same score, every time -- no randomness in judging');
    // A rebound-only bar should favour flip over punch.
    const r = { content: 0, cadence: 0, rebound: 10 };
    assert.ok(booth.scoreBar(r, 'flip') > booth.scoreBar(r, 'punch'));
    console.log('PASS: scoreBar is pure and rewards each strategy on its own axis');
  }

  // 9. A full match runs to settlement, alternates turns, and records repliesTo.
  {
    const st0 = await booth.startMatch(['alice', 'bob'], 50);
    let st = st0;
    let guard = 0;
    while (st.phase !== 'settled' && guard++ < 50) {
      const seat = st.turnSeat;
      const legal = booth.getButtons(st);
      assert.strictEqual(legal.length, 3);
      st = booth.applyMove(st, seat, legal[guard % 3].id);
      // resolve must stay synchronous and side-effect free
      const out = booth.resolve(st);
      assert.strictEqual(out.score, st.phase === 'settled' ? st.result : null);
    }
    assert.strictEqual(st.phase, 'settled', 'booth always terminates');
    assert.strictEqual(st.transcript.length, booth.ROUNDS);
    assert.ok(['win', 'lose', 'push'].includes(st.result));
    assert.strictEqual(st.transcript[0].repliesTo, null, 'first bar replies to the seed, not a prior bar');
    assert.ok(st.transcript[1].repliesTo, 'later bars record the opponent line they answered');
    console.log('PASS: a full booth match alternates seats, terminates, and logs repliesTo');
  }

  // 10. Wrong-seat and illegal-strategy rejection.
  {
    const st = await booth.startMatch(['alice', 'bob'], 50);
    assert.throws(() => booth.applyMove(st, 'bob', 'punch'), /not this seat's turn/);
    assert.throws(() => booth.applyMove(st, 'alice', 'diss_track'), /illegal move/);
    console.log('PASS: booth rejects wrong-seat moves and non-rail strategies');
  }

  // 11. resolve() event queue is drained exactly once.
  {
    let st = await booth.startMatch(['alice', 'bob'], 50);
    st = booth.applyMove(st, 'alice', 'punch');
    const first = booth.resolve(st);
    assert.deepStrictEqual(first.events, ['booth_bar']);
    const second = booth.resolve(first.nextState);
    assert.deepStrictEqual(second.events, [], 'repeat resolve() reports no events');
    console.log('PASS: booth resolve() drains its event queue exactly once');
  }

  // 12. The settling round emits bar + verdict together, then settles the score.
  {
    let st = await booth.startMatch(['alice', 'bob'], 50);
    let out2 = null;
    let i = 0;
    while (st.phase !== 'settled' && i++ < 50) {
      st = booth.applyMove(st, st.turnSeat, booth.RAIL[i % 3]);
      out2 = booth.resolve(st);
    }
    assert.deepStrictEqual(out2.events, ['booth_bar', 'booth_verdict']);
    assert.ok(['win', 'lose', 'push'].includes(out2.score));
    const again = booth.resolve(out2.nextState);
    assert.deepStrictEqual(again.events, [], 'verdict is not re-emitted');
    console.log('PASS: the settling round emits booth_bar + booth_verdict, then stops');
  }

  // 13. summary() never leaks the transcript or bar text to a spectator.
  {
    const st = await booth.startMatch(['alice', 'bob'], 50);
    const s = booth.summary(st);
    assert.strictEqual(s.transcript, undefined, 'summary omits transcript');
    assert.ok(s.sources, 'summary discloses content source');
    assert.strictEqual(s.result, null, 'no result leaked mid-match');
    console.log('PASS: booth summary() hides bars/result but discloses content source');
  }

  // 14. startMatch hands the writer the opponent's opener LINE, not their name.
  // Regression: it used to pass `characters[...]` -- the literal strings
  // "Gunner" / "Player (red beanie)" -- as opponentLine, so the writer was
  // asked to rebut a name rather than an actual bar, while the docs and the
  // code comment both claimed it was answering a specific line.
  {
    const real = writer.composeBards;
    const seen = [];
    writer.composeBards = (opts) => {
      seen.push(opts);
      return Promise.resolve({
        source: 'test',
        truncated: false,
        bars: [
          { strategy: 'punch', text: 'a', content: 5, cadence: 5, rebound: 5 },
          { strategy: 'flip', text: 'b', content: 5, cadence: 5, rebound: 5 },
          { strategy: 'story', text: 'c', content: 5, cadence: 5, rebound: 5 },
        ],
      });
    };
    try {
      await booth.startMatch(['carol', 'dave'], 10);

      assert.strictEqual(seen.length, 2, 'one compose call per seat');
      const NAMES = ['Player (red beanie)', 'Gunner'];
      for (const opts of seen) {
        assert.strictEqual(typeof opts.opponentLine, 'string');
        assert.ok(opts.opponentLine.length > 20,
          `opponentLine must be a real sentence, got ${JSON.stringify(opts.opponentLine)}`);
        assert.ok(!NAMES.includes(opts.opponentLine),
          `opponentLine must not be a bare character name, got ${JSON.stringify(opts.opponentLine)}`);
      }
      // Each seat answers the OTHER seat's opener, so the two lines differ.
      assert.notStrictEqual(seen[0].opponentLine, seen[1].opponentLine,
        'each seat must answer a different opponent line');
      console.log('PASS: startMatch gives the writer the opponent\'s opener line, not their name');
    } finally {
      writer.composeBards = real;
    }
  }

  console.log('\n14/14 booth generative-pack tests passed');
}

main().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });