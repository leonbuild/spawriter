# Spawriter CLI + Skill 实施文档

> 本文档基于 `MCP_CLI_SKILL_DESIGN.md` 设计方案，全面参考上游 `D:\dev\0-ref\playwriter`（v0.0.105），针对 `D:\dev\side\spawriter` 当前代码状态给出逐步实施指南。
>
> **原则：每个步骤都可以独立验证、独立提交。**

## 目录

1. [前置条件与环境](#1-前置条件与环境)
2. [Phase 1A: 最小文档闭环](#2-phase-1a-最小文档闭环)
3. [Phase 1B: 增强文档产物](#3-phase-1b-增强文档产物)
4. [Phase 2: 运行时抽离与 Control Plane](#4-phase-2-运行时抽离与-control-plane)
5. [Phase 3: CLI 统一为 `-e` 代码执行模式](#5-phase-3-cli-统一为--e-代码执行模式)
6. [Phase 4: 分发增强](#6-phase-4-分发增强)
7. [安全实施清单](#7-安全实施清单)
8. [测试实施计划](#8-测试实施计划)
9. [迁移检查清单](#9-迁移检查清单)
10. [审计发现与修正](#10-审计发现与修正)

---

## 1. 前置条件与环境

### 1.1 当前代码状态

| 文件 | 行数 | 角色 |
|---|---|---|
| `spawriter/src/mcp.ts` | 3496 | MCP server + 31 tool 定义（待精简为 4 tool） + 全部工具执行逻辑 + 全局状态 |
| `spawriter/src/relay.ts` | 1258 | HTTP+WS relay server + Tab Lease System |
| `spawriter/src/pw-executor.ts` | 363 | Playwright VM 执行器 + ExecutorManager |
| `spawriter/src/cli.ts` | 65 | 仅 `serve`/`relay` 两个启动命令 |
| `spawriter/src/utils.ts` | 65 | 版本、端口、环境变量工具 |
| `spawriter/src/protocol.ts` | — | 扩展通信协议类型 |
| `spawriter/src/cli.test.ts` | 234 | 镜像式参数解析测试 |

### 1.2 上游对标版本

上游 `playwriter` v0.0.105，关键文件：

| 上游文件 | 行数 | `spawriter` 对应 |
|---|---|---|
| `playwriter/src/cli.ts` | 933 | `spawriter/src/cli.ts`（需大幅扩展） |
| `playwriter/src/mcp.ts` | 372 | `spawriter/src/mcp.ts`（需瘦身） |
| `playwriter/src/executor.ts` | ~600 | `spawriter/src/pw-executor.ts` |
| `playwriter/src/cdp-relay.ts` | ~2000 | `spawriter/src/relay.ts` |
| `playwriter/src/relay-client.ts` | ~200 | 新增 |
| `playwriter/src/relay-state.ts` | ~500 | 新增（从 mcp.ts 抽出） |
| `playwriter/src/skill.md` | 1059 | 新增 |
| `playwriter/scripts/build-resources.ts` | 270 | 新增 |
| `skills/playwriter/SKILL.md` | 36 | 新增 |

### 1.3 需要安装的新依赖

```bash
# Phase 1A 无新依赖

# Phase 1B
# 无强制新依赖（构建脚本可用 node:fs 原生实现）

# Phase 2 - 运行时重构 + 测试
cd spawriter
npm install -D vitest

# Phase 3 - CLI 扩展（可部分在 Phase 1A 启动）
npm install goke picocolors zod
```

---

## 1.4 前置步骤：目录与包名统一

在开始所有 Phase 之前，先将目录和包名统一为 `spawriter`（对齐上游 `playwriter/playwriter/` 模式）：

**Step 1: 重命名目录**

```bash
cd D:\dev\side\spawriter
git mv mcp spawriter
```

**Step 2: 更新 `spawriter/package.json`**

```json
{
  "name": "spawriter",  // 原 spawriter-mcp → spawriter
  "main": "dist/cli.js",
  "bin": {
    "spawriter": "./bin.js"
  }
}
```

**Step 3: 更新根 `package.json`**

```json
{
  "workspaces": [
    "ext",
    "spawriter"  // 原 "mcp" → "spawriter"
  ],
  "scripts": {
    "build:mcp": "npm run -w spawriter build",    // 原 -w spawriter-mcp
    "mcp:build": "npm run -w spawriter build",
    "mcp:serve": "npm run mcp:build && node spawriter/dist/cli.js serve",  // 原 mcp/dist/cli.js
    "mcp:relay": "npm run mcp:build && node spawriter/dist/cli.js relay",
    "mcp:link": "npm link -w spawriter",           // 新增：一键全局链接
    "test": "npx tsx --test spawriter/src/mcp.test.ts spawriter/src/pw-executor.test.ts spawriter/src/lease.test.ts spawriter/src/utils.test.ts spawriter/src/cli.test.ts spawriter/src/relay.test.ts"
  }
}
```

**Step 4: 更新 `spawriter/bin.js`**

```javascript
#!/usr/bin/env node
import './dist/cli.js';
```

（内容不变，但确认 import 路径是相对路径，目录重命名不影响。）

**Step 5: 验证**

```bash
cd D:\dev\side\spawriter
npm install                          # 重新解析 workspaces
npm run build:mcp                    # 构建
node spawriter/dist/cli.js --version # 验证 CLI 可执行
npm run mcp:link                     # 全局链接
spawriter --version                  # 验证全局命令
```

> **注意**：后续所有文档路径均使用重命名后的 `spawriter/` 目录。

---

## 2. Phase 1A: 最小文档闭环

> **目标**：建立单源文档 + `spawriter skill` 命令 + 轻量 SKILL.md stub
>
> **预计工作量**：0.5–1 天
>
> **不依赖**：任何运行时重构

### 步骤 2.1: 创建 `spawriter/src/skill.md`

从当前 `README.md` 中的 AI 指令内容提取，参考上游 `playwriter/src/skill.md` 的章节结构，撰写完整 agent 文档。

**预计章节结构**（800–1200 行）：

```markdown
## CLI Usage

（Phase 3 后填充。核心内容：`-e` 代码执行模式 + spawriter 扩展函数 API 参考。
Phase 1A 先留占位框架，Phase 3 完成后填充步骤 5.3 中定义的完整 API 参考。）

### Quick Start

spawriter session new
spawriter -s <id> -e '<playwright code + spawriter extensions>'

### Execution Environment

Built-in globals: page, context, state (same as playwriter)
Spawriter extensions: singleSpa(), tab(), consoleLogs(), networkLog(), ...

### Spawriter Extension Functions

（Phase 3 填充完整 API 参考，包括 Single-spa、Tab Lease、Inspect、Network 等分类）

## Connection Protocol

1. MCP 模式：spawriter 或 spawriter serve 启动 MCP，自动连接 relay
2. CLI 模式：spawriter -s <id> -e 通过 /cli/execute 端点执行
3. 重连策略：连接失败时调用 session reset
4. session_id 说明：每个 session 独立的 Playwright VM + 持久化 state

## MCP Tool Catalog

4 core MCP tools. CLI agent uses -e code execution, MCP agent uses structured tool calls.
Both share the same Playwright VM and spawriter extensions.

### execute
Execute Playwright JS code with spawriter extensions injected.
Globals: page, context, state, singleSpa(), tab(), consoleLogs(), networkLog(), ...
Use for: all Playwright operations + spawriter extensions.

### reset
Recreate CDP connection and reset page/context/state.

### single_spa
Manage single-spa micro-frontends.
Actions: status, override_set, override_remove, override_enable, override_disable,
         override_reset_all, mount, unmount, unload.

### tab
Manage browser tabs via Tab Lease System.
Actions: connect, list, switch, release.

## When to Proactively Use the Browser

（迁移 README 中的使用场景表格）

## Verification-After-Changes Protocol

（迁移 README 中的验证协议）

## Safety Rules

（迁移 README 中的安全规则）

## Troubleshooting

（迁移 README 中的故障排除表格）

## Key Usage Notes

### execute Tool — Playwright + spawriter Extensions
### single_spa Tool — Single-spa Management
### tab Tool — Tab Lease System
### VM Global Functions Reference
### Network Mocking via execute
### Common Patterns and Best Practices

（迁移 README 中的使用说明，并按新 4-tool 架构重组）
```

**参考文件**：
- 上游 `playwriter/src/skill.md`：章节组织方式
- 当前 `spawriter/README.md`：AI 指令正文

**章节内容来源映射**：

| skill.md 章节 | 内容来源 | 备注 |
|---|---|---|
| CLI Usage | 新写 | Phase 1A 留占位框架，Phase 3 填充 `-e` 代码执行模式 + spawriter 扩展函数 API 参考（见步骤 5.3） |
| Connection Protocol | `README.md` "Connection Protocol" 段 | 直接迁移 |
| MCP Tool Catalog | `mcp.ts` 中 4 个 tool 的 zod schema + description | 与 MCP 注册保持一致 |
| When to Proactively Use the Browser | `README.md` 对应场景表格 | 直接迁移 |
| Verification-After-Changes Protocol | `README.md` 对应段落 | 直接迁移 |
| Safety Rules | `README.md` "Safety Rules" 段 | 直接迁移 |
| Troubleshooting | `README.md` "Troubleshooting" 表格 | 直接迁移 |
| execute Tool Usage | `README.md` "execute vs playwright_execute" 段 + 新写 | 合并为 `execute` tool 用法指南 |
| single_spa Tool Usage | `README.md` "Single-spa Specific Tools" 段 | 更新为 `single_spa` action API |
| tab Tool Usage | `README.md` "Multi-Tab" 段 | 更新为 `tab` action API |
| VM Global Functions | 步骤 5.3 spawriter 扩展函数 API 参考 | 新写 |
| Network Mocking | `README.md` 对应段落 | 更新为 `execute` + `networkIntercept` 用法 |

### 步骤 2.2: 给 CLI 添加 `skill` 命令

修改 `spawriter/src/cli.ts`，添加 `skill` 命令：

```typescript
// 在 switch (command) 之前添加
case "skill": {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const skillPath = path.join(__dirname, "..", "src", "skill.md");
  // 构建后路径可能不同，需要 fallback
  const fallbackPath = path.join(__dirname, "skill.md");
  const resolvedPath = fs.existsSync(skillPath) ? skillPath : fallbackPath;
  const content = fs.readFileSync(resolvedPath, "utf-8");
  console.log(content);
  process.exit(0);
}
```

**上游参考**：`playwriter/src/cli.ts` 第 924–928 行

```typescript
// 上游实现
cli.command('skill', 'Print the full playwriter usage instructions').action(() => {
  const skillPath = path.join(__dirname, '..', 'src', 'skill.md')
  const content = fs.readFileSync(skillPath, 'utf-8')
  console.log(content)
})
```

**注意**：`spawriter` 使用 TypeScript 编译到 `dist/`，所以路径解析需要兼顾 `src/` 和 `dist/` 两种情况。建议在 `package.json` 的 `files` 字段中确保 `src/skill.md` 包含在发布包内。

### 步骤 2.3: 更新 `spawriter/package.json`

确保 `skill.md` 被包含在发布包中：

```json
{
  "files": [
    "dist",
    "src/skill.md",
    "bin.js"
  ]
}
```

### 步骤 2.4: 创建 `skills/spawriter/SKILL.md`

在 repo 根目录创建轻量 stub：

```markdown
---
name: spawriter
description: AI-assisted browser automation & debugging for single-spa micro-frontend projects. Controls the user's real Chrome tab via CDP with 4 core MCP tools (execute, reset, single_spa, tab). Run `spawriter skill` to read the complete up to date skill.
---

## REQUIRED: Read Full Documentation First

**Before using spawriter, you MUST run this command:**

```bash
spawriter skill
```

This outputs the complete documentation including:

- Connection protocol and tab management
- 4 core MCP tools: `execute` (Playwright code + spawriter extensions), `reset`, `single_spa`, `tab`
- Spawriter extensions: Single-spa management, Tab Lease System, CDP enhanced tools
- Verification-after-changes protocol
- Safety rules and troubleshooting

**Do NOT skip this step.** The examples below will fail without understanding the connection protocol and tool interactions from the full docs.

## Minimal Example (after reading full docs)

```bash
# If using MCP (Cursor/Claude):
# Tools are available directly via MCP protocol

# If using CLI:
spawriter skill   # Read full docs first
```

If `spawriter` is not found, check your MCP configuration or install the package.
```

**上游参考**：`skills/playwriter/SKILL.md`（36 行轻量 stub）

### 步骤 2.5: 瘦身 README.md

将 README 从"内嵌全部 agent 手册"改为"入口型 README"：

1. 保留：安装步骤、快速开始、MCP 配置示例
2. 移除：完整的 AI Instructions Content（已迁移到 `spawriter/src/skill.md`）
3. 新增：`spawriter skill` 命令说明
4. 新增：`skills/spawriter/SKILL.md` 链接

### 步骤 2.6: 验证

```bash
# 1. 验证 skill 输出
cd spawriter && npx tsx src/cli.ts skill | head -20

# 2. 验证 SKILL.md stub 存在
cat skills/spawriter/SKILL.md | head -10

# 3. 验证构建后 skill 仍可用
cd spawriter && npm run build
node dist/cli.js skill | head -20
```

---

## 3. Phase 1B: 增强文档产物

> **目标**：自动生成 agent-guide.md、cursor-rules、修正 release 打包
>
> **预计工作量**：0.5 天
>
> **依赖**：Phase 1A 完成

### 步骤 3.1: 创建文档构建脚本

新建 `spawriter/scripts/build-doc-artifacts.ts`：

```typescript
/**
 * 从 skill.md 单源生成文档派生产物。
 *
 * 生成：
 * - spawriter/dist/agent-guide.md — 去掉 CLI Usage 段落后的 agent 指南
 * - skills/spawriter/SKILL.md — 保持已有 stub 不变（不自动覆盖）
 * - cursor-rules/spawriter.mdc — 生成 Cursor 规则文件
 *
 * 参考上游：playwriter/scripts/build-resources.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(__dirname, '..')
const repoRoot = path.join(pkgDir, '..')

const skillPath = path.join(pkgDir, 'src', 'skill.md')
const skillContent = fs.readFileSync(skillPath, 'utf-8')

// --- 1. agent-guide.md: strip CLI Usage section ---

function stripCliSection(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let skip = false

  for (const line of lines) {
    if (/^## CLI Usage/.test(line)) {
      skip = true
      continue
    }
    if (skip && /^## /.test(line)) {
      skip = false
    }
    if (!skip) {
      result.push(line)
    }
  }

  return result.join('\n').trim() + '\n'
}

const distDir = path.join(pkgDir, 'dist')
fs.mkdirSync(distDir, { recursive: true })

const agentGuide = stripCliSection(skillContent)
fs.writeFileSync(path.join(distDir, 'agent-guide.md'), agentGuide, 'utf-8')
console.log('Generated spawriter/dist/agent-guide.md')

// --- 2. prompt.md: same as agent-guide, used as MCP execute tool description ---
// 上游 playwriter 的 mcp.ts 读取 dist/prompt.md 作为 execute tool description
fs.copyFileSync(path.join(distDir, 'agent-guide.md'), path.join(distDir, 'prompt.md'))
console.log('Generated spawriter/dist/prompt.md')

// --- 3. cursor-rules/spawriter.mdc ---

const cursorRulesDir = path.join(repoRoot, 'cursor-rules')
fs.mkdirSync(cursorRulesDir, { recursive: true })

const mdcContent = `---
description: spawriter - AI-assisted browser automation & debugging for single-spa micro-frontend projects. Use proactively to view, verify, and explore web pages whenever browser context would help.
globs: "**"
alwaysApply: false
---

${agentGuide}
`

fs.writeFileSync(path.join(cursorRulesDir, 'spawriter.mdc'), mdcContent, 'utf-8')
console.log('Generated cursor-rules/spawriter.mdc')

console.log('Document artifacts generated successfully')
```

**上游参考**：`playwriter/scripts/build-resources.ts`（使用 marked Lexer 做精确的 Markdown token 级裁剪）

> 本实现使用更简单的行级裁剪。如果后续需要更精确的处理（如裁剪 CLI Usage 的子章节），可升级为 marked Lexer 方式。

### 步骤 3.2: 在 `spawriter/package.json` 中添加构建步骤

```json
{
  "scripts": {
    "build": "node -e \"const fs=require('fs');if(fs.existsSync('dist'))fs.rmSync('dist',{recursive:true,force:true})\" && tsc && node -e \"require('fs').copyFileSync('src/skill.md','dist/skill.md')\"",
    "build:docs": "npx tsx scripts/build-doc-artifacts.ts",
    "build:all": "npm run build && npm run build:docs"
  }
}
```

> **注意**：`build` 脚本在 `tsc` 之后复制 `src/skill.md` 到 `dist/skill.md`，确保 `spawriter skill` 命令在构建后和发布包中都能找到文件。这是步骤 2.2 中路径 fallback 机制所依赖的。

### 步骤 3.3: 修正 `scripts/package-release.js`

当前第 148–155 行引用已删除的 `spawriter/skills/spawriter` 和 `spawriter/cursor-rules` 目录。修改为：

```javascript
// 替换原来的：
// copyDirIfExists(path.join(rootDir, "mcp", "skills", "spawriter"), ...)
// copyDirIfExists(path.join(rootDir, "mcp", "cursor-rules"), ...)

// 改为从 repo 根目录复制生成产物：
copyDirIfExists(
  path.join(rootDir, "skills", "spawriter"),
  path.join(releaseDir, "skills", "spawriter")
);
copyDirIfExists(
  path.join(rootDir, "cursor-rules"),
  path.join(releaseDir, "cursor-rules")
);
```

### 步骤 3.4: 验证

```bash
# 1. 生成文档产物
cd spawriter && npx tsx scripts/build-doc-artifacts.ts

# 2. 验证 agent-guide.md 不包含 CLI Usage
grep "## CLI Usage" dist/agent-guide.md  # 应无输出

# 3. 验证 prompt.md 存在且与 agent-guide.md 一致（用于 MCP execute tool description）
diff dist/agent-guide.md dist/prompt.md  # 应无差异

# 4. 验证 cursor-rules 存在
cat ../cursor-rules/spawriter.mdc | head -10

# 5. 验证 release 打包
cd .. && node scripts/package-release.js
ls release/spawriter-v1.0.0/skills/spawriter/SKILL.md
ls release/spawriter-v1.0.0/cursor-rules/spawriter.mdc
```

---

## 4. Phase 2: 运行时抽离与 Control Plane

> **目标**：从 `mcp.ts` 中抽出底层执行逻辑和会话状态，将 MCP 精简为 4 个 tool（`execute`/`reset`/`single_spa`/`tab`），挂到 relay 持久服务
>
> **预计工作量**：3–5 天
>
> **依赖**：Phase 1A 完成
>
> **这是整个迁移中最重要也最复杂的阶段。**

### 步骤 4.1: 创建 `spawriter/src/runtime/` 目录结构

```text
spawriter/src/runtime/
  tool-service.ts        # 底层工具执行分发（供 single_spa/tab MCP tool 和 VM 全局函数调用）
  session-store.ts       # 统一会话管理
  control-routes.ts      # HTTP /cli/* 路由
  control-client.ts      # CLI 侧 HTTP 客户端
  cli-globals.ts         # VM 全局函数注入（spawriter 扩展）
  ensure-relay.ts        # CLI 自动启动 relay
  kitty-graphics.ts      # Kitty Graphics Protocol
```

### 步骤 4.2: 抽出 tool-service.ts（精简版）

> **原则变更**：MCP 现在只有 4 个 tool（`execute`/`reset`/`single_spa`/`tab`），不再需要 31 tool 的大规模 registry 和分发。`tool-registry.ts` 不再需要（4 个 tool 的 schema 直接在 `mcp.ts` 中用 zod 定义即可，与上游一致）。

从 `mcp.ts` 中提取**底层执行逻辑**（原 31 个 tool 的实现函数），作为 `execute` tool 的 VM 全局函数和 `single_spa`/`tab` tool 的内部实现基础。

**目标接口**：

```typescript
// spawriter/src/runtime/tool-service.ts

export interface ToolContext {
  sessionId: string
  cdpSession: CdpSession
  preferredTargetId: string | null
  executorManager: ExecutorManager
  consoleLogs: ConsoleLogEntry[]
  interceptRules: Map<string, InterceptRule>
  refCacheByTab: Map<string, Map<number, RefInfo>>
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

/**
 * 底层工具执行函数。
 * 由 single_spa / tab MCP tool 和 VM 全局函数（injectSpawriterGlobals）共同调用。
 * 不直接暴露为 MCP tool —— MCP 层只有 4 个 tool。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult>
```

**实施要点**：
- 原 31 个 tool 的执行逻辑提取为内部函数，由 `executeTool` 分发
- `executeTool` 的调用者：
  1. `single_spa` MCP tool 的 action 分发
  2. `tab` MCP tool 的 action 分发
  3. `injectSpawriterGlobals` 中的 VM 全局函数
- `ToolContext` 包含当前 session 的所有必要状态引用
- **MCP 层不再有 `ListToolsRequestSchema` handler 的大 tools 数组**——直接用 `server.tool()` 注册 4 个 tool（对齐上游 `playwriter` 使用 MCP SDK 的方式）

### 步骤 4.3: 抽出 session-store.ts

统一管理 CLI session 与内部 session 的映射。

**目标接口**：

```typescript
// spawriter/src/runtime/session-store.ts

import type { CdpSession } from '../mcp.js'
import type { InterceptRule, ConsoleLogEntry, RefInfo } from '../mcp.js'

export interface SessionState {
  id: string
  cdpSession: CdpSession | null
  preferredTargetId: string | null
  activeAgentId: string | null
  consoleLogs: ConsoleLogEntry[]
  interceptRules: Map<string, InterceptRule>
  refCacheByTab: Map<string, Map<number, RefInfo>>
  executorSessionId: string
  createdAt: number
}

export class SessionStore {
  private sessions = new Map<string, SessionState>()
  private maxSessions: number

  constructor(maxSessions = 10) {
    this.maxSessions = maxSessions
  }

  createSession(): SessionState {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Session limit reached (${this.maxSessions}). Delete an existing session first.`)
    }
    const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const session: SessionState = {
      id,
      cdpSession: null,
      preferredTargetId: null,
      activeAgentId: null,
      consoleLogs: [],
      interceptRules: new Map(),
      refCacheByTab: new Map(),
      executorSessionId: id,
      createdAt: Date.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id)
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values())
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  resetSession(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.consoleLogs = []
    session.interceptRules.clear()
    session.refCacheByTab.clear()
    session.cdpSession = null
    session.preferredTargetId = null
    return true
  }
}
```

**实施要点**：
- 当前 `mcp.ts` 中的全局变量需要逐步迁移到 session-scoped 存储。经源码审计，需要迁移的全局状态包括：
  - `cdpSession`（第 30 行）— 全局单例 CDP 连接
  - `preferredTargetId`（第 32 行）— 全局 tab 选择
  - `activeAgentId`（第 189 行）— 当前活跃 agent
  - `consoleLogs`（第 217 行）— 全局 console 缓存
  - `interceptRules`（第 291 行）— 全局拦截规则
  - `refCacheByTab`（第 1048 行）— 按 tab 分组的 ref 缓存
  - `executorManager` — Playwright VM 管理器（已按 sessionId 隔离）
- 注意：网络日志通过 CDP 事件直接获取，无持久缓冲区变量；snapshot baseline 按需计算；debugger state 通过 CDP session 实时管理。这些不需要 session 化。
- 第一阶段可以只做一个默认 session（向后兼容）
- **超出上限时必须显式报错**（见上面 `createSession` 中的 `throw`），不静默淘汰

### 步骤 4.4: 创建 control-routes.ts

在 relay 中增加 HTTP 路由，供 CLI 调用。

```typescript
// spawriter/src/runtime/control-routes.ts

import type { Hono } from 'hono'
import type { SessionStore, SessionState } from './session-store.js'
import { executeTool, type ToolContext } from './tool-service.js'
import type { ExecutorManager } from '../pw-executor.js'

function buildToolContext(session: SessionState, executorManager: ExecutorManager): ToolContext {
  return {
    sessionId: session.id,
    cdpSession: session.cdpSession,
    preferredTargetId: session.preferredTargetId,
    executorManager,
    consoleLogs: session.consoleLogs,
    interceptRules: session.interceptRules,
    refCacheByTab: session.refCacheByTab,
  }
}

export function registerControlRoutes(
  app: Hono,
  sessionStore: SessionStore,
  executorManager: ExecutorManager
) {
  // 执行工具（底层分发，供 CLI 直接调用）
  app.post('/cli/tool', async (c) => {
    const { sessionId, name, args } = await c.req.json()
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)

    const context = buildToolContext(session, executorManager)
    const result = await executeTool(name, args, context)
    return c.json(result)
  })

  // Session CRUD
  app.post('/cli/session/new', (c) => {
    const session = sessionStore.createSession()
    return c.json({ id: session.id })
  })

  app.get('/cli/sessions', (c) => {
    const sessions = sessionStore.listSessions()
    return c.json({ sessions: sessions.map(s => ({
      id: s.id,
      createdAt: s.createdAt,
    })) })
  })

  app.post('/cli/session/delete', async (c) => {
    const { sessionId } = await c.req.json()
    const ok = sessionStore.deleteSession(sessionId)
    if (!ok) return c.json({ error: 'Session not found' }, 404)
    return c.json({ success: true })
  })

  app.post('/cli/session/reset', async (c) => {
    const { sessionId } = await c.req.json()
    const ok = sessionStore.resetSession(sessionId)
    if (!ok) return c.json({ error: 'Session not found' }, 404)
    return c.json({ success: true })
  })
}
```

**上游参考**：`playwriter/src/cdp-relay.ts` 中的 `/cli/execute`、`/cli/session/new`、`/cli/sessions`、`/cli/reset`、`/cli/session/delete` 路由。

### 步骤 4.5: 创建 control-client.ts

CLI 侧的 HTTP 客户端，用于调用 control API。

```typescript
// spawriter/src/runtime/control-client.ts

export class ControlClient {
  private token?: string

  constructor(private baseUrl: string, token?: string) {
    this.token = token
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    return headers
  }

  private async request<T = unknown>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...this.getHeaders(), ...options?.headers as Record<string, string> },
      })
    } catch (err) {
      throw new Error(`Cannot connect to relay at ${this.baseUrl}. Is the relay running? (spawriter relay)`)
    }
    const data = await res.json() as any
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status} from ${path}`)
    }
    return data as T
  }

  async listTools() {
    return this.request<{ tools: unknown[] }>('/cli/tools')
  }

  async executeCode(sessionId: string, code: string, opts?: { timeout?: number; cwd?: string }) {
    return this.request<{ text: string; images: Array<{ data: string; mimeType: string }>; isError: boolean }>(
      '/cli/execute',
      { method: 'POST', body: JSON.stringify({ sessionId, code, timeout: opts?.timeout || 10000, cwd: opts?.cwd }) },
    )
  }

  async executeTool(sessionId: string, name: string, args: Record<string, unknown>) {
    return this.request('/cli/tool', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name, args }),
    })
  }

  async createSession(opts?: { cwd?: string }) {
    return this.request<{ id: string }>('/cli/session/new', {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    })
  }

  async listSessions() {
    return this.request<{ sessions: Array<{ id: string; createdAt: number }> }>('/cli/sessions')
  }

  async deleteSession(sessionId: string) {
    return this.request('/cli/session/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
  }

  async resetSession(sessionId: string) {
    return this.request<{ success: boolean; pageUrl?: string; pagesCount?: number }>('/cli/session/reset', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
  }
}
```

> **设计要点**：
> - `token` 参数与步骤 4.8 安全防护中间件配合：CLI 从 `SSPA_MCP_TOKEN` 环境变量读取 token 传入 `ControlClient`
> - `request()` 统一处理连接失败和 HTTP 错误，CLI 层只需 catch 并打印
> - 泛型返回类型提供 TypeScript 类型安全

### 步骤 4.6: 修改 `ExecutorManager` 淘汰策略

当前 `pw-executor.ts` 第 321–325 行的 `getOrCreate` 会静默淘汰最老 session：

```typescript
// 当前代码（需要修改）
if (this.executors.size >= this.maxSessions) {
  const oldest = this.executors.keys().next().value as string;
  const oldExecutor = this.executors.get(oldest)!;
  oldExecutor.reset().catch(() => {});
  this.executors.delete(oldest);
}
```

修改为显式报错：

```typescript
getOrCreate(sessionId: string): PlaywrightExecutor {
  let executor = this.executors.get(sessionId);
  if (!executor) {
    if (this.executors.size >= this.maxSessions) {
      throw new Error(
        `Playwright executor limit reached (${this.maxSessions}). ` +
        `Active sessions: ${Array.from(this.executors.keys()).join(', ')}. ` +
        `Delete an existing session first.`
      );
    }
    executor = new PlaywrightExecutor();
    this.executors.set(sessionId, executor);
  }
  return executor;
}
```

### 步骤 4.7: 在 relay.ts 中注册 control routes

```typescript
// 在 relay.ts 中添加
import { registerControlRoutes } from './runtime/control-routes.js'
import { SessionStore } from './runtime/session-store.js'
import { ExecutorManager } from './pw-executor.js'

const sessionStore = new SessionStore()
const executorManager = new ExecutorManager()
registerControlRoutes(app, sessionStore, executorManager)
```

### 步骤 4.8: 安全防护

在 control routes 注册之前，添加安全中间件：

```typescript
// 安全中间件：保护 /cli/* 路由
app.use('/cli/*', async (c, next) => {
  // 1. 拒绝浏览器跨源请求
  const secFetchSite = c.req.header('sec-fetch-site')
  if (secFetchSite && secFetchSite !== 'none' && secFetchSite !== 'same-origin') {
    return c.json({ error: 'Cross-origin requests not allowed' }, 403)
  }

  // 2. POST 请求必须是 application/json
  if (c.req.method === 'POST') {
    const contentType = c.req.header('content-type')
    if (!contentType?.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 400)
    }
  }

  // 3. token 鉴权（如果配置了 token）
  const token = getRelayToken()
  if (token) {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  await next()
})
```

**上游参考**：`playwriter/src/cdp-relay.ts` 中的 `Sec-Fetch-Site` 检查和 token 验证。

### 步骤 4.9: 让 MCP 调用 control API

Phase 2 完成后，`mcp.ts` 应从"3496 行巨型文件"变为"4 个 tool 的精简注册层"：

```typescript
// mcp.ts 精简后 — 对齐上游 playwriter 的风格
// 使用 MCP SDK 的 server.tool() 直接注册 4 个 tool
server.tool('execute', promptContent, { code: z.string(), timeout: z.number().default(10000) }, ...)
server.tool('reset', 'Recreates CDP connection...', {}, ...)
server.tool('single_spa', '...', { action: z.enum([...]), ... }, ...)
server.tool('tab', '...', { action: z.enum([...]), ... }, ...)
```

> **注意**：Phase 2 的过渡阶段，`single_spa` 和 `tab` tool 内部调用 `executeTool()`（同进程），后者分发到原 31 个 tool 的底层实现函数。`execute` tool 则直接执行 Playwright 代码 + spawriter VM 全局函数。

### 步骤 4.10: MCP 侧向 playwriter 靠拢 — `execute` + `reset` + spawriter 扩展

> **架构决策**：MCP 侧也向上游 `playwriter` 靠拢——减少专用 tool 数量，以 `execute`（通用代码执行）+ `reset` 为核心，对 Playwright 原生 API 信任模型能力。spawriter 特有工具保留为独立 MCP tool 并在 prompt 中详细讲解。

#### 4.10.1 上游 MCP 架构回顾

上游 `playwriter` MCP 只有 **2 个 tool**：
- `execute`：执行 Playwright JS 代码，全局 scope 有 `page`/`context`/`state`。tool description 是一个巨大的 prompt（`prompt.md`，从 `skill.md` 去掉 CLI Usage 生成），教 agent 如何写 Playwright 代码
- `reset`：重建 CDP 连接

关键设计：**工具描述即指南**。上游把 `skill.md` 的全部 Playwright 使用指南（最佳实践、常见错误、snapshot 用法、selector 策略等）都注入到 `execute` tool 的 description 中，agent 读到 tool 描述就知道怎么用。

#### 4.10.2 spawriter MCP tool 分类决策

将当前 31 个 MCP tool 分为三类：

| 分类 | 处理方式 | 工具 |
|---|---|---|
| **合并到 `execute`** | Playwright 原生 API 可完成，移除独立 tool，在 prompt 中教 agent 写代码 | `navigate`, `page_content`, `interact`, `ensure_fresh_render`, `clear_cache_and_reload`, `trace`, `editor` |
| **合并为 `single_spa` tool** | Single-spa 独有能力，合并为 1 个 tool | `dashboard_state` + `override_app` + `app_action` → `single_spa` |
| **合并为 `tab` tool** | Tab Lease 独有能力，合并为 1 个 tool | `connect_tab` + `list_tabs` + `switch_tab` + `release_tab` → `tab` |
| **保留但降级为 prompt 指导** | CDP 封装操作，复杂但可通过代码实现，prompt 中给出示例代码 | `screenshot`\*, `accessibility_snapshot`\*, `console_logs`, `network_log`, `network_detail`, `css_inspect`, `network_intercept`, `debugger`, `browser_fetch`, `storage`, `emulation`, `performance` |

> \* `screenshot` 和 `accessibility_snapshot` 考虑到使用频率极高且在上游也有内建支持（`snapshot()` 和 `screenshotWithAccessibilityLabels()`），建议**注入为 VM 全局函数**而非保留为 MCP tool。

#### 4.10.3 新 MCP tool 结构

```typescript
// spawriter/src/mcp.ts — 重构后
import fs from 'node:fs'
import path from 'node:path'

const promptContent = fs.readFileSync(
  path.join(__dirname, '..', 'dist', 'prompt.md'), 'utf-8'
)

// 1. execute — 核心通用执行工具（对齐上游）
server.tool(
  'execute',
  promptContent, // 从 skill.md 生成的完整 prompt，包含 Playwright 指南 + spawriter 扩展 API
  {
    code: z.string().describe(
      'Playwright JS code. Globals: {page, context, state, ' +
      'singleSpa, tab, ' +
      'snapshot, screenshotWithLabels, consoleLogs, networkLog, ...}. ' +
      'Use ; for multiple statements. Prefer multiple execute calls over complex scripts.'
    ),
    timeout: z.number().default(10000).describe('Timeout in ms'),
  },
  async ({ code, timeout }) => {
    // 与上游 playwriter 相同的执行流程
    const exec = await getOrCreateExecutor()
    const session = sessionStore.getSession(sessionId)
    const toolCtx = buildToolContext(session, executorManager)
    injectSpawriterGlobals(exec, sessionId, toolCtx)
    const result = await exec.execute(code, timeout)
    // 返回 text + images
  }
)

// 2. reset — 重建连接（对齐上游）
server.tool(
  'reset',
  'Recreates CDP connection and resets page/context/state. Also clears spawriter extensions state.',
  {},
  async () => {
    const exec = await getOrCreateExecutor()
    const { page, context } = await exec.reset()
    return { content: [{ type: 'text', text: `Reset. ${context.pages().length} pages. Current: ${page.url()}` }] }
  }
)

// 3. single_spa — Single-spa 管理（合并 dashboard_state + override_app + app_action）
server.tool(
  'single_spa',
  dedent`
    Manage single-spa micro-frontend applications. This tool is spawriter-specific.

    Actions:
    - status: Get all app statuses + active import-map-overrides
    - override_set: Point an app to a local dev server URL
    - override_remove: Remove an override
    - override_enable / override_disable: Toggle an override without deleting
    - override_reset_all: Clear all overrides
    - mount / unmount / unload: Force lifecycle action on an app

    After setting an override, reload the page to see changes:
    \`await page.reload(); await snapshot({ page })\`
  `,
  {
    action: z.enum([
      'status',
      'override_set', 'override_remove', 'override_enable', 'override_disable', 'override_reset_all',
      'mount', 'unmount', 'unload',
    ]),
    appName: z.string().optional().describe('App name (e.g. @org/navbar)'),
    url: z.string().optional().describe('Override URL (for override_set)'),
  },
  async ({ action, appName, url }) => {
    switch (action) {
      case 'status': return executeTool('dashboard_state', {}, ctx)
      case 'override_set': return executeTool('override_app', { action: 'set', appName, url }, ctx)
      case 'override_remove': return executeTool('override_app', { action: 'remove', appName }, ctx)
      // ... 其余 action 类推
    }
  }
)

