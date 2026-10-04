'use strict';
/**
 * hall/packs/football.js -- Arcade Football, wrapped in the
 * ENGINE-VISION.md contract exactly like blackjack.js / skate.js:
 *   startMatch(seats, wager)             -> initial state
 *   getButtons(state) -> legal[]         -> ALWAYS <= 3, { id, label }
 *   applyMove(state, seatId, moveId)     -> new state
 *   resolve(state)                       -> { score, nextState, events[] }
 *
 * Action shape: fixed (ENGINE-VISION.md roster: "one play, not the drive").
 * No LLM in the resolver.
 *
 * PROVENANCE / REUSE (Shaddai-Arcade issue #13 said "may reuse existing sim
 * logic referenced in the main Shaddai repo's games-routes.js -- check before
 * rewriting"). Checked: the main repo has a full Arcade Football V1 module at
 * backend/sports/football/ (playbook.js, ruleset.js, abilities.js, roles.js)
 * plus backend/lib/arcade-sim.js. This pack does NOT duplicate that sim, for
 * two reasons:
 *   1. Royale is a separate deploy and cannot require() the private main repo.
 *   2. arcade-sim.js is a whole-game score generator (one call -> one score);
 *      it cannot express a play-call button contract at all.
 * What IS reused is the *model*: the play/call identities and their exact
 * risk/reward/pressure/weakness values below are copied verbatim from
 * playbook.js's OFFENSE_PLAYS and DEFENSE_CALLS, and the resolver's counter
 * matrix is driven by playbook's own `weakness` field. A retune there should
 * be mirrored here; playbook.js stays the source of truth.
 *
 * Turn shape: offense seat calls a play (3 buttons), defense seat answers with
 * a call (3 buttons), then the play resolves. getButtons returns whichever
 * side's 3 buttons the current phase calls for -- the same role-dependent
 * pattern skate.js uses for setter/follower.
 *
 * Note on ENGINE-VISION's example buttons ("short pass / play-action / blitz
 * answer"): those mix an offense play with a defense call, which can't be one
 * button list. Read as "offense calls, defense answers", offense is offered
 * short_pass / play_action / deep_pass and defense is offered blitz / zone /
 * man. The remaining playbook entries (inside_run, outside_run, prevent) are
 * exported and usable but not on the default 3-button rail.
 */

const OFFENSE = {
  inside_run: { label: 'Inside Run', risk: 0.30, reward: 0.50, trait: 'run' },
  outside_run: { label: 'Outside Run', risk: 0.40, reward: 0.65, trait: 'speed' },
  short_pass: { label: 'Short Pass', risk: 0.25, reward: 0.55, trait: 'quick_pass' },
  deep_pass: { label: 'Deep Pass', risk: 0.65, reward: 0.90, trait: 'speed' },
  play_action: { label: 'Play Action', risk: 0.45, reward: 0.75, trait: 'flood' },
};

const DEFENSE = {
  man: { label: 'Man Coverage', pressure: 0.40, weakness: 'speed' },
  zone: { label: 'Zone Coverage', pressure: 0.30, weakness: 'flood' },
  blitz: { label: 'Blitz', pressure: 0.85, weakness: 'quick_pass' },
  prevent: { label: 'Prevent', pressure: 0.10, weakness: 'short_pass' },
};

const OFFENSE_RAIL = ['short_pass', 'play_action', 'deep_pass'];
const DEFENSE_RAIL = ['blitz', 'zone', 'man'];

// Weakness bonuses are small on purpose: they should tilt a close match, not
// decide it. Risk/reward and pressure do the heavy lifting.
const WEAKNESS_BONUS = 0.15;

const DOWNS_PER_DRIVE = 4;
const YARDS_TO_GAIN = 10;
const DRIVES_PER_MATCH = 3; // 6 total, alternating possession -- bounds the match
const STARTING_YARD_LINE = 25;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * successChance(offenseId, defenseId) -> float 0..1
 * Pure data + arithmetic so it is trivially testable and never hides a second
 * random draw inside applyMove (one roll per play keeps replays honest).
 */
function successChance(offenseId, defenseId) {
  const o = OFFENSE[offenseId];
  const d = DEFENSE[defenseId];
  if (!o || !d) throw new Error('football: unknown play/call');
  const base = 0.45 + (o.reward - o.risk) * 0.5;
  const vsPressure = -d.pressure * 0.30;
  const vsWeakness = o.trait === d.weakness ? WEAKNESS_BONUS : 0;
  return clamp(base + vsPressure + vsWeakness, 0.05, 0.95);
}

/** yardsFor(offenseId, success) -> integer yards gained, or 0 on a turnover. */
function yardsFor(offenseId, success) {
  const o = OFFENSE[offenseId];
  if (!success) return 0;
  return Math.round(clamp(o.reward * 18, 1, 18));
}

