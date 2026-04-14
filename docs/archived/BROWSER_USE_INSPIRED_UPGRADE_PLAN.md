# 从 browser-use 借鉴的 spawriter 架构升级方案

> **背景**：[browser-use](https://github.com/browser-use/browser-use) 是一个 Python LLM 浏览器代理框架，使用 CDP 驱动 Chromium，提供了成熟的事件驱动架构、DOM 序列化、工具注册、HAR 录制、Cloud 抽象、Target 生命周期管理和多层容错机制。本文档基于对两个项目源码的逐行分析，提出 7 项可借鉴的升级方案。

---

## 目录

1. [事件驱动 Watchdog 架构（拆分 mcp.ts）](#1-事件驱动-watchdog-架构拆分-mcpts)
2. [结构化元素索引系统](#2-结构化元素索引系统)
3. [Tool Registry 自动注册模式](#3-tool-registry-自动注册模式)
4. [HAR 录制与导出](#4-har-录制与导出)
5. [远程/Cloud 浏览器抽象层](#5-远程cloud-浏览器抽象层)
6. [CDP Target 生命周期主动管理](#6-cdp-target-生命周期主动管理)
7. [多层重试与容错策略](#7-多层重试与容错策略)

---

## 1. 事件驱动 Watchdog 架构（拆分 mcp.ts）

### 问题

`mcp/src/mcp.ts` 目前 **3,012 行**，混合了 10+ 个不同的关注点：

| 行范围（约） | 关注点 |
|-------------|--------|
| 1–33 | 导入、全局类型 |
| 38–100 | 多 Agent session 管理 |
| 105–150 | Console 日志缓冲 |
| 152–264 | Network 日志 + Fetch 拦截 |
| 266–352 | CDP 事件分发 |
| 354–794 | Relay 管理 + CDP 连接 + Lease |
| 796–881 | JS 执行 + AX 格式化 |
| 883–955 | 快照 diff + 调试器事件 + Lease 事件 |
| 1014–1075 | 标注截图辅助函数 |
| 1077–1491 | MCP tools 数组定义 |
| 1493–2961 | CallTool 分发（if/switch 链） |
| 2963–3012 | MCP 服务器生命周期 |

新增一个工具需要在 **3 个位置** 同步修改（tools 数组 + dispatch 分支 + 实现逻辑），极易遗漏。

### browser-use 的做法

browser-use 使用 `bubus.EventBus` + `BaseWatchdog` 基类实现完全解耦：

```python
# browser_use/browser/watchdog_base.py (简化)
class BaseWatchdog(BaseModel):
    LISTENS_TO: ClassVar[list[type[BaseEvent]]] = []
    EMITS: ClassVar[list[type[BaseEvent]]] = []

    event_bus: EventBus
    browser_session: BrowserSession

    def attach_to_session(self) -> None:
        # 自动扫描 on_* 方法，匹配事件类，注册到 event_bus
        for name in dir(self):
            if name.startswith('on_'):
                event_cls = events_map.get(name[3:])
                if event_cls:
                    self.event_bus.on(event_cls, getattr(self, name))
```

每个 Watchdog 独立一个文件，职责单一：

| Watchdog | 文件 | 职责 |
|----------|------|------|
| `DOMWatchdog` | `dom_watchdog.py` | DOM 树构建、序列化、元素缓存 |
| `ScreenshotWatchdog` | `screenshot_watchdog.py` | 截图捕获 |
| `DefaultActionWatchdog` | `default_action_watchdog.py` | 点击、输入、滚动等交互 |
| `HarRecordingWatchdog` | `har_recording_watchdog.py` | HAR 录制 |
| `DownloadsWatchdog` | `downloads_watchdog.py` | 下载管理 |
| `SecurityWatchdog` | `security_watchdog.py` | URL 安全检查 |
| `StorageStateWatchdog` | `storage_state_watchdog.py` | Cookie/存储状态管理 |
| `PopupsWatchdog` | `popups_watchdog.py` | 对话框处理 |
| `CrashWatchdog` | `crash_watchdog.py` | Target 崩溃监控 |
| `CaptchaWatchdog` | `captcha_watchdog.py` | 验证码检测 |
| `RecordingWatchdog` | `recording_watchdog.py` | 视频录制 |

生命周期清晰：`BrowserSession.start()` → `dispatch(BrowserStartEvent)` → `attach_all_watchdogs()` → 每个 watchdog `attach_to_session()` → 事件驱动运行 → `BrowserStopEvent` → `event_bus.stop(clear=True)` → 清理。

### spawriter 升级方案

#### 目标目录结构

```
mcp/src/
├── mcp.ts                    # 精简为：MCP Server 生命周期 + tool dispatch 入口
├── handlers/
│   ├── base-handler.ts       # BaseHandler 抽象类
│   ├── console-handler.ts    # Console 日志缓冲 + 查询
│   ├── network-handler.ts    # Network 日志 + 详情 + Fetch 拦截
│   ├── screenshot-handler.ts # 截图 + 标注
│   ├── accessibility-handler.ts # AX 树 + diff/search
│   ├── debugger-handler.ts   # 调试器状态 + 断点管理
│   ├── editor-handler.ts     # 源码/样式实时编辑
│   ├── storage-handler.ts    # Cookie/localStorage/sessionStorage
│   ├── performance-handler.ts # 性能指标
│   ├── emulation-handler.ts  # 设备模拟
│   ├── page-content-handler.ts # DOM 内容查询
│   ├── single-spa-handler.ts # dashboard_state + override_app + app_action
│   ├── navigation-handler.ts # navigate + ensure_fresh_render + clear_cache_and_reload
│   ├── tab-handler.ts        # list_tabs + switch_tab + connect_tab + release_tab
│   ├── execution-handler.ts  # execute + playwright_execute + session_manager
│   └── core-handler.ts       # reset + 全局状态清理/恢复
├── cdp/
│   ├── session.ts            # CdpSession 类型 + sendCdpCommand + evaluateJs
│   ├── connection.ts         # connectCdp + 心跳 + 重连
│   └── event-router.ts       # handleCdpEvent → 分发到各 handler
├── agents/
│   ├── agent-session.ts      # 多 Agent session 管理
│   └── lease-manager.ts      # Tab lease 逻辑
├── relay.ts                  # 不变
├── pw-executor.ts            # 不变
├── protocol.ts               # 不变
├── utils.ts                  # 不变
└── cli.ts                    # 不变
```

#### BaseHandler 设计

```typescript
// mcp/src/handlers/base-handler.ts

import { CdpSession } from '../cdp/session.js';

export interface HandlerContext {
  agentId?: string;
  resolveSession: (agentId?: string) => Promise<CdpSession>;
  getActiveSession: (agentId?: string) => CdpSession | null;
  invalidateSessionByTargetId: (targetId: string) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export abstract class BaseHandler {
  /**
   * 声明此 handler 提供的 MCP tools。
   * 替代手写 tools 数组中的对应条目。
   */
  abstract getTools(): ToolDefinition[];

  /**
   * 处理 tool 调用。返回 undefined 表示此 handler 不处理该 tool。
   */
  abstract handleTool(
    name: string,
    args: Record<string, unknown>,
    ctx: HandlerContext
  ): Promise<ToolResult | undefined>;

  /**
   * 订阅 CDP 事件。在 CDP 连接建立后调用。
   * 替代 handleCdpEvent 中的 if/else 链。
   */
  onCdpEvent?(method: string, params: Record<string, unknown>, ctx: HandlerContext): void | Promise<void>;

  /**
   * 当 CDP 连接断开或 tab 切换时清理状态。
   * 替代 switch_tab 中散布的清理代码。
   */
  onSessionClear?(): void;

  /**
   * 启用所需的 CDP 域（在连接后调用）。
   */
  enableDomains?(session: CdpSession): Promise<void>;
}
```

#### 迁移示例：ConsoleHandler

```typescript
// mcp/src/handlers/console-handler.ts

import { BaseHandler, ToolDefinition, ToolResult } from './base-handler.js';
import { CdpSession } from '../cdp/session.js';

interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
}

const MAX_CONSOLE_LOGS = 1000;

export class ConsoleHandler extends BaseHandler {
  private logs: ConsoleEntry[] = [];

  getTools(): ToolDefinition[] {
    return [{
      name: 'console_logs',
      description: 'Get captured browser console logs with filtering',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of recent logs to return (default: 50)' },
          level: { type: 'string', description: 'Filter by level: log, warn, error, info, debug' },
          search: { type: 'string', description: 'Search text filter' },
          clear: { type: 'boolean', description: 'Clear logs after reading' },
        },
      },
    }];
  }

  async handleTool(
    name: string,
    args: Record<string, unknown>,
    _ctx: HandlerContext,
  ): Promise<ToolResult | undefined> {
    if (name !== 'console_logs') return undefined;

    let filtered = [...this.logs];
    if (args.level) filtered = filtered.filter(l => l.level === args.level);
    if (args.search) {
      const s = String(args.search).toLowerCase();
      filtered = filtered.filter(l => l.text.toLowerCase().includes(s));
    }

    const count = Number(args.count) || 50;
    const result = filtered.slice(-count);

    if (args.clear) this.logs = [];

    return {
      content: [{
        type: 'text',
        text: result.length === 0
          ? 'No console logs captured.'
          : result.map(l => `[${l.level}] ${l.text}`).join('\n'),
      }],
    };
  }

  onCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = (params.args as Array<{ value?: string; description?: string }>) || [];
      this.logs.push({
        level: String(params.type || 'log'),
        text: args.map(a => a.value ?? a.description ?? '').join(' '),
        timestamp: Date.now(),
      });
      if (this.logs.length > MAX_CONSOLE_LOGS) {
        this.logs = this.logs.slice(-MAX_CONSOLE_LOGS);
      }
    }
    if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails as Record<string, unknown> | undefined;
      this.logs.push({
        level: 'error',
        text: `Exception: ${detail?.text || JSON.stringify(detail)}`,
        timestamp: Date.now(),
      });
    }
  }

  onSessionClear(): void {
    this.logs = [];
  }
}
```

#### 注册和分发

```typescript
// mcp/src/mcp.ts (精简后的核心)

import { ConsoleHandler } from './handlers/console-handler.js';
import { NetworkHandler } from './handlers/network-handler.js';
import { ScreenshotHandler } from './handlers/screenshot-handler.js';
// ...

const handlers: BaseHandler[] = [
  new ConsoleHandler(),
  new NetworkHandler(),
  new ScreenshotHandler(),
  new AccessibilityHandler(),
  new DebuggerHandler(),
  new EditorHandler(),
  new StorageHandler(),
  new PerformanceHandler(),
  new EmulationHandler(),
  new PageContentHandler(),
  new SingleSpaHandler(),
  new NavigationHandler(),
  new TabHandler(),
  new ExecutionHandler(),
  new CoreHandler(),
];

// 自动收集所有 tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: handlers.flatMap(h => h.getTools()),
}));

// 自动分发 tool 调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  for (const handler of handlers) {
    const result = await handler.handleTool(name, args, handlerContext);
    if (result) return result;
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

// CDP 事件自动路由
async function routeCdpEventToHandlers(method: string, params: Record<string, unknown>): Promise<void> {
  for (const handler of handlers) {
    await handler.onCdpEvent?.(method, params, handlerContext);
  }
}
```

### 迁移策略

**阶段 1**（低风险）：提取 `cdp/session.ts` 和 `cdp/connection.ts`，不改变行为。

**阶段 2**（中风险）：逐个提取 handler，每提取一个跑测试验证：
1. `ConsoleHandler` → 最简单，纯内存缓冲
2. `NetworkHandler` → 包含 Fetch 拦截，状态较多
3. `DebuggerHandler` → 包含断点、暂停状态
4. `ScreenshotHandler` + `AccessibilityHandler`
5. 其余 handler

**阶段 3**：重构 dispatch 逻辑为 handler 链。

### 注意事项

> **Handler 拆分需覆盖全量工具**：除 `console/network/screenshot/...` 等明显的功能 handler 外，还必须显式覆盖 `execute`、`playwright_execute`、`session_manager`、`list_tabs`、`switch_tab`、`connect_tab`、`release_tab`、`reset` 等工具（上方目录结构已包含 `execution-handler.ts`、`tab-handler.ts`、`core-handler.ts`）。拆分时不可遗漏任何现有 tool。

### 预期收益

- `mcp.ts` 从 3,012 行降至 ~500 行（仅保留连接管理 + 注册 + 分发）
- 新增工具只需新建一个 handler 文件
- 状态隔离清晰：每个 handler 管自己的状态，`onSessionClear()` 统一清理
- 可测试性：每个 handler 可独立单元测试

---

## 2. 结构化元素索引系统

### 问题

spawriter 当前提供两种元素识别方式：
1. `screenshot { labels: true }` —— 在截图上叠加数字标签
2. `accessibility_snapshot` —— 返回 AX 树文本

AI 要操作元素时只能通过 `execute` 写 CSS selector 或通过 `playwright_execute` 用 Playwright locator。这存在两个问题：
- **Selector 脆弱**：页面结构变化就失效
- **LLM 猜测**：AI 从截图或 AX 文本推断 selector，准确率不高

### browser-use 的做法

browser-use 构建了一套完整的**索引元素系统**：

**步骤 1：构建增强 DOM 树**

```python
# browser_use/dom/service.py — 并行获取三棵树后合并
async def _get_dom_tree_data(self, target_id):
    tasks = {
        'snapshot': DOMSnapshot.captureSnapshot(...),
        'dom_tree': DOM.getDocument(pierce=True),
        'ax_tree': Accessibility.getFullAXTree(...),  # 每个 frame 单独获取
        'device_pixel_ratio': Runtime.evaluate('window.devicePixelRatio'),
    }
    done, pending = await asyncio.wait(tasks.values(), timeout=10.0)
    # 重试超时任务...
```

**步骤 2：合并为 `EnhancedDOMTreeNode`**

每个节点包含来自三棵树的信息：

```python
@dataclass(slots=True)
class EnhancedDOMTreeNode:
    # DOM
    node_id: int
    backend_node_id: int       # Chrome CDP 分配的稳定 ID
    node_type: NodeType
    tag_name: str
    attributes: dict[str, str]
    # AX
    ax_node: EnhancedAXNode    # role, name, properties
    # Snapshot
    snapshot_node: EnhancedSnapshotNode  # bounds, clientRects, computed_styles
    # 计算属性
    absolute_position: DOMRect
    is_visible: bool
    has_js_click_listener: bool
```

**步骤 3：识别可交互元素**

`ClickableElementDetector.is_interactive()` 使用多维度启发式：

```python
# browser_use/dom/serializer/clickable_elements.py
class ClickableElementDetector:
    def is_interactive(self, node: EnhancedDOMTreeNode) -> bool:
        # 原生交互元素：button, input, select, textarea, a[href]
        # ARIA roles：button, link, menuitem, tab, switch, ...
        # 属性：onclick, tabindex, contenteditable
        # AX 属性：focusable, editable
        # 样式：cursor: pointer
        # JS 监听器：addEventListener('click', ...)
        # iframe（大于阈值尺寸）
        # label 包裹的 form control
```

**步骤 4：序列化为 LLM 可读格式**

```python
# 输出示例（LLM 看到的格式）：
# [12345]<button>Submit</button>
# [12346]<input type="text" placeholder="Search...">
# [12347]<a href="/settings">Settings</a>
```

`[12345]` 就是 `backend_node_id`，LLM 在 action 参数中传回这个数字。

**步骤 5：通过索引执行操作**

```python
# browser_use/browser/session.py
async def get_dom_element_by_index(self, index: int) -> EnhancedDOMTreeNode:
    return self._cached_selector_map.get(index)

# browser_use/tools/service.py — click action
async def click(params, browser_session):
    assert params.index != 0
    element = await browser_session.get_dom_element_by_index(params.index)
    browser_session.event_bus.dispatch(ClickElementEvent(element=element))
```

### spawriter 升级方案

#### 新增 `get_interactive_elements` 工具

```typescript
// mcp/src/handlers/accessibility-handler.ts（扩展）

interface InteractiveElement {
  index: number;          // 用于引用的会话内短时索引（非跨快照稳定 ID）
  backendNodeId: number;  // Chrome CDP backend_node_id
  role: string;           // AX role: button, link, textbox, ...
  name: string;           // AX accessible name
  tag: string;            // HTML tag: button, input, a, ...
  bounds: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;  // href, placeholder, type, ...
  value?: string;         // 当前值（input/select）
}
```

实现步骤：

```typescript
async function getInteractiveElements(session: CdpSession): Promise<InteractiveElement[]> {
  // 1. 获取 AX 树
  const { nodes } = await sendCdpCommand(session, 'Accessibility.getFullAXTree', {
    depth: -1,
  });

  // 2. 过滤可交互节点
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'menuitem', 'tab', 'switch',
    'slider', 'spinbutton', 'searchbox', 'option',
  ]);

  const interactiveNodes = nodes.filter((node: AXNode) => {
    const role = node.role?.value;
    if (!role) return false;
    if (interactiveRoles.has(role)) return true;
    if (node.properties?.some((p: AXProperty) =>
      p.name === 'focusable' && p.value?.value === true
    )) return true;
    return false;
  });

  // 3. 获取每个节点的 box model
  const elements: InteractiveElement[] = [];
  for (const [i, node] of interactiveNodes.entries()) {
    const backendNodeId = node.backendDOMNodeId;
    if (!backendNodeId) continue;

    try {
      const { model } = await sendCdpCommand(session, 'DOM.getBoxModel', {
        backendNodeId,
      });

      // 4. 获取 HTML 属性
      const { node: domNode } = await sendCdpCommand(session, 'DOM.describeNode', {
        backendNodeId,
      });

      const attrs: Record<string, string> = {};
      const attrList = domNode.attributes || [];
      for (let j = 0; j < attrList.length; j += 2) {
        attrs[attrList[j]] = attrList[j + 1];
      }

      elements.push({
        index: elements.length + 1,
        backendNodeId,
        role: node.role.value,
        name: node.name?.value || '',
        tag: domNode.nodeName.toLowerCase(),
        bounds: {
          x: model.content[0],
          y: model.content[1],
          width: model.width,
          height: model.height,
        },
        attributes: attrs,
        value: node.value?.value,
      });
    } catch {
      // 节点可能不可见或已被移除
    }
  }

  return elements;
}
```

> 实施备注：`index` 应被视为“当前快照中的临时引用号”。真正稳定键应使用 `backendNodeId`，并在 `click_element` / `type_element` 执行前做一次“索引 → backendNodeId”重验证，避免 DOM 变化导致误点。

#### 新增 `click_element` 和 `type_element` 工具

```typescript
// get_interactive_elements 返回索引后，AI 可以用：

// click_element { index: 5 }
// → 通过 backendNodeId 找到元素
// → DOM.getBoxModel 获取中心坐标
// → Input.dispatchMouseEvent 点击

// type_element { index: 3, text: "hello" }
// → 先 click 聚焦
// → Input.dispatchKeyEvent 逐字输入
```

这些工具可以与现有的 `execute` / `playwright_execute` 并存——简单操作用索引工具（精确、低 token），复杂操作（拖拽、多步交互）用 Playwright。

#### 与现有标注截图的协同

`screenshot { labels: true }` 继续工作，但标签数字改为使用 `get_interactive_elements` 返回的相同索引号，确保 AI 看到的截图标签和索引一一对应。

### 注意事项

> **索引语义要谨慎**：`index` 应视作"快照内短时引用"（每次 `get_interactive_elements` 调用重新分配），`backendNodeId` 才是跨快照稳定键。执行 `click_element` / `type_element` 前应做一次映射重验证（确认 index 对应的 backendNodeId 仍有效），防止页面 DOM 变化导致操作错误元素。

### 预期收益

- AI 操作元素从"猜 selector"变为"指定索引号"，准确率大幅提升
- 消除 selector 脆弱性问题
- 减少 AI 需要的 token 数（不用生成复杂 selector 表达式）
- 标注截图 + 索引列表 + 索引操作形成闭环

---

## 3. Tool Registry 自动注册模式

### 问题

spawriter 当前的 tool 定义是一个手写的 JSON Schema 大数组（`const tools = [...]`，约 400 行），dispatch 是一个 `if/switch` 链（约 1,400 行）。这导致：

1. **三点同步**：新增 tool 需改 tools 数组 + dispatch 分支 + 实现逻辑
2. **Schema 漂移**：inputSchema 和实际参数处理可能不一致
3. **无类型安全**：参数从 `args` 对象手动取值，无编译时检查

### browser-use 的做法

`Registry` 类通过装饰器 + 函数签名自省自动生成一切：

```python
# browser_use/tools/registry/service.py

class Registry:
    def action(self, description: str, param_model=None, terminates_sequence=False):
        def decorator(func):
            # 自动从函数签名生成 Pydantic schema
            normalized_func, actual_param_model = self._normalize_action_function_signature(
                func, description, param_model
            )
            self.registry.actions[func.__name__] = RegisteredAction(
                name=func.__name__,
                description=description,
                function=normalized_func,
                param_model=actual_param_model,
            )
            return normalized_func
        return decorator

    def _normalize_action_function_signature(self, func, desc, param_model):
        if not param_model:
            # Type B：从签名自动生成
            params_dict = {}
            for param in action_params:
                annotation = param.annotation if param.annotation != Parameter.empty else str
                default = ... if param.default == Parameter.empty else param.default
                params_dict[param.name] = (annotation, default)
            param_model = create_model(f'{func.__name__}_Params', __base__=ActionModel, **params_dict)
        return normalized_func, param_model

    async def execute_action(self, action_name, params, browser_session, ...):
        action = self.registry.actions[action_name]
        validated_params = action.param_model(**params)  # Pydantic 验证
        special_context = {
            'browser_session': browser_session,
            'file_system': file_system,
            # ... 自动注入
        }
        return await action.function(params=validated_params, **special_context)
```

注册工具只需一个装饰器：

```python
@self.registry.action('Navigate to a URL')
async def navigate(url: str, new_tab: bool = False, browser_session: BrowserSession = None):
    event = browser_session.event_bus.dispatch(NavigateToUrlEvent(url=url, new_tab=new_tab))
    await event
```

`url` 和 `new_tab` 自动变成 JSON Schema，`browser_session` 被识别为"特殊注入参数"不出现在 schema 中。

### spawriter 升级方案

#### ToolRegistry 类

```typescript
// mcp/src/tool-registry.ts

import { z, ZodObject, ZodRawShape } from 'zod';

interface RegisteredTool<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<S>;
  handler: (params: z.infer<ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
  requiresSession: boolean;
}

interface ToolContext {
  session: CdpSession;
  sendCommand: typeof sendCdpCommand;
  evaluateJs: typeof evaluateJs;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register<S extends ZodRawShape>(config: {
    name: string;
    description: string;
    schema: ZodObject<S>;
    requiresSession?: boolean;
    handler: (params: z.infer<ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
  }): void {
    this.tools.set(config.name, {
      ...config,
      requiresSession: config.requiresSession ?? true,
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Invalid params: ${parsed.error.message}` }],
        isError: true,
      };
    }

    return tool.handler(parsed.data, ctx);
  }
}
```

#### 使用方式

```typescript
// mcp/src/handlers/screenshot-handler.ts

const screenshotSchema = z.object({
  labels: z.boolean().optional().describe('Add numbered labels to interactive elements'),
});

export function registerScreenshotTools(registry: ToolRegistry): void {
  registry.register({
    name: 'screenshot',
    description: 'Capture page screenshot, optionally with numbered labels on interactive elements',
    schema: screenshotSchema,
    handler: async (params, ctx) => {
      let result = await ctx.sendCommand(ctx.session, 'Page.captureScreenshot', {
        format: 'png',
        quality: 75,
      });

      if (params.labels) {
        // 注入标注脚本...
        result = await ctx.sendCommand(ctx.session, 'Page.captureScreenshot', { ... });
      }

      return {
        content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
      };
    },
  });
}
```

#### 与 Handler 模式的关系：二选一 + 渐进迁移

> **注意**：`BaseHandler`（第 1 节）和 `ToolRegistry`（本节）是同一个"tool dispatch 职责"的两种实现方案，**不应同时并存于最终架构中**。推荐路径：
>
> | 阶段 | 方案 | 说明 |
> |------|------|------|
> | Phase 1 | `BaseHandler.getTools()` + `BaseHandler.handleTool()` | 先拆分 mcp.ts，用手写 JSON Schema，降低一次性改动量 |
> | Phase 3 | `ToolRegistry` + Zod schema 替换 `getTools/handleTool` | Handler 仍管 CDP 事件/状态/生命周期，tool 定义和 dispatch 交给 `ToolRegistry` |
>
> Phase 3 迁移后，`BaseHandler` 不再需要 `getTools()` 和 `handleTool()` 方法，改为在构造器中向共享 `ToolRegistry` 注册：

```typescript
abstract class BaseHandler {
  // Phase 3 后只保留这些职责：
  abstract onCdpEvent?(method: string, params: Record<string, unknown>, ctx: HandlerContext): void;
  abstract onSessionClear?(): void;
  abstract enableDomains?(session: CdpSession): Promise<void>;

  // tool 注册移至 ToolRegistry（在构造器中调用）
  protected registerTools(registry: ToolRegistry): void { /* 子类 override */ }
}

class ConsoleHandler extends BaseHandler {
  constructor(registry: ToolRegistry) {
    super();
    registry.register({
      name: 'console_logs',
      description: '...',
      schema: consoleLogsSchema,
      handler: (params) => this.handleConsoleLogs(params),
    });
  }
}
```

### 依赖选择

- **Zod**（推荐）：spawriter 可以引入 `zod` + `zod-to-json-schema` 实现类型安全的 schema 定义
- **或手写**：如果不想加依赖，可以用 TypeScript interface + 手写转换函数

### 预期收益

- 新增 tool 只需在一个地方写 schema + handler
- Zod 在运行时验证参数，编译时类型检查
- schema 和实现不可能漂移
- 可以自动生成 tool 文档

---

## 4. HAR 录制与导出

### 问题

spawriter 的 `networkLog` 是内存中的 Map（上限 500 条），不支持导出、持久化或标准格式。调试完关掉就没了。

### browser-use 的做法

`HarRecordingWatchdog` 实现了完整的 HAR 1.2 录制：

```python
# browser_use/browser/watchdogs/har_recording_watchdog.py

class HarRecordingWatchdog(BaseWatchdog):
    LISTENS_TO = [BrowserConnectedEvent, BrowserStopEvent]

    async def on_BrowserConnectedEvent(self, event):
        # 启用 Network + Page 域
        await cdp.send.Network.enable(...)
        await cdp.send.Page.enable(...)

        # 注册 CDP 回调
        cdp.register.Network.requestWillBeSent(self._on_request_will_be_sent)
        cdp.register.Network.responseReceived(self._on_response_received)
        cdp.register.Network.dataReceived(self._on_data_received)
        cdp.register.Network.loadingFinished(self._on_loading_finished)
        cdp.register.Network.loadingFailed(self._on_loading_failed)
        cdp.register.Page.lifecycleEvent(self._on_lifecycle_event)

    async def on_BrowserStopEvent(self, event):
        await self._write_har()  # 写入 HAR JSON
```

关键设计决策：

1. **HTTPS only**：过滤掉 data:、blob:、chrome-extension: 等 URL
2. **三种内容模式**：`embed`（内联 base64）、`attach`（sidecar 文件）、`omit`（不保存 body）
3. **`Network.getResponseBody` 优先**：比 `dataReceived` 流式拼接更可靠
4. **原子写入**：先写 `.tmp` 文件再 rename，防止中途崩溃导致文件损坏
5. **HAR 1.2 标准格式**：可直接在 Chrome DevTools、Charles、Fiddler 中打开

### spawriter 升级方案

在 `NetworkHandler` 中增加 HAR 导出能力，复用现有的 `networkLog` 数据：

```typescript
// 新增 network_log action: "export_har"

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text?: string; encoding?: string };
    headersSize: number;
    bodySize: number;
  };
  timings: { send: number; wait: number; receive: number };
}

