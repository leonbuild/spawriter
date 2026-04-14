# CDP 增强计划：利用 Chrome DevTools Protocol 弥补 Playwright 缺口

> 目的：基于 CDP 完整域能力分析，制定 spawriter 的下一阶段增强路线，覆盖 playwriter 现有功能并超越。

---

## 1. 现状分析

### 1.1 spawriter 当前能力（27 个 MCP 工具）

| 类别 | 工具 | CDP 域 |
|------|------|--------|
| **页面观察** | `screenshot`, `accessibility_snapshot` | `Page.captureScreenshot`, `Accessibility.*` |
| **代码执行** | `execute`, `playwright_execute` | `Runtime.evaluate`, Playwright API |
| **日志/网络** | `console_logs`, `network_log`, `network_detail` | `Runtime.consoleAPICalled`, `Network.*` |
| **调试** | `debugger`, `css_inspect` | `Debugger.*`, `Runtime.*`, `CSS.*` |
| **导航/刷新** | `navigate`, `ensure_fresh_render`, `clear_cache_and_reload` | `Page.navigate`, `Network.clearBrowserCache` |
| **微前端** | `dashboard_state`, `override_app`, `app_action` | `Runtime.evaluate` |
| **会话** | `session_manager`, `reset` | Playwright 连接管理 |

### 1.2 playwriter 独有能力（spawriter 缺失）

| 能力 | playwriter 实现 | CDP 域 | 可行性 |
|------|----------------|--------|--------|
| **代码编辑器** | `createEditor()` — 列出/读取/编辑/搜索页面脚本和 CSS | `Debugger.*`, `CSS.*`, `DOM.*` | ✅ 纯 CDP |
| **视频录制** | `chrome.tabCapture` + MediaRecorder | 扩展 API (非 CDP) | ⚠️ 需改扩展 |
| **Ghost Cursor** | 注入 SVG 覆盖层显示鼠标位置 | `Runtime.evaluate` | ✅ 简单注入 |
| **React 源码定位** | `getReactSource()` — 查找组件源文件和行号 | `Runtime.evaluate` + React DevTools 内部 API | ✅ Runtime 注入 |
| **MCP 资源** | `debugger-api.md`, `editor-api.md`, `styles-api.md` | 无（静态资源） | ✅ 文档 |
| **HTML/Markdown 导出** | `getCleanHTML()`, `getPageMarkdown()` | `DOM.*`, `Runtime.evaluate` | ✅ 纯 CDP/JS |
| **Demo 视频** | FFmpeg 拼接截图+录制 | 本地工具 | ⚠️ 外部依赖 |

### 1.3 CDP 域全景：未开发能力

Chrome DevTools Protocol 共有 50+ 个域。以下是 spawriter 和 playwriter **均未充分利用**的高价值域：

