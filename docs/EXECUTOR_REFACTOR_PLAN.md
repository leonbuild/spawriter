# Executor Refactor Plan: Shared Core Architecture

> Generated: 2026-04-14
> Status: **Proposed — ready for implementation**
> Reference: `D:\dev\0-ref\playwriter` (upstream)
> Current: `D:\dev\side\spawriter`

## Goal

CLI and MCP share the same `PlaywrightExecutor` as the sole execution engine.
Neither depends on the other. All browser capabilities — including single-spa
management, screenshot, accessibility, console, network, interception — are
VM globals inside the executor.

## Target Architecture

```
                    ┌─────────────────────────────────┐
                    │       PlaywrightExecutor          │
                    │      (pw-executor.ts - core)      │
                    │                                   │
                    │  VM globals (upstream-aligned):   │
                    │    page, context, browser, state  │
                    │    snapshot / accessibilitySnapshot│
                    │    screenshotWithLabels           │
                    │    getLatestLogs / clearAllLogs   │
                    │    getCDPSession / require / import│
                    │    refToLocator / waitForPageLoad │
                    │    resetPlaywright                │
                    │  VM globals (spawriter-specific): │
                    │    networkLog / networkIntercept   │
                    │    browserFetch / storage          │
                    │    emulation / performance         │
                    │    cssInspect / dbg / editor      │
                    │    singleSpa (dashboard, override) │
                    │    pageContent                    │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────┼──────────────────┐
                    │              │                   │
               ┌────▼────┐  ┌─────▼─────┐  ┌─────────▼──────────┐
               │ MCP      │  │ CLI -e    │  │ Relay /cli/execute  │
               │ (mcp.ts) │  │ (cli.ts)  │  │ (relay.ts)         │
               │ 4 tools  │  │ → HTTP    │  │ → executor.execute │
               │ ~400 LOC │  │           │  │                    │
               └──────────┘  └───────────┘  └────────────────────┘

Dependency graph (no cycles):
  pw-executor.ts  ← mcp.ts
  pw-executor.ts  ← relay.ts (via ExecutorManager)
  relay.ts        ← cli.ts (HTTP client)
```

**Key difference from upstream:** playwriter has 2 MCP tools (`execute`, `reset`).
spawriter has 4 MCP tools (`execute`, `reset`, `single_spa`, `tab`) because
single-spa management and tab leases are domain-specific features that benefit
from structured schemas rather than free-form code.

---

## Upstream Comparison (`playwriter`)

### File sizes (upstream executor.ts: 1422 LOC, mcp.ts: 371 LOC, cli.ts: 933 LOC, cdp-relay.ts: 2099 LOC)

### VM globals in upstream executor (lines 1121-1174)

All of these are injected into the `vm.createContext()` sandbox:

| Global | Source module | Notes |
|--------|-------------|-------|
| `page`, `context`, `browser` | Playwright core | Connection state |
| `state` | `this.userState` | Persistent across calls |
| `console` | Custom in-execute logger | Per-call capture (NOT persistent) |
| `snapshot` / `accessibilitySnapshot` | `./aria-snapshot.js` | In-page AX tree via CDP |
| `refToLocator` | Inline | Maps ref strings to locator selectors |
| `getCleanHTML` | `./clean-html.js` | Cleaned HTML extraction |
| `getPageMarkdown` | `./page-markdown.js` | Markdown extraction |
| `getLocatorStringForElement` | Inline | Selector generator |
| `getLatestLogs` | Inline (uses `this.browserLogs`) | Browser console logs |
| `clearAllLogs` | Inline | Clears all browser logs |
| `waitForPageLoad` | `./wait-for-page-load.js` | Smart page load waiter |
| `getCDPSession` | `./cdp-session.js` | Raw CDP session access |
| `createDebugger` | `./debugger.js` | Debugger class factory |
| `createEditor` | `./editor.js` | Editor class factory |
| `getStylesForLocator` | `./styles.js` | CSS style extraction |
| `formatStylesAsText` | `./styles.js` | Style formatting |
| `getReactSource` | `./react-source.js` | React source location |
| `screenshotWithAccessibilityLabels` | `./aria-snapshot.js` | Labeled screenshot |
| `resizeImageForAgent` / `resizeImage` | `./aria-snapshot.js` | Image resizing |
| `ghostCursor` | `./ghost-cursor.js` | Ghost cursor show/hide |
| `recording` | `./screen-recording.js` | Screen recording API |
| `startRecording` / `stopRecording` | Aliases | Backward compat |
| `createDemoVideo` | `./ffmpeg.js` | Demo video creator |
| `resetPlaywright` | Inline | `self.reset()` wrapper |
| `require` | `this.sandboxedRequire` | ScopedFS-backed |
| `import` | Dynamic import | ES module import |
| `chrome` | `./ghost-browser.js` | Ghost Browser API |
| `usefulGlobals` | Inline (lines 54-69) | setTimeout, fetch, Buffer, etc. |

### Key architectural patterns in upstream

1. **Modular delegation**: Executor imports ~15 modules instead of inlining logic.
   Each capability is a standalone file with its own tests.

2. **Two console systems**:
   - `customConsole` (lines 795-811): per-execute capture of user code `console.log()`.
   - `this.browserLogs` (lines 290, 520-556): persistent page-level browser console.
   Both are exposed but serve different purposes.

3. **Page lifecycle management** (lines 432-518):
   - `setupPageListeners()` adds close detection, console listener, popup tracking.
   - `pagesWithListeners` WeakSet prevents double-listening.
   - Page close auto-picks replacement and enqueues warnings.

4. **Warning system** (lines 375-416): Scoped warning events per execute() call,
   with cursor-based pruning. Warnings appear in execute() return value.

5. **ScopedFS with ALLOWED_MODULES** (lines 156-193, 328-351):
   20+ modules allowed: path, url, crypto, buffer, util, assert, events, timers,
   stream, zlib, http, https, http2, os, fs. `fs`/`node:fs` returns ScopedFS.

6. **Screenshot collector** (lines 1033-1057): `ScreenshotResult[]` collector passed
   to `screenshotWithAccessibilityLabels()`. Also separate `resizedImageCollector`.
   Both merge into `result.images` and `result.screenshots`.

7. **ExecuteResult type** (lines 203-208):
   ```typescript
   interface ExecuteResult {
     text: string
     images: Array<{ data: string; mimeType: string }>
     screenshots: ExecuteScreenshot[]  // path, base64, snapshot, labelCount
     isError: boolean
   }
   ```
   spawriter's current `ExecuteResult` lacks `screenshots` array.

