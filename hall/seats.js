'use strict';
/**
 * hall/seats.js — seat registration (docs/HALL-PHASE1-SPEC.md's "Data model"
 * section). In-memory store, matching this repo's existing convention
 * (server.js's `games`/`players` objects are also in-memory) -- persistence
 * can be added later without changing this module's public shape.
 *
 * POST /api/hall/seats { kind, display_name, owner_id, model, endpoint,
 *                          face_lock, sparks_ref }
 * GET  /api/hall/seats/:id
 */

const crypto = require('crypto');

const VALID_KINDS = new Set(['human', 'shaddai', 'grok', 'paybox', 'webhook']);
// Kinds whose moves arrive via a real HTTP callback the mailbox POSTs to.
// human: a UI button click is the move (no HTTP hop).
// shaddai: routed through the main backend's agent-invocation surface
//   instead of a seat-owner-registered endpoint (see hall/mailbox.js).
const ENDPOINT_REQUIRED_KINDS = new Set(['grok', 'paybox', 'webhook']);

const seats = new Map(); // id -> seat record

function createSeat(input) {
  const { kind, display_name, owner_id, model, endpoint, face_lock, sparks_ref } = input || {};
  if (!VALID_KINDS.has(kind)) {
    const err = new Error(`kind must be one of: ${[...VALID_KINDS].join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (!display_name || typeof display_name !== 'string') {
    const err = new Error('display_name required');
    err.status = 400;
    throw err;
  }
  if (ENDPOINT_REQUIRED_KINDS.has(kind) && !endpoint) {
    const err = new Error(`kind '${kind}' requires an endpoint URL for the mailbox to POST to`);
    err.status = 400;
    throw err;
  }
  if (endpoint && !/^https?:\/\//i.test(String(endpoint))) {
    const err = new Error('endpoint must be an http(s) URL');
    err.status = 400;
    throw err;
  }
  // sparks_ref is the userId key into the main backend's Sparks ledger
  // (economy-service.js) -- e.g. "agent:nova", or a human's own account id.
  // Not required at seat-creation time (a seat can exist before it ever
  // buys into a table), but validated as a plain string when present.
  if (sparks_ref != null && typeof sparks_ref !== 'string') {
    const err = new Error('sparks_ref must be a string');
    err.status = 400;
    throw err;
  }

  const id = 'seat_' + crypto.randomBytes(6).toString('hex');
  const seat = {
    id,
    kind,
    display_name: String(display_name).slice(0, 60),
    owner_id: owner_id || null,
    model: model || null,
    endpoint: endpoint || null,
    face_lock: face_lock || null, // LENS original-cast identity, not enforced here (issue #5's concern)
    sparks_ref: sparks_ref || null,
    createdAt: Date.now(),
  };
  seats.set(id, seat);
  return seat;
}

function getSeat(id) {
  return seats.get(id) || null;
}

module.exports = { createSeat, getSeat, VALID_KINDS };
