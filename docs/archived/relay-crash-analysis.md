# Spawriter Relay Crash Analysis

> **Status: Implemented**（2026-06-12 验证）。本文建议的进程级保护已落地：`relay.ts` 与 `mcp.ts` 均注册了 `unhandledRejection`/`uncaughtException` 处理器，`pw-executor.ts` 含 dialog（`beforeunload`）处理。本文档仅作历史记录。

## 1. 审计结论

本次崩溃最可信的直接原因是 Playwright 在处理 `beforeunload` / JavaScript dialog 时触发了未处理的异步 rejection：

```text
ProtocolError: Protocol error (Page.handleJavaScriptDialog):
  {"code":-32602,"message":"No dialog is showing"}
    at CRSession.send (playwright-core/lib/server/chromium/crConnection.js:111:57)
    at Dialog._onHandle (playwright-core/lib/server/chromium/crPage.js:669:28)
    at Dialog.accept (playwright-core/lib/server/dialog.js:53:16)
    at Dialog.close (playwright-core/lib/server/dialog.js:63:18)
    at DialogManager.dialogDidOpen (playwright-core/lib/server/dialog.js:85:14)
    at FrameSession._onDialog (playwright-core/lib/server/chromium/crPage.js:662:45)
```

结合源码，relay 独立进程当前没有 `process.on('unhandledRejection')` / `process.on('uncaughtException')` 保护；Node v25.9.0 在默认 `--unhandled-rejections=throw` 行为下会把未处理 rejection 作为未捕获异常抛出，进而终止进程。因此日志中的 3 次相同栈崩溃与源码结构一致。

需要修正的重点不是“所有 reload 都会崩”，而是：**没有显式 dialog 订阅时，Playwright 服务端会自动关闭 dialog；如果页面导航/reload 过程中 dialog 已消失，`Page.handleJavaScriptDialog` 返回 `No dialog is showing`，该自动关闭 promise 没有 `.catch()`，从而成为未处理 rejection。**

## 2. 证据边界

本仓库内未找到独立原始日志文件；可审计的日志证据来自本文原有转录内容。源码审计基于当前工作区：

- `spawriter/src/relay.ts`
- `spawriter/src/pw-executor.ts`
- `spawriter/src/mcp.ts`
- `spawriter/src/cli.ts`
- `node_modules/playwright-core` 当前安装版本：`1.59.1`
- 当前 Node：`v25.9.0`

原文提到的 3 次崩溃时间线可保留为现象记录，但因为没有原始日志文件，不能进一步校验每次崩溃前后的完整请求序列。

## 3. 根因链路

1. 用户代码或 helper 触发页面 reload / 导航，例如 `location.reload()`、`clearCacheAndReload()`、`ensureFreshRender()`。
2. 页面卸载过程中出现 JavaScript dialog 事件，常见来源是 `beforeunload`。
3. Playwright 服务端收到 `Page.javascriptDialogOpening`，进入 `crPage.js` 的 `_onDialog()`。
4. `DialogManager.dialogDidOpen()` 在没有 dialog handler 时调用 `dialog.close().then(() => {})`。
5. 对 `beforeunload`，`dialog.close()` 会走 `accept()`，最终发送 `Page.handleJavaScriptDialog`。
6. Chrome / extension 通道返回 `{"code":-32602,"message":"No dialog is showing"}`。
7. `dialog.close().then(() => {})` 没有 rejection handler，错误成为未处理 rejection。
8. relay 进程没有全局 rejection/exception handler，Node 终止进程，后续 CLI 只看到 `fetch failed` / `Cannot connect to relay`。

关键 Playwright 代码证据：

```js
// node_modules/playwright-core/lib/server/dialog.js
if (!hasHandlers)
  dialog.close().then(() => {
  });
```

```js
// node_modules/playwright-core/lib/server/chromium/crPage.js
await this._client.send("Page.handleJavaScriptDialog", { accept, promptText });
```

这说明原文“Playwright 内部 auto-dismiss/auto-close 触发未处理错误”的方向是成立的，但“CDP 消息路由紊乱导致 target 销毁重建”只能作为相关现象，不应写成确定根因。

## 4. 源码审计

### 4.1 `relay.ts`：请求级 try/catch 覆盖不到进程级异步错误

`/cli/execute` 会捕获 `executor.execute()` 直接抛出的错误：

```ts
const result = await executor.execute(body.code, body.timeout || 10000);
```

