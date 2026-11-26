# MCP `navigate` / `execute` 卡死 Chrome 根因定位与修复方案

- **日期**：2026-11-25
- **影响范围**：`extension/src/ai_bridge/bridge.js`、`extension/src/offscreen.js`、`spawriter/src/relay.ts`、`spawriter/src/cdp-log.ts`、`spawriter/src/pw-executor.ts`
- **现象**：通过 MCP 调用 `navigate` / `execute` 时，Chrome 浏览器无响应（卡死），同时伴随 `Page.navigate` 超时、`Runtime.callFunctionOn` 延迟 60–80 秒返回、`CDP connection timeout (15s)` 等错误。

---

## 一、核心结论

Chrome 在执行 MCP `navigate` / `execute` 时卡死，核心原因是 **页面加载期间的高频 CDP 事件风暴（尤其是携带巨型 V8 调用栈的 `Runtime.consoleAPICalled`）叠加扩展端无过滤、无裁剪、无批处理的逐条 `chrome.runtime.sendMessage` 洪泛，直接打满 Chrome 主进程（Browser Process）的 UI 线程与扩展 IPC 通道**。

在此基础上，以下三处放大器共同把单次抖动推演为数十秒级的雪崩：
1. 扩展端 `tabs.onUpdated` 与 5 秒轮询无防抖、无变更检测地全量刷新所有标签页图标并注入标题脚本，持续挤压 Chrome UI 线程。
2. Relay 端 `routeCdpEvent` 对同一 `pw-*` 客户端重复派发事件、虚拟会话 `vps-*` 泄漏，且 `cdp.jsonl` 在主线程同步序列化巨型对象并整文件读写轮转，阻塞 Relay 事件循环超过 6 秒。
3. `Page.navigate` 超时抛出的错误未被 `isExecutionTimeoutLikeError` 识别，漏走超时恢复；而 `CodeExecutionTimeoutError` 重连后又会触发 `DOMAINS_TO_RECYCLE`（先 `disable` 再 `enable`），引发二次事件重放。

---

## 二、现场日志实证（`%TEMP%\spawriter\relay.log` & `cdp.jsonl`）

### 2.1 卡死与雪崩时间线（2026-11-25 UTC）

| 时间（UTC） | 日志证据 | 现象解读 |
|---|---|---|
| `05:44:34.109` | `Error: "Page.navigate" timed out after 23.748s` | `Page.navigate` 在 `chrome.debugger` 通道上卡死，耗尽全部导航时间预算。 |
| `05:44:45.607` – `05:44:47.904` | `CDP WebSocket disconnected` → `Playwright browser disconnected` | 仅关闭本地回环连接就耗时 **3.75s + 2.30s**。 |
| `05:44:50.474` – `05:44:56.793` | `Connecting Playwright over CDP` → `CDP WebSocket connected` | 本机 `127.0.0.1:19989` WebSocket 握手耗时 **`6.32s`**，表明 Relay Node.js 事件循环严重阻塞。 |
| `05:45:08.403` | `Error: CDP connection timeout (15s)` | 新建 Playwright 连接在 15 秒内无法完成初始化。 |
| `05:45:36.420` – `05:45:44.398` | `Late response ... Runtime.callFunctionOn, age=79.8s / 65.5s / 62.6s` | 此前发往 Chrome 的 CDP 命令被积压 **60–80 秒** 才陆续返回。 |
| `05:47:48.647` | `Late response ... Runtime.terminateExecution, age=21.2s` | 超时恢复发出的终止执行命令本身也被阻塞了 **21.2 秒**。 |

### 2.2 CDP 事件风暴实测统计（`cdp.jsonl`）

对 `%TEMP%\spawriter\cdp.jsonl`（文件大小 **62 MB**，仅 **5,114 行**，刚经历过 10,000 行 → 5,000 行的轮转）的统计结果：

