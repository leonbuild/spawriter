# spawriter 能力学习与拓展路线（对标 playwriter / browser-use）

- 配套文档：`docs/spawriter-full-audit-20260612.md`（问题审计）、`docs/spawriter-fix-plan-20260612.md`（S1–S12 修复）
- 本文目标：结合 `0-ref/playwriter`、`0-ref/browser-use` 源码，提炼 spawriter 可**学习、优化、拓展**的能力点，给出可实施步骤；优先服务 spawriter 的差异化主线——**single-spa 微前端调试**。
- 标注约定：「源码依据」= 直接读到的参考实现；「实施思路」= 本文给出的落地方案（需开发验证）。

---

## 0. 三者定位与可借鉴边界

| 项目 | 定位 | 浏览器 | 对 spawriter 的借鉴价值 |
|---|---|---|---|
| **spawriter** | 给外部 agent 的工具（MCP/CLI）+ single-spa 调试 | 用户真实 Chrome（扩展+CDP relay） | — |
| **playwriter** | 同类工具（MCP/CLI），能力更全 | 用户真实 Chrome（扩展）或 `--direct` CDP | **最高**：架构同构，能力可近乎直接移植 |
| **browser-use** | 自带 agent 框架 + 独立浏览器 + 云 | 自启 Chromium（CDP `cdp_use`） | **中**：agent loop 不适用；DOM 序列化质量、watchdog 健壮性、安全模型可借鉴 |

> 结论：playwriter 是 spawriter 的"能力超集参照"，移植成本最低；browser-use 主要贡献「DOM 提取的 token 效率」「遮挡/视口过滤」「watchdog 解耦」「安全白名单」四类思路。

---

## 1. 能力矩阵对比

| 能力 | spawriter 现状 | playwriter | browser-use | 拓展编号 |
|---|---|---|---|---|
| AX 快照 | 有（自研 AX tree） | 有（`snapshot`，支持 locator/iframe 作用域 + diff） | 有（DOM+AX 混合 + 遮挡/视口过滤） | C3, C7 |
| 截图+可交互标注 | 有（`screenshotWithLabels`） | 有（`screenshotWithAccessibilityLabels`，色彩分类） | 有（带 index 的 bbox 叠加） | C7 |
| 网络监控/拦截 | 有（`networkLog`/`networkIntercept`） | 有（含 replay 模式示例） | 有 | — |
| 调试器 | 有（`dbg`） | 有（`createDebugger`） | — | — |
| 运行时源码编辑 | 有（`editor`） | 有（`createEditor`，grep+edit） | — | — |
| 设备/网络模拟 | 有（`emulation`） | 部分 | 有（profile） | — |
| **React/组件源码定位** | **无** | **有（`getReactSource`/`getReactComponentInfo`，bippy fiber）** | — | **C1** |
| **智能等待加载** | 无（仅 `waitForLoadState`） | 有（`waitForPageLoad`，忽略广告/分析） | 有（watchdog 判稳） | **C2** |
| **snapshot 作用域/iframe** | 无（仅整页 AX） | 有（`{locator}`/`{frame}` + diff） | 有（跨域 iframe + 视口阈值） | **C3** |
| **popup→tab 重定位** | 无 | 有（扩展自动重定位 + 警告） | — | **C4** |
| **正文提取(Readability)** | 无（`pageContent.get_text` 仅 textContent） | 有（`getPageMarkdown` Readability + `getCleanHTML` diff） | 有（结构化 extraction） | **C5** |
| **CSS 来源定位(file:line)** | 部分（`cssInspect` 仅 computed） | 有（`getStylesForLocator`，规则来源 file:line） | — | **C6** |
| **遮挡/视口过滤** | 无 | 部分 | 有（paint-order + viewport threshold） | **C7** |
| 文件执行 / direct 模式 | 无 | 有（`-f` / `--direct` 无扩展连接） | n/a（自启浏览器） | **C8** |
| **录屏 + 拟人光标 + demo** | 无 | 有（`recording.*`/`ghostCursor.*`/`createDemoVideo`，tabCapture） | 有（recording watchdog） | **C9** |
| **CDP 调试日志(JSONL)** | 弱（仅 relay.log，且实测未落盘） | 有（`cdp.jsonl` 全量截断日志） | 有（observability） | **C10** |
| **安全 watchdog/URL 白名单** | 无（本地无鉴权，见 S7） | — | 有（`security_watchdog` 域名白名单） | **C11** |
| 元素引脚(右键复制引用) | 无 | 有（`globalThis.playwriterPinnedElemN`） | — | **C12** |
| 多 tab create/close | 无（见 S8） | 有 | 有 | （见 fix-plan S8） |