8. **Relay security** (cdp-relay.ts lines 1765-1817):
   `privilegedRouteMiddleware` checks `Sec-Fetch-Site` header on `/cli/*` routes
   to prevent cross-origin attacks. spawriter's relay lacks this.

9. **MCP is truly thin** (371 LOC): Only `getOrCreateExecutor()` + 2 tool registrations
   (`execute`, `reset`). All error handling, relay checks, and result formatting in <100 LOC.

### What spawriter needs beyond upstream

| Feature | Upstream has? | Complexity in executor |
|---------|--------------|----------------------|
| `snapshot` / `accessibilitySnapshot` | Yes | Port from upstream |
| `screenshotWithAccessibilityLabels` | Yes | Port from upstream |
| `getLatestLogs` / `clearAllLogs` | Yes | Port from upstream |
| `getCDPSession` | Yes | Port from upstream |
| `createDebugger` / `createEditor` | Yes | Port from upstream |
| `require` (ScopedFS) | Yes | Port from upstream |
| `waitForPageLoad` | Yes | Port from upstream |
| `resetPlaywright` | Yes | Port from upstream |
| Network monitoring (CDP `Network.*`) | No | spawriter-specific, ~250 LOC |
| Network interception (CDP `Fetch.*`) | No | spawriter-specific, ~150 LOC |
| CSS inspect | No | spawriter-specific, ~80 LOC |
| Browser fetch (in-page) | No | spawriter-specific, ~30 LOC |
| Storage (cookies/localStorage) | No | spawriter-specific, ~100 LOC |
| Emulation (device/network/geo) | No | spawriter-specific, ~80 LOC |
| Performance (metrics/vitals) | No | spawriter-specific, ~80 LOC |
| Single-spa management | No | spawriter-specific, ~200 LOC |
| Tab lease management | No | spawriter-specific, ~100 LOC |
| Page content (get_html/search_dom) | No | spawriter-specific, ~80 LOC |

**Revised LOC estimate for `pw-executor.ts`**: ~1600-1800 LOC (upstream 1422 + spawriter
CDP features). This is significantly higher than the original +800 estimate.

---

## Current State Analysis

### File sizes (source lines)

| File | LOC | Notes |
|------|-----|-------|
| `mcp.ts` | 3227 | Monolith: all tool logic inline |
| `mcp.test.ts` | 10111 | 178 describe blocks |
| `pw-executor.ts` | 385 | Has usefulGlobals, customConsole, autoReturn (see below) |
| `pw-executor.test.ts` | 1237 | Auto-return, VM sandbox tests |
| `cli.ts` | 256 | goke-based CLI |
| `cli.test.ts` | 389 | CLI parsing + dispatch |
| `relay.ts` | 1268 | CDP relay + control routes |
| `runtime/cli-globals.ts` | 126 | Stub tool bridge |
| `runtime/control-routes.ts` | 122 | CLI HTTP routes |
| `runtime/session-store.ts` | 94 | Simple session map |
| `runtime/tool-service.ts` | 13 | Type-only interface |
| `runtime/ensure-relay.ts` | 54 | Auto-start relay |
| `runtime/kitty-graphics.ts` | 23 | Terminal image protocol |
| `runtime/control-client.ts` | 70 | CLI HTTP client |

### What `pw-executor.ts` already has (aligned with upstream)

| Feature | Lines | Upstream equivalent |
|---------|-------|-------------------|
| `usefulGlobals` | 13-27 | executor.ts 54-69 (missing `crypto`) |
| `CodeExecutionTimeoutError` | 6-11 | executor.ts 47-52 |
| `isPlaywrightChannelOwner` | 40-47 | executor.ts 273-281 |
| `getAutoReturnExpression` / `wrapCode` | 54-82 | executor.ts 76-145 (spawriter uses regex, upstream uses acorn AST) |
| `ExecuteResult` type | 29-33 | executor.ts 203-208 (missing `screenshots`) |
| Per-execute `customConsole` | 167-172 | executor.ts 795-811 |
| `usefulGlobals` spread in VM | 191 | executor.ts 1173 |
| `setGlobals()` / `customGlobals` | 92-96 | N/A (spawriter-specific extensibility) |
| Warmup `page.evaluate('1')` | 175-184 | N/A (spawriter-specific) |
| `retryOnContextError` | 248-256 | N/A (spawriter-specific) |
| `ExecutorManager` | 286-385 | executor.ts 1367-1422 |

**What's missing vs upstream:** persistent `browserLogs`, `setupPageListeners`,
page close detection, warning system, `ScopedFS` + sandboxed `require`,
`browser` in VM context, `snapshot`, `screenshotWithAccessibilityLabels`,
`getLatestLogs`, `getCDPSession`, `createDebugger`, `createEditor`,
`resetPlaywright`, `screenshots` in ExecuteResult.

**Note on `getAutoReturnExpression`:** spawriter uses a regex+`new Function` heuristic
(pw-executor.ts lines 54-75), while upstream uses `acorn` AST parsing (executor.ts
lines 76-127). The upstream approach is more robust. Consider upgrading during refactor.

### What lives in `mcp.ts` that needs to move

1. **Console log capture** (lines 225-266): `ConsoleLogEntry`, `addConsoleLog`,
   `clearConsoleLogs`, `getConsoleLogs`, `formatConsoleLogs`.
   Uses CDP `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`.

2. **Network monitoring** (lines 272-370): `NetworkEntry`, `networkLog` Map,
   request/response handlers, `formatNetworkEntries`. Uses CDP `Network.*`.

3. **Network interception** (lines 297-340): `InterceptRule`, `interceptRules`,
   `handleFetchPaused`. Uses CDP `Fetch.*` domain.

4. **Accessibility snapshot** (lines 983-1230): `formatAXTreeAsText` (line 983),
   `getInteractiveElements` (line 1235), `buildLabelInjectionScript` (line 1261),
   `REMOVE_LABELS_SCRIPT` (line 1277), `formatLabelLegend` (line 1282),
   `computeSnapshotDiff` (line 1160), `searchSnapshot` (line 1183).
   Uses CDP `Accessibility.getFullAXTree` + `DOM.resolveNode`.

5. **Labeled screenshot** (lines 76-148): `resolveImageProfile` (line 76),
   `captureWithSizeGuarantee` (line 100), model profiles (lines 58-70),
   auto-compression logic. Uses CDP `Page.captureScreenshot`.

6. **CSS inspect**: Injection code for computed styles via
   CDP `Runtime.evaluate`. Handler at `name === 'css_inspect'`.

7. **Debugger**: Breakpoint management, step/resume, variable inspection.
   Uses CDP `Debugger.*`. Handler at `name === 'debugger'`.

