'use strict';
/**
 * hall/packs/soccer.js -- Arcade Soccer, wrapped in the ENGINE-VISION.md
 * contract the same way as blackjack.js / skate.js / football.js:
 *   startMatch(seats, wager)             -> initial state
 *   getButtons(state) -> legal[]         -> ALWAYS <= 3, { id, label }
 *   applyMove(state, seatId, moveId)     -> new state
 *   resolve(state)                       -> { score, nextState, events[] }
 *
 * Action shape: fixed. ENGINE-VISION.md roster: buttons "shoot / square /
 * skill move", filmable event "shot or tackle only".
 *
 * PROVENANCE: issue #13 grouped Football and Soccer together and pointed at
 * the main repo's football sim for reuse. Checked backend/sports/ on
 * origin/main -- there is a football module and no soccer module, so unlike
 * football.js this pack has nothing upstream to mirror and its numbers are
 * original. Flagged in docs so a future soccer module knows to reconcile
 * against this file rather than assume football's risk/reward scale.
 *
 * Turn shape mirrors football.js: the attacking seat picks one of 3 actions,
 * the defending seat answers with one of 3, then the chance resolves. Keeping
 * the two packs structurally identical means hall/routes.js needs no
 * pack-specific branching and a reviewer learns one pattern, not two.
 *
 * Only two event names are ever emitted -- 'shot' and 'tackle' -- because the
 * vision doc restricts this pack's filmable moments to exactly those two, and
 * LENS only needs to know a fixed vocabulary per pack.
 */

const ATTACK = {
  shoot: { label: 'Shoot', base: 0.34, trait: 'power' },
  square: { label: 'Square It', base: 0.52, trait: 'width' },
  skill_move: { label: 'Skill Move', base: 0.44, trait: 'dribble' },
};

const DEFEND = {
  press: { label: 'Press', closing: 0.85, weakness: 'width' },
  contain: { label: 'Contain', closing: 0.40, weakness: 'dribble' },
  tackle: { label: 'Tackle', closing: 0.70, weakness: 'power' },
};

const ATTACK_RAIL = ['shoot', 'square', 'skill_move'];
const DEFEND_RAIL = ['press', 'contain', 'tackle'];

const ATTACKS_PER_MATCH = 6;
const WEAKNESS_BONUS = 0.18;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * shotChance(attackId, defendId) -> float 0..1
 * Shooting is the only action that can score; squaring and skill moves win the
 * ball back but score nothing themselves, which is why their `base` values sit
 * below shoot's once the defense is accounted for.
 */
function shotChance(attackId, defendId) {
  const a = ATTACK[attackId];
  const d = DEFEND[defendId];
  if (!a || !d) throw new Error('soccer: unknown action/call');
  const vsClosing = -d.closing * 0.28;
  const vsWeakness = a.trait === d.weakness ? WEAKNESS_BONUS : 0;
  return clamp(a.base + vsClosing + vsWeakness, 0.05, 0.92);
}

/** outcome(attackId, defendId, roll) -> { goal, turnover } */
function outcome(attackId, defendId, roll) {
  const scored = roll < shotChance(attackId, defendId);
  // Only a beaten defence can lose the ball; otherwise the attack recycles.
  const turnover = !scored && roll > 0.72;
  return { goal: scored, turnover };
}

function startMatch(seats, wager) {
  if (!Array.isArray(seats) || seats.length < 2 || !seats[0] || !seats[1]) {
    throw new Error('soccer: startMatch requires exactly two seats');
  }
  return {
    pack: 'soccer',
    seats: [seats[0], seats[1]],
    wager: Number(wager) || 0,
    attackSeat: seats[0],
    defendSeat: seats[1],
    attackIndex: 0,
    scores: { [seats[0]]: 0, [seats[1]]: 0 },
    phase: 'attack-call',   // attack-call -> defend-call -> resolved
    pendingAction: null,
    pendingCall: null,
    result: null,
    log: [],
    pendingEvent: null,     // 'shot' | 'tackle', consumed by resolve()
  };
}

function getButtons(state) {
  if (!state || state.phase === 'settled') return [];
  if (state.phase === 'attack-call') {
    return ATTACK_RAIL.map((id) => ({ id, label: ATTACK[id].label }));
  }
  if (state.phase === 'defend-call') {
    return DEFEND_RAIL.map((id) => ({ id, label: DEFEND[id].label }));
  }
  return [];
}

function commit(state) {
  const next = { ...state, log: state.log.slice() };
  const actionId = state.pendingAction;
  const callId = state.pendingCall;
  const roll = Math.random();
  const { goal, turnover } = outcome(actionId, callId, roll);
  const chance = shotChance(actionId, callId);

  next.log.push({
    attack: state.attackIndex,
    action: actionId,
    call: callId,
    goal,
    turnover,
    chance: Number(chance.toFixed(3)),
  });

  // Only 'shot' and 'tackle' ever reach LENS for this pack.
  next.pendingEvent = turnover ? 'tackle' : 'shot';
  if (goal) next.scores[state.attackSeat] += 1;

  next.attackIndex += 1;
  next.phase = 'attack-call';
  next.pendingAction = null;
  next.pendingCall = null;

  // A turnover flips who is attacking; otherwise the same seat keeps the ball.
  if (turnover) {
    next.attackSeat = state.defendSeat;
    next.defendSeat = state.attackSeat;
  }

  if (next.attackIndex >= ATTACKS_PER_MATCH) {
    const a = next.scores[next.seats[0]];
    const b = next.scores[next.seats[1]];
    next.phase = 'settled';
    next.result = a === b ? 'push' : (a > b ? 'win' : 'lose');
  }
  return next;
}

function applyMove(state, seatId, moveId) {
  if (state.phase === 'settled') throw new Error('soccer: match already settled');

  const legal = getButtons(state);
  if (!legal.some((b) => b.id === moveId)) {
    throw new Error(`soccer: illegal move '${moveId}' (legal: ${legal.map((b) => b.id).join(', ')})`);
  }

  if (state.phase === 'attack-call') {
    if (seatId !== state.attackSeat) throw new Error("soccer: not the attacking seat's turn");
    return { ...state, pendingAction: moveId, phase: 'defend-call' };
  }

  if (state.phase === 'defend-call') {
    if (seatId !== state.defendSeat) throw new Error("soccer: not the defending seat's turn");
    return commit({ ...state, pendingCall: moveId });
  }

  throw new Error('soccer: no move accepted in phase ' + state.phase);
}

/**
 * resolve(state) -> { score, nextState, events[] }
 * Consumes the pending event on the returned nextState so a repeat call is a
 * no-op -- the idempotency property every other pack here is tested for.
 */
function resolve(state) {
  const events = state.pendingEvent ? [state.pendingEvent] : [];
  const nextState = state.pendingEvent ? { ...state, pendingEvent: null } : state;
  if (nextState.phase !== 'settled') return { score: null, nextState, events };
  return { score: nextState.result, nextState, events };
}

function summary(state) {
  return {
    phase: state.phase,
    attackIndex: state.attackIndex,
    attacksLeft: Math.max(0, ATTACKS_PER_MATCH - state.attackIndex),
    attackSeat: state.attackSeat,
    scores: state.scores,
    result: state.result,
  };
}

module.exports = {
  ATTACK, DEFEND, ATTACK_RAIL, DEFEND_RAIL, ATTACKS_PER_MATCH,
  shotChance, outcome,
  startMatch, getButtons, applyMove, resolve, summary,
};