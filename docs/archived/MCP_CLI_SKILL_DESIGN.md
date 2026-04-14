# Spawriter CLI + Skill 设计文档

## 1. 背景

本设计文档的目标是：参考上游 `D:\dev\0-ref\playwriter` 已验证的做法，为 `D:\dev\side\spawriter` 设计一套在现有 MCP 基础上增加 `cli + skill` 使用方式的方案。

本次只做设计，不实施代码。

当前结论很明确：

1. `playwriter` 的成功点不在于“多了一个 CLI 文件”，而在于它把 **MCP、CLI、skill、文档、运行时状态** 串成了一个完整产品面。
2. `spawriter` 当前已经有可运行的 MCP 和一个很薄的 CLI，但还没有形成 `CLI-first + skill-guided` 的使用闭环。
3. 如果只是把以前删除的 `SKILL.md` 和 `cursor-rules` 手工恢复回来，或者在现有 `mcp.ts` 外面硬包一层 CLI，都只能得到“能跑但会继续分叉”的结果，不会得到上游那种稳定形态。

## 2. 研究范围

本次研究重点查看了以下内容。

### 2.1 上游 `playwriter`

- `playwriter/package.json`
- `playwriter/bin.js`
- `playwriter/src/cli.ts`
- `playwriter/src/mcp.ts`
- `playwriter/src/skill.md`
- `playwriter/src/resource.md`
- `playwriter/src/relay-client.ts`
- `playwriter/src/cdp-relay.ts`
- `playwriter/scripts/build-resources.ts`
- `skills/playwriter/SKILL.md`
- `README.md`
- 相关 git 历史

### 2.2 当前 `spawriter`

- `package.json`
- `README.md`
- `mcp/package.json`
- `mcp/bin.js`
- `mcp/src/cli.ts`
- `mcp/src/mcp.ts`
- `mcp/src/relay.ts`
- `mcp/src/pw-executor.ts`
- `mcp/src/cli.test.ts`
- `scripts/package-release.js`
- `release/spawriter-v1.0.0/skills/spawriter/SKILL.md`
- `release/spawriter-v1.0.0/cursor-rules/spawriter.mdc`
- 当前 repo git 历史中删除 `mcp/skills/spawriter/SKILL.md` 与 `mcp/cursor-rules/spawriter.mdc` 的提交

## 3. 结论摘要

### 3.1 上游真正采用的不是“CLI + MCP 并存”，而是“三层统一”

`playwriter` 的结构不是把 CLI 和 MCP 各写一份，而是：

- 同一个公开 package 暴露统一二进制 `playwriter`
- CLI 和 MCP 复用同一套持久运行时能力
- `skill.md` 是完整文档源，MCP prompt、公开 skill、网站资源都由它派生

### 3.2 `spawriter` 当前的最大缺口不是命令缺失，而是缺少“单一真相源 + 持久运行时适配层”

当前 `spawriter` 的几个问题是相互耦合的：

- CLI 只有 `serve` / `relay`，本质上是启动器，不是 agent 直接可用的 CLI
- 30 个 MCP tool 的 schema 与行为几乎都堆在 `mcp/src/mcp.ts` 里
- AI 指令正文被合并进 `README.md`，没有独立 skill 源文件
- 旧的 `mcp/skills/spawriter/SKILL.md` 与 `mcp/cursor-rules/spawriter.mdc` 已在 `5ece1ac` 删除
- `scripts/package-release.js` 仍然尝试打包这些已删除目录，说明分发链路已经与源码脱节

### 3.3 对 `spawriter` 的正确迁移方向

应该采用和 `playwriter` 同一策略，但按 `spawriter` 的工具形态做适配：

1. 恢复独立的 skill 源文件，但不要回到手工维护多个副本的旧方式。
2. 将当前 `mcp.ts` 中的工具注册、工具执行、会话状态逐步从 stdio 适配层中抽离。
3. 让 CLI 和 MCP 都使用同一个持久运行时入口。
4. 让 `spawriter skill` 成为完整文档出口，外部 `SKILL.md` 只做轻量跳转。
5. 让 README 从“内嵌全部 agent 规则”回到“安装、快速开始、命令入口、链接”的角色。

## 4. 上游 `playwriter` 的实现方式、方法、策略

### 4.1 代码组织方式

上游的关键不是文件多，而是职责切分清晰。

| 上游位置 | 作用 | 对应策略 |
|---|---|---|
| `playwriter/src/cli.ts` | 统一 CLI 入口 | 默认入口既能 `-e` 执行，也能启动 MCP，也能输出 `skill` |
| `playwriter/src/mcp.ts` | MCP 适配层 | 读取派生出的 `dist/prompt.md`，不是自己维护一份独立 prompt |
| `playwriter/src/executor.ts` | 状态化执行器 | CLI 与 MCP 共享核心执行模型 |
| `playwriter/src/relay-client.ts` | relay 客户端工具 | CLI / MCP 都通过它确保 relay 可用 |
| `playwriter/src/cdp-relay.ts` | 持久控制平面 | 提供 `/cli/*` HTTP 入口，CLI 通过这些入口使用持久状态 |
| `playwriter/src/skill.md` | 完整文档真相源 | CLI 直接打印；MCP prompt 由它裁剪生成 |
| `playwriter/scripts/build-resources.ts` | 文档派生构建 | 生成 `prompt.md`、站点 `SKILL.md`、`.well-known/skills` |
| `skills/playwriter/SKILL.md` | 轻量 skill stub | 不复制完整文档，只提示 agent 先运行 `playwriter skill` |

### 4.2 上游的演进顺序

从 git 历史看，上游不是一步到位，而是按下面顺序演进。

| 提交 | 含义 | 对 `spawriter` 的启发 |
|---|---|---|
| `67dd9aa` | 增加 `-e/--eval`，抽出 `executor.ts`、`relay-client.ts`，并新增 `/cli/execute`、`/cli/reset`、`/cli/sessions` | CLI 能成立的前提是先把运行时从 MCP 里抽出来 |
| `1af5aac` | 增加 `session new/list/reset` | CLI 一旦进入 agent 工作流，session 必须成为一等公民 |
| `58dc932` | skill 中加入 CLI 使用说明 | skill 不是泛文档，而是 agent 操作手册 |
| `b7edfb5` | 让 `SKILL.md` 成为真相源，并生成 `prompt.md` | 文档必须单源派生，不能手工双写 |
| `45cdc37` | 把 skill 源移到 package 内部，增加 `playwriter skill`，外部 skill 改为轻量 stub，并从 skill 中裁剪出 MCP prompt | `skill` 命令是整套设计的关键枢纽 |
| `2cb3a95` | README 中明确 CLI + skill 是推荐用法，MCP 退居第二入口 | 文档入口也必须跟着产品策略变 |
| `a718299` | 增加 `.well-known/skills` 发现端点 | 这是分发增强，不是第一阶段必需品 |