---

## 2. 高价值拓展（按 ROI × single-spa 契合度排序）

### 第一梯队 —— 强化微前端调试主线（差异化护城河）

#### C1 — React/组件源码定位（`getReactSource` / `getReactComponentInfo`）

- **源码依据**：playwriter 用 `bippy`（React fiber introspection）bundle 注入页面，提供 `getReactSource`（返回 `{fileName, lineNumber, columnNumber, componentName}`）与 `getReactComponentInfo`（`{componentName, source, hierarchy, props}`），并接入右键"Copy React Source Path"。
- **价值**：spawriter 主打 single-spa 微前端，override 后最常见的诉求是"这个 UI 由哪个 app/组件渲染、源码在哪"。这是与 playwriter 拉不开但与通用浏览器 MCP 拉得开的差异点，**最契合主线**。
- **实施思路**：
  1. 在 `pw-executor.ts` 的 `buildVmGlobals` 增加 `getReactSource(locator)` / `getReactComponentInfo(locator)` 两个 global。
  2. 实现方式（两选一）：
     - 轻量：通过 `Runtime.evaluate` 读取元素上的 React fiber（`el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))]`），沿 `fiber._debugSource`（dev build）取 `{fileName,lineNumber}`，沿 `fiber.return` 取组件层级与 `type.name`。
     - 完整：移植 bippy bundle，注入后用其 API（兼容 React 16–18 fiber 结构）。
  3. props 需做 sanitize/截断（函数/DOM/循环引用/超大对象），与 playwriter 一致。
  4. 在 `single_spa` 工具增加 `which_app(selector)` 动作：结合组件来源 + 当前 import-map-overrides，回答"该元素属于哪个 micro-app、是否被 override、源码位置"。
- **涉及文件**：`pw-executor.ts`（global）、`mcp.ts`（single_spa 新动作）、`AGENTS_*.md`。
- **工作量**：中（轻量版 ~1 天；接入 single_spa 关联 ~0.5 天）。

#### C2 — 智能 `waitForPageLoad`（忽略分析/广告请求）

- **源码依据**：playwriter `waitForPageLoad({page,timeout,pollInterval,minWait})` 返回 `{success, readyState, pendingRequests, waitTimeMs, timedOut}`，基于 in-flight 请求数 + `document.readyState` 判稳，过滤 analytics/ads 域。
- **价值**：微前端异步挂载（动态 import chunk、import-map-overrides 加载新 bundle）后，`domcontentloaded` 远不足以判稳；当前 spawriter 仅有 `waitForLoadState`，且审计中 navigate 频繁超时（导航预算逻辑复杂）。智能等待能显著降低"页面没好就操作"的失败。
- **实施思路**：
  1. `NetworkMonitor` 已跟踪请求/响应（`pw-executor.ts` setupPageListeners）。新增 `getPendingRequestCount(opts)`，排除 analytics 域名（可配置黑名单：google-analytics、doubleclick、segment、sentry 等）。
  2. `buildVmGlobals` 增加 `waitForPageLoad({timeout, pollInterval=200, minWait=300, quietWindow=500})`：轮询直到 `readyState==='complete'` 且 pending（非分析）请求为 0 持续 `quietWindow`，或超时返回诊断对象。
  3. `navigate()` 内部可选地在跳转后调用它，替代部分硬等待。
- **涉及文件**：`runtime/network-monitor.ts`、`pw-executor.ts`。
- **工作量**：小（~0.5 天）。

#### C3 — snapshot 作用域（locator 子树 / iframe）+ 已有 diff 强化

