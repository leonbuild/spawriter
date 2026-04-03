# spawriter Clone-and-Use 审计报告

> 为什么 `git clone` 后不能直接使用？需要做什么才能让它跑起来？

---

## 结论概要

spawriter 在仓库中 **不包含任何构建产物**，所有运行时所需文件（MCP 编译输出、Extension webpack 打包、PNG 图标）都在 `.gitignore` 中被排除。clone 后需要执行 `**npm run setup`** 即可一键完成安装和构建。

---

## 一、为什么 MCP 配置报 Error

### 根因：`mcp/dist/` 不存在

MCP 客户端（如 Cursor）的配置指向：

```json
{
  "command": "node",
  "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
}
```

`mcp/dist/` 整个目录被 `.gitignore` 排除。clone 后该目录不存在，`node mcp/dist/cli.js serve` 必然报 `Cannot find module` 错误。

### 修复

```bash
npm run setup    # 一键安装 + 构建
```

---

## 二、为什么不能拖拽文件夹到 Chrome 加载 Extension

Chrome 的 "Load unpacked" 需要一个包含 `**manifest.json**` 的目录。spawriter 存在两个问题：

### 问题 1：仓库内没有可直接加载的 Chrome extension 目录


| 目录/文件              | 状态         | 说明                                                                                   |
| ------------------ | ---------- | ------------------------------------------------------------------------------------ |
| `ext/` 根目录         | 不可加载       | 没有 Chrome 所需的 `manifest.json`（只有 `manifest.chrome.json` 和 Firefox 的 `manifest.json`） |
| `ext/build/`       | gitignored | webpack 打包输出，不存在                                                                     |
| `ext/dist-chrome/` | gitignored | Chrome 专用构建目录（含正确的 manifest.json + build/ + icons/），不存在                              |


### 问题 2：源码中的 manifest 文件不匹配 Chrome 加载需求

- `**ext/manifest.json**` — 这是 **Firefox** manifest（MV2/MV3 混合），Chrome 无法直接加载
- `**ext/manifest.chrome.json`** — 这是 Chrome MV3 manifest 的**源文件**，但文件名不是 `manifest.json`，Chrome 不认识
- Chrome manifest 引用 `./build/backgroundScript.js` 等 webpack 输出文件，即使强行重命名，源码也不存在这些编译后的 JS

### 问题 3：PNG 图标不存在

Chrome MV3 **不支持 SVG 图标**，必须使用 PNG。仓库仅包含 SVG 源文件（12 个 `.svg`），PNG 通过 `sharp` 转换生成。

### 修复

```bash
npm run setup    # 一键安装 + 构建
```

构建完成后，在 Chrome 中加载 `**ext/dist-chrome/**` 目录。

---

## 三、完整构建链路分析

### 3.1 项目结构（npm workspaces monorepo）

spawriter 使用 **npm workspaces** 管理三个包：

```
spawriter/           ← 根（orchestrator）
├── package.json     ← workspaces: ["ext", "mcp"]
├── ext/             ← spawriter-ext（Chrome/Firefox 扩展）
│   └── package.json
└── mcp/             ← spawriter-mcp（MCP server + CDP relay）
    └── package.json
```

一次 `npm install` 在根目录执行，即可安装所有工作区依赖（依赖会被提升到根 `node_modules/`）。

### 3.2 可用脚本


| 命令                  | 作用            | 说明                                              |
| ------------------- | ------------- | ----------------------------------------------- |
| `npm run setup`     | **一键初始化**     | `npm install` → `build:ext` → `build:mcp`       |
| `npm run build`     | 构建全部          | `build:ext` + `build:mcp`（**不清理产物**）            |
| `npm run release`   | 发布打包          | `build` + `package-release` + `clean:artifacts` |
| `npm run build:ext` | 构建 Extension  | convert-icons → webpack → build-chrome          |
| `npm run build:mcp` | 构建 MCP server | tsc 编译                                          |


### 3.3 Extension 构建链（`npm run build:ext`）

```
SVG icons ──→ [sharp: convert-icons.js] ──→ PNG icons
     │
     ↓
Source JS/React ──→ [Babel + Webpack] ──→ ext/build/
     │                                        │
     ↓                                        ↓
manifest.chrome.json ──→ [build-chrome.js] ──→ ext/dist-chrome/
                              copies:           ├── manifest.json (from manifest.chrome.json)
                                                ├── build/ (from ext/build/)
                                                ├── icons/*.png
                                                └── icons/*.svg
```

### 3.4 MCP 构建链（`npm run build:mcp`）

```
mcp/src/*.ts ──→ [tsc] ──→ mcp/dist/*.js + *.d.ts + *.map
```

