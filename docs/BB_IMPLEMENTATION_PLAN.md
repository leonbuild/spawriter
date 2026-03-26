# spawriter — bb-browser 特性实施计划

> 基于: [BB_BROWSER_ANALYSIS.md](./BB_BROWSER_ANALYSIS.md)
> 日期: 2026-03-26
> 代码基线: spawriter main branch

---

## Phase 1: 基础增强 (1-2 周)

### 1.1 结构化错误格式

**目标**: 替换当前的 `"Error: ..."` 纯文本错误为结构化 JSON，帮助 AI agent 自主恢复。

**当前实现** (`mcp/src/mcp.ts`):
```typescript
// 多处类似模式:
return { content: [{ type: 'text', text: `Error: ${String(e)}` }], isError: true };
```

**改动方案**:

1. 在 `mcp/src/protocol.ts` 中新增错误类型:

```typescript
interface StructuredError {
  error: string;       // 技术原因 (e.g. "CDP connection lost")
  hint: string;        // 人类可读解释
  recovery?: string;   // 可执行的恢复命令/tool name
}
```

2. 在 `mcp/src/mcp.ts` 中新增 helper:

```typescript
function formatError(err: StructuredError): string {
  const parts = [`Error: ${err.error}`];
  if (err.hint) parts.push(`Hint: ${err.hint}`);
  if (err.recovery) parts.push(`Recovery: call "${err.recovery}" tool`);
  return parts.join('\n');
}
```

3. 改造关键错误点 (保持 MCP text 格式兼容性，不破坏 content schema):

| 错误场景 | error | hint | recovery |
|---------|-------|------|----------|
| CDP 连接丢失 | `CDP connection lost` | `Chrome tab may have been closed or navigated away` | `reset` |
| Tab 未连接 | `No tab connected` | `No Chrome tab is attached to spawriter` | `connect_tab` |
| Lease 被拒 | `Tab leased by another agent` | `Tab {targetId} is owned by {owner}. Use list_tabs to find available tabs.` | `list_tabs` |
| 元素未找到 | `Element not found: {selector}` | `The CSS selector did not match any element on the page` | — |
| Playwright 连接失败 | `Playwright CDP connection failed` | `Relay server may not be running` | `reset` |
| 命令超时 | `Tool "{name}" timed out after {n}s` | `The browser may be busy or unreachable` | `reset` |
| importMapOverrides 不可用 | `importMapOverrides not available` | `Page may not have loaded yet; wait and retry` | `ensure_fresh_render` |

**涉及文件**:
- `mcp/src/protocol.ts` — 新增 `StructuredError` 类型
- `mcp/src/mcp.ts` — `formatError` helper + 改造 ~15 处错误返回点

**测试用例**:

```typescript
// mcp/src/structured-error.test.ts
import { describe, it, assert } from 'node:test';

describe('formatError', () => {
  it('should format error with all fields', () => {
    const result = formatError({
      error: 'CDP connection lost',
      hint: 'Chrome tab may have been closed',
      recovery: 'reset'
    });
    assert.ok(result.includes('Error: CDP connection lost'));
    assert.ok(result.includes('Hint: Chrome tab may have been closed'));
    assert.ok(result.includes('Recovery: call "reset" tool'));
  });

  it('should format error without recovery', () => {
    const result = formatError({
      error: 'Element not found',
      hint: 'Selector did not match'
    });
    assert.ok(result.includes('Error: Element not found'));
    assert.ok(!result.includes('Recovery'));
  });
});
```

**手动验证**:
1. 断开 Chrome → 调用任意 tool → 验证返回含 `Hint` 和 `Recovery` 字段
2. 在已被其他 agent 锁定的 tab 上操作 → 验证 lease 错误格式

---

### 1.2 `accessibility_snapshot` 增加 `interactive_only` 参数

**目标**: 减少 accessibility tree 输出噪音，降低 agent token 消耗。

**当前实现** (`mcp/src/mcp.ts:1944-1966`):
- `Accessibility.getFullAXTree` → `formatAXTreeAsText` 返回完整树
- 支持 `search` 和 `diff` 参数，但无过滤

**改动方案**:

1. 在 tool schema 中新增参数:

```typescript
// tools 数组中 accessibility_snapshot 的 arguments.properties 中新增:
interactive_only: {
  type: 'boolean',
  description: 'If true, only show interactive elements (buttons, links, inputs, etc.) with ref numbers'
}
```

2. 在 handler 中:

```typescript
case 'accessibility_snapshot': {
  await sendCdpCommand(session, 'Accessibility.enable', ...);
  const axResult = await sendCdpCommand(session, 'Accessibility.getFullAXTree', ...) as { nodes: AXNode[] };

  const interactiveOnly = args.interactive_only as boolean | undefined;
  if (interactiveOnly) {
    const interactive = getInteractiveElements(axResult.nodes ?? []);
    const text = formatInteractiveSnapshot(interactive);
    lastSnapshot = text;
    return { content: [{ type: 'text', text }] };
  }

  // ... 原有 full tree 逻辑 (search, diff) ...
}
```

3. 新增 `formatInteractiveSnapshot`:

