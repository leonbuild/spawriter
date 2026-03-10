# spawriter 功能增强计划：合并 playwriter 能力

> 评估日期：2025-03-10
> 目标：将 playwriter 的通用浏览器自动化能力合并到 spawriter，使其同时具备 single-spa 专用功能和通用浏览器自动化能力。

---

## 1. 背景

### 1.1 两个项目

| | spawriter | playwriter |
|---|-----------|------------|
| **定位** | single-spa 微前端 AI 开发助手 | 通用浏览器自动化 AI 工具 |
| **特色** | import-map-overrides、single-spa 生命周期、DevTools 面板 | Playwright API、Session、调试器、录制 |
| **execute 方式** | CDP `Runtime.evaluate`（页面上下文） | Node.js VM 沙箱 + Playwright API（服务端） |
| **端口** | 19989 | 19988 |
| **代码库** | `D:\dev\side\spawriter` | `D:\dev\side\docs\playwriter` |

### 1.2 架构对比

```
两者共享相同的通信架构：

AI Client ←→ MCP Server ←→ Relay Server ←→ Chrome Extension ←→ Chrome Tab
  (stdio)      (Node)     (WebSocket)     (chrome.debugger)    (CDP)
```

**关键差异在 execute 实现**：

```
spawriter:   AI → MCP → CDP Runtime.evaluate(code) → 页面上下文运行 → 返回值
playwriter:  AI → MCP → Node VM sandbox → Playwright API → CDP → 浏览器
```

| 维度 | spawriter execute | playwriter execute |
|------|-------------------|-------------------|
| 运行环境 | 页面上下文（浏览器） | Node.js VM 沙箱（服务端） |
| 可用 API | `window.*`, `document.*` | `page.*`, `context.*`, `state`, utilities |
| 跨域限制 | 受同源策略限制 | 无限制 |
| 状态持久化 | 无 | 有（`state` 对象跨调用保持） |
| 多页面 | 不支持 | 支持（`context.newPage()`） |
| 性能 | 极快（直接 CDP） | 略慢（VM + Playwright 协议） |

### 1.3 playwriter 的 Playwright 来源

playwriter 没有自己实现 Playwright API。它 fork 了微软官方 `playwright-core`（发布为 `@xmorse/playwright-core`），添加了 `MouseActionEvent`（ghost cursor 需要）。核心 API 完全来自微软原版。

**对 spawriter 的意义**：直接使用标准 `playwright-core` npm 包即可，不需要 fork。spawriter 的 `mcp/package.json` 已声明 `"playwright-core": "^1.56.1"` 但尚未使用。

### 1.4 Chrome tab 激活态的影响

| 操作 | Tab 在前台 | Tab 在后台 |
|------|-----------|-----------|
| JS 执行 / AX 快照 / Navigate | 正常 | 正常 |
| Network / Console 事件 | 正常 | 正常 |
| **截图** | 正常 | **可能返回旧画面** |

大部分操作不需要 tab 在前台。`chrome.debugger` 连接不会因 tab 不在前台而断开。

---

## 2. playwriter 功能清单与移植评估

### 2.1 核心执行引擎

| 功能 | playwriter 实现 | 工作量 | 需要 Playwright |
|------|-----------------|--------|----------------|
| VM 沙箱执行 | `vm.createContext` + `vm.runInContext` | 中 | 是 |
| Playwright 连接 | `chromium.connectOverCDP(cdpUrl)` | 小 | 是 |
| 自动 return | acorn AST 检测单表达式 | 小 | 否 |
| 执行超时 | `Promise.race` + timeout | 小 | 否 |

### 2.2 Playwright API

| 功能 | 说明 | 引入 Playwright 后 |
|------|------|-------------------|
| page 对象 | `goto()`, `click()`, `fill()`, `locator()`, `screenshot()` | 自动获得 |
| context 对象 | `newPage()`, `pages()`, `cookies()` | 自动获得 |
| state 对象 | 跨 execute 调用保持 | 在 executor 上维护 |
| Locator API | `page.locator('text=Submit')`, `getByRole('button')` | 自动获得 |

### 2.3 调试与监控工具

