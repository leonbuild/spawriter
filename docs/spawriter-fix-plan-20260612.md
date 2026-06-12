# spawriter 修复与优化方案（可实施）

> **Status: Implemented**（2026-06-12，全部 12 项已落地并通过 1565 个测试 + 构建 + CLI 实测）。
> 实施与本文的差异：S7 仅落地改动 1（README Security model 节），改动 2（token 自动协商）为可选未实施；S9 采用更彻底的方案 —— 扩展侧 url 匹配函数（`pickBestMatchingTab` 等）整体删除，idle 复用唯一决策点为 relay 的 `pickReusableAttachedTab`；S10 的 `-e` 改为可选值参数（`-e` / `-e -` 均读 stdin），并新增 `-f <file>`；另修复了实施中发现的两个新问题：relay 顶层 `setInterval` 未 `unref`（导致测试进程挂起）、`ensureRelayServer` 状态消息污染 stdout（破坏 `session new` 的脚本契约）。回归测试见 `mcp.test.ts`（S1/S3/S5/S6/S10/S11）与 `relay.test.ts`（S4/S8）。
>
> **实施后自审计追加修复（同日）**：e2e 实测暴露出三个既有协议级 bug，均已修复并补充回归测试（`relay.test.ts`）：
> 1. **实时 `Target.attachedToTarget` 带顶层 `sessionId` 被 Playwright 丢弃** —— Playwright 将带顶层 sessionId 的消息路由到（尚不存在的）子会话而非浏览器级处理器，导致连接建立后新 attach 的 tab 永远不会成为 page（`newPage()`、`session bind` 后切换、MCP `tab switch` 全部受影响）。修复：逐 client 发送且不带顶层 sessionId，并套用与连接时回放一致的所有权过滤。
> 2. **`Target.detachedFromTarget` 经 `routeCdpEvent` 携带顶层 `sessionId` 且缺少 `params.targetId`** —— Playwright 依赖浏览器级 detach 事件中的 `targetId` 来标记 page 关闭，二者缺一 `page.close()` 永远挂起（S8 的 closeTarget 实际关掉了 tab，但 Promise 不返回）。修复：relay 在广播前从 attachedTargets 注册表补全 `targetId`，以浏览器级事件（无顶层 sessionId）广播。
> 3. **`handleCloseTarget` 仅按真实 CDP targetId 匹配** —— `/json/list` 暴露的 `id` 是 relay sessionId，按文档用该 id 调 `Target.closeTarget` 返回 target not found。修复：增加 `t.sessionId === targetId` 兜底匹配。
> 另：MCP `tab switch` 现无条件向 relay 发 claim 以同步 relay 侧 executor 的活动 tab；`/cli/tab/claim` 在 claim 后调用 `executor.switchToTab`；扩展 `clearCacheAndReload` 改为必须显式 `tabId`（拒绝隐式作用于用户活动标签）；relay 进程启用文件日志（`%TMP%/spawriter/relay.log`），解决 `stdio:'ignore'` 下日志全丢的问题。
>
> **S6 设计演进（同日，依据用户反馈）**：彻底移除 title 小点后用户失去了 tab 级可视化（badge/icon 是全局的，无法在标签条上区分单个 tab）。最终方案改为**重新引入 title 小点标记，但以单写者幂等设计实现**：仅扩展一处写入（`setTabState`/`emitDetachedFromTarget`/`tabs.onUpdated` 汇聚到 `scheduleTitleMarker`），标记从权威状态（attachedTabs + tabOwnership）即时推导（🟢=被会话占用，🔵=已附加空闲），注入脚本先剥离已有标记且仅在变化时写入。双绿点的根因（扩展 markTabTitle 与 executor 注入的 MutationObserver 两个写者竞争）不复存在——pw-executor 侧无任何 title 写入（回归测试断言此不变量）。
>
> **MCP/CLI 对齐补全（同日）**：新增 CLI `tabs list` / `tabs connect <url> [--create|--force-create]` / `tabs release [tabId]` 三个命令（`ControlClient` 增加 `listTabs`/`connectTab`/`releaseTab`），与 MCP `tab` 工具的 connect/list/release 动作一一对应；`tab switch` 的 CLI 等价物为既有 `session bind <tabId>`（同一 `/cli/tab/claim` 路径）。`relay.test.ts` 新增行为级测试：以子进程启动真实 relay，用假扩展 + 假 Playwright 客户端走完整 WS 链路，断言 live attach/detach 以浏览器级事件送达（防止协议 bug 1/2 回归）。`cli.test.ts` 新增 MCP/CLI parity 源级断言。测试总数 1569。
>
> **tab 获取边界定稿（同日，依据用户反馈）**：自动获取顺序为**自有 tab → 蓝点（已附加空闲）tab → 新建**。产品约定：蓝点 tab 是 agent 领地，用户不浏览蓝点 tab，因此复用无需活跃 tab 检测（曾实现"扩展上报活跃 tab + relay 排除"机制，经用户确认该约定后移除，避免冗余）；无点 tab 对自动路径完全不可见——`pickReusableAttachedTab` 是唯一复用决策点且仅遍历 `attachedTargets`。回归测试：`relay.test.ts` 断言唯一决策点、仅见已附加表、跳过已占用 tab。测试总数 1573。
>
> **执行页解析修复（同日，e2e 发现）**：新建 tab 的 page 对象在 Playwright `context.pages()` 中异步出现，`ensureConnection` 原先找不到时静默回退 `pages[0]`，导致 execute 代码跑在无关页面（实测跑在了用户的知乎页上，所有权未被破坏但页面解析错误）。修复：`waitForPageForTab` 轮询等待 owned tab 的 page（3s 超时报错），绝不回退到无关页面。回归测试 2 个（等待异步出现的 page、永不出现时报错）。
>
> **Prepared tab 交互（同日，依据用户反馈）**：用户可以主动附加一个 tab 并导航到目标页面，作为"准备好的页面"交给 agent。同时 title 标记对 about:blank 等受限页面增加 debugger `Runtime.evaluate` 兜底（`scripting.executeScript` 被 Chrome 拒绝时经已附加的 debugger 会话写入，空 title 以 URL 为基底），新建空白 tab 也能显示 🟢/🔵。
>
> **复用规则最终定稿（同日，依据用户反馈）**：放弃 prepared/blank 启发式区分与 safe-URL 白名单——**所有蓝点（已附加、无 owner）一律可复用，不论 URL**。获取顺序：自己的 🟢 → 任意 🔵（URL 命中 hint 的优先，其次最近附加）→ 新建；无点 tab 对自动路径不可见。智能选择交给 agent 层：`tabs list` / MCP `tab list` 暴露全部蓝点及其 URL，agent 可显式 connect 指定 tabId。`SAFE_AUTO_REUSE_URLS`/`isSafeAutoReuseUrl` 删除，reason 收敛为 `url-match`/`idle`；顺带删除测试中早已死亡的 `safeAutoClaimTab` 镜像及其套件。测试总数 1564。

