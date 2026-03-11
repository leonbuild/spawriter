# 架构与功能比较：spawriter vs playwriter vs agent-browser

> 目的：帮助决策在增强 spawriter 时参考哪个架构继续开发。

---

## 1. 项目定位

| 维度 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **一句话描述** | 面向 single-spa 的 AI 浏览器开发工具 | 连接用户已有 Chrome 的 AI 浏览器自动化工具 | 面向 AI 代理的无头浏览器自动化 CLI |
| **主要用户** | AI 代理 + 前端开发者 | AI 代理（任意 MCP 客户端） | AI 代理（编码助手） |
| **核心问题** | 让 AI 看到并控制实时浏览器中的微前端应用 | 让 AI 使用用户的已登录浏览器（保留 cookies、扩展、会话） | 让 AI 通过 CLI 驱动任意浏览器，交互紧凑、token 高效 |
| **领域** | 浏览器 DevTools + 微前端编排 | 通用浏览器自动化（用户浏览器） | 通用浏览器自动化（无头/有头） |
| **核心差异化** | single-spa 专属能力 | 复用用户浏览器状态、完整 Playwright API、单工具设计 | CLI 优先、快照-引用模式、安全策略 |

---

## 2. 架构概览

### spawriter：扩展 → 中继 → MCP

```
AI 客户端 ←stdio→ MCP 服务器 ←WS→ 中继服务器 ←WS→ Chrome 扩展 ←CDP→ 浏览器标签页
 (Cursor)      (Node/TS)        (Node/TS)        (chrome.debugger)       (页面)
```

- Chrome 扩展（Manifest V3），含 DevTools 面板、内容脚本、AI Bridge
- WebSocket 中继连接扩展和 MCP 服务器
- MCP 服务器通过 stdio 向 AI 客户端暴露工具
- 扩展通过 `chrome.debugger` API 执行 CDP 命令
- **端口**：19989

### playwriter：扩展 → 中继 → Playwright → MCP

```
AI 客户端 ←stdio→ MCP 服务器 → PlaywrightExecutor ←CDP WS→ 中继 ←WS→ Chrome 扩展 ←chrome.debugger→ 浏览器标签页
                 (Node/TS)     (VM 沙盒)            :19988  (Hono)   (MV3)
```

- Chrome 扩展（MV3）通过 `chrome.debugger` 连接用户已有标签页
- Hono WebSocket 中继服务器（端口 19988）桥接扩展和 Playwright
- Playwright 通过 CDP WebSocket 连接到中继，视标签页为 Playwright `Page`
- MCP 服务器暴露 `execute` 工具——在 VM 沙盒中运行 Playwright 代码
- 使用 `@xmorse/playwright-core`（fork，支持 frame 级别 CDP）
- **端口**：19988

### agent-browser：CLI → 守护进程 → Playwright

```
AI 代理 ←shell→ Rust CLI ←IPC→ Node.js 守护进程 ←Playwright→ 浏览器
                              (或通过 CDP 的原生 Rust 守护进程)
```

- Rust CLI 实现快速命令解析；守护进程维持持久浏览器会话
- 通过 Unix socket / 命名管道进行 IPC（JSON 换行分隔）
- 守护进程使用 Playwright Core（或原生模式下直接 CDP）
- 无障碍快照 → 稳定引用（`@e1`、`@e2`）→ 操作
- 无 MCP 协议——CLI 命令即接口

---

## 3. 技术栈比较

| 层级 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **语言** | TypeScript + JavaScript | TypeScript | Rust + TypeScript |
| **MCP 框架** | @modelcontextprotocol/sdk | @modelcontextprotocol/sdk | 无（CLI 优先） |
| **浏览器控制** | chrome.debugger (CDP) 通过扩展 | Playwright Core（fork）通过扩展中继 | Playwright Core / 直接 CDP |
| **Web 框架** | 无 | Hono | 无 |
| **实时通信** | WebSocket（中继） | WebSocket（中继） | WebSocket（流传输） |
| **桌面端** | Chrome 扩展 | Chrome 扩展 | Rust CLI + 守护进程 |
| **构建工具** | Webpack 5、Babel | pnpm workspace、tsc | Cargo、esbuild/tsc |
| **UI** | React 17（DevTools 面板） | 无独立 UI | 终端输出 / 流式查看器 |
| **持久化** | 无（内存中） | 内存（per-session state） | SQLite（状态）、加密文件 |
| **数据验证** | 手动 | Zod | Zod |
| **状态管理** | React useState | Zustand（中继状态） | 无 |
| **JS 执行** | CDP `Runtime.evaluate` | Node VM 沙盒（`vm.runInContext`） | Playwright eval / CDP |
| **包管理** | npm | pnpm | Cargo + npm |

---

## 4. 功能矩阵

