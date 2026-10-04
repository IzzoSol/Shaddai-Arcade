'use strict';
/**
 * hall/writer-client.js — the writer model for the Hall's first `generative`
 * pack (hall/packs/booth.js, Shaddai-Arcade issue #11).
 *
 * WHY A SEPARATE CLIENT (read before "simplifying" this into lens-client.js):
 * hall/lens-client.js talks to the main backend's LENS route, but LENS is the
 * VIDEO generator -- it takes a locked {SCENE_LOCK, CAST_LOCK, EVENT, LAW,
 * DURATION} contract built by backend/lib/lens-rewriter.js and hands it to
 * Fal. It accepts no prose and returns no prose. Booth needs the opposite
 * capability: raw bars from a writer model. So this is a separate client,
 * shaped like the other two (hall/economy-client.js, hall/skillplay-client.js):
 * same base URL, same admin-token header, same explicit-status errors.
 *
 * TARGET ENDPOINT: POST {SHADDAI_MAIN_BACKEND_URL}/api/groq, whose real
 * request shape was read from the main repo's backend/api-proxy-routes.js
 * (`{ messages, max_tokens, model, apiKey }` -> OpenAI-style
 * `{ choices: [{ message: { content } }] }`). Two deliberate choices:
 *   - We NEVER send `apiKey`. That field lets a caller supply their own Groq
 *     key; Royale must not carry or forward one. The backend falls back to
 *     its own env GROQ_API_KEY when the field is absent, which is the only
 *     path we use. PIKADON should read this as the credential boundary.
 *   - We ask for JSON only and never trust it: parse defensively, drop any
 *     bar that is not a string, and fall back to SEEDED_BARS rather than
 *     letting a malformed completion break a match.
 *
 * CONTENT SAFETY: seeded bars are clean by construction, and generated bars
 * are length-capped (MAX_BAR_CHARS) and stripped of control characters. The
 * cast stays original-only -- 'Player (red beanie)' and 'Gunner' are the two
 * booth characters, both already in the main repo's CAST_LOCK
 * (backend/lib/lens-rewriter.js). No real names or likenesses, ever.
 *
 * ⏳ NOT WIRED YET: this is an owner action item, the same shape
 * SHADDAI_GAMES_URL was for issue #10 -- see docs/HALL-BOOTH-PACK.md.
 */

const axios = require('axios');

const MAX_BAR_CHARS = 240;
const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

// Per-strategy judging emphasis. Mirrors booth.js's STRATEGY weights -- kept
// here so the writer's own prompt asks for the bar the strategy actually
// needs (a "flip" that reads like a "story" gets scored badly and feels bad).
const STRATEGY_BRIEF = {
  punch: 'a short, hard, direct hit on the weakest claim in their last line. No setup.',
  flip: "their own words turned back on them. Quote-and-reverse is fine; be specific.",
  story: 'a short narrative that reframes the whole round in your favour. Needs cadence, not a jab.',
};

const SEED_LINES = Object.freeze({
  punch: [
    'You rehearsed that line, not lived it.',
    'Cool posture, no receipts.',
    'Every bar you wrote is about being good.',
    'You brought a metaphor to a footrace.',
    'That took you all week and it still missed.',
  ],
  flip: [
    'You called it a come-up, so why are you still here?',
    'You said "own the room" — the room left.',
    'You called yourself honest, so explain the flinch.',
    'You said "no shortcuts" and rushed the whole verse.',
  ],
  story: [
    'I was mid when you were loading a template.',
    'You practised a victory lap before the first bar.',
    'You measured the fall so carefully it never left the ground.',
    'I built the thing you keep claiming to have built.',
  ],
});

