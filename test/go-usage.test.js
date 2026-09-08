// Tests for src/lib/go-usage.js -- zero dependencies (node:test + node:assert).
// Fixtures live in temp SQLite DBs under os.tmpdir(); the real opencode DB is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getGoUsage, GO_PROVIDER_ID, DB_PATH } from '../src/lib/go-usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const H = 3600 * 1000;

/** Assert two floats are equal within float-error tolerance. */
function assertNear(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''}expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  cost REAL DEFAULT 0,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tokens_reasoning INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0,
  tokens_cache_write INTEGER DEFAULT 0,
  time_updated INTEGER,
  model TEXT
);
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL,
  name TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  data TEXT
);
`;

function localDayStart(offsetDays = 0) {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return base + offsetDays * DAY_MS;
}

function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makeTempDb() {
  const dbPath = path.join(os.tmpdir(), `go-usage-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`);
  return {
    dbPath,
    db,
    insert,
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suffix);
        } catch {
          // ignore
        }
      }
    },
  };
}

/** Serialize one synthetic go assistant message row (mirrors the probed real structure). */
function goMessageRow({ modelID = 'deepseek-v4-pro', tokens = {}, cost = 0, created, providerID = GO_PROVIDER_ID, role = 'assistant' } = {}) {
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const reasoning = tokens.reasoning ?? 0;
  const read = tokens.cache?.read ?? 0;
  const write = tokens.cache?.write ?? 0;
  return JSON.stringify({
    parentID: 'msg_parent',
    role,
    mode: 'build',
    agent: 'build',
    variant: 'test',
    path: { cwd: 'D:/proj', root: 'D:/' },
    cost,
    tokens: {
      total: tokens.total ?? input + output + reasoning + read + write,
      input,
      output,
      reasoning,
      cache: { read, write },
    },
    modelID,
    providerID,
    time: created == null ? {} : { created, completed: created + 1000 },
    finish: 'stop',
  });
}

/**
 * Standard fixture (see expectations inline). Returns makeTempDb() handle.
 *
 * today (3 go rows):      g1 pro $0.20 (in 1000/out 100/r 50/cache 8000/100, total 9250),
 *                         g2 flash $0.01 (in 200/out 20, total 220), g8 unknown $0.001 (in 10/out 1, total 11)
 * yesterday (1):          g3 pro $0.10 (in 500/out 50/cache 1500/250, total 2300)
 * 6 days ago (1):         g4 pro $0.05 (in 400/out 40, total 440)
 * 30 days ago (1):        g5 grok-code $1.00 (in 10000/out 1000/r 200/cache 5000/1000, total 17200)
 * bad JSON (1):           g6 truncated JSON (contains the LIKE patterns but unparseable) -> skippedRows
 * other provider (1):     g7 providerID "opencode" $9.99 -> filtered out
 * timeless (1):           g9 pro, time:{} $0 (in 7, total 7) -> allTime/byModel only
 */
function makeGoFixture() {
  const f = makeTempDb();
  const today = localDayStart(0);

  const rows = [
    ['g1', goMessageRow({ created: today + 1 * H, cost: 0.2, tokens: { input: 1000, output: 100, reasoning: 50, cache: { read: 8000, write: 100 } } })],
    ['g2', goMessageRow({ created: today + 2 * H, modelID: 'deepseek-v4-flash', cost: 0.01, tokens: { input: 200, output: 20 } })],
    ['g3', goMessageRow({ created: today - DAY_MS + 5 * H, cost: 0.1, tokens: { input: 500, output: 50, cache: { read: 1500, write: 250 } } })],
    ['g4', goMessageRow({ created: today - 6 * DAY_MS + 5 * H, cost: 0.05, tokens: { input: 400, output: 40 } })],
    ['g5', goMessageRow({ created: today - 30 * DAY_MS, modelID: 'grok-code', cost: 1.0, tokens: { input: 10000, output: 1000, reasoning: 200, cache: { read: 5000, write: 1000 } } })],
    // Truncated JSON: passes the SQL LIKE pre-filter (contains both patterns) but fails JSON.parse.
    ['g6', '{"role":"assistant","providerID":"opencode-go","cost":0.5,"tokens":{"input":50'],
    ['g7', goMessageRow({ created: today + 3 * H, providerID: 'opencode', modelID: 'claude-x', cost: 9.99, tokens: { input: 999 } })],
    ['g8', goMessageRow({ created: today + 4 * H, modelID: null, cost: 0.001, tokens: { input: 10, output: 1 } })],
    ['g9', goMessageRow({ created: null, cost: 0, tokens: { input: 7 } })],
  ];
  for (const [id, data] of rows) f.insert.run(id, 'ses-1', data);

  return f;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('exports DB_PATH and the hardcoded GO_PROVIDER_ID', () => {
  assert.equal(DB_PATH, path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'));
  assert.equal(GO_PROVIDER_ID, 'opencode-go');
  assert.equal(typeof getGoUsage, 'function');
});

test('missing DB resolves with available:false, reason db-missing, zeroed structure, never throws', async () => {
  const summary = await getGoUsage({ dbPath: path.join(os.tmpdir(), 'definitely-not-here-go-12345.db') });
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'db-missing');
  assert.equal(summary.skippedRows, 0);
  for (const bucket of ['today', 'week', 'allTime']) {
    assert.equal(summary[bucket].requests, 0);
    assert.equal(summary[bucket].cost, 0);
    assert.equal(summary[bucket].hitRateOfInput, null);
    assert.equal(summary[bucket].hitRateReadWrite, null);
  }
  assert.equal(summary.byDay.length, 7);
  assert.equal(summary.byModel.length, 0);
  for (const d of summary.byDay) {
    assert.equal(d.requests, 0);
    assert.equal(d.cost, 0);
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(!Number.isNaN(Date.parse(summary.generatedAt)));
});

test('unreadable/garbage DB file resolves with available:false, reason db-error', async () => {
  const p = path.join(os.tmpdir(), `go-usage-garbage-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(p, 'this is definitely not a sqlite database, just garbage bytes');
  try {
    const summary = await getGoUsage({ dbPath: p });
    assert.equal(summary.available, false);
    assert.equal(summary.reason, 'db-error');
    assert.equal(summary.allTime.requests, 0);
  } finally {
    fs.unlinkSync(p);
  }
});

