'use strict';
/**
 * hall/skillplay-client.js — server-to-server client for the shaddai-games
 * repo's live SKILLPLAY engine (IzzoSol/shaddai-games, backend/platform/
 * skillplay.js + affinity.js), added for Shaddai-Arcade issue #10.
 *
 * WHY THIS EXISTS (read before touching #10 again): issue #10 originally
 * assumed Gridiron/Neon Hoops/Dodgeball/Starfall could wrap behind
 * startMatch/getButtons/applyMove/resolve the same way blackjack does. They
 * can't as written -- they're real-time, keyboard-controlled, physics-sim'd
 * browser games with no server-side turn structure or legal-moves list
 * anywhere in that repo (confirmed by reading shaddai-games' actual code,
 * not assumed from the issue text). Re-scoped, with the owner's sign-off,
 * to "spectator/bet" packs instead: a Hall seat backs one of two contenders,
 * the *outcome* is resolved deterministically via the SAME engine that
 * repo already uses to compute how good an agent is at a given game
 * (skillplay.js's kitForAgent -> per-ability match scores), and the Hall
 * pays out on that result. No new simulation invented -- this reuses the
 * real, already-deterministic scoring engine that repo runs in production
 * for its own SKILLPLAY mode, over the HTTP boundary that already exists
 * (GET /api/skillplay/:game/kit/:id), the same cross-service-client pattern
 * as hall/economy-client.js and hall/lens-client.js.
 *
 * SHADDAI_GAMES_URL must point at a reachable shaddai-games deployment.
 * ⚠️ NOT SET ANYWHERE YET -- this is a new owner action item, same shape as
 * ARCADE_SERVICE_TOKEN was for issue #3 (see docs/HALL-SKILLPLAY-BET-PACKS.md).
 * No auth token needed: /api/skillplay/:game/kit/:id is a public read-only
 * GET in that repo today, same as its own frontend calls it.
 */

const axios = require('axios');

function baseUrl() {
  const url = process.env.SHADDAI_GAMES_URL;
  if (!url) throw new Error('SHADDAI_GAMES_URL not configured -- cannot score a skillplay-bet pack');
  return url.replace(/\/$/, '');
}

/**
 * contenderScore(game, agentId) -> 0..1 aggregate match quality
 * Calls the real, already-deterministic engine (no local reimplementation,
 * no drift risk): averages the top-N ability match scores it returns.
 */
async function contenderScore(game, agentId) {
  const res = await axios.get(`${baseUrl()}/api/skillplay/${encodeURIComponent(game)}/kit/${encodeURIComponent(agentId)}`, {
    params: { n: 8 }, timeout: 8000,
  });
  const abilities = (res.data && res.data.abilities) || [];
  if (!abilities.length) return 0;
  const sum = abilities.reduce((s, a) => s + (a.match || 0), 0);
  return +(sum / abilities.length).toFixed(4);
}

/**
 * resolveContest(game, contenderA, contenderB) -> { winner: 'A'|'B', scoreA, scoreB }
 * Deterministic: same two contenders + same engine state always produce the
 * same winner. A tie (both scores exactly equal) breaks to contender A --
 * documented, not hidden, since a silent coin-flip would reintroduce the
 * randomness this engine explicitly avoids everywhere else.
 */
async function resolveContest(game, contenderA, contenderB) {
  const [scoreA, scoreB] = await Promise.all([
    contenderScore(game, contenderA),
    contenderScore(game, contenderB),
  ]);
  return { winner: scoreB > scoreA ? 'B' : 'A', scoreA, scoreB };
}

module.exports = { contenderScore, resolveContest };
