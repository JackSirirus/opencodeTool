// Zero-dependency data layer for opencode Go plan usage (providerID: opencode-go).
// Aggregates assistant message rows from the local opencode SQLite DB.
// Contract mirrors src/lib/opencode-data.js (getUsageSummary): this module
// NEVER throws to callers — a missing/unreadable DB resolves with
// `available: false`, a stable `reason`, and zeroed stats.

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

export const GO_PROVIDER_ID = 'opencode-go';

export const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Probe conclusions (2026-09-07, full report: .omo/evidence/task-1-probe.md)
// ---------------------------------------------------------------------------
// - message table columns: id TEXT PK | session_id | time_created INTEGER |
//   time_updated INTEGER | data TEXT.
// - role/providerID/modelID exist ONLY inside the `data` JSON (no SQL columns).
//   Strategy: cheap LIKE pre-filter in SQL, then exact equality check after
//   JSON.parse (LIKE could over-match content that merely quotes this JSON;
//   measured false positives on the real DB: 0 / 27,642 rows).
// - data.time.created is a ms epoch, valid in 100% of sampled go assistant rows
//   (1000/1000) -> it is the SOLE time source (the real time_created column was
//   verified equivalent but is deliberately not referenced, so the query works
//   on schema variants without it). A row without a valid timestamp is
//   "timeless": counted in allTime/byModel, never in today/week/byDay.
// - data JSON is serialized without spaces, so the LIKE patterns below match.

const LIKE_ASSISTANT = `%"role":"assistant"%`;
const LIKE_GO_PROVIDER = `%"providerID":"${GO_PROVIDER_ID}"%`;

// Sanity bounds for a "valid" ms epoch (2001-09 .. 2096-10).
const MS_EPOCH_MIN = 1e12;
const MS_EPOCH_MAX = 4e12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyBucket() {
  return { requests: 0, tokens: emptyTokens(), cost: 0 };
}

/** hitRateOfInput = cacheRead / (input + cacheRead + cacheWrite); hitRateReadWrite = cacheRead / (cacheRead + cacheWrite); denominator 0 -> null. */
function hitRates(tokens) {
  const inputDenom = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const rwDenom = tokens.cacheRead + tokens.cacheWrite;
  return {
    hitRateOfInput: inputDenom > 0 ? tokens.cacheRead / inputDenom : null,
    hitRateReadWrite: rwDenom > 0 ? tokens.cacheRead / rwDenom : null,
  };
}

function finalizeBucket(b) {
  return { requests: b.requests, tokens: b.tokens, cost: b.cost, ...hitRates(b.tokens) };
}

/** Local calendar day key 'YYYY-MM-DD' from an ms epoch timestamp. */
function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight (ms) of the day containing `ms`. */
function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function zeroedSummary(days, reason) {
  const now = new Date();
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    byDay.push({
      date: localDateKey(now.getTime() - i * DAY_MS),
      requests: 0,
      tokens: emptyTokens(),
      cost: 0,
    });
  }
  return {
    available: false,
    reason,
    generatedAt: now.toISOString(),
    skippedRows: 0,
    today: { ...emptyBucket(), ...hitRates(emptyTokens()) },
    week: { ...emptyBucket(), ...hitRates(emptyTokens()) },
    allTime: { ...emptyBucket(), ...hitRates(emptyTokens()) },
    byDay,
    byModel: [],
  };
}

