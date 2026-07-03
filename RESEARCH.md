# spawriter 功能提升研究：对比 playwriter 与 browser-use

> 研究日期：2026-07-03
> 对比版本：playwriter v0.4.0（2026-06-30 最新提交）、browser-use master（2026-07 拉取）、spawriter v1.0.0（含本轮安全加固）
> 两个参考项目均为 MIT 许可，移植代码合法，建议保留出处注释。

## 0. 结论摘要

- **playwriter 是 spawriter 的上游项目**（同构：relay + MV3 扩展 + VM 执行器 + MCP/CLI 双入口），但功能面显著更宽。它是最直接、移植成本最低的参考来源——大部分模块可近乎原样移植。
- **browser-use 是 Python LLM Agent 框架**，代码不能直接复用，但其 **watchdog 弹性架构、面向 LLM 的 DOM 序列化、域名安全白名单** 三个设计模式非常值得借鉴。
- spawriter 的独有价值（single-spa 工具链、标签页所有权隔离、networkIntercept 声明式 mock、storage/emulation/performance 套件）上游都没有，应保持并继续强化。
- 最高性价比的 6 个改进（P0）：**getPageMarkdown、getCleanHTML、waitForPageLoad、CDP JSONL 日志、弹窗迁移（popup relocation）、getReactSource**。最后一项与 spawriter 的微前端定位协同效应最强——single-spa 子应用绝大多数是 React。

## 1. 研究对象与定位

| | spawriter | playwriter | browser-use |
|---|---|---|---|
| 语言/形态 | TS，MCP + CLI 工具 | TS，MCP + CLI 工具 | Python，自主 Agent 框架 |
| 定位 | AI 辅助浏览器自动化 + **single-spa 微前端调试** | 通用 AI 浏览器自动化（"give agents a real browser"） | LLM 自主驱动浏览器完成任务 |
| 控制通道 | 仅 MV3 扩展 + chrome.debugger | 扩展 **或直连 CDP**（--direct）**或自管理浏览器**（headless/cloud） | CDP 直连（自启动 Chrome） |
| 执行模型 | VM 沙箱内跑 Playwright 代码 | 同左（同源架构） | LLM 决策循环 + 动作注册表 |
| 关系 | 从 playwriter fork，深度定制 | 上游 | 独立项目（playwriter 云浏览器后端曾用其服务） |

依赖差异需注意：playwriter 已切换到自维护的 `@xmorse/playwright-core` fork（为 aria-ref 定位器与 channel-owner 注入打补丁）；spawriter 仍用官方 `playwright-core@1.56.1`。移植涉及 aria-ref 的功能时需评估是否跟进该 fork（见 §8）。

## 2. 功能矩阵

图例：✅ 有；⚠️ 部分/较弱；❌ 无。