function buildHarFromNetworkLog(networkLog: Map<string, NetworkEntry>): object {
  const entries: HarEntry[] = [];

  const toHarHeaders = (h?: Record<string, string>) =>
    Object.entries(h || {}).map(([name, value]) => ({ name, value }));

  for (const [, entry] of networkLog) {
    entries.push({
      startedDateTime: new Date(entry.startTime).toISOString(),
      time: entry.endTime ? Math.max(0, entry.endTime - entry.startTime) : 0,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(entry.requestHeaders),
        queryString: parseQueryString(entry.url),
        postData: entry.postData
          ? { mimeType: entry.requestHeaders?.['content-type'] || '', text: entry.postData }
          : undefined,
        headersSize: -1,
        bodySize: entry.postData?.length ?? -1,
      },
      response: {
        status: entry.status || 0,
        statusText: entry.statusText || '',
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(entry.responseHeaders),
        content: {
          size: entry.size || 0,
          mimeType: entry.mimeType || '',
        },
        headersSize: -1,
        bodySize: entry.size ?? -1,
      },
      timings: {
        send: 0,
        wait: entry.endTime ? Math.max(0, entry.endTime - entry.startTime) : 0,
        receive: 0,
      },
    });
  }

  return {
    log: {
      version: '1.2',
      creator: { name: 'spawriter', version: VERSION },
      entries,
    },
  };
}
```

工具 schema 扩展（建议新增独立工具，避免破坏 `network_log` 现有合约）：

```typescript
// export_har {}
// → 返回 HAR JSON 字符串，AI 可以保存到文件

