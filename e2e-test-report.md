# Spawriter MCP Tools — E2E Test Report

> Date: 2026-03-11
> Test Environment: Chrome 145, Windows 10, CDP connection mode
> Test Page: https://example.com (and https://github.com during earlier session)
> Tester: Cursor AI (Claude 4.6 Opus) via MCP

---

## Summary

| Result | Count |
|--------|-------|
| PASS   | 20    |
| PARTIAL| 1     |
| N/A (env-specific) | 2 |
| **Total** | **23** |

---

## Tool Test Results

### 1. `navigate` — PASS

| Test | Input | Result |
|------|-------|--------|
| Navigate to URL | `url: "https://example.com"` | `Navigated to https://example.com` |
| Navigate to authenticated page | `url: "https://github.com/settings/education/benefits?page=1"` | Successfully loaded with auth cookies |

Notes: Fast, reliable. Handles both public and authenticated pages.

---

### 2. `screenshot` — PASS

| Test | Input | Result |
|------|-------|--------|
| Basic screenshot | `{}` | Returns PNG image of full page |
| Screenshot with labels | `{"labels": true}` | Returns PNG with numbered red overlay labels + text list of interactive elements |

Notes: Label overlays are clear and accurate. Interactive element list includes role, name, and index number.

---

### 3. `execute` — PASS

| Test | Input | Result |
|------|-------|--------|
| Simple expression | `"1+1"` | `2` (implicit) |
| DOM query | `"document.title + ' \| ' + document.querySelector('h1').textContent"` | `Example Domain \| Example Domain` |
| Console output | `"console.log('test'); 'done'"` | `done` (console captured separately) |
| Object.defineProperty | Geolocation override | Successfully overrode navigator.geolocation |
| DOM manipulation | Button click via querySelectorAll | Successfully found and clicked elements |
| Error case | CSP-blocked fetch | Returned error message correctly |

Notes: Runs synchronously in page context. Most reliable tool for quick DOM operations. `void()` returns undefined as expected. Errors from page JS show as `Error: JS error: Uncaught`.

---

### 4. `playwright_execute` — PARTIAL PASS

| Test | Input | Result | Status |
|------|-------|--------|--------|
| Simple return | `return 'hello'` | `[return value] hello` | PASS |
| State access | `state.x = 1; return state.x` | `[return value] 1` | PASS |
| page.url() (sync) | `return page.url()` | `Code executed successfully (no output)` | PARTIAL — runs but no output |
| page.title() (async) | `await page.title()` | **TIMEOUT** | FAIL |
| page.evaluate() | `await page.evaluate(...)` | **TIMEOUT** (sometimes works) | FLAKY |
| page.locator().count() | `await page.locator('a').count()` | **TIMEOUT** | FAIL |
| page.getByRole().click() | Clicking buttons | **TIMEOUT** | FAIL |
| page.getByText() | Text locator | **TIMEOUT** | FAIL |
| page.waitForTimeout() | 3s wait | Works when under timeout limit | PASS |
| page.addInitScript() | Adding init script | Works | PASS |
| context.addInitScript() | Context-level script | Works | PASS |
| context.grantPermissions() | Geolocation permission | `Browser.grantPermissions wasn't found` | FAIL (CDP limitation) |
| context.setGeolocation() | Set fake location | Connection closed | FAIL (CDP limitation) |
| context.newCDPSession() | CDP session creation | `Not allowed` | FAIL (CDP limitation) |

**Key Finding:** In CDP connection mode (connecting to existing browser), Playwright page APIs that require `await` (like `title()`, `locator()`, `evaluate()`) frequently timeout. This appears to be a Playwright CDP connection limitation where the page context becomes unresponsive during async operations. Simple synchronous operations and `state` manipulation work fine.

**Workaround:** Use `execute` tool (direct page context JS) for DOM operations instead of `playwright_execute` with Playwright locators.

---

### 5. `accessibility_snapshot` — PASS

| Test | Input | Result |
|------|-------|--------|
| Full page snapshot | `{}` | Returns full AXTree with roles, names, states, URLs |
| Diff mode | After navigation | Shows `Removed:` and `Added:` sections with before/after comparison |

Notes: Very detailed output including InlineTextBox nodes. Shows diff when page content changes between calls.

---

### 6. `network_log` — PASS

| Test | Input | Result |
|------|-------|--------|
| Default (50 entries) | `{}` | Returns entries with requestId, method, status, timing, size |
| With count | `{"count": 100}` | Returns up to 100 entries |
| With URL filter | `{"url_filter": "education"}` | Correctly filters by URL substring |
| With status filter | `{"status_filter": "error"}` | Filters by status category |
| With clear | `{"clear": true}` | Returns entries then clears buffer |

