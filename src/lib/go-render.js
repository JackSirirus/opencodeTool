// ============================================================
// go-render — pure rendering layer for the `usage go` report.
// Zero IO: no fs, no network, no process/env reads.
// Input shape (设计/v0.2-go-usage S8.6 JSON contract):
//   data = {
//     generatedAt?: ISO string,          // header timestamp (defaults to now)
//     local: {
//       available: boolean,
//       today | week | allTime: {
//         requests, cost,
//         tokens: { input, output, reasoning, cacheRead, cacheWrite } | number,
//         hitRateOfInput?: 0..1, hitRateReadWrite?: 0..1,   // fractions
//       },
//       byDay:   [{ date: 'YYYY-MM-DD', requests, tokens, cost }],   // ascending
//       byModel: [{ id, requests, tokens, cost }],                   // full set
//     },
//     quota: {
//       available: boolean,
//       reason?: 'network' | 'no-subscription' | 'no-credentials' | 'timeout',
//       lastGood?: { at: ISO, monthlyPercent?: number },   // network-failure anchor
//       windows?: { rolling: { status, percent, resetsAt },
//                   weekly: {...}, monthly: {...} } | null,
//     },
//   }
// All render functions never throw on missing/null fields.
// ============================================================

// ---- ANSI palette (mirrors bin/opencode-usage.js conventions) --------------

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

// ---- width helpers (CJK-aware, copied convention from bin/opencode-usage.js)

const CJK_RE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/;

/** Display width: CJK & full-width chars count as 2. */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += CJK_RE.test(ch) ? 2 : 1;
  return w;
}

function pad(s, width, align = 'left') {
  const str = String(s);
  const gap = Math.max(0, width - displayWidth(str));
  return align === 'right' ? ' '.repeat(gap) + str : str + ' '.repeat(gap);
}

/** Truncate to maxW display columns, appending '…' when cut. */
export function truncateWidth(s, maxW) {
  const str = String(s);
  if (displayWidth(str) <= maxW) return str;
  let out = '';
  for (const ch of str) {
    if (displayWidth(out) + displayWidth(ch) > maxW - 1) break;
    out += ch;
  }
  return out + '…';
}

// ---- formatting helpers -----------------------------------------------------

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Thousands separator: 0 -> "0", 1000 -> "1,000", 26991 -> "26,991". */
export function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return intFmt.format(Math.round(n));
}