```typescript
function formatInteractiveSnapshot(elements: LabeledElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.';
  const lines = elements.map(e =>
    `@${e.index} [${e.role}]${e.name ? ` "${e.name}"` : ''}`
  );
  return `Interactive elements (${elements.length}):\n${lines.join('\n')}`;
}
```

**涉及文件**:
- `mcp/src/mcp.ts` — tool schema + handler + `formatInteractiveSnapshot`

**测试用例**:

```typescript
// mcp/src/accessibility.test.ts
describe('formatInteractiveSnapshot', () => {
  it('should format elements with @ref notation', () => {
    const elements = [
      { index: 1, role: 'button', name: '提交', backendDOMNodeId: 10 },
      { index: 2, role: 'textbox', name: '', backendDOMNodeId: 11 },
    ];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('@1 [button] "提交"'));
    assert.ok(result.includes('@2 [textbox]'));
    assert.ok(result.includes('Interactive elements (2)'));
  });

  it('should handle empty elements', () => {
    assert.strictEqual(formatInteractiveSnapshot([]), 'No interactive elements found.');
  });
});
```

**手动验证**:
1. 在 service.cstcloud.cn 上调用 `accessibility_snapshot { interactive_only: true }` → 验证只返回按钮/链接/输入框
2. 对比 `interactive_only: true` 和默认输出的 token 数量差异
3. 验证 `interactive_only` 与 `search`/`diff` 参数的优先级行为（`interactive_only` 应优先于 `search` 和 `diff`，因为返回的是不同格式）

---

### 1.3 Extension 关键状态用 `chrome.storage.session` 持久化

**目标**: 防止 MV3 service worker 休眠后丢失状态。

**当前实现** (`ext/src/ai_bridge/bridge.js:11-26`):
- `attachedTabs` 和 `tabStates` 已通过 `chrome.storage.session` 持久化
- `restoreState()` 在启动时恢复

**分析**: 当前 bridge.js 已经实现了核心状态的持久化。需要审计还有哪些状态在内存中可能丢失。

**需要检查和补充持久化的状态**:

| 状态 | 当前存储 | 是否需要持久化 |
|------|---------|------------|
| `attachedTabs` | `chrome.storage.session` ✅ | 已实现 |
| `tabStates` | `chrome.storage.session` ✅ | 已实现 |
| `portsToPanel` | 内存 (Map) | 不需要 — panel 打开时会重新连接 |
| `tabLeases` (relay.ts) | Node 内存 | 不需要 — 在 relay 进程中，不受 SW 影响 |
| `consoleLogs` / `networkLog` (mcp.ts) | Node 内存 | 不需要 — 在 MCP 进程中 |

**结论**: bridge.js 已经实现了必要的持久化。此项可标记为**已完成**或仅做小幅补充:

- 补充: 将 `lastConnectedRelayUrl` 持久化，SW 重启后自动重连 relay
- 补充: 将 debugger 的 `attached` 状态也持久化（当前 debugger attach 在 SW 休眠后会丢失）

**涉及文件**:
- `ext/src/ai_bridge/bridge.js` — 补充 relay URL 和 debugger 状态的持久化

**测试用例**: 手动测试
1. 连接 relay + attach tab → 等待 SW 休眠 (~30s 不活动) → 调用 tool → 验证自动恢复
2. 在 `chrome://serviceworker-internals/` 手动停止 SW → 调用 tool → 验证自动恢复

---

## Phase 2: Ref 系统 (2-3 周)

### 2.1 Snapshot 中为可交互元素分配 @ref 编号

**目标**: 让 `accessibility_snapshot` 返回带 `@ref` 编号的可交互元素，后续操作可直接引用。

**设计**:

1. `accessibility_snapshot` 的 full tree 模式中，在可交互元素行前标注 `@N`:

```
  heading "个人资源"
  tablist
    @1 tab "云主机列表"
    @2 tab "云硬盘列表"
    @3 tab "订单列表"
  @4 button "新建"
  table
    @5 textbox "" (search)
```

2. `interactive_only` 模式已在 Phase 1.2 实现，直接输出 `@N` 格式

3. 在 MCP 进程侧缓存 ref → backendDOMNodeId 映射:

```typescript
// mcp/src/mcp.ts
let refCache: Map<number, { backendDOMNodeId: number; role: string; name: string }> = new Map();
```

**改动方案**:

1. 修改 `formatAXTreeAsText` 增加 ref 标注:

```typescript
function formatAXTreeAsText(nodes: AXNode[], assignRefs: boolean = true): string {
  refCache.clear();
  const interactiveSet = assignRefs ? new Set(
    getInteractiveElements(nodes).map(e => e.backendDOMNodeId)
  ) : new Set<number>();

  let refIdx = 1;
  // ... walk 函数中，对可交互节点增加 @ref 前缀 ...
  function walk(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId);
    // ...
    const isInteractive = node.backendDOMNodeId && interactiveSet.has(node.backendDOMNodeId);
    const refPrefix = isInteractive ? `@${refIdx}` : '';
    if (isInteractive && node.backendDOMNodeId) {
      refCache.set(refIdx, {
        backendDOMNodeId: node.backendDOMNodeId,
        role: role,
        name: name
      });
      refIdx++;
    }
    // ... 构建行文本时加入 refPrefix ...
  }
}
```