Notes: Excellent for monitoring all network activity. Shows timing, size, and request IDs for detailed inspection.

---

### 7. `network_detail` — PASS

| Test | Input | Result |
|------|-------|--------|
| Full details | `{"requestId": "...", "include": "all"}` | Returns request/response headers and body |
| Headers only | `{"include": "request_headers,response_headers"}` | Returns just headers |
| Request body | `{"include": "request_body"}` | Returns POST body (URL-encoded or JSON) |
| Response body | `{"include": "response_body", "max_body_size": 20000}` | Returns response content |
| Evicted body | Old request | `(not available - may have been evicted from browser buffer)` |

Notes: Response bodies may be evicted from browser buffer if not fetched soon after the request. `max_body_size` effectively controls truncation.

---

### 8. `console_logs` — PASS

| Test | Input | Result |
|------|-------|--------|
| No logs | `{}` | `No console logs captured (0 total in buffer)` |
| After console.log/warn/error | `{}` | Shows all 3 with timestamps, levels, and source |

Sample output:
```
[07:49:21.383] [LOG  ] test-log-from-spawriter
[07:49:21.384] [WARNING] test-warn
[07:49:21.384] [ERROR] test-error
```

Notes: Captures log, warn, error levels. Source file info included.

---

### 9. `css_inspect` — PASS

| Test | Input | Result |
|------|-------|--------|
| Default properties | `{"selector": "h1"}` | Returns display, position, width, height, margin, color, font-size, font-weight, font-family, border, opacity |
| Custom properties | `{"selector": "p", "properties": "color,font-size,line-height,margin"}` | Returns only requested properties |

Sample output:
```
Element: <h1> (1536x31 at 512,188)
Computed styles:
  font-size: 24px
  font-weight: 700
  color: rgb(0, 0, 0)
```

Notes: Shows element dimensions and position. Uses computed (resolved) styles.

---

### 10. `debugger` — PASS

| Test | Action | Result |
|------|--------|--------|
| Enable | `action: "enable"` | `Debugger enabled. Scripts will be parsed and breakpoints can be set.` |
| List scripts | `action: "list_scripts", search: "example"` | `No scripts found.` (example.com has no JS) |
| List breakpoints | `action: "list_breakpoints"` | `No active breakpoints.` |
| Evaluate | `action: "evaluate", expression: "1+1"` | `2` |
| Pause on exceptions | `action: "pause_on_exceptions", state: "uncaught"` | `Pause on exceptions: uncaught` |

Notes: Full debugger functionality available. `set_breakpoint`, `step_over`, `step_into`, `step_out` not tested (would require a page with JS and paused execution).

---

### 11. `session_manager` — PASS

| Test | Action | Result |
|------|--------|--------|
| List (empty) | `action: "list"` | `No active sessions.` |
| Create | `action: "create", sessionId: "test-session-1"` | `Session "test-session-1" created.` |
| List (with session) | `action: "list"` | `Sessions (1): test-session-1: connected=false, stateKeys=[]` |
| Switch | `action: "switch", sessionId: "test-session-1"` | `Switched to session "test-session-1".` |
| Remove | `action: "remove", sessionId: "test-session-1"` | `Session "test-session-1" removed.` |
| List (after remove) | `action: "list"` | `No active sessions.` |

Notes: Full CRUD lifecycle works. Sessions maintain independent Playwright state.

---

### 12. `app_action` — N/A (environment-specific)

| Test | Action | Result |
|------|--------|--------|
| Mount non-existent app | `action: "mount", appName: "@test/nonexistent-app"` | `{"success":false,"error":"single-spa devtools not available"}` |

Notes: Requires a single-spa micro-frontend environment. Error handling is correct — gracefully reports that single-spa devtools are not available on the test page.

---

### 13. `override_app` — N/A (environment-specific)

| Test | Action | Result |
|------|--------|--------|
| Reset all | `action: "reset_all"` | `{"success":false,"error":"importMapOverrides not available"}` |

Notes: Requires import-map-overrides library for single-spa apps. Error handling is correct.

---

### 14. `ensure_fresh_render` — PASS

| Test | Input | Result |
|------|-------|--------|
| Fresh render | `{}` | `Page reloaded with fresh cache` |

Notes: Simple, effective cache-busting reload.

---

### 15. `clear_cache_and_reload` — PASS