test('empty DB (schema only) resolves with available:true and all zeros', async () => {
  const f = makeTempDb();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    assert.equal(summary.available, true);
    assert.equal(summary.skippedRows, 0);
    for (const bucket of ['today', 'week', 'allTime']) {
      assert.equal(summary[bucket].requests, 0);
      assert.equal(summary[bucket].cost, 0);
      assert.equal(summary[bucket].hitRateOfInput, null);
      assert.equal(summary[bucket].hitRateReadWrite, null);
    }
    assert.equal(summary.byDay.length, 7);
    assert.equal(summary.byModel.length, 0);
  } finally {
    f.cleanup();
  }
});

test('today bucket aggregates exactly the go assistant rows since local midnight', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    const t = summary.today;
    assert.equal(t.requests, 3); // g1 + g2 + g8 (g7 other provider, g9 timeless, g6 bad)
    assertNear(t.cost, 0.211); // 0.20 + 0.01 + 0.001
    assert.equal(t.tokens.input, 1210); // 1000 + 200 + 10
    assert.equal(t.tokens.output, 121); // 100 + 20 + 1
    assert.equal(t.tokens.reasoning, 50);
    assert.equal(t.tokens.cacheRead, 8000);
    assert.equal(t.tokens.cacheWrite, 100);
    assert.equal(t.tokens.total, 9481); // 9250 + 220 + 11
    assertNear(t.hitRateOfInput, 8000 / 9310);
    assertNear(t.hitRateReadWrite, 8000 / 8100);
  } finally {
    f.cleanup();
  }
});

