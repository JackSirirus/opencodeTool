#!/usr/bin/env node
// opencode-usage — terminal usage report for local OpenCode data.
// Zero dependencies; reads the local opencode SQLite DB through src/lib/opencode-data.js.

import { getUsageSummary, DB_PATH } from '../src/lib/opencode-data.js';
import { getGoUsage } from '../src/lib/go-usage.js';
import { getGoQuota } from '../src/lib/go-quota.js';
import { renderGoReport, renderGoJson } from '../src/lib/go-render.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

let useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};
const color = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

/** Humanize token counts: 1.2k / 3.4M / 1.8B. */
function humanizeTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function dollars(n) {
  return `$${n.toFixed(2)}`;
}

/** Display width: CJK & full-width chars count as 2. */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(s, width, align = 'left') {
  const str = String(s);
  const gap = Math.max(0, width - displayWidth(str));
  return align === 'right' ? ' '.repeat(gap) + str : str + ' '.repeat(gap);
}

/** Relative bar for the day table, scaled to `maxWidth` columns. */
function bar(value, max, maxWidth = 14) {
  if (max <= 0 || value <= 0) return color(C.dim, '·'.repeat(maxWidth));
  const n = Math.max(1, Math.round((value / max) * maxWidth));
  return '█'.repeat(n) + color(C.dim, '·'.repeat(maxWidth - n));
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderDayStat(label, stat) {
  const lines = [];
  lines.push(
    `${color(C.bold, pad(label, 12))} ${color(C.green, pad(dollars(stat.cost), 10))} ${pad(humanizeTokens(stat.tokensInput + stat.tokensOutput), 8)} tokens  ${pad(String(stat.sessions), 4)} sessions`
  );
  lines.push(
    `              in ${pad(humanizeTokens(stat.tokensInput), 8)}  out ${pad(humanizeTokens(stat.tokensOutput), 8)}  reasoning ${pad(humanizeTokens(stat.tokensReasoning), 8)}  cache ${humanizeTokens(stat.tokensCacheRead + stat.tokensCacheWrite)}`
  );
  if (stat.topModel) {
    const m = stat.topModel;
    lines.push(`              ${color(C.dim, 'top model')} ${color(C.cyan, `${m.id} / ${m.providerID}`)} ${color(C.dim, dollars(m.cost))}`);
  }
  return lines;
}

function renderModels(models, limit = 5) {
  const rows = models.slice(0, limit);
  if (rows.length === 0) return ['  (no data)'];
  const lines = [
    `  ${color(C.dim, pad('model', 34))}${color(C.dim, pad('cost', 10, 'right'))}${color(C.dim, pad('input', 9, 'right'))}${color(C.dim, pad('output', 9, 'right'))}${color(C.dim, pad('sessions', 9, 'right'))}`,
  ];
  for (const m of rows) {
    lines.push(
      `  ${pad(`${m.id} / ${m.providerID}`.slice(0, 44), 34)}${pad(dollars(m.cost), 10, 'right')}${pad(humanizeTokens(m.tokensInput), 9, 'right')}${pad(humanizeTokens(m.tokensOutput), 9, 'right')}${pad(String(m.sessions), 9, 'right')}`
    );
  }
  return lines;
}

function renderProjects(projects, limit = 5) {
  const rows = projects.slice(0, limit);
  if (rows.length === 0) return ['  (no data)'];
  const lines = [
    `  ${color(C.dim, pad('project', 30))}${color(C.dim, pad('cost', 10, 'right'))}${color(C.dim, pad('input', 9, 'right'))}${color(C.dim, pad('output', 9, 'right'))}${color(C.dim, pad('sessions', 9, 'right'))}`,
  ];
  for (const p of rows) {
    lines.push(
      `  ${pad(p.name.slice(0, 40), 30)}${pad(dollars(p.cost), 10, 'right')}${pad(humanizeTokens(p.tokensInput), 9, 'right')}${pad(humanizeTokens(p.tokensOutput), 9, 'right')}${pad(String(p.sessions), 9, 'right')}`
    );
  }
  return lines;
}

function renderDays(byDay) {
  if (byDay.length === 0) return ['  (no data)'];
  const maxCost = Math.max(...byDay.map((d) => d.cost), 0);
  const todayKey = localTodayKey();
  const lines = [
    `  ${color(C.dim, pad('date', 11))}${color(C.dim, pad('cost', 10, 'right'))}${color(C.dim, pad('input', 9, 'right'))}${color(C.dim, pad('output', 9, 'right'))}${color(C.dim, pad('sessions', 9, 'right'))} ${color(C.dim, 'trend')}`,
  ];
  for (const d of byDay) {
    const isToday = d.date === todayKey;
    lines.push(
      `  ${color(isToday ? C.bold : C.reset, pad(d.date, 11))}${pad(dollars(d.cost), 10, 'right')}${pad(humanizeTokens(d.tokensInput), 9, 'right')}${pad(humanizeTokens(d.tokensOutput), 9, 'right')}${pad(String(d.sessions), 9, 'right')} ${bar(d.cost, maxCost)}${isToday ? color(C.yellow, ' ← today') : ''}`
    );
  }
  return lines;
}

function localTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function section(title) {
  return color(C.bold + C.cyan, `\n${title}\n${'─'.repeat(Math.max(displayWidth(title), 40))}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, days: 7, help: false, noColor: false, subcommand: null, sort: 'requests', quota: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--no-color') {
      opts.noColor = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--days') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) opts.days = Math.floor(v);
    } else if (arg.startsWith('--days=')) {
      const v = Number(arg.slice('--days='.length));
      if (Number.isFinite(v) && v > 0) opts.days = Math.floor(v);
    } else if (arg === '--sort') {
      const v = String(argv[++i] || '').toLowerCase();
      opts.sort = v === 'cost' ? 'cost' : 'requests';
    } else if (arg.startsWith('--sort=')) {
      const v = arg.slice('--sort='.length).toLowerCase();
      opts.sort = v === 'cost' ? 'cost' : 'requests';
    } else if (arg === '--quota') {
      opts.quota = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`unknown flag ignored: ${arg}\n`);
    } else if (opts.subcommand === null) {
      opts.subcommand = arg;
    } else {
      process.stderr.write(`extra argument ignored: ${arg}\n`);
    }
  }
  return opts;
}

const HELP = `
opencode-usage — OpenCode 本地用量报告（只读读取 opencode.db）

Usage:
  node bin/opencode-usage.js [subcommand] [flags]

Subcommands:
  (default)   full summary: today / week / all-time + top models + top projects + last-N-day table
  today       today's stats only
  week        this week (last N days) stats + day table
  all         all-time stats + top models + top projects
  projects    top projects table (all-time, top 10)
  models      top models table (all-time, top 10)
  days        day-by-day table
  go          OpenCode Go plan usage + quota (opencode-go provider)

Flags:
  --json         print the raw summary JSON instead of formatted output
  --days N       number of days for week/day buckets (default 7)
  --sort X       sort models by "requests" (default) or "cost" (go only)
  --quota        force refresh quota from API, bypassing 5-min cache (go only)
  --no-color     disable ANSI colors
  -h, --help     show this help
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.noColor) useColor = false;
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // --- go subcommand routes BEFORE --json interception -----------------------
  if (opts.subcommand === 'go') {
    const local = await getGoUsage({ days: opts.days });
    const quota = await getGoQuota({ force: !!opts.quota });
    if (opts.json) {
      process.stdout.write(JSON.stringify(renderGoJson(local, quota), null, 2) + '\n');
    } else {
      // process.stdout.write, not console.log: console.log goes through the
      // async stdout machinery and gets truncated when output is piped.
      process.stdout.write(renderGoReport({ local, quota }, { days: opts.days, sort: opts.sort, noColor: !useColor }) + '\n');
    }
    // exitCode, not process.exit: exit() can truncate piped async stdout on
    // Windows; setting exitCode lets the process drain and exit normally.
    process.exitCode = local.available ? 0 : 1;
    return;
  }

  const summary = await getUsageSummary({ days: opts.days });

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  if (!summary.available) {
    process.stdout.write(
      `${color(C.red, '✗')} 无法读取 OpenCode 数据库 (opencode.db not found or unreadable)\n` +
        `${color(C.dim, `   expected path: ${DB_PATH}`)}\n` +
        `${color(C.dim, '   提示：先启动过一次 OpenCode 后数据库才会生成。')}\n`
    );
    return;
  }

  const sub = opts.subcommand;

  if (sub === 'today') {
    process.stdout.write(renderDayStat('今日', summary.today).join('\n') + '\n');
  } else if (sub === 'week') {
    process.stdout.write(renderDayStat(`本周(${opts.days}天)`, summary.week).join('\n') + '\n');
    process.stdout.write(section(`最近 ${opts.days} 天`));
    process.stdout.write('\n' + renderDays(summary.byDay).join('\n') + '\n');
  } else if (sub === 'all') {
    process.stdout.write(renderDayStat('累计', summary.allTime).join('\n') + '\n');
    process.stdout.write(section('模型 Top 10（累计）'));
    process.stdout.write('\n' + renderModels(summary.byModel, 10).join('\n') + '\n');
    process.stdout.write(section('项目 Top 10（累计）'));
    process.stdout.write('\n' + renderProjects(summary.byProject, 10).join('\n') + '\n');
  } else if (sub === 'projects') {
    process.stdout.write(section('项目 Top 10（累计）'));
    process.stdout.write('\n' + renderProjects(summary.byProject, 10).join('\n') + '\n');
  } else if (sub === 'models') {
    process.stdout.write(section('模型 Top 10（累计）'));
    process.stdout.write('\n' + renderModels(summary.byModel, 10).join('\n') + '\n');
  } else if (sub === 'days') {
    process.stdout.write(section(`最近 ${opts.days} 天`));
    process.stdout.write('\n' + renderDays(summary.byDay).join('\n') + '\n');
  } else {
    // default: full summary
    process.stdout.write(renderDayStat('今日', summary.today).join('\n') + '\n');
    process.stdout.write(renderDayStat(`本周(${opts.days}天)`, summary.week).join('\n') + '\n');
    process.stdout.write(renderDayStat('累计', summary.allTime).join('\n') + '\n');
    process.stdout.write(section('模型 Top 5（累计）'));
    process.stdout.write('\n' + renderModels(summary.byModel).join('\n') + '\n');
    process.stdout.write(section('项目 Top 5（累计）'));
    process.stdout.write('\n' + renderProjects(summary.byProject).join('\n') + '\n');
    process.stdout.write(section(`最近 ${opts.days} 天`));
    process.stdout.write('\n' + renderDays(summary.byDay).join('\n') + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