### 4.1 浏览器自动化能力

| 功能 | spawriter（当前） | spawriter（v2.0 计划） | playwriter | agent-browser |
|------|-------------------|------------------------|------------|---------------|
| **页面导航** | `navigate` | `navigate` | 通过 Playwright `page.goto()` | `open`、`back`、`forward`、`reload` |
| **JS 执行** | CDP `Runtime.evaluate` | + Playwright VM 沙盒 | VM 沙盒（完整 Playwright API） | `eval`、CDP eval、Playwright 沙盒 |
| **截图** | 基础 | + 标注（AX 叠加层） | 标注截图（Vimium 风格标签） | 基础、全页、标注 |
| **无障碍快照** | 基础树 | + diff/搜索 | 文本树 + 定位器 + diff | 紧凑树 + 稳定引用 |
| **元素交互** | 通过 CDP eval | 通过 CDP + Playwright | 完整 Playwright API | `click`、`fill`、`hover`、`drag` 等 |
| **控制台捕获** | — | P0 | `getLatestLogs()` | `console` 命令 |
| **网络监控** | — | P0 | 网络拦截（Playwright） | `network` 命令 |
| **CSS 检查** | — | P2 | `createEditor()` + CSS CDP | `get styles`、`get box` |
| **调试器/断点** | — | P2 | `createDebugger()`（CDP Debugger） | `trace`、`profiler` |
| **视频录制** | — | P3 | `chrome.tabCapture`（30-60fps） | `record` 命令 |
| **代码编辑** | — | P2 | `createEditor()`（实时编辑页面脚本） | — |
| **状态持久化** | — | P1 | per-session `state` | `state save/load`、加密 |
| **会话管理** | 按标签页 | P2：ExecutorManager | `ExecutorManager`（命名会话） | 命名会话、配置文件 |
| **Ghost Cursor** | — | — | overlay 演示光标 | — |
| **远程访问** | — | — | traforo 隧道 / LAN | 云提供商（Browserbase 等） |
| **PDF 导出** | — | — | — | `pdf` 命令 |
| **差异对比** | — | — | 快照 diff | `diff snapshot/screenshot/url` |

### 4.2 微前端特有功能（仅 spawriter）

| 功能 | 描述 |
|------|------|
| single-spa 应用状态 | 列出已注册、已挂载、加载中的应用 |
| Import Map 覆盖 | 设置/移除/启用/禁用覆盖 |
| 应用生命周期控制 | 强制挂载、卸载、卸载注册 |
| 清除缓存并重载 | 缓存清除 + 重新加载 |
| 叠加层高亮 | 可视化微前端边界高亮 |

### 4.3 MCP 工具设计

| 方面 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **工具数量** | 10 个专用工具 | 1 个 `execute` + 1 个 `reset` | 约 50 个 CLI 命令 |
| **设计哲学** | 每功能一工具 | 单工具 + 完整 API | 每操作一命令 |
| **代码执行** | CDP eval（字符串） | VM 沙盒（Playwright 代码） | Shell 命令 |
| **上下文注入** | 无 | `page`、`context`、`state`、`require` | 无（引用系统） |
| **MCP 资源** | 无 | `debugger-api`、`editor-api`、`styles-api` | 无 |
| **Token 效率** | 中等 | 高（单工具 + 快照） | 高（紧凑快照 + 引用） |

### 4.4 浏览器连接模式

| 方面 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **连接方式** | 扩展 chrome.debugger | 扩展 chrome.debugger → Playwright | 直接 Playwright / CDP |
| **使用用户浏览器** | 是（扩展） | 是（扩展） | 否（通常启动新实例） |
| **保留登录状态** | 是 | 是 | 需手动配置 profile |
| **保留扩展** | 是 | 是 | 否（无头浏览器） |
| **用户显式同意** | 点击扩展图标 | 点击扩展图标 | 无需（CLI 启动） |
| **跨浏览器** | 仅 Chrome | 仅 Chrome | Chromium/Firefox/WebKit |

---

## 5. 通信与协议设计

| 方面 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **AI ↔ 服务器** | MCP stdio | MCP stdio | Shell 命令 |
| **服务器 ↔ 浏览器** | WS → 扩展 → CDP | Playwright → CDP WS → 中继 → 扩展 → CDP | Playwright / 直接 CDP |
| **中继协议** | 自定义 WS 消息 | 类型化消息（ForwardCDPCommand 等） | JSON IPC |
| **端口** | 19989 | 19988 | 动态 |
| **多客户端** | 单代理/中继 | 多 Playwright 客户端（`/cdp/:id`） | 单代理/守护进程 |
| **状态同步** | Chrome 扩展消息 | Zustand 状态（纯函数转换） | 无 |
| **保活** | — | — | 守护进程持久运行 |
| **认证** | — | Token（`--token`、`PLAYWRITER_TOKEN`） | Auth 保险库（AES-256-GCM） |

