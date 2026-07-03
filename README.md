# spawriter

**AI-assisted browser automation & debugging for single-spa micro-frontends.**

spawriter gives AI agents (Cursor, Claude Code, Codex, GitHub Copilot, OpenCode, etc.) direct access to your **real Chrome tab** via MCP — enabling autonomous **code -> override -> screenshot -> iterate** workflows for micro-frontend development.

Other browser MCPs spawn a fresh Chrome — no logins, no extensions, instantly flagged by bot detectors, double the memory. spawriter connects to **your running browser** instead. One Chrome extension, full Playwright API, everything you're already logged into — plus **single-spa aware** tooling for import-map overrides, app lifecycle control, and micro-frontend debugging.

## Installation

### From source (git clone)

```bash
git clone <repo-url> spawriter
cd spawriter
npm run setup
npm run link
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

1. Build it first: `npm run build:ext` (already included in `npm run setup`)
2. Open `chrome://extensions/` -> enable Developer mode
3. Click "Load unpacked" -> select the `extension/` directory (its `manifest.json` references `./build/`)
   - Strict alternative: unzip `extension/web-ext-artifacts/spawriter-chrome-<version>.zip` and load the unzipped directory (Chrome-specific manifest, no Firefox keys)
4. Click the extension icon on any tab -> turns green when connected

### Configure your AI client

See MCP Setup below.

## CLI Usage

```bash
# MCP server (for AI agents)
spawriter                    # start MCP server (default command, no -e)
spawriter serve              # same as above, explicit

# Code execution (Playwright API + spawriter extensions)
spawriter session new                        # create a session, prints ID
spawriter -s <id> -e 'page.url()'            # execute code in the session
spawriter -s <id> -e 'await navigate("https://example.com")'
spawriter -s <id> -e 'await screenshot()'
spawriter -s <id> -f script.js               # execute code from a file
echo 'page.url()' | spawriter -s <id> -e -   # read code from stdin (avoids shell quoting issues)

# Session management
spawriter session list                       # list active sessions
spawriter session reset <id>                 # reset a session's browser connection
spawriter session delete <id>                # delete a session
spawriter session bind <tabId> -s <id>       # bind session to a specific Chrome tab

# Tab management (CLI equivalents of the MCP `tab` tool)
spawriter tabs list -s <id>                  # list tabs with MINE/AVAILABLE/OWNED status
spawriter tabs connect <url> --create -s <id>  # connect + claim a tab (--force-create: always create)
spawriter tabs release [tabId] -s <id>       # release one owned tab, or all if omitted

# Other
spawriter relay              # start CDP relay only
spawriter relay --replace    # replace existing relay server
spawriter skill              # print the full usage instructions (AGENTS_Unified.md)
spawriter logfile            # print log file paths
spawriter --version          # show version
spawriter --help             # show help
```

On first `execute`, spawriter auto-acquires a browser tab (reuses idle attached tabs or creates a new one). If auto-acquisition fails, use `session bind` to manually bind a tab. See `AGENTS_CLI.md` for details.

Run `spawriter skill` for the full usage reference.

## MCP Setup

> Replace `/path/to/spawriter` with your actual clone path. Windows: use `"D:\\dev\\side\\spawriter"`.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "spawriter": {
      "command": "node",
      "args": ["D:\\dev\\side\\spawriter\\spawriter\\dist\\cli.js", "serve"]
    }
  }
}
```

**AI Instructions**: copy `AGENTS_Unified.md` into `.cursor/rules/spawriter.md`

### Claude Code

```bash
claude mcp add --scope user --transport stdio spawriter -- \
  node /path/to/spawriter/spawriter/dist/cli.js serve
```

**AI Instructions**: copy `AGENTS_Unified.md` to project root or into `CLAUDE.md`

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

**AI Instructions**: copy `AGENTS_Unified.md` to your project root as `AGENTS.md` (Copilot auto-detects that filename)

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
AI Agent ──→ MCP Server (stdio) ──→ CDP Relay (:19989) ←──→ Chrome Extension ←──→ Browser Tab
         or  CLI (-e)           HTTP                    WS                    chrome.debugger
```

### Security model

The relay binds to `127.0.0.1` only by default, so it is not reachable from the network. Without `SSPA_MCP_TOKEN` set, **any local process** can execute browser code (including your logged-in sessions) through port 19989. On multi-user or shared machines, set `SSPA_MCP_TOKEN` — all `/cli/*` endpoints then require `Authorization: Bearer <token>`.

Additional hardening enforced by the relay:

- **Loopback by default.** Binding to a public host (`--host 0.0.0.0`, `SSPA_RELAY_BIND_HOST`) is refused unless `SSPA_MCP_TOKEN` is set, and any non-localhost request must then carry the token — health check `GET /` aside.
- **Browser CSRF / DNS-rebinding guard.** Every route rejects requests whose `Sec-Fetch-Site` is cross-site/same-site, so a malicious web page cannot drive or shut down the relay. Non-browser clients (CLI, MCP) are unaffected.

Monorepo with two packages managed via **npm workspaces**:

| Directory | Package | Description |
|---|---|---|
| `extension/` | `spawriter-extension` | Chrome extension (Manifest V3): DevTools panel, AI Bridge, CDP relay connection |
| `spawriter/` | `spawriter` | MCP server + CDP relay + CLI |

Key features:
- **4 core MCP tools**: `execute`, `reset`, `single_spa`, `tab`
- **CLI `-e` code execution**: `spawriter -s <id> -e '<code>'` — Playwright API + spawriter extensions in an isolated VM sandbox
- **Auto tab acquisition** — first execute auto-acquires a tab (idle reuse → create new); fallback to manual `session bind`
- **Multi-agent isolation** — Tab Ownership System ensures exclusive tab ownership per session; idle sessions cleaned up after 30 min
- **Per-tab status markers** — attached tabs show a dot in the tab title: 🟢 claimed by an agent session, 🔵 attached but idle (reusable); markers are applied idempotently by the extension only
- **Persistent connection** — offscreen document survives MV3 service worker restarts
- **User tab safety** — acquisition order is: own 🟢 tab → any 🔵 idle tab (URL match first, then newest) → create new; undotted user tabs are never touched. Attach a tab and navigate it to a page to hand it to an agent — agents see every blue dot with its URL and can pick it up directly

## Scripts

| Command | Description |
|---|---|
| `npm run setup` | Install deps + build extension + build MCP server |
| `npm run build` | Build everything |
| `npm run build:mcp` | Build MCP server only |
| `npm run build:ext` | Build extension only |
| `npm run link` | Link `spawriter` CLI globally via npm link |
| `npm test` | Run all tests |

## Troubleshooting

| Problem | Fix |
|---|---|
| Chrome: "manifest file missing" | Run `npm run setup` first, then load the `extension/` directory (not `extension/build/`) |
| `Cannot find module` | Run `npm run setup` or `npm run build:mcp` |
| MCP connected but no page | Navigate to a normal web page (not `chrome://` or `edge://`) |
| `No tab connected to this session` | `spawriter tabs connect <url> --force-create -s <id>`, or `spawriter session bind <tabId> -s <id>` — see `AGENTS_CLI.md` |
| Relay not running | By design the relay shuts down after 5 idle minutes with no clients; it restarts on the next CLI/MCP call. To start manually: `spawriter relay` or `spawriter relay --replace`. Session tab claims expire after 30 min (override: `SPAWRITER_CLAIM_TTL_MS`). |
| webpack OpenSSL error | Use Node.js 18+ LTS |
