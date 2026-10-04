# HALL-BOOTH-PACK — the first `generative` pack (issue #11)

Status: **implemented and tested** on `feat/hall-platform-phase1`.
Blocked on two **main-repo** edits (see Action Items) — booth is playable now, but not *filmable* until they land.

## What makes it `generative`

Per `docs/ENGINE-VISION.md`, a `generative` pack has:

| Property | How booth does it |
|---|---|
| Buttons are **strategies**, never content | `getButtons()` returns exactly `punch` / `flip` / `story`. A button is a 5-char strategy id. |
| Content is **written in response to the opponent** | `hall/writer-client.js` asks the main backend's `/api/groq` for bars that answer the opponent's line. Each delivered bar records `repliesTo`. |
| Content is **generated, not enumerated** | Bars live in `writer-client.js`; the pack never contains a hardcoded bar list on the live path (seeded bars exist only as an offline fallback). |
| Resolver is **pure logic** | `scoreBar(bar, strategy)` is a weighted sum over the `content`/`cadence`/`rebound` rubric. No I/O, no generation, no randomness. |

## The judge rubric

Each bar is scored 0–10 on three axes, then weighted **per strategy**, so choosing a strategy is a real commitment rather than a formality:

| Strategy | content | cadence | rebound | Reads as |
|---|---|---|---|---|
| `punch` | 0.55 | 0.25 | 0.20 | short, hard hit on the weakest claim |
| `flip` | 0.40 | 0.25 | 0.35 | their own words turned back on them |
| `story` | 0.45 | 0.40 | 0.15 | narrative reframe; needs flow, not a jab |

Six rounds, alternating seats, points accumulate, higher total wins (exact tie → `push`).

## Architecture note — why generation is in `startMatch`

The engine contract is load-bearing and every pack obeys it: **`getButtons`/`applyMove`/`resolve` are synchronous**. `skillplay-bet.js` set the precedent that `startMatch` may be `async` and does all external work up front.

A network LLM call therefore **cannot** happen inside a synchronous `applyMove`. Doing per-turn generation would mean changing the engine, which issue #11 forbids ("no new engine concepts"). So:

- bars are composed **once** in `startMatch`, each written as a reply to the character's seed opener;
- they're dealt deterministically from that library as the match runs.

**The honest deviation:** `ENGINE-VISION.md` says content is written "in response to the opponent's **last** move". Here the writer answers the seed line, and `repliesTo` records which prior line a bar is *attached* to. A true write-after-every-bar needs an async `applyMove` — an engine change deferred to a later phase, not smuggled into this one.

## Cast

Original cast only, per issue #11: **`Player (red beanie)`** vs **`Gunner`**. Both already exist in the main repo's `CAST_LOCK` (`backend/lib/lens-rewriter.js`) — booth adds no new faces and never names a real person or likeness.

## Credential boundary (PIKADON-relevant)

`writer-client.js` calls `POST {SHADDAI_MAIN_BACKEND_URL}/api/groq`, whose contract was read from `backend/api-proxy-routes.js` (`{messages, max_tokens, model, apiKey}` → OpenAI-style response).

That route accepts a **caller-supplied `apiKey`**. Royale deliberately **never sends that field** — the backend then uses its own env `GROQ_API_KEY`. Arcade must not hold or forward a Groq key. Scoped-token boundary is unchanged from `hall/lens-client.js`: `SHADDAI_ADMIN_TOKEN` should hold the scoped `ARCADE_SERVICE_TOKEN`, not the main backend's master `ADMIN_TOKEN`.

## Failure posture

- **Missing admin token** → throws. A missing credential is an operator error, not something to paper over.
- **Missing `SHADDAI_MAIN_BACKEND_URL` / provider down / unparseable completion** → seeded bars, `state.sources[seat] === 'seeded'`.
- **Partial completion** (some strategy missing) → that strategy is backfilled from seed and `state.truncated === true`.

`summary()` always discloses `sources` and `truncated`, so seeded content can never masquerade as model output. `parseCompletion` tolerates prose, fenced blocks, bare arrays, half-JSON, and non-numeric rubric values without ever throwing into a live match.

## Action Items (main repo — `IzzoSol/Shaddai`)

1. **Add two `EVENT_SCENES` keys** for `booth_bar` and `booth_verdict` in `backend/lib/lens-rewriter.js`. Until then `backend/lens-routes.js` rejects booth clips with `400 unfilmable event type`. Note the existing precedent from SKATE: bare keys can collide (`bail` is owned by dodgeball), and `buildLensContract` resolves `pack_eventType` first — so prefer **`booth_bar` / `booth_verdict`** over bare `bar` / `verdict`.
2. **Set `GROQ_API_KEY`** on the main backend, and give Royale `SHADDAI_MAIN_BACKEND_URL` + scoped `SHADDAI_ADMIN_TOKEN`. Same shape as `SHADDAI_GAMES_URL` for issue #10.

## Tests

`node hall/tests/booth.test.js` — **13/13**, run with no writer configured on purpose. The generative contract must hold identically whether content came from the model or the seed, or the pack is only correct when the network is up.