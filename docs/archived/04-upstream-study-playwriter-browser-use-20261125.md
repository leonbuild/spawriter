# Spawriter 上游稳定性专项学习报告：Playwriter / Browser-use

> 2026-11-25；源码阅读报告，非运行测试报告  
> 目的：为 MCP navigate/execute 卡死治理提取可验证、可移植的工程机制，而非泛化功能比较。  
> 配套：[融合后的故障分析](03-integrated-rca-spawriter-mcp-chrome-hang-20261125.md)、[最终优化设计](05-implementation-plan-spawriter-mcp-stability-20261125.md)。

## 1. 研究基线与方法

| 项目 | 本地路径 | 已审查提交 | 版本/依赖 |
|---|---|---|---|
| Spawriter | D:\dev\side\spawriter | c811443 | playwright-core ^1.56.1；扩展 MV3、Offscreen |
| Playwriter | D:\dev-ref\playwriter | aa8744946f31ff973fbb9dc50d4b37d3340f475e（2026-11-21） | playwriter 0.12.0、extension 0.0.179；@xmorse/playwright-core 定制 workspace fork，可选 @playwriter/patchright-core |
| Browser-use | D:\dev-ref\browser-use | 94784c1f7ecb6b0a5f565b7f9fba59e395b7e048（2026-11-24） | 1.0.8；browser-harness==0.1.13，uv.lock cdp-use==1.4.5 |

上述为前一轮 git pull 后的本地 HEAD。研究内容以实际源码、Git commit、测试定义交叉验证，未将项目 README 宣称的能力直接当作运行结果。Playwriter 的 playwright 和 patchright-playwriter Git 子模块未初始化（固定 SHA 分别 5348a527d15d257f2f3c394bcae91d8d40990d74 / cab84e831bd5d8e051528d80e4ef79efa9c43cc1），故定制驱动取消 API 的内部实现尚未审计。Browser-use 将底层 CDP daemon 迁入独立 browser-harness 包，本地源码树未含该包、未安装或解包它；底层 socket 分发和所有取消语义不推断为已验证。未构建或运行任一上游 E2E。

## 2. 最值得借鉴的发现

| 机制 | 来源 | 采用策略 |
|---|---|---|
| 在 debugger 回调源头过滤无用高频事件 | Playwriter | 直接借鉴，P0 |
| SW 直接 WebSocket，避免逐条 Offscreen IPC | Playwriter | 优先试验，保留兼容 transport，P1 |
| per-tab UI 差量更新 | Playwriter | 直接借鉴，P0 |
| 同 Session 串行执行/reset/dispose | Playwriter、Browser-use REPL | 借鉴锁与生命周期，额外有界排队 |
| HTTP caller disconnect 传播 | Playwriter | 借鉴，检查 Node HTTP 实际取消事件 |
| running + later Playwright call abort | Playwriter fork | 不能直接调用 stock API；独立方案 + fork 可选 POC |
| Runtime enable holders、context cache、定向重放 | Playwriter | 优先借鉴，修复重连正反馈 |
| client/extension/target owner 路由 | Playwriter | 借鉴 registry，不照搬宽松共享策略 |
| process guard + AsyncLocalStorage 错误归属 | Playwriter | P0/P1 可移植；不是硬隔离 |
| drain + version/instanceId | Playwriter | 借鉴平滑升级；不自动 kill 未识别端口 |
| 可终止 Worker、父进程监督、Windows Job | Browser-use Agent REPL | P2 目标；与浏览器进程生命周期解耦 |
| dialog-aware CDP + per-method telemetry | Browser-use REPL | P1；按现有 dialog 策略适配 |
| OOPIF/worker network-idle 语义 | Browser-use | P1；按 frame/session 跟踪 |
| CLI-MCP 50s 后返回 still running | Browser-use CLI-MCP | **不作为 Spawriter 默认行为** |

核心结论：最直接的同类产品参考是 Playwriter；Browser-use 的价值主要在独立执行进程和生命周期设计。上游也存在未覆盖的风险，不能以更换项目或复制源码代替验证。

## 3. Playwriter：本轮新增机制与源码证据