8. **Single-spa dashboard** (at `case 'dashboard_state'` line 1989 inside
   `_legacyDispatch`, which spans lines 1524-3163 = 1639 LOC): JS code
   reading `__SINGLE_SPA_DEVTOOLS__` and `window.importMapOverrides` via
   `page.evaluate()`.

9. **Single-spa override** (at `case 'override_app'` line 2106 inside
   `_legacyDispatch`): `importMapOverrides.addOverride()` etc. via
   `page.evaluate()`.

10. **Single-spa app_action** (at `case 'app_action'` line 2183 inside
    `_legacyDispatch`): Mount/unmount/unload via `page.evaluate()`.

11. **Browser fetch**: CDP `Network.loadNetworkResource` or `Fetch.*`.
    Handler at `name === 'browser_fetch'`.

12. **Storage**: CDP cookies/localStorage/sessionStorage.
    Handler at `name === 'storage'`.

13. **Emulation**: CDP `Emulation.*`, `Network.*`.
    Handler at `name === 'emulation'`.

14. **Performance**: CDP `Performance.*`.
    Handler at `name === 'performance'`.

15. **Tab management** (lines 1557-1760): `list_tabs` (line 1557),
    `switch_tab` (line 1597), `connect_tab` (line 1683), `release_tab`
    (line 1743). These use the relay's HTTP API and CDP lease system.

16. **CDP session management** (lines 460-530): `ensureRelayServer` (line 472),
    `doStartRelay` (line 495), `ensureSession`, `sendCdpCommand`, agent
    sessions. MCP-specific, replaced by executor's own connection management.

17. **Override sync logic**: `detectOverrideChanges` and `importPageOverrides`
    are currently test-only pure functions (in `mcp.test.ts` lines 1662-1723),
    not in production code. They represent logic that should be promoted to
    production code as VM globals in the executor.

18. **Helper functions** that need destination decisions during migration:

| Function | Line | Destination |
|----------|------|-------------|
| `loadPromptContent()` | 26 | Keep in mcp.ts |
| `getEffectiveClientId()` | 181 | Keep in mcp.ts (agent-specific) |
| `getAgentSession()` | 186 | Keep in mcp.ts (agent-specific) |
| `resolveActiveSession()` | 209 | Keep in mcp.ts (agent-specific) |
| `clearInterceptState()` | 311 | Move to executor |
| `handleFetchPaused()` | 317 | Move to executor |
| `requestExtensionAttachTab()` | 532 | Keep in mcp.ts |
| `getTargets()` | 559 | Keep in mcp.ts (relay HTTP) |
| `connectCdp()` | 571 | Move to executor (connection mgmt) |
| `acquireLease()` | 696 | Keep in mcp.ts (tab leases) |
| `releaseLease()` | 716 | Keep in mcp.ts |
| `releaseAllMyLeases()` | 725 | Keep in mcp.ts |
| `enableDomains()` | 739 | Move to executor |
| `requestConnectTab()` | 752 | Keep in mcp.ts (relay HTTP) |
| `doEnsureSession()` | 801 | Split: connection→executor, agent→mcp |
| `evaluateJs()` | 941 | Move to executor |
| `formatError()` | 965 | Move to executor (shared utility) |
| `getRefCache()` | 1067 | Move to executor (AX ref tracking) |
| `setTabTitlePrefix()` | 1080 | Move to executor (tab UI) |
| `handleDebuggerEvent()` | 1098 | Move to executor |
| `invalidateSessionByTargetId()` | 1121 | Keep in mcp.ts (session mgmt) |
| `handleLeaseEvent()` | 1134 | Keep in mcp.ts (lease events) |
| `stripRefPrefixes()` | 1156 | Move to executor (AX utility) |
| `formatInteractiveSnapshot()` | 1253 | Move to executor (AX formatting) |
| `mcpLog()` | 1301 | Keep in mcp.ts |
| `withTimeout()` | 1395 | Move to executor (shared utility) |
| `_legacyDispatch()` | 1524-3163 | Delete (logic moves to executor) |
| `main()` / `startMcpServer()` | 3178/3218 | Keep in mcp.ts |

### What spawriter has that upstream doesn't

| Feature | Description | Keep in new arch? |
|---------|-------------|-------------------|
| Single-spa management | dashboard_state, override_app, app_action | Yes (VM global) |
| Override sync | detectOverrideChanges, importPageOverrides | Yes (VM global) |
| Tab Lease System | Multi-agent tab isolation | Yes (relay-level, exposed as VM global) |
| Network monitoring | CDP Network.* event capture & formatting | Yes (VM global via CDP) |
| Network interception | Fetch domain mocking | Yes (VM global via CDP) |
| CSS inspect | Computed styles inspector | Yes (VM global) |
| Browser fetch | In-browser fetch | Yes (VM global) |
| Storage management | Cookies/localStorage | Yes (VM global) |
| Emulation | Device/network/geo | Yes (VM global) |
| Performance | Metrics/vitals | Yes (VM global) |
| Page content | get_html/search_dom/get_metadata | Yes (VM global) |
| Agent session isolation | Per-agent CDP connections | Keep in MCP only |

**Note:** Upstream HAS `createDebugger` and `createEditor` as VM globals (via
`./debugger.js` and `./editor.js`). spawriter's debugger logic is inline in
`_legacyDispatch`. The refactor should extract it into a similar class pattern.

---

## Implementation Plan

### Phase A: Restructure `pw-executor.ts` — add rich VM globals

**A1. Add console log capture — two systems (matching upstream)**

Upstream has TWO console systems (executor.ts lines 762-811, 520-556):
1. `customConsole` — per-execute capture of user code `console.log()` calls.
   Created fresh each `execute()` call. Formatted into `result.text`.
2. `this.browserLogs` — persistent page-level browser console via `page.on('console')`.
   Exposed as `getLatestLogs()` VM global. Clears on navigation.

**Browser console (persistent):**
```typescript
// In PlaywrightExecutor (matches upstream lines 520-556)
private browserLogs: Map<string, string[]> = new Map();
private pagesWithListeners = new WeakSet<Page>();
private static MAX_LOGS_PER_PAGE = 5000;

private setupPageConsoleListener(page: Page) {
  const targetId = page.targetId?.() || (page as any)._guid;
  if (!targetId) return;
  this.browserLogs.set(targetId, []);

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) this.browserLogs.set(targetId, []);
  });
  page.on('close', () => this.browserLogs.delete(targetId));
  page.on('console', (msg) => {
    try {
      const entry = `[${msg.type()}] ${msg.text()}`;
      const logs = this.browserLogs.get(targetId) ?? [];
      logs.push(entry);
      if (logs.length > PlaywrightExecutor.MAX_LOGS_PER_PAGE) logs.shift();
      this.browserLogs.set(targetId, logs);
    } catch (e) { this.logger.error('Console capture error:', e); }
  });
}
```