### 4.3 上游的几个关键策略

#### 策略 A：CLI 不直接复刻 MCP 行为，而是复用持久运行时

在 `playwriter` 中，CLI 不是调用 stdio MCP，而是通过 relay 的 `/cli/*` HTTP 接口访问同一个持久执行器。这样可以保证：

- 多次 CLI 调用之间共享 session 状态
- CLI 与 MCP 不会各自维护一套行为分支
- 重连、日志、执行器生命周期只有一份逻辑

#### 策略 B：完整文档源放在 package 内部

`playwriter/src/skill.md` 在已安装 package 中也存在，因此：

- `playwriter skill` 可以稳定输出完整文档
- CLI、MCP、构建脚本都能使用同一份源文档
- 文档不会依赖仓库根目录 layout

#### 策略 C：外部 skill 文件不是完整文档，而是导流器

`skills/playwriter/SKILL.md` 只做三件事：

- 提供 frontmatter 供 skill 发现
- 告诉 agent 先运行 `playwriter skill`
- 给出最小示例

这样避免 skill 副本和 CLI 文档长期漂移。

#### 策略 D：MCP prompt 来自 skill 的裁剪版本

`build-resources.ts` 会把 `skill.md` 中 `## CLI Usage` 这一大段裁掉，生成 `dist/prompt.md` 给 MCP 使用。也就是说：

- MCP prompt 与 CLI 文档共用同一知识源
- 但 MCP 不会看到只适用于 shell 的说明

#### 策略 E：上游的 `prompt.md` 方案要学方法，不能机械照搬

这一点对 `spawriter` 很重要。

`playwriter` 的 `dist/prompt.md` 能直接挂到 MCP 的核心原因，是它本质上只有一个主工具 `execute`，所以“一份全局 prompt 文本”可以直接成为该工具的使用说明。

`spawriter` 当前是 30 个独立 tool：

- 每个 tool 已经有独立 schema 与 description
- 当前 MCP SDK 用法里也没有 `playwriter execute` 那种天然的“单工具全局 prompt 槽位”

因此，上游这里真正值得复制的是“**从 skill 单源派生出非 CLI 文本**”的方法，而不是把 `dist/prompt.md` 这个文件名或接法原样照搬。

对 `spawriter` 更合理的做法是：

- 生成一份 `mcp/dist/agent-guide.md` 或同类文件，作为“去掉 CLI-only 内容后的 agent 指南”
- 这份文本可用于：
  - 生成 `cursor-rules/spawriter.mdc`
  - 作为未来 MCP `resource` 的内容
  - 作为 README 摘要的来源
- 只有在未来明确引入 MCP `resource` 或 prompt 模板机制时，才需要决定是否仍沿用 `prompt.md` 命名

#### 策略 F：README 只保留安装与入口，不再承载完整 agent 手册

上游 README 最重要的一步，是把“长规则正文”从 README 中移出去，转成：

- 安装步骤
- 快速开始
- CLI 用法
- Skill 安装方式
- MCP 单独配置页链接

这一步让 README、skill、prompt 的边界变清晰。

## 5. 当前 `spawriter` 的现状与差距

### 5.1 已有能力

`spawriter` 并不是没有基础，它已经具备以下条件：

- `mcp/package.json` 已经暴露 `bin: { "spawriter": "./bin.js" }`
- `mcp/src/cli.ts` 已经是一个可执行入口
- `mcp/src/mcp.ts` 中已经集中维护了完整 `tools` registry
- `mcp/src/relay.ts` 已经是长期驻留的 HTTP + WebSocket 服务器
- `mcp/src/pw-executor.ts` 已经存在 Playwright VM 执行器与 `ExecutorManager`

这意味着：`spawriter` 缺的不是“有没有命令行入口”，而是 **如何把已有能力重组为 CLI-first 产品面**。

### 5.2 当前关键问题

#### 问题 A：CLI 仍然只是启动器

当前 `mcp/src/cli.ts` 只支持：

- `spawriter relay`
- `spawriter serve`

它无法承担 agent 直接使用的 CLI 模式。

#### 问题 B：高状态工具逻辑集中在 `mcp.ts`

当前以下状态都在 `mcp/src/mcp.ts` 里维护：

- `activeAgentId`
- `consoleLogs`
- `networkEntries`
- snapshot diff baseline
- `refCache`
- debugger state
- intercept rules
- Playwright `ExecutorManager`
- agent session registry

这意味着如果直接做“每个 shell 命令拉起一个新 CLI 进程”，状态会立刻丢失。

#### 问题 C：文档已经重新集中到 README，但集中方式不对

`5ece1ac` 删除了：

- `mcp/skills/spawriter/SKILL.md`
- `mcp/cursor-rules/spawriter.mdc`

并把说明折叠进 `README.md`。这减少了文件数量，但副作用是：

- README 承载了过多 agent 规则正文
- 没有可打印的 `spawriter skill`
- 没有可分发的轻量 skill stub
- 没有可生成的非 CLI agent guide / MCP resource 文本

#### 问题 D：release 打包链路已经与源码脱节

`scripts/package-release.js` 仍然会复制：

- `mcp/skills/spawriter`
- `mcp/cursor-rules`

但当前源码里这些目录已经不存在。说明“分发产物”和“源码现状”已经发生漂移。

#### 问题 E：`spawriter` 有两套 session 语义

这是本项目与上游最大的差异之一。

- `session_id`：用于 tab lease / 多 agent 隔离
- `session_manager.sessionId`：用于 Playwright VM 执行器

上游 `playwriter` 的 CLI 只有一套 session 概念，因此 `playwriter session new` 非常自然。

而 `spawriter` 如果直接照搬，会把用户和 agent 都绕晕。

#### 问题 F：当前 `ExecutorManager` 的 session 策略不适合直接暴露为 CLI 产品语义

`mcp/src/pw-executor.ts` 当前的 `ExecutorManager` 默认最多保留 5 个 session，超出后会静默移除最老 session。

这在当前 MCP 内部实现里问题不算大，但如果未来 CLI 对外承诺：

- `spawriter session new`
- `spawriter session list`
- `spawriter session reset <id>`

那么“静默淘汰最老 session”会直接变成用户可见的不确定性。

因此，CLI 方案落地前必须明确：

1. 是继续保留上限但改成显式报错
2. 还是把 session 上限、淘汰策略、清理策略一起产品化

## 6. 设计原则

本次设计建议遵循以下原则。