| 能力 | spawriter | playwriter | 参考实现（playwriter src/） |
|---|---|---|---|
| 无障碍快照 + diff + 搜索 | ✅ `snapshot()` | ✅ 另支持 page/frame/locator 级作用域 | `aria-snapshot.ts` |
| 数字 ref 交互 | ✅ `interact(ref)` | ✅ `aria-ref=eN` 定位器（可直接给 `page.locator`） | `aria-snapshot.ts` + playwright fork |
| 带标注截图 | ✅ `screenshotWithLabels` | ✅ `screenshotWithAccessibilityLabels` | 双方同源 |
| 主内容提取为 Markdown | ❌ | ✅ Readability 注入 | `page-markdown.ts` |
| 清洗版 HTML | ⚠️ `pageContent('get_html')` 仅删 style/script | ✅ 深度清洗 + 可读改写 | `clean-html.ts`、`htmlrewrite.ts` |
| 智能等待页面加载 | ❌ 仅 `waitForLoadState('domcontentloaded')` | ✅ 轮询 pending 请求 + 过滤广告/追踪域名 | `wait-for-page-load.ts` |
| 跨调用 diff 通用化 | ⚠️ 仅 snapshot 内置 | ✅ snapshot/HTML/markdown 共享 `createSmartDiff` | `diff-utils.ts` |
| React 组件溯源（源码位置/props/层级） | ❌ | ✅ 基于 bippy | `react-source.ts` |
| CSS 规则级检查（含源文件:行号） | ⚠️ `cssInspect` 仅计算样式 | ✅ matched rules + 来源定位 | `styles.ts` |
| CDP 调试器（断点/单步） | ✅ `dbg` | ✅ `createDebugger` | 同源 |
| 已加载源码编辑器 | ✅ `editor()` | ✅ `createEditor` | 同源 |
| 原生视频录制（tab capture 全帧率） | ❌ | ✅ `recording.start/stop` | `screen-recording.ts`、`recording-relay.ts` |
| 演示视频生成（ffmpeg 空闲加速） | ❌ | ✅ `createDemoVideo` | `ffmpeg.ts` |
| 拟人光标（ghost cursor） | ❌ | ✅ 贝塞尔轨迹 + 可视化光标 | `ghost-cursor*.ts`（3 个模块） |
| 直连 CDP 模式（免扩展） | ❌ | ✅ `--direct [endpoint]`，自动发现本机实例 | `chrome-discovery.ts`、`cdp-relay.ts` |
| 无头浏览器会话 | ❌ | ✅ `session new --browser headless`，最后会话删除时自动关闭 | `browser-launch.ts` |
| Chrome for Testing 安装/启动 | ❌ | ✅ `browser install` / `browser start` | `browser-install.ts` |
| CDP 消息 JSONL 日志（截断+轮转） | ❌ 混在 relay.log | ✅ 独立 cdp.jsonl，字符串截断 2000、1 万条轮转、降噪 | `cdp-log.ts` |
| 弹窗自动迁移为标签页 | ❌ | ✅ window.open 弹窗重定位，保持扩展可控 | 扩展 + `popup-relocation.test.ts` |
| 终端内联图片（kitty 协议） | ❌ | ✅ 截图直接显示在支持的终端 | `kitty-graphics.ts` |
| 用户钉选元素（右键发给 Agent） | ❌ | ✅ pinned elements | 扩展 |
| 云浏览器/代理/验证码 | ❌ | ✅（商业服务） | `cloud-client.ts` |
| **single-spa 工具链** | ✅ 状态/override/挂载/卸载 | ❌ | —（spawriter 独有） |
| **标签页所有权隔离**（MINE/AVAILABLE/OWNED） | ✅ claim/release + 蓝点 | ⚠️ 仅多客户端共享 relay | spawriter 独有 |
| **声明式网络 mock 规则** | ✅ `networkIntercept` | ⚠️ 建议手写 `page.route` | spawriter 独有 |
| storage/emulation/performance/browserFetch 套件 | ✅ | ⚠️ 需手写 CDP | spawriter 独有 |
| 安全默认（回环绑定+token+CSRF） | ✅（本轮加固） | ⚠️ token 可选 | spawriter 现已领先 |

## 3. 参考 playwriter 的改进项（按优先级）

### P0 —— 高价值、低到中成本，建议尽快移植

> **状态（2026-07-03）：P0-1 ~ P0-6 已全部实施并带单元/集成测试**：`getPageMarkdown`、`getCleanHTML`、`waitForPageLoad`、`getReactSource`/`getReactComponentInfo` 已注入 VM 全局；CDP JSONL 日志见 `spawriter logfile`；弹窗迁移已进扩展（需在 chrome://extensions 重新加载扩展生效）。

**P0-1 `getPageMarkdown`（主内容 Markdown 提取）**
- 现状：Agent 读长文页面只能 `pageContent('get_text')`，拿到的是未去噪的全文，token 浪费严重。
- 参考：`page-markdown.ts` —— 打包 Mozilla Readability 为 `dist/readability.js`，注入页面执行，返回 `{content,title,author,excerpt,wordCount…}`，并支持 `search` 过滤与 `showDiffSinceLastCall`。
- 移植要点：需在 build 脚本中增加 readability 打包步骤（上游用 esbuild 单独产出）；spawriter 的 `evaluateJs` 双通道（CDP/Playwright）可直接复用。工作量约 1 天。

**P0-2 `getCleanHTML`（深度清洗 HTML）**
- 现状：`pageContent('get_html')` 只移除内联 style 和 script，输出仍含大量框架噪声属性。
- 参考：`clean-html.ts` + `htmlrewrite.ts` —— 删除注释/data-* /aria 冗余属性、折叠空白、可选保留交互属性，输出面向 LLM 阅读优化。
- 移植要点：纯函数模块，与 spawriter 现有 `pageContent` 合并成 `get_clean_html` action 即可。工作量约 0.5 天。