2. 在 `reset` / `switch_tab` 时清除 `refCache`

**涉及文件**:
- `mcp/src/mcp.ts` — `refCache` 变量, `formatAXTreeAsText` 修改, 清理逻辑

**测试用例**:

```typescript
describe('ref assignment in formatAXTreeAsText', () => {
  it('should assign @ref to interactive elements', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Title' } },
      { nodeId: '3', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 42 },
    ];
    const text = formatAXTreeAsText(nodes, true);
    assert.ok(text.includes('@1'));
    assert.ok(text.includes('button "Submit"'));
    assert.ok(!text.includes('@') || !text.includes('heading')); // heading 不应有 @ref
  });
});
```

---

### 2.2 Extension 侧缓存 ref → backendDOMNodeId 映射

**分析**: 基于 Phase 2.1 的方案，ref 缓存放在 MCP 进程侧（`mcp.ts`），不需要在 extension 中额外缓存。原因：

1. `backendDOMNodeId` 通过 CDP `Accessibility.getFullAXTree` 获取，可直接被 `DOM.resolveNode` 使用
2. MCP 进程直接通过 CDP 发送 `DOM.resolveNode({ backendNodeId })` → 不需要 extension 的协助
3. 缓存放在 MCP 进程中更简单，且生命周期与 `lastSnapshot` 一致

**如需 extension 侧缓存** (用于 `chrome.storage.session` 持久化):
- 在 `bridge.js` 中增加 `refMap` 存储
- 新增 relay 消息类型 `cacheRefs` / `resolveRef`
- 评估: 增加复杂度，除非 MCP 进程重启后需要保留 ref

**结论**: Phase 2.1 的 MCP 侧缓存足够，标记此项为**不需要独立实施**。

---

### 2.3 `playwright_execute` / `execute` 支持通过 @ref 快速定位元素

**目标**: Agent 可以在 `execute` / `playwright_execute` 中通过 `@ref` 快速引用元素。

**设计方案 A — 新增独立 MCP tool `interact`**:

```typescript
// tool schema
{
  name: 'interact',
  description: 'Interact with a page element by @ref number (from accessibility_snapshot)',
  arguments: {
    type: 'object',
    properties: {
      ref: { type: 'number', description: '@ref number from accessibility_snapshot' },
      action: {
        type: 'string',
        enum: ['click', 'hover', 'fill', 'focus', 'check', 'uncheck', 'select'],
        description: 'Action to perform'
      },
      value: { type: 'string', description: 'Value for fill/select actions' }
    },
    required: ['ref', 'action']
  }
}
```

Handler:
```typescript
case 'interact': {
  const ref = args.ref as number;
  const action = args.action as string;
  const value = args.value as string | undefined;

  const cached = refCache.get(ref);
  if (!cached) {
    return { content: [{ type: 'text', text: formatError({
      error: `Ref @${ref} not found`,
      hint: 'Run accessibility_snapshot first to get fresh @ref numbers',
      recovery: 'accessibility_snapshot'
    }) }], isError: true };
  }

  // DOM.resolveNode → objectId
  const resolved = await sendCdpCommand(session, 'DOM.resolveNode', {
    backendNodeId: cached.backendDOMNodeId
  });
  const objectId = resolved.object?.objectId;

  // DOM.getBoxModel → 坐标
  const boxModel = await sendCdpCommand(session, 'DOM.getBoxModel', {
    backendNodeId: cached.backendDOMNodeId
  });
  const b = boxModel.model.border;
  const cx = (Math.min(b[0], b[2], b[4], b[6]) + Math.max(b[0], b[2], b[4], b[6])) / 2;
  const cy = (Math.min(b[1], b[3], b[5], b[7]) + Math.max(b[1], b[3], b[5], b[7])) / 2;

  switch (action) {
    case 'click':
      await sendCdpCommand(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await sendCdpCommand(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      break;
    case 'hover':
      await sendCdpCommand(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      break;
    case 'fill':
      await sendCdpCommand(session, 'DOM.focus', { backendNodeId: cached.backendDOMNodeId });
      // 清空当前值
      await sendCdpCommand(session, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }); // Ctrl+A
      await sendCdpCommand(session, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 });
      await sendCdpCommand(session, 'Input.insertText', { text: value ?? '' });
      break;
    case 'focus':
      await sendCdpCommand(session, 'DOM.focus', { backendNodeId: cached.backendDOMNodeId });
      break;
    // ... check, uncheck, select 通过 Runtime.callFunctionOn(objectId) 实现
  }

  return { content: [{ type: 'text', text: `Performed ${action} on @${ref} [${cached.role}]${cached.name ? ` "${cached.name}"` : ''}` }] };
}
```

**设计方案 B — 在 `playwright_execute` 中注入 `refToSelector` helper**:

在 `pw-executor.ts` 的 VM context 中注入:
```typescript
const refToSelector = (ref: number) => {
  // 通过 CDP 将 backendDOMNodeId 转换为 unique CSS selector
  // 需要 MCP 进程与 executor 之间共享 refCache
};
```