test('week bucket spans the last N local days including today', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    const w = summary.week;
    assert.equal(w.requests, 5); // today(3) + g3 + g4; g5 (30d), g7, g9 excluded
    assertNear(w.cost, 0.361); // 0.211 + 0.10 + 0.05
    assert.equal(w.tokens.input, 2110); // 1210 + 500 + 400
    assert.equal(w.tokens.output, 211);
    assert.equal(w.tokens.cacheRead, 9500); // 8000 + 1500
    assert.equal(w.tokens.cacheWrite, 350); // 100 + 250
    assert.equal(w.tokens.total, 12221); // 9481 + 2300 + 440
  } finally {
    f.cleanup();
  }
});

test('allTime includes 30-days-ago and timeless rows, excludes other providers', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    const a = summary.allTime;
    assert.equal(a.requests, 7); // g1..g5, g8, g9 (g6 skipped, g7 filtered)
    assertNear(a.cost, 1.361); // 0.361 + 1.00 + 0
    assert.equal(a.tokens.input, 12117); // 2110 + 10000 + 7
    assert.equal(a.tokens.output, 1211);
    assert.equal(a.tokens.reasoning, 250); // 50 + 200
    assert.equal(a.tokens.cacheRead, 14500); // 9500 + 5000
    assert.equal(a.tokens.cacheWrite, 1350); // 350 + 1000
    assert.equal(a.tokens.total, 29428);
    assertNear(a.hitRateOfInput, 14500 / 27967);
    assertNear(a.hitRateReadWrite, 14500 / 15850);
  } finally {
    f.cleanup();
  }
});

test('byDay is ascending, zero-filled, length = days, correct per-day math', async () => {
  const f = makeGoFixture();
  try {
    const today = localDayStart(0);
    const summary = await getGoUsage({ dbPath: f.dbPath });
    const byDay = summary.byDay;
    assert.equal(byDay.length, 7);

    const expectedKeys = [];
    for (let i = 6; i >= 0; i--) expectedKeys.push(localDateKey(today - i * DAY_MS));
    assert.deepEqual(byDay.map((d) => d.date), expectedKeys);

    // middle days zero-filled
    assert.deepEqual(byDay[1], { date: expectedKeys[1], requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });

    // 6 days ago: g4
    assert.equal(byDay[0].requests, 1);
    assertNear(byDay[0].cost, 0.05);
    assert.equal(byDay[0].tokens.input, 400);
    assert.equal(byDay[0].tokens.output, 40);

    // yesterday: g3
    assert.equal(byDay[5].requests, 1);
    assertNear(byDay[5].cost, 0.1);
    assert.equal(byDay[5].tokens.cacheRead, 1500);

    // today: g1, g2, g8
    assert.equal(byDay[6].requests, 3);
    assertNear(byDay[6].cost, 0.211);
    assert.equal(byDay[6].tokens.input, 1210);
    assert.equal(byDay[6].tokens.output, 121);
  } finally {
    f.cleanup();
  }
});

test('days option changes week window and byDay length, allTime unaffected', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath, days: 3 });
    assert.equal(summary.byDay.length, 3);
    assert.equal(summary.week.requests, 4); // today(3) + g3; g4 (6d ago) now outside
    assertNear(summary.week.cost, 0.311); // 0.211 + 0.10
    assert.equal(summary.allTime.requests, 7); // allTime unaffected
    assert.equal(summary.byDay[2].requests, 3); // today is last element
  } finally {
    f.cleanup();
  }
});

test('malformed data row is skipped and counted in skippedRows', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    assert.equal(summary.skippedRows, 1); // g6
    // the skipped row contributed nothing anywhere
    assert.equal(summary.allTime.requests, 7);
  } finally {
    f.cleanup();
  }
});

test('rows from other providers are filtered out entirely', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    assert.equal(summary.byModel.find((m) => m.id === 'claude-x'), undefined);
    assertNear(summary.allTime.cost, 1.361); // not 11.351 (g7's $9.99 absent)
    assert.equal(summary.allTime.requests, 7);
  } finally {
    f.cleanup();
  }
});