// 4. tab — Tab Lease System（合并 connect_tab + list_tabs + switch_tab + release_tab）
server.tool(
  'tab',
  dedent`
    Manage browser tabs via spawriter's Tab Lease System.
    Provides safe multi-agent tab sharing with explicit connect/release semantics.

    Actions:
    - connect: Connect to a tab by URL (create if not found with create=true)
    - list: List all available tabs
    - switch: Switch to a tab by ref number
    - release: Release the currently held tab
  `,
  {
    action: z.enum(['connect', 'list', 'switch', 'release']),
    url: z.string().optional().describe('Tab URL (for connect)'),
    create: z.boolean().optional().describe('Create new tab if not found (for connect)'),
    ref: z.number().optional().describe('Tab ref number (for switch)'),
    session_id: z.string().optional().describe('Session ID'),
  },
  async ({ action, url, create, ref, session_id }) => {
    switch (action) {
      case 'connect': return executeTool('connect_tab', { url, create, session_id }, ctx)
      case 'list': return executeTool('list_tabs', { session_id }, ctx)
      case 'switch': return executeTool('switch_tab', { ref, session_id }, ctx)
      case 'release': return executeTool('release_tab', { session_id }, ctx)
    }
  }
)
```

#### 4.10.4 VM 全局作用域注入（MCP + CLI 共享）

`execute` tool 和 CLI `-e` 共享相同的 `injectSpawriterGlobals()`（步骤 5.2.2），确保两个通道的代码执行环境完全一致。

MCP `execute` 中注入的全局函数表：

| 全局函数 | 来源 | 说明 |
|---|---|---|
| `page`, `context`, `state` | Playwright | 与上游完全一致 |
| `snapshot()` | spawriter | 等价于上游 `snapshot()`，返回 AX tree 文本 |
| `screenshotWithLabels()` | spawriter | 等价于上游 `screenshotWithAccessibilityLabels()`，返回带标签的截图 |
| `singleSpa(action, opts?)` | spawriter | 对齐 MCP `single_spa` tool（status/override_set/mount 等） |
| `tab(action, opts?)` | spawriter | 对齐 MCP `tab` tool（connect/list/switch/release） |
| `consoleLogs()` | spawriter | 控制台日志收集 |
| `networkLog()` | spawriter | 网络请求日志 |
| `networkIntercept` | spawriter | 网络拦截/mock |
| `debugger` | spawriter | 调试器控制 |
| `browserFetch()` | spawriter | 带 session 的 HTTP 请求 |
| `getCDPSession()` | spawriter | 获取 CDP session（对齐上游） |

#### 4.10.5 prompt.md 内容结构

从 `skill.md` 生成 `prompt.md`（注入到 `execute` tool description），内容需要覆盖：

1. **Playwright 最佳实践**（从上游 `skill.md` 移植）：
   - interaction feedback loop（observe → act → observe）
   - common mistakes to avoid（12 条）
   - accessibility snapshots 用法
   - selector best practices
   - working with pages / downloads / iframes
   - drag and drop 模式

2. **spawriter 扩展函数参考**（从步骤 5.3.3 提取）：
   - Single-spa 工具 API + 示例
   - Tab Lease 工具 API + 示例
   - CDP 增强封装用法 + 示例
   - 网络拦截用法 + 示例

3. **spawriter 特有注意事项**：
   - 使用 `snapshot()` 而非 `page.evaluate()` 获取 AX 信息（对齐上游最佳实践）
   - `getCDPSession()` 替代 `context.newCDPSession()`
   - Tab Lease 生命周期（connect → 操作 → release）
   - Override 设置后需要 `ensure_fresh_render` 或 reload

#### 4.10.6 迁移策略

从 31 tool → 4 tool 是**破坏性变更**。建议分步迁移：

**Step A（Phase 2 内完成）**：
1. 新增 `execute` tool（含完整 prompt + spawriter 全局函数注入）
2. 新增 `reset` tool
3. 新增 `single_spa` tool（合并 3 个 single-spa tool）
4. 新增 `tab` tool（合并 4 个 tab tool）
5. **暂时保留原 31 个 tool**，但在 tool description 中标注 `[DEPRECATED: Use execute/single_spa/tab instead]`
6. 在 prompt 中说明："所有操作通过 `execute` 写代码 + `single_spa`/`tab` 传参完成"

**Step B（观察期后，删除）**：
1. 确认 agent 完全迁移到 4 tool 模式
2. 移除全部原 31 个 deprecated tool
3. `mcp.ts` 降到 < 500 行

这样可以**渐进迁移**——已有的 MCP 配置暂时继续工作，但 prompt 引导 agent 使用新 API。

> **与路径 B CLI 的一致性**：CLI `-e` 和 MCP `execute` 共享完全相同的执行环境（`injectSpawriterGlobals`），agent 在两个通道写的代码可以互换。

### 步骤 4.11: `execute` 返回值安全修复（原 `playwright_execute`）

**必须在 Phase 2 完成**。参考上游 v0.0.103 修复。

在 `pw-executor.ts` 的 `PlaywrightExecutor.execute()` 方法中，添加返回值过滤：

```typescript
/**
 * 检测 Playwright ChannelOwner 对象。
 * 这些对象被 util.inspect 遍历时会泄露 _connection._platform.env
 * （即完整的 process.env），必须在序列化前拦截。
 * 参考上游 playwriter/src/executor.ts — issue #82。
 */
