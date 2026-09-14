'use strict';
/**
 * hall/lens-client.js — server-to-server client for the main Shaddai
 * backend's LENS route (backend/lens-routes.js, added this session as
 * Shaddai-Arcade issue #5). Mirrors hall/economy-client.js exactly: same
 * base URL, same admin-token header, same fail-closed-if-unconfigured
 * posture (a Lens clip involves a real Sparks spend, so silently no-op'ing
 * on missing config would be worse than a loud error).
 *
 * Royale never holds FAL_KEY -- the main backend owns Fal entirely. This
 * module only ever sends the resolved event's *shape* (matchId, pack,
 * eventType, seatId), never any chat/prompt text, matching
 * docs/HALL-PHASE1-SPEC.md's "rewriter never forwards raw chat" rule.
 *
 * SHADDAI_ADMIN_TOKEN here should hold the scoped ARCADE_SERVICE_TOKEN, not
 * the main backend's master ADMIN_TOKEN -- see the longer note in
 * hall/economy-client.js (Shaddai-Arcade issue #3, PIKADON review).
 */

const axios = require('axios');

function baseUrl() {
  const url = process.env.SHADDAI_MAIN_BACKEND_URL;
  if (!url) throw new Error('SHADDAI_MAIN_BACKEND_URL not configured');
  return url.replace(/\/$/, '');
}

function adminHeaders() {
  const token = process.env.SHADDAI_ADMIN_TOKEN;
  if (!token) throw new Error('SHADDAI_ADMIN_TOKEN not configured -- refusing to call LENS without it');
  return { 'x-admin-token': token, 'Content-Type': 'application/json' };
}

/**
 * requestClip(userId, { matchId, pack, eventType, seatId }, idempotencyKey)
 *   -> { jobId, status, eta, costUsd, sparksCharged, balance, replayed }
 * Throws with err.status=402 on insufficient Sparks, err.status=400 on an
 * unfilmable event type, err.status=503 if Lens/Fal isn't configured
 * server-side -- callers (hall/routes.js) map these to clean HTTP responses.
 */
async function requestClip(userId, event, idempotencyKey) {
  try {
    const res = await axios.post(`${baseUrl()}/api/lens/clip`, {
      userId,
      matchId: event.matchId,
      pack: event.pack,
      eventType: event.eventType,
      seatId: event.seatId,
      idempotencyKey,
    }, { headers: adminHeaders(), timeout: 20000 });
    return res.data;
  } catch (e) {
    if (e.response && e.response.data) {
      const err = new Error(e.response.data.error || 'lens clip request failed');
      err.status = e.response.status;
      err.code = e.response.data.code;
      throw err;
    }
    throw e;
  }
}

/**
 * getClipStatus(jobId) -> { status, progress, videoUrl, error }
 * Thin passthrough to GET /api/lens/clip/:jobId (backend/lens-routes.js),
 * which itself passes through to the fal adapter's own getStatus() --
 * videoUrl is null until the provider job finishes. Added for the mobile
 * Hall's inline Lens playback (issue #6 follow-up): the browser client
 * can't hold SHADDAI_ADMIN_TOKEN, so hall/routes.js proxies this the same
 * way it already proxies requestClip.
 */
async function getClipStatus(jobId) {
  try {
    const res = await axios.get(`${baseUrl()}/api/lens/clip/${encodeURIComponent(jobId)}`, {
      headers: adminHeaders(), timeout: 15000,
    });
    return res.data;
  } catch (e) {
    if (e.response && e.response.data) {
      const err = new Error(e.response.data.error || 'lens clip status request failed');
      err.status = e.response.status;
      err.code = e.response.data.code;
      throw err;
    }
    throw e;
  }
}

module.exports = { requestClip, getClipStatus };
