/* ============================================================
 * OpenCode 用量小窗口 — 渲染进程
 * 职责：消费主进程通过 IPC 推送的 usage 数据并安全渲染
 * 设计原则：所有 null/undefined 都降级为 "—"，不抛错
 * IPC：通过 preload.cjs 暴露的 window.widget 桥接访问主进程
 * ============================================================ */

// ---- formatting helpers ---------------------------------------------------

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const intFmt0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const WEEKDAYS_CN = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_EN_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtCost(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return usdFmt.format(v);
}

function fmtTokens(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 1_000) return intFmt0.format(v);
  if (v < 1_000_000) {
    const k = v / 1_000;
    return (k < 10 ? k.toFixed(2) : k < 100 ? k.toFixed(1) : k.toFixed(0)) + "k";
  }
  if (v < 1_000_000_000) {
    const m = v / 1_000_000;
    return (m < 10 ? m.toFixed(2) : m.toFixed(1)) + "M";
  }
  return (v / 1_000_000_000).toFixed(2) + "B";
}

function fmtSessions(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return intFmt0.format(v);
}

// Requests share the sessions formatter: integer with thousands separators
// (en-US locale → "26,991", 设计 S7 大数字规则).
const fmtRequests = fmtSessions;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "—";
  }
}

function basename(p) {
  if (!p || typeof p !== "string") return "";
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function safeStr(v, max = 18) {
  if (v == null) return "—";
  const s = String(v);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---- DOM references -------------------------------------------------------

const els = {
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  heroUpdated: document.getElementById("hero-updated"),
  heroCost: document.getElementById("hero-cost"),
  heroIn: document.getElementById("hero-in"),
  heroOut: document.getElementById("hero-out"),
  heroSessions: document.getElementById("hero-sessions"),
  weekCost: document.getElementById("week-cost"),
  weekMeta: document.getElementById("week-meta"),
  allCost: document.getElementById("all-cost"),
  allMeta: document.getElementById("all-meta"),
  chartHint: document.getElementById("chart-hint"),
  chartBody: document.getElementById("chart-body"),
  listModels: document.getElementById("list-models"),
  listProjects: document.getElementById("list-projects"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnClose: document.getElementById("btn-close"),

  // Go tab (T6 DOM) — ids are go- prefixed, fee ids untouched
  headerDot: document.querySelector("#header .brand__dot"),
  tabFee: document.getElementById("tab-fee"),
  tabGo: document.getElementById("tab-go"),
  paneFee: document.getElementById("pane-fee"),
  paneGo: document.getElementById("pane-go"),
  goHeroUpdated: document.getElementById("go-hero-updated"),
  goHeroCost: document.getElementById("go-hero-cost"),
  goHeroSub: document.getElementById("go-hero-sub"),
  goQuotaSection: document.querySelector("#pane-go .go-quota"),
  goQuotaSrc: document.getElementById("go-quota-src"),
  goQuotaRolling: document.getElementById("go-quota-rolling"),
  goQuotaWeekly: document.getElementById("go-quota-weekly"),
  goQuotaMonthly: document.getElementById("go-quota-monthly"),
  goHitToday: document.getElementById("go-hit-today"),
  goHitAlltime: document.getElementById("go-hit-alltime"),
  goRowWeek: document.getElementById("go-row-week"),
  goRowAll: document.getElementById("go-row-all"),
  goModelCount: document.getElementById("go-model-count"),
  goListModels: document.getElementById("go-list-models"),
  goFootHitrate: document.getElementById("go-foot-hitrate"),

  // Compact mode (v0.3) — paneFee/paneGo are already referenced above
  btnCompact: document.getElementById("btn-compact"),
  card: document.getElementById("card"),
  header: document.getElementById("header"),
};

// Quota windows in display order: key in payload → row element → banner label
const QUOTA_WINDOWS = [
  { key: "rolling", row: () => els.goQuotaRolling, label: "5 小时" },
  { key: "weekly", row: () => els.goQuotaWeekly, label: "每周" },
  { key: "monthly", row: () => els.goQuotaMonthly, label: "每月" },
];

// ---- render: hero (today) -------------------------------------------------

function renderHero(today) {
  els.heroCost.textContent = fmtCost(today?.cost);
  els.heroIn.textContent = fmtTokens(today?.tokensInput);
  els.heroOut.textContent = fmtTokens(today?.tokensOutput);
  els.heroSessions.textContent = fmtSessions(today?.sessions);
}

// ---- render: rows (week / all-time) ---------------------------------------

function renderRow(rowEl, costEl, metaEl, bucket) {
  costEl.textContent = fmtCost(bucket?.cost);
  const tin = fmtTokens(bucket?.tokensInput);
  const tout = fmtTokens(bucket?.tokensOutput);
  const sess = fmtSessions(bucket?.sessions);
  metaEl.textContent = `${tin} in · ${sess} 会话`;
  // secondary detail (optional, on hover/title) — keep DOM clean for the small window
  rowEl.title = `${usdFmt.format(bucket?.cost ?? 0)} · 输入 ${intFmt0.format(
    bucket?.tokensInput ?? 0,
  )} · 输出 ${intFmt0.format(bucket?.tokensOutput ?? 0)} · ${intFmt0.format(
    bucket?.sessions ?? 0,
  )} 会话`;
}

function renderRows(week, allTime) {
  renderRow(els.weekCost.parentElement, els.weekCost, els.weekMeta, week);
  renderRow(
    els.allCost.parentElement,
    els.allCost,
    els.allMeta,
    allTime,
  );
}

// ---- render: 7-day chart --------------------------------------------------

function renderChart(byDay) {
  const days = Array.isArray(byDay) ? byDay : [];
  // Pad / truncate to 7 buckets so the layout never breaks
  const buckets = days.slice(-7);
  while (buckets.length < 7) {
    buckets.unshift(null);
  }

  const maxCost = buckets.reduce(
    (m, b) => Math.max(m, b && b.cost > 0 ? b.cost : 0),
    0,
  );

  const todayKey = isoDayKey(new Date());

  const frag = document.createDocumentFragment();
  buckets.forEach((b) => {
    const bar = document.createElement("div");
    bar.className = "bar";

    let pct = 0;
    if (b && Number.isFinite(b.cost) && b.cost > 0 && maxCost > 0) {
      pct = Math.max(6, (b.cost / maxCost) * 100);
    }

    const isToday = b && b.date === todayKey;
    const isEmpty = !b || !Number.isFinite(b.cost) || b.cost <= 0;

    if (isEmpty) {
      bar.classList.add("bar--empty");
      bar.style.height = "2px";
    } else {
      bar.style.height = `${pct}%`;
    }

    if (isToday) bar.classList.add("bar--today");

    // date label
    const label = document.createElement("span");
    label.className = "bar__day";
    if (b && b.date) {
      const d = new Date(b.date + "T00:00:00");
      if (!Number.isNaN(d.getTime())) {
        label.textContent = WEEKDAYS_EN_SHORT[d.getDay()];
      } else {
        label.textContent = "·";
      }
    } else {
      label.textContent = "·";
    }
    bar.appendChild(label);

    if (b) {
      bar.title = `${b.date || "—"} · ${fmtCost(b.cost)} · ${fmtSessions(
        b.sessions,
      )} 会话`;
    } else {
      bar.title = "无数据";
    }

    frag.appendChild(bar);
  });

  els.chartBody.replaceChildren(frag);

  // Hint text — sum of last 7 days
  const sum7 = buckets.reduce(
    (s, b) => s + (b && Number.isFinite(b.cost) ? b.cost : 0),
    0,
  );
  els.chartHint.textContent = `合计 ${fmtCost(sum7)}`;
}

// ---- render: top-3 lists --------------------------------------------------

function renderList(listEl, items, nameFn) {
  const safe = Array.isArray(items) ? items : [];
  listEl.replaceChildren();

  if (safe.length === 0) {
    const empty = document.createElement("li");
    empty.className = "list__empty";
    empty.textContent = "暂无数据";
    listEl.appendChild(empty);
    return;
  }

  safe.slice(0, 3).forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "list__item";

    const idx = document.createElement("span");
    idx.className = "list__idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "list__name";
    name.textContent = safeStr(nameFn(item), 16);

    const cost = document.createElement("span");
    cost.className = "list__cost";
    cost.textContent = fmtCost(item?.cost);

    li.title = `${nameFn(item) || "—"} · ${fmtCost(item?.cost)} · ${fmtSessions(
      item?.sessions,
    )} 会话`;

    li.append(idx, name, cost);
    listEl.appendChild(li);
  });

  if (safe.length < 3) {
    for (let i = safe.length; i < 3; i++) {
      const li = document.createElement("li");
      li.className = "list__item";
      li.style.opacity = "0.35";
      li.innerHTML =
        '<span class="list__idx">··</span><span class="list__name">—</span><span class="list__cost">—</span>';
      listEl.appendChild(li);
    }
  }
}

function renderLists(byModel, byProject) {
  renderList(els.listModels, byModel, (m) => {
    if (!m) return "—";
    const id = m.id || "unknown";
    const provider = m.providerID ? ` · ${m.providerID}` : "";
    return `${id}${provider}`;
  });
  renderList(els.listProjects, byProject, (p) => {
    if (!p) return "—";
    if (p.name) return String(p.name);
    return basename(p.worktree) || "—";
  });
}

// ---- Go tab state (module-level, S1-S6 source of truth) --------------------
// Three independent data sources, independently degraded (设计 v0.2 S10):
//   - lastUsage: fee summary via usage:update (shared channel). It also carries
//     DB availability for the Go pane's local sections; a future go-shaped
//     payload (today.requests present) is adopted wholesale by extractGoLocal.
//   - lastQuota: server quota via quota:update {available, reason?, windows?,
//     lastGood?}. The two sources render independently, never block each other.
//   - lastGoLocal: Go local usage via go-local:update / go:local:initial —
//     the authoritative source for the Go pane's local sections. Fetched
//     lazily on the first Go-tab open (the ~2.5s DB scan must not run unless
//     the user actually looks at Go); afterwards pushed on the 5min cadence.
let activePane = "fee";
let lastUsage = null;
let lastQuota = null;
let lastGoLocal = null;
let goLocalFetchInFlight = false;
let isCompact = false;

// v0.3 compact toggle icons: chevron-down = shrink, chevron-up = expand
const SVG_SHRINK = '<path d="M4 6.5 8 10.5 12 6.5" />';
const SVG_EXPAND = '<path d="M4 9.5 8 5.5 12 9.5" />';

function rateLimitedBannerLine(rl) {
  return `Go 已达 ${rl.label}上限 · 重置后自动恢复 · 期间可切免费模型（opencode/*）`;
}

// First rate-limited window in display order, or null.
function findRateLimited(quota) {
  if (!quota || quota.available !== true || !quota.windows) return null;
  for (const w of QUOTA_WINDOWS) {
    const win = quota.windows[w.key];
    if (win && win.status === "rate-limited") return { key: w.key, label: w.label };
  }
  return null;
}

// Shared #banner (S10): max 1 banner; rate-limited (red) > DB unavailable
// (amber); both at once → one merged red banner, two lines. Quota-area
// failures (S3/S4) never touch the banner.
function renderBanner() {
  els.banner.classList.remove("go-banner--danger", "go-banner--multi");
  const rl = findRateLimited(lastQuota);
  const dbDown = !!(lastUsage && lastUsage.available === false);
  if (rl && dbDown) {
    els.bannerText.textContent =
      `${rateLimitedBannerLine(rl)}\n本地数据库不可用，等待中…（每 30s 重试）`;
    els.banner.classList.add("go-banner--danger", "go-banner--multi");
    els.banner.classList.remove("banner--hidden");
  } else if (rl) {
    els.bannerText.textContent = rateLimitedBannerLine(rl);
    els.banner.classList.add("go-banner--danger");
    els.banner.classList.remove("banner--hidden");
  } else if (dbDown) {
    // fee tab's existing amber banner — behavior preserved verbatim
    els.bannerText.textContent = "数据库不可用，等待中…";
    els.banner.classList.remove("banner--hidden");
  } else {
    els.banner.classList.add("banner--hidden");
  }
}

// Header dot: red = rate-limited (S5), gray = no subscription (S4) or DB down (S6)
function renderDot() {
  const rl = findRateLimited(lastQuota);
  const quotaDead =
    lastQuota &&
    lastQuota.available === false &&
    (lastQuota.reason === "no-subscription" || lastQuota.reason === "no-credentials");
  const dbDown = !!(lastUsage && lastUsage.available === false);
  els.headerDot.classList.toggle("go-dot--red", !!rl);
  els.headerDot.classList.toggle("go-dot--gray", !rl && !!(quotaDead || dbDown));
}

function renderGoChrome() {
  renderBanner();
  renderDot();
  // compact Go rows live outside the full quota DOM — keep them fresh on pushes
  if (isCompact && activePane === "go") {
    renderCompactGo(lastQuota, currentGoLocal());
  }
  renderStateTag();
}

// ---- Go pane: quota section (server data, violet) ---------------------------

// rolling → countdown "2h11m 后重置"; weekly/monthly → "MM-DD 重置" (S7 bounds)
function resetLabel(key, resetsAt) {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "—";
  if (key === "rolling") {
    const delta = t - Date.now();
    if (delta <= 0) return "等待刷新";
    if (delta < 60_000) return "即将重置";
    const totalMin = Math.floor(delta / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`} 后重置`;
  }
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd} 重置`;
}

function renderQuotaRow(rowEl, win, key) {
  const bar = rowEl.querySelector(".go-qrow__bar");
  const fill = rowEl.querySelector(".go-qrow__fill");
  const v = rowEl.querySelector(".go-qrow__v");
  const r = rowEl.querySelector(".go-qrow__r");
  bar.classList.remove("go-skeleton");
  rowEl.classList.remove("hit", "warn");
  if (!win || typeof win !== "object") {
    fill.style.width = "0%";
    v.textContent = "—";
    r.textContent = "—";
    return;
  }
  const limited = win.status === "rate-limited";
  let pct = Number(win.percent);
  pct = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  if (limited) pct = 100; // rate-limited is always full (设计 S7)
  fill.style.width = `${pct}%`;
  v.textContent = `${Math.round(pct)}%`;
  // color ladder: >=80 hit / >=50 warn / else violet; banner only follows status
  if (limited || pct >= 80) rowEl.classList.add("hit");
  else if (pct >= 50) rowEl.classList.add("warn");
  r.textContent = resetLabel(key, win.resetsAt);
}

// S3/S4: collapse the three window bars into a two-line degraded text block
function setQuotaDegraded(line1, line2) {
  QUOTA_WINDOWS.forEach(({ row }) => {
    const el = row();
    el.hidden = true;
    el.classList.remove("hit", "warn");
    el.querySelector(".go-qrow__bar").classList.remove("go-skeleton");
  });
  let box = els.goQuotaSection.querySelector(".go-qdown");
  if (!box) {
    box = document.createElement("div");
    box.className = "go-qdown";
    els.goQuotaSection.appendChild(box);
  }
  box.textContent = line2 ? `${line1}\n${line2}` : line1;
}

function renderGoQuota(quota) {
  lastQuota = quota && typeof quota === "object" ? quota : null;
  const q = lastQuota;

  // S1 — skeleton bars until the first quota payload lands
  if (!q) {
    els.goQuotaSrc.textContent = "连接中";
    els.goQuotaSrc.classList.remove("go-quota__src--down");
    els.goQuotaSection.querySelector(".go-qdown")?.remove();
    QUOTA_WINDOWS.forEach(({ row }) => {
      const el = row();
      el.hidden = false;
      el.classList.remove("hit", "warn");
      el.querySelector(".go-qrow__bar").classList.add("go-skeleton");
      el.querySelector(".go-qrow__fill").style.width = "0%";
      el.querySelector(".go-qrow__v").textContent = "··";
      el.querySelector(".go-qrow__r").textContent = "···";
    });
    return;
  }

  if (q.available === false) {
    const reason = String(q.reason || "");
    els.goQuotaSection.querySelector(".go-qdown")?.remove();
    if (reason === "no-subscription" || reason === "no-credentials") {
      // S4 — deterministic state, gray dot, never a banner
      els.goQuotaSrc.textContent = "未检测到 Go 订阅";
      els.goQuotaSrc.classList.add("go-quota__src--down");
      setQuotaDegraded(
        "auth.json 中无 opencode-go 凭据，或订阅已过期。",
        "订阅 / 换 key → opencode.ai/auth · 本地统计不受影响",
      );
    } else {
      // S3 — network/timeout: degraded in-area with a lastGood anchor
      els.goQuotaSrc.textContent = "额度数据不可用";
      els.goQuotaSrc.classList.add("go-quota__src--down");
      const lg = q.lastGood;
      let anchor = "上次成功：—";
      if (lg && lg.fetchedAt) {
        const mp = lg.windows && lg.windows.monthly;
        const mpTxt =
          mp && Number.isFinite(mp.percent) ? `（月 ${Math.round(mp.percent)}%）` : "";
        anchor = `上次成功：${fmtTime(lg.fetchedAt)}${mpTxt}`;
      }
      setQuotaDegraded("⚠ 无法连接 opencode.ai —— 检查网络后点 ↻ 重试", anchor);
    }
    return;
  }

  // normal / rate-limited — three window rows
  els.goQuotaSrc.textContent = "server";
  els.goQuotaSrc.classList.remove("go-quota__src--down");
  els.goQuotaSection.querySelector(".go-qdown")?.remove();
  QUOTA_WINDOWS.forEach(({ key, row }) => {
    const el = row();
    el.hidden = false;
    renderQuotaRow(el, q.windows ? q.windows[key] : null, key);
  });
}

// ---- Go pane: local sections (amber/cyan, independent of quota) -------------

// The dedicated go-local channel is authoritative once it has delivered a
// payload; until then the usage channel is still consulted (forward-compat:
// a go-shaped payload embedded in usage:update is adopted wholesale).
function currentGoLocal() {
  if (lastGoLocal) return lastGoLocal;
  return extractGoLocal(lastUsage);
}

// The usage channel currently carries the fee summary (all providers). When a
// go-shaped payload appears (today.requests finite) it is adopted wholesale;
// until then local sections degrade to "—" instead of showing wrong numbers.
function extractGoLocal(summary) {
  if (!summary || typeof summary !== "object") return null;
  const nested = summary.go && typeof summary.go === "object" ? summary.go : null;
  if (nested && nested.today && Number.isFinite(nested.today.requests)) return nested;
  if (summary.today && Number.isFinite(summary.today.requests)) return summary;
  return null;
}

function setHitRate(rowEl, rate) {
  const fill = rowEl.querySelector(".go-hit__fill");
  const v = rowEl.querySelector(".go-hit__v");
  if (rate == null || !Number.isFinite(rate)) {
    fill.style.width = "0%";
    v.textContent = "—";
    return;
  }
  const pct = Math.min(100, Math.max(0, rate * 100));
  fill.style.width = `${pct}%`;
  v.textContent = `${pct.toFixed(1)}%`;
}

function setGoRow(rowEl, bucket) {
  const req = rowEl.querySelector(".go-row__req");
  const meta = rowEl.querySelector(".go-row__meta");
  if (!bucket || typeof bucket !== "object") {
    req.textContent = "—";
    meta.textContent = "— tok · $—";
    return;
  }
  const unit = document.createElement("small");
  unit.textContent = "次";
  req.replaceChildren(document.createTextNode(fmtRequests(bucket.requests)), unit);
  meta.textContent = `${fmtTokens(bucket.tokens?.total)} tok · ${fmtCost(bucket.cost)}`;
}

function renderGoModels(byModel, emptyText) {
  const list = Array.isArray(byModel) ? byModel : [];
  els.goModelCount.textContent = String(list.length);
  els.goListModels.replaceChildren();
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "go-list__item go-list__empty";
    li.textContent = emptyText || "暂无数据";
    els.goListModels.appendChild(li);
    return;
  }
  list.slice(0, 3).forEach((m, i) => {
    const li = document.createElement("li");
    li.className = "go-list__item";
    li.title = `${m?.id || "—"} · ${fmtSessions(m?.requests)} 次 · ${fmtCost(m?.cost)}`;

    const idx = document.createElement("span");
    idx.className = "go-list__idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const nm = document.createElement("span");
    nm.className = "go-list__nm";
    nm.textContent = safeStr(m?.id, 20);

    const rq = document.createElement("span");
    rq.className = "go-list__rq";
    rq.textContent = fmtSessions(m?.requests);

    const co = document.createElement("span");
    co.className = "go-list__co";
    co.textContent = fmtCost(m?.cost);

    li.append(idx, nm, rq, co);
    els.goListModels.appendChild(li);
  });
}

function renderGoLocal() {
  const summary = currentGoLocal();
  const dim = (on) => els.goHeroCost.classList.toggle("go-hero--dim", on);

  // S1 — before the first usage payload arrives (tabs/close stay usable)
  if (!summary) {
    dim(true);
    els.goHeroUpdated.textContent = "—";
    els.goHeroCost.textContent = "···";
    els.goHeroSub.textContent = "获取数据中…";
    setHitRate(els.goHitToday, null);
    setHitRate(els.goHitAlltime, null);
    setGoRow(els.goRowWeek, null);
    setGoRow(els.goRowAll, null);
    renderGoModels(null, "加载中…");
    els.goFootHitrate.textContent = "读写占比 —";
    return;
  }

  els.goHeroUpdated.textContent = fmtTime(summary.generatedAt);

  // S6 — DB unavailable: local "—", quota section keeps working
  if (summary.available === false) {
    dim(true);
    els.goHeroCost.textContent = "—";
    els.goHeroSub.textContent = "— tok · $— · —";
    setHitRate(els.goHitToday, null);
    setHitRate(els.goHitAlltime, null);
    setGoRow(els.goRowWeek, null);
    setGoRow(els.goRowAll, null);
    renderGoModels(null, "等待本地数据库…");
    els.goFootHitrate.textContent = "读写占比 —";
    return;
  }

  const go = extractGoLocal(summary);
  if (!go) {
    // Channel alive but no go-shaped payload yet — graceful "—", not fake data
    dim(true);
    els.goHeroCost.textContent = "—";
    els.goHeroSub.textContent = "— tok · $— · —";
    setHitRate(els.goHitToday, null);
    setHitRate(els.goHitAlltime, null);
    setGoRow(els.goRowWeek, null);
    setGoRow(els.goRowAll, null);
    renderGoModels(null, "暂无数据");
    els.goFootHitrate.textContent = "读写占比 —";
    return;
  }

  // Go-shaped payload: S2 (all zero) and normal share one render path
  dim(false);
  const today = go.today || {};
  els.goHeroCost.textContent = fmtRequests(today.requests);
  els.goHeroSub.textContent = `${fmtTokens(today.tokens?.total)} tok · ${fmtCost(
    today.cost,
  )} · ${fmtTime(go.generatedAt || summary.generatedAt)}`;
  setHitRate(els.goHitToday, today.hitRateOfInput);
  setHitRate(els.goHitAlltime, go.allTime?.hitRateOfInput);
  setGoRow(els.goRowWeek, go.week);
  setGoRow(els.goRowAll, go.allTime);
  const totalReq = Number(go.allTime?.requests);
  const emptyText =
    totalReq === 0
      ? "本机还没有 opencode-go 请求 · 在 OpenCode 里选 Go 模型开始使用"
      : "暂无数据";
  renderGoModels(go.byModel, emptyText);
  const rw = go.allTime?.hitRateReadWrite;
  els.goFootHitrate.textContent =
    "读写占比 " +
    (rw == null || !Number.isFinite(rw) ? "—" : `${(rw * 100).toFixed(2)}%`);
}

// ---- compact mode (v0.3) ----------------------------------------------------
// Compact content lives outside the panes as direct children of .card
// (design: 三行费用清单 / 三行额度 / 单行降级, all c- prefixed). `.card.is-compact`
// hides the panes via CSS; this module shows exactly one compact block.

let compactEls = null;
let compactGoDegraded = false;

function ensureCompactDom() {
  if (compactEls) return compactEls;

  const feeRows = document.createElement("div");
  feeRows.className = "c-fee-rows";
  feeRows.style.display = "none";
  feeRows.innerHTML = `
    <div class="c-fee-row"><span class="c-fee-row__k">今日</span><span class="c-fee-row__v">···</span></div>
    <div class="c-fee-row"><span class="c-fee-row__k">本周</span><span class="c-fee-row__v">···</span></div>
    <div class="c-fee-row c-fee-row--strong"><span class="c-fee-row__k">累计</span><span class="c-fee-row__v">···</span></div>`;

  const goRows = document.createElement("div");
  goRows.className = "c-go-rows";
  goRows.style.display = "none";
  goRows.innerHTML = `
    <div class="c-go-row"><span class="c-go-row__n">5小时</span><span class="c-go-row__bar"><span class="c-go-row__fill"></span></span><span class="c-go-row__v">···</span><span class="c-go-row__r">···</span></div>
    <div class="c-go-row"><span class="c-go-row__n">本周</span><span class="c-go-row__bar"><span class="c-go-row__fill"></span></span><span class="c-go-row__v">···</span><span class="c-go-row__r">···</span></div>
    <div class="c-go-row"><span class="c-go-row__n">本月</span><span class="c-go-row__bar"><span class="c-go-row__fill"></span></span><span class="c-go-row__v">···</span><span class="c-go-row__r">···</span></div>`;

  const degrade = document.createElement("div");
  degrade.className = "c-degrade";
  degrade.style.display = "none";

  // state tag, right of the brand title (design S3/S4/S5/S8)
  const tag = document.createElement("span");
  tag.className = "c-tag";
  const title = els.headerDot.parentElement.querySelector(".brand__title");
  if (title) title.after(tag);
  else els.headerDot.parentElement.appendChild(tag);

  els.card.append(feeRows, goRows, degrade);
  const feeVals = feeRows.querySelectorAll(".c-fee-row__v");
  compactEls = {
    feeRows,
    feeToday: feeVals[0],
    feeWeek: feeVals[1],
    feeAll: feeVals[2],
    goRows,
    goRowEls: Array.from(goRows.querySelectorAll(".c-go-row")),
    degrade,
    tag,
  };
  return compactEls;
}

// Compact fee: 今日 / 本周 / 累计 (US-02; S6 loading, S8 DB down)
function renderCompactFee(summary) {
  const c = ensureCompactDom();
  if (!summary || typeof summary !== "object") {
    c.feeToday.textContent = c.feeWeek.textContent = c.feeAll.textContent = "···";
    return;
  }
  if (summary.available === false) {
    c.feeToday.textContent = c.feeWeek.textContent = c.feeAll.textContent = "—";
    return;
  }
  c.feeToday.textContent = fmtCost(summary.today?.cost);
  c.feeWeek.textContent = fmtCost(summary.week?.cost);
  c.feeAll.textContent = fmtCost(summary.allTime?.cost);
}

// rolling → "2h11m"; weekly/monthly → "09-14" (short format, design S2)
function resetLabelShort(key, resetsAt) {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "—";
  if (key === "rolling") {
    const delta = t - Date.now();
    if (delta <= 0) return "等待刷新";
    if (delta < 60_000) return "即将重置";
    const totalMin = Math.floor(delta / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

// Compact quota row: same percent ladder as full mode, short reset format
function renderCompactQuotaRow(rowEl, win, key) {
  const bar = rowEl.querySelector(".c-go-row__bar");
  const fill = rowEl.querySelector(".c-go-row__fill");
  const v = rowEl.querySelector(".c-go-row__v");
  const r = rowEl.querySelector(".c-go-row__r");
  bar.classList.remove("c-skeleton");
  rowEl.classList.remove("hit", "warn");
  if (!win || typeof win !== "object") {
    fill.style.width = "0%";
    v.textContent = "—";
    r.textContent = "—";
    return;
  }
  const limited = win.status === "rate-limited";
  let pct = Number(win.percent);
  pct = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  if (limited) pct = 100; // rate-limited is always full (设计 S3)
  fill.style.width = `${pct}%`;
  v.textContent = `${Math.round(pct)}%`;
  if (limited || pct >= 80) rowEl.classList.add("hit");
  else if (pct >= 50) rowEl.classList.add("warn");
  r.textContent = resetLabelShort(key, win.resetsAt);
}

// Compact Go: three quota rows; loading = skeleton, unavailable = one-line
// degrade block (S4/S5/S6). `goLocal` is accepted for the dispatcher signature
// (S7 keeps showing quota rows by default, so it is not consulted).
function renderCompactGo(quota, goLocal) {
  const c = ensureCompactDom();
  const q = quota && typeof quota === "object" ? quota : null;

  if (!q) {
    // S6 — skeleton rows until the first quota payload lands
    compactGoDegraded = false;
    c.goRowEls.forEach((row) => {
      row.classList.remove("hit", "warn");
      row.querySelector(".c-go-row__bar").classList.add("c-skeleton");
      row.querySelector(".c-go-row__fill").style.width = "0%";
      row.querySelector(".c-go-row__v").textContent = "···";
      row.querySelector(".c-go-row__r").textContent = "···";
    });
    return;
  }

  if (q.available === false) {
    // S4/S5 — collapse the three rows into one degraded line
    compactGoDegraded = true;
    c.degrade.textContent =
      q.reason === "no-subscription" || q.reason === "no-credentials"
        ? "无 opencode-go 凭据"
        : "额度数据不可用 · 点 ↻ 重试";
    return;
  }

  compactGoDegraded = false;
  QUOTA_WINDOWS.forEach(({ key }, i) => {
    renderCompactQuotaRow(c.goRowEls[i], q.windows ? q.windows[key] : null, key);
  });
}

// Compact header state: dot color + conditional tag (US-05). The standalone
// banner is suppressed in compact (决策 11) — state lives in the header.
function renderStateTag() {
  if (!isCompact) {
    // leaving compact — restore full-mode chrome owned by renderBanner/renderDot
    els.headerDot.classList.remove("is-red", "is-gray");
    if (compactEls) {
      compactEls.tag.textContent = "";
      compactEls.tag.className = "c-tag";
      compactEls.tag.title = "";
      compactEls.feeRows.style.display = "none";
      compactEls.goRows.style.display = "none";
      compactEls.degrade.style.display = "none";
    }
    return;
  }

  const c = ensureCompactDom();
  els.banner.classList.add("banner--hidden");

  const rl = findRateLimited(lastQuota);
  const quotaDown = !!(lastQuota && lastQuota.available === false);
  const dbDown = !!(lastUsage && lastUsage.available === false);

  els.headerDot.classList.toggle("is-red", !!rl);
  els.headerDot.classList.toggle("is-gray", !rl && (quotaDown || dbDown));

  if (rl) {
    c.tag.textContent = "限流";
    c.tag.className = "c-tag c-tag--danger";
    c.tag.title = rateLimitedBannerLine(rl);
  } else if (quotaDown) {
    c.tag.className = "c-tag c-tag--muted";
    if (
      lastQuota.reason === "no-subscription" ||
      lastQuota.reason === "no-credentials"
    ) {
      c.tag.textContent = "无订阅";
      c.tag.title = "auth.json 中无 opencode-go 凭据，或订阅已过期";
    } else {
      c.tag.textContent = "额度离线";
      c.tag.title = "无法连接 opencode.ai · 检查网络后点 ↻ 重试";
    }
  } else if (dbDown) {
    c.tag.textContent = "本地离线";
    c.tag.className = "c-tag c-tag--muted";
    c.tag.title = "数据库不可用，等待中…（每 30s 重试）";
  } else {
    c.tag.textContent = "";
    c.tag.className = "c-tag";
    c.tag.title = "";
  }

  // exactly one compact block is visible for the active pane
  const showFee = activePane === "fee";
  c.feeRows.style.display = showFee ? "" : "none";
  c.goRows.style.display = !showFee && !compactGoDegraded ? "" : "none";
  c.degrade.style.display = !showFee && compactGoDegraded ? "" : "none";
}

// Compact content for the active pane + chrome (pane switch / toggle / updates)
function renderCompact() {
  if (activePane === "fee") {
    renderCompactFee(lastUsage);
  } else {
    renderCompactGo(lastQuota, currentGoLocal());
  }
  renderStateTag();
}

// Sync toggle button icon/classes + re-render for the current mode
function applyCompactMode() {
  els.btnCompact.querySelector("svg").innerHTML = isCompact
    ? SVG_EXPAND
    : SVG_SHRINK;
  els.btnCompact.title = isCompact ? "放大" : "缩小";
  els.btnCompact.setAttribute("aria-label", isCompact ? "放大" : "缩小");
  els.card.classList.toggle("is-compact", isCompact);
  els.header.classList.toggle("c-head--compact", isCompact);
  if (isCompact) {
    renderCompact();
  } else {
    renderFull();
  }
}

function toggleCompact() {
  isCompact = !isCompact;
  applyCompactMode();
  api.setCompact(isCompact).catch((err) => {
    console.error("setCompact failed:", err);
    // revert UI too — the window size never changed, state must stay aligned
    isCompact = !isCompact;
    applyCompactMode();
  });
}

// Full-mode re-render from the cached payload (used when leaving compact);
// in full mode render() takes its unchanged path.
function renderFull() {
  render(lastUsage);
}

// ---- tab state machine (fee | go) -------------------------------------------

function switchPane(name) {
  if (name !== "fee" && name !== "go") return;
  activePane = name;
  els.paneFee.hidden = name !== "fee";
  els.paneGo.hidden = name !== "go";
  els.tabFee.classList.toggle("on", name === "fee");
  els.tabGo.classList.toggle("on", name === "go");
  els.tabFee.setAttribute("aria-pressed", String(name === "fee"));
  els.tabGo.setAttribute("aria-pressed", String(name === "go"));
  // Compact mode has its own content tree — re-render the visible pane and
  // stop before the full-pane refresh path below.
  if (isCompact) {
    renderCompact();
    return;
  }
  // Re-render go sections on show so countdowns are fresh; data comes from
  // memory, no re-fetch (<50ms, 设计 S9) — except the very first Go open,
  // which lazily pulls the local usage (S1 skeleton shows until it lands).
  if (name === "go") {
    if (lastGoLocal === null && !goLocalFetchInFlight) {
      goLocalFetchInFlight = true;
      api
        .getGoLocalInitial()
        .then((data) => {
          goLocalFetchInFlight = false;
          if (!data) return;
          lastGoLocal = data;
          // The go-local:update push (sent by main before this invoke
          // resolves) may already have rendered — re-render is idempotent.
          if (activePane === "go") renderGoLocal();
        })
        .catch((err) => {
          goLocalFetchInFlight = false;
          console.error("go local initial fetch failed:", err);
        });
    }
    renderGoLocal();
    renderGoQuota(lastQuota);
  }
}

// ---- render: top-level dispatcher ----------------------------------------

function render(summary) {
  const safe = summary && typeof summary === "object" ? summary : {};
  lastUsage = safe;

  if (isCompact) {
    // compact view replaces the full tree; chrome handled by renderStateTag
    renderCompact();
    return;
  }

  // fee pane — existing render path, zero behavior change
  els.heroUpdated.textContent = fmtTime(safe.generatedAt);
  renderHero(safe.today);
  renderRows(safe.week, safe.allTime);
  renderChart(safe.byDay);
  renderLists(safe.byModel, safe.byProject);

  // go pane — additive branch; all three data sources render independently
  renderGoLocal();
  renderGoChrome();
}

// ---- IPC wiring (via preload bridge) ---------------------------------------

const api = window.widget;

if (!api) {
  // preload.cjs failed to load — surface it instead of silently freezing on "—"
  console.error("window.widget missing — preload.cjs did not load");
  els.bannerText.textContent = "preload bridge missing";
  els.banner.classList.remove("banner--hidden");
} else {
  api.onUpdate(render);

  els.btnRefresh.addEventListener("click", async () => {
    els.btnRefresh.classList.add("is-spinning");
    try {
      const summary = await api.refresh();
      if (summary) render(summary);
    } catch (err) {
      console.error("refresh failed:", err);
    } finally {
      setTimeout(() => els.btnRefresh.classList.remove("is-spinning"), 420);
    }
  });

  els.btnClose.addEventListener("click", () => {
    api.close();
  });

  els.btnCompact.addEventListener("click", () => {
    toggleCompact();
  });

  // tab pills (fee | go) — data-pane attribute is the single source of truth
  els.tabFee.addEventListener("click", () => switchPane(els.tabFee.dataset.pane));
  els.tabGo.addEventListener("click", () => switchPane(els.tabGo.dataset.pane));

  // quota push (5min timer + refresh passthrough) — independent of usage
  api.onQuotaUpdate((q) => {
    renderGoQuota(q);
    renderGoChrome();
  });

  // go local push (piggybacked on the 5min quota poll + manual refresh) —
  // authoritative source for the Go pane's local sections once it lands
  api.onGoLocalUpdate((data) => {
    if (!data) return;
    lastGoLocal = data;
    if (activePane === "go") renderGoLocal();
  });

  // initial handshake: usage and quota pulled in parallel, rendered independently
  api
    .getInitial()
    .then((summary) => {
      if (summary) render(summary);
      // tell main the renderer has consumed the first payload
      api.ready(summary || null);
    })
    .catch((err) => {
      console.error("initial fetch failed:", err);
      render({ available: false, generatedAt: new Date().toISOString() });
      api.ready(null);
    });

  api
    .getQuotaInitial()
    .then((q) => {
      renderGoQuota(q);
      renderGoChrome();
    })
    .catch((err) => {
      console.error("quota initial fetch failed:", err);
    });

  // S1 placeholders until the first payloads land
  renderGoLocal();
  renderGoQuota(null);
  switchPane("fee");
}

// ---- helpers --------------------------------------------------------------

function isoDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}