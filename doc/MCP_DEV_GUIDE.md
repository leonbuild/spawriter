# spawriter 开发指南（方案 A：CDP Relay + Playwright MCP）

本文档目标：在 **不破坏现有 spawriter 的人类 DevTools 体验**（面板、覆盖、Clear Cache & Refresh）前提下，新增一套 **给 AI 使用的 MCP 服务**，使 AI 能连接到“人类正在使用的真实 Chrome Tab”，从而 **看见并操作** import-map-overrides 覆盖后的最终渲染结果。

参考实现：`playwriter`（同仓库中的 `d:\dev-side\playwriter`）。

---

## 术语

- **扩展（Extension）**：`spawriter` 现有 Chrome 扩展（MV3 service worker + DevTools panel + content scripts）。
- **Relay Server**：本机 Node 进程提供的 WebSocket/HTTP 服务，用于桥接扩展和 CDP 客户端（Playwright）。
- **CDP**：Chrome DevTools Protocol。
- **MCP Server**：本机 Node 进程，以 stdio transport 暴露 MCP tools，内部使用 Playwright `connectOverCDP` 操作真实 Tab。
- **AI Client**：Cursor/Claude 等 MCP 客户端。

---

## 需求与验收标准

### 功能性验收（必须）

- **真实渲染可见**：AI 通过 MCP 能拿到截图/可访问性快照，内容与人类 Chrome 中“被 override 后”的实际页面一致。
- **真实 Tab 可操作**：AI 可点击/输入/导航/执行 JS；至少提供 `execute(code)` 与 `reset()` 两个基础 tool。
- **不破坏原功能**：
  - DevTools panel 正常工作（mount/unmount、overlay 等）。
  - Import Map Overrides UI 正常工作（依赖 `window.importMapOverrides`）。
  - 浏览器 toolbar 点击仍然执行 **Clear Cache & Refresh**（人类感知路径不变）。
- **“无感清缓存/重渲染（给 AI）”**：
  - MCP 工具在某些操作中默认执行（例如首次连接、或检测到页面明显“旧资源/旧覆盖”时）。
  - 同时提供显式 tool：AI 可以自己触发清缓存/刷新。

### 安全性验收（必须）

- Relay 的 **extension 入口只能被本机扩展连接**（localhost + origin 校验）。
- CDP 客户端入口对外可选 token（默认本机无需 token；远程模式必须 token）。
- 不向网页注入新的高权限对象（除了现有内容脚本能力）；CDP 权限仅由扩展 `chrome.debugger` 持有。

---

## 总体架构（推荐落地）

### 架构图（数据流）

1. AI Client ⇄（stdio）⇄ MCP Server（Node）
2. MCP Server ⇄（WS/CDP）⇄ Relay Server（Node）
3. Relay Server ⇄（WS）⇄ Extension background（MV3 service worker）
4. Extension background ⇄（chrome.debugger）⇄ 真实 Chrome Tab

关键点：**AI 不再打开“另一个浏览器”**，而是通过 CDP 连接到人类正在看的真实 Tab，因此 override 后的渲染自然可见。

### 组件职责拆分

- **Extension（新增“AI Bridge”模块）**

  - 维护到 Relay 的 WS 连接（类似 playwriter 的 `extension/src/background.ts`）。
  - 将 Relay 发来的 `forwardCDPCommand` 转成 `chrome.debugger.sendCommand`，并把 `chrome.debugger.onEvent` 转回 Relay（`forwardCDPEvent`）。
  - 额外提供“无感清缓存/刷新”的能力（通过 `browsingData`+`tabs.reload`），但不改变现有 action click 语义。

- **Relay Server（新增 Node 包）**

  - 提供 `/extension` WS：只允许 localhost 且 Origin 必须是本扩展 ID。
  - 提供 `/cdp/:clientId` WS：给 Playwright 连接，转发 CDP command/event（参考 `playwriter/src/cdp-relay.ts`）。
  - 提供 CDP discovery endpoints：`/json/version`、`/json/list` 等（方便 Playwright/工具发现）。
  - 可选：`/mcp-log` 便于 MCP 写日志。

- **MCP Server（新增 Node 包）**
  - `chromium.connectOverCDP(ws://127.0.0.1:<port>/cdp/<id>)`
  - 暴露工具：`execute`、`reset`、`screenshot`、`accessibilitySnapshot`、`clearCacheAndReload`、`ensureFreshRender`（无感策略入口）。

