# spawriter 错误输出深度审计文档（XCAI 上传场景）

## 1. 问题概览

本次观测到两类错误同时出现：

1. 浏览器侧上传请求报错（`CORS` + `net::ERR_FAILED` + `502`）
2. spawriter 执行层报错（`Code execution timed out after 30000ms`）

二者会互相干扰认知，容易误判“只有 CORS 问题”或“只有 spawriter 问题”。

本结论是：

- **上传失败的业务主因在后端/网关链路（502）**，CORS 报错是错误响应未携带 CORS 头后的浏览器表现。
- **spawriter 的确存在可改进点**：执行超时机制会导致“命令超时但页面动作可能已生效”的假失败体验。

---

## 2. 现场错误输出（归档）

### 2.1 浏览器控制台

- `Access to XMLHttpRequest ... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header ...`
- `POST https://paper.cstcloud.cn/api/literature/upload net::ERR_FAILED 502 (Bad Gateway)`

### 2.2 spawriter 命令行

- `Error executing code: Code execution timed out after 30000ms`
- `[HINT: Execution timed out. The operation may still be running in the browser. Use reset if the browser is in a bad state.]`

### 2.3 后续校验

在超时后执行 `page.url()`，返回目标地址（`https://xcai.cstcloud.cn/upload`），说明导航动作并非一定失败，可能是“返回超时，动作晚到达”。

---

## 3. 调用链和组件边界

本场景（`spawriter -s <id> -e 'await navigate(...)'`）执行链：

1. CLI 入口：`spawriter/src/cli.ts`
2. HTTP 调度：`POST /cli/execute`（`spawriter/src/relay.ts`）
3. 执行器：`executor.execute(code, timeout)`（`spawriter/src/pw-executor.ts`）
4. VM 全局函数：`navigate(url)`（`pw-executor.ts` 中注入）
5. 底层导航：
   - 优先 CDP：`Page.navigate`
   - 退化路径：`page.evaluate('window.location.href=...')`

---

## 4. 根因机制（重点）

## 4.1 超时预算冲突

`execute()` 外层有总超时（CLI 默认 30000ms），而 `navigate()` 内部逻辑是：

1. 发送 `Page.navigate`（CDP 命令超时配置为 60000ms）
2. 额外固定等待 `2s`
3. 返回 `Navigated to ...`

因此，当 `Page.navigate` 本身超过约 `28s` 时，外层 30s 先触发，出现：

- CLI 返回超时错误
- 浏览器中的导航可能仍在进行并最终成功

可以表达为：

`T(Page.navigate) + 2s + 运行开销 > 30s  => execute 超时`

---

## 4.2 为什么会“报错但页面到了”

`execute()` 的超时实现是 `Promise.race`，超时后返回错误，但并不总是能真正中止浏览器侧已发出的 CDP 命令。

结果是：

- 控制面（CLI）认为失败
- 数据面（浏览器页）可能继续变化

这就是超时后 `page.url()` 可能已经是目标地址的原因。

---

## 4.3 与 `setDefaultNavigationTimeout(15000)` 的关系

执行器中会设置：

- `page.setDefaultTimeout(Math.min(timeout, 30000))`
- `page.setDefaultNavigationTimeout(Math.min(timeout, 15000))`

但当前 `navigate()` 主路径用的是 CDP `Page.navigate`，不是 `page.goto()`，所以该 15s 限制**不直接决定** `navigate()` 超时点。

它主要影响用户在脚本里直接调用 `page.goto()` 的场景。

---

## 5. 与 CORS/502 的关系（避免误诊）

同一时间窗出现 CORS 与 502 时，建议按如下优先级判断：

1. 业务失败主因先看 HTTP 真实状态（这里是 502）
2. CORS 报错通常是“错误响应未带 CORS 头”的前端表现

已做过的链路验证：

- `OPTIONS /api/literature/upload` 可返回 `200` 且带 `access-control-allow-origin`
- 非法 token 的 `POST` 返回 `401` 且也带 `access-control-allow-origin`
- 实际上传请求在浏览器中出现 `ERR_FAILED` + 502，说明“异常路径（网关/上游）”头部处理不一致

结论：

- **上传失败主因仍在后端/网关异常路径**
- spawriter 超时只是在调试过程中增加噪声，不是导致后端 502 的根因

---

## 6. 当前可确认的 spawriter 风险点（审计清单）

### High

1. **外层 execute 与内层 navigate 超时预算不一致（已修复）**  
   已通过预算函数绑定内层导航超时到外层剩余时间，消除固定 2 秒导致的预算挤占。

2. **超时后缺少“动作是否已落地”的自动核验（部分修复）**  
   当前成功路径已输出 `readyState/currentUrl`；错误路径已改为预算错误 + 超时提示，但仍可继续增强 phase 级结构化诊断。

### Medium

3. **导航路径固定 sleep（已修复）**  
   `navigate()` 已去除固定 `sleep(2000)`，改为预算驱动并附带状态观测。

4. **不同入口默认 timeout 不统一（待修复）**  
   CLI 默认 30s，relay 路由在缺省场景可能回退到 10s。

### Low