// export_har { save_path: "/tmp/debug.har", include_bodies: true }
// → 直接写入文件（需要 Node.js fs 访问）
```

### 实现优先级

1. **Phase 1**：基于现有 `networkLog` 生成 metadata-only HAR（headers/status/timing）
2. **Phase 2**：按需补拉 response body（按 requestId 调 `Network.getResponseBody`，可通过 `include_bodies` 开关控制）
3. **Phase 3**：支持持续录制模式（自动保存到文件）

### 预期收益

- 调试网络问题时可以导出标准 HAR 文件
- 可在 Chrome DevTools → Network → Import HAR 中查看
- 可以共享给其他开发者复现问题

---

## 5. 远程/Cloud 浏览器抽象层

### 问题

spawriter 强绑定到本地 Chrome 扩展 + relay 的路径。在 CI/CD、远程调试、团队共享等场景下无法使用。

### browser-use 的做法

browser-use 在 `BrowserSession.start()` 中通过一个简单的分支实现本地/云端统一：

```python
# browser_use/browser/session.py

async def on_BrowserStartEvent(self, event):
    if not self.cdp_url:
        if self.browser_profile.use_cloud:
            # 调用云端 API 获取 cdpUrl
            cloud_response = await self._cloud_browser_client.create_browser(params)
            self.browser_profile.cdp_url = cloud_response.cdpUrl
        elif self.is_local:
            # 启动本地浏览器
            self.event_bus.dispatch(BrowserLaunchEvent())

    # 无论来源，后续代码统一通过 cdp_url 连接
    await self._connect_via_cdp(self.cdp_url)
