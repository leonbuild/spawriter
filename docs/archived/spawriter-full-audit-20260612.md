# spawriter 全面审计报告

> **Status: Implemented**（2026-06-12）。S1–S12 已全部修复，见 `docs/spawriter-fix-plan-20260612.md` 头部的实施记录。本文描述的问题均为修复前快照。

- 审计日期：2026-06-12
- 审计范围：架构、relay / MCP / CLI / executor 实现、Chrome 扩展、构建产物、测试覆盖
- 审计方式：静态代码走查 + 真实 relay 上的 CLI/MCP 端到端对比测试（证据见附录）
- 被审版本：`spawriter` 1.0.0，relay/extension/CLI 均为 1.0.0
- 参考对象：`0-ref/playwriter`、`0-ref/browser-use`

---

## 0. 结论摘要（TL;DR）

用户报告的三个症状全部成功复现，根因均已定位：

1. **agent 连续获取多个 tab** —— 根因是 **MCP 服务器内部使用了三套互不一致的 session 命名**。`tab connect` 领取的 tab 与 `execute` 实际使用的 tab 永远不是同一个，导致每个 agent 按官方文档流程操作必然多开一个 tab；叠加 `reset` 不释放、进程退出不释放、非空 tab 永不复用三个放大器，tab 越积越多。
2. **agent 抢用户 tab** —— 当前源码已基本修复（CLI 路径实测不再抢占）。但仍存在三个残留口子：扩展侧 `connectTabByMatch` 的非 `forceCreate` 分支仍全表搜索、`/connect-active-tab` 端点仍在、以及**仓库内存在一个更旧的扩展构建目录 `ext/dist-chrome/`，装上它会退回旧的"抢 tab + 无所有权"行为**。
3. **tab 出现两个小绿点** —— 状态用「修改页面 `document.title` 加 emoji 前缀」表示，SPA 重写标题后前缀被推入中段，扩展再次标记时只能脱开头前缀、无法脱中段前缀，于是叠加出第二个绿点。已稳定复现。

此外发现：所有权隔离可被绕过（跨 session 读取他人 tab）、`context.newPage()`/`page.close()` 不可用、本地 HTTP 接口无鉴权即可执行任意浏览器代码、Windows/PowerShell 下 CLI 引号被吞、CLI 退出时 libuv 断言崩溃等问题。

单元测试 1426 个全部通过，但**上述所有集成层 bug 的测试覆盖为零**——现有测试几乎全是单文件纯函数测试，没有任何贯穿 relay+executor+extension 的端到端用例。

严重度分布：

| 级别 | 数量 | 编号 |
|---|---|---|
| P0 严重（直接导致"不好用"） | 3 | S1, S2, S3 |
| P1 安全/正确性 | 4 | S4, S5, S6, S7 |
| P2 功能缺口/体验 | 5 | S8, S9, S10, S11, S12 |

---

## 1. 系统架构

```
AI Agent ─┬─ MCP Server (stdio)  ─┐
          └─ CLI (-e)            ─┴─→ CDP Relay (:19989) ←──→ Chrome Extension ←──→ Browser Tab
                                  HTTP/WS                  WS(offscreen)        chrome.debugger
```

- **relay (`spawriter/src/relay.ts`, 1600 行)**：单例 HTTP+WS 服务器，端口 19989。维护 `attachedTargets`（CDP session→tab）、`tabOwners`（tab→session 所有权）两张核心表，对 CDP 客户端做 Playwright 协议多路复用与所有权拦截。
- **MCP (`spawriter/src/mcp.ts`, 594 行)**：stdio MCP server，4 个工具 `execute`/`reset`/`single_spa`/`tab`。自身不直接连浏览器，全部通过 HTTP 转发给 relay。
- **CLI (`spawriter/src/cli.ts`, 268 行)**：`-e` 代码执行、session 管理、relay 启动。也通过 HTTP 转发给 relay。
- **executor (`spawriter/src/pw-executor.ts`, 2334 行)**：Playwright over CDP 执行引擎，VM 沙箱运行用户代码，提供 navigate/snapshot/screenshot/networkLog 等全部 globals。relay 与 MCP 各持有一个 `ExecutorManager`。
- **extension (`extension/src/ai_bridge/bridge.js`, 1186 行)**：MV3 service worker，通过 offscreen document 维持与 relay 的持久 WebSocket，用 `chrome.debugger` 在真实 tab 上执行 CDP 命令。

