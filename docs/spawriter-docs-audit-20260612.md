# spawriter 文档全面审计报告

> **Status: Implemented**（2026-06-12）。D1–D19 已全部落地，与原方案的差异：
> - D5 采用零重复方案 —— 不新建 `skill.md`，`spawriter skill` 直接打印 `AGENTS_Unified.md`（消除一份重复维护源）。
> - D6 方向修正 —— 全部 10 个测试文件均使用 `node:test`，workspace 的 `vitest run` 才是错误一方；现 workspace `test` 用 `tsx --test` 显式列出 10 个文件（Windows cmd 不展开 glob），根脚本委托 workspace，`vitest` 依赖已移除。
> - D7/D10/D11 的过渡性弱化文案不再需要 —— S1/S3/S4/S5 修复已合入，强承诺表述如实保留/恢复。
> - D15 决策为「保留三份但对齐」：MCP prompt 按文件名加载 `AGENTS_MCP.md`、CLI 指南独立成文，合并会损失各自加载场景；本次已消除事实分叉（D9/D12/存储承诺表述三处统一）。
> - D19 文档已 `git mv` 至根 `docs/` 并补状态头。

- 审计日期：2026-06-12
- 审计范围：仓库内全部 37 个 Markdown 文档 + `package.json` scripts 表述 + CLI help 文案，逐条与当前源码核对
- 方法：每个文档中的命令、路径、参数名、行为承诺，均在源码/文件系统中验证；本报告中所有行号引用均为本次实际核对结果
- 配套文档：`spawriter-full-audit-20260612.md`（S1–S12 代码问题）、`spawriter-fix-plan-20260612.md`（修复方案）、`spawriter-capability-roadmap-20260612.md`（能力路线）

---

## 1. 文档清单与状态总览

| 文档 | 定位 | 状态判定 | 主要问题 |
|---|---|---|---|
| `README.md` | 项目入口 | **多处硬错误** | D1–D8（安装/配置照抄必失败） |
| `AGENTS_MCP.md` | MCP agent 指南 | 大体准确 | D9–D11 |
| `AGENTS_CLI.md` | CLI agent 指南 | 大体准确 | D12–D14 |
| `AGENTS_Unified.md` | 统一 agent 指南 | 准确性最高 | D15（三份重复维护） |
| `docs/tab-acquisition-optimization.md` | tab 获取方案 | **方案已实施但无状态标注** | D16、D17 |
| `docs/xcai-upload-timeout-error-audit.md` | 超时错误分析 | 建议已实施、无状态标注 | D18 |
| `spawriter/docs/relay-crash-analysis.md` | relay 崩溃分析 | **核心论断已过时** | D19、位置不统一 |
| `docs/spawriter-{full-audit,fix-plan,capability-roadmap}-20260612.md` | 本轮产出 | 自审通过 | D20（1 处已当场修正） |
| `docs/archived/`（23 个） | 历史归档 | 正常 | 无需处理（已在 archived/ 下） |

无其他文档：`extension/`、`spawriter/` 包内均无 README/CHANGELOG/skill 文件（这本身构成 D5 问题）。

---

## 2. 逐文档发现（编号 D1–D20，按严重度标注）

### 2.1 README.md

**D1（高）Cursor MCP 配置路径错误 — 照抄必失败**

`README.md:90` 的 Cursor 配置：

```json
"args": ["D:\\dev\\side\\spawriter\\mcp\\dist\\cli.js", "serve"]
```

仓库根本没有 `mcp/` 目录（实际目录：`docs, ext, extension, node_modules, scripts, spawriter`）。其余四个客户端（Claude Code/VS Code/Codex/OpenCode）的配置都正确地用 `spawriter/dist/cli.js`。Cursor 用户按文档配置会直接 `Cannot find module`。

修正：`"args": ["D:\\dev\\side\\spawriter\\spawriter\\dist\\cli.js", "serve"]`

**D2（高）扩展加载路径错误 — 且 Troubleshooting 教反了**