- **爆发窗口**：`2026-11-25T05:49:19.669Z` – `05:49:21.936Z`（**2.27 秒**）
- **事件总量**：仅 `Runtime.consoleAPICalled` 单类事件即产生 **2,497 条**（日志记录 `from-extension` + `to-playwright` 共 **4,994 行**）
- **每秒峰值**：
  - `05:49:19`：412 条（824 行）
  - `05:49:20`：**1,681 条/秒**（3,362 行）
  - `05:49:21`：404 条（808 行）
- **载荷构成**：单条 `Runtime.consoleAPICalled` 平均 **12,327 字节**，其中 `params.stackTrace` 占 **11,926 字节（96.7%）**；2.27 秒内向扩展 IPC 灌入约 **30.8 MB** 原始 JSON（来源为开发态 SPA 页面 `http://localhost:9960/app.js` 连续输出的 `[intlify] Fall back to translate ...` / `Not found ... key` 警告）。

---

## 三、根因定位（精确到文件与行号）

### 根因 1（主因）：扩展端 `chrome.debugger.onEvent` 无过滤、无裁剪、逐条走 `chrome.runtime.sendMessage` 打满 Chrome UI 线程

- **涉及文件**：
  - `extension/src/ai_bridge/bridge.js:304-314`（`chrome.debugger.onEvent` 监听）
  - `extension/src/ai_bridge/bridge.js:409-417`（`sendMessage`）
  - `extension/src/ai_bridge/bridge.js:735-739`（`attachTab` 预开启 `Page`/`Runtime`/`Network`）
  - `extension/src/offscreen.js:128-135`（`ws-send` 接收与应答）
- **关键代码**：
  ```js
  // extension/src/ai_bridge/bridge.js:304-314
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId;
    if (typeof tabId !== "number") return;
    const tabInfo = attachedTabs.get(tabId);
    if (!tabInfo) return;

    sendMessage({
      method: "forwardCDPEvent",
      params: { method, sessionId: tabInfo.sessionId, params },
    });
  });

  // extension/src/ai_bridge/bridge.js:409-417
  function sendMessage(message) {
    try {
      chrome.runtime.sendMessage({ type: "ws-send", payload: message }).catch(() => {
        warn("Cannot send message, offscreen not available");
      });
    } catch (_) {
      warn("Cannot send message, offscreen not available");
    }
  }
  ```
- **因果机制**：
  1. `bridge.js` 对 `chrome.debugger.onEvent` 未做任何前置过滤：即便是 Relay 明确丢弃的 `Network.dataReceived`、`Network.resourceChangedPriority`（`spawriter/src/cdp-log.ts:26-29`），在扩展端仍全部原样序列化转发。
  2. `Runtime.consoleAPICalled` 附带完整异步 V8 `stackTrace`（占比 **96.7%**，单条 ~12 KB），无裁剪、无限流。
  3. 每条 CDP 事件都触发一次独立的 `chrome.runtime.sendMessage`：每次调用都需要结构化克隆整份 `params`、经由 **Chrome Browser Process UI 线程** 路由并广播给所有扩展视图（Offscreen、DevTools Panel 等），再分配回调等待 `offscreen.js` 返回 `sendResponse({ sent: ok })`。
  4. 导航加载页面时，峰值 **1,681 次/秒 × 12 KB** 的一次性跨进程消息瞬间打满扩展 IPC 队列与浏览器 UI 线程，既导致 **Chrome 界面假死**，又把共享同一通道的 `Page.navigate` 和 `Runtime.callFunctionOn` 饿死长达 23–80 秒。

---

### 根因 2（放大器 A）：`tabs.onUpdated` 与 5 秒轮询无防抖/无变更检测地全量刷新所有标签页图标和标题脚本

