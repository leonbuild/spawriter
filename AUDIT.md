# spawriter 项目审计报告

- 审计对象：`D:\dev\side\spawriter`（monorepo：`spawriter/` MCP 服务器 + CDP relay、`extension/` Chrome MV3 扩展）
- 审计分支/状态：`main`，工作树干净（`git status` 无改动），最新提交 `46908de`
- 审计方法：源码走读 + 运行日志分析（`%TEMP%\spawriter\relay.log`）+ 端口/接口实测（`netstat`、HTTP 探测）+ 最小复现脚本 + 完整测试套件执行
- 测试基线：`npm test` 全绿，`tests 1642 / suites 325 / fail 0`（耗时约 124.8s）

> 每条问题均附**证据**（`文件:行号`、日志计数、复现结果）与**修复方案**。仅列出已验证的问题，不含臆测。

---

## 结论摘要（按严重度）

| 编号 | 严重度 | 问题 | 证据类型 |
|---|---|---|---|
| S1 | 高 | Relay 实际监听所有网卡（`::`/`0.0.0.0`），且 HTTP 控制面无 localhost 校验，与文档"仅 127.0.0.1"矛盾 | 代码 + netstat + HTTP 实测 |
| S2 | 高 | `/shutdown`、`/connect-tab`、`/trace` 等在 `/cli/*` 鉴权中间件之外，设 token 也无法保护 | 代码 |
| B1 | 高（功能/数据） | 客户端 `cwd` 在服务端被丢弃 → ScopedFS 误拦截用户项目目录写入（EPERM） | 代码 + 日志 4 次 |
| R1 | 中 | EADDRINUSE 仍以 uncaughtException 崩溃退出（有专门 handler 却未生效） | 代码 + 日志 + 复现 |
| S3 | 中 | `/cli/*` 的 CSRF 防护依赖 `sec-fetch-site` 存在性，非浏览器客户端可绕过 | 代码 + HTTP 实测 |
| T1 | 中 | `tests/relay-crash-fixes.test.ts` 从未被 `npm test` 执行，且 `vitest` 未在任何 package.json 声明 | 代码 + lockfile |
| R2 | 中低 | stderr 写入 EPIPE 导致 relay 崩溃（父进程退出时） | 代码 + 日志 7 次 |
| M1 | 中 | `relay.ts`(2210) / `pw-executor.ts`(2592) 远超项目自定的"单文件 <400 行" | 行数统计 |
| N1 | 低 | "unknown request id"(465) / "Late response"(162) 以 ERROR 刷屏 | 代码 + 日志 |
| N2 | 低 | "OWNERSHIP BLOCKED"(204) 无去重，毫秒级批量重复 | 代码 + 日志 |
| N3 | 低 | `No SSPA_EXTENSION_IDS configured` 以 ERROR 级别、每次启动重复打印 | 代码 + 日志 |
| T2 | 低 | `test` 脚本用手写文件清单，新增 `*.test.ts` 会被静默漏测 | 代码 |

---

## S1 · 高 · Relay 监听所有网卡且 HTTP 控制面无 localhost 校验

**文档承诺**（`README.md:169`）：
> The relay listens on `127.0.0.1` only. Without `SSPA_MCP_TOKEN` set, **any local process** can execute browser code ...

**实际行为与证据**：

1. 启动时未指定 host：`spawriter/src/relay.ts:2175`
   ```ts
   server.listen(port, () => { ... });   // 无 host 参数 → Node 绑定 :: (双栈, 所有网卡)
   ```
2. `netstat` 实测（运行中的 relay，PID 27308）：
   ```
   TCP    0.0.0.0:19989     0.0.0.0:0    LISTENING
   TCP    [::]:19989        [::]:0       LISTENING
   ```
   即监听所有网卡，而非仅回环。
3. HTTP 请求处理器（`relay.ts:1969-1995`）直接把请求交给 `app.fetch(request)`，**全程没有** `isLocalhost(req.socket.remoteAddress)` 校验。localhost 校验只存在于 WebSocket 升级路径 `wss.on('connection')`（`relay.ts:2000-2007`）：
   ```ts
   const remoteAddr = req.socket?.remoteAddress || '';
   if (!isLocalhost(remoteAddr)) { ws.close(1008, ...); return; }   // 仅 WS 有
   ```