| CDP 域 | 用途 | AI Agent 价值 |
|--------|------|---------------|
| **Performance** | 运行时性能指标（FPS、布局、脚本时间） | 🔴 高 — AI 性能诊断 |
| **PerformanceTimeline** | Web Vitals（LCP、FID、CLS）、PerformanceObserver 事件 | 🔴 高 — 核心体验指标 |
| **Memory** | 内存压力、DOM 节点计数 | 🟡 中 — 内存泄漏检测 |
| **HeapProfiler** | 堆快照、采样分析 | 🟡 中 — 深度内存分析 |
| **Profiler** | CPU 采样分析 | 🟡 中 — 性能瓶颈定位 |
| **Tracing** | Chrome Trace 格式输出（Timeline） | 🟡 中 — 全面性能追踪 |
| **Storage** | Cookie、IndexedDB、CacheStorage、LocalStorage 管理 | 🔴 高 — 状态检查/清理 |
| **IndexedDB** | IndexedDB 数据库/对象存储 CRUD | 🟡 中 — 数据检查 |
| **DOMStorage** | localStorage / sessionStorage 操作 | 🔴 高 — 状态管理调试 |
| **CacheStorage** | Service Worker 缓存管理 | 🟡 中 — PWA 调试 |
| **ServiceWorker** | SW 注册/注销/更新/推送 | 🟡 中 — PWA 调试 |
| **DOMSnapshot** | 完整 DOM + 布局 + 样式快照 | 🟡 中 — 页面结构分析 |
| **Overlay** | 高亮元素、网格/弹性布局可视化 | 🟡 中 — 可视化调试 |
| **Emulation** | 设备模拟、地理位置、时区、媒体查询 | 🔴 高 — 响应式测试 |
| **Input** | 合成鼠标/键盘/触摸事件 | 🟡 中 — 精确交互 |
| **Fetch** | 网络请求拦截/修改 | 🔴 高 — API mock/修改 |
| **Security** | 证书信息、安全状态 | 🟢 低 — 安全检查 |
| **Audits** | Lighthouse 问题检测 | 🟡 中 — 自动审计 |
| **Animation** | CSS 动画控制 | 🟢 低 — 动画调试 |
| **Log** | 浏览器日志（含 SW 和 Violations） | 🟡 中 — 扩展日志源 |
| **WebAudio** | 音频上下文检查 | 🟢 低 — 特殊场景 |
| **LayerTree** | 合成层可视化 | 🟢 低 — 渲染性能 |

---

## 2. 增强路线

### Phase 4：存储与状态检查（优先级 P0）

> **目标**：让 AI 能读写浏览器存储状态，极大增强调试和状态管理能力。

#### 4.1 `storage` 工具

**CDP 域**：`DOMStorage`, `Storage`, `Network`（Cookie）

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `get_cookies` | 获取页面/域的所有 Cookie | `Network.getCookies` |
| `set_cookie` | 设置 Cookie | `Network.setCookie` |
| `delete_cookie` | 删除指定 Cookie | `Network.deleteCookies` |
| `get_local_storage` | 读取 localStorage | `DOMStorage.getDOMStorageItems` |
| `set_local_storage` | 写入 localStorage | `DOMStorage.setDOMStorageItem` |
| `remove_local_storage` | 删除 localStorage 项 | `DOMStorage.removeDOMStorageItem` |
| `get_session_storage` | 读取 sessionStorage | `DOMStorage.getDOMStorageItems`（isLocalStorage=false） |
| `clear_storage` | 清除指定类型的存储 | `Storage.clearDataForOrigin` |
| `get_storage_usage` | 获取存储使用量和配额 | `Storage.getUsageAndQuota` |

```typescript
{
  name: 'storage',
  description: 'Manage browser storage: cookies, localStorage, sessionStorage, cache. Read, write, delete entries.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'get_cookies', 'set_cookie', 'delete_cookie',
        'get_local_storage', 'set_local_storage', 'remove_local_storage',
        'get_session_storage',
        'clear_storage', 'get_storage_usage'
      ]},
      key: { type: 'string', description: 'Storage key for get/set/remove' },
      value: { type: 'string', description: 'Value for set operations' },
      name: { type: 'string', description: 'Cookie name for set/delete' },
      domain: { type: 'string', description: 'Cookie domain' },
      url: { type: 'string', description: 'URL for cookie operations' },
      origin: { type: 'string', description: 'Origin for clear/usage operations' },
      storage_types: { type: 'string', description: 'Comma-separated: cookies,local_storage,session_storage,cache_storage,indexeddb,service_workers' },
    },
    required: ['action'],
  },
}
```

**工作量**：1 天  
**价值**：🔴 极高 — Cookie 和 localStorage 是 Web 应用状态管理的核心。playwriter 不直接支持此功能，这是 spawriter 超越 playwriter 的差异化点。

---

### Phase 5：性能监控（优先级 P1）

> **目标**：让 AI 能实时监控和诊断页面性能。

#### 5.1 `performance` 工具

