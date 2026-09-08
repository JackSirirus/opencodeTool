// Zero-dependency quota fetcher for the OpenCode Go plan usage API.
//
// Contract (mirrors opencode-data.js): getGoQuota() NEVER throws. It resolves with
//   { available: true,  fetchedAt, windows: { rolling, weekly, monthly }, lastGood? }
// or { available: false, reason, lastGood?, ... }
// where `reason` is ALWAYS exactly one of 4 stable strings (decision 19):
//   'no-credentials' | 'no-subscription' | 'network' | 'timeout'
// Diagnostic details (HTTP status, error messages) go to stderr only -- never into
// `reason` -- and the API key never appears in any return value or log line (G6).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const GO_AUTH_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

const CACHE_TTL_MS = 5 * 60 * 1000;   // success cache lifetime (force=true bypasses)
const BACKOFF_MS = 15 * 60 * 1000;    // pause after 3 consecutive transport failures
const FAIL_STREAK_LIMIT = 3;
const MTIME_DEBOUNCE_MS = 30 * 1000;  // min spacing between auth.json mtime re-checks
const FETCH_TIMEOUT_MS = 10 * 1000;   // AbortController timeout for the HTTP call
const KEY_RETRY_DELAY_MS = 100;       // auth.json caught mid-write -> retry once

// ---------------------------------------------------------------------------
// State (held by the caller -- e.g. widget main.js -- across polling cycles)
// ---------------------------------------------------------------------------

export function createQuotaState() {
  return {
    cache: null,           // { authPath, at, value } -- last successful fetch
    inflight: null,        // { authPath, promise } -- single-flight lock
    failStreak: 0,         // consecutive network/timeout failures
    backoffUntil: 0,       // epoch ms; auto calls short-circuit while now() < this
    lastFailReason: null,  // reason of most recent failure (reused for backoff responses)
    dormant: false,        // set on 401/403; auto-polling stops until auth.json changes
    dormantReason: null,
    mtimeSeen: false,      // false until the first auth.json stat observation
    lastMtimeMs: null,     // last observed auth.json mtimeMs (null = file missing)
    mtimeDebounceUntil: 0, // epoch ms; mtime re-checks are debounced to 30s
    lastGood: null,        // { windows, fetchedAt } -- last success, for UI "上次成功"
  };
}

