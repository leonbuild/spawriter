# spawriter Unified Agent Guide

spawriter provides the full Playwright browser automation capabilities for the user's real, visible Chrome browser through CDP. It can navigate, click, type, upload files, inspect content, capture screenshots, observe network and console activity, and follow the same end-to-end flows a user would perform. All browser actions affect the visible browser.

spawriter also extends Playwright with single-spa microfrontend tooling. You can override an individual microfrontend with a local or specified build inside the real host application, then inspect and verify the integrated page with the surrounding applications still running. This makes it possible to evaluate the overall experience after an override, not just the microfrontend in isolation.

Proactively use spawriter whenever browser context would improve the work. Do not wait to be asked when inspecting, reproducing, or verifying the visible page is useful.

## Transport Priority

Use one transport at a time in this order:

1. Prefer the spawriter MCP tools when they are available.
2. If MCP is unavailable, or MCP still fails after retrying and running its recovery steps, fall back to the `spawriter` CLI.
3. If CLI recovery also fails, report the blocker and ask the user to check Chrome, the extension, or the relay.

Do not invoke MCP and CLI in parallel. Once a transport has a working session and tab, keep using it for the current browser workflow. The behavioral, isolation, verification, and safety rules below apply equally to both transports.

## MCP Interface

The spawriter MCP server provides four tools:

- `execute`: Run Playwright JavaScript with the spawriter VM globals.
- `reset`: Reconnect and clear MCP browser state.
- `single_spa`: Manage overrides and application lifecycle.
- `tab`: Connect, list, switch, and release tabs with ownership isolation.

Use a stable `session_id`, preferably the agent transcript UUID when available, for every `tab` call in the workflow.

### MCP Connection

1. Call `tab` with `{ action: "list", session_id: "..." }` and reuse a tab marked `MINE` when one exists.
2. Otherwise call `tab` with `{ action: "connect", url: "target-url", create: true, session_id: "..." }`. This may claim a blue-dot `AVAILABLE` tab or create a new tab.
3. On `execute` error `No tab connected`, connect to a new safe tab with `{ action: "connect", url: "about:blank", create: true, session_id: "..." }`, then retry.
4. On another MCP connection or tool error, retry once, call `reset`, then retry.
5. If MCP remains unavailable or broken, switch to the CLI fallback.

## CLI Fallback

Create one isolated CLI session and pass its ID to every execute command:

```bash
spawriter session new
# outputs: sw-abc123
spawriter -s sw-abc123 -e 'page.url()'
```

In bash, always wrap `-e` code in single quotes (`'...'`) so the shell does not interpret `$`, backticks, or other JavaScript syntax. Use double quotes or template literals for strings inside the JavaScript code. On Windows (PowerShell/CMD), prefer stdin (`-e -`) or a file (`-f <path>`) instead of inline `-e` to avoid shell quoting issues.

### CLI Session Commands

```bash
spawriter session new
spawriter session list
spawriter session reset <id>
spawriter session delete <id>
spawriter session bind <tabId> -s <id>
spawriter tabs list -s <id>                       # tabs with MINE/AVAILABLE/OWNED status
spawriter tabs connect <url> --create -s <id>     # connect + claim (like MCP tab connect)
spawriter tabs release [tabId] -s <id>            # release one or all owned tabs
spawriter -s <id> -e '<code>'
spawriter -s <id> -e -                  # code from stdin
spawriter -s <id> -f <path>             # code from a file
spawriter relay
spawriter relay --replace
spawriter logfile
```

### CLI Connection

On the first `-e` call, spawriter safely auto-acquires an owned session tab, a blue-dot idle attached tab, or a newly created inactive tab.

If `No tab connected to this session` occurs:

1. Run `spawriter session reset <id>`.
2. If it still fails, connect and claim a new tab:

   ```bash
   spawriter tabs connect about:blank --force-create -s <id>
   ```

3. Use the target URL instead of `about:blank` when it is already known.
4. If the relay is unavailable, run `spawriter relay --replace` and retry.

## Tab Isolation Policy

Never take over a tab the user is reading. Use tabs only in this order:

1. A tab already owned by the current MCP or CLI session.
2. An idle spawriter-attached tab marked `AVAILABLE` or shown with a blue dot.
3. A newly created tab.

Never use `/connect-active-tab`, the user's active or current tab, an unmanaged existing Chrome tab, or a tab ID copied from the Chrome UI. A matching URL does not make a user tab safe.

