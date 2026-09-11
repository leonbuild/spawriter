# spawriter 多 Import Map Override UI 实施手册

## 1. 结论

当前扩展不能在 UI 中完整展示多个 import map。它只用 `getRawAppData()` 生成行，因此只能看到已经向 single-spa 注册的应用；基础依赖、未注册的 `@scope/name` import、仅存在于 override 或扩展存储中的名称都会被隐藏。

现有页面能力足够实现该功能，不需要自行推断多个 import map 的覆盖顺序。在线页面已经验证：

- `window.importMapOverrides.getDefaultMap()` 自动合并两个外部 import map，返回 15 个顶层 `imports`。
- `window.importMapOverrides.getOverrideMap()` 返回当前真正生效的 override。
- `window.importMapOverrides.getCurrentPageMap()` 返回合并默认值与 override 后的当前有效 map。
- 两个外部文件分别是 `/maps/importmap-dependency.json` 和 `/maps/importmap-app.json`。
- 当前页面有 10 个 `@scope/name` import、5 个裸名称 dependency、7 个真正注册到 single-spa 的应用。

目标实现应允许所有合法 import name 被 override。名称样式只用于 UI 分类，不能再用于权限限制：

- 匹配 `^@[^/]+/.+`：归入 App 区域。
- 其他非空名称，例如 `single-spa`、`single-spa-vue`、`axios`：归入 Dependency 区域。

App 区域固定显示在上方；Dependency 区域显示在下方并可折叠。Dependency 没有 active override 时初始折叠；只要存在 active dependency override，初始化和新变化发生时都自动展开。

同步正确性优先于界面便利性。UI 不得再把扩展保存的 `enabled` 当成页面实际状态。

## 2. 已核实的在线页面状态

目标页面：`https://dev-journal.aifed.cn/j/demo/my/manage/user-roles`

`getDefaultMap()` 返回的合并结果为：

```json
{
  "imports": {
    "single-spa": "/js/single-spa.min.js",
    "single-spa-vue": "/js/single-spa-vue.js",
    "axios": "/js/axios.min.js",
    "core-js": "/js/core-js-index.js",
    "moment": "/js/moment.min.js",
    "@cnic/i18n": "/i18n/i18n.json",
    "@cnic/site-setting": "/config/config.json",
    "@cnic/root-config": "/cnic-root-config.js",
    "@cnic/main": "/app/main/app.js",
    "@journal/submit": "/app/submit/app.js",
    "@journal/review": "/app/review/app.js",
    "@journal/proofread": "/app/proofread/app.js",
    "@journal/edit": "/app/edit/app.js",
    "@journal/publish": "/app/publish/app.js",
    "@journal/manage": "/app/manage/app.js"
  }
}
```

真正注册到 single-spa 的 7 个应用是：

```text
@cnic/main
@journal/edit
@journal/manage
@journal/proofread
@journal/publish
@journal/review
@journal/submit
```

因此“App 分类”和“single-spa lifecycle app”必须分开建模。例如 `@cnic/i18n` 按产品规则属于 App 区域，但没有 Mount/Unmount 动作。

现场还确认了当前同步缺陷：页面 `getOverrideMap()` 和 `localStorage` 都为空，但 dashboard 的 `activeOverrides` 仍保留旧的 `@journal/edit`，说明当前 `overrides` React state 没有随轮询结果刷新。

## 3. 当前代码的关键问题

| 位置 | 当前行为 | 必须修改的原因 |
|---|---|---|
| `extension/src/panel-app.js` | 只读取 `getRawAppData()` | 无法发现多个 import map 中的全部名称 |
| `extension/src/panel-app/apps.component.js` | 只遍历 `props.apps` | dependency、import-only app、orphan override 均不可见 |
| `useImportMapOverrides.js#getImportMapOverrides` | 初始化时读取一次 `getOverrideMap()` | `overrides`/dashboard 会陈旧 |
| `detectExternalChanges` | 只更新 `savedOverrides` | UI 实际状态与页面状态不是同一快照 |
| `isScopedPackage` | 拒绝和清除裸名称 | 与“所有 import 均可 override”的新需求冲突 |
| `apps.component.js#isValidOverrideUrl` | 强制 URL 以 `.js` 结束 | `@cnic/i18n`、`@cnic/site-setting` 等 JSON import 无法使用 |
| Export | 只导出 `props.apps` 的 URL | dependency、enabled 和 orphan 状态丢失 |
| Import | 任意对象直接写入 storage | 缺少 name、URL、记录结构和数量边界验证 |
| `spa-helpers.ts` | MCP/CLI 拒绝 bare package | UI 与 agent 行为将不一致 |
| `extension/build/panelApp.js` | 构建产物可能落后于 `src` | 重载扩展后仍可能运行旧逻辑 |

