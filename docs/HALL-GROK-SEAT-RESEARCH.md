# Grok-Bot Seat Adapter — Research (Shaddai-Arcade issue #8)
> 2026-09-13. ORACLE pass. Research/analysis only, no code. Answers issue #8's three questions against the mailbox protocol as it's actually implemented (`hall/mailbox.js`, `hall/seats.js`), not the spec's aspirational version — the two already differ in one place (the `shaddai` seat kind uses agent-task polling, not a webhook; `grok` does not have that exception and uses the plain webhook path).

## 1. How a bot owner registers a `grok` seat

`kind: 'grok'` is already a first-class seat kind in `hall/seats.js`'s `VALID_KINDS`, and it's in `ENDPOINT_REQUIRED_KINDS` — it goes through the exact same code path as `kind: 'webhook'`. There is nothing Grok-specific in the current implementation; a "Grok bot" is, mechanically, just an operator who owns an HTTP endpoint and calls it `grok` for their own bookkeeping. That's a reasonable v1 posture (no special-cased vendor integration to maintain) but worth being explicit about, since the spec's data-model diagram (`IDENTITY → grok_bot`) reads as if it's a distinct integration.

Registration call:

```
POST /api/hall/seats
{
  "kind": "grok",
  "display_name": "<shown at the table>",
  "endpoint": "https://<bot owner's server>/mailbox",   // required, must be http(s)
  "owner_id": "<optional, bot owner's account id>",
  "sparks_ref": "<optional, only needed if this seat will wager>"
}
```

There is currently **no auth on seat registration itself** — anyone who can reach `/api/hall/seats` can register a `grok` seat pointing at any URL they own. That's fine for phase-1 (no money moves at registration time, only at buy-in, which is gated separately by `sparks_ref` + the economy service), but it means seat *creation* is not the security boundary — the **mailbox POST to their endpoint** and the **buy-in spend** are. Flagging this rather than treating it as solved, since a future "public bot marketplace" framing would need registration-time auth (e.g. an owner login) that doesn't exist today.

## 2. Wire contract and latency budget

Every turn, the Hall POSTs this to the registered endpoint (`hall/mailbox.js` `dispatchToWebhook`):

```
POST <seat.endpoint>
{ match_id, pack, you, mode, sparks, legal: [{id,label}], state, timeout_ms }
```

Expected reply, within `timeout_ms` (currently hardcoded to **15000 ms** per turn, set by `hall/routes.js`'s `driveToHumanOrEnd`, not configurable per-seat today):

```
{ match_id, move: "<one id from legal[]>" }
```

Two things a Grok-bot integrator needs to know that aren't obvious from the payload alone:

- **The `match_id` in the reply is checked** — `dispatchToWebhook` silently discards the reply (treats it as `null`, i.e. a strike) if `body.match_id` is present but doesn't match the request's `match_id`. A bot that queues requests and replies out of order will burn strikes for no visible reason unless it echoes `match_id` correctly.
- **The 15s budget is for the whole HTTP round-trip**, not "time to decide" — `axios.post(..., { timeout: timeoutMs })` is the actual bound, so DNS/TLS/queueing time on the bot's side eats into the same clock as its thinking time. A bot backed by an LLM call (which a real Grok integration would be) needs its own internal timeout meaningfully under 15s (recommend ≤10s) to leave margin for network overhead, or it will reliably time out on the very first turn of every hand.

## 3. Failure modes and what actually happens

This is already implemented and testable today, not hypothetical — `hall/mailbox.js`'s `dispatchTurn`:

| Failure | What happens | Player-visible effect |
|---|---|---|
| Endpoint returns malformed body / non-object / missing `move` | Treated as `null` → strike | Nothing shown yet (see strike 1 below) |
| Endpoint returns a `move` not in `legal[]` | `isLegalMove` rejects → strike | Nothing shown yet |
| Endpoint returns mismatched `match_id` | Discarded → strike | Nothing shown yet |
| Endpoint times out (>15s) | `axios` throws, caught, treated as `null` → strike | Nothing shown yet |
| Endpoint is unreachable (DNS fail, connection refused, TLS error) | Same as timeout — caught, strike | Nothing shown yet |
| **Second** strike (any of the above, twice in a row) | `dispatchTurn` returns the pack's `defaultMoveId` (blackjack: `stand`) — hand keeps moving | `{seat.name} didn't answer in time, so the house called it for them: {move label}` — see `docs/HALL-COPY.md` §2 |

Two consequences worth calling out for a real Grok integration, since they're structural, not tuning knobs:

- **A permanently-down bot never gets flagged or benched** — it just auto-stands every single hand it's dealt into, forever, silently degrading to "worst possible player" rather than being pulled from rotation. There's no seat-health tracking (consecutive-timeout counter, auto-sit-out) anywhere in `hall/seats.js` today. Fine for a single demo table; not fine once bots are seated unattended across many concurrent tables — flagging as a real gap for whoever scopes seat-health/monitoring, likely a NEXUS follow-up once #10-13's multi-table backlog lands.
- **Retries are not backed off or deduplicated beyond the match_id check** — the second attempt inside `dispatchTurn` fires immediately after the first fails, with no delay. A bot that's failing because it's rate-limiting itself (plausible for an LLM-backed responder under load) will just eat both strikes back-to-back and auto-resolve, rather than getting a moment to recover. Also worth a NEXUS look if flaky-but-recoverable bots turn out to be common in practice — not a phase-1 blocker since it's exactly the behavior the two-strike rule is supposed to produce (never stall the table), just worth knowing it trades bot-recoverability for table-liveness on purpose.

## Recommendation

Ship phase-1 Grok seats exactly as `webhook` seats — no special code needed, the contract already works end-to-end (this is the same path `hall/mailbox.js`'s tests exercise via a stub HTTP seat). Before onboarding a *real* external Grok-bot operator (as opposed to an internal test), give them: the wire contract above, the ≤10s internal-timeout recommendation, and an explicit warning that a consistently-down endpoint degrades to auto-stand with no alerting on either side — that last part is the one thing that could look like a Hall bug from the bot owner's side when it's actually working as designed.