For MCP, only switch to tab IDs returned by `tab { action: "list" }` as `MINE` or `AVAILABLE`. For CLI, only bind a tab created for the session or otherwise confirmed safe and owned.

## When to Use the Browser

| Situation | Action |
|-----------|--------|
| User shares a URL | Navigate, then call `screenshot()` and `snapshot()` |
| UI problem reported | Call `screenshotWithLabels()`, `consoleLogs({ level: "error" })`, and `networkLog({ status_filter: "error" })` |
| After UI code changes | Call `ensureFreshRender()`, then `screenshotWithLabels()` and verify |
| User asks how something looks | Call `screenshotWithLabels()` and `snapshot()` |
| Debugging an API issue | Call `networkLog()`, then `networkDetail(requestId)` |
| Exploring an unfamiliar page | Check single-spa status, then call `screenshotWithLabels()` |
| Override set or changed | Check single-spa status, call `ensureFreshRender()`, then verify visually |
| User says it does not work | Inspect the page immediately before asking questions |

Do not tell the user to check the browser without checking it yourself first.

### When Not to Use the Browser

- Pure backend or algorithmic changes
- Config edits with no rendering impact
- The user explicitly opts out

## Verification After Changes

After every UI code change:

1. Call `ensureFreshRender()`, or `clearCacheAndReload()` when stale cache is possible.
2. Call `screenshotWithLabels()` to capture the result.
3. Compare the visible result with the expected behavior.
4. If it is wrong, inspect `consoleLogs({ level: "error" })` and `networkLog({ status_filter: "error" })`.
5. Fix the issue and verify again before reporting the result.

CLI example:

```bash
spawriter -s <id> -e 'await ensureFreshRender()'
spawriter -s <id> -e 'await screenshotWithLabels()'
spawriter -s <id> -e 'consoleLogs({ level: "error" })'
spawriter -s <id> -e 'networkLog({ status_filter: "error" })'
```

With MCP, run the same JavaScript through `execute`.

## VM Globals

The following globals are available in MCP `execute` and CLI `spawriter -e`:

| Global | Description |
|--------|-------------|
| `page`, `context`, `browser` | Playwright core objects |
| `state` | Persistent state across execute calls and tab switches |
| `navigate(url)` | Navigate to a URL |
| `ensureFreshRender()` | Reload with fresh cache |
| `screenshot()` | Capture a screenshot |
| `screenshotWithLabels()` | Capture a screenshot with numbered interactive labels |
| `snapshot()` / `accessibilitySnapshot()` | Read the accessibility tree |
| `interact(ref, action, value?)` | Interact using a ref populated by `snapshot()` |
| `refToLocator(ref)` | Resolve locator information for a ref |
| `consoleLogs(options?)` | Read captured console logs |
| `getLatestLogs()` | Read persistent browser console logs |
| `clearAllLogs()` | Clear console logs |
| `networkLog(options?)` | Read captured network requests |
| `networkDetail(requestId)` | Read request and response details |
| `clearNetworkLog()` | Clear the network log |
| `networkIntercept` | Enable, add, list, remove, and disable mock rules |
| `dbg` | Enable and control the debugger |
| `editor(action, opts?)` | List, read, search, and edit loaded source |
| `browserFetch(url, opts?)` | Fetch using the browser context and user cookies |
| `storage(action, opts?)` | Manage cookies and origin-scoped storage |
| `emulation(action, opts?)` | Control device, network, timezone, and geolocation |
| `performance(action?)` | Read performance metrics |
| `cssInspect(selector, props?)` | Read computed CSS styles |
| `pageContent(action, opts?)` | Read text, HTML, metadata, or search the DOM |
| `singleSpa` | Manage single-spa applications and overrides |
| `clearCacheAndReload(opts?)` | Clear origin-scoped data and reload |
| `getCDPSession()` | Access the raw CDP session when supported |
| `resetPlaywright()` | Reset the Playwright connection |
| `require(module)` | Import an allowlisted sandbox module |
| `import` | Dynamically import an ES module |

## Common Operations

The JavaScript below can be passed directly to MCP `execute`. For CLI, wrap it as `spawriter -s <id> -e '<code>'`.

### Navigation and Inspection

```javascript
await navigate("https://example.com")
await snapshot()
await screenshot()
await screenshotWithLabels()
await ensureFreshRender()
```

### Interaction

Always call `snapshot()` before `interact()` because it populates the ref cache.

```javascript
const tree = await snapshot()
await interact(0, "click")
refToLocator(0)
```

### Console and Network