/** Extract tokens/cost/modelID/created from one parsed assistant message. */
function extractRow(d) {
  const raw = d.tokens ?? {};
  const cache = raw.cache ?? {};
  const tokens = {
    input: num(raw.input),
    output: num(raw.output),
    reasoning: num(raw.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
  // Prefer the stored total; fall back to the sum of the parts.
  tokens.total =
    typeof raw.total === 'number' && Number.isFinite(raw.total)
      ? raw.total
      : tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;

  const created =
    typeof d.time?.created === 'number' &&
    Number.isFinite(d.time.created) &&
    d.time.created >= MS_EPOCH_MIN &&
    d.time.created <= MS_EPOCH_MAX
      ? d.time.created
      : null;

  return {
    tokens,
    cost: num(d.cost),
    modelID: typeof d.modelID === 'string' && d.modelID ? d.modelID : 'unknown',
    created,
  };
}

function addTo(acc, row) {
  acc.requests += 1;
  acc.tokens.input += row.tokens.input;
  acc.tokens.output += row.tokens.output;
  acc.tokens.reasoning += row.tokens.reasoning;
  acc.tokens.cacheRead += row.tokens.cacheRead;
  acc.tokens.cacheWrite += row.tokens.cacheWrite;
  acc.tokens.total += row.tokens.total;
  acc.cost += row.cost;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate Go plan (providerID: opencode-go) assistant-message usage from the
 * local opencode SQLite DB.
 *
 * @param {object} [options]
 * @param {number} [options.days=7]   number of days for `week` and `byDay`
 * @param {string} [options.dbPath]   DB path override (used by tests; defaults to DB_PATH)
 * @returns {Promise<object>} never rejects; resolves with zeroed data + available:false on failure
 */
export async function getGoUsage({ days = 7, dbPath } = {}) {
  const nDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  const resolvedDbPath = dbPath ?? DB_PATH;

  let db;
  try {
    db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  } catch {
    return zeroedSummary(nDays, 'db-missing');
  }

  try {
    // Provider pattern FIRST: it is the more selective predicate (fails ~14% of
    // rows), so SQLite skips the second LIKE scan for those rows. Measured on the
    // real DB (414MB data column): 2.6s vs 4.8s with the role pattern first.
    const rows = db
      .prepare('SELECT data FROM message WHERE data LIKE ? AND data LIKE ?')
      .all(LIKE_GO_PROVIDER, LIKE_ASSISTANT);

    const now = Date.now();
    const todayStart = startOfLocalDay(now);
    const weekStart = todayStart - (nDays - 1) * DAY_MS;

    const allTime = emptyBucket();
    const today = emptyBucket();
    const week = emptyBucket();
    const byDayMap = new Map();
    const byModelMap = new Map();

    // Initialize day buckets (ascending, zero-filled).
    const dayKeys = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const key = localDateKey(now - i * DAY_MS);
      dayKeys.push(key);
      byDayMap.set(key, { date: key, requests: 0, tokens: emptyTokens(), cost: 0 });
    }

    let skippedRows = 0;

    for (const r of rows) {
      let d;
      try {
        d = JSON.parse(r.data);
      } catch {
        skippedRows += 1;
        continue;
      }
      // Exact check: the LIKE pre-filter can over-match (e.g. quoted JSON in content).
      if (d?.role !== 'assistant' || d?.providerID !== GO_PROVIDER_ID) continue;

      const row = extractRow(d);

      addTo(allTime, row);
      if (row.created !== null) {
        if (row.created >= todayStart) addTo(today, row);
        if (row.created >= weekStart) addTo(week, row);

        const bucket = byDayMap.get(localDateKey(row.created));
        if (bucket) addTo(bucket, row);
      }

      let m = byModelMap.get(row.modelID);
      if (!m) {
        m = { id: row.modelID, requests: 0, tokens: emptyTokens(), cost: 0, lastUsedAt: null };
        byModelMap.set(row.modelID, m);
      }
      m.requests += 1;
      m.tokens.input += row.tokens.input;
      m.tokens.output += row.tokens.output;
      m.tokens.reasoning += row.tokens.reasoning;
      m.tokens.cacheRead += row.tokens.cacheRead;
      m.tokens.cacheWrite += row.tokens.cacheWrite;
      m.tokens.total += row.tokens.total;
      m.cost += row.cost;
      if (row.created !== null && (m.lastUsedAt === null || row.created > m.lastUsedAt)) {
        m.lastUsedAt = row.created;
      }
    }

    const byDay = dayKeys.map((key) => byDayMap.get(key));
    const byModel = [...byModelMap.values()].sort((a, b) => b.requests - a.requests || b.cost - a.cost);

    return {
      available: true,
      generatedAt: new Date().toISOString(),
      skippedRows,
      today: finalizeBucket(today),
      week: finalizeBucket(week),
      allTime: finalizeBucket(allTime),
      byDay,
      byModel,
    };
  } catch {
    // Any query/logic failure (e.g. message table absent) degrades to zeroed data.
    return zeroedSummary(nDays, 'db-error');
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }
}