**User code console (per-execute):**
```typescript
// In execute() — matches upstream lines 795-811
const consoleLogs: Array<{ method: string; args: any[] }> = [];
const customConsole = {
  log: (...args: any[]) => consoleLogs.push({ method: 'log', args }),
  info: (...args: any[]) => consoleLogs.push({ method: 'info', args }),
  warn: (...args: any[]) => consoleLogs.push({ method: 'warn', args }),
  error: (...args: any[]) => consoleLogs.push({ method: 'error', args }),
  debug: (...args: any[]) => consoleLogs.push({ method: 'debug', args }),
};
```

Exposed as VM globals:
- `console` → per-execute customConsole (user code logs appear in result.text)
- `getLatestLogs(options?)` → browser page logs (persistent, searchable)
- `clearAllLogs()` → clears all persistent browser logs

**A2. Add accessibility snapshot (follow upstream pattern)**

Upstream uses `getAriaSnapshot()` from `./aria-snapshot.js` (executor.ts lines
813-927). This is a comprehensive in-page implementation with:
- Ref tracking via `WeakMap<Page, Map<string, string>>` for locator resolution
- Diff support via `createSmartDiff()` (shows changes since last snapshot)
- Search support with context lines (similar to grep output)
- Caching keyed by locator selector (page vs locator-scoped snapshots)
- `interactiveOnly` option for focused snapshots

spawriter currently uses CDP `Accessibility.getFullAXTree` + custom
`formatAXTreeAsText()`. Decision:
- **Keep CDP approach** for now (it works and supports label overlay for screenshots)
- **Add upstream-style diff and search** as enhancements
- **Add `refToLocator` VM global** (upstream line 929-936)
- Move `formatAXTreeAsText`, `computeSnapshotDiff`, `searchSnapshot`,
  `getInteractiveElements`, `formatInteractiveSnapshot`, `stripRefPrefixes`,
  `getRefCache` from `mcp.ts` into executor or `runtime/ax-tree.ts`

Exposed as VM globals:
- `snapshot(options?)` / `accessibilitySnapshot(options?)` → formatted text with diff
- `refToLocator({ ref })` → locator string for ref number

**A3. Add screenshot with labels (match upstream collector pattern)**

Upstream uses a `ScreenshotResult[]` collector passed to `screenshotWithAccessibilityLabels()`.
Results are collected during execute() and merged into `result.images` and `result.screenshots`.

spawriter's screenshot flow is CDP-based (vs upstream's Playwright-native approach).
Move into `runtime/labeled-screenshot.ts`:
- `captureWithSizeGuarantee`, `resolveImageProfile`
- `buildLabelInjectionScript`, `REMOVE_LABELS_SCRIPT`
- `getInteractiveElements`, `formatLabelLegend`

**Update `ExecuteResult`** to match upstream:
```typescript
interface ExecuteScreenshot {
  path: string;
  base64: string;
  mimeType: 'image/png';
  snapshot: string;
  labelCount: number;
}

interface ExecuteResult {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  screenshots: ExecuteScreenshot[];  // NEW: upstream has this
  isError: boolean;
}
```

Exposed as VM global:
- `screenshotWithLabels(options?)` → pushes to collector, returns snapshot text

**A4. Add single-spa management as VM globals**

These are the simplest — they're all `page.evaluate()` calls. Move the JS
strings from `mcp.ts` into executor globals:

```typescript
// In execute() VM context setup:
singleSpa: {
  status: async () => {
    return page.evaluate(DASHBOARD_STATE_CODE);
  },
  override: async (action, appName?, url?) => {
    return page.evaluate(overrideCode(action, appName, url));
  },
  mount: async (appName) => {
    return page.evaluate(appActionCode('mount', appName));
  },
  unmount: async (appName) => { ... },
  unload: async (appName) => { ... },
},
```

The `DASHBOARD_STATE_CODE` and override/action code generation functions are
already isolated in `mcp.ts` — they just need to move.

**Override sync logic**: `detectOverrideChanges` and `importPageOverrides` can
also be VM globals or internal helpers on the executor:

```typescript
singleSpa: {
  ...
  detectOverrideChanges: () => detectOverrideChanges(pageOverrides, savedOverrides),
  importPageOverrides: () => importPageOverrides(pageOverrides, savedOverrides),
}
```

**A5. Add network monitoring via CDP session**

Use `page.context().newCDPSession(page)` to get a CDP session, then:
- Enable `Network.enable`
- Listen for `Network.requestWillBeSent`, `Network.responseReceived`,
  `Network.loadingFinished`, `Network.loadingFailed`

Move `NetworkEntry`, `addRequest`, `setResponse`, `setFinished`, `setFailed`,
`getNetworkEntries`, `formatNetworkEntries`, `clearNetworkLog`,
`getNetworkDetail` into executor state.

Exposed as VM globals:
- `networkLog(options?)` → formatted entries
- `networkDetail(requestId, options?)` → detailed info
- `clearNetworkLog()` → clears entries

**A6. Add network interception via CDP**

Use CDP `Fetch.enable` / `Fetch.requestPaused` via the same CDPSession:

Exposed as VM global:
- `networkIntercept` object: `{ enable, disable, addRule, removeRule, listRules }`

**A7. Add remaining capabilities**

| Capability | VM global name | Implementation |
|-----------|----------------|----------------|
| CSS inspect | `cssInspect(selector, props?)` | CDP `Runtime.evaluate` via CDPSession |
| Debugger | `dbg` object | CDP `Debugger.*` via CDPSession |
| Browser fetch | `browserFetch(url, opts?)` | `page.evaluate(() => fetch(...))` |
| Storage | `storage(action, opts?)` | CDP `Network.getCookies`, `DOMStorage.*` |
| Emulation | `emulation(action, opts?)` | CDP `Emulation.*`, `Network.*` |
| Performance | `performance(action?)` | CDP `Performance.*` |
| Tab management | `tab(action, opts?)` | Relay HTTP API calls |
| Require | `require(module)` | Sandboxed allowlist (ScopedFS) |

**A8. Add sandboxed `require` (port from upstream)**

Port upstream's `ScopedFS` + allowlisted module pattern (executor.ts lines 156-351).