export function isPlaywrightChannelOwner(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any)._type === 'string' &&
    typeof (value as any)._guid === 'string'
  )
}
```

在 `pw-executor.ts` 的 `PlaywrightExecutor.execute()` 方法中，修改返回值序列化逻辑（当前第 199–206 行）：

```typescript
// 修改前（当前代码）：
if (hasExplicitReturn && result !== undefined) {
  const formatted = typeof result === 'string'
    ? result
    : util.inspect(result, { depth: 4, colors: false, ... });
  ...
}

// 修改后：
if (hasExplicitReturn && result !== undefined && !isPlaywrightChannelOwner(result)) {
  const formatted = typeof result === 'string'
    ? result
    : util.inspect(result, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 });
  if (formatted.trim()) {
    responseText += `[return value] ${formatted}\n`;
  }
}
```

**上游参考**：`playwriter/src/executor.ts` 第 1219 行的 `isPlaywrightChannelOwner` 检测和 `channel-owner-inspect.test.ts` 测试。使用 `_type`/`_guid` 内部属性检测比 `constructor.name` 更可靠（minified 代码不会破坏这些内部字段）。

---

## 5. Phase 3: CLI 统一为 `-e` 代码执行模式

> **架构决策**：采用**路径 B** —— CLI 和 MCP 都尽量少 tool，通用 `execute` 执行为核心，不同操作通过代码/参数区分。
>
> **核心理念**：
> - **Playwright 原生 API**：信任 agent 的编程能力，`page.goto()`、`page.screenshot()` 等直接使用，无需包装
> - **spawriter 自有工具**（single-spa、tab lease、inspect 等）：在 Playwright VM 全局作用域注入为可调用函数，并在 `skill.md`/`prompt.md` 中详细讲解
> - **MCP agent**：调用 4 个精简 tool（`execute`/`reset`/`single_spa`/`tab`），在 `execute` 中写代码完成大部分操作
> - **CLI agent / 人类用户**：用 `-e` 写代码（Playwright + spawriter 扩展函数），一个入口解决一切
> - **CLI 和 MCP API 一致**：`singleSpa(action, opts)` 和 `tab(action, opts)` 在两端使用方式完全相同
>
> **预计工作量**：3–5 天
>
> **依赖**：
> - `skill` / `serve` / `relay` / `logfile` — 无依赖，可在 Phase 1A 与 goke 迁移同步完成
> - `session new/list/delete/reset` — 依赖 Phase 2（需要 control API）
> - 默认命令 `-e` 执行 — 依赖 Phase 2（需要 relay 的 `/cli/execute` 端点）
>
> **建议**：goke 迁移可在 Phase 1A 启动，先迁移已有命令 + `skill`，Phase 2 完成后再补 session 和 `-e` 执行。

### 步骤 5.1: 引入 goke 重写 cli.ts — 默认命令 + `-e` 代码执行

**核心设计**：`spawriter` 的默认命令（无子命令时）同时充当 MCP 入口和 `-e` 代码执行入口，**完全对齐上游 `playwriter` 的用法**。

```bash
# 无 -e：启动 MCP server（用于 IDE/agent 的 MCP 连接）
spawriter
spawriter --host remote-server