- `README.md:38`：「Load unpacked → select `extension/dist-chrome/`」— 已验证该目录**不存在**。
- `README.md:189`（Troubleshooting）：「Load `extension/dist-chrome/`, not `extension/`」— **方向恰好相反**。已验证实际结构：
  - `extension/manifest.json` 存在于扩展根目录，引用 `./build/*.js`（webpack 产物）；
  - `extension/build/` 内**没有** manifest.json，不能单独加载;
  - 因此正确的开发加载方式是：`npm run build:ext` 后 Load unpacked 选 **`extension/` 根目录**。
  - 注意：根目录 `manifest.json` 是 Firefox 变体（含 `browser_specific_settings.gecko`），`scripts/build-chrome.js` 仅在打 zip 时临时换入 `manifest.chrome.json`。Chrome 加载 Firefox 变体可用但有警告；严格做法是解压 `extension/web-ext-artifacts/spawriter-chrome-<version>.zip`。
- 仓库根的 `ext/dist-chrome/` 是旧版本构建陷阱（full-audit S2），唯一"能直接 Load unpacked"的目录恰是这个**过期目录**，进一步放大误导。

修正建议（README 安装节）：

```markdown
### Chrome Extension
1. `npm run build:ext`（或 `npm run setup` 已包含）
2. Open `chrome://extensions/` -> enable Developer mode
3. Click "Load unpacked" -> select the `extension/` directory (its manifest.json references ./build/)
   - 或解压 `extension/web-ext-artifacts/spawriter-chrome-<version>.zip` 后加载解压目录（严格 Chrome manifest）
