# bb-browser 项目分析 — 对 spawriter 的启发

> 初始分析: 2026-03-25  
> 最近更新: 2026-04-03 (补充 v0.11.2 架构变更及新发现)
> 分析对象: [bb-browser](https://github.com/epiral/bb-browser) (BadBoy Browser)
> 版本: 0.11.2 (基于本地 `D:\dev\0-ref\bb-browser` 源码)

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
bb-browser (v0.11.2, 扩展已移除):
  AI Agent ──CLI/MCP stdio──▶ CLI/MCP ──HTTP──▶ Daemon ──CDP WebSocket 直连──▶ Chrome

spawriter:
  AI Agent ──MCP stdio──▶ MCP Server ──WebSocket──▶ Relay ──CDP──▶ Extension ──CDP──▶ Browser
                              └──CDP──▶ PlaywrightExecutor
```

**关键差异**:
- **bb-browser 已移除 Extension 依赖** (CHANGELOG 确认)，改为 Daemon 直接通过 CDP WebSocket 连接 Chrome（`--remote-debugging-port`）
- bb-browser 的 Daemon 是独立 HTTP 服务器，CLI/MCP 通过 HTTP POST `/command` 调用
- spawriter 仍需 Chrome 扩展做 CDP 中转，Relay 做 WebSocket 桥接
- spawriter 额外有 Playwright 层（通过 CDP connectOverCDP 连接到 Relay）

> **2026-04-03 重要发现**: bb-browser 放弃扩展后，用 `chrome.storage.session` 也失去了意义，ref 映射改为 Daemon 内存 + `TabStateManager` 管理。这说明**无扩展模式下的状态管理**是一个需要解决的问题。

### MCP 层对比

| 维度 | bb-browser | spawriter |
|------|-----------|-----------|
| MCP SDK | `@modelcontextprotocol/sdk` (官方) | `@modelcontextprotocol/sdk` (官方) |
| Tool 注册 | `server.tool()` + Zod schema | 手动定义 tool 数组 + ListToolsRequestSchema |
| Tool 粒度 | 原子化 (每个交互一个 tool) | 功能聚合 (playwright_execute + execute + 专项工具) |
| Tool 数量 | 20+ MCP tools (含 6 个 site adapter tools) | 30 个 MCP tools |
| 参数验证 | Zod runtime validation | 手动检查 |
| Site Adapters | 36 平台 / 103 命令 (独立 bb-sites repo) | 无 (专注 single-spa) |

### Extension / CDP 对比

| 维度 | bb-browser (v0.11.2) | spawriter |
|------|-----------|-----------|
| Extension | **已移除** | V3 Chrome Extension |
| CDP 连接 | Daemon 直连 Chrome CDP WebSocket | Extension chrome.debugger → Relay 转发 |
| UI | 无 | DevTools Panel + Toolbar Popup |
| 元素定位 | backendDOMNodeId (AX Tree + buildDomTree.js 混合) | CSS selector / Playwright locator / @ref |
| 状态管理 | Daemon TabStateManager (内存 ring buffers) | Extension 内存 + Relay 内存 |
| 多 Tab 管理 | 单 WebSocket + sessionId 多路复用 (flat protocol) | 每 client 独立 WebSocket + Tab Lease 系统 |

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

### 特性 7: 全局单调序列号 + `since` 查询 (优先级: 高)

> 2026-04-03 新增

**bb-browser 的做法**:
- 每个 action/event 递增一个全局 `seq` 计数器
- 所有 observation API（network、console、errors）支持 `since` 参数
- Agent 可以用 `since: "last_action"` 或数字 cursor 做增量查询
- Response 中携带 `cursor` 用于下次查询

```typescript
// protocol.ts 中的设计
type Response = {
  tab: string;
  seq: number;    // 全局单调递增
  cursor?: number; // observation API 的增量游标
  ...
};
```

**spawriter 现状**: `console_logs`/`network_log` 有 `count` 和 `clear`，但没有 cursor-based 增量查询。Agent 需要用 `clear: true` 清空后重新收集，可能丢失中间事件。

**建议方案**:
1. 在 Relay 层维护全局 `seq`（每次 CDP 命令/事件递增）
2. `console_logs`、`network_log` 增加 `since` 参数
3. Response 中返回 `cursor` 供下次查询
4. 保留 `clear` 作为显式重置手段

**价值**: 减少 agent 循环中的数据量，避免重复处理已见过的日志。对长时间 debug 会话特别有用。

### 特性 8: Tab 短 ID (优先级: 中)

> 2026-04-03 新增

**bb-browser 的做法**:
- 把 CDP `targetId`（UUID 格式）缩短为 `t1`, `t2` 等短 ID
- 在 `AGENTS.md` 中记录为设计不变量
- 所有 tool 的 `tab` 参数使用短 ID

**spawriter 现状**: `list_tabs` 返回完整 `spawriter-tab-xxxx-xxxx-xxxx...` 格式 ID（40+ 字符）。每次 agent 引用 tab 都要在 prompt 中包含完整 ID，浪费 token。

**建议方案**:
1. 在 Relay 层维护 `targetId → shortId` 映射（`s1`, `s2`, ...）
2. `list_tabs` 返回中包含 `shortId` 字段
3. `switch_tab`/`connect_tab` 同时接受 `shortId` 和完整 `targetId`
4. 短 ID 在 session 生命周期内唯一即可

**价值**: 减少约 30-40 token/次引用，对多 tab 操作场景累积节省显著。

### 特性 9: 无扩展 CDP 直连模式 (优先级: 高 — 架构方向)

> 2026-04-03 新增

**bb-browser 的做法**:
- v0.11.2 已**完全移除 Chrome 扩展依赖**
- Daemon 通过 `http://<host>:<port>/json/version` 发现 CDP endpoint
- 直接建立 WebSocket 到 `webSocketDebuggerUrl`
- 使用 `Target.setDiscoverTargets` + `Target.attachToTarget` (flatten: true) 管理多 tab

**spawriter 现状**: 强依赖 Chrome 扩展做 CDP 中转。安装流程：安装扩展 → 加载 → 点击 toolbar → attach tab → 才能使用。

**评估**:
- **Pro**: 无扩展模式极大简化安装和连接流程
- **Pro**: 消除 MV3 service worker 休眠问题
- **Con**: 需要用户用 `--remote-debugging-port` 启动 Chrome
- **Con**: 失去扩展的 DevTools Panel UI（import-map-overrides 管理）
- **Con**: `chrome.debugger` 通过扩展可以在普通 Chrome 上工作；直连 CDP 需要启动参数

**建议方案**: 不完全放弃扩展，但增加**可选的 CDP 直连模式**：
1. 新增 `relay` 启动参数 `--cdp-direct <host:port>`
2. 跳过扩展 WebSocket，直接连 Chrome 的 CDP
3. 检测 `--remote-debugging-port` 或 `CHROME_CDP_URL` 环境变量
4. 扩展模式保留为默认（因为 single-spa DevTools Panel 仍有价值）

**价值**: 为 CI/CD、无头测试、non-single-spa 用户提供低门槛的使用路径。

### 特性 10: 两阶段启动 + HTTP 503 (优先级: 低)

> 2026-04-03 新增

**bb-browser 的做法**:
- Daemon 先启动 HTTP 服务（接受请求排队）
- CDP 连接异步建立
- Chrome 未连接时返回 **503 Service Unavailable**

**spawriter 现状**: `ensureRelayServer` 检查 `/version` 端点，但启动流程散布在多处。

**建议方案**: 统一 Relay 启动状态机（`starting → http_ready → cdp_connected → fully_ready`），在 `http_ready` 但 `cdp` 未就绪时返回明确的 503 + JSON 错误体，而非超时。

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

### 4.3 Service Worker 状态持久化 → Daemon 内存管理

~~MV3 extension 的 service worker 会休眠。bb-browser 用 `chrome.storage.session` 持久化关键状态。~~

> **2026-04-03 更新**: bb-browser v0.11.2 已移除 Extension。Ref 映射现在由 Daemon 的 `TabStateManager` 在内存中管理（per-tab ring buffers）。这消除了 MV3 service worker 休眠问题，但也意味着 Daemon 重启会丢失状态。

对 spawriter 的启示：即使保留扩展，也应该考虑将关键状态（ref map、snapshot cache）在 Relay 层做备份，而非完全依赖 extension 内存。

### 4.4 CDP "Flat" 协议 — 单 WebSocket 多 Session

> 2026-04-03 新增

bb-browser Daemon 只建立**一个** browser-level WebSocket，使用 `Target.attachToTarget({ flatten: true })` 和 `sessionId` 字段在同一连接上多路复用多个 tab 的 CDP 命令。

```typescript
// cdp-connection.ts 精简
socket.on('message', data => {
  const msg = JSON.parse(data);
  if (msg.sessionId) {
    tabStateManager.routeEvent(msg.sessionId, msg);
  }
});

// 发送命令时指定 sessionId
socket.send(JSON.stringify({ id, method, params, sessionId: tabSession }));
```

spawriter 的 Relay 为每个 client 建立独立 WebSocket，由 extension 做 CDP 转发。Flat 模式的优势是减少连接数和简化路由逻辑。

### 4.5 Per-tab 环形缓冲区

> 2026-04-03 新增

bb-browser 为每个 tab 维护固定大小的 ring buffer：

| 类型 | 容量 |
|------|------|
| Network requests | 500 |
| Console entries | 200 |
| JS errors | 100 |

`TabStateManager` 在 `tab-state.ts` 中实现，内存占用可控。超出容量时自动丢弃最旧记录。

spawriter 的日志也有 `count` 参数限制返回量，但存储侧没有明确上限。建议在 MCP 层或 Relay 层为每个 tab session 设置环形缓冲区。

### 4.6 Monorepo 中的共享协议类型

bb-browser 把所有通信协议定义在 `packages/shared/src/protocol.ts` 中，一个文件定义所有 ActionType、Request、Response 类型。修改协议时只需改一个地方。

spawriter 的 extension 和 relay 之间的协议散落在多个文件中（`mcp/src/protocol.ts`、extension bridge），可以考虑统一。

### 4.7 MCP Tool 的 `tab` 参数统一设计

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
- [x] 结构化错误格式 *(部分实施)*
- [x] `accessibility_snapshot` 增加 `interactive_only` 参数 *(已实施)*
- [ ] Extension 关键状态备份到 Relay 层
- [ ] **全局 `seq` + `since` 增量查询** (特性 7)
- [ ] **Tab 短 ID** (特性 8)

### Phase 2: Ref 系统 (2-3 周)
- [x] 在 snapshot 中为可交互元素分配 ref 编号 *(已实施)*
- [x] `interact` 工具通过 ref 快捷交互 *(已实施)*
- [ ] Extension 侧 ref → backendDOMNodeId 映射优化

### Phase 3: 高级特性 (3-4 周)
- [x] 操作录制 (Trace) — start/stop/status tools *(已实施)*
- [x] `browser_fetch` 工具 — 带登录态的 fetch *(已实施)*
- [ ] `dialog` 处理工具

### Phase 4: 架构演进
- [ ] **可选 CDP 直连模式** (特性 9) — 无扩展 fallback
- [ ] 协议类型统一到 shared 包
- [ ] **Per-tab 环形缓冲区** (4.5)
- [ ] Session tab 清理
- [ ] 从 trace 事件自动生成 Playwright 测试脚本
- [ ] 两阶段 Relay 启动 + 503 状态 (特性 10)

---

## 附录: bb-browser 项目结构 (v0.11.2)

```
bb-browser/
├── packages/
│   ├── shared/          # 共享类型定义 (protocol.ts, constants.ts, buildDomTree.js)
│   ├── cli/             # CLI 命令 (30+ 命令, 每个一个文件)
│   │   └── src/commands/  # click.ts, hover.ts, snapshot.ts, trace.ts, ...
│   ├── daemon/          # HTTP 服务器 + CDP WebSocket 直连 Chrome
│   │   └── src/
│   │       ├── http-server.ts      # POST /command API
│   │       ├── cdp-connection.ts   # 单 WebSocket, flat protocol, sessionId 多路复用
│   │       ├── tab-state.ts        # Per-tab ring buffers (network/console/error)
│   │       └── command-dispatch.ts # 命令路由 + snapshot ref 分配
│   └── mcp/             # MCP Server (20+ tools, 官方 SDK + Zod)
│       └── src/index.ts   # ensureDaemon(), tool 定义
├── bin/bb-browserd.ts   # 独立 Bun 脚本 (gRPC/Connect hub 集成)
├── skills/              # AI agent skill 文件 (SKILL.md)
├── AGENTS.md            # 架构图 + 设计不变量 (tab shortId, seq, response contract)
└── README.md

注: extension/ 包已在 v0.11.2 中移除，CHANGELOG 确认改为 CDP 直连模式。
    SSE 相关常量 (constants.ts 中的 SSE_*) 为遗留代码。
```
