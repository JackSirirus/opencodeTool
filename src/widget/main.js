/* ============================================================
 * OpenCode 用量桌面小窗口 — 主进程
 * 职责：BrowserWindow 管理、轮询数据层、IPC 转发、--selftest 校验
 * ============================================================ */

import { app, BrowserWindow, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { getUsageSummary } from "../lib/opencode-data.js";
import { createQuotaState, getGoQuota } from "../lib/go-quota.js";
import { getGoUsage } from "../lib/go-usage.js";

// ---- CLI flags ------------------------------------------------------------

const argv = process.argv.slice(1);
const SELFTEST = argv.includes("--selftest");

// ---- constants ------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;
// Go quota polling is independent of the local 30s poll: the quota API is a
// remote endpoint (no free lunch) and go-quota.js already caches (5min TTL),
// backs off and goes dormant on its own — so the timer just ticks.
const QUOTA_POLL_INTERVAL_MS = 5 * 60_000;
// Bumped 20s -> 30s: selftest performs one real quota fetch on top of the local
// summary (~3s) + window load; a getGoQuota attempt is bounded by its own 10s
// AbortController timeout, so 30s keeps the worst case comfortably inside.
const SELFTEST_TIMEOUT_MS = 30_000;
const WIN_WIDTH = 300;
const WIN_HEIGHT = 400;
const COMPACT_WIDTH = 300;
const COMPACT_HEIGHT = 120;
const EDGE_MARGIN = 16;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- state ----------------------------------------------------------------

let mainWindow = null;
let pollTimer = null;
let selftestDone = false;
// Quota poller — separate lifecycle from the local 30s pollTimer (stopPolling
// only clears pollTimer; the quota timer must not be blocked by the slow local
// SQLite scan either, and vice versa).
let quotaTimer = null;
let quotaState = null;
// Go local usage cache — lazy (first fetch happens when the renderer opens the
// Go tab or hits manual refresh), 5min TTL aligned with the quota cache.
// getGoUsage scans the full ~414MB message table (~2.5s), so it must NEVER run
// inside the 30s fee poll loop; it piggybacks on the 5min quota poll instead.
let goLocalData = null;
let goLocalFetchedAt = 0;
const GO_LOCAL_TTL_MS = 5 * 60 * 1000;
let goLocalInFlight = null;

// ---- helpers --------------------------------------------------------------

function emptyStat() {
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

function emptySummary(reason) {
  return {
    available: false,
    generatedAt: new Date().toISOString(),
    today: emptyStat(),
    week: emptyStat(),
    allTime: emptyStat(),
    byDay: [],
    byModel: [],
    byProject: [],
    error: reason || "data unavailable",
  };
}

async function fetchSummary() {
  try {
    const s = await getUsageSummary({ days: 7 });
    if (s && typeof s === "object") return s;
    return emptySummary("empty result");
  } catch (err) {
    return emptySummary(String(err?.message || err));
  }
}

function pushToRenderer(summary) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  try {
    mainWindow.webContents.send("usage:update", summary);
  } catch (err) {
    // renderer may not be ready yet — silently ignore
  }
}

async function pollOnce() {
  const summary = await fetchSummary();
  pushToRenderer(summary);
  return summary;
}

function emitStdout(line) {
  // Electron on Windows: stdout from the main process is piped to the parent
  // console only when launched from a console (or when ELECTRON_ENABLE_LOGGING
  // is set). console.log goes through Chromium's logger; process.stdout.write
  // goes directly to fd 1. Prefer process.stdout.write — it is the canonical
  // Node.js path and shows up in `npm run widget -- --selftest` reliably.
  try {
    process.stdout.write(line + "\n");
  } catch {
    try {
      console.log(line);
    } catch {
      // nothing left to try — drop the line rather than crash the widget
    }
  }
}

// ---- selftest --------------------------------------------------------------

async function reportSelftest(summary) {
  if (selftestDone) return;
  selftestDone = true;
  // G10: new `go` field is additive — existing fields and the "SELFTEST OK"
  // string stay byte-for-byte identical. quotaState is null when quota
  // polling was never started; then go reports { available: false }.
  const goQuota = quotaState
    ? await getGoQuota({ state: quotaState }).catch(() => null)
    : null;
  const payload = {
    available: !!(summary && summary.available),
    todayCost: summary?.today?.cost ?? null,
    allTimeCost: summary?.allTime?.cost ?? null,
    sessions: summary?.allTime?.sessions ?? null,
    go: goQuota ? { available: goQuota.available } : { available: false },
  };
  emitStdout("SELFTEST OK " + JSON.stringify(payload));
  // small delay to let stdout flush before the process exits
  setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      process.exit(0);
    }
  }, 80);
}

