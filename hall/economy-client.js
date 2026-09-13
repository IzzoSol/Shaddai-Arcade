'use strict';
/**
 * hall/economy-client.js — thin server-to-server client for the main
 * Shaddai backend's Sparks ledger (backend/economy-routes.js), added this
 * session as Shaddai-Arcade issue #1: GET /balance, POST /grant were
 * already live; POST /spend was the missing leg, now added.
 *
 * SECURITY: SHADDAI_ADMIN_TOKEN is a server-to-server credential and must
 * NEVER reach this repo's browser client -- this module is backend-only.
 * Calling any function here with it unset fails closed with a clear error
 * rather than silently no-op'ing (a silent no-op would be worse: a buy-in
 * that "succeeds" without actually debiting anyone).
 *
 * PIKADON pass (issue #3) is DONE as of the main backend's commit 8464785:
 * economy-routes.js now also accepts a narrower ARCADE_SERVICE_TOKEN
 * alongside the master ADMIN_TOKEN. Set THIS repo's SHADDAI_ADMIN_TOKEN env
 * var to that scoped ARCADE_SERVICE_TOKEN value (a Render dashboard action
 * on both services, not a code change) -- despite the variable's name here,
 * it should hold the scoped token, NOT the main backend's actual master
 * ADMIN_TOKEN, so a compromise of this public repo's deploy can't reach
 * anything outside the Sparks ledger + Lens.
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
