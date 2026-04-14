# spawriter

**AI-assisted browser automation & debugging for single-spa micro-frontends.**

spawriter gives AI agents (Cursor, Claude Code, Codex, GitHub Copilot, OpenCode, etc.) direct access to your **real Chrome tab** via MCP — enabling autonomous **code -> override -> screenshot -> iterate** workflows for micro-frontend development.

Other browser MCPs spawn a fresh Chrome — no logins, no extensions, instantly flagged by bot detectors, double the memory. spawriter connects to **your running browser** instead. One Chrome extension, full Playwright API, everything you're already logged into — plus **single-spa aware** tooling for import-map overrides, app lifecycle control, and micro-frontend debugging.

## Installation

### From source (git clone)

```bash
git clone <repo-url> spawriter
cd spawriter
npm run setup          # install deps + build extension + build MCP server
npm run link           # optional: makes `spawriter` command available system-wide
```

After linking, you can use `spawriter` directly from any terminal:

```bash
spawriter --version
spawriter skill
spawriter serve
```

Without linking, use the full path:

```bash
node /path/to/spawriter/spawriter/dist/cli.js serve
node /path/to/spawriter/spawriter/dist/cli.js skill
```

### Chrome Extension

1. Open `chrome://extensions/` -> enable Developer mode
2. Click "Load unpacked" -> select `extension/dist-chrome/`
3. Click the extension icon on any tab -> turns green when connected

### Configure your AI client

See MCP Setup below.

## CLI Usage

```bash
# MCP server (for AI agents)
spawriter                    # start MCP server (default command, no -e)
spawriter serve              # same as above, explicit

# Code execution (Playwright API + spawriter extensions)
spawriter session new                        # create a session, prints ID
spawriter -s <id> -e 'await page.goto("https://example.com")'
spawriter -s <id> -e 'return await singleSpa("status")'
spawriter -s <id> -e 'await tab("connect", { url: "http://localhost:9000", create: true })'

# Session management
spawriter session list       # list active sessions
spawriter session reset <id> # reset a session's browser connection
spawriter session delete <id># delete a session

# Other
spawriter relay              # start CDP relay only
spawriter skill              # print CLI documentation
spawriter logfile            # print log file paths
spawriter --version          # show version
spawriter --help             # show help
```

Run `spawriter skill` for the full CLI reference.

## MCP Setup

> Replace `/path/to/spawriter` with your actual clone path. Windows: use `"D:\\dev\\side\\spawriter"`.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["/path/to/spawriter/spawriter/dist/cli.js", "serve"]
    }
  }
}
```

**AI Instructions**: copy `AGENTS.md` into `.cursor/rules/spawriter.md`

### Claude Code

```bash
claude mcp add --scope user --transport stdio spawriter -- \
  node /path/to/spawriter/spawriter/dist/cli.js serve
```

**AI Instructions**: copy `AGENTS.md` to project root or into `CLAUDE.md`

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "spawriter": {
      "command": "node",
      "args": ["/path/to/spawriter/spawriter/dist/cli.js", "serve"]
    }
  }
}
```

**AI Instructions**: `AGENTS.md` at project root is automatically picked up by Copilot

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.spawriter]
command = "node"
args = ["/path/to/spawriter/spawriter/dist/cli.js", "serve"]
```

### OpenCode

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spawriter": {
      "type": "local",
      "command": ["node", "/path/to/spawriter/spawriter/dist/cli.js", "serve"],
      "enabled": true
    }
  }
}
```

## Architecture

```
AI Agent -> MCP Server (stdio) -> CDP Relay (:19989) -> Chrome Extension -> Browser Tab
```

Monorepo with two packages managed via **npm workspaces**:

| Directory | Package | Description |
|---|---|---|
| `extension/` | `spawriter-extension` | Chrome extension (Manifest V3): DevTools panel, AI Bridge, CDP relay connection |
| `spawriter/` | `spawriter` | MCP server + CDP relay + CLI |

Key features:
- **4 core MCP tools**: `execute`, `reset`, `single_spa`, `tab` (legacy tools deprecated but still available)
- **CLI `-e` code execution**: `spawriter -s <id> -e '<code>'` — Playwright API + spawriter extensions
- **Zero-touch tab management** — agents create/attach/navigate tabs programmatically
- **Multi-agent isolation** — Tab Lease System ensures exclusive tab ownership
- **Persistent connection** — offscreen document survives MV3 service worker restarts

## Scripts

| Command | Description |
|---|---|
| `npm run setup` | Install deps + build extension + build MCP server |
| `npm run build` | Build everything |
| `npm run build:mcp` | Build MCP server only |
| `npm run build:ext` | Build extension only |
| `npm run link` | Link `spawriter` CLI globally via npm link |
| `npm run release` | Build + package into `release/` |
| `npm test` | Run all tests |

## Troubleshooting

| Problem | Fix |
|---|---|
| Chrome: "manifest file missing" | Load `extension/dist-chrome/`, not `extension/`. Run `npm run setup` first. |
| `Cannot find module` | Run `npm run setup` or `npm run build:mcp` |
| MCP connected but no page | Navigate to a normal web page (not `chrome://` or `edge://`) |
| webpack OpenSSL error | Use Node.js 18+ LTS |