当前 `apps.component.js` 约 1032 行，`useImportMapOverrides.js` 约 952 行。不要继续把目录发现、同步、storage、UI 和 CSS 堆进这两个文件，应在本次实现中按职责拆分。

## 4. 数据源与权威规则

保留两套存储，但明确职责：

| 数据 | 来源 | 权威范围 |
|---|---|---|
| 默认 import 清单和默认 URL | `getDefaultMap()` | 目录与默认值 |
| 页面实际 active override | `getOverrideMap()` | UI 开关和当前 override URL |
| 当前有效 URL | `getCurrentPageMap()` | 诊断与验证 |
| 保存的 URL 和期望 enabled | `browser.storage.local` | 跨刷新恢复意图 |
| lifecycle status | `getRawAppData()` | Mount/Unmount 状态与动作 |

最重要的规则：

1. UI 的 Toggle `checked` 必须来自 `activeOverrides`，不得来自 `savedOverrides[name].enabled`。
2. `savedOverrides.enabled` 只表示期望恢复状态。
3. 初始化恢复完成后，页面实际状态成为稳态权威；外部变化同步回 storage。
4. 任何不一致都必须进入显式的 `syncStatus`，不能静默显示为已同步。

## 5. 统一快照

每次刷新应在一次 inspected-page evaluation 中取得一致快照，避免连续多个 `evalCmd` 跨越页面变化：

```js
async function readImportMapSnapshot() {
  return evalCmd(`(async function () {
    const imo = window.importMapOverrides;
    const devtools = window.__SINGLE_SPA_DEVTOOLS__?.exposedMethods;
    if (!imo) return { available: false };

    const [defaultMap, currentPageMap] = await Promise.all([
      typeof imo.getDefaultMap === "function"
        ? imo.getDefaultMap()
        : Promise.resolve(null),
      typeof imo.getCurrentPageMap === "function"
        ? imo.getCurrentPageMap()
        : Promise.resolve(null)
    ]);
    const overrideMap = imo.getOverrideMap?.() || { imports: {}, scopes: {} };
    const registeredApps = devtools?.getRawAppData?.() || [];

    return {
      available: true,
      pageUrl: location.href,
      origin: location.origin,
      defaultImports: defaultMap?.imports || {},
      activeOverrides: overrideMap?.imports || {},
      effectiveImports: currentPageMap?.imports || {},
      overrideScopes: overrideMap?.scopes || {},
      registeredApps: registeredApps.map(app => ({
        name: app.name,
        status: app.status,
        devtools: app.devtools
      }))
    };
  })()`);
}
```

生产代码在拼接 name 和 URL 到 inspected-page JavaScript 时必须使用 `JSON.stringify`，不能继续直接插入字符串模板。

### 多 Import Map 兼容策略

首选 `getDefaultMap()`，因为它返回 import-map-overrides 按自身规则合并后的最终默认 map，天然支持：

- 多个外部 `systemjs-importmap`；
- inline import map；
- 页面自身的 map 合并规则；
- 相同名称的最终解析结果。

兼容旧版本 import-map-overrides 时按以下顺序降级：

1. `getDefaultMap()`；
2. `getCurrentPageMap()`，同时把默认 URL 标记为可能包含 override；
3. 读取 `script[type="systemjs-importmap"], script[type="importmap"], script[type="importmap-shim"]`，解析 inline JSON，并在页面上下文 fetch 外部 JSON；
4. 任一来源失败时保留已经读取到的其他 map，并在 UI 显示部分加载警告，不能把整个面板置空。

DOM fallback 只用于缺少 API 的页面，不参与正常路径的覆盖顺序判断。