4. HTTP 实测：非浏览器客户端（无 `sec-fetch-site` 头）访问控制 API 直接 200：
   ```
   GET http://127.0.0.1:19989/cli/sessions  → 200  {"sessions":[]}
   ```

**影响**：默认未设 `SSPA_MCP_TOKEN` 时，**同一网段任意主机**只要能连到 19989，即可 `POST /cli/session/new` 建会话、`/connect-tab` 连接/新建标签页、`/cli/execute` 在用户**已登录的浏览器**里执行任意 Playwright/JS。文档"仅 127.0.0.1"给用户造成安全错觉。

**修复**：
- 默认绑定回环：`server.listen(port, '127.0.0.1', ...)`；仅当用户显式 `--host` 且已设 token 时才绑定公网地址（`cli.ts:212-213` 已声明"--token required for public host"，但未强制执行，应补上强制校验）。
- 纵深防御：在 HTTP 处理器入口镜像 WS 的 `isLocalhost(req.socket.remoteAddress)` 校验，非回环直接 403。

---

## S2 · 高 · 鉴权中间件覆盖不全，`/shutdown` 等可被未授权远程调用

**证据**：鉴权/CSRF/Content-Type 中间件只挂在 `/cli/*`（`relay.ts:1732`）：
```ts
app.use('/cli/*', async (c, next) => { /* sec-fetch-site + content-type + Bearer token */ });
```
而以下**改变状态**的路由都在该前缀之外，因此**即便设置了 `SSPA_MCP_TOKEN` 也不校验 token、不校验来源、不校验 localhost**：
- `app.post('/shutdown')`（`relay.ts:608`）→ `process.exit(0)`：未授权远程 DoS。
- `app.post('/connect-tab')`（`relay.ts:481`）→ 附加 debugger / 新建标签页。
- `app.post('/trace')`（`relay.ts:567`）。
- `app.get('/json/list')`（`relay.ts:623`）、`/version`、`/json/version`：信息泄露（枚举标签页 URL）。

叠加 S1 的全网卡绑定，这些端点可从网络被直接触达。

**修复**：把同一套"localhost + token + Content-Type"守卫提升为全局中间件（仅放行 `GET /` 健康检查），或至少显式为 `/shutdown`、`/connect-tab`、`/trace` 加上 localhost + token 守卫。`/shutdown` 建议额外要求 token 或仅回环。

---

## S3 · 中 · `/cli/*` 的 CSRF 防护可被非浏览器客户端绕过

**证据**（`relay.ts:1733-1736`）：
```ts
const secFetchSite = c.req.header('sec-fetch-site');
if (secFetchSite && secFetchSite !== 'none' && secFetchSite !== 'same-origin') {
  return c.json({ error: 'Cross-origin requests not allowed' }, 403);
}
```
头**缺失**时 `secFetchSite` 为假值，条件不成立 → 放行。实测：
- 无 `sec-fetch-site`（curl/脚本）→ 200（放行）
- `sec-fetch-site: cross-site`（模拟浏览器跨站）→ 403（拦截）

该守卫只能挡住"恶意网页在真实浏览器里发起的跨站 fetch/DNS-rebinding"，挡不住直接的非浏览器远程客户端。

**修复**：本项防护本身合理（防 DNS-rebinding），但**必须与 S1 的回环绑定配合**才完整：绑定 127.0.0.1 后，非浏览器远程客户端根本无法触达，本头校验则恰好覆盖残余的浏览器 rebinding 向量。建议默认即要求 token。

---

## B1 · 高（功能/数据） · 客户端 `cwd` 被服务端丢弃，导致合法文件写入被 ScopedFS 拦截

**现象日志**（`relay.log`，4 次，跨 6/12–7/02）：
```
Error in playwright execute: Error: EPERM: operation not permitted,
  access outside allowed directories: D:/dev/xcai/.tmp-litlist.png
  ... D:\dev\journal\mf-journal-manage\.tmp-submitcfg.png
  ... D:/dev/side/feedback-loop/tmp-verify-menu.png
  ... D:/dev/core/video-ranking/frontend/immersive_feed.js
```
用户在各自项目目录运行 CLI 并让代码写临时文件/截图，却被拒。