---

## 与 playwriter 的对照（你应该复用的核心点）

### 必须复用的模式

- **Relay 服务器协议与端点设计**：几乎可直接照搬 `playwriter/src/cdp-relay.ts`
  - `/extension`（extension 连接）
  - `/cdp/:clientId?`（Playwright/客户端连接）
  - `/json/version`、`/json/list` 等
- **扩展端的转发模型**：可直接照搬 `playwriter/extension/src/background.ts` 的结构
  - ConnectionManager（重连、ping/pong、并发保护）
  - attachTab / detachTab（用 `chrome.debugger.attach`）
  - `forwardCDPCommand` / `forwardCDPEvent` 消息格式（可直接复用 `playwriter/src/protocol.ts`）
- **MCP 端 `connectOverCDP`**：照搬 `playwriter/src/mcp.ts` 的 `ensureRelayServer()` / `ensureConnection()` 思路，但简化到你需要的工具集。

### 不建议照搬的点（可后置）

- 复杂的 VM sandbox 执行环境、selector generator、React source、styles extractor 等（这些是锦上添花，先不做）。

---

## 目录与包结构建议（允许大改，但保持清晰）

建议在 `spawriter` 下新增一个 `mcp/` 子目录（独立 Node 工程）：

```
spawriter/
  mcp/
    package.json
    src/
      cli.ts                # 类似 playwriter/src/cli.ts
      mcp.ts                # MCP server（stdio）
      relay.ts              # Relay server（ws + hono/express）
      protocol.ts           # Extension<->Relay 消息类型（可复制 playwriter/src/protocol.ts）
      utils.ts              # getCdpUrl、VERSION、sleep
```

扩展侧保持现有 webpack 构建，但新增一个模块文件（或直接合入 background）：

```
spawriter/src/
  background_script.js      # 现有：panel通信、clear cache、tabs.reload
  ai_bridge/
    bridge.js               # 新增：WS 连接 relay、chrome.debugger 转发 CDP
```

> 注：你现在 `webpack.config.js` entry 已固定，如需打包新模块，建议 `bridge.js` 被 `background_script.js` import 引入即可，不必新增 entry。

---

## 权限与 manifest 修改（Chrome）

### 必须新增的权限

- `debugger`：让扩展能 attach 到真实 tab 并执行 CDP 命令（核心能力）
- 保持现有：`tabs`、`browsingData`、`storage`、`scripting`

### manifest 修改点

在 `manifest.json` 与 `dist-chrome/manifest.json` 的生成流程里加入 `debugger` 权限。

> 你有 `scripts/build-chrome.js`，要确认最终 chrome 包的 manifest 也带上 `debugger`。

---

## Relay Server 设计（仿 playwriter）

### 端口与发现

- 默认端口：`19989`（独立于 playwriter 的 19988，两个扩展可共存）
- discovery endpoints：
  - `GET /` → `OK`
  - `GET /version` → `{ version }`
  - `GET /json/version` → `{ webSocketDebuggerUrl }`
  - `GET /json/list` → 返回当前已 attach 的 targets 列表

### WebSocket 端点

- `GET /extension`（WS upgrade）

  - **必须**：只允许 localhost（remoteAddress 127.0.0.1/::1）
  - **必须**：校验 `Origin: chrome-extension://<extensionId>`
  - **必须**：只允许你的 extensionId（dev 与 prod 两个）
  - 功能：接收 extension 发来的 `forwardCDPEvent`，并转发给所有 CDP clients；同时接收 CDP clients 的命令并转发给 extension。

- `GET /cdp/:clientId?`（WS upgrade）
  - 可选：token 校验（query `?token=...`）
  - Node 客户端通常无 Origin，可放行；如果有 Origin 则校验（照 playwriter）

### 消息协议

复用 playwriter 的最小协议（`playwriter/src/protocol.ts`）：

- Relay → Extension：`{ id, method:"forwardCDPCommand", params:{ method, sessionId?, params? } }`
- Extension → Relay：
  - response：`{ id, result? , error? }`
  - event：`{ method:"forwardCDPEvent", params:{ method, sessionId?, params? } }`
  - log：`{ method:"log", params:{ level, args } }`
  - pong：`{ method:"pong" }`