### 3.1 相关 Git 演进（796e571..aa87449）

以下 commit 来自本地 git log，选择与稳定性有关者，而非完整 changelog。

| Commit | 意图及关联 |
|---|---|
| 35eaad7 / 6489336 | 从拒绝重叠的超时执行演进至 abort 超时脚本 |
| 1fd5c8c | cancel running Playwright actions when execute times out |
| accdfcc | relay/MCP survive agent mistakes |
| 10e439d | AsyncLocalStorage 归属 Agent fault |
| 44d489a | drain relay on upgrade |
| 2c42659 | extension/remote session reconnect |
| b8dba4f | 第二 CDP client 不再破坏其他 execution contexts |
| bbb92de | awaited evaluate 不被 relay 普通 30s timeout 截断 |
| 07edcae / 0837ab7 | session owned tabs、child target ownership |
| 3613221 | crashed/closed page 安全恢复提示 |
| b6bf797 | navigation targetInfoChanged |
| 83efdcb | MCP 改用 relay session tools，与 CLI 统一 |
| c30244e / d0946f3 | per-tab icon update / store diff |
| 586004f | handoff，明确移交 Tab |

这些修复与 Spawriter 当前 R2/R3/R4/R5/R6/R7/R8 高度相关。不能认为它们证明了本机第一次卡死原因，但足以支持设计选型。

### 3.2 Extension 传输：SW direct WebSocket + 前置过滤

源码：extension/src/background.ts，ConnectionManager（约 351–600）、sendToLocalRelay（795–810）、sendMessage（831–839）、dispatchRelayMessage（840 起）、onDebuggerEvent（1580–1664）；playwriter/src/cdp-relay.ts:292–320。

当前 Playwriter 直接在 extension background service worker 中创建 WebSocket，发送 JSON，不经过 Spawriter 每事件 runtime.sendMessage → Offscreen → sendResponse 这一跳。Relay 的 ping/pong 活动支持 service worker 存活；background 同时处理 reconnect、连接状态和 remote relay sink。Offscreen 权限仍存在，不能把它理解为项目完全不使用 Offscreen；这里只讨论 CDP 数据路径。

onDebuggerEvent 第一条逻辑即 DROPPED_CDP_EVENTS.has(method) return，集合为 Network.dataReceived、Network.resourceChangedPriority；Relay 保留相同过滤以兼容旧 extension。注释明确 *ExtraInfo 和 webSocketFrame* 不能随意丢，因为 Playwright 用于 allHeaders 和 websocket events。事件处理还避免为高频 Network、Page.lifecycleEvent、Page.screencastFrame 逐条输出 debug log。子 target 事件保留 source.sessionId，restricted child 会 detach；截图流有集中 ACK 机制。

**Spawriter 适配**：
- 双端过滤共享明确 allow/drop 表，并测试当前 Playwright 1.56.x 的依赖。
- 直连 WS 是降低额外 IPC 的优先 POC；需要验证目标 Chrome 对 SW WebSocket keepalive、启动恢复和兼容版本的行为，而非假定长连接永不终止。
- 另一报告建议 Port + batch，可作为保留 Offscreen 的兼容 transport。应仅对可采样遥测微批、队列有界。
- upstream 仍逐条 JSON.stringify/WS.send，未在已阅读路径中看到完整 Console 限流、字节背压或硬上限，因此不能只抄它的连接方式就宣布解决 R1。Spawriter 还必须做独立流量治理。

### 3.3 UI 更新：store diff 而非全量遍历

源码：background.ts:2920–2960、3413、3486–3490。提交 c30244e、d0946f3。

updateAllIcons 只在启动或 extension-replaced 状态变化时使用；updateIconsForStoreChange 比较全局 connected count/errorText，仅变化才更新 default；遍历前后受控 tab key 集合，状态/错误未变化跳过，只对受影响 Tab 取最新 URL。tabs.onUpdated 仅 status/url 变化调用 updateTabIcon，title 变化不触发该路径。extension-connection.test.ts:1416 有 “sends icons only for tabs whose icon changed” 集成测试定义。