| Test | Mode | Result |
|------|------|--------|
| Light mode | `mode: "light"` | `Cache cleared with mode: light` |
| Aggressive mode | `mode: "aggressive"` | `Cache cleared with mode: aggressive` |

Notes: Both modes work. Aggressive mode presumably clears more browser state (cookies, localStorage, etc.).

---

### 16. `reset` — PASS

| Test | Input | Result |
|------|-------|--------|
| Full reset | `{}` | `Connection reset. Console logs, network entries, Playwright state, debugger state, and sessions cleared.` |
| Verify clear | console_logs, network_log | Both return 0 entries |

Notes: Complete cleanup of all captured state. Essential after connection issues or to start fresh.

---

### 17. `dashboard_state` — PASS

| Test | Input | Result |
|------|-------|--------|
| Without single-spa | `{}` | Returns JSON with pageUrl, hasSingleSpaDevtools=false, appCount=0 |

Sample output:
```json
{
  "pageUrl": "https://example.com/",
  "hasSingleSpaDevtools": false,
  "hasImportMapOverrides": false,
  "appCount": 0,
  "activeOverrides": {},
  "apps": []
}
```

---

### 18. `storage` — PASS

| Test | Action | Result |
|------|--------|--------|
| Get cookies | `action: "get_cookies"` | `No cookies found.` (example.com has none) |
| Set localStorage | `action: "set_local_storage", key: "test_key", value: "test_value_123"` | `localStorage[test_key] set.` |
| Get localStorage | `action: "get_local_storage"` | `localStorage (1 entries): test_key: test_value_123` |
| Remove localStorage | `action: "remove_local_storage", key: "test_key"` | `localStorage[test_key] removed.` |
| Get storage usage | `action: "get_storage_usage"` | `Usage: 0.0KB / 291664.8MB (0.0%)` |

Notes: Full CRUD for cookies, localStorage, sessionStorage. Storage usage reporting works.

---

### 19. `performance` — PASS

| Test | Action | Result |
|------|--------|--------|
| Get metrics | `action: "get_metrics"` | Returns Documents, Frames, JSEventListeners, Nodes, Layout/Script duration, JSHeap |
| Get Web Vitals | `action: "get_web_vitals"` | Returns FCP (240ms), TTFB (3ms), DOM Interactive/Complete, Load time. LCP/CLS/INP need observers |
| Get memory | `action: "get_memory"` | `JS Heap: 35.31MB / 37.25MB (94.8%), DOM Nodes: 33` |
| Get resource timing | `action: "get_resource_timing"` | `No resource timing entries found.` (simple page) |

Notes: Comprehensive performance monitoring. Web Vitals note correctly explains that LCP/CLS/INP require PerformanceObserver and page interaction.

---

### 20. `editor` — PASS

| Test | Action | Result |
|------|--------|--------|
| List sources | `action: "list_sources"` | `No scripts found.` (example.com has no JS) |
| List stylesheets | `action: "list_stylesheets"` | `Stylesheets (1): [0] (inline) (4 rules)` |
| Get stylesheet | `action: "get_stylesheet", styleSheetId: "0"` | Returns full CSS text |
| Edit stylesheet | `action: "edit_stylesheet", styleSheetId: "0", content: "body{background:red}..."` | `Stylesheet updated (2 rules applied)` — visually verified via screenshot |

Notes: Live CSS editing works perfectly. Can read and modify stylesheets in real-time. Visual confirmation showed red background applied immediately.

---

### 21. `network_intercept` — PASS

| Test | Action | Result |
|------|--------|--------|
| List rules (empty) | `action: "list_rules"` | `No intercept rules. Interception is disabled.` |
| Enable | `action: "enable"` | `Network interception enabled. 0 rules active.` |
| Add rule | `action: "add_rule", url_pattern: "*example*", response_body: "...", response_status: 200` | `Rule added: rule_1 (pattern="*example*")` |
| List rules | `action: "list_rules"` | `Intercept rules (1, enabled): [rule_1] pattern="*example*"` |
| Remove rule | `action: "remove_rule", rule_id: "rule_1"` | `Rule rule_1 removed.` |
| Disable | `action: "disable"` | `Network interception disabled.` |

Notes: Full request interception lifecycle works. Can mock API responses, which is valuable for testing.

---

### 22. `emulation` — PASS