**CDP 域**：`Performance`, `PerformanceTimeline`, `Runtime`

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `get_metrics` | 获取运行时性能指标 | `Performance.getMetrics` |
| `get_web_vitals` | 获取 Web Vitals（LCP/FID/CLS/INP/TTFB） | `PerformanceTimeline.enable` + `Runtime.evaluate` |
| `get_memory` | 获取 JS 堆大小和 DOM 节点数 | `Performance.getMetrics`（JSHeapUsedSize/Nodes） |
| `get_resource_timing` | 获取资源加载时间线 | `Runtime.evaluate`（performance.getEntries()） |
| `start_trace` | 开始性能录制 | `Tracing.start` |
| `stop_trace` | 停止并返回录制结果摘要 | `Tracing.end` |

```typescript
{
  name: 'performance',
  description: 'Monitor page performance: metrics, Web Vitals (LCP/CLS/INP/TTFB), memory, resource timing.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'get_metrics', 'get_web_vitals', 'get_memory',
        'get_resource_timing', 'start_trace', 'stop_trace'
      ]},
      categories: { type: 'string', description: 'Trace categories (for start_trace)' },
    },
    required: ['action'],
  },
}
```

**关键指标输出示例**：

```
Performance Metrics:
  FPS: 60 | JS Heap: 12.5MB/32MB (39%) | DOM Nodes: 1,842

Web Vitals:
  LCP: 1.8s ✅ (Good <2.5s)
  CLS: 0.05 ✅ (Good <0.1)
  INP: 120ms ⚠️ (Needs Improvement <200ms)
  TTFB: 380ms ✅ (Good <800ms)

Top Resource Load Times:
  bundle.js     1.2s  (612KB)
  style.css     0.3s  (89KB)
  api/users     0.8s  (12KB)
```

**工作量**：1.5 天  
**价值**：🔴 高 — playwriter 没有内置的性能监控。这是一个全新的维度，让 AI 能从"功能调试"升级到"性能调试"。

---

### Phase 6：代码编辑器（优先级 P1）

> **目标**：移植 playwriter 的 `createEditor()` 功能，让 AI 能直接查看和编辑运行中的页面脚本和 CSS。

#### 6.1 `editor` 工具

**CDP 域**：`Debugger`, `CSS`, `DOM`, `Runtime`

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `list_sources` | 列出已加载的脚本/CSS 源 | `Debugger.enable` + scriptParsed 事件 |
| `get_source` | 获取指定脚本/CSS 的源码 | `Debugger.getScriptSource` / `CSS.getStyleSheetText` |
| `edit_source` | 修改脚本源码（热更新） | `Debugger.setScriptSource` / `Runtime.evaluate` |
| `edit_css` | 修改 CSS 样式表 | `CSS.setStyleSheetText` |
| `search_source` | 在所有脚本中搜索字符串 | `Debugger.searchInContent` |
| `list_stylesheets` | 列出所有 CSS 样式表 | `CSS.enable` + `CSS.getAllStyleSheets` |

```typescript
{
  name: 'editor',
  description: 'View and edit page JavaScript and CSS sources in real-time. Supports hot-reload of running code.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list_sources', 'get_source', 'edit_source',
        'edit_css', 'search_source', 'list_stylesheets'
      ]},
      scriptId: { type: 'string', description: 'Script/stylesheet ID from list_sources/list_stylesheets' },
      search: { type: 'string', description: 'Search string for filtering/searching' },
      content: { type: 'string', description: 'New content for edit operations' },
      line_start: { type: 'number', description: 'Start line for partial source view' },
      line_end: { type: 'number', description: 'End line for partial source view' },
    },
    required: ['action'],
  },
}
```

**参考**：playwriter `editor.ts`（D:\dev\side\docs\playwriter）

**工作量**：1.5 天  
**价值**：🔴 高 — 让 AI 能实时查看和修改页面代码，无需重新部署。对前端调试和快速原型验证极为重要。