**根因链（客户端传了 cwd，服务端三处全丢）**：
1. 客户端**确实发送** cwd：`control-client.ts:35`（`/cli/execute` body 含 `cwd`）、`:42`（`/cli/session/new` body 含 `cwd`）；`cli.ts:246` `createSession({ cwd: process.cwd() })`。
2. 但 `/cli/execute` 只解析 `{ sessionId, code, timeout }`，**未读 `cwd`**：`relay.ts:1755`。
3. `/cli/session/new` 忽略 `body.cwd`：`relay.ts:1862-1864`。
4. `ExecutorManager.getOrCreate(sessionId)` **没有 cwd 形参**，恒以无 cwd 构造：`pw-executor.ts:2556` `new PlaywrightExecutor(this.logger)`。
5. 于是 `PlaywrightExecutor` 构造里 `sessionCwd = null`（`pw-executor.ts:353`），ScopedFS 允许目录退化为 `[relay进程cwd, /tmp, os.tmpdir()]`（`pw-executor.ts:354-357`、`runtime/scoped-fs.ts:11-13`）。relay 是**分离进程**，其 cwd 取决于当初被 spawn 的位置，与用户项目目录无关 → 用户目录写入必被 `EPERM`。

> 补充：`cli.ts` 的 `executeCode` 内联 fetch（`cli.ts:123`）也只发 `{ sessionId, code, timeout }`，同样漏传 cwd，需一并修。

**修复**：把 cwd 贯通到执行器——
- `ExecutorManager.getOrCreate(sessionId, cwd?)`：首次创建时用 `cwd` 构造；已存在则按需刷新 ScopedFS 允许目录。
- `/cli/execute` 解析并透传 `body.cwd`；`cli.ts:123` 补发 `cwd: process.cwd()`。
- 可选：允许目录并入"会话创建时的 cwd"以兼容跨目录调用。

---

## R1 · 中 · EADDRINUSE 仍以 uncaughtException 崩溃（专门 handler 未生效）

**证据**：已有 EADDRINUSE 优雅处理（`relay.ts:2166-2173`，`err.code==='EADDRINUSE'` → `process.exit(0)`），但日志出现（2 次，最近 2026-07-03T01:34:19）：
```
Uncaught exception in relay (uncaughtException), exiting:
  Error: listen EADDRINUSE: address already in use :::19989
```
即走了 `uncaughtException` 分支（`relay.ts:169-174`）而非 `server.on('error')`。

**复现**（最小脚本，Windows/Node）：
- 纯 `http.createServer` + `server.on('error')` 抢占同端口：后启者命中 `server.on('error')`，优雅 exit 0。
- 一旦按 relay 的顺序先 `new WebSocketServer({ server })`（`relay.ts:1997`）再 `server.listen`：后启者的 EADDRINUSE **变成 uncaughtException**（复现输出 `child-B UNCAUGHT (uncaughtException): listen EADDRINUSE`）。`ws` 绑定 server 后的错误传播使进程级 handler 先触发，而 `handleRecoverableProcessError` 未把 EADDRINUSE 视为可恢复 → exit 1。

**影响**：`ensureRelay` 自启 + `relay --replace` + MCP 自启存在双启动竞态，日志出现吓人的"崩溃/未捕获异常"，实则另一实例已在运行、无害，但误导排查。

**修复**：在 `handleRecoverableProcessError`（`relay.ts` 进程级 handler）中将 `code==='EADDRINUSE'` 归类为可恢复（打印"another instance running"并 `exit(0)`）。或改为"先 `listen` 且挂好 error handler，成功后再构造 `WebSocketServer`"，并在 listen 前先探测端口。

---

## R2 · 中低 · stderr 写入 EPIPE 使 relay 崩溃

**证据**：日志 7 次
```
Uncaught exception in relay (uncaughtException), exiting: Error: EPIPE: broken pipe, write
```
日志实现向 `process.stderr` 同步写（`utils.ts` 的 `log`/`error`）。当 spawn 该 relay 的父进程（如 MCP/CLI）退出、继承的 stderr 管道关闭后，下一次日志写入抛 `EPIPE` → uncaughtException → exit 1。属"因记日志这一副作用而崩溃"，非受控关闭。