```

`CloudBrowserClient` 是一个简单的 HTTP 客户端：

```python
# browser_use/browser/cloud/cloud.py

class CloudBrowserClient:
    async def create_browser(self, request) -> CloudBrowserResponse:
        response = await self.client.post('/api/v2/browsers', json=request.model_dump())
        return CloudBrowserResponse(**response.json())

    async def stop_browser(self, session_id=None) -> CloudBrowserResponse:
        response = await self.client.patch(f'/api/v2/browsers/{session_id}', json={'action': 'stop'})
        return CloudBrowserResponse(**response.json())
```

关键洞察：**云端浏览器最终也是给你一个 CDP WebSocket URL**，所以只要把"获取 URL"这一步抽象出来，后续所有代码完全复用。

### spawriter 升级方案

spawriter 的架构特殊之处在于中间有一个 relay 层。抽象需要考虑两种模式：

#### 模式 A：Extension Relay（当前模式）

```
AI → MCP → WebSocket → Relay → Extension → chrome.debugger → Tab
```

#### 模式 B：Direct CDP（新增）

```
AI → MCP → WebSocket → Remote CDP Endpoint (Browserless, BrowserBase, etc.)
```

#### BrowserBackend 接口

```typescript
// mcp/src/backends/backend.ts

export interface BrowserTarget {
  targetId: string;
  title: string;
  url: string;
  type: string;
}

export interface BrowserBackend {
  /**
   * 获取 CDP WebSocket URL。
   * Extension 模式返回 relay 的 /cdp/:clientId URL。
   * Direct 模式返回远程端点的 URL。
   */
  getCdpUrl(clientId: string): string;

  /**
   * 获取可用的 target 列表。
   */
  getTargets(): Promise<BrowserTarget[]>;

  /**
   * 连接到指定 target（可选，某些后端自动连接）。
   */
  connectTarget?(targetId: string): Promise<void>;

