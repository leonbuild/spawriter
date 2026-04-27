# Tab 获取机制 — 完备审计、实施方案与优化文档

## 一、系统架构

```
┌──────────────┐     HTTP        ┌─────────────┐    CDP/WebSocket    ┌──────────────┐
│  CLI / MCP   │ ─────────────→  │    Relay     │  ←──────────────→  │  Extension   │
│  (agent端)   │  /cli/execute   │  relay.ts    │  connectTabByMatch │  bridge.js   │
│              │  /connect-tab   │              │  connectActiveTab  │              │
│              │  /cli/tab/claim │              │                    │              │
└──────────────┘                 └──────────────┘                    └──────────────┘
                                       │                                   │
                            ┌──────────┴──────────┐             ┌──────────┴──────────┐
                            │  tabOwners Map       │             │  tabOwnership Map   │
                            │  attachedTargets Map │             │  attachedTabs Map   │
                            │  (relay 侧状态)      │             │  (extension 侧状态)  │
                            └─────────────────────┘             └─────────────────────┘
```

### 核心概念

| 术语 | 定义 | 状态来源 |
|------|------|----------|
| **Attached tab** | 已由 extension 连接 debugger 的标签页，在 relay 和 extension 两侧均有记录 | `attachedTargets` / `attachedTabs` |
| **Owned/Claimed tab** | 已分配给某 session 的 attached tab | `tabOwners.get(tabId) !== undefined` |
| **Idle tab** | Attached 但无 owner 的标签页。Extension 显示 "idle" 状态 | `attached && !owned` |
| **Safe URL tab** | URL 为 `about:blank` / `chrome://newtab/` / `edge://newtab/` 的标签页 | `isSafeAutoReuseUrl()` |
| **User tab** | 用户主动打开的浏览器标签页 — 非 safe-URL、非 agent 管理 | 不在 `attachedTabs` 中 |

---

## 二、全部 Tab 获取路径审计

### 路径 A：`/cli/execute` 自动获取（relay.ts:1317-1387）

**触发时机**：每次 agent 执行代码时。这是最核心、最频繁的路径。

```
A1. executor.getActiveTabId() != null
    → 使用已有活跃 tab（无需获取）

A2. getOwnedTabs(sessionId) 非空
    → 从已 own 的 tab 中选（优先 URL 匹配，否则第一个）

A3. pickReusableAttachedTab(urlHint)
    ├── A3a. URL hint 匹配已 attached 未 owned 的 tab → claim        ← 可能取到用户 tab
    ├── A3b. Safe-URL 的未 owned attached tab → claim                 ← OK
    └── A3c. 任意未 owned attached tab → claim                        ← ⚠️ 夺取用户 tab

A4. Extension: connectTabByMatch({ url: urlHint, create: false })
    → extension 搜索所有浏览器 tab（browser.tabs.query({})）
    → pickBestMatchingTab()                                           ← ⚠️ 可匹配到用户 tab

A5. Extension: connectTabByMatch({ url: 'about:blank', forceCreate: true })
    → 创建新 tab                                                      ← OK
```

**问题**：
- **A3c** (`relay.ts:225-230`)：`candidates[0]` fallback 会取到任意 unclaimed attached tab
- **A4** (`relay.ts:1356-1370`)：`create: false` 导致 extension 搜索全部浏览器 tab

### 路径 B：`/cli/tab/claim` 显式 claim（relay.ts:1474-1486）

**触发时机**：CLI `session bind` / MCP `tab connect` 成功后调用。

```
B1. 接收 { tabId, sessionId, force? }
B2. claimTab(tabId, sessionId, force?)
B3. executor.claimTab(tabId, url)
```

**评估**：显式操作，用户/agent 主动指定 tabId。无问题。

### 路径 C：`/connect-tab` 转发（relay.ts:331-365）

**触发时机**：MCP `tab { action: "connect" }` 调用。

```
C1. 转发到 extension: connectTabByMatch(body)
    → 同路径 A4 的 extension 处理逻辑                                  ← ⚠️ 同 A4 的问题
```

### 路径 D：MCP `tab { action: "connect" }`（mcp.ts:255-323）

**触发时机**：MCP 工具主动连接 tab。

