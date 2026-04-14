# Remaining Optimization & Testing Work

> Generated: 2026-04-14
> Status: Post-implementation audit
> Context: After completing the Executor Refactor Plan (EXECUTOR_REFACTOR_PLAN.md)

## Current State

### What's Done

- **Core architecture**: `PlaywrightExecutor` (1600 LOC) is the shared execution engine
- **MCP**: 4 tools (`execute`, `reset`, `single_spa`, `tab`) in thin wrapper (505 LOC)
- **Relay**: Inlined CLI control routes with security middleware
- **CLI**: `-e` code execution, session management commands
- **4 new runtime modules**: `ax-tree.ts`, `labeled-screenshot.ts`, `spa-helpers.ts`, `network-monitor.ts`
- **4 obsolete files deleted**: `cli-globals.ts`, `session-store.ts`, `tool-service.ts`, `control-routes.ts`
- **Tests**: 1325 tests across 10 files, all passing
- **CDP fallback**: `screenshot()`, `snapshot()`, `evaluateJs()` gracefully fall back to Playwright APIs when CDP session is unavailable

### Known Issue: CDP Session via Relay

When running through the extension relay (the primary deployment architecture), Playwright's
`context.newCDPSession(page)` sends `Target.attachToBrowserTarget` which Chrome's extension
debugger API (`chrome.debugger`) does not support. Result: `getCDPSession()` returns `null`.

**Impact**: VM globals that depend on CDP direct commands fall back or throw.

| VM Global | CDP Method Used | Fallback Available? | Current Behavior |
|-----------|----------------|--------------------|-|
| `screenshot()` | `Page.captureScreenshot` | **Yes** → `page.screenshot()` | Works |
| `snapshot()` | `Accessibility.getFullAXTree` | **Yes** → `ariaSnapshot()` | Works |
| `evaluateJs()` (used by singleSpa) | `Runtime.evaluate` | **Yes** → `page.evaluate()` | Works |
| `screenshotWithLabels()` | `Accessibility.*` + `DOM.resolveNode` | **No** | Throws "CDP not available" |
| `getLatestLogs()` | None (reads from `networkMonitor`) | N/A | Works (no CDP needed) |
| `clearAllLogs()` | None | N/A | Works |
| `consoleLogs()` | None | N/A | Works |
| `networkLog()` | `Network.*` events | **No** | Throws (CDP needed for enable) |
| `networkDetail()` | None (reads from monitor) | Partial | Needs enable first |
| `networkIntercept` | `Fetch.enable/disable` | **No** | Throws |
| `cssInspect()` | `Runtime.evaluate` + `CSS.*` | Partial | `evaluateJs` fallback works for basic |
| `dbg` (debugger) | `Debugger.*` | **No** | Throws |
| `browserFetch()` | `page.evaluate(fetch(...))` | **Yes** (already uses page.evaluate) | Works |
| `storage()` | `Network.getCookies`, `DOMStorage.*` | Partial | Cookie read fails, localStorage via evaluate works |
| `emulation()` | `Emulation.*`, `Network.*` | **No** | Throws |
| `performance()` | `Performance.*` | **No** | Throws |
| `editor()` | `Debugger.getScriptSource` | **No** | Throws |
| `pageContent()` | `Runtime.evaluate` | **Yes** (via evaluateJs fallback) | Works |
| `interact()` | Uses `refToLocator` + Playwright actions | **Yes** | Works (Playwright native) |
| `clearCacheAndReload()` | `Network.clearBrowserCache`, `Storage.*` | **No** | Throws for some clear types |
| `navigate()` | `page.goto()` | **Yes** | Works (Playwright native) |
| `ensureFreshRender()` | `page.reload()` | **Yes** | Works (Playwright native) |
| `resetPlaywright()` | None | **Yes** | Works |
| `getCDPSession()` | N/A | Returns null | Returns null gracefully |
| `refToLocator()` | None (reads ref cache) | Partial | Works if snapshot was CDP-based |

---

## Priority 1: High Impact (Blocks Real Usage)

### 1.1 CDP Fallback for All VM Globals

**Problem**: ~10 VM globals throw unhandled "CDP session not available" errors when
used through the relay. This makes them unusable for any agent connecting via extension.