---

## Extension AI Bridge 设计（仿 playwriter）

### 关键策略

- **action click 为 per-tab attach/detach**：工具栏按钮点击切换当前 tab 的 attach/detach 状态（与 playwriter 行为一致）。badge 显示 attached 数量与状态：绿色+数字=本 tab 已连接，黄色+"..."=连接中，灰色+数字=其他 tab 已连接，无 badge=无连接，红色+"!"=错误。多个 tab 可同时 attached。
- AI Bridge 初始为空闲状态，需点击工具栏按钮 attach 当前 tab 后才会连接 relay；attached 的 tab 会归入绿色 "spawriter" tab 组。
- MV3 service worker 可能被杀：需像 playwriter 一样 `maintainLoop()` 重连，并支持 relay 的 ping/pong keep-alive。

### Tab 选择策略（简化版）

初期只支持“当前活跃 tab”：

- MCP 端调用 tool `connectActiveTab()`（内部发消息给 extension：让它 attach 当前 active tab）。
- 后续再支持多 tab 或根据 URL/Title 选择。

> playwriter 是用户点击 icon 把 tab 加入 “playwriter group”。你这里不需要 UI，但可以复用同样的 tab tracking map。

### Debugger attach 要点

- `chrome.debugger.attach({tabId}, '1.3')`
- `Page.enable`/`Runtime.enable` 等由 CDP 客户端发起（relay 只转发）
- 处理 restricted url：`chrome://`、`chrome-extension://`、`edge://` 等直接拒绝

---

## MCP Server 设计（仿 playwriter，但更聚焦）

### 最小工具集（MVP）

1. `execute`

   - 输入：`code`（一行 JS；scope 内有 `{ page, context }`）
   - 行为：`connectOverCDP` → 获取 page → `page.evaluate` / 允许用户写 Playwright 代码（与 playwriter 类似，但可先不做 vm sandbox）

2. `reset`

   - 重新建立 CDP 连接（关闭旧连接 → 重新 connect）

3. `screenshot`

   - 直接 `page.screenshot()`，返回 image

4. `accessibility_snapshot`

   - 返回可访问性树/或 Playwright 的 accessibility snapshot（可简化为 Playwright 的相关 API）

5. `clear_cache_and_reload`

   - 通过 Relay → Extension 发指令（新增一个非 CDP 的扩展命令也可以，或直接用 CDP 清缓存+reload）

6. `ensure_fresh_render`（无感策略入口）
   - 默认在以下时机触发：
     - MCP 首次连接成功后
     - 检测到页面“可能旧”的信号（见下）

### “无感清缓存/重渲染”策略（建议）

目标：AI 使用时尽量确保渲染是最新的，但不让人类感知到频繁刷新。

建议分层：

- **轻量优先（默认）**：

  - 只在 MCP 首次连接到 tab 时执行一次：
    - `Network.clearBrowserCache`（若可用）
    - `Page.reload({ ignoreCache: true })`
  - 或者调用扩展侧的 `tabs.reload(bypassCache:true)`（与人类按钮一致，但由 AI 隐式触发）

- **强制模式（显式 tool）**：

  - `clear_cache_and_reload({ mode: "aggressive" })`：
    - 扩展侧 `browsingData.remove({since:0},{cache:true,serviceWorkers:true})`
    - 然后 `tabs.reload({ bypassCache:true })`

- **触发条件（自动）**：
  - MCP 连接后发现 `window.importMapOverrides` 存在且 overrides 非空，但页面 UI 不符合预期（这很难自动判断，建议只做一次“连接时”刷新）
  - 或者 AI 明确要求“刷新/清缓存”

> 注意：`browsingData.remove` 是全局级别，过于 aggressive 会影响人类；所以默认只做 ignoreCache reload，强制模式才做全量清缓存+SW。

---

## 分阶段实施计划（强烈建议按这个顺序）

### 阶段 0：准备与约束（半天）

- 确认 extensionId：
  - dev（unpacked）id
  - prod id（webstore）
- 选定 relay 端口（当前为 19989，独立于 playwriter 的 19988）
- 决定 Node 版本（建议 >= 18；playwriter 用 >=18）

产出：

- 文档中填入两个 extensionId
- 约定环境变量：`SSPA_MCP_PORT`、`SSPA_MCP_TOKEN`（可选）