```
D1. requestConnectTab(port, { url, tabId, create })
    → POST /connect-tab → extension connectTabByMatch
D2. 成功 → POST /cli/tab/claim
D3. claim 失败 && create=true → retry with forceCreate: true         ← OK
```

**问题**：D1 走 `/connect-tab` 路径，同 C1。

### 路径 E：MCP `tab { action: "switch" }`（mcp.ts:326-359）

**触发时机**：agent 主动切换 tab。

```
E1. 查找 target in attached targets
E2. 未 owned → POST /cli/tab/claim
E3. executor.claimTab + switchToTab
```

**评估**：用户显式提供 tabId，已知 attached tab。无问题。

### 路径 F：Execute 中的防御性 auto-claim（relay.ts:1397-1414）

**触发时机**：active tab 存在但未 claim。

```
F1. activeTabId 存在但 getTabOwner() == undefined
F2. claimTab(activeTabId, sessionId)
```

**评估**：对已在用的 tab 补充 ownership。无问题。

### 路径 G：CDP `Target.claimTab`（relay.ts:868-886）

**触发时机**：CDP 协议层 claim 命令。

```
G1. 收到 CDP 消息 → claimTab(tabId, sessionId, force?)
```

**评估**：低层协议命令。无问题。

### 路径 H：`/connect-active-tab`（relay.ts:297-329）

**触发时机**：外部调用。

```
H1. 发送到 extension: connectActiveTab
H2. extension: ensureActiveTabAttached()
    → 获取用户当前活跃标签页                                           ← ⚠️ 直接抢占用户活跃 tab
```

**评估**：此端点被设计为用于用户手动触发。但如果 agent 调用，会直接抢占用户正在使用的 tab。

### 路径 I：Extension `connectTabByMatch` 无参数 fallback（bridge.js:1011）

**触发时机**：`connectTabByMatch` 既没有 `url` 也没有 `tabId` 时。

```
I1. 无 url、无 tabId
I2. ensureActiveTabAttached()
    → 同路径 H2                                                       ← ⚠️ 抢占用户活跃 tab
```

### 路径 J：过期 Session 清理（relay.ts:264-277）

```
J1. 定时检查 sessionActivity
J2. 超过 30 分钟不活跃 → releaseAllTabs(sessionId)
```

**评估**：仅释放 tab，不获取。无问题。

### 路径 K：Target 替换（relay.ts:964-969）

```
K1. 同一 tabId 出现不同 CDP sessionId
K2. 删除旧条目，释放 ownership
```

**评估**：清理逻辑。无问题。

---

## 三、Extension 侧关键函数审计

### `pickBestMatchingTab(allTabs, urlHint)`（bridge.js:134-139）

```javascript
function pickBestMatchingTab(allTabs, urlHint) {
  const matches = allTabs
    .filter((tab) => tab?.id != null && tabMatchesHint(tab, urlHint))
    .sort((a, b) => tabReuseScore(a) - tabReuseScore(b));
  return matches[0];
}
```

**问题**：`allTabs` 来自 `browser.tabs.query({})`，包含所有浏览器 tab。

### `tabReuseScore(tab)`（bridge.js:123-132）

| Score | 状态 | 风险 |
|-------|------|------|
| 0 | attached + 未 owned（idle） | 低 — spawriter 管理的空闲 tab |
| **1** | **未 attached + 未 owned** | **高 — 用户自己的普通 tab** |
| 2 | attached + owned | 阻止 — 另一个 agent 的 tab |
| 3 | 其他 | N/A |

**问题**：Score 1 允许匹配到从未被 spawriter 管理过的用户 tab。

### `tabMatchesHint(tab, rawUrlHint)`（bridge.js:94-121）

```javascript
// URL 匹配
tabUrl.includes(rawHint) || (normalizedHint && tabUrl.includes(normalizedHint))
// Title 匹配
tabTitle.includes(rawHint)
```

**问题**：宽松的 `includes` 匹配。如 hint=`"example"` 会匹配 `"https://totally-different-example.com"`。

### `ensureActiveTabAttached()`（bridge.js:828-841）

```javascript
async function ensureActiveTabAttached() {
  const activeTab = await getActiveTab();  // 获取用户当前活跃 tab
  if (!activeTab?.id) throw new Error("No active tab found");
  // ... 直接 attach debugger
}
```