**Solution**: For each affected VM global, either:
- (A) Add Playwright-native fallback (preferred, like screenshot/snapshot)
- (B) Add graceful error message: `"Not available through relay connection. Use direct CDP connection or call via MCP."`

**Affected globals and proposed fallbacks:**

| Global | Proposed Fallback |
|--------|-------------------|
| `networkLog()` | Use `page.on('request')` + `page.on('response')` for basic monitoring |
| `networkIntercept` | Use `page.route()` for Playwright-native interception |
| `cssInspect()` | Already partially works via `evaluateJs()` fallback → just needs `page.evaluate()` |
| `dbg` (debugger) | No Playwright equivalent → return "requires direct CDP connection" |
| `storage()` | Cookies: `context.cookies()` / `context.addCookies()`. localStorage: `page.evaluate()` |
| `emulation()` | Viewport: `page.setViewportSize()`. Others: return "requires CDP" |
| `performance()` | `page.evaluate(() => performance.getEntries())` for basic metrics |
| `editor()` | No Playwright equivalent → return "requires direct CDP connection" |
| `clearCacheAndReload()` | Use `page.reload()` + clear cookies via `context.clearCookies()` |
| `screenshotWithLabels()` | Use `snapshot()` for element positions + `page.screenshot()` for image |

**Estimated work**: ~400-600 LOC changes in `buildVmGlobals()` in `pw-executor.ts`

**Files to modify**: `spawriter/src/pw-executor.ts`

### 1.2 MCP stdio End-to-End Test

**Problem**: MCP is the primary user-facing interface, but has zero end-to-end tests.
All 1027 tests in `mcp.test.ts` are unit tests that don't start an MCP server or send
real tool calls.

**Solution**: Create `mcp-e2e.test.ts` that:
1. Spawns `node bin.js serve` as a child process
2. Connects with `@modelcontextprotocol/sdk`'s `Client` over stdio
3. Sends `tools/list` and verifies exactly 4 tools
4. Sends `tools/call` for each tool
5. Verifies response format (text, images, isError)

**Note**: These tests need a running Chrome with extension (can be skipped in CI).

**Estimated work**: ~200 LOC new file

**Files to create**: `spawriter/src/mcp-e2e.test.ts`

### 1.3 screenshotWithLabels Fallback

**Problem**: `screenshotWithLabels()` is the most useful tool for AI agents (screenshot
with numbered labels on interactive elements). Currently requires CDP for
`DOM.resolveNode` (to get element positions from AX tree backendNodeIds).

**Solution**: Use Playwright's `ariaSnapshot()` to get elements, then `locator.boundingBox()`
to get positions, then `page.screenshot()` after injecting labels.

**Estimated work**: ~150 LOC in `pw-executor.ts`

---

## Priority 2: Quality Improvement

### 2.1 Test Migration from mcp.test.ts

**Problem**: ~153 describe blocks in `mcp.test.ts` re-implement functions locally rather
than importing from production modules. This means changes to production code won't be
caught by these tests (false positives).

**Status**: 4 domain-specific test files were already created:
- `runtime/ax-tree.test.ts` (30 tests) — covers the same functions
- `runtime/spa-helpers.test.ts` (33 tests) — covers the same functions
- `runtime/network-monitor.test.ts` (47 tests) — covers the same functions
- `runtime/labeled-screenshot.test.ts` (8 tests) — covers the same functions

**Remaining work**: The existing mcp.test.ts blocks for debugger, CSS inspect, storage,
emulation, performance, editor, page_content, clear_cache_and_reload, tab management,
timeout utilities still use local re-implementations.

**Options**:
- (A) Migrate gradually: Create new test files that import production code for each category
- (B) Update mcp.test.ts to import from production modules directly (less disruption)
- (C) Accept the duplication — it provides regression coverage even if indirect

**Recommended**: Option B for high-value categories (debugger, CSS, storage, timeout).
Leave the rest as-is since they're already covered by the 4 new domain files for the
core functions.

**Estimated work**: ~1000 LOC updates across mcp.test.ts (change local function to import)

### 2.2 Relay `--replace` Port Release Fix

**Problem**: `node bin.js relay --replace` kills the old process but port isn't released
immediately (TIME_WAIT state). The new server fails with EADDRINUSE.