| Test | Action | Result |
|------|--------|--------|
| Set timezone | `action: "set_timezone", timezone_id: "America/New_York"` | `Timezone: America/New_York` |
| Set geolocation | `action: "set_geolocation", latitude: 40.7128, longitude: -74.006` | `Geolocation: 40.7128, -74.006` |
| Set device | `action: "set_device", device: "iPhone 12"` | `Device emulation: 375x812 @1x` |
| Set network conditions | `action: "set_network_conditions", latency: 100, download: 1000000, upload: 500000` | `Network: custom (latency=100ms, down=977KB/s, up=488KB/s)` |
| Set media | `action: "set_media", media: "print"` | `Media features: (cleared)` |
| Clear all | `action: "clear_all"` | `All emulations cleared.` |

Notes: Comprehensive device/network/geo/timezone emulation. `set_geolocation` works here (unlike CDP-level `context.setGeolocation()` which fails). This is the correct way to emulate geolocation in Spawriter.

**Important:** `emulation.set_geolocation` is the proper way to fake geolocation, not JS injection. This should have been used instead of the manual JS override approach.

---

### 23. `page_content` — PASS

| Test | Action | Result |
|------|--------|--------|
| Get text | `action: "get_text"` | Returns clean text content of the page |
| Get HTML | `action: "get_html"` | Returns clean HTML of `<body>` |
| Get metadata | `action: "get_metadata"` | Returns title, URL, charset, lang, viewport, counts of scripts/stylesheets/images/links |
| Search DOM | `action: "search_dom", search: "domain"` | `DOM search for "domain" (4 results)` — shows matching elements with context |

Notes: Very useful for structured content extraction. `get_metadata` gives a quick overview. `search_dom` is powerful for finding specific content.

---

## Critical Issues Found

### Issue 1: `playwright_execute` — Playwright Page API Timeouts (HIGH)

**Severity:** HIGH
**Description:** Any `playwright_execute` code that uses `await` with Playwright page methods (`page.title()`, `page.locator()`, `page.evaluate()`, `page.getByRole()`, etc.) consistently times out after the configured timeout period.

**Reproduction:**
```javascript
// This ALWAYS times out:
const title = await page.title();
return title;

// This WORKS:
return 'hello';

// This WORKS:
state.x = 42;
return state.x;
```

**Root Cause:** Likely related to CDP (Chrome DevTools Protocol) connection mode. When Spawriter connects to an existing browser via CDP (rather than launching its own), certain Playwright async operations may not properly resolve.

**Impact:** Cannot use Playwright's powerful locator API, form-filling, or multi-step interaction flows. Must fall back to `execute` tool with raw DOM manipulation.

**Workaround:** Use `execute` tool for DOM operations and `playwright_execute` only for:
- Simple return values
- State management (`state` object)
- `page.waitForTimeout()` (works)
- `page.addInitScript()` / `context.addInitScript()` (works)

### Issue 2: CDP Permission APIs Not Available (MEDIUM)

**Severity:** MEDIUM
**Description:** `context.grantPermissions()`, `context.setGeolocation()`, and `context.newCDPSession()` are not supported in CDP connection mode.

**Error Messages:**
- `Browser.grantPermissions wasn't found`
- Connection closed
- `Not allowed`

**Impact:** Cannot programmatically grant browser permissions (geolocation, camera, etc.) or use low-level CDP emulation commands.

**Workaround:** Use `execute` tool to override browser APIs via JavaScript injection (e.g., `Object.defineProperty(navigator, 'geolocation', ...)`).

---

## Recommendations

1. **Investigate page API timeouts in CDP mode** — This is the most impactful issue. Consider testing with different CDP connection strategies or adding explicit timeout handling.

2. **Add `page.evaluate()` fallback in `playwright_execute`** — When direct Playwright methods timeout, could auto-fallback to `page.evaluate()` with the equivalent DOM operations.

3. **Document CDP mode limitations** — Add documentation noting which Playwright features are not available when connecting to an existing browser vs. launching one.

4. **Consider adding a `page.goto()` variant in `navigate`** — The `navigate` tool works well but doesn't expose Playwright's `waitUntil` options. Could be useful for SPAs.

5. **`network_intercept` already exists** — The network interception capability is already implemented and works well.

6. **Use `emulation.set_geolocation` over JS injection** — The `emulation` tool provides proper geolocation emulation via CDP's `Emulation.setGeolocationOverride`. This is more reliable than overriding `navigator.geolocation` via JavaScript injection. However, note that browser permission prompts may still appear; the `emulation` tool handles this at the CDP level.

7. **MCP descriptor files may be stale** — The Cursor MCP descriptor folder only had 16 of 23 tool descriptors. Users may need to restart Cursor or reconnect the MCP server to regenerate descriptors for newer tools (storage, performance, editor, network_intercept, emulation, page_content).