# 有 -e：执行代码（Playwright API + spawriter 扩展函数）
spawriter -s sw-1 -e 'await page.goto("https://example.com")'
spawriter -s sw-1 -e 'await page.screenshot({ path: "shot.png" })'
spawriter -s sw-1 -e 'const s = await singleSpa("status"); return s.apps'
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/app", url: "http://localhost:8080/main.js" })'
```

```typescript
import { goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { fileURLToPath } from 'node:url'
import { VERSION, getRelayPort, getRelayToken } from './utils.js'
import { ensureRelayServer } from './runtime/ensure-relay.js'
import { canEmitKittyGraphics, emitKittyImage } from './runtime/kitty-graphics.js'

// Prevent Buffers from dumping hex bytes in util.inspect output
Buffer.prototype[util.inspect.custom] = function () {
  return `<Buffer ${this.length} bytes>`
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const cli = goke('spawriter')

// === 默认命令：MCP server 或 -e 代码执行 ===
cli
  .command('', 'Start the MCP server or execute code with -e')
  .option('--host <host>', 'Remote relay server host (or set SSPA_RELAY_HOST)')
  .option('--token <token>', 'Authentication token (or set SSPA_RELAY_TOKEN)')
  .option('-s, --session <name>', 'Session ID (required for -e)')
  .option('-e, --eval <code>', 'Execute code and exit (Playwright API + spawriter extensions)')
  .option('--timeout [ms]', z.number().default(10000).describe('Execution timeout'))
  .action(async (options) => {
    if (options.eval) {
      await executeCode({
        code: options.eval,
        timeout: options.timeout || 10000,
        sessionId: options.session,
        host: options.host,
        token: options.token,
      })
      return
    }

    // 无 -e：启动 MCP server
    const { startMcpServer } = await import('./mcp.js')
    await startMcpServer({ host: options.host, token: options.token })
  })

// === executeCode：核心代码执行函数 ===
async function executeCode(options: {
  code: string
  timeout: number
  sessionId?: string
  host?: string
  token?: string
}): Promise<void> {
  const { code, timeout, host, token } = options
  const cwd = process.cwd()
  const sessionId = options.sessionId || process.env.SSPA_SESSION

  if (!sessionId) {
    console.error('Error: -s/--session is required for -e.')
    console.error('Run `spawriter session new` first to get a session ID.')
    process.exit(1)
  }

  const serverHost = host || process.env.SSPA_RELAY_HOST || '127.0.0.1'
  const port = getRelayPort()
  const serverUrl = `http://${serverHost}:${port}`
  const authToken = token || process.env.SSPA_RELAY_TOKEN

  // 本地模式：确保 relay 运行
  if (!host && !process.env.SSPA_RELAY_HOST) {
    await ensureRelayServer()
  }

  try {
    const response = await fetch(`${serverUrl}/cli/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ sessionId, code, timeout, cwd }),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`Error: ${response.status} ${text}`)
      process.exit(1)
    }

    const result = (await response.json()) as {
      text: string
      images: Array<{ data: string; mimeType: string }>
      isError: boolean
    }

    if (result.text) {
      if (result.isError) {
        console.error(result.text)
      } else {
        console.log(result.text)
      }
    }

    // Kitty Graphics Protocol 输出
    if (canEmitKittyGraphics() && result.images?.length > 0) {
      for (const img of result.images) {
        if (img.data) emitKittyImage(img.data)
      }
    }

    if (result.isError) process.exit(1)
  } catch (error: any) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('Error: Cannot connect to relay server.')
      console.error('The relay server should start automatically. Check logs.')
    } else {
      console.error(`Error: ${error.message}`)
    }
    process.exit(1)
  }
}

// === skill ===
cli.command('skill', 'Print the full spawriter usage instructions').action(() => {
  const skillPath = path.join(__dirname, '..', 'src', 'skill.md')
  const fallback = path.join(__dirname, 'skill.md')
  const resolved = fs.existsSync(skillPath) ? skillPath : fallback
  console.log(fs.readFileSync(resolved, 'utf-8'))
})

// === serve（MCP server） ===
cli.command('serve', 'Start the MCP server (includes relay if not running)')
  .option('--port <port>', z.number().default(19989).describe('Port'))
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (options) => {
    process.env.SSPA_MCP_PORT = String(options.port)
    const { startMcpServer } = await import('./mcp.js')
    await startMcpServer({ host: options.host, token: options.token })
  })

// === relay ===
cli.command('relay', 'Start the CDP relay server')
  .option('--port <port>', z.number().default(19989).describe('Port'))
  .option('--host [host]', z.string().default('0.0.0.0').describe('Bind host'))
  .option('--token <token>', 'Auth token (required for public host)')
  .option('--replace', 'Kill existing server if running')
  .action(async (options) => {
    if (options.replace) {
      // 步骤 5.6: 检测端口占用并尝试终止已有进程
      const net = await import('node:net')
      const inUse = await new Promise<boolean>((resolve) => {
        const s = net.createServer()
        s.once('error', () => resolve(true))
        s.listen(options.port, () => { s.close(); resolve(false) })
      })
      if (inUse) {
        console.log(`Port ${options.port} in use, killing existing server...`)
        try { await fetch(`http://127.0.0.1:${options.port}/shutdown`, { method: 'POST' }) }
        catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 500))
      }
    }
    process.env.SSPA_MCP_PORT = String(options.port)
    const { startRelayServer } = await import('./relay.js')
    await startRelayServer()
  })

// === session commands ===
cli.command('session new', 'Create a new session and print the session ID')
  .option('--host <host>', 'Remote relay host')
  .action(async (options) => {
    if (!options.host && !process.env.SSPA_RELAY_HOST) {
      await ensureRelayServer()
    }
    const client = getControlClient(options)
    const result = await client.createSession({ cwd: process.cwd() })
    console.log(`Session ${result.id} created. Use with: spawriter -s ${result.id} -e "..."`)
  })

cli.command('session list', 'List all active sessions')
  .option('--host <host>', 'Remote relay host')
  .action(async (options) => {
    if (!options.host && !process.env.SSPA_RELAY_HOST) await ensureRelayServer()
    const client = getControlClient(options)
    const { sessions } = await client.listSessions()
    if (sessions.length === 0) {
      console.log('No active sessions. Run `spawriter session new` to create one.')
      return
    }
    // 格式化表格 — 详见步骤 5.5
    const header = 'ID                  | CREATED'
    const separator = '-'.repeat(header.length)
    console.log(header)
    console.log(separator)
    for (const s of sessions) {
      const created = new Date(s.createdAt).toLocaleString()
      console.log(`${s.id.padEnd(20)}| ${created}`)
    }
  })

cli.command('session delete <id>', 'Delete a session')
  .option('--host <host>', 'Remote relay host')
  .action(async (id, options) => {
    const client = getControlClient(options)
    await client.deleteSession(id)
    console.log(`Session ${id} deleted.`)
  })

cli.command('session reset <id>', 'Reset the browser connection for a session')
  .option('--host <host>', 'Remote relay host')
  .action(async (id, options) => {
    const client = getControlClient(options)
    const result = await client.resetSession(id)
    console.log(`Connection reset. ${result.pagesCount} page(s) available. Current: ${result.pageUrl}`)
  })

// === logfile ===
cli.command('logfile', 'Print log file paths').action(async () => {
  const os = await import('node:os')
  const logDir = path.join(os.tmpdir(), 'spawriter')
  console.log(`relay: ${path.join(logDir, 'relay.log')}`)
})

// === helper ===
import { ControlClient } from './runtime/control-client.js'

function getControlClient(options: { host?: string }) {
  const host = options.host || process.env.SSPA_RELAY_HOST || '127.0.0.1'
  const port = getRelayPort()
  const token = getRelayToken()
  return new ControlClient(`http://${host}:${port}`, token)
}

cli.help()
cli.version(VERSION)
cli.parse()
```

**关键对比 — 上游 vs spawriter CLI 用法**：

| 操作 | 上游 `playwriter` | `spawriter`（路径 B） |
|---|---|---|
| 创建 session | `playwriter session new` | `spawriter session new` |
| 执行代码 | `playwriter -s id -e '...'` | `spawriter -s id -e '...'` |
| 启动 MCP | `playwriter`（无 -e） | `spawriter`（无 -e）或 `spawriter serve` |
| Playwright API | `page.goto()` 等原生 API | **完全相同** |
| 自有扩展 | 无（只有 Playwright） | `singleSpa()`、`tab()`、`consoleLogs()` 等 |

### 步骤 5.2: relay 端新增 `/cli/execute` 端点 + VM 全局作用域注入

这是路径 B 的核心实现：relay 暴露 `/cli/execute` HTTP 端点，CLI 的 `-e` 代码通过此端点执行。执行环境是增强的 Playwright VM，全局作用域除了 `page`/`context`/`state` 外，还注入 spawriter 自有工具函数。

**与上游的关键差异**：上游 VM 里只有 Playwright 原生对象（`page`/`context`/`state`），所有操作都通过 Playwright API 完成。spawriter 除了这三个外，还注入了 single-spa、tab lease、inspect 等自有工具。

#### 5.2.1 relay 端 `/cli/*` 路由

在 `relay.ts` 中新增：

```typescript
// relay.ts — 新增 /cli/* 路由

import { PlaywrightExecutor, ExecutorManager, isPlaywrightChannelOwner } from './pw-executor.js'
import { buildToolContext } from './runtime/control-routes.js'
import { injectSpawriterGlobals } from './runtime/cli-globals.js'
import { SessionStore } from './runtime/session-store.js'

// 安全中间件：拒绝浏览器跨源请求
function privilegedRouteMiddleware(c: any, next: () => Promise<void>) {
  const secFetchSite = c.req.header('sec-fetch-site')
  if (secFetchSite && secFetchSite !== 'same-origin') {
    return c.text('Forbidden: cross-origin requests not allowed', 403)
  }

  const token = getRelayToken()
  if (token) {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${token}`) {
      return c.text('Unauthorized', 401)
    }
  }

  return next()
}

app.use('/cli/*', privilegedRouteMiddleware)

// 核心：代码执行
app.post('/cli/execute', async (c) => {
  try {
    const body = (await c.req.json()) as {
      sessionId: string
      code: string
      timeout?: number
      cwd?: string
    }

    const manager = await getExecutorManager()
    const executor = manager.getOrCreate(String(body.sessionId), {
      cwd: body.cwd || process.cwd(),
    })

    // 构建 toolContext 并注入 spawriter 扩展函数
    const session = sessionStore.getSession(body.sessionId)
    const toolCtx = session
      ? buildToolContext(session, manager)
      : { executeTool: async () => ({ content: [] }) }
    injectSpawriterGlobals(executor, body.sessionId, toolCtx)

    const result = await executor.execute(body.code, body.timeout || 10000)

    return c.json({
      text: result.text,
      images: result.images,
      isError: result.isError,
    })
  } catch (error: any) {
    return c.json({ text: error.message, images: [], isError: true }, 500)
  }
})

// Session 管理
app.post('/cli/session/new', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { cwd?: string }
  const manager = await getExecutorManager()
  const id = manager.createSession({ cwd: body.cwd })
  return c.json({ id })
})

app.get('/cli/sessions', async (c) => {
  const manager = await getExecutorManager()
  return c.json({ sessions: manager.listSessions() })
})

app.post('/cli/session/delete', async (c) => {
  const body = (await c.req.json()) as { sessionId: string }
  const manager = await getExecutorManager()
  manager.deleteSession(String(body.sessionId))
  return c.json({ success: true })
})

app.post('/cli/reset', async (c) => {
  const body = (await c.req.json()) as { sessionId: string; cwd?: string }
  const manager = await getExecutorManager()
  const executor = manager.getOrCreate(String(body.sessionId), {
    cwd: body.cwd || process.cwd(),
  })
  const { page, context } = await executor.reset()
  return c.json({
    success: true,
    pageUrl: page.url(),
    pagesCount: context.pages().length,
  })
})
```

#### 5.2.2 spawriter 扩展函数注入

这是路径 B 的关键——将 spawriter 自有工具注入到 Playwright VM 的全局作用域。**Playwright 原生 API（`page`/`context`/`state`）已由 `PlaywrightExecutor` 自动提供，无需额外处理。**

**注入原则**：只注入 Playwright 原生 API 无法直接完成的 spawriter 自有能力。以下工具 **不注入**（模型直接用 Playwright 原生代码即可）：

| MCP tool | CLI 中的等价 Playwright 代码 | 不注入原因 |
|---|---|---|
| `navigate` | `await page.goto(url)` | Playwright 原生 |
| `page_content` | `await page.content()` / `page.evaluate(...)` | Playwright 原生 |
| `interact` | `await page.click(selector)` 等 | Playwright 原生 |
| `ensure_fresh_render` | `await page.reload()` + `page.waitForLoadState()` | Playwright 原生组合 |
| `clear_cache_and_reload` | CDP 命令 + `page.reload()` | 可通过 Playwright 代码实现 |
| `editor` | CDP `Debugger.setScriptSource` | 高级用法，模型自行写 CDP 代码 |
| `trace` | `await context.tracing.start/stop()` | Playwright 原生 |

注入的 spawriter 自有工具分为以下类别：
1. **Single-spa 工具**（上游无，spawriter 独有）：`singleSpa(action, opts?)` — 对齐 MCP `single_spa` tool
2. **Tab Lease 工具**（上游无，spawriter 独有）：`tab(action, opts?)` — 对齐 MCP `tab` tool
3. **CDP 增强封装**（模型不易自行实现的复杂 CDP 操作）：`consoleLogs()`、`networkLog()`、`networkDetail()`、`cssInspect()`、`networkIntercept`、`debugger`
4. **增强截图**（spawriter 独有的标签叠加功能）：`labeledScreenshot()`（注意：普通截图直接用 `page.screenshot()`）
5. **AX 增强**（spawriter 格式化后的快照）：`accessibilitySnapshot()`
6. **浏览器上下文操作**：`browserFetch()`、`storage()`、`emulation()`、`performance()`

```typescript
// spawriter/src/runtime/cli-globals.ts

import type { PlaywrightExecutor } from '../pw-executor.js'

/**
 * 将 spawriter 自有工具注入到 executor 的全局作用域。
 * Playwright 原生 API (page, context, state) 已由 executor 自带。
 *
 * 设计原则：
 * - Playwright 原生操作（导航、点击、截图等）直接用 page.xxx()，不包装
 * - spawriter 自有功能（single-spa、tab lease 等）注入为全局函数/对象
 */