**推荐**: 方案 A (独立 `interact` tool)，因为:
- 不需要跨进程共享状态
- 直接用 CDP 操作，不经过 Playwright
- 更符合 bb-browser 的设计哲学（原子化 tool）
- `playwright_execute` 仍可用于复杂流程

**涉及文件**:
- `mcp/src/mcp.ts` — 新增 `interact` tool schema + handler

**测试用例**:

```typescript
describe('interact tool', () => {
  it('should reject invalid ref', () => {
    // mock refCache为空
    const result = handleInteract({ ref: 99, action: 'click' });
    assert.ok(result.isError);
    assert.ok(result.text.includes('Ref @99 not found'));
  });

  it('should reject fill without value', () => {
    refCache.set(1, { backendDOMNodeId: 42, role: 'textbox', name: 'search' });
    const result = handleInteract({ ref: 1, action: 'fill' }); // no value
    // fill with empty string is valid (clears field)
  });
});
```

**端到端手动验证**:
1. `accessibility_snapshot` → 记录 @ref 编号
2. `interact { ref: 1, action: "click" }` → 验证按钮被点击
3. `interact { ref: 2, action: "fill", value: "hello" }` → 验证输入框被填充
4. `interact { ref: 99, action: "click" }` → 验证错误消息格式
5. `switch_tab` → `interact { ref: 1, action: "click" }` → 验证 ref 失效提示

---

## Phase 3: 高级特性 (3-4 周)

### 3.1 操作录制 (Trace)

**目标**: 录制用户在浏览器中的操作，输出结构化事件列表。

**架构**:
```
用户操作 → content_script (DOM 事件监听)
         → chrome.runtime.sendMessage
         → bridge.js (background) 缓存事件
         → relay → MCP tool 返回
```

**实施步骤**:

**Step 1: 新增 content script (`ext/src/content_trace.js`)**

```javascript
// 辅助函数: 生成唯一 CSS 选择器
function generateUniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/).filter(c => c).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      selector += cls;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

// 辅助函数: 生成 XPath
function getXPath(el) {
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

// 监听 DOM 事件，发送到 background
const DEBOUNCE_INPUT = 500;
const DEBOUNCE_SCROLL = 300;

let inputTimer = null;
let scrollTimer = null;
let traceActive = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'trace_start') traceActive = true;
  if (msg.type === 'trace_stop') traceActive = false;
});

function getElementInfo(el) {
  return {
    tagName: el.tagName?.toLowerCase(),
    role: el.getAttribute('role') || el.tagName?.toLowerCase(),
    name: el.getAttribute('aria-label') || el.innerText?.slice(0, 50) || '',
    cssSelector: generateUniqueSelector(el), // 需要实现: 通过 id/class/nth-child 生成唯一选择器
    xpath: getXPath(el), // 需要实现: 遍历 parentNode 生成 xpath
    type: el.type || undefined,
  };
}

function sendTraceEvent(event) {
  if (!traceActive) return;
  chrome.runtime.sendMessage({
    type: 'trace_event',
    payload: {
      ...event,
      timestamp: Date.now(),
      url: window.location.href,
    }
  });
}

document.addEventListener('click', (e) => {
  sendTraceEvent({
    type: 'click',
    element: getElementInfo(e.target),
    position: { x: e.clientX, y: e.clientY },
  });
}, true);

document.addEventListener('input', (e) => {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    const value = e.target.type === 'password' ? '********' : e.target.value;
    sendTraceEvent({
      type: 'fill',
      element: getElementInfo(e.target),
      value,
    });
  }, DEBOUNCE_INPUT);
}, true);

document.addEventListener('change', (e) => {
  if (e.target.type === 'checkbox' || e.target.type === 'radio') {
    sendTraceEvent({
      type: e.target.checked ? 'check' : 'uncheck',
      element: getElementInfo(e.target),
    });
  } else if (e.target.tagName === 'SELECT') {
    sendTraceEvent({
      type: 'select',
      element: getElementInfo(e.target),
      value: e.target.value,
    });
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (['Enter', 'Escape', 'Tab', 'Backspace', 'Delete'].includes(e.key) ||
      (e.ctrlKey || e.metaKey)) {
    sendTraceEvent({
      type: 'press',
      key: e.key,
      modifiers: {
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      },
      element: getElementInfo(e.target),
    });
  }
}, true);

document.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    sendTraceEvent({
      type: 'scroll',
      position: { x: window.scrollX, y: window.scrollY },
    });
  }, DEBOUNCE_SCROLL);
}, true);
```

**Step 2: bridge.js 中缓存 trace 事件**

