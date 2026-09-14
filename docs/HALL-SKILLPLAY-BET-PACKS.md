# Shaddai-Arcade #10 — Re-scope: shaddai-games as "watch and bet" packs
> 2026-09-13. Read this before touching #10/hall/packs/skillplay-bet.js again.

## What changed vs. the original issue

Issue #10 said the 4 `shaddai-games` titles (named there as "basketball/football/dodgeball/sigil-storm") are "fixed action-shape" and could wrap behind `startMatch/getButtons/applyMove/resolve` with "no new engine concepts needed" — the same treatment blackjack got.

That's not what's actually in `IzzoSol/shaddai-games`. Read directly: Gridiron, Neon Hoops, Dodgeball, and Starfall (the real 4 "Playable Now" titles per that repo's own README — there is no "sigil-storm") are real-time, keyboard-controlled, physics-simulated browser games. There is no server-side turn structure and no legal-moves list anywhere in that repo's backend (`backend/skillplay-routes.js` only handles ability-catalog/kit lookup, not match play — the actual gameplay loop is client-side canvas/WASD). The Hall's mailbox protocol needs a discrete "here are your legal moves this turn" list to send, which these games structurally don't have without inventing a genuinely new abstraction.

**Owner-approved re-scope:** wrap them as **spectator/bet packs** instead. A seat backs one of two named contenders for a title; the outcome is decided once, deterministically, using the real SKILLPLAY scoring engine that repo already runs in production (`backend/platform/skillplay.js`'s `kitForAgent` — same deterministic skill→ability matching its own frontend uses); the Hall pays out on the pick. This reuses the seat/mailbox/pack contract exactly as-is (any seat kind can place this bet with zero mailbox changes) and reuses the real scoring engine instead of inventing a fake simulation.

## What's built

- `hall/skillplay-client.js` — cross-service HTTP client to shaddai-games' existing `GET /api/skillplay/:game/kit/:id` (already live in that repo, no changes needed there). Same pattern as `hall/economy-client.js`/`hall/lens-client.js`.
- `hall/packs/skillplay-bet.js` — `makeSkillplayBetPack(key, {game, label, contenderA, contenderB})` factory. `score()` vocabulary is `'win'|'lose'`, matching blackjack's, so `hall/routes.js`'s existing settlement/rake logic needed no pack-specific branching.
- `hall/packs/index.js` — the pack registry (`blackjack`, `hoops_bet`, `gridiron_bet`, `dodgeball_bet`, `starfall_bet`). Phase-1 contenders are fixed council-agent pairings (e.g. hoops: NEXUS vs. PIKADON) — real "pick your own roster" is a further increment, not built here.
- `hall/routes.js` — `POST /api/hall/tables` now takes an optional `pack` field (defaults to `'blackjack'`), validated against the registry; previously hardcoded to blackjack only. `startMatch` is now awaited (blackjack's stays sync — awaiting a non-promise is a no-op — the bet packs' is async, since resolving the contest is a network call).
- `hall/tests/skillplay-bet.test.js` — real HTTP against a stub shaddai-games server + the real Hall routes, proving determinism and a full win/lose settlement.

## ⚠️ New owner action item

**`SHADDAI_GAMES_URL`** must be set (on whichever service hosts `hall/routes.js` in production) to a reachable `IzzoSol/shaddai-games` deployment. Not set anywhere yet. No new auth token needed — `GET /api/skillplay/:game/kit/:id` is already a public read-only route in that repo. Without this env var, any `*_bet` pack table creation fails closed with a clear error (`SHADDAI_GAMES_URL not configured`), same fail-closed posture as `SHADDAI_ADMIN_TOKEN` elsewhere in this codebase.

## Explicitly not done here

- Real seat-vs-seat rosters (contenders are fixed pairs, not player-chosen).
- Odds/payout curves reflecting each contender's actual scored strength (current payout is the same flat win/lose math as blackjack — a 90%-favorite win pays the same as a coinflip win, which ZEROX should weigh in on, same open question as blackjack's rake in issue #4).
- Any UI — this is backend/pack-contract work only, same split as the rest of this session (#6/TURTLE still owns the swivel page).