1. **文档单源**：只允许一份完整 agent 文档真相源。
2. **运行时单源**：CLI 与 MCP 必须复用同一个持久运行时。
3. **对外统一**：CLI 层应隐藏 `session_id` 与 `session_manager` 的内部差异。
4. **保持兼容**：现有 MCP tool 名称、schema、`serve` 用法不破坏。
5. **先做基础设施，再做命令糖衣**：先抽运行时与文档管线，再扩 CLI 命令面。
6. **不要回退到多副本文档**：不能重新人工维护 README、skill、cursor rule 三份正文。
7. **CLI 安全默认值**：凡是新增 `/cli/*` 或 control API，都必须按上游方式加本地安全防护。

## 7. 目标架构

### 7.1 总体结构

建议把 `spawriter` 演进到下面的形态：

```text
CLI Agent --shell--> spawriter CLI ----HTTP----+
                                              |
MCP Agent --stdio--> spawriter MCP ---HTTP----+--> Spawriter Runtime/Control Plane --> Relay WS --> Extension --> Chrome
```

关键点：

- **MCP 不再直接持有全部运行时状态**
- **CLI 不直接跑一套独立工具逻辑**
- **持久状态统一由 control plane 持有**

### 7.2 建议的新职责边界

| 层 | 责任 | 建议放置位置 |
|---|---|---|
| CLI | 解析命令、格式化输出、调用 control API、打印 `skill` | `mcp/src/cli.ts` |
| MCP | stdio 适配、暴露 tool schema、转发到 control API | `mcp/src/mcp.ts` |
| Runtime / Control Plane | 统一会话、工具执行、缓存、日志、状态管理 | 新增 `mcp/src/runtime/*` |
| Relay | 继续负责 HTTP + WS、扩展连接、CDP 中继，可承载 control routes | `mcp/src/relay.ts` |
| 文档构建 | 从单一 skill 源派生 prompt / stub / rules | 新增 `mcp/scripts/build-doc-artifacts.ts` 或同类脚本 |

### 7.3 为什么 control plane 应该附着在持久服务上

推荐让 control plane 跑在长期存活的服务端，而不是 stdio MCP 进程里。优先建议复用现有 relay 进程承载 HTTP control routes，原因如下：

1. relay 已经是常驻进程，天然适合承载跨多次 CLI 调用的状态。
2. relay 已经有 HTTP 服务与 token/origin 相关机制，扩展成本最低。
3. 如果 CLI 每次都直接起一个新 `mcp.ts`，则以下状态都会丢失：
   - console/network buffers
   - snapshot diff baseline
   - ref cache
   - intercept rules
   - debugger state
   - Playwright executor session
4. 这正是上游选择 `/cli/*` + executor manager 的核心原因。

### 7.4 但不要把所有代码继续堆进 `relay.ts`

虽然 control plane 可以挂在 relay 进程上，但代码不应该继续内联在 `relay.ts` 单文件里。

建议拆出：

```text
mcp/src/runtime/
  tool-registry.ts
  tool-service.ts
  session-store.ts
  tool-context.ts
  control-routes.ts
  docs.ts
```

其中：

- `tool-registry.ts`：从当前 `mcp.ts` 抽出 `tools` 数组
- `tool-service.ts`：从当前 `switch(name)` 中抽出工具执行逻辑
- `session-store.ts`：统一 CLI session、tab lease session、Playwright executor session 的映射
- `control-routes.ts`：把 HTTP `/cli/*` 或 `/control/*` 路由单独放出

## 8. 建议的文档与 skill 管线

### 8.0 先说结论：最小版不复杂

如果完全按上游的“最小闭环”理解，文档体系其实不复杂。

去掉网站托管、`.well-known/skills`、额外 IDE 规则这些增强项后，上游真正的核心只有：

1. 一份手写源文档：`playwriter/src/skill.md`
2. 一个命令：`playwriter skill`，直接打印这份源文档
3. 一个轻量 skill stub：`skills/playwriter/SKILL.md`
4. 一个给运行时消费的裁剪文件：`dist/prompt.md`

也就是说，上游的最小模型其实就是：

```text
源文档 -> CLI 输出 -> 轻量 skill stub -> 运行时消费的裁剪文本
```

对 `spawriter` 来说，建议明确区分两档方案。

#### 最小版

- `mcp/src/skill.md`
- `spawriter skill`
- `skills/spawriter/SKILL.md`
- README 改成入口型说明

这四项就足够形成“单源文档 + CLI + skill”闭环。

#### 完整版

在最小版基础上，再增加：

- `cursor-rules/spawriter.mdc`
- `mcp/dist/agent-guide.md`
- 官网托管 `SKILL.md`
- `.well-known/skills`

因此，本设计文档后面提到的派生产物里，真正第一阶段必需的只有最小版那几项，其余都应视为增强项，而不是一开始必须铺开的复杂体系。

### 8.1 单一真相源

建议新增：

```text
mcp/src/skill.md
```

这份文件应成为：

- `spawriter skill` 的输出源
- 非 CLI agent guide / MCP resource 文本的上游源
- 外部 skill stub 的内容来源
- Cursor rule 的内容来源

### 8.2 派生产物

参考上游，建议生成以下文件。

```text
mcp/dist/agent-guide.md         # 去掉 CLI-only 段落后的非 CLI 指南
skills/spawriter/SKILL.md       # 轻量 stub，给 skill 安装器/仓库浏览使用
cursor-rules/spawriter.mdc      # 生成版 Cursor 规则
```

如果未来有官网，再追加：

```text
website/public/SKILL.md
website/public/.well-known/skills/index.json
website/public/.well-known/skills/spawriter/SKILL.md
```

这部分应定义为第二阶段或第三阶段可选增强，而不是第一阶段前置条件。

### 8.3 `skills/spawriter/SKILL.md` 应该是什么样

不建议把完整正文直接复制进去。更推荐上游做法：

- 保留 frontmatter：`name`、`description`
- 明确要求 agent 先运行 `spawriter skill`
- 给出最小使用样例
- 保持短小、稳定、不会和完整文档分叉

### 8.4 非 CLI guide 如何生成

建议借用上游“裁剪 CLI 段落”的思路，但不要机械照搬文件语义：

- 在 `skill.md` 中约定一个顶级章节，例如 `## CLI Usage`
- 构建时把这部分裁掉，生成 `mcp/dist/agent-guide.md`

这样可以保证：

- CLI 文档更完整
- 非 CLI agent 指南更聚焦
- 维护时只改一处

如果后续决定在 MCP 中增加 `resource` 或统一的 agent guide 暴露入口，再把 `agent-guide.md` 挂入 MCP；在那之前，不必为了和上游名字一致而强行制造一个当前无处消费的 `prompt.md`。

### 8.5 README 的定位要调整

建议把当前 README 中超长的 “AI Instructions Content” 移出正文，改成：

- 安装
- 快速开始
- CLI 示例
- `spawriter skill` 入口
- `skills/spawriter/SKILL.md` 或规则文件说明
- MCP 配置作为单独小节，明确“仍然支持，但不再承载全部 agent 手册”

