# The Hall — User-Facing Copy (Shaddai-Arcade issue #7)
> 2026-09-13. QUILL pass. Companion to `docs/HALL-PHASE1-SPEC.md` (Prompt rails, LENS) and `docs/ENGINE-VISION.md` (move mailbox). Written for TURTLE to wire into `#6` (the `/hall` swivel page) — this doc has no code changes; the server still speaks the short dev-facing strings documented inline in `hall/routes.js`, `hall/mailbox.js`, `hall/packs/blackjack.js` (e.g. `blackjack: illegal move '<id>' (legal: ...)`), which the client is expected to map to the lines below rather than show raw.

## Voice

Short, confident, house-of-cards-dealer dry wit — never apologetic, never cutesy. The Hall doesn't say "oops!"; it says what happened and what you can do next. No exclamation points except on a genuine win.

---

## 1. Prompt rails (table mode)

Shown as a small mode chip near the top bar of a table, plus a one-line tooltip on hover/tap.

| Mode | Chip label | Tooltip |
|---|---|---|
| `solo` | **Solo** | Practice hand. No one else is seated — it's just you and the house. |
| `versus` | **Versus** | Live hand. Only the two seated players can move — chat doesn't count. |
| `coach` | **Coach** | You can talk this seat through it in Line, but the move still has to come through the table. Chat never plays the hand. |
| `crowd` | **Crowd** | Spectators vote on the next move. Majority rules. |
| `director` | **Director** | Reserved for Room/Station/Live sessions — not open yet. |

Coach-mode Line placeholder text (chat box, when a human is coaching a non-human seat): *"Talk them through it — they still have to make the move themselves."*

---

## 2. Illegal-move / mailbox messages

These map to `hall/mailbox.js`'s two-strike protocol. A **human** seat gets an immediate inline validation message (their client should never even let them submit an off-menu move, but this is the fallback if it happens — e.g. a stale button). A **non-human** seat's strikes are shown to spectators/the other seat as a small status line under that seat's name, not a blocking modal.

**First illegal reply (strike 1) — human-facing fallback:**
> That's not one of your options right now. Pick one of the highlighted buttons.

**First illegal reply (strike 1) — shown about a non-human seat, to others at the table:**
> `{seat.name}` sent something the table couldn't use. Giving it one more shot.

**Second illegal reply or timeout (strike 2) — auto-resolve, shown to everyone at the table:**
> `{seat.name}` didn't answer in time, so the house called it for them: **{move label}**.

**Timeout warning (optional, shown a few seconds before the clock runs out on a non-human seat):**
> Waiting on `{seat.name}`...

---

## 3. Lens button + confirmation

Button, shown only after a filmable event (bust / win / blackjack):

> **🎬 Lens this — 15 Sparks**

Confirmation step (tap-to-confirm, not a full modal — this should feel as fast as the button itself):

> Turn this into a clip for 15 Sparks? *(Confirm / Never mind)*

While the clip is generating:

> Rolling the clip... this usually takes under a minute.

On success:

> Clip's ready. *(View / Share)*

On failure (Fal/queue error — map from `lens-routes.js`'s refund-on-failure path):

> Couldn't get the shot this time. Your 15 Sparks are back in your balance.

On insufficient Sparks (`402` from the main backend):

> You need 15 Sparks for a Lens clip — you've got `{balance}`.

On "no filmable event yet" (`409`, e.g. double-tapping after the moment passed):

> Nothing to film right now — Lens only works right after a bust, win, or blackjack.

On Lens disabled / not configured (`503`):

> Lens isn't running at this table yet. Check back soon.

---

## 4. Buy-in confirmation flow

Before a hand starts, when a wager > 0:

> Sit in for **{wager} Sparks**? *(Confirm / Never mind)*

On insufficient Sparks for buy-in:

> You need {wager} Sparks to sit in — you've got `{balance}`. Top up or pick a smaller table.

On successful buy-in (brief toast, not blocking):

> You're in. **{wager} Sparks** on the table.

Hand outcomes (shown at resolve, tied to `settleIfDone()`'s `score`):

| `score` | Copy |
|---|---|
| `win` | You win **{payout} Sparks**. *(house keeps a {rake}-Spark cut)* |
| `blackjack` | **Blackjack!** {payout} Sparks. *(house keeps a {rake}-Spark cut)* |
| `push` | Push — your {wager} Sparks are back. |
| `lose` / `bust` | House takes it this time. |

Note the rake line only needs to show when `rake > 0` — on small pots the rake can floor to 0, and the line should just disappear rather than say "0-Spark cut."

---

## 5. Seat registration (light copy, for whenever seat-creation gets a UI)

> Claim a seat at the Hall. *(name, kind: You / Shaddai agent / Grok / PayBox agent)*

---

## Open for TURTLE / ZEROX

- `{payout}`, `{rake}`, `{balance}`, `{wager}`, `{seat.name}`, `{move label}` are template slots — the client already has all of these values from the existing API responses (`state`, `settlement`, `legal[].label`), no new endpoint needed.
- Rake-amount wording assumes ZEROX's 4% default holds; if the rake model changes (issue #4's open item), only the buy-in-flow table above needs a re-pass, nothing else in this doc depends on the exact rate.
