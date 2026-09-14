'use strict';
/**
 * hall/packs/skillplay-bet.js — generic "watch and bet" pack factory for the
 * shaddai-games titles (Shaddai-Arcade issue #10, re-scoped -- see
 * hall/skillplay-client.js's header comment for why this isn't a literal
 * move-by-move wrap of those games).
 *
 * Model: a seat backs one of two named contenders for a given
 * shaddai-games title. The outcome is decided ONCE, deterministically, at
 * match creation (via the real SKILLPLAY engine over hall/skillplay-client.js)
 * -- not simulated turn-by-turn, since there is no server-side turn
 * structure for these titles to simulate. The seat then picks a side
 * through the exact same getButtons/applyMove/mailbox path blackjack uses,
 * so any seat kind (human, shaddai, grok, webhook) can place this bet with
 * zero seat/mailbox changes -- that's the part of the engine that IS
 * reused untouched, per the spec's "no new engine concepts" intent.
 *
 * score() vocabulary matches blackjack's exactly ('win' | 'lose') so
 * hall/routes.js's existing settleIfDone() (buy-in pays out on win, is kept
 * by the house on lose) needs no pack-specific branching.
 */

const skillplayClient = require('../skillplay-client');

/**
 * makeSkillplayBetPack(key, { game, label, contenderA, contenderB })
 *   key: unique pack id (e.g. 'hoops_bet') -- what callers pass as `pack`.
 *   game: the shaddai-games catalog key (see skillplay.js's GAME_ALIAS).
 *   label: human-readable title shown in button copy.
 *   contenderA/B: agent ids scored against `game`'s ability catalog via the
 *     real shaddai-games engine (council names work out of the box; a
 *     forged operative id works too, same as that repo's own /kit route).
 */
function makeSkillplayBetPack(key, { game, label, contenderA, contenderB }) {
  if (!game || !contenderA || !contenderB) {
    throw new Error(`${key}: game, contenderA, and contenderB are required`);
  }

  async function startMatch(seats, wager) {
    if (!Array.isArray(seats) || seats.length < 1) {
      throw new Error(`${key}: startMatch requires at least one seat`);
    }
    const { winner, scoreA, scoreB } = await skillplayClient.resolveContest(game, contenderA, contenderB);
    return {
      pack: key,
      seats: [seats[0], null],
      wager: Number(wager) || 0,
      turnSeat: seats[0],
      contenders: { A: contenderA, B: contenderB },
      scores: { A: scoreA, B: scoreB }, // informational -- not shown until settled, so a pick can't be reverse-engineered from it mid-round
      winner, // decided now, not at resolve() -- resolve() stays synchronous
      phase: 'pick', // pick -> resolving -> settled
      pick: null,
      result: null,
    };
  }

  function getButtons(state) {
    if (!state || state.phase !== 'pick') return [];
    return [
      { id: 'A', label: `${state.contenders.A} — ${label}` },
      { id: 'B', label: `${state.contenders.B} — ${label}` },
    ];
  }

  function applyMove(state, seatId, moveId) {
    if (state.phase !== 'pick') throw new Error(`${key}: no move accepted outside pick phase`);
    if (seatId !== state.turnSeat) throw new Error(`${key}: not this seat's turn`);
    const legal = getButtons(state);
    if (!legal.some((b) => b.id === moveId)) {
      throw new Error(`${key}: illegal move '${moveId}' (legal: ${legal.map((b) => b.id).join(', ')})`);
    }
    return { ...state, pick: moveId, phase: 'resolving' };
  }

  function resolve(state) {
    if (state.phase === 'pick') return { score: null, nextState: state, events: [] };
    if (state.phase === 'settled') return { score: state.result, nextState: state, events: [] };

    const result = state.pick === state.winner ? 'win' : 'lose';
    const next = { ...state, phase: 'settled', result };
    const events = [result === 'win' ? `${key}_win` : `${key}_lose`]; // filmable -- Lens can clip the reveal same as a blackjack win/bust
    return { score: result, nextState: next, events };
  }

  return { key, game, label, startMatch, getButtons, applyMove, resolve };
}

module.exports = { makeSkillplayBetPack };