## 6. 目录合并与分类

不得仅使用 default map 生成 UI。完整目录必须是以下名称的并集：

```text
defaultImports
∪ activeOverrides
∪ savedOverrides
∪ registeredApps
```

这保证以下对象始终可见：

- 多个 import map 中的所有默认 import；
- 外部工具刚添加的 override；
- 当前 map 已删除但 storage 仍保存的 orphan；
- 已注册但暂时不在 default map 中的 single-spa app。

纯函数模型建议放在 `import-map-model.js`：

```js
export function classifyImportName(name) {
  return /^@[^/]+\/.+/.test(name) ? "app" : "dependency";
}

export function buildImportEntries(snapshot, savedOverrides) {
  const names = new Set([
    ...Object.keys(snapshot.defaultImports),
    ...Object.keys(snapshot.activeOverrides),
    ...Object.keys(savedOverrides),
    ...snapshot.registeredApps.map(app => app.name)
  ]);
  // 返回排序前的统一 row model
}
```

每一行使用统一结构：

```js
{
  name,
  kind,                  // app | dependency
  defaultUrl,
  savedUrl,
  activeOverrideUrl,
  effectiveUrl,
  desiredEnabled,
  actualEnabled,
  registered,
  lifecycleStatus,
  sourceState,           // default | saved-only | active-only | registered-only
  syncStatus             // synced | restoring | applying | drift | error
}
```

判断 active 必须用属性存在性，不能用 URL truthiness：

```js
const actualEnabled = Object.prototype.hasOwnProperty.call(activeOverrides, name);
```

## 7. 同步状态机

### 7.1 生命周期

```text
INITIALIZING
  → RESTORING
  → READY
  → APPLYING(name, operationId)
  → RELOADING
  → VERIFYING
  → READY | ERROR
```

### 7.2 初始化

1. 读取当前 origin。
2. 并行读取 import-map 快照和 origin-scoped `savedOverrides`。
3. 立即用并集渲染 UI，active 状态取自快照。
4. 将 storage 中的 `enabled` 视为恢复意图，计算需要 add/remove 的差异。
5. 先验证所有要启用的 URL，再批量调用 API。
6. 所有变更完成后最多 reload 一次，不能每行 reload。
7. reload 后读取新快照并逐项验证。
8. 成功后进入 READY；失败行进入 ERROR，并显示实际状态。

### 7.3 UI 操作

启用：

1. 校验 name 和 URL。
2. 设置该行 `syncStatus=applying`，生成递增 `operationId`。
3. 保存 `{url, enabled:true}`。
4. 调用 `addOverride` 并读回 `getOverrideMap()`。
5. reload 一次。
6. reload 后再次读回；只有实际存在时 Toggle 才显示 ON。

禁用：

1. 保存 `{url, enabled:false}`，保留 URL。
2. 调用 `removeOverride`。
3. reload 并读回。
4. 实际不存在后显示 OFF。

保存新 URL且当前已启用：

1. 预检新 URL。
2. 保存新 URL。
3. 调用 `addOverride(name, newUrl)` 替换 active URL。
4. reload、读回并验证。

### 7.4 外部变化

外部变化包括 localStorage 手工修改、import-map-overrides 原生 UI、其他扩展和 MCP/CLI。

刷新触发源：

- panel 首次显示；
- single-spa routing event；
- `tab-updated`；
- DevTools panel 再次显示；
- 3 秒低频兜底轮询。

READY 状态下发现外部变化时：

- 新增或 URL 改变：立即更新 `activeOverrides`，并写入 `{url: actualUrl, enabled:true}`。
- 删除：立即更新 `activeOverrides`，保留 saved URL，但写入 `enabled:false`。
- UI 先显示页面实际状态，再完成 storage 持久化。
- 内部操作只屏蔽同名行，不要用全局 8 秒冷却阻断其他名称同步。

每次刷新都必须同时 `setActiveOverrides(snapshot.activeOverrides)`；这是修复当前 dashboard 陈旧状态的必要条件。

### 7.5 防止循环

为每个 name 保存 pending operation：

```js
pendingByName[name] = {
  id,
  expectedEnabled,
  expectedUrl,
  startedAt
};
```

