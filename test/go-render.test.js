// Tests for src/lib/go-render.js -- pure rendering functions, fixture data only.
// No real DB access; all inputs are inline objects matching the S8.6 JSON contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderGoReport,
  renderGoJson,
  fmtInt,
  fmtTokens,
  fmtCost,
  fmtPct,
  fmtCountdown,
  asciiBar,
  displayWidth,
} from '../src/lib/go-render.js';

// ---------------------------------------------------------------------------
// Fixtures (shape per 设计/v0.2-go-usage S8.6)
// ---------------------------------------------------------------------------

const T = (input, output, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite,
});

const MIN = 60 * 1000;

function makeLocal() {
  return {
    available: true,
    today: {
      requests: 268,
      tokens: T(23_600_000, 500_000, 158_000_000),
      cost: 1.44,
      hitRateOfInput: 0.869,
      hitRateReadWrite: 1.0,
    },
    week: {
      requests: 1558,
      tokens: T(320_000_000, 11_300_000, 1_800_000_000),
      cost: 13.25,
      hitRateOfInput: 0.912,
      hitRateReadWrite: 0.999,
    },
    allTime: {
      requests: 26991,
      tokens: T(6_300_000_000, 110_000_000, 40_000_000_000),
      cost: 168.99,
      hitRateOfInput: 0.9739,
      hitRateReadWrite: 0.9996,
    },
    byDay: [
      { date: '2026-09-01', requests: 106, tokens: 32_500_000, cost: 1.02 },
      { date: '2026-09-02', requests: 110, tokens: 47_700_000, cost: 0.86 },
      { date: '2026-09-03', requests: 0, tokens: 0, cost: 0 },
      { date: '2026-09-04', requests: 266, tokens: 81_800_000, cost: 2.55 },
      { date: '2026-09-05', requests: 291, tokens: 36_600_000, cost: 3.14 },
      { date: '2026-09-06', requests: 335, tokens: 31_300_000, cost: 3.07 },
      { date: '2026-09-07', requests: 268, tokens: 24_100_000, cost: 1.44 },
    ],
    byModel: [
      { id: 'deepseek-v4-flash', requests: 15938, tokens: 4_700_000_000, cost: 33.76 },
      { id: 'deepseek-v4-pro', requests: 8253, tokens: 1_400_000_000, cost: 92.52 },
      { id: 'minimax-m3', requests: 1057, tokens: 113_900_000, cost: 8.82 },
      { id: 'glm-5.1', requests: 596, tokens: 68_100_000, cost: 22.26 },
      { id: 'omen-alpha', requests: 514, tokens: 58_500_000, cost: 3.77 },
      { id: 'qwen3.7-plus', requests: 183, tokens: 15_100_000, cost: 2.39 },
      { id: 'mimo-v2.5-pro', requests: 154, tokens: 56_700_000, cost: 3.26 },
      { id: 'mimo-v2.5', requests: 44, tokens: 5_000_000, cost: 0.4 },
      { id: 'kimi-k2.6', requests: 31, tokens: 3_000_000, cost: 0.3 },
      { id: 'hy3', requests: 22, tokens: 2_000_000, cost: 0.2 },
      { id: 'ox-alpha-free', requests: 11, tokens: 1_000_000, cost: 0.1 },
      { id: 'kimi-k2.7-code', requests: 5, tokens: 500_000, cost: 0.05 },
    ],
  };
}

function makeQuota() {
  return {
    available: true,
    fetchedAt: '2026-09-07T08:44:58.000Z',
    windows: {
      rolling: { status: 'ok', percent: 7, resetsAt: new Date(Date.now() + (2 * 60 + 11.5) * MIN).toISOString() },
      weekly: { status: 'ok', percent: 2, resetsAt: '2026-09-14T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 42, resetsAt: '2026-10-01T00:00:00.000Z' },
    },
  };
}

/** Full report with noColor (deterministic text assertions). */
function renderPlain(overrides = {}) {
  return renderGoReport(
    { local: overrides.local ?? makeLocal(), quota: overrides.quota ?? makeQuota(), ...overrides.data },
    { noColor: true, ...overrides.opts }
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test('fmtInt: thousands separator', () => {
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtInt(500), '500');
  assert.equal(fmtInt(1000), '1,000');
  assert.equal(fmtInt(26991), '26,991');
  assert.equal(fmtInt(null), '—');
  assert.equal(fmtInt(undefined), '—');
});

test('fmtTokens: k/M/B scale', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(500), '500');
  assert.equal(fmtTokens(164_400), '164.4k');
  assert.equal(fmtTokens(24_100_000), '24.1M');
  assert.equal(fmtTokens(331_300_000), '331.3M');
  assert.equal(fmtTokens(6_410_000_000), '6.41B');
  assert.equal(fmtTokens(null), '—');
});

