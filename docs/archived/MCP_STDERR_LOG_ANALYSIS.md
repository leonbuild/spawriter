# MCP Stdio `[error]` Log Analysis — Root Cause Report

**Date**: 2026-04-03
**Context**: Cursor, VS Code, and Claude Code simultaneously connecting to the same spawriter MCP server (stdio transport)

---

## TL;DR

All `[error]`-level entries in the Cursor MCP output panel are **false positives** — they are normal informational/debug messages that spawriter writes to `stderr`. Cursor's MCP client classifies **all stderr output as `[error]`**, regardless of content. This is a Cursor-side display issue, not a spawriter bug. The duplicate startup messages are caused by a known Cursor race condition when toggling/creating MCP server connections.

---

## 1. The Logs Under Investigation

```
14:42:34.813 [info]    Starting new stdio process with command: node D:\dev\side\spawriter\mcp\dist\cli.js serve
14:42:34.813 [info]    Server creation in progress, waiting for completion
14:42:34.813 [info]    Handling DeleteClient action, reason: server_disabled
14:42:34.813 [warning] Pending server creation failed: Server cleanup requested during creation
14:42:34.813 [info]    Starting new stdio process with command: node D:\dev\side\spawriter\mcp\dist\cli.js serve
14:42:34.813 [info]    Server creation in progress, waiting for completion
14:42:36.673 [error]   spawriter v1.0.0
14:42:36.673 [error]   spawriter v1.0.0
14:42:36.675 [error]   [SPAWRITER] ...T06:42:36.672Z Starting MCP server...
14:42:36.675 [error]   [SPAWRITER] ...T06:42:36.672Z Starting MCP server...
14:42:36.725 [error]   [SPAWRITER] ...T06:42:36.702Z MCP server ready
14:42:36.725 [error]   [SPAWRITER] ...T06:42:36.706Z MCP server ready
14:42:36.736 [info]    Successfully connected to stdio server
14:42:36.736 [info]    Storing stdio client: user-spawriter
14:42:36.736 [info]    [MCP Allowlist] Creating adapter with serverName="spawriter", identifier="user-spawriter"
14:42:36.736 [info]    CreateClient completed, server stored: true
14:42:36.739 [info]    Successfully connected to stdio server
14:42:36.739 [info]    A second client was created while connecting, discarding it.
14:42:36.739 [info]    CreateClient completed, server stored: true
14:42:36.743 [error]   [SPAWRITER] ...T06:42:36.741Z Relay server already running
14:42:36.743 [error]   [SPAWRITER] ...T06:42:36.741Z Relay server already running
14:42:55.867 [info]    Handling DeleteClient action, reason: server_disabled
14:42:55.867 [info]    Cleaning up, reason: server_disabled
14:42:55.867 [warning] [V1] connected -> disconnected
14:43:57.157 [info]    Starting new stdio process with command: node D:\dev\side\spawriter\mcp\dist\cli.js serve
14:43:57.733 [error]   spawriter v1.0.0
14:43:57.734 [error]   [SPAWRITER] ...T06:43:57.733Z Starting MCP server...
14:43:57.743 [error]   [SPAWRITER] ...T06:43:57.742Z MCP server ready
14:43:57.748 [info]    Successfully connected to stdio server
14:43:57.748 [info]    Storing stdio client: user-spawriter
14:43:57.748 [warning] [MCP Allowlist] No serverName provided for adapter...
14:43:57.748 [info]    CreateClient completed, server stored: true
14:43:57.755 [error]   [SPAWRITER] ...T06:43:57.754Z Relay server already running
14:43:57.755 [error]   [SPAWRITER] ...T06:43:57.754Z Relay server already running
```

---

## 2. Root Cause Analysis Per Log Entry

### 2.1 `[error] spawriter v1.0.0` — FALSE POSITIVE

**Source**: `mcp/src/cli.ts:16`

```typescript
process.stderr.write(`spawriter v${VERSION}\n`);
```

**Root cause**: The version banner is intentionally printed to `stderr` on every CLI invocation — this is the correct approach for MCP stdio servers, since `stdout` is reserved exclusively for JSON-RPC messages. Cursor classifies **all stderr output** as `[error]` level in its log panel.