- **源码依据**：playwriter `snapshot({page|locator|frame, search, showDiffSinceLastCall})`——可只快照某子树或某 iframe，首呼全量、后续 diff，token 效率高。
- **价值**：微前端整页 AX 往往上百行（导航/壳/多个 app 混杂）。按 app 容器或 iframe 作用域快照，能把"只看 navbar app"做到 ~20 行；diff 让"override 前后变化"一目了然。spawriter 已有 diff（`computeSnapshotDiff`），但缺作用域。
- **实施思路**：
  1. 现有 `snapshot()`（`pw-executor.ts:887` 调 `Accessibility.getFullAXTree`，整页）。增加可选 `root` 参数：传 CSS selector 或 ref → 先 `DOM.querySelector` 得 `backendNodeId` → `Accessibility.getPartialAXTree({backendNodeId})` 或对子树过滤 full tree。
  2. iframe：用 `Page.getFrameTree` 找目标 frame，对其执行 AX 抓取（需 frame 级 session）。
  3. 复用既有 `computeSnapshotDiff`，按 root 维护独立 `lastSnapshot`（现 `refCacheByTab` 已分 tab，可再分 root）。
- **涉及文件**：`pw-executor.ts`、`runtime/ax-tree.ts`。
- **工作量**：中（locator 作用域 ~0.5 天；iframe ~1 天）。

### 第二梯队 —— 通用健壮性 / 内容能力

#### C4 — popup 自动重定位为 tab

- **源码依据**：playwriter 扩展拦截 `window.open(url,'',features)`/OAuth 弹窗，重定位为主窗口 tab，纳入 `context.pages()` 并发 `[WARNING] New page opened ...`。
- **价值**：登录/OAuth/支付弹窗在真实业务中极常见；当前 spawriter executor 有 `page.on('popup')` 仅记录警告（`pw-executor.ts:574`），但弹窗作为独立 window 未必被 relay 的 attachedTargets 管理，agent 难以接管。
- **实施思路**：
  1. 扩展侧监听 `chrome.windows.onCreated` / `chrome.tabs.onCreated`，对 `window.open` 产生的弹窗，用 `chrome.tabs.move` 移入主窗口并 attach（复用 `attachTab`）。
  2. relay 发 `Target.attachedToTarget`，executor 的 `popup` 警告补上新 tab 的 index/url。
- **涉及文件**：`bridge.js`、`relay.ts`、`pw-executor.ts`。
- **工作量**：中（~1 天，需处理弹窗时序）。

#### C5 — 正文提取 `getPageMarkdown`（Readability）+ `getCleanHTML` diff

- **源码依据**：playwriter `getPageMarkdown`（Mozilla Readability，输出标题/作者/正文）、`getCleanHTML`（剥离 script/style/svg、保留语义属性、支持 diff/search）。
- **价值**：当前 `pageContent.get_text` 只是 `textContent`（噪声多）。Readability 正文 + cleanHTML diff 对"抓取页面内容、对比 override 前后 DOM"价值高，token 更省。
- **实施思路**：
  1. `pageContent` 增加 `action: 'get_markdown'`：注入 `@mozilla/readability` + `DOMParser`（或 bundle 后注入），返回结构化正文。
  2. `get_clean_html`：移植 playwriter 的 `clean-html.ts` 清洗逻辑（删 script/style/svg/head、unwrap 空 wrapper、截断长值、保留 `href/aria-*/data-*`），接 `computeSnapshotDiff` 支持 diff。
- **涉及文件**：`pw-executor.ts`（pageContent 分支）、新增 `runtime/clean-html.ts`。
- **工作量**：中（~1 天）。

#### C6 — `cssInspect` 升级为带来源定位（file:line）

- **源码依据**：playwriter `getStylesForLocator` 返回每条匹配规则的 selector + **source location** + declarations（DevTools "Styles" 面板式）。
- **价值**：当前 `cssInspect` 用 `getComputedStyle`（只给最终值，不给"哪条规则、哪个文件第几行定义"）。调试微前端样式冲突（多个 app 的 CSS 互相覆盖）时，来源定位是关键。
- **实施思路**：
  1. 改用 CDP `CSS.enable` + `DOM.querySelector` → `CSS.getMatchedStylesForNode({nodeId})`，得 `matchedCSSRules[]`（含 `rule.style.styleSheetId`、`range`）。
  2. 用 `CSS.getStyleSheetText` / styleSheet 的 `sourceURL` 映射到 file:line。
  3. 输出：selector、来源（url:line）、声明、是否被覆盖（按层叠顺序）。
- **涉及文件**：`pw-executor.ts`（cssInspect 分支）。
- **工作量**：中（~1 天）。