export function injectSpawriterGlobals(
  executor: PlaywrightExecutor,
  sessionId: string,
  toolContext: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> },
): void {

  executor.setGlobals({
    // === single_spa — 对齐 MCP single_spa tool 的 API 结构 ===
    /**
     * Single-spa 管理 — 与 MCP `single_spa` tool API 一致
     *
     * @example await singleSpa('status')
     * @example await singleSpa('override_set', { appName: '@org/navbar', url: 'http://localhost:8080/main.js' })
     * @example await singleSpa('override_remove', { appName: '@org/navbar' })
     * @example await singleSpa('override_enable', { appName: '@org/navbar' })
     * @example await singleSpa('override_disable', { appName: '@org/navbar' })
     * @example await singleSpa('override_reset_all')
     * @example await singleSpa('mount', { appName: '@org/settings' })
     * @example await singleSpa('unmount', { appName: '@org/settings' })
     * @example await singleSpa('unload', { appName: '@org/settings' })
     *
     * After setting an override, reload the page to see changes:
     *   await singleSpa('override_set', { appName: '@org/app', url: '...' })
     *   await page.reload()
     *   await snapshot({ page })
     */
    singleSpa: async (
      action: string,
      opts?: { appName?: string; url?: string },
    ) => {
      switch (action) {
        case 'status':
          return toolContext.executeTool('dashboard_state', {})
        case 'override_set':
          return toolContext.executeTool('override_app', { action: 'set', appName: opts?.appName, url: opts?.url })
        case 'override_remove':
          return toolContext.executeTool('override_app', { action: 'remove', appName: opts?.appName })
        case 'override_enable':
          return toolContext.executeTool('override_app', { action: 'enable', appName: opts?.appName })
        case 'override_disable':
          return toolContext.executeTool('override_app', { action: 'disable', appName: opts?.appName })
        case 'override_reset_all':
          return toolContext.executeTool('override_app', { action: 'reset_all' })
        case 'mount':
        case 'unmount':
        case 'unload':
          return toolContext.executeTool('app_action', { action, appName: opts?.appName })
        default:
          throw new Error(`Unknown single_spa action: ${action}`)
      }
    },

    // === tab — 对齐 MCP tab tool 的 API 结构 ===
    /**
     * Tab Lease System — 与 MCP `tab` tool API 一致
     *
     * @example await tab('connect', { url: 'http://localhost:9000', create: true })
     * @example const tabs = await tab('list')
     * @example await tab('switch', { ref: 2 })
     * @example await tab('release')
     */
    tab: async (
      action: string,
      opts?: { url?: string; create?: boolean; ref?: number },
    ) => {
      switch (action) {
        case 'connect':
          return toolContext.executeTool('connect_tab', { url: opts?.url, create: opts?.create, session_id: sessionId })
        case 'list':
          return toolContext.executeTool('list_tabs', { session_id: sessionId })
        case 'switch':
          return toolContext.executeTool('switch_tab', { ref: opts?.ref, session_id: sessionId })
        case 'release':
          return toolContext.executeTool('release_tab', { session_id: sessionId })
        default:
          throw new Error(`Unknown tab action: ${action}`)
      }
    },

    // === 增强 Inspect 工具 ===
    consoleLogs: async (opts?: { level?: string; clear?: boolean }) =>
      toolContext.executeTool('console_logs', opts || {}),

    networkLog: async (opts?: { status_filter?: string }) =>
      toolContext.executeTool('network_log', opts || {}),

    networkDetail: async (requestId: string) =>
      toolContext.executeTool('network_detail', { requestId }),

    cssInspect: async (selector: string) =>
      toolContext.executeTool('css_inspect', { selector }),

    /**
     * 带标签的截图 + accessibility snapshot（spawriter 增强版）
     * 普通截图直接用 page.screenshot()
     * @example const { snapshot, image } = await labeledScreenshot()
     */
    labeledScreenshot: async (opts?: { quality?: string }) =>
      toolContext.executeTool('screenshot', { labels: true, ...opts }),

    accessibilitySnapshot: async (opts?: { search?: string; interactive_only?: boolean }) =>
      toolContext.executeTool('accessibility_snapshot', opts || {}),

    // === 网络拦截 ===
    networkIntercept: {
      enable: async () => toolContext.executeTool('network_intercept', { action: 'enable' }),
      disable: async () => toolContext.executeTool('network_intercept', { action: 'disable' }),
      addRule: async (rule: { url_pattern: string; mock_status?: number; mock_body?: string; block?: boolean }) =>
        toolContext.executeTool('network_intercept', { action: 'add_rule', ...rule }),
      removeRule: async (ruleId: string) =>
        toolContext.executeTool('network_intercept', { action: 'remove_rule', ruleId }),
    },

    // === 调试器 ===
    debugger: {
      enable: async () => toolContext.executeTool('debugger', { action: 'enable' }),
      pause: async () => toolContext.executeTool('debugger', { action: 'pause' }),
      resume: async () => toolContext.executeTool('debugger', { action: 'resume' }),
      stepOver: async () => toolContext.executeTool('debugger', { action: 'step_over' }),
      setBreakpoint: async (url: string, line: number) =>
        toolContext.executeTool('debugger', { action: 'set_breakpoint', url, lineNumber: line }),
    },

    // === 其他 ===
    browserFetch: async (url: string, opts?: RequestInit) =>
      toolContext.executeTool('browser_fetch', { url, ...opts }),

    storage: async (action: string, opts?: Record<string, unknown>) =>
      toolContext.executeTool('storage', { action, ...opts }),

    emulation: async (opts: Record<string, unknown>) =>
      toolContext.executeTool('emulation', opts),

    performance: async (action?: string) =>
      toolContext.executeTool('performance', { action: action || 'metrics' }),
  })
}
```

#### 5.2.3 `PlaywrightExecutor.setGlobals()` 扩展

在 `pw-executor.ts` 中添加方法，允许外部注入全局变量到 VM：

```typescript
// pw-executor.ts 新增方法

class PlaywrightExecutor {
  private customGlobals: Record<string, unknown> = {}

  setGlobals(globals: Record<string, unknown>): void {
    this.customGlobals = { ...this.customGlobals, ...globals }
  }

  // 在 execute() 中，将 customGlobals 合并到 VM context
  async execute(code: string, timeout: number): Promise<ExecutionResult> {
    const context = {
      page: this.page,
      context: this.browserContext,
      state: this.state,
      console: this.sandboxConsole,
      ...this.customGlobals, // spawriter 扩展函数
    }
    // ... 执行代码 ...
  }
}
```

> **设计原则再强调**：`page.goto()`、`page.click()`、`page.screenshot()` 等 Playwright 原生操作，agent **直接用**，不包装。只有 spawriter 自有能力才注入为全局函数。这意味着 agent 在 `-e` 模式下写的代码和在上游 `playwriter -e` 写的代码**几乎完全兼容**（差异仅在于 spawriter 多了额外的全局函数可用）。

### 步骤 5.3: spawriter 扩展函数 API 参考（skill.md CLI Usage 核心内容）

在路径 B 架构下，CLI 不再需要大量快捷命令（`screenshot`/`snapshot`/`tab connect` 等），因为所有操作都通过 `-e` 完成。**agent 需要的是 API 文档，而不是命令列表。**

以下是注入到 `-e` 全局作用域的 spawriter 扩展函数的完整 API 参考。这些内容将写入 `skill.md` 的 `CLI Usage` 章节。

#### 5.3.1 执行环境概述

`spawriter -s <id> -e '<code>'` 的执行环境与上游 `playwriter -e` 完全兼容：

| 全局变量 | 来源 | 说明 |
|---|---|---|
| `page` | Playwright | 当前活动页面，`Page` 实例 |
| `context` | Playwright | 浏览器上下文，`BrowserContext` 实例 |
| `state` | Playwright | 跨调用持久化的 `{}` 对象 |
| `console` | sandbox | 沙箱 console，输出包含在结果的 `text` 中 |
| **以下为 spawriter 扩展** | | |
| `singleSpa(action, opts?)` | spawriter | Single-spa 管理（对齐 MCP `single_spa` tool） |
| `tab(action, opts?)` | spawriter | Tab Lease System（对齐 MCP `tab` tool） |
| `consoleLogs()` | spawriter | 控制台日志 |
| `networkLog()` | spawriter | 网络请求日志 |
| `networkDetail()` | spawriter | 请求详情 |
| `cssInspect()` | spawriter | CSS 检查 |
| `labeledScreenshot()` | spawriter | 带标签的截图 |
| `accessibilitySnapshot()` | spawriter | 无障碍快照 |
| `networkIntercept` | spawriter | 网络拦截/mock |
| `debugger` | spawriter | 调试器控制 |
| `browserFetch()` | spawriter | 用浏览器 cookie/session 发 HTTP 请求 |
| `storage()` | spawriter | Cookie/localStorage/sessionStorage 管理 |
| `emulation()` | spawriter | 设备/网络/时区模拟 |
| `performance()` | spawriter | 性能指标 |

#### 5.3.2 Playwright 原生操作（直接使用，不包装）

```bash
# 导航
spawriter -s sw-1 -e 'await page.goto("https://example.com")'

# 截图（保存到文件）
spawriter -s sw-1 -e 'await page.screenshot({ path: "shot.png" })'

# 点击
spawriter -s sw-1 -e 'await page.click("#submit-button")'

# 填写表单
spawriter -s sw-1 -e 'await page.fill("input[name=email]", "test@example.com")'

# 等待元素
spawriter -s sw-1 -e 'await page.waitForSelector(".loaded")'

# 获取页面标题
spawriter -s sw-1 -e 'return await page.title()'

# 执行页面内 JS
spawriter -s sw-1 -e 'return await page.evaluate(() => document.title)'

# 组合操作（一次 -e 内完成多步）
spawriter -s sw-1 -e 'await page.goto("https://example.com"); await page.click("#login"); await page.fill("#email", "test@test.com"); await page.screenshot({ path: "after-fill.png" })'

# 持久化状态
spawriter -s sw-1 -e 'state.startUrl = page.url(); return state.startUrl'
spawriter -s sw-1 -e 'return state.startUrl' # 跨调用保持
```

#### 5.3.3 spawriter 扩展函数详解

**`singleSpa()` — Single-spa 管理**（与 MCP `single_spa` tool API 一致）：

```bash
# 获取所有应用状态和 import-map-overrides
spawriter -s sw-1 -e 'return await singleSpa("status")'
# 返回：{ apps: [{ name, status, devtools }], overrides: { "@org/app": "http://..." } }

# 设置 import-map override（将应用指向本地开发服务器）
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/navbar", url: "http://localhost:8080/main.js" })'

# 设置 override 后查看效果
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/navbar", url: "http://localhost:8080/main.js" }); await page.reload(); await snapshot({ page })'

# 移除 override
spawriter -s sw-1 -e 'await singleSpa("override_remove", { appName: "@org/navbar" })'

# 启用/禁用 override（不删除，只是暂停）
spawriter -s sw-1 -e 'await singleSpa("override_disable", { appName: "@org/navbar" })'
spawriter -s sw-1 -e 'await singleSpa("override_enable", { appName: "@org/navbar" })'

# 清除所有 overrides
spawriter -s sw-1 -e 'await singleSpa("override_reset_all")'

# 强制 mount/unmount/unload 应用
spawriter -s sw-1 -e 'await singleSpa("mount", { appName: "@org/settings" })'
spawriter -s sw-1 -e 'await singleSpa("unmount", { appName: "@org/settings" })'
```

**`tab()` — Tab Lease System**（与 MCP `tab` tool API 一致）：

```bash
# 连接到指定 URL 的 tab（不存在则创建）
spawriter -s sw-1 -e 'await tab("connect", { url: "http://localhost:9000", create: true })'

# 列出可用 tabs
spawriter -s sw-1 -e 'return await tab("list")'

# 切换到指定 tab
spawriter -s sw-1 -e 'await tab("switch", { ref: 2 })'

# 释放当前 tab
spawriter -s sw-1 -e 'await tab("release")'
```

**增强 Inspect**（spawriter 对 CDP 的封装）：

```bash
# 控制台日志（error 级别）
spawriter -s sw-1 -e 'return await consoleLogs({ level: "error" })'

# 网络请求日志
spawriter -s sw-1 -e 'return await networkLog()'
spawriter -s sw-1 -e 'return await networkLog({ status_filter: "error" })'

# 请求详情
spawriter -s sw-1 -e 'return await networkDetail("req-123")'

# CSS 检查
spawriter -s sw-1 -e 'return await cssInspect(".header")'

# 带标签截图 + accessibility snapshot（spawriter 增强版截图）
spawriter -s sw-1 -e 'return await labeledScreenshot()'

# accessibility snapshot
spawriter -s sw-1 -e 'return await accessibilitySnapshot()'
spawriter -s sw-1 -e 'return await accessibilitySnapshot({ search: "login button" })'
```

**网络拦截（mock API）**：

```bash
# 启用拦截
spawriter -s sw-1 -e 'await networkIntercept.enable()'

# 添加 mock 规则
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/users", mock_status: 200, mock_body: JSON.stringify([{ id: 1, name: "Test" }]) })'

# 模拟网络错误
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/data", block: true })'

# 完成后禁用（重要！规则持续到显式禁用）
spawriter -s sw-1 -e 'await networkIntercept.disable()'
```

**调试器**：

```bash
spawriter -s sw-1 -e 'await debugger.enable()'
spawriter -s sw-1 -e 'await debugger.setBreakpoint("https://example.com/app.js", 42)'
spawriter -s sw-1 -e 'await debugger.resume()'
```

#### 5.3.4 不注入、模型直接用 Playwright 代码的操作

以下操作在 MCP 中有对应 tool，但在 CLI `-e` 中**不注入全局函数**，模型直接写 Playwright 代码即可：

```bash
# 导航（MCP tool: navigate）
spawriter -s sw-1 -e 'await page.goto("https://example.com")'