/** Humanize tokens: 500 -> "500", 24100000 -> "24.1M", 6410000000 -> "6.41B". */
export function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Two-decimal dollars: 0 -> "$0.00", 1.44 -> "$1.44". */
export function fmtCost(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

/** Percent string: fmtPct(86.9) -> "86.9%", fmtPct(97.39) -> "97.4%". */
export function fmtPct(n, decimals = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}

/** 2-decimal percent with trailing zero trimmed to 1 decimal: 99.96 -> "99.96%", 100 -> "100.0%". */
function fmtPctSmart(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n.toFixed(2);
  return s.endsWith('0') ? s.slice(0, -1) + '%' : s + '%';
}

/**
 * Relative countdown from now: "2h11m" / "38m" / "即将重置" (<60s) / "等待刷新" (past).
 * >=24h renders as "2d5h".
 */
export function fmtCountdown(iso, now = Date.now()) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  if (diff <= 0) return '等待刷新';
  if (diff < 60_000) return '即将重置';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Fixed-width bar, width 10: asciiBar(70) -> "▇▇▇▇▇▇▇░░░", 0 -> all empty, 100 -> all filled. Nonzero percent keeps >=1 filled. */
export function asciiBar(percent, width = 10) {
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  if (p <= 0) return '░'.repeat(width);
  const filled = Math.min(width, Math.max(1, Math.ceil((p / 100) * width)));
  return '▇'.repeat(filled) + '░'.repeat(width - filled);
}

/** Local "MM-DD" from an ISO string, e.g. weekly/monthly reset dates. */
function fmtDateMD(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local "HH:MM" from an ISO string (lastGood anchor). */
function fmtTimeHM(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Header stamp: local "YYYY-MM-DD HH:MM". */
function fmtStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Token total from either a scalar or a nested tokens object (input+output, matching bin CLI). */
function tokenTotal(t) {
  if (t == null) return 0;
  if (typeof t === 'number') return Number.isNaN(t) ? 0 : t;
  return (t.input || 0) + (t.output || 0);
}

/** Hit-rate percent (0-100) from a precomputed fraction field or from tokens. null = no data. */
function hitPct(stat, key) {
  const v = stat?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v <= 1 ? v * 100 : v;
  const t = stat?.tokens;
  if (!t || typeof t === 'number') return null;
  const input = t.input || 0;
  const cr = t.cacheRead || 0;
  const cw = t.cacheWrite || 0;
  if (key === 'hitRateOfInput') {
    const d = input + cr + cw;
    return d > 0 ? (cr / d) * 100 : null;
  }
  const d = cr + cw;
  return d > 0 ? (cr / d) * 100 : null;
}

// ---- section renderers ------------------------------------------------------

const RULE_W = 56;

function rule(c) {
  return c(DIM, '─'.repeat(RULE_W));
}

function headerLine(c, generatedAt) {
  const head = 'OpenCode Go 套餐';
  const stamp = fmtStamp(generatedAt);
  const gap = Math.max(2, RULE_W - displayWidth(head) - displayWidth(stamp));
  return c(BOLD, head) + ' '.repeat(gap) + c(DIM, stamp);
}

function statRow(label, stat, c) {
  const req = pad(fmtInt(stat?.requests ?? 0), 6, 'right');
  const tok = pad(fmtTokens(tokenTotal(stat?.tokens)), 8, 'right');
  const cost = pad(fmtCost(stat?.cost ?? 0), 7, 'right');
  return `${pad(label, 4)}  ${req} 请求  ${tok} tok  ${c(GREEN, cost)}`;
}

function quotaSection(quota, c, now) {
  const lines = [];
  lines.push(c(MAGENTA, '套餐额度') + '  ' + c(DIM, '(server)'));
  lines.push(rule(c));

  if (!quota?.available) {
    const reason = quota?.reason ?? 'network';
    if (reason === 'no-subscription' || reason === 'no-credentials') {
      lines.push(c(YELLOW, '未检测到 Go 订阅'));
      lines.push(c(DIM, '（auth.json 无 opencode-go 凭据或已过期）'));
      lines.push(c(DIM, '订阅 / 换 key → opencode.ai/auth'));
    } else {
      let msg = `额度不可用：${reason}`;
      const lg = quota?.lastGood;
      if (lg?.at) {
        const mp = lg.monthlyPercent != null ? `（月 ${fmtPct(lg.monthlyPercent)}）` : '';
        msg += ` · 上次成功 ${fmtTimeHM(lg.at)}${mp}`;
      }
      lines.push(c(YELLOW, msg));
      lines.push(c(DIM, '本地统计不受影响；重试：npm run usage -- go --quota'));
    }
    return lines;
  }

  const windows = quota.windows;
  if (!windows) {
    lines.push(c(YELLOW, '额度数据为空'));
    return lines;
  }

  const LABELS = { rolling: '5 小时', weekly: '本周', monthly: '本月' };
  const LIMITS = { rolling: '$12', weekly: '$30', monthly: '$60' };
  let limitedLabel = null;

  for (const k of ['rolling', 'weekly', 'monthly']) {
    const w = windows[k];
    if (!w) continue;
    const limited = w.status === 'rate-limited';
    if (limited) limitedLabel = LABELS[k];
    const pct = limited ? 100 : Math.min(100, Math.max(0, Number(w.percent) || 0));
    const bar = limited ? c(RED, asciiBar(100)) : asciiBar(pct);
    const prefix = limited ? c(RED, '!!') + ' ' : '   ';
    let reset;
    if (k === 'rolling') {
      const cd = fmtCountdown(w.resetsAt, now);
      reset = cd === '即将重置' || cd === '等待刷新' || cd === '—' ? cd : `${cd} 后重置`;
    } else {
      // weekly/monthly resets are calendar dates, not countdowns
      const md = fmtDateMD(w.resetsAt);
      reset = md === '—' ? '重置时间未知' : `${md} 重置`;
    }
    const pctStr = pad(`${pct}%`, 4, 'right');
    lines.push(`${pad(LABELS[k], 6)}${prefix}${bar} ${pctStr}  ${c(DIM, `限额 ${LIMITS[k]} · ${reset}`)}`);
  }

  if (limitedLabel) {
    lines.push(
      c(RED, `${limitedLabel}窗口已达上限 · 期间可切换免费模型（opencode/*），重置后自动恢复`)
    );
  }
  lines.push(c(DIM, '限额按美元价值计，有效额度因模型乘数而异（docs/go）；percent 以服务端为准'));
  return lines;
}

function cacheRow(label, todayPct, allPct, c, smart) {
  const fmt = smart ? fmtPctSmart : (v) => fmtPct(v);
  const t = todayPct == null ? '—' : pad(fmt(todayPct), 6);
  const a = allPct == null ? '—' : pad(fmt(allPct), 6);
  const tBar = todayPct == null ? c(DIM, '·'.repeat(10)) : asciiBar(todayPct);
  const aBar = allPct == null ? c(DIM, '·'.repeat(10)) : asciiBar(allPct);
  const tCol = todayPct == null ? t : c(CYAN, t);
  const aCol = allPct == null ? a : c(CYAN, a);
  return `  ${pad(label, 12)}  今日 ${tCol} ${tBar}   累计 ${aCol} ${aBar}`;
}

function cacheSection(local, c) {
  const lines = [];
  lines.push('缓存命中率');
  const today = local?.today;
  const all = local?.allTime;
  lines.push(cacheRow('占输入', hitPct(today, 'hitRateOfInput'), hitPct(all, 'hitRateOfInput'), c, false));
  lines.push(cacheRow('缓存读写占比', hitPct(today, 'hitRateReadWrite'), hitPct(all, 'hitRateReadWrite'), c, true));
  return lines;
}

const MODEL_ROW_LIMIT = 7;
const MODEL_NAME_MAX = 22;

function modelsSection(byModel, sort, c) {
  const lines = [];
  const all = [...(byModel ?? [])].sort((a, b) =>
    sort === 'cost' ? (b.cost ?? 0) - (a.cost ?? 0) : (b.requests ?? 0) - (a.requests ?? 0)
  );

  const head = `模型 (${all.length})`;
  const note = '请求 · tokens · 费用标记';
  const gap = Math.max(2, 62 - displayWidth(head) - displayWidth(note));
  lines.push(c(BOLD, head) + ' '.repeat(gap) + c(DIM, note));
  lines.push(rule(c));

  if (all.length === 0) {
    lines.push(c(DIM, '（本机还没有 opencode-go 请求）'));
    return lines;
  }

  const shown = all.slice(0, MODEL_ROW_LIMIT);
  const nameW = Math.min(MODEL_NAME_MAX, Math.max(...shown.map((m) => displayWidth(m.id ?? '—')), 4));
  const maxReq = Math.max(...shown.map((m) => m.requests ?? 0));

  for (const m of shown) {
    const name = pad(truncateWidth(m.id ?? '—', nameW), nameW);
    const req = pad(fmtInt(m.requests ?? 0), 6, 'right');
    const tok = pad(fmtTokens(tokenTotal(m.tokens)), 8, 'right');
    const cost = pad(fmtCost(m.cost ?? 0), 7, 'right');
    let bar = c(DIM, '·');
    if ((m.requests ?? 0) > 0 && maxReq > 0) {
      const n = Math.min(10, Math.max(1, Math.round(((m.requests ?? 0) / maxReq) * 10)));
      bar = '▇'.repeat(n);
    }
    lines.push(`${name}  ${req}   ${tok} tok  ${c(GREEN, cost)}   ${bar}`);
  }

  const rest = all.slice(MODEL_ROW_LIMIT);
  if (rest.length > 0) {
    lines.push(c(DIM, `… +${rest.length} (${rest.map((m) => truncateWidth(m.id ?? '—', 18)).join(' / ')})`));
  }
  return lines;
}

function daysSection(byDay, days, c) {
  const lines = [];
  const shown = (byDay ?? []).slice(-days);
  const n = shown.length;
  lines.push(`近 ${n} 天`);
  lines.push(rule(c));
  if (n === 0) {
    lines.push(c(DIM, '（无数据）'));
    return lines;
  }
  const maxReq = Math.max(...shown.map((d) => d.requests ?? 0));
  for (const d of shown) {
    const date = (d.date ?? '').length >= 10 ? d.date.slice(5) : (d.date ?? '—');
    const req = d.requests ?? 0;
    let bar;
    if (req <= 0 || maxReq <= 0) {
      bar = c(DIM, '·'.repeat(8));
    } else {
      const fill = Math.min(8, Math.max(1, Math.round((req / maxReq) * 8)));
      bar = '▇'.repeat(fill).padEnd(8, '░');
    }
    const tok = pad(fmtTokens(tokenTotal(d.tokens)), 8, 'right');
    lines.push(`  ${date}  ${bar}  ${pad(fmtInt(req), 5, 'right')} 请求  ${tok} tok  ${c(GREEN, fmtCost(d.cost ?? 0))}`);
  }
  return lines;
}

// ---- top-level renderers ----------------------------------------------------

/**
 * Render the full `usage go` terminal report. Pure: returns a multi-line string.
 * opts: { days = 7, sort = "requests" | "cost", noColor = false }
 */
export function renderGoReport(data, { days = 7, sort = 'requests', noColor = false } = {}) {
  const c = noColor ? (_code, s) => s : (code, s) => code + s + RESET;
  const local = data?.local ?? { available: false };
  const quota = data?.quota ?? { available: false, reason: 'network' };
  const now = Date.now();
  const lines = [];

  lines.push(headerLine(c, data?.generatedAt));
  lines.push(rule(c));

  if (local.available === false) {
    lines.push(c(YELLOW, '本地数据库不可用（opencode.db 缺失或不可读）'));
    lines.push(c(DIM, '提示：先启动一次 OpenCode 以生成数据库'));
  } else {
    lines.push(statRow('今日', local.today, c));
    lines.push(statRow('本周', local.week, c));
    lines.push(statRow('累计', local.allTime, c));
  }

  // quota section renders independently of local DB state (S8.5)
  lines.push('');
  lines.push(...quotaSection(quota, c, now));

  if (local.available !== false) {
    lines.push('');
    lines.push(...cacheSection(local, c));

    lines.push('');
    lines.push(...modelsSection(local.byModel, sort, c));

    const hasUsage = (local.allTime?.requests ?? 0) > 0;
    if (hasUsage && (local.byDay?.length ?? 0) > 0) {
      lines.push('');
      lines.push(...daysSection(local.byDay, days, c));
    }
    if ((local.allTime?.requests ?? 0) === 0) {
      lines.push('');
      lines.push(c(DIM, '提示：在 OpenCode 中选择 opencode-go/* 模型开始使用'));
    }
  }

  lines.push('');
  lines.push(c(DIM, '口径：opencode-go · 本地日历日 · 只读 opencode.db · 额度来自官方 API'));
  return lines.join('\n');
}

/**
 * The --json contract: { generatedAt, local, quota } — local and quota pass
 * through unchanged (S8.6: 双数据源独立成败，两者永远同时输出).
 */
export function renderGoJson(local, quota) {
  return {
    generatedAt: new Date().toISOString(),
    local: local ?? null,
    quota: quota ?? null,
  };
}