**Verdict**: Normal. Not an error.

---

### 2.2 `[error] [SPAWRITER] ... Starting MCP server...` — FALSE POSITIVE

**Source**: `mcp/src/mcp.ts:3303` (inside `main()`)

```typescript
log('Starting MCP server...');
```

The `log()` function (`mcp/src/utils.ts:46-47`) writes to `process.stderr`:

```typescript
export function log(...args: unknown[]): void {
  process.stderr.write(`[SPAWRITER] ${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
}
```

**Root cause**: Same as above — `log()` uses stderr as the logging channel per MCP spec. Cursor renders it as `[error]`.

**Verdict**: Normal. Not an error.

---

### 2.3 `[error] [SPAWRITER] ... MCP server ready` — FALSE POSITIVE

**Source**: `mcp/src/mcp.ts:3324`

```typescript
log('MCP server ready');
```

**Verdict**: Normal success message routed through stderr.

---

### 2.4 `[error] [SPAWRITER] ... Relay server already running` — FALSE POSITIVE (but indicates multi-client scenario)

**Source**: `mcp/src/mcp.ts:354-361` (inside `ensureRelayServer()`)

```typescript
async function ensureRelayServer(): Promise<void> {
  try {
    const response = await fetch(`http://localhost:${getRelayPort()}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      log('Relay server already running');
      return;
    }
  } catch {
    log('Relay server not running, attempting to start...');
  }
  // ... spawn relay child process ...
}
```

**Root cause**: When the first MCP server process (from Cursor, VS Code, or Claude Code) starts, it spawns a detached relay child process on port 19989 (default). Subsequent MCP processes probe `GET http://localhost:19989/version` — when they get a 200 OK, they log "already running" and skip spawning.

**Why it appears twice per startup**: Cursor's race condition spawns two server processes simultaneously (see §2.6), so each process independently probes and logs this message.

**Verdict**: Normal and expected when multiple hosts share one relay. Not an error.

---

### 2.5 `[warning] Pending server creation failed: Server cleanup requested during creation` — CURSOR-SIDE RACE CONDITION

**Source**: Cursor's internal MCP client code (not spawriter)

**Root cause**: Cursor's MCP subsystem received a `DeleteClient` action (reason: `server_disabled`) while it was still in the middle of creating the server connection. The sequence at `14:42:34.813`:

1. Cursor starts creating stdio process #1
2. Before creation completes, Cursor receives a `server_disabled` event (likely from a settings toggle or re-initialization)
3. The pending creation is cancelled with this warning
4. Cursor immediately starts creating stdio process #2

This is a **known Cursor bug** — a race condition in MCP server lifecycle management. It's been reported multiple times on the Cursor Community Forum (see [MCP Server Race Condition Causes Infinite Process Spawning](https://forum.cursor.com/t/mcp-server-race-condition-causes-infinite-process-spawning-on-windows-cursor-2-0-34/139610) and [MCP server process leak](https://forum.cursor.com/t/mcp-server-process-leak/151615/3)).

**Verdict**: Cursor-side bug. Harmless in this case (the server recovers), but can cause orphaned processes over time.

---

### 2.6 Duplicate `Starting new stdio process` and `A second client was created while connecting, discarding it.`

**Source**: Cursor's internal MCP client code

**Root cause**: Direct consequence of the race in §2.5. Cursor spawns **two** stdio processes in rapid succession:

```
14:42:34.813 [info] Starting new stdio process ... (process #1)
14:42:34.813 [info] Server creation in progress, waiting for completion
14:42:34.813 [info] Handling DeleteClient action, reason: server_disabled
14:42:34.813 [warning] Pending server creation failed: ...
14:42:34.813 [info] Starting new stdio process ... (process #2)
```

Both processes start successfully, both write their banners to stderr, both connect — but then Cursor realizes it has two connected clients:

```
14:42:36.736 [info] Successfully connected to stdio server       ← process #1 wins
14:42:36.739 [info] Successfully connected to stdio server       ← process #2 also connects
14:42:36.739 [info] A second client was created while connecting, discarding it.  ← process #2 discarded
```

**Impact**: The discarded second process **may not be properly killed**, leading to an orphaned `node` process. This is the Cursor MCP process leak bug.

**Verdict**: Cursor-side race condition. The spawriter server itself is unaffected, but the orphaned node process wastes memory.

---

### 2.7 `[info] Handling DeleteClient action, reason: server_disabled` / `[warning] [V1] connected -> disconnected`

**Source**: Cursor's internal MCP client code

**Root cause**: These appear when the MCP server connection is toggled (disabled → enabled) or when Cursor restarts its extension host. `V1` likely refers to the MCP protocol version (v1 of Cursor's internal state machine). The state transition `connected -> disconnected` is logged as `[warning]` because it's an abnormal lifecycle event (not a clean shutdown).

**Trigger**: Most likely caused by the user toggling the MCP server in Cursor settings, or by Cursor's extension host restarting (which happens on window focus changes or after configuration edits).

**Verdict**: Normal lifecycle event. Not a spawriter issue.

---

### 2.8 `[warning] [MCP Allowlist] No serverName provided for adapter, falling back to stripIdentifierPrefix`

**Source**: Cursor's internal MCP Allowlist system

**Root cause**: On the second reconnection (14:43:57), Cursor's Allowlist adapter didn't receive the `serverName` parameter. Contrast with the first connection:

```
14:42:36.736 [info] [MCP Allowlist] Creating adapter with serverName="spawriter", identifier="user-spawriter"
```

vs the reconnection:

```
14:43:57.748 [warning] [MCP Allowlist] No serverName provided for adapter, falling back to stripIdentifierPrefix. identifier="user-spawriter"
```

This is a minor Cursor-side inconsistency — when reconnecting after a `server_disabled` cycle, the serverName isn't passed to the Allowlist adapter constructor. The fallback `stripIdentifierPrefix` strips the `user-` prefix from `user-spawriter` to derive "spawriter", so the end result is identical.

**Verdict**: Cursor-side cosmetic inconsistency. No functional impact.

---

### 2.9 `undefined` after every `[error]` line

**Example**:
```
14:42:36.673 [error] spawriter v1.0.0
 undefined
```

**Root cause**: Cursor's stderr log capture calls a function that expects a second value (possibly the "source" or "category") from the stderr data. Since spawriter's stderr output is raw text (not structured), the second field is `undefined`. This is purely a Cursor log formatting artifact.

**Verdict**: Cursor-side display bug. Ignore.

---

## 3. Why Duplicate Lines Appear (Two of Everything)

The log shows every spawriter stderr line **doubled**:

```
[error] spawriter v1.0.0
[error] spawriter v1.0.0
[error] [SPAWRITER] ... Starting MCP server...
[error] [SPAWRITER] ... Starting MCP server...
```

**Root cause**: Cursor's race condition (§2.5/§2.6) spawned **two** `node ... cli.js serve` processes. Both processes write to stderr independently. Cursor captures stderr from both and logs them interleaved. After one client is discarded (§2.6), only one process continues — which is why later reconnections (14:43:57) show single lines.

---

## 4. Architecture Diagram: Multi-Host Sharing

```
┌─────────┐   ┌─────────┐   ┌────────────┐
│  Cursor  │   │ VS Code │   │ Claude Code│
│ (stdio)  │   │ (stdio) │   │  (stdio)   │
└────┬─────┘   └────┬────┘   └─────┬──────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐  ┌──────────┐  ┌──────────┐
│ node    │  │ node     │  │ node     │
│ cli.js  │  │ cli.js   │  │ cli.js   │
│ serve   │  │ serve    │  │ serve    │
│ (MCP #1)│  │ (MCP #2) │  │ (MCP #3) │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │
     │   ensureRelayServer()       │
     │   GET /version → 200 OK    │
     │   "already running" ✓      │
     │              │              │
     ▼              ▼              ▼
    ┌──────────────────────────────┐
    │   Shared Relay Server        │
    │   (port 19989, detached)     │
    │   HTTP + WebSocket           │
    │   /extension  /cdp/:clientId │
    └──────────────┬───────────────┘
                   │
                   ▼
            ┌──────────────┐
            │ Chrome Tab   │
            │ (spawriter   │
            │  extension)  │
            └──────────────┘
```

Each MCP host spawns its own `node cli.js serve` process. The **first** one to start also spawns the relay (detached, `unref()`). All subsequent ones detect the relay via the `/version` health probe and share it.

---

## 5. MCP Specification: stderr Is NOT for Errors Only

The [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/latest/basic/transports) explicitly states:

> The server MAY write UTF-8 strings to its standard error (`stderr`) for **any logging purposes including informational, debug, and error messages**.

> The client MAY capture, forward, or ignore the server's `stderr` output and **SHOULD NOT assume `stderr` output indicates error conditions**.

This was formalized in [PR #670](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/670) after clients like Cursor and Roo were observed misclassifying stderr as errors.

**Cursor violates this SHOULD NOT** by labeling all stderr output as `[error]`. This is a known Cursor limitation, not a spawriter bug.

---

## 6. Summary Table

| Log Message | Level | Source | Is It an Error? | Root Cause |
|---|---|---|---|---|
| `spawriter v1.0.0` | `[error]` | spawriter `cli.ts:16` | **No** — version banner on stderr | Cursor maps all stderr → `[error]` |
| `Starting MCP server...` | `[error]` | spawriter `mcp.ts:3303` | **No** — info log on stderr | Cursor maps all stderr → `[error]` |
| `MCP server ready` | `[error]` | spawriter `mcp.ts:3324` | **No** — success log on stderr | Cursor maps all stderr → `[error]` |
| `Relay server already running` | `[error]` | spawriter `mcp.ts:360` | **No** — relay found healthy | Cursor maps all stderr → `[error]`; relay shared across hosts |
| `Pending server creation failed` | `[warning]` | Cursor internal | **No** — race condition, auto-recovered | Cursor DeleteClient/CreateClient race |
| `A second client was created...` | `[info]` | Cursor internal | **No** — duplicate discarded | Consequence of above race; may leak a process |
| `[V1] connected -> disconnected` | `[warning]` | Cursor internal | **No** — lifecycle transition | Server disabled/re-enabled by Cursor |
| `[MCP Allowlist] No serverName` | `[warning]` | Cursor internal | **No** — fallback works | Cursor doesn't pass serverName on reconnect |
| `undefined` after `[error]` lines | — | Cursor internal | **No** — display artifact | Cursor expects structured stderr; gets raw text |

---

## 7. Audit: spawriter Issues Identified

While the `[error]` labels are false positives, the investigation reveals several **real issues** in spawriter that should be fixed:

### 7.1 CRITICAL: Relay server has no EADDRINUSE handling

**File**: `mcp/src/relay.ts:1211`

```typescript
server.listen(port, () => {
  log(`Relay server started on port ${port}`);
});
```

There is **no `server.on('error')` handler**. If the relay is spawned twice in a race (e.g., two MCP hosts starting simultaneously before the first relay is ready), the second relay process will crash with an unhandled `EADDRINUSE` error. Since the relay is spawned with `stdio: 'ignore'`, the crash is invisible.

**Fix**: Add an `error` event handler to `server` that detects `EADDRINUSE` and exits gracefully (code 0, since the port being taken means another relay is already serving).

```typescript
// relay.ts — add before server.listen()
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${port} already in use — another relay is running. Exiting gracefully.`);
    process.exit(0);
  }
  error('Relay server error:', err.message);
  process.exit(1);
});
```

---

### 7.2 MEDIUM: `ensureRelayServer()` has no reentrancy guard

**File**: `mcp/src/mcp.ts:354-400`

`ensureRelayServer()` is called from many places:
- `main()` at startup (line 3317)
- `doEnsureSession()` (line 682)
- `list_tabs` handler (line 1697)
- `switch_tab` handler (line 1744)
- `connect_tab` handler (line 1823)
- `playwright_execute` handler (line 1911)
- `trace` handler (line 3234)

If multiple tool calls arrive simultaneously, each will independently call `ensureRelayServer()`. While `doEnsureSession` has a mutex (`sessionPromise`), `ensureRelayServer` does not. Two concurrent calls could both pass the `/version` probe failure and both try to `spawn('node', [relayPath])`.

**Fix**: Add a promise-based mutex (same pattern as `sessionPromise`):

```typescript
let relayPromise: Promise<void> | null = null;

async function ensureRelayServer(): Promise<void> {
  // Fast path: relay already up
  try {
    const response = await fetch(`http://localhost:${getRelayPort()}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      log('Relay server already running');
      return;
    }
  } catch {
    // needs start
  }

  // Mutex: only one caller starts the relay
  if (relayPromise) {
    return relayPromise;
  }
  relayPromise = doStartRelay();
  try {
    return await relayPromise;
  } finally {
    relayPromise = null;
  }
}

async function doStartRelay(): Promise<void> {
  // ... existing spawn + polling logic ...
}
```

---

### 7.3 MEDIUM: No MCP logging capability declared

**File**: `mcp/src/mcp.ts:1160-1170`

```typescript
const server = new Server(
  { name: 'spawriter', version: VERSION },
  { capabilities: { tools: {} } }
);
```

spawriter only declares `tools` capability. The MCP spec defines a [`logging` capability](https://modelcontextprotocol.io/specification/2024-11-05/server/utilities/logging) that allows servers to send **structured** log messages with proper severity levels (`debug`, `info`, `warning`, `error`, etc.) via `notifications/message`. This would allow clients to display log levels correctly instead of dumping everything as `[error]`.

**Fix**: Declare `logging` capability and use `server.sendLoggingMessage()` for important lifecycle events:

```typescript
const server = new Server(
  { name: 'spawriter', version: VERSION },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);
```

Then optionally supplement stderr logging with protocol-level notifications for key events:

```typescript
// After server.connect(transport), send structured logs
server.sendLoggingMessage({
  level: 'info',
  logger: 'spawriter',
  data: 'MCP server ready',
});
```

Note: stderr logging should be **kept** (for when the protocol channel isn't ready yet, and for non-MCP consumers). This is additive, not a replacement.

---

### 7.4 LOW: Orphaned relay process on MCP exit

**File**: `mcp/src/mcp.ts:375-380`

```typescript
relayServerProcess = spawn('node', [relayPath], {
  stdio: 'ignore',
  detached: true,
});
relayServerProcess.unref();
```

The relay is spawned detached and unref'd. This is intentional (relay should outlive MCP), but there's no cleanup mechanism. When **all** MCP hosts disconnect, the relay keeps running indefinitely. This is by design for the current use case, but could be improved with a configurable idle timeout.

**Fix** (optional): Add an idle timeout to the relay that auto-exits when no CDP clients and no extension are connected for N minutes:

```typescript
// relay.ts — add idle shutdown logic
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (cdpClients.size === 0 && !extensionWs) {
      log('No clients connected for 5 minutes. Shutting down relay.');
      process.exit(0);
    }
    resetIdleTimer(); // re-check if still idle
  }, IDLE_TIMEOUT_MS);
}
```

---

### 7.5 LOW: Version banner noise reduction

**File**: `mcp/src/cli.ts:16`

```typescript
process.stderr.write(`spawriter v${VERSION}\n`);
```

This runs unconditionally on every invocation, even for `serve`. Since Cursor spawns new processes on every reconnect, it creates noise in logs. Consider gating it to `--version` / `--help` only, or prefixing it with `[SPAWRITER]` for consistency.

**Fix**:

```typescript
// Only print banner for explicit version request or non-serve commands
if (command !== 'serve' && command !== 'relay') {
  process.stderr.write(`spawriter v${VERSION}\n`);
}
```

Or keep it but use the standard prefix:

```typescript
log(`spawriter v${VERSION}`);
```

---

## 8. Fix Plan — Priority Order

| # | Priority | Area | Issue | Fix Location | Effort |
|---|----------|------|-------|--------------|--------|
| 1 | **CRITICAL** | Relay | No EADDRINUSE handler — silent crash | `relay.ts` before `server.listen()` | 5 min |
| 2 | **MEDIUM** | MCP | `ensureRelayServer()` lacks reentrancy guard | `mcp.ts:354-400` | 15 min |
| 3 | **MEDIUM** | MCP | No `logging` capability — all logs appear as `[error]` | `mcp.ts:1160-1170` + new helper | 30 min |
| 4 | **LOW** | Relay | No idle timeout — relay runs forever | `relay.ts` — new idle shutdown | 20 min |
| 5 | **LOW** | CLI | Version banner noise | `cli.ts:16` | 2 min |

---

## 9. Cursor-Side Issues (Cannot Fix, Documented for Reference)

| Area | Issue | Status | Forum Link |
|---|---|---|---|
| stderr → `[error]` classification | Violates MCP spec: "SHOULD NOT assume stderr output indicates error conditions" | Known, no fix | — |
| Race condition: double process spawn | `DeleteClient` during `CreateClient` causes duplicate spawn | Known bug | [forum](https://forum.cursor.com/t/mcp-server-race-condition-causes-infinite-process-spawning-on-windows-cursor-2-0-34/139610) |
| Orphaned processes | Discarded second client's node process may not be killed | Known bug | [forum](https://forum.cursor.com/t/mcp-server-process-leak/151615/3) |
| `undefined` after stderr lines | Log formatter expects structured data, gets raw text | Cosmetic | — |
| Missing `serverName` on reconnect | Allowlist adapter falls back to `stripIdentifierPrefix` | Cosmetic | — |

---

## 10. Conclusion

**None of the `[error]` log entries represent actual errors in spawriter.** They are all normal informational messages written to stderr per the MCP specification's logging convention. Cursor misclassifies them as errors because it labels all stderr output with `[error]` severity, violating the MCP spec's explicit guidance.

The `[warning]` entries are Cursor-internal lifecycle events caused by a known race condition in Cursor's MCP client. They are harmless but may occasionally result in orphaned node processes.

When running spawriter across Cursor + VS Code + Claude Code simultaneously, the "Relay server already running" messages are **expected and correct** — they confirm the relay singleton pattern is working as designed.

However, the audit uncovered **real issues** in spawriter (§7.1–7.5) — most critically the missing EADDRINUSE handler on the relay server and the missing reentrancy guard on `ensureRelayServer()` — that should be addressed regardless of the Cursor log display bug.

---

## 11. Implementation Status

All 5 fixes have been implemented and verified:

| # | Fix | Files Changed | Tests Added | Status |
|---|-----|---------------|-------------|--------|
| 1 | EADDRINUSE handler | `relay.ts` | 3 tests in `relay.test.ts` | **DONE** |
| 2 | `ensureRelayServer()` reentrancy guard | `mcp.ts` | 5 tests in `mcp.test.ts` | **DONE** |
| 3 | MCP `logging` capability + `mcpLog()` helper | `mcp.ts` | — (runtime behavior) | **DONE** |
| 4 | Relay idle shutdown (5 min) | `relay.ts` | 4 tests in `relay.test.ts` | **DONE** |
| 5 | Version banner suppression for `serve`/`relay` | `cli.ts` | 5 tests in `cli.test.ts` | **DONE** |

### Test Results (after audit pass)

```
cli.test.ts:    36 tests, 9 suites   — all pass  (+5 banner suppression)
relay.test.ts:  60 tests, 18 suites  — all pass  (+7 idle timer lifecycle, +3 EADDRINUSE, +4 shutdown decision)
mcp.test.ts:   974 tests, 169 suites — all pass  (+8 relay reentrancy, +4 logging capability, +4 version probe)
Build:          tsc — 0 errors
```

### Test Coverage by Fix

| Fix | Tests | What's Covered |
|-----|-------|---------------|
| **#1 EADDRINUSE** | 3 logic + verified in code | Classification: EADDRINUSE → graceful exit, EACCES → error exit, unknown → error exit |
| **#2 Reentrancy guard** | 9 total | Mutex: single start, skip when running, release after complete, error recovery, concurrent error propagation. Full flow: version probe fast path, probe-then-start, probe-after-running, concurrent start with probe |
| **#3 MCP logging** | 4 total | Capability declaration, dual-channel (stderr + protocol), rejection swallowing, all severity levels |
| **#4 Idle shutdown** | 11 total | Decision logic: 4 cases. Timer lifecycle: set on empty, skip on clients, cancel on connect, fire → shutdown, fire → no shutdown (reconnected), re-arm, cancel on extension |
| **#5 Banner suppression** | 5 total | Suppress for serve/relay, print for unknown, print for undefined, print for --help |