轮询遇到 pending name 时只做读回验证，不将短暂中间态当成外部修改。验证成功或超时后删除 pending。不要依赖固定 8 秒 cooldown。

## 8. UI 设计

建议布局：

```text
┌ Applications (10) ──────────────────────────────────────────────┐
│ Name                Status          Actions       Override       │
│ @cnic/main          MOUNTED         Unmount ...   [on] URL Edit  │
│ @cnic/i18n          IMPORT ONLY     —             [off] URL Edit │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘

▸ Dependencies (5) · 0 active

[Clear Cache & Refresh]
```

有 active dependency override 时：

```text
▾ Dependencies (5) · 1 active
┌─────────────────────────────────────────────────────────────────┐
│ single-spa         OVERRIDDEN      —             [on] URL Edit  │
│ single-spa-vue     DEFAULT         —             [off] URL Edit │
│ axios              DEFAULT         —             [off] URL Edit │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

### App 区域

- 显示所有 `kind=app` 条目，而不只是 registered apps。
- registered app 显示现有 lifecycle status 和 Mount/Unmount/Reset。
- 未注册的 scoped import 显示 `IMPORT ONLY`，Actions 显示 `—`。
- Override 控件对两类 app 都可用。

### Dependency 区域

- 折叠按钮显示总数和 active 数量。
- 初始值：`activeDependencyCount > 0` 时展开，否则折叠。
- READY 后 dependency 从 0 变为 active 时自动展开。
- 用户手动折叠后可以保持折叠，直到出现新的 active dependency；新的 active 必须再次展开并聚焦/高亮对应行。
- dependency 不显示 Mount/Unmount，只显示 `DEFAULT`、`OVERRIDDEN`、`SYNCING` 或 `ERROR`。

### 行内状态

- Toggle 颜色不能是唯一状态信息；增加文本 badge。
- active URL 与 saved URL 不一致时显示 `DRIFT`，并同时展示实际 URL。
- `saved-only` 或 `active-only` 名称必须显示 `ORPHAN` 标识，禁止静默隐藏。
- 输入框激活时显示 active URL；关闭时显示 saved URL；默认 URL作为 title 或次级文本显示。

### 可访问性

- Dependency 标题使用原生 `button`，带 `aria-expanded` 和 `aria-controls`。
- Toggle 必须有包含 import name 的可访问名称。
- 折叠区域使用稳定 id，键盘 Enter/Space 可切换。
- 状态同时提供文字、颜色和错误说明。
- 窄 DevTools 面板允许表格区域横向滚动，不截断操作按钮。

## 9. URL 校验与失败恢复

删除“必须以 `.js` 结尾”的限制。允许 JSON、JS 和其他可被 SystemJS/import map 消费的 HTTP(S) 资源。

校验规则：

- name 必须是非空字符串，并限制合理长度，例如 1–512。
- URL 必须是非空字符串，并限制合理长度，例如不超过 4096。
- 使用 `new URL(value, pageOrigin)` 支持绝对 URL和 `/path` 相对 URL。
- 只允许 `http:` 和 `https:`；默认拒绝 `javascript:`、`data:`、`file:`。
- 预检必须识别 HTTP 200 的 HTML fallback；`text/html` 或正文以 `<html`/`<!doctype` 开头应判失败。
- HEAD 返回 405 时可降级为 GET；不能只根据 `response.ok` 判定成功。
- 跨域 CORS 失败必须明确报告，因为 SystemJS 随后也无法加载。

Dependency override 风险更高，启用时显示提示，但不能禁止用户操作。

在 reload 前把本次变更记录为 pending transaction。若 reload 后目标 import 不存在、页面核心 devtools 从可用变为不可用，或捕获到目标 URL解析错误，则只回滚该 name 的 localStorage key，并再次 reload。不得调用 `localStorage.clear()`。

即使 single-spa 本身加载失败，面板也必须能够恢复：Override Manager 不应依赖 `getRawAppData()` 成功后才挂载。`PanelRoot` 应在 `importMapOverrides` 可用时渲染目录；lifecycle 区域可以单独显示不可用提示。

## 10. Storage、迁移与导入导出

继续使用 origin-scoped key：

```text
savedOverrides:${origin}
```

保留结构：

```js
{
  [importName]: {
    url: string,
    enabled: boolean
  }
}
```

迁移要求：

- 移除当前“清除所有 bare package”的迁移代码。
- 不删除已有 `single-spa`、`axios` 等记录。
- 对缺少 `enabled` 的旧记录补 `false`。
- 丢弃 name/url 非字符串、空 name、危险 scheme 和超长记录。
- migration 写入成功后再提高 `storageSchemaVersion`。

建议导出格式升级为：

```json
{
  "version": 2,
  "origin": "https://dev-journal.aifed.cn",
  "overrides": {
    "@journal/edit": {
      "url": "http://localhost:9130/app.js",
      "enabled": false
    },
    "single-spa": {
      "url": "/js/single-spa.min.js",
      "enabled": true
    }
  }
}
```

导出必须覆盖目录并集中的所有 saved/active 项；不得再只遍历 `props.apps`。导入可以一次性兼容旧的 `{name: url}` 格式，转换后统一存为 v2。导入完成后应批量应用，最多 reload 一次。

Reset All 必须清除 App 和 Dependency 的 active/saved override；确认文案显示两类数量。可额外提供每个区域独立 Reset，但不是首批必需项。

## 11. MCP/CLI 一致性

当前 `02ace2b` 提交新增了 bare package 拒绝逻辑，与新需求冲突。应修改而不是保留两套规则：

- 删除 `spa-helpers.ts#isScopedPackage` 和 `buildOverrideCode(set)` 的 bare-name 拒绝。
- 参数名称和描述从 `appName` 调整为兼容性的 `importName`；若暂时保留字段名，文档必须说明它接受 dependency name。
- `override_set/remove/enable/disable` 对两类名称行为一致。
- `mount/unmount/unload` 仍只接受真正的 registered app。
- `single_spa status` 返回 `defaultImports`、`activeOverrides`、分类后的 entries、registered lifecycle 状态和非空 scopes 警告。
- MCP 设置 override 后仍执行 URL 预检、reload、读回验证和定向回滚。