ALLOWED_MODULES (upstream lines 156-193, 20+ modules):
`path`, `url`, `querystring`, `punycode`, `crypto`, `buffer`, `string_decoder`,
`util`, `assert`, `events`, `timers`, `stream`, `zlib`, `http`, `https`,
`http2`, `os`, `fs` (+ `node:` prefixed variants).

- `require('fs')` / `require('node:fs')` → returns `ScopedFS`
- `require('path')`, etc. → direct passthrough
- Unknown modules → throw `ModuleNotAllowedError`
- Also add `import` for ES module imports (upstream line 1170)

**A9. AST auto-return (already done)**

spawriter already has `getAutoReturnExpression` using acorn. No changes needed.

**A10. Add page lifecycle management (from upstream)**

Upstream (executor.ts lines 432-518) has comprehensive page lifecycle handling:
- `setupPageListeners()` with close detection, console, popup tracking
- `pagesWithListeners` WeakSet to prevent double-listening
- Auto-replacement of closed current page
- Warning system with scoped warning events per execute() call

spawriter's executor doesn't have this. It needs:
- `setupPageCloseDetection()` — auto-pick replacement page on close
- `setupNewPageLogging()` — popup tracking via `page.on('popup')`
- Warning scope system (`beginWarningScope`, `flushWarningsForScope`)

**A11. `usefulGlobals` in VM context (ALREADY DONE, minor update needed)**

spawriter already has `usefulGlobals` (pw-executor.ts lines 13-27) AND uses them
in the VM context (line 191). Missing only `crypto` compared to upstream.

Also: spawriter does NOT inject `browser` into the VM context (upstream does at
line 1124). Add `browser: this.browser` to the VM context object.

**A12. Add `resetPlaywright` VM global (from upstream)**

Upstream (executor.ts lines 1162-1168): Exposes `resetPlaywright()` that calls
`self.reset()` and updates the VM context's `page`, `context`, `browser` refs.
This allows user code to reset the connection without needing the `reset` MCP tool.

**A13. Relay security middleware (ALREADY DONE)**

spawriter's `runtime/control-routes.ts` lines 13-35 already has security middleware
on `/cli/*` routes: `sec-fetch-site` check, `Content-Type` enforcement, and
token-based authorization (all three layers). This matches upstream's
`privilegedRouteMiddleware` (cdp-relay.ts lines 1765-1817).

When Phase C inlines routes into `relay.ts`, preserve this middleware.

### Phase B: Slim down `mcp.ts`

**B1. Replace MCP tool handlers**

The 4 tools become:

```typescript
// execute tool
server.tool('execute', promptContent, { code: z.string(), timeout: z.number().default(10000) },
  async ({ code, timeout }) => {
    const exec = await getOrCreateExecutor();
    const result = await exec.execute(code, timeout);
    // Transform to MCP format
    return formatMcpResult(result);
  }
);

// reset tool
server.tool('reset', resetDescription, {},
  async () => {
    const exec = await getOrCreateExecutor();
    const { page, context } = await exec.reset();
    return { content: [{ type: 'text', text: `Reset. ${context.pages().length} pages. URL: ${page.url()}` }] };
  }
);

// single_spa tool — translates action to execute() code
server.tool('single_spa', singleSpaDescription, singleSpaSchema,
  async ({ action, appName, url }) => {
    const exec = await getOrCreateExecutor();
    const code = buildSingleSpaCode(action, appName, url);
    return formatMcpResult(await exec.execute(code));
  }
);

// tab tool — talks to relay HTTP API
server.tool('tab', tabDescription, tabSchema,
  async ({ action, ...args }) => {
    return handleTabAction(action, args);
  }
);
```

**B2. Remove from `mcp.ts`**

- All CDP event handlers (console, network, fetch)
- All `sendCdpCommand` calls for tool logic
- `captureWithSizeGuarantee`, `resolveImageProfile`
- `formatAXTreeAsText`, `getInteractiveElements`, label injection
- Console/network/intercept state management
- Debugger/CSS inspect/storage/emulation/performance handlers
- `_legacyDispatch` function
- Inline single-spa JS code strings

**B3. Keep in `mcp.ts`** (target: ~400 LOC, upstream is 371 LOC with 2 tools)

Reference upstream pattern (mcp.ts):
- `mcpLog()` + `sendLogToRelayServer()` — fire-and-forget MCP logging (~20 LOC)
- `getOrCreateExecutor()` — lazy executor creation with config (~30 LOC)
- `ensureRelayServerForMcp()` — relay auto-start (~3 LOC)
- MCP server setup (McpServer, StdioServerTransport) (~5 LOC)
- `execute` tool — calls `exec.execute(code, timeout)`, formats result (~60 LOC)
- `reset` tool — calls `exec.reset()`, formats result (~30 LOC)

spawriter additions beyond upstream:
- `single_spa` tool — translates action to `exec.execute()` code (~30 LOC)
- `tab` tool — relay HTTP calls for tab management (~50 LOC)
- Agent session management (per-agent executor instances) (~60 LOC)
- `formatMcpResult()` — transforms ExecuteResult to MCP content array (~30 LOC)
- `ensureRelayServer()` — delegates to `runtime/ensure-relay.ts` (~10 LOC)

Total estimated: ~330-400 LOC (vs current 3227 LOC = 90% reduction)

### Phase C: Update relay

**C1. Replace control routes stub**

```typescript
// relay.ts — inline the routes from control-routes.ts
// IMPORTANT: preserve security middleware (Sec-Fetch-Site, Content-Type, token auth)
const relayExecutorManager = new ExecutorManager({
  cdpConfig: { host: '127.0.0.1', port },
  logger: relayLogger,
});

// Security middleware (from current control-routes.ts lines 13-35)
app.use('/cli/*', async (c, next) => {
  const secFetchSite = c.req.header('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'none' && secFetchSite !== 'same-origin') {
    return c.json({ error: 'Cross-origin requests not allowed' }, 403);
  }
  if (c.req.method === 'POST') {
    const ct = c.req.header('content-type');
    if (!ct?.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 400);
    }
  }
  // Token auth ...
  await next();
});

app.post('/cli/execute', async (c) => {
  const { sessionId, code, timeout } = await c.req.json();
  const executor = relayExecutorManager.getSession(sessionId);
  if (!executor) return c.json({ error: 'Session not found' }, 404);
  const result = await executor.execute(code, timeout || 10000);
  return c.json(result);
});
```

**C2. Remove `runtime/session-store.ts`**

The `ExecutorManager` IS the session store. Sessions are just executor instances.

**C3. Remove `runtime/cli-globals.ts`**

No longer needed — all globals are in the executor.

**C4. Remove `runtime/control-routes.ts`**

Routes now inlined in relay.ts with security middleware preserved.