- 配套审计报告：`docs/spawriter-full-audit-20260612.md`（问题编号 S1–S12 与此文一致）
- 本文目标：针对每个问题给出**确切到文件/函数/行**的修复代码（before → after）、验证方法与回归测试要点，达到可直接照改的程度。
- 约定：行号基于审计时的源码快照，照改时以函数名/上下文为准（行号可能因前序改动偏移）。

---

## 实施顺序总览

| 阶段 | 问题 | 改动文件 | 风险 | 依赖 |
|---|---|---|---|---|
| 第 1 批（根因） | S1 | `mcp.ts` | 低 | 无 |
| 第 1 批 | S3 | `mcp.ts` | 低 | S1 |
| 第 1 批 | S2 | 删 `ext/`、`README.md`、`.gitignore` | 低 | 无 |
| 第 2 批（安全） | S4 | `relay.ts` | 中 | 无 |
| 第 2 批 | S5 | `relay.ts`、`bridge.js` | 低 | 无 |
| 第 2 批 | S6 | `bridge.js`（+删 `pw-executor.ts` 死代码） | 低 | 无 |
| 第 2 批 | S7 | `relay.ts`、文档 | 低 | 无 |
| 第 3 批（功能） | S8 | `relay.ts`、`bridge.js` | 高 | 无 |
| 第 3 批 | S9 | `relay.ts`、`mcp.ts`、`bridge.js` | 中 | S1 |
| 第 3 批 | S10 | `cli.ts`、`AGENTS_CLI.md` | 低 | 无 |
| 第 3 批 | S11 | `cli.ts` | 低 | 无 |
| 第 3 批 | S12 | `mcp.ts` | 低 | S1 |

