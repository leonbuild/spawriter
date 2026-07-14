# spawriter CLI Guide for AI Agents

spawriter provides the full Playwright browser automation capabilities for the user's real, visible Chrome browser. It can navigate, click, type, upload files, inspect content, capture screenshots, observe network and console activity, and follow the same end-to-end flows a user would perform.

It also extends Playwright with single-spa microfrontend tooling. You can override an individual microfrontend with a local or specified build inside the real host application, then inspect and verify the integrated page with the surrounding applications still running. This makes it possible to evaluate the overall experience after an override, not just the microfrontend in isolation.

Use spawriter proactively when browser context materially improves inspection, reproduction, or verification. Do not use it for purely backend, algorithmic, documentation-only, or configuration tasks unless browser verification is relevant.

## Quick Start

```bash
spawriter session new
# outputs: sw-abc123
spawriter -s sw-abc123 -e 'page.url()'
```

**Why single quotes?** In bash, always wrap `-e` code in single quotes (`'...'`) to prevent the shell from interpreting `$`, backticks, and other special characters. Use double quotes or backtick template literals for strings inside the JS code.

**Windows:** quoting rules differ from bash. Prefer stdin or a file instead of inline `-e`.

```powershell
# Single quotes preserve the JavaScript exactly; do not backslash-escape inner double quotes.
'await navigate("https://example.com")' | spawriter -s sw-abc123 -e -

# Or write the code to a file and run it.
spawriter -s sw-abc123 -f script.js
```

## Session Management

Each session runs in an **isolated sandbox** with its own `state` object. Use sessions to:
- Keep state separate between different tasks or agents
- Persist data (pages, variables) across multiple execute calls
- Avoid interference when multiple agents use spawriter simultaneously

```bash
spawriter session new                   # create a new session, prints ID
spawriter session list                  # list all active sessions
spawriter session reset <id>            # reset browser connection for a session
spawriter session delete <id>           # delete a session
spawriter session bind <tabId> -s <id>  # bind only to a safe tabId you created or own
spawriter tabs list -s <id>             # list tabs with MINE/AVAILABLE/OWNED status
spawriter tabs connect <url> --create -s <id>   # connect + claim a tab (use --force-create to always create)
spawriter tabs release [tabId] -s <id>  # release one owned tab, or all if omitted
spawriter -s <id> -e '<code>'           # execute code in a session
spawriter -s <id> -e -                  # execute code read from stdin
spawriter -s <id> -f <path>             # execute code from a file
spawriter relay                         # start the relay server
spawriter relay --replace               # replace existing relay server
spawriter logfile                       # prints the log file path
```

**Always use your own session** — pass `-s <id>` to all `-e` commands.

## Tab Isolation Policy

Agents must never take over a tab the user is reading. Use tabs in this order only:

1. A tab already owned by your session.
2. An idle spawriter-attached tab shown as a blue dot / `AVAILABLE`.
3. A newly created tab.

Never use `/connect-active-tab`, never bind the current Chrome tab, and never bind an arbitrary existing tab just because its URL matches. If no owned or blue-dot idle tab is available, create a new tab.

## Tab Acquisition & Recovery

On first `-e` execute, spawriter auto-acquires safely: owned session tab -> blue-dot idle attached tab -> newly created inactive tab. It must not attach the user's active tab or any unmanaged existing tab. If you get `No tab connected to this session`, recover in this order:

1. `spawriter session reset <id>` — retries safe auto-acquisition
2. If still fails, connect and claim a new tab:
   ```bash
   spawriter tabs connect about:blank --force-create -s <id>
   ```
   Use the target URL instead of `about:blank` when you already know where the agent should work.
3. If relay is down: `spawriter relay --replace`

After binding, `-e` commands work normally.

## VM Globals Reference