**C5. Remove `runtime/tool-service.ts`**

Never fully implemented, not needed.

### Phase D: Update CLI

**D1. Remove cli-globals injection**

In `cli.ts`, the `executeCode` function already sends code to
`/cli/execute`. No changes needed since the relay now runs executor directly.

**D2. Update session commands**

The session commands (new/list/delete/reset) should talk to the
`ExecutorManager` on the relay, not a separate `SessionStore`. The HTTP endpoints
stay the same, just the relay implementation changes.

### Phase E: Update `ExecutorManager`

The current spawriter `ExecutorManager` is simplistic. Align with upstream:

```typescript
export class ExecutorManager {
  private executors = new Map<string, PlaywrightExecutor>();
  private cdpConfig: CdpConfig;
  private logger: ExecutorLogger;

  constructor(options: { cdpConfig: CdpConfig; logger?: ExecutorLogger });

  getExecutor(options: {
    sessionId: string;
    cwd?: string;
  }): PlaywrightExecutor;

  getSession(sessionId: string): PlaywrightExecutor | null;
  deleteExecutor(sessionId: string): boolean;
  listSessions(): SessionInfo[];
}
```

Each session gets its own `PlaywrightExecutor` with its own Playwright CDP
connection. This is critical for session isolation.

---

## Test Migration Plan

### Tests to move (mcp.test.ts → pw-executor.test.ts or domain-specific test)

`mcp.test.ts` has 178 `describe` blocks and 10111 lines. Here's the migration
by category. Line numbers refer to `describe` block start lines.

**Console & logging (move to pw-executor.test.ts):**
- `Console log capture` (line 60) — 11 tests
- `CDP event dispatch (handleCdpEvent simulation)` (line 1257) — 4 tests

**Network monitoring (move to pw-executor.test.ts or network-monitor.test.ts):**
- `Network request monitoring` (line 240) — 13 tests
- `Network request monitoring – extended fields` (line 367) — 12 tests
- `network_detail – include section parsing` (line 521) — 9 tests
- `network_detail – output formatting` (line 629) — 28 tests
- `network_detail – tool definition and error cases` (line 873) — 5 tests
- `network_detail – body truncation edge cases` (line 921) — 8 tests
- `network_detail – base64 decoding` (line 975) — 7 tests
- `CDP event dispatch – Network extended fields` (line 1029) — 10 tests
- `formatNetworkEntries` (line 3649) — 10 tests

**Network interception (move to pw-executor.test.ts):**
- `network_intercept – rule management` (line 6114)
- `network_intercept – URL pattern matching` (line 6171)
- `network_intercept – request handling logic` (line 6206)
- `network_intercept – glob-to-regex conversion` (line 6810)
- `network_intercept – Fetch.fulfillRequest encoding` (line 6839)
- `network_intercept – response header formatting` (line 6867)
- `network_intercept – rule formatting for list_rules` (line 6898)
- `intercept state management` (line 6466)

**Accessibility snapshot (move to ax-tree.test.ts):**
- `formatAXTreeAsText` (line 1567) — 5 tests
- `formatAXTreeAsText (edge cases)` (line 1836) — 5 tests
- `computeSnapshotDiff` (line 3255) — 5 tests
- `computeSnapshotDiff (precision)` (line 3730) — 6 tests
- `searchSnapshot` (line 3344) — 10 tests
- `getInteractiveElements` (line 3437) — 6 tests
- `formatLabelLegend` (line 3509) — 4 tests
- `buildLabelInjectionScript` (line 3553) — 7 tests
- `REMOVE_LABELS_SCRIPT` (line 3616) — 2 tests

**Screenshot (move to pw-executor.test.ts):**
- `Screenshot quality: resolveImageProfile` (line 2369) — 11 tests
- `Screenshot quality: auto-compression logic` (line 2491) — 10 tests

**Single-spa (move to spa-helpers.test.ts):**
- `app_action JS code generation` (line 2638) — 6 tests
- `override_app parameter validation` (line 2747) — 11 tests
- `override_app JS code generation` (line 2827) — 3 tests
- `detectOverrideChanges` (line 1725) — 5 tests (test-only function)
- `detectOverrideChanges (edge cases)` (line 2854) — 7 tests
- `importPageOverrides (fresh install sync)` (line 1785) — 4 tests
- `importPageOverrides (edge cases)` (line 2939) — 4 tests
- `end-to-end sync simulation` (line 2996) — 7 tests

**Debugger (move to pw-executor.test.ts):**
- `handleDebuggerEvent` (line 3857) — 12 tests
- `Debugger tool action routing` (line 4012) — 18 tests
- `Debugger tool definition validation` (line 4182) — 8 tests
- `Breakpoint state management` (line 4420) — 3 tests
- `Script URL filtering for list_scripts` (line 4456) — 4 tests
- `Reset clears debugger state` (line 4500) — 2 tests
- `Debugger state machine – exhaustive transitions` (line 4735) — 8 tests
- `Debugger breakpoint URL regex escaping` (line 4847) — 9 tests
- `Debugger evaluate result formatting` (line 4896) — 11 tests
- `Debugger pause_on_exceptions states` (line 5714)
- `Script URL filtering – comprehensive` (line 5745)

**CSS inspect (move to pw-executor.test.ts):**
- `CSS Inspect result formatting` (line 4244) — 6 tests
- `CSS Inspect tool definition validation` (line 4339) — 4 tests
- `CSS Inspect injection code generation` (line 4370) — 6 tests
- `CSS Inspect default properties list` (line 4961) — 4 tests
- `CSS Inspect property parsing` (line 5019)
- `CSS Inspect selector injection safety` (line 5065)
- `CSS Inspect formatting edge cases` (line 5117)

**Storage (move to pw-executor.test.ts):**
- `storage tool – action routing` (line 5812)
- `storage tool – cookie formatting` (line 5849)
- `storage tool – localStorage formatting` (line 5892)
- `storage tool – storage usage formatting` (line 5924)
- `storage – cookie edge cases` (line 6541)
- `storage – cookie attribute combinations` (line 6570)
- `storage – localStorage key/value edge cases` (line 6594)
- `storage – clear_storage types parsing` (line 6630)

**Performance (move to pw-executor.test.ts):**
- `performance tool – metrics formatting` (line 5953)
- `performance tool – web vitals grading` (line 5979)
- `performance tool – memory formatting` (line 5999)
- `performance tool – resource timing formatting` (line 6020)
- `performance – key metrics list` (line 6649)
- `performance – web vitals thresholds` (line 6667)
- `performance – resource timing sorting and filtering` (line 6687)

