# spawriter

**The missing link between AI coding agents and single-spa micro-frontends.**

spawriter is an enhanced single-spa DevTools extension that adds MCP (Model Context Protocol) capabilities, enabling AI agents to connect to your **real, running Chrome tab** — not a sandboxed browser — to visually verify, debug, and manage micro-frontend applications.

> Current version: `v1.0.0` · License: MIT

---

## Why spawriter matters in the single-spa ecosystem

### The problem: micro-frontend dev ≠ normal web dev

In a typical web application, a developer runs `npm start`, opens `localhost:3000`, and sees the app. AI coding tools like Codex, Cursor, and Cline work well in this world — they edit code, and the dev server hot-reloads it.

**Single-spa micro-frontends don't work that way.** Each micro-app is a module loaded by a shared root-config host via an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap). To develop locally, you must:

1. Run the micro-app dev server on a local port (e.g. `localhost:8080`)
2. **Override the import map** in the host to point to your local module instead of the deployed one
3. Visually verify that the override took effect and the app renders correctly **inside the host**

This "override → verify" loop is the core workflow, and it relies on a browser extension — traditionally [import-map-overrides](https://github.com/single-spa/import-map-overrides) — to manage step 2. Without step 3 (visual verification in the actual host), you're flying blind.

### The gap: AI agents can't do this today

Current AI coding tools can edit source files, but they **cannot**:

- **Toggle import-map-overrides** to swap a production module for a local one
- **See the live page** to verify whether the override worked and the UI renders correctly
- **Inspect single-spa app status** (mounted, not mounted, loading error, etc.)

This means every AI-assisted code change in a micro-frontend project still requires a human to manually switch overrides, eyeball the browser, and report back. The feedback loop is broken.

### The solution: spawriter

spawriter closes this gap by providing:

| Capability | How |
|---|---|
| **Override management** | Read, create, toggle, and delete import-map-overrides programmatically |
| **Visual verification** | Take screenshots and read accessibility snapshots of the live page |
| **App state inspection** | Query which single-spa apps are mounted, their status, and whether overrides point to localhost |
| **Cache & reload** | Clear browser cache and reload the host to get a clean state |
| **JS execution** | Run arbitrary JavaScript in the page context for deeper inspection |

All of this is exposed as **MCP tools** that any compatible AI agent (Codex, Cursor, Cline, OpenCode, etc.) can call directly. The AI can now do: **code → override → screenshot → iterate** — entirely autonomously.

spawriter is the **first and only open-source tool** in the single-spa ecosystem that gives AI agents both import-map-override control and visual feedback, directly in the developer's real browser session.

---

## Part 1: Dashboard (Human Developer Path)

This part requires no MCP and no separate server process.

### Features

- View single-spa application status in the DevTools panel
- Force mount / unmount applications
- Overlay highlighting (On / Off / List Hover)
- Import Map Overrides management (edit, save, enable/disable, import/export)
- Clear Cache & Refresh (panel button)
- spawriter AI Bridge (toolbar button, per-tab attach/detach; badge shows attached count & status: green = this tab connected, gray + number = other tab connected, no badge = no connection)

### Installation

#### Option A: Pre-built release (recommended)

- Chrome: `spawriter-chrome-{version}.zip`
- Firefox: `spawriter-firefox-{version}.zip`

#### Option B: Build from source

```bash
npm install
npm run build
```

This generates a unified release directory (recommended for distribution):

- `release/spawriter-v<version>/`

The directory contains:

- `extension/dist-chrome/` — Chrome unpacked extension
- `extension/spawriter-chrome-<version>.zip` — Chrome zip
- `mcp/dist/` — MCP server build artifacts
- `skills/spawriter/` — Agent skill definitions
- `cursor-rules/` — Cursor IDE rule templates
- `doc/` — Installation and development guides

After `npm run build`, intermediate directories (`build`, `dist-chrome`, `web-ext-artifacts`) are automatically cleaned up to avoid confusion.

> **Build notes**
>
> - `release/` is a pure build artifact (in `.gitignore`) — safe to delete and fully rebuild with `npm run build`.
> - To bump the version, use `npm run version:bump <patch|minor|major|x.y.z>`. This updates `package.json`, `manifest.json`, `manifest.chrome.json`, and `mcp/package.json` in sync.
> - Build pipeline: `webpack → build-chrome → web-ext zip → mcp:build → package-release → clean:artifacts`.
> - Old release directories are automatically cleaned by `clean:artifacts`; only the current version is kept.

### Chrome side-loading (unpacked)

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `release/spawriter-v<version>/extension/dist-chrome/`

### Dashboard regression checklist

- Panel opens correctly
- mount / unmount works
- Overlay works
- import-map-overrides save / toggle / reload works
- Toolbar button per-tab attach/detach works (badge: green + number = this tab connected, yellow + "..." = connecting, gray + number = other tab connected, no badge = no connection, red + "!" = error)

---

## Part 2: MCP (AI Automation Path)

This part enables AI agents to interact with your browser. You can use the Dashboard alone, or Dashboard + MCP together.

### Architecture

- **Chrome extension** — includes the spawriter AI Bridge (default port `19989`)
- **Relay** — CDP forwarding on port `19989` (independent of playwriter's `19988`; both extensions can coexist)
- **MCP Server** — stdio-based tool server

### Quick start (from the dev repo)

```bash
# 1) Build the MCP server
npm run mcp:build

# 2) Start the MCP server (also starts the relay)
npm run mcp:serve
```

You can also run directly:

```bash
node dist/cli.js serve
```

> A compatibility entry point at `dist/cli.js` in the repo root is included to fix the "module not found when running from the project root" issue.

### Start from the release directory (for end users)

Assuming you are distributing `release/spawriter-v<version>/`:

```bash
cd release/spawriter-v<version>/mcp
npm install
node dist/cli.js serve
```

After the initial `npm install`, you can also run from the release root:

```bash
node dist/cli.js serve
```

### Start from the `mcp/` directory (optional)

```bash
cd mcp
npm run build
node dist/cli.js serve
```

### MCP client configuration

Configure your AI client to point to `mcp/dist/cli.js serve`. Example:

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["D:/dev/side/spawriter/mcp/dist/cli.js", "serve"]
    }
  }
}
```

### Multi-tab support

The extension can attach to multiple Chrome tabs simultaneously (click the toolbar button on each tab). The MCP server provides two tools for tab management:

- `list_tabs` — list all attached tabs with session IDs, titles, URLs, and which tab is active
- `switch_tab` — switch the CDP session to a different attached tab (clears console/network/intercept/debugger state; Playwright sessions are preserved)

After switching, all tools (`screenshot`, `execute`, `dashboard_state`, etc.) operate on the new tab.

### MCP tools

| Tool | Description |
|---|---|
| `screenshot` | Capture a screenshot of the current page |
| `accessibility_snapshot` | Read the accessibility tree of the current page |
| `execute` | Run arbitrary JavaScript in the page context |
| `playwright_execute` | Run code in Node.js VM sandbox with full Playwright API |
| `dashboard_state` | Read dashboard status, app states, whether overrides hit localhost |
| `console_logs` | Get captured browser console logs with filtering |
| `network_log` | Get captured network requests with filtering |
| `network_detail` | Get full details of a specific request (headers, body) |
| `network_intercept` | Intercept, mock, or block network requests (Fetch domain) |
| `debugger` | Control JavaScript debugger: breakpoints, stepping, variable inspection |
| `css_inspect` | Get computed CSS styles for an element by selector |
| `editor` | View and edit page JS/CSS sources in real-time |
| `storage` | Manage cookies, localStorage, sessionStorage, cache |
| `performance` | Runtime metrics, Web Vitals, memory, resource timing |
| `emulation` | Device, network, geolocation, timezone, media feature emulation |
| `page_content` | Get clean HTML, text, metadata, or search the DOM |
| `override_app` | Manage import-map-overrides |
| `app_action` | Control single-spa app lifecycle (mount / unmount / unload) |
| `navigate` | Navigate to a URL |
| `ensure_fresh_render` | Wait for the page to stabilize after navigation |
| `clear_cache_and_reload` | Clear browser cache/storage with granular control and reload |
| `list_tabs` | List all attached Chrome tabs (session ID, title, URL, active) |
| `switch_tab` | Switch CDP session to a different attached Chrome tab |
| `session_manager` | Manage multiple Playwright executor sessions |
| `reset` | Reset the MCP connection |

### Offline UI testing with mock responses

You don't need a running backend to test UI. The `network_intercept` tool uses the CDP Fetch domain to intercept any request and return custom responses:

```
network_intercept { action: "enable" }
network_intercept { action: "add_rule", url_pattern: "/api/users", mock_status: 200, mock_body: "[{\"id\":1}]" }
network_intercept { action: "add_rule", url_pattern: "/api/error", mock_status: 500, mock_body: "{\"error\":\"fail\"}" }
network_intercept { action: "add_rule", url_pattern: "/ads/", block: true }
```

Use cases: testing error handling UI, empty states, loading states (block request), developing before backend is ready, reproducing specific bugs.

### Cursor Rules (auto-context for AI agents in Cursor IDE)

In Cursor IDE, `.cursor/rules/*.mdc` files inject MCP usage knowledge into the AI automatically.

A pre-built rule template is included: `cursor-rules/spawriter.mdc`

#### Installation

Copy the rule file into your workspace:

```bash
mkdir -p /path/to/workspace/.cursor/rules
cp cursor-rules/spawriter.mdc /path/to/workspace/.cursor/rules/
```

#### Scope configuration

The `globs` field in the rule file controls which files trigger the rule:

| Scenario | globs value |
|---|---|
| All files | `**` |
| Only journal and service | `journal/**,service/**` |
| A specific sub-project | `my-project/**` |

Edit the `globs:` line at the top of the `.mdc` file.

#### Rules vs Skills

| | Cursor Rule (`.cursor/rules/*.mdc`) | Skill (`skills/SKILL.md`) |
|---|---|---|
| Trigger | Auto-injected when editing matching files | Explicitly loaded by the agent system |
| Best for | Day-to-day development in Cursor IDE | Distribution to other AI agent systems |
| Location | Workspace `.cursor/rules/` | Project `skills/` |

Both can coexist. Use Rules for Cursor; use Skills for other agent systems.

### Skills (usage constraints for other agent systems)

Following the "CLI + MCP + Skill" pattern pioneered by [`remorses/playwriter`](https://github.com/remorses/playwriter), spawriter ships a set of structured usage rules (e.g., always screenshot before executing, reset on error, only operate on normal web tabs) to minimize invalid calls.

- Reference project: [`remorses/playwriter`](https://github.com/remorses/playwriter)
- Recommended reading:
  - `doc/MCP_DEV_GUIDE.md`
  - `doc/CHROME_INSTALL_TEST_GUIDE.md`
- Ready-to-copy skill: `skills/spawriter/SKILL.md`
- Best practice: always call `dashboard_state` first to confirm override & dashboard status before making changes.

### Troubleshooting

- **`node dist/cli.js serve` — module not found**
  - Use `npm run mcp:serve` instead
  - Or run `npm run mcp:build` first, then `node dist/cli.js serve`

- **webpack OpenSSL error**
  - The build scripts already include `--openssl-legacy-provider`

- **MCP connected but no page**
  - Make sure the active tab is a normal web page (not `chrome://`, `edge://`, or `chrome-extension://`)
  - Call `reset` or restart `npm run mcp:serve`

---

## Documentation

- `doc/CHROME_INSTALL_TEST_GUIDE.md`
- `doc/MCP_DEV_GUIDE.md`
- `doc/PUBLISH_GUIDE.md`

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