// Shared fallback so bare getGoQuota() calls still get single-flight + caching.
let shared = null;
function sharedState() {
  if (!shared) shared = createQuotaState();
  return shared;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** stderr detail logging with key redaction -- details NEVER go into `reason`. */
function logDetail(reason, err, key) {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  const safe = typeof key === 'string' && key ? raw.split(key).join('<redacted>') : raw;
  console.error(`[go-quota] ${reason}: ${safe}`);
}

/**
 * One read attempt of the Go API key from auth.json
 * ({"opencode-go":{"type":"api","key":"sk-..."}}). Read-only, never writes.
 * Returns the key string, null when the key is definitively absent, or
 * undefined when the file was caught mid-write (invalid JSON -> caller retries).
 */
function readKeyOnce(authPath) {
  let raw;
  try {
    raw = fs.readFileSync(authPath, 'utf8');
  } catch {
    return null; // missing or unreadable -> no credentials, no retry
  }
  try {
    const parsed = JSON.parse(raw);
    const entry = parsed && typeof parsed === 'object' ? parsed['opencode-go'] : undefined;
    const key = entry && typeof entry === 'object' ? entry.key : undefined;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return undefined; // parse failure -- may be a partial write, retry once
  }
}

/** Resolve the API key; retry once after 100ms when JSON parsing failed. */
async function readAuthKey(authPath) {
  let key = readKeyOnce(authPath);
  if (key === undefined) {
    await sleep(KEY_RETRY_DELAY_MS);
    key = readKeyOnce(authPath);
  }
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Track auth.json mtime. Returns true exactly when the file changed since the
 * previous observation AND the 30s debounce window allows acting on it.
 * The very first observation only records the baseline (never a "change");
 * changes observed during a debounce window are swallowed until it passes.
 */
function observeAuthMtime(st, authPath, t) {
  let mtime = null;
  try {
    mtime = fs.statSync(authPath).mtimeMs;
  } catch {
    mtime = null; // file missing
  }
  const first = !st.mtimeSeen;
  const prev = st.lastMtimeMs;
  st.mtimeSeen = true;
  st.lastMtimeMs = mtime;
  if (first || mtime === prev) return false;
  if (t < st.mtimeDebounceUntil) return false;
  st.mtimeDebounceUntil = t + MTIME_DEBOUNCE_MS;
  return true;
}

function parseWindow(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) {
    return null;
  }
  return {
    status: typeof raw.status === 'string' ? raw.status : 'ok',
    percent: Math.max(0, Math.min(100, raw.percent)), // decision 24: clamp to 0..100
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  };
}

/** Returns { rolling, weekly, monthly } or null when the body is malformed. */
function parseUsageWindows(body) {
  const usage = body && typeof body === 'object' ? body.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const rolling = parseWindow(usage.rolling);
  const weekly = parseWindow(usage.weekly);
  const monthly = parseWindow(usage.monthly);
  return rolling && weekly && monthly ? { rolling, weekly, monthly } : null;
}

/**
 * One HTTP round trip. Maps every outcome into the 4-value error taxonomy:
 *   401 -> no-credentials, 403 -> no-subscription,
 *   throw / non-200 (incl. 5xx, 429) / malformed body -> network,
 *   AbortError -> timeout.
 */
async function fetchQuota(fetchFn, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(GO_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : 'network';
    logDetail(reason, err, key);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }

  if (!res || typeof res.status !== 'number') {
    logDetail('network', new Error('fetchFn did not return a Response-like object'), key);
    return { ok: false, reason: 'network' };
  }
  if (res.status === 401) return { ok: false, reason: 'no-credentials' };
  if (res.status === 403) return { ok: false, reason: 'no-subscription' };
  if (res.status !== 200) {
    logDetail('network', new Error(`HTTP ${res.status} from ${GO_USAGE_URL}`), key);
    return { ok: false, reason: 'network' };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    logDetail('network', err, key);
    return { ok: false, reason: 'network' };
  }
  const windows = parseUsageWindows(body);
  if (!windows) {
    logDetail('network', new Error('malformed usage body (missing usage.rolling/weekly/monthly)'), key);
    return { ok: false, reason: 'network' };
  }
  return { ok: true, windows };
}

/** Apply a raw fetch outcome to the state machine; build the caller-facing result. */
function applyResult(st, raw, t, authPath) {
  if (raw.ok) {
    const value = { available: true, fetchedAt: new Date(t).toISOString(), windows: raw.windows };
    st.failStreak = 0;
    st.backoffUntil = 0;
    st.dormant = false;
    st.dormantReason = null;
    st.cache = { authPath, at: t, value };
    st.lastGood = { windows: raw.windows, fetchedAt: value.fetchedAt };
    return { ...value, lastGood: st.lastGood };
  }

  const reason = raw.reason;
  const result = { available: false, reason, ...(st.lastGood ? { lastGood: st.lastGood } : {}) };
  if (reason === 'no-credentials' || reason === 'no-subscription') {
    // Credential problem: go dormant and wait for auth.json to change (mtime re-check).
    st.dormant = true;
    st.dormantReason = reason;
    st.failStreak = 0;
    st.lastFailReason = reason;
  } else {
    st.failStreak += 1;
    st.lastFailReason = reason;
    if (st.failStreak >= FAIL_STREAK_LIMIT) {
      st.backoffUntil = t + BACKOFF_MS;
      st.failStreak = 0;
    } else {
      st.backoffUntil = 0; // fresh streak: any earlier backoff no longer applies
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Go plan quota. All dependencies are injectable for tests:
 *   fetchFn  -- HTTP fetch (default globalThis.fetch)
 *   authPath -- auth.json location (default GO_AUTH_PATH); read-only access
 *   now      -- clock, returns epoch ms (default Date.now) for TTL/backoff tests
 *   force    -- bypass cache, dormant and backoff short-circuits (manual refresh)
 *   state    -- state object from createQuotaState(); omit to use a shared default
 */
export async function getGoQuota({
  fetchFn = globalThis.fetch,
  authPath = GO_AUTH_PATH,
  now = Date.now,
  force = false,
  state,
} = {}) {
  try {
    return await getGoQuotaInner({ fetchFn, authPath, now, force, state });
  } catch (err) {
    // Contract guard: this module never throws (should be unreachable).
    logDetail('network', err, null);
    return { available: false, reason: 'network' };
  }
}

async function getGoQuotaInner({ fetchFn, authPath, now, force, state }) {
  const st = state ?? sharedState();
  const t = now();

  // 1. auth.json mtime tracking (drives dormant re-checks, 30s debounce)
  const authChanged = observeAuthMtime(st, authPath, t);

  // 2. key hygiene gate: no key -> never hit the network
  const key = await readAuthKey(authPath);
  if (!key) {
    return { available: false, reason: 'no-credentials', ...(st.lastGood ? { lastGood: st.lastGood } : {}) };
  }

  if (authChanged) {
    // Key file changed: one fresh re-check; cached results for the old key are invalid.
    st.dormant = false;
    st.dormantReason = null;
    st.cache = null;
  }

  // 3. dormant: 401/403 put us to sleep; auto calls only wake on authChanged above
  if (!force && st.dormant) {
    return {
      available: false,
      reason: st.dormantReason ?? 'no-credentials',
      dormant: true,
      ...(st.lastGood ? { lastGood: st.lastGood } : {}),
    };
  }

  // 4. success cache (5 min)
  if (!force && st.cache && st.cache.authPath === authPath && t - st.cache.at < CACHE_TTL_MS) {
    return { ...st.cache.value, ...(st.lastGood ? { lastGood: st.lastGood } : {}) };
  }

  // 5. backoff after 3 consecutive transport failures (15 min)
  if (!force && t < st.backoffUntil) {
    return {
      available: false,
      reason: st.lastFailReason ?? 'network',
      backoffUntil: st.backoffUntil,
      ...(st.lastGood ? { lastGood: st.lastGood } : {}),
    };
  }

  // 6. single-flight: concurrent calls reuse the in-flight request
  if (!force && st.inflight && st.inflight.authPath === authPath) {
    return st.inflight.promise;
  }

  let promise;
  promise = (async () => {
    try {
      const raw = await fetchQuota(fetchFn, key);
      return applyResult(st, raw, now(), authPath);
    } finally {
      if (st.inflight && st.inflight.promise === promise) st.inflight = null;
    }
  })();
  st.inflight = { authPath, promise };
  return promise;
}
