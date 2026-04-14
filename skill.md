## CLI Usage

### Quick Start

```bash
spawriter session new
# outputs: sw-abc123
spawriter -s sw-abc123 -e 'await page.goto("https://example.com")'
```

### Session Management

Each session runs in an **isolated sandbox** with its own `state` object. Use sessions to:

- Keep state separate between different tasks or agents
- Persist data (pages, variables) across multiple execute calls
- Avoid interference when multiple agents use spawriter simultaneously

```bash
spawriter session new          # create a new session, prints ID
spawriter session list         # list all active sessions
spawriter session reset <id>   # reset browser connection for a session
spawriter session delete <id>  # delete a session
```

**Always use your own session** — pass `-s <id>` to all `-e` commands. Using the same session preserves your `state` between calls.

### Execute Code

```bash
spawriter -s <id> -e '<code>'
```

The `-s` flag specifies a session ID (required). The `-e` flag takes Playwright JS code to execute.

**Execution Environment:**

Built-in globals: `page`, `context`, `state` (same as playwriter), plus spawriter extensions.

**Examples:**

```bash
# Navigate to a page
spawriter -s sw-1 -e 'await page.goto("https://example.com")'

# Take a screenshot
spawriter -s sw-1 -e 'await page.screenshot({ path: "shot.png" })'

# Get page title
spawriter -s sw-1 -e 'return await page.title()'

# Persistent state across calls
spawriter -s sw-1 -e 'state.startUrl = page.url(); return state.startUrl'
spawriter -s sw-1 -e 'return state.startUrl'

# Single-spa management
spawriter -s sw-1 -e 'return await singleSpa("status")'
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/app", url: "http://localhost:8080/main.js" })'

# Tab management
spawriter -s sw-1 -e 'await tab("connect", { url: "http://localhost:9000", create: true })'
spawriter -s sw-1 -e 'return await tab("list")'
```

**Why single quotes?** Always wrap `-e` code in single quotes (`'...'`) to prevent bash from interpreting `$`, backticks, and other special characters. Use double quotes or backtick template literals for strings inside the JS code.

### Spawriter Extension Functions

The following functions are injected into the `-e` execution environment in addition to Playwright's `page`, `context`, and `state`. Playwright native operations (`page.goto()`, `page.click()`, `page.screenshot()`, etc.) are used directly — no wrappers needed.

#### `singleSpa(action, opts?)` — Single-spa Management

```bash
# Get all app statuses and import-map-overrides
spawriter -s sw-1 -e 'return await singleSpa("status")'

# Set import-map override (point app to local dev server)
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/navbar", url: "http://localhost:8080/main.js" })'

# After override, reload to see changes
spawriter -s sw-1 -e 'await singleSpa("override_set", { appName: "@org/app", url: "..." }); await page.reload()'

# Remove / enable / disable override
spawriter -s sw-1 -e 'await singleSpa("override_remove", { appName: "@org/navbar" })'
spawriter -s sw-1 -e 'await singleSpa("override_disable", { appName: "@org/navbar" })'
spawriter -s sw-1 -e 'await singleSpa("override_enable", { appName: "@org/navbar" })'

# Clear all overrides
spawriter -s sw-1 -e 'await singleSpa("override_reset_all")'

# Force mount/unmount/unload an app
spawriter -s sw-1 -e 'await singleSpa("mount", { appName: "@org/settings" })'
spawriter -s sw-1 -e 'await singleSpa("unmount", { appName: "@org/settings" })'
```

Actions: `status`, `override_set`, `override_remove`, `override_enable`, `override_disable`, `override_reset_all`, `mount`, `unmount`, `unload`.

#### `tab(action, opts?)` — Tab Lease System

```bash
# Connect to a tab by URL (create if not found)
spawriter -s sw-1 -e 'await tab("connect", { url: "http://localhost:9000", create: true })'

# List available tabs
spawriter -s sw-1 -e 'return await tab("list")'

# Switch to a tab by ref number
spawriter -s sw-1 -e 'await tab("switch", { ref: 2 })'

# Release the currently held tab
spawriter -s sw-1 -e 'await tab("release")'
```