这与上游的 README 定位一致。

## 9. 建议的 CLI 设计

### 9.1 先统一 CLI 语义，再扩命令面

不建议一上来就为 30 个 tool 各做一个手写命令。第一阶段更合理的 CLI 面应该是：

#### 基础命令

- `spawriter serve`
- `spawriter relay`
- `spawriter skill`
- `spawriter help`

#### 会话命令

- `spawriter session new`
- `spawriter session list`
- `spawriter session reset <id>`
- `spawriter session delete <id>`

#### 通用工具命令

- `spawriter tool <tool-name> --json '<payload>'`
- `spawriter tool <tool-name> --file payload.json`
- `spawriter tool <tool-name> --stdin`

#### 高频快捷命令

- `spawriter tab connect ...`
- `spawriter tab list ...`
- `spawriter tab switch ...`
- `spawriter tab release ...`
- `spawriter screenshot ...`
- `spawriter snapshot ...`
- `spawriter js -e '...'`
- `spawriter pw -e '...'`

### 9.2 为什么推荐保留 `tool <name>` 通用入口

因为 `spawriter` 的 MCP tool 很多，而且还会继续演进。通用入口有三个好处：

1. CLI 可以快速覆盖全部 tool，而不是等一堆手写命令补齐。
2. skill 文档可以稳定写成“当没有快捷命令时，用 `spawriter tool <name> --json ...`”。
3. tool schema 发生变化时，CLI 的覆盖面不会断裂。

同时，必须补一个跨 shell 约束：

- `--json` 只适合短 payload
- 对较长或包含引号/换行的参数，必须支持 `--file` 或 `--stdin`

否则在 PowerShell、bash、zsh、Claude Code shell、Codex shell 中都会频繁遇到转义问题，反而会削弱 CLI 模式的可用性。

### 9.3 会话模型必须做“外部统一、内部映射”

建议把 CLI 对外只暴露一个 `session` 概念。

CLI 的 `session` 应默认映射到：

- tab lease 使用的 `session_id`
- Playwright executor 的默认 `sessionId`
- console/network/debugger/intercept/refCache/snapshotBaseline 等状态的隔离 key

换句话说，CLI 应该对外提供的是：

```text
一个 session = 一个 agent 工作上下文
```

而不是把当前内部两套 session 机制原样暴露给用户。

### 9.4 推荐的 CLI 使用心智模型

建议让最终 CLI 呈现出类似上游的使用方式：

```bash
spawriter session new
spawriter tab connect -s sw-123 --url http://localhost:9000 --create
spawriter screenshot -s sw-123 --labels
spawriter pw -s sw-123 -e 'await page.getByRole("button", { name: "Save" }).click()'
```

这里的 `-s sw-123` 不必让用户知道背后分别命中了 `session_id` 与 `ExecutorManager`。

### 9.5 CLI 解析器选择

当前 `mcp/src/cli.ts` 的手工 `process.argv` 解析不适合继续扩展。

建议引入正式 CLI 解析库。首选可以直接参考上游当前使用的 `goke`，原因是：

- 上游已经验证过嵌套命令与帮助文案结构
- `session new` 这类带空格的命令面较自然
- 后续 `skill`、`tool`、`tab`、`session` 都更容易组织

`commander` 也可行，但如果目标是“最大程度沿用上游经验”，`goke` 更贴近。

## 10. 建议的运行时重构方向

### 10.1 当前不应直接扩 `mcp.ts` 的原因

如果继续把 CLI 能力直接塞进现在的 `mcp.ts`，会遇到这些结构性问题：

- 每新增一个 CLI 行为，就要在 `mcp.ts` 再复制一份分支
- 持久状态只能留在 stdio MCP 进程里，CLI 没法复用
- 工具描述、工具执行、CLI 输出、MCP 输出会继续耦合

因此建议优先抽出三层：

1. `tool registry`
2. `tool execution service`
3. `control routes / client`

### 10.2 推荐的重构切分

#### 第一步：抽 schema

把当前 `mcp.ts` 中的 `tools` 数组抽到 `tool-registry.ts`。

这样可以让：

- MCP `ListTools` 直接复用
- CLI `tool help <name>` 或 `tool list` 复用
- 文档生成脚本复用 tool 描述

#### 第二步：抽工具执行器

把 `switch (name)` 中的执行逻辑抽到 `tool-service.ts`。

建议函数签名类似：

```ts
executeTool({ name, args, sessionContext }): Promise<ToolResult>
```

#### 第三步：抽 session store

新增统一会话存储，至少负责：

- `cliSessionId -> agent/tab lease session`
- `cliSessionId -> playwright executor session`
- `cliSessionId -> preferred target`
- `cliSessionId -> console/network/debugger/intercept/ref state`

这里要特别注意当前实现中的“全局态”问题：

- `consoleLogs`
- `networkEntries`
- debugger state
- intercept rules
- snapshot baseline / ref cache

如果这些状态仍保持全局单例，就不能在产品层宣称“CLI session 完整隔离”。

因此推荐策略是：

1. 第一阶段文档中明确哪些状态仍是全局的
2. 第二阶段 control plane 落地时，把高频冲突状态改成 session-scoped
3. 只有在关键状态完成 session 化后，才把 CLI + skill 写成推荐主路径

#### 第四步：把 control API 挂到持久服务上

建议增加类似上游的路由：

- `POST /cli/tool`
- `GET /cli/tools`
- `POST /cli/session/new`
- `GET /cli/sessions`
- `POST /cli/session/reset`
- `POST /cli/session/delete`

不建议简单把 30 个 tool 全部做成离散 HTTP 路由。对 `spawriter` 更合适的是：

- 用 `POST /cli/tool` 承接长尾工具
- 对高频场景再补单独 route 或 CLI alias

### 10.3 安全策略必须沿用上游 `/cli/*` 防护思路

一旦 relay 对本机开放了更强的 HTTP 控制能力，就必须加保护。建议直接照搬上游的策略：

1. 拒绝可疑的浏览器跨源请求：检查 `Sec-Fetch-Site`
2. 强制 `POST` 为 `application/json`
3. 如果绑定远程 host 或配置 token，则强制鉴权

这一点不能后补。

## 11. 针对 `spawriter` 的推荐文件布局

建议目标布局如下：

```text
spawriter/
  README.md
  skills/
    spawriter/
      SKILL.md                # 生成的轻量 stub
  cursor-rules/
    spawriter.mdc             # 生成的 Cursor 规则
  mcp/
    bin.js
    package.json
    src/
      cli.ts
      mcp.ts
      relay.ts
      skill.md                # 完整文档真相源
      runtime/
        tool-registry.ts
        tool-service.ts
        session-store.ts
        control-routes.ts
        control-client.ts
    dist/
      cli.js
      agent-guide.md          # 构建生成
    scripts/
      build-doc-artifacts.ts
```

