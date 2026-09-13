'use strict';
/**
 * hall/mailbox.js — the ONE protocol every non-human seat obeys
 * (docs/ENGINE-VISION.md "The move mailbox").
 *
 *   Hall -> seat.endpoint (POST, every turn):
 *     { match_id, pack, you, mode, sparks, legal: [{id,label}], state, timeout_ms }
 *   seat -> Hall:
 *     { match_id, move: <one id from legal[]> }
 *
 * Rules (from the spec, restated as code):
 *   - human seats never go through this module -- the UI button click IS
 *     the move; the HTTP route layer handles that seat kind directly.
 *   - First illegal reply (free text, extra keys, an id not in legal[], a
 *     request naming a real celebrity) -> rejected, clock keeps running.
 *   - Second illegal reply, OR a timeout -> auto-resolve to the pack's
 *     declared default move. This is what stops a broken/chatty external
 *     bot from stalling a table forever.
 *
 * HONEST GAP, flagged rather than papered over: the spec says a `shaddai`
 * seat "routes through the existing mcp__shaddai__shaddai_* tools instead
 * of a raw webhook" -- those are MCP tools reachable from a Claude session,
 * not something a standalone Node server process can invoke directly. What
 * this module actually does for `kind:'shaddai'` is call the main Shaddai
 * backend's real REST agent-task surface (POST /api/agent/run, poll
 * GET /api/agent/task/:id -- verified against public/index.html's own usage
 * of this exact pattern in the main repo this session) with a goal prompt
 * asking the agent to pick one of the legal move ids. It reaches a real
 * SHADDAI agent and gets a real decision back -- it is NOT the literal MCP
 * tool-call path the spec describes. ORACLE's seat-adapter research
 * (issue #8) and a PIKADON pass are the right place to decide whether this
 * approximation is good enough to keep or needs the real MCP bridge.
 */

const axios = require('axios');

const CELEBRITY_NAME_PATTERN_NOTE =
  'Illegal-move detection for "a request naming a real celebrity" is a LENS/rewriter-side' +
  ' concern (docs/ENGINE-VISION.md), not a move-mailbox concern -- moves here are always' +
  ' constrained to bare ids from legal[], never free text, so a celebrity name literally' +
  ' cannot appear in a move payload. Noted so this isn\'t silently "forgotten" scope.';
void CELEBRITY_NAME_PATTERN_NOTE; // documentation-only constant, not logic

function isLegalMove(legal, moveId) {
  return Array.isArray(legal) && legal.some((b) => b && b.id === moveId);
}

async function dispatchToWebhook(seat, payload, timeoutMs) {
  const res = await axios.post(seat.endpoint, payload, { timeout: timeoutMs });
  const body = res && res.data;
  if (!body || typeof body !== 'object' || typeof body.move !== 'string') return null;
  if (body.match_id && body.match_id !== payload.match_id) return null; // stale/mismatched reply
  return body.move;
}

async function dispatchToShaddai(seat, payload, opts) {
  const base = (opts && opts.shaddaiBaseUrl) || process.env.SHADDAI_MAIN_BACKEND_URL;
  if (!base) throw new Error('SHADDAI_MAIN_BACKEND_URL not configured -- cannot reach a shaddai seat');
  const goal =
    `You are seated at a ${payload.pack} table (match ${payload.match_id}). ` +
    `Current state: ${JSON.stringify(payload.state)}. ` +
    `Choose exactly one move id from this list and respond with ONLY that id, nothing else: ` +
    payload.legal.map((b) => b.id).join(', ');
  const runRes = await axios.post(`${base.replace(/\/$/, '')}/api/agent/run`, {
    goal, agent: (seat.model || 'SHADDAI'),
  }, { timeout: payload.timeout_ms || 15000 });
  const taskId = runRes.data && runRes.data.taskId;
  if (!taskId) return null;

  const deadline = Date.now() + (payload.timeout_ms || 15000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const poll = await axios.get(`${base.replace(/\/$/, '')}/api/agent/task/${taskId}`, { timeout: 5000 }).catch(() => null);
    const t = poll && poll.data;
    if (t && (t.status === 'completed' || t.status === 'failed')) {
      const text = String((t.result && (t.result.text || t.result)) || '').trim().toLowerCase();
      const hit = payload.legal.find((b) => text === b.id || text.includes(b.id));
      return hit ? hit.id : null;
    }
  }
  return null; // timed out waiting on the agent -- caller treats as a strike
}

/**
 * dispatchTurn -> { moveId, strikes, autoResolved }
 *   seat: a seat record from hall/seats.js (never 'human')
 *   payload: { match_id, pack, you, mode, sparks, legal, state, timeout_ms }
 *   defaultMoveId: the pack's declared fallback (e.g. blackjack's 'stand')
 */
async function dispatchTurn(seat, payload, defaultMoveId, opts) {
  if (seat.kind === 'human') {
    throw new Error('dispatchTurn must never be called for a human seat');
  }
  const timeoutMs = payload.timeout_ms || 15000;

  async function attempt() {
    if (seat.kind === 'shaddai') return dispatchToShaddai(seat, payload, opts);
    return dispatchToWebhook(seat, payload, timeoutMs);
  }

  let move = null;
  try { move = await attempt(); } catch (_) { move = null; }
  if (isLegalMove(payload.legal, move)) return { moveId: move, strikes: 0, autoResolved: false };

  // Strike 1 used. Clock keeps running -- give it one more try.
  let move2 = null;
  try { move2 = await attempt(); } catch (_) { move2 = null; }
  if (isLegalMove(payload.legal, move2)) return { moveId: move2, strikes: 1, autoResolved: false };

  // Strike 2, or timeout both times -- auto-resolve, never stall the table.
  return { moveId: defaultMoveId, strikes: 2, autoResolved: true };
}

module.exports = { dispatchTurn, isLegalMove };