### 3.5 build 与 release 的区别

- `**npm run build**`：只构建，产物保留在 `ext/dist-chrome/` 和 `mcp/dist/`，可直接使用
- `**npm run release**`：构建 → 打包到 `release/spawriter-v{version}/` → 清理中间产物（`ext/build/`、`ext/dist-chrome/`、`ext/web-ext-artifacts/`）

---

## 四、潜在阻碍因素清单

### 4.1 `sharp` 原生依赖

`sharp` 在 `ext/package.json` 中被用于 SVG→PNG 图标转换。它包含**平台特定的原生二进制文件**。

**可能遇到的问题：**

- 网络问题导致预编译二进制下载失败
- 公司代理/镜像不包含 `sharp` 的预编译包

**解决方案：** 手动把 SVG 转 PNG（如在线转换），放到 `ext/src/icons/` 下，然后跳过 `convert-icons` 步骤直接运行 webpack。

### 4.2 Node.js 版本与 OpenSSL

webpack 5 + 新版 Node.js（17+）存在 OpenSSL 兼容性问题。ext 的构建脚本已内置 `--openssl-legacy-provider`。推荐使用 Node.js 18 或 20 LTS。

### 4.3 `playwright-core` — 无需浏览器下载

`mcp/package.json` 依赖 `playwright-core`（不是 `playwright`），它**不会自动下载浏览器**。它只用来通过 CDP 连接已有的 Chrome。

### 4.4 `package-lock.json` lockfileVersion 3

需要 npm 7+（Node.js 16+ 自带）。推荐 Node.js 18+。

---

## 五、克隆后快速启动手册

### 前置要求

- Node.js 18+ LTS（含 npm 9+）
- Chrome 浏览器
- 网络能正常下载 npm 包

### 步骤

```bash
# 1. 克隆
git clone <repo-url> spawriter
cd spawriter

# 2. 一键安装 + 构建
npm run setup

# 3. 加载 Chrome 扩展
#    打开 chrome://extensions/ → 开启开发者模式
#    点击「加载已解压的扩展程序」→ 选择 ext/dist-chrome/ 目录

# 4. 配置 MCP 客户端（以 Cursor 为例）
#    在 MCP 设置中添加：
#    {
#      "mcpServers": {
#        "spawriter": {
#          "command": "node",
#          "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
#        }
#      }
#    }
```

---

## 六、问题总结表


| 症状                               | 根因                                       | 类别                   | 修复              |
| -------------------------------- | ---------------------------------------- | -------------------- | --------------- |
| MCP 配置报 `Cannot find module`     | `mcp/dist/` 被 gitignore                  | 缺少构建产物               | `npm run setup` |
| Chrome 拒绝加载 `ext/` 目录            | `ext/` 根目录没有 Chrome 可识别的 `manifest.json` | manifest 不匹配         | `npm run setup` |
| Chrome 加载报 manifest 缺失           | `ext/dist-chrome/` 被 gitignore           | 缺少构建产物               | `npm run setup` |
| 即使有 manifest 也缺少 JS 文件           | webpack 输出的 `ext/build/` 被 gitignore     | 缺少构建产物               | `npm run setup` |
| manifest 中引用的 PNG 图标不存在          | PNG 从 SVG 生成，且被 gitignore                | 缺少构建产物               | `npm run setup` |
| `npm run build` 后 dist-chrome 消失 | 旧版 `build` 包含 `clean:artifacts`          | ~~已修复~~：`build` 不再清理 |                 |
| `sharp` 安装失败                     | 原生平台二进制依赖                                | 环境依赖                 | 手动转换 SVG→PNG    |


---

## 七、已完成改进

1. **npm workspaces**：根 `package.json` 添加 `"workspaces": ["ext", "mcp"]`，一次 `npm install` 安装所有依赖
2. `**npm run setup`** 一键脚本：`install → build:ext → build:mcp`，clone 后一条命令即可使用
3. **分离 build 和 release**：`npm run build` 只构建不清理产物；`npm run release` 构建 + 打包 + 清理
4. **mcp 包名修正**：`mcp/package.json` name 改为 `spawriter-mcp` 避免与根包名冲突
5. **webpack 路径修复**：ext 的 webpack 调用路径从 `./node_modules/` 改为 `../node_modules/` 适配 hoisting

## 八、可选后续改进

1. **提供 prebuilt release**：在 GitHub Releases 中发布包含 `mcp/dist/` + `ext/dist-chrome/` 的压缩包，使非开发者可以直接使用
2. **GitHub Actions CI**：自动化构建、测试、发布流程