Actions: `connect`, `list`, `switch`, `release`.

#### Inspect Tools (CDP enhanced)

```bash
# Console logs
spawriter -s sw-1 -e 'return await consoleLogs({ level: "error" })'

# Network request log
spawriter -s sw-1 -e 'return await networkLog()'
spawriter -s sw-1 -e 'return await networkLog({ status_filter: "error" })'

# Request detail
spawriter -s sw-1 -e 'return await networkDetail("req-123")'

# CSS inspection
spawriter -s sw-1 -e 'return await cssInspect(".header")'

# Labeled screenshot (spawriter enhanced — with overlay labels)
spawriter -s sw-1 -e 'return await labeledScreenshot()'

# Accessibility snapshot
spawriter -s sw-1 -e 'return await accessibilitySnapshot()'
spawriter -s sw-1 -e 'return await accessibilitySnapshot({ search: "login button" })'
```

#### Network Mocking

```bash
# Enable interception
spawriter -s sw-1 -e 'await networkIntercept.enable()'

# Add mock rule
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/users", mock_status: 200, mock_body: JSON.stringify([{ id: 1, name: "Test" }]) })'

# Block requests (simulate offline)
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/data", block: true })'

# IMPORTANT: always disable when done — rules persist until explicitly removed
spawriter -s sw-1 -e 'await networkIntercept.disable()'
```

#### Debugger

```bash
spawriter -s sw-1 -e 'await debugger.enable()'
spawriter -s sw-1 -e 'await debugger.setBreakpoint("https://example.com/app.js", 42)'
spawriter -s sw-1 -e 'await debugger.resume()'
```

#### Other Extensions

```bash
# Browser fetch (with user's cookies/session)
spawriter -s sw-1 -e 'return await browserFetch("https://api.example.com/data")'

# Storage management
spawriter -s sw-1 -e 'return await storage("get", { type: "localStorage" })'

# Device/network emulation
spawriter -s sw-1 -e 'await emulation({ device: "iPhone 12" })'

# Performance metrics
spawriter -s sw-1 -e 'return await performance("metrics")'
```

### Playwright Native Operations (use directly, no wrapper)

```bash
# Navigation
spawriter -s sw-1 -e 'await page.goto("https://example.com")'

# Screenshots
spawriter -s sw-1 -e 'await page.screenshot({ path: "shot.png" })'

# Click / fill / interact
spawriter -s sw-1 -e 'await page.click("#submit-button")'
spawriter -s sw-1 -e 'await page.fill("input[name=email]", "test@example.com")'

# Wait for elements
spawriter -s sw-1 -e 'await page.waitForSelector(".loaded")'

# Execute in-page JS
spawriter -s sw-1 -e 'return await page.evaluate(() => document.title)'

# Refresh
spawriter -s sw-1 -e 'await page.reload(); await page.waitForLoadState("networkidle")'
```

### Debugging spawriter issues

```bash
spawriter logfile  # prints the log file path
```

---

## Connection Protocol

1. **MCP mode**: `spawriter` or `spawriter serve` starts the MCP server, which auto-connects to the relay
2. **CLI mode**: `spawriter -s <id> -e '<code>'` executes via the relay's `/cli/execute` endpoint
3. **Reconnection**: on connection failure, call `spawriter session reset <id>` or the MCP `reset` tool
4. **session_id**: each session has an independent Playwright VM + persistent `state` object

On first use, determine a `session_id`:
- **MCP mode**: use the agent transcript UUID if available, otherwise generate one. Pass it on `tab { action: "connect" }`, `tab { action: "list" }`, etc.
- **CLI mode**: create with `spawriter session new`, then pass via `-s <id>`

On connection error: retry `tab { action: "connect" }` → `reset` + retry → ask user to check Chrome/extension/relay.

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

- `tab("connect", { url, create: true })` / `tab("list")` / `tab("switch", { ref })` / `tab("release")` for multi-tab work
- On `tab("switch")`: console/network/debugger/intercept state is cleared; Playwright `state` persists
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