**Emulation (move to pw-executor.test.ts):**
- `emulation tool – network presets` (line 6230)
- `emulation tool – media features parsing` (line 6265)
- `emulation tool – device metrics` (line 6303)
- `emulation – common device presets` (line 6934)
- `emulation – timezone validation` (line 6967)
- `emulation – geolocation validation` (line 6987)
- `emulation – network conditions format` (line 7005)

**Editor (move to pw-executor.test.ts):**
- `editor tool – action routing` (line 6051)
- `editor tool – source line extraction` (line 6073)
- `editor – source truncation` (line 6732)
- `editor – search results formatting` (line 6749)
- `editor – script filtering` (line 6779)

**Page content (move to pw-executor.test.ts):**
- `page_content tool – actions` (line 6329)
- `page_content tool – HTML cleaning logic` (line 6336)
- `page_content tool – truncation` (line 6358)
- `page_content tool – metadata format` (line 6379)
- `page_content – HTML cleaning patterns` (line 7033)
- `page_content – style attribute removal` (line 7059)
- `page_content – metadata fields` (line 7075)
- `page_content – DOM search result formatting` (line 7096)

**Timeout utilities (move to pw-executor.test.ts):**
- `withTimeout utility` (line 7143)
- `sendCdpCommand timeout pattern` (line 7237)
- `evaluateJs timeout parameter` (line 7283)
- `Timeout hierarchy` (line 7316)
- `Timeout error message format` (line 7367)
- `Extension sendCommandWithTimeout pattern` (line 7410)
- `Extension timeout hierarchy` (line 7527)

**clear_cache_and_reload (move to pw-executor.test.ts):**
- `clear_cache_and_reload parameter parsing` (line 7586)
- `clear_cache_and_reload cookie domain matching` (line 7786)
- `clear_cache_and_reload cookie scope decision` (line 7883)
- `clear_cache_and_reload storage type partitioning` (line 7943)
- `clear_cache_and_reload output summary` (line 8013)
- `clear_cache_and_reload reload parameter` (line 8055)
- `clear_cache_and_reload scenario simulation` (line 8091)

**Tab management (move to pw-executor.test.ts):**
- `list_tabs – formatting` (line 8303)
- `switch_tab – target validation` (line 8398)
- `switch_tab – preferredTargetId and doEnsureSession target selection` (line 8492)
- `switch_tab – state clearing categories` (line 8565)
- `switch_tab – success message formatting` (line 8595)
- `list_tabs and switch_tab tool definitions` (line 8637)
- `multi-tab scenario: A/B comparison workflow` (line 8668)
- `multi-tab scenario: tab detachment handling` (line 8685)
- `multi-tab: state isolation between tabs` (line 8698)
- `multi-tab: network_detail after tab switch` (line 8722)
- `multi-tab: playwright_execute independence` (line 8732)

**Relay / bridge / download (move to relay.test.ts):**
- `relay: toPageDownloadParams – Browser to Page behavior mapping` (line 8769)
- `relay: download event synthesis` (line 8801)
- `relay: download behavior cache and inheritance` (line 8822)
- `relay: Browser.setDownloadBehavior validation` (line 8859)
- `relay: applyDownloadBehaviorToAllPages – target type filtering` (line 8880)
- `bridge: Chrome API defensive guards` (line 8907)
- `bridge: maintainLoop keepalive conditions` (line 8946)
- `cookie API: extension relay compatibility` (line 8994)
- `integration: Browser.setDownloadBehavior full relay flow` (line 9083)
- `integration: new target inherits download behavior` (line 9129)
- `integration: download event synthesis end-to-end` (line 9158)
- `integration: last-writer-wins download behavior updates` (line 9190)
- `integration: mixed target types during setDownloadBehavior` (line 9224)

**Shared utilities (move to pw-executor.test.ts):**
- `formatError – structured error formatting` (line 9254)
- `formatInteractiveSnapshot` (line 9289)
- `formatAXTreeAsText – @ref assignment` (line 9331)
- `stripRefPrefixes` (line 9423)
- `refCacheByTab – reset clears all tabs` (line 9450)
- `DYNAMIC_CLASS_RE pattern` (line 9525)

**Interact / trace / browser_fetch tool tests (move to pw-executor.test.ts):**
- `interact tool definition` (line 9470)
- `interact tool – ref validation logic` (line 9484)
- `trace tool definition` (line 9507)
- `browser_fetch tool definition` (line 9557)
- `accessibility_snapshot – interactive_only priority` (line 9738)
- `browser_fetch – fetch code generation` (line 9757)
- `trace – event cap simulation` (line 9841)
- `trace – DYNAMIC_CLASS_RE extended patterns` (line 9869)

**Tab title prefix (move to pw-executor.test.ts):**
- `Tab title prefix regex` (line 9899)
- `Tab title prefix mapping` (line 9942)
- `setTabTitlePrefix code generation` (line 9989)
- `Tab state lifecycle – title prefix expectations` (line 10032)

### Tests to keep in mcp.test.ts (MCP-specific)

| Test group | Line | Notes |
|-----------|------|-------|
| `MCP logging capability` | 1986 | MCP-specific logging |
| `ensureRelayServer reentrancy guard` | 2080 | MCP relay startup |
| `ensureRelayServer with version probe simulation` | 2169 | MCP relay probing |
| `ensureSession mutex` | 1630 | MCP session creation |
| `ensureSession mutex (error recovery)` | 1921 | MCP error handling |
| `getCommandTimeout` | 1615 | MCP timeout config |
| `getCommandTimeout (additional)` | 2585 | MCP timeout config |
| `clear_cache_and_reload safety` | 2246 | MCP cache clear logic |
| `Integration: only 4 core MCP tools registered` | 9579 | Tool registration |
| `Integration: All tool names – Phase 4-9` | 6410 | Tool name validation |
| `Integration: All tool names are unique and complete` | 5582 | Tool uniqueness |
| `Session Manager tool action routing` | 4534 | MCP session manager |
| `Session Manager tool definition validation` | 4673 | MCP session manager |
| `Session Manager eviction strategy` | 5210 | MCP session limits |
| `Session Manager concurrent operations` | 5291 | MCP session concurrency |
| `Session Manager output formatting` | 5340 | MCP session display |
| `playwright_execute tool definition` | 3179 | Tool schema validation |
| `playwright_execute integration path` | 3785 | MCP execute flow |
| `reset tool description` | 3230 | Tool description |
| `Integration: Reset clears all state types` | 5387 | MCP reset behavior |
| `Integration: Debugger action preconditions` | 5442 | MCP debugger flow |
| `Integration: tool action counts` | 8227 | MCP action count validation |
| `Phase 2: execute tool schema` | 9619 | MCP tool schema |
| `Phase 2: single_spa tool schema` | 9643 | MCP tool schema |
| `Phase 2: tab tool schema` | 9660 | MCP tool schema |
| `Phase 2: single_spa delegates to internal handlers` | 9677 | MCP dispatch |
| `Phase 2: SessionStore session limit` | 9695 | MCP session limits |
| `Phase 2: ChannelOwner filtering in execute result` | 9717 | MCP result filtering |
| New: `formatMcpResult()` | — | Transform executor→MCP |
| New: Agent session isolation | — | Per-agent executor |
| New: 4 thin tool wrappers | — | execute/reset/single_spa/tab |