```

并删除仓库根 `ext/` 目录（fix-plan S2 已立项）。

**D3（高）三处引用不存在的 `AGENTS.md`**

`README.md:96/105/122` 让用户复制 `AGENTS.md`，但仓库只有 `AGENTS_MCP.md`、`AGENTS_CLI.md`、`AGENTS_Unified.md`。应统一指向 `AGENTS_Unified.md`（语义上它就是给 AI 客户端的统一规则文件）。

**D4（中）`npm run release` 不存在**

`README.md:182` 文档了 `npm run release`（"Build + package into `release/`"），根 `package.json` scripts 中没有该脚本（有 `deploy:firefox/chrome/deploy`）。要么补脚本要么删行。

**D5（中）`spawriter skill` 命令已损坏，README 仍在宣传**

`README.md:24/67` 宣传 `spawriter skill`（"print CLI documentation"）。实现 `cli.ts:156-167` 依次找 `<repo>/skill.md` 与 `<dist>/skill.md`，但**全仓库不存在任何 skill.md**（已 glob 验证），命令必然输出 `skill.md not found.` 并 exit 1。`README.md:75`「Run `spawriter skill` for the full CLI reference」同样落空。

修正（二选一）：
1. 新增 `skill.md`（建议内容 = `AGENTS_Unified.md`，构建时复制到 `dist/`，并在 `spawriter/package.json` 的 `files` 中加入）；
2. 或移除 skill 命令与 README 宣传。
推荐方案 1 —— playwriter 的同名命令就是 agent 自助获取用法的入口，与能力路线一致。

**D6（中）`npm test` ≠ "Run all tests"，且双测试栈并存**

`README.md:183` 称 `npm test` "Run all tests"。实际根脚本（`package.json:25`）只跑 6 个文件：

```
mcp.test.ts pw-executor.test.ts ownership.test.ts utils.test.ts cli.test.ts relay.test.ts
```

`spawriter/src` 实有 **10** 个测试文件，遗漏 `runtime/` 下 4 个：`spa-helpers.test.ts`、`ax-tree.test.ts`、`labeled-screenshot.test.ts`、`network-monitor.test.ts`。且根用 `npx tsx --test`、workspace（`spawriter/package.json:17`）用 `vitest run`，同一批文件两套 runner 并存。

修正：根 `test` 改为 `npm run -w spawriter test`（vitest 自动发现全部 `*.test.ts`），消除遗漏与双轨。

**D7（低）「never hijacks user's browsing tabs」与现状不符**

`README.md:7/171` 的安全承诺在 S4（无 sessionId 的 CDP 兜底）、S5（`/connect-active-tab`）、`bridge.js:621-627`（CDP 无目标时 fallback 抢活跃 tab，见 D17）修复落地前不成立。承诺类文案应在 fix-plan 第 1–2 批合入后再保留，否则属失实宣传。

**D8（低）relay 5 分钟空闲自动退出未见于任何文档**

已验证 `relay.ts:1793-1801`：无客户端连接 5 分钟后 relay 自动 shutdown。该行为直接影响排障心智（「为什么 relay 又不在了」），README Troubleshooting 与两份 AGENTS 文档均未提及。建议在 Troubleshooting「Relay not running」行补充原因说明。
（对照：`README.md:169`「idle sessions cleaned up after 30 min」已验证准确 — `relay.ts:285` `DEFAULT_STALE_TTL = 30*60*1000`，可经 `SPAWRITER_CLAIM_TTL_MS` 覆盖，该环境变量同样无文档。）

### 2.2 AGENTS_MCP.md

**D9（中）single_spa 动作名与 schema 不符，同文件内自相矛盾**

`AGENTS_MCP.md:13`：「(status/set/remove/enable/disable/reset_all/mount/unmount/unload)」。实际 schema enum（`mcp.ts:491`）是：

```
status, override_set, override_remove, override_enable, override_disable, override_reset_all, mount, unmount, unload
```

agent 照 13 行调用 `single_spa { action: "set" }` 会被 schema 拒绝。而同文件 77 行写的又是正确的 `override_set` —— 内部不一致。修正 13 行为完整动作名。

**D10（低）`reset` "clear all state" 过度承诺**

`AGENTS_MCP.md:12`。S3 已证实带 `::agentId` 后缀的会话所有权释放不掉。待 fix-plan S1/S3 落地后此句才成立；当前应加限定或随修复同步更新。

**D11（低）session_id 指引在 S1 修复前会诱发「连续多开 tab」**

`AGENTS_MCP.md:28` 教 agent 在 `tab` 动作传 `session_id`，但 `execute` 使用另一套 ID（S1 根因）。文档本身方向正确（指引隔离），但与当前实现组合后反而触发用户报告的多 tab 症状。S1 修复合入时必须同步修订本节（fix-plan 已含此项）。

**验证通过项**（与代码逐一核对一致）：32 个 execute globals 全部存在于 `pw-executor.ts`（`vmContextObj` + `buildVmGlobals`，725-734/882-2363）；tab 动作 connect/list/switch/release 与 `mcp.ts:229-401` 一致；「panel 约 3s 自动同步」= `useImportMapOverrides.js:775` `POLL_INTERVAL_MS = 3000` ✓。

### 2.3 AGENTS_CLI.md

**D12（中）`getCDPSession()` 描述与实现相反**

`AGENTS_CLI.md:97`：「(returns null through relay)」。实测实现（`pw-executor.ts:649-663`）：经 relay 时 `page.context().newCDPSession(page)` 正常成功并返回真实 CDPSession —— `snapshot`/`dbg` 等核心功能正依赖它经 relay 工作；仅在创建失败时才返回 null。`AGENTS_Unified.md:167` 的「when supported」才是准确表述。修正 97 行为「正常返回 CDP session；创建失败时返回 null」。

**D13（低）示例全部为 bash 单引号写法，Windows 用户照抄必失败**

文档所有 `-e` 示例均为 `'...'` 包裹。PowerShell 下内层双引号会被吞（已在 full-audit S10 实测复现 SyntaxError）。S10 方案（stdin/`-f` + PowerShell 示例）落地时需同步本文件与 `AGENTS_Unified.md`。

**D14（低）`session bind` 声明支持 `--host`，实现硬编码 localhost**

`cli.ts:267-291`：bind 子命令声明了 `--host` 选项，但请求 URL 写死 `http://localhost:${port}/cli/tab/claim`（276 行），`--host` 实际被忽略 —— 远程 relay 场景 bind 不可用。属代码缺陷，文档（`AGENTS_CLI.md:31` 等）随之失实。修正代码改用 `getControlClient`（与其他子命令一致）。

**验证通过项**：`require` 白名单与 `child_process` 阻断（`pw-executor.ts:48-56/353-373`）✓；`storage`（set_cookie/delete_cookie/get_storage_usage…）、`emulation`（set_device/set_timezone/set_geolocation/reset）、`performance`（get_web_vitals/get_metrics/get_memory/get_resource_timing）、`pageContent`（get_text/get_html/get_metadata/search_dom）、`editor`（list_sources/get_source/search/edit）、`networkIntercept.removeRule`、`singleSpa.unload` 全部存在 ✓；`snapshot({ search })` 支持（`pw-executor.ts:884`）✓；会话 ID `sw-` 前缀格式（`relay.ts:1480`）✓。