但本次错误发生在 Playwright 内部 dialog event handler 的异步 promise 上，不在 `/cli/execute` 的 await 调用栈内。

`startRelayServer()` 当前有：

- `server.on('error')`，已处理 `EADDRINUSE`
- 5 分钟 idle shutdown
- extension / CDP WebSocket 的 close/error 清理

但没有：

- `process.on('unhandledRejection')`
- `process.on('uncaughtException')`
- 针对已知 Playwright dialog race 的分类恢复逻辑

因此原文关于“relay 模式不走 `mcp.ts` 的全局保护”的判断成立。

### 4.2 `mcp.ts`：已有保护不覆盖独立 relay 进程

`mcp.ts` 的 `main()` 中已有：

```ts
process.on('uncaughtException', (err) => {
  error('Uncaught exception (recovered):', err.message);
});

process.on('unhandledRejection', (reason) => {
  error('Unhandled rejection (recovered):', String(reason));
});
```

但 relay 是独立进程：CLI `relay` 命令直接启动 `startRelayServer()`，MCP 也会 spawn `relay.js`。所以 MCP 进程的 handler 不能保护 relay 进程。

### 4.3 `pw-executor.ts`：reload 路径确实存在

`pw-executor.ts` 中多个 helper 会触发 reload：

- `clearCacheAndReload()`：`Page.reload` 或 `window.location.reload()`
- `singleSpa.override()` 设置 override 后：`Page.reload` 或 `window.location.reload()`
- `ensureFreshRender()`：`Page.reload` 或 `window.location.reload()`

`ensureConnection()` / `setupPageListeners()` 当前监听了 `close`、`popup`、`console`、`request`、`response`、`requestfailed`，但没有 `dialog` listener。这会使 Playwright 落入“无 handler 时服务端自动关闭 dialog”的路径。

### 4.4 `Received response for unknown request id` 的含义需要降级

原文把该日志解释为“CDP 消息路由紊乱，target 可能已销毁又重建”。这个解释可能成立，但源码上更准确的说法是：

```ts
const pending = pendingRequests.get(response.id);
if (!pending) {
  error(`Received response for unknown request id: ${response.id}`);
  return;
}
```

也就是说，relay 收到了 extension response，但对应 relay request id 已不在 `pendingRequests`。常见原因包括：

- 请求已经超时并被删除
- CDP client 断开时 pending 被清理
- extension 返回了重复/迟到 response
- target detach / reload 期间请求与响应跨越了清理窗口

它是 reload 期间通道压力或时序竞争的前置信号，但不是证明 target 销毁重建的充分证据。

## 5. 影响范围

| 场景 | 风险 | 说明 |
|---|---:|---|
| `location.reload()` via `page.evaluate` | 高 | 页面卸载可触发 `beforeunload` dialog |
| `ensureFreshRender()` | 高 | 当前实现明确调用 `Page.reload` / `window.location.reload()` |
| `clearCacheAndReload()` | 高 | 清缓存后可能调用 reload |
| `singleSpa.override()` 设置后自动刷新 | 中高 | override 成功后会 reload 验证 |
| `navigate(url)` | 中 | 当前主要走 `Page.navigate`，通常不是 reload，但目标页/当前页仍可能触发 `beforeunload` |
| 普通 `page.evaluate()` 且不导航 | 低 | 不涉及页面卸载或 dialog 生命周期 |

## 6. 新增现象：timeout / navigate hang / relay restart 的审计

另一个 agent 记录到：

- `--timeout 60000` 下仍报 `Code execution timed out after 60000ms`
- 推断 `navigate + 12000ms wait + page.evaluate` 理论上只应约 29s
- 看到 `Starting relay server on port 19989...` 后推断“每个 CLI 进程都会检查/重启 relay”
- 简单 `page.evaluate(() => document.title)` 成功，但复杂 DOM 扫描 evaluate 超时
- 后续出现 `CDP connection timeout (15s)`

这些现象与本次 relay 崩溃问题相关，但不应混为同一根因。

### 6.1 `--timeout` 是外层总预算

`PlaywrightExecutor.execute()` 对整段用户代码设置总预算：

```ts
const result = await Promise.race([
  vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
  new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new CodeExecutionTimeoutError(timeout)), timeout);
  }),
  new Promise((_, reject) => {
    abortController.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(timeout)));
  }),
]);
```

因此 `Code execution timed out after 60000ms` 只表示整段脚本没有在 60s 内 settle，并不能推出 `navigate()` 只用了 15s。