MCP 当前仅用 HEAD 和状态码预检，无法识别 `/js/single-spa.dev.js` 返回 HTTP 200 HTML 的问题；必须复用 UI 的 URL 检查规则。

## 12. 建议文件拆分与实施步骤

不新增依赖，使用 React 17、浏览器 API和现有 `evalCmd`。

### 第一步：纯模型

新增：

- `extension/src/panel-app/import-map/import-map-model.js`
- `extension/src/panel-app/import-map/import-map-model.test.js`

职责：分类、并集、row model、排序、active dependency 计数、drift 判断。所有函数必须是纯函数。

### 第二步：页面快照与 storage

新增：

- `import-map-page.js`：一次性读取 default/override/effective/registered 快照，封装 add/remove/readback。
- `override-storage.js`：origin key、schema migration、导入导出验证。
- `override-url.js`：URL 解析与预检结果归一化。

`evalCmd` 的外部输入统一经过 `JSON.stringify`。

### 第三步：同步 Hook

将 `useImportMapOverrides.js` 缩减为编排层，或替换为 `use-import-map-state.js`：

- 保存 `snapshot`、`savedOverrides`、`pendingByName`、`errorByName`。
- 实现 init restore、UI transaction、external reconciliation、origin change。
- 每次快照同时更新 active 与 default map。
- 移除 `isScopedPackage` 和固定全局 cooldown。
- 恢复期间批量变更后只 reload 一次。

### 第四步：UI 组件

新增：

- `override-manager.component.js`
- `override-section.component.js`
- `override-row.component.js`
- `override-manager.css`

`apps.component.js` 只负责 toolbar、生命周期交互和组合两个区域，不再包含整套 import/export、同步和 300 多行 CSS。

### 第五步：PanelRoot 解耦

`panel-app.js` 不再等待 registered apps 成功才渲染 override UI：

- import-map manager 可独立加载；
- lifecycle 数据缺失时用空数组和提示；
- dependency override 导致 single-spa 崩溃时仍能关闭对应 override。

### 第六步：MCP/CLI

更新：

- `spawriter/src/runtime/spa-helpers.ts`
- `spawriter/src/pw-executor.ts`
- `spawriter/src/mcp.ts`
- 对应测试