test('fmtCost: two-decimal dollars', () => {
  assert.equal(fmtCost(0), '$0.00');
  assert.equal(fmtCost(1.44), '$1.44');
  assert.equal(fmtCost(168.99), '$168.99');
  assert.equal(fmtCost(null), '—');
});

test('fmtPct: 1 decimal default, decimals opt', () => {
  assert.equal(fmtPct(86.9), '86.9%');
  assert.equal(fmtPct(97.39), '97.4%');
  assert.equal(fmtPct(97.39, 2), '97.39%');
  assert.equal(fmtPct(100), '100.0%');
  assert.equal(fmtPct(null), '—');
});

test('fmtCountdown: relative time bands', () => {
  const now = Date.now();
  // 2h11m30s ahead -> floor to minutes -> "2h11m"
  assert.equal(fmtCountdown(new Date(now + (2 * 60 + 11.5) * MIN).toISOString(), now), '2h11m');
  // 38m ahead
  assert.equal(fmtCountdown(new Date(now + 38 * MIN).toISOString(), now), '38m');
  // <60s -> 即将重置
  assert.equal(fmtCountdown(new Date(now + 30 * 1000).toISOString(), now), '即将重置');
  // past -> 等待刷新
  assert.equal(fmtCountdown(new Date(now - 5 * MIN).toISOString(), now), '等待刷新');
  // missing / invalid
  assert.equal(fmtCountdown(null, now), '—');
  assert.equal(fmtCountdown('not-a-date', now), '—');
});

test('asciiBar: 10-wide fill/empty', () => {
  assert.equal(asciiBar(0), '░░░░░░░░░░');
  assert.equal(asciiBar(100), '▇▇▇▇▇▇▇▇▇▇');
  assert.equal(asciiBar(70), '▇▇▇▇▇▇▇░░░');
  // nonzero percent keeps at least 1 filled (design: 7% -> ▇░░░░░░░░░)
  assert.equal(asciiBar(7), '▇░░░░░░░░░');
  assert.equal(asciiBar(42), '▇▇▇▇▇░░░░░');
  // custom width
  assert.equal(asciiBar(50, 8), '▇▇▇▇░░░░');
  // out-of-range clamped
  assert.equal(asciiBar(-5), '░░░░░░░░░░');
  assert.equal(asciiBar(140), '▇▇▇▇▇▇▇▇▇▇');
});

// ---------------------------------------------------------------------------
// renderGoReport
// ---------------------------------------------------------------------------

test('renderGoReport: full fixture contains all section headers and key numbers', () => {
  const out = renderPlain();
  for (const s of ['OpenCode Go 套餐', '今日', '本周', '累计', '套餐额度', '缓存命中率', '模型 (12)', '近 7 天']) {
    assert.ok(out.includes(s), `missing section text: ${s}`);
  }
  assert.ok(out.includes('26,991'), 'allTime requests with separator');
  assert.ok(out.includes('6.41B'), 'allTime tokens');
  assert.ok(out.includes('$168.99'), 'allTime cost');
  assert.ok(out.includes('deepseek-v4-flash'), 'model row');
  assert.ok(out.includes('… +5'), 'model overflow line');
  assert.ok(out.includes('限额 $12'), 'rolling limit');
  assert.ok(out.includes('限额 $30 · 09-14 重置'), 'weekly reset date');
  assert.ok(out.includes('限额 $60 · 10-01 重置'), 'monthly reset date');
});

test('renderGoReport: quota network failure shows degraded line with lastGood anchor', () => {
  const out = renderPlain({
    quota: {
      available: false,
      reason: 'network',
      lastGood: { at: '2026-09-07T08:02:00.000Z', monthlyPercent: 42 },
    },
  });
  assert.ok(out.includes('额度不可用：network'));
  assert.ok(out.includes('上次成功'));
  assert.ok(out.includes('月 42.0%'));
  // local data still rendered
  assert.ok(out.includes('今日'), 'local section survives quota failure');
  assert.ok(!out.includes('限额 $12'), 'no window lines when unavailable');
});

test('renderGoReport: no-subscription degraded state', () => {
  const out = renderPlain({ quota: { available: false, reason: 'no-subscription' } });
  assert.ok(out.includes('未检测到 Go 订阅'));
  assert.ok(out.includes('opencode.ai/auth'));
});

test('renderGoReport: rate-limited window renders !!, full bar, 100% and hint', () => {
  const quota = makeQuota();
  quota.windows.rolling = { status: 'rate-limited', percent: 100, resetsAt: new Date(Date.now() + 38 * MIN).toISOString() };
  const out = renderPlain({ quota });
  assert.ok(out.includes('!!'), 'red !! prefix');
  assert.ok(out.includes('100%'));
  assert.ok(out.includes('▇▇▇▇▇▇▇▇▇▇'), 'full bar');
  assert.ok(out.includes('5 小时窗口已达上限'));
  assert.ok(out.includes('可切换免费模型（opencode/*）'));
});