**建议**：先做第 1 批（S1+S3+S2），重新 `npm run build:mcp` 并加载正确扩展，立刻验证"多开 tab"消失，再推进后续批次。

---

## P0 修复

### S1 — 统一 MCP session 身份（根因）

**问题回顾**：`tab connect` 用 `mcp-${MCP_CLIENT_ID}::${agentId}`，`execute`/`single_spa`/`remoteRelaySendCdp` 用 `mcp-${MCP_CLIENT_ID}`（丢 agentId），二者永不命中同一 tab。

**核心思路**：引入唯一的 relay session 解析函数 `getRelaySessionId()`，所有面向 relay 的调用都用它；`execute`/`single_spa` 接受可选 `session_id` 并同步 `activeAgentId`。

#### 改动 1：新增统一解析函数（`mcp.ts`，放在 `getEffectiveClientId` 之后，约 119 行后）

```ts
// 统一的 relay 端 session ID：execute / single_spa / tab / cdp 必须全部用它
function getRelaySessionId(agentId?: string): string {
  return `mcp-${getEffectiveClientId(agentId ?? activeAgentId ?? undefined)}`;
}
```

#### 改动 2：`executeViaRelay` 使用统一 session（`mcp.ts:160-167`）

```ts
// BEFORE
async function executeViaRelay(code: string, timeout: number): Promise<ExecuteResult> {
  const port = getRelayPort();
  const mcpSessionId = `mcp-${getEffectiveClientId() || 'default'}`;
  const resp = await fetch(`http://localhost:${port}/cli/execute`, {

