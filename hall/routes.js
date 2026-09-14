'use strict';
/**
 * hall/routes.js — the Hall's HTTP surface (Shaddai-Arcade issue #2).
 * Mounted additively in server.js -- does not touch any existing route.
 *
 * SCOPE DECISION (flagged, not hidden): this ships one seat playing one
 * hand against the house, reachable via the mailbox for ANY seat kind
 * (human via direct move submission below, shaddai/grok/webhook/paybox via
 * hall/mailbox.js). True "two seats, two concurrent hands, one shared
 * dealer" (the fuller "human vs Shaddai agent at the same table" picture)
 * needs hall/packs/blackjack.js extended from a single `state.player` to a
 * `state.players[seatId]` map -- a real next increment, not done here, so
 * as not to ship an undertested redesign in the same pass as the first one.
 * Solo play against the house already exercises the full seat/mailbox/
 * Sparks/pack pipeline end-to-end for every seat kind.
 *
 *   POST /api/hall/seats                  -- register a seat
 *   GET  /api/hall/seats/:id              -- fetch a seat
 *   POST /api/hall/tables                 -- start a match { seatId, wager }
 *   POST /api/hall/tables/:id/move        -- human move { move }
 *   GET  /api/hall/tables/:id             -- current state + legal buttons
 *   POST /api/hall/tables/:id/lens        -- Lens button: Sparks-gated Fal clip (issue #5)
 */

const express = require('express');
const router = express.Router();
const json = express.json();

const seatsStore = require('./seats');
const mailbox = require('./mailbox');
const economy = require('./economy-client');
const lens = require('./lens-client');

// Shaddai-Arcade issue #10: pack registry, no longer hardcoded to blackjack.
// hall/packs/index.js documents each pack's key -> module.
const PACKS = require('./packs');
const matches = new Map(); // matchId -> { pack, seatId, state, sparksApplied }

function newMatchId() {
  return 'match_' + require('crypto').randomBytes(6).toString('hex');
}

// Sparks is optional in local/dev: if the cross-service credential isn't
// configured yet (SHADDAI_ADMIN_TOKEN / SHADDAI_MAIN_BACKEND_URL), tables
// still work end-to-end on wager=0 semantics -- just no real ledger call.
// This is intentional so hall/routes.js can be developed and demoed before
// issue #3's PIKADON review clears the credential for real traffic.
function sparksConfigured() {
  return !!(process.env.SHADDAI_ADMIN_TOKEN && process.env.SHADDAI_MAIN_BACKEND_URL);
}