**P0-3 `waitForPageLoad`（智能等待）**
- 现状：spawriter 仅在导航后 `waitForLoadState('domcontentloaded')`，SPA 异步渲染常导致 Agent 截图过早、误判空白页。
- 参考：`wait-for-page-load.ts` —— 轮询 `document.readyState` + 网络 pending 请求数，内置约 40 个广告/埋点域名与字体图标扩展名过滤表（避免第三方脚本永远挂起导致等待超时），返回 `{readyState,pendingRequests,waitTimeMs,timedOut}` 结构化结果。
- 移植要点：对 single-spa 场景尤其有用（子应用异步加载）；可再叠加 spawriter 已有的 `singleSpa.status()` 检查形成微前端专属等待。工作量约 0.5 天。

**P0-4 CDP JSONL 独立日志**
- 现状：CDP 流量与业务日志混在同一 relay.log，排查协议问题需人肉过滤；本轮审计中的日志噪声问题也源于此。
- 参考：`cdp-log.ts` —— 独立 cdp.jsonl，方向标记（from-playwright/to-extension…）、字符串截断（默认 2000 字符）、循环引用保护、1 万条自动轮转、异步批量写入。上游 2026-06-29 提交还专门丢弃高频噪声事件降低刷屏。
- 移植要点：独立模块零耦合，接入点在 relay 的消息转发处。配合 `spawriter logfile` 增加 `--cdp` 开关。工作量约 0.5 天。

**P0-5 弹窗自动迁移（popup relocation）**
- 现状：页面 `window.open` 产生的弹窗不在扩展控制内，Agent 遇到 OAuth 登录弹窗即卡死。
- 参考：上游扩展将弹窗自动重定位为普通标签页并附加调试器，含 `popup-relocation.test.ts` 回归测试。
- 移植要点：改动在扩展 background；需与 spawriter 的所有权模型对接（新标签页应标记为发起会话 OWNED）。工作量约 1 天。

**P0-6 `getReactSource` / `getReactComponentInfo`（战略推荐）**
- 现状：无。Agent 看到 UI 问题后无法直接定位到源码组件。
- 参考：`react-source.ts` —— 基于 bippy 读取 React fiber，从 DOM 元素反查组件名、源文件:行:列、props 与组件层级。
- 为什么对 spawriter 特别重要：single-spa 子应用绝大多数是 React；"截图发现问题 → 直接给出子应用内组件源码位置" 是微前端调试的杀手级闭环，可与 `singleSpa.override` 联动（定位到组件 → 本地改码 → override 验证）。
- 移植要点：需引入 bippy（MIT）；对生产构建（无 debugSource）降级为仅组件名。工作量约 1-2 天。

### P1 —— 高价值、中高成本

**P1-1 直连 CDP 模式（`--direct`）**
- 参考：`chrome-discovery.ts`（扫描本机 `--remote-debugging-port` 实例）+ `cdp-relay.ts`。
- 价值：免扩展运行，解锁 CI、Docker、无扩展环境；也让 spawriter 自身的 E2E 测试不再依赖真人 Chrome + 扩展（当前集成测试只能测 HTTP 控制面，测不了真实 CDP 链路）。
- 成本：relay 需抽象出「扩展通道 / 直连通道」双实现，约 3-5 天。建议与 P1-2 一起做。

**P1-2 无头浏览器会话（`session new --browser headless`）**
- 参考：`browser-launch.ts`、`browser-install.ts`（Chrome for Testing 下载与版本管理）、上游 2026-06-25 两个提交（最后会话删除时自动关闭共享 headless 实例、修复自动关闭竞态）。
- 价值：同 P1-1，且为 spawriter 增加"零配置试用"路径。依赖 P1-1 的直连通道。约 2-3 天。

**P1-3 原生视频录制 + 演示视频**
- 参考：`screen-recording.ts`（扩展 tabCapture，原生帧率，无 Playwright 截图式录屏的卡顿）、`recording-relay.ts`（分片回传）、`ffmpeg.ts`（`createDemoVideo`：空闲片段加速、鼠标高亮）。
- 价值：微前端改动验收时"录一段演示"是高频诉求；与 ghost cursor 组合可自动产出产品演示视频。
- 成本：涉及扩展、relay、CLI 三端，约 3-5 天；ffmpeg 为可选运行时依赖（无则仅保存原始 webm）。