| 功能 | CDP 域 | 工作量 | 需要 Playwright |
|------|--------|--------|----------------|
| **Console 日志捕获** | `Runtime.consoleAPICalled` | 小 | 否 |
| **Network 请求监控** | `Network.*` | 小 | 否 |
| **断点调试器** | `Debugger.*` | 中 | 否 |
| **代码编辑器** | `Debugger.*`, `CSS.*` | 中 | 否 |
| **CSS 检查** | `CSS.getComputedStyleForNode` | 小 | 部分 |

### 2.4 截图与无障碍

| 功能 | spawriter 当前 | 工作量 | 需要 Playwright |
|------|---------------|--------|----------------|
| 基础 AX 快照 | 已有 ✅ | — | 否 |
| 带标签截图 | 无 | 中 | 否（纯 CDP） |
| diff 快照 | 无 | 小 | 否 |
| ref → Locator | — | — | 是 |

### 2.5 录制与展示

| 功能 | 工作量 | 需要 Playwright |
|------|--------|----------------|
| 视频录制 | 大（需改扩展） | 否 |
| Ghost cursor | 小 | 部分 |
| Demo 视频 | 大（FFmpeg） | 否 |

### 2.6 Session 与其他

| 功能 | 工作量 | 需要 Playwright |
|------|--------|----------------|
| Session 管理 | 中 | 是 |
| 状态持久化 | 小 | 是（依赖 executor） |
| CLI 工具 | 小 | 是 |
| Scoped FS | 小 | 否 |
| MCP Resources | 小 | 否 |

---

## 3. 功能优先级

| 优先级 | 功能 | 日常频率 | AI 效率提升 |
|--------|------|---------|-----------|
| **P0** | Console 日志捕获 | 极高 | 极高 |
| **P0** | Network 请求监控 | 极高 | 极高 |
| **P1** | Playwright execute | 高 | 高 |
| **P1** | 带标签截图 | 高 | 高 |
| **P1** | State 持久化 | 高 | 高 |
| **P2** | 断点调试器 | 中 | 中 |
| **P2** | 代码编辑器 | 中 | 中 |
| **P2** | CSS 检查 | 中 | 中 |
| **P2** | Session 管理 | 中 | 中 |
| **P3** | 视频录制 / CLI / Demo 视频 / Ghost cursor | 低 | 低 |

---

## 4. 合并后的工具清单

```
spawriter v2.0（合并后）
├── MCP Tools
│   ├── execute                    ← 保留（页面上下文 JS，快速轻量）
│   ├── playwright_execute         ← 新增（Playwright VM 沙箱，复杂交互）
│   ├── screenshot                 ← 增强（支持 labels 参数）
│   ├── accessibility_snapshot     ← 增强（支持 diff/search）
│   ├── console_logs               ← 新增（纯 CDP）
│   ├── network_log                ← 新增（纯 CDP）
│   ├── navigate                   ← 保留
│   ├── dashboard_state            ← 保留（spawriter 独有）
│   ├── override_app               ← 保留（spawriter 独有）
│   ├── app_action                 ← 保留（spawriter 独有）
│   ├── clear_cache_and_reload     ← 保留
│   ├── ensure_fresh_render        ← 保留
│   └── reset                      ← 保留（增强：清理日志/网络/Playwright）
└── Extension
    ├── single-spa DevTools panel  ← 保留（spawriter 独有）
    └── import-map-overrides UI    ← 保留（spawriter 独有）
```

---

## 5. 分阶段实施

### Phase 1：纯 CDP 增强（~1 周）

> 不需要 Playwright，改动最小，价值最高。

#### 5.1.1 Console 日志捕获

**修改文件**：`mcp/src/mcp.ts`

**原理**：扩展 attach 时已执行 `Runtime.enable`，CDP 推送 `Runtime.consoleAPICalled` 事件。当前 `ws.on('message')` 处理器（第 154 行）只处理有 `id` 的 CDP 响应，无 `id` 的事件被忽略。

**步骤 1：添加存储（第 25 行附近）**

```typescript
interface ConsoleLogEntry {
  level: string
  text: string
  timestamp: number
  url?: string
  lineNumber?: number
}

const MAX_CONSOLE_LOGS = 1000;
const consoleLogs: ConsoleLogEntry[] = [];

function addConsoleLog(entry: ConsoleLogEntry) {
  consoleLogs.push(entry);
  if (consoleLogs.length > MAX_CONSOLE_LOGS) {
    consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE_LOGS);
  }
}

function clearConsoleLogs() {
  consoleLogs.length = 0;
}
```