  /**
   * 清理资源。
   */
  dispose(): Promise<void>;

  /**
   * 后端类型标识。
   */
  readonly type: 'extension-relay' | 'direct-cdp' | 'cloud';
}
```

#### Extension Relay 后端（当前行为的封装）

```typescript
// mcp/src/backends/extension-relay-backend.ts

export class ExtensionRelayBackend implements BrowserBackend {
  readonly type = 'extension-relay' as const;
  private relayPort: number;
  private relayProcess?: ChildProcess;

  constructor(port?: number) {
    this.relayPort = port || getRelayPort();
  }

  getCdpUrl(clientId: string): string {
    return `ws://127.0.0.1:${this.relayPort}/cdp/${clientId}`;
  }

  async getTargets(): Promise<BrowserTarget[]> {
    const resp = await fetch(`http://127.0.0.1:${this.relayPort}/json/list`);
    return resp.json();
  }

  async dispose(): Promise<void> {
    this.relayProcess?.kill();
  }
}
```

#### Direct CDP 后端

```typescript
// mcp/src/backends/direct-cdp-backend.ts

export class DirectCdpBackend implements BrowserBackend {
  readonly type = 'direct-cdp' as const;
  private cdpUrl: string;

  constructor(cdpUrl: string) {
    // e.g. "ws://localhost:9222" or "wss://cloud.browserless.io?token=xxx"
    this.cdpUrl = cdpUrl;
  }

  getCdpUrl(clientId: string): string {
    return this.cdpUrl;
  }

  async getTargets(): Promise<BrowserTarget[]> {
    const httpUrl = this.cdpUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    const base = new URL(httpUrl).origin;
    const resp = await fetch(`${base}/json/list`);
    return resp.json();
  }

  async dispose(): Promise<void> {
    // 无需清理
  }
}
```

#### 配置方式

通过环境变量选择后端：

```bash
# 默认：Extension Relay 模式
SSPA_MCP_PORT=19989 node dist/cli.js serve

# Direct CDP：连接到本地 Chromium 调试端口
SSPA_CDP_URL=ws://localhost:9222 node dist/cli.js serve

# Cloud：连接到 Browserless
SSPA_CDP_URL=wss://cloud.browserless.io?token=xxx node dist/cli.js serve
```

#### 功能降级矩阵（当前代码基线）

> 以下矩阵反映的是**当前代码尚未做任何兼容层时**各后端的支持情况。"是否支持"指"在该后端模式下，当前代码能否正常运行该功能"。

| 功能 | Extension Relay（现有模式） | Direct CDP（本地 headless，需兼容层） | Cloud（远程浏览器，需兼容层） |
|------|---------------------------|--------------------------------------|-------------------------------|
| 全部 27 个 MCP tools | 全部可用 | 不可用（缺少兼容层） | 不可用（缺少兼容层） |
| 基础 CDP 工具（screenshot / execute / AX 等） | 全部可用 | 兼容层完成后可用 | 兼容层完成后可用（取决于 provider） |
| single-spa 专属工具（dashboard_state / override_app 等） | 全部可用 | 兼容层完成后可用（页面需加载 single-spa + IMO） | 兼容层完成后可用（同左） |
| Tab lease（多 agent 隔离） | 全部可用 | 不可用（当前 lease 依赖 relay 自定义命令） | 不可用（同左） |
| Tab 管理工具（connect_tab / list_tabs / release_tab） | 全部可用 | 不可用（依赖 relay HTTP 端点 + lease 命令） | 不可用（同左） |
| 访问用户浏览器状态（cookies / localStorage 等） | 全部可用 | 取决于本地 Chrome profile 启动方式 | 不可用（远程浏览器无本地状态） |

> **重要**：Direct/Cloud 模式属于远期目标（Phase 3+），在兼容层实现之前不会影响现有 Extension Relay 模式的功能。

### 注意事项

> **Direct/Cloud 不是"开关即用"**：当前 `list_tabs` / `connect_tab` / `release_tab` 及 lease 流程依赖 relay HTTP 端点和自定义 `Target.acquireLease` / `Target.releaseLease` 命令，必须先做兼容层才能在非 Extension Relay 模式下工作。实施时建议先完成 `BrowserBackend` 接口抽象，再逐步适配 Direct/Cloud 后端。

### 预期收益

- CI/CD 中可以用 headless Chrome + spawriter MCP 工具集
- 团队成员可以连接远程浏览器协同调试
- 不影响现有 extension relay 模式的任何功能
- 为未来 cloud provider 集成预留接口

---

## 6. CDP Target 生命周期主动管理

### 问题

spawriter 已有一部分主动生命周期管理能力（relay 处理 `Target.attachedToTarget`/`Target.detachedFromTarget` 并清理 lease；MCP 处理 `Target.leaseLost`/`Target.detachedFromTarget` 并失效会话），但仍存在以下缺口：

1. 缺少统一的 `Target.targetCreated` / `Target.targetDestroyed` 状态机抽象
2. 自动恢复仍以“下次 tool 调用触发重连”为主，缺少后台主动恢复策略
3. Target 抖动（频繁 attach/detach）缺少集中观测指标与节流保护
4. 现有自动附着能力存在，但在 Direct/Cloud 模式下尚未抽象成可复用后端能力

> **当前代码已有的能力（避免重复实现）**：
> - `relay.ts` 已在 `Target.detachedFromTarget` 时清理 `attachedTargets` + `tabLeases` 并向 lease 持有者发送 `Target.leaseLost`；`mcp.ts` 已消费 `Target.leaseLost` / `Target.detachedFromTarget` 并失效会话。升级方案应在此基础上扩展，而非重写。
> - `doEnsureSession` 已包含"project URL 自动附着"与"fallback 请求扩展附着 active tab"两级策略，不仅依赖手工点击。升级重点应放在增加后台主动恢复和统一状态机，而非重做自动附着。

### browser-use 的做法

`SessionManager` 全面订阅 Target 事件，维护实时 target 池：

```python
# browser_use/browser/session_manager.py

async def start_monitoring(self):
    # 开启 target 发现
    await cdp.send.Target.setDiscoverTargets(
        discover=True, filter=[{'type': 'page'}, {'type': 'iframe'}]
    )

    # 注册三个核心回调
    cdp.register.Target.attachedToTarget(on_attached)
    cdp.register.Target.detachedFromTarget(on_detached)
    cdp.register.Target.targetInfoChanged(on_target_info_changed)
```

关键行为：

**Tab 关闭自动处理**（`_handle_target_detached`）：

```python
async def _handle_target_detached(self, event):
    # 从 session pool 移除
    del self._target_sessions[target_id][session_id]

    # 如果 target 的所有 session 都没了 → target 彻底移除
    if remaining_sessions == 0:
        del self._targets[target_id]

        # 如果是 agent 正在操作的 tab → 清空 focus
        if self.browser_session.agent_focus_target_id == target_id:
            self.browser_session.agent_focus_target_id = None

        # 派发 TabClosedEvent
        if target_type in ('page', 'tab'):
            self.browser_session.event_bus.dispatch(TabClosedEvent(target_id=target_id))
```

**Focus 自动恢复**（`_recover_agent_focus`）：

```python
async def _recover_agent_focus(self, crashed_target_id):
    # 单飞锁防止并发恢复
    async with self._recovery_lock:
        page_targets = self.get_all_page_targets()

        if page_targets:
            # 切到最近的 page target
            new_target_id = page_targets[-1].target_id
        else:
            # 没有 tab 了 → 创建新的
            new_target_id = await self._cdp_create_new_page('about:blank')

        # 等待 session attach（轮询 20 次 × 100ms）
        for _ in range(20):
            await asyncio.sleep(0.1)
            if self._get_session_for_target(new_target_id):
                break

        self.browser_session.agent_focus_target_id = new_target_id
        self.browser_session.event_bus.dispatch(
            AgentFocusChangedEvent(target_id=new_target_id)
        )
```

### spawriter 升级方案

#### 在 relay 层增加 Target 事件监听

relay 已经有 extension 发来的 CDP 事件流，可以从中提取 Target 事件：

```typescript
// mcp/src/relay.ts — 增强 routeCdpEvent

