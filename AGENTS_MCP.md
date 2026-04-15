# spawriter MCP Agent Guide

## Connection Protocol

1. **Start**: `spawriter` or `spawriter serve` starts the MCP server, which auto-connects to the relay
2. **session_id**: use the agent transcript UUID if available, otherwise generate one. Pass on `tab { action: "connect" }`, `tab { action: "list" }`, etc.
3. **Reconnection**: on connection failure, call the MCP `reset` tool → retry → ask user to check Chrome/extension/relay

## MCP Tool Catalog

4 core MCP tools. All share the same Playwright VM with spawriter extensions injected.

### execute

Execute Playwright JS code with spawriter extensions.

**Globals**: `page`, `context`, `state`, `navigate()`, `ensureFreshRender()`, `screenshot()`, `screenshotWithLabels()`, `snapshot()`, `interact()`, `consoleLogs()`, `networkLog()`, `networkIntercept`, `dbg`, `editor()`, `browserFetch()`, `storage()`, `emulation()`, `performance()`, `cssInspect()`, `pageContent()`, `singleSpa`, `clearCacheAndReload()`, `getCDPSession()`, `resetPlaywright()`, `require()`, `import`.

Use for: all Playwright operations + spawriter extensions. Prefer multiple `execute` calls over complex scripts in a single call.

### reset

Recreate CDP connection and reset page/context/state. Also clears spawriter extension state (console logs, intercept rules, etc.).

Use when: MCP stops responding, connection errors, page closed, or other issues.

### single_spa

Manage single-spa micro-frontend applications.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `status` | — | Get all app statuses + active overrides |
| `override_set` | `appName`, `url` | Point app to localhost |
| `override_remove` | `appName` | Remove override |
| `override_enable` | `appName` | Enable disabled override |
| `override_disable` | `appName` | Temporarily disable override |
| `override_reset_all` | — | Clear all overrides |
| `mount` | `appName` | Force mount an app |
| `unmount` | `appName` | Force unmount an app |
| `unload` | `appName` | Force unload an app |

After setting an override, reload the page to see changes.

### tab

Manage browser tabs via the Tab Lease System.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `connect` | `url`, `create?` | Connect to tab by URL, create if not found |
| `list` | `session_id` | List all tabs with lease status |
| `switch` | `targetId` | Switch to a specific tab |
| `release` | — | Release current tab lease |

On tab switch: console/network/debugger/intercept state is cleared; Playwright `state` persists.

## When to Proactively Use the Browser

Controls the user's **real Chrome tab** via CDP. Not headless — all actions affect the visible browser.

**Proactively use these tools whenever browser context would improve your work.** Don't wait to be asked — if seeing the page helps, just do it.

| Situation | Action |
|-----------|--------|
| User shares a URL | `execute` → `navigate(url)` + `snapshot()` |
| UI problem reported | `execute` → `screenshotWithLabels()` + `consoleLogs({ level: "error" })` + `networkLog({ status_filter: "error" })` |
| After code changes to UI | `execute` → `ensureFreshRender()` → `screenshotWithLabels()` → verify |
| "How does X look?" | `execute` → `screenshotWithLabels()` + `snapshot()` |
| Implementing UI feature | Screenshot before AND after each significant change |
| Debugging API issue | `execute` → `networkLog()` → `networkDetail(requestId)` |
| Design reference needed | Navigate to reference → screenshot → navigate back → implement |
| Exploring unfamiliar page | `single_spa { action: "status" }` + `execute` → `screenshotWithLabels()` + `snapshot()` |
| Override set/changed | `single_spa { action: "status" }` + `execute` → `ensureFreshRender()` + `screenshotWithLabels()` |
| "It doesn't work" | `execute` → `screenshotWithLabels()` immediately — look, don't ask |

**Never say "please check it" without checking yourself first.**

## Verification-After-Changes Protocol

After any UI code change, automatically:
1. `execute` → `ensureFreshRender()` (or `clearCacheAndReload()` if cache may be stale)
2. `execute` → `screenshotWithLabels()` — capture result
3. Compare with expectations
4. If wrong: `execute` → `consoleLogs({ level: "error" })` + `networkLog({ status_filter: "error" })`
5. Report what you see to the user

### When NOT to Use Browser