function startMatch(seats, wager) {
  if (!Array.isArray(seats) || seats.length < 2 || !seats[0] || !seats[1]) {
    throw new Error('football: startMatch requires exactly two seats');
  }
  return {
    pack: 'football',
    seats: [seats[0], seats[1]],
    wager: Number(wager) || 0,
    offenseSeat: seats[0],
    defenseSeat: seats[1],
    down: 1,
    yardsToGo: YARDS_TO_GAIN,
    lineOfScrimmage: STARTING_YARD_LINE,
    driveIndex: 0,
    scores: { [seats[0]]: 0, [seats[1]]: 0 },
    phase: 'offense-call',   // offense-call -> defense-call -> resolved
    pendingPlay: null,
    pendingCall: null,
    lastPlay: null,
    turnover: false,
    result: null,            // 'win' | 'lose' | 'push' from seats[0]'s perspective
    log: [],
    pendingEvent: null,      // 'play' | 'touchdown' | 'turnover', consumed by resolve()
  };
}

function getButtons(state) {
  if (!state || state.phase === 'settled') return [];
  if (state.phase === 'offense-call') {
    return OFFENSE_RAIL.map((id) => ({ id, label: OFFENSE[id].label }));
  }
  if (state.phase === 'defense-call') {
    return DEFENSE_RAIL.map((id) => ({ id, label: DEFENSE[id].label }));
  }
  return [];
}

/**
 * Resolve the play once both calls are in. Kept as its own function (not
 * inlined in applyMove) so tests can exercise it without a full match.
 */
function commitPlay(state) {
  const next = { ...state, log: state.log.slice() };
  const offenseId = state.pendingPlay;
  const defenseId = state.pendingCall;
  const chance = successChance(offenseId, defenseId);
  const success = Math.random() < chance;
  const yards = yardsFor(offenseId, success);
  const turnover = !success;

  next.log.push({
    drive: state.driveIndex,
    down: state.down,
    play: offenseId,
    call: defenseId,
    yards,
    turnover,
    chance: Number(chance.toFixed(3)),
  });

  next.lineOfScrimmage += yards;
  next.pendingEvent = 'play';

  // Touchdown: reached the end zone from inside the 20 with room to spare.
  if (next.lineOfScrimmage >= 100) {
    next.scores[state.offenseSeat] += 6;
    next.log[next.log.length - 1].touchdown = true;
    next.pendingEvent = 'touchdown';
    next.driveIndex += 1;
    next.down = 1;
    next.yardsToGo = YARDS_TO_GAIN;
    next.lineOfScrimmage = STARTING_YARD_LINE;
    next.offenseSeat = state.defenseSeat;
    next.defenseSeat = state.offenseSeat;
    next.phase = 'offense-call';
    next.pendingPlay = null;
    next.pendingCall = null;
    if (next.driveIndex >= DRIVES_PER_MATCH * 2) settle(next);
    return next;
  }

  // First down resets the series but keeps possession.
  if (yards >= next.yardsToGo) {
    next.down = 1;
    next.yardsToGo = YARDS_TO_GAIN;
  } else {
    next.down += 1;
    next.yardsToGo -= yards;
  }

  // Turnover on a failed play, or on 4th down.
  if (turnover || next.down > DOWNS_PER_DRIVE) {
    next.turnover = true;
    next.pendingEvent = 'turnover';
    next.driveIndex += 1;
    next.down = 1;
    next.yardsToGo = YARDS_TO_GAIN;
    next.lineOfScrimmage = STARTING_YARD_LINE;
    next.offenseSeat = state.defenseSeat;
    next.defenseSeat = state.offenseSeat;
    next.phase = 'offense-call';
    next.pendingPlay = null;
    next.pendingCall = null;
    if (next.driveIndex >= DRIVES_PER_MATCH * 2) settle(next);
    return next;
  }

  next.phase = 'offense-call';
  next.pendingPlay = null;
  next.pendingCall = null;
  return next;
}

function settle(next) {
  const a = next.scores[next.seats[0]];
  const b = next.scores[next.seats[1]];
  next.phase = 'settled';
  next.result = a === b ? 'push' : (a > b ? 'win' : 'lose');
}

function applyMove(state, seatId, moveId) {
  if (state.phase === 'settled') throw new Error('football: match already settled');

  const legal = getButtons(state);
  if (!legal.some((b) => b.id === moveId)) {
    throw new Error(`football: illegal move '${moveId}' (legal: ${legal.map((b) => b.id).join(', ')})`);
  }

  if (state.phase === 'offense-call') {
    if (seatId !== state.offenseSeat) throw new Error("football: not the offense's turn");
    return { ...state, pendingPlay: moveId, phase: 'defense-call' };
  }

  if (state.phase === 'defense-call') {
    if (seatId !== state.defenseSeat) throw new Error("football: not the defense's turn");
    return commitPlay({ ...state, pendingCall: moveId });
  }

  throw new Error('football: no move accepted in phase ' + state.phase);
}

/**
 * resolve(state) -> { score, nextState, events[] }
 * Emits the event for the play just resolved and CONSUMES it, so calling
 * resolve() again on the chained nextState reports nothing -- same idempotency
 * property blackjack.js and skate.js are tested for.
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
    down: state.down,
    yardsToGo: state.yardsToGo,
    lineOfScrimmage: state.lineOfScrimmage,
    offenseSeat: state.offenseSeat,
    scores: state.scores,
    result: state.result,
  };
}

module.exports = {
  OFFENSE, DEFENSE, OFFENSE_RAIL, DEFENSE_RAIL,
  DOWNS_PER_DRIVE, YARDS_TO_GAIN, DRIVES_PER_MATCH,
  successChance, yardsFor,
  startMatch, getButtons, applyMove, resolve, summary,
};