# spawriter CLI Agent Guide

## Quick Start

```bash
spawriter session new
# outputs: sw-abc123
spawriter -s sw-abc123 -e 'page.url()'
```

**Why single quotes?** Always wrap `-e` code in single quotes (`'...'`) to prevent bash from interpreting `$`, backticks, and other special characters. Use double quotes or backtick template literals for strings inside the JS code.

## Session Management

Each session runs in an **isolated sandbox** with its own `state` object. Use sessions to:
- Keep state separate between different tasks or agents
- Persist data (pages, variables) across multiple execute calls
- Avoid interference when multiple agents use spawriter simultaneously

```bash
spawriter session new          # create a new session, prints ID
spawriter session list         # list all active sessions
spawriter session reset <id>   # reset browser connection for a session
spawriter session delete <id>  # delete a session
spawriter -s <id> -e '<code>' # execute code in a session
spawriter relay                # start the relay server
spawriter relay --replace      # replace existing relay server
spawriter logfile              # prints the log file path
```

**Always use your own session** — pass `-s <id>` to all `-e` commands.

## VM Globals Reference

All globals are injected into the Playwright VM sandbox. Playwright native operations (`page.goto()`, `page.click()`, etc.) are used directly — no wrappers needed.

| Global | Description |
|--------|-------------|
| `page`, `context`, `browser` | Playwright core objects |
| `state` | Persistent state object (survives across `execute` calls and tab switches) |
| `navigate(url)` | Navigate to URL |
| `ensureFreshRender()` | Reload page with fresh cache |
| `screenshot()` | Capture page screenshot |
| `screenshotWithLabels()` | Screenshot with numbered interactive element labels |
| `snapshot()` / `accessibilitySnapshot()` | Accessibility tree (text-based, fast) |
| `interact(ref, action, value?)` | Interact with element by ref from `snapshot()` |
| `refToLocator(ref)` | Get locator info for a ref from `snapshot()` |
| `consoleLogs(options?)` | Get captured console logs |
| `getLatestLogs()` | Get persistent browser console logs |
| `clearAllLogs()` | Clear all console logs |
| `networkLog(options?)` | Get captured network requests |
| `networkDetail(requestId)` | Get detailed request/response info |
| `clearNetworkLog()` | Clear network log |
| `networkIntercept` | Network mocking: `.enable()`, `.addRule()`, `.listRules()`, `.removeRule()`, `.disable()` |
| `dbg` | Debugger: `.enable()`, `.disable()`, `.listScripts()`, `.setBreakpoint()`, `.resume()`, etc. |
| `editor(action, opts?)` | Source editor: `list_sources`, `get_source`, `search`, `edit` |
| `browserFetch(url, opts?)` | Fetch from browser context (with user's cookies) |
| `storage(action, opts?)` | Cookie/storage management |
| `emulation(action, opts?)` | Device/network/geo emulation |
| `performance(action?)` | Performance metrics |
| `cssInspect(selector, props?)` | Computed CSS styles for elements |
| `pageContent(action, opts?)` | Page content: `get_text`, `get_html`, `get_metadata`, `search_dom` |
| `singleSpa` | Single-spa management (`.status()`, `.override()`, `.mount()`, `.unmount()`, `.unload()`) |
| `clearCacheAndReload(opts?)` | Origin-scoped cache/storage clear + reload |
| `getCDPSession()` | Raw CDP session accessor (returns null through relay) |
| `resetPlaywright()` | Reset Playwright connection |
| `require(module)` | Sandboxed module import (allowlisted: `path`, `url`, `crypto`, `fs` → ScopedFS, etc.) |
| `import` | ES module dynamic import |

## Usage Examples by Category

### Navigation & Screenshots

```bash
spawriter -s sw-1 -e 'await navigate("https://example.com")'
spawriter -s sw-1 -e 'await screenshot()'
spawriter -s sw-1 -e 'await screenshotWithLabels()'
spawriter -s sw-1 -e 'await ensureFreshRender()'
```

### Accessibility & Interaction

```bash
spawriter -s sw-1 -e 'await snapshot()'
spawriter -s sw-1 -e 'await snapshot({ search: "login button" })'
spawriter -s sw-1 -e 'const s = await snapshot(); await interact(0, "click")'
spawriter -s sw-1 -e 'const s = await snapshot(); refToLocator(0)'
```

### State Persistence

```bash
spawriter -s sw-1 -e 'state.startUrl = page.url(); state.startUrl'
spawriter -s sw-1 -e 'state.startUrl'  # still there from previous call
```

### Single-spa Management

```bash
spawriter -s sw-1 -e 'await singleSpa.status()'
spawriter -s sw-1 -e 'await singleSpa.override("set", "@org/navbar", "http://localhost:8080/main.js")'
spawriter -s sw-1 -e 'await ensureFreshRender()'  # reload to see changes
spawriter -s sw-1 -e 'await singleSpa.override("remove", "@org/navbar")'
spawriter -s sw-1 -e 'await singleSpa.override("reset_all")'
spawriter -s sw-1 -e 'await singleSpa.mount("@org/settings")'
spawriter -s sw-1 -e 'await singleSpa.unmount("@org/settings")'
```

### Console & Network Inspection

```bash
spawriter -s sw-1 -e 'consoleLogs()'
spawriter -s sw-1 -e 'consoleLogs({ level: "error" })'
spawriter -s sw-1 -e 'networkLog()'
spawriter -s sw-1 -e 'networkLog({ status_filter: "error" })'
spawriter -s sw-1 -e 'await networkDetail("req-123")'
```

### Network Mocking

```bash
spawriter -s sw-1 -e 'await networkIntercept.enable()'
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/users", mock_status: 200, mock_body: JSON.stringify([{ id: 1 }]) })'
spawriter -s sw-1 -e 'await networkIntercept.addRule({ url_pattern: "**/api/data", block: true })'  # simulate offline
spawriter -s sw-1 -e 'await networkIntercept.listRules()'
spawriter -s sw-1 -e 'await networkIntercept.disable()'  # always clean up
```

### CSS Inspection

```bash
spawriter -s sw-1 -e 'await cssInspect("h1")'
spawriter -s sw-1 -e 'await cssInspect(".header", ["color", "font-size"])'
```

### Debugger

```bash
spawriter -s sw-1 -e 'await dbg.enable()'
spawriter -s sw-1 -e 'await dbg.listScripts()'
spawriter -s sw-1 -e 'await dbg.setBreakpoint("https://example.com/app.js", 42)'
spawriter -s sw-1 -e 'await dbg.resume()'
spawriter -s sw-1 -e 'await dbg.disable()'
```

### Editor (Live Source Viewing/Editing)

```bash
spawriter -s sw-1 -e 'await editor("list_sources")'
spawriter -s sw-1 -e 'await editor("get_source", { scriptId: "123", startLine: 1, endLine: 50 })'
spawriter -s sw-1 -e 'await editor("search", { query: "handleClick" })'
```

### Storage Management

```bash
spawriter -s sw-1 -e 'await storage("get_cookies")'
spawriter -s sw-1 -e 'await storage("set_cookie", { name: "key", value: "val" })'
spawriter -s sw-1 -e 'await storage("delete_cookie", { name: "key" })'
spawriter -s sw-1 -e 'await storage("get_local_storage")'
spawriter -s sw-1 -e 'await storage("clear_storage", { storage_types: "local_storage" })'
spawriter -s sw-1 -e 'await storage("get_storage_usage")'
```

### Emulation

```bash
spawriter -s sw-1 -e 'await emulation("set_device", { device: "iphone-12" })'
spawriter -s sw-1 -e 'await emulation("set_timezone", { timezone_id: "America/New_York" })'
spawriter -s sw-1 -e 'await emulation("set_geolocation", { latitude: 37.7749, longitude: -122.4194 })'
spawriter -s sw-1 -e 'await emulation("reset")'
```

### Performance

```bash
spawriter -s sw-1 -e 'await performance("get_web_vitals")'
spawriter -s sw-1 -e 'await performance("get_metrics")'
spawriter -s sw-1 -e 'await performance("get_memory")'
spawriter -s sw-1 -e 'await performance("get_resource_timing")'
```

### Browser Fetch & Page Content

```bash
spawriter -s sw-1 -e 'await browserFetch("https://api.example.com/data")'
spawriter -s sw-1 -e 'await pageContent("get_text")'
spawriter -s sw-1 -e 'await pageContent("get_metadata")'
spawriter -s sw-1 -e 'await pageContent("search_dom", { query: "button" })'
```

### Cache & Reload

```bash
spawriter -s sw-1 -e 'await clearCacheAndReload({ clear: "local_storage", reload: true })'
spawriter -s sw-1 -e 'await clearCacheAndReload({ clear: "cache,local_storage,session_storage" })'
```

### Sandboxed Module Import

```bash
spawriter -s sw-1 -e 'const path = require("path"); path.join("a", "b")'
spawriter -s sw-1 -e 'const crypto = require("crypto"); crypto.randomUUID()'
# Blocked modules throw:
spawriter -s sw-1 -e 'try { require("child_process") } catch(e) { e.message }'
```

### Playwright Native Operations

Playwright's `page`, `context`, `browser` are available directly:

```bash
spawriter -s sw-1 -e 'await page.evaluate(() => document.title)'
spawriter -s sw-1 -e 'await page.evaluate(() => window.localStorage.getItem("key"))'
spawriter -s sw-1 -e 'page.url()'
```

**Note**: `page.goto()`, `page.reload()`, `page.screenshot()` may timeout through the relay. Prefer `navigate()`, `ensureFreshRender()`, `screenshot()` which use working fallbacks.

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. **CRITICAL: All cache/cookie/storage clearing is automatically scoped to the current tab's origin. Never attempt to clear storage for other origins — this will destroy the user's login sessions on all sites.**
3. Screenshot between major actions for verification
4. Don't assume code changes are live — verify with `screenshot()` or `snapshot()`
5. Mock rules persist until disabled — always clean up with `networkIntercept.disable()`

## Best Practices

- **Multiple execute calls**: Use separate calls for complex logic — helps understand intermediate state and isolate failures.
- **Snapshot before interact**: Always call `snapshot()` before `interact()` — the ref cache is populated by `snapshot()`.
- **Snapshot before screenshot**: Use `snapshot()` first (text-based, fast). Only use `screenshotWithLabels()` when you need visual/spatial info.
- **Check state after actions**: Always verify page state after clicking/submitting.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool timeout | `spawriter session reset <id>` |
| Override not reflected | `await ensureFreshRender()` |
| App not mounting | Navigate to the app's route first |
| Connection error | `spawriter session reset <id>` then retry |
| Relay not running | `spawriter relay --replace` |
| Playwright locator timeout | Use `page.evaluate()` or `interact()` instead |

## Architecture Notes

The CLI communicates with the relay server via HTTP:
- `/cli/execute` — runs code in the Playwright VM
- `/cli/session/*` — session management
- `/cli/cdp` — raw CDP command forwarding

CDP-dependent features work through a three-tier fallback: Direct CDP → Relay CDP (via extension WebSocket) → Playwright-native / `page.evaluate()`.

Tab ownership is universally enforced across all paths (CLI HTTP, MCP, CDP WebSocket). Unclaimed tabs are auto-claimed on first `execute`.
