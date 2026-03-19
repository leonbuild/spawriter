---
name: spawriter
description: Control the user's real Chrome tab through spawriter (extension + relay + MCP server). Proactively use for viewing, verifying, and exploring web pages whenever browser context would help — don't wait for the user to ask.
---

## REQUIRED: Read Full Documentation First

Before using this skill, you MUST read these docs:

1. `README.md` (Part 2: MCP 使用)
2. `docs/CHROME_INSTALL_TEST_GUIDE.md`
3. `docs/MCP_DEV_GUIDE.md`

Do NOT skip this step. Most failures come from missing setup (extension not loaded, MCP not running, or tab restrictions).

## Minimal startup

```bash
npm run mcp:serve
```

Or:

```bash
node dist/cli.js serve
```

## Session identification for tab isolation

When multiple Cursor chat sessions share the same MCP server process, each session must identify itself to prevent cross-session tab access. On your **first spawriter tool call** in a conversation, determine your `session_id`:

1. If your system prompt contains an agent transcript path like `.../agent-transcripts/{UUID}/{UUID}.jsonl`, use that UUID
2. Otherwise, generate a short identifier from the conversation context (e.g., the task description, first 8 chars of a hash, or any stable session-specific value)

Then pass `session_id` on **every** `connect_tab`, `list_tabs`, `switch_tab`, and `release_tab` call.

## Connection awareness

Before using any spawriter tool, ensure the browser is connected. If a tool call fails:

1. First try `connect_tab { url: "about:blank", create: true, session_id: "your-id" }` to auto-create a browser tab
2. If that fails, call `reset` and retry
3. Only if that also fails, check that Chrome is open, extension is loaded, and MCP relay is running

**Proactively use `connect_tab`** when you anticipate needing browser access — agents can create and attach tabs without any user interaction.

## Proactive browser engagement (IMPORTANT)

**You MUST actively use spawriter in these situations — do NOT wait for the user to ask:**

- **User shares a URL or mentions a page** → `navigate` + `screenshot` + `accessibility_snapshot`
- **User describes a UI problem** → `screenshot` + `console_logs { level: "error" }` + `network_log { status_filter: "error" }`
- **You need a design/layout reference** → `navigate` to the reference, `screenshot`, study it, navigate back
- **You just made code changes** → `ensure_fresh_render` → `screenshot` → compare with before
- **User asks "how does X look?"** → `screenshot { labels: true }` + `accessibility_snapshot`
- **You're implementing a UI feature** → screenshot before starting, screenshot after each significant change
- **User mentions an error** → `console_logs` + `network_log` + `screenshot`
- **You're debugging an API issue** → `network_log` → `network_detail` for headers + body
- **User says "it doesn't work"** → `screenshot` immediately — see what they see
- **After setting or changing an override** → `dashboard_state` + `ensure_fresh_render` + `screenshot`

### Verification-after-changes protocol

After modifying UI code, **always** run this sequence automatically:

1. `ensure_fresh_render` (or `clear_cache_and_reload` if cache might be stale)
2. `screenshot` — capture the result
3. Compare with expectations; if wrong: `console_logs` + `network_log` to diagnose
4. Report the visual result to the user

**Never tell the user "please check it" without checking it yourself first.**

### When NOT to use the browser

- Pure backend/algorithmic code with no UI impact
- User explicitly says they don't want browser interaction
- Configuration edits that don't affect rendering

## Recommended workflow

1. Call `dashboard_state` first to read full dashboard/runtime state.
2. Check `isAnyAppUsingLocalhostOverride` and `targetAppState` to verify local override is really active for the app you are changing.
3. Call `screenshot` to confirm visible UI and app mount status match the state report.
4. Use `execute` for small checks (URL, selector existence, runtime values).
5. If state looks stale, call `ensure_fresh_render`.
6. Use `clear_cache_and_reload` only when explicit cache reset is required.
7. If CDP/session is unstable, call `reset` and continue.

## Tab scope & cross-page comparison

> In multi-agent setups, each agent can only operate on tabs it has leased. See "Multi-agent tab isolation" below.

spawriter can work with **multiple attached Chrome tabs** using `list_tabs` and `switch_tab`. The user attaches tabs via the toolbar button; the agent switches between them.

- `list_tabs { session_id: "..." }` — shows all attached tabs (session ID, tab ID, title, URL, active indicator, lease status)
- `switch_tab { targetId: "...", session_id: "..." }` — switches to a different tab, clears console/network/intercept/debugger state (Playwright sessions preserved)
- `session_manager` manages Playwright executor VM sessions (isolated JS sandboxes), not Chrome tabs

**Multi-tab comparison workflow:**
```
list_tabs { session_id: "my-session" } → see attached tabs
switch_tab { targetId: "session-ref", session_id: "my-session" } → switch to reference tab → screenshot
switch_tab { targetId: "session-work", session_id: "my-session" } → switch back → screenshot → compare
```

