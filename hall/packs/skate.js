'use strict';
/**
 * hall/packs/skate.js — the classic game of S-K-A-T-E, wrapped in the
 * ENGINE-VISION.md contract exactly like blackjack.js:
 *   startMatch(seats, wager)      -> initial state
 *   getButtons(state) -> legal[]  -> ALWAYS <= 3, { id, label }
 *   applyMove(state, seatId, moveId) -> new state
 *   resolve(state)                -> { score, nextState, events[] }
 *
 * Action shape: fixed (docs/ENGINE-VISION.md's roster table: "3 tricks
 * generated per spot", filmable event "the land or the bail"). The tricks
 * offered per spot are drawn from a fixed pool per spot -- no LLM involved
 * in the resolver, matching "fixed" per the engine's own axis-1 definition.
 * LENS turns the declared 'land'/'bail' events into a real clip in the main
 * backend; this pack only ever emits those two event names.
 *
 * Rules (standard game of SKATE, 1-on-1):
 *   - 5 real spots, played in order. One seat "sets" each spot: it's offered
 *     3 candidate tricks and picks one to attempt.
 *   - Setter LANDS -> the other seat must attempt the SAME trick (1 legal
 *     button, not 3 -- "or fewer if rules force it" per the engine doc).
 *     - Follower lands too: no letter, move to the next spot, roles swap.
 *     - Follower bails: follower takes the next letter in S-K-A-T-E.
 *   - Setter BAILS -> no letter for anyone; the other seat becomes setter
 *     for the SAME spot with a fresh 3-trick offer.
 *   - First seat to spell all of S-K-A-T-E loses. score is 'win'/'lose'/
 *     'push' from seats[0]'s perspective, same vocabulary as blackjack.js
 *     and hall/packs/skillplay-bet.js, so hall/routes.js needs no
 *     pack-specific settlement branching.
 */

const LETTERS = ['S', 'K', 'A', 'T', 'E'];

// 9 spots, not 5 -- setter/follower roles strictly ping-pong every spot
// (see applyMove), so across N spots one player is follower (the only role
// that can take a letter) at most ceil(N/2) times. With 5 spots that caps
// out at 3, making the headline "spell all of S-K-A-T-E" win condition
// mathematically unreachable. 9 spots makes ceil(9/2)=5 reachable while
// keeping the match bounded (max 9 setter attempts + up to 9 follower
// attempts = 18 resolver calls) -- important for the Hall's per-turn
// timeout mailbox, unlike real unbounded SKATE.
const SPOTS = [
  { id: 'ledge', label: 'The Ledge', tricks: ['Boardslide', '5-0 Grind', 'Nosegrind'] },
  { id: 'stairs', label: 'The Big Stairs', tricks: ['Ollie', 'Kickflip', 'Heelflip'] },
  { id: 'rail', label: 'The Handrail', tricks: ['Boardslide', 'Feeble Grind', '50-50'] },
  { id: 'manny', label: 'The Manual Pad', tricks: ['Manual', 'Nose Manual', 'Shove-it Manual'] },
  { id: 'bank', label: 'The Bank to Wall', tricks: ['Ollie', '360 Flip', 'Wallride'] },
  { id: 'gap', label: 'The Gap', tricks: ['Ollie', 'Kickflip', '360 Flip'] },
  { id: 'curb', label: 'The Curb Cut', tricks: ['50-50', 'Boardslide', 'Nosegrind'] },
  { id: 'quarterpipe', label: 'The Quarterpipe', tricks: ['Wallride', 'Heelflip', 'Ollie'] },
  { id: 'flatbar', label: 'The Flatbar', tricks: ['Feeble Grind', '5-0 Grind', 'Boardslide'] },
];

// Land probability per trick name -- flat difficulty table, not per-spot, so
// a trick means the same thing everywhere it's offered. Tuned so a run of 5
// spots is winnable but not trivial; ZEROX/TURTLE can retune without
// touching the resolver shape.
const TRICK_DIFFICULTY = {
  'Ollie': 0.85, 'Manual': 0.85, 'Nose Manual': 0.7, 'Shove-it Manual': 0.7,
  'Kickflip': 0.6, 'Heelflip': 0.6, 'Wallride': 0.6, '50-50': 0.65,
  'Boardslide': 0.5, '5-0 Grind': 0.5, 'Nosegrind': 0.45, 'Feeble Grind': 0.45,
  '360 Flip': 0.35,
};

function landChance(trick) { return TRICK_DIFFICULTY[trick] || 0.5; }

/**
 * startMatch(seats, wager) -> state
 *   seats: [seatIdA, seatIdB] -- exactly 2, this pack has no solo/crowd mode
 *   wager: integer Sparks buy-in per seat (ledger handled by the Hall, same
 *          separation of concerns as blackjack.js)
 */
function startMatch(seats, wager) {
  if (!Array.isArray(seats) || seats.length < 2 || !seats[0] || !seats[1]) {
    throw new Error('skate: startMatch requires exactly two seats');
  }
  return {
    pack: 'skate',
    seats: [seats[0], seats[1]],
    wager: Number(wager) || 0,
    spotIndex: 0,
    setterSeat: seats[0],
    letters: { [seats[0]]: [], [seats[1]]: [] },
    phase: 'setter-pick',       // setter-pick -> follower-attempt -> settled
    offer: null,                // the 3 tricks currently offered to the setter
    pendingTrick: null,         // the trick the follower must now match
    result: null,               // 'win' | 'lose' | 'push', from seats[0]'s perspective
    log: [],                    // [{spot, seat, trick, landed}] -- spectator/summary feed
    pendingEvent: null,         // 'land' | 'bail' from the move just applied -- consumed by
                                 // the next resolve() call so repeat calls are idempotent
                                 // (same property blackjack.js's resolve() has: calling it
                                 // twice on an unchanged state must not re-emit an event).
  };
}