**修复**：给 `process.stdout/stderr` 挂 `.on('error', () => {})` 吞掉 EPIPE；或在写日志处 try/catch 忽略 EPIPE；或把 EPIPE 归类为可恢复。（relay 通常以 `stdio:'ignore'` 分离启动，但 `serve` 路径并非总是如此。）

---

## R3 · 低 · 标签页生命周期竞态错误（可观测、行为正确）

**证据**：日志 `No page found for owned tab ... after 3000ms`（39 次）、`CDP connection timeout (15s)`（22 次）。这些错误被正确抛回调用方，属预期失败反馈；但频次说明"claim 到解析 page 之间标签页被关闭"的竞态较常见。

**建议（可选）**：对该窗口加一次短重试/退避，或把错误文案改得更可操作（提示标签页可能已关闭）。

---

## 日志噪声（N1–N3）

**N1** · `relay.ts:1368-1374`：单一全局 `nextExtensionRequestId` + 断连即清空 pending，扩展的迟到响应落在清空之后。`recentlyDeletedRequests` 已能区分并打印 `Late response`（含原因，162 次），但兜底的 `Received response for unknown request id`（465 次）仍以 ERROR 刷屏。→ **降级为 debug/warn**，断连场景属预期。

**N2** · `relay.ts:1406`：`OWNERSHIP BLOCKED` 对每个被拦事件都打印且无去重，target 广播扇出到"绑定到其它会话的 pw- 客户端"时毫秒级批量重复（204 次）。→ **按 (clientId,tabId) 短窗口去重**，或降为 debug。

**N3** · `relay.ts:1965-1967`：`No SSPA_EXTENSION_IDS configured` 用 `error()` 打印（ERROR 级），且日志显示每次启动重复 2 次。这是**配置提示**而非错误。→ 改 `log()`/warn 且单次。

---

## T1 · 中 · 崩溃修复测试从未被执行，且 `vitest` 未声明

**证据**：
- 根 `test` → `npm run -w spawriter test`（`package.json:25`）→ `spawriter/package.json:17` 的 `tsx --test` **手工列举**，只含 `src/*.test.ts`，**不含** `tests/relay-crash-fixes.test.ts`。
- 该文件用 `vitest`（`import { describe, it, expect, vi } from 'vitest'`），且验证的是关键崩溃修复（dialog race 恢复 `isRecoverablePlaywrightDialogRace`、navigate 超时计算）。
- `vitest` **未在任何 package.json 声明**（对全部 `**/package.json` 搜索 `vitest` 无命中），但存在于 lockfile（`node_modules/vitest` 4.1.7，`node_modules/.bin/vitest.cmd` 存在）——属**未声明/游离依赖**。
- `spawriter/vitest.config.ts`（`include: ['tests/**/*.test.ts']`）**无任何脚本调用**。

**影响**：这些崩溃回归用例在 CI/`npm test` 中**根本不跑**，会静默腐烂；且 `npm install` 依 package.json 收敛时可能把 vitest 剪除，直接导致其无法运行。

**修复（二选一，推荐 a）**：
- (a) 把这些用例改写为 `node:test`（与其余测试同一 runner），并加入 `tsx --test` 清单；删除游离的 `vitest`/`vitest.config.ts`。
- (b) 在 `spawriter` devDependencies 声明 `vitest`，并让 `test` 同时跑 `tsx --test` 与 `vitest run`。

---

## T2 · 低 · 测试脚本用手写清单，易漏测

**证据**：`spawriter/package.json:17` 逐个列出 11 个测试文件。新增 `src/**/*.test.ts` 若忘记改脚本，会被静默排除。

**修复**：改用 glob 或目录发现，如 `tsx --test "src/**/*.test.ts"`（或 Node `--test` 目录自动发现），使新测试自动纳入。

> 正面结论：现有覆盖充实（1642 用例 / 325 套件全绿），`ExecutorManager`（上限、驱逐、重置、独立性）、ownership、clear-policy、ax-tree、labeled-screenshot、network-monitor 等均有较细的单测。

---

## M1 · 中 · 单文件体量远超项目自定规范

