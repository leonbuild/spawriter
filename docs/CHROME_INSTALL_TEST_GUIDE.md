# spawriter Chrome 安装与测试指南

本文档用于快速完成两件事：

1. 产出默认压缩包（zip）及可加载目录。
2. 验证“人类 DevTools 功能 + AI MCP 功能”都可正常工作。

---

## 1) 先决条件

- Node.js 18+（推荐）。
- 已安装项目依赖：
  - 根目录：`npm install`
  - `mcp` 目录：`cd mcp && npm install`
- Chrome 浏览器（用于加载 unpacked 扩展）。

---

## 2) 默认打包（zip）

在项目根目录执行：

```bash
npm run build
```

说明：

- 默认 `build` 会输出统一分发目录。
- 统一目录：`release/spawriter-v<version>/`
- 其中包含：
  - `extension/spawriter-chrome-<version>.zip`
  - `extension/dist-chrome/`
  - `mcp/dist/`
  - `skills/spawriter/`
- 构建结束会自动清理根目录中间产物（`build`、`dist-chrome`、`web-ext-artifacts`），仅保留统一分发目录。
- 如只需本地 unpacked 目录，可执行：`npm run webpack-build && node scripts/build-chrome.js`

---

## 3) 在 Chrome 安装扩展（本地调试）

1. 打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择目录：`release/spawriter-v<version>/extension/dist-chrome`。
5. 确认扩展已启用，且无红色报错。

补充：

- zip 包主要用于分发/归档（例如上传或传递产物）。
- 本地调试建议仍使用 `dist-chrome/` 目录方式加载。

---

## 4) 启动 MCP 服务

开发仓库中，推荐在项目根目录执行：

```bash
npm run mcp:serve
```

说明：

- `serve` 会启动 MCP server，并在需要时自动拉起 relay。
- 默认端口为 `19989`，可通过 `--port` 覆盖。
- 兼容命令：`node dist/cli.js serve`（根目录）或 `cd mcp && node dist/cli.js serve`。

如果你从统一分发目录启动（给最终用户）：

```bash
cd release/spawriter-v<version>/mcp
npm install
node dist/cli.js serve
```

---

## 5) 回归测试（人类功能）

在 single-spa 页面中打开 DevTools 面板，检查以下功能：

- `spawriter` 面板可正常打开。
- mount/unmount 操作正常。
- overlays 显示/隐藏正常。
- Import Map Overrides（保存、开关、重载）正常。
- 工具栏按钮（扩展 icon）点击后切换当前 tab 的 attach/detach 状态（badge 绿色+数字=本 tab 已连接，黄色+"..."=连接中，灰色+数字=其他 tab 已连接，无 badge=无连接，红色+"!"=错误）。

通过标准：

- 不出现异常报错。
- 现有 DevTools 体验不被破坏。

---

## 6) MCP 功能测试（AI 能连真实 Tab）

建议测试顺序：

1. 保持目标网页为普通 web 页面（不要是 `chrome://`、`edge://`、`chrome-extension://`）。
2. 确保扩展和 MCP 服务已启动。
3. 在 MCP 客户端依次调用：
   - `dashboard_state`（先确认当前 app 是否命中 localhost override）
   - `screenshot`
   - `execute`（例如读取 `location.href`）
   - `ensure_fresh_render`
   - `clear_cache_and_reload`（`light`/`aggressive`）

预期结果：

- `dashboard_state` 返回 app 状态、override 状态、localhost 命中信息。
- `screenshot` 返回与当前人类 Chrome Tab 一致的实际渲染。
- `execute` 可返回当前页面可执行结果。
- `ensure_fresh_render` 能完成刷新并回到可操作状态。
- `clear_cache_and_reload` 调用后页面完成 reload，MCP 仍可继续操作。

---

## 7) 常见问题排查

- **构建时报 OpenSSL 错误**

  - 默认脚本已内置兼容参数；若你手动执行 webpack，可用：`node --openssl-legacy-provider ./node_modules/webpack/bin/webpack.js --mode=production`。

- **MCP 连接成功但没有可用页面**

  - 切到普通网页 Tab（非浏览器内部页）。
  - 重新调用 `reset` 或重启 `node dist/cli.js serve`。

- **CDP 连接被拒绝（origin/token）**
  - 检查 relay 端安全策略是否命中（origin 校验、token 配置）。
  - 若配置了 `SSPA_MCP_TOKEN`，客户端需带上相同 token。

---

## 8) 最小验收结论模板

你可以按下面格式记录本次测试结论：

- Chrome 扩展加载：通过 / 不通过
- 人类 DevTools 功能回归：通过 / 不通过
- MCP screenshot/execute：通过 / 不通过
- fresh render 与 clear cache：通过 / 不通过
- 备注与阻塞项：
