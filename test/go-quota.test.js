// Tests for src/lib/go-quota.js -- zero dependencies (node:test + node:assert/strict).
// All HTTP traffic is faked via an injected fetchFn (no real network calls) and
// auth.json fixtures live under os.tmpdir(). The real ~/.local/share/opencode/auth.json
// is only ever used read-only by production code -- tests never touch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getGoQuota, createQuotaState, GO_USAGE_URL, GO_AUTH_PATH } from '../src/lib/go-quota.js';

const DEFAULT_KEY = 'sk-test-go-quota-0001';
const HYGIENE_KEY = 'sk-hygiene-DO-NOT-LOG-777';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Temp dir with an auth.json containing the given (fake) key. */
function makeTempAuth(key = DEFAULT_KEY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-quota-test-'));
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ 'opencode-go': { type: 'api', key } }));
  return { authPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function okBody(overrides = {}) {
  return {
    usage: {
      rolling: { status: 'ok', percent: 42, resetsAt: '2026-09-08T00:00:00.000Z' },
      weekly: { status: 'ok', percent: 10, resetsAt: '2026-09-14T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 5, resetsAt: '2026-10-01T00:00:00.000Z' },
      ...overrides,
    },
  };
}

/** Injectable clock for time-dependent tests (cache TTL, backoff, debounce). */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

/** Run getGoQuota with a fresh state and assert the failure reason. */
async function expectReason(fetchFn, authPath, expectedReason) {
  const r = await getGoQuota({ fetchFn, authPath, state: createQuotaState() });
  assert.equal(r.available, false);
  assert.equal(r.reason, expectedReason);
  return r;
}

// ---------------------------------------------------------------------------
// Error taxonomy mapping (reason is always one of 4 stable strings)
// ---------------------------------------------------------------------------

test('error mapping: HTTP 401 -> reason "no-credentials"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => jsonResponse(401, { error: 'unauthorized' }), authPath, 'no-credentials');
  } finally { cleanup(); }
});

test('error mapping: HTTP 403 -> reason "no-subscription"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => jsonResponse(403, { error: 'forbidden' }), authPath, 'no-subscription');
  } finally { cleanup(); }
});

test('error mapping: fetchFn throws -> reason "network"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => { throw new Error('ECONNRESET'); }, authPath, 'network');
  } finally { cleanup(); }
});

test('error mapping: HTTP 500 -> reason "network"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => jsonResponse(500, { error: 'boom' }), authPath, 'network');
  } finally { cleanup(); }
});

test('error mapping: HTTP 429 -> reason "network"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => jsonResponse(429, { error: 'slow down' }), authPath, 'network');
  } finally { cleanup(); }
});

test('error mapping: 200 but malformed body (missing usage.rolling) -> reason "network"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    await expectReason(async () => jsonResponse(200, { usage: {} }), authPath, 'network');
  } finally { cleanup(); }
});