### 2.4 AGENTS_Unified.md

**D15（低）三份 agent 文档重复维护，已产生互相矛盾**

`AGENTS_Unified.md` 与 `AGENTS_MCP.md`、`AGENTS_CLI.md` 约 70% 内容重叠，且已出现 D12 这种同一事实两种说法。建议：`AGENTS_Unified.md` 为唯一事实来源；MCP/CLI 两份退化为「差异点 + 指向 Unified」的薄文档，或由脚本从 Unified 生成。本文件本身内容核对无误（getCDPSession 表述正确、命令清单与 cli.ts 一致）。

另一处一致性说明：两份 AGENTS 的「storage 清理自动 origin-scoped、never affects other sites」表述（`AGENTS_MCP.md:96`、`AGENTS_CLI.md:258`）—— 实现默认确实取当前 `window.location.origin`（`pw-executor.ts:1712-1718`），但 `clear_storage`/`clearCacheAndReload` 均接受调用方显式传 `origin` 参数覆盖。「自动作用域」属实，「never affects other sites」是行为约定而非硬保证，建议文案改为「默认当前 origin；禁止显式传其他 origin」。

### 2.5 docs/tab-acquisition-optimization.md

**D16（中）方案已全部实施，文档仍呈现为待办**

逐条核对实施状态：

| 方案 | 实施证据 | 状态 |
|---|---|---|
| 6.1 移除 `candidates[0]` fallback、safe 随机选取 | `relay.ts:257`（`'safe-fallback' : 'idle-random'`） | ✅ 已实施 |
| 6.2 execute handler 单阶段 `forceCreate` | `relay.ts:1401-1406`（无 `create:false` 阶段） | ✅ 已实施 |
| 6.3 `pickBestMatchingTab` idle 过滤 | `bridge.js:137`（`attachedTabs.has && !isTabOwned`） | ✅ 已实施 |
| 6.4 connectTabByMatch 无参 fallback 改报错 | `bridge.js:1012`（`No url or tabId provided`） | ✅ 已实施 |
| 6.5 测试更新 | `relay.test.ts` 含 pickReusable 系列用例 | 部分（随机性用例未见） |

文档没有任何状态标注，「验证清单」全部未勾选 —— 读者（包括 AI agent）会误判问题仍存在、重复实施。修正：文档头部加 `> Status: Implemented（relay.ts/bridge.js，验证于 2026-06-12）`，勾选清单，或整体移入 `docs/archived/`。

**D17（中）该文档的路径枚举存在遗漏：`bridge.js:621-627`**

文档「路径 I」只覆盖了 `connectTabByMatch` 无参分支（已修），但**CDP 命令无 targetTabId 时的兜底**仍在现行源码中直接 `ensureActiveTabAttached()` 抢用户活跃 tab：

```621:627:extension/src/ai_bridge/bridge.js
    if (!targetTabId) {
      try {
        targetTabId = await ensureActiveTabAttached();
      } catch (attachErr) {
        error(
          "No target tab available for CDP command:",
          attachErr?.message || attachErr
```

这是当前源码中仍存活的「抢用户 tab」路径之一（与 full-audit S4/S5 同根）。`spawriter-fix-plan-20260612.md` 的 S8 改动 3（452-454 行）已覆盖移除此 fallback —— 实施时务必包含。

### 2.6 docs/xcai-upload-timeout-error-audit.md

**D18（低）navigate 预算建议已落实，无状态标注**

文档建议的导航预算治理已体现在 `pw-executor.ts:231-241`（`NAVIGATE_TIMEOUT_SAFETY_BUFFER_MS`、`NAVIGATE_MIN/MAX_POST_ACTION_RESERVE_MS`、`NAVIGATE_POST_ACTION_RESERVE_RATIO` 等一组常量）。处理同 D16：补状态头或归档。

### 2.7 spawriter/docs/relay-crash-analysis.md

**D19（中）核心论断已过时 + 文档位置不统一**