**Spawriter 适配**：复用差量思路，另外为本项目蓝/绿点标题标记和 ownership snapshot 引入独立 dirty flag、版本及缓存。Chrome 新文档可能重置 per-tab action icon，status/url 变化时应让该 Tab 缓存失效；不能一味只看所有权差异。title 注入与图标更新分开；非 attached Tab 仅在受限 URL 边界、全局默认状态需要时处理。重复轮询不写 storage。

### 3.4 CDP Relay：extension-scoped state、统一路由

源码：playwriter/src/relay-state.ts:26–99、199–343、405–505；cdp-relay.ts:381–514、550–638、1945–1955、2200–2320、2529 起。

relay-state 将 ExtensionEntry、ConnectedTarget、PlaywrightClient、pendingRequests 分开；目标带 ownerKey、parentSessionId、frameIds，客户端记录 extensionId/sessionId。sendToPlaywright 统一构造消息并一次 JSON.stringify，对指定 client 或当前 extension 下可见的 target 路由，并捕获 closing WS 的发送异常。extension pending 以 extensionId 和 requestId 关联；timeout、send fail 删除 pending；extension close reject 所有 pending。关闭 Playwright client 时释放 screencast、recording、runtime holders、focus、client registry。

相比 Spawriter 的 ownerClientId + all pw-* + virtual fanout，这种统一出口及目标归属模式更清晰；但上游 canClientSeeTarget 对未 owned target、无 session 的 client、旧 relay/已删除 owner、SDK shared tabs 有意放宽。findEventTarget 找不到目标时也可能广播 browser-level/unknown event。因此不能直接照搬，否则会退化 Spawriter 当前严格的 lease/ownership policy。

**移植决策**：
1. 将 relay 路由与 registry 拆模块；对已绑定 Session 严格检验当前 owner、physical generation、announced/subscription。
2. virtual browser/page Session 是 Spawriter 的兼容结构，不假设上游存在相同 vps/vbs 数据模型；按 client + logical sid 精确登记和释放。
3. 一次事件只对每个 (clientId, destinationSessionId) 发送一次。控制事件、目标 detach 应在移除 registry 前冻结合法接收方。
4. pending 注册时固定 client/extension generation，旧响应只记 tombstone；断线不等于已取消 Chrome 原生命令。
5. 不以客户端字符串前缀 pw-* 推定权限。

### 3.5 Runtime domain 多客户端管理：最重要的直接参考

源码：cdp-relay.ts:1121–1165、1229–1244、1303–1385；extension/src/background.ts:1470–1499。提交 b8dba4f。

上游明确解释：Runtime.enable 是物理 tab/target Session 级，不是逻辑 client 级；反复 disable/enable 会让所有客户端收到 context 重建事件，使旧 handles 和 in-flight evaluate 失败。

Relay 的 runtimes Map 以 extensionId + sessionId 作为 key，每项保存 enabled Promise、contexts Map、holders Set。第一位 client 创建 shared enable Promise，并在事件到达前注册 cache；后续 client 加入 holders，await enable，再做 Runtime.getIsolateId round trip 让该客户端先前 Page.getFrameTree 有机会完成，然后只向该 client 重放 Runtime.executionContextCreated，不再次让物理域 recycle。Runtime.disable 由最后 holder 决定是否发给 Chrome；client close 移除 holder；target detach/extension close 清理 cache；executionContextCreated/Destroyed/Cleared 实时维护。

enableRuntime 监听 default execution context，最长等 3s，超时仅警告。Extension 仍有首次 Runtime.enable 前 bounded disable（10s）、sleep 50ms、enable（10s），保留真正 child sessionId。说明上游没有彻底消除物理 recycle，而是限制重复逻辑初始化。

**值得采用，但要增强**：
- registry 按 physical target generation，而不是只按 sid；attach、detach、导航过程有一致状态边界。
- listener 应同时校验 extension/physical identity，不把同名 session 其他连接事件视为当前 context。
- 默认 context 不一定等同主 frame，需要按 frameId 确认；无默认 context 时不能合成成功快照。
- 定向 replay 需保证 snapshot 与 live event 之间不重不漏（序列号/同步 barrier）。
- Page domain、Network/Fetch 的状态与订阅语义分别设计；不能将 Runtime 方法机械推广至全部 domain。
- upstream 能保留 OOPIF child debugger session；Spawriter 当前部分 child attach 丢弃逻辑不能宣称已经具备同样能力。
- 首轮 P0 先消除无界 disable 与并发 recycle；P1 引入 cache/replay 并验证两个真实 CDP client 同时执行。