### 11.1 为什么推荐 `mcp/src/skill.md`

这是和上游最一致的落点，因为：

- `spawriter skill` 可以在已安装 package 内工作
- 构建脚本容易读取
- skill 文档和 CLI 属于同一个可发布单元

### 11.2 为什么推荐把生成产物放回 repo 根

`skills/` 和 `cursor-rules/` 放在 repo 根，更适合作为：

- 分发产物
- release 包内容
- 用户浏览仓库时能直接找到的入口

这也更接近上游的 `skills/playwriter/SKILL.md` 布局。

### 11.3 package 名称与二进制名称需要提前定下来

当前 `mcp/package.json` 的状态是：

- package name: `spawriter-mcp`
- bin name: `spawriter`

上游 `playwriter` 的公开体验更顺滑，是因为“包名 = 命令名 = 文档中的产品名”。

对 `spawriter` 来说，CLI + skill 真正对外发布前，需要明确其中一种策略：

1. **首选**：公开 package 名也统一为 `spawriter`
2. **备选**：保留 `spawriter-mcp` 作为 package 名，但所有文档都明确区分“安装 spec”与“执行命令”

如果这件事不提前定，后续 skill 文档中的安装命令、README 的 quick start、release 包中的说明都会反复出现两套名字。

## 12. 迁移阶段建议

### Phase 1：恢复单源文档体系

目标：先解决文档真相源与分发漂移。

建议再拆成两个层级。

#### Phase 1A：最小闭环

1. 新建 `mcp/src/skill.md`
2. 增加 `spawriter skill`
3. 生成 `skills/spawriter/SKILL.md`
4. 更新 `README.md`，从“内嵌全部 agent 手册”转为“入口型 README”

#### Phase 1B：增强文档产物

1. 新建 `mcp/src/skill.md`
2. 新建文档构建脚本，生成：
   - `mcp/dist/agent-guide.md`
   - `skills/spawriter/SKILL.md`
   - `cursor-rules/spawriter.mdc`
3. 增加 `spawriter skill`
4. 更新 `README.md`，从“内嵌全部 agent 手册”转为“入口型 README”
5. 修正 `scripts/package-release.js`，只打包生成产物，不再引用已删除目录

如果你想先走最简版，做到 Phase 1A 就足够；如果你希望同时把旧的 Cursor/rule 分发也恢复到自动生成，再做 Phase 1B。

### Phase 2：抽 control plane，打通 CLI 直接调用

目标：让 CLI 与 MCP 共用一套持久运行时。

包含内容：

1. 从 `mcp.ts` 抽出 `tool-registry`
2. 从 `mcp.ts` 抽出 `tool-service`
3. 增加 session store
4. 在 relay 或持久服务中增加 `/cli/*` control API
5. 重新定义 `ExecutorManager` 的上限与淘汰策略，使其符合 CLI session 语义
6. 让 MCP 从“直接执行工具”变成“调用 control API 的 stdio 适配层”

这是本设计里最重要的一阶段。

### Phase 3：扩 CLI 命令面

目标：让 agent 真正能走 `cli + skill` 工作流。

建议优先级：

1. `skill`
2. `session new/list/reset/delete`
3. `tool <name> --json ...`
4. `tab connect/list/switch/release`
5. `screenshot` / `snapshot`
6. `js -e` / `pw -e`

### Phase 4：分发增强

可选增强：

- `.well-known/skills`
- 官网托管 `SKILL.md`
- `spawriter doctor`
- `spawriter logfile`

这些都不是第一阶段必需。

## 13. 需要明确规避的错误路径

### 错误路径 A：直接恢复旧的 `mcp/skills` 与 `mcp/cursor-rules`

这会回到 2026-04-09 之前的手工双写状态，问题只是重新开始积累。

### 错误路径 B：在现有 `mcp/src/cli.ts` 上继续堆命令 if/else

当前 CLI 只适合两个启动命令，不适合承载未来的 session / tool / skill 体系。

### 错误路径 C：让 CLI 直接 shell 调用 stdio MCP

这样做看起来快，但会马上失去持久状态，无法得到上游 `playwriter` 那种 session 连续性。

### 错误路径 D：继续让 README 承载全部 agent 规则正文

这会让 README、skill、cursor rule、release 文档之间再次分叉。

## 14. 验收标准

当 `spawriter` 完成这次设计对应的实现后，建议以以下标准验收。

### 14.1 文档与分发

1. 完整 agent 文档只有一份真相源。
2. `spawriter skill` 可以在安装包环境下输出完整文档。
3. `skills/spawriter/SKILL.md` 是轻量 stub，而不是完整副本。
4. 非 CLI agent guide / MCP resource 文本与 skill 文档来自同一源文件。
5. release 打包产物与源码目录完全一致，不再引用已删除路径。
6. `--json`、`--file`、`--stdin` 三种 payload 输入方式至少具备两种，保证跨 shell 可用性。

### 14.2 运行时一致性

1. 同一个 CLI session 跨多次命令仍能保留 tab 选择、Playwright 状态与诊断状态。
2. MCP 调用与 CLI 调用命中相同的工具执行逻辑。
3. 不再存在 “MCP 改了一个 tool 行为，但 CLI 没改” 这类双实现问题。
4. 文档中宣称“session 隔离”的状态项，在实现上都已真正 session-scoped，或已明确标注为全局态。

### 14.3 用户体验

1. README 首屏可以清晰看出推荐入口是 `CLI + skill`。
2. 直接 MCP 配置仍可用，但不再是唯一入口。
3. CLI 的 session 概念对用户是统一的，不要求理解内部两套 session 机制。

### 14.4 测试要求

1. CLI 测试应尽量覆盖真实命令面，而不是像当前 `mcp/src/cli.test.ts` 一样复制一份解析逻辑做镜像测试。
2. 至少需要覆盖：
   - `skill` 输出
   - `session new/list/reset/delete`
   - `tool <name>` 的 payload 解析
   - CLI 多次调用之间的状态连续性
   - 关键状态的 session 隔离

## 15. 最终建议

对 `spawriter` 来说，最值得直接复制的不是 `playwriter` 某一个文件，而是它的三条主线：

1. **运行时主线**：CLI 与 MCP 必须共用持久运行时，而不是各写一套。
2. **文档主线**：完整 skill 文档必须单源派生，`spawriter skill` 是文档出口。
3. **产品主线**：README 负责入口，skill 负责 agent 规则，MCP 只是兼容接口，不再独占产品中心。

如果按这个方向做，`spawriter` 会得到的是和上游同类型的“产品化 CLI + skill + MCP 三位一体架构”；如果只恢复旧文件或只扩 CLI 参数，则只会得到一个继续分叉的工具集合。

