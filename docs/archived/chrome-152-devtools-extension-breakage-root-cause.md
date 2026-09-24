# spawriter 在 Chrome 152 更新后崩溃：根因分析与修复设计
## 1. 结论
本次故障是一个已确认的 Chrome 152 兼容性回归，根因不在 single-spa、Playwright、CDP relay、页面路由或 Chrome DevTools 面板生命周期。

Chrome 152 开始在声明了 `devtools_page` 的扩展中提供原生 `browser` namespace。spawriter 引入的 `webextension-polyfill@0.12.0` 检测到原生 `browser` 后变成 no-op，导致 `browser.devtools.inspectedWindow.eval()` 从旧 polyfill 的双元素结果形式切换为 Chrome 原生 Promise 的直接返回值。spawriter 的 `evalCmd()` 仍无条件读取 `result[0]`，把应用数组错误地截断为第一个应用对象。React 随后对该对象执行数组展开，最终抛出：
```text
TypeError: e is not iterable
at chrome-extension://dhdfaklnlgnikbdeijfhhejegonpgobh/build/panelApp.js:2:179223
```
`Try Reload Inspector`、关闭并重新打开 DevTools、刷新被检查页面都不会消除该错误，因为错误来自稳定且可重复的 API 返回契约变化。
## 2. 调查范围
调查对象：

- 仓库：`D:\dev\side\spawriter`
- Git commit：`2dba06649d3815cf4741fb26854ac7d0088d71cb`
- 分支：`main`
- 调查时工作树：clean
- 扩展版本：`1.0.0`
- `webextension-polyfill` 实际安装版本：`0.12.0`
- 本机 Chrome：`152.0.7977.64`
- 操作系统：Windows
- 调查日期：2026-08-27

本次仅执行了只读源码、构建产物、依赖与浏览器版本检查，没有修改产品代码，也没有提交 GitHub issue。
## 3. 外部变更背景
Chrome 152 Stable 于 2026-08-25 发布。本机当前 Chrome 二进制版本为 `152.0.7977.64`，与用户描述的"今天 Chrome 更新后开始崩溃"一致；更新前的确切版本没有可验证记录，因此本文不推测更新前版本。

Chrome 官方文档明确说明：

- Chrome 152 及以后，带 DevTools page 的扩展可以使用 `browser` namespace。
- Chrome 152 以前，声明 `devtools_page` 的扩展会在整个扩展中禁用该 namespace。
- 此前禁用的原因正是 `webextension-polyfill` 兼容性：polyfill 看到已有 `browser` 时会跳过包装。
- Chrome 的 `devtools.inspectedWindow.eval()` 现在提供原生 Promise 返回形式，同时保留 callback 形式以兼容旧代码。

这不是偶然相关的 Chrome 更新；Chrome 152 放开 DevTools 扩展中的 `browser` namespace，正好触发了仓库当前依赖和返回值假设之间的冲突。
## 4. 仓库中的相关实现
### 4.1 扩展明确声明了 DevTools page
`extension/manifest.chrome.json` 和 `extension/manifest.json` 均包含：
```json
{
  "devtools_page": "./build/main.html",
  "minimum_chrome_version": "116"
}
```
因此，该扩展正属于 Chrome 152 此次 namespace 行为变化的目标范围。
### 4.2 扩展依赖旧 polyfill 返回契约
`extension/package.json`：
```json
"webextension-polyfill": "^0.12.0"
```
锁文件最终解析为 `0.12.0`。打包进 `panelApp.js` 的 polyfill 源码也标记为：
```text
webextension-polyfill - v0.12.0 - Tue May 14 2024
```
polyfill 启动时检查：
```js
if (!(globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id)) {
  // wrap chrome APIs
}
```
Chrome 152 之前，DevTools 扩展中没有原生 `browser`，因此进入包装分支。Chrome 152 中该检查为 false，polyfill 直接使用浏览器提供的原生对象。
### 4.3 `evalCmd()` 假定 Promise 总是返回 tuple
`extension/src/inspected-window.helper.js:46-81` 的关键逻辑：
```js
const result = await browser.devtools.inspectedWindow.eval(commandString);

if (result[1] && (result[1].isError || result[1].isException)) {
  // process exceptionInfo
}

return result[0];
```
该实现把返回值固定解释为：
```js
[evaluatedValue, exceptionInfo]
```
这与旧 polyfill 的 metadata 一致。其 `devtools.inspectedWindow.eval` 配置为：
```js
{
  minArgs: 1,
  maxArgs: 2,
  singleCallbackArg: false
}
```
`singleCallbackArg: false` 让 callback 的所有参数以数组形式解析 Promise，即使第二个参数是 `undefined`。
### 4.4 Chrome 152 下的数据被截断
面板初始化时，`extension/src/panel-app.js:48` 调用：
```js
const results = await evalDevtoolsCmd(
  `exposedMethods?.getRawAppData()`
);
```
`getRawAppData()` 的正确结果是应用数组，例如：
```js
[
  { name: "@org/navbar", status: "MOUNTED", devtools: {} },
  { name: "@org/content", status: "NOT_MOUNTED", devtools: {} }
]
```
返回行为变化如下：