### 3.6 Session 执行与取消：runExclusive + driver abort

源码：executor.ts:127–141、847–878、1460–1477、1519–1550、2028、2176–2210、2283–2319、2355–2370；relay-sessions.ts:781–809；cdp-relay.ts:3014–3070。

executor.runExclusive 用 operationTail Promise chain 序列化操作，pendingOperations 包括等待与运行，finally 更新时间和计数。execute、reset、dispose 等均走该锁；disposing 阻止新操作。idleMs 在有 pending operation 时返回 0，避免 idle sweep 清理正在执行/排队的 Session。

executeInternal 在获得锁后检查 caller signal.aborted。HTTP 入口传 c.req.raw.signal，client 的 executeInSession 合并 caller signal 和 timeout + 30s response grace。实际 VM 脚本调用 chromium.runWithAbortSignal(abortController.signal, runScript)，timeout 和 caller abort 时都 abort controller，再 reject race，并清 timer/listener。脚本中暴露 signal，错误提示检查页面再重试，不再推荐整段自动重放。

注意局限：
- runExclusive 没有完整有界队列和入队时绝对 deadline；当前计时仍主要围绕脚本执行。
- 取消效果依赖 @xmorse/playwright-core / @playwriter/patchright-core 的非 stock API；子模块未初始化，不能声称已阅读它如何中止 server-side progress。
- 上游测试明确显示旧脚本纯 JS continuation 仍可能醒来并修改 state.signalAborted；只是后续 Playwright 调用失败，不是任意 JS 被杀死。
- HTTP abort、JS continuation、Chrome side effect 是不同层次。CDP 已提交的表单不可回滚。
- upstream browser disconnected callback 仍有直接清理状态的路径（executor.ts:1264、1301），Spawriter 要补 generation identity 防护。

**首轮采用**：bounded per-session queue + session identity + typed cancellation + HTTP signal/explicit cancel + Relay command fencing；无法确保 stock Playwright 已中止的任务，保持 recovering/unhealthy，不复用旧能力。是否引入 fork，应由单独 POC、维护成本、协议兼容与测试决定。最终任意 CPU/JS 隔离参考 Browser-use 子进程。

### 3.7 Process guard：错误归属不是进程硬隔离

源码：playwriter/src/process-guard.ts:1–115；executor.ts:2185；start-relay-server.ts；提交 accdfcc、10e439d。

runAsFaultOwner 用 AsyncLocalStorage 在 VM 执行与异步 continuation 中标记 executor；unhandledRejection 转为相应 Session warning 并计数、限频；uncaughtException 只在 stack 归属于 VM（.playwriter-eval.js）或 playwright/patchright-core 时尝试容错，未知内部错误 flush 日志后 exit(1)。日志窗口 60s，最多 5 条完整 contained fault。

对 Spawriter 已有全局 uncaught/rejection 恢复逻辑，值得借鉴 owner 归属、告警、率限制和 fatal 分类，不再让单个忘记 await 的脚本导致全 Relay 重启；但不能无条件吞所有 assertion/异常，也不能靠它中断同步死循环、内存膨胀或清除损坏状态。建议 process guard 放在 Worker 层；Relay 内部不变量破坏由独立 supervisor 安全退出/恢复，保留故障证据。

### 3.8 Relay 启停、drain、版本和长任务

源码：relay-client.ts:238–318、388–457；cdp-relay.ts:2965–3070；relay-sessions.ts:24–31、781–809。

上游启动有 pendingEnsure single-flight、port PID 检查、等待竞争进程的 /version；旧 client 不替换更新 server；升级先 /cli/drain，instanceId mismatch 返回 409，draining 拒绝新 execute（503），跟踪 activeExecutes，默认等 30s、上限 120s 后停止。请求响应写完/连接 close 纳入计数。注意 drain deadline 超出仍会停止，不能宣称永远不打断任务。它在 port 被占用且始终无法识别时也有 stopRelay 路径；Spawriter 不应照搬未知进程 kill 风险。

relay command timeout 区分普通 60s 与 awaitPromise 5min（cdp-relay.ts:140–144）；这是避免合法慢 JS 被错误中断的机制，不是应无限放宽 execute deadline 的理由。Spawriter 仍需统一用户预算、每类命令 cap 和可配置 grace。

### 3.9 Logger：上游已有脱敏但未彻底解决内存/字节风险

源码：cdp-log.ts:19–53、60–156；cdp-relay.ts:146–165。默认排除 screencast 等噪声、敏感 cookie/authorization/header 键脱敏、private file mode、字符串截断、500ms 批量写入。仍按 10,000 行旋转，readFile/split/join/writeFile；log() 同步 stringify，未看到完整 Console stack 限制和队列字节上限。故 Spawriter 自行设计固定字节 segment ring、metadata-only 诊断是必要的，不宜直接同步上游 logger。

### 3.10 上游已写的测试（已阅读定义，未运行）

| 文件与定位 | 实际验证意图 |
|---|---|
| relay-core.test.ts:1004 | 同 CLI Session A/B 执行顺序 |
| :1046 | 超时脚本后来醒来，signal.aborted=true，旧浏览器调用不能成功，新 execute 正常 |
| :1079 | 超时的 locator click 等待元素，后续创建元素仍不得触发旧 click |
| :2048 | MCP Session create/list/delete/isolation |
| :2103 | awaited evaluate 可跨普通 command timeout |
| process-guard.test.ts:51 | un-awaited rejection / throwing timer 后下一任务存活 |
| :79 | caller disconnect abort 与 drain |
| extension-connection.test.ts:1416 | 只更新变更 Tab 的 icon |
| relay-navigation.test.ts:183、343、377、625 | OOPIF、真实页面导航、detach event 路由 |

这些是 Spawriter 回归测试的高价值模板。不能直接复制依赖上游 fork 的断言却不实现等价取消能力。

## 4. Browser-use 1.0.8：架构迁移后的稳定性机制

### 4.1 必须先纠正旧架构认知

pyproject.toml:1–31 指明 persistent Python REPL on raw CDP，browser-harness 固定 0.1.13；旧 browser/session/watchdog/actor 等大量文件在本轮更新中被替换或迁移。当前应研究 browser_use/browser/browser.py、repl/session.py、repl/worker.py、repl/network_idle.py、mcp/cli_mcp.py，不应仍以旧 Watchdog 架构为最新事实。底层 browser-harness daemon 本体不在此次 checkout，锁定版本详见 uv.lock:65–81、153–164。

存在两条不同执行路径：
- Agent 库：Browser + Repl 子进程，通过 loopback 控制 channel 与 browser-harness daemon 交互，支持真正终止执行进程树。
- CLI-MCP：browser_exec 在本 MCP server 的线程中执行，具有独立输出和 50s response window，允许任务超过调用窗口继续运行；并非前一条 kill-and-restart 语义。

### 4.2 Agent REPL：独立进程、超时硬终止

源码：repl/session.py:1–17、222–300、304–450、460–485、524–580。

父进程以随机 token 验证 worker 回连本地 ephemeral port，采用跨平台 socket 而非继承 FD；Popen 持久进程、每 cell 编号，回复需匹配 n，不会将旧 cell response 给新 cell。asyncio.Lock 串行 cell；loop 变化时重建适配的 lock/worker。

_call 将 startup/send/wait 包在统一 cleanup boundary 内；read response 用 asyncio.timeout，TimeoutError/ConnectionError 时 await close()，读取并裁剪已保存 cell output，返回 CellTimeout 或 WorkerExited，提示 Python 变量丢失、文件/checkpoint/browser state 保留、Actions may already have happened; inspect before retrying。CancelledError 同样 close 后重新抛出。注意 timeout 主要包响应读取，startup 和 drain 并非天然包含在同一 budget；Spawriter 应做更严格端到端 deadline。

这比 Promise.race 强，因为旧进程本身被终止，新的任意代码不能继续运行于旧 VM；但已经送到 Chrome 的原生 CDP 操作仍可能产生副作用，浏览器不是 Worker 子进程的附属资源，不可说 kill Worker 等于回滚浏览器。

### 4.3 Windows 与父进程死亡的处理

源码：repl/session.py:222–300；repl/worker.py:1088–1113。Windows Job Object 使用 kill-on-close 约束 Worker 及其 cell 子进程，必要时 taskkill /F /T /PID；POSIX worker 独立 process group，killpg；父进程记录进程与 job handle，atexit/终止清理；worker _watch_parent 在 Windows 等待 parent process handle、POSIX 观察 parent 死亡。

对 Windows 上的 Spawriter 特别有价值。建议 supervisor 启动每 Session Worker 并持有受控 job/process identity，不允许将用户 Chrome 或共享 Relay 纳入同一 job；监控 PID 重用、启动失败、父进程死亡、取消发生在 spawn 前后等边界。仅复制 taskkill PID 命令不够安全。当前 Node.js 无需引入 Python REPL，使用 Node child_process + 可验证的 Windows 进程树封装即可。

该 worker 并非安全 sandbox：源码明确模型代码可访问本机文件等资源。Spawriter 还需保留 scoped FS、模块限制、所有权和 capability validation；进程隔离首先是可靠性边界。

### 4.4 Browser 生命周期：只恢复拥有的对象，不重建用户 Chrome

源码：browser/browser.py:674、701–790、876–899、1125–1178。Browser._lock 串行 start/stop/reattach；start 幂等、同浏览器 daemon 重启；reattach 在 Browser 已经被 stop 后拒绝隐式创建另一个浏览器，避免中途丢 tabs/logins；新 browser 与 same browser recovery 有明确区别。stop 文档说明仅停止自己启动的 daemon/browser，不碰用户正在使用的 Chrome。下载及 stop 的取消有专门 grace，stop 在 finally/shield 中清理。

Spawriter 应保持现有 user tab 不可抢占/全局清除禁止政策，进一步明确 resetLogicalSession / reattachOwnedTab / releaseLease / shutdownRelay 四种不同操作。仅连接恢复不得关闭真实浏览器；物理 detach 后确认 ownership generation 再重新 attach。

### 4.5 CLI-MCP 的继续执行策略：有意不采用

源码：mcp/cli_mcp.py:70–85、352–370、488–505、680–755。

CALL_SECONDS=50，避免 60s MCP SDK 等待窗口耗尽；_exec_call 的 lock acquisition 计入 deadline；_Cell 自己的线程和 StringIO 独立捕获输出，过期或客户端取消后仍继续运行；空 code 查询后续输出；新 code 可以与未完成代码并行（提示文本明确说明）。_locked 注释承认线程不可停止，取消释放锁，旧线程仍跑。

这是为了 tool response liveness 与长任务输出，并非严格执行隔离。**与 Spawriter 当前用户需求冲突**：如果默认采用，旧浏览器命令可能在新任务中继续执行，引发原问题。可借鉴响应窗口、taskId/状态查询和独立 output，但必须显式 opt-in long-running job，仍持有目标 lease，不能把 timeout 后继续运行当作正常失败恢复。P0 不提供脱离请求的后台执行。

最新 #6526（94784c1f7）及 65820e9b3 针对 CLI/CLI-MCP 从自有临时 Chromium 切换到已开启远程调试的用户 Chrome。见 cli.py:711–798、mcp/cli_mcp.py:850–883。此为启动/连接体验，不是本次卡死的直接解法，也不能让 Spawriter 自动抢占用户 Tab。

### 4.6 Dialog-aware CDP、按方法统计和 network-idle

源码：repl/worker.py:550–625、645–694；repl/capture.py:6–7；repl/network_idle.py:1–55。

JS dialog 会阻塞页面相关命令；worker 查 pending_dialog meta，对已知 dialog 缩短 probe（2s），对于本身可能触发 dialog 的 command 使用线程与 pending dialog probe 竞赛，提示 accept/dismiss；旧 CDP call 仍可能在对话框处理前排队，因此不要把该机制误认为强取消。CDP 默认 20s、screenshot 60s；timed wrapper 按 method 用 perf_counter_ns 计时及记录失败。Spawriter 已有 dialog listener，需监控对话框状态并确保 control lane 不被遥测堵住；尊重显式 debugger 暂停、已有用户 dialog 策略。

network_idle.py 说明 browser-harness 0.1.13 的 helper 会错误等待在 tab session 开始、child target 结束的请求（worker script loaderId=""、OOPIF）。本模块为 #982 的兼容实现，按 active session 过滤；对 Page.frameDetached reason=swap 移除相应 frame in-flight，Page.frameAttached 回归本进程；worker loaderId 为空不计；idle deadline 到达返回 False。Spawriter 可借鉴 frame/session 感知，但必须测试 loaderId、redirect、跨站 iframe、ServiceWorker、长连接/SPA XHR。不可直接照抄任何 Network.* 都刷新 idle 时间的策略而导致 HMR/WS 永不 idle，也不应使用 wall clock 代替单调时钟。

### 4.7 Browser-use 已有测试（仅读定义）

| 文件 | 场景 |
|---|---|
| tests/ci/test_repl.py:62、73 | Worker timeout 重启、释放 socket |
| :170 | caller cancelled 后重建 Worker |
| :213、492、517 | 终止 cell 子进程、Worker 先死亡后仍清进程树 |
| :542 | startup 期间取消 |
| :428、579 | 大输出裁剪、timeout 后避免读取整个大文件 |
| :834 | parent mid-cell 死亡 |
| tests/ci/test_browser.py:467、547、1028、1083 | start 幂等、取消启动、取消 stop 与新 start 不重叠、bounded local startup |
| tests/ci/test_local_browser.py:188、1064、1155、1180 | 取消、父进程 SIGKILL、PID 复用、重连 daemon watchdog |
| tests/ci/test_browser_use_cli.py:577 | 文档加载等待期间 dialog 提示 |

## 5. 对照 Spawriter 的差距与迁移成本

| 领域 | Spawriter 基线缺陷 | 上游可参考 | 不能直接解决的部分 |
|---|---|---|---|
| 事件源 | 无前置过滤、逐条 Offscreen IPC | PW 直连与过滤 | Console 风暴治理、端到端背压需自建 |
| UI | 全 Tab 刷新、重复 ownership | PW store diff | 蓝绿点 title marker、轮询和 cache 特有 |
| Runtime | 每次 enable 物理 recycle | PW holders/context replay | vps 映射、OOPIF 兼容、generation barrier |
| execute | cancel 前一个再马上执行 | PW operationTail / BU lock | deadline/queue cap、旧脚本能力隔离 |
| 取消 | race 只停止等待 | PW fork abort、BU Worker kill | stock PW API、原生已提交 CDP 结果未知 |
| 进程错误 | 广泛恢复/共享 event loop | PW ALS guard、BU watchdog | Relay/Worker 独立、fatal 状态边界 |
| Session | activeAgentId 全局可变、重复广播 | PW 显式 Relay Session | 严格 owner 与 Tab lease 不得退化 |
| 导航 | 忽略 errorText、旧 doc readyState | PW 安全提示/targetInfoChanged、BU dialog/network idle | 实际 commit、same-document、下载、局部恢复 |
| 升级 | 健康检查失败重复 spawn | PW version/drain | 跨进程互斥、未知 PID 不 kill |
| 日志 | 全对象+按行轮转 | PW 脱敏/私有文件 | 字节限额、保全、精简诊断 |

### 5.1 建议采用路线

第一阶段优先小范围移植 PW 源头过滤、per-tab icon、串行化/错误类型、路由及 runtime 初始化有界化；自建 Console 流量治理和 logger。第二阶段按 Runtime registry、直连传输 POC、显式取消、per-method latency、dialog/network-idle 和 drain 扩展。第三阶段参考 BU REPL 的独立 Worker、进程树清理；可独立评估 Playwright fork，不能把是否引入 fork 与 P0 稳定性修复绑定。

### 5.2 不做的事

不把整个 Playwriter 当前仓库直接 merge 进 Spawriter；不引入 browser-use 的 Python Agent 或自动切换用户 Chrome；不迁移与稳定性无关的 cloud/stealth/recording 功能；不把上游测试定义误称为已通过；不把 process guard 当作 CPU/内存硬隔离。

## 6. 后续验证及证据链接

上游只读研究已完成到上述本地 HEAD 的应用层和测试层。建议后续独立任务：
1. 初始化 Playwriter 两个固定 SHA 子模块（用户授权后），定位 runWithAbortSignal 从 client 到 server 的取消实现和 late-action 测试覆盖；决定 fork 是否值得维护。
2. 获取 browser-harness==0.1.13、cdp-use==1.4.5 的锁定源码（不执行安装脚本，核验 lock hash），补读 daemon pending、event buffers、IPC、shutdown；当前设计不依赖未验证细节。
3. 在独立测试 profile 执行原版/候选版压力测试，而不是直接在日常 Chrome 复现 3,000 条事件爆发。

参考仓库的永久提交入口：
- https://github.com/remorses/playwriter/tree/aa8744946f31ff973fbb9dc50d4b37d3340f475e
- https://github.com/browser-use/browser-use/tree/94784c1f7ecb6b0a5f565b7f9fba59e395b7e048

本报告来源为本地 Git checkout，不声称已联网逐页验证上述链接。无上游文件修改、依赖安装、子模块初始化、浏览器操作或测试执行。学习成果已经用于配套最终优化设计；实施与验收仍待完成。

## 7. 补充 RCA 对学习结论的影响（2026-11-25）

再审阅[另一 Agent 原报告](01-original-rca-mcp-chrome-hang-20261125.md)及新增[扩展版 RCA](02-original-rca-mcp-chrome-freeze-expanded-20261125.md)，结合 Spawriter 源码核实 R12–R15。详见[融合故障报告第 12 节](03-integrated-rca-spawriter-mcp-chrome-hang-20261125.md#12-第三份报告补充审计及最终裁决)和[优化设计 1.1](05-implementation-plan-spawriter-mcp-stability-20261125.md)。

| 新问题 | 已审查上游机制 | Spawriter 适配结论 |
|---|---|---|
| AX/DOM helper enable 无配对关闭 | Playwriter Runtime holders/context cache（cdp-relay.ts:1121、1229、1303） | 借鉴 scoped holder 模型，但并非上游已经实现等价 AX/DOM lease；需独立验证 stock API、node/ref 稳定性 |
| DevTools 多触发源并发读取、共享槽及无界 callback | Playwriter operationTail、Browser-use Repl lock/worker deadline 的通用原则 | Spawriter 特有 single-spa panel；自行实现 per-document single-flight/dirty rerun、唯一 request slot、callback timeout。没有证据表明上游存在同类面板修复 |
| Relay 全局断言阈值触发 resetAll | Playwriter process-guard.ts:29–115 AsyncLocalStorage 与异常分类 | 借鉴错误归属与 fatal 边界；driver/路由事件需显式 client identity；局部恢复不能直接复用 upstream guard |
| 本地 MCP executor 镜像与实际 Relay state 漂移 | Playwriter 83efdcb，relay-sessions.ts:781 起；Browser-use browser.py 的生命周期锁 | Relay 为唯一 active target authority，固定请求 Session ID，先迁移接口再移除镜像；不照搬上游宽松共享权限 |

第三份报告建议的 Port + 全事件微批、普通 Console 固定单帧栈、额外丢弃 screencastVisibilityChanged 等不直接采用；上游已审查的 drop 表只有两个 Network 事件，Runtime replay 依赖关键事件次序，正常 Console 应保真。P0 仍为 source filtering/流量治理、UI diff、路由、错误分类和隔离；P1 增加专属 panel 调度与 authoritative state 迁移。

本节为对既有上游研究的关联补充，不代表重新拉取上游或扩大到未初始化的 driver 子模块、browser-harness daemon。当前日志中 234 条 duplicate frameAttached 告警不能证明上游同款 bug 或唯一双发来源；本地源码注释还指出初始化快照与实时事件竞态。上游设计作为参考，最终以本项目实际复现与验收为准。