**注意事项**：
- `Debugger.setScriptSource` 在 Chrome 142+ 已弃用，需使用 `Runtime.evaluate` 注入代码作为 fallback
- CSS 编辑通过 `CSS.setStyleSheetText` 实时生效
- 需要利用已有的 `debugger` 工具的脚本列表（`knownScripts`）

---

### Phase 7：网络请求拦截（优先级 P1）

> **目标**：让 AI 能拦截和修改网络请求，实现 API mock、请求重写等能力。

#### 7.1 `network_intercept` 工具

**CDP 域**：`Fetch`

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `enable` | 启用请求拦截（配置 URL 模式） | `Fetch.enable` with patterns |
| `disable` | 停用请求拦截 | `Fetch.disable` |
| `list_rules` | 列出当前拦截规则 | 本地状态 |
| `add_rule` | 添加拦截规则（mock/modify/block） | 本地状态 + `Fetch.requestPaused` 处理 |
| `remove_rule` | 删除拦截规则 | 本地状态 |
| `continue` | 放行被暂停的请求（可选修改） | `Fetch.continueRequest` / `Fetch.fulfillRequest` |

```typescript
{
  name: 'network_intercept',
  description: 'Intercept and modify network requests. Mock API responses, block requests, modify headers.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['enable', 'disable', 'list_rules', 'add_rule', 'remove_rule'] },
      url_pattern: { type: 'string', description: 'URL pattern to match (glob or regex)' },
      resource_type: { type: 'string', description: 'Resource type filter (XHR, Fetch, Document, etc.)' },
      mock_status: { type: 'number', description: 'HTTP status for mock response' },
      mock_headers: { type: 'string', description: 'JSON headers for mock response' },
      mock_body: { type: 'string', description: 'Body content for mock response' },
      modify_headers: { type: 'string', description: 'JSON headers to add/replace on request' },
      block: { type: 'boolean', description: 'Block matching requests entirely' },
    },
    required: ['action'],
  },
}
```

**工作量**：2 天  
**价值**：🔴 极高 — 这是唯一能让 AI "修改"网络行为的工具。对 API 开发、测试、错误模拟极为重要。playwriter 通过 Playwright 的 `page.route()` 可以做到，但 spawriter 可以用纯 CDP `Fetch` 域实现更底层的控制。

---

### Phase 8：设备模拟（优先级 P2）

> **目标**：让 AI 能模拟不同设备、地理位置、网络条件等。

#### 8.1 `emulation` 工具

**CDP 域**：`Emulation`, `Network`

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `set_device` | 设置设备尺寸和 DPR | `Emulation.setDeviceMetricsOverride` |
| `set_user_agent` | 设置 User-Agent | `Emulation.setUserAgentOverride` |
| `set_geolocation` | 设置地理位置 | `Emulation.setGeolocationOverride` |
| `set_timezone` | 设置时区 | `Emulation.setTimezoneOverride` |
| `set_locale` | 设置语言区域 | `Emulation.setLocaleOverride` |
| `set_network_conditions` | 设置网络条件（3G/4G/离线） | `Network.emulateNetworkConditions` |
| `set_media` | 设置 CSS 媒体查询 | `Emulation.setEmulatedMedia` |
| `set_color_scheme` | 设置明/暗色模式 | `Emulation.setEmulatedMedia`（prefers-color-scheme） |
| `clear_all` | 清除所有模拟 | 各域 clear 命令 |

```typescript
{
  name: 'emulation',
  description: 'Emulate devices, network conditions, geolocation, timezone, and color scheme for responsive testing.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'set_device', 'set_user_agent', 'set_geolocation', 'set_timezone',
        'set_locale', 'set_network_conditions', 'set_media', 'set_color_scheme', 'clear_all'
      ]},
      width: { type: 'number' }, height: { type: 'number' }, device_scale_factor: { type: 'number' },
      user_agent: { type: 'string' },
      latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' },
      timezone_id: { type: 'string' }, locale: { type: 'string' },
      preset: { type: 'string', description: 'Network preset: offline, slow-3g, fast-3g, 4g' },
      download: { type: 'number' }, upload: { type: 'number' }, latency: { type: 'number' },
      features: { type: 'string', description: 'Comma-separated media features (e.g. prefers-color-scheme:dark)' },
    },
    required: ['action'],
  },
}
```