| 环境 | `await inspectedWindow.eval(...)` 的形状 | `evalCmd()` 的 `result[0]` |
|---|---|---|
| Chrome 152 以前 + polyfill 包装 | `[appsArray, undefined]` | `appsArray`，正确 |
| Chrome 152 + 原生 `browser` Promise | `appsArray` | 第一个 app 对象，错误 |

随后 `PanelRoot` 将第一个 app 对象写入 `apps` state：
```js
setApps(results);
```
### 4.5 React 崩溃点与上报偏移完全一致
`extension/src/panel-app/apps.component.js:39-45`：
```js
const sortedApps = useMemo(() => {
  if (sortBy === "appname") {
    return sortAppsByName(props.apps);
  }
  return sortApps(props.apps);
}, [props.apps, sortBy]);
```
`extension/src/panel-app/apps.component.js:590-595`：
```js
function sortApps(apps) {
  return [...apps]
    .sort((a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase()))
    .sort((a, b) => getAppPriority(a) - getAppPriority(b));
}
```
构建产物 `extension/build/panelApp.js` 报错列附近反格式化后为：
```js
$ = useMemo(() => {
  return "appname" === R
    ? [...t.apps].sort(...)
    : function (e) {
        return [...e].sort(...).sort(...);
      }(t.apps);
}, [t.apps, R]);
```
这与上报的 `panelApp.js:2:179223` 对应。`t.apps` 此时是普通 app 对象，没有 `Symbol.iterator`，所以 V8 抛出 `TypeError: e is not iterable`。
## 5. 可重复的最小证明
以下 mock 验证了 polyfill 的 no-op 与 `result[0]` 截断机理。mock 模拟的是 Chrome 152 将表达式值直接返回的行为，而非调用真实 DevTools API；实际崩溃在 Chrome 152 上的稳定复现是根因的直接证据。
```js
globalThis.chrome = { runtime: { id: "x" } };

const nativeBrowser = {
  runtime: { id: "x" },
  devtools: {
    inspectedWindow: {
      eval: async () => [
        { name: "app-a" },
        { name: "app-b" },
      ],
    },
  },
};

globalThis.browser = nativeBrowser;
const imported = require("webextension-polyfill");
const result = await imported.devtools.inspectedWindow.eval();
const helperResult = result[0];
```
实际输出：
```json
{
  "polyfillNoOp": true,
  "nativeResult": [
    { "name": "app-a" },
    { "name": "app-b" }
  ],
  "helperResult": { "name": "app-a" },
  "helperResultIsArray": false
}
```
该结果同时证明：