router.post('/api/hall/seats', json, (req, res) => {
  try {
    const seat = seatsStore.createSeat(req.body || {});
    res.json({ ok: true, seat });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

router.get('/api/hall/seats/:id', (req, res) => {
  const seat = seatsStore.getSeat(req.params.id);
  if (!seat) return res.status(404).json({ ok: false, error: 'seat not found' });
  res.json({ ok: true, seat });
});

/**
 * Drives non-human turns forward until it's a human's turn or the hand is
 * over. Shared by table creation (seat[0] might not be human) and move
 * submission (the seat that just moved might not have been the last one).
 */
async function driveToHumanOrEnd(match) {
  const pack = PACKS[match.pack];
  for (let guard = 0; guard < 20; guard++) { // hard cap: never spin forever on a bug
    const legal = pack.getButtons(match.state);
    if (!legal.length) break; // player-turn is over; resolve() will report the result
    const seat = seatsStore.getSeat(match.state.turnSeat);
    if (!seat || seat.kind === 'human') break; // wait for the human's own move POST
    const payload = {
      match_id: match.id, pack: match.pack, you: seat.id, mode: 'versus',
      sparks: match.wager, legal, state: match.state, timeout_ms: 15000,
    };
    const defaultMoveId = legal.some((b) => b.id === 'stand') ? 'stand' : legal[0].id;
    const { moveId } = await mailbox.dispatchTurn(seat, payload, defaultMoveId);
    match.state = pack.applyMove(match.state, seat.id, moveId);
  }
}

// Shaddai-Arcade issue #4 (ZEROX Sparks pricing sanity): docs/HALL-PHASE1-
// SPEC.md's own economy section calls for "grant(winner.sparks_ref, pot -
// rake, 'hall:bj_win', idemKey); rake goes to a house account (house:hall)"
// -- this was spec'd but never implemented (settleIfDone previously paid the
// full pot with no rake at all). 4% is a starting default, not a final
// pricing decision -- ZEROX's call whether to keep it, tune it, or drop it
// in favor of relying on blackjack's own structural house edge (the dealer
// already wins any hand where the player busts first, before the dealer
// even draws -- a real edge on its own, separate from this rake). Flooring
// the rake (never rounding up) means a small pot never rakes to zero payout.
const RAKE_BPS = 400; // 4.00%, in basis points so the math stays integer-exact
const HOUSE_ACCOUNT = 'house:hall'; // per HALL-PHASE1-SPEC.md's own naming

async function settleIfDone(match) {
  const pack = PACKS[match.pack];
  const { score, nextState, events } = pack.resolve(match.state);
  match.state = nextState;
  if (events && events.length) match.lastEvents = events; // Lens button reads this -- see /lens below
  if (score === null || match.sparksApplied) return { score, events }; // not over yet, or already paid
  match.sparksApplied = true;
  if (!sparksConfigured()) return { score, events, sparksSkipped: true };

  const seat = seatsStore.getSeat(match.seatId);
  const sparksRef = seat && seat.sparks_ref;
  if (!sparksRef) return { score, events, sparksSkipped: true };
  try {
    if (score === 'win' || score === 'blackjack') {
      const pot = match.wager * 2;
      const rake = Math.floor((pot * RAKE_BPS) / 10000);
      const payout = pot - rake;
      await economy.grant(sparksRef, payout, `hall:${match.pack}_win:${score}`, `${match.id}:payout`);
      if (rake > 0) {
        // Best-effort: a rake-credit failure must never undo or block the
        // player's own payout above, which has already succeeded.
        try {
          await economy.grant(HOUSE_ACCOUNT, rake, `hall:${match.pack}_rake`, `${match.id}:rake`);
        } catch (e) { /* house accounting gap, not a player-facing failure -- swallow */ }
      }
    } else if (score === 'push') {
      await economy.grant(sparksRef, match.wager, `hall:${match.pack}_push_refund`, `${match.id}:refund`);
    }
    // 'lose' / 'bust': buy-in already spent at table creation, no further movement.
  } catch (e) {
    return { score, events, sparksError: e.message };
  }
  return { score, events };
}

router.post('/api/hall/tables', json, async (req, res) => {
  try {
    const { seatId, wager, pack: packKey } = req.body || {};
    const seat = seatsStore.getSeat(seatId);
    if (!seat) return res.status(404).json({ ok: false, error: 'seat not found' });
    const amount = Number(wager) || 0;

    const pack = PACKS[packKey || 'blackjack'];
    if (!pack) {
      return res.status(400).json({ ok: false, error: `unknown pack '${packKey}' (valid: ${Object.keys(PACKS).join(', ')})` });
    }

    if (amount > 0 && sparksConfigured() && seat.sparks_ref) {
      try {
        await economy.spend(seat.sparks_ref, amount, `hall:${pack.key || 'bj'}_buyin`, `${seatId}:${Date.now()}`);
      } catch (e) {
        return res.status(e.status || 502).json({ ok: false, error: e.message });
      }
    }

    // await, not a bare call: skillplay-bet packs' startMatch is async (it
    // resolves the contest via a cross-service call before play begins);
    // blackjack's startMatch is sync and awaiting a non-promise is a no-op.
    let state = await pack.startMatch([seatId], amount);
    const match = { id: newMatchId(), pack: pack.key || 'blackjack', seatId, wager: amount, state, sparksApplied: false };
    matches.set(match.id, match);

    await driveToHumanOrEnd(match);
    const settlement = await settleIfDone(match);

    res.json({
      ok: true, matchId: match.id, state: match.state,
      legal: pack.getButtons(match.state), settlement,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/hall/tables/:id', (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ ok: false, error: 'match not found' });
  const pack = PACKS[match.pack];
  res.json({ ok: true, matchId: match.id, state: match.state, legal: pack.getButtons(match.state) });
});

router.post('/api/hall/tables/:id/move', json, async (req, res) => {
  try {
    const match = matches.get(req.params.id);
    if (!match) return res.status(404).json({ ok: false, error: 'match not found' });
    const pack = PACKS[match.pack];
    const seat = seatsStore.getSeat(match.state.turnSeat);
    if (!seat || seat.kind !== 'human') {
      return res.status(409).json({ ok: false, error: 'it is not a human seat\'s turn' });
    }
    const { move } = req.body || {};
    match.state = pack.applyMove(match.state, seat.id, move); // throws on illegal move -> 400 below

    await driveToHumanOrEnd(match);
    const settlement = await settleIfDone(match);

    res.json({ ok: true, state: match.state, legal: pack.getButtons(match.state), settlement });
  } catch (e) {
    const status = /illegal move|not this seat/i.test(e.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/hall/tables/:id/lens -- the spec's "Lens button on bust/win"
 * (acceptance item 6, docs/HALL-PHASE1-SPEC.md). User/frontend-triggered,
 * NOT automatic: a clip costs real Sparks, so it only fires when someone
 * actually asks for one, and only for a hand that just produced a filmable
 * event (bust/win/blackjack -- see blackjack.js's resolve()). Idempotency
 * key is derived from the match id so a double-click/retry replays the
 * same spend instead of charging twice (matches the spec's own testing
 * note: "no double-spend on retry").
 */
router.post('/api/hall/tables/:id/lens', json, async (req, res) => {
  try {
    const match = matches.get(req.params.id);
    if (!match) return res.status(404).json({ ok: false, error: 'match not found' });
    if (!match.lastEvents || !match.lastEvents.length) {
      return res.status(409).json({ ok: false, error: 'no filmable event on this table yet' });
    }
    if (!sparksConfigured()) {
      return res.status(503).json({ ok: false, error: 'Lens disabled (Sparks not configured)', code: 'DISABLED' });
    }
    const seat = seatsStore.getSeat(match.seatId);
    if (!seat || !seat.sparks_ref) {
      return res.status(400).json({ ok: false, error: 'seat has no sparks_ref' });
    }
    const eventType = match.lastEvents[match.lastEvents.length - 1]; // most recent filmable event
    const idempotencyKey = `${match.id}:lens`;
    try {
      const clip = await lens.requestClip(seat.sparks_ref, {
        matchId: match.id, pack: match.pack, eventType, seatId: seat.id,
      }, idempotencyKey);
      return res.json({ ok: true, ...clip });
    } catch (e) {
      return res.status(e.status || 502).json({ ok: false, error: e.message, code: e.code });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