# 页面内容获取（MCP tool: page_content）
spawriter -s sw-1 -e 'return await page.content()'
spawriter -s sw-1 -e 'return await page.evaluate(() => document.querySelector("h1").textContent)'

# 元素交互（MCP tool: interact）
spawriter -s sw-1 -e 'await page.click("#submit")'
spawriter -s sw-1 -e 'await page.fill("input[name=q]", "search term")'
spawriter -s sw-1 -e 'await page.hover(".menu-item")'

# 刷新（MCP tool: ensure_fresh_render / clear_cache_and_reload）
spawriter -s sw-1 -e 'await page.reload(); await page.waitForLoadState("networkidle")'

# Tracing（MCP tool: trace）
spawriter -s sw-1 -e 'await context.tracing.start({ screenshots: true }); /* ... */ await context.tracing.stop({ path: "trace.zip" })'

# CSS 编辑（MCP tool: editor）— 高级用法
spawriter -s sw-1 -e 'const cdp = await page.context().newCDPSession(page); await cdp.send("CSS.enable"); /* ... */'
```

> **设计原则**：CLI 中只注入模型不可能自己写出来的能力（single-spa、tab lease 等）。Playwright 能做的事情，信任模型自己写代码。这与上游 `playwriter` 的哲学完全一致。

> **向后兼容**：`tool <name>` 子命令**不再是主入口**。保留作为向后兼容的备选方式（如果实施时认为有价值），但 `-e` 是推荐的主要方式。

### 步骤 5.4: `ensureRelayServer` — CLI 自动启动 relay

上游所有需要 relay 的 CLI 命令（session/tool/screenshot 等）在执行前都会调用 `ensureRelayServer()`，自动检查 relay 是否运行，未运行则自动启动。这是 CLI 可用性的关键——不要求用户先手动运行 `spawriter relay`。

```typescript
// spawriter/src/runtime/ensure-relay.ts

import { getRelayPort } from '../utils.js'

let relayProcess: ReturnType<typeof import('child_process').spawn> | null = null

export async function ensureRelayServer(options?: {
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void }
}): Promise<boolean> {
  const port = getRelayPort()
  const logger = options?.logger || console

  const isRunning = await checkRelayRunning(port)
  if (isRunning) return false

  logger.log(`Starting relay server on port ${port}...`)

  const { spawn } = await import('child_process')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  relayProcess = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'cli.js'), 'relay', '--port', String(port)],
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, SSPA_MCP_PORT: String(port) },
    }
  )
  relayProcess.unref()

  // 等待 relay 启动
  const startTime = Date.now()
  const timeout = 10000
  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200))
    if (await checkRelayRunning(port)) {
      logger.log(`Relay server started on port ${port}`)
      return true
    }
  }

  throw new Error(`Relay server failed to start within ${timeout}ms`)
}

async function checkRelayRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(1000),
    })
    return res.ok
  } catch {
    return false
  }
}
```

**上游参考**：`playwriter/src/relay-client.ts` 的 `ensureRelayServer()` 函数。

在 CLI 的 session/tool 命令中使用：

```typescript
// 在 session new/list/delete/reset 和 tool 命令的 action 开头添加：
await ensureRelayServer()
```

### 步骤 5.5: `session list` 格式化表格输出

上游的 `session list` 输出格式化的对齐表格，包含 ID、BROWSER、PROFILE 等列。`spawriter` 应提供类似的体验：

```typescript
cli.command('session list', 'List all active sessions')
  .action(async () => {
    await ensureRelayServer()
    const token = getRelayToken()
    const client = new ControlClient(`http://127.0.0.1:${getRelayPort()}`, token)
    const { sessions } = await client.listSessions()

    if (sessions.length === 0) {
      console.log('No active sessions')
      return
    }

    const idWidth = Math.max(2, ...sessions.map(s => s.id.length))
    const timeWidth = 19

    console.log('ID'.padEnd(idWidth) + '  ' + 'CREATED')
    console.log('-'.repeat(idWidth + timeWidth + 2))

    for (const session of sessions) {
      const time = new Date(session.createdAt).toISOString().slice(0, 19).replace('T', ' ')
      console.log(session.id.padEnd(idWidth) + '  ' + time)
    }
  })
```

### 步骤 5.6: `serve` 命令增强

对标上游 `playwriter serve`，增加端口检测和 `--replace`：

```typescript
cli.command('relay', 'Start the CDP relay server')
  .option('--port <port>', z.number().default(19989).describe('Port'))
  .option('--replace', 'Kill existing server if running')
  .action(async (options) => {
    const port = options.port

    // 检查端口是否已被占用
    const isRunning = await checkRelayRunning(port)
    if (isRunning) {
      if (!options.replace) {
        console.log(`Relay server is already running on port ${port}`)
        console.log('Tip: Use --replace to kill the existing server and start a new one.')
        process.exit(0)
      }
      console.log(`Killing existing server on port ${port}...`)
      // 需要实现端口进程查杀
    }

    process.env.SSPA_MCP_PORT = String(port)
    const { startRelayServer } = await import('./relay.js')
    await startRelayServer()
  })
```

### 步骤 5.7: `--host` 全局选项（远程 relay 连接）

上游的所有 session 命令都支持 `--host` 连接远程 relay。`spawriter` 应支持同样的模式：

```typescript
// 在 goke 全局选项或每个 session/tool 命令上添加
.option('--host <host>', 'Remote relay server host (or set SSPA_RELAY_HOST)')

// 在 ControlClient 构建时使用
function getControlClient(options: { host?: string }): ControlClient {
  const host = options.host || process.env.SSPA_RELAY_HOST || '127.0.0.1'
  const port = getRelayPort()
  const token = getRelayToken()
  return new ControlClient(`http://${host}:${port}`, token)
}
```

### 步骤 5.8: CLI 截图输出处理

CLI 返回截图需要特殊处理，因为 base64 图像数据不能直接打印到终端。上游 `playwriter` 采用两种机制：

1. **Kitty Graphics Protocol**：当 `AGENT_GRAPHICS=kitty` 时，通过 APC 转义序列输出图像，供 kitty-graphics-agent 等工具拦截并传递给 LLM
2. **保存到文件**：将截图保存为 PNG/WebP 文件，打印文件路径

`spawriter` 建议实现：

```typescript
import fs from 'node:fs'
import path from 'node:path'

function canEmitKittyGraphics(): boolean {
  return process.env.AGENT_GRAPHICS?.includes('kitty') ?? false
}

function emitKittyImage(base64: string): void {
  const CHUNK_SIZE = 4096
  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE))
  }

  if (chunks.length === 1) {
    process.stdout.write(`\x1b_Ga=T,f=100;${chunks[0]}\x1b\\`)
    return
  }

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0
    const isLast = i === chunks.length - 1
    const control = isFirst ? 'a=T,f=100,m=1' : isLast ? 'm=0' : 'm=1'
    process.stdout.write(`\x1b_G${control};${chunks[i]}\x1b\\`)
  }
}

function handleScreenshotOutput(result: any, savePath?: string): void {
  const imageContent = result.content?.find((c: any) => c.type === 'image')
  const textContent = result.content?.find((c: any) => c.type === 'text')

  if (textContent?.text) {
    console.log(textContent.text)
  }

  if (imageContent?.data) {
    if (canEmitKittyGraphics()) {
      emitKittyImage(imageContent.data)
    }

    if (savePath) {
      const buffer = Buffer.from(imageContent.data, 'base64')
      fs.writeFileSync(savePath, buffer)
      console.log(`Screenshot saved to: ${savePath}`)
    } else if (!canEmitKittyGraphics()) {
      // 既不是 Kitty 也不指定保存路径时，自动保存到临时文件
      const tmpPath = path.join(process.cwd(), `screenshot-${Date.now()}.webp`)
      const buffer = Buffer.from(imageContent.data, 'base64')
      fs.writeFileSync(tmpPath, buffer)
      console.log(`Screenshot saved to: ${tmpPath}`)
    }
  }
}
```

**上游参考**：`playwriter/src/cli.ts` 第 242–288 行处理 `result.screenshots` 和 `result.images`，以及 `playwriter/src/kitty-graphics.ts` 实现 Kitty Graphics Protocol。

**关键设计决策**：
- 当 `AGENT_GRAPHICS=kitty` 时，agent（如 Claude Code CLI）能直接通过 Kitty 转义序列获取图像
- 当不在 Kitty 环境时，截图自动保存为文件，返回文件路径
- `--save` 选项允许用户指定保存路径

---

## 6. Phase 4: 分发增强

> **预计工作量**：1 天（可选）

### 步骤 6.1: `spawriter logfile`

```typescript
cli.command('logfile', 'Print log file paths').action(() => {
  console.log(`relay: ${LOG_FILE_PATH}`)
})
```

### 步骤 6.2: `.well-known/skills`（可选）

如果未来有官网，在构建脚本中生成 `.well-known/skills/index.json`。参考上游 `build-resources.ts` 第 228–260 行。

### 步骤 6.3: package 名称统一

~~已完成：目录从 `mcp/` 重命名为 `spawriter/`，`package.json` 的 `name` 从 `spawriter-mcp` 改为 `spawriter`，使安装命令与执行命令一致。~~

---

## 7. 安全实施清单

| 项目 | Phase | 状态 | 说明 |
|---|---|---|---|
| `/cli/*` 路由 Sec-Fetch-Site 检查 | Phase 2 | 待实施 | 拒绝浏览器跨源请求 |
| POST 请求 Content-Type 验证 | Phase 2 | 待实施 | 强制 application/json |
| Token 鉴权 | Phase 2 | 待实施 | 绑定远程 host 时强制 |
| `execute` 返回值过滤 | Phase 2 | 待实施 | 防止 env 泄露（步骤 4.11） |
| CLI payload 大小限制 | Phase 3 | 待实施 | 防止 DoS |

---

## 8. 测试实施计划

详见 `MCP_CLI_SKILL_DESIGN.md` Section 16。

### Phase 1A 测试

```bash
# 新增 spawriter/src/skill.test.ts
# 验证 skill 输出完整性、stub 一致性
```

### Phase 2 测试

```bash
# 新增以下测试文件：
# spawriter/src/runtime/session-store.test.ts
# spawriter/src/runtime/tool-service.test.ts
# spawriter/src/pw-executor.security.test.ts
# spawriter/src/mcp-tools.test.ts  — 4 个 MCP tool 注册和 action 分发
```

### Phase 3 测试（路径 B 完整用例）

```bash
# 测试文件清单：
# spawriter/src/cli.test.ts            — CLI 参数解析、-e/session/serve/relay/skill 命令
# spawriter/src/runtime/cli-globals.test.ts  — VM 全局作用域注入
# spawriter/src/runtime/ensure-relay.test.ts — relay 自动启动
# spawriter/src/runtime/kitty-graphics.test.ts — Kitty Graphics Protocol
# spawriter/src/integration/cli-execute.test.ts — 端到端 -e 执行
# spawriter/src/integration/cli-session.test.ts — session 生命周期
```

#### 单元测试

**cli.test.ts — CLI 参数解析**（可无浏览器运行）：

```typescript
import { describe, it, expect } from 'vitest'

describe('CLI argument parsing', () => {
  // 默认命令行为
  it('no args → starts MCP server', () => { /* 验证不含 -e 时调用 startMcpServer */ })
  it('-e flag → executes code', () => { /* 验证含 -e 时调用 executeCode */ })
  it('-e without -s → error with helpful message', () => { /* 验证缺少 session 时的错误提示 */ })
  it('-s can use env var SSPA_SESSION', () => { /* 验证环境变量回退 */ })
  it('--timeout parses as number', () => { /* 验证 --timeout 10000 */ })

  // session 子命令
  it('session new → POST /cli/session/new', () => {})
  it('session list → GET /cli/sessions', () => {})
  it('session delete <id> → POST /cli/session/delete', () => {})
  it('session reset <id> → POST /cli/reset', () => {})
  it('all session commands support --host', () => {})

  // 其他子命令
  it('skill → reads and prints skill.md', () => {})
  it('logfile → prints log path', () => {})
  it('serve → starts MCP with options', () => {})
  it('relay → starts relay with options', () => {})
  it('relay --replace → kills existing + restarts', () => {})
  it('unknown command → error', () => {})
})
```

**cli-globals.test.ts — VM 全局作用域注入**：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { injectSpawriterGlobals } from '../runtime/cli-globals.js'

describe('injectSpawriterGlobals', () => {
  const mockToolContext = {
    executeTool: vi.fn().mockResolvedValue({ apps: [], overrides: {} }),
  }
  const mockExecutor = { setGlobals: vi.fn() }

  it('injects singleSpa as function (matches MCP single_spa tool API)', () => {
    injectSpawriterGlobals(mockExecutor as any, 'test-session', mockToolContext)
    const globals = mockExecutor.setGlobals.mock.calls[0][0]
    expect(typeof globals.singleSpa).toBe('function')
  })

  it('singleSpa("status") calls dashboard_state', async () => {
    const mockTool = vi.fn().mockResolvedValue({ apps: [] })
    const executor = { setGlobals: vi.fn() }
    injectSpawriterGlobals(executor as any, 'test-session', { executeTool: mockTool })
    const globals = executor.setGlobals.mock.calls[0][0]
    await globals.singleSpa('status')
    expect(mockTool).toHaveBeenCalledWith('dashboard_state', {})
  })

  it('singleSpa("override_set") calls override_app with correct args', async () => {
    const mockTool = vi.fn().mockResolvedValue({})
    const executor = { setGlobals: vi.fn() }
    injectSpawriterGlobals(executor as any, 'test-session', { executeTool: mockTool })
    const globals = executor.setGlobals.mock.calls[0][0]
    await globals.singleSpa('override_set', { appName: '@org/app', url: 'http://localhost:8080/main.js' })
    expect(mockTool).toHaveBeenCalledWith('override_app', {
      action: 'set', appName: '@org/app', url: 'http://localhost:8080/main.js',
    })
  })

  it('injects tab as function (matches MCP tab tool API)', () => {
    injectSpawriterGlobals(mockExecutor as any, 'test-session', mockToolContext)
    const globals = mockExecutor.setGlobals.mock.calls[0][0]
    expect(typeof globals.tab).toBe('function')
  })

  it('tab("connect") passes session_id automatically', async () => {
    const mockTool = vi.fn().mockResolvedValue({})
    const executor = { setGlobals: vi.fn() }
    injectSpawriterGlobals(executor as any, 'my-session', { executeTool: mockTool })
    const globals = executor.setGlobals.mock.calls[0][0]
    await globals.tab('connect', { url: 'http://localhost:9000', create: true })
    expect(mockTool).toHaveBeenCalledWith('connect_tab', {
      url: 'http://localhost:9000',
      create: true,
      session_id: 'my-session',
    })
  })

  it('does NOT inject Playwright-native operations (navigate, interact, etc.)', () => {
    injectSpawriterGlobals(mockExecutor as any, 'test-session', mockToolContext)
    const globals = mockExecutor.setGlobals.mock.calls[0][0]
    expect(globals.navigate).toBeUndefined()
    expect(globals.interact).toBeUndefined()
    expect(globals.pageContent).toBeUndefined()
    expect(globals.ensureFreshRender).toBeUndefined()
  })

  it('injects consoleLogs, networkLog, networkDetail, cssInspect', () => {
    injectSpawriterGlobals(mockExecutor as any, 'test-session')
    const globals = mockExecutor.setGlobals.mock.calls[0][0]
    expect(typeof globals.consoleLogs).toBe('function')
    expect(typeof globals.networkLog).toBe('function')
    expect(typeof globals.networkDetail).toBe('function')
    expect(typeof globals.cssInspect).toBe('function')
  })

  it('injects networkIntercept with enable/disable/addRule/removeRule', () => {
    injectSpawriterGlobals(mockExecutor as any, 'test-session')
    const globals = mockExecutor.setGlobals.mock.calls[0][0]
    expect(typeof globals.networkIntercept.enable).toBe('function')
    expect(typeof globals.networkIntercept.disable).toBe('function')
    expect(typeof globals.networkIntercept.addRule).toBe('function')
    expect(typeof globals.networkIntercept.removeRule).toBe('function')
  })
})
```