### 6.2 `navigate()` 可能吃掉接近整个 timeout

当前 `navigate()` 使用剩余执行时间计算 CDP command timeout：

```ts
const cdpTimeout = computeNavigateCommandTimeout(remainingExecutionMs);
await sendCdpCmd('Page.navigate', { url }, cdpTimeout);
```

`computeNavigateCommandTimeout()` 的上限是 `Page.navigate` 的 60000ms，并只扣 250ms safety buffer。也就是说，在 `--timeout 60000` 的场景里，`Page.navigate` 本身最多可以等待约 59.75s。此时后续 `await sleep(12000)` 或复杂 `page.evaluate()` 没有实际剩余预算。

这解释了“理论上应约 29s，实际外层 60s 超时”的矛盾：理论估算假设 `Page.navigate` 很快返回，但源码允许它占满几乎全部外层预算。

### 6.3 CLI 不会在健康 relay 上主动重启

`spawriter -e` 在没有显式 `--host` / `SSPA_RELAY_HOST` 时会先调用 `ensureRelayServer()`：

```ts
const isRunning = await checkRelayRunning(port);
if (isRunning) return false;

logger.log(`Starting relay server on port ${port}...`);
```

`checkRelayRunning()` 只是请求 `GET /version`。只有该探测失败时才会 spawn relay。也就是说，“每个 CLI 进程都会导致 relay 重启”这个判断不成立；更准确的解释是：

- relay 已经崩溃或退出
- relay event loop / HTTP server 当时无法在 1s 内响应 `/version`
- 端口上进程不健康，导致探测失败
- relay idle shutdown 后被下一次 CLI 拉起

CLI 本身并不会在健康 relay 上执行 `--replace`。另外，“直接用 relay HTTP API”也不能绕开核心问题，因为 `spawriter -e` 本来就是对 `/cli/execute` 发 HTTP POST。

### 6.4 简单 evaluate 成功、复杂 evaluate 超时的解释

简单表达式如 `document.title` 成功，只能证明当时 Runtime.evaluate 的最小链路可用。复杂 DOM 扫描可能失败的原因包括：

- 页面主线程繁忙，Runtime.evaluate 被延迟执行
- evaluate 函数自身遍历范围过大
- 返回值过大，`returnByValue` 序列化成本高
- 页面持续变更导致脚本等待 promise 或异步逻辑不结束
- 前一次 timeout 后 Playwright / CDP session 已处于不稳定状态

后续出现 `CDP connection timeout (15s)` 来自 `ensureConnection()` 中的 `chromium.connectOverCDP()` 超时。它更像是 relay/CDP 通道已经不健康，或 extension/Chrome 无法及时完成 Playwright 的 CDP 握手；不能简单归因于“视频页太重”。

### 6.5 该现象暴露的额外问题

1. `navigate()` 的 command timeout 与外层 execution timeout 过于贴近，容易让后续步骤没有预算。
2. timeout 后只做一次 `page.evaluate('1')` 响应性探测；如果探测失败，只清 `page` / `cachedCdpSession`，不一定能恢复 relay/CDP 映射。
3. `ensureRelayServer()` 的 1s `/version` 探测较短，relay 短暂卡顿时可能误判为未运行。
4. CLI 连接失败时不会在“请求尚未进入服务端”的安全场景自动重试一次。

这些应作为 P1/P2 稳定性问题处理，优先级低于 P0 dialog race，但会放大 crash 后的恢复成本。

## 7. 根因定位（最终）

本次问题不是单一 bug，而是两个主根因和两个放大因素叠加后形成的故障链。

### 根因 A：relay 缺少进程级保护，Playwright dialog race 可直接杀进程

日志中的 `Page.handleJavaScriptDialog` / `No dialog is showing` 是明确的进程崩溃触发点。Playwright 服务端在没有 dialog listener 时会自动关闭 dialog，但该 promise 没有 rejection handler；relay 独立进程又没有 `unhandledRejection` / `uncaughtException` handler，于是单个 Playwright 内部异步错误会终止整个 relay。

这是“为什么 relay 会重启 / session 和 tab 绑定丢失”的直接根因。

### 根因 B：执行超时是软超时，底层 CDP / Playwright 操作没有被取消

`execute()` 的 timeout 只包住外层 `Promise.race()`：

```ts
const result = await Promise.race([
  vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
  new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new CodeExecutionTimeoutError(timeout)), timeout);
  }),
]);
```