function offerFor(state) {
  const spot = SPOTS[state.spotIndex];
  return spot.tricks.map((t, i) => ({ id: 'trick_' + i, label: t, trick: t }));
}

/** getButtons(state) -> legal[] -- ALWAYS exactly 3, or exactly 1 when the
 *  follower must match a specific already-landed trick. */
function getButtons(state) {
  if (!state || state.phase === 'settled') return [];
  if (state.phase === 'setter-pick') {
    const offer = state.offer || offerFor(state);
    return offer.map((o) => ({ id: o.id, label: o.label }));
  }
  if (state.phase === 'follower-attempt') {
    return [{ id: 'attempt', label: 'Attempt: ' + state.pendingTrick }];
  }
  return [];
}

function otherSeat(state, seatId) {
  return state.seats[0] === seatId ? state.seats[1] : state.seats[0];
}

/**
 * applyMove(state, seatId, moveId) -> new state. Rolls the land/bail outcome
 * immediately (this pack has no multi-step trick animation to model --
 * "the land or the bail" IS the whole event, per the roster table).
 */
function applyMove(state, seatId, moveId) {
  if (state.phase === 'settled') throw new Error('skate: match already settled');

  const legal = getButtons(state);
  if (!legal.some((b) => b.id === moveId)) {
    throw new Error(`skate: illegal move '${moveId}' (legal: ${legal.map((b) => b.id).join(', ')})`);
  }

  const next = {
    ...state,
    letters: { ...state.letters, [state.seats[0]]: state.letters[state.seats[0]].slice(), [state.seats[1]]: state.letters[state.seats[1]].slice() },
    log: state.log.slice(),
  };

  if (state.phase === 'setter-pick') {
    if (seatId !== state.setterSeat) throw new Error('skate: not the setter\'s turn');
    const offer = state.offer || offerFor(state);
    const chosen = offer.find((o) => o.id === moveId);
    const landed = Math.random() < landChance(chosen.trick);
    next.offer = offer;
    next.log.push({ spot: SPOTS[state.spotIndex].id, seat: seatId, trick: chosen.trick, landed, role: 'setter' });
    next.pendingEvent = landed ? 'land' : 'bail';

    if (landed) {
      next.phase = 'follower-attempt';
      next.pendingTrick = chosen.trick;
    } else {
      // Setter bails -- no letter, the other seat sets the SAME spot fresh.
      next.setterSeat = otherSeat(state, seatId);
      next.offer = null;
      next.phase = 'setter-pick';
    }
    return next;
  }

  if (state.phase === 'follower-attempt') {
    const followerSeat = otherSeat(state, state.setterSeat);
    if (seatId !== followerSeat) throw new Error('skate: not the follower\'s turn');
    const landed = Math.random() < landChance(state.pendingTrick);
    next.log.push({ spot: SPOTS[state.spotIndex].id, seat: seatId, trick: state.pendingTrick, landed, role: 'follower' });
    next.pendingEvent = landed ? 'land' : 'bail';

    if (!landed) {
      const already = next.letters[seatId];
      next.letters[seatId] = already.concat([LETTERS[already.length]]);
    }
    // Either way the spot is done: advance, and the follower becomes next
    // spot's setter (standard SKATE alternation) unless the game just ended.
    next.pendingTrick = null;
    next.offer = null;
    if (next.letters[seatId].length >= LETTERS.length) {
      next.phase = 'settled';
      next.result = seatId === state.seats[0] ? 'lose' : 'win';
    } else if (state.spotIndex + 1 >= SPOTS.length) {
      // Ran out of spots with nobody spelling SKATE -- fewest letters wins,
      // equal letters is a push. Deterministic, no sudden-death spot needed
      // for phase 1.
      next.phase = 'settled';
      const a = next.letters[state.seats[0]].length, b = next.letters[state.seats[1]].length;
      next.result = a === b ? 'push' : (a < b ? 'win' : 'lose');
    } else {
      next.spotIndex = state.spotIndex + 1;
      next.setterSeat = followerSeat;
      next.phase = 'setter-pick';
    }
    return next;
  }

  throw new Error('skate: no move accepted in phase ' + state.phase);
}

/**
 * resolve(state) -> { score, nextState, events[] }
 * Emits exactly 'land' or 'bail' for the move just applied, then CONSUMES
 * that event on the returned nextState -- calling resolve() again on the
 * result reports no events, matching blackjack.js's own tested idempotency
 * property (hall/tests/blackjack.test.js #8). This is the only event
 * vocabulary LENS needs to know about for this pack.
 */
function resolve(state) {
  const events = state.pendingEvent ? [state.pendingEvent] : [];
  const nextState = state.pendingEvent ? { ...state, pendingEvent: null } : state;
  if (nextState.phase !== 'settled') return { score: null, nextState, events };
  return { score: nextState.result, nextState, events };
}

/** summary(state) -> spectator-safe view: current spot, letters, whose turn. */
function summary(state) {
  return {
    phase: state.phase,
    spot: SPOTS[state.spotIndex] ? SPOTS[state.spotIndex].label : null,
    setterSeat: state.setterSeat,
    letters: state.letters,
    result: state.result,
  };
}

module.exports = {
  // exported for tests / reuse; not part of the public pack contract itself
  SPOTS, LETTERS, TRICK_DIFFICULTY, landChance,
  // the pack contract
  startMatch, getButtons, applyMove, resolve, summary,
};