**步骤 2：修改 `ws.on('message')` 处理器（第 154 行）**

```typescript
ws.on('message', (data: Buffer) => {
  try {
    const msg = JSON.parse(data.toString());

    if (msg.id !== undefined) {
      const pending = session.pendingRequests.get(msg.id);
      if (pending) {
        session.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // CDP 事件（无 id，有 method）
    if (msg.method) {
      handleCdpEvent(msg.method, msg.params);
    }
  } catch {
    // ignore parse errors
  }
});
```

**步骤 3：CDP 事件处理**

```typescript
function handleCdpEvent(method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const type = (params.type as string) || 'log';
      const args = (params.args as Array<{ type: string; value?: unknown; description?: string }>) || [];
      const text = args.map(arg => {
        if (arg.value !== undefined) return String(arg.value);
        if (arg.description) return arg.description;
        return `[${arg.type}]`;
      }).join(' ');
      const stackTrace = params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined;
      const topFrame = stackTrace?.callFrames?.[0];
      addConsoleLog({
        level: type, text, timestamp: Date.now(),
        url: topFrame?.url, lineNumber: topFrame?.lineNumber,
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number } | undefined;
      addConsoleLog({
        level: 'error',
        text: details?.exception?.description || details?.text || 'Unknown exception',
        timestamp: Date.now(), url: details?.url, lineNumber: details?.lineNumber,
      });
      break;
    }
    // Network 事件见下文
  }
}
```

**步骤 4：MCP 工具定义（`tools` 数组中添加）**

```typescript
{
  name: 'console_logs',
  description: 'Get captured browser console logs (log, warn, error, info, debug).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      count: { type: 'number', description: 'Recent logs count (default: 50, max: 1000)' },
      level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug', 'all'], description: 'Filter level (default: all)' },
      search: { type: 'string', description: 'Search text filter' },
      clear: { type: 'boolean', description: 'Clear after returning' },
    },
  },
},
```

**步骤 5：工具处理（`switch (name)` 中添加）**

```typescript
case 'console_logs': {
  const count = Math.min(Math.max((args.count as number) || 50, 1), MAX_CONSOLE_LOGS);
  const level = (args.level as string) || 'all';
  const search = (args.search as string) || '';
  const shouldClear = args.clear as boolean;
  let filtered = consoleLogs;
  if (level !== 'all') filtered = filtered.filter(log => log.level === level);
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(log => log.text.toLowerCase().includes(s)); }
  const recent = filtered.slice(-count);
  const lines = recent.map(log => {
    const time = new Date(log.timestamp).toISOString().slice(11, 23);
    const loc = log.url ? ` (${log.url}${log.lineNumber !== undefined ? ':' + log.lineNumber : ''})` : '';
    return `[${time}] [${log.level.toUpperCase().padEnd(5)}] ${log.text}${loc}`;
  });
  if (shouldClear) clearConsoleLogs();
  return { content: [{ type: 'text', text: lines.length > 0
    ? `Console logs (${recent.length}/${consoleLogs.length} total):\n${lines.join('\n')}`
    : `No console logs (${consoleLogs.length} total)` }] };
}
```

#### 5.1.2 Network 请求监控

**存储（同文件顶部添加）**

```typescript
interface NetworkEntry {
  requestId: string; url: string; method: string;
  status?: number; statusText?: string; mimeType?: string;
  startTime: number; endTime?: number; error?: string; size?: number;
}
const MAX_NETWORK_ENTRIES = 500;
const networkLog: Map<string, NetworkEntry> = new Map();
function clearNetworkLog() { networkLog.clear(); }
```

**`handleCdpEvent` 中添加 Network 分支**

