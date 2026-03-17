# Spawriter 优化文档：基于 Playwriter 最近更新的审核

> 审核范围：playwriter 最近 9 次提交 (1ced689..271cde8)
> 日期：2026-03-17

---

## 1. [高优] Relay 层 Browser.setDownloadBehavior 空操作

### 问题

spawriter relay (`mcp/src/relay.ts` L343-346) 对 `Browser.setDownloadBehavior` 的处理是直接返回空结果：

```typescript
case 'Browser.setDownloadBehavior': {
  sendCdpResponse(clientId, { id, sessionId, result: {} });
  return true;
}
```

这意味着 Playwright 在 extension 模式下调用 `Browser.setDownloadBehavior` 时，行为完全不生效。**文件下载功能在 extension 模式下会静默失败**——Playwright 的 `page.waitForEvent('download')` 将永远不会触发。

### Playwriter 的解决方案 (commit 4557fe1)

Playwriter 实现了三层修复：

1. **Browser → Page 映射**：将 `Browser.setDownloadBehavior` 转换为 `Page.setDownloadBehavior`，并分发到所有已连接的 page target
2. **Behavior 缓存**：用 `extensionDownloadBehavior` Map 缓存每个 extension 的 download behavior，新 attach 的 page 自动继承
3. **事件转发**：将 page 级别的 `Page.downloadWillBegin` / `Page.downloadProgress` 合成为 `Browser.downloadWillBegin` / `Browser.downloadProgress` 转发给 Playwright

### 对 spawriter 的优化方案

#### 方案 A：Relay 层实现（推荐）

已在 `relay.ts` 中实现完整修复（详见代码提交）：

- `activeDownloadBehavior`：全局变量存储最近一次 `Browser.setDownloadBehavior` 的参数（last writer wins）
- `toPageDownloadParams()`：将 Browser behavior 映射为 Page behavior（`allowAndName` → `allow`）
- `applyDownloadBehaviorToAllPages()`：分发到所有已连接的 page target
- `applyDownloadBehaviorToTarget()`：新 attach 的 page 自动继承缓存的 behavior
- `maybeSynthesizeBrowserDownloadEvent()`：合成 `Browser.download*` 事件
- Extension 断开时清除缓存

#### 影响范围

- `mcp/src/relay.ts`：修改 `handleServerCdpCommand`、`handleExtensionMessage`
- 不影响 `mcp.ts` 和 `bridge.js`
- `pw-executor.ts`：当前不涉及下载功能，但修复后将自然受益

#### 测试建议

1. 单元测试：验证 `Browser.setDownloadBehavior` 被正确映射到 `Page.setDownloadBehavior`
2. 单元测试：验证新 attach 的 page 继承缓存的 behavior
3. 集成测试：通过 `playwright_execute` 触发下载，验证 `page.waitForEvent('download')` 能正常 resolve

---

## 2. [中优] Chrome API 防御性编程

### 问题

Playwriter 在 commit 36f3801 中发现 `chrome.contextMenus` 在某些环境（如测试环境、受限的 MV3 上下文）中可能为 `undefined`，导致 service worker 启动崩溃。

### spawriter bridge.js 现状分析

审查 `src/ai_bridge/bridge.js`，spawriter 当前使用的 Chrome API 及其防御状态：

| API | 使用位置 | 是否有防御 |
|-----|---------|-----------|
| `chrome.debugger.onEvent` | L164 | 无 |
| `chrome.debugger.onDetach` | L177 | 无 |
| `chrome.debugger.attach` | L534 | try-catch 包裹 |
| `chrome.debugger.sendCommand` | L364, L427, L436-540 | try-catch 包裹 |
| `chrome.debugger.detach` | L478 | try-catch 包裹 |
| `chrome.tabs.group` / `chrome.tabGroups.update` | L586-627 | ✅ 有防御检查 |
| `browser.tabs.query` | L104, L637, L703 | 无 |
| `browser.tabs.get` | L497, L529 | 无 |
| `browser.tabs.reload` | L660 | 无 |
| `browser.tabs.onRemoved` | L185 | 无 |
| `browser.tabs.onUpdated` | L191 | 无 |
| `browser.browsingData.remove` | L656 | 无 |
| `browser.runtime.onMessage` | L716 | 无 |

### 优化建议

**关键风险点**：`chrome.debugger` 系列 API 是 spawriter 的核心。虽然它们在正常 MV3 环境中一定存在，但 `chrome.debugger.onEvent.addListener` 和 `chrome.debugger.onDetach.addListener`（L164, L177）如果在 `debugger` 权限缺失时调用，会直接抛出异常导致整个 bridge 初始化失败。

推荐在 `ensureDebuggerEventListener()` 函数开头添加守卫：

```javascript
function ensureDebuggerEventListener() {
  if (debuggerEventListenerRegistered) return;
  if (!chrome.debugger?.onEvent || !chrome.debugger?.onDetach) {
    error("chrome.debugger API not available — extension may lack 'debugger' permission");
    return;
  }
  // ...existing listener registration...
}
```

对 `browser.browsingData.remove`（L656）也建议添加存在性检查，因为 `browsingData` 权限在某些场景可能缺失：

