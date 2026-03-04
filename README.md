# spawriter

single-spa 的 DevTools 面板增强版，保留原有 Dashboard 调试体验，并新增 MCP 能力，让 AI 直接连接你正在使用的真实 Chrome Tab（而不是新开浏览器）。

> 项目版本：`v1.0.0`

---

## Part 1: Dashboard 使用

这部分是“人类开发者”路径，不依赖 MCP，也不需要启动 MCP 进程。

### 1) 主要功能

- DevTools 面板查看 single-spa 应用状态
- 强制 mount / unmount
- Overlay 高亮（On / Off / List Hover）
- Import Map Overrides（编辑、保存、启停、导入导出）
- Clear Cache & Refresh（面板按钮）
- spawriter AI Bridge（工具栏按钮 per-tab 开关，点击 attach/detach 当前 tab；badge 显示 attached 数量与状态，绿色=本 tab 已连接，灰色+数字=其他 tab 已连接，无 badge=无连接）

### 2) 安装方式

#### 方式 A：使用发布包（推荐）

- Chrome：`spawriter-chrome-{version}.zip`
- Firefox：`spawriter-firefox-{version}.zip`

#### 方式 B：源码构建

```bash
npm install
npm run build
```

默认会生成统一分发目录（推荐直接分发这一整个目录）：

- `release/spawriter-v<version>/`

该目录下包含：

- `extension/dist-chrome/`（Chrome unpacked 安装）
- `extension/spawriter-chrome-<version>.zip`（Chrome zip）
- `mcp/dist/`（MCP 可执行产物）
- `skills/spawriter/`（可复制的 skill）
- `cursor-rules/`（Cursor IDE 规则模板）
- `doc/`（安装与开发文档）

`npm run build` 完成后会自动清理根目录中间产物目录（`build`、`dist-chrome`、`web-ext-artifacts`），避免与统一分发目录混淆。

> **构建约束**
>
> - `release/` 是纯构建产物（已加入 `.gitignore`），可安全删除后 `npm run build` 完全重建。
> - 版本号变更请使用 `npm run version:bump <patch|minor|major|x.y.z>`，该脚本会同步更新 `package.json`、`manifest.json`、`manifest.chrome.json`、`mcp/package.json` 四个文件。
> - 编译流水线：`webpack → build-chrome → web-ext zip → mcp:build → package-release → clean:artifacts`。
> - 旧版本 release 目录会被 `clean:artifacts` 自动清理，始终只保留当前版本。

### 3) Chrome 本地加载（unpacked）

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `release/spawriter-v<version>/extension/dist-chrome/`

### 4) Dashboard 回归检查

- 面板能正常打开
- mount/unmount 正常
- overlay 正常
- import-map-overrides 保存/开关/重载正常
- 工具栏按钮 per-tab attach/detach 正常（badge 绿色+数字=本 tab 已连接，黄色+"..."=连接中，灰色+数字=其他 tab 已连接，无 badge=无连接，红色+"!"=错误）

---

## Part 2: MCP 使用

这部分是“AI 自动化”路径。你可以只用 Dashboard，也可以 Dashboard + MCP 同时使用。

### 1) MCP 由哪几部分组成

- Chrome 扩展（包含 spawriter AI bridge，默认端口 `19989`）
- Relay（CDP 转发，端口 `19989`，独立于 playwriter 的 `19988`，两个扩展可共存）
- MCP Server（stdio tools）

### 2) 快速启动（开发仓库内）

```bash
# 1) 先构建 MCP
npm run mcp:build

# 2) 启动 MCP Server（会处理 relay）
npm run mcp:serve
```

你也可以直接运行兼容命令：

```bash
node dist/cli.js serve
```

> 已添加根目录 `dist/cli.js` 兼容入口，修复了“在项目根目录执行 `node dist/cli.js serve` 找不到模块”的问题。

### 3) 从统一分发目录启动（给最终用户）

假设你分发的是 `release/spawriter-v<version>/`：