function baseUrl() {
  const url = process.env.SHADDAI_MAIN_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

function adminHeaders() {
  const token = process.env.SHADDAI_ADMIN_TOKEN;
  if (!token) throw new Error('SHADDAI_ADMIN_TOKEN not configured -- refusing to call the writer without it');
  return { 'x-admin-token': token, 'Content-Type': 'application/json' };
}

/** Strip control chars and cap length. Generated text is untrusted input. */
function sanitizeBar(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_BAR_CHARS ? clean.slice(0, MAX_BAR_CHARS - 1).trimEnd() + '…' : clean;
}

function buildPrompt(strategies, count, opponentLine) {
  const keys = Object.keys(STRATEGY_BRIEF).filter((k) => strategies.includes(k));
  const spec = keys.map((k) => `  "${k}": ${count} bar(s) — ${STRATEGY_BRIEF[k]}`).join('\n');
  return [
    'You write clean, competitive rap-battle bars for a game. Hard and clever, never cruel.',
    'No slurs. No threats. No real people, brands, or likenesses. No self-reference to AI.',
    `The opponent just said: "${String(opponentLine || '').slice(0, 200)}"`,
    'Each bar must directly answer THAT line.',
    '',
    'Return ONLY a JSON object, no markdown fence, no preamble, shaped exactly:',
    '{ "bars": [ { "strategy": "punch|flip|story", "text": "...", "content": 0-10, "cadence": 0-10, "rebound": 0-10 } ] }',
    '',
    'content/cadence/rebound are the judge rubric: content = how well it answers them,',
    'cadence = rhythm and flow, rebound = how hard it sets up your NEXT bar.',
    '',
    `Write this many bars per strategy:\n${spec}`,
  ].join('\n');
}

/**
 * parseCompletion(content) -> [{ strategy, text, content, cadence, rebound }] | []
 * Defensive by design: an LLM returning prose, a fenced block, a bare array, or
 * half-JSON must never throw into a live match. Returns [] on anything it
 * can't trust, and the caller falls back to seeded bars.
 */
function parseCompletion(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  let text = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bars) ? parsed.bars : null);
  if (!list) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const strategy = String(item.strategy || '').trim();
    if (!STRATEGY_BRIEF[strategy]) continue;
    const bar = sanitizeBar(item.text);
    if (!bar) continue;
    const num = (v) => Math.max(0, Math.min(10, Number(v) || 0));
    out.push({ strategy, text: bar, content: num(item.content), cadence: num(item.cadence), rebound: num(item.rebound) });
  }
  return out;
}

/** Deterministic fallback content, so booth is always playable. */
function seededBars(strategies, count, opponentLine) {
  const seed = sanitizeBar(opponentLine) || 'you had the whole night and still said nothing.';
  const out = [];
  for (const s of strategies) {
    const pool = SEED_LINES[s] || [];
    for (let i = 0; i < count; i++) {
      // Base the line on what the opponent actually said, then rotate the
      // stock closers so bars don't repeat verbatim within one match.
      out.push({
        strategy: s,
        text: i % 2 === 0 ? pool[i % pool.length] : `${pool[i % pool.length]} You said "${seed}" and moved on.`,
        content: 5 + ((i * 3) % 5),
        cadence: 5 + ((i * 2) % 5),
        rebound: 4 + ((i * 5) % 6),
      });
    }
  }
  return out;
}

/**
 * composeBards({ strategies, count, opponentLine })
 *   -> { bars, source: 'llm'|'seeded', truncated: boolean }
 * Never throws for content problems — a match must always get bars. Throws
 * only for missing admin-token config (same fail-closed posture as
 * hall/lens-client.js: a missing credential is an operator error, not
 * something to paper over with fake content).
 */
async function composeBards({ strategies, count, opponentLine } = {}) {
  const rails = Array.isArray(strategies) && strategies.length ? strategies : Object.keys(STRATEGY_BRIEF);
  const per = Math.max(1, Number(count) || 3);

  const url = baseUrl();
  if (!url) {
    return { bars: seededBars(rails, per, opponentLine), source: 'seeded', truncated: false };
  }

  let bars = [];
  try {
    const res = await axios.post(`${url}/api/groq`, {
      messages: [
        { role: 'system', content: 'You are a precise rap-battle writer. You always reply with raw JSON and nothing else.' },
        { role: 'user', content: buildPrompt(rails, per, opponentLine) },
      ],
      max_tokens: DEFAULT_MAX_TOKENS,
      model: DEFAULT_MODEL,
      // apiKey deliberately omitted — see header comment.
    }, { headers: adminHeaders(), timeout: 25000 });

    const content = res.data && res.data.choices && res.data.choices[0]
      && res.data.choices[0].message && res.data.choices[0].message.content;
    bars = parseCompletion(content);
  } catch (e) {
    // Network/provider trouble is not fatal to a match; fall through to seed.
    bars = [];
  }

  if (!bars.length) {
    return { bars: seededBars(rails, per, opponentLine), source: 'seeded', truncated: false };
  }

  // Guarantee every strategy on the rail has at least one usable bar, so a
  // partial completion can never leave a button unplayable.
  let truncated = false;
  for (const s of rails) {
    const have = bars.filter((b) => b.strategy === s).length;
    if (have === 0) {
      truncated = true;
      bars.push(...seededBars([s], 1, opponentLine));
    }
  }
  return { bars, source: 'llm', truncated };
}

module.exports = { composeBards, parseCompletion, sanitizeBar, buildPrompt, SEED_LINES, STRATEGY_BRIEF, MAX_BAR_CHARS };