```javascript
async function clearCacheAndReload(tabId) {
  if (browser.browsingData?.remove) {
    await browser.browsingData.remove(
      { since: 0 },
      { cache: true, serviceWorkers: true }
    );
  }
  await browser.tabs.reload(tabId, { bypassCache: true });
}
```

**优先级判断**：spawriter 运行环境相对固定（用户自行安装、manifest 中声明了 `debugger` 权限），此问题为**预防性优化**而非紧急修复。但在未来如果 spawriter 拆分为精简版（去掉某些权限），这些守卫将变得关键。

---

## 3. [中优] Service Worker Keepalive 机制精简

### 问题

Playwriter 在 commit 1ced689 中发现其 `chrome.alarms` keepalive 是冗余的——`maintainLoop` 的 `while(true) + sleep(1000)` 和 `setInterval(checkMemory, 5000)` 已经足以保持 service worker 存活。

### spawriter bridge.js 现状分析

spawriter 使用的保活机制：

1. **`maintainLoop()`**（L664-681）：基于 `setTimeout(loop, 5000)` 递归调用，只在有 `attachedTabs` 时运行
2. **无 `chrome.alarms`**：spawriter manifest 中没有声明 `alarms` 权限，不存在冗余问题
3. **relay 端 ping**（`relay.ts` L772-776）：每 30 秒向 extension 发送 ping

### 分析结论

**spawriter 不存在此问题。** 其 keepalive 策略简洁明确：

- 有连接时：`maintainLoop` 的 5s interval 保活
- 无连接时：service worker 正常休眠（由 Chrome 管理）
- relay 端 ping 提供了额外的 heartbeat

但有一个细微风险：**当所有 tab 断开但 relay WebSocket 仍然连接时**，`maintainLoop` 会停止（L667 `if (attachedTabs.size === 0) return`），此时只有 relay 的 30s ping 可以唤醒 service worker。如果 Chrome 在 ping 间隔内终止了 service worker，WebSocket 连接会丢失。

**建议**：这是已知的 MV3 限制，当前实现可接受。如果未来发现 relay 连接不稳定，可以考虑将 `maintainLoop` 改为只要有 relay WebSocket 连接就运行，而不是仅在有 `attachedTabs` 时运行。

---

## 4. [中优] Cookie API 使用文档化

### 问题

Playwriter 在 commit 24db529 中记录了一个重要发现：extension 模式下 `Storage.getCookies` 是 root-session 命令，在 relay path 中不可用，**必须**使用 `Network.getCookies` 通过 page CDP session。

### spawriter 现状分析

spawriter 在 `mcp.ts` 中**已经正确使用 `Network.getCookies`**：

- `storage` tool 的 `get_cookies` action（L1940）：`Network.getCookies`
- `clear_cache_and_reload` 的 cookie 清理逻辑（L1564）：`Network.getCookies`

**spawriter 不存在此 bug。**

### 文档化建议

虽然代码正确，但文档中没有明确说明这个约束。建议在以下位置补充：

1. **`cursor-rules/spawriter.mdc`** Troubleshooting 表中添加：

```
| Cookie 读取失败 | spawriter 使用 `Network.getCookies`（非 `Storage.getCookies`）。
如果在 `playwright_execute` 中操作 cookie，必须通过 CDP session 的 
`Network.getCookies` 而非 `Storage.getCookies` |
```

2. **`skills/spawriter/SKILL.md`** 中无 cookie 相关内容，如果未来添加 `playwright_execute` cookie 操作示例，需使用 `Network.getCookies`。

3. **`docs/MCP_DEV_GUIDE.md`** 或 `docs/CDP_ENHANCEMENT_PLAN.md` 中记录设计决策：

```markdown
### Cookie API 选择

spawriter 使用 `Network.getCookies` 而非 `Storage.getCookies` 读取页面 cookie。
原因：extension relay 模式下，CDP 命令通过 page session 路由。
`Storage.getCookies` 是 root-session (Browser target) 命令，在 page session 上不可用。
`Network.getCookies` 是 page-level 命令，可正确工作。
```

---

## 优化路线图汇总

| 优先级 | 优化项 | 复杂度 | 文件 | 收益 |
|--------|--------|--------|------|------|
| **P1** | Browser.setDownloadBehavior → Page 映射 | 中 | `relay.ts` | 修复 extension 模式文件下载 |
| **P2** | Chrome API 防御性守卫 | 低 | `bridge.js` | 提高环境鲁棒性 |
| **P2** | Cookie API 约束文档化 | 低 | `spawriter.mdc`, docs | 防止未来误用 |
| **P3** | Service Worker keepalive 优化 | 低 | `bridge.js` | 预防性，当前不紧急 |

### 不需要行动的项

| Playwriter 提交 | 原因 |
|-----------------|------|
| `271cde8` SKILL.md 注释 | spawriter SKILL.md 不依赖 CLI 输出 |
| `9e31853` lockfile 重生成 | 纯 housekeeping |
| `3c19066` 版本发布 | 无关 |
| `4044f1f` logo 资源 | 品牌资源，不影响功能 |
| `df7476a` Prism 资源构建 | spawriter 无 welcome page 嵌入资源 |