当外层 timeout 触发时，已经发出的 `Page.navigate`、`Runtime.evaluate`、用户调用的 `page.evaluate()` 等底层操作仍可能继续在 Playwright / relay / extension / Chrome 中运行。`AbortController` 只用于让当前 `Promise.race()` 尽快 reject，没有传入 Playwright 或 CDP command，也没有取消 relay pending request。

这会导致：

- 下一次 CLI 命令进入时，上一次的 CDP command 可能仍在飞行。
- relay 后续收到迟到 response 时，pending map 可能已被清理，出现 `Received response for unknown request id`。
- Playwright 的 CDP session 可能处于半关闭或 stale 状态，下一次 `connectOverCDP()` 出现 `CDP connection timeout (15s)`。
- timeout 后的 `page.evaluate('1')` 响应性探测只能判断一个瞬时小命令是否成功，不能证明前一次复杂 evaluate / navigate 已被真正取消。

这是“为什么一个 timeout 后后续命令越来越不稳定”的主根因。

### 根因 C：`navigate()` 的预算策略允许单个导航吃满外层 timeout

`navigate()` 使用剩余外层预算计算 command timeout，而 `Page.navigate` 上限也是 60000ms：

```ts
const cdpTimeout = computeNavigateCommandTimeout(remainingExecutionMs);
await sendCdpCmd('Page.navigate', { url }, cdpTimeout);
```

在 `--timeout 60000` 下，`Page.navigate` 可获得约 59.75s。后续 `wait 12000ms` 和提取 evaluate 没有保留预算，因此“理论应 29s”这个估计不成立。

这是“为什么 navigate + wait + evaluate 看似短，仍然触发 60000ms 外层 timeout”的直接原因。

### 根因 D：CLI 的 `Starting relay server...` 是症状，不是健康 relay 被主动重启

CLI 每次执行前确实会探测 relay，但只有 `/version` 探测失败才会启动 relay。健康 relay 不会被每次 CLI 主动重启。因此看到 `Starting relay server on port 19989...` 说明 relay 当时已经：

- 退出或崩溃；
- 因 event loop / HTTP server 短暂不可响应而 1s health probe 失败；
- idle shutdown 后被下一次命令拉起；
- 或上一轮 timeout/crash 后进入不健康状态。

它不是根因，而是根因 A/B/C 之后的可见症状。

## 8. 修复方案

### P0：relay 增加进程级保护，但必须分类处理

不建议无条件吞掉所有 `uncaughtException`。更稳妥的做法是识别本次已知 benign race，继续运行；未知异常仍应记录后退出，避免隐藏真实数据结构损坏。

建议形态：

```ts
function isNoDialogShowingRace(reason: unknown): boolean {
  const text = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
    : String(reason);
  return text.includes('Page.handleJavaScriptDialog') &&
    text.includes('No dialog is showing');
}

process.on('unhandledRejection', (reason) => {
  if (isNoDialogShowingRace(reason)) {
    error('Recovered Playwright dialog race:', reason);
    return;
  }
  error('Unhandled rejection, exiting:', reason);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

process.on('uncaughtException', (err, origin) => {
  if (isNoDialogShowingRace(err)) {
    error(`Recovered Playwright dialog race (${origin}):`, err);
    return;
  }
  error(`Uncaught exception (${origin}), exiting:`, err);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
```

对本 case，`unhandledRejection` handler 已足够阻止 Node 把 rejection 升级成 uncaught exception；`uncaughtException` 是兜底。

### P0：在 executor 默认安装安全 dialog handler

在 `setupPageListeners(page)` 中为每个 page 安装一次 dialog handler，避免 Playwright 服务端走无 handler 自动关闭路径：

```ts
page.on('dialog', (dialog) => {
  const action = dialog.type() === 'beforeunload'
    ? dialog.accept()
    : dialog.dismiss();

  action.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('No dialog is showing')) {
      this.logger.error('Dialog handling failed:', msg);
    }
  });
});
```

注意事项：

- `beforeunload` 用 `accept()`，保持 reload / navigate 继续执行。
- 其他 dialog 默认 `dismiss()`，减少对页面状态的侵入。
- 这会让 spawriter 默认接管 dialog；如果未来需要让用户代码自行处理 dialog，应增加开关或检测已有 listener，避免双方重复处理同一个 dialog。

### P1：reload / navigate helper 做局部恢复

`ensureFreshRender()`、`clearCacheAndReload()`、`singleSpa.override()` 里的 reload 调用，以及 `navigate()`，建议统一走一个 helper：