**ensure-relay.test.ts — relay 自动启动**：

```typescript
import { describe, it, expect, vi } from 'vitest'

describe('ensureRelayServer', () => {
  it('returns false if relay already running', async () => {})
  it('spawns detached relay process if not running', async () => {})
  it('waits for relay to respond to /version', async () => {})
  it('throws after timeout if relay fails to start', async () => {})
  it('unrefs spawned process so CLI can exit', async () => {})
})
```

**kitty-graphics.test.ts — Kitty Graphics Protocol**：

```typescript
import { describe, it, expect } from 'vitest'
import { canEmitKittyGraphics, emitKittyImage } from '../runtime/kitty-graphics.js'

describe('canEmitKittyGraphics', () => {
  it('returns true when AGENT_GRAPHICS=kitty', () => {})
  it('returns true when AGENT_GRAPHICS=kitty,other', () => {})
  it('returns false when AGENT_GRAPHICS unset', () => {})
  it('returns false when AGENT_GRAPHICS=none', () => {})
})

describe('emitKittyImage', () => {
  it('emits single chunk for small base64', () => {})
  it('emits multiple chunks with m=0/1 for large base64', () => {})
  it('uses APC escape sequences \\x1b_ ... \\x1b\\\\', () => {})
})
```

#### 集成测试

**cli-execute.test.ts — 端到端 `-e` 执行**（需要 relay + 浏览器）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