**证据**（项目规则要求"单文件 <400 行，超出即拆分"）：
```
2210 行  spawriter/src/relay.ts
2592 行  spawriter/src/pw-executor.ts
 678 行  spawriter/src/mcp.ts
10264 行  spawriter/src/mcp.test.ts   (397KB，含大量内联数据)
1169 行  extension/src/ai_bridge/bridge.js
```
`relay.ts` 单文件混合了：HTTP 路由、WS 管理、tab ownership、虚拟 CDP session 复用、Playwright 断言恢复、执行器管理、进程级错误处理——**单一职责被破坏**。

**修复**：按职责拆分，例如 `relay/routes.ts`、`relay/ownership.ts`、`relay/cdp-session-mux.ts`、`relay/process-recovery.ts`、`relay/server.ts`；`pw-executor.ts` 将 `buildVmGlobals` 的各类全局（screenshot/network/storage/emulation/dbg/editor）拆到 `runtime/globals/*`。`mcp.test.ts` 的大数据 fixture 外置为独立数据文件。

---

## 架构层面观察（设计建议）

1. **请求-ID 与 pending 注册表设计脆弱**：单一全局 `nextExtensionRequestId`（`relay.ts:75`）跨"CDP 转发/扩展命令/下载行为"复用，又拆成 `pendingRequests` 与 `pendingExtensionCmdRequests` 两张表、三种响应形状（`relay.ts:531/574/646/1692/2138` 处各自 new 一个 mockWs）。这是 N1"unknown request id"整类噪声的结构性根源。建议：按用途分命名空间的 id，或用一个"可辨识联合"的统一 pending 注册表 + 统一超时/清理路径。
2. **双端 clear-policy 重复实现**：`spawriter/src/cdp-clear-policy.ts` 与 `extension/src/ai_bridge/clear-policy.js` 逻辑镜像。冗余带来漂移风险（已有 `GLOBAL_CLEAR_CDP_METHODS` 两处各写一遍）。建议抽取单一真源（如生成或共享常量）。这是正确的纵深防御，保留双端**执行**，但**策略数据**应单一来源。
3. **安全默认值**：当前"默认全网卡 + 默认无 token + 控制面可执行任意代码"三者叠加，属"默认不安全"。建议默认回环 + 默认必需 token（首次启动自动生成并写入用户配置），把开放公网设为需显式 opt-in。

---

## 附：已核验为"无问题/设计得当"的点（避免误报）

- `ScopedFS` 路径前缀判断（`runtime/scoped-fs.ts:16-17`）用 `resolved === dir || startsWith(dir + sep)`，正确避免了 `/tmpfoo` 绕过 `/tmp` 的前缀陷阱。
- `cdp-clear-policy.ts`：全局清除方法（`Network.clearBrowserCookies/Cache`、`Storage.clearCookies`）恒被拒，`Storage.clearDataForOrigin` 强制精确 origin 作用域——符合"不做浏览器级数据清除"的安全目标。
- WS 升级路径对 `remoteAddress` 与扩展 origin 双重校验（`relay.ts:2003/2012`）。
- `ExecutorManager` 有会话上限（relay 侧 `maxSessions:10`，`relay.ts:1724`）与 stale 会话清扫（`startStaleSweep`，`relay.ts:457-471`，`.unref()` 不阻塞退出），设计合理。
- MV3 service worker 短命问题用 offscreen 常驻 WS 连接解决（`extension/src/offscreen.js`），方向正确。

---

## 建议修复优先级

1. **P0**：S1（回环绑定 + HTTP localhost 校验）、S2（鉴权覆盖全路由）、B1（贯通 cwd）。
2. **P1**：R1（EADDRINUSE 归类可恢复）、R2（EPIPE 吞掉）、T1（崩溃测试纳入 runner）。
3. **P2**：S3（配合 S1 收口）、N1/N2/N3（日志降噪去重）、T2（glob 发现测试）。
4. **P3**：M1（大文件拆分）、架构建议（统一 pending 注册表、clear-policy 单一真源、安全默认值）。

---

## 已修复（本次改动 + 验证）

以下问题已修复，`npm test` 全绿（**1674 通过 / 335 套件 / 0 失败**，较修复前新增 32 用例），并对 relay 行为做了真实进程级 E2E。