test('error mapping: AbortError from fetchFn -> reason "timeout"', async () => {
  const { authPath, cleanup } = makeTempAuth();
  try {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    await expectReason(async () => { throw abortErr; }, authPath, 'timeout');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Cache / backoff / single-flight
// ---------------------------------------------------------------------------

test('cache: repeated calls within 5min hit cache; force and TTL expiry trigger refetch', async () => {
  const clock = makeClock();
  const { authPath, cleanup } = makeTempAuth();
  let calls = 0;
  const fetchFn = async () => { calls += 1; return jsonResponse(200, okBody()); };
  const state = createQuotaState();
  try {
    const r1 = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(r1.available, true);

    const r2 = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(r2.available, true);
    assert.deepEqual(r2.windows, r1.windows);
    assert.equal(calls, 1); // served from cache

    await getGoQuota({ fetchFn, authPath, state, now: clock.now, force: true });
    assert.equal(calls, 2); // force bypasses cache

    clock.advance(5 * 60 * 1000 + 1); // TTL expired
    await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(calls, 3);
  } finally { cleanup(); }
});

test('backoff: 3 consecutive failures -> 4th call blocked within 15min, allowed after', async () => {
  const clock = makeClock();
  const { authPath, cleanup } = makeTempAuth();
  let calls = 0;
  const fetchFn = async () => { calls += 1; return jsonResponse(500, {}); };
  const state = createQuotaState();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
      assert.equal(r.reason, 'network');
    }
    assert.equal(calls, 3);

    // within the 15min backoff window: rejected without hitting fetchFn
    const blocked = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(blocked.available, false);
    assert.equal(blocked.reason, 'network');
    assert.equal(calls, 3);

    clock.advance(15 * 60 * 1000); // backoff elapsed
    const again = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(again.available, false);
    assert.equal(again.reason, 'network');
    assert.equal(calls, 4); // allowed to fetch again
  } finally { cleanup(); }
});

test('single-flight: 3 concurrent calls share one fetch; Bearer header + URL correct', async () => {
  const { authPath, cleanup } = makeTempAuth();
  let calls = 0;
  let lastUrl = null;
  let lastOpts = null;
  const fetchFn = async (url, opts) => {
    calls += 1;
    lastUrl = url;
    lastOpts = opts;
    await sleep(25); // keep the request in-flight while the others join
    return jsonResponse(200, okBody());
  };
  const state = createQuotaState();
  try {
    const results = await Promise.all([
      getGoQuota({ fetchFn, authPath, state }),
      getGoQuota({ fetchFn, authPath, state }),
      getGoQuota({ fetchFn, authPath, state }),
    ]);
    assert.equal(calls, 1);
    assert.equal(lastUrl, GO_USAGE_URL);
    assert.equal(lastOpts.headers.Authorization, `Bearer ${DEFAULT_KEY}`);
    for (const r of results) assert.equal(r.available, true);
    assert.equal(results[0].windows.rolling.percent, 42);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Dormant + mtime re-check
// ---------------------------------------------------------------------------

test('dormant: 403 stops auto-polling; mtime change triggers exactly one re-check', async () => {
  const { authPath, cleanup } = makeTempAuth();
  let calls = 0;
  const fetchFn = async () => { calls += 1; return jsonResponse(403, {}); };
  const state = createQuotaState();
  try {
    const r1 = await getGoQuota({ fetchFn, authPath, state });
    assert.equal(r1.available, false);
    assert.equal(r1.reason, 'no-subscription');
    assert.equal(calls, 1);

    // auto call while dormant: no fetch at all
    const r2 = await getGoQuota({ fetchFn, authPath, state });
    assert.equal(r2.available, false);
    assert.equal(r2.reason, 'no-subscription');
    assert.equal(r2.dormant, true);
    assert.equal(calls, 1);

    // touch auth.json -> mtime change -> exactly one re-check
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(authPath, future, future);
    const r3 = await getGoQuota({ fetchFn, authPath, state });
    assert.equal(r3.available, false);
    assert.equal(r3.reason, 'no-subscription');
    assert.equal(calls, 2);

    // still dormant afterwards: no further fetch without another mtime change
    const r4 = await getGoQuota({ fetchFn, authPath, state });
    assert.equal(r4.available, false);
    assert.equal(calls, 2);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------

test('key hygiene: API key never appears in return values or stderr logs', async () => {
  const { authPath, cleanup } = makeTempAuth(HYGIENE_KEY);
  const origError = console.error;
  let logged = '';
  console.error = (...args) => { logged += args.join(' '); };
  try {
    // success path
    const ok = await getGoQuota({
      fetchFn: async () => jsonResponse(200, okBody()),
      authPath,
      state: createQuotaState(),
    });
    assert.equal(ok.available, true);
    assert.equal(JSON.stringify(ok).includes(HYGIENE_KEY), false);

    // failure path where the thrown error message contains the key
    const bad = await getGoQuota({
      fetchFn: async () => { throw new Error(`socket hangup during ${HYGIENE_KEY} call`); },
      authPath,
      state: createQuotaState(),
    });
    assert.equal(bad.available, false);
    assert.equal(bad.reason, 'network');
    assert.equal(JSON.stringify(bad).includes(HYGIENE_KEY), false);

    // stderr details are key-redacted too
    assert.ok(logged.includes('<redacted>'), 'stderr should contain redaction marker');
    assert.equal(logged.includes(HYGIENE_KEY), false);
  } finally {
    console.error = origError;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Response shape + clamping + key-file edge cases
// ---------------------------------------------------------------------------

test('success shape: windows parsed, percent clamped to 0..100, fetchedAt from injected clock', async () => {
  const clock = makeClock(1_700_000_000_000);
  const { authPath, cleanup } = makeTempAuth();
  const fetchFn = async () => jsonResponse(200, okBody({
    rolling: { status: 'rate-limited', percent: 137.5, resetsAt: '2026-09-08T00:00:00.000Z' },
    weekly: { status: 'ok', percent: -5, resetsAt: '2026-09-14T00:00:00.000Z' },
  }));
  try {
    const r = await getGoQuota({ fetchFn, authPath, state: createQuotaState(), now: clock.now });
    assert.equal(r.available, true);
    assert.equal(r.fetchedAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(r.windows.rolling, { status: 'rate-limited', percent: 100, resetsAt: '2026-09-08T00:00:00.000Z' });
    assert.equal(r.windows.weekly.percent, 0);
    assert.equal(r.windows.monthly.percent, 5);
    assert.deepEqual(r.lastGood.windows, r.windows); // lastGood retained for UI
  } finally { cleanup(); }
});

test('missing auth.json -> reason "no-credentials", network never touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-quota-test-'));
  const authPath = path.join(dir, 'does-not-exist.json');
  let calls = 0;
  const fetchFn = async () => { calls += 1; return jsonResponse(200, okBody()); };
  try {
    await expectReason(fetchFn, authPath, 'no-credentials');
    assert.equal(calls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed auth.json -> retried once, then reason "no-credentials", network never touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-quota-test-'));
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, '{"opencode-go": {"key": '); // caught mid-write
  let calls = 0;
  const fetchFn = async () => { calls += 1; return jsonResponse(200, okBody()); };
  try {
    const r = await getGoQuota({ fetchFn, authPath, state: createQuotaState() });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'no-credentials');
    assert.equal(calls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('constants: GO_USAGE_URL and GO_AUTH_PATH are exported correctly', () => {
  assert.equal(GO_USAGE_URL, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(typeof GO_AUTH_PATH, 'string');
  assert.ok(GO_AUTH_PATH.endsWith('auth.json'));
  assert.ok(GO_AUTH_PATH.includes(path.join('.local', 'share', 'opencode')));
});

test('force bypasses backoff: blocked auto call, then forced fetch runs', async () => {
  const clock = makeClock();
  const { authPath, cleanup } = makeTempAuth();
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new Error('EAI_AGAIN'); };
  const state = createQuotaState();
  try {
    for (let i = 0; i < 3; i++) {
      await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    }
    assert.equal(calls, 3);

    const blocked = await getGoQuota({ fetchFn, authPath, state, now: clock.now });
    assert.equal(blocked.reason, 'network');
    assert.equal(calls, 3); // backoff active

    const forced = await getGoQuota({ fetchFn, authPath, state, now: clock.now, force: true });
    assert.equal(forced.available, false);
    assert.equal(forced.reason, 'network');
    assert.equal(calls, 4); // force ignores backoff
  } finally { cleanup(); }
});

test('default shared state: concurrent bare calls still single-flight', async () => {
  const { authPath, cleanup } = makeTempAuth('sk-default-state-key-1');
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    await sleep(10);
    return jsonResponse(200, okBody());
  };
  try {
    const results = await Promise.all([
      getGoQuota({ fetchFn, authPath }),
      getGoQuota({ fetchFn, authPath }),
      getGoQuota({ fetchFn, authPath }),
    ]);
    assert.equal(calls, 1);
    for (const r of results) assert.equal(r.available, true);
  } finally { cleanup(); }
});