## 16. 测试用例设计

### 16.0 当前测试现状

`spawriter` 当前只有一个测试文件 `mcp/src/cli.test.ts`（234 行），使用 `node:test` + `assert/strict`。测试内容是**复制了一份 CLI 参数解析逻辑做镜像测试**，没有测试真实的 `cli.ts` 导出，也没有覆盖任何工具行为。

上游 `playwriter` 有 19 个测试文件，覆盖了 executor、relay state、session、snapshot、screen recording、chrome discovery、debugger、AX tree 等核心模块，使用 vitest。

### 16.1 测试策略

建议测试分为四个层次，与 Phase 1–4 迁移阶段对应：

| 层次 | 覆盖内容 | 对应 Phase | 优先级 |
|---|---|---|---|
| L1: 文档与 skill | skill 输出完整性、stub 一致性 | Phase 1A | 高 |
| L2: CLI 命令面 | 命令解析、routing、输出格式 | Phase 3 | 中 |
| L3: 运行时与 session | tool 执行、session 隔离、状态持久性 | Phase 2 | 高 |
| L4: 集成 | CLI ↔ relay ↔ Chrome 端到端 | Phase 3–4 | 中 |

### 16.2 L1: 文档与 skill 测试

```
describe('spawriter skill')
  ├─ should output complete skill.md content
  ├─ should include all required sections (Connection, Tool Catalog, etc.)
  └─ should not include empty or truncated output

describe('skills/spawriter/SKILL.md stub')
  ├─ should have valid frontmatter (name, description)
  ├─ should reference "spawriter skill" command
  ├─ should be less than 50 lines (lightweight, not a full copy)
  └─ should not contain content that diverges from skill.md

describe('document pipeline')
  ├─ agent-guide.md should NOT contain CLI Usage section
  ├─ agent-guide.md should contain all non-CLI sections from skill.md
  └─ cursor-rules/spawriter.mdc should be derivable from agent-guide.md
```

### 16.3 L2: CLI 命令面测试

当 CLI 迁移到 goke 后，测试应覆盖真实的命令解析，而不是复制一份解析逻辑。

```
describe('CLI command routing')
  ├─ spawriter serve → starts MCP server
  ├─ spawriter relay → starts relay server
  ├─ spawriter skill → prints skill.md to stdout
  ├─ spawriter help → prints help text
  ├─ spawriter session new → calls POST /cli/session/new
  ├─ spawriter session list → calls GET /cli/sessions
  ├─ spawriter session reset <id> → calls POST /cli/session/reset
  ├─ spawriter session delete <id> → calls POST /cli/session/delete
  ├─ spawriter tool <name> --json '<payload>' → calls POST /cli/tool
  ├─ spawriter tool <name> --file payload.json → reads file, calls POST /cli/tool
  ├─ spawriter unknown → exits with error
  └─ spawriter (no args) → exits with error or shows help

describe('CLI payload parsing')
  ├─ --json should parse valid JSON
  ├─ --json should reject invalid JSON with clear error
  ├─ --file should read file and parse JSON
  ├─ --file should reject missing file
  ├─ --stdin should read from stdin (pipe)
  └─ should reject conflicting --json and --file

describe('CLI output formatting')
  ├─ session list should format as aligned table
  ├─ tool result should print text content
  ├─ tool error should print to stderr with exit code 1
  └─ screenshot tool should handle base64 image output
```

### 16.4 L3: 运行时与 session 测试

这是最关键的测试层，验证 CLI 与 MCP 共享运行时的核心承诺。

```
describe('tool-registry')
  ├─ should export all registered tools with name, description, schema
  ├─ tool count should match MCP ListTools response
  └─ each tool schema should be valid JSON Schema

describe('tool-service')
  ├─ executeTool should dispatch to correct handler
  ├─ executeTool should reject unknown tool name
  ├─ executeTool should pass sessionContext correctly
  └─ executeTool result should have consistent shape

describe('session-store')
  ├─ session new should create unique session ID
  ├─ session list should return all active sessions
  ├─ session delete should remove session and all associated state
  ├─ session reset should clear browser connection but preserve session ID
  ├─ creating session beyond limit should return explicit error (not silent evict)
  └─ session should map to both tab lease and playwright executor

describe('session state isolation')
  ├─ console logs from session A should not appear in session B
  ├─ network entries from session A should not appear in session B
  ├─ snapshot diff baseline should be session-scoped
  ├─ ref cache should be session-scoped
  └─ intercept rules from session A should not affect session B

describe('cross-call state persistence')
  ├─ consecutive CLI tool calls within same session should share state
  │   (e.g., connect_tab then screenshot should work)
  ├─ playwright_execute state object should persist across calls
  └─ tab selection should persist across calls within same session

describe('MCP-CLI parity')
  ├─ MCP tool call and CLI tool call should produce identical results
  ├─ MCP and CLI should share the same session store
  └─ tool registered in MCP should also be callable via CLI
```

### 16.5 L4: 集成测试

端到端测试需要 Chrome + 扩展 + relay 完整环境。参考上游 `relay-session.test.ts` 的 `setupTestContext` 模式。

```
describe('E2E: CLI → relay → Chrome')
  ├─ session new → tab connect → screenshot should produce valid image
  ├─ session new → navigate → accessibility_snapshot should return AX tree
  ├─ session new → playwright_execute → page interaction should succeed
  ├─ session delete → subsequent tool calls should fail with clear error
  └─ relay restart → session recovery or clear error

describe('E2E: security')
  ├─ /cli/* routes should reject requests with Sec-Fetch-Site: cross-site
  ├─ /cli/* POST routes should require Content-Type: application/json
  └─ token-protected relay should reject unauthenticated CLI requests
```

### 16.6 `playwright_execute` 返回值安全测试

基于上游 v0.0.103 修复的安全问题，需要专项测试。

```
describe('playwright_execute return value safety')
  ├─ should NOT include process.env in serialized output
  ├─ should NOT leak _connection._platform internals
  ├─ Playwright Response object should be filtered or summarized
  ├─ Playwright Page object should be filtered or summarized
  ├─ console.log(response) should produce safe concise output
  └─ explicit property access (response.url()) should work normally
```

### 16.7 上游测试文件对标映射

上游 `playwriter` 共 19 个测试文件，按职责可归类如下。右侧列出 `spawriter` 应对应创建的测试。