架构本身合理（连接真实浏览器、复用登录态、single-spa 感知），核心问题集中在**所有权/session 状态管理**这一层。

---

## 2. P0 严重问题

### S1 — MCP session 三套命名不一致，导致 agent 多开 tab 【已动态复现，最严重】

**位置**：`spawriter/src/mcp.ts`

同一个 MCP 进程内部，三条路径计算出的 relay session ID 互不相同：

| 路径 | 代码 | 实际 session |
|---|---|---|
| `tab connect`（带 `session_id`） | `mcp.ts:224-226` `getEffectiveClientId(sessionId)` | `mcp-${MCP_CLIENT_ID}::${agentId}` |
| `execute` | `mcp.ts:162` `getEffectiveClientId()` **无参** | `mcp-${MCP_CLIENT_ID}`（丢掉 agentId） |
| 本地 executor | `mcp.ts:156-157` | `mcp-${agentId}` / `mcp-default` |

`getEffectiveClientId` 无参时直接返回基础 ID，不带 agent 后缀：

```ts
// mcp.ts:116-119
function getEffectiveClientId(agentId?: string): string {
  if (!agentId) return MCP_CLIENT_ID;
  return `${MCP_CLIENT_ID}::${agentId}`;
}
```

```ts
// mcp.ts:160-167  —— execute 走的就是这里，永远不带 agentId
async function executeViaRelay(code: string, timeout: number): Promise<ExecuteResult> {
  const port = getRelayPort();
  const mcpSessionId = `mcp-${getEffectiveClientId() || 'default'}`;   // ← 无参！
  const resp = await fetch(`http://localhost:${port}/cli/execute`, {
    ...
    body: JSON.stringify({ sessionId: mcpSessionId, code, timeout }),
```

**后果**：`tab connect` 把新建/复用的 tab claim 给了 `mcp-…::agentId`，但随后的 `execute` 用 `mcp-…`（无后缀）去 relay，relay 发现该 session 没有任何 owned tab，于是**再新建一个 tab**。两者永远对不上，每个 agent 固定多开一个 tab。

**动态复现**（严格按 `AGENTS_MCP.md` 推荐流程：先 `tab connect` 带 session_id，再 `execute`）：

```
STEP 1  tab connect {url:about:blank, create:true, session_id:e2e-agent-a}
        → 新建 tabId=…864, owner = mcp-mcp-24204-mqailoc4::e2e-agent-a
STEP 2  execute {code:"page.url()"}
        → 又新建 tabId=…867, owner = mcp-mcp-24204-mqailoc4   (没有用 864！)
STEP 3  tab list {session_id:e2e-agent-a}
        → "4 tab(s), 1 mine, 3 owned by others, 0 available"
          tabId 864 标 MINE，tabId 867 被标成 "owned by others"（其实是同一个 agent 自己！）