### New tests to add

| Test | Location | Description |
|------|----------|-------------|
| VM global: consoleLogs() | pw-executor.test.ts | Verify page.on('console') capture |
| VM global: accessibilitySnapshot() | pw-executor.test.ts | Verify AX tree formatting |
| VM global: labeledScreenshot() | pw-executor.test.ts | Verify screenshot pipeline |
| VM global: singleSpa.status() | pw-executor.test.ts | Verify dashboard eval |
| VM global: singleSpa.override() | pw-executor.test.ts | Verify override actions |
| VM global: networkLog() | pw-executor.test.ts | Verify CDP network capture |
| VM global: networkIntercept | pw-executor.test.ts | Verify fetch interception |
| VM global: browserFetch() | pw-executor.test.ts | Verify in-browser fetch |
| VM global: cssInspect() | pw-executor.test.ts | Verify CSS extraction |
| VM global: dbg | pw-executor.test.ts | Verify debugger operations |
| VM global: storage() | pw-executor.test.ts | Verify cookie/storage |
| VM global: tab() | pw-executor.test.ts | Verify tab management |
| Sandboxed require | pw-executor.test.ts | Verify module allowlist |
| CLI → relay → executor | cli.test.ts | E2E: -e with VM globals |
| MCP thin wrappers | mcp.test.ts | 4 tools call executor |
| Relay /cli/execute | relay.test.ts (new) | HTTP → executor flow |

### Tests to delete or update

| Test group | Line | Action |
|-----------|------|--------|
| `Debugger: all 12 actions have handler coverage` | 5637 | Update for new action routing |
| `Session Manager: all 5 actions have handler coverage` | 5684 | Delete if session manager removed |
| `reset clears all state including intercept` | 6521 | Move to executor tests |
| Inline function definitions (detectOverrideChanges etc.) | 1662-1723 | Move to production code |
| Tests referencing `_legacyDispatch` internal | various | Update to test executor globals |

---

## File changes summary

### New files

| File | Purpose | LOC |
|------|---------|-----|
| `runtime/labeled-screenshot.ts` | Screenshot capture + label overlay | ~200 |
| `runtime/ax-tree.ts` | Accessibility tree formatting | ~200 |
| `runtime/spa-helpers.ts` | Single-spa JS code generators | ~150 |
| `runtime/network-monitor.ts` | Network capture + formatting | ~250 |
| `relay.test.ts` | Relay HTTP + download/bridge tests | ~500 |

### Modified files

| File | Changes | LOC delta |
|------|---------|-----------|
| `pw-executor.ts` | Add VM globals, CDPSession, ScopedFS, require | +1200-1400 |
| `mcp.ts` | Strip to 4 thin wrappers + agent session mgmt | -2800 |
| `relay.ts` | Direct executor calls, remove stub | -30 |
| `cli.ts` | Minor: remove cli-globals import | -5 |
| `pw-executor.test.ts` | Add tests for all VM globals + moved tests | +4000 |
| `mcp.test.ts` | Remove ~153 describe blocks, keep ~25 MCP-specific | -9000 |

### Kept files (runtime/)

| File | Reason |
|------|--------|
| `runtime/ensure-relay.ts` | Used by MCP to auto-start relay |
| `runtime/kitty-graphics.ts` | Used by CLI for terminal image output |
| `runtime/control-client.ts` | Used by CLI as HTTP client to relay |

### Deleted files

| File | Reason |
|------|--------|
| `runtime/cli-globals.ts` | Globals in executor |
| `runtime/session-store.ts` | ExecutorManager is session store |
| `runtime/tool-service.ts` | Not needed |
| `runtime/control-routes.ts` | Routes inline in relay.ts |

---

## Migration order (can be done incrementally)

1. **Phase A10-A12**: Core infrastructure (page lifecycle, usefulGlobals,
   resetPlaywright, warning system) → run tests → verify
2. **Phase A1-A2**: Console (both systems) + accessibility → run tests → verify
3. **Phase A3**: Screenshot with collector pattern → run tests → verify
4. **Phase A4**: Single-spa → run tests → verify (critical for spawriter)
5. **Phase A5-A6**: Network + interception → run tests → verify
6. **Phase A7**: Remaining (CSS, debugger, storage, emulation, performance, pageContent)
7. **Phase A8**: Sandboxed require (A11 usefulGlobals already done, add `crypto`)
8. **Phase B**: Slim mcp.ts (target ~400 LOC)
9. **Phase C**: Update relay (A13 security middleware already done, preserve it)
10. **Phase D**: Update CLI
11. **Phase E**: Final tests + cleanup

Each step is independently testable and deployable. The key invariant is:
**MCP tests must pass after each phase** (backward compatible).

---

## Decision log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| MCP uses executor directly? | Yes (Option A) | Upstream pattern, simpler |
| Console via Playwright vs CDP? | Playwright `page.on('console')` | Simpler, upstream pattern |
| Two console systems? | Yes (per-execute + persistent) | Matches upstream exactly |
| AX tree via Playwright vs CDP? | CDP for labeled screenshots | Need backendNodeId for labels |
| Keep 4 MCP tools (not upstream's 2)? | Yes | single_spa + tab are domain-specific |
| Tab management in executor? | As VM global calling relay HTTP | Tab leases are relay-level |
| ScopedFS sandbox? | Yes | Enables `require('fs')` safely |
| Per-session executor instances? | Yes, via ExecutorManager | Session isolation |
| Debugger as class (vs inline)? | Extract to class (like upstream) | Upstream uses `./debugger.js` |
| Page lifecycle management? | Port from upstream | Prevents stale page references |
| Relay security middleware? | Port from upstream | Prevents cross-origin attacks |
| `ExecuteResult` with `screenshots`? | Yes, match upstream type | CLI needs screenshot metadata |
| `usefulGlobals` in VM? | Yes | VM sandbox needs setTimeout, fetch, etc. |