**P1-4 `getStylesForLocator`（规则级 CSS 检查）**
- 参考：`styles.ts` —— 用 `CSS.getMatchedStylesForNode` 返回命中的规则链、每条规则的源文件:行号、specificity 与被覆盖标记。
- 价值：spawriter 的 `cssInspect` 只有计算值，回答不了"这个样式是哪个子应用的哪行 CSS 写的"——而这恰是微前端样式冲突排查的核心问题。约 1-2 天。

**P1-5 快照作用域与 aria-ref 定位器**
- 参考：`aria-snapshot.ts` + `@xmorse/playwright-core` 的 `aria-ref=eN` selector engine。
- 价值：`snapshot({ locator })` 可只快照某个子应用容器（token 友好）；`page.locator('aria-ref=e12')` 让 ref 直接进入 Playwright 全 API 而不是只能走 `interact()` 的固定动作集。
- 成本：完整实现需要跟进 playwright fork（见 §8 风险）；折中方案是保留 spawriter 现有 backendDOMNodeId → `Runtime.getRemoteObject` 桥接，仅增加作用域参数。约 2-4 天。

### P2 —— 锦上添花

| 项 | 参考 | 说明 |
|---|---|---|
| ghost cursor 拟人操作 | `ghost-cursor*.ts` | 贝塞尔轨迹 + 页面可视化光标，演示/反检测场景 |
| 终端内联截图 | `kitty-graphics.ts` | kitty/iTerm2/WezTerm 直接显示截图，CLI 体验提升 |
| 用户钉选元素 | 扩展 pinned elements | 用户右键"发送给 Agent"，反向沟通通道 |
| `resizeImageForAgent` | 上游 utils | 统一图片降采样入口（spawriter 已有 quality tiers，可整合） |
| `kill-port` 工具 | `kill-port.ts` | relay 端口被占时的辅助命令（spawriter 已优雅退出，优先级低） |
| skill.md/resource.md 随包分发 | `skill.md`、`resource.md` | 把 Agent 使用指南作为 MCP resource 暴露，spawriter 目前靠用户 rules 注入 |

## 4. 参考 browser-use 的改进项（模式借鉴，非代码移植）

**B-1 Watchdog 弹性架构（最值得借鉴）**
- 参考：`browser_use/browser/watchdogs/` —— 14 个独立监视器：crash（进程/target 崩溃恢复）、downloads（下载拦截登记）、popups（JS dialog 自动处理）、permissions（权限自动授予）、security（域名白名单强制）、storage_state（cookie 持久化）、aboutblank（空白页兜底）等，统一事件总线驱动。
- 对 spawriter 的意义：本轮审计修复的 EADDRINUSE/EPIPE/detach 问题都是"事后打补丁"式修复。将 relay 中散落的恢复逻辑（`handleRecoverableProcessError`、dialog race 检测、tab detach 重连）重组为 watchdog 注册表模式，每个监视器单一职责、可单测，新故障类型只需加新监视器。这是架构级改进，建议在下次大重构时采纳。

**B-2 域名安全白名单（allowed_domains）**
- 参考：`security_watchdog.py` —— 会话级 URL 白名单，glob 匹配，导航前强制校验。
- 对 spawriter 的意义：Agent 驱动真实用户浏览器（带登录态 cookie），当前对"Agent 被 prompt 注入后导航到恶意站点"没有防线。可在 relay 的 `Page.navigate` / `Target.createTarget` 转发处加会话级 `--allowed-domains` 校验，属于纵深防御，与本轮的 token/CSRF 加固互补。约 1 天。

**B-3 面向 LLM 的 DOM 序列化**
- 参考：`dom/serializer/`、`enhanced_snapshot.py` —— 可见性过滤、交互元素索引、视口内外标记、token 预算裁剪，快照体积远小于原始 AX 树。
- 对 spawriter 的意义：spawriter 的 `formatAXTreeAsText` 已有 diff/搜索，但缺"视口内外标记"与"token 预算"概念。可选择性吸收：给 snapshot 增加 `viewport_only` 与 `max_tokens` 选项。约 1-2 天。

**B-4 CDP 超时分级**
- 参考：`_cdp_timeout.py` —— 按命令类型分级超时并统一封装重试。spawriter 的 `getCommandTimeout` 已有雏形，可对照补全遗漏命令类别（如 `Page.captureScreenshot` 大页面场景）。