```

`execute` 自己建的 tab 在 `tab list` 里反而显示成"别的 session 拥有"，这正是用户观察到的"连续获取多个 tab"。

**对比**：CLI 模式不受此 bug 影响——CLI 全程只用 `-s` 传入的单一 session 名，实测 T1（首次 execute 自动新建并 claim）、T3（第二 session 完全隔离）均正确。**所以问题主要出在 MCP 模式**。

**建议修复**：让 `execute`/`single_spa`/`getOrCreateExecutor`/`tab connect` 全部使用同一个 session ID。最小改动是把 `execute` 路径也带上 `activeAgentId`：

```ts
// executeViaRelay 应接收 agentId，并：
const mcpSessionId = `mcp-${getEffectiveClientId(activeAgentId ?? undefined)}`;
```

并在 `execute` 工具处理中接受 `session_id` 参数、同步设置 `activeAgentId`（见 S12）。修复后"多开 tab"会立即消失，且 S3 的两个释放问题也随之缓解。

---

### S2 — 构建产物混乱：旧扩展目录 + README 指向不存在的路径 【已确认，高危】

**位置**：仓库根 `ext/` 与 `extension/`，`README.md:38`

仓库内同时存在两个扩展构建目录，且**日期更新的那个反而是更旧的代码**：

| 目录 | backgroundScript.js 时间 | 代码指纹 | 判定 |
|---|---|---|---|
| `extension/build/` | 2026-04-27 13:24 | 含 `Target.ownershipSnapshot`、`requestOwnershipSnapshot`、`tabInfoChanged`、新 fallback 文案 | **当前源码的构建** |
| `ext/dist-chrome/` | 2026-05-18 09:12 | 无 ownership 快照协议、无 `requestOwnershipSnapshot`、无 `tabInfoChanged` | **更旧的代码（旧 tab 选择逻辑）** |

指纹验证（节选实测）：

```
extension/build/backgroundScript.js   ownershipSnapshot=true   requestOwnershipSnapshot=true   tabInfoChanged=true
ext/dist-chrome/build/backgroundScript.js  ownershipSnapshot=false  requestOwnershipSnapshot=false  tabInfoChanged=false
```

`ext/dist-chrome` 的源映射还原出的 `connectTabByMatch` 是旧实现：`allTabs.find(t => t.url.includes(url))` 全表搜索、无 idle 过滤、无 `forceCreate` 概念——**正是会"抢用户 tab"的版本**。

同时 `README.md` 指引用户加载：

```
2. Click "Load unpacked" -> select extension/dist-chrome/
```

而 `extension/dist-chrome/` **根本不存在**（实际目录是 `extension/build/` 或根级 `ext/dist-chrome/`）。

**后果**：用户极可能加载了 `ext/dist-chrome/`（旧扩展）配新 relay，所有权快照协议对不上，表现为"时好时坏、不如别的 MCP 好用"——这很可能是用户主观感受"这版不好用"的**直接原因之一**：relay 与扩展版本错配。

**建议修复**：
1. 删除根级 `ext/` 目录（不在 npm workspace、不被任何 build 脚本产出，是历史遗留）。
2. 统一构建输出目录命名，`README.md` 改为指向真实存在且最新的目录（`extension/build/`，或让 `build:chrome` 产出到 `extension/dist-chrome/` 并对齐文档）。
3. `.gitignore` 确认只忽略一处构建产物，避免再次出现双目录。

---

### S3 — reset 与进程退出都不能真正释放 tab 所有权 【已动态复现 reset；进程退出为代码层面确认】

**位置**：`spawriter/src/mcp.ts:540-560`

`reset` 工具声称 "All state and tab ownership cleared"，实测并未释放 `tab connect` 领取的 tab：

```
连接后:  tabId=…873 owner = mcp-mcp-3424-mqaipt59::e2e-reset-agent
调用 reset → 返回 "Connection reset. All state and tab ownership cleared."
reset 后:  tabId=…873 owner = mcp-mcp-3424-mqaipt59::e2e-reset-agent   ← 原样残留！
```

根因有两处：

```ts
// mcp.ts:540-544
if (name === 'reset') {
  const port = getRelayPort();
  const sessionsToRelease = new Set<string>();
  for (const [, sid] of agentSessions) sessionsToRelease.add(`mcp-${sid}`);   // (A)
  sessionsToRelease.add(`mcp-${getEffectiveClientId() || 'default'}`);         // (B)
```

- **(A) 死代码 + 序列化 bug**：`agentSessions` 是 `Map<string, AgentSession>`，`sid` 是 `AgentSession` 对象，`` `mcp-${sid}` `` 会变成 `"mcp-[object Object]"`。而且 `getAgentSession`（唯一会 `agentSessions.set` 的函数，`mcp.ts:121-132`）**从未被任何代码调用**，所以 `agentSessions` 永远是空 Map，这一行实际不执行。
- **(B) 漏掉 agent 后缀**：这里删的是 `mcp-${MCP_CLIENT_ID}`（execute 用的无后缀名），而 `tab connect` 领的 tab owner 是 `mcp-${MCP_CLIENT_ID}::agentId`（带后缀）。`/cli/session/delete` 内部 `releaseAllTabs(无后缀名)` 匹配不到带后缀的所有权，于是释放不掉。

这又是 S1（session 命名不一致）的直接恶果。

**进程退出同理**（代码层面确认）：
- relay 的 `ws.on('close')`（`relay.ts:1710-1722`）只对 `sessionToClientId` 中匹配的 pw client 释放 tab。execute 时绑定的 session 是无后缀名，因此进程退出最多能释放 execute 自建的 tab，**释放不掉 connect 领的带后缀 tab**。
- MCP 的 `SIGINT` handler（`mcp.ts:644-648`）只调 `executorManager.resetAll()`（关闭本地 Playwright 连接），不调用 relay 的 release；且只挂了 `SIGINT`，`SIGTERM`/`SIGKILL`/stdio 关闭都不会触发。
- 兜底只有 relay 端 30 分钟 stale sweep（`relay.ts:285-318`），且 sweep **只删 ownership、不关闭 tab**。

**后果**：泄漏的 tab 在 30 分钟内一直占着（且非空 URL 的 idle tab 永不被复用，见 S? 复用逻辑），表现为浏览器里 spawriter tab 越积越多。

**建议修复**：`reset` 改为查询 `/json/list` 找出所有 `owner` 以当前 `mcp-${MCP_CLIENT_ID}` 为前缀（含 `::agentId`）的 tab，逐个 `/cli/tab/release`；并在 stdio transport 关闭 / `SIGTERM` 时执行同样的释放。修复 S1 后此处可大幅简化。

---

## 3. P1 安全 / 正确性问题

### S4 — 所有权隔离可被绕过：跨 session 读取他人 tab 【已动态复现】

**位置**：`spawriter/src/relay.ts:1542-1571`（`/cli/cdp`）与 `relay.ts:1291-1339`（`relaySendCdp` + `getActiveSessionId`）

`/cli/cdp` 仅在 `params.sessionId`（目标 CDP session）存在时才做所有权校验；缺省时直接放行，并落到 `relaySendCdp`：

```ts
// relay.ts:1291-1296  —— 取 attachedTargets 的第一个，完全无视所有权
function getActiveSessionId(): string | undefined {
  for (const target of attachedTargets.values()) {
    return target.sessionId;
  }
  return undefined;
}
```

**动态复现**：用一个根本不存在的 session 名调用，成功读到别的 session 拥有的 tab 内容：

```
POST /cli/cdp {"method":"Runtime.evaluate","params":{"expression":"document.title",...},"sessionId":"leak-test-session"}
→ {"result":{"result":{"type":"string","value":"Dashboard - Example Domain"}}}   ← 读到了他人 tab 的标题
```

任意调用者只要不指定目标 CDP session，就能对"第一个 attached tab"执行任意 CDP 命令，无视 `tabOwners`。多 agent 场景下相当于所有权形同虚设。

**建议修复**：`relaySendCdp` 接收并校验调用方 session；`/cli/cdp` 在缺省目标 session 时按调用方 owned tab 解析目标，而非取第一个；无 owned tab 则报错。

---

### S5 — `/connect-active-tab` 端点仍可直接抢占用户活跃 tab 【代码层面确认】

**位置**：`spawriter/src/relay.ts:328-360`，扩展侧 `bridge.js:952-956`

```ts
// relay.ts:328  端点存在，无任何所有权/安全保护
app.post('/connect-active-tab', async (c) => {
  ...
  sendToExtension({ id: relayId, method: 'connectActiveTab' });
```

扩展侧 `ensureActiveTabAttached()`（`bridge.js:829-842`）无条件 attach `browser.tabs.query({active:true})`——即用户正在看的 tab。所有 AGENTS 文档都声明"禁止使用"，但端点存在即攻击面：任意本地进程一条 HTTP 即可抢占用户当前 tab。

**建议修复**：删除该端点与 `connectActiveTab` 扩展分支；状态指示等场景不需要它。

---

### S6 — 两个小绿点：标题 emoji 前缀方案的结构性缺陷 【已动态复现】

**位置**：`extension/src/ai_bridge/bridge.js:339-384`（`TAB_TITLE_PREFIXES` / `markTabTitle`）

tab 状态（owned/idle）通过给页面 `document.title` 加 emoji 前缀显示：

```js
// bridge.js:339-345
const TAB_TITLE_PREFIXES = { connected: "🟢 ", idle: "🔵 ", connecting: "🟡 ", error: "🔴 " };
const ALL_PREFIXES_RE_SRC = "^(?:🟢 |🟡 |🔴 |🔵 )+";   // 只能脱「开头」的前缀
```

`markTabTitle` 每次注入脚本时先 `disconnect()` 旧的 MutationObserver、删掉 `__spawriterOrigTitleDesc` 描述符，然后做一次性正则替换——也就是说原本设计用来防抖动的 observer/描述符保护**实际是被关掉的**，只剩开头正则替换。

**动态复现**（SPA 用模板字面量重设标题是极常见写法）：

```
初始:            🟢 Example Domain
页面执行 title = 'Dashboard - ' + title
                 → "Dashboard - 🟢 Example Domain"   (绿点被推进中段)
扩展 5s 轮询后重新 markTabTitle
                 → "🟢 Dashboard - 🟢 Example Domain"  (开头补一个，中段那个脱不掉 → 两个绿点!)
```

根因：`^(?:🟢…)+` 只能匹配字符串开头，无法移除被 SPA 推到中段的旧前缀；下次标记时在最前面又加一个。

**对比 playwriter**：playwriter 用扩展工具栏 UI（`extension/src/toolbar/`）显示连接状态，**完全不修改页面标题**，从根本上不存在此问题。

**建议修复**：移除标题 emoji 注入，改用 `chrome.action.setBadgeText` / `setBadgeBackgroundColor`（已有 `buildBadgeInfo`，`bridge.js:191-200`）或工具栏 popup 显示状态。这同时消除对页面 DOM 的侵入（SPA 标题逻辑、SEO、用户可见标题都会被污染）。

---

### S7 — 本地 HTTP 接口无鉴权即可执行任意浏览器代码 【代码层面确认】

**位置**：`spawriter/src/relay.ts:1349-1368`（`/cli/*` 中间件）、`utils.ts:18-20`（token 默认 undefined）、`relay.ts:320-321`（扩展白名单默认放开）

- `getRelayToken()` 默认 `undefined`，此时 `/cli/*` 不做 Bearer 校验。
- 中间件依赖 `Sec-Fetch-Site` 防 CSRF，但**非浏览器调用方（curl / 任意本地进程）不发该 header，`secFetchSite` 为空即放行**。
- `/cli/execute` 会在浏览器上下文执行任意 Playwright/JS 代码，结合用户登录态，等价于本地任意进程可读写用户的已登录会话。
- `getAllowedExtensionIds()` 默认空 → `ALLOW_ANY_EXTENSION = true`，relay 接受任何 `chrome-extension://` origin 连接。

这是"连接真实浏览器"工具的固有取舍，但应明确记录并提供加固选项（默认绑定 127.0.0.1 已有，但无 token 时本地任意进程仍可调用）。

**建议**：文档显著标注本地安全模型；考虑默认生成一次性 token 并通过受保护渠道传给 MCP/CLI；扩展白名单提供配置引导。

---

## 4. P2 功能缺口 / 体验问题

### S8 — `context.newPage()` / `page.close()` 不可用 【已动态复现】

**位置**：relay 的虚拟 target 多路复用未实现 `Target.createTarget` / `Target.closeTarget`（对比 `playwriter/extension/src/background.ts:1006-1016` 已实现）。

```
T4: const p = await context.newPage(); p.url()
    → Error: browserContext.newPage: Cannot read properties of undefined (reading '_page')
清理阶段: page.close() 全部 20s 超时，最终只能用底层 CDP Page.close 关闭 tab
```

这是能力缺口而非偶发 bug：agent 无法在同一 session 内开/关多页，多 tab 工作流受限。

**建议**：在 relay 的 `handleServerCdpCommand` 实现 `Target.createTarget`/`Target.closeTarget`，转发给扩展的 `tabs.create`/`tabs.remove` 并维护 attachedTargets，对齐 playwriter。

---

### S9 — 残留的"抢用户 tab"代码路径 【代码层面确认】

即便不算 S2 的旧扩展，当前源码仍有两处依赖兜底而非源头安全：

```js
// bridge.js:980-996  —— connectTabByMatch 非 forceCreate 分支仍全表 query
if (url) {
  const forceCreate = message.params?.forceCreate;
  if (!forceCreate) {
    const allTabs = await browser.tabs.query({});   // 全部浏览器 tab
    const match = pickBestMatchingTab(allTabs, url);
```

`pickBestMatchingTab`（`bridge.js:134-140`）已新增 `attachedTabs.has(tab.id) && !isTabOwned(tab.id)` 过滤（纵深防御到位），但 MCP `tab connect {url, create:true}` 仍先走这条全表路径，安全性依赖过滤兜底。`relay.ts` 的 `/cli/execute` 自动获取路径已改为始终 `forceCreate`（`relay.ts:1400-1423`，实测正确），但 MCP 的 connect 走的是 `/connect-tab`→扩展直连，未享受该收紧。

**建议**：MCP `tab connect` 也统一走 relay 的 `pickReusableAttachedTab`（只在 idle pool 内匹配）+ `forceCreate` 新建，与 CLI execute 路径一致；扩展侧非 forceCreate 全表分支可整体移除。

---

### S10 — Windows / PowerShell 下 CLI 引号被吞 【已动态复现】

```
T2: spawriter -s <id> -e 'await navigate("https://example.com")'
    （PowerShell 吃掉内层双引号）
    → relay 收到 navigate(https://example.com)
    → SyntaxError: missing ) after argument list
```

`AGENTS_CLI.md:17` 只说明 bash 单引号规则，未覆盖 Windows/PowerShell（需 `cmd /c "... -e \"...\""` 或转义）。Windows 用户必然踩坑。

**建议**：`AGENTS_CLI.md` 增加 PowerShell/cmd 引号示例；或在 CLI 增加从 stdin/文件读取代码的方式（`-e -` 读 stdin）规避 shell 引号问题。

---

### S11 — CLI 退出时 libuv 断言崩溃 【已动态复现】

多次出现，退出码 `-1073740791`：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

出现在 `-e` 出错路径 `process.exit(1)`（`cli.ts:143/151`）时，仍有未正常关闭的 handle（CDP WebSocket / fetch）。功能结果不受影响，但每次报错都伴随崩溃噪声，且**掩盖了真实退出码**（脚本无法可靠判断成功/失败）。

**建议**：用 `process.exitCode = 1` + 优雅关闭未决连接替代直接 `process.exit`；或显式 `ws.terminate()` 后再退出。

---

### S12 — `execute` / `single_spa` 不支持 `session_id`，多 agent 无法隔离 execute 【代码层面确认】

**位置**：`mcp.ts:455-518` 工具 schema

只有 `tab` 工具暴露 `session_id` 参数，`execute` 与 `single_spa` 没有。所有 execute 都挤在 `mcp-${MCP_CLIENT_ID}` 单一 executor 上（见 S1）。同一 MCP server 服务多个并发 agent 时，execute 无法隔离、`state` 互相串。

**建议**：`execute`/`single_spa` 也接受 `session_id`，与 `tab` 共用同一 session 解析逻辑（修复 S1 的一部分）。

---

## 5. 测试覆盖评估

| 维度 | 现状 | 评价 |
|---|---|---|
| 单元测试 | 1426 test / 276 suite 全绿，约 122s | 纯函数层质量好：AX 树格式化、网络监控、截图压缩档位、debugger 状态机、override 同步、snapshot diff、ownership 纯逻辑等 |
| 集成测试 | 几乎为零 | `mcp.test.ts` 8770 行但无一个真正跑 `executeViaRelay → relay → executor` 的端到端用例 |
| 本报告所列 bug 覆盖 | 0 | S1（session 命名）、S3（reset 释放）、S4（所有权绕过）、S6（双绿点）、S8（newPage）均无测试 |
| 对比 playwriter | 缺口明显 | playwriter 有 `relay-core.test.ts`/`relay-session.test.ts`/`relay-navigation.test.ts`/`extension-connection.test.ts` 等真实链路测试 |

**根本问题**：所有 bug 都跨 relay+executor+extension 三方协作，而测试全是单文件纯函数，结构上无法捕获这类集成缺陷。

**建议**：新增集成测试套件，用内存内 relay + mock 扩展 WS，覆盖：
- 同一 MCP 身份下 `tab connect` 与 `execute` 必须命中同一 tab（回归 S1）；
- `reset` 后 `/json/list` 中该身份的 owner 全部清空（回归 S3）；
- `/cli/cdp` 对非 owner session 必须拒绝（回归 S4）；
- 多 session 并发只各持有自己的 tab（回归隔离）。

---

## 6. 与 playwriter / browser-use 的能力对齐

| 能力 | playwriter | spawriter | 对齐建议 |
|---|---|---|---|
| 状态显示 | 扩展工具栏 UI，不碰页面 | 改 `document.title` 加 emoji（S6 根因） | 改 badge/popup，移除标题注入 |
| 多 tab / 新建关闭 | `Target.createTarget`/`closeTarget` | 不支持，`newPage`/`close` 报错（S8） | 实现虚拟 target 的 create/close |
| tab 创建语义 | 走 CDP 标准 createTarget | 旁路 HTTP `connectTabByMatch` | 收敛到 CDP 标准路径 |
| 状态数据源 | zustand store 单一数据源 | relay+extension 两套 Map + 5s HTTP 轮询对账（`bridge.js:1042-1057`） | 单一所有权源、事件驱动取代轮询 |
| session 身份 | 单一身份贯穿全流程 | MCP 内三套命名（S1） | 统一 session 解析 |
| 集成测试 | 多个真实链路测试 | 无 | 补集成测试 |
| ghost cursor / 录制 | 有 | 无 | 可选对齐 |

`browser-use` 为独立浏览器 + 云端架构，定位不同，主要可借鉴"单一 agent 身份贯穿全流程"的设计。

---

## 7. 修复优先级建议

**P0（直接导致不好用，应立即修）**
1. **S1** 统一 MCP session 身份：`execute`/`single_spa`/`getOrCreateExecutor`/`tab connect` 用同一 session ID。改动最小、收益最大，修完"多开 tab"立即消失。
2. **S2** 删除 `ext/` 目录，`README` 改指向真实存在的最新构建目录，统一构建输出。
3. **S3** `reset` 真正释放当前身份的所有 tab；stdio 关闭/`SIGTERM` 时同样释放。（依赖 S1）

**P1（安全 / 正确性）**
4. **S4** `/cli/cdp` 强制按调用方所有权解析目标 tab；`relaySendCdp` 不再取"第一个 tab"。
5. **S5** 删除 `/connect-active-tab` 端点与扩展分支。
6. **S6** 状态显示改 badge/popup，移除页面标题 emoji 注入（根除双绿点）。
7. **S7** 文档明确本地安全模型；提供 token / 扩展白名单加固引导。

**P2（功能 / 体验）**
8. **S8** 实现 `Target.createTarget`/`closeTarget`，让 `newPage`/`page.close()` 可用。
9. **S9** MCP `tab connect` 收敛到 relay 的 idle-only + forceCreate 路径，移除扩展全表分支。
10. **S10** `AGENTS_CLI.md` 补 Windows/PowerShell 引号说明，或支持 stdin 传码。
11. **S11** 修 CLI 退出时 handle 泄漏，保证退出码可靠。
12. **S12** `execute`/`single_spa` 接受 `session_id`。
13. 补充贯穿 relay+executor+extension 的集成测试（回归 S1/S3/S4）。

---

## 附录 A：端到端测试记录

测试在已运行的真实 relay（127.0.0.1:19989，无扩展连接时直接复现 relay/MCP 层逻辑；扩展相关结论以源码与构建指纹为准）上进行。原始日志：`docs/e2e-20260612.log`。

### A.1 CLI 路径（健康）

| 用例 | 操作 | 结果 | 判定 |
|---|---|---|---|
| T1 | 新 session 首次 `page.url()` | 自动新建 tab 并 claim，返回 `about:blank` | 通过 |
| T2 | 单引号 navigate（PowerShell） | 引号被吞 → SyntaxError | S10 |
| T2b/T2c | `cmd /c` 转义后 navigate | 成功，`https://example.com/` | 通过 |
| T3 | 第二 session `page.url()` | 各自独立 tab，互不干扰 | 通过（隔离正确） |
| T4 | `context.newPage()` | `Cannot read properties of undefined (reading '_page')` | S8 |
| T6/T6b | SPA 重写标题后观察前缀 | `🟢 Dashboard - 🟢 Example Domain` | S6（双绿点） |
| T8 | `/cli/cdp` 用不存在的 session 读标题 | 成功读到他人 tab 标题 | S4（所有权绕过） |

### A.2 MCP 路径（多开 tab + reset 泄漏）

```
STEP1 tab connect(session_id=e2e-agent-a) → tabId 864 owner=mcp-…::e2e-agent-a
STEP2 execute(page.url())                 → tabId 867 owner=mcp-…        (没用 864，多开!)
STEP3 tab list(session_id=e2e-agent-a)    → 1 mine, 3 owned by others, 0 available
reset 测试: connect 得 tabId 873 owner=mcp-…::e2e-reset-agent
            reset 返回"ownership cleared" 但 873 owner 原样残留
```

证据印证根因：execute 用无后缀 session、connect 用带后缀 session，二者永不相交（S1）；reset 删无后缀名、漏带后缀名（S3）。

## 附录 B：关键代码位置索引

| 编号 | 文件:行 | 说明 |
|---|---|---|
| S1 | `mcp.ts:116-119, 160-167, 154-158, 222-226` | session 三套命名 |
| S2 | `ext/` 目录、`README.md:38` | 旧构建 + 错误指引 |
| S3 | `mcp.ts:540-560, 121-132, 644-648`；`relay.ts:285-318, 1710-1722` | reset/退出不释放 |
| S4 | `relay.ts:1542-1571, 1291-1339` | 所有权绕过 |
| S5 | `relay.ts:328-360`；`bridge.js:829-842, 952-956` | connect-active-tab |
| S6 | `bridge.js:339-384, 1042-1057` | 标题 emoji 双绿点 |
| S7 | `relay.ts:1349-1368, 320-321`；`utils.ts:18-20` | 本地无鉴权 |
| S8 | `relay.ts` handleServerCdpCommand（缺 createTarget/closeTarget） | newPage/close |
| S9 | `bridge.js:980-996, 134-140`；`relay.ts:1400-1423` | 残留抢 tab 路径 |
| S10 | `cli.ts:42-59`；`AGENTS_CLI.md:17` | Windows 引号 |
| S11 | `cli.ts:143, 151` | 退出崩溃 |
| S12 | `mcp.ts:455-518` | execute 无 session_id |
