# spawriter

**The missing link between AI coding agents and single-spa micro-frontends.**

spawriter gives AI agents (Cursor, Codex, Cline, etc.) direct access to your **real Chrome tab** via MCP — enabling autonomous **code -> override -> screenshot -> iterate** workflows for micro-frontend development.

> `v1.0.0` · MIT License

---

## Quick Start

```bash
git clone <repo-url> spawriter
cd spawriter
npm run setup       # install all dependencies + build extension + build MCP server
```

Then:

1. **Load Chrome Extension**: `chrome://extensions/` -> Developer mode -> Load unpacked -> select `ext/dist-chrome/`
2. **Configure your AI client** (e.g. Cursor):

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

That's it. Your AI agent can now see and control your browser.

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

## Multi-Agent Setup

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

## Cursor & Skill Integration

- **Cursor Rules**: copy `mcp/cursor-rules/spawriter.mdc` to `.cursor/rules/` in your workspace
- **Skills**: copy `mcp/skills/spawriter/SKILL.md` for other AI agent systems

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
│   ├── dist/                # Compiled output (gitignored)
│   ├── skills/              # AI skill definitions
│   └── cursor-rules/        # Cursor IDE rule templates
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

---

## Requirements

- **Node.js** 18+ LTS (npm 9+)
- **Chrome** browser
- Network access for npm packages

---

## Documentation

- [Chrome Install & Test Guide](docs/CHROME_INSTALL_TEST_GUIDE.md)
- [MCP Development Guide](docs/MCP_DEV_GUIDE.md)
- [Publishing Guide](docs/PUBLISH_GUIDE.md)
- [Multi-Agent Tab Lease Design](docs/MULTI_AGENT_TAB_LEASE_DESIGN.md)
- [Tab Lease Audit Report](docs/TAB_LEASE_AUDIT_REPORT.md)
- [Clone & Use Audit](docs/CLONE_AND_USE_AUDIT.md)

---

## Contributing

Contributions welcome — open an issue or submit a PR.

## License

MIT