```bash
cd release/spawriter-v<version>/mcp
npm install
node dist/cli.js serve
```

完成一次 `mcp` 依赖安装后，也支持在分发目录根下直接执行：

```bash
node dist/cli.js serve
```

### 4) 在 `mcp/` 目录单独启动（可选）

```bash
cd mcp
npm run build
node dist/cli.js serve
```

### 5) MCP 客户端配置示例

可按你的客户端格式配置，核心是启动命令指向 `mcp/dist/cli.js serve`。

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["D:/dev-side/spawriter/mcp/dist/cli.js", "serve"]
    }
  }
}
```

### 6) MCP 工具能力（当前）

- `screenshot`
- `accessibility_snapshot`
- `execute`
- `dashboard_state`（读取 dashboard 状态、app 状态、override 是否命中 localhost）
- `reset`
- `clear_cache_and_reload`
- `ensure_fresh_render`
- `navigate`

### 7) Cursor Rule（给 AI Agent 的自动上下文）

在 Cursor IDE 中，可以通过 `.cursor/rules/*.mdc` 文件让 AI 自动获得 MCP 使用知识。

统一分发目录中包含预置的规则模板：`cursor-rules/spawriter.mdc`

#### 安装方式

将 `cursor-rules/spawriter.mdc` 复制到你工作区的 `.cursor/rules/` 目录下即可：

```bash
mkdir -p /path/to/workspace/.cursor/rules
cp cursor-rules/spawriter.mdc /path/to/workspace/.cursor/rules/
```

#### 作用域配置

规则文件中的 `globs` 字段控制生效范围，可根据项目结构调整：

| 场景 | globs 配置 |
|------|------------|
| 所有文件 | `**` |
| 仅 journal 和 service | `journal/**,service/**` |
| 仅特定子项目 | `my-project/**` |

修改 `.mdc` 文件头部的 `globs:` 行即可。

#### Rule vs Skill

| | Cursor Rule (`.cursor/rules/*.mdc`) | Skill (`skills/SKILL.md`) |
|---|---|---|
| 触发方式 | 编辑匹配文件时自动注入 | 需要 agent 系统显式加载 |
| 适用场景 | Cursor IDE 日常开发 | 分发给其他 AI Agent 系统 |
| 位置 | 工作区 `.cursor/rules/` | 项目内 `skills/` |

两者可以并存。建议 Cursor 用户使用 Rule，其他 AI Agent 系统使用 Skill。

### 8) Skill（给其他 Agent 系统的使用约束）

参考 `playwriter` 的“CLI + MCP + skill”方式，这个项目也建议给 Agent 配套一段固定使用规范（例如：先截图再执行、异常先 reset、只在普通网页 tab 操作等），以减少误操作与无效调用。

- 参考项目：[`remorses/playwriter`](https://github.com/remorses/playwriter)
- 本项目建议结合：
  - `doc/MCP_DEV_GUIDE.md`
  - `doc/CHROME_INSTALL_TEST_GUIDE.md`
- 统一分发目录中可直接复制：`skills/spawriter/SKILL.md`
- 建议在所有自动化流程中先调用 `dashboard_state`，确认 override 与 dashboard 状态后再执行修改验证。

### 9) 常见问题排查

- **`node dist/cli.js serve` 报找不到模块**

  - 直接用：`npm run mcp:serve`
  - 或先执行：`npm run mcp:build` 再执行 `node dist/cli.js serve`

- **webpack OpenSSL 报错**

  - 当前脚本已内置 `--openssl-legacy-provider`

- **MCP 连上但没有页面**
  - 确认当前是普通网页 tab（不是 `chrome://` / `edge://` / `chrome-extension://`）
  - 调用 `reset` 或重启 `npm run mcp:serve`

---

## 相关文档

- `doc/CHROME_INSTALL_TEST_GUIDE.md`
- `doc/MCP_DEV_GUIDE.md`
- `doc/PUBLISH_GUIDE.md`