1. 原生 `browser` 存在时，当前 polyfill 不创建旧包装。
2. 当前 `evalCmd()` 的 `result[0]` 会把原始应用数组截断为第一个对象。
3. 下游 `[...apps]` 必然失败。
## 6. 根因分类
### 6.1 直接根因
`evalCmd()` 把第三方 polyfill 的历史返回形状当成了 `inspectedWindow.eval()` 的永久 API 契约，无条件执行 `return result[0]`。
### 6.2 触发条件
Chrome 152 在 DevTools 扩展中启用原生 `browser` namespace，使 `webextension-polyfill` 从"实际包装器"变成 no-op。
### 6.3 放大因素
- API 边界没有把外部返回值规范化为明确的内部类型。
- `PanelRoot` 只检查 truthy，没有执行 `Array.isArray(results)`。
- `Apps` 同样假定 `props.apps` 必然为数组。
### 6.4 非根因
没有证据支持以下组件是本次崩溃原因：

- 被检查页面的 single-spa 版本或路由状态
- spawriter relay
- Playwright 连接
- Chrome Debugger/CDP attach
- content script 注入时序
- service worker 休眠
- import-map-overrides 数据
- React `useMemo` 本身

`useMemo` 只是第一个消费错误类型并立即失败的位置。
## 7. 影响范围
### 7.1 已确认影响
- 只要 `getRawAppData()` 返回至少一个 app，面板初始化就会把第一个 app 对象当作数组并崩溃。
- "Reload spawriter""Try Reload Inspector"、页面路由刷新和关闭重开 DevTools 都会再次走同一错误路径。
### 7.2 可能的同源影响
`evalCmd()` 是共享方法，不只用于应用列表：

- 返回字符串时，`result[0]` 会变成首字符。
- 返回普通对象时，`result[0]` 通常是 `undefined`。
- 返回布尔值或数字时，`result[0]` 是 `undefined`。
- 原生 Promise rejection 不再经过旧 tuple 的 `exceptionInfo` 分支，现有可恢复协议错误分类可能失效。

因此，即使 React 层临时避免崩溃，import-map override、origin scope、状态同步和 profiler 等调用仍可能继续出现静默错误。修复必须落在共享 API 适配层，不能只在 `Apps` 中兜底。
### 7.3 空应用列表的表现
若 `getRawAppData()` 返回空数组，当前 `result[0]` 为 `undefined`。`PanelRoot` 的 truthy 检查不会调用 `setApps`，面板会一直停留在 Loading 状态，而不是抛出当前错误。
## 8. 修复要求
修复应满足以下约束：

1. `evalCmd()` 对调用者始终返回"表达式本身的值"，不得泄漏 Chrome callback、Firefox Promise 或 polyfill 的返回包装差异。
2. 错误信息应在适配层统一为项目自己的错误类型。
3. 不得根据"数组长度是否为 2"盲猜 tuple，因为表达式本身可以合法返回双元素数组。
4. `getRawAppData()` 的结果必须在进入 React state 前验证为数组。
5. 不应通过捕获并吞掉类型错误让面板显示不完整数据。
6. 应保留导航期间 execution context 销毁等可恢复错误的重试语义。
7. 不需要引入新依赖；标准 Promise 和原生扩展 API 已足够。
## 9. 修复设计
### 9.1 使用 Chrome callback 形式替代 polyfill Promise
`chrome.devtools.inspectedWindow.eval(expression, options, callback)` 的 callback 形式从 Chrome 116 起就稳定支持，始终提供 `(value, exceptionInfo)` 两个参数，不受 polyfill 有无和 `browser` namespace 变更影响。

修改 `extension/src/inspected-window.helper.js`：

1. 移除 `import browser from "webextension-polyfill"`。
2. 新增底层函数，用 callback 形式调用 `chrome.devtools.inspectedWindow.eval`，手动包装为 Promise：
```js
function chromeEval(expression) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expression, (value, exceptionInfo) => {
      resolve({ value, exceptionInfo });
    });
  });
}
```
3. `evalCmd()` 消费 `{ value, exceptionInfo }`，不再读取 `result[0]` 或 `result[1]`：
```js
const { value, exceptionInfo } = await chromeEval(commandString);
if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) {
  // 现有错误处理逻辑，直接使用 exceptionInfo
}
return value;
```
4. 错误处理（可恢复错误检测、重试）保持不变，只改数据提取路径。