#### C7 — 遮挡/视口过滤，提升 snapshot 与 labels 准确性

- **源码依据**：browser-use `DomService(paint_order_filtering, viewport_threshold)` + `enhanced_snapshot.REQUIRED_COMPUTED_STYLES`，用 `DOMSnapshot.captureSnapshot`（含 paintOrders、computed styles）过滤被遮挡/视口外元素，`ClickableElementDetector` 产出干净的可交互列表。
- **价值**：当前 `screenshotWithLabels`/`getInteractiveElements` 可能标注被遮挡（modal 下层）或视口外元素，造成"点了点不到"。遮挡过滤直接提升交互成功率，token 也更省。
- **实施思路**：
  1. labeled-screenshot/AX 提取时，额外取 `DOMSnapshot.captureSnapshot({computedStyles:['display','visibility','opacity','pointer-events']})` + paintOrders。
  2. 过滤 `display:none`/`visibility:hidden`/`opacity:0`/视口外/被更高 paintOrder 完全遮挡的元素。
  3. 可选 `viewport_only` 选项控制是否只标注视口内。
- **涉及文件**：`runtime/labeled-screenshot.ts`、`runtime/ax-tree.ts`。
- **工作量**：中-高（~1.5 天）。

#### C8 — `-f` 文件执行 + `--direct` 无扩展模式

- **源码依据**：playwriter `-f script.js`（同沙箱执行文件）、`--direct`（连 `chrome --remote-debugging-port`，访问全部 page，无需扩展）。
- **价值**：`-f` 规避 shell 引号地狱（呼应审计 S10）；`--direct` 在扩展未装/CI 场景提供退路，且能调试扩展本身无法 attach 的页面。
- **实施思路**：
  1. `-f`：`cli.ts` 默认命令读文件内容当 code（与 S10 的 stdin 方案并列）。
  2. `--direct`：`executeCode` 检测 `--direct`，executor 直接 `chromium.connectOverCDP('http://127.0.0.1:9222')`，绕过 relay/extension；session 不走 tabOwners（直连无多 agent 隔离需求，或文档标注）。
- **涉及文件**：`cli.ts`、`pw-executor.ts`、`runtime/ensure-relay.ts`。
- **工作量**：小（`-f` ~0.5 天）+ 中（`--direct` ~1 天）。

### 第三梯队 —— 演示 / 可观测 / 安全

#### C9 — 录屏 + 拟人光标 + demo 视频

- **源码依据**：playwriter `recording.start/stop`（`chrome.tabCapture`，跨导航持续，30–60fps）、`ghostCursor.show/hide`（注入光标跟随 Playwright 动作）、`createDemoVideo`（ffmpeg 加速空闲段）。
- **价值**：录制 bug 复现、生成微前端 override 前后对比演示。差异化体验，但非核心调试。
- **实施思路**：
  1. 扩展用 `chrome.tabCapture` + offscreen `MediaRecorder` 录制，存盘后回传路径。
  2. ghost cursor：content script 注入一个 overlay，监听 relay 转发的 mouse 动作坐标。
  3. demo：ffmpeg 加速处理必须在 CLI/relay 进程侧执行（沙箱 `ALLOWED_MODULES` 不含也不应放开 `child_process`），如新增 `spawriter demo-video <recording>` 命令；需检测 ffmpeg 可用性。
- **涉及文件**：`bridge.js`、`offscreen.js`、新增 `runtime/recording.ts`。
- **工作量**：高（~2–3 天）。建议最后做。

#### C10 — CDP JSONL 调试日志（呼应审计 logfile 缺失）

- **源码依据**：playwriter 在 relay 写 `cdp.jsonl`，记录所有 CDP 命令/响应/事件（长串截断），便于 `jq`/`rg` 排障。spawriter 审计中 `spawriter logfile` 仅指向 `relay.log` 且实测目录为空。
- **价值**：本次审计的多个 bug（session 命名、所有权）若有 CDP 流水日志会更快定位。直接提升可维护性，且支撑后续回归。
- **实施思路**：
  1. relay 的 `handleCDPMessage`/`handleExtensionMessage`/`sendToExtension` 统一经过一个 `cdpLog(direction, msg)`，写 `os.tmpdir()/spawriter/cdp.jsonl`（长串截断到 ~500 字符），每次启动重建。
  2. `relay.log` 同步真正落盘。已验证根因：`utils.ts:46` 的 `log()` 只写 stderr，而 relay 进程由 `mcp.ts:79` 与 `runtime/ensure-relay.ts:28` 以 `stdio:'ignore'` spawn，stderr 被直接丢弃——这就是 `spawriter logfile` 指向的文件始终为空的原因。改为 `log()` 同时 append 到文件。
  3. `cli.ts logfile` 打印两个文件路径。