**问题**：无条件抓取用户活跃 tab。

---

## 四、问题汇总

| 编号 | 位置 | 严重度 | 描述 |
|------|------|--------|------|
| **P1** | `relay.ts` `pickReusableAttachedTab()` L225 | **高** | `candidates[0]` fallback 取任意 unclaimed attached tab |
| **P2** | `relay.ts` execute handler L1356-1370 | **高** | `connectTabByMatch(create:false)` 搜索全部浏览器 tab |
| **P3** | `bridge.js` `pickBestMatchingTab()` L134 | **高** | Score 1 允许匹配用户未 attached tab |
| **P4** | `bridge.js` `connectTabByMatch` fallback L1011 | **中** | 无参数时 fallback 到 `ensureActiveTabAttached()` 抢用户 tab |
| **P5** | `bridge.js` `tabMatchesHint()` L108-121 | **中** | 宽松的 title includes 可匹配不相关 tab |
| **P6** | `mcp.ts` connect action L263 | **中** | 使用同样有问题的 `/connect-tab` 路径 |

---

## 五、目标行为规范

### 用户期望

> 1. 先从 idle tab 中查找目标地址 — 有就使用
> 2. 如果没有匹配 URL 的 idle tab — 从 idle 中随机取一个
> 3. 如果没有 idle tab — 新开 tab，不从已有 tab 获取

### 设计原则

1. **永不干扰用户 tab** — 只使用 spawriter 管理的 idle attached tab 或新创建的 tab
2. **URL hint 匹配仅限 idle pool** — 不搜索用户浏览器 tab
3. **新建 tab 永远安全** — 优先于夺取
4. **随机选取避免偏差** — 多个 idle tab 时随机选择

---

## 六、实施方案

### 6.1 修改 `pickReusableAttachedTab()`

**文件**：`spawriter/src/relay.ts`，行 197-231

**当前代码**（问题部分）：

```typescript
// L216-230：当前 fallback 逻辑
const safeCandidate = candidates.find(candidate => candidate.safe);
if (safeCandidate) {
  return {
    tabId: safeCandidate.tabId,
    url: safeCandidate.url,
    reason: preferredUrlHint ? 'safe-fallback' : 'safe-reuse',
  };
}

// ⚠️ 问题：取任意 unclaimed tab
const firstCandidate = candidates[0];
return {
  tabId: firstCandidate.tabId,
  url: firstCandidate.url,
  reason: preferredUrlHint ? 'idle-fallback' : 'idle-reuse',
};
```

**修改为**：

```typescript
// 从 safe-URL tab 中随机选取
const safeCandidates = candidates.filter(c => c.safe);
if (safeCandidates.length > 0) {
  const pick = safeCandidates[Math.floor(Math.random() * safeCandidates.length)];
  return {
    tabId: pick.tabId,
    url: pick.url,
    reason: preferredUrlHint ? 'safe-fallback' : 'idle-random',
  };
}

// 无 idle tab → 返回 null → 调用方将新建 tab
return null;
```

**变更说明**：
- 删除 `candidates[0]` fallback（P1 修复）
- Safe tab 改为随机选取（代替 `find` 的确定性选取）
- 无 safe tab 时返回 null

### 6.2 简化 Execute Handler 的 Extension 调用

**文件**：`spawriter/src/relay.ts`，行 1341-1385

**当前代码**（两阶段获取）：

```typescript
if (executor.getActiveTabId() == null && isExtensionConnected()) {
  const claimConnectedTab = async (tabId: number, fallbackUrl: string): Promise<boolean> => {
    // ... 等待 tab attach，然后 claim
  };

  let tabPrepared = false;
  // 阶段 1：搜索已有 tab（⚠️ 问题：搜索全部浏览器 tab）
  if (targetUrlHint) {
    try {
      const result = await sendExtensionCommand('connectTabByMatch', {
        url: targetUrlHint,
        create: false,   // ← 不创建，搜索已有
      });
      if (result.success && typeof result.tabId === 'number') {
        tabPrepared = await claimConnectedTab(result.tabId as number, targetUrlHint);
      }
    } catch (e: any) { ... }
  }

  // 阶段 2：新建 tab
  if (!tabPrepared) {
    try {
      const result = await sendExtensionCommand('connectTabByMatch', {
        url: 'about:blank',
        forceCreate: true,
      });
      if (result.success && typeof result.tabId === 'number') {
        tabPrepared = await claimConnectedTab(result.tabId as number, 'about:blank');
      }
    } catch (e: any) { ... }
  }
}
```