**工作量**：1 天  
**价值**：🟡 中高 — 响应式开发和多设备测试的基础。playwriter 通过 Playwright 的 `context.newPage()` 支持设备模拟，但 spawriter 可以对已有页面动态切换。

---

### Phase 9：HTML/Markdown 导出与页面内容（优先级 P2）

> **目标**：让 AI 能获取结构化的页面内容，用于分析和文档生成。

#### 9.1 `page_content` 工具

**CDP 域**：`DOM`, `DOMSnapshot`, `Runtime`

| 操作 | 说明 | CDP 命令 |
|------|------|----------|
| `get_html` | 获取清理后的 HTML | `DOM.getOuterHTML` / `Runtime.evaluate` |
| `get_text` | 获取页面纯文本 | `Runtime.evaluate`（innerText） |
| `get_markdown` | 获取 Markdown 格式内容 | `Runtime.evaluate` + turndown 库 |
| `get_dom_snapshot` | 获取完整 DOM + 布局快照 | `DOMSnapshot.captureSnapshot` |
| `get_metadata` | 获取页面元信息（title, meta, links） | `Runtime.evaluate` |
| `search_dom` | 在 DOM 中搜索元素 | `DOM.performSearch` |

**工作量**：1 天  
**价值**：🟡 中 — 内容提取和分析的基础工具。playwriter 通过 `getCleanHTML()` 和 `getPageMarkdown()` 支持。

---

### Phase 10：视频录制（优先级 P3）

> **目标**：实现页面操作录制功能，用于回归测试、演示和文档。

#### 10.1 `recording` 工具

**技术方案**：需要扩展使用 `chrome.tabCapture` API + MediaRecorder

| 操作 | 说明 |
|------|------|
| `start` | 开始录制当前标签页 |
| `stop` | 停止录制并返回视频（base64 或保存文件） |
| `status` | 查询录制状态 |
| `screenshot_sequence` | 按间隔截取一系列截图（CDP 方案替代） |

**CDP 替代方案**：`Page.captureScreenshot` 定时截取 + 客户端拼接 GIF/视频

**工作量**：2 天（扩展方案）/ 0.5 天（截图序列方案）  
**价值**：🟡 中 — 可用于演示和回归文档。截图序列方案可先实现。

---

### Phase 11：React/框架源码定位（优先级 P3）

> **目标**：让 AI 能快速定位页面元素对应的框架源码。

#### 11.1 集成到 `css_inspect` 或新工具

**CDP 域**：`Runtime`

| 操作 | 说明 |
|------|------|
| `get_react_source` | 获取 React 组件的源文件和行号 |
| `get_component_tree` | 获取组件层次结构 |
| `get_component_props` | 获取组件 props 和 state |

**参考**：playwriter `react-source.ts` — 通过 `__REACT_DEVTOOLS_GLOBAL_HOOK__` 访问 React Fiber 树

**工作量**：0.5 天  
**价值**：🟡 中 — 对 React 项目有专门价值。

---

## 3. 优先级排序与时间线

```
Phase 4: 存储管理 (storage)                  ████░░░░ 1天    P0  ← 立即实施
Phase 5: 性能监控 (performance)              █████░░░ 1.5天  P1  ← 紧随其后
Phase 6: 代码编辑器 (editor)                 █████░░░ 1.5天  P1  ← 与 Phase 5 并行
Phase 7: 网络请求拦截 (network_intercept)    ██████░░ 2天    P1
Phase 8: 设备模拟 (emulation)                ████░░░░ 1天    P2
Phase 9: 页面内容导出 (page_content)         ████░░░░ 1天    P2
Phase 10: 视频录制 (recording)               █░░░░░░░ 0.5天  P3  （截图序列方案）
Phase 11: React 源码定位                      ██░░░░░░ 0.5天  P3
                                              ─────────────────
                                              总计 ≈ 9天
```