- 捕获 `No dialog is showing` 并视为可恢复
- reload 后清理 `cachedCdpSession`
- 重新解析 active page / target
- 用短超时探测 `document.readyState`
- 为后续步骤预留预算，避免单个 `Page.navigate` 吃完整个 execution timeout

这样即使 dialog race 没有杀进程，也能降低后续 CDP session 指向旧 target 的概率，并减少“navigate 成功但外层脚本无剩余时间”的误诊。

### P1：把 execution timeout 从软超时改成可恢复的硬取消

当前外层 timeout 只返回错误，不取消底层 CDP/Playwright 操作。建议在 `CodeExecutionTimeoutError` 分支中将当前 Playwright 连接标记为 poisoned，并做强制恢复：

1. best-effort 发送 `Runtime.terminateExecution`（如果 CDP session 仍可用），终止正在页面 context 中执行的 JS。
2. 关闭当前 Playwright browser/CDP 连接，而不是只清 `page` / `cachedCdpSession`。
3. 清理 `browser`、`context`、`page`、`cachedCdpSession`、`isConnected`，下一次执行必须重新 `connectOverCDP()`。
4. relay 在 CDP client close 时立即清理该 client 的 `pendingRequests`，并记录删除原因。
5. 对 direct `relaySendCdp()` 的 `pendingExtensionCmdRequests` 也记录 timeout 删除原因，迟到 response 不再只打印 unknown id。

伪代码：

```ts
if (isTimeoutError) {
  await this.terminateRuntimeExecutionBestEffort().catch(() => {});
  await this.closeQuietly();
  this.clearConnectionState();
  return timeoutResultWithResetHint;
}
```

这会牺牲 timeout 后复用连接的机会，但能阻止上一轮长命令污染下一轮执行。

### P1：重做 `navigate()` 预算策略

`navigate()` 不应默认吃掉全部 execution timeout。建议：

- 默认为导航后的 wait/evaluate 预留至少 10-15s，或预留外层 timeout 的 20%。
- `Page.navigate` 默认 cap 降为 15000-30000ms。
- 支持 `navigate(url, { timeout })` 让调用者显式声明慢页面预算。
- 当剩余时间不足以同时覆盖导航和后续探测时，直接抛 `NavigationBudgetError`，不要启动注定挤爆预算的导航。

建议形态：

```ts
const POST_NAVIGATION_RESERVE_MS = Math.min(15000, Math.max(3000, timeout * 0.2));
const navigateBudget = Math.min(
  options?.timeout ?? 30000,
  executionDeadlineMs - Date.now() - POST_NAVIGATION_RESERVE_MS,
);
if (navigateBudget < 1000) throw new NavigationBudgetError(navigateBudget);
await sendCdpCmd('Page.navigate', { url }, navigateBudget);
```

### P1：为 relay pending request 增加可诊断生命周期

`pendingRequests` / `pendingExtensionCmdRequests` 应保存 command metadata：

- relay id
- client id
- original CDP id
- method
- session id
- createdAt
- deletedAt
- deleteReason：`completed` / `timeout` / `client-close` / `extension-close` / `execution-timeout`

再维护一个最近删除记录 LRU。迟到 response 到达时输出：

```text
Late response for relay id 803: method=Runtime.evaluate, deletedReason=timeout, age=92.4s
```

这能把“unknown request id”从泛泛报错变成可定位的时序证据。

### P1：timeout 后响应文案应明确要求 reset/reconnect

当前 timeout hint 是 “Use reset if the browser is in a bad state”。在软超时改硬恢复前，建议更明确：

```text
Execution timed out. The previous browser/CDP operation may still be running.
Run session reset before continuing, or split navigation/wait/extraction into separate commands.
```

硬恢复实现后，文案可改为：

```text
Execution timed out. The Playwright CDP connection was reset; retry with a larger timeout or split the operation.
```

### P2：CLI 侧只对连接失败做安全自愈

`spawriter -e` 在执行前已调用 `ensureRelayServer()`，但如果 relay 在 ensure 和 POST 之间崩溃，CLI 仍会直接报错退出。

可以对 `ECONNREFUSED` / relay 未监听这类“请求未进入服务端”的错误重启 relay 并重试一次。不要对执行中断后的 `fetch failed` 无条件重试，因为用户代码可能已经在页面上产生副作用，重复执行会放大风险。

### P2：调宽 relay health probe 并区分“启动”和“重启”

`ensureRelayServer()` 当前 `/version` 探测超时为 1000ms。建议：

