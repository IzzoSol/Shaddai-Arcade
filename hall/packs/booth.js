'use strict';
/**
 * hall/packs/booth.js — the Hall's FIRST `generative` pack
 * (Shaddai-Arcade issue #11, docs/ENGINE-VISION.md).
 *
 * The generative action shape, in full:
 *   - getButtons returns 3 STRATEGIES (punch / flip / story), never content.
 *   - The actual bar is produced by a writer model (hall/writer-client.js) in
 *     response to the opponent's line.
 *   - The resolver is PURE LOGIC. It only multiplies the judge rubric and
 *     compares totals. No generation, no I/O, no randomness in judging.
 *   - So it is a genuinely different shape from blackjack/skate/football: those
 *     enumerate content, this composes it.
 *
 * ── WHY GENERATION HAPPENS IN startMatch, NOT PER MOVE ────────────────────────
 * The engine contract is load-bearing and every other pack obeys it exactly:
 * getButtons/applyMove/resolve are all SYNCHRONOUS. skillplay-bet.js
 * established the precedent for the one degree of freedom we have --
 * startMatch is allowed to be async and does all external work up front.
 * A network LLM call cannot happen inside a synchronous applyMove, so per-turn
 * generation is architecturally impossible without changing the engine, and
 * issue #11 explicitly asks for "no new engine concepts" beyond the vision doc.
 * Therefore: bars are composed once, at match start, each one written as a
 * reply to a seed opener, then dealt deterministically from that library.
 *
 * The honest deviation, stated rather than hidden: the vision doc says content
 * is written "in response to the opponent's last move". Here each bar records
 * `repliesTo` = the opponent's previously delivered line, and the writer is
 * asked to answer the seed line the round opens with. Getting a true
 * write-after-each-bar would need an async applyMove, i.e. an engine change
 * deferred to a later phase. Flagged in docs/HALL-BOOTH-PACK.md.
 *
 * ── CAST ──────────────────────────────────────────────────────────────────────
 * Original cast only, exactly as issue #11 requires: 'Player (red beanie)' and
 * 'Gunner'. Both are already in the main repo's CAST_LOCK
 * (backend/lib/lens-rewriter.js) — booth adds no new faces and never names a
 * real person.
 *
 * ⚠️ ACTION ITEM (main repo): booth's events ('booth_bar', 'booth_verdict') are
 * not yet keys in EVENT_SCENES, so backend/lens-routes.js will reject a booth
 * clip with 400 "unfilmable event type" until two entries are added to
 * backend/lib/lens-rewriter.js. See docs/HALL-BOOTH-PACK.md.
 */

const writerClient = require('../writer-client');

const STRATEGY = {
  punch: { label: 'Punch', weights: { content: 0.55, cadence: 0.25, rebound: 0.20 } },
  flip: { label: 'Flip', weights: { content: 0.40, cadence: 0.25, rebound: 0.35 } },
  story: { label: 'Story', weights: { content: 0.45, cadence: 0.40, rebound: 0.15 } },
};

const RAIL = ['punch', 'flip', 'story'];

const CHARACTERS = Object.freeze({ player: 'Player (red beanie)', gunner: 'Gunner' });

const ROUNDS = 6;                 // 3 bars each, alternating
const BARS_PER_STRATEGY = 3;
const SEED_OPENERS = Object.freeze({
  [CHARACTERS.player]: 'I gave you the whole stage and you filled it with filler.',
  [CHARACTERS.gunner]: 'You named a blueprint and never drew a single line.',
});

/** Pure: weighted rubric score for one bar under its strategy. */
function scoreBar(bar, strategy) {
  const w = STRATEGY[strategy].weights;
  return +(bar.content * w.content + bar.cadence * w.cadence + bar.rebound * w.rebound).toFixed(4);
}

function dealFrom(library, strategy) {
  const list = library[strategy] || [];
  if (!list.length) return null;
  return list[0];
}