**B-5 其余可读性参考**：`tokens/`（LLM 成本核算）、`agent/` 决策循环、`skills/` —— 与 spawriter 工具定位重叠少，仅作了解，不建议移植。

## 5. spawriter 独有优势（保持并强化）

1. **single-spa 工具链**（status/override/mount/unmount + import-map 处理）——上游完全没有，是 fork 存在的理由。P0-6/P1-4/P1-5 都应围绕它设计联动。
2. **标签页所有权模型**（MINE/AVAILABLE/OWNED + claim/release + 蓝点标识）——多 Agent 并存时不抢用户标签页，上游只有粗粒度共享。移植上游功能时注意全部过所有权检查（尤其 popup relocation、录制）。
3. **声明式 networkIntercept 规则**——上游建议手写 `page.route`，spawriter 的规则式 mock 对 Agent 更友好（可列出、可清理）。
4. **storage/emulation/performance/browserFetch/pageContent 套件**——上游要手写 CDP 才能做到。
5. **安全默认**——本轮加固后（默认回环绑定、公网需 token、全局 CSRF 防护、ScopedFS cwd 线程化），spawriter 的默认安全姿态已强于上游（上游 token 可选、绑定策略更宽松）。
6. **Windows 一等公民**——上游文档以 bash 为主；spawriter 的 stdin/-f 引号规避方案在 PowerShell 下更可靠。

## 6. 不建议移植项

| 项 | 原因 |
|---|---|
| 云浏览器/代理/验证码（`cloud-client.ts` 及 website/ 整套） | 商业服务绑定上游账号体系，spawriter 无此诉求 |
| traforo 隧道集成 | 依赖第三方隧道服务；spawriter 已支持 `--host` + token，需要远程时用户可自选隧道 |
| `@xmorse/playwright-core` 整体切换 | 供应链风险（个人维护的 fork）；仅在决定做完整 aria-ref 时局部评估 |
| browser-use 的 Agent 决策循环/LLM 集成 | spawriter 定位是"给 Agent 用的工具"而非"自带 LLM 的 Agent" |

## 7. 建议实施路线图

- **第一阶段（约 1 周）— 内容提取与调试体验**：P0-1 getPageMarkdown、P0-2 getCleanHTML、P0-3 waitForPageLoad、P0-4 CDP JSONL 日志。全部为低耦合新模块，每项配 node:test 单测。
- **第二阶段（约 1 周）— 微前端调试闭环**：P0-6 getReactSource、P1-4 getStylesForLocator、P0-5 弹窗迁移、B-2 域名白名单。完成后形成"截图 → 组件源码 → 样式来源 → override 验证"完整链路。
- **第三阶段（约 2 周）— 运行形态扩展**：P1-1 直连 CDP、P1-2 无头会话。顺带解锁 spawriter 自身的真 CDP 链路 E2E 测试。
- **第四阶段（按需）— 演示能力**：P1-3 视频录制、P2 ghost cursor、终端内联截图。
- **长期架构**：B-1 watchdog 模式重构 relay 恢复逻辑；建立对上游的定期 diff 机制（`git remote add upstream` + 每月 `git log upstream/main --oneline` 巡检，按模块 cherry-pick，如 2026-06-29 的 CDP 日志降噪提交）。

## 8. 移植注意事项

1. **许可**：playwriter 与 browser-use 均为 MIT。移植文件保留上游版权头或在文件头注明来源 commit。
2. **依赖差异**：上游 import 自 `@xmorse/playwright-core`，移植时统一改回 `playwright-core`；涉及 fork 专有 API（aria-ref selector engine、channel-owner 注入）的部分需要替代实现或降级。
3. **架构差异**：上游多数全局函数签名是 `fn({ page, ... })`（显式传 page，支持多页），spawriter 是绑定单活动页的闭包。移植时保持 spawriter 现有签名风格，内部转调。
4. **所有权模型**：所有会创建/接管标签页的上游功能（弹窗迁移、录制、headless 会话）必须接入 spawriter 的 claim/release 生命周期，否则破坏隔离承诺。
5. **测试**：上游用 vitest + 快照测试，spawriter 用 node:test。移植测试时同步改写，快照断言改为内联断言或忽略。