文档核心论断「relay 独立进程当前没有 `process.on('unhandledRejection')` / `uncaughtException` 保护」已不成立：`relay.ts:83/93` 与 `mcp.ts:628/632` 均已加保护，`pw-executor.ts:546` 也有 dialog 处理（`beforeunload` 分支）。即崩溃修复已实施，文档读起来仍像未修。另：它是唯一放在 `spawriter/docs/` 的文档，其余都在根 `docs/` —— 建议移入根 `docs/`（或 archived/）并补状态头。

### 2.8 本轮三份新文档（自审计）

**D20（已当场修正）capability-roadmap C9 与沙箱白名单矛盾**

原文建议沙箱内 `require('child_process')` 调 ffmpeg，与 `ALLOWED_MODULES`（`pw-executor.ts:48-56`，不含且不应放开 child_process）矛盾。已改为「ffmpeg 在 CLI/relay 进程侧执行（如 `spawriter demo-video` 命令）」。

抽查 full-audit / fix-plan 的关键论断与本次复核全部一致：S1 会话 ID 双轨（`mcp.ts:222` tab 用 `args.session_id`，execute 另走 clientId）、S2 目录混乱（本次进一步精确化为 D2 的「正确加载方式 = extension/ 根」）、S8 `Target.createTarget` 缺失、S10/S11 CLI 问题（`cli.ts` 仍有 6 处 `process.exit`）。fix-plan 与 D17 互为印证（S8 改动 3 已覆盖）。

---

## 3. 系统性根因（文档工程层面）

- **G1 文档无生命周期管理**：D16/D18/D19 同一根因 —— 分析/方案文档实施后从不回写状态。规范建议：每份方案/分析文档头部强制 `Status: Draft | Approved | Implemented(日期/commit) | Archived` 字段；实施 PR 必须同步更新对应文档状态。
- **G2 同一信息多份维护**：三份 AGENTS_* 已出现事实分叉（D12），README 又引用第四个不存在的名字（D3）。确立 `AGENTS_Unified.md` 为唯一事实来源。
- **G3 文档承诺与代码脱钩无检测**：D1/D2/D4/D5/D6 全是「写了但没有/坏了」。低成本对策：加一个 doc-smoke 测试（CI 校验 README 中出现的路径存在、scripts 表格中的命令在 package.json 中存在、`spawriter skill` 退出码为 0）。
- **G4 安装路径叙事混乱是 S2 的文档面**：README 正文、Troubleshooting、`ext/` 目录三处互相矛盾（D2），修复必须三处同步 + 删除 `ext/`。

---

## 4. 修复优先级清单

| 优先级 | 项 | 动作 | 文件 |
|---|---|---|---|
| **P0** | D1 | Cursor 配置路径 `mcp\dist` → `spawriter\dist` | README.md:90 |
| **P0** | D2 | 重写扩展安装节 + 修正 Troubleshooting 方向 + 删 `ext/` | README.md:35-39/189、ext/ |
| **P0** | D3 | `AGENTS.md` → `AGENTS_Unified.md`（3 处） | README.md:96/105/122 |
| **P0** | D17 | 实施时确保移除 `bridge.js:621-627` active-tab fallback | （随 fix-plan S8 改动 3） |
| **P1** | D5 | 新增 `skill.md`（内容取自 AGENTS_Unified，build 复制进 dist + files 字段）或移除命令 | skill.md、spawriter/package.json、cli.ts |
| **P1** | D6 | 根 `test` 改 `npm run -w spawriter test`，统一 vitest、覆盖全部 10 个测试文件 | package.json:25 |
| **P1** | D9 | single_spa 动作名改为 override_* 全称 | AGENTS_MCP.md:13 |
| **P1** | D12 | getCDPSession 描述改为「正常返回；失败为 null」 | AGENTS_CLI.md:97 |
| **P1** | D16/D18/D19 | 三份已实施文档补 `Status: Implemented` 头（或移入 archived/），D19 同时移到根 docs/ | 对应文档 |
| **P2** | D4 | 删除或实现 `npm run release` | README.md:182 / package.json |
| **P2** | D7/D10/D11 | 承诺类文案与 S1/S3/S4/S5 修复同步更新 | README、AGENTS_MCP |
| **P2** | D8 | 文档化 relay 5 分钟空闲退出与 `SPAWRITER_CLAIM_TTL_MS` | README Troubleshooting |
| **P2** | D13 | PowerShell/cmd 示例（随 S10） | AGENTS_CLI、AGENTS_Unified |
| **P2** | D14 | `session bind` 改用 getControlClient 以兑现 `--host` | cli.ts:267-291 |
| **P2** | D15 | AGENTS 三合一（Unified 为源） | AGENTS_*.md |

