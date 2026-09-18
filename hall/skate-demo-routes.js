'use strict';
/**
 * hall/skate-demo-routes.js — solo-vs-house practice mode for hall/packs/skate.js.
 *
 * Why this exists separately from hall/routes.js: the real Hall table-creation
 * flow (`POST /api/hall/tables`) only ever hands a pack ONE real seat id --
 * every existing pack (blackjack, the skillplay-bet packs) is single-seat by
 * design. hall/packs/skate.js is genuine 2-seat PvP (matches the owner's
 * "vs" plan for this pack), which the Hall's route layer doesn't support
 * yet -- there's no real seat-matchmaking anywhere in this repo.
 *
 * Rather than block on building real matchmaking (a bigger, separate task
 * that also unlocks Booth later), this wraps the ALREADY-TESTED skate.js
 * resolver unchanged in a "solo vs house" mode: seats = [playerId, 'house'],
 * and this route auto-plays every 'house' turn immediately server-side.
 * No changes to hall/packs/skate.js itself -- it has no idea it's playing a
 * bot, which is exactly the point of the pack contract (seats are just ids).
 *
 * NOT wired into Sparks/wager settlement (hall/routes.js owns that for real
 * tables) -- this is a free practice/demo mode, zero economy risk.
 */

const express = require('express');
const router = express.Router();
const pack = require('./packs/skate');

const HOUSE_SEAT = 'house';
const matches = new Map(); // matchId -> state

function newMatchId() {
  return 'skate_demo_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** House picks a random legal option every time -- a real difficulty curve
 *  is content-tuning for later, not needed to prove the loop works. */
function houseMove(state) {
  const legal = pack.getButtons(state);
  if (!legal.length) return null;
  return legal[Math.floor(Math.random() * legal.length)].id;
}

/** Drive the match forward while it's the house's turn, collecting every
 *  event along the way so the client can animate each land/bail in order,
 *  not just the final one. */
function driveHouse(state) {
  const events = [];
  let guard = 0;
  while (state.phase !== 'settled' && guard < 40) {
    const whoseTurn = state.phase === 'setter-pick'
      ? state.setterSeat
      : (state.seats[0] === state.setterSeat ? state.seats[1] : state.seats[0]);
    if (whoseTurn !== HOUSE_SEAT) break;
    const moveId = houseMove(state);
    if (!moveId) break;
    state = pack.applyMove(state, HOUSE_SEAT, moveId);
    const out = pack.resolve(state);
    state = out.nextState;
    if (out.events.length) events.push({ seat: HOUSE_SEAT, events: out.events });
    guard++;
  }
  return { state, events };
}

function publicView(matchId, state, extraEvents) {
  const whoseTurn = state.phase === 'settled'
    ? null
    : (state.phase === 'setter-pick' ? state.setterSeat : (state.seats[0] === state.setterSeat ? state.seats[1] : state.seats[0]));
  return {
    ok: true,
    matchId,
    summary: pack.summary(state),
    yourTurn: whoseTurn === state.seats[0],
    legal: whoseTurn === state.seats[0] ? pack.getButtons(state) : [],
    events: extraEvents || [],
    settled: state.phase === 'settled',
    result: state.phase === 'settled' ? state.result : null,
  };
}

// POST /api/skate-demo/start  { playerId }
router.post('/api/skate-demo/start', express.json(), (req, res) => {
  try {
    const playerId = String((req.body && req.body.playerId) || 'guest');
    let state = pack.startMatch([playerId, HOUSE_SEAT], 0);
    const matchId = newMatchId();
    const driven = driveHouse(state);
    state = driven.state;
    matches.set(matchId, state);
    res.json(publicView(matchId, state, driven.events));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/skate-demo/move  { matchId, moveId }
router.post('/api/skate-demo/move', express.json(), (req, res) => {
  try {
    const { matchId, moveId } = req.body || {};
    const state = matches.get(matchId);
    if (!state) return res.status(404).json({ ok: false, error: 'unknown matchId' });
    if (state.phase === 'settled') return res.status(400).json({ ok: false, error: 'match already settled' });

    const playerId = state.seats[0];
    let next = pack.applyMove(state, playerId, moveId);
    const out = pack.resolve(next);
    next = out.nextState;
    const events = out.events.length ? [{ seat: playerId, events: out.events }] : [];

    const driven = driveHouse(next);
    next = driven.state;
    events.push(...driven.events);

    matches.set(matchId, next);
    res.json(publicView(matchId, next, events));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
