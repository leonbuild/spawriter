# spawriter

**The missing link between AI coding agents and single-spa micro-frontends.**

spawriter gives AI agents (Cursor, Claude Code, Codex, Github Copilot, Opencode, etc.) direct access to your **real Chrome tab** via MCP — enabling autonomous **code -> override -> screenshot -> iterate** workflows for micro-frontend development.

---

## Quick Start

```bash
git clone <repo-url> spawriter
cd spawriter
npm run setup       # install all dependencies + build extension + build MCP server
```

Then:

1. **Load Chrome Extension**: `chrome://extensions/` -> Developer mode -> Load unpacked -> select `ext/dist-chrome/`
2. **Configure your AI client** — see below

---

## What It Does

In single-spa, AI agents can edit code but **can't** toggle import-map-overrides, see the live page, or check app status. spawriter fixes this by exposing 30 MCP tools:

| Category | Tools |
|---|---|
| **Inspection** | `screenshot`, `accessibility_snapshot`, `execute`, `playwright_execute`, `interact`, `dashboard_state` |
| **Network** | `console_logs`, `network_log`, `network_detail`, `network_intercept`, `browser_fetch` |
| **Debugging** | `debugger`, `css_inspect`, `editor`, `trace` |
| **State & Storage** | `storage`, `performance`, `emulation`, `page_content` |
| **App Control** | `override_app`, `app_action`, `navigate`, `ensure_fresh_render`, `clear_cache_and_reload` |
| **Tab Management** | `list_tabs`, `switch_tab`, `connect_tab`, `release_tab`, `session_manager`, `reset` |

---

## Configure Your AI Client

> Replace `/path/to/spawriter` with your actual clone path. Windows: use `"D:\\dev\\side\\spawriter"`.

Each platform needs two steps: **① MCP config** (tell the client how to start spawriter) + **② AI Instructions** (guide AI on when/how to use spawriter tools).

### Cursor

**① MCP** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
    }
  }
}
```

**② AI Instructions**: copy the [AI Instructions Content](#ai-instructions-content) into `.cursor/rules/spawriter.mdc`

### Claude Code

**① MCP** (CLI recommended):

```bash
claude mcp add --scope user --transport stdio spawriter -- \
  node /path/to/spawriter/mcp/dist/cli.js serve
```

Or manually in `.mcp.json`:

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
    }
  }
}
```

> `.mcp.json` uses `"mcpServers"` (same as Cursor).

**② AI Instructions**: copy the [AI Instructions Content](#ai-instructions-content) into `CLAUDE.md` or `~/.claude/CLAUDE.md`

### VS Code (GitHub Copilot)

**① MCP** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "spawriter": {
      "command": "node",
      "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
    }
  }
}
```

> VS Code uses `"servers"` (not `"mcpServers"`), no `timeout` / `autoApprove` fields.

**② AI Instructions**: copy the [AI Instructions Content](#ai-instructions-content) into `.github/copilot-instructions.md` or `AGENTS.md`

**Recommended**: `"chat.agent.maxRequests": 100` in `settings.json` (reduces interruptions, no extra cost).

### Codex

**① MCP** (`~/.codex/config.toml`):

```toml
[mcp_servers.spawriter]
command = "node"
args = ["/path/to/spawriter/mcp/dist/cli.js", "serve"]
```

**② AI Instructions**: copy the [AI Instructions Content](#ai-instructions-content) into `AGENTS.md` or `~/.codex/AGENTS.md`

### OpenCode

**① MCP** (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spawriter": {
      "type": "local",
      "command": ["node", "/path/to/spawriter/mcp/dist/cli.js", "serve"],
      "enabled": true
    }
  }
}
```