### 实施后工具总数预估

```
当前：27 个工具
+ Phase 4: storage             (+1)
+ Phase 5: performance         (+1)
+ Phase 6: editor              (+1)
+ Phase 7: network_intercept   (+1)
+ Phase 8: emulation           (+1)
+ Phase 9: page_content        (+1)
+ Phase 10: recording          (+1)
+ Phase 11: react_source       (+1)
───────────────────────────────────
预计：25 个工具
```

---

## 4. 与 playwriter 对比：实施后的能力矩阵

| 能力 | playwriter | spawriter 现在 | spawriter 增强后 |
|------|------------|----------------|------------------|
| 页面截图 + 标注 | ✅ Vimium 式 | ✅ 编号标签 | ✅ |
| 无障碍快照 + Diff | ✅ aria-ref | ✅ search+diff | ✅ |
| JS 执行（页面） | ✅ via execute | ✅ execute | ✅ |
| JS 执行（Playwright VM） | ✅ execute | ✅ playwright_execute | ✅ |
| 控制台日志 | ✅ getLatestLogs | ✅ console_logs | ✅ |
| 网络请求列表 | ⚠️ 有限 | ✅ network_log | ✅ |
| 网络请求详情（Body） | ❌ | ✅ network_detail | ✅ |
| 断点调试 | ✅ createDebugger | ✅ debugger | ✅ |
| CSS 检查 | ✅ getStylesForLocator | ✅ css_inspect | ✅ |
| 会话管理 | ✅ CLI sessions | ✅ session_manager | ✅ |
| **代码编辑器** | ✅ createEditor | ❌ | ✅ Phase 6 |
| **视频录制** | ✅ tabCapture | ❌ | ⚠️ Phase 10（截图序列） |
| **React 源码定位** | ✅ getReactSource | ❌ | ✅ Phase 11 |
| **Ghost Cursor** | ✅ | ❌ | 可选 |
| HTML/Markdown 导出 | ✅ | ❌ | ✅ Phase 9 |
| MCP 资源（API 文档） | ✅ 3 个 | ❌ | 可选 |
| **存储管理** | ❌ | ❌ | ✅ Phase 4 🆕 |
| **性能监控/Web Vitals** | ❌ | ❌ | ✅ Phase 5 🆕 |
| **网络请求拦截** | ⚠️ via page.route() | ❌ | ✅ Phase 7 🆕 |
| **设备模拟** | ⚠️ via Playwright context | ❌ | ✅ Phase 8 🆕 |
| 微前端管理 | ❌ | ✅ 独有 | ✅ |

### 差异化总结

- **spawriter 超越 playwriter 的领域**：存储管理、性能监控、网络请求拦截、网络请求详情（Body）、设备模拟（动态切换）、微前端管理
- **playwriter 仍领先的领域**：视频录制（TabCapture）、单工具 API 设计（token 效率更高）、Ghost Cursor
- **两者均覆盖**：截图、快照、执行、调试、CSS、日志、代码编辑（Phase 6 后）

---

## 5. 技术注意事项

### 5.1 CDP 域启用策略

建议在 `doEnsureSession` 中按需启用域，而非一次性全部启用：

```typescript
// 当前（已实现）
await sendCdpCommand(session, 'Network.enable', { maxTotalBufferSize: 10*1024*1024 });
await sendCdpCommand(session, 'Runtime.enable');

// 按需启用（工具首次调用时）
// storage 工具 → DOMStorage.enable
// performance 工具 → Performance.enable, PerformanceTimeline.enable
// editor 工具 → Debugger.enable, CSS.enable
// network_intercept 工具 → Fetch.enable
```

### 5.2 事件缓冲策略

某些域启用后会持续产生事件，需要管控内存：

