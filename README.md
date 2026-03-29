# spawriter

**The missing link between AI coding agents and single-spa micro-frontends.**

spawriter gives AI agents (Cursor, Codex, Cline, etc.) direct access to your **real Chrome tab** via MCP — enabling autonomous **code → override → screenshot → iterate** workflows for micro-frontend development.

> `v1.0.0` · MIT License

---

## Quick Start

### 1. Build

```bash
npm install && cd ext && npm install && cd ../mcp && npm install && cd ..
npm run build
```

### 2. Load Chrome Extension

1. Open `chrome://extensions/` → Enable **Developer mode**
2. Click **Load unpacked** → Select `ext/dist-chrome/`

### 3. Start MCP Server

```bash
npm run mcp:serve
```

### 4. Configure Your AI Client

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
AI Agent → MCP Server (stdio) → CDP Relay (:19989) → Chrome Extension → Browser Tab
```

Monorepo with two packages:

- **`ext/`** — Chrome extension (Manifest V3): DevTools panel, AI Bridge, CDP relay connection
- **`mcp/`** — MCP server + CDP relay: 30 tools for browser automation

Key features:
- **Zero-touch tab management** — agents create/attach/navigate tabs programmatically
- **Multi-agent isolation** — Tab Lease System ensures exclusive tab ownership
- **Persistent connection** — offscreen document survives MV3 service worker restarts

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

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Chrome: "manifest file missing" | Loaded wrong directory | Load `ext/dist-chrome/`, not `ext/` or repo root. Build first if it doesn't exist. |
| `Cannot find module 'mcp/dist/cli.js'` | Not built yet | Run `npm run mcp:build` or `npm run build` |
| `npm install` 567 / mirror errors | Stale `package-lock.json` | Delete it and run `npm install` again |
| MCP connected but no page | Wrong tab type | Navigate to a normal web page (not `chrome://` or `edge://`) |
| webpack OpenSSL error | Node.js version | Build scripts already include `--openssl-legacy-provider` |

---

## Project Structure

```
spawriter/
├── ext/                     # Chrome Extension (Manifest V3)
│   ├── src/                 # Source (JS/React)
│   ├── build/               # Webpack output (gitignored)
│   ├── dist-chrome/         # Chrome build (gitignored)
│   ├── manifest.json        # Firefox manifest
│   └── manifest.chrome.json # Chrome manifest
├── mcp/                     # MCP Server (TypeScript)
│   ├── src/                 # Source (TS)
│   ├── dist/                # Compiled output (gitignored)
│   ├── skills/              # AI skill definitions
│   └── cursor-rules/        # Cursor IDE rule templates
├── scripts/                 # Build orchestration
├── docs/                    # Documentation
└── package.json             # Root orchestration
```

## Documentation

- `docs/CHROME_INSTALL_TEST_GUIDE.md` — Extension installation & testing
- `docs/MCP_DEV_GUIDE.md` — MCP server development
- `docs/PUBLISH_GUIDE.md` — Release & publishing
- `docs/MULTI_AGENT_TAB_LEASE_DESIGN.md` — Tab lease system design
- `docs/TAB_LEASE_AUDIT_REPORT.md` — Lease system audit

## Contributing

Contributions welcome — open an issue or submit a PR.

## License

MIT