| 上游测试文件 | 测试范围 | `spawriter` 对应测试 | 优先级 |
|---|---|---|---|
| `executor.unit.test.ts` | 代码包装、自动 return、ChannelOwner 检测 | `pw-executor.unit.test.ts`：代码执行、返回值安全 | Phase 2 高 |
| `relay-state.test.ts` | relay store 纯逻辑（17 个 describe，无需浏览器） | `runtime/session-store.test.ts`：session CRUD、状态映射 | Phase 2 高 |
| `relay-session.test.ts` | CDP session、debugger、editor、service worker（需浏览器） | `integration/session.test.ts`：debugger/editor 集成 | Phase 3 中 |
| `relay-core.test.ts` | 截图、console log、AX snapshot、download、HTML 提取 | `integration/core-tools.test.ts`：核心 MCP tool 行为 | Phase 3 高 |
| `relay-navigation.test.ts` | 页面导航、iframe、CDP 发现端点 | `integration/navigation.test.ts`：navigate、iframe 处理 | Phase 3 中 |
| `extension-connection.test.ts` | 扩展连接/断连/重连、多 tab、auto-reconnect | `integration/connection.test.ts`：relay ↔ 扩展稳定性 | Phase 3 中 |
| `aria-snapshot.test.ts` | 真实网站 AX 快照回归 | `integration/snapshot.test.ts`：AX snapshot 回归 | Phase 3 低 |
| `aria-snapshot.unit.test.ts` | AX 树过滤、ref 生成、interactive-only | `snapshot-filter.unit.test.ts`：snapshot 纯逻辑 | Phase 2 中 |
| `snapshot-tools.test.ts` | 截图标注、layout metrics、locator 提取 | `integration/screenshot.test.ts`：截图 + 标注 | Phase 3 中 |
| `channel-owner-inspect.test.ts` | **env 泄露防护**（`util.inspect` 安全） | `pw-executor.security.test.ts`：返回值安全 | Phase 2 高 |
| `diff-utils.test.ts` | 智能 diff 纯逻辑 | `utils/diff.test.ts`（如有类似功能） | Phase 2 低 |
| `chrome-discovery.test.ts` | DevToolsActivePort 解析 | 暂无对应（spawriter 依赖 relay） | — |
| `kitty-graphics.test.ts` | Kitty 图像协议编码 | 暂无对应（Phase 4 可选） | — |
| `locator-selector.test.ts` | Playwright locator → selector 字符串 | 暂无对应（spawriter 不做 locator 转换） | — |
| `on-mouse-action.test.ts` | 鼠标动作回调、ghost cursor | 暂无对应（spawriter 无 ghost cursor） | — |
| `popup-relocation.test.ts` | popup 重定向为 tab | 暂无对应 | — |
| `scoped-fs.test.ts` | 沙箱文件系统、session list | `runtime/session-store.test.ts` 可覆盖 listSessions | Phase 2 中 |
| `screen-recording.test.ts` | 录屏宽高比计算 | 暂无对应 | — |
| `htmlrewrite.test.ts` | HTML 重写 | 暂无对应 | — |

#### 上游测试模式总结

从上游测试结构中可以提取以下值得复制的模式：

**模式 1：纯逻辑测试与集成测试分离**
- `.unit.test.ts` 后缀表示无需浏览器的纯逻辑测试
- 无后缀的 `.test.ts` 是需要完整 relay + Chrome 的集成测试
- `spawriter` 应采用同样的命名规范

**模式 2：`setupTestContext` 统一测试环境**
- 上游 `test-utils.ts` 提供统一的 `setupTestContext({ port, tempDirPrefix, toggleExtension })`
- 自动启动 relay、Chrome、扩展
- `cleanupTestContext` 负责清理
- `spawriter` 应创建类似的测试工具

**模式 3：安全测试作为独立测试文件**
- `channel-owner-inspect.test.ts` 专门测试 env 泄露
- 不混在功能测试里
- `spawriter` 的安全测试也应独立

**模式 4：回归测试命名**
- 上游在 `it` 描述中引用 issue 编号（如 `issue #14`、`issue #40`、`issue #82`）
- 修复 bug 时同步添加回归测试

### 16.8 `spawriter` 建议的测试文件布局

```text
mcp/src/
  cli.test.ts                         # L2: CLI 命令面（替代当前的镜像测试）
  pw-executor.unit.test.ts            # L3: 代码执行纯逻辑
  pw-executor.security.test.ts        # L3: 返回值安全（env 泄露防护）
  skill.test.ts                       # L1: skill 输出 + stub 一致性
  runtime/
    session-store.test.ts             # L3: session CRUD、状态映射、隔离
    tool-registry.test.ts             # L3: tool 注册、schema 验证
    tool-service.test.ts              # L3: tool 执行分发
  integration/
    core-tools.test.ts                # L4: screenshot、console、network、AX
    connection.test.ts                 # L4: relay ↔ 扩展连接稳定性
    session.test.ts                    # L4: debugger、editor 集成
    navigation.test.ts                 # L4: 页面导航、iframe
  test-utils.ts                        # 测试基础设施
```

### 16.9 测试基础设施建议

1. **测试框架**：建议从 `node:test` 迁移到 `vitest`，与上游一致，更好的 TypeScript 支持、inline snapshot、并行执行
2. **测试工具类**：参考上游 `test-utils.ts`，创建 `mcp/src/test-utils.ts`，封装 `setupTestContext`、`cleanupTestContext`、`withTimeout`
3. **Mock relay**：L2/L3 测试不需要真实 Chrome，可以 mock relay 的 HTTP 响应
4. **CI 分层**：
   - `unit`：L1/L2/L3 纯逻辑测试，无需 Chrome，每次 PR 必跑
   - `integration`：L4 集成测试，需要 Chrome + 扩展，可设为定时或手动触发
5. **安全测试必须在 Phase 2 优先完成**：`pw-executor.security.test.ts` 应作为 Phase 2 的前置条件

## 17. 审计补遗：上游近期演进（v0.0.80 – v0.0.105）

本设计文档初稿基于上游较早版本的 git 历史。截至审计时（2026-04-14），上游已迭代至 v0.0.105，新增了若干与本设计直接相关的能力和策略变化。以下补充需纳入后续实施参考。

### 16.1 上游新增的关键能力

| 版本范围 | 能力 | 对 `spawriter` 的影响 |
|---|---|---|
| v0.0.98 | **Direct CDP 连接模式** (`--direct`)：不依赖扩展，直接通过 Chrome DevTools Protocol 连接浏览器 | `spawriter` 当前已通过 relay 实现类似能力，但如果未来支持 CLI，需要考虑是否也暴露 `--direct` 语义 |
| v0.0.98 | **`playwriter browser list`**：列出所有可调试的 Chrome 实例 | 对应 `spawriter` 的 `list_tabs`，但上游是 CLI 命令而非 MCP tool |
| v0.0.99 | **Kitty Graphics Protocol**：CLI 模式下自动将截图以 Kitty 转义序列输出给 agent | `spawriter` 的 CLI 如果要支持 `screenshot`，需要考虑类似的图像输出机制 |
| v0.0.101 | **Chrome 136+ 自动发现**：处理了 `/json/version` 返回 404 的新版 Chrome | relay 层面可能需要跟进 |
| v0.0.102 | **sandbox 暴露 `browser` 变量**：`browser.contexts()` 可访问所有打开的 Chrome profile | `spawriter` 的 `playwright_execute` 目前只暴露 `page`/`context`/`state` |
| v0.0.103 | **自动跳过 Playwright handle 返回值**：避免 `util.inspect` 泄露环境变量 | **安全相关**：`spawriter` 的 `playwright_execute` 应检查是否有同样的泄露风险 |
| v0.0.104 | **扩展最低版本检查**：CLI/MCP 检测过时扩展并警告 | `spawriter` 应在 Phase 2 考虑类似的版本兼容性检查 |
| v0.0.105 | **多浏览器扩展连接稳定性**：用持久化 per-install ID 替代 `chrome.identity` | `spawriter` 的 tab lease 系统已有 `session_id` 机制，但多浏览器场景可能需要参考 |