- **涉及文件**：
  - `extension/src/ai_bridge/bridge.js:135-176`（`scheduleTitleMarker` / `applyTitleMarker`）
  - `extension/src/ai_bridge/bridge.js:222-296`（`updateIcons`）
  - `extension/src/ai_bridge/bridge.js:329-344`（`browser.tabs.onUpdated`）
  - `extension/src/ai_bridge/bridge.js:960-975`（5 秒 `setInterval` 所有权轮询）
- **因果机制**：
  1. `tabs.onUpdated` 监听器对**浏览器内任意标签页的任何属性变更**（`status: loading`、`url`、`title`、`favIconUrl`、`status: complete`）均无防抖地调用 `updateIcons()`。单次 `navigate` 往往触发 5–10 次 `tabs.onUpdated`。
  2. `updateIcons()` 每次执行 `browser.tabs.query({})` 拉取全部标签页，并对所有 `tabId` 并发发出 `setIcon`、`setTitle`、`setBadgeText`、`setBadgeBackgroundColor`（4 个 UI 线程 IPC × N 个标签页）外加逐标签页 `console.log`。若用户开了 30 个标签页，单次导航就会叠加数百次工具栏重绘 IPC。
  3. `init()` 中的 5 秒 `setInterval` 拉取 `/json/list` 后，**无论所有权是否发生变化**，都会调用 `syncOwnershipStates()` → `setTabState()` → `persistState()`（写 `chrome.storage.session`）+ `scheduleTitleMarker()`（注入 `chrome.scripting.executeScript`，失败时回退到 `chrome.debugger.sendCommand("Runtime.evaluate")`）+ `updateIcons()`，在导航阻塞期持续向已卡顿的标签页与 UI 线程施压。

---

### 根因 3（放大器 B）：Relay 事件重复派发、虚拟会话泄漏与 `cdp.jsonl` 同步序列化/整文件轮转

- **涉及文件**：
  - `spawriter/src/relay.ts:1091-1104`（`Target.attachToTarget` 创建 `vps-*`）
  - `spawriter/src/relay.ts:1495-1526`（`routeCdpEvent`）
  - `spawriter/src/relay.ts:2248-2268`（`/cdp/:clientId` 断连清理）
  - `spawriter/src/cdp-log.ts:34-46`、`88-127`（`NOISY_LOG_EVENTS`、`rotate`、`log`）
- **因果机制**：
  1. **事件重复发送**：在 `routeCdpEvent()` 中，`/cli/execute` 已将 `sessionToClientId` 绑定为 `pw-*` 客户端，代码先执行 `sendToCDPClient(ownerClientId, ...)` 发送第 1 份，紧接着执行 `sendToPwClients(sessionId)` 向同一个 `pw-*` 客户端发送**第 2 份**，再遍历 `realToVirtualSessions` 向每个 `vps-*` 发送**第 3、4… 份**。
  2. **虚拟会话泄漏**：`handleServerCdpCommand` 未处理 `Target.detachFromTarget`，且 `/cdp/:clientId` 的 `ws.on('close')` 也从未清理 `virtualBrowserSessions`、`virtualToRealSession`、`realToVirtualSessions`。每次 `resolvePageTargetId()` 临时 `newCDPSession()` + `detach()`，或超时重连，都会残留死 `vps-*`，持续放大事件扇出倍数。
  3. **同步大对象日志与百兆文件轮转阻塞事件循环**：`cdp-log.ts` 未将 `Runtime.consoleAPICalled` 纳入 `NOISY_LOG_EVENTS`，每次调用 `log()` 都在 Node.js 主线程同步执行 `JSON.stringify(entry, createTruncatingReplacer(...))` 遍历整棵 `stackTrace` 对象；且轮转仅按行数 `DEFAULT_MAX_ENTRIES = 10_000` 控制，单行 12 KB 时文件要涨到 **~120 MB** 才触发 `rotate()`，随后整文件 `readFile` + `split('\n')` + `join('\n')` + 重写 60 MB，直接造成本机回环 WS 连接耗时 **6.32 秒** 与 `CDP connection timeout (15s)`。

---

