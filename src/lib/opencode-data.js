// Zero-dependency data layer for opencode local SQLite data.
// Reads the local opencode DB read-only and produces usage aggregates.
// This module NEVER throws to callers: if the DB is missing/unreadable,
// getUsageSummary() resolves with `available: false` and zeroed stats.

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

export const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL_LIMIT = 10;
const PROJECT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyDayStat() {
  return {
    cost: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    sessions: 0,
    topModel: null,
  };
}

function zeroedSummary(days) {
  const now = new Date();
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    byDay.push({
      date: localDateKey(new Date(now.getTime() - i * DAY_MS)),
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      sessions: 0,
    });
  }
  return {
    available: false,
    generatedAt: now.toISOString(),
    today: emptyDayStat(),
    week: emptyDayStat(),
    allTime: emptyDayStat(),
    byDay,
    byModel: [],
    byProject: [],
  };
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

/** Parse the `model` JSON string column defensively. */
function parseModel(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { id: 'unknown', providerID: 'unknown' };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      id: typeof parsed?.id === 'string' && parsed.id ? parsed.id : 'unknown',
      providerID: typeof parsed?.providerID === 'string' && parsed.providerID ? parsed.providerID : 'unknown',
    };
  } catch {
    return { id: 'unknown', providerID: 'unknown' };
  }
}

/** Display name for a project: explicit name, else basename of worktree, else fallback. */
function projectDisplayName(row) {
  if (row.projectId === 'global') return 'global';
  if (row.projectName != null && String(row.projectName).length > 0) return row.projectName;
  if (row.worktree) {
    const base = path.basename(row.worktree);
    if (base && base !== '.') return base;
  }
  return 'unknown';
}

/** Build the all-time aggregated row set from the session table. */
function loadSessions(db) {
  const rows = db
    .prepare(
      `SELECT
         s.cost,
         s.tokens_input,
         s.tokens_output,
         s.tokens_reasoning,
         s.tokens_cache_read,
         s.tokens_cache_write,
         s.time_updated,
         s.model,
         s.project_id,
         p.name AS project_name,
         p.worktree AS worktree
       FROM session s
       LEFT JOIN project p ON p.id = s.project_id`
    )
    .all();

  const out = [];
  for (const r of rows) {
    out.push({
      cost: Number(r.cost) || 0,
      tokensInput: Number(r.tokens_input) || 0,
      tokensOutput: Number(r.tokens_output) || 0,
      tokensReasoning: Number(r.tokens_reasoning) || 0,
      tokensCacheRead: Number(r.tokens_cache_read) || 0,
      tokensCacheWrite: Number(r.tokens_cache_write) || 0,
      timeUpdated: Number(r.time_updated) || 0,
      model: parseModel(r.model),
      projectKey: r.project_id == null ? 'unknown' : String(r.project_id),
      project: projectDisplayName({
        projectId: r.project_id,
        projectName: r.project_name,
        worktree: r.worktree,
      }),
      worktree: r.worktree == null ? null : String(r.worktree),
    });
  }
  return out;
}

/** Fold a list of sessions into a DayStat (all fields aggregated). */
function aggregateSessions(sessions) {
  const stat = emptyDayStat();
  let top = null; // { id, providerID, cost }
  for (const s of sessions) {
    stat.cost += s.cost;
    stat.tokensInput += s.tokensInput;
    stat.tokensOutput += s.tokensOutput;
    stat.tokensReasoning += s.tokensReasoning;
    stat.tokensCacheRead += s.tokensCacheRead;
    stat.tokensCacheWrite += s.tokensCacheWrite;
    stat.sessions += 1;
    if (top === null || s.cost > top.cost) {
      top = { id: s.model.id, providerID: s.model.providerID, cost: s.cost };
    }
  }
  if (top !== null) stat.topModel = top;
  return stat;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate usage from the local opencode SQLite DB.
 *
 * @param {object} [options]
 * @param {number} [options.days=7]   number of days for `week` and `byDay`
 * @param {string} [options.dbPath]   DB path override (used by tests; defaults to DB_PATH)
 * @returns {Promise<Summary>} never rejects; resolves with zeroed data + available:false on failure
 */
export async function getUsageSummary({ days = 7, dbPath } = {}) {
  const nDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  const resolvedDbPath = dbPath ?? DB_PATH;

  let db;
  try {
    db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  } catch {
    return zeroedSummary(nDays);
  }

  try {
    const sessions = loadSessions(db);

    const now = Date.now();
    const todayStart = startOfLocalDay(now);
    const weekStart = todayStart - (nDays - 1) * DAY_MS;

    // Bucket sessions
    const todaySessions = [];
    const weekSessions = [];
    const byDayMap = new Map();
    const byModelMap = new Map();
    const byProjectMap = new Map();

    // Initialize day buckets (ascending, zero-filled)
    const dayKeys = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const key = localDateKey(now - i * DAY_MS);
      dayKeys.push(key);
      byDayMap.set(key, {
        date: key,
        cost: 0,
        tokensInput: 0,
        tokensOutput: 0,
        sessions: 0,
      });
    }

    for (const s of sessions) {
      const t = s.timeUpdated;
      if (t >= todayStart) todaySessions.push(s);
      if (t >= weekStart) weekSessions.push(s);

      if (t > 0) {
        const key = localDateKey(t);
        const bucket = byDayMap.get(key);
        if (bucket) {
          bucket.cost += s.cost;
          bucket.tokensInput += s.tokensInput;
          bucket.tokensOutput += s.tokensOutput;
          bucket.sessions += 1;
        }
      }

      // byModel (all-time)
      const modelKey = `${s.model.id}\u0000${s.model.providerID}`;
      let m = byModelMap.get(modelKey);
      if (!m) {
        m = { id: s.model.id, providerID: s.model.providerID, cost: 0, tokensInput: 0, tokensOutput: 0, sessions: 0 };
        byModelMap.set(modelKey, m);
      }
      m.cost += s.cost;
      m.tokensInput += s.tokensInput;
      m.tokensOutput += s.tokensOutput;
      m.sessions += 1;

      // byProject (all-time)
      let p = byProjectMap.get(s.projectKey);
      if (!p) {
        p = { name: s.project, worktree: s.worktree, cost: 0, tokensInput: 0, tokensOutput: 0, sessions: 0 };
        byProjectMap.set(s.projectKey, p);
      }
      p.cost += s.cost;
      p.tokensInput += s.tokensInput;
      p.tokensOutput += s.tokensOutput;
      p.sessions += 1;
    }

    const byDay = dayKeys.map((key) => byDayMap.get(key));
    const byModel = [...byModelMap.values()].sort((a, b) => b.cost - a.cost).slice(0, MODEL_LIMIT);
    const byProject = [...byProjectMap.values()].sort((a, b) => b.cost - a.cost).slice(0, PROJECT_LIMIT);

    return {
      available: true,
      generatedAt: new Date().toISOString(),
      today: aggregateSessions(todaySessions),
      week: aggregateSessions(weekSessions),
      allTime: aggregateSessions(sessions),
      byDay,
      byModel,
      byProject,
    };
  } catch {
    // Any query/logic failure degrades to the zeroed summary instead of throwing.
    return zeroedSummary(nDays);
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }
}