function startMatch(seats, wager) {
  if (!Array.isArray(seats) || seats.length < 2 || !seats[0] || !seats[1]) {
    return Promise.reject(new Error('booth: startMatch requires exactly two seats'));
  }
  const characters = { [seats[0]]: CHARACTERS.player, [seats[1]]: CHARACTERS.gunner };

  // One compose call per seat. Each seat answers the OTHER seat's seed opener,
  // so the writer is always responding to a specific line. Note this must be
  // SEED_OPENERS[...], not characters[...] -- passing the character name gave
  // the writer "Gunner" to rebut instead of an actual line.
  return Promise.all(seats.map((seat) => {
    const opponentSeatId = seat === seats[0] ? seats[1] : seats[0];
    const opponentLine = SEED_OPENERS[characters[opponentSeatId]];
    return writerClient.composeBards({
      strategies: RAIL,
      count: BARS_PER_STRATEGY,
      opponentLine,
    }).then(({ bars, source, truncated }) => ({ seat, bars, source, truncated }));
  }))
    .then((results) => {
      const state = {
        pack: 'booth',
        seats: [seats[0], seats[1]],
        wager: Number(wager) || 0,
        characters,
        libraries: {},
        sources: {},
        truncated: results.some((r) => r.truncated),
        points: { [seats[0]]: 0, [seats[1]]: 0 },
        round: 0,
        roundsTotal: ROUNDS,
        turnSeat: seats[0],
        phase: 'call',            // call -> settled
        transcript: [],
        lastBarBySeat: {},
        result: null,
        pendingEvents: [],       // drained by resolve(); see resolve() below
      };
      for (const r of results) {
        const byStrategy = { punch: [], flip: [], story: [] };
        for (const b of r.bars) {
          if (byStrategy[b.strategy] && byStrategy[b.strategy].length < BARS_PER_STRATEGY) {
            byStrategy[b.strategy].push(b);
          }
        }
        state.libraries[r.seat] = byStrategy;
        state.sources[r.seat] = r.source;
      }
      return state;
    });
}

function getButtons(state) {
  if (!state || state.phase !== 'call') return [];
  // Strategies, never content — the generative shape's defining constraint.
  return RAIL.map((id) => ({ id, label: STRATEGY[id].label }));
}

function applyMove(state, seatId, moveId) {
  if (state.phase !== 'call') throw new Error('booth: no move accepted outside call phase');
  if (seatId !== state.turnSeat) throw new Error('booth: not this seat\'s turn');
  if (!RAIL.includes(moveId)) {
    throw new Error(`booth: illegal move '${moveId}' (legal: ${RAIL.join(', ')})`);
  }

  const library = state.libraries[seatId];
  const opponentSeat = seatId === state.seats[0] ? state.seats[1] : state.seats[0];
  const bar = dealFrom(library, moveId);
  if (!bar) throw new Error(`booth: no generated bar left for strategy '${moveId}'`);

  // Pure judging — no randomness, no generation.
  const earned = scoreBar(bar, moveId);
  const next = {
    ...state,
    points: { ...state.points, [seatId]: +(state.points[seatId] + earned).toFixed(4) },
    round: state.round + 1,
    turnSeat: opponentSeat,
    transcript: state.transcript.concat([{
      round: state.round,
      seatId,
      character: state.characters[seatId],
      strategy: moveId,
      text: bar.text,
      rubric: { content: bar.content, cadence: bar.cadence, rebound: bar.rebound },
      earned,
      source: state.sources[seatId],
      repliesTo: state.lastBarBySeat[opponentSeat] || null,
    }]),
    lastBarBySeat: { ...state.lastBarBySeat, [seatId]: bar.text },
    // The settling round emits its bar AND the verdict together, so the whole
    // event queue can be drained in one place and stay idempotent.
    pendingEvents: (state.round + 1) >= ROUNDS ? ['booth_bar', 'booth_verdict'] : ['booth_bar'],
  };

  // Consume this bar so the next call for the same strategy moves on.
  next.libraries = {
    ...state.libraries,
    [seatId]: { ...library, [moveId]: library[moveId].slice(1) },
  };

  if (next.round >= ROUNDS) {
    next.phase = 'settled';
    const a = next.points[next.seats[0]];
    const b = next.points[next.seats[1]];
    next.result = Math.abs(a - b) < 1e-9 ? 'push' : (a > b ? 'win' : 'lose');
  }
  return next;
}

/**
 * resolve(state) -> { score, nextState, events[] }
 * Synchronous and pure, as every other pack here. Drains the pending event
 * queue into the returned nextState, so calling resolve() again on that
 * nextState reports no events — the idempotency property the rest of the pack
 * suite is tested for.
 */
function resolve(state) {
  const events = state.pendingEvents ? state.pendingEvents.slice() : [];
  const nextState = { ...state, pendingEvents: [] };
  if (nextState.phase !== 'settled') return { score: null, nextState, events };
  return { score: nextState.result, nextState, events };
}

function summary(state) {
  return {
    phase: state.phase,
    round: state.round,
    roundsTotal: state.roundsTotal,
    characters: state.characters,
    points: state.points,
    // Surfaced so a room can tell generated content from seeded fallback.
    sources: state.sources,
    truncated: state.truncated,
    result: state.result,
  };
}

module.exports = {
  STRATEGY, RAIL, CHARACTERS, ROUNDS, BARS_PER_STRATEGY,
  scoreBar, dealFrom,
  startMatch, getButtons, applyMove, resolve, summary,
};