撤销 bare-name 禁止，增加统一快照输出和 HTML fallback 检测。

### 第七步：构建与版本

- 为 extension package 增加 `test` 脚本，并让根 `npm test` 覆盖 extension tests。
- 构建 Chrome 扩展。
- 确认 `extension/build/panelApp.js` 包含新逻辑。
- 提高 manifest/package 版本，避免无法区分旧 bundle。
- 重载 unpacked extension 后执行浏览器验收。

## 13. 测试用例

### 13.1 纯函数单元测试

| ID | 场景 | 预期 |
|---|---|---|
| U01 | `@cnic/main` | 分类为 app |
| U02 | `@cnic/i18n` | 分类为 app，即使未注册 |
| U03 | `single-spa` | 分类为 dependency，但允许 override |
| U04 | `single-spa-vue` | 分类为 dependency |
| U05 | 两个 default maps 合并后共 15 项 | 10 app、5 dependency |
| U06 | 名称只在 activeOverrides | 生成 active-only orphan 行 |
| U07 | 名称只在 savedOverrides | 生成 saved-only orphan 行 |
| U08 | 名称只在 registeredApps | 生成 registered-only 行 |
| U09 | saved enabled=false，actual 无 | `actualEnabled=false`、synced |
| U10 | saved enabled=true，actual 无 | `actualEnabled=false`、drift |
| U11 | saved URL 与 actual URL 不同 | 显示 actual URL和 drift |
| U12 | actual dependency 数从 0 变 1 | dependency 自动展开 |
| U13 | dependency 无 active override | 初始折叠 |
| U14 | JSON URL | 校验通过 |
| U15 | root-relative URL | 按 page origin 解析通过 |
| U16 | `javascript:` URL | 拒绝 |
| U17 | HTTP 200 HTML fallback | 预检失败 |
| U18 | `scopes` 非空 | 返回可见 warning，不静默丢弃 |

### 13.2 Storage 与同步测试

| ID | 场景 | 预期 |
|---|---|---|
| S01 | 加载旧 bare-name 数据 | 保留并显示 dependency |
| S02 | 外部 add `single-spa` | dependency 展开、Toggle ON、storage enabled=true |
| S03 | 外部 remove `single-spa` | Toggle OFF、URL保留、storage enabled=false |
| S04 | 外部改变 active URL | UI 立即显示实际 URL，随后 storage 同步 |
| S05 | UI enable 期间轮询 | pending name 不被错误反转 |
| S06 | 同时改变两个不同名称 | 分别同步，不受全局 cooldown 阻塞 |
| S07 | origin A 导航到 origin B | 使用 B 的 storage，A 不泄漏 |
| S08 | 多项 restore | 只 reload 一次 |
| S09 | restore 后读回不一致 | 行进入 ERROR，Toggle 显示 actual |
| S10 | orphan active override | UI 可见且可关闭 |
| S11 | Reset All | 两类 active/page localStorage 和 saved storage 均清空 |
| S12 | 导入含 app+dependency | 两类均出现，enabled 状态正确应用 |

### 13.3 UI 组件测试

| ID | 场景 | 预期 |
|---|---|---|
| C01 | 正常页面 | App 在上，Dependency 在下 |
| C02 | 无 dependency override | Dependency 默认折叠 |
| C03 | 初始已有 dependency override | Dependency 默认展开 |
| C04 | 展开/折叠键盘操作 | Enter/Space 有效，`aria-expanded` 正确 |
| C05 | import-only app | 显示 `IMPORT ONLY`，无 lifecycle 按钮，有 override 控件 |
| C06 | registered app | 保留 Mount/Unmount/Reset |
| C07 | active URL 与 saved URL 漂移 | 显示 DRIFT 和实际 URL |
| C08 | 窄面板 | 可横向滚动，Toggle 与 Edit 可操作 |
| C09 | dark theme | 文字、边框、状态对比度可读 |
| C10 | active dependency 新出现 | 区域自动展开并高亮变化行 |

### 13.4 MCP/CLI 测试