---

## 5. 逐项精确改动文本（可直接实施）

第 2 节已含 D2（README 安装节替换块）与 D17（指向 fix-plan S8 改动 3 的现成 diff）。其余各项的确切改动如下。

### D1 — README.md:90

```json
// 改前
"args": ["D:\\dev\\side\\spawriter\\mcp\\dist\\cli.js", "serve"]
// 改后
"args": ["D:\\dev\\side\\spawriter\\spawriter\\dist\\cli.js", "serve"]
```

### D3 — README.md:96/105/122（三处同改）

```markdown
改前：copy `AGENTS.md` ...
改后：copy `AGENTS_Unified.md` ...
```

（96 行：`copy AGENTS_Unified.md into .cursor/rules/spawriter.md`；105 行：`copy AGENTS_Unified.md to project root or into CLAUDE.md`；122 行：`AGENTS_Unified.md at project root is automatically picked up by Copilot` —— Copilot 实际只自动识别 `AGENTS.md` 文件名，若要自动识别需另存为 `AGENTS.md`，建议 122 行改为「copy `AGENTS_Unified.md` to project root as `AGENTS.md`」）

### D4 — README.md:182

删除整行 `| npm run release | Build + package into release/ |`（根 package.json 无此脚本；如需保留，改为 `| npm run deploy:chrome | Build + zip + upload Chrome extension |`）。

### D5 — 修复 `spawriter skill`（推荐方案：新增 skill.md）

1. 新建仓库根 `skill.md`，内容 = `AGENTS_Unified.md` 全文（或顶部加一行注释 `<!-- generated from AGENTS_Unified.md -->`）。git-clone 用法即刻生效（`cli.ts:158` 解析 `<repo>/skill.md`）。
2. npm 发布形态同步：`spawriter/package.json:15` build 脚本追加复制步骤（npm script 的 cwd 为 `spawriter/`）：

```json
"build": "node -e \"const fs=require('fs');if(fs.existsSync('dist'))fs.rmSync('dist',{recursive:true,force:true})\" && tsc && node -e \"require('fs').copyFileSync('../skill.md','dist/skill.md')\""
```

`files` 字段已含 `dist`，无需改动。验证：`spawriter skill` 退出码 0 且输出全文。

### D6 — 根 package.json:25

```json
// 改前
"test": "npx tsx --test spawriter/src/mcp.test.ts spawriter/src/pw-executor.test.ts spawriter/src/ownership.test.ts spawriter/src/utils.test.ts spawriter/src/cli.test.ts spawriter/src/relay.test.ts"
// 改后（vitest 自动发现全部 10 个 *.test.ts）
"test": "npm run -w spawriter test"
```

验证：`npm test` 输出包含 `runtime/ax-tree.test.ts` 等 4 个此前遗漏文件。

### D7 — README.md:171（修复落地前的过渡文案）

```markdown
改前：- **User tab safety** — only uses spawriter-managed idle tabs or creates new ones; never hijacks user's browsing tabs
改后：- **User tab safety** — designed to only use spawriter-managed idle tabs or create new ones (hardening in progress, see docs/spawriter-fix-plan-20260612.md S4/S5)
```

S4/S5/S8 改动 3 全部合入后再恢复强承诺表述。

### D8 — README.md Troubleshooting 表追加一行

```markdown
| Relay exits by itself | By design: relay auto-shuts down after 5 idle minutes with no clients. It restarts automatically on next CLI/MCP call. Session claim TTL is 30 min (override: SPAWRITER_CLAIM_TTL_MS). |
```

### D9 — AGENTS_MCP.md:13

