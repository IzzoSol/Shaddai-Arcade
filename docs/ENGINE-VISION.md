# SHADDAI Arcade — Engine Vision
> Written by QUILL, 2026-09-12. This organizes everything sent across this build's planning session (including the original Grok-sourced master prompts) into one reference. Purpose: make it obvious what is ENGINE (build once, reuse forever) vs. what is CONTENT (one table's specific rules). Read this before adding any new game.

---

## The one thing to hold onto

**We are not building a game. We are building the thing that lets any game sit in the same room.**

If a feature can't be described as *a new table pack*, *a new seat kind*, or *a new prompt rail*, it doesn't belong in the engine — it's either content (goes in a pack) or it's scope creep (goes in the backlog).

## The spine (this is the whole engine)

```
CITY      → where you walk in from (2D world / /hall swivel page / 3D world — same room, three cameras)
IDENTITY  → who is sitting: human | shaddai_agent | grok_bot | paybox_agent | webhook
SEAT      → a body's registration + wallet reference (POST /api/hall/seats)
TABLE     → a pack + a mode rail + two-or-more seats
MAILBOX   → the ONE protocol every seat obeys, regardless of kind (see below)
RESOLVER  → pack-specific logic: turns a move into a new state + a score
SPARKS    → the one chip, in and out of every table
LENS      → the optional camera (Fal), gated by Sparks, never by raw text
```

Everything below this line is either **the contract** (build once) or **content** (build per-game, cheaply, because the contract already did the hard part).

## The contract: what every game pack must implement

```js
startMatch(seats, wager)      // seats fill, buy-in clears via Sparks
getButtons(state) -> legal[]  // ALWAYS exactly 3 (or fewer if rules force it) { id, label }
applyMove(seatId, moveId)     // one seat's move, validated against legal[]
resolve()                      // { score, nextState, events[] } — events[] flags what's filmable
```

This is the only thing a new game has to write. Seats, wallets, spectating, crowd voting, and the camera are already handled by the engine — a new pack does not re-implement any of those.

## The two axes that describe every game (this answers "what KIND of games tech is this")

**Axis 1 — action shape:**
- `fixed` — the 3 buttons are literal, enumerable actions with deterministic rules (Hit/Stand/Double; a skate trick list; a play call). Resolver is pure logic, no LLM needed.
- `generative` — the 3 buttons are *strategies*, and the actual content (a rap bar, a defense's read) is written in response to the opponent's last move by a writer model. Resolver still needs pure logic for scoring/judging, but the content between buttons is generated, not enumerated.

**Axis 2 — prompt rail (who is allowed to submit the move):**
- `solo` — one seat, practice/self-play.
- `versus` — exactly the two seated bodies move each other. Default for real matches.
- `coach` — a seat's owner can talk (Line chat) about strategy, but the seated agent still must submit the legal move through the mailbox. Chat is never a move.
- `crowd` — spectators vote on the same `legal[]`; majority wins the turn. The table declares this, seats don't opt in per-turn.
- `director` — reserved for Room/Station/Live sessions (Fal Director, not a table game). Not part of the pack contract.

Every pack declares both: e.g. Blackjack = `fixed` + (`versus` | `crowd`). Booth = `generative` + (`versus` | `crowd`).

## The move mailbox (this is what makes "any agent can sit down" real)

One protocol, all seat kinds:

```
Hall → seat.endpoint (POST, every turn):
{ match_id, pack, you, mode, sparks, legal: [{id,label}], state, timeout_ms }

seat → Hall:
{ match_id, move: <one id from legal[]> }
```

- `human` seats skip the HTTP hop — a UI button click *is* the reply.
- `shaddai` seats route through the existing `mcp__shaddai__shaddai_*` tools instead of a raw webhook.
- `grok` / `webhook` / `paybox` seats are a real registered HTTP endpoint.
- Illegal reply (free text, extra keys, an id not in `legal[]`, a request naming a real celebrity) → rejected, clock keeps running. **Second** illegal reply, or a timeout, auto-resolves to the pack's declared default (e.g. auto-stand). This is a hard rule, not a suggestion — it's what keeps a chatty or broken external bot from stalling a table forever, and what keeps Fal from ever seeing raw text.
- Talk (Line / coach chat) is a **separate channel** from the mailbox, always. A seat cannot "talk its way into" a move.

## The original game roster (content, not engine — reference for future packs)

These are the games already described across planning; each is just an instance of the contract above. None of this needs new engine work once the mailbox and pack interface exist — it's per-pack content:

| Pack | Action shape | Example legal buttons | Filmable event |
|---|---|---|---|
| **Blackjack** (live, Royale) | fixed | Hit / Stand / Double | card snap, chip push, bust |
| **Football** | fixed | short pass / play-action / blitz answer | one play, not the drive |
| **Soccer** | fixed | shoot / square / skill move | shot or tackle only |
| **SKATE / S.K.A.T.E.** | fixed | 3 tricks generated per spot | the land or the bail |
| **Booth** (rap VS) | generative | punch / flip last line / story | last exchange only |
| **The Room** (content mode) | generative | 3 audience-continuation buttons | one clip per beat, Director-only |

`shaddai-games`'s four existing agent-only titles (basketball/football/dodgeball/sigil-storm) are additional `fixed` packs to wrap later — same contract, no new engine concept.

## Economy — one chip, no exceptions

**Sparks** is the only chip. PayBox is the top-up window only (buys Sparks / Line Pass / Desk) — it never sits a hand directly. Sparks do not cash out in v1. Every spend (buy-in, VS pot entry, spectator back, Line extension, Lens clip, Live take, Station hour) is a `spend()`/`grant()` call against the same ledger (`economy-service.js`), whether the seat is a human, an agent, or a bot. No second currency, ever — "gold," "chips," and "credits" are the same failure: three names for money confuses the person paying and the engineer building.

## LENS — the camera is a button, not a feature of the chat

LENS is never reachable from free text. A rewriter compresses a *resolved match event* into a locked contract (`SCENE_LOCK, CAST_LOCK, EVENT, LAW, DURATION`) before anything reaches Fal. Original face locks only. This is where "no stops" personal-agent talk (Line Pass, phase 2) and match spectating both end up — talk is cheap and continuous by design; the camera is always a metered, capped token spend, never unlimited, regardless of subscription tier.

## Non-negotiable laws (carried from every planning pass, restated once so they stop needing repeating)

1. No real celebrity names or likenesses as characters, ever — original cast only (Nova, Patch, Volt, Sol, Player, Gunner, and future original bodies).
2. No raw chat ever reaches Fal — always through the rewriter/contract.
3. No unlimited video generation at any subscription tier — Sparks meter every camera spend.
4. No real-money spectator wagering in v1 — Sparks/points only; cash-out is a future licensed layer, not this engine's problem yet.
5. A new idea is a pack, a seat kind, or a prompt rail — never a bespoke one-off system bolted to the side.

## Where the current build actually is

This is the vision layer — it doesn't change often. For what's actually shipping right now, task ownership, and open questions, see [`docs/HALL-PHASE1-SPEC.md`](HALL-PHASE1-SPEC.md) and the `phase-1`-labeled issues on this repo (`gh issue list --repo IzzoSol/Shaddai-Arcade --label phase-1`).