```javascript
let traceEvents = [];
let traceActive = false;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'trace_event' && traceActive) {
    traceEvents.push(msg.payload);
  }
});

// 在 relay 消息处理中新增 trace 命令
case 'trace':
  if (params.action === 'start') {
    traceActive = true;
    traceEvents = [];
    // 向所有 content scripts 发送开始录制
    for (const [tabId] of attachedTabs) {
      chrome.tabs.sendMessage(tabId, { type: 'trace_start' });
    }
    return { status: 'recording' };
  }
  if (params.action === 'stop') {
    traceActive = false;
    const events = [...traceEvents];
    traceEvents = [];
    for (const [tabId] of attachedTabs) {
      chrome.tabs.sendMessage(tabId, { type: 'trace_stop' });
    }
    return { status: 'stopped', events, count: events.length };
  }
  if (params.action === 'status') {
    return { recording: traceActive, eventCount: traceEvents.length };
  }
```

**Step 3: 新增 MCP tool `trace`**

```typescript
{
  name: 'trace',
  description: 'Record user interactions on the page. Start recording, stop to get events.',
  arguments: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status'],
        description: 'start: begin recording, stop: end recording and return events, status: check recording state'
      }
    },
    required: ['action']
  }
}
```

**Step 4: manifest.json 注册新 content script**

