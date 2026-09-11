# opencodeTool — OpenCode 显示工具集

读取本机 [OpenCode](https://opencode.ai) 的本地 SQLite 数据（`~/.local/share/opencode/opencode.db`），提供用量显示工具：

1. **终端用量报告 CLI** — 按天 / 周 / 累计统计 token 与费用，支持按模型、按项目拆解
2. **桌面常驻小窗口** — Electron 无边框置顶悬浮窗，实时显示今日/本周/累计用量

技术栈：Node.js 24 + 内置 `node:sqlite`（零依赖数据层）+ Electron。

## 安装 / 运行

要求 Node.js ≥ 22.5（本机为 v24.12.0，`node:sqlite` 无需任何安装）。

```powershell
# 查看完整用量报告
npm run usage

# 等价于
node bin/opencode-usage.js

# 启动桌面悬浮窗（右下角常驻，置顶显示用量）
npm run widget

# 开机自动启动：Win+R 输入 shell:startup，把本项目的 widget 启动快捷方式放进去
```

无需 `npm install`：数据层与 CLI 完全零依赖。

## CLI 用法

```
node bin/opencode-usage.js [subcommand] [flags]
```

| 子命令        | 说明                                                |
| ---------- | ------------------------------------------------- |
| （默认）       | 完整报告：今日 / 本周 / 累计 + 模型 Top 5 + 项目 Top 5 + 最近 7 天表 |
| `today`    | 仅今日统计                                             |
| `week`     | 本周（最近 N 天）统计 + 每日明细表                              |
| `all`      | 累计统计 + 模型 / 项目 Top 10                             |
| `projects` | 项目 Top 10（累计）                                     |
| `models`   | 模型 Top 10（累计）                                     |
| `days`     | 每日明细表                                             |
| `go`       | Go 套餐用量（opencode-go provider）+ 服务端额度              |

| 标志                      | 说明                            |
| ----------------------- | ----------------------------- |
| `--json`                | 输出原始汇总 JSON（供程序消费）            |
| `--days N`              | 周/日桶的天数（默认 7）                 |
| `--sort requests\|cost` | 模型排序方式（仅 go 子命令，默认 requests）  |
| `--quota`               | 强制刷新服务端额度，跳过 5 分钟缓存（仅 go 子命令） |
| `--no-color`            | 关闭 ANSI 颜色                    |
| `-h, --help`            | 帮助                            |

示例：

```powershell
node bin/opencode-usage.js                # 完整报告
node bin/opencode-usage.js days --days 14 # 最近 14 天每日明细
node bin/opencode-usage.js --json         # JSON 输出
```

### 程序化调用（数据层）

```js
import { getUsageSummary, DB_PATH } from './src/lib/opencode-data.js';

const summary = await getUsageSummary({ days: 7, dbPath: DB_PATH });
// {
//   available, generatedAt,
//   today / week / allTime: { cost, tokensInput, tokensOutput, tokensReasoning,
//                            tokensCacheRead, tokensCacheWrite, sessions,
//                            topModel: { id, providerID, cost } | null },
//   byDay:     [{ date, cost, tokensInput, tokensOutput, sessions }],   // 升序，长度 = days
//   byModel:   [{ id, providerID, cost, tokensInput, tokensOutput, sessions }],   // 累计，按费用降序，Top 10
//   byProject: [{ name, worktree, cost, tokensInput, tokensOutput, sessions }],  // 累计，按费用降序，Top 10
// }
```

数据库缺失或不可读时 `available: false`，其余字段返回零值——**从不抛异常**。

## Go 套餐用量

查看 OpenCode Go 套餐（$10/月）的请求量、模型分布、缓存命中率和服务端剩余额度。

### 用法

```powershell
node bin/opencode-usage.js go              # 完整 Go 用量报告
node bin/opencode-usage.js go --json       # JSON 双段输出（local + quota）
node bin/opencode-usage.js go --sort cost  # 模型按费用降序
node bin/opencode-usage.js go --quota      # 强制刷新额度（跳过 5min 缓存）
node bin/opencode-usage.js go --days 14    # byDay 显示 14 天

npm run usage -- go                        # 等价写法
```

### 口径说明

- **本地数据**：筛选 `providerID=opencode-go` 的 assistant message 行，请求量 = 行数
- **费用标记**：`message.data.cost` 累计（订阅套餐下是美元价值标记，非实际扣费，UI 措辞用"费用标记"）
- **命中率双口径**：
  - 占输入 = `cacheRead / (input + cacheRead + cacheWrite)`
  - 读写占比 = `cacheRead / (cacheRead + cacheWrite)`（分母为 0 时显示 N/A）
- **额度来源**：OpenCode 官方 API `GET https://opencode.ai/zen/go/v1/usage`，Bearer key 读自 `auth.json`，5 分钟缓存，`--quota` 强制刷新

### JSON 输出格式（--json）

```json
{
  "local": {
    "available": true,
    "today": { "requests": 268, "tokens": { "input": 12345678, "output": 12345678, "reasoning": 0, "cacheRead": 98765432, "cacheWrite": 0, "total": 24691356 }, "cost": 1.44, "hitRateOfInput": 0.869, "hitRateReadWrite": null },
    "week": { "requests": 1558, "..." : "..." },
    "allTime": { "requests": 26991, "..." : "..." },
    "byDay": [{ "date": "2026-09-07", "requests": 268, "tokens": {...}, "cost": 1.44 }],
    "byModel": [{ "id": "deepseek-v4-flash", "requests": 15938, "tokens": {...}, "cost": 33.76, "lastUsedAt": "2026-09-07T12:00:00Z" }]
  },
  "quota": {
    "available": true,
    "fetchedAt": "2026-09-07T10:00:00Z",
    "windows": {
      "rolling": { "status": "ok", "percent": 7, "resetsAt": "2026-09-07T11:11:13Z" },
      "weekly": { "status": "ok", "percent": 2, "resetsAt": "2026-09-14T00:00:00Z" },
      "monthly": { "status": "ok", "percent": 42, "resetsAt": "2026-10-01T23:51:02Z" }
    }
  }
}
```

`local.available=false` 时额度区显示降级文案，`quota.available=false` 时显示 reason（4 个稳定值：`network`、`no-subscription`、`no-credentials`、`timeout`）。

### 桌面小窗口 Go Tab

点击小窗口顶部 **费用 | Go** pill 切换到 Go Tab。显示今日请求大数字、额度三窗口进度条、命中率双条、模型 Top 3、本周/累计行。

## 数据来源说明

- 数据文件：`~/.local/share/opencode/opencode.db`（Windows 下为 `C:\Users\<你>\.local\share\opencode\opencode.db`）
- 只读打开（`DatabaseSync(path, { readOnly: true })`），即使 OpenCode 正在运行（WAL 模式）也可以安全读取
- 统计口径：
  - `session` 表一行 = 一个会话；费用为 `cost`（REAL，美元）
  - token 字段：`tokens_input` / `tokens_output` / `tokens_reasoning` / `tokens_cache_read` / `tokens_cache_write`
  - 按 `time_updated`（毫秒时间戳）归入**本地日历日**；今日 = 本地零点至今；本周 = 最近 N 天（含今日）
  - `model` 列为 JSON 字符串（`{"id","providerID","variant"}`），解析失败或为 NULL 时归入 `unknown / unknown`
  - 项目名：`project.name` 优先，否则取 `worktree` 的 basename；`project_id = 'global'` 显示为 `global`；项目行缺失显示为 `unknown`
- 首次运行前需至少启动过一次 OpenCode，数据库才会生成

## 调试 / 自检

```powershell
npm test                                        # 全部测试（数据层 + 额度 fetcher + 渲染）
npx electron src/widget/main.js --selftest      # 无窗口自检：输出 SELFTEST OK 后自动退出
$env:WIDGET_DEVTOOLS="1"; npm run widget        # 打开小窗 DevTools 调试
```

## 测试

```powershell
npm test                                    # 运行全部测试（现有 + go-usage/go-quota/go-render）
node --test test/opencode-data.test.js      # 仅费用数据层测试
node --test test/go-usage.test.js           # 仅 Go 本地数据层测试
node --test test/go-quota.test.js           # 仅 Go 额度 fetcher 测试
node --test test/go-render.test.js          # 仅 Go CLI 渲染测试
```

测试使用 `os.tmpdir()` 下的临时 SQLite 数据库（合成数据），**不会触碰真实数据库**。

## 目录结构

```
src/lib/opencode-data.js   # 零依赖数据层（node:sqlite 只读聚合）
src/lib/go-usage.js        # Go 套餐本地数据聚合
src/lib/go-quota.js        # Go 套餐官方额度 fetcher
src/lib/go-render.js       # Go CLI 渲染纯函数
bin/opencode-usage.js      # 终端用量报告 CLI
test/opencode-data.test.js # 费用数据层测试
test/go-usage.test.js      # Go 本地数据层测试
test/go-quota.test.js      # Go 额度 fetcher 测试
test/go-render.test.js     # Go CLI 渲染测试
src/widget/                # Electron 桌面小窗口（含 Go Tab）
```