```typescript
case 'Network.requestWillBeSent': {
  const requestId = params.requestId as string;
  const request = params.request as { url: string; method: string };
  networkLog.set(requestId, { requestId, url: request.url, method: request.method, startTime: Date.now() });
  if (networkLog.size > MAX_NETWORK_ENTRIES) { const k = networkLog.keys().next().value; if (k) networkLog.delete(k); }
  break;
}
case 'Network.responseReceived': {
  const entry = networkLog.get(params.requestId as string);
  if (entry) { const r = params.response as any; entry.status = r.status; entry.statusText = r.statusText; entry.mimeType = r.mimeType; entry.endTime = Date.now(); }
  break;
}
case 'Network.loadingFinished': {
  const entry = networkLog.get(params.requestId as string);
  if (entry) { entry.endTime = entry.endTime || Date.now(); entry.size = (params.encodedDataLength as number) || undefined; }
  break;
}
case 'Network.loadingFailed': {
  const entry = networkLog.get(params.requestId as string);
  if (entry) { entry.error = (params.errorText as string) || 'Failed'; entry.endTime = Date.now(); }
  break;
}
```

**MCP 工具**

```typescript
{
  name: 'network_log',
  description: 'Get captured network requests. Shows URL, method, status, timing, errors.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      count: { type: 'number', description: 'Recent entries (default: 50)' },
      url_filter: { type: 'string', description: 'Filter by URL substring' },
      status_filter: { type: 'string', enum: ['all', 'ok', 'error', '4xx', '5xx'], description: 'Status filter' },
      clear: { type: 'boolean', description: 'Clear after returning' },
    },
  },
},
```

**工具处理**

```typescript
case 'network_log': {
  const count = Math.min(Math.max((args.count as number) || 50, 1), MAX_NETWORK_ENTRIES);
  const urlFilter = (args.url_filter as string) || '';
  const statusFilter = (args.status_filter as string) || 'all';
  let entries = Array.from(networkLog.values());
  if (urlFilter) { const l = urlFilter.toLowerCase(); entries = entries.filter(e => e.url.toLowerCase().includes(l)); }
  if (statusFilter !== 'all') entries = entries.filter(e => {
    if (statusFilter === 'ok') return e.status !== undefined && e.status >= 200 && e.status < 400;
    if (statusFilter === 'error') return e.error || (e.status !== undefined && e.status >= 400);
    if (statusFilter === '4xx') return e.status !== undefined && e.status >= 400 && e.status < 500;
    if (statusFilter === '5xx') return e.status !== undefined && e.status >= 500;
    return true;
  });
  const recent = entries.slice(-count);
  const lines = recent.map(e => {
    const st = e.error ? `ERR:${e.error}` : (e.status !== undefined ? `${e.status}` : '...');
    const dur = e.endTime && e.startTime ? `${e.endTime - e.startTime}ms` : '...';
    const sz = e.size ? ` ${(e.size / 1024).toFixed(1)}KB` : '';
    return `${e.method.padEnd(6)} ${st.padEnd(15)} ${dur.padStart(7)}${sz}  ${e.url}`;
  });
  if (args.clear) clearNetworkLog();
  return { content: [{ type: 'text', text: lines.length > 0
    ? `Network (${recent.length}/${networkLog.size}):\n${lines.join('\n')}`
    : `No entries (${networkLog.size} total)` }] };
}
```

#### 5.1.3 Reset 增强

```typescript
if (name === 'reset') {
  if (cdpSession) { cdpSession.ws.close(); cdpSession = null; }
  clearConsoleLogs();
  clearNetworkLog();
  return { content: [{ type: 'text', text: 'Connection reset' }] };
}
```

#### 5.1.4 带标签截图

修改 `screenshot` 工具，增加 `labels` 参数。通过 AX 树获取可交互元素，用 `DOM.resolveNode` + `DOM.getBoxModel` 获取位置，注入 CSS overlay，截图后移除。参考 playwriter 的 `aria-snapshot.ts`。

> 此功能较复杂，建议 Phase 1 先完成 Console + Network，带标签截图作为 Phase 1.5。

---

### Phase 2：Playwright 集成（~1-2 周）

#### 5.2.1 新建 `mcp/src/pw-executor.ts`