不需要 Firefox 适配路径：manifest 使用的 `debugger`、`offscreen`、content script `"world": "MAIN"` 均为 Chrome 独有的 Manifest V3 特性，`manifest.json` 中的 `gecko` 配置实际不可用。
### 9.2 信任边界验证
被检查页面可以控制 `window.__SINGLE_SPA_DEVTOOLS__`，`panel-app.js` 中 `fetchApps()` 在 `setApps(results)` 之前应验证：
```js
if (!Array.isArray(results)) {
  throw new TypeError(`getRawAppData() expected array, got ${typeof results}`);
}
```
不应把非数组静默转成 `[]`（会把协议故障伪装成"页面没有应用"）。
## 10. 不建议的修法
以下方案没有解决根因：

- 只把 `[...apps]` 改成 `Array.from(apps || [])`。
- 只在 `Apps` 中写 `const apps = Array.isArray(props.apps) ? props.apps : []`。
- 只增加 ErrorBoundary 重载次数。
- 增加延迟、轮询或 `setTimeout`。
- 强制重新注入 content script。
- 清空 Chrome cache 或扩展 storage。
- 用 `Array.isArray(result) && result.length === 2` 判断旧 tuple。
- 降级 Chrome 作为长期方案。

其中"双元素数组判断"尤其危险：应用数据本身完全可能恰好包含两个 app，会再次被误判为 tuple。
## 11. 最小回归测试矩阵
应使用仓库已有的 Node `node:test` 和 `assert`，不新增测试框架。建议为适配层增加一个小型测试文件，覆盖：

1. Chrome callback 成功返回数组。
2. Chrome callback 返回一个 app。
3. Chrome callback 返回恰好两个 app，确保不会被误判为 tuple。
4. Chrome callback 返回空数组。
5. Chrome callback 提供 `isException`。
6. Chrome callback 提供 `isError` 和 `E_PROTOCOLERROR`。
7. `getRawAppData()` 返回普通对象时立即抛出清晰错误。
8. `getRawAppData()` 返回 `null` 或 `undefined` 时行为明确。
9. execution context 销毁仍按现有策略重试，重试耗尽后生成 `ProtocolError`。
10. 非可恢复错误不得被吞掉。

测试必须直接断言调用者得到完整 app 数组，不能只断言"没有抛错"。至少应包含一项：
```js
assert.deepEqual(actual, [appA, appB]);
```
这会立即捕获本次 `result[0]` 截断回归。
## 12. 浏览器端验证清单
代码测试通过后，应在真实 Chrome 152 DevTools 中验证：

1. 重新构建 `extension/build/panelApp.js`。
2. 重新加载 unpacked extension。
3. 完全关闭并重新打开 DevTools，以创建新的 DevTools page 实例。
4. 验证没有 single-spa app 的页面显示正确空状态，而不是永久 Loading。
5. 验证只有一个 app 的页面能渲染。
6. 验证恰好两个 app 的页面能完整渲染。
7. 验证多个 app 的名称、状态和排序均正确。
8. 切换按状态/名称排序。
9. 页面刷新、前进后退和 single-spa 路由切换后再次读取状态。
10. 验证 import-map override 的读取、添加、删除和 reset all。
11. 验证 DevTools 关闭重开后 storage scope 正确恢复。
12. 检查 DevTools panel console，不应存在未处理 rejection 或类型错误。

验证时应特别覆盖 0、1、2、多个 app 四种数量。只有测试"常见的多个 app"不足以发现返回形状误判。
## 13. 临时处置
在正式修复发布前，没有可靠的面板内操作可以绕过该问题。

- 重载 Inspector 无效。
- 清缓存无效。
- 重装同一个未修复构建无效。
- 不建议通过长期降级 Chrome 规避，因为会丢失浏览器安全更新。

