# SHADDAI Arcade — The Hall (Phase 1 Spec)
> 2026-09-12. Architectural spec, brainstormed and approved this session. Supersedes the "modules" framing of the original 90-day Arcade plan — this is the platform version.

---

## One sentence

Shaddai Arcade is one Hall — reachable from the 2D city, a web swivel page, and the existing 3D world — where humans, Shaddai agents, Grok bots, and PayBox agents sit at the same tables under the same rules, spectators can watch or vote, and Fal (LENS) is the optional camera that proves the moment.

## Repo decision

Checked all `IzzoSol` repos before deciding where this lives. Two existing public repos are candidates:

- **`shaddai-games`** ("SHADDAI Games") — agent-only deterministic skill-to-ability arcade (basketball/football/dodgeball/sigil-storm). No humans, no wagering, no seats. This is what "Shaddai Arcade github" refers to.
- **`Shaddai-Royale`** — already a real blackjack game: Node/Express + Socket.IO backend, 7 AI-agent rivals, Story Mode, Tournament, Agent CPU, its own "Royale Bank" chip ledger, Phantom (Solana) wallet for bonus chips. This is "the other game one."

**Decision: upgrade `Shaddai-Royale` into the Hall's first table**, instead of starting a new repo or starting from `shaddai-games`. It already has real-time blackjack + agent rivals — the seat/mailbox/Sparks/LENS work below is additive, not a rewrite. `shaddai-games`'s four games get wrapped into the same seat interface later (Phase 2) — untouched for now.

This does **not** move Royale's canonical backend logic into the main private `Shaddai` repo. Royale stays a standalone deploy; it gains a thin client to the main backend's economy for Sparks (see below).

## Platform spine

```
CITY (2D world, web swivel /hall, existing 3D world — three cameras, one Hall)
  |
IDENTITY: human | shaddai_agent | grok_bot | paybox_agent | webhook
  |
SEAT  →  TABLE (pack + mode rail)  →  MOVE MAILBOX  →  RESOLVER
                                                          |
                                                    SPARKS ledger
                                                          |
                                                     LENS (Fal, optional)
```

A new idea is only allowed in as: a new table pack, a new seat kind, or a new prompt rail. No separate apps for Grok, PayBox, rap, skate, casino, or video.

## Data model

**Seat** — `POST /api/hall/seats { kind: human|shaddai|grok|paybox|webhook, display_name, owner_id, model, endpoint, face_lock, sparks_ref }`. `sparks_ref` is the userId key into the canonical Sparks ledger (`economy-service.js` in the main Shaddai backend) — e.g. `agent:nova`, or a human's existing account id.

**Table / Match** — `{ id, pack: 'blackjack', room: 'hall', seats: [seatId|null, seatId|null], mode, potSparks, rake, state, filmableEvents[] }`.

**Move mailbox** (the seat-agnostic protocol — this is the actual platform upgrade):
```
Hall → seat.endpoint (POST, per turn):
{ match_id, pack, you, mode, sparks, legal: [{id,label}], state, timeout_ms }

seat → Hall:
{ match_id, move: <id from legal[]> }
```
- `kind: human` skips the HTTP hop — the UI button click *is* the move.
- `kind: shaddai` routes through the existing `mcp__shaddai__shaddai_*` agent tools rather than a raw webhook.
- `kind: grok | webhook | paybox` call a real HTTP endpoint the seat owner registered.
- First illegal/malformed reply (free text, extra keys, a real-celebrity ask, an id not in `legal[]`) → rejected, clock keeps running. Second illegal reply or timeout → auto-resolve to the pack's default (stand/fold).
- Talk (Line / coach chat) is a **separate channel**, never a substitute for a legal move.

**Prompt rails (table mode)** — `solo | versus | coach | crowd | director`. `solo`: practice, one seat plays itself. `versus`: exactly the two seated bodies move. `coach`: the owner chats in Line, but the seated agent still must return a move via the mailbox — chat never becomes the move. `crowd`: spectators vote on the same `legal[]`; majority becomes the move. `director`: reserved for Room/Station/Live sessions, not built this phase.

## Economy — Sparks

Canonical ledger is `backend/economy-service.js` in the main Shaddai repo (`grant/spend/getBalance`, integer-only, idempotent, no cash-out — this already exists and is load-bearing for agent-services and the x402 bridge, so it is reused as-is, not rebuilt).

**Gap found:** Sparks is currently only reachable by an in-process `require()` inside the main backend. Royale is a separate deploy and needs it over HTTP. There's precedent for exactly this shape already — `backend/x402-ledger-routes.js` exposes `GET /balance/:account`, `POST /credit` and `POST /debit`, `requireAdmin`-gated. **New work needed:** a sibling `economy-routes.js` exposing `spend`/`grant`/`getBalance` from `economy-service.js` the same way, admin-gated for server-to-server calls only (Royale holds an admin-scoped key server-side; never shipped to its browser client).

Buy-in: `spend(seat.sparks_ref, 25, 'hall:bj_buyin', idemKey)`. Payout: `grant(winner.sparks_ref, pot - rake, 'hall:bj_win', idemKey)`. Rake goes to a house account (`house:hall`). PayBox is the only Sparks top-up window; Royale's existing "Royale Bank" ledger and Phantom-wallet bonus chips get bridged to/retired in favor of Sparks as part of this work (do not run two chip systems in parallel past Phase 1).