function routeCdpEvent(method: string, params: unknown, fromTargetSessionId?: string): void {
  // 现有逻辑：转发给 lease holder

  // 新增：Target 生命周期事件处理
  if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
    const targetId = (params as Record<string, string>).targetId;
    handleTargetRemoved(targetId);
  }

  if (method === 'Target.targetCreated') {
    const info = (params as Record<string, unknown>).targetInfo;
    handleTargetCreated(info);
  }
}

function handleTargetRemoved(targetId: string): void {
  // 1. 释放该 target 的 lease
  const lease = tabLeases.get(targetId);
  if (lease) {
    tabLeases.delete(targetId);
    log(`Auto-released lease for destroyed target ${targetId}`);

    // 通知 lease holder
    notifyClient(lease.clientId, {
      method: 'Target.leaseLost',
      params: { sessionId: targetId, reason: 'target_destroyed' },
    });
  }

  // 2. 从 attachedTargets 移除
  attachedTargets.delete(targetId);
}
```

#### 在 MCP 层增加自动恢复

```typescript
// mcp/src/mcp.ts — handleLeaseEvent 增强

function handleLeaseEvent(method: string, params: Record<string, unknown>): void {
  if (method === 'Target.leaseLost') {
    const reason = params.reason as string;
    const sessionId = params.sessionId as string;
    log(`Lease lost: ${sessionId}, reason: ${reason}`);

    // 清空当前 session
    cdpSession = null;
    // 通知各 handler 清理状态
    handlers.forEach(h => h.onSessionClear?.());

    // 自动尝试恢复（连接到下一个可用 tab）
    autoRecoverSession().catch(e => error('Auto-recovery failed:', e));
  }
}

async function autoRecoverSession(): Promise<void> {
  const targets = await getTargets();
  const available = targets.filter(t => t.type === 'page');

  if (available.length > 0) {
    preferredTargetId = available[0].id;
    log(`Auto-recovering to target: ${available[0].url}`);
    await doEnsureSession();
  } else {
    log('No available targets for auto-recovery');
  }
}
```

#### 健康检查机制

```typescript
// 定期检查当前 target 是否存活

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function startHealthCheck(session: CdpSession): void {
  healthCheckInterval = setInterval(async () => {
    try {
      await sendCdpCommand(session, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      }, 5000);
    } catch {
      log('Health check failed, triggering recovery');
      cdpSession = null;
      handlers.forEach(h => h.onSessionClear?.());
      autoRecoverSession().catch(() => {});
    }
  }, 30_000);
}

function stopHealthCheck(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}
```

### 预期收益

- Tab 关闭后立即感知，不等到下次 tool 调用
- Lease 自动释放，不会出现"幽灵 lease"
- Session 自动恢复，减少 AI 遇到的连接错误
- 健康检查防止"假活"状态

---

## 7. 多层重试与容错策略

### 问题

spawriter 当前的错误处理比较粗糙：

1. **CDP 命令**：超时 → 直接拒绝，无重试
2. **Tool 执行**：catch → 清空 `cdpSession` → 返回 `isError: true`
3. **连接断开**：下次 tool 调用才重连
4. `connect_tab` 有 6 次重试，但这是唯一有重试的地方

### browser-use 的多层容错

browser-use 在 **4 个层级** 实现了容错：

#### 层级 1：LLM 调用（指数退避）

```python
# browser_use/llm/browser_use/chat.py
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

for attempt in range(self.max_retries):
    try:
        result = await self._make_request(payload)
        break
    except httpx.HTTPStatusError as e:
        if e.response.status_code in RETRYABLE_STATUS_CODES:
            delay = min(base_delay * (2 ** attempt), max_delay)
            jitter = random.uniform(0, delay * 0.1)
            await asyncio.sleep(delay + jitter)
    except (httpx.TimeoutException, httpx.ConnectError):
        delay = min(base_delay * (2 ** attempt), max_delay)
        await asyncio.sleep(delay + jitter)
```

#### 层级 2：CDP 并行请求（超时重试）

```python
# browser_use/dom/service.py
done, pending = await asyncio.wait(tasks.values(), timeout=10.0)

if pending:
    for task in pending:
        task.cancel()
    # 用 retry_map 重建失败的任务
    for key, task in tasks.items():
        if task in pending:
            tasks[key] = retry_map[task]()
    # 第二次等待，更短超时
    done2, pending2 = await asyncio.wait([...], timeout=2.0)
```

#### 层级 3：Agent 步骤错误（连接恢复 + 失败计数）

```python
# browser_use/agent/service.py
async def _handle_step_error(self, error):
    if self._is_connection_like_error(error):
        # 等待重连
        if self.browser_session.is_cdp_connected:
            return  # 重试当前步骤

    self.state.consecutive_failures += 1
    if consecutive_failures >= max_total_failures:
        break  # 终止 agent
```

#### 层级 4：空响应恢复

```python
# browser_use/agent/service.py
async def _get_model_output_with_retry(self, messages):
    output = await self.get_model_output(messages)
    if not output.action:
        # 追加提示信息，重试一次
        retry_messages.append("Please provide a valid action...")
        output = await self.get_model_output(retry_messages)
        if not output.action:
            # 注入安全的 noop action
            output.action = [DoneAction(success=False, text='No action returned')]
    return output
```

### spawriter 升级方案

#### 层级 1：CDP 命令重试

```typescript
// mcp/src/cdp/session.ts

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableErrors?: Set<string>;
}

const RETRYABLE_ERROR_PATTERNS = new Set([
  'No node with given id found',
  'Could not find node with given id',
  'Cannot find context with specified id',
  'Execution context was destroyed',
  'Session with given id not found',
  'Target closed',
  'Protocol error',
]);

const DEFAULT_RETRY_OPTS: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelay: 500,
  maxDelay: 3000,
  retryableErrors: RETRYABLE_ERROR_PATTERNS,
};

export async function sendCdpCommandWithRetry(
  session: CdpSession,
  method: string,
  params?: Record<string, unknown>,
  commandTimeout = 30000,
  retryOpts: RetryOptions = {},
): Promise<unknown> {
  const opts = { ...DEFAULT_RETRY_OPTS, ...retryOpts };

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await sendCdpCommand(session, method, params, commandTimeout);
    } catch (e) {
      const msg = String(e);
      const isRetryable = [...opts.retryableErrors].some(pattern => msg.includes(pattern));

      if (!isRetryable || attempt === opts.maxRetries) throw e;

      const delay = Math.min(
        opts.baseDelay * Math.pow(2, attempt) + Math.random() * 200,
        opts.maxDelay,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable');
}
```

#### 关键命令的重试配置

```typescript
const CRITICAL_COMMANDS: Record<string, RetryOptions> = {
  'Page.captureScreenshot': { maxRetries: 2, baseDelay: 1000 },
  'Accessibility.getFullAXTree': { maxRetries: 2, baseDelay: 500 },
  'Runtime.evaluate': { maxRetries: 1, baseDelay: 300 },
  'DOM.getDocument': { maxRetries: 2, baseDelay: 500 },
  'DOM.getBoxModel': { maxRetries: 1, baseDelay: 200 },
  'Network.getResponseBody': { maxRetries: 2, baseDelay: 500 },
};
```

#### 层级 2：并行 CDP 请求容错

```typescript
// 获取 DOM 状态时并行请求多个 CDP 命令

async function getPageState(session: CdpSession) {
  const results = await Promise.allSettled([
    sendCdpCommandWithRetry(session, 'Accessibility.getFullAXTree', { depth: -1 }),
    sendCdpCommandWithRetry(session, 'Page.captureScreenshot', { format: 'png' }),
    sendCdpCommandWithRetry(session, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    }),
  ]);

  return {
    axTree: results[0].status === 'fulfilled' ? results[0].value : null,
    screenshot: results[1].status === 'fulfilled' ? results[1].value : null,
    title: results[2].status === 'fulfilled' ? results[2].value : null,
  };
}
```

#### 层级 3：Tool 级别智能错误处理

替换当前的"catch all → 清空 session → isError"模式：

```typescript
// mcp/src/mcp.ts — 重构后的 error handler

enum ErrorCategory {
  Transient,       // 可重试：超时、临时断开
  SessionLost,     // session 丢失：需要重连
  TargetGone,      // target 被关闭
  InvalidInput,    // 参数错误：不应重试
  Unknown,         // 未知错误
}