```json
{
  "content_scripts": [
    // ... existing entries ...
    {
      "matches": ["<all_urls>"],
      "js": ["build/contentTrace.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**Step 5: webpack.config.js 新增 entry**

```javascript
contentTrace: "./src/content_trace.js",
```

**涉及文件**:
- `ext/src/content_trace.js` — 新建
- `ext/src/ai_bridge/bridge.js` — trace 事件缓存 + relay 命令
- `ext/manifest.json` — 注册 content script
- `ext/webpack.config.js` — 新 entry
- `mcp/src/mcp.ts` — trace tool schema + handler

**测试用例**:

```typescript
describe('trace tool', () => {
  it('start should return recording status', async () => {
    const result = await callTool('trace', { action: 'start' });
    assert.ok(result.text.includes('recording'));
  });

  it('stop should return events array', async () => {
    await callTool('trace', { action: 'start' });
    // 模拟用户操作...
    const result = await callTool('trace', { action: 'stop' });
    assert.ok(result.text.includes('events'));
  });

  it('status while not recording', async () => {
    const result = await callTool('trace', { action: 'status' });
    assert.ok(result.text.includes('"recording":false'));
  });
});
```

**端到端手动验证**:
1. `trace { action: "start" }` → 在浏览器中点击按钮、填写表单 → `trace { action: "stop" }` → 验证返回的事件列表
2. 验证密码字段脱敏 (`********`)
3. 验证 input 防抖 (快速打字 → 只产生一个 fill 事件)
4. `trace { action: "status" }` → 验证录制状态

---

### 3.2 `browser_fetch` 工具 — 带登录态的 fetch

**目标**: 在浏览器上下文中发 HTTP 请求，自动携带 cookie/session。

**设计**:

新增 MCP tool `browser_fetch`:

```typescript
{
  name: 'browser_fetch',
  description: 'Make HTTP requests in the browser context with the user\'s cookies and session.',
  arguments: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch (absolute or relative to current page)' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (default: GET)' },
      headers: { type: 'string', description: 'JSON string of custom headers' },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      max_body_size: { type: 'number', description: 'Max response body size in chars (default: 10000)' }
    },
    required: ['url']
  }
}
```

Handler — 使用 `Runtime.evaluate` 在页面上下文执行 fetch:

```typescript
case 'browser_fetch': {
  const url = args.url as string;
  const method = (args.method as string) || 'GET';
  const headers = args.headers as string | undefined;
  const body = args.body as string | undefined;
  const maxSize = (args.max_body_size as number) || 10000;

  // 注意: headers 必须 JSON.stringify 转义，防止代码注入
  const fetchCode = `
    (async () => {
      try {
        const resp = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          ${headers ? `headers: JSON.parse(${JSON.stringify(headers)}),` : ''}
          ${body ? `body: ${JSON.stringify(body)},` : ''}
          credentials: 'include'
        });
        const text = await resp.text();
        return JSON.stringify({
          status: resp.status,
          statusText: resp.statusText,
          headers: Object.fromEntries(resp.headers.entries()),
          body: text.slice(0, ${maxSize}),
          truncated: text.length > ${maxSize}
        });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `;

  const result = await evaluateJs(session, fetchCode);
  return { content: [{ type: 'text', text: result }] };
}
```

**涉及文件**:
- `mcp/src/mcp.ts` — tool schema + handler

**测试用例**:

```typescript
describe('browser_fetch', () => {
  it('should require url parameter', () => {
    const result = handleBrowserFetch({});
    assert.ok(result.isError);
  });

  it('should default to GET method', () => {
    // 验证生成的 fetch code 使用 GET
  });

  it('should truncate large responses', () => {
    // 验证 max_body_size 截断
  });
});
```

**手动验证**:
1. 在已登录页面: `browser_fetch { url: "/api/user/me" }` → 验证返回用户信息
2. POST 请求: `browser_fetch { url: "/api/data", method: "POST", body: "{\"key\":\"value\"}" }` → 验证
3. 跨域请求: `browser_fetch { url: "https://other.domain/api" }` → 验证 CORS 行为

---

### 3.3 Dialog 处理工具 (低优先级)

**目标**: 自动处理 `alert()`, `confirm()`, `prompt()` 弹窗。

**设计**: 在 MCP 进程中监听 CDP `Page.javascriptDialogOpening` 事件。

**实施**: 由于 `playwright_execute` 已经支持 `page.on('dialog')`, 此功能优先级低。可在需要时实现。

---

## Phase 4: 可选增强

### 4.1 协议类型统一到 shared 包

**当前状况**: `mcp/src/protocol.ts` 定义了部分类型，extension 使用字符串常量。

**方案**: 将 `protocol.ts` 中的类型定义提取为独立包或在 `mcp/src/protocol.ts` 中集中定义所有 relay ↔ extension 消息类型，extension 通过复制或 build 引用。

**风险**: 改动较大，需要修改 extension build pipeline。

### 4.2 Session tab 清理

**方案**: `release_tab` 增加 `close: true` 参数:

```typescript
case 'release_tab': {
  // ... existing lease release logic ...
  if (args.close) {
    // 通过 CDP 关闭 tab (注意: 不是 Browser.close，那是关闭整个浏览器)
    await sendCdpCommand(session, 'Target.closeTarget', { targetId });
  }
}
```

### 4.3 从 trace 事件自动生成 Playwright 测试脚本

**方案**: 在 `trace { action: "stop" }` 返回中，额外提供 `playwright_code` 字段:

```typescript
function traceToPlaywright(events: TraceEvent[]): string {
  return events.map(e => {
    switch (e.type) {
      case 'click': return `await page.locator('${e.element.cssSelector}').click();`;
      case 'fill': return `await page.locator('${e.element.cssSelector}').fill('${e.value}');`;
      case 'press': return `await page.keyboard.press('${e.key}');`;
      case 'scroll': return `await page.mouse.wheel(0, ${e.position.y});`;
      default: return `// ${e.type} event`;
    }
  }).join('\n');
}
```

---

## 实施优先级总览

| # | 特性 | 优先级 | 复杂度 | 涉及文件数 |
|---|------|--------|--------|-----------|
| 1.1 | 结构化错误格式 | 高 | 低 | 2 |
| 1.2 | `interactive_only` 参数 | 高 | 低 | 1 |
| 1.3 | Extension 状态持久化补充 | 中 | 低 | 1 |
| 2.1 | Snapshot @ref 编号 | 高 | 中 | 1 |
| 2.3 | `interact` tool | 高 | 中 | 1 |
| 3.1 | 操作录制 (trace) | 高 | 高 | 5 |
| 3.2 | `browser_fetch` | 中 | 低 | 1 |
| 3.3 | Dialog 处理 | 低 | 低 | 1 |
| 4.1 | 协议统一 | 低 | 高 | 多 |
| 4.2 | Tab 清理 | 低 | 低 | 2 |
| 4.3 | Trace → Playwright | 低 | 中 | 1 |

---

## 回归测试计划

现有测试套件 (`mcp/src/mcp.test.ts`) 包含 120+ 个 describe block，覆盖了核心功能。每个 Phase 的改动必须：
1. **不破坏现有测试** — 修改前后运行 `npx tsx --test mcp/src/mcp.test.ts` 全部通过
2. **新增对应回归测试** — 见下方详细清单

### 必须通过的现有关键测试（回归防护）

| 测试 describe | 覆盖区域 | 受影响的 Phase |
|-------------|---------|------------|
| `formatAXTreeAsText` (line 1440) | AX 树格式化 | Phase 2.1 (修改此函数) |
| `formatAXTreeAsText (edge cases)` (line 1709) | AX 树边界情况 | Phase 2.1 |
| `getInteractiveElements` (line 2764) | 可交互元素提取 | Phase 1.2, 2.1 |
| `formatLabelLegend` (line 2836) | 标签图例格式 | Phase 1.2 |
| `buildLabelInjectionScript` (line 2880) | 标签注入脚本 | Phase 2.1 (间接) |
| `computeSnapshotDiff` (line 2551) | 快照差异比对 | Phase 2.1 (需验证 @ref 前缀不影响 diff) |
| `searchSnapshot` (line 2640) | 快照搜索 | Phase 2.1 (需验证 @ref 前缀不影响搜索) |
| `Integration: All tool names are unique and complete` (line 4909) | tool 列表完整性 | Phase 2.3, 3.1, 3.2 (新增 tool 后需更新) |
| `Integration: tool action counts` (line 7553) | tool action 计数 | Phase 3.1 (新增 trace tool) |
| `reset clears all state including intercept` (line 5847) | reset 清理 | Phase 2.1 (refCache 也需清理) |

### 各 Phase 必须新增的测试

#### Phase 1.1 — 结构化错误格式

```typescript
// mcp/src/mcp.test.ts 中新增