## LENS (Fal)

No Fal adapter exists yet in the codebase (`video-providers.js` currently has pika/runway/heygen/kling, all with the same `generate()/getStatus()/costPerSecond` shape). Add `fal` as a fifth adapter there, same interface. `FAL_KEY` is an env var, server-side only — **never inline in a prompt, chat message, or client code**, and the key pasted earlier in this session should be rotated in the fal.ai dashboard regardless of how it's used.

Flow: resolve a filmable event (bust/win) → `spend(seat.sparks_ref, 15, 'lens:bj_clip', idemKey)` → rewriter compresses the event into the locked contract (`SCENE_LOCK, CAST_LOCK, EVENT, LAW, DURATION`) → `fal.generate()`. Rewriter never forwards raw chat. Original face locks only: **Nova, Patch, Volt, Sol, Player (red beanie), Gunner** — no real celebrity names or likenesses, ever (this was tested and refused earlier in this session for a separate request; the rule is absolute, not a suggestion).

## Frontend (TURTLE)

- 2D-world: an Arcade door/room in the existing pixel-world leading to the Hall.
- New `/hall` swivel web page: CSS-3D or lightweight Three.js room (not a new engine), tables on the floor, agents already seated with idle poses, click felt = sit, click rail = spectate. Bottom rail = always exactly the 3 legal buttons. Top bar = Sparks / Line / Lens. No "choose a game" menu — the room is the navigation.
- Royale's existing neon-casino UI is the visual base for the blackjack table specifically; it gets the seat/mailbox + Sparks + Lens wiring, not a redesign.
- 3D-world wiring (same table ids, third camera) is a fast-follow after 2D + swivel ship, not a Phase-1 blocker.

## Explicitly out of scope this phase

- Line Pass / personal chatbot continuous-talk subscriptions (designed this session, banked for Phase 2 — same Sparks ledger, so cheap to add later).
- Wrapping `shaddai-games`'s four existing games into the shared seat interface (Phase 2).
- PayBox real-money spectator wagering (Sparks/points only in v1; cash-out is a future licensed layer with lawyers involved first).
- Director/Live/Station sessions.

## Testing

- Unit: blackjack pack `legalMoves/applyMove/resolve`; mailbox illegal-move + timeout handling (2-strike rule); Sparks buy-in/payout math.
- Integration: seat intake → match fills → mailbox round-trip against a stub HTTP seat (fake "grok" endpoint) → resolve → Sparks balances correct → Lens spend gated correctly (no spend without event, no double-spend on retry).
- Reuse `economy-service.js`'s existing test suite rather than duplicating ledger tests.

## Open questions / risks flagged, not yet resolved

- `MASTER-PLAN-2026-09-04.md` (this vault) references a repo at `C:\Users\Brittany\Documents\IzzoSol-Shaddai` distinct from the live `C:\Users\Brittany\Shaddai` checkout used this session (confirmed current: branch `main`, matches `github.com/IzzoSol/Shaddai`, private). Worth confirming which is authoritative before agents start editing — working in the wrong checkout would fork state silently.
- Royale's Phantom/Solana wallet bonus-chip feature and "Royale Bank" need an explicit migration/retirement decision (bridge balances once, or start Sparks at zero) — not yet made.
- Cross-service auth shape (admin key held by Royale to call the main backend's new `economy-routes.js`) needs a PIKADON pass before it ships — this is a real credential crossing a network boundary between two separate deploys.

## Agent task ownership (Phase 1)

| Task | Owner | Depends on |
|---|---|---|
| `economy-routes.js` (admin-gated spend/grant/getBalance over HTTP) | NEXUS | — |
| Seat schema + move-mailbox protocol + blackjack pack (`legalMoves/applyMove/resolve`) in Royale | NEXUS | economy-routes.js |
| Cross-service auth review (Royale ↔ main backend admin key) | PIKADON | economy-routes.js |
| Sparks pricing sanity (buy-in, rake, Lens cost vs. Fal COGS) | ZEROX | — |
| `fal` adapter in `video-providers.js` + rewriter contract | NEXUS | — |
| `/hall` swivel page + 2D-world Arcade door + Royale UI wiring for seats/rail/Sparks/Lens button | TURTLE | seat/mailbox protocol |
| Copy: seat-mode labels, illegal-move messages, Lens button, buy-in confirmation | QUILL | seat/mailbox protocol |
| Grok-bot seat adapter research (auth shape, rate limits, response contract for an external model) | ORACLE | seat/mailbox protocol |
| Final go/no-go before Royale main-branch merge | SHADDAI | all above |

## Build order (unchanged from the session's own sequencing)

1. Hall as a place: 2D room + `/hall` swivel with two tables stubbed (one blackjack live, one "coming").
2. Seat intake + mailbox on blackjack, human vs. Shaddai agent.
3. Sparks buy-in + pot (via new `economy-routes.js`).
4. Spectate rail + crowd mode on that one table.
5. Grok seat via mailbox.
6. Lens button on bust/win.
7. *(Phase 2)* Wrap a `shaddai-games` game into the same Hall as a second room/table.
