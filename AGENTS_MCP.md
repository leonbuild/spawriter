# spawriter MCP Tools

spawriter provides the full Playwright browser automation capabilities for the user's **real, visible Chrome browser** through CDP. It can navigate, click, type, upload files, inspect content, capture screenshots, observe network and console activity, and follow the same end-to-end flows a user would perform. It is not headless; all actions affect the visible browser.

spawriter also extends Playwright with single-spa microfrontend tooling. You can override an individual microfrontend with a local or specified build inside the real host application, then inspect and verify the integrated page with the surrounding applications still running. This makes it possible to evaluate the overall experience after an override, not just the microfrontend in isolation.

**Proactively use these tools whenever browser context would improve your work.** Don't wait to be asked — if seeing, reproducing, or verifying the page helps, just do it. Tool parameters are self-documented via MCP tool definitions; this file covers behavioral guidance and non-obvious details.

## Tool Catalog (4 tools)

- **`execute`** — Playwright JS code with spawriter extensions. Globals: `page`, `context`, `browser`, `state`, `navigate`, `ensureFreshRender`, `screenshot`, `screenshotWithLabels`, `snapshot`/`accessibilitySnapshot`, `interact`, `refToLocator`, `consoleLogs`, `getLatestLogs`, `clearAllLogs`, `networkLog`, `networkDetail`, `clearNetworkLog`, `networkIntercept`, `dbg`, `editor`, `browserFetch`, `storage`, `emulation`, `performance`, `cssInspect`, `pageContent`, `singleSpa`, `clearCacheAndReload`, `getCDPSession`, `resetPlaywright`, `require`, `import`
- **`reset`** — Reconnect + clear all state, releasing every tab owned by this MCP server
- **`single_spa`** — Override management, app lifecycle (status/override_set/override_remove/override_enable/override_disable/override_reset_all/mount/unmount/unload)
- **`tab`** — Tab management (connect/list/switch/release) with ownership isolation

## Tab Isolation Policy

Agents must never take over a tab the user is reading. Use tabs in this order only:

1. A tab already owned by this `session_id` (`MINE` in `tab { action: "list" }`).
2. An idle spawriter-attached tab (`AVAILABLE`, the blue-dot tab).
3. A newly created tab.

Never use the user's active/current tab, `/connect-active-tab`, unmanaged existing Chrome tabs, or a tabId copied from the Chrome UI. URL matches do not make a user tab safe. If no owned or blue-dot idle tab is available, create a new tab.

## Connection Protocol

1. Determine a `session_id` (use agent transcript UUID if available). Pass the **same value** on every call that accepts it — `tab`, `execute`, and `single_spa` — so all operations land on the same relay session and the same owned tab.
2. If your session already owns a tab, keep using it; do not reconnect just to navigate.
3. Proactively call `tab { action: "connect", url: "target-url", create: true, session_id: "..." }` when you anticipate needing browser access. This may claim a blue-dot idle tab or create a new tab; it must not claim an unmanaged user tab.
4. On `execute` error "No tab connected": call `tab { action: "connect", url: "about:blank", create: true, session_id: "..." }` first, then retry `execute`.
5. On connection error: retry → `reset` + retry → ask user to check Chrome/extension/relay.

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

- Use overrides to replace one microfrontend's module URL while keeping it inside the real host application
- After setting an override, verify the complete integrated experience, including layout, navigation, shared dependencies, and interactions with surrounding microfrontends
- After `override_set`, call `execute` → `ensureFreshRender()` to reload with the override
- `status` returns app list, statuses, and active import-map-overrides
- Extension panel auto-syncs within ~3s

### tab

- On `switch`: console/network/debugger/intercept state is cleared; `state` persists
- `connect { url, create: true, session_id }` claims a blue-dot idle tab or creates a new tab if no matching idle tab exists
- `connect` only searches idle attached tabs (never touches user's unmanaged tabs)
- `list` shows all attached tabs with ownership info — use only `MINE` or `AVAILABLE` tabIds
- `switch` only to tabIds shown as `MINE` or `AVAILABLE`; never switch to a user/current tab not returned by `list`

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. Never use `/connect-active-tab`, the user's active/current tab, or arbitrary existing Chrome tabs
3. Verify state via `single_spa { action: "status" }` / `execute`, not static assumptions
4. Screenshot between major actions
5. Don't assume code changes are live — confirm visually
6. **CRITICAL: cache/cookie/storage clearing defaults to the current origin — never pass another site's origin explicitly**
7. Mock rules persist until disabled — always clean up

## Troubleshooting

Do not ask the user for help — recover autonomously using this table:

| Symptom | Recovery |
|---------|----------|
| `No tab connected` on execute | `tab { action: "connect", url: "about:blank", create: true, session_id: "..." }` then retry execute |
| Tool timeout / connection error | `reset` then retry |
| Override not reflected | `execute` → `ensureFreshRender()` or `clearCacheAndReload({ clear: "cache" })` |
| App not mounting after override | Navigate to the app's route first |
| Debugger not pausing | `execute` → `dbg.enable()` first |
| All tabs owned by others | `tab { action: "connect", url: "about:blank", create: true, session_id: "..." }` to create a new tab |