function reportSelftestTimeout() {
  if (selftestDone) return;
  selftestDone = true;
  emitStdout("SELFTEST TIMEOUT");
  setTimeout(() => {
    try {
      app.exit(1);
    } catch {
      process.exit(1);
    }
  }, 80);
}

// ---- window ---------------------------------------------------------------

function computeAnchorRect(display) {
  // workArea excludes taskbar; bounds is full screen
  const area = display.workArea || display.bounds;
  const x = Math.max(area.x, area.x + area.width - WIN_WIDTH - EDGE_MARGIN);
  const y = Math.max(area.y, area.y + area.height - WIN_HEIGHT - EDGE_MARGIN);
  return { x, y };
}

function computeCompactAnchorRect(display, newWidth, newHeight) {
  // Keep the current bottom-right corner fixed: compact mode shrinks the
  // window up/left from where the user sees it instead of jumping anchors.
  const current = mainWindow.getBounds();
  const right = current.x + current.width;
  const bottom = current.y + current.height;
  const area = display.workArea || display.bounds;
  const x = Math.max(
    area.x,
    Math.min(right - newWidth, area.x + area.width - newWidth),
  );
  const y = Math.max(
    area.y,
    Math.min(bottom - newHeight, area.y + area.height - newHeight),
  );
  return { x, y, width: newWidth, height: newHeight };
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y } = computeAnchorRect(display);

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    title: "OpenCode 用量",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  // 'screen-saver' is the highest alwaysOnTop level on Windows — stays above
  // fullscreen apps too.
  try {
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // older platforms may not support visibleOnFullScreen
  }

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    if (process.env.WIDGET_DEVTOOLS === "1" && !SELFTEST) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Block navigation/new windows; this is a sandboxed local widget.
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function startPolling() {
  // initial fetch — fire-and-forget; selftest listens to the ack instead
  pollOnce();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- Go quota polling (independent lifecycle) ------------------------------

function startQuotaPolling() {
  quotaState = createQuotaState();
  if (quotaTimer) clearInterval(quotaTimer);
  // Interval-only: the renderer pulls the first value itself via the paired
  // `quota:initial` IPC, so no extra fetch is burned at startup.
  quotaTimer = setInterval(pollQuotaOnce, QUOTA_POLL_INTERVAL_MS);
}

function stopQuotaPolling() {
  if (quotaTimer) {
    clearInterval(quotaTimer);
    quotaTimer = null;
  }
}

async function pollQuotaOnce() {
  const q = await getGoQuota({ state: quotaState });
  pushQuotaToRenderer(q);
  // Piggyback: refresh the Go local cache on the same 5min cadence. The
  // ~2.5s DB scan runs async and never delays the next 30s fee poll; the
  // renderer only needs it when the Go tab is visible, and a push while the
  // fee tab is shown is harmless (renderer keeps it for the next switch).
  fetchGoLocal().catch(() => {});
}

function pushQuotaToRenderer(q) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  try {
    mainWindow.webContents.send("quota:update", q);
  } catch (err) {
    // renderer may not be ready yet — silently ignore
  }
}

// ---- Go local usage (lazy cache, independent of the 30s fee poll) ----------