describe('CLI -e execution (integration)', () => {
  let sessionId: string

  beforeAll(async () => {
    // 启动 relay，创建 session
  })

  afterAll(async () => {
    // 清理 session，停止 relay
  })

  // 原则 1：Playwright 原生 API 直接可用
  it('page.goto() works', async () => {})
  it('page.screenshot() saves file', async () => {})
  it('page.click() works', async () => {})
  it('page.evaluate() returns value', async () => {})
  it('context.pages() lists pages', async () => {})
  it('return value is printed as text', async () => {})

  // 原则 1：state 跨调用持久化
  it('state persists across -e calls', async () => {
    // 调用 1: spawriter -s id -e 'state.counter = 42'
    // 调用 2: spawriter -s id -e 'return state.counter' → 42
  })

  // 原则 2：spawriter 扩展函数可用（API 与 MCP tool 一致）
  it('singleSpa("status") returns app list', async () => {})
  it('singleSpa("override_set") + singleSpa("override_remove") lifecycle', async () => {})
  it('tab("connect") + tab("release") lifecycle', async () => {})
  it('consoleLogs() returns collected logs', async () => {})
  it('networkLog() returns request list', async () => {})
  it('labeledScreenshot() returns image with labels', async () => {})

  // 错误处理
  it('syntax error in -e code returns isError', async () => {})
  it('timeout returns timeout error', async () => {})
  it('undefined session returns 500', async () => {})

  // 安全
  it('/cli/execute rejects cross-origin requests (Sec-Fetch-Site)', async () => {})
  it('/cli/execute requires token when configured', async () => {})
  it('Playwright channel owner objects are filtered from return', async () => {})

  // Kitty Graphics
  it('image results emitted as Kitty escape sequences when AGENT_GRAPHICS=kitty', async () => {})
  it('image results saved to file when not Kitty', async () => {})
})
```

**cli-session.test.ts — session 生命周期**：

```typescript
describe('CLI session lifecycle (integration)', () => {
  it('session new → returns session ID', async () => {})
  it('session list → shows created session', async () => {})
  it('session reset → returns pageUrl and pagesCount', async () => {})
  it('session delete → removes session', async () => {})
  it('session list after delete → empty', async () => {})
  it('multiple sessions are isolated (state not shared)', async () => {})
  it('ensureRelayServer auto-starts relay if not running', async () => {})
  it('--host connects to remote relay', async () => {})
})
```

---

## 9. 迁移检查清单

### Phase 1A 完成标志

- [ ] `spawriter/src/skill.md` 存在且包含完整 agent 文档
- [ ] `spawriter skill` 命令输出完整文档
- [ ] `skills/spawriter/SKILL.md` 是轻量 stub
- [ ] README 已瘦身为入口型
- [ ] 构建后 `node dist/cli.js skill` 正常工作

### Phase 1B 完成标志

- [ ] `spawriter/dist/agent-guide.md` 自动生成，不含 CLI Usage
- [ ] `cursor-rules/spawriter.mdc` 自动生成
- [ ] `scripts/package-release.js` 不再引用已删除目录
- [ ] release 打包包含所有生成产物

### Phase 2 完成标志

- [ ] `spawriter/src/runtime/` 目录包含 7+ 个文件
- [ ] `mcp.ts` 只注册 4 个 MCP tool（`execute`/`reset`/`single_spa`/`tab`）+ 原 31 tool 标记 deprecated
- [ ] MCP 和 CLI 调用命中相同的 `executeTool` / `execute` 逻辑
- [ ] `/cli/*` 路由有安全防护
- [ ] `execute` 返回值不泄露环境变量（`isPlaywrightChannelOwner` 过滤）
- [ ] session store 超限时显式报错
- [ ] **MCP 新增 `execute` tool**（通用代码执行 + spawriter 全局函数注入）
- [ ] **MCP 新增 `reset` tool**（对齐上游）
- [ ] **`prompt.md` 生成脚本**（skill.md → 去 CLI 段 → 注入到 execute description）
- [ ] **`single_spa` tool**（合并 dashboard_state + override_app + app_action）
- [ ] **`tab` tool**（合并 connect_tab + list_tabs + switch_tab + release_tab）
- [ ] **原 31 tool 标记 deprecated**（向后兼容，Step A 策略）
- [ ] 所有 Phase 2 测试通过

### Phase 3 完成标志（路径 B）

- [ ] CLI 使用 goke 解析器
- [ ] **默认命令支持 `-e` 代码执行**（对齐上游 `playwriter -e`）
- [ ] **默认命令无 `-e` 时启动 MCP server**
- [ ] `-e` 执行环境包含 `page`/`context`/`state` + spawriter 扩展函数
- [ ] **relay 暴露 `/cli/execute` 端点**（含安全中间件）
- [ ] **`injectSpawriterGlobals` 正确注入**：`singleSpa()`、`tab()`、`consoleLogs()` 等
- [ ] 支持 `session new/list/delete/reset`（含 `--host`）
- [ ] `session list` 输出格式化对齐表格
- [ ] 支持 `skill`、`serve`、`relay`、`logfile`、`help`
- [ ] `ensureRelayServer`：CLI 命令前自动检查/启动 relay
- [ ] `relay` 命令支持 `--replace` 和端口检测
- [ ] `-e` 结果支持 Kitty Graphics Protocol 图像输出
- [ ] CLI 多次调用同一 session，`state` 持久化正常
- [ ] 所有 Phase 3 测试通过

### Phase 4 完成标志

- [ ] `logfile` 命令可用
- [x] ~~package name 已统一~~（已移至前置步骤 1.4）

---

## 10. 审计发现与修正

基于对 `spawriter` 源码（`mcp.ts`, `cli.ts`, `relay.ts`, `pw-executor.ts`, `package.json`, `package-release.js`）和上游 `playwriter`（`cli.ts`, `executor.ts`, `cdp-relay.ts`）的交叉核对，发现以下需要修正或补充的问题。

### 10.1 工具数量修正

实施文档 Section 1.1 写"31 tool 定义"，实际 `mcp.ts` 的 `tools` 数组包含 **31 个** tool 定义（逐一匹配 `name:` 确认为 31 个）。设计文档写"30 个"。以源码为准，统一为 **31 个**。

### 10.2 `pw-executor.ts` 安全漏洞确认

审计确认 **`spawriter` 存在与上游 v0.0.103 相同的安全风险**。

当前 `pw-executor.ts` 第 199–206 行的返回值序列化逻辑：

```typescript
if (hasExplicitReturn && result !== undefined) {
  const formatted = typeof result === 'string'
    ? result
    : util.inspect(result, { depth: 4, colors: false, ... });
  if (formatted.trim()) {
    responseText += `[return value] ${formatted}\n`;
  }
}
```

这里直接对 `result` 调用 `util.inspect()`，如果 `result` 是 Playwright `Response`/`Page` 等对象，`util.inspect` 会遍历 `_connection._platform.env`，导致完整的 `process.env` 泄露。

上游的修复方式（`executor.ts` 第 1219 行）是在序列化前检查：

```typescript
if (resolvedResult !== undefined && !isPlaywrightChannelOwner(resolvedResult)) {
  // safe to inspect
}
```

上游的 `isPlaywrightChannelOwner` 检查的是 `value._type` 和 `value._guid` 属性（Playwright 内部协议字段），而不是 `constructor.name`。**实施文档步骤 4.10 中建议的 `isPlaywrightHandle` 实现需要修正**：

```typescript
// 修正后的实现（与上游一致）
export function isPlaywrightChannelOwner(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any)._type === 'string' &&
    typeof (value as any)._guid === 'string'
  )
}
```

这比基于 `constructor.name` 的检测更可靠，因为：
- Playwright 内部所有 channel owner 对象都有 `_type` 和 `_guid`
- `constructor.name` 在 minified 代码中可能被破坏
- 上游已经验证过这种检测方式的正确性

### 10.3 全局状态清单精确化

实施文档 Section 4.4 提到需要迁移的全局状态。经源码审计，`mcp.ts` 中实际的全局状态有：

| 变量 | 行号 | 作用域 | session 化优先级 |
|---|---|---|---|
| `cdpSession` | 30 | 全局单例 CDP 连接 | 高 — 多 session 需要各自的 CDP 连接 |
| `preferredTargetId` | 32 | 全局 tab 选择 | 高 — 每个 session 应有独立 tab 偏好 |
| `activeAgentId` | 189 | 当前活跃 agent | 高 — session store 核心字段 |
| `consoleLogs` | 217 | 全局 console 缓存 | 高 — 设计文档明确要求隔离 |
| `interceptRules` | 291 | 全局拦截规则 | 高 — 各 session 的 mock 不应互相干扰 |
| `refCacheByTab` | 1048 | 按 tab 分组的 ref 缓存 | 中 — 已按 tab 隔离，但需映射到 session |
| `MODEL_PROFILES` | 41 | 图像配置常量 | 无需 session 化 — 只读配置 |
| `executorManager` | (mcp.ts 中实例化) | Playwright VM 管理器 | 高 — 已按 sessionId 隔离 |

**注意**：设计文档提到的 `networkEntries`、`snapshotBaseline`、`debuggerState` 在 `mcp.ts` 中**不是**以这些变量名存在的。实际上：
- 网络日志通过 CDP 事件直接获取，没有持久的 `networkEntries` 缓冲区
- snapshot baseline 通过 `accessibility_snapshot` 的 `diff` 参数按需计算
- debugger state 通过 CDP session 命令实时管理

因此 `SessionState` 接口需要修正（移除不存在的字段，补充实际存在的字段）：

```typescript
export interface SessionState {
  id: string
  cdpSession: CdpSession | null
  preferredTargetId: string | null
  activeAgentId: string | null
  consoleLogs: ConsoleLogEntry[]
  interceptRules: Map<string, InterceptRule>
  refCacheByTab: Map<string, Map<number, RefInfo>>
  executorSessionId: string
  createdAt: number
}
```

### 10.4 relay.ts 使用 Hono 确认

审计确认 `relay.ts` 第 1 行 `import { Hono } from 'hono'`，第 54 行 `const app = new Hono()`。现有路由包括 `/`, `/connect-active-tab`, `/connect-tab`, `/trace`, `/version`, `/json/version`, `/json/list`。

实施文档步骤 4.5 中使用 `Hono` 类型是正确的。但 `control-routes.ts` 的 `registerControlRoutes(app: Hono, ...)` 签名需要确认 Hono 是否支持外部注册路由的方式（答案是支持，Hono 实例可以传递）。

### 10.5 `package.json` 现状确认

- 当前无 `files` 字段 — 步骤 2.3 需要新增
- 当前无 `vitest` 依赖 — Phase 2 需要安装
- 当前无 `goke`/`zod`/`picocolors` — Phase 3 需要安装
- `description` 写"27 MCP tools"但实际是 31 个（待精简为 4 tool） — 应修正为描述新架构

### 10.6 `package-release.js` 行号确认

实施文档 Section 3.3 说"当前第 148–155 行"，审计确认：
- 第 148–151 行：`copyDirIfExists(path.join(rootDir, "mcp", "skills", "spawriter"), ...)`
- 第 152–155 行：`copyDirIfExists(path.join(rootDir, "mcp", "cursor-rules"), ...)`

行号准确。

### 10.7 上游 `skill` 命令路径解析

实施文档步骤 2.2 建议 Phase 1A 用 `switch (command)` 内的 `case "skill"` 实现，步骤 5.1 再用 goke 重写。但上游的 `skill` 命令路径解析为：

```typescript
const skillPath = path.join(__dirname, '..', 'src', 'skill.md')
```

上游 `__dirname` 指向 `playwriter/dist/`（因为是编译后的 JS），所以 `..` 回退到 `playwriter/`，`src/skill.md` 指向源文件。

**`spawriter` 的构建产物在 `spawriter/dist/`**。`path.join(__dirname, '..', 'src', 'skill.md')` 会正确指向 `spawriter/src/skill.md`。但构建后 `__dirname` 是 `spawriter/dist/`，所以：
- `path.join(__dirname, '..', 'src', 'skill.md')` → `spawriter/src/skill.md` ✓
- fallback `path.join(__dirname, 'skill.md')` → `spawriter/dist/skill.md` — 需要在构建时复制

建议在 `tsconfig.json` 或构建脚本中添加 `skill.md` 的复制步骤，或者在 `package.json` 的 `build` 脚本中添加：

```json
"build": "... && tsc && cp src/skill.md dist/skill.md"
```

这样无论是开发态还是发布态都能找到文件。

### 10.8 Phase 2 → Phase 3 依赖关系补充

实施文档说 Phase 3 依赖 Phase 2 完成。但 `skill` 命令和基础命令可以在 Phase 1A 就实现（因为不需要 control plane）。路径 B 后依赖关系更新为：

| Phase 3 子功能 | 实际依赖 |
|---|---|
| `spawriter skill` | Phase 1A |
| `spawriter serve` / `relay` | 已有 |
| `spawriter session new/list/delete/reset` | Phase 2（需要 `/cli/session/*` 端点） |
| `spawriter -e` 代码执行 | Phase 2（需要 `/cli/execute` 端点 + `injectSpawriterGlobals`） |
| `spawriter logfile` | Phase 1A |

所以 **goke 迁移可以在 Phase 1A 启动**，先迁移已有命令 + `skill` + `logfile`，Phase 2 完成后再补 session 和 `-e` 执行。

### 10.9 缺失内容清单（路径 B 更新后）

路径 B 架构变更后，以下原缺失项的状态：

| 原设计文档要求 | 路径 B 后状态 | 说明 |
|---|---|---|
| `js -e` / `pw -e` 快捷命令 | **被 `-e` 替代** | 路径 B 统一为默认命令 `-e`，不再需要独立的 `js`/`pw` 子命令 |
| `--stdin` 输入方式 | **不再需要** | `-e` 模式下代码直接作为参数传递，无需 JSON stdin |
| `tab connect/list/switch/release` 快捷命令 | **被 `tab()` 函数替代** | 在 `-e` 中通过 `tab("connect")` 等调用 |
| 跨 shell 转义问题 | **仍需注意** | `-e` 的代码字符串仍受 shell 转义影响，但简单字符串比 JSON payload 问题更少 |
| `ExecutorManager` 策略变更 | **已补充**（步骤 4.7） | 显式报错而非静默淘汰 |
| `tool <name>` 通用入口 | **降级为可选** | 路径 B 以 `-e` 为主入口，`tool` 子命令保留为向后兼容备选 |
| Phase 2 的过渡策略（先同进程再 HTTP）| 步骤 4.9 已提及 | 应补充具体的过渡实现示例 |
| skill.md 内容实际撰写指南 | 步骤 2.1 仅给了章节大纲 | 应对每个章节给出内容来源映射 |
| `tsconfig.json` 变更 | 未提及 | 新增 `runtime/` 目录需要确认 TS 配置 |

### 10.10 上游 CLI 命令 vs spawriter 工具逐一对比（路径 B 更新后）

> **重要**：此对比表已根据路径 B 架构决策更新。spawriter CLI 现在统一为 `-e` 代码执行模式，与上游 `playwriter` 的 CLI 用法基本对齐。

上游 `playwriter` CLI 有 **8 个命令**（含默认命令），MCP 端只有 **2 个 tool**（`execute` + `reset`）。`spawriter` 路径 B 后将有 **同构的 CLI 命令**（默认 `-e` + session + serve + skill + logfile）和 **4 个核心 MCP tool**（`execute` + `reset` + `single_spa` + `tab`，原 31 tool 标记 deprecated 渐进淘汰）。

两个项目的架构在路径 B + MCP 靠拢后**趋于一致**：
- **上游**：MCP 暴露 `execute` + `reset`，agent 写 Playwright JS
- **spawriter**：MCP 暴露 `execute` + `reset` + `single_spa` + `tab` = **4 个 tool**，agent 写 Playwright + spawriter 扩展代码。原 31 tool 标记 deprecated 渐进淘汰
- **CLI 层**：两者用法**几乎一致** —— `session new` → `-s id -e '<code>'`

#### 命令级对比（路径 B 更新后）

| # | 上游 CLI 命令 | 上游实现要点 | spawriter 对应（路径 B） | 差距评估 |
|---|---|---|---|---|
| 1 | `playwriter`（默认命令） | 无 `-e` 时启动 MCP；有 `-e` 时执行代码 | `spawriter`（步骤 5.1）：完全相同的双模式默认命令 | **已对齐** |
| 2 | `playwriter session new` | `--direct`/`--browser`/`--host`；自动发现 Chrome；自动启动 relay | `spawriter session new`（步骤 5.1） | **部分差距**：缺少 `--direct` CDP 直连、`--browser` 多浏览器选择、Chrome 实例自动发现。已有 `--host` 和 `ensureRelayServer` |
| 3 | `playwriter session list` | 格式化表格；`--host` | `spawriter session list`（步骤 5.5） | **已对齐** |
| 4 | `playwriter session delete <id>` | `--host` | `spawriter session delete`（步骤 5.1） | **已对齐** |
| 5 | `playwriter session reset <id>` | `--host`；返回 pageUrl/pagesCount | `spawriter session reset`（步骤 5.1） | **已对齐**（包含状态反馈） |
| 6 | `playwriter serve` | `--host`/`--token`/`--replace`；公网强制 token；端口检测 | `spawriter relay`（步骤 5.6） | **已对齐**（`--replace`/端口检测/`--host`/`--token`） |
| 7 | `playwriter browser start` | 启动 Chrome、加载扩展 | 无对应 | **不需要**：spawriter 依赖用户安装扩展 |
| 8 | `playwriter browser list` | 列出扩展+CDP 浏览器 | 无独立命令 | **低优先**：spawriter 场景中不常用 |
| 9 | `playwriter logfile` | 打印日志路径 | `spawriter logfile`（步骤 6.1） | **已规划** |
| 10 | `playwriter skill` | 打印 skill.md | `spawriter skill`（步骤 2.2） | **已规划** |

#### `-e` 执行环境对比

| 维度 | 上游 `playwriter -e` | `spawriter -e`（路径 B） |
|---|---|---|
| 内建全局 | `page`, `context`, `state`, `console` | **相同** + spawriter 扩展函数 |
| Playwright 操作 | `page.goto()`, `page.click()` 等原生 API | **完全相同** |
| 截图 | `page.screenshot()` 原生 | `page.screenshot()` 原生 + `labeledScreenshot()` 增强版 |
| Single-spa | 无 | `singleSpa("status"/"override_set"/...)` |
| Tab 管理 | session 级隔离 | `tab("connect"/"list"/"switch"/"release")` |
| 网络调试 | 通过 Playwright route/CDP 代码 | `consoleLogs()`, `networkLog()`, `networkIntercept` 封装 |
| 返回值过滤 | `isPlaywrightChannelOwner` | **相同** |
| Kitty Graphics | 支持 | **相同** |

#### spawriter 的差异化优势（路径 B 后不变）

1. **4 个精炼 MCP tool**（`execute`/`reset`/`single_spa`/`tab`）— 通用调用、传不同参数、允许组合
2. **Single-spa 工具**：`single_spa` MCP tool + `singleSpa()` VM 全局函数，CLI 和 MCP API 一致
3. **Tab Lease System**：`tab` MCP tool + `tab()` VM 全局函数，多 agent 安全共享 tab，CLI 和 MCP API 一致
4. **丰富 VM 全局函数**：`snapshot()`、`screenshotWithLabels()`、`consoleLogs()`、`networkIntercept` 等注入到 execute 环境
5. **双通道一致性**：MCP `execute` 和 CLI `-e` 共享完全相同的 VM 环境

#### 路径 B 后剩余差距（低优先级，可未来补齐）

| 差距项 | 说明 | 优先级 |
|---|---|---|
| `--direct` CDP 直连 | 上游支持无扩展的 CDP 直连，spawriter 依赖扩展 | 低（spawriter 设计就是扩展驱动） |
| `--browser` 多浏览器选择 | 上游支持在多个连接的 Chrome 间选择 | 低 |
| Chrome 实例自动发现 | 上游的 `chrome-discovery.ts` | 低 |
| `browser start/list` | 管理 Chrome 进程 | 不需要 |
| 扩展版本过时检测 | 连接时检查扩展版本 | 中（可后续添加） |

### 10.11 已修正项摘要

以下项目已在历次修正中同步到正文，不再需要实施者手动交叉对照：

- [x] 步骤 4.12 安全检测改用 `_type`/`_guid`（原 10.2 发现，原步骤 4.11 现重编号为 4.12）
- [x] 步骤 4.4 SessionState 接口修正（原 10.3 发现）
- [x] 步骤 4.4 实施要点移除不存在的全局变量引用（原 10.3 发现）
- [x] Phase 3 依赖声明细化（原 10.8 发现）
- [x] 步骤 4.5 补充 `buildToolContext` 定义（二次审计发现）
- [x] 步骤 4.6 ControlClient 添加错误处理 + token（二次审计发现）
- [x] `vitest` 安装移到 Phase 2（二次审计发现）
- [x] 步骤 2.1 补充内容来源映射表（二次审计发现）
- [x] 步骤 3.2 构建脚本补充 skill.md 复制（原 10.7 发现）
- [x] **Phase 3 架构重写为路径 B**（CLI 统一 `-e` 代码执行模式）
- [x] 步骤 5.1 重写为默认命令 + `-e` 执行（对齐上游 `playwriter`）
- [x] 步骤 5.2 重写为 relay `/cli/execute` 端点 + VM 全局作用域注入
- [x] 步骤 5.3 重写为 spawriter 扩展函数 API 参考（替代原快捷命令方案）
- [x] skill.md CLI Usage 章节描述更新（反映 `-e` 为主入口）
- [x] Section 10.10 对比表更新（反映路径 B 后差距大幅缩小）
- [x] **步骤 4.11 新增**：MCP 侧向 playwriter 靠拢（`execute` + `reset` + spawriter 独有 tool）
- [x] Phase 2 完成标志更新（含 MCP 新结构验证项）
- [x] 安全修复步骤重编号 4.11 → 4.12
- [x] **目录与包名统一**：`mcp/` → `spawriter/`，`spawriter-mcp` → `spawriter`，新增前置步骤 1.4
- [x] **大原则更新**：CLI+MCP 尽量少 tool，移除 `tool-registry.ts`，Phase 2 目标从 31 tool registry 改为 4 tool 精简注册
- [x] **可实施性审计**（见 10.13）

### 10.12 `tsconfig.json` 注意事项

新增 `spawriter/src/runtime/` 目录需要确认 TypeScript 配置：

1. `rootDir` 设为 `src/`（如果是，`runtime/` 会被正确处理，编译产物在 `dist/runtime/`）
2. import 路径需要使用 `.js` 后缀（ESM 规范），例如 `import { SessionStore } from './runtime/session-store.js'`
3. 所有代码示例已遵循此约定

### 10.13 可实施性审计（对照源码）

对照当前 `spawriter/src/pw-executor.ts`（363 行）和上游 `playwriter/src/mcp.ts`（372 行），发现以下可实施性问题：

#### 10.13.1 `ExecuteResult` 缺少 `images` 字段

当前 `pw-executor.ts` 第 29-32 行：

```typescript
export interface ExecuteResult {
  text: string;
  isError: boolean;
}
```

文档步骤 5.1 的 `executeCode` 函数期望返回 `{ text, images, isError }`。上游 `executor.ts` 的 `ExecuteResult` 包含 `images: Array<{ data: string; mimeType: string }>` 和 `screenshots: Array<{ path: string; snapshot: string; labelCount: number }>`。

**修复**：Phase 2 需要扩展 `ExecuteResult` 接口：

```typescript
export interface ExecuteResult {
  text: string;
  isError: boolean;
  images: Array<{ data: string; mimeType: string }>;  // 新增
  screenshots: Array<{ path: string; snapshot: string; labelCount: number }>;  // 新增
}
```

#### 10.13.2 `getToolContext()` 桥接方式需要明确

步骤 5.2.2 中 `injectSpawriterGlobals` 使用 `executor.getToolContext()` 获取 `toolContext.executeTool()`。但 `PlaywrightExecutor` 是 Playwright VM 执行器，不感知 MCP tool 注册。

**已修复**：步骤 5.2.2 的 `injectSpawriterGlobals` 函数签名已改为接受外部传入的 `toolContext` 参数，`PlaywrightExecutor` 保持纯净。调用方（relay `/cli/execute` 或 MCP `execute` tool handler）负责构建 `toolContext`。

#### 10.13.3 `prompt.md` 与 `agent-guide.md` 关系需要明确

步骤 3.1 生成 `agent-guide.md`（skill.md 去 CLI 段），步骤 4.10.5 定义 `prompt.md`（注入到 execute tool description）。两者内容基本相同（都是 skill.md 去 CLI 段），但用途不同：

- `agent-guide.md`：给外部 agent 阅读的文档
- `prompt.md`：注入到 MCP `execute` tool 的 description，MCP agent 调用 tool 时看到

**已修复**：步骤 3.1 构建脚本现在同时生成 `prompt.md`（`agent-guide.md` 的副本）。步骤 3.4 验证步骤增加了 `diff` 校验。

#### 10.13.4 `vm.createContext` 全局注入时机

当前 `pw-executor.ts` 第 166-174 行在**每次 `execute()` 调用**时创建新的 `vmContext`。步骤 5.2.3 的 `setGlobals()` 在 `execute()` 中合并 `customGlobals`——这意味着 `injectSpawriterGlobals` 可以在 `execute()` 之前调用一次，后续每次 `execute()` 都会自动包含这些全局变量。这是正确的。

但需要注意：`vm.createContext()` 每次重新创建意味着**闭包不能跨 execute 调用共享 VM 状态**（除了 `state` 对象）。这与上游行为一致，不是问题。

#### 10.13.5 上游 `prompt.md` 读取路径

上游 `mcp.ts` 第 185-186 行：

```typescript
const promptContent = fs.readFileSync(path.join(__dirname, '..', 'dist', 'prompt.md'), 'utf-8')
```

`spawriter` 的 `mcp.ts` 需要同样的路径解析。`__dirname` 编译后为 `spawriter/dist/`，路径为 `path.join(__dirname, '..', 'dist', 'prompt.md')` = `spawriter/dist/prompt.md`。

**已修复**：步骤 3.1 构建脚本现在会将 `prompt.md` 生成到 `dist/` 目录。