| ID | 场景 | 预期 |
|---|---|---|
| M01 | override_set `single-spa` 到有效 JS | 允许并验证成功 |
| M02 | override_set `axios` | 允许 |
| M03 | override_set `@journal/edit` | 允许 |
| M04 | mount `single-spa` | 拒绝，说明不是 registered app |
| M05 | status | 返回 15 项合并目录及分类 |
| M06 | 目标返回 200 HTML | 拒绝，不写 localStorage |
| M07 | reload 后页面异常 | 定向删除本次 override 并恢复 |

### 13.5 在线 E2E 验收

使用隔离 spawriter tab，测试前保存原始 override map，所有写入放在 `try/finally` 中恢复。

1. 打开目标 URL并等待页面稳定。
2. 打开 spawriter panel。
3. 确认 App 区域 10 行，Dependency 标题显示 5，初始折叠。
4. 展开 Dependency，确认 5 个名称及默认 URL。
5. 将 `single-spa` override 设置为当前已知可用的 `/js/single-spa.min.js`，避免故意破坏在线站点。
6. reload 后确认 Dependency 自动展开、`single-spa` Toggle ON、active URL正确。
7. 直接通过页面 API remove，等待同步，确认 UI 自动变 OFF且保存 URL仍在。
8. 直接通过页面 API add 一个 app override，确认 App 行同步。
9. 检查 dashboard、UI、`getOverrideMap()` 和对应 localStorage key 四者一致。
10. 导航到同 origin 的其他路由，确认状态保持；导航到其他 origin，确认隔离。
11. 检查 `consoleLogs({level:"error"})` 与 `networkLog({status_filter:"error"})`。
12. 执行 `screenshotWithLabels()`，验证折叠按钮、Toggle、Edit 的可访问名称。
13. finally 恢复测试前 override map 并 reload。

禁止在共享在线环境用不存在的 `/js/single-spa.dev.js` 做破坏性 E2E。该 URL当前返回 HTTP 200 `text/html`，解析结果为 `SyntaxError: Unexpected token '<'`；该场景应在本地 fixture 测试。

## 14. 验收标准

- 自动读取任意数量的 import map，并在当前站点显示 15 个合并后的 import。
- 所有非空 name 均可 override；分类不参与权限判断。
- 10 个 `@scope/name` 显示在 App 区域，5 个裸名称显示在 Dependency 区域。
- App 区域始终在上，Dependency 区域始终在下。
- Dependency 无 active override 时默认折叠；有 active override 时默认展开。
- default、active、saved、registered 任一来源出现的 name 都有可见行。
- Toggle 始终反映 `getOverrideMap()` 的实际结果。
- dashboard、UI、page localStorage、getOverrideMap 在同步完成后一致。
- 外部 add/remove/change 在一个轮询周期内反映到 UI和 storage。
- 多项批量操作最多触发一次 reload。
- dependency 导致 single-spa lifecycle 不可用时，Override Manager 仍可操作并恢复。
- Import/Export 和 Reset All 同时覆盖 App 与 Dependency。
- Chrome 构建产物包含实现，扩展版本可识别。
- 单元、同步、MCP/CLI 和在线 E2E 全部通过；无新增 console/network error。

## 15. 推荐实施顺序

1. 先实现纯 `import-map-model` 和测试。
2. 实现一次性页面快照，先让 dashboard 正确返回 15 项。
3. 重构同步 Hook，让 UI 的 actual state 与 `getOverrideMap()` 同源。
4. 实现 App/Dependency 两区域和 orphan 可见性。
5. 更新 storage migration 与 Import/Export。
6. 移除 UI 与 MCP/CLI 的 bare-name 限制。
7. 增加 URL 预检、定向回滚和无 single-spa lifecycle 时的恢复 UI。
8. 跑全部测试、构建扩展、重载并执行在线 E2E。

建议按上述顺序拆成小提交，避免 UI 改造与同步语义在同一提交中难以回归。

## 16. 明确边界

首期完整支持顶层 `imports`。如果 `getOverrideMap().scopes` 非空，UI 必须显示“存在 N 个 scoped override，当前尚未编辑支持”的警告和原始状态入口，不能假装所有 override 已同步。若要编辑 scopes，应另行设计以 `(scopeUrl, importName)` 为复合键的第三类行，不能复用当前单 name storage schema。