---

### 阶段 1：新增 Relay Server（1 天）

1. 新建 `spawriter/mcp/package.json`
   - 依赖：`@modelcontextprotocol/sdk`、`playwright-core`、`hono`、`@hono/node-server`、`@hono/node-ws`、`zod`（可按 playwriter）
2. 实现 `mcp/src/relay.ts`
   - 基本路由：`/`、`/version`、`/json/version`、`/json/list`
   - WS：`/extension`、`/cdp/:clientId`
   - 先不实现 token（本机模式），但预留接口
3. 加一个 `mcp/src/utils.ts`：`getCdpUrl()`（复用 playwriter 思路）

验证：

- `node relay.ts` 启动后 `GET /` 返回 OK
- WS 端点可用（暂时没有 extension 连接也没关系）

---

### 阶段 2：扩展侧 AI Bridge（2 天）

1. manifest 增加 `debugger` 权限（chrome）
2. 在 `src/background_script.js` 里 import `./ai_bridge/bridge.js`
3. 实现 `src/ai_bridge/bridge.js`
   - WS 连接 relay：`ws://localhost:<port>/extension`
   - 处理 `ping`→`pong`
   - 实现 `forwardCDPCommand`：
     - 找到目标 tab（先 active tab 或某个已登记 tab）
     - `chrome.debugger.sendCommand(...)`
   - 监听 `chrome.debugger.onEvent`：
     - 转成 `forwardCDPEvent` 发回 relay
   - 支持 attach/detach（最初只 attach active tab）
4. 工具栏按钮改为 per-tab attach/detach（通过 `browser.action.onClicked` 切换当前 tab 的 attach/detach 状态）

验证：

- 打开任意页面，确保 DevTools 面板仍可用
- Relay 显示 extension 已连接
- 能通过 relay 发一条简单 CDP 命令（例如 `Runtime.evaluate`）并收到结果

---

### 阶段 3：MCP Server（1–2 天）

1. 实现 `mcp/src/mcp.ts`
   - `ensureRelayServer()`（可选：自动拉起 relay；或让用户单独起）
   - `ensureConnection()`：`chromium.connectOverCDP(getCdpUrl(...))`
2. 暴露 MCP tools（MVP）：
   - `execute`
   - `reset`
   - `screenshot`
   - `accessibility_snapshot`
   - `clear_cache_and_reload`
   - `ensure_fresh_render`
3. 实现 `mcp/src/cli.ts`：
   - `spawriter`：启动 MCP server
   - `spawriter serve`：启动 relay server（可选远程 token 模式）

验证：

- MCP client 能连上并截图
- 截图与人类页面一致（含 override 后效果）

---

### 阶段 4：增强与稳定性（按需）

- 多 tab 支持（选择 URL/title/tabId）
- 页面 ready 策略（等待 single-spa 应用稳定）
- 日志与诊断（`/mcp-log`、ring buffer）
- 访问控制（token 强制，远程 relay 模式）

---

## 测试清单（建议你每个阶段都跑）

### 回归（人类功能）

- DevTools panel 打开无报错
- mount/unmount 按钮工作
- overlays 工作
- Import Map Overrides：保存/开关/重载工作
- toolbar 点击：per-tab attach/detach 正常（badge 显示 attached 数量与状态）

### AI 功能

- MCP `screenshot` 能得到真实渲染（含 override）
- MCP `execute` 能读 `location.href`、能 `document.querySelector(...)`
- `ensure_fresh_render` 不会导致频繁刷新（只在首次连接/显式调用）

---

## 安全注意事项（必须读）

- `debugger` 权限等同“高权限自动化”，发布到商店需要在文档中解释用途。
- Relay `/extension` 必须限制 localhost + origin，否则可能被网络内攻击者劫持浏览器会话。
- `browsingData.remove` 是全局操作：默认不要自动跑 aggressive 清缓存；只在显式 tool 或特定场景跑。

---

## 与现有文档的衔接

- Clear cache 相关研究：`doc/CLEAR_CACHE_FEATURE_RESEARCH.md`
- MV3 生命周期问题：`doc/FIX_EXTENSION_CONTEXT_INVALIDATED.md`

此 MCP 方案需要额外面对 MV3 service worker 被杀的问题；建议直接复用 playwriter 的重连/keep-alive 思路。