async function fetchGoLocal(force = false) {
  if (!force && goLocalData && Date.now() - goLocalFetchedAt < GO_LOCAL_TTL_MS) {
    return goLocalData;
  }
  // Single-flight: concurrent triggers (lazy initial + 5min piggyback + manual
  // refresh) share one ~2.5s scan instead of stacking duplicates. Mirrors the
  // inflight pattern in go-quota.js. Force callers also reuse an in-flight
  // scan — it started at most ~2.5s ago, so its result is fresh enough.
  if (goLocalInFlight) return goLocalInFlight;
  goLocalInFlight = (async () => {
    // getGoUsage never throws (contract mirrors getUsageSummary): a missing or
    // unreadable DB resolves with { available: false } and zeroed stats.
    const data = await getGoUsage({ days: 7 });
    goLocalData = data;
    goLocalFetchedAt = Date.now();
    pushGoLocalToRenderer(data);
    return data;
  })();
  try {
    return await goLocalInFlight;
  } finally {
    goLocalInFlight = null;
  }
}

function pushGoLocalToRenderer(data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  try {
    mainWindow.webContents.send("go-local:update", data);
  } catch (err) {
    // renderer may not be ready yet — silently ignore
  }
}

// ---- IPC ------------------------------------------------------------------

ipcMain.handle("usage:initial", async () => {
  return await fetchSummary();
});

ipcMain.handle("usage:refresh", async () => {
  const summary = await pollOnce();
  // Same manual refresh also force-refreshes quota (bypasses cache/backoff/
  // dormant short-circuits). Return shape stays the usage summary — unchanged.
  if (quotaState) {
    const q = await getGoQuota({ state: quotaState, force: true });
    pushQuotaToRenderer(q);
  }
  // ...and force-refreshes the Go local cache (bypasses the 5min TTL). Not
  // awaited: the ~2.5s scan would stall the refresh ack; the renderer gets
  // the fresh payload via the go-local:update push instead.
  fetchGoLocal(true).catch(() => {});
  return summary;
});

// Paired with push channel `quota:update` (decision 17): renderer pulls the
// first value here, afterwards it is pushed on the 5min timer. quotaState is
// null only if polling was never started — report a stable failure shape.
ipcMain.handle("quota:initial", async () => {
  if (!quotaState) return { available: false, reason: "no-credentials" };
  return await getGoQuota({ state: quotaState });
});

// Lazy Go local data (option B): the renderer pulls the first value when the
// Go tab is opened, so the ~2.5s DB scan never runs unless the user actually
// looks at Go. Afterwards pushes arrive piggybacked on the 5min quota poll.
// Payload is the raw getGoUsage() result — pure local DB aggregation, no
// auth key anywhere in it.
ipcMain.handle("go:local:initial", async () => {
  return await fetchGoLocal(false);
});

ipcMain.on("widget:close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// Compact mode toggle: renderer calls with a boolean; the window resizes
// 300×400 ↔ 300×120 while keeping its bottom-right corner anchored.
// resizable:false does not block programmatic setBounds.
ipcMain.handle("widget:set-compact", (_event, isCompact) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const w = isCompact ? COMPACT_WIDTH : WIN_WIDTH;
  const h = isCompact ? COMPACT_HEIGHT : WIN_HEIGHT;
  const rect = computeCompactAnchorRect(display, w, h);
  mainWindow.setBounds(rect);
  return { width: w, height: h };
});

// Renderer announces it has rendered the first payload — only used in selftest
ipcMain.on("widget:ready", (_event, summary) => {
  if (SELFTEST)
    reportSelftest(summary).catch(() => {
      // timeout fallback reports SELFTEST TIMEOUT on its own timer
    });
});

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  if (!SELFTEST) {
    startPolling();
    startQuotaPolling();
  } else {
    // Selftest still needs the initial fetch — but the *report* is triggered
    // by the renderer's ready ack so we know the data path end-to-end.
    fetchSummary().catch(() => {});
    // Selftest also exercises the quota path once (no timer): reportSelftest
    // awaits a single getGoQuota call so the `go` field reflects real wiring.
    quotaState = createQuotaState();
    setTimeout(reportSelftestTimeout, SELFTEST_TIMEOUT_MS);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopPolling();
  stopQuotaPolling();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopPolling();
  stopQuotaPolling();
});

// On Windows, when launched without a console, stdout is not piped to the
// parent. Force the process to flush by listening to 'exit' too.
process.on("exit", (code) => {
  if (SELFTEST && !selftestDone) {
    emitStdout(
      code === 0 ? "SELFTEST OK {\"available\":null}" : "SELFTEST TIMEOUT",
    );
  }
});