5. **错误信息可观测性不足（部分修复）**  
   成功路径与预算错误路径均已增强，仍建议补 `phase` 与耗时分段信息。

---

## 7. 修复措施（本次已落地）

本次不是仅“兜底提示”，而是改了执行语义，目标是减少假失败并提高可证伪性。

## 7.1 已实施修复

1. **移除 `navigate()` 固定 2 秒等待**
   - 旧逻辑：`Page.navigate` 后固定 `sleep(2000)`
   - 新逻辑：不再固定 sleep，避免人为吞掉 2 秒执行预算

2. **新增 `computeNavigateCommandTimeout()`，将内层导航超时绑定到外层剩余预算**
   - 计算公式：`min(Page.navigate 上限, remainingExecutionMs - safetyBuffer)`
   - safety buffer 取 250ms，避免 race 边界抖动
   - 当剩余预算不足时，直接抛出明确错误（不是隐式超时）

3. **`navigate()` 返回增加状态可观测字段**
   - 返回文本追加：`readyState`、`currentUrl`
   - 让“命令结果”可直接用于判定是否已落地

4. **`execute()` 内显式传递 deadline 到 VM 全局逻辑**
   - 子操作可以感知统一时间预算，而不是各自独立估算

5. **新增 `NavigationBudgetError` 与 timeout-like 分类**
   - 预算不足错误不再落到“连接错误提示”分支
   - 提示语统一为超时语义，便于直接调大 `--timeout`

## 7.2 对应代码位置

- `spawriter/src/pw-executor.ts`
  - 新增：`computeNavigateCommandTimeout()`
  - 修改：`execute()` 向 `buildVmGlobals()` 传递 `executionDeadlineMs`
  - 修改：`navigate()` 去掉固定 2 秒等待，改为预算驱动
- `spawriter/src/pw-executor.test.ts`
  - 新增预算函数、错误分类相关单测

---

## 8. 修复证明（已执行）

## 8.1 单元测试证明

执行命令：

- `npx tsx --test src/pw-executor.test.ts`

结果：

- `tests 194`
- `pass 194`
- `fail 0`

新增断言已覆盖：

1. 30s 剩余预算会保留 safety buffer（不再把预算吃满）
2. 超大预算会被 `Page.navigate` 上限约束（60s）
3. 剩余预算过小时抛出明确错误（避免模糊超时）
4. `NavigationBudgetError` 被识别为 timeout-like，不再触发“连接错误”误提示

## 8.2 行为层证明

修复后，`navigate()` 的时间预算不再包含固定 2 秒等待，等价于将临界超时阈值从“约 28s”提升到“接近外层 timeout（减 safety）”。

这不是“增加兜底”，而是移除人为延迟并统一预算约束。

本地源码 relay 实测输出（已确认）：

1. 正常预算：
   - 命令：`npx tsx src/cli.ts -s sw-mokud3yy-in7u -e 'await navigate("https://xcai.cstcloud.cn/upload")'`
   - 返回：`Navigated to ... (readyState=unknown, currentUrl=...)`
   - 证明点：成功路径可直接观测 URL 与页面状态

2. 低预算（强制触发）：
   - 命令：`npx tsx src/cli.ts -s sw-mokud3yy-in7u --timeout 600 -e 'await navigate("https://xcai.cstcloud.cn/upload")'`
   - 返回：`Insufficient execution time remaining for navigate(): ...ms` + 超时语义 hint
   - 证明点：错误从“模糊超时”变成“可解释预算错误 + 正确提示”，可直接指导调参

---

## 9. 回归测试计划（建议纳入 CI）

## 9.1 功能用例

1. `navigate` 在快页下正常返回
2. `navigate` 在慢页（模拟网络慢）不应误报失败（或应返回可解释 partial result）
3. 超时后立即执行 `page.url()`，应可看到一致可解释状态

## 9.2 稳定性用例

1. 连续 20 次 `navigate -> snapshot` 不应出现不可恢复挂死
2. `session reset` 后首次调用应稳定恢复

## 9.3 兼容性用例

1. CDP 可用路径
2. CDP 不可用 fallback 路径
3. 多 session 并发（验证不串会话）

---

## 10. 一线排障 Runbook（现场可直接用）

1. 先执行：
   - `spawriter -s <id> -e 'page.url()'`
2. 若超时刚发生，优先确认“状态是否其实已变化”：
   - `spawriter -s <id> -e 'await snapshot({ search: "上传" })'`
3. 若连接异常：
   - `spawriter session reset <id>`
4. 对慢站点提高预算：
   - `spawriter -s <id> --timeout 90000 -e 'await navigate("...")'`
5. 分离业务故障与工具故障：
   - 工具层只负责复现/采样
   - 业务层（API 502、CORS 缺头）交由后端/网关日志定位

---

## 11. 最终结论（供项目记录）

在 XCAI 上传场景中，`Code execution timed out after 30000ms` 的本质是：

- spawriter 执行超时策略与导航内部耗时组合导致的“控制面超时”
- 并不必然等于页面动作失败

真正导致上传失败的是后端/网关上传链路（502）及异常路径 CORS 头缺失。  
spawriter 需要改进的是**超时语义、状态可观测性与预算一致性**，以降低误诊成本。