**Solution**: Add retry logic (3 attempts with 1s delay) before giving up. Or use
`server.listen({ reusePort: true })` in Hono/Node.js.

**Estimated work**: ~20 LOC in `relay.ts`

### 2.3 ScopedFS / Sandboxed require (Plan A8)

**Problem**: The VM sandbox has no `require()` function. Users cannot import built-in
Node.js modules (path, url, crypto, etc.) in their code.

**Upstream reference**: playwriter has `ScopedFS` with 20+ allowed modules and a
sandboxed `fs` that restricts file access to the project directory.

**Solution**: Port upstream's allowlist pattern:
```typescript
const ALLOWED_MODULES = new Set([
  'path', 'url', 'crypto', 'buffer', 'util', 'assert',
  'events', 'timers', 'stream', 'zlib', 'http', 'https',
  'os', 'querystring', 'string_decoder',
]);
```

**Estimated work**: ~100 LOC in `pw-executor.ts`

### 2.4 Warning System (Plan A10)

**Problem**: When a page closes during execution, or navigation interrupts code, the
user gets no warning. Upstream playwriter has a scoped warning system that collects
non-fatal events during `execute()` and appends them to the result.

**Solution**: Add `beginWarningScope()` / `flushWarnings()` to PlaywrightExecutor.

**Estimated work**: ~60 LOC in `pw-executor.ts`

---

## Priority 3: Nice to Have

### 3.1 Relay HTTP Integration Tests

**Problem**: `relay.test.ts` has 15 describe blocks covering lease logic and route
validation, but no tests for the `/cli/*` routes (execute, session management).

**Solution**: Add tests that start a relay instance, send HTTP requests, and verify
responses. These would be integration tests requiring a relay process.

**Estimated work**: ~300 LOC in `relay.test.ts`

### 3.2 Kitty Graphics Screenshot Display

**Problem**: CLI screenshot returns base64 image data but the terminal shows only text
(`"Screenshot captured (via Playwright)"`). Terminals supporting Kitty Graphics Protocol
can display images inline.

**Status**: `runtime/kitty-graphics.ts` (23 LOC) exists but may not be wired into the
execute output path for relay-side screenshots.

**Solution**: Check terminal support and emit Kitty escape sequences after screenshot capture.

**Estimated work**: ~30 LOC in `cli.ts`

### 3.3 Update EXECUTOR_REFACTOR_PLAN.md

**Problem**: The plan document still says "Proposed — ready for implementation". It should
be updated to reflect the actual implementation state, including:
- Status: "Implemented" with date
- Deviations: CDP fallback (not in original plan), ScopedFS deferred, Warning system deferred
- Additional changes: 4 domain-specific test files, formatMcpResult tests
- Actual LOC counts vs estimates

**Estimated work**: ~30 minutes of document editing

---

## Dependency Graph

```
1.1 CDP Fallback ─────────────┐
                               ├──→ 1.3 screenshotWithLabels
1.2 MCP E2E Test ─────────────┘

2.1 Test Migration ──────────→ (independent)
2.2 Relay Replace Fix ───────→ (independent)
2.3 ScopedFS ────────────────→ (independent)
2.4 Warning System ──────────→ (independent)

3.1 Relay Integration Tests ─→ depends on 2.2
3.2 Kitty Graphics ──────────→ (independent)
3.3 Plan Doc Update ─────────→ after all P1/P2 done
```

---

## Estimated Total Effort

| Priority | Items | LOC | Time |
|----------|-------|-----|------|
| P1 High | 3 items | ~750-950 LOC | 2-3 hours |
| P2 Medium | 4 items | ~1180 LOC | 2-3 hours |
| P3 Low | 3 items | ~360 LOC | 1-2 hours |
| **Total** | **10 items** | **~2300-2500 LOC** | **5-8 hours** |

---

## Recommended Execution Order

1. **1.1 CDP Fallback** → unblocks all VM globals for relay users
2. **1.3 screenshotWithLabels** → depends on 1.1, high value for AI agents
3. **2.2 Relay Replace Fix** → quick fix, improves DX
4. **1.2 MCP E2E Test** → validates the real user path
5. **2.3 ScopedFS** → enables `require()` in VM
6. **2.1 Test Migration** → improves test reliability
7. **2.4 Warning System** → polish
8. **3.1-3.3** → as time permits