---

## 6. 扩展性与配置

| 方面 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **插件系统** | 无 | 无（但 VM 沙盒可扩展） | Provider 系统 |
| **配置文件** | — | — | `agent-browser.json` |
| **环境变量** | `SPAWRITER_MCP_PORT` | `PLAYWRITER_TOKEN` | 20+ 个 `AGENT_BROWSER_*` |
| **技能/规则** | Cursor rules + skills | Cursor skills | Skills（多平台） |
| **自定义能力** | `execute`（CDP eval） | `execute`（完整 Playwright API） | `eval` + `playwright_eval` |
| **MCP 资源** | 无 | API 文档资源 | 无 |

---

## 7. 架构质量评估

| 质量指标 | spawriter | playwriter | agent-browser |
|----------|-----------|------------|---------------|
| **关注点分离** | 良好（扩展/中继/MCP 分离） | 优秀（扩展/中继/Executor/MCP 四层分离） | 优秀（CLI/守护进程/浏览器清晰分层） |
| **错误处理** | 基础（重试、错误类型） | 良好（协议错误、可恢复错误分类） | 良好（重试、回退、错误分类） |
| **会话隔离** | 按标签页 | 命名会话（ExecutorManager） | 命名会话 + 配置文件 |
| **持久化** | 无 | 内存（session state） | SQLite + 加密文件 |
| **多配置文件** | 无 | 支持（stableKey: profile/email） | 支持（--profile） |
| **环境支持** | 仅 Chrome | 仅 Chrome + 远程访问 | 全平台 + 云 + iOS |
| **协议稳定性** | 未文档化 | 向后兼容承诺 | 未明确 |
| **生产就绪度** | Alpha/Beta | Beta/成熟中 | 成熟 |

---

## 8. 关键架构差异分析

### 8.1 JS 执行模型（最关键差异）

| | spawriter | playwriter | agent-browser |
|--|-----------|------------|---------------|
| **执行方式** | CDP `Runtime.evaluate`（页面上下文） | Node VM 沙盒（`vm.runInContext`） | Playwright API / CDP eval |
| **可用 API** | 仅页面 JS | 完整 Playwright + 页面 JS + Node 模块 | CLI 命令 + eval |
| **沙盒隔离** | 无（直接页面执行） | 有（VM 上下文 + 受限 require） | 无 |
| **自动返回** | 手动 | AST 分析自动返回单表达式 | 手动 |
| **跨调用状态** | 无 | `state` 对象持久化 | `state save/load` |

spawriter 目前使用的是最简单的执行模型（CDP eval），但 FEATURE_ENHANCEMENT_PLAN 的 Phase 2 计划引入 playwriter 的 VM 沙盒模式。

### 8.2 工具设计哲学

| 哲学 | spawriter | playwriter | agent-browser |
|------|-----------|------------|---------------|
| **风格** | 多工具（每功能一工具） | 单工具（`execute` 包办一切） | 多命令（每操作一命令） |
| **Token 开销** | 工具定义多 → schema 大 | 工具定义少 → schema 小 | 无 schema（CLI help） |
| **学习曲线** | 低（工具名自解释） | 中（需了解 Playwright API） | 低（命令名自解释） |
| **灵活性** | 低（预定义操作） | 高（任意 Playwright 代码） | 中（预定义 + eval） |

### 8.3 录制能力

| | spawriter | playwriter | agent-browser |
|--|-----------|------------|---------------|
| **方式** | — | `chrome.tabCapture`（扩展原生） | Playwright trace / screencast |
| **帧率** | — | 30-60 fps | 取决于配置 |
| **跨导航** | — | 支持（tab 级别捕获） | 取决于实现 |
| **效率** | — | 高（扩展直接访问媒体流） | 中（base64 帧） |

### 8.4 CDP 中继架构对比

| | spawriter | playwriter |
|--|-----------|------------|
| **中继协议** | 自定义消息格式 | 类型化消息 + Zustand 状态 |
| **Playwright 集成** | 无 | 通过 CDP WS 桥接 |
| **多标签页** | 支持 | 支持（target 过滤） |
| **多客户端** | 单客户端 | 多 Playwright 客户端（`/cdp/:id`） |
| **状态管理** | 无形式化 | Zustand 纯函数转换 |

---

## 9. spawriter 增强决策框架

### 从 playwriter 可以学到什么（最高优先级）

