'use strict';
/**
 * hall/packs/blackjack.js — the Hall's first table pack.
 *
 * Implements the ENGINE-VISION.md contract exactly:
 *   startMatch(seats, wager)      -> initial state
 *   getButtons(state) -> legal[]  -> ALWAYS <= 3, { id, label }
 *   applyMove(state, seatId, moveId) -> new state
 *   resolve(state)                -> { score, nextState, events[] }
 *
 * Action shape: fixed (Hit / Stand / Double — the three buttons
 * docs/ENGINE-VISION.md's own roster table names for this pack). No side
 * bets, no split, no insurance, no surrender in Phase 1 -- server.js's
 * existing REST game has those for the standalone game; the Hall's first
 * table intentionally stays to the documented 3-button contract. Extending
 * this pack later to match server.js's full ruleset is a content change,
 * not an engine change, per ENGINE-VISION.md's own framing.
 *
 * Deliberately has NO dependency on server.js/engine.js (avoids coupling the
 * new Hall layer to the standalone game's in-memory globals) -- self-
 * contained so it's easy to unit test and easy to reuse if the mailbox ever
 * runs in a different process.
 */

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

function newShuffledDeck(rng = Math.random) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s, v: cardValue(r) });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Best hand value, aces counted as 11 or 1 to avoid busting. */
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) { total += c.v; if (c.r === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

/**
 * startMatch(seats, wager) -> state
 *   seats: [seatIdA, seatIdB] -- exactly 2 for versus/crowd; solo uses [seatId, null]
 *   wager: integer Sparks buy-in per seat (already spent by the caller before
 *          this is invoked -- this pack does not itself touch the ledger,
 *          matching HALL-PHASE1-SPEC.md's own separation: buy-in/payout are
 *          the Hall's job via economy-client.js, resolve() just reports the
 *          score the Hall then pays out against).
 */
function startMatch(seats, wager) {
  if (!Array.isArray(seats) || seats.length < 1) {
    throw new Error('blackjack: startMatch requires at least one seat');
  }
  const deck = newShuffledDeck();
  const dealer = [deck.pop(), deck.pop()];
  const playerHand = [deck.pop(), deck.pop()];
  return {
    pack: 'blackjack',
    seats: [seats[0], seats[1] || null],
    wager: Number(wager) || 0,
    deck,
    dealer,
    player: { cards: playerHand, done: false, doubled: false },
    phase: 'player-turn', // player-turn -> dealer-turn -> settled
    turnSeat: seats[0],
    result: null, // set by resolve(): 'win' | 'lose' | 'push' | 'blackjack'
  };
}

/**
 * getButtons(state) -> legal[] -- ALWAYS exactly 3 or fewer.
 * Double is only legal on the player's first decision (2 cards, not already
 * doubled) -- matches server.js's existing double-down rule.
 */
function getButtons(state) {
  if (!state || state.phase !== 'player-turn' || state.player.done) return [];
  const legal = [
    { id: 'hit', label: 'Hit' },
    { id: 'stand', label: 'Stand' },
  ];
  if (state.player.cards.length === 2 && !state.player.doubled) {
    legal.push({ id: 'double', label: 'Double' });
  }
  return legal;
}

/**
 * applyMove(state, seatId, moveId) -> new state (does not mutate the input).
 * Throws on an illegal move -- the mailbox is responsible for the 2-strike/
 * timeout handling described in ENGINE-VISION.md; this function's contract
 * is simply "reject anything not currently in getButtons(state)".
 */
function applyMove(state, seatId, moveId) {
  if (state.phase !== 'player-turn') throw new Error('blackjack: no move accepted outside player-turn');
  if (seatId !== state.turnSeat) throw new Error('blackjack: not this seat\'s turn');
  const legal = getButtons(state);
  if (!legal.some((b) => b.id === moveId)) {
    throw new Error(`blackjack: illegal move '${moveId}' (legal: ${legal.map((b) => b.id).join(', ')})`);
  }

  // Shallow-clone the parts we mutate; deck/dealer are only read from here.
  const next = {
    ...state,
    deck: state.deck.slice(),
    player: { ...state.player, cards: state.player.cards.slice() },
  };

  if (moveId === 'hit') {
    next.player.cards.push(next.deck.pop());
    if (handValue(next.player.cards) > 21) { next.player.done = true; next.phase = 'dealer-turn'; }
  } else if (moveId === 'stand') {
    next.player.done = true;
    next.phase = 'dealer-turn';
  } else if (moveId === 'double') {
    next.player.doubled = true;
    next.player.cards.push(next.deck.pop());
    next.player.done = true;
    next.phase = 'dealer-turn';
  }

  return next;
}

/**
 * resolve(state) -> { score, nextState, events[] }
 * Only meaningful once phase is 'dealer-turn' or later -- plays the dealer
 * out (stand on 17, matching Vegas/AC house rules already documented in
 * engine.js) and settles. events[] flags what's filmable for LENS, per
 * ENGINE-VISION.md's roster table ("card snap, chip push, bust").
 */
function resolve(state) {
  if (state.phase === 'player-turn') {
    // Not over yet -- report the current (unsettled) score, no events.
    return { score: null, nextState: state, events: [] };
  }
  if (state.phase === 'settled') {
    return { score: state.result, nextState: state, events: [] };
  }

  const next = { ...state, deck: state.deck.slice(), dealer: state.dealer.slice() };
  const playerValue = handValue(next.player.cards);
  const events = [];

  if (playerValue > 21) {
    next.result = 'bust';
    events.push('bust');
  } else {
    while (handValue(next.dealer) < 17) next.dealer.push(next.deck.pop());
    const dealerValue = handValue(next.dealer);
    if (isBlackjack(next.player.cards) && !isBlackjack(next.dealer)) {
      next.result = 'blackjack';
      events.push('blackjack');
    } else if (dealerValue > 21) {
      next.result = 'win';
      events.push('win');
    } else if (playerValue > dealerValue) {
      next.result = 'win';
      events.push('win');
    } else if (playerValue === dealerValue) {
      next.result = 'push';
    } else {
      next.result = 'lose';
    }
  }
  next.phase = 'settled';

  return { score: next.result, nextState: next, events };
}

module.exports = {
  // exported for tests / reuse; not part of the public pack contract itself
  newShuffledDeck, handValue, isBlackjack,
  // the pack contract
  startMatch, getButtons, applyMove, resolve,
};