可接受的临时方案只有发布一个修复后的本地 unpacked build，或暂时不使用依赖该面板的功能。
## 14. 发布与监控建议
- 修复版本应明确记录"Chrome 152 DevTools `browser` namespace compatibility"。
- 发布前检查生成的 `extension/build/panelApp.js` 确实来自修复后源码，避免只改 `src` 未重建。
- 后续扩展 API 调用不应依赖 polyfill 私有或历史包装形状，应先定义项目内部返回契约。
## 15. 证据索引
本地源码：

- `extension/manifest.chrome.json:23-24`
- `extension/manifest.json:23-24`
- `extension/package.json:38`
- `package-lock.json:20342-20345`
- `node_modules/webextension-polyfill/dist/browser-polyfill.js:12-23`
- `node_modules/webextension-polyfill/dist/browser-polyfill.js:242-248`
- `node_modules/webextension-polyfill/dist/browser-polyfill.js:778-786`
- `extension/src/inspected-window.helper.js:41-81`
- `extension/src/panel-app.js:48-52`
- `extension/src/panel-app.js:358`
- `extension/src/panel-app/apps.component.js:39-49`
- `extension/src/panel-app/apps.component.js:590-615`
- `extension/src/panel-app/ErrorBoundary.component.js:23-31`
- `extension/build/panelApp.js:2:179087-179319`

公开资料：

- Chrome 152 release notes
  https://developer.chrome.com/release-notes/152
- Chrome：Extend DevTools，包含 Chrome 152 `browser` namespace 行为说明
  https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools
- Chrome：`devtools.inspectedWindow` API
  https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow
- Chrome Extensions What's New，包含 DevTools API Promise support 记录
  https://developer.chrome.com/docs/extensions/whats-new
- Mozilla `webextension-polyfill` 项目说明
  https://github.com/mozilla/webextension-polyfill
- MDN：`browser.devtools.inspectedWindow.eval()` 返回值说明
  https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/devtools/inspectedWindow/eval

Chrome 官方的当前 API reference 与 What's New 对 `inspectedWindow.eval()` 首次支持 Promise 的具体 milestone 标注存在 151 与 149 的差异。该差异不影响本次结论：本机 Chrome 152 已具备原生 Promise API；决定性变化是 Chrome 152 首次在声明 `devtools_page` 的扩展中启用原生 `browser` namespace。
## 16. 最终判断
故障因果链已经闭合：
```text
Chrome 更新到 152
  → DevTools 扩展获得原生 browser namespace
  → webextension-polyfill 0.12.0 变为 no-op
  → inspectedWindow.eval() 返回形状改变
  → evalCmd() 错误执行 result[0]
  → apps 数组被截断为第一个 app 对象
  → sortApps() 对普通对象执行 [...apps]
  → TypeError: e is not iterable
```
根因修复位置是 `extension/src/inspected-window.helper.js` 的 `evalCmd()` API 适配边界；React 列表代码不是首要修复点。
## 17. 后续优化建议
以下优化与当前崩溃修复无关，不应混入修复 PR，建议独立 issue 跟踪。
### 刷新架构
- 将 `fetchApps()`、`fetchAppsWithRetry()`、burst polling 和 `getApps()` 收敛为职责明确的入口，保证所有路径使用相同校验和错误策略。
- 增加 single-flight 与 generation ID：同一时间最多执行一个应用读取，旧导航发起的请求不得覆盖新导航结果。
- 事件驱动刷新只保留一个低频 watchdog，避免一次导航启动多轮 burst `eval()`。
### 代码与诊断
- 将 `sortApps()` 的两次稳定排序合并为单 comparator。
- 系统审计当前八个 `webextension-polyfill` import 及其 Promise、callback、message listener 语义，因为 Chrome 152 的 no-op 影响整个扩展而非仅 `inspectedWindow.eval()`。
- ErrorBoundary 应区分浏览器兼容、页面协议、导航瞬态和 React 渲染错误。
- 生产构建应生成可离线符号化的 source map。
- 所有拼入 `eval()` 的 app name、URL 和其他页面值必须经 `JSON.stringify()` 序列化，避免转义错误和代码注入。