1. **VM 沙盒执行模型**：`vm.runInContext()` + 完整 Playwright API 是 spawriter v2.0 计划的核心。playwriter 已经实现了这个模式，包括上下文注入（`page`、`context`、`state`）、自动返回、受限 `require`。
2. **ExecutorManager**：命名会话 + session 级别状态隔离的实现可以直接参考。
3. **CDP 中继增强**：playwriter 的中继支持多 Playwright 客户端（`/cdp/:id`），Zustand 状态管理比 spawriter 的更形式化。
4. **标注截图**：Vimium 风格标签在 token 效率和准确性上优于纯无障碍树。
5. **录制能力**：`chrome.tabCapture` 是扩展架构独有的优势，比 Playwright 文件录制更高效。
6. **调试器和代码编辑器**：`createDebugger()` 和 `createEditor()` 是强大的开发者工具能力。
7. **Playwright fork**：`@xmorse/playwright-core` 添加了 frame 级别 CDP 支持，对复杂页面很有价值。

### 从 agent-browser 可以学到什么

1. **快照-引用模式**：`@e1`/`@e2` 稳定引用系统在 token 效率上很优雅。可以作为无障碍快照的增强。
2. **会话持久化**：SQLite + 加密的 `state save/load` 比纯内存持久化更可靠。
3. **安全模型**：Auth 保险库、域名白名单、操作策略——如果 spawriter 扩展到生产场景会有用。
4. **差异对比**：`diff snapshot`、`diff screenshot`、`diff url` 对回归测试有价值。
5. **守护进程持久化**：持久进程模式避免重复启动开销，值得参考。
6. **跨浏览器支持**：通过 Playwright 支持 Firefox/WebKit，虽然与扩展模式不完全兼容。

### spawriter 已有的独特优势

1. **single-spa 专业化**：应用状态、Import Map 覆盖、生命周期控制——独一无二的价值。
2. **DevTools 面板**：直接集成在 Chrome DevTools 中，开发者体验最好。
3. **叠加层高亮**：可视化微前端边界，其他工具没有。

---

## 10. 推荐架构方向

### 方案 A：深度融合 playwriter（推荐）

将 playwriter 的核心能力（Executor、VM 沙盒、录制、调试器）整合进 spawriter，形成统一产品。

```
AI 客户端 ←stdio→ MCP 服务器 ←→ 中继 ←WS→ 扩展 (chrome.debugger)
                    ↓                           ↓
              ExecutorManager              浏览器标签页
              (VM 沙盒、state)
              ↓
        single-spa 工具    +    通用 Playwright 工具
        (dashboard_state,       (execute, screenshot,
         override_app,           console_logs, network,
         app_action)             debugger, editor, recording)
```

**优点：**
- spawriter 和 playwriter 共享相同的扩展架构，技术上最容易合并
- 保留 single-spa 专属能力
- 获得完整 Playwright API + 录制 + 调试器
- 与 FEATURE_ENHANCEMENT_PLAN 完全一致
- 不增加新的运行时依赖

**缺点：**
- 需要处理两个代码库的合并
- playwriter 的 Playwright fork 引入额外维护成本

**工作量估计：** 与 FEATURE_ENHANCEMENT_PLAN 的 Phase 1-2 一致，约 2-3 周。

### 方案 B：保持独立 + 选择性借鉴

不合并代码库，仅从 playwriter 和 agent-browser 借鉴设计模式，在 spawriter 中重新实现。

**优点：**
- 不依赖外部代码
- 可以挑选最适合的实现

**缺点：**
- 重新实现成本高
- 可能错过 playwriter 已验证的细节

### 方案 C：agent-browser 式重写

放弃扩展模式，改为 CLI + 守护进程架构。

**优点：**
- 跨浏览器、不依赖扩展

**缺点：**
- 失去 DevTools 面板、扩展级 API、single-spa 叠加层
- 失去复用用户浏览器状态的核心优势
- 本质上是重建 agent-browser

### 推荐

**方案 A（深度融合 playwriter）** 是最佳路径：

1. spawriter 和 playwriter 共享相同的底层架构（Chrome 扩展 + WebSocket 中继 + CDP），合并自然。
2. FEATURE_ENHANCEMENT_PLAN 已经规划了从 playwriter 引入的核心功能（`playwright_execute`、控制台、网络监控）。
3. 合并后的产品 = single-spa 专业化 + 通用浏览器自动化 + 完整 Playwright API + 用户浏览器复用。
4. agent-browser 的快照-引用模式和安全特性可以作为后续增强，但不是第一优先级。

**阶段建议：**
- **Phase 1**（1 周）：引入 playwriter 的控制台捕获和网络监控（纯 CDP，与 FEATURE_ENHANCEMENT_PLAN 一致）
- **Phase 2**（1-2 周）：引入 ExecutorManager + VM 沙盒 + `execute` 工具升级
- **Phase 3**（按需）：引入调试器、代码编辑器、录制、标注截图
- **后续**：从 agent-browser 借鉴快照-引用模式和差异对比能力
