# spawriter MCP Tools

Controls the user's **real Chrome tab** via CDP. Not headless — all actions affect the visible browser.

**Proactively use these tools whenever browser context would improve your work.** Don't wait to be asked — if seeing the page helps, just do it. Tool parameters are self-documented via MCP tool definitions; this file covers behavioral guidance and non-obvious details.

## Tool Catalog (4 tools)

- **`execute`** — Playwright JS code with spawriter extensions. Globals: `page`, `context`, `browser`, `state`, `navigate`, `ensureFreshRender`, `screenshot`, `screenshotWithLabels`, `snapshot`/`accessibilitySnapshot`, `interact`, `refToLocator`, `consoleLogs`, `getLatestLogs`, `clearAllLogs`, `networkLog`, `networkDetail`, `clearNetworkLog`, `networkIntercept`, `dbg`, `editor`, `browserFetch`, `storage`, `emulation`, `performance`, `cssInspect`, `pageContent`, `singleSpa`, `clearCacheAndReload`, `getCDPSession`, `resetPlaywright`, `require`, `import`
- **`reset`** — Full reconnect + clear all state
- **`single_spa`** — Override management, app lifecycle (status/set/remove/enable/disable/reset_all/mount/unmount/unload)
- **`tab`** — Tab management (connect/list/switch/release) with lease isolation

## Connection Protocol

1. Determine a `session_id` (use agent transcript UUID if available). Pass on `tab { action: "connect" }`, `tab { action: "list" }`, etc.
2. Proactively call `tab { action: "connect", url: "target-url", create: true, session_id: "..." }` when you anticipate needing browser access.
3. On connection error: retry → `reset` + retry → ask user to check Chrome/extension/relay.

## When to Proactively Use the Browser

| Situation | Action |
|-----------|--------|
| User shares a URL | `execute` → `navigate(url)` + `screenshot()` + `snapshot()` |
| UI problem reported | `execute` → `screenshotWithLabels()` + `consoleLogs({ level: "error" })` + `networkLog({ status_filter: "error" })` |
| After code changes to UI | `execute` → `ensureFreshRender()` → `screenshotWithLabels()` → verify |
| "How does X look?" | `execute` → `screenshotWithLabels()` + `snapshot()` |
| Debugging API issue | `execute` → `networkLog()` → `networkDetail(requestId)` |
| Exploring unfamiliar page | `single_spa { action: "status" }` + `execute` → `screenshotWithLabels()` |
| Override set/changed | `single_spa { action: "status" }` + `execute` → `ensureFreshRender()` + `screenshotWithLabels()` |
| "It doesn't work" | `execute` → `screenshotWithLabels()` immediately — look, don't ask |

**Never say "please check it" without checking yourself first.**

### Verification-After-Changes Protocol

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

## Key Usage Notes

### execute

- `snapshot()` populates the ref cache — always call it before `interact(ref, action)`
- `state` persists across `execute` calls AND tab switches — use it to store data between calls
- Playwright locators (`page.getByRole()` etc.) may timeout through the relay — prefer `page.evaluate()`, `interact()`, `snapshot()`
- `networkIntercept.disable()` when done — rules persist until explicitly removed

### single_spa

- After `override_set`, call `execute` → `ensureFreshRender()` to reload with the override
- `status` returns app list, statuses, and active import-map-overrides
- Extension panel auto-syncs within ~3s

### tab

- On `switch`: console/network/debugger/intercept state is cleared; `state` persists
- `connect { url, create: true }` creates a new tab if no matching tab exists

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. Verify state via `single_spa { action: "status" }` / `execute`, not static assumptions
3. Screenshot between major actions
4. Don't assume code changes are live — confirm visually
5. **CRITICAL: All cache/cookie/storage clearing is automatically origin-scoped — never affects other sites**
6. Mock rules persist until disabled — always clean up

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool timeout | `reset` to re-establish connections |
| Override not reflected | `execute` → `ensureFreshRender()` or `clearCacheAndReload({ clear: "cache" })` |
| App not mounting after override | Navigate to the app's route first |
| Debugger not pausing | `execute` → `dbg.enable()` first |
| Connection error | `reset` then retry |
| All tabs leased | `tab { action: "connect", url: "...", create: true }` |