### 代码改动
- **S1/S2/S3**（`relay.ts`、`utils.ts`、`cli.ts`）
  - `startRelayServer({host})` 默认绑定 `127.0.0.1`；公网 host 无 `SSPA_MCP_TOKEN` 时**拒绝启动**（exit 1）。
  - HTTP 处理器新增非回环访问的 token 门禁（健康检查 `GET /` 除外）。
  - 新增**全局** `sec-fetch-site` CSRF 中间件（覆盖 `/shutdown`、`/connect-tab`、`/version` 等所有路由），`/cli/*` 中间件去重后仅保留 content-type + token。
  - CLI `relay` 透传 `--host`/`--token`；新增 `isLoopbackHost()`。
  - 附带修复：MCP→relay 所有 `/cli/*`/`/connect-tab` 调用统一带上 `Authorization`（`relayHeaders()`），此前设 token 会让 MCP 执行 401。
- **B1**（`pw-executor.ts`、`runtime/scoped-fs.ts`、`relay.ts`、`mcp.ts`、`cli.ts`）
  - `ScopedFS.configure()` 支持原地重定作用域（保持 sandboxed require 捕获的引用有效）。
  - `PlaywrightExecutor.updateCwd()` + `ExecutorManager.getOrCreate(sessionId, cwd)`；`/cli/execute`、`/cli/session/new` 读取 `body.cwd`；MCP/CLI 两个执行入口发送 `process.cwd()`。
- **R1/R2/R3**（`relay.ts`、`utils.ts`）
  - `isPortInUseError()` + 进程级处理器把 `EADDRINUSE` 归类为可恢复（优雅 exit 0）。
  - `writeLine` 吞掉 stderr EPIPE；进程级 `stdout/stderr` 挂 `error` 处理器。
  - idle/ping 定时器 `.unref()`（监听 socket 才是存活来源）。
- **N1/N2/N3**（`relay.ts`）
  - late/unknown response 降级为 `log()`；`OWNERSHIP BLOCKED` 按 `(client,tab)` 1s 窗口去重；`No SSPA_EXTENSION_IDS` 降为 `log()`。
- **T1/T2**（`package.json`、测试文件）
  - `test` 脚本改为 glob：`tsx --test "src/**/*.test.ts"`（新增测试自动纳入）。
  - 游离的 `tests/relay-crash-fixes.test.ts`（vitest）改写为 `node:test` 迁至 `src/`，删除 `vitest.config.ts`；不再依赖未声明的 vitest。
- **文档**：`README.md` 安全模型更新为实际行为；`cli.ts` `--host` 帮助文案纠正为默认 127.0.0.1。

### 新增测试
- `src/relay.integration.test.ts`：真实启动 relay（回环临时端口），验证健康检查、CSRF 403、无 token 放行、content-type 400、无扩展时的 “No tab connected”、以及 token 401/200 门禁。
- `src/runtime/scoped-fs.test.ts`：作用域写入/越界 EPERM/共享前缀防绕过/`configure()` 重定作用域。
- `src/relay-crash-fixes.test.ts`：迁移自 vitest，新增 `isPortInUseError` 覆盖。
- `src/utils.test.ts`：新增 `isLoopbackHost`。
- `src/pw-executor.test.ts`：新增 ExecutorManager cwd 贯通用例。

### E2E 验证（真实构建产物）
- `netstat`：`node dist/cli.js relay --port 19993` → 仅 `127.0.0.1:19993` LISTENING（不再有 `0.0.0.0`/`::`）。
- `--host 0.0.0.0` 无 token → 拒绝启动，exit 1。
- token 模式：`/cli/sessions` 无鉴权 401、带 `Bearer` 200。
- 端口竞态：第二个同端口 relay → 打印“another relay instance is running”并 **exit 0**（此前为 uncaughtException/exit 1）。

### 未执行（附理由）
- **M1（大文件拆分）**：`relay.ts`(2210)/`pw-executor.ts`(2592) 的拆分是大范围重构，回归风险高，且与本次“最小改动、稳态修复”目标冲突。建议单独排期，按报告中“架构层面观察”的边界拆分后再跑全量回归。保留为建议，未在本次改动。
- **clear-policy 单一真源**：服务端（TS/Node）与扩展端（JS/浏览器）跨运行时，无法直接共享模块；当前双端**执行**属正确的纵深防御，仅“策略常量”存在漂移风险，改造收益有限、成本较高，暂缓。