| 域 | 事件 | 策略 |
|----|------|------|
| `Network.*` | requestWillBeSent, responseReceived, ... | ✅ 已有 MAX_NETWORK_ENTRIES=500 |
| `Debugger.scriptParsed` | 每个脚本加载 | ✅ 已有 knownScripts Map |
| `Fetch.requestPaused` | 每个拦截的请求 | 需要：自动 continueRequest 超时 |
| `Performance` | 无持续事件（按需查询） | ✅ 安全 |
| `PerformanceTimeline.timelineEventAdded` | 周期性事件 | 需要：环形缓冲 |

### 5.3 chrome.debugger 限制

通过 Chrome 扩展的 `chrome.debugger` API 转发 CDP 命令时：

- **所有 CDP 域均可用**（经 debugger API 无过滤转发）
- **限制**：用户会看到调试器附加的提示栏
- **性能**：每个 CDP 命令需经过 扩展→中继→MCP 三跳，延迟约 10-50ms

### 5.4 测试策略

延续当前模式：
1. 纯逻辑单元测试（不依赖浏览器）
2. 模拟 CDP 命令/事件的集成测试
3. 每个新工具至少 20+ 测试用例

---

## 附录 A：CDP API 选择决策记录

### A.1 Cookie 读取：Network.getCookies vs Storage.getCookies

**决策**：spawriter 使用 `Network.getCookies` 读取页面 cookie，不使用 `Storage.getCookies`。

**原因**：extension relay 模式下，CDP 命令通过 page session 路由（`chrome.debugger.sendCommand({ tabId })`）。`Storage.getCookies` 是 Browser target（root session）命令，在 page session 上不可用，调用会返回 `No tab found for method Storage.getCookies` 错误。`Network.getCookies` 是 page-level 命令，可正确工作。

**影响范围**：
- `mcp.ts` 中 `storage` tool 的 `get_cookies` action 使用 `Network.getCookies` ✅
- `mcp.ts` 中 `clear_cache_and_reload` 的 cookie 枚举使用 `Network.getCookies` ✅
- `playwright_execute` 中如需操作 cookie，也必须通过 CDP session 的 `Network.getCookies`

**参考**：playwriter issue #66 发现并记录了相同问题。

### A.2 文件下载：Browser.setDownloadBehavior → Page.setDownloadBehavior

**决策**：relay 层将 `Browser.setDownloadBehavior` 映射为 `Page.setDownloadBehavior`，分发到所有已连接的 page target。

**原因**：extension 模式下 CDP 命令通过 page session 路由，`Browser.setDownloadBehavior` 是 Browser target 命令。Playwright 调用此命令时需要 relay 层翻译为等效的 page-level 命令。同时缓存 behavior 配置，使新 attach 的 page 自动继承。合成 `Browser.downloadWillBegin/downloadProgress` 事件确保 Playwright 的 download event 能正常触发。

**注意**：`Browser.setDownloadBehavior` 的 `browserContextId` 参数被忽略。Extension 模式下通常只有一个 browser context，此参数无意义。Relay 会对所有已连接的 page target 统一应用配置。

**参考**：playwriter issue #65 修复实现了相同的 Browser/Page 兼容性桥接。

---

## 6. 总结

CDP 作为 Chrome 浏览器的底层协议，提供了 50+ 个域、数百个命令。spawriter 当前仅使用了约 8 个域（Network, Runtime, Page, Accessibility, Debugger, CSS, DOM, DOMStorage 部分）。

通过系统性地开发 Storage、Performance、Fetch、Emulation 等域的 MCP 工具包装，spawriter 可以：

1. **完全覆盖** playwriter 的功能（代码编辑器、内容导出）
2. **超越** playwriter，提供存储管理、性能监控、网络拦截、设备模拟等 playwriter 未实现的能力
3. **保持** 微前端管理的独有优势
4. **最终目标**：成为最全面的 AI 浏览器 DevTools MCP 工具集