**Single-tab alternative:** use `navigate` to switch URLs within one tab, saving data in `playwright_execute` state.

**On switch_tab:** console logs, network entries, intercept rules, debugger state, and snapshot baseline are cleared. Playwright sessions (`session_manager` / `playwright_execute`) are preserved but maintain their own CDP connection — they may not automatically follow the tab switch.

## File downloads via Playwright

The relay maps `Browser.setDownloadBehavior` to per-page `Page.setDownloadBehavior` and synthesizes `Browser.download*` events, so Playwright downloads work in extension mode:

```
playwright_execute { code: "const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-btn')]); return await download.path();" }
```

## Offline UI testing with mock responses

You do NOT need real API servers to test UI. spawriter provides full network interception via `network_intercept`:

- **Mock success responses:** `network_intercept { action: "add_rule", url_pattern: "/api/data", mock_status: 200, mock_body: "[{\"id\":1}]" }`
- **Mock errors:** `network_intercept { action: "add_rule", url_pattern: "/api/data", mock_status: 500, mock_body: "{\"error\":\"fail\"}" }`
- **Block requests** (test loading/offline): `network_intercept { action: "add_rule", url_pattern: "/api/slow", block: true }`
- **Test empty states:** mock with `mock_body: "[]"`
- **Combine with interaction:** set up mock → `playwright_execute` to fill forms and submit → `screenshot` to verify

Always `network_intercept { action: "enable" }` before adding rules, and `network_intercept { action: "disable" }` when done.

Use mock testing when: backend is unavailable, testing error handling UI, testing edge cases, reproducing specific bugs, or testing loading/skeleton states.

## Multi-agent tab isolation

When multiple AI agents share the same relay server, spawriter's Tab Lease System ensures each agent gets its own tab(s):

- Each agent process gets a unique client ID; the relay enforces exclusive tab leases
- CDP events are routed only to the lease holder — no cross-agent pollution
- Leases auto-release on disconnect or tab close

### Per-session isolation with `session_id`

IDE hosts like Cursor may share a single MCP server process across multiple chat sessions. Without additional identification, all sessions appear as the same "agent" and can access each other's tabs.

To isolate tabs per chat session, pass `session_id` on tab management tools. Each unique `session_id` gets its own CDP connection with a distinct client identity, so the relay's lease system correctly scopes ownership.

**How to use:** Pass a stable, unique `session_id` string on `connect_tab`, `list_tabs`, `switch_tab`, and `release_tab`:

```
connect_tab { url: "localhost:8080", create: true, session_id: "finetune-debug" }
list_tabs { session_id: "finetune-debug" }
switch_tab { targetId: "spawriter-tab-...", session_id: "finetune-debug" }
release_tab { session_id: "finetune-debug" }
```

- Use a descriptive, stable ID per session (e.g., transcript UUID, task name, session purpose)
- Different `session_id` values create separate lease scopes — session A cannot access session B's tabs
- Omitting `session_id` uses the default (shared) scope for backward compatibility

### Session stickiness

After calling `connect_tab` or `switch_tab` with a `session_id`, all subsequent tool calls (`screenshot`, `navigate`, `execute`, etc.) automatically route to that session's CDP connection. You do NOT need to pass `session_id` on every tool call — only on tab management tools.

### Known limitations

- Console logs, network logs, and debugger state are shared across sessions (not per-session scoped)
- `reset` is global — releases ALL sessions' leases and connections
- These are low-risk in practice because Cursor's stdio MCP transport is sequential

**Environment variables** (set in MCP client config):
- `SSPA_AGENT_LABEL` — human-readable name shown in `list_tabs` (e.g., `"frontend-agent"`)
- `SSPA_PROJECT_URL` — URL substring for automatic tab matching (e.g., `"localhost:8080"`)

**Tab management tools:**
- `connect_tab { url: "...", session_id: "..." }` — attach a tab by URL match, or add `create: true` to create one
- `release_tab { session_id: "..." }` — release lease on current tab; add `targetId` for specific tab
- `list_tabs { session_id: "..." }` — shows `MINE`, `LEASED by <label>`, `AVAILABLE` markers
- `switch_tab { targetId: "...", session_id: "..." }` — lease-aware tab switching
- `reset` — releases all leases (all sessions) before resetting connections

**Session negotiation is automatic:** the agent reconnects to its own leased tab, finds unleased tabs matching `SSPA_PROJECT_URL`, auto-attaches by URL, or reports all-leased status with guidance.

**Backward compatible:** single-agent setups and calls without `session_id` work unchanged.

## Safety rules

- Prefer normal web pages; avoid `chrome://`, `edge://`, and extension pages.
- Do not infer single-spa state from static HTML alone; verify via runtime checks.
- Keep operations incremental and verify with screenshot between major actions.
- For project development tasks, do not assume your code change is active until `dashboard_state` confirms localhost override is effective.
- Mock rules persist until disabled — always clean up with `network_intercept { action: "disable" }` or `reset` after mock testing.