### 根因 4（次生放大器）：`Page.navigate` 超时漏走恢复流程，重连时 `DOMAINS_TO_RECYCLE` 二次引爆事件

- **涉及文件**：
  - `spawriter/src/pw-executor.ts:81-88`（`isExecutionTimeoutLikeError`）
  - `spawriter/src/pw-executor.ts:236-243`（`withTimeout`）
  - `spawriter/src/pw-executor.ts:896-905`（超时恢复判定）
  - `extension/src/ai_bridge/bridge.js:630-639`（`DOMAINS_TO_RECYCLE`）
- **因果机制**：
  1. `withTimeout()` 抛出的是普通 `Error`（`name === 'Error'`），而 `isExecutionTimeoutLikeError()` 仅识别 `CodeExecutionTimeoutError`、`NavigationBudgetError`、`TimeoutError`、`AbortError`。因此 `Page.navigate` 超时后不会进入 `recoverAfterExecutionTimeout()`，悬空请求和脏会话继续留在通道内。
  2. 当后续 `execute` 触发 30 秒 `CodeExecutionTimeoutError` 并重连时，Playwright 重新发送 `Runtime.enable` / `Page.enable`，触发 `bridge.js` 的 `DOMAINS_TO_RECYCLE`（先 `disable` 再 `enable`），导致 Chrome 重新同步执行上下文并重放缓存事件，形成恶性循环。

---

## 四、修复方案（按优先级）

### P0：立即消除 Chrome 假死（扩展端改造）

#### 1. `bridge.js` 前置过滤、裁剪与限流 CDP 事件
- 在 `chrome.debugger.onEvent` 入口直接丢弃高频无用事件：
  - `Network.dataReceived`
  - `Network.resourceChangedPriority`
- 对 `Runtime.consoleAPICalled` 做载荷裁剪：
  - 非 `error` / `assert` 级别：丢弃 `params.stackTrace`（或仅保留顶层 `callFrames.slice(0, 2)`），单条体积从 ~12 KB 降至 ~400 B（降低 **>95%**）。
  - 即使对 `error` 级别，也将 `callFrames` 上限裁剪为 10 帧并移除 `parent` / `parentId` 深层异步链。
- 增加按 `tabId` 的 `Runtime.consoleAPICalled` 滑动窗口限流：
  - 例如每 1 秒窗口超过 100 条后，丢弃非 `error` 控制台事件，窗口结束时补发一条汇总提示（`[spawriter] dropped N console events in last 1s`）。

#### 2. `bridge.js ↔ offscreen.js` 改用持久化 `Port` + 微批聚合
- 将 `chrome.runtime.sendMessage({ type: "ws-send", ... })` 替换为持久化 `chrome.runtime.connect({ name: "spawriter-ws" })`（支持 Service Worker 唤醒后自动重连 `Port`）。
- 区分通道优先级：
  - **命令响应（带 `id` 的消息）与控制消息**：立即发送，不引入延迟。
  - **`forwardCDPEvent` 事件流**：在 Service Worker 侧以 16–30ms 时间窗或满 50 条做微批聚合（如 `{ type: "ws-send-batch", payloads: [...] }`），由 `offscreen.js` 逐条写入 WebSocket，将峰值 1,681 次/秒的跨进程 IPC 压低至 30–60 次/秒。

#### 3. 修复 `updateIcons()` 与 5 秒轮询的无效刷屏
- `tabs.onUpdated` 仅在 `attachedTabs.has(tabId)` 或 `changeInfo.url` 跨越受限协议边界时触发，且对 `updateIcons()` 增加 200ms 防抖。
- 改为增量更新：缓存每个 `tabId` 上次写入的 `{ icon, title, badgeText, badgeColor }`，仅在值发生变化时调用 `chrome.action.*`，并移除 `updateIcons()` 中逐标签页的 `log(...)`。
- `init()` 中的 5 秒 `setInterval` 先对比新旧 `tabOwnership` 序列化快照，**无变化时直接 `return`**，不再重复触发 `syncOwnershipStates()`、`persistState()`、`scheduleTitleMarker()` 与 `updateIcons()`。