**② AI Instructions**: copy the [AI Instructions Content](#ai-instructions-content) into `.opencode/instructions.md`

### Multi-Agent Setup

For multi-agent isolation, add separate server entries with unique labels (Cursor/Claude Code JSON format shown; adapt for Codex TOML or VS Code):

```json
{
  "mcpServers": {
    "spawriter-agent1": {
      "command": "node",
      "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"],
      "env": { "SSPA_AGENT_LABEL": "agent-1", "SSPA_PROJECT_URL": "localhost:8080" }
    },
    "spawriter-agent2": {
      "command": "node",
      "args": ["/path/to/spawriter/mcp/dist/cli.js", "serve"],
      "env": { "SSPA_AGENT_LABEL": "agent-2", "SSPA_PROJECT_URL": "localhost:9090" }
    }
  }
}
```

Each agent gets its own client ID and exclusive tab leases. Single-agent setups need no extra configuration.

---

## AI Instructions Content

The same instructions content works across all platforms. Place it in the appropriate file for your client:

| Platform | File |
|----------|------|
| **Cursor** | `.cursor/rules/spawriter.mdc` |
| **Claude Code** | `CLAUDE.md` or `~/.claude/CLAUDE.md` |
| **VS Code (Copilot)** | `.github/copilot-instructions.md` or `AGENTS.md` |
| **Codex CLI** | `AGENTS.md` or `~/.codex/AGENTS.md` |
| **OpenCode** | `.opencode/instructions.md` |

<details>
<summary>Click to expand full AI instructions content</summary>

```markdown
# spawriter MCP Tools

Controls the user's **real Chrome tab** via CDP. Not headless — all actions affect the visible browser.

**Proactively use these tools whenever browser context would improve your work.** Don't wait to be asked — if seeing the page helps, just do it. Tool parameters are self-documented via MCP tool definitions; this file covers behavioral guidance and non-obvious details.

## Tool Catalog (30 tools)

**Inspect:** `screenshot` (labels?, quality?), `accessibility_snapshot` (search?, diff?, interactive_only?), `dashboard_state`, `console_logs`, `network_log`, `network_detail`, `page_content` (get_html/get_text/get_metadata/search_dom), `css_inspect`, `trace`
**Interact:** `execute` (JS in page), `playwright_execute` (Playwright VM), `interact` (@ref actions), `navigate`, `ensure_fresh_render`, `clear_cache_and_reload` (clear: cache,cookies,local_storage,session_storage,cache_storage,indexeddb,service_workers,all)
**Debug:** `debugger` (breakpoints/stepping/eval), `editor` (view/edit live JS/CSS sources with hot-reload)
**Network:** `network_intercept` (mock/block requests), `browser_fetch` (HTTP with user's cookies/session)
**State:** `storage` (cookies/localStorage/sessionStorage/cache), `emulation` (device/network/geo/timezone/media), `performance` (metrics/vitals/memory/resources)
**Single-spa:** `override_app` (import-map overrides), `app_action` (mount/unmount/unload)
**Tabs:** `list_tabs`, `switch_tab`, `connect_tab`, `release_tab`
**Session:** `session_manager` (Playwright VM sessions), `reset` (full reconnect)

## Connection Protocol

1. On first use, determine a `session_id` (use agent transcript UUID if available, otherwise generate one). Pass it on `connect_tab`, `list_tabs`, `switch_tab`, `release_tab`.
2. Proactively call `connect_tab { url: "target-url", create: true, session_id: "..." }` when you anticipate needing browser access.
3. On connection error: retry `connect_tab` → `reset` + retry → ask user to check Chrome/extension/relay.

## When to Proactively Use the Browser

| Situation | Action |
|-----------|--------|
| User shares a URL | `navigate` → `screenshot` + `accessibility_snapshot` |
| UI problem reported | `screenshot` + `console_logs { level: "error" }` + `network_log { status_filter: "error" }` |
| After code changes to UI | `ensure_fresh_render` → `screenshot` → verify visually |
| "How does X look?" | `screenshot { labels: true }` + `accessibility_snapshot` |
| Implementing UI feature | Screenshot before AND after each significant change |
| Debugging API issue | `network_log` → `network_detail { requestId }` for full request/response |
| Design reference needed | `navigate` to reference → `screenshot` → navigate back → implement |
| Exploring unfamiliar page | `dashboard_state` + `screenshot { labels: true }` + `accessibility_snapshot` |
| Override set/changed | `dashboard_state` + `ensure_fresh_render` + `screenshot` to confirm |
| "It doesn't work" | `screenshot` immediately — look, don't ask |

**Never say "please check it" without checking yourself first.**

### Verification-After-Changes Protocol

After any UI code change, automatically:
1. `ensure_fresh_render` (or `clear_cache_and_reload` if cache may be stale)
2. `screenshot` — capture result
3. Compare with expectations
4. If wrong: `console_logs { level: "error" }` + `network_log { status_filter: "error" }`
5. Report what you see to the user

### When NOT to Use Browser

- Pure backend/algorithmic changes
- User explicitly opts out
- Config edits with no rendering impact

## Key Tool Usage Notes

### execute vs playwright_execute
- `execute`: fast JS eval in page context (DOM reads, API calls). No real input events.
- `playwright_execute`: full Playwright API in Node VM sandbox. Real browser input events (`:hover`/`:focus` work). Use for clicks, form fills, keyboard, drag, waiting. Globals: `page`, `context`, `state` (persistent across calls).
- `state` object persists across `playwright_execute` calls AND tab switches — use it to store data between navigations.
- File downloads work: relay bridges `Browser.setDownloadBehavior` to per-page scope. Use `page.waitForEvent('download')`.
- Cookie reads: use `Network.getCookies` via CDP, NOT `Storage.getCookies` (fails in extension relay mode).

### interact
After `accessibility_snapshot`, use `interact { ref, action, value? }` for quick single-step actions (click, hover, fill, focus, check, uncheck, select) by @ref number.

### Single-spa Specific Tools

**`dashboard_state`** — Get app list, statuses, active import-map-overrides. Always check this first on single-spa pages.

**`override_app`** — Manage import-map-overrides:
- `set` (appName, url) — point app to localhost
- `remove` / `enable` / `disable` (appName) — toggle overrides
- `reset_all` — clear all overrides
- Extension panel auto-syncs within ~3s

**`app_action`** — Force `mount`/`unmount`/`unload` a single-spa app.

### Network Mocking

Use `network_intercept` to mock APIs without a backend:
1. `enable` → `add_rule { url_pattern, mock_status, mock_body }` → test → `disable`
2. Use `block: true` to simulate offline/loading states
3. **Always `disable` when done** — rules persist until explicitly removed

### Multi-Tab

- `list_tabs` / `switch_tab` / `connect_tab` / `release_tab` for multi-tab work
- On `switch_tab`: console/network/debugger/intercept state is cleared; Playwright `state` persists
- After switching, call `reset` if `playwright_execute` needs to reconnect to the new tab

## Safety Rules

1. Only operate on normal web pages — never `chrome://` or extension pages
2. Verify state via `dashboard_state` / `execute`, not static assumptions
3. Screenshot between major actions
4. Don't assume code changes are live — confirm via `dashboard_state`
5. All cache/cookie clearing is tab/origin-scoped — never affects other sites
6. Mock rules persist until disabled — always clean up

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool timeout | `reset` to re-establish connections |
| Override not reflected | `ensure_fresh_render` or `clear_cache_and_reload { clear: "cache,service_workers" }` |
| App not mounting after override | Navigate to the app's route first, then check status |
| Debugger not pausing | Call `debugger { action: "enable" }` first |
| `playwright_execute` connection error | `reset` then retry |
| Cookie read in `playwright_execute` | Use `Network.getCookies` via CDP session, NOT `Storage.getCookies` |
| All tabs leased | `connect_tab { url, create: true }` to create a new tab |
```

</details>

---

## Architecture

```
AI Agent -> MCP Server (stdio) -> CDP Relay (:19989) -> Chrome Extension -> Browser Tab
```

Monorepo with two packages managed via **npm workspaces**:

- **`ext/`** (`spawriter-ext`) — Chrome extension (Manifest V3): DevTools panel, AI Bridge, CDP relay connection
- **`mcp/`** (`spawriter-mcp`) — MCP server + CDP relay: 30 tools for browser automation

Key features:
- **Zero-touch tab management** — agents create/attach/navigate tabs programmatically
- **Multi-agent isolation** — Tab Lease System ensures exclusive tab ownership
- **Persistent connection** — offscreen document survives MV3 service worker restarts

---

## Scripts

| Command | What It Does |
|---|---|
| `npm run setup` | One-liner: install all deps + build ext + build mcp |
| `npm run build` | Build everything (keeps artifacts) |
| `npm run build:ext` | Build Chrome extension only |
| `npm run build:mcp` | Build MCP server only |
| `npm run release` | Build + package into `release/` + clean intermediates |
| `npm run mcp:serve` | Build + start MCP server |
| `npm run mcp:relay` | Build + start CDP relay |
| `npm test` | Run all tests (1320 tests) |
| `npm run start:hot` | Hot-reload dev mode (requires pnpm) |
| `npm run version:bump` | Bump version across all packages |

---

## Project Structure

```
spawriter/
├── package.json             # Root: workspaces + orchestration scripts
├── ext/                     # Chrome Extension (Manifest V3)
│   ├── src/                 # Source (JS/React)
│   ├── scripts/             # Build helpers (convert-icons, build-chrome)
│   ├── build/               # Webpack output (gitignored)
│   ├── dist-chrome/         # Chrome-ready build (gitignored)
│   ├── manifest.json        # Firefox manifest
│   └── manifest.chrome.json # Chrome manifest source
├── mcp/                     # MCP Server + CDP Relay (TypeScript)
│   ├── src/                 # Source (TS)
│   └── dist/                # Compiled output (gitignored)
├── scripts/                 # Root build orchestration
│   ├── package-release.js   # Bundle release artifacts
│   ├── clean-stale-artifacts.js
│   └── bump-version.js      # Version sync across packages
└── docs/                    # Architecture & guides
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Chrome: "manifest file missing" | Load `ext/dist-chrome/`, not `ext/`. Run `npm run setup` first if it doesn't exist. |
| `Cannot find module 'mcp/dist/cli.js'` | Run `npm run setup` or `npm run build:mcp` |
| MCP connected but no page | Navigate to a normal web page (not `chrome://` or `edge://`) |
| webpack OpenSSL error | Build scripts include `--openssl-legacy-provider`. Use Node.js 18+ LTS. |
| `sharp` install failure | Native binary dependency. Try `npm install` again, or manually convert SVG to PNG. |