// AFTER
async function executeViaRelay(code: string, timeout: number): Promise<ExecuteResult> {
  const port = getRelayPort();
  const mcpSessionId = getRelaySessionId();
  const resp = await fetch(`http://localhost:${port}/cli/execute`, {
```

#### 改动 3：`remoteRelaySendCdp` 使用统一 session（`mcp.ts:138-141`）

```ts
// BEFORE
async function remoteRelaySendCdp(method, params, timeout) {
  const port = getRelayPort();
  const mcpSessionId = `mcp-${getEffectiveClientId() || 'default'}`;

// AFTER
async function remoteRelaySendCdp(method, params, timeout) {
  const port = getRelayPort();
  const mcpSessionId = getRelaySessionId();
```

#### 改动 4：`handleTabAction` 复用统一函数（`mcp.ts:224-226`）

```ts
// BEFORE
if (sessionId) activeAgentId = sessionId;
const effectiveClientId = getEffectiveClientId(sessionId || activeAgentId || undefined);
const mySessionId = `mcp-${effectiveClientId || 'default'}`;

// AFTER
if (sessionId) activeAgentId = sessionId;
const mySessionId = getRelaySessionId(sessionId);
```

#### 改动 5：`execute` 工具接受 `session_id`（`mcp.ts:529-538`）

```ts
// BEFORE
if (name === 'execute') {
  const code = args.code as string;
  const timeout = (args.timeout as number) || 30000;
  if (!code) { ... }
  await ensureRelayServer();
  const result = await executeViaRelay(code, timeout);
  return formatMcpResult(result);
}

// AFTER
if (name === 'execute') {
  const code = args.code as string;
  const timeout = (args.timeout as number) || 30000;
  if (args.session_id) activeAgentId = args.session_id as string;
  if (!code) { ... }
  await ensureRelayServer();
  const result = await executeViaRelay(code, timeout);
  return formatMcpResult(result);
}
```

同样在 `single_spa` 分支开头加 `if (args.session_id) activeAgentId = args.session_id as string;`（`mcp.ts:562` 后）。

#### 改动 6：schema 暴露 `session_id`（`mcp.ts` execute 与 single_spa 的 `inputSchema.properties`，见 S12）

**验证**：
```
tab connect {url:about:blank, create:true, session_id:X}  → 记下 owner
execute {code:"page.url()", session_id:X}                 → /json/list 不应新增 tab，owner 与上一步一致
tab list {session_id:X}                                   → "1 mine"，无"owned by others"误标
```

---

### S3 — reset 与进程退出真正释放 tab

**前置**：S1 完成后，所有 tab 的 owner 前缀统一为 `mcp-${MCP_CLIENT_ID}`（可能带 `::agentId`）。

#### 改动 1：重写 `reset`（`mcp.ts:540-560`）

```ts
// AFTER
if (name === 'reset') {
  const port = getRelayPort();
  const prefix = `mcp-${MCP_CLIENT_ID}`;
  try {
    const targets = await getTargets(port);
    for (const t of targets) {
      if (t.tabId != null && t.owner &&
          (t.owner === prefix || t.owner.startsWith(`${prefix}::`))) {
        await fetch(`http://localhost:${port}/cli/tab/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabId: t.tabId, sessionId: t.owner }),
        }).catch(() => {});
        await fetch(`http://localhost:${port}/cli/session/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: t.owner }),
        }).catch(() => {});
      }
    }
  } catch { /* relay may not be running */ }

  await executorManager.resetAll();
  agentSessions.clear();
  activeAgentId = null;
  return { content: [{ type: 'text', text: 'Connection reset. All state and tab ownership cleared.' }] };
}
```

这同时删除了原 `for (const [, sid] of agentSessions) ... mcp-${sid}` 的死代码 + `[object Object]` 序列化 bug。

#### 改动 2：进程退出释放（`mcp.ts` main，`644-648` 替换并扩展）

```ts
// AFTER —— 抽出复用函数
async function releaseAllOwnedTabs(): Promise<void> {
  const port = getRelayPort();
  const prefix = `mcp-${MCP_CLIENT_ID}`;
  try {
    const targets = await getTargets(port);
    await Promise.all(targets
      .filter(t => t.tabId != null && t.owner &&
        (t.owner === prefix || t.owner.startsWith(`${prefix}::`)))
      .map(t => fetch(`http://localhost:${port}/cli/tab/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: t.tabId, sessionId: t.owner }),
      }).catch(() => {})));
  } catch { /* best-effort */ }
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${signal})...`);
  await releaseAllOwnedTabs();
  await executorManager.resetAll().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.stdin.on('end', () => void gracefulShutdown('stdin-end')); // MCP 客户端关闭 stdio
```

> 说明：`SIGKILL` 无法捕获，仍依赖 relay 30 分钟 sweep；但 SIGTERM/SIGINT/stdio 关闭已覆盖绝大多数正常退出。

**验证**：connect 后 `reset` → `/json/list` 中该前缀 owner 全部消失；`kill <mcp-pid>`（SIGTERM）后稍候 `/json/list` 同样清空。

---

### S2 — 清理构建产物 + 修正加载指引

#### 改动 1：删除历史遗留目录

```bash
# ext/ 不在 npm workspace、不被任何 build 脚本产出
git rm -r ext/
```

#### 改动 2：确认唯一构建输出并修 README

`extension/scripts/build-chrome.js` 用 `web-ext build` 产出 zip；解压加载用 `extension/`（含 `build/` 与 `manifest.json`）。当前 `README.md:38` 指向不存在的 `extension/dist-chrome/`。改为：

```md
<!-- README.md -->
2. Click "Load unpacked" -> select the `extension/` directory
   (Chrome 用 `extension/build/` 内的产物 + 根 `manifest.json`；
    先执行 `npm run setup` 生成 `extension/build/`)
```

> 若希望保留 `dist-chrome` 命名，则改 `build-chrome.js` 把解包产物拷到 `extension/dist-chrome/`，README 指向它，二选一，不要并存两套。

#### 改动 3：`.gitignore` 只保留一处构建产物路径，删除对 `ext/` 的任何条目。

**验证**：全新 clone → `npm run setup` → 加载指引目录存在且 `backgroundScript.js` 含 `requestOwnershipSnapshot`（新协议指纹）。

---

## P1 修复

### S4 — 关闭跨 session 的所有权绕过

**问题**：`/cli/cdp` 缺省 `params.sessionId` 时跳过校验，`relaySendCdp` 用 `getActiveSessionId()`（第一个 tab）。

#### 改动 1：`relaySendCdp` 按调用方解析目标（`relay.ts:1298-1339`）

```ts
// AFTER —— 增加 callerSessionId 参数
function relaySendCdp(
  method: string,
  params?: Record<string, unknown>,
  timeout = 30000,
  callerSessionId?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sessionId = resolveCdpSessionForCaller(callerSessionId);
    if (!sessionId) {
      reject(new Error(callerSessionId
        ? `No tab owned by session "${callerSessionId}"`
        : 'No attached target'));
      return;
    }
    // ...（其余不变）
  });
}

// 新增：只在调用方拥有的 tab 中选目标 CDP session
function resolveCdpSessionForCaller(callerSessionId?: string): string | undefined {
  if (!callerSessionId) return getActiveSessionId(); // 内部/无主调用保持旧行为
  for (const target of attachedTargets.values()) {
    if (target.tabId != null && getTabOwner(target.tabId) === callerSessionId) {
      return target.sessionId;
    }
  }
  return undefined;
}
```

#### 改动 2：`/cli/cdp` 传调用方 session 并强校验（`relay.ts:1542-1571`）

```ts
// AFTER（关键片段）
if (sessionId) {
  sessionActivity.set(sessionId, Date.now());
  const targetCdpSession = params?.sessionId as string | undefined;
  if (targetCdpSession) {
    const tabId = resolveTabIdFromSession(targetCdpSession);
    if (tabId != null) {
      const owner = getTabOwner(tabId);
      if (owner && owner !== sessionId) {
        return c.json({ error: `Tab ${tabId} owned by session "${owner}"` }, 403);
      }
    }
  }
}
const result = await relaySendCdp(method, params, timeout, sessionId); // ← 传 sessionId
return c.json({ result });
```

`remoteRelaySendCdp`（MCP 侧）已带 `sessionId`，relay 的 `/cli/cdp` 收到后即按所有权解析。

**验证**：用不存在/非 owner 的 `sessionId` 调 `/cli/cdp` 读 `document.title` → 应返回 403 或 "No tab owned"，不再泄漏他人 tab。

---

### S5 — 删除 `/connect-active-tab`

#### 改动 1：删除 relay 端点（`relay.ts:328-360` 整段 `app.post('/connect-active-tab', ...)`）。

#### 改动 2：删除扩展分支（`bridge.js`）

```js
// handleRelayIncoming (bridge.js:529) —— 去掉 connectActiveTab
if (message.method === "connectTabByMatch") {   // 原: "connectActiveTab" || "connectTabByMatch"

// handleRelayMessage (bridge.js:952-956) —— 删除整个 connectActiveTab 分支
```

`ensureActiveTabAttached`（`bridge.js:829-842`）若不再被任何路径调用（S8 实现 createTarget 后 `handleCDPCommand` 的 fallback 也应移除，见下），可一并删除。

**验证**：`POST /connect-active-tab` 返回 404；扩展不再有抓取活跃 tab 的路径。

---

### S6 — 根除双绿点：状态改用扩展 badge，移除页面标题注入

**问题**：`markTabTitle` 注入 `document.title` 前缀，SPA 重写标题后无法清理中段前缀。

#### 改动 1：删除标题注入相关代码（`bridge.js`）

- 删 `TAB_TITLE_PREFIXES`、`ALL_PREFIXES_RE_SRC`（339-345）
- 删 `pendingTitleUpdates`、`markTabTitle`、`_applyTabTitle`（347-384）
- 删所有 `markTabTitle(...)` 调用点（在 `syncOwnershipStates`、`attachTab`、`emitDetachedFromTarget`、`resyncAttachedTabs`、`init`、`ws-state-change` 等处，全删）

#### 改动 2：状态完全由 `updateIcons` 的图标 + badge 表达（已有逻辑，`bridge.js:202-283`）

`updateIcons` 已按 `state` 设置 per-tab 图标（绿/蓝/灰）与 badge 文案/颜色。删除标题逻辑后，状态指示完全落在扩展图标上——这正是 playwriter 的做法，不侵入页面。无需新增代码，只需保证每次状态变更后调用 `updateIcons()`（现有调用点已覆盖）。

#### 改动 3（优化）：删除 executor 侧死代码

`pw-executor.ts:263-272` 的 `buildSetTabTitlePrefixCode` / `TITLE_PREFIX_RE` 在生产代码中无调用（仅测试引用），随 S6 一并删除，并清理 `mcp.test.ts` 中 `setTabTitlePrefix code generation` 相关用例。

**验证**：
```
设 document.title = 'Dashboard - ' + document.title  （模拟 SPA）
等扩展轮询/重标
→ 页面标题保持业务原值，无任何 🟢/🔵 前缀；状态在扩展图标/badge 上显示
```

---

### S7 — 本地安全模型加固与文档

本地 19989 无 token 时，非浏览器调用方（无 `Sec-Fetch-Site`）可执行任意浏览器代码。属本地工具固有取舍，给出渐进加固：

#### 改动 1：文档明确风险（`README.md` 新增「Security model」小节）

> relay 仅监听 127.0.0.1；未设 `SSPA_MCP_TOKEN` 时，本机任意进程均可通过 19989 执行浏览器代码（含已登录会话）。多用户/共享机器请设置 token。

#### 改动 2：可选 token 自动协商（`relay.ts` 启动 + `ensure-relay.ts`）

- relay 启动时若 `SSPA_MCP_TOKEN` 未设，可生成随机 token 写入 `os.tmpdir()/spawriter/relay-token`（仅当前用户可读）。
- CLI/MCP 的 `getRelayToken()` 在环境变量缺失时回退读取该文件。
- `/cli/*` 中间件已支持 Bearer 校验，无需改协议。

> 该项为可选增强；最低限度先落地改动 1 的文档声明。

**验证**：设 `SSPA_MCP_TOKEN` 后，无 Authorization 的 `/cli/execute` 返回 401。

---

## P2 修复

### S8 — 实现 `Target.createTarget` / `Target.closeTarget`（启用 newPage/close）

**问题**：relay 未实现这两条 browser 级 CDP 命令，`context.newPage()`/`page.close()` 失败。`Target.createTarget` 不能用 `chrome.debugger.sendCommand({tabId})` 转发（它是 browser 级），必须用 `chrome.tabs.create/remove` 实现。

#### 改动 1：扩展新增 `closeTab` 命令（`bridge.js` handleRelayMessage，约 1022 行 getTabs 之后）

```js
if (message.method === "closeTab") {
  const tabId = message.params?.tabId ?? message.tabId;
  if (tabId == null) return { success: false, error: "No tabId" };
  try {
    await browser.tabs.remove(tabId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```
（创建 tab 复用已有 `connectTabByMatch { forceCreate:true }`，无需新增。）

#### 改动 2：relay 拦截 createTarget/closeTarget（`relay.ts` `handleCDPMessage`，在调用 `handleServerCdpCommand` 前增加 async 拦截）

因 `handleServerCdpCommand` 是同步函数，这两条需要 await 扩展，单独 async 处理：

```ts
// 在 handleCDPMessage 解析出 method/id 后，转发前插入：
if (method === 'Target.createTarget') {
  void handleCreateTarget(clientId, id, (params as { url?: string })?.url);
  return;
}
if (method === 'Target.closeTarget') {
  void handleCloseTarget(clientId, id, sessionId, (params as { targetId?: string })?.targetId);
  return;
}
```

```ts
// 新增函数
async function handleCreateTarget(clientId: string, id: number, url?: string): Promise<void> {
  const createUrl = url || 'about:blank';
  try {
    const result = await sendExtensionCommand('connectTabByMatch', { url: createUrl, forceCreate: true });
    if (!result.success || typeof result.tabId !== 'number') {
      sendCdpError(clientId, { id, error: `createTarget failed: ${(result as any).error || 'unknown'}` });
      return;
    }
    // 等待 attachedToTarget 落入 attachedTargets
    let target: AttachedTarget | undefined;
    for (let i = 0; i < 25; i++) {
      target = [...attachedTargets.values()].find(t => t.tabId === result.tabId);
      if (target) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!target) { sendCdpError(clientId, { id, error: 'createTarget: tab did not attach' }); return; }
    // 将新 tab claim 给该 client 对应的 session（若可解析）
    const sid = pwClientToSession.get(clientId);
    if (sid && result.tabId != null) claimTab(result.tabId, sid);
    sendCdpResponse(clientId, { id, result: { targetId: buildTargetInfo(target).targetId } });
  } catch (e: any) {
    sendCdpError(clientId, { id, error: `createTarget error: ${e.message}` });
  }
}

async function handleCloseTarget(clientId: string, id: number, sessionId: string | undefined, targetId?: string): Promise<void> {
  const target = targetId
    ? [...attachedTargets.values()].find(t => buildTargetInfo(t).targetId === targetId)
    : (sessionId ? attachedTargets.get(sessionId) : undefined);
  if (!target?.tabId) { sendCdpError(clientId, { id, sessionId, error: 'closeTarget: target not found' }); return; }
  // 所有权校验
  const owner = getTabOwner(target.tabId);
  const callerSid = pwClientToSession.get(clientId);
  if (owner && callerSid && owner !== callerSid) {
    sendCdpError(clientId, { id, sessionId, error: `Tab ${target.tabId} owned by ${owner}` }); return;
  }
  try {
    await sendExtensionCommand('closeTab', { tabId: target.tabId });
    sendCdpResponse(clientId, { id, sessionId, result: { success: true } });
  } catch (e: any) {
    sendCdpError(clientId, { id, sessionId, error: `closeTarget error: ${e.message}` });
  }
}
```

#### 改动 3：移除 `handleCDPCommand` 的 active-tab fallback（`bridge.js:621-635`）

实现 createTarget 后，CDP 命令不应再回退到 `ensureActiveTabAttached()`（与 S5 一致）。将该 fallback 改为直接报错：

```js
if (!targetTabId) {
  sendMessage({ id, error: "No target tab attached" });
  return;
}
```

**验证**：
```
context.newPage() → 返回新 Page，/json/list 多一个该 session 拥有的 tab
page.close()      → 该 tab 从 /json/list 消失，不再 20s 超时
```
> 风险标注：Playwright `connectOverCDP` 的 newPage 内部时序较敏感，需真实浏览器回归；建议先在隔离 session 验证再合入。

---

### S9 — tab 获取收敛到 relay 单一数据源

**问题**：MCP `tab connect` 走扩展 `connectTabByMatch` 全表 `tabs.query({})`（虽有 idle 过滤兜底）。应由 relay（持有权威 `attachedTargets`/`tabOwners`）决定复用，扩展只负责建 tab。

#### 改动 1：MCP connect 先问 relay 复用（`mcp.ts` handleTabAction `connect` 分支，264 行前）

```ts
// AFTER（思路）：connect 时先尝试 relay 端 idle 复用
case 'connect': {
  await ensureRelayServer();
  const url = args.url as string | undefined;
  const tabId = args.tabId as number | undefined;
  const create = args.create as boolean | undefined;
  if (!url && tabId === undefined) { ... }

  // tabId 显式指定：保持原逻辑（走 /connect-tab by tabId）
  // 否则：让 relay 在 idle pool 内复用或 forceCreate（与 /cli/execute 一致）
  // 通过给 /connect-tab 增加 idleOnly 语义（见改动 2），不再扩展全表搜索
  let result = await requestConnectTab(port, { url, tabId, create });
  ...
}
```

#### 改动 2：扩展移除全表搜索分支（`bridge.js:980-996`）

```js
// AFTER —— connectTabByMatch 只负责 by-tabId 连接 与 forceCreate 建 tab；
// 复用判断交给 relay（relay 已在 /cli/execute 用 pickReusableAttachedTab 做 idle-only 复用）
if (url) {
  const forceCreate = message.params?.forceCreate;
  if (forceCreate) {
    const fullUrl = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    const newTab = await browser.tabs.create({ url: fullUrl, active: false });
    await sleep(1000);
    await connectTab(newTab.id);
    return { success: true, tabId: newTab.id, created: true };
  }
  // 非 forceCreate：交回 relay 决策（relay 决定复用 idle 还是要求 forceCreate）
  return { success: false, error: 'No reusable idle tab; relay should retry with forceCreate' };
}
```

#### 改动 3：`/connect-tab` 在 relay 端先做 idle 复用（`relay.ts:362-397`）

```ts
// AFTER（思路）：收到 by-url 请求时，先 pickReusableAttachedTab(url)，
// 命中则直接返回该 tabId（不打扰扩展全表）；未命中再转发 forceCreate 给扩展。
```

> 该项与 S1 协同后，CLI 与 MCP 两条路径共用同一套「relay 决策 idle-only 复用 + forceCreate 兜底」，行为一致、单一数据源。

**验证**：MCP `tab connect {url:X}` 时，扩展端不再 `tabs.query({})` 全表（可在扩展日志确认）；有匹配 idle 则复用，无则新建，绝不触碰用户 tab。

---

### S10 — Windows 引号 + stdin 传码

#### 改动 1：CLI 支持从 stdin 读代码（`cli.ts` 默认命令 action，43 行附近）

```ts
// AFTER
if (options.eval !== undefined) {
  let code = options.eval as string;
  if (code === '-' || code === '') {
    code = await readStdin();   // 读取管道输入，绕过 shell 引号
  }
  await executeCode({ code, timeout: Number(options.timeout) || 30000, ... });
  return;
}
```
```ts
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}
```
用法：`echo 'await navigate("https://x.com")' | spawriter -s ID -e -`

#### 改动 2：文档补 PowerShell/cmd 示例（`AGENTS_CLI.md:17` 附近）

```md
- bash:        spawriter -s ID -e 'await navigate("https://x.com")'
- PowerShell:  spawriter -s ID -e 'await navigate(\"https://x.com\")'
               或 cmd /c "spawriter -s ID -e ""await navigate('https://x.com')"""
- 跨平台稳妥:  echo 'await navigate("https://x.com")' | spawriter -s ID -e -
```

**验证**：PowerShell 下 stdin 方式与转义方式均能正确 navigate，不再 SyntaxError。

---

### S11 — 修复 CLI 退出 libuv 断言崩溃

**问题**：`process.exit(1)` 在 undici 连接池/handle 关闭中途调用，触发 `UV_HANDLE_CLOSING` 断言，掩盖真实退出码。

#### 改动：用 `process.exitCode` 让事件循环自然排空（`cli.ts` executeCode，143 与 151 行）

```ts
// BEFORE
if (result.isError) process.exit(1);
// ...
} catch (error: any) {
  ...
  process.exit(1);
}

// AFTER
if (result.isError) { process.exitCode = 1; return; }
// ...
} catch (error: any) {
  ...
  process.exitCode = 1;
  return;
}
```

成功路径同理（不显式 `process.exit(0)`，让进程自然退出）。若担心 undici keep-alive 拖住退出，可在 `executeCode` 末尾 `await` 完成后无悬挂句柄即自然结束。

**验证**：Windows + Node 26 下，`-e` 出错退出码为 1 且无 `Assertion failed` 噪声；成功退出码 0。

---

### S12 — `execute` / `single_spa` 暴露 `session_id`

#### 改动：schema 增加参数（`mcp.ts` tools 定义）

`execute` 的 `inputSchema.properties`（`mcp.ts:457-466`）增加：
```ts
session_id: { type: 'string', description: 'Session ID for per-agent isolation (use the same value as tab connect)' },
```
`single_spa` 的 `inputSchema.properties`（`mcp.ts:487-497`）同样增加 `session_id`。

配合 S1 改动 5，`execute`/`single_spa` 收到 `session_id` 即设 `activeAgentId`，与 `tab` 全程一致。

**验证**：两个不同 `session_id` 各自 `execute`，`state` 不互相串，tab 各自隔离。

---

## 优化清单（随修复一并处理）

| 项 | 位置 | 优化 |
|---|---|---|
| 死代码 | `pw-executor.ts:263-272` `buildSetTabTitlePrefixCode`/`TITLE_PREFIX_RE` | 无生产调用，随 S6 删除 |
| 死代码 | `mcp.ts:121-132` `getAgentSession` + `agentSessions` | 从未被调用，随 S1/S3 删除（或接入统一 session 管理） |
| 轮询→事件 | `bridge.js:1042-1057` 5s `fetch /json/list` 对账 | relay 已通过 `Target.ownershipSnapshot` 主动推送，轮询可降频或移除，减少无谓 HTTP |
| 单一数据源 | relay `tabOwners` 与扩展 `tabOwnership` 两套 | 以 relay 为权威，扩展仅渲染快照（S9 配套） |
| 复用空 tab | `relay.ts:251-261` `pickReusableAttachedTab` 仅复用 safe-URL | 可选：允许复用本会话历史 idle tab，降低新建频率 |

---

## 回归测试补强（对应审计第 5 节）

新增集成测试（建议 `spawriter/src/integration.test.ts`，内存 relay + mock 扩展 WS）：

1. **S1 回归**：同一 MCP 身份 `tab connect` 后 `execute`，断言 `/json/list` tab 数不变、owner 一致。
2. **S3 回归**：`reset` 后该前缀 owner 数为 0；模拟 stdin end 后同样为 0。
3. **S4 回归**：非 owner session 调 `/cli/cdp` 必返回 403。
4. **S6 回归**：扩展状态变更不产生任何页面标题写入（mock `chrome.scripting.executeScript` 断言未被调用）。
5. **S8 回归**：`Target.createTarget` 返回 targetId 且新 target 入表；`closeTarget` 后出表。
6. **隔离回归**：两 session 并发，各自只见自己的 tab。

---

## 附：最小可用首批落地清单（30 分钟内见效）

1. S1 改动 1–5（统一 session）
2. S3 改动 1（reset 释放）
3. S2 改动 1–2（删 `ext/` + 修 README）
4. `npm run build:mcp` → 重启 MCP → 重新加载 `extension/`（正确目录）
5. 跑 S1/S3 验证步骤确认"多开 tab""reset 不释放"消失