All globals are injected into the Playwright VM sandbox, and native Playwright APIs remain available. Through the relay, prefer `navigate()`, `ensureFreshRender()`, and `screenshot()` for navigation, reloads, and screenshots because they include relay-safe fallbacks.

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
| `getPageMarkdown(opts?)` | Main article content as Markdown (Readability); diff on repeat calls, `search` filter |
| `getCleanHTML(opts?)` | Deeply cleaned LLM-friendly HTML (`selector`, `search`, `includeStyles`); diff on repeat calls |
| `waitForPageLoad(opts?)` | Wait until readyState complete + no meaningful pending requests (SPA-aware) |
| `getReactSource(target)` | React component name + source file:line for a snapshot ref or CSS selector |
| `getReactComponentInfo(target)` | React component props + hierarchy for a snapshot ref or CSS selector |
| `singleSpa` | Single-spa management (`.status()`, `.override()`, `.mount()`, `.unmount()`, `.unload()`) |
| `clearCacheAndReload(opts?)` | Origin-scoped cache/storage clear + reload |
| `getCDPSession()` | Raw CDP session accessor (normally returns a live session, including through the relay; null only if creation failed) |
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

Use single-spa overrides to replace one microfrontend's module URL while keeping it inside the real host application. After setting an override, reload the page and verify the complete integrated experience, including layout, navigation, shared dependencies, and interactions with surrounding microfrontends.

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

### LLM-Friendly Content Extraction

```bash
spawriter -s sw-1 -e 'await getPageMarkdown()'                          # main article as Markdown (Readability)
spawriter -s sw-1 -e 'await getPageMarkdown({ search: "pricing" })'     # matching lines with context
spawriter -s sw-1 -e 'await getCleanHTML()'                             # deeply cleaned HTML of <body>
spawriter -s sw-1 -e 'await getCleanHTML({ selector: "#main" })'
# Repeat calls return a diff by default; pass { showDiffSinceLastCall: false } for full content.
```

### Smart Page-Load Waiting

```bash
spawriter -s sw-1 -e 'await navigate("https://example.com"); await waitForPageLoad()'
spawriter -s sw-1 -e 'await waitForPageLoad({ timeout: 10000 })'
# Settles when readyState is complete AND no meaningful requests are pending
# (ad/analytics beacons and stuck requests are ignored).
```

### React Component Inspection

```bash
spawriter -s sw-1 -e 'await snapshot()'                                 # populates refs
spawriter -s sw-1 -e 'await getReactSource(5)'                          # component name + source file:line
spawriter -s sw-1 -e 'await getReactSource(".nav-item")'                # CSS selector target
spawriter -s sw-1 -e 'await getReactComponentInfo(5)'                   # + props and hierarchy
# Source locations require a React dev build; production builds return an explanatory error.
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
2. Never use `/connect-active-tab` or bind arbitrary active/existing Chrome tabs. Only use your owned tab, a blue-dot idle spawriter tab, or a newly created tab.
3. **All clearing is origin-scoped and enforced: browser-wide clears (`context.clearCookies()`, CDP `Network.clearBrowserCookies`/`Network.clearBrowserCache`/`Storage.clearCookies`, cross-origin `Storage.clearDataForOrigin`) are blocked by the relay and extension. Use `storage("delete_cookie"/"clear_storage")` or `clearCacheAndReload({ clear })` — they always target the current tab's origin; origin overrides are rejected.**
4. Verify major state transitions; prefer `snapshot()` for structural checks and use `screenshot()` when visual confirmation matters
5. Don't assume code changes are live — verify with `screenshot()` or `snapshot()`
6. Mock rules persist until disabled — always clean up with `networkIntercept.disable()`

## Best Practices

- **Multiple execute calls**: Use separate calls for complex logic — helps understand intermediate state and isolate failures.
- **Snapshot before interact**: Always call `snapshot()` before `interact()` — the ref cache is populated by `snapshot()`.
- **Snapshot before screenshot**: Use `snapshot()` first (text-based, fast). Only use `screenshotWithLabels()` when you need visual/spatial info.
- **Check state after actions**: Always verify page state after clicking/submitting.

## Troubleshooting

Attempt these recovery steps before asking the user. Ask for user action only when authentication, permissions, extension setup, or another user-controlled prerequisite blocks progress:

| Symptom | Recovery |
|---------|----------|
| `No tab connected to this session` | `spawriter session reset <id>` → if still fails: `spawriter tabs connect <url> --force-create -s <id>` |
| Tool timeout / connection error | `spawriter session reset <id>` then retry |
| Relay not running | `spawriter relay --replace` then retry |
| Override not reflected | `await ensureFreshRender()` |
| App not mounting | Navigate to the app's route first |
| Playwright locator timeout | Use `page.evaluate()` or `interact()` instead |