test('byModel: all models, sorted desc by requests (cost tiebreak), unknown fallback, lastUsedAt', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    const ids = summary.byModel.map((m) => m.id);
    assert.deepEqual(ids, ['deepseek-v4-pro', 'grok-code', 'deepseek-v4-flash', 'unknown']);

    const pro = summary.byModel[0];
    assert.equal(pro.requests, 4); // g1 + g3 + g4 + g9
    assertNear(pro.cost, 0.35); // 0.20 + 0.10 + 0.05 + 0
    assert.equal(pro.tokens.input, 1907); // 1000 + 500 + 400 + 7
    assert.equal(pro.lastUsedAt, localDayStart(0) + 1 * H); // most recent = g1

    const grok = summary.byModel[1];
    assert.equal(grok.requests, 1);
    assertNear(grok.cost, 1.0);
    assert.equal(grok.lastUsedAt, localDayStart(0) - 30 * DAY_MS);

    const unknown = summary.byModel[3];
    assert.equal(unknown.requests, 1); // g8 (modelID null -> unknown)
    assertNear(unknown.cost, 0.001);
    assert.equal(unknown.lastUsedAt, localDayStart(0) + 4 * H);
  } finally {
    f.cleanup();
  }
});

test('hitRateReadWrite is null when cache read+write are both 0; hitRateOfInput is 0', async () => {
  const f = makeTempDb();
  try {
    f.insert.run('z1', 'ses-1', goMessageRow({ created: localDayStart(0) + 1000, cost: 0, tokens: { input: 100, output: 10 } }));
    const summary = await getGoUsage({ dbPath: f.dbPath });
    assert.equal(summary.allTime.requests, 1);
    assert.equal(summary.allTime.hitRateOfInput, 0); // 0 / 100
    assert.equal(summary.allTime.hitRateReadWrite, null); // 0 / 0
    assert.equal(summary.today.hitRateReadWrite, null);
    assert.equal(summary.allTime.cost, 0); // cost missing -> 0
  } finally {
    f.cleanup();
  }
});

test('summary has the exact contract shape (success and failure)', async () => {
  const f = makeGoFixture();
  try {
    const summary = await getGoUsage({ dbPath: f.dbPath });
    assert.deepEqual(Object.keys(summary).sort(), [
      'allTime',
      'available',
      'byDay',
      'byModel',
      'generatedAt',
      'skippedRows',
      'today',
      'week',
    ].sort());
    const bucketKeys = ['cost', 'hitRateOfInput', 'hitRateReadWrite', 'requests', 'tokens'].sort();
    const tokenKeys = ['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning', 'total'].sort();
    for (const bucket of ['today', 'week', 'allTime']) {
      assert.deepEqual(Object.keys(summary[bucket]).sort(), bucketKeys);
      assert.deepEqual(Object.keys(summary[bucket].tokens).sort(), tokenKeys);
      assert.equal(typeof summary[bucket].cost, 'number');
    }
    for (const d of summary.byDay) {
      assert.deepEqual(Object.keys(d).sort(), ['cost', 'date', 'requests', 'tokens'].sort());
      assert.deepEqual(Object.keys(d.tokens).sort(), tokenKeys);
    }
    for (const m of summary.byModel) {
      assert.deepEqual(Object.keys(m).sort(), ['cost', 'id', 'lastUsedAt', 'requests', 'tokens'].sort());
      assert.deepEqual(Object.keys(m.tokens).sort(), tokenKeys);
    }

    // failure shape: same keys + reason
    const failed = await getGoUsage({ dbPath: path.join(os.tmpdir(), 'nope-go-shape.db') });
    assert.deepEqual(Object.keys(failed).sort(), [...Object.keys(summary).map((k) => k), 'reason'].sort());
    assert.equal(typeof failed.reason, 'string');
  } finally {
    f.cleanup();
  }
});