### 16.2 上游 skill.md 的规模与结构

上游 `playwriter/src/skill.md` 共 1059 行，结构如下：

- `## CLI Usage`（约 120 行）：session 管理、`--direct`、`-e` 使用方式
- `## Code execution model`：sandbox 模型、globals、timeout
- `## Working with pages`：page navigation、popup 处理
- `## Selectors`：选择器策略、反模式
- `## Screenshots and accessibility`：截图 + AX tree
- `## Recording`：屏幕录制
- `## Downloads`：文件下载处理
- `## Network interception`：拦截/mock
- `## Debugging`：debugger API
- `## Editor`：运行时 JS/CSS 编辑
- 其余：styles、fs 操作、common pitfalls 等

这个规模说明 `spawriter` 的 `mcp/src/skill.md` 预计也会是一个 **800-1200 行** 的文档。撰写时需要有计划地组织章节，而不是随写随加。

### 16.3 安全补充

上游 v0.0.103 修复了一个重要安全问题：`util.inspect` 在序列化 Playwright Response 对象时会遍历 `_connection._platform.env`，导致所有进程环境变量（包括 API key、token 等）泄露到 CLI 输出。

**`spawriter` 应立即检查 `playwright_execute` 工具是否存在相同风险**。当前 `pw-executor.ts` 的返回值序列化逻辑需要审计，确保不会把 Playwright 内部对象完整输出。

### 16.4 上游 goke 版本

设计文档推荐使用 `goke` 作为 CLI 解析器。上游当前使用 `goke@6.3.2`（配合 `zod@4.3.5` 做参数校验）。`spawriter` 引入时需确认：

1. Node.js 版本兼容性（goke 6.x 需要 Node 18+）
2. 是否需要同时引入 `zod` 做参数定义
3. `picocolors` 用于 CLI 彩色输出（上游已使用）

### 16.5 上游近期未被本文覆盖的模块

以下模块在上游已存在但本设计文档未提及，列出供后续参考：

| 上游模块 | 功能 | `spawriter` 是否已有对应 |
|---|---|---|
| `screen-recording.ts` | 屏幕录制 | 无 |
| `aria-snapshot.ts` | 增强的 AX 快照 | 有（内嵌在 mcp.ts） |
| `chrome-discovery.ts` | Chrome 实例自动发现 | 无（依赖 relay） |
| `browser-launch.ts` | 托管 Chrome 启动 | 无 |
| `browser-config.ts` | 浏览器配置解析 | 无 |
| `kill-port.ts` | 端口进程清理 | 无 |
| `kitty-graphics.ts` | Kitty 图像协议输出 | 无 |
| `relay-state.ts` | relay 状态管理（从 cdp-relay 拆出） | 无（状态在 mcp.ts 全局） |

其中 `relay-state.ts` 的拆分思路与本文 Section 7.4 建议的 `runtime/` 拆分方向一致，说明上游也在做类似的代码分层。

## 18. 需要拍板的决策清单

下面这些不是实现细节，而是会直接影响整体架构和对外体验的决策点。

| 决策项 | 可选方向 | 推荐方向 | 原因 |
|---|---|---|---|
| 公开 package 名称 | `spawriter` / `spawriter-mcp` | `spawriter` | 最接近上游的包名 = 命令名 = 产品名，skill 文档最清晰 |
| control plane 落点 | 挂到 relay / 新建 daemon / 继续放 mcp | 挂到 relay，但代码拆到 `runtime/*` | 现有 relay 已经常驻且有 HTTP 能力，成本最低 |
| CLI 是否做主入口 | CLI+skill 为主 / MCP 与 CLI 并列 | CLI+skill 为推荐主入口，MCP 保留兼容入口 | 这才真正复制了上游产品策略 |
| 衍生文档文件名 | `prompt.md` / `agent-guide.md` | `agent-guide.md` | `spawriter` 是多 tool 模型，`prompt.md` 容易让实现误走单工具思路 |
| CLI session 模型 | 暴露两套 session / 对外统一一套 session | 对外统一一套 `session` | 用户和 agent 不应理解 `session_id` 与 `session_manager` 的内部差异 |
| `ExecutorManager` 策略 | 继续静默淘汰 / 显式报错 / 可配置 | 显式报错或可配置，不要静默淘汰 | 一旦 session 成为 CLI 产品概念，静默淘汰不可接受 |
| CLI 命令面 | 30 个手写命令 / `tool <name>` 通用入口 / 混合 | 混合：`tool <name>` + 高频快捷命令 | 覆盖完整又不会在第一阶段爆炸 |
| CLI payload 输入 | 只支持 `--json` / 增加 `--file` / 增加 `--stdin` | 至少支持 `--json` + `--file`，最好加 `--stdin` | 跨 PowerShell/bash/agent shell 时转义问题很现实 |
| session 隔离落地时机 | 先文档后实现 / 先实现关键状态 session 化再推荐 CLI | 先文档单源，再把关键状态 session 化，再正式推荐 CLI | 否则会提前承诺一个实际不存在的隔离模型 |
| 分发范围 | 先本地 repo+release / 直接做 npm + `.well-known` | 先本地 repo+release，再做 npm / `.well-known` | 先把架构稳定，再做发现与托管 |
| `playwright_execute` 返回值安全 | 不处理 / 过滤 Playwright handle | 过滤 Playwright handle 返回值 | 上游 v0.0.103 修复了 `util.inspect` 泄露环境变量的安全问题，`spawriter` 应跟进 |

## 19. 文档变更记录

| 日期 | 变更内容 |
|---|---|
| 初稿 | Sections 1–15：基于上游早期 git 历史的完整设计方案 |
| 2026-04-14 审计 | 新增 Section 16 测试用例设计、Section 17 上游演进补遗。Section 18 决策清单新增 `playwright_execute` 返回值安全项。修正 Section 4.3 策略编号顺序（D→E→F） |