describe('formatError – structured error formatting', () => {
  it('should include error, hint, and recovery', () => {
    const result = formatError({ error: 'CDP connection lost', hint: 'Tab may be closed', recovery: 'reset' });
    assert.ok(result.includes('Error: CDP connection lost'));
    assert.ok(result.includes('Hint: Tab may be closed'));
    assert.ok(result.includes('Recovery: call "reset" tool'));
  });

  it('should omit recovery when not provided', () => {
    const result = formatError({ error: 'Element not found', hint: 'Selector mismatch' });
    assert.ok(!result.includes('Recovery'));
  });

  it('should handle empty hint', () => {
    const result = formatError({ error: 'Timeout', hint: '' });
    assert.ok(result.includes('Error: Timeout'));
    // empty hint line should not be added
    const lines = result.split('\n');
    assert.equal(lines.length, 1);
  });
});
```

#### Phase 1.2 — `interactive_only` 参数

```typescript
describe('formatInteractiveSnapshot', () => {
  it('should format with @ref notation', () => {
    const elements = [
      { index: 1, role: 'button', name: '提交', backendDOMNodeId: 10 },
      { index: 2, role: 'textbox', name: '', backendDOMNodeId: 11 },
      { index: 3, role: 'link', name: 'Home', backendDOMNodeId: 12 },
    ];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('@1 [button] "提交"'));
    assert.ok(result.includes('@2 [textbox]'));
    assert.ok(result.includes('@3 [link] "Home"'));
    assert.ok(result.startsWith('Interactive elements (3):'));
  });

  it('should return fallback for no elements', () => {
    assert.equal(formatInteractiveSnapshot([]), 'No interactive elements found.');
  });

  it('should escape special chars in names', () => {
    const elements = [{ index: 1, role: 'button', name: 'Save & "Close"', backendDOMNodeId: 10 }];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('Save & "Close"'));
  });
});
```

#### Phase 2.1 — @ref 在 formatAXTreeAsText 中

```typescript
describe('formatAXTreeAsText – @ref assignment', () => {
  it('should assign @ref to interactive elements in tree', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Title' } },
      { nodeId: '3', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 42 },
    ];
    const text = formatAXTreeAsText(nodes, true);
    assert.ok(text.includes('@1'));
    assert.ok(text.includes('button "Submit"'));
    // heading should NOT have @ref
    assert.ok(!text.includes('@') || text.indexOf('@') === text.indexOf('@1'));
  });

  it('should NOT assign @ref when assignRefs=false', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'OK' }, backendDOMNodeId: 42 },
    ];
    const text = formatAXTreeAsText(nodes, false);
    assert.ok(!text.includes('@'));
  });

  it('should populate refCache when assigning refs', () => {
    refCache.clear();
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Go' }, backendDOMNodeId: 99 },
    ];
    formatAXTreeAsText(nodes, true);
    assert.equal(refCache.size, 1);
    assert.equal(refCache.get(1)?.backendDOMNodeId, 99);
    assert.equal(refCache.get(1)?.name, 'Go');
  });

  it('should clear refCache on each call', () => {
    refCache.set(999, { backendDOMNodeId: 1, role: 'button', name: 'old' });
    formatAXTreeAsText([], true);
    assert.ok(!refCache.has(999));
  });

  it('existing tests should still pass with assignRefs=false (backward compat)', () => {
    // 复制现有 formatAXTreeAsText 测试中的关键用例，用 assignRefs=false 验证输出不变
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'My Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Hello World' } },
    ];
    const text = formatAXTreeAsText(nodes, false);
    assert.ok(text.includes('RootWebArea "My Page"'));
    assert.ok(text.includes('  heading "Hello World"'));
  });

  it('should not break computeSnapshotDiff with @ref prefixes', () => {
    // 两次 snapshot，确保 @ref 编号不影响 diff 算法
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 42 },
    ];
    const snap1 = formatAXTreeAsText(nodes, true);
    const snap2 = formatAXTreeAsText(nodes, true);
    const diff = computeSnapshotDiff(snap1, snap2);
    assert.ok(diff.includes('No changes detected'));
  });
});
```

#### Phase 2.3 — interact tool

```typescript
describe('interact tool – ref validation', () => {
  it('should reject ref not in cache', () => {
    refCache.clear();
    // 模拟 handleToolCall
    const result = handleInteract({ ref: 42, action: 'click' });
    assert.ok(result.isError);
    assert.ok(result.text.includes('Ref @42 not found'));
    assert.ok(result.text.includes('Recovery'));
  });

  it('should reject unknown action', () => {
    refCache.set(1, { backendDOMNodeId: 10, role: 'button', name: 'OK' });
    const result = handleInteract({ ref: 1, action: 'invalidAction' });
    assert.ok(result.isError);
  });

  it('should accept valid ref and action combination', () => {
    refCache.set(1, { backendDOMNodeId: 10, role: 'button', name: 'Submit' });
    // 此测试需 mock sendCdpCommand
    // 验证返回包含 "Performed click on @1"
  });
});

describe('interact tool definition', () => {
  it('should have required params: ref and action', () => {
    const tool = tools.find(t => t.name === 'interact');
    assert.ok(tool);
    assert.deepStrictEqual(tool.inputSchema.required, ['ref', 'action']);
  });

  it('should have valid action enum', () => {
    const tool = tools.find(t => t.name === 'interact');
    const actionProp = tool.inputSchema.properties.action;
    assert.ok(actionProp.enum.includes('click'));
    assert.ok(actionProp.enum.includes('fill'));
    assert.ok(actionProp.enum.includes('hover'));
  });
});
```

#### Phase 3.1 — trace tool

```typescript
describe('trace tool definition', () => {
  it('should have action as required param', () => {
    const tool = tools.find(t => t.name === 'trace');
    assert.ok(tool);
    assert.deepStrictEqual(tool.inputSchema.required, ['action']);
  });

  it('should have valid action enum', () => {
    const tool = tools.find(t => t.name === 'trace');
    const actionProp = tool.inputSchema.properties.action;
    assert.deepStrictEqual(actionProp.enum, ['start', 'stop', 'status']);
  });
});