```markdown
改前：- **`single_spa`** — Override management, app lifecycle (status/set/remove/enable/disable/reset_all/mount/unmount/unload)
改后：- **`single_spa`** — Override management, app lifecycle (status/override_set/override_remove/override_enable/override_disable/override_reset_all/mount/unmount/unload)
```

### D10 — AGENTS_MCP.md:12（S3 修复合入前）

```markdown
改前：- **`reset`** — Full reconnect + clear all state
改后：- **`reset`** — Reconnect + clear executor state (tab ownership release for per-agent sessions lands with fix S1/S3)
```

S1/S3 合入后恢复原表述。

### D11 — AGENTS_MCP.md:28（过渡警示，S1 合入后删除）

行尾追加：`Note: until session unification (fix S1) lands, execute uses a different internal session — avoid mixing tab connect and execute across different session_id values in one workflow.`

### D12 — AGENTS_CLI.md:97

```markdown
改前：| `getCDPSession()` | Raw CDP session accessor (returns null through relay) |
改后：| `getCDPSession()` | Raw CDP session accessor (normally returns a live session, including through the relay; null only if session creation failed) |
```

### D13 — AGENTS_CLI.md「Quick Start」追加 Windows 小节（已实测验证的写法）

```markdown
**Windows (PowerShell)**: PowerShell 5.1 mangles inner double quotes when passing args to native binaries. Use cmd as a shim with doubled quotes:

    cmd /c "spawriter -s sw-1 -e ""await navigate('https://example.com')"""

Or prefer single-quoted JS strings inside, avoiding double quotes entirely. (A `-f <file>` / stdin mode is planned — see fix S10.)
```

### D14 — cli.ts:267-291（session bind 兑现 --host）

```ts
// 改前（276 行）
const response = await fetch(`http://localhost:${port}/cli/tab/claim`, {
// 改后：与 executeCode 相同的 serverUrl 推导，移除上方 const port = getRelayPort();
const rawHost = (options.host as string) || process.env.SSPA_RELAY_HOST || '';
const serverUrl = rawHost && /^https?:\/\//.test(rawHost)
  ? rawHost.replace(/\/$/, '')
  : `http://${rawHost || '127.0.0.1'}:${getRelayPort()}`;
const response = await fetch(`${serverUrl}/cli/tab/claim`, {
```

同时将本命令两处 `process.exit(1)` 改为 `process.exitCode = 1; return;`（与 S11 一致）。

### D16/D18/D19 — 三份已实施文档的状态头（粘贴到各文档首行之后）

```markdown
> **Status: Implemented** — 方案已落地于当前源码（核验 2026-06-12，见 docs/spawriter-docs-audit-20260612.md D16/D18/D19 的实施证据表）。本文保留作设计依据。
```

D19 同时执行：`git mv spawriter/docs/relay-crash-analysis.md docs/relay-crash-analysis.md`。

### D15 — AGENTS 三合一（编辑性，P2）

1. 保留 `AGENTS_Unified.md` 为唯一事实来源；
2. `AGENTS_MCP.md` / `AGENTS_CLI.md` 各保留「传输方式差异 + 完整指南见 AGENTS_Unified.md」一页薄文档；
3. README 的 AI Instructions 全部指向 Unified（随 D3）。

---

## 6. 本次验证位置索引

代码核对（全部为本次实读）：`mcp.ts:222/229-401/491/510/514/628-632`；`cli.ts:34-59/62-153/156-167/170-206/209-298/300-302`；`relay.ts:83/93/257/285-291/391-395/1401-1406/1480/1793-1801`；`pw-executor.ts:48-56/231-241/353-373/546/649-663/725-734/882-905/1252/1604-1739/1767-1800/1887-1927/2055-2062/2167/2343-2361`；`bridge.js:134-138/621-627/829-831/952-1013`；`useImportMapOverrides.js:775`；`utils.ts:13-16/46-52`；`extension/manifest.json`；`extension/scripts/build-chrome.js`；根/包 `package.json`。

文件系统核对：`extension/dist-chrome` 不存在；`extension/build/` 无 manifest.json；`extension/manifest.json`/`manifest.chrome.json` 存在；`ext/` 存在（陈旧）；全仓库无 `skill.md`/`AGENTS.md`；`spawriter/src` 含 10 个 `*.test.ts`。