function categorizeError(e: unknown): ErrorCategory {
  const msg = String(e);
  if (msg.includes('timeout') || msg.includes('Timed out'))
    return ErrorCategory.Transient;
  if (msg.includes('not open') || msg.includes('connection'))
    return ErrorCategory.SessionLost;
  if (msg.includes('Target closed') || msg.includes('leaseLost'))
    return ErrorCategory.TargetGone;
  if (msg.includes('Invalid') || msg.includes('required'))
    return ErrorCategory.InvalidInput;
  return ErrorCategory.Unknown;
}

async function executeToolWithRecovery(
  name: string,
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await handler();
    } catch (e) {
      const category = categorizeError(e);

      switch (category) {
        case ErrorCategory.Transient:
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          break;

        case ErrorCategory.SessionLost:
          cdpSession = null;
          if (attempt === 0) {
            try {
              await doEnsureSession();
              continue;
            } catch {
              break;
            }
          }
          break;

        case ErrorCategory.TargetGone:
          cdpSession = null;
          handlers.forEach(h => h.onSessionClear?.());
          break;

        case ErrorCategory.InvalidInput:
          // 不重试
          break;
      }

      return {
        content: [{ type: 'text', text: `Error (${ErrorCategory[category]}): ${String(e)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Error: max retries exceeded for ${name}` }],
    isError: true,
  };
}
```

> 多 session 备注：`SessionLost` / `TargetGone` 不能只清理全局 `cdpSession`，还需要按 `session_id` 清理对应 `agentSessions` 条目（可复用现有 `invalidateSessionByTargetId` 思路）。

#### 层级 4：Playwright Executor 重试

当前 `pw-executor.ts` 只在 "execution context destroyed" 时重试一次。增加更多可重试场景：

```typescript
// mcp/src/pw-executor.ts — 增强

const PW_RETRYABLE_ERRORS = [
  'Execution context was destroyed',
  'Target page, context or browser has been closed',
  'Protocol error (Runtime.callFunctionOn)',
  'Session closed',
  'Connection closed',
];

async execute(code: string, timeout = 30000): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await this._executeInVm(code, timeout);
    } catch (e) {
      const msg = String(e);
      const isRetryable = PW_RETRYABLE_ERRORS.some(p => msg.includes(p));

      if (isRetryable && attempt === 0) {
        await this.reconnect();
        continue;
      }
      throw e;
    }
  }
}
```

### 预期收益

- CDP 命令在页面导航等临时中断时自动恢复，减少 AI 看到的错误
- 错误分类使日志更有意义，方便调试
- Session 丢失时自动重连，而不是等下次 tool 调用
- Playwright 断开时自动重连，不需要 AI 手动 `reset`

> **多会话注意事项**：任何"session 丢失"恢复逻辑都要同时处理全局会话与 `agentSessions`，避免只清理 `cdpSession` 导致跨会话残留。

---

## 防回归测试策略

> **核心原则**：任何重构/新增功能之前，必须先补齐测试覆盖，确保零回归。

### 关于"能否保证一定不回归"

结论：**不能做 100% 绝对保证**。重构涉及浏览器连接、扩展通信、CDP 时序与多会话状态，存在环境变量（Chrome 版本、扩展状态、网络时延）带来的不确定性。

可以做到的是"高置信不回归"，并通过强门禁把风险压到最低：

1. **测试门禁**：现有全量测试 + 本文新增合约测试全部通过（必须在每个 Phase 合并前执行）。
2. **行为门禁**：27 个 MCP tools 做输入/输出合约对照（重构前后对同一模拟输入输出一致）。
3. **场景门禁**：单会话 + 多会话（`session_id`）+ tab lease + extension 断连恢复场景全部通过。
4. **手工冒烟门禁**：验证清单中的关键链路必须逐项通过，不允许"只跑自动化"。
5. **发布门禁**：采用 canary 发布与回滚预案（保留旧实现开关，异常可立即切回）。

### 现有测试覆盖分析

当前 6 个测试文件（`mcp.test.ts` 147 个 describe + `relay.test.ts` + `lease.test.ts` + `pw-executor.test.ts` + `utils.test.ts` + `cli.test.ts`）已经覆盖了大部分逻辑单元，测试方式是**模拟核心数据结构和算法**（不依赖真实 CDP/WebSocket 连接），这个模式应该继续保持。

### 现有覆盖（已有测试的模块）

| 模块 | 测试文件 | describe 数 | 覆盖内容 |
|------|---------|------------|----------|
| Console 日志缓冲 | `mcp.test.ts` | 1 | 添加、过滤、格式化、缓冲溢出 |
| Network 日志 | `mcp.test.ts` | ~6 | 请求监控、扩展字段、`network_detail` 格式化/截断/base64 |
| CDP 事件分发 | `mcp.test.ts` | 2 | `handleCdpEvent` 模拟、Network 扩展字段 |
| AX 树格式化 | `mcp.test.ts` | 2 | `formatAXTreeAsText`、边缘情况 |
| 快照 diff/search | `mcp.test.ts` | 3 | `computeSnapshotDiff`、`searchSnapshot`、精度 |
| 标注截图 | `mcp.test.ts` | 3 | `getInteractiveElements`、`formatLabelLegend`、注入脚本 |
| 调试器 | `mcp.test.ts` | ~8 | 事件处理、action 路由、状态机、断点管理 |
| CSS 检查 | `mcp.test.ts` | ~6 | 格式化、属性解析、选择器安全、边缘情况 |
| Session Manager | `mcp.test.ts` | ~5 | Action 路由、淘汰策略、并发、格式化 |
| Storage 工具 | `mcp.test.ts` | ~5 | Action 路由、cookie 格式化、localStorage、清理 |
| Performance 工具 | `mcp.test.ts` | ~5 | 指标格式化、Web Vitals 评级、内存、资源计时 |
| Editor 工具 | `mcp.test.ts` | ~4 | Action 路由、源码截取、搜索、脚本过滤 |
| Network 拦截 | `mcp.test.ts` | ~6 | 规则管理、URL 匹配、请求处理、glob-regex 转换 |
| Emulation | `mcp.test.ts` | ~5 | 设备预设、网络条件、时区/地理位置、媒体特性 |
| Page Content | `mcp.test.ts` | ~5 | HTML 清理、截断、元数据、DOM 搜索 |
| 超时模式 | `mcp.test.ts` | ~5 | `withTimeout`、`sendCdpCommand`、`evaluateJs`、层级 |
| `clear_cache_and_reload` | `mcp.test.ts` | ~7 | 参数解析、cookie 域匹配、存储分区、场景模拟 |
| 多 Tab | `mcp.test.ts` | ~8 | `list_tabs` 格式化、`switch_tab` 验证/状态清理、A/B 比较 |
| Relay/下载 | `mcp.test.ts` | ~7 | 下载行为映射、事件合成、缓存继承 |
| single-spa 覆盖 | `mcp.test.ts` | ~4 | `detectOverrideChanges`、`importPageOverrides`、同步模拟 |
| `app_action` | `mcp.test.ts` | 1 | JS 代码生成 |
| `override_app` | `mcp.test.ts` | 2 | 参数验证、JS 代码生成 |
| Lease 系统 | `relay.test.ts` + `lease.test.ts` | ~30+ | 获取/释放/执行/隔离/竞态/向后兼容 |
| Playwright Executor | `pw-executor.test.ts` | ~15 | 自动返回、代码包装、VM 沙盒、超时、会话管理 |
| CLI 解析 | `cli.test.ts` | ~5 | 参数解析、命令分发 |
| Utils | `utils.test.ts` | ~8 | 端口/Token/URL/日志/ClientId 生成 |

### 需要补充的测试（重构前必做）

以下测试需要在**任何重构开始之前**补齐，确保重构时有回归检测网：

#### 1. Fetch 拦截完整生命周期测试

```
文件：mcp/src/mcp.test.ts（扩展现有 network_intercept 区域）
补充内容：
- handleFetchPaused 匹配逻辑（URL pattern vs rule 匹配优先级）
- mock 响应构建（status + headers + body → Fetch.fulfillRequest 参数）
- block 模式（→ Fetch.failRequest）
- 无匹配规则时 pass-through（→ Fetch.continueRequest）
- enable/disable 状态切换
- 规则添加/删除后的 interceptNextId 递增
```

#### 2. CDP 连接管理合约测试

```
文件：新建 mcp/src/cdp-connection.test.ts
内容：
- sendCdpCommand：超时处理、WS 非 OPEN 拒绝、pending 请求映射
- connectCdp：WS URL 构建、心跳间隔、关闭时清理 pending
- enableDomains：Network.enable + Runtime.enable 参数
- evaluateJs：表达式包装、错误提取、超时传递
- ensureSession 互斥锁：并发调用只执行一次、锁释放后可重入
- doEnsureSession：target 选择优先级（own lease > project URL > first available）
```

#### 3. 多 Agent Session 路由测试

```
文件：新建 mcp/src/agent-session.test.ts
内容：
- resolveActiveSession：有 session_id → 创建/复用 AgentSession
- resolveActiveSession：无 session_id → 使用全局 session
- activeAgentId 粘性：connect_tab 后所有后续调用走该 session
- 不同 session_id 的隔离：各自的 cdpSession + preferredTargetId
```

#### 4. Tool 输入/输出合约测试

```
文件：mcp/src/mcp.test.ts（扩展）
内容：为每个 MCP tool 验证 inputSchema 与实际参数处理的一致性