- Pure backend/algorithmic changes
- User explicitly opts out
- Config edits with no rendering impact

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. Verify state via `single_spa { action: "status" }` / `execute` → `page.evaluate()`, not static assumptions
3. Screenshot between major actions
4. Don't assume code changes are live — confirm with `single_spa { action: "status" }` or `screenshot()`
5. **CRITICAL: All cache/cookie/storage clearing is automatically scoped to the current tab's origin. The `storage('clear_storage')` and `clearCacheAndReload()` functions ONLY clear storage for the current page's origin. Never attempt to bypass this scoping — it will destroy the user's login sessions on all sites.**
6. Mock rules persist until disabled — always clean up with `networkIntercept.disable()`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool timeout | Call `reset` tool to re-establish connections |
| Override not reflected | `execute` → `ensureFreshRender()` or `clearCacheAndReload({ clear: "cache" })` |
| App not mounting after override | Navigate to the app's route first, then check status |
| Debugger not pausing | `execute` → `dbg.enable()` first |
| Connection error | `reset` then retry |
| Cookie read | `execute` → `storage('get_cookies')` — auto-detects CDP vs Playwright fallback |
| All tabs leased | `tab { action: "connect", url: "...", create: true }` to create a new tab |

## Key Usage Patterns

### Snapshot Before Interact

Always call `snapshot()` before `interact()` — the ref cache is populated by `snapshot()`:

```javascript
const s = await snapshot();
// s contains refs like @0, @1, etc.
await interact(0, 'click');  // click element @0
```

### State Persistence

`state` persists within a session across `execute` calls and tab switches:

```javascript
// Call 1: store data
state.collectedUrls = ['https://example.com'];

// Call 2: use stored data
console.log(state.collectedUrls);  // ['https://example.com']
```

### Network Mocking

```javascript
await networkIntercept.enable();
await networkIntercept.addRule({
  url_pattern: '*api/users*',
  mock_status: 200,
  mock_body: JSON.stringify({ users: [] })
});
// ... test with mocked API ...
await networkIntercept.disable();  // always clean up
```

### Single-spa Override Workflow

```javascript
// Via single_spa tool:
single_spa({ action: "override_set", appName: "@org/app", url: "http://localhost:8080/app.js" })
// Then via execute:
await ensureFreshRender();
await screenshotWithLabels();  // verify
// When done:
single_spa({ action: "override_remove", appName: "@org/app" })
```

### Playwright Locator Limitations

`page.getByRole()` and other Playwright locators may timeout through the relay. Prefer:
- `page.evaluate()` for DOM queries
- `interact(ref, action)` for element interactions (uses DOM queries internally)
- `snapshot()` for understanding page structure

## CDP Fallback Architecture

All VM globals work through the relay even without a direct Playwright CDP session. The MCP uses `remoteRelaySendCdp()` which sends HTTP POST to `/cli/cdp` on the relay, which forwards CDP commands to the Chrome extension.

Three-tier fallback:
1. **Direct CDP** (`cdpSession.send`) — when Playwright has a direct CDP connection
2. **Relay CDP** (`remoteRelaySendCdp → /cli/cdp → relay → extension`) — raw CDP commands via HTTP + WebSocket
3. **Playwright-native / page.evaluate** — navigation, DOM interaction, cookie access

| Global | Fallback Path |
|--------|--------------|
| `navigate()` | `page.evaluate('window.location.href = url')` |
| `ensureFreshRender()` | `page.evaluate('window.location.reload()')` |
| `screenshot()` | relay CDP `Page.captureScreenshot` |
| `screenshotWithLabels()` | relay CDP screenshot + DOM label injection |
| `snapshot()` | Playwright `ariaSnapshot()` with ref cache |
| `interact()` | `page.evaluate()` DOM click/fill/hover |
| `dbg.*` | relay CDP `Debugger.*` / `Runtime.*` |
| `editor()` | relay CDP `Debugger.*` |
| `performance()` | relay CDP `Performance.*` / `page.evaluate()` |
| `emulation()` | relay CDP `Emulation.*` / `Network.*` |
| `storage()` | relay CDP `Network.*` / Playwright `context.cookies()` |
| `networkIntercept` | Playwright `page.route()` |
| `clearCacheAndReload()` | origin-scoped clear + `page.evaluate('location.reload()')` |

## Tab Lease System

The lease system provides multi-agent tab isolation for parallel AI agents:

- **No lease = open access**: Any agent can use any tab
- **Leased tab**: Only the lease holder can send CDP commands; others are rejected
- **Auto-cleanup**: Leases are released when the agent disconnects or the tab is detached
- Leases apply to the CDP WebSocket path; MCP HTTP routes (`/cli/cdp`) do not enforce leases