```javascript
consoleLogs({ level: "error" })
networkLog({ status_filter: "error" })
await networkDetail("req-123")
```

### Single-spa

MCP should prefer the dedicated `single_spa` tool for status and lifecycle operations. The equivalent execute globals are:

Use overrides to replace one microfrontend's module URL while keeping it inside the real host application. After setting an override, reload and verify the complete integrated experience, including layout, navigation, shared dependencies, and interactions with surrounding microfrontends.

```javascript
await singleSpa.status()
await singleSpa.override("set", "@org/navbar", "http://localhost:8080/main.js")
await ensureFreshRender()
await singleSpa.override("remove", "@org/navbar")
await singleSpa.override("reset_all")
await singleSpa.mount("@org/settings")
await singleSpa.unmount("@org/settings")
```

After changing an override, always refresh and verify the rendered page.

### Network Mocking

```javascript
await networkIntercept.enable()
await networkIntercept.addRule({
  url_pattern: "**/api/users",
  mock_status: 200,
  mock_body: JSON.stringify([{ id: 1 }])
})
await networkIntercept.listRules()
await networkIntercept.disable()
```

Mock rules persist. Always call `networkIntercept.disable()` when finished.

### Storage and Cache

```javascript
await storage("get_cookies")
await storage("get_local_storage")
await storage("clear_storage", { storage_types: "local_storage" })
await clearCacheAndReload({ clear: "cache,local_storage,session_storage" })
```

All clearing operations must remain scoped to the current page origin.

### Debugger and Source Inspection

```javascript
await dbg.enable()
await dbg.listScripts()
await dbg.setBreakpoint("https://example.com/app.js", 42)
await dbg.resume()
await dbg.disable()

await editor("list_sources")
await editor("get_source", { scriptId: "123", startLine: 1, endLine: 50 })
await editor("search", { query: "handleClick" })
```

### CSS, Content, and Performance

```javascript
await cssInspect(".header", ["color", "font-size"])
await pageContent("get_text")
await pageContent("get_metadata")
await pageContent("search_dom", { query: "button" })
await performance("get_web_vitals")
await performance("get_metrics")
```

## Key Usage Notes

- `state` persists across execute calls and tab switches.
- Prefer separate execute calls for complex workflows so intermediate results can be inspected.
- Prefer `snapshot()` before screenshots when text and semantics are sufficient.
- Use `screenshotWithLabels()` when visual position or element labeling matters.
- Verify page state after every click, submission, navigation, or override.
- Playwright locators may time out through the relay. Prefer `page.evaluate()`, `snapshot()`, and `interact()` when that happens.
- `page.goto()`, `page.reload()`, and `page.screenshot()` may time out through the relay. Prefer `navigate()`, `ensureFreshRender()`, and `screenshot()`.
- On an MCP tab switch, console, network, debugger, and intercept state is cleared; `state` persists.
- Never assume local code changes are live until the visible page confirms them.

## Safety Rules

1. Operate only on normal web pages, never `chrome://` or extension pages.
2. Never use `/connect-active-tab`, the user's active tab, or arbitrary existing Chrome tabs.
3. Cache, cookie, and storage clearing must remain scoped to the current origin.
4. Capture a screenshot between major actions.
5. Verify visible state instead of relying on static assumptions.
6. Disable all network mock rules when finished.

## Troubleshooting

Recover autonomously before asking the user for help:

| Symptom | MCP recovery | CLI recovery |
|---------|--------------|--------------|
| No tab connected | `tab connect` with `create: true`, then retry | `spawriter session reset <id>`, then `spawriter tabs connect <url> --create -s <id>` |
| Tool timeout or connection error | Retry, call `reset`, then retry; fall back to CLI if still broken | Reset the session and retry |
| Relay unavailable | Fall back to CLI and run relay recovery | `spawriter relay --replace`, then retry |
| Override not reflected | `ensureFreshRender()` or `clearCacheAndReload({ clear: "cache" })` | Same execute code through CLI |
| App not mounting | Navigate to the application's route first | Navigate to the application's route first |
| Debugger not pausing | Call `dbg.enable()` first | Call `dbg.enable()` first |
| Locator timeout | Use `page.evaluate()` or `interact()` | Use `page.evaluate()` or `interact()` |
| All attached tabs owned by others | Create a new tab through `tab connect` | Create a new tab and bind it to the CLI session |

Only after both MCP and CLI recovery paths fail should the user be asked to inspect Chrome, the extension, or the relay.