test('renderGoReport: noColor strips all ANSI escapes; color mode emits them', () => {
  const plain = renderPlain();
  assert.ok(!plain.includes('\x1b['), 'noColor output must contain no escape sequences');

  const colored = renderGoReport({ local: makeLocal(), quota: makeQuota() }, { noColor: false });
  assert.ok(colored.includes('\x1b['), 'colored output contains escape sequences');
});

test('renderGoReport: every line stays within 80 display columns', () => {
  const out = renderPlain();
  for (const line of out.split('\n')) {
    const w = displayWidth(line);
    assert.ok(w <= 80, `line too wide (${w}): ${line}`);
  }
});

test('renderGoReport: sort=cost reorders model table', () => {
  const byReq = renderPlain().split('\n').filter((l) => l.includes('deepseek-v4-flash'));
  assert.ok(byReq.length > 0);
  const costOut = renderPlain({ opts: { sort: 'cost' } });
  const lines = costOut.split('\n');
  const flashIdx = lines.findIndex((l) => l.includes('deepseek-v4-flash'));
  const proIdx = lines.findIndex((l) => l.includes('deepseek-v4-pro'));
  assert.ok(flashIdx > 0 && proIdx > 0, 'both model rows present');
  assert.ok(proIdx < flashIdx, 'deepseek-v4-pro ($92.52) ranks first when sorted by cost');
});

test('renderGoReport: empty local data (S8.1)', () => {
  const local = makeLocal();
  local.today = { requests: 0, tokens: T(0, 0), cost: 0 };
  local.week = { requests: 0, tokens: T(0, 0), cost: 0 };
  local.allTime = { requests: 0, tokens: T(0, 0), cost: 0 };
  local.byModel = [];
  local.byDay = [];
  const out = renderPlain({ local, quota: makeQuota() });
  assert.ok(out.includes('（本机还没有 opencode-go 请求）'));
  assert.ok(out.includes('提示：在 OpenCode 中选择 opencode-go/* 模型开始使用'));
  assert.ok(!out.includes('近 0 天'), 'day table suppressed when no usage');
});

test('renderGoReport: local DB unavailable (S8.5) still renders quota', () => {
  const out = renderPlain({ local: { available: false } });
  assert.ok(out.includes('本地数据库不可用'));
  assert.ok(out.includes('先启动一次 OpenCode'));
  assert.ok(out.includes('套餐额度'), 'quota section still present');
  assert.ok(out.includes('5 小时'), 'window lines still present');
  assert.ok(!out.includes('26,991'), 'no local stats');
});

test('renderGoReport: never throws on missing/degenerate input', () => {
  assert.doesNotThrow(() => renderGoReport({}, { noColor: true }));
  assert.doesNotThrow(() => renderGoReport({ local: { available: true }, quota: { available: true } }, { noColor: true }));
  assert.doesNotThrow(() => renderGoReport({ local: makeLocal(), quota: { available: true, windows: null } }, { noColor: true }));
  const out = renderGoReport({ local: { available: true }, quota: { available: true } }, { noColor: true });
  assert.ok(out.includes('额度数据为空'));
});

test('renderGoReport: hit-rate fallback computed from tokens when not precomputed', () => {
  const local = makeLocal();
  // today: cacheRead 158M / (23.6M + 500k + 158M) ≈ 86.69%
  delete local.today.hitRateOfInput;
  delete local.today.hitRateReadWrite;
  const out = renderPlain({ local });
  assert.ok(out.includes('缓存命中率'));
  assert.ok(out.includes('87.0%'), 'computed 158M/(23.6M input+158M cacheRead) of-input rate');
  assert.ok(out.includes('100.0%'), 'read/write rate = 158M/(158M+0) = 100%');
});

// ---------------------------------------------------------------------------
// renderGoJson
// ---------------------------------------------------------------------------

test('renderGoJson: { generatedAt, local, quota } contract', () => {
  const local = makeLocal();
  const quota = makeQuota();
  const json = renderGoJson(local, quota);
  assert.deepEqual(Object.keys(json).sort(), ['generatedAt', 'local', 'quota']);
  assert.ok(!Number.isNaN(new Date(json.generatedAt).getTime()), 'generatedAt is a valid ISO date');
  assert.equal(json.local, local, 'local passed through by reference');
  assert.equal(json.quota, quota, 'quota passed through by reference');
});

test('renderGoJson: null inputs degrade to null, never throw', () => {
  const json = renderGoJson(null, null);
  assert.equal(json.local, null);
  assert.equal(json.quota, null);
  assert.ok(json.generatedAt);
});
