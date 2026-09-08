// Tests for src/lib/opencode-data.js -- zero dependencies (node:test + node:assert).
// Fixtures live in temp SQLite DBs under os.tmpdir(); the real opencode DB is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getUsageSummary, DB_PATH } from '../src/lib/opencode-data.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const dbPath = path.join(os.tmpdir(), `opencode-usage-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO session (id, project_id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertProject = db.prepare(`INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)`);
  return {
    dbPath,
    db,
    insert,
    insertProject,
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

/**
 * Standard fixture (see expectations inline). Returns { dbPath, cleanup }.
 *
 * today (5 sessions): s1 m1/p1 $0.40, s2 m2/p2 $0.60, s3 malformed model $0.10,
 *                     s7 NULL model + missing project $0.05, s8 global $0.02
 * yesterday (1):      s4 m1/p1 $0.25
 * 6 days ago (1):     s5 m1/p1 $0.15
 * 30 days ago (1):    s6 m3/p3 $5.00
 * no timestamp (1):   s9 m4/p4 $0.01
 */
function makeStandardFixture() {
  const f = makeTempDb();
  const today = localDayStart(0);
  const H = 3600 * 1000;

  f.insertProject.run('proj-a', 'D:/dataCode/LearnCode/WriteSync', null);
  f.insertProject.run('proj-b', 'D:/dataCode/LearnCode/Other', 'My Project');
  f.insertProject.run('global', '/', null);

  const sessions = [
    ['s1', 'proj-a', 0.4, 100, 10, 5, 20, 2, today + 1 * H, JSON.stringify({ id: 'm1', providerID: 'p1' })],
    ['s2', 'proj-a', 0.6, 200, 20, 10, 40, 4, today + 2 * H, JSON.stringify({ id: 'm2', providerID: 'p2' })],
    ['s3', 'proj-b', 0.1, 30, 3, 0, 0, 0, today + 3 * H, 'not-valid-json'],
    ['s4', 'proj-a', 0.25, 50, 5, 0, 0, 0, today - DAY_MS + 5 * H, JSON.stringify({ id: 'm1', providerID: 'p1' })],
    ['s5', 'proj-a', 0.15, 40, 4, 0, 0, 0, today - 6 * DAY_MS + 5 * H, JSON.stringify({ id: 'm1', providerID: 'p1' })],
    ['s6', 'proj-a', 5.0, 1000, 100, 0, 0, 0, today - 30 * DAY_MS + 5 * H, JSON.stringify({ id: 'm3', providerID: 'p3' })],
    ['s7', 'missing-project', 0.05, 0, 0, 0, 0, 0, today + 4 * H, null],
    ['s8', 'global', 0.02, 10, 1, 0, 0, 0, today + 5 * H, JSON.stringify({ id: 'm2', providerID: 'p2' })],
    ['s9', 'proj-a', 0.01, 0, 0, 0, 0, 0, null, JSON.stringify({ id: 'm4', providerID: 'p4' })],
  ];
  for (const s of sessions) f.insert.run(...s);

  return f;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('DB_PATH points at the platform-local opencode.db', () => {
  assert.equal(DB_PATH, path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'));
});

test('missing DB resolves with available:false and zeroed structure, never throws', async () => {
  const summary = await getUsageSummary({ dbPath: path.join(os.tmpdir(), 'definitely-not-here-12345.db') });
  assert.equal(summary.available, false);
  assert.equal(summary.allTime.cost, 0);
  assert.equal(summary.allTime.sessions, 0);
  assert.equal(summary.allTime.topModel, null);
  assert.equal(summary.byDay.length, 7);
  assert.equal(summary.byModel.length, 0);
  assert.equal(summary.byProject.length, 0);
  for (const d of summary.byDay) {
    assert.equal(d.cost, 0);
    assert.equal(d.sessions, 0);
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(!Number.isNaN(Date.parse(summary.generatedAt)));
});

test('unreadable/garbage DB file resolves with available:false, never throws', async () => {
  const p = path.join(os.tmpdir(), `opencode-garbage-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(p, 'this is definitely not a sqlite database, just garbage bytes');
  try {
    const summary = await getUsageSummary({ dbPath: p });
    assert.equal(summary.available, false);
    assert.equal(summary.allTime.cost, 0);
  } finally {
    fs.unlinkSync(p);
  }
});

test('empty DB (schema only) resolves with available:true and all zeros', async () => {
  const f = makeTempDb();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    assert.equal(summary.available, true);
    assert.equal(summary.allTime.sessions, 0);
    assert.equal(summary.today.sessions, 0);
    assert.equal(summary.byDay.length, 7);
    assert.equal(summary.byModel.length, 0);
    assert.equal(summary.byProject.length, 0);
  } finally {
    f.cleanup();
  }
});

test('today bucket aggregates exactly the sessions with time_updated >= local midnight', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const t = summary.today;
    assert.equal(t.sessions, 5);
    assertNear(t.cost, 1.17); // 0.40+0.60+0.10+0.05+0.02
    assert.equal(t.tokensInput, 340); // 100+200+30+0+10
    assert.equal(t.tokensOutput, 34);
    assert.equal(t.tokensReasoning, 15); // 5+10
    assert.equal(t.tokensCacheRead, 60); // 20+40
    assert.equal(t.tokensCacheWrite, 6); // 2+4
    assert.deepEqual(t.topModel, { id: 'm2', providerID: 'p2', cost: 0.6 });
  } finally {
    f.cleanup();
  }
});

test('week bucket spans the last N local days including today', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const w = summary.week;
    assert.equal(w.sessions, 7); // today(5) + yesterday + 6-days-ago; 30d-ago & timestampless excluded
    assertNear(w.cost, 1.57); // 1.17 + 0.25 + 0.15
    assert.equal(w.tokensInput, 430);
    assert.equal(w.tokensOutput, 43);
    assert.deepEqual(w.topModel, { id: 'm2', providerID: 'p2', cost: 0.6 });
  } finally {
    f.cleanup();
  }
});

test('allTime bucket includes everything (incl. sessions without time_updated)', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const a = summary.allTime;
    assert.equal(a.sessions, 9);
    assertNear(a.cost, 6.58); // 1.57 + 5.00 + 0.01
    assert.equal(a.tokensInput, 1430);
    assert.equal(a.tokensOutput, 143);
    assert.equal(a.tokensReasoning, 15);
    assert.equal(a.tokensCacheRead, 60);
    assert.equal(a.tokensCacheWrite, 6);
    assert.deepEqual(a.topModel, { id: 'm3', providerID: 'p3', cost: 5.0 });
  } finally {
    f.cleanup();
  }
});

test('byDay is ascending, zero-filled, length = days, correct per-day math', async () => {
  const f = makeStandardFixture();
  try {
    const today = localDayStart(0);
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const byDay = summary.byDay;
    assert.equal(byDay.length, 7);

    // ascending dates
    const expectedKeys = [];
    for (let i = 6; i >= 0; i--) expectedKeys.push(localDateKey(today - i * DAY_MS));
    assert.deepEqual(byDay.map((d) => d.date), expectedKeys);

    // middle days zero-filled
    assert.deepEqual(byDay[1], { date: expectedKeys[1], cost: 0, tokensInput: 0, tokensOutput: 0, sessions: 0 });

    // 6 days ago: s5
    assert.equal(byDay[0].cost, 0.15);
    assert.equal(byDay[0].tokensInput, 40);
    assert.equal(byDay[0].tokensOutput, 4);
    assert.equal(byDay[0].sessions, 1);

    // yesterday: s4
    assert.equal(byDay[5].cost, 0.25);
    assert.equal(byDay[5].sessions, 1);

    // today: s1,s2,s3,s7,s8
    assertNear(byDay[6].cost, 1.17);
    assert.equal(byDay[6].tokensInput, 340);
    assert.equal(byDay[6].tokensOutput, 34);
    assert.equal(byDay[6].sessions, 5);
  } finally {
    f.cleanup();
  }
});

test('days option changes week window and byDay length', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath, days: 3 });
    assert.equal(summary.byDay.length, 3);
    assert.equal(summary.week.sessions, 6); // excludes the 6-days-ago session
    assertNear(summary.week.cost, 1.42); // 1.17 + 0.25
    assert.equal(summary.allTime.sessions, 9); // allTime unaffected
    assert.equal(summary.byDay[2].sessions, 5); // today is last element
  } finally {
    f.cleanup();
  }
});

test('malformed and NULL model JSON fall back to unknown/unknown', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const unknown = summary.byModel.find((m) => m.id === 'unknown');
    assert.ok(unknown, 'unknown model row exists');
    assert.equal(unknown.providerID, 'unknown');
    assertNear(unknown.cost, 0.15); // s3 (bad JSON) + s7 (NULL)
    assert.equal(unknown.sessions, 2);
    assert.equal(unknown.tokensInput, 30);
  } finally {
    f.cleanup();
  }
});

test('byModel aggregates by id+providerID, sorted desc by cost, capped at 10', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const ids = summary.byModel.map((m) => `${m.id}/${m.providerID}`);
    assert.deepEqual(ids, [
      'm3/p3', // 5.00
      'm1/p1', // 0.80
      'm2/p2', // 0.62
      'unknown/unknown', // 0.15
      'm4/p4', // 0.01
    ]);

    const m1 = summary.byModel.find((m) => m.id === 'm1');
    assert.equal(m1.providerID, 'p1');
    assertNear(m1.cost, 0.8); // 0.40 + 0.25 + 0.15
    assert.equal(m1.tokensInput, 190); // 100 + 50 + 40
    assert.equal(m1.tokensOutput, 19);
    assert.equal(m1.sessions, 3);

    // cap: separate fixture with 12 distinct models
    const f2 = makeTempDb();
    try {
      const ins = f2.insert;
      for (let i = 0; i < 12; i++) {
        ins.run(`c${i}`, 'global', 1 + i * 0.01, 1, 1, 0, 0, 0, localDayStart(0) + i, JSON.stringify({ id: `model-${i}`, providerID: 'p' }));
      }
      const s2 = await getUsageSummary({ dbPath: f2.dbPath });
      assert.equal(s2.byModel.length, 10);
      assert.equal(s2.byModel[0].id, 'model-11'); // highest cost first
      assert.equal(s2.byModel[9].id, 'model-2');
    } finally {
      f2.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('byProject resolves display names (basename / explicit name / global / unknown) and sorts desc', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const names = summary.byProject.map((p) => p.name);
    assert.deepEqual(names, ['WriteSync', 'My Project', 'unknown', 'global']);

    const ws = summary.byProject[0];
    assert.equal(ws.worktree, 'D:/dataCode/LearnCode/WriteSync');
    assertNear(ws.cost, 6.41); // 0.40+0.60+0.25+0.15+5.00+0.01
    assert.equal(ws.tokensInput, 1390);
    assert.equal(ws.tokensOutput, 139);
    assert.equal(ws.sessions, 6);

    const glob = summary.byProject.find((p) => p.name === 'global');
    assert.equal(glob.cost, 0.02);
    assert.equal(glob.sessions, 1);

    const unknown = summary.byProject.find((p) => p.name === 'unknown');
    assert.equal(unknown.cost, 0.05); // session referencing missing project row
    assert.equal(unknown.worktree, null);
  } finally {
    f.cleanup();
  }
});

test('byProject is capped at 10, sorted desc by cost', async () => {
  const f = makeTempDb();
  try {
    for (let i = 0; i < 12; i++) {
      f.insertProject.run(`proj-${i}`, `/worktrees/proj-${i}`, null);
      f.insert.run(`s${i}`, `proj-${i}`, 10 - i, 1, 1, 0, 0, 0, localDayStart(0), null);
    }
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    assert.equal(summary.byProject.length, 10);
    assert.equal(summary.byProject[0].name, 'proj-0'); // cost 10
    assert.equal(summary.byProject[9].name, 'proj-9'); // cost 1
  } finally {
    f.cleanup();
  }
});

test('topModel is null for empty buckets and for buckets whose sessions have zero cost only', async () => {
  const f = makeTempDb();
  try {
    // one session with zero cost today -> topModel still set (it's the max, cost 0)
    f.insert.run('z1', 'global', 0, 0, 0, 0, 0, 0, localDayStart(0) + 1000, null);
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    assert.equal(summary.today.sessions, 1);
    assert.deepEqual(summary.today.topModel, { id: 'unknown', providerID: 'unknown', cost: 0 });

    // empty DB -> topModel null everywhere
    const f2 = makeTempDb();
    try {
      const s2 = await getUsageSummary({ dbPath: f2.dbPath });
      assert.equal(s2.today.topModel, null);
      assert.equal(s2.week.topModel, null);
      assert.equal(s2.allTime.topModel, null);
    } finally {
      f2.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('summary has the exact contract shape', async () => {
  const f = makeStandardFixture();
  try {
    const summary = await getUsageSummary({ dbPath: f.dbPath });
    const dayStatKeys = ['cost', 'tokensInput', 'tokensOutput', 'tokensReasoning', 'tokensCacheRead', 'tokensCacheWrite', 'sessions', 'topModel'];
    for (const bucket of ['today', 'week', 'allTime']) {
      assert.deepEqual(Object.keys(summary[bucket]).sort(), [...dayStatKeys].sort());
      assert.equal(typeof summary[bucket].cost, 'number');
    }
    assert.deepEqual(Object.keys(summary).sort(), [
      'allTime',
      'available',
      'byDay',
      'byModel',
      'byProject',
      'generatedAt',
      'today',
      'week',
    ].sort());
    assert.equal(typeof summary.available, 'boolean');
    assert.equal(typeof summary.generatedAt, 'string');
    assert.ok(Array.isArray(summary.byDay));
    assert.ok(Array.isArray(summary.byModel));
    assert.ok(Array.isArray(summary.byProject));
    for (const d of summary.byDay) {
      assert.deepEqual(Object.keys(d).sort(), ['cost', 'date', 'sessions', 'tokensInput', 'tokensOutput'].sort());
    }
    for (const m of summary.byModel) {
      assert.deepEqual(Object.keys(m).sort(), ['cost', 'id', 'providerID', 'sessions', 'tokensInput', 'tokensOutput'].sort());
    }
    for (const p of summary.byProject) {
      assert.deepEqual(Object.keys(p).sort(), ['cost', 'name', 'sessions', 'tokensInput', 'tokensOutput', 'worktree'].sort());
    }
  } finally {
    f.cleanup();
  }
});