describe('trace – content script helpers', () => {
  it('generateUniqueSelector should handle element with id', () => {
    // JSDOM 或模拟 DOM 测试
  });

  it('generateUniqueSelector should handle nested element without id', () => {
    // JSDOM 或模拟 DOM 测试
  });

  it('getXPath should generate valid xpath', () => {
    // JSDOM 或模拟 DOM 测试
  });
});
```

#### Phase 3.2 — browser_fetch tool

```typescript
describe('browser_fetch tool definition', () => {
  it('should have url as required param', () => {
    const tool = tools.find(t => t.name === 'browser_fetch');
    assert.ok(tool);
    assert.deepStrictEqual(tool.inputSchema.required, ['url']);
  });
});

describe('browser_fetch – code generation', () => {
  it('should generate valid fetch code for GET', () => {
    const code = generateFetchCode({ url: '/api/me', method: 'GET', maxSize: 10000 });
    assert.ok(code.includes('fetch("/api/me"'));
    assert.ok(code.includes("method: \"GET\""));
    assert.ok(code.includes("credentials: 'include'"));
  });

  it('should escape URL in generated code', () => {
    const code = generateFetchCode({ url: '/api/search?q=hello"world', method: 'GET', maxSize: 10000 });
    assert.ok(!code.includes('hello"world')); // should be escaped
  });

  it('should truncate response body', () => {
    const code = generateFetchCode({ url: '/api', method: 'GET', maxSize: 100 });
    assert.ok(code.includes('.slice(0, 100)'));
  });

  it('should safely handle headers parameter (no code injection)', () => {
    const code = generateFetchCode({
      url: '/api',
      method: 'POST',
      headers: '{"Content-Type": "application/json"}',
      maxSize: 10000
    });
    assert.ok(code.includes('JSON.parse'));
  });
});
```

### 运行测试命令

```bash
# 运行所有 MCP 测试
npx tsx --test mcp/src/mcp.test.ts

# 运行所有测试文件
npx tsx --test mcp/src/*.test.ts

# 运行特定测试 (过滤)
npx tsx --test --test-name-pattern="formatAXTreeAsText" mcp/src/mcp.test.ts
npx tsx --test --test-name-pattern="interact" mcp/src/mcp.test.ts
```

### 每个 Phase 完成时的检查清单

- [ ] 所有现有测试通过 (`npx tsx --test mcp/src/*.test.ts`)
- [ ] 新增测试全部通过
- [ ] `tsc --noEmit` 无类型错误
- [ ] Extension build 成功 (`cd ext && npm run build`)
- [ ] 手动在浏览器中验证核心功能（screenshot, accessibility_snapshot, execute, playwright_execute）仍正常工作
- [ ] SKILL.md 和 cursor-rules 更新（如新增了 tool）

---

## 风险与注意事项

1. **Ref 缓存失效**: 页面导航或 DOM 变化后，`backendDOMNodeId` 可能失效。`interact` tool 应在操作失败时提示 agent 重新运行 `accessibility_snapshot`。

2. **Content Script 注入时机**: `content_trace.js` 需要在 `document_idle` 后注入，SPA 页面的动态内容可能需要 MutationObserver 补充。

3. **Trace 数据量**: 长时间录制可能产生大量事件，应在 bridge.js 中设置上限 (e.g. 10000 events) 并自动淘汰最早的事件。

4. **browser_fetch 安全性**: 浏览器的 CORS 策略仍然生效。Agent 应理解某些跨域请求会被浏览器阻止。

5. **MCP Tool 数量增长**: 新增 `interact`, `trace`, `browser_fetch` 后，tool 总数从 27 增长到 30。注意保持 tool 描述简洁，避免 LLM context 膨胀。

6. **interact fill 操作的跨平台兼容**: `Input.dispatchKeyEvent` 的 `modifiers: 2` 代表 Ctrl 键 (Windows/Linux)。macOS 上应使用 `modifiers: 4` (Meta)。建议检测 `navigator.platform` 或统一使用 `DOM.setFileInputFiles` / `Runtime.callFunctionOn` 来设置值。

7. **Trace content script 的 SPA 兼容性**: single-spa 微前端架构中，子应用的 DOM 可能在 content script 注入后才挂载。content_trace.js 使用 document 级事件委托 (capturing phase)，可以捕获动态添加的元素事件，因此兼容 SPA。

8. **browser_fetch 的 `await` 超时**: `evaluateJs` 中的 fetch 可能长时间挂起（如服务器无响应）。应在 fetchCode 内添加 AbortController 超时，或依赖 `sendCdpCommand` 的外层超时。