**修改为**（合并为单阶段 forceCreate）：

```typescript
if (executor.getActiveTabId() == null && isExtensionConnected()) {
  try {
    const createUrl = targetUrlHint || 'about:blank';
    const result = await sendExtensionCommand('connectTabByMatch', {
      url: createUrl,
      forceCreate: true,
    });
    if (result.success && typeof result.tabId === 'number') {
      for (let i = 0; i < 20; i++) {
        if ([...attachedTargets.values()].find(t => t.tabId === result.tabId)) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const claim = claimTab(result.tabId as number, body.sessionId);
      if (claim.ok) {
        const tabUrl = [...attachedTargets.values()]
          .find(t => t.tabId === result.tabId)?.targetInfo?.url || createUrl;
        executor.claimTab(result.tabId as number, tabUrl);
        log(`Created new tab ${result.tabId} for session ${body.sessionId}${
          targetUrlHint ? ` (hint: ${targetUrlHint})` : ''
        }`);
      }
    }
  } catch (e: any) {
    log(`Tab creation failed for session ${body.sessionId}: ${e.message}`);
  }
}
```

**变更说明**：
- 删除 `create: false` 阶段（P2 修复）
- 始终使用 `forceCreate: true`
- 如有 URL hint，直接创建带该 URL 的新 tab
- 代码行数从 ~45 行减少到 ~20 行

### 6.3 限制 Extension 的 `pickBestMatchingTab`

**文件**：`extension/src/ai_bridge/bridge.js`，行 134-139

**当前代码**：

```javascript
function pickBestMatchingTab(allTabs, urlHint) {
  const matches = allTabs
    .filter((tab) => tab?.id != null && tabMatchesHint(tab, urlHint))
    .sort((a, b) => tabReuseScore(a) - tabReuseScore(b));
  return matches[0];
}
```

**修改为**：

```javascript
function pickBestMatchingTab(allTabs, urlHint) {
  const matches = allTabs
    .filter((tab) => tab?.id != null && tabMatchesHint(tab, urlHint))
    .filter((tab) => attachedTabs.has(tab.id) && !isTabOwned(tab.id))
    .sort((a, b) => tabReuseScore(a) - tabReuseScore(b));
  return matches[0];
}
```

**变更说明**：
- 新增 `.filter((tab) => attachedTabs.has(tab.id) && !isTabOwned(tab.id))`（P3 修复）
- 仅在 idle attached tab 中搜索
- 作为纵深防御，确保 MCP `connect` 等路径也不会触及用户 tab

### 6.4 移除 `connectTabByMatch` 无参数 fallback

**文件**：`extension/src/ai_bridge/bridge.js`，行 1011-1012

**当前代码**：

```javascript
// 无 url、无 tabId 时 fallback
const activeTabId = await ensureActiveTabAttached();
return { success: true, tabId: activeTabId };
```

**修改为**：

```javascript
return { success: false, error: "No url or tabId provided" };
```

**变更说明**：
- 移除 `ensureActiveTabAttached()` fallback（P4 修复）
- 无参数时返回错误而非抢占用户活跃 tab
- `connectActiveTab` 仍可通过单独端点 `/connect-active-tab` 使用（用户主动触发场景）

### 6.5 更新测试

**文件**：`spawriter/src/relay.test.ts`

需更新的测试：

| 测试 | 当前断言 | 修改为 |
|------|---------|--------|
| `pickReusableTab` 无 safe tab 时 (L1125-1128) | 返回 `idle-reuse` reason | 返回 `null` |
| `pickReusableTab` 有 safe + non-safe 时 | 可能返回 non-safe | 只返回 safe |

需新增的测试：

| 测试 | 断言 |
|------|------|
| `pickReusableAttachedTab` 仅有 non-safe unclaimed tab | 返回 `null` |
| `pickReusableAttachedTab` 多个 safe tab | 返回其中一个（随机） |
| Extension `pickBestMatchingTab` 过滤非 idle tab | 不返回未 attach 的 tab |

