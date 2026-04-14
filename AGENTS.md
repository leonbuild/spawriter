## Connection Protocol

1. **MCP mode**: `spawriter` or `spawriter serve` starts the MCP server, which auto-connects to the relay
2. **CLI mode**: `spawriter -s <id> -e '<code>'` executes via the relay's `/cli/execute` endpoint
3. **Reconnection**: on connection failure, call `spawriter session reset <id>` or the MCP `reset` tool
4. **session_id**: each session has an independent Playwright VM + persistent `state` object

On first use, determine a `session_id`:
- **MCP mode**: use the agent transcript UUID if available, otherwise generate one. Pass it on `tab { action: "connect" }`, `tab { action: "list" }`, etc.
- **CLI mode**: create with `spawriter session new`, then pass via `-s <id>`

On connection error: retry `tab { action: "connect" }` → `reset` + retry → ask user to check Chrome/extension/relay.

## MCP Tool Catalog

4 core MCP tools. CLI agents use `-e` code execution; MCP agents use structured tool calls. Both share the same Playwright VM and spawriter extensions.

### execute

Execute Playwright JS code with spawriter extensions injected.

Globals: `page`, `context`, `state`, `singleSpa()`, `tab()`, `consoleLogs()`, `networkLog()`, `labeledScreenshot()`, `accessibilitySnapshot()`, `networkIntercept`, `dbg`, `browserFetch()`, `storage()`, `emulation()`, `performance()`.

Use for: all Playwright operations + spawriter extensions. Prefer multiple `execute` calls over complex scripts in a single call.

### reset

Recreate CDP connection and reset page/context/state. Also clears spawriter extension state (console logs, intercept rules, etc.).

Use when: MCP stops responding, connection errors, page closed, or other issues.

### single_spa

Manage single-spa micro-frontend applications.

Actions: `status`, `override_set`, `override_remove`, `override_enable`, `override_disable`, `override_reset_all`, `mount`, `unmount`, `unload`.

Parameters: `action` (required), `appName` (for app-specific actions), `url` (for `override_set`).

After setting an override, reload the page to see changes.

### tab

Manage browser tabs via the Tab Lease System.

Actions: `connect` (connect to tab by URL, create if not found), `list` (list all tabs), `switch` (switch by targetId), `release` (release current tab).

Parameters: `action` (required), `url` (for connect), `create` (boolean, for connect), `targetId` (for switch), `session_id`.

> **Note**: The legacy tools (screenshot, accessibility_snapshot, playwright_execute, etc.) are still available but deprecated. Use `execute`, `reset`, `single_spa`, and `tab` instead.

## When to Proactively Use the Browser

Controls the user's **real Chrome tab** via CDP. Not headless — all actions affect the visible browser.

**Proactively use these tools whenever browser context would improve your work.** Don't wait to be asked — if seeing the page helps, just do it.

| Situation | Action |
|-----------|--------|
| User shares a URL | `execute` → `page.goto(url)` + `accessibilitySnapshot()` |
| UI problem reported | `labeledScreenshot()` + `consoleLogs({ level: "error" })` + `networkLog({ status_filter: "error" })` |
| After code changes to UI | `page.reload()` → `labeledScreenshot()` → verify visually |
| "How does X look?" | `labeledScreenshot()` + `accessibilitySnapshot()` |
| Implementing UI feature | Screenshot before AND after each significant change |
| Debugging API issue | `networkLog()` → `networkDetail(requestId)` for full request/response |
| Design reference needed | Navigate to reference → screenshot → navigate back → implement |
| Exploring unfamiliar page | `singleSpa("status")` + `labeledScreenshot()` + `accessibilitySnapshot()` |
| Override set/changed | `singleSpa("status")` + `page.reload()` + `labeledScreenshot()` to confirm |
| "It doesn't work" | `labeledScreenshot()` immediately — look, don't ask |

**Never say "please check it" without checking yourself first.**

## Verification-After-Changes Protocol

After any UI code change, automatically:
1. `page.reload()` (or clear cache if stale: `await page.evaluate(() => caches.keys().then(k => Promise.all(k.map(c => caches.delete(c)))))` then reload)
2. `labeledScreenshot()` — capture result
3. Compare with expectations
4. If wrong: `consoleLogs({ level: "error" })` + `networkLog({ status_filter: "error" })`
5. Report what you see to the user

### When NOT to Use Browser

- Pure backend/algorithmic changes
- User explicitly opts out
- Config edits with no rendering impact

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. Verify state via `singleSpa("status")` / `page.evaluate()`, not static assumptions
3. Screenshot between major actions
4. Don't assume code changes are live — confirm via `singleSpa("status")`
5. All cache/cookie clearing is tab/origin-scoped — never affects other sites
6. Mock rules persist until disabled — always clean up with `networkIntercept.disable()`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool timeout | `reset` to re-establish connections |
| Override not reflected | `page.reload()` or clear cache + reload |
| App not mounting after override | Navigate to the app's route first, then check status |
| Debugger not pausing | Call `debugger.enable()` first |
| Connection error | `reset` then retry |
| Cookie read | Use `Network.getCookies` via CDP, NOT `Storage.getCookies` |
| All tabs leased | `tab("connect", { url, create: true })` to create a new tab |

## Key Usage Notes

### execute Tool — Playwright + spawriter Extensions

- `execute` runs Playwright JS code in a Node VM sandbox with real browser input events (`:hover`/`:focus` work)
- Use for clicks, form fills, keyboard, drag, waiting — anything that needs real browser interaction
- `state` object persists across `execute` calls AND tab switches — use it to store data between navigations
- File downloads work: relay bridges `Browser.setDownloadBehavior` to per-page scope
- Cookie reads: use `Network.getCookies` via CDP, NOT `Storage.getCookies` (fails in extension relay mode)

### single_spa Tool — Single-spa Management

**`singleSpa("status")`** — Get all app statuses + active import-map-overrides. Always check this first on single-spa pages.

**Override workflow:**
1. `singleSpa("override_set", { appName, url })` — point app to localhost
2. `page.reload()` — apply the override
3. `labeledScreenshot()` — verify visually
4. When done: `singleSpa("override_remove", { appName })` or `singleSpa("override_reset_all")`

Extension panel auto-syncs within ~3s of override changes.

### tab Tool — Tab Lease System

- `tab { action: "connect", url, create: true }` / `tab { action: "list" }` / `tab { action: "switch", targetId }` / `tab { action: "release" }` for multi-tab work
- On switch: console/network/debugger/intercept state is cleared; Playwright `state` persists
- After switching, call `reset` if the connection needs to reconnect to the new tab

### Network Mocking via execute

Use `networkIntercept` to mock APIs without a backend:
1. `networkIntercept.enable()` → `networkIntercept.addRule({ url_pattern, mock_status, mock_body })` → test → `networkIntercept.disable()`
2. Use `block: true` to simulate offline/loading states
3. **Always disable when done** — rules persist until explicitly removed

### Common Patterns and Best Practices

**Multiple execute calls**: use multiple execute calls for complex logic — helps understand intermediate state and isolate which action failed.

**Check state after actions**: always verify page state after clicking/submitting. Your mental model can diverge from actual browser state.

**Snapshot before screenshot**: use `accessibilitySnapshot()` first to understand page state (text-based, fast, cheap). Only use `labeledScreenshot()` when you need visual/spatial information.

**State persistence**: `state` persists within a session. Use it to store page references, collected data, and configuration across calls.