- **涉及文件**：`relay.ts`、`utils.ts`（log 落盘）、`cli.ts`。
- **工作量**：小-中（~0.5–1 天）。**建议优先做**（排障基础设施，支撑其他修复验证）。

#### C11 — 安全 watchdog / URL 白名单（呼应 S7）

- **源码依据**：browser-use `security_watchdog` 支持 `allowed_domains`，导航到非白名单域被拦截；`downloads_watchdog` 统一管理下载。
- **价值**：spawriter 连真实浏览器 + 登录态，本地无鉴权（S7）。可选的导航/操作白名单为敏感环境提供约束。
- **实施思路**：
  1. relay 读 `SSPA_ALLOWED_DOMAINS`，`navigate`/`Page.navigate` 转发前校验目标域，命中黑/非白名单则拒绝并返回结构化错误。
  2. 与 S7 的 token 加固协同，形成"本地访问控制"层。
- **涉及文件**：`relay.ts`、`pw-executor.ts`（navigate）。
- **工作量**：小（~0.5 天）。

#### C12 — 元素引脚（右键复制元素引用）

- **源码依据**：playwriter 右键"Copy Playwriter Element Reference"→ 存 `globalThis.playwriterPinnedElemN` + 复制到剪贴板，agent 用 `evaluateHandle` 取用。
- **价值**：人机协作——用户手动指认元素给 agent。微前端中"用户指这个挂件"很实用。
- **实施思路**：扩展 content script 注册右键菜单（`chrome.contextMenus`），点选时把元素存到页面 `globalThis.__spawriterPinnedN`，executor 加 `getPinnedElement(n)`。
- **涉及文件**：`bridge.js`/content script、`pw-executor.ts`。
- **工作量**：小（~0.5 天）。

---

## 3. 路线图（与修复批次协同）

| 里程碑 | 内容 | 说明 |
|---|---|---|
| **M0 先修后扩** | 完成 fix-plan 第 1–2 批（S1–S7） | 能力拓展建立在正确的 session/所有权/单一数据源之上，否则新功能继承旧 bug |
| **M1 排障基建** | C10（CDP 日志）+ fix-plan S8（createTarget/close） | 先把可观测与多 tab 打牢，支撑后续验证 |
| **M2 微前端主线** | C1（React 源码定位）+ C3（snapshot 作用域）+ C2（智能等待） | 直接强化差异化护城河，配合 `single_spa` 工具 |
| **M3 通用增强** | C5（Readability/cleanHTML）+ C6（CSS 来源）+ C7（遮挡过滤）+ C4（popup） | 健壮性与内容能力对齐 playwriter |
| **M4 体验/安全** | C8（-f/direct）+ C11（白名单）+ C9（录屏）+ C12（引脚） | 锦上添花，按需取舍 |

---

## 4. 与既有问题（S1–S12）的关系

- C10（CDP 日志）补齐审计中"logfile 为空"的可观测缺口，应优先。
- C11（白名单）是 S7（本地无鉴权）的功能性补充。
- C2/C4/C7（智能等待/popup/遮挡过滤）系统性降低审计中观察到的 navigate 超时、误点、弹窗失控类问题。
- C8 的 `-f`/stdin 与 fix-plan S10 是同一诉求的两种实现，合并落地。
- 所有拓展都依赖 fix-plan S1（统一 session）与 S8（多 tab）先行——**先修复、后拓展**。

---

## 5. 不建议照搬的部分

- **browser-use 的 agent loop / 任务规划 / structured output**：spawriter 是"工具"而非"agent"，外部 agent（Cursor 等）已负责规划，照搬会越界且重复。
- **browser-use 的独立浏览器 + 云**：与 spawriter "连用户真实浏览器"的核心定位冲突。
- **Ghost Browser 多身份**：受众过窄。
- 仅当确有需求时再引入 ffmpeg 依赖（C9），避免增加安装负担。