---

## 七、行为对比矩阵

| 场景 | 当前行为 | 优化后行为 |
|------|---------|-----------|
| Agent 需要 tab，有 idle about:blank | 使用 idle tab | 使用 idle tab（多个时随机） |
| Agent 需要 tab，无 idle 但有用户 tab | **夺取用户 tab** | **新建 tab** |
| Agent 需要 `example.com`，idle tab 在该 URL | 复用 | 复用 |
| Agent 需要 `example.com`，用户 tab 在该 URL（未 attach） | **夺取用户 tab** | **新建 tab 并导航** |
| Agent 需要 `example.com`，idle attached tab 在该 URL | 复用 | 复用 |
| 两个 agent 同时启动，仅 1 个 idle tab | 一个得到，另一个夺用户 tab | 一个得到，另一个新建 tab |
| Extension 未连接，无 idle tab | 取任意 attached tab | 返回错误 |
| MCP `tab connect { url: "...", create: true }` | 先搜全部 tab | 仅搜 idle tab，无则创建 |
| `connectTabByMatch` 无参数 | 抢用户活跃 tab | 返回错误 |

---

## 八、实施优先级

| 优先级 | 变更 | 涉及文件 | 代码量 | 影响 |
|--------|------|----------|--------|------|
| **P0** | 移除 `candidates[0]` non-safe fallback | relay.ts | ~5 行 | 阻止 relay 侧 tab 窃取 |
| **P0** | 移除 `create: false` 搜索，始终 `forceCreate` | relay.ts | ~25 行 | 阻止 extension 侧 tab 窃取 |
| **P1** | 限制 `pickBestMatchingTab` 仅匹配 idle tab | bridge.js | 1 行 | 纵深防御 |
| **P1** | 移除无参数 fallback 到 active tab | bridge.js | 2 行 | 阻止无参数时抢 active tab |
| **P2** | Safe tab 随机选取 | relay.ts | 2 行 | 公平分配 |
| **P2** | 更新测试 | relay.test.ts | ~25 行 | 验证新行为 |

**总代码变更**：~60 行修改，净减少 ~20 行

---

## 九、风险评估与缓解

| 风险 | 概率 | 缓解策略 |
|------|------|----------|
| Agent 找不到 tab（无 idle、extension 未连接） | 低 | 清晰错误信息 + CLI 提示。行为同当前 Step 5 |
| 比之前创建更多 tab | 中 | 过期 session 清理（30 分钟）自动释放 tab。Extension tab group 保持整洁 |
| 新建 tab 比复用稍慢 | 中 | `browser.tabs.create()` + 等待 attach 约 1-2 秒。可接受 |
| MCP `connect { create: false }` 不再匹配用户 tab | 低 | 已有 fallback 到 `forceCreate: true`（mcp.ts:288-304） |
| 打破现有 agent 使用习惯 | 低 | idle tab 复用逻辑不变，仅移除越界行为 |

---

## 十、回滚方案

所有变更均为行为收紧（减少匹配范围），不涉及数据结构变化：

1. **relay.ts 变更**：恢复 `pickReusableAttachedTab()` 的 `candidates[0]` fallback 和两阶段 extension 调用
2. **bridge.js 变更**：移除 `.filter(idle)` 和恢复 `ensureActiveTabAttached()` fallback
3. 无需数据迁移，无需重启 session

---

## 十一、验证清单

- [ ] 新 session 无 idle tab 时 → 自动新建 tab，不影响用户浏览器
- [ ] 新 session 有 about:blank idle tab → 复用
- [ ] 新 session 有多个 idle tab → 随机选取其中一个
- [ ] 新 session 有 URL 匹配的 idle tab → 复用
- [ ] 两个 session 同时启动 → 各自获得独立 tab
- [ ] MCP `tab connect { url: "..." }` → 仅匹配 idle tab 或新建
- [ ] MCP `tab connect { url: "...", create: true }` → 同上
- [ ] Extension 未连接时 → 返回清晰错误
- [ ] 长时间不活跃 session → 30 分钟后自动释放 tab
