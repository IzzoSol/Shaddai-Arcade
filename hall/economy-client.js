'use strict';
/**
 * hall/economy-client.js — thin server-to-server client for the main
 * Shaddai backend's Sparks ledger (backend/economy-routes.js), added this
 * session as Shaddai-Arcade issue #1: GET /balance, POST /grant were
 * already live; POST /spend was the missing leg, now added.
 *
 * SECURITY: SHADDAI_ADMIN_TOKEN is a server-to-server credential and must
 * NEVER reach this repo's browser client -- this module is backend-only.
 * docs/HALL-PHASE1-SPEC.md's own open-question list calls out that the
 * actual cross-service auth shape needs a PIKADON pass (issue #3) before
 * this is used with a real token in production; until then, calling any
 * function here with SHADDAI_ADMIN_TOKEN unset fails closed with a clear
 * error rather than silently no-op'ing (a silent no-op would be worse: a
 * buy-in that "succeeds" without actually debiting anyone).
 */

const axios = require('axios');

function baseUrl() {
  const url = process.env.SHADDAI_MAIN_BACKEND_URL;
  if (!url) throw new Error('SHADDAI_MAIN_BACKEND_URL not configured');
  return url.replace(/\/$/, '');
}

function adminHeaders() {
  const token = process.env.SHADDAI_ADMIN_TOKEN;
  if (!token) throw new Error('SHADDAI_ADMIN_TOKEN not configured -- refusing to call the Sparks ledger without it');
  return { 'x-admin-token': token, 'Content-Type': 'application/json' };
}

/** getBalance(userId) -> integer Sparks balance */
async function getBalance(userId) {
  const res = await axios.get(`${baseUrl()}/api/economy/balance`, {
    params: { userId }, timeout: 8000,
  });
  return res.data && res.data.sparks_balance;
}

/**
 * spend(userId, amount, reason, idempotencyKey) -> { balance, replayed }
 * Throws with err.status=402 on insufficient funds (mirrors the main
 * backend's own InsufficientFundsError -> 402 mapping) so callers can
 * distinguish "can't afford the buy-in" from a real infra failure.
 */
async function spend(userId, amount, reason, idempotencyKey) {
  try {
    const res = await axios.post(`${baseUrl()}/api/economy/spend`,
      { userId, amount, reason, idempotencyKey },
      { headers: adminHeaders(), timeout: 8000 });
    return { balance: res.data.balance, replayed: !!res.data.replayed };
  } catch (e) {
    if (e.response && e.response.status === 402) {
      const err = new Error(e.response.data && e.response.data.error || 'insufficient Sparks');
      err.status = 402;
      throw err;
    }
    throw e;
  }
}

/** grant(userId, amount, reason, idempotencyKey) -> { balance, replayed } */
async function grant(userId, amount, reason, idempotencyKey) {
  const res = await axios.post(`${baseUrl()}/api/economy/grant`,
    { userId, amount, reason, idempotencyKey },
    { headers: adminHeaders(), timeout: 8000 });
  return { balance: res.data.balance, replayed: !!res.data.replayed };
}

module.exports = { getBalance, spend, grant };