---

### P1：消除 Relay 事件放大与事件循环阻塞

#### 4. 修复 `relay.ts` 重复派发与虚拟会话泄漏
- **`routeCdpEvent` 去重**（`spawriter/src/relay.ts:1495-1526`）：
  - 记录已发送的 `clientId`（或当 `ownerClientId` 已发送时，在 `sendToPwClients` 中跳过 `cid === ownerClientId`），避免同一 `pw-*` 连接收到两份相同事件。
- **清理虚拟会话**：
  - 在 `handleServerCdpCommand` 中补充 `case 'Target.detachFromTarget'`，从 `virtualToRealSession` 和 `realToVirtualSessions` 中删除对应 `vpsId` 并直接返回 `{}`。
  - 维护 `clientToVirtualSessions: Map<string, { browser: Set<string>; page: Set<string> }>`，在 `/cdp/:clientId` 的 `ws.on('close')` 中彻底清理该客户端创建的所有 `vbs-*` 与 `vps-*`。

#### 5. 改造 `cdp-log.ts` 防主线程阻塞与字节上限轮转
- 将 `Runtime.consoleAPICalled` 加入 `NOISY_LOG_EVENTS`（或通过专用精简逻辑仅记录 `type` 与截断后的首条文本参数，不序列化 `stackTrace`）。
- 为 `cdp.jsonl` 增加字节上限（如 `DEFAULT_MAX_BYTES = 10 * 1024 * 1024`），轮转改用 O(1) 的文件重命名滚动（`cdp.jsonl` → `cdp.1.jsonl`），彻底移除 `readFile` + `split` + `join` + `writeFile` 的整文件内存拷贝。

---

### P2：完善超时恢复闭环

#### 6. 统一 CDP 命令超时错误类型与恢复策略
- 在 `spawriter/src/pw-executor.ts:236-243` 中，让 `withTimeout()` 抛出带有 `err.name = 'TimeoutError'`（或专用 `CdpCommandTimeoutError` 并在 `isExecutionTimeoutLikeError()` 中显式包含）的错误，确保 `Page.navigate` 超时也能正确进入超时恢复分支。
- 调整 `recoverAfterExecutionTimeout()`：仅当超时发生在脚本求值类命令时才发送 `Runtime.terminateExecution`；若是 `Page.navigate` 超时，优先尝试短超时 `Page.stopLoading` 后直接重建连接，避免继续向拥堵的 debugger 通道追加阻塞命令。

---

## 五、验证与回归测试清单

1. **事件风暴压测**：构造在 `navigate` 后 2 秒内输出 3,000 条带深层调用栈 `console.warn` 的测试页，验证 Chrome UI 可正常点击切页、`Page.navigate` 耗时 < 3 秒、`cdp.jsonl` 体积受控在 10 MB 以内。
2. **扩展 IPC 与图标更新计数**：在 30 个打开标签页环境下执行 `navigate`，验证 `chrome.action.setIcon` 与 `chrome.scripting.executeScript` 调用次数在稳态空闲期（5 秒轮询）为 **0**，导航期间仅触发个位数增量更新。
3. **Relay 单元测试**：
   - `routeCdpEvent` 对拥有标签页的 `pw-*` 客户端每条事件只发送 1 次（主会话）+ 1 次（活跃 `vps-*`），无重复发送。
   - `Target.detachFromTarget` 与 `/cdp/:clientId` 断开后，`virtualBrowserSessions` / `virtualToRealSession` / `realToVirtualSessions` 均归零。
4. **超时恢复测试**：模拟 `Page.navigate` 触发 `withTimeout`，验证 `isExecutionTimeoutLikeError` 返回 `true` 并触发连接恢复。
