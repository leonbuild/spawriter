# bb-browser 项目分析 — 对 spawriter 的启发

> 分析日期: 2026-03-25
> 分析对象: [bb-browser](https://github.com/epiral/bb-browser) (BadBoy Browser)
> 版本: 基于 GitHub main 分支源码

---

## 一、bb-browser 项目概览

### 定位
"Your browser is the API. No keys. No bots. No scrapers."

bb-browser 让 AI agent 直接使用用户的真实浏览器（包括登录态、cookie、session），而非启动无头浏览器。核心理念：与其让网站提供机器接口，不如让机器使用人类接口。

### 核心功能
- **浏览器自动化**: 通过 CLI / MCP 控制真实 Chrome（open, snapshot, click, fill, hover, scroll, press, eval, screenshot 等 30+ 命令）
- **Site Adapter 系统**: 社区驱动的网站适配器，36 个平台、103 个命令（Twitter、Reddit、GitHub、知乎、B站等）
- **带登录态的 fetch**: 在浏览器上下文中发 HTTP 请求，自动携带 cookie
- **操作录制 (Trace)**: 录制用户在浏览器中的操作，输出结构化事件
- **网络拦截**: 请求捕获、mock、拦截

### 技术栈
- Monorepo (pnpm workspace + turbo)
- 五个 package: `shared`, `cli`, `daemon`, `extension`, `mcp`
- TypeScript, Vite (extension build), tsup (其他 package)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Zod (MCP 参数验证)

---

## 二、架构对比

### 通信链路

```
bb-browser:
  AI Agent ──CLI/MCP stdio──▶ CLI/MCP ──HTTP──▶ Daemon ──SSE──▶ Extension ──CDP──▶ Browser

spawriter:
  AI Agent ──MCP stdio──▶ MCP Server ──WebSocket──▶ Relay ──CDP──▶ Extension ──CDP──▶ Browser
                              └──CDP──▶ PlaywrightExecutor
```

**关键差异**:
- bb-browser 的 Daemon 是一个独立的 HTTP 服务器，Extension 通过 SSE 长连接接收命令
- spawriter 的 Relay 是 WebSocket 服务器，Extension 通过 WebSocket 双向通信
- spawriter 额外有 Playwright 层（通过 CDP connectOverCDP 连接到 Relay）

### MCP 层对比

| 维度 | bb-browser | spawriter |
|------|-----------|-----------|
| MCP SDK | `@modelcontextprotocol/sdk` (官方) | 手动实现 MCP protocol |
| Tool 注册 | `server.tool()` + Zod schema | 手动定义 tool 数组 |
| Tool 粒度 | 原子化 (每个交互一个 tool) | 功能聚合 (playwright_execute + execute + 专项工具) |
| Tool 数量 | 17 个 MCP tools | 27 个 MCP tools |
| 参数验证 | Zod runtime validation | 手动检查 |

### Extension 对比

| 维度 | bb-browser | spawriter |
|------|-----------|-----------|
| Manifest | V3 (service worker) | V3 + V2 兼容 |
| UI | 无 (纯后台) | DevTools Panel + Toolbar Popup |
| CDP 使用 | `chrome.debugger` API | `chrome.debugger` API |
| 元素定位 | **backendDOMNodeId** (CDP AX Tree) | CSS selector / Playwright locator |
| 状态持久化 | `chrome.storage.session` | 内存 (有丢失风险) |

---

## 三、值得 spawriter 借鉴的特性

### 特性 1: Ref 系统 (优先级: 高)

**bb-browser 的做法**:
- `snapshot` 命令使用 CDP `Accessibility.getFullAXTree` 获取页面的 accessibility tree
- 为每个可交互元素分配一个 `@ref` 编号（`@1`, `@2`, ...）
- ref 对应的元素信息（backendDOMNodeId, role, name, xpath）缓存在 `chrome.storage.session` 中
- 后续所有交互命令（click, hover, fill）通过 `@ref` 引用元素

```bash
bb-browser snapshot -i        # 只显示可交互元素
# @1 [button] "提交"
# @2 [input type="text"] placeholder="请输入姓名"
# @3 [a] "查看详情"

bb-browser click @1           # 点击 @1 → 提交按钮
bb-browser hover @3           # hover @3 → 查看详情链接
bb-browser fill @2 "张三"     # 填写 @2 → 姓名输入框
```

**spawriter 现状**:
- `screenshot { labels: true }` 在截图上标注编号，但编号无法被程序化引用
- `accessibility_snapshot` 返回文本树，但没有 ref 编号
- 所有交互必须通过 `playwright_execute` 写完整的 Playwright 代码

**建议方案**:
1. 增强 `accessibility_snapshot` 返回带 ref 编号的结构
2. 在 extension 侧缓存 ref → backendDOMNodeId 映射
3. 在 `playwright_execute` / `execute` 中支持通过 ref 快速定位元素（如注入 helper 函数 `refToSelector(ref)` 或暴露为 Playwright locator）
4. 保留 `playwright_execute` 做复杂流程

**价值**: 降低 agent 定位元素的成本——snapshot 给出 ref，agent 用 ref 写简短代码即可交互，减少选择器试错和 token 消耗。

### 特性 2: 操作录制 (Trace) (优先级: 高)

**bb-browser 的做法**:
- Content script (`trace.ts`) 注入页面，监听 click, input, change, keydown, scroll 事件
- 每个事件提取: ref (highlightIndex), xpath, cssSelector, elementRole, elementName, 操作参数
- 输入事件有 500ms 防抖，滚动事件有 300ms 防抖
- 密码字段自动脱敏为 `********`
- 通过 `chrome.runtime.sendMessage` 发回 background service worker

```typescript
// trace.ts 的事件类型
type TraceEvent = {
  type: 'click' | 'fill' | 'select' | 'check' | 'press' | 'scroll' | 'navigation';
  timestamp: number;
  url: string;
  ref?: number;
  xpath?: string;
  cssSelector?: string;
  value?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  elementRole?: string;
  elementName?: string;
};
```

**spawriter 现状**: 无操作录制功能。

**建议方案**:
1. 在 spawriter extension 中增加 content script 做操作录制
2. 新增 MCP tool: `trace { action: "start" | "stop" | "status" }`
3. stop 时返回结构化事件列表
4. 可选: 自动生成 Playwright 测试代码或 bb-browser 风格的命令序列

**价值**: 特别适合 spawriter 的 single-spa 场景：
- 录制微前端操作流程，帮助 agent 理解用户工作流
- 生成自动化回归测试
- Debug 时回放用户操作复现问题

### 特性 3: 带登录态的 Fetch 工具 (优先级: 中)

**bb-browser 的做法**:
- 独立的 `fetch` CLI 命令
- 在浏览器上下文中执行 `fetch()`，自动带 cookie
- 支持 GET/POST/自定义 header/保存到文件
- 自动域名路由（绝对路径找匹配 tab 或新建，相对路径用当前 tab）

**spawriter 现状**: 可以通过 `execute { code: "fetch('/api/me').then(r=>r.json())" }` 实现，但不够显式。

**建议方案**: 
- 新增 `browser_fetch` MCP tool，封装浏览器上下文 fetch
- 参数: url, method, headers, body
- 自动返回 JSON 解析结果
- 比让 agent 写 fetch 代码更直观

### 特性 4: 结构化错误格式 (优先级: 中)

**bb-browser 的做法**:
```json
{
  "error": "HTTP 401",
  "hint": "需要先登录雪球，请先在浏览器中打开 xueqiu.com 并登录",
  "action": "bb-browser open https://xueqiu.com"
}
```

三个字段:
- `error`: 技术原因 (agent 判断是否可自动修复)
- `hint`: 人类可读解释 (agent 无法自修时转达给用户)
- `action`: 可执行的修复命令 (agent 可尝试执行)

**spawriter 现状**: 错误返回 plain text，如 `"Error: Element not found"`

**建议方案**: 在 MCP tool 响应中引入结构化错误:
```json
{
  "error": "CDP connection lost",
  "hint": "Chrome tab may have been closed or navigated away",
  "recovery": "reset"
}
```

### 特性 5: Dialog 处理 (优先级: 低)

**bb-browser 的做法**: 
- CDP `Page.javascriptDialogOpening` 监听 dialog 弹出
- `dialog accept/dismiss` 命令处理
- 支持 prompt 文本输入

**spawriter 现状**: 无专门的 dialog 处理工具（可通过 `playwright_execute` 中 `page.on('dialog')` 实现）

**建议方案**: 新增 `dialog` MCP tool（低优先级，因为 Playwright 已经可以处理）

### 特性 6: Session Tab 清理 (优先级: 低)

**bb-browser 的做法**: MCP 层追踪所有 session 中 `open` 创建的 tab，提供 `browser_close_all` 批量关闭。

**spawriter 现状**: `release_tab` 释放 lease 但不关闭 tab。

**建议方案**: 可选 — 添加 `release_tab { close: true }` 参数或 `cleanup_session` 工具。

---

## 四、bb-browser 实现细节值得参考的点

### 4.1 CDP Hover 实现 (cdp-dom-service.ts)

bb-browser 的 hover 实现不依赖 Playwright，直接用 CDP：

1. 通过 `@ref` 查找 `backendDOMNodeId`
2. `DOM.resolveNode({ backendNodeId })` → 获取 `objectId`
3. `DOM.getBoxModel({ objectId })` → 获取元素坐标
4. 计算元素中心点
5. `Input.dispatchMouseEvent({ type: "mouseMoved", x, y })` → 真实 hover

这种方式触发 CSS `:hover`，不需要 Playwright 层。spawriter 的 `execute` tool 目前只能 `dispatchEvent(new MouseEvent('mouseenter'))` 做合成事件，不触发 CSS 伪类。

### 4.2 Snapshot 的 `-i` (interactive only) 模式

bb-browser 的 snapshot 支持只返回可交互元素（`-i` 参数），大幅减少输出噪音。这对 agent 的 token 效率非常重要。

spawriter 的 `accessibility_snapshot` 返回完整树。建议增加 `interactive_only` 参数。

### 4.3 Service Worker 状态持久化

MV3 extension 的 service worker 会休眠。bb-browser 用 `chrome.storage.session` 持久化关键状态（snapshot refs），唤醒后自动恢复。

```typescript
async function saveRefsToStorage(tabId: number, refs: Record<string, RefInfo>): Promise<void> {
  const result = await chrome.storage.session.get('tabSnapshotRefs');
  const stored = (result.tabSnapshotRefs || {}) as Record<string, Record<string, RefInfo>>;
  stored[String(tabId)] = refs;
  await chrome.storage.session.set({ tabSnapshotRefs: stored });
}
```

spawriter 的 extension 状态全在内存中，service worker 休眠后可能丢失。

### 4.4 Monorepo 中的共享协议类型

bb-browser 把所有 CLI ↔ Extension 的通信协议定义在 `packages/shared/src/protocol.ts` 中，一个文件定义所有 ActionType、Request、Response 类型。修改协议时只需改一个地方。

spawriter 的 extension 和 relay 之间的协议散落在多个文件中，可以考虑统一。

### 4.5 MCP Tool 的 `tab` 参数统一设计

bb-browser 的每个 MCP tool 都有可选的 `tab: z.number().optional()` 参数，agent 可以指定操作哪个 tab。默认操作活跃 tab。这比 spawriter 的 `switch_tab` + 操作 的两步方式更简洁。

---

## 五、spawriter 的独有优势（不应丢失）

| 能力 | bb-browser | spawriter |
|------|-----------|-----------|
| Playwright API | **无** | 完整 (click, hover, fill, drag, keyboard, mouse...) |
| single-spa 集成 | **无** | import-map override, app lifecycle, dashboard |
| DevTools Panel | **无** | 可视化 override 管理, app 状态 |
| CSS 检查 | **无** | `css_inspect` (computed styles) |
| JavaScript Debugger | **无** | 断点, 步进, 变量检查 |
| Source Editor | **无** | 实时编辑 JS/CSS (hot-reload) |
| Performance 监控 | **无** | Web Vitals, memory, resource timing |
| 多 Agent Tab Lease | 简单 tabId | 完整的 lease 系统 (per-session isolation) |
| Network Mock | 基础 route/abort | 完整 (add_rule, list, remove, mock headers) |
| Emulation | **无** | device, network, geo, timezone, media features |
| Storage 管理 | **无** | cookies, localStorage, sessionStorage, cache |
| 会话管理 | **无** | ExecutorManager (命名会话) |
| Accessibility Diff | **无** | snapshot diff 比对 |

---

## 六、建议实施路线图

### Phase 1: 基础增强 (1-2 周)
- [ ] 结构化错误格式
- [ ] `accessibility_snapshot` 增加 `interactive_only` 参数
- [ ] Extension 关键状态用 `chrome.storage.session` 持久化

### Phase 2: Ref 系统 (2-3 周)
- [ ] 在 snapshot 中为可交互元素分配 ref 编号
- [ ] Extension 侧缓存 ref → backendDOMNodeId 映射
- [ ] `playwright_execute` / `execute` 支持通过 ref 快速定位元素

### Phase 3: 高级特性 (3-4 周)
- [ ] 操作录制 (Trace) — content script + start/stop/status tools
- [ ] `browser_fetch` 工具 — 带登录态的 fetch
- [ ] `dialog` 处理工具

### Phase 4: 可选增强
- [ ] 协议类型统一到 shared 包
- [ ] Session tab 清理
- [ ] 从 trace 事件自动生成 Playwright 测试脚本

---

## 附录: bb-browser 项目结构

```
bb-browser/
├── packages/
│   ├── shared/          # 共享类型定义 (protocol.ts, constants.ts)
│   ├── cli/             # CLI 命令 (30+ 命令, 每个一个文件)
│   │   └── src/commands/  # click.ts, hover.ts, snapshot.ts, trace.ts, ...
│   ├── daemon/          # HTTP 服务器 (SSE 推送, 请求路由)
│   ├── extension/       # Chrome Extension (MV3 service worker)
│   │   └── src/
│   │       ├── background/  # command-handler.ts, cdp-service.ts, cdp-dom-service.ts
│   │       └── content/     # trace.ts (操作录制)
│   └── mcp/             # MCP Server (17 个 tools, 官方 SDK)
├── skills/              # AI agent skill 文件 (SKILL.md)
├── AGENTS.md            # Agent 开发指南
└── README.md
```