screenshot：
  - 无参数 → 默认行为
  - labels: true → 触发 AX 树获取 + 标注注入
  - labels: false/undefined → 纯截图

accessibility_snapshot：
  - 无参数 → 全量快照
  - search: "button" → 过滤
  - diff: true（默认）→ 与 lastSnapshot 对比
  - diff: false → 强制全量

navigate：
  - url 必填
  - 缺少 url → 错误

execute：
  - code 必填
  - 返回值格式化

console_logs / network_log / network_detail：已有覆盖，补充边界

debugger：每个 action 的必填参数验证

storage / performance / editor / emulation / page_content：
  每个 action 的参数验证和输出格式
```

#### 5. 状态清理合约测试

```
文件：mcp/src/mcp.test.ts（扩展）
内容：验证以下场景的状态清理完整性

switch_tab 后应清理：
  - consoleLogs → 清空
  - networkLog → 清空
  - interceptEnabled → false, interceptRules → 清空
  - debuggerEnabled → false, breakpoints/knownScripts/debuggerPaused → 重置
  - lastSnapshot → null

reset 后应清理：
  - 以上所有
  - cdpSession → null
  - agentSessions → 清空
  - relayServerProcess → 可能清理
  - pwExecutor → reset
  - executorManager → resetAll

tool 执行错误后：
  - cdpSession → null（当前行为）
  - 其他状态不变（验证不会意外清理）
```

#### 6. navigate + ensure_fresh_render + clear_cache_and_reload 合约

```
文件：mcp/src/mcp.test.ts（已有 clear_cache_and_reload 覆盖，补充）
内容：
- navigate：Page.navigate 参数构建
- ensure_fresh_render：Page.reload 参数
- navigate vs ensure_fresh_render 的区别
```

#### 7. dashboard_state JS 注入代码测试

```
文件：mcp/src/mcp.test.ts（扩展）
内容：
- dashboard_state 注入的 JS 代码片段解析测试
- 返回值格式：apps 列表、active overrides 格式
- 页面没有 single-spa 时的 fallback 行为
```

### 测试实施顺序

```
Step 1: 补充上述第 5 项（状态清理合约）
        → 这是重构 mcp.ts 拆分的直接守护网
Step 2: 补充上述第 2 项（CDP 连接管理合约）
        → 这是提取 cdp/session.ts 和 cdp/connection.ts 的前提
Step 3: 补充上述第 1 项（Fetch 拦截完整生命周期）
        → NetworkHandler 提取的守护网
Step 4: 补充上述第 3 项（多 Agent Session 路由）
        → agent-session.ts 提取的守护网
Step 5: 补充上述第 4 项（Tool 输入/输出合约）
        → Tool Registry 模式迁移的守护网
Step 6-7: 按需补充
```

### 测试命令

```bash
# 运行所有测试
cd mcp && npx tsx --test src/*.test.ts

# 运行单个测试文件
npx tsx --test src/mcp.test.ts

# 运行特定 describe
npx tsx --test --test-name-pattern="Console log" src/mcp.test.ts
```

### 测试原则

1. **不依赖真实浏览器/WebSocket**：继续使用模拟数据结构的方式
2. **测试合约而非实现**：验证输入→输出映射，不关心内部如何实现
3. **每次重构前运行全量测试**：`npx tsx --test src/*.test.ts`
4. **每个提取的 handler 都要有独立测试文件**
5. **新增功能（如 `get_interactive_elements`）先写测试再实现**

---

## 实施路线图

### Phase 0：补齐测试覆盖（预计 4-6 天）

| 优先级 | 任务 | 守护目标 |
|--------|------|---------|
| P0 | 状态清理合约测试 | mcp.ts 拆分 |
| P0 | CDP 连接管理合约测试 | cdp/ 提取 |
| P1 | Fetch 拦截生命周期测试 | NetworkHandler |
| P1 | 多 Agent Session 路由测试 | agent-session.ts |
| P2 | Tool 输入/输出合约测试 | Tool Registry |

### Phase 1：基础架构重构（预计 5-8 天）

| 优先级 | 任务 | 风险 |
|--------|------|------|
| P0 | 提取 `cdp/session.ts` + `cdp/connection.ts` | 低 |
| P0 | 实现 `BaseHandler` + 迁移 `ConsoleHandler` | 低 |
| P0 | 迁移 `NetworkHandler`（含 Fetch 拦截） | 中 |
| P1 | 迁移 `DebuggerHandler` | 中 |
| P1 | 迁移剩余 handlers | 低 |

### Phase 2：核心能力增强（预计 5-8 天）

| 优先级 | 任务 | 风险 |
|--------|------|------|
| P0 | 实现 `sendCdpCommandWithRetry` | 低 |
| P0 | 实现 `executeToolWithRecovery` | 中 |
| P1 | 实现 `get_interactive_elements` 工具 | 中 |
| P1 | 实现 `click_element` / `type_element` 工具 | 中 |
| P2 | HAR 导出功能 | 低 |

### Phase 3：扩展能力（预计 4-6 天）

| 优先级 | 任务 | 风险 |
|--------|------|------|
| P1 | 实现 `ToolRegistry` + Zod schema | 中 |
| P2 | Target 生命周期监听 + 自动恢复 | 中 |
| P2 | `BrowserBackend` 接口 + Direct CDP 后端 | 低 |
| P3 | 健康检查机制 | 低 |

### 验证清单

每个 Phase 完成后：

- [ ] 所有现有 MCP tool 调用行为不变
- [ ] `mcp.test.ts` 和 `relay.test.ts` 通过
- [ ] `lease.test.ts` 通过
- [ ] `pw-executor.test.ts` 通过
- [ ] 手动测试：截图、AX 快照、console logs、network log、navigate、execute、playwright_execute
- [ ] 手动测试：switch_tab、connect_tab、list_tabs
- [ ] 手动测试：debugger 断点、editor 编辑
- [ ] 手动测试：override_app、dashboard_state

---

## 附录：browser-use 关键源码索引

| 文件 | 行数 | 关键内容 |
|------|------|----------|
| `browser_use/browser/watchdog_base.py` | 321 | `BaseWatchdog`、`attach_handler_to_session`、事件匹配 |
| `browser_use/browser/events.py` | 667 | 所有事件类型定义 |
| `browser_use/browser/session.py` | 3969 | `BrowserSession`、`attach_all_watchdogs`、导航、Cloud 分支 |
| `browser_use/browser/session_manager.py` | 911 | Target 事件监听、focus 恢复 |
| `browser_use/dom/service.py` | 1153 | DOM + AX + Snapshot 合并 |
| `browser_use/dom/serializer/serializer.py` | 1290 | 序列化 + 索引分配 |
| `browser_use/dom/serializer/clickable_elements.py` | 246 | 可交互元素检测启发式 |
| `browser_use/dom/views.py` | 1041 | `EnhancedDOMTreeNode`、`SerializedDOMState` |
| `browser_use/tools/registry/service.py` | 601 | `Registry`、`@action` 装饰器 |
| `browser_use/tools/service.py` | ~2160 | 所有默认 action 注册 |
| `browser_use/browser/watchdogs/har_recording_watchdog.py` | 779 | HAR 1.2 录制 |
| `browser_use/browser/cloud/cloud.py` | 203 | `CloudBrowserClient` |
| `browser_use/llm/browser_use/chat.py` | 295 | 指数退避重试 |
| `browser_use/agent/service.py` | 4091 | Agent 循环、`max_failures`、`_handle_step_error` |