```typescript
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import * as vm from 'node:vm';
import { getCdpUrl, log, error } from './utils.js';

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private userState: Record<string, unknown> = {};

  async ensureConnection(): Promise<{ page: Page; context: BrowserContext }> {
    if (this.page && this.context) {
      try { await this.page.evaluate('1'); return { page: this.page, context: this.context }; }
      catch { log('Playwright connection stale, reconnecting...'); }
    }
    const cdpUrl = getCdpUrl();
    this.browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = this.browser.contexts();
    this.context = contexts[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();
    return { page: this.page, context: this.context };
  }

  async execute(code: string, timeout = 30000): Promise<string> {
    const { page, context } = await this.ensureConnection();
    const sandbox = {
      page, context, state: this.userState,
      console: { log: (...a: unknown[]) => log('[pw]', ...a), error: (...a: unknown[]) => error('[pw]', ...a),
                 warn: (...a: unknown[]) => log('[pw:warn]', ...a), info: (...a: unknown[]) => log('[pw:info]', ...a) },
      setTimeout: global.setTimeout, setInterval: global.setInterval,
      clearTimeout: global.clearTimeout, clearInterval: global.clearInterval,
      fetch: global.fetch, URL, URLSearchParams, Buffer, JSON,
    };
    const vmContext = vm.createContext(sandbox);
    const result = await Promise.race([
      vm.runInContext(`(async () => { ${code} })()`, vmContext),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${timeout}ms`)), timeout)),
    ]);
    if (result === undefined) return 'undefined';
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  async reset(): Promise<void> {
    this.userState = {};
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; this.context = null; this.page = null; }
  }
}
```

#### 5.2.2 MCP 工具

```typescript
{
  name: 'playwright_execute',
  description: `Execute code in Node.js sandbox with Playwright API.
Variables: page (Page), context (BrowserContext), state (persistent object).
Use for: complex interactions, form filling, multi-page, Playwright locators.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      timeout: { type: 'number', description: 'Timeout ms (default: 30000)' },
    },
    required: ['code'],
  },
},
```

#### 5.2.3 注意事项

- Playwright `connectOverCDP` 需要 relay 支持新的 CDP 客户端路径（如 `/cdp/playwright`）
- 需确认 `mcp/src/utils.ts` 有 `getCdpUrl()` 函数
- Reset 时需调用 `pwExecutor.reset()`

---

### Phase 3：按需高级功能

| 功能 | 来源 | 估时 |
|------|------|------|
| 断点调试器 | 移植 playwriter `debugger.ts` | 1 天 |
| 代码编辑器 | 移植 playwriter `editor.ts` | 1 天 |
| 视频录制 | 扩展添加 `chrome.tabCapture` + RecordingRelay | 2 天 |
| Session 管理 | 添加 `ExecutorManager` | 1 天 |
| CLI 工具 | relay 添加 `POST /cli/execute` | 0.5 天 |

---

## 6. 工作量汇总

| Phase | 内容 | 估时 |
|-------|------|------|
| Phase 1 | Console + Network + 带标签截图 | 3-5 天 |
| Phase 2 | Playwright execute + State | 5-7 天 |
| Phase 3 | 调试器/编辑器/录制/Session/CLI | 按需 5-6 天 |
| **总计** | | **~13-18 天** |

---

## 7. 改名与版本

| 项目 | 建议 |
|------|------|
| 名字 | 保留 `spawriter`（已有认知） |
| 定位 | "AI-powered browser devtools for single-spa and beyond" |
| 新工具名 | `playwright_execute`（与 `execute` 明确区分） |
| 版本 | Phase 2 完成后发 v2.0 |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Playwright 与 Chrome 兼容 | 使用 `playwright-core`（无内置浏览器） |
| 两套 execute 导致 AI 困惑 | 工具描述中明确场景 |
| 内存增长 | Console/Network 设最大条数，滚动淘汰 |
| Relay 多客户端 | 检查 relay 是否支持 `/cdp/playwright` 路径共存 |

---

## 9. cursor-rules 更新

Phase 1/2 完成后更新 `cursor-rules/spawriter.mdc`：

```markdown
### Inspection & State

| Tool | Description | Key Args |
|---|----|----|
| `dashboard_state` | single-spa app list, statuses, overrides | `appName?` |
| `screenshot` | Page screenshot, optional a11y labels | `labels?` |
| `accessibility_snapshot` | Condensed accessibility tree | — |
| `execute` | Run JS in page context (fast, lightweight) | `code` |
| `playwright_execute` | Run code with Playwright API (page, context, state) | `code`, `timeout?` |
| `console_logs` | Browser console logs | `count?`, `level?`, `search?`, `clear?` |
| `network_log` | Network requests | `count?`, `url_filter?`, `status_filter?`, `clear?` |
```