- 将 health probe 超时调到 2000-3000ms，减少 relay 短暂忙碌时误判。
- 日志改为 `Relay not responding; starting relay...`，避免用户误读为 CLI 每次都在重启。
- 如果端口已被占用但 `/version` 不响应，应输出更明确的诊断，而不是只等待新 relay 启动。

### P2：复杂 evaluate 的使用建议

对视频/直播等重页面，不建议一次性 DOM 全量扫描并返回大对象。更稳的执行方式是：

- 先用小表达式确认 URL/title/关键容器存在
- 缩小 selector 范围
- 限制返回字段和数量
- 避免在 page context 中等待无界 promise
- 将 `navigate`、等待、提取拆成多次 CLI 调用，但只在 relay 健康稳定后执行

## 9. 时间线（来自原日志转录）

| 时间 (UTC) | 事件 |
|---|---|
| 06:18:33 | 第一次 relay 启动 (terminal 8326) |
| 06:28:20 | 第一次崩溃 (terminal 103555): `Page.handleJavaScriptDialog` / `No dialog is showing` |
| 06:28:37 | 第二次 relay 启动 (terminal 103555 被替换) |
| 07:10:32 | 第二次崩溃 (terminal 905355): 同一 ProtocolError |
| 07:10:58 | 第三次 relay 启动 (terminal 395516) |
| 07:12:13 | 正常关闭（被 `--replace` 替换） |
| 07:13:07 | 第三次崩溃 (terminal 968567): 同一 ProtocolError |

3 次崩溃栈一致，支持“同一 Playwright dialog race 重复触发”的结论。

## 10. 当前已存在的相关修复

以下原文中曾作为建议的项，在当前源码中已经存在，不应再作为未完成项陈述：

- `relay.ts` 已有 `server.on('error')`，`EADDRINUSE` 时优雅退出。
- `relay.ts` 已有 5 分钟 idle shutdown。
- `mcp.ts` 的 relay auto-start 已有 `relayStartPromise` 互斥。
- `mcp.ts` 已有 `uncaughtException` / `unhandledRejection` handler。

仍未覆盖的是：独立 relay 进程自身的进程级异常保护、executor 默认 dialog handler、reload helper 的局部恢复，以及 unknown request id 的可诊断性。

## 11. 建议验证

修复后建议至少覆盖这些用例：

1. 页面注册 `beforeunload`，执行 `ensureFreshRender()`，relay 不退出。
2. 页面注册 `beforeunload`，执行 `page.evaluate('location.reload()')`，relay 不退出。
3. extension 对 `Page.handleJavaScriptDialog` 返回 `No dialog is showing`，进程级 handler 只恢复该已知错误。
4. 人工抛出未知 `unhandledRejection`，relay 仍按预期退出。
5. `Received response for unknown request id` 日志包含 method/session/删除原因。
6. `navigate()` 在 `--timeout 60000` 下不会独占全部预算，后续 wait/evaluate 有明确剩余时间。
7. relay 健康时，连续多个 `spawriter -e` 不输出 `Starting relay server on port ...`。
8. relay `/version` 短暂慢响应时，CLI 不误判为需要启动新 relay。
9. 人工制造长时间 `Runtime.evaluate` 后触发 execution timeout，下一次简单 `page.evaluate('document.title')` 能在新 CDP 连接上恢复。
10. 迟到 CDP response 不再只打印 unknown id，而能显示原 method 和删除原因。

## 12. 最终判断

原文的核心方向正确：崩溃与 Playwright dialog auto-close 产生的未处理 `ProtocolError` 强相关，relay 缺少进程级兜底导致单个异步错误杀死整个 relay。

需要修正的是两点：

- `Received response for unknown request id` 只能证明 response 迟到或 pending 映射已清理，不能单独证明 CDP 路由紊乱或 target 销毁重建。
- 修复不应只靠“吞掉所有全局错误”；应同时加默认 dialog handler、已知错误分类恢复、reload 后连接状态修复和更可诊断的 pending request 日志。
- 另一个 agent 看到的 timeout / `Starting relay server` 现象不能证明 CLI 会主动重启健康 relay；它更可能说明 relay 已退出、不响应，或上一轮 timeout/crash 后 CDP 通道已经不健康。
- 最终修复需要同时处理两条主线：P0 阻止 dialog race 杀 relay；P1 让 execution timeout 真正切断/恢复底层 CDP 操作，避免上一轮长命令污染下一轮执行。
