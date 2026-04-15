# CDP WebSocket Proxy: Eliminating the Three-Tier Fallback

> Generated: 2026-04-15
> Status: **Research Document — Proposal**
> Tracked in: `EXECUTOR_REFACTOR_PLAN.md` (future phase)

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Why Fallbacks Exist Today](#why-fallbacks-exist-today)
3. [What a CDP WebSocket Proxy Would Solve](#what-a-cdp-websocket-proxy-would-solve)
4. [How Chrome's CDP Protocol Works](#how-chromes-cdp-protocol-works)
5. [Existing Reference Implementations](#existing-reference-implementations)
6. [Architecture Options](#architecture-options)
7. [Recommended Architecture: Full CDP WebSocket Proxy](#recommended-architecture)
8. [Implementation Plan](#implementation-plan)
9. [Risk Analysis](#risk-analysis)
10. [Appendix: Wire Protocol Reference](#appendix-wire-protocol-reference)

---

## Problem Statement

spawriter's relay connects Playwright to the browser via a Chrome extension using
`chrome.debugger` API. When Playwright calls `context.newCDPSession(page)`, it
sends `Target.attachToBrowserTarget` — a command the extension's debugger API
does **not support**. This causes `getCDPSession()` to return `null`, forcing
every CDP-dependent VM global into a fallback path.

The current three-tier fallback architecture works (41/41 CLI, 32/32 MCP — all
PASS) but adds complexity:

- **~500 LOC** of fallback code in `pw-executor.ts`
- **3 code paths** per CDP feature (direct → relay → evaluate)
- **Behavioral differences** between tiers (e.g., `page.evaluate` navigation
  doesn't report lifecycle events)
- **Maintenance burden**: every new CDP feature needs fallback implementations

**If the relay exposed a proper CDP WebSocket endpoint that Playwright could use
with `connectOverCDP()`, then `newCDPSession(page)` would work natively and all
fallbacks would be unnecessary.**

---

## Why Fallbacks Exist Today

### The Connection Chain

```
┌──────────┐       ┌─────────────────────┐       ┌──────────────────────┐
│ Playwright│◄─────►│ Relay (relay.ts)     │◄─────►│ Chrome Extension     │
│ (Node.js) │  CDP  │ WebSocket Server     │  WS   │ chrome.debugger API  │
│           │  WS   │ :18792/cdp           │       │ (background.js)      │
└──────────┘       └─────────────────────┘       └──────────┬───────────┘
                                                            │ chrome.debugger
                                                            ▼
                                                    ┌───────────────┐
                                                    │ Chrome Browser │
                                                    │ (Real Tab)     │
                                                    └───────────────┘
```

### The Critical Failure Point

When Playwright connects via `connectOverCDP('ws://localhost:18792/cdp')`, it
establishes a **browser-level CDP session**. To interact with a specific page,
it tries:

```
Playwright → Target.attachToBrowserTarget { targetId } → Relay → Extension
```

The extension's `chrome.debugger` API responds with:

```
{ "error": { "code": -32000, "message": "Not allowed" } }
```

**Why?** Chrome's extension debugger API (`chrome.debugger.attach`) already has
its own session management. It doesn't support the browser-level
`Target.attachToBrowserTarget` command that creates a raw CDP session from the
browser scope. The extension operates at the **tab scope**, not the **browser
scope**.

### Consequence: Three Tiers of Fallback

| Tier | When Used | Mechanism | Limitations |
|------|-----------|-----------|-------------|
| **1. Direct CDP** | `newCDPSession` succeeds | `cdpSession.send(method, params)` | Never works through relay |
| **2. Relay CDP** | Extension connected | `relaySendCdp()` → extension WS → `chrome.debugger.sendCommand` | No session multiplexing; single-tab at a time; no lifecycle events |
| **3. page.evaluate** | Last resort | `page.evaluate(() => { ... })` | Can't access browser-level APIs, no binary data, no event subscriptions |

---

## What a CDP WebSocket Proxy Would Solve

A properly implemented CDP WebSocket proxy would:

1. **Eliminate Tier 2 and Tier 3** — `newCDPSession(page)` works, so direct CDP
   is always available
2. **Remove ~500 LOC of fallback code** from `pw-executor.ts`
3. **Unify code paths** — every CDP feature has exactly one implementation
4. **Enable CDP event subscriptions** — `cdpSession.on('Network.requestWillBeSent')`
   works natively instead of Playwright event adapters
5. **Enable binary data transfer** — `Page.captureScreenshot` returns binary
   through the WebSocket directly, no base64 workaround
6. **Support page.goto() / page.reload()** — Playwright lifecycle events
   (`domcontentloaded`, `load`) propagate correctly
7. **Support page.screenshot()** — Playwright's native screenshot API works
   instead of CDP-level capture
8. **Enable multi-session** — Multiple CDP sessions can coexist (e.g., page
   session + service worker session)

---

## How Chrome's CDP Protocol Works

### Protocol Definition Source

The official Chrome DevTools Protocol is defined in PDL (Protocol Definition
Language) files maintained by the Chromium team at
[ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
(locally at `D:\dev\0-ref\devtools-protocol`). This repo is **not** a CDP
implementation — it is the **protocol schema and TypeScript type definitions**
published as the `devtools-protocol` npm package.

Key files in the repo:
- `pdl/domains/Target.pdl` — Defines `attachToTarget`, `attachToBrowserTarget`,
  `setAutoAttach`, session management, and target events
- `pdl/domains/Page.pdl` — Navigation, lifecycle events, screenshots
- `pdl/domains/Network.pdl` — Request/response monitoring
- `pdl/domains/Fetch.pdl` — Request interception
- `pdl/domains/Accessibility.pdl` — AX tree queries
- `json/browser_protocol.json` — Machine-readable JSON schema
- `types/protocol.d.ts` — TypeScript definitions for all protocol types
- `types/protocol-proxy-api.d.ts` — Domain API type mappings

The distinction between `Target.attachToTarget` and
`Target.attachToBrowserTarget` is defined in `Target.pdl`:

```
# Attaches to the target with given id.
command attachToTarget
  parameters
    TargetID targetId
    optional boolean flatten  # "flat" access via sessionId in commands
  returns
    SessionID sessionId

# Attaches to the browser target, only uses flat sessionId mode.
experimental command attachToBrowserTarget
  returns
    SessionID sessionId
```

`attachToBrowserTarget` is **experimental** and returns a session scoped to the
**browser itself** (not a page). This is what Playwright uses internally for its
`newCDPSession(page)` implementation when connecting via `connectOverCDP()`. The
extension's `chrome.debugger` API has no equivalent — it only supports
tab-scoped debugging via `chrome.debugger.attach({ tabId })`.

### Wire Format

CDP uses JSON-RPC over WebSocket. Three message types:

**Command (client → browser):**
```json
{ "id": 1, "method": "Page.captureScreenshot", "params": { "format": "png" } }
```

**Response (browser → client):**
```json
{ "id": 1, "result": { "data": "iVBORw0K..." } }
```

**Event (browser → client, no id):**
```json
{ "method": "Network.requestWillBeSent", "params": { "requestId": "1", ... } }
```

### Session Multiplexing (Flattened Protocol)

Since Chrome 77+, CDP supports **flattened sessions**. A single WebSocket
connection multiplexes commands to multiple targets using `sessionId`:

```json
{ "id": 2, "sessionId": "AB12CD34", "method": "DOM.getDocument" }
```

The browser routes the command to the correct target and returns:

```json
{ "id": 2, "sessionId": "AB12CD34", "result": { "root": { ... } } }
```

Events also include `sessionId`:

```json
{ "sessionId": "AB12CD34", "method": "DOM.documentUpdated" }
```

### How `newCDPSession(page)` Works Internally

When Playwright calls `context.newCDPSession(page)`:

1. Playwright sends `Target.attachToTarget { targetId, flatten: true }`
2. Browser returns `{ result: { sessionId: "AB12CD34" } }`
3. Playwright creates a `CDPSession` object bound to `sessionId`
4. All subsequent `session.send(method, params)` messages include the `sessionId`
5. Events with matching `sessionId` are dispatched to the session's listeners

**Key insight:** If the relay correctly handles `Target.attachToTarget` (with
`flatten: true`) and routes `sessionId`-tagged messages to/from the correct
extension debugger session, then `newCDPSession(page)` will work natively.

---

## Existing Reference Implementations

### Comparison Table

| Repo | Stars | Approach | Session Proxy? | Extension? | newCDPSession Works? |
|------|-------|----------|---------------|------------|---------------------|
| **remorses/playwriter** (upstream) | ~2K | Extension relay + cdp-relay.ts | Partial (returns existing sessionId) | Yes | **No** — same limitation |
| **microsoft/playwright-mcp** | ~34K | Extension relay + relayConnection.ts | Same as above | Yes | **No** — same limitation |
| **puppeteer ExtensionTransport** | N/A (built-in) | `chrome.debugger` transport | Open bug #13251 | Yes | **No** — P3 open issue |
| **henu-wang/chrome-mcp-proxy** | ~0 | Native CDP WebSocket proxy | Yes (ID remapping + event routing) | No (needs `--remote-debugging-port`) | **Yes** |
| **browserbase/stagehand** | ~22K | `CdpConnection` session multiplexer | Yes (inflight tracking + sessionToTarget map) | No (launches browser) | **Yes** |
| **zackiles/cdp-proxy-interceptor** | ~21 | MITM CDP proxy (Deno) | Yes (transparent forwarding) | No (needs `--remote-debugging-port`) | **Yes** |
| **bbhide/puppeteer-chrome-debugger-transport** | ~10 | `chrome.debugger` as Puppeteer transport | No | Yes | **No** |
| **microsoft/vscode-cdp-proxy** | ~15 | CDP protocol translator | N/A (custom targets) | No | N/A |

**Key insight:** No existing project has solved `newCDPSession()` through a
Chrome extension relay. Every extension-based approach (playwriter, playwright-mcp,
Puppeteer ExtensionTransport, puppeteer-chrome-debugger-transport) shares the
same fundamental limitation. Projects that do support full CDP sessions
(chrome-mcp-proxy, stagehand, cdp-proxy-interceptor) all require Chrome to be
launched with `--remote-debugging-port` — they connect to the native CDP
endpoint, not through an extension.

### 1. remorses/playwriter (Upstream — `cdp-relay.ts`, 2060 LOC)

spawriter's direct upstream. The relay handles `Target.attachToTarget` at the
server level by looking up existing connected targets and returning their
`sessionId` — exactly the same approach spawriter uses:

```typescript
case 'Target.attachToTarget': {
  const attachParams = params as Protocol.Target.AttachToTargetRequest
  for (const target of connectedTargets.values()) {
    if (target.targetId === attachParams.targetId) {
      return { sessionId: target.sessionId }
    }
  }
  throw new Error(`Target ${attachParams.targetId} not found`)
}
```

**Does NOT handle** `Target.attachToBrowserTarget`. All CDP commands are
forwarded through the extension via `forwardCDPCommand`. Uses the
`devtools-protocol` npm package for TypeScript types (`Protocol.*`).

Also handles OOPIF (out-of-process iframe) targets via `Target.setAutoAttach`
with `flatten: true` forwarding to the extension, and routes
`Target.attachedToTarget` events with correct parent sessionId via frame ID
tracking.

### 2. microsoft/playwright-mcp Extension Relay

**Source:** `extension/src/relayConnection.ts` (179 LOC)

Similar extension relay, simpler than playwriter. Custom protocol:
`attachToTab` → `forwardCDPCommand` / `forwardCDPEvent`.

**Flat session support (Chrome 125+):** The extension handles `sessionId`
in `chrome.debugger.sendCommand()`:

```javascript
const debuggerSession = { tabId, sessionId: params.sessionId };
chrome.debugger.sendCommand(debuggerSession, method, params);
```

### 3. Puppeteer ExtensionTransport (Official, Experimental)

Puppeteer's built-in transport for running inside Chrome extensions. Has an
**open P3 bug** (#13251) for `page.createCDPSession()` failing with "Not
allowed". Recent fix (commit 47c92d6) improved `sessionId` assignment in
`Target.attachedToTarget` responses but the core limitation remains.

### 4. henu-wang/chrome-mcp-proxy

Full CDP proxy for AI agents. **Requires `--remote-debugging-port`** — connects
to Chrome's native CDP WebSocket endpoint. Key innovations:
- Request ID remapping (per-client offset ranges)
- Event routing by sessionId
- Auto-reconnect on Chrome restart
- Focus-stealing prevention

### 5. browserbase/stagehand `CdpConnection`

High-quality CDP session multiplexer (22K stars). Manages WebSocket ownership,
tracks inflight calls, routes responses to correct sessions, handles
session-to-target 1:1 mapping. Good reference for session lifecycle management
but operates on native CDP (launches browser).

### 6. zackiles/cdp-proxy-interceptor

Transparent MITM proxy for CDP with plugin system. Intercepts and modifies
CDP messages in-flight. Demonstrates how to build a transparent proxy layer.
Requires Deno runtime.

---

## Architecture Options

### Option A: Full Transparent CDP WebSocket Proxy

```
┌──────────┐       ┌──────────────────────────────────┐       ┌──────────────────┐
│ Playwright│◄─────►│ Relay CDP WebSocket Proxy         │◄─────►│ Chrome Extension  │
│           │  CDP  │                                    │  WS   │                  │
│ connect   │  WS   │ - Intercepts Target.attach*        │       │ chrome.debugger   │
│ OverCDP() │       │ - Maps sessions to debugger tabs   │       │ .sendCommand()   │
│           │       │ - Remaps request IDs                │       │ .onEvent         │
│ newCDP    │       │ - Routes events by sessionId        │       │ .attach()        │
│ Session() │       │ - Translates Browser→Tab scope      │       │                  │
│ ✓ WORKS   │       │                                    │       │                  │
└──────────┘       └──────────────────────────────────┘       └──────────────────┘
```

**Pros:** Full CDP compatibility. `newCDPSession()` works. All Playwright APIs
work natively. Zero fallbacks needed.

**Cons:** Highest complexity. Must handle all edge cases in the CDP protocol.
Session lifetime management is complex. Must handle `Target.attachToBrowserTarget`
translation.

**Estimated effort:** ~800-1200 LOC, 2-3 days

### Option B: Session-Aware Command Forwarding

Keep the current relay architecture but add proper session tracking so that
`Target.attachToTarget` returns a valid `sessionId` that maps to the extension's
debugger session.

```
Playwright: Target.attachToTarget { targetId: "X", flatten: true }
    ↓
Relay: Maps targetId → tabId, creates sessionId mapping
    ↓
Relay: Returns { sessionId: "mapped-session-123" }
    ↓
Playwright: session.send("Page.navigate", { url }) with sessionId
    ↓
Relay: Looks up sessionId → tabId, forwards via extension chrome.debugger
```

**Pros:** Less invasive than Option A. Reuses existing extension communication.
Still enables `newCDPSession()`.

**Cons:** Must handle `Target.attachToTarget` / `Target.detachFromTarget` lifecycle.
Event routing by sessionId adds complexity. Still need to handle binary data.

**Estimated effort:** ~500-800 LOC, 1-2 days

### Option C: Dual-Mode Connection

Launch Chrome with `--remote-debugging-pipe` or use Chrome's
`DevToolsActivePort` file to get the native CDP WebSocket URL. Use the extension
only for tab selection/UI; use the native CDP endpoint for actual automation.

```
┌──────────┐       ┌──────────────────┐
│ Playwright│◄─────►│ Chrome Browser    │  (native CDP, full protocol)
│           │  CDP  │ :9222/devtools    │
│ connect   │  WS   │                  │
│ OverCDP() │       └──────────────────┘
│ newCDP    │
│ Session() │       ┌──────────────────┐       ┌──────────────────┐
│ ✓ WORKS   │       │ Relay (tab mgmt) │◄─────►│ Chrome Extension  │
└──────────┘       │ /connect-tab     │  WS   │ (tab UI only)     │
                    └──────────────────┘       └──────────────────┘
```

**Pros:** Full native CDP. Zero proxy complexity. Proven approach (Playwright's
standard mode).

**Cons:** Requires Chrome launched with `--remote-debugging-port` or
`--remote-debugging-pipe`. Not possible if the user's Chrome is already running
without these flags. The extension's value proposition (attach to existing
browser) is lost.

**Estimated effort:** ~200 LOC, 0.5 days (but only works if Chrome is launched
by the relay)

### Option D: Hybrid — Extension for Discovery, Native CDP for Sessions

Use the extension to discover and select tabs, then use
`chrome.debugger.getTargets()` to find the target's `devtoolsFrontendUrl` or
internal WebSocket URL. Connect Playwright directly to the target's CDP endpoint.

**Pros:** Combines extension convenience with native CDP power.

**Cons:** Chrome does not expose per-target WebSocket URLs through the extension
API. `chrome.debugger.getTargets()` doesn't return WebSocket URLs. Only
`/json/list` on the debugging port has those URLs — which requires
`--remote-debugging-port`.

**Verdict:** Not feasible without Chrome startup flags.

---

## Recommended Architecture

### Option B: Session-Aware Command Forwarding

Option B is the recommended approach. It builds on the existing relay
architecture, adds the minimum necessary session management to make
`newCDPSession()` work, and doesn't require Chrome to be launched with special
flags.

### Why Not Option A?

Option A (full transparent proxy) attempts to make the relay indistinguishable
from a real Chrome CDP endpoint. While theoretically superior, it requires
handling every nuance of the CDP protocol — hundreds of domain methods, binary
frame handling, and complex session lifecycle management. The ROI is low because
spawriter only needs a subset of CDP domains.

### Why Not Option C?

Option C requires Chrome to be launched with `--remote-debugging-port`, which
defeats spawriter's core value proposition: attaching to the user's existing
browser session. Users shouldn't need to restart Chrome with special flags.

### Detailed Design: Session-Aware Command Forwarding

#### Core Mechanism

The relay already handles `Target.attachToTarget` by returning an existing
session (see `relay.ts` line 619). The gap is that Playwright's
`Target.attachToTarget` with `flatten: true` expects the returned `sessionId`
to be usable for subsequent commands — and events with that `sessionId` must
flow back.

**What needs to change:**

1. **Track flattened sessions**: When `Target.attachToTarget { flatten: true }`
   arrives, create a session mapping: `sessionId → tabId + extensionSessionId`

2. **Route sessionId-tagged commands**: When a command arrives with `sessionId`,
   look up the mapping and forward to the correct extension debugger session

3. **Route sessionId-tagged events**: When the extension forwards a CDP event
   with a `sessionId`, route it to the correct Playwright client

4. **Handle Target.detachFromTarget**: Clean up session mappings

#### Session Mapping Table

```typescript
interface FlattenedSession {
  sessionId: string;              // Returned to Playwright
  tabId: number;                  // Chrome tab ID for chrome.debugger
  extensionSessionId?: string;    // Extension's child session ID (for OOPIFs)
  clientId: string;               // Which CDP client owns this session
  createdAt: number;
}

const flattenedSessions = new Map<string, FlattenedSession>();
```

#### Message Flow: Target.attachToTarget

```
Playwright                    Relay                         Extension
    |                           |                               |
    |-- Target.attachToTarget ->|                               |
    |   { targetId, flatten:1 } |                               |
    |                           |-- lookup targetId → tabId --->|
    |                           |                               |
    |                           |-- create sessionId mapping ---|
    |                           |   sessionId = "relay-sess-1"  |
    |                           |                               |
    |<-- { sessionId } ---------|                               |
    |                           |                               |
    |-- DOM.getDocument ------->|                               |
    |   { sessionId }           |                               |
    |                           |-- forwardCDPCommand --------->|
    |                           |   { tabId, sessionId,         |
    |                           |     method, params }          |
    |                           |                               |
    |                           |<-- forwardCDPEvent -----------|
    |                           |   { sessionId, method,        |
    |                           |     params }                  |
    |                           |                               |
    |<-- { sessionId, result }--|                               |
```

#### Message Flow: CDP Events with Session Routing

```
Extension                     Relay                         Playwright
    |                           |                               |
    |-- forwardCDPEvent ------->|                               |
    |   { sessionId: "ext-1",   |                               |
    |     method: "Network.*",  |                               |
    |     params: {...} }       |                               |
    |                           |-- lookup sessionId ---------->|
    |                           |   ext-1 → clientId, session   |
    |                           |                               |
    |                           |-- send to client ------------>|
    |                           |   { sessionId: "relay-sess-1",|
    |                           |     method, params }          |
```

#### Changes Required in Relay (relay.ts)

```typescript
// NEW: Flattened session tracking
const flattenedSessions = new Map<string, FlattenedSession>();
let nextSessionId = 1;

function generateSessionId(): string {
  return `relay-session-${nextSessionId++}`;
}

// MODIFIED: Target.attachToTarget handler (currently at line 619)
case 'Target.attachToTarget': {
  const targetId = params?.targetId;
  const flatten = params?.flatten;

  if (!targetId) {
    sendCdpError(clientId, { id, sessionId, error: 'targetId required' });
    return true;
  }

  // Find the target and its tabId
  const target = findTargetByTargetId(targetId);
  if (!target) {
    sendCdpError(clientId, { id, sessionId, error: `Target ${targetId} not found` });
    return true;
  }

  if (flatten) {
    // Create a flattened session mapping
    const newSessionId = generateSessionId();
    flattenedSessions.set(newSessionId, {
      sessionId: newSessionId,
      tabId: target.tabId!,
      clientId,
      createdAt: Date.now(),
    });

    // Return the session ID to Playwright
    sendCdpResponse(clientId, {
      id, sessionId,
      result: { sessionId: newSessionId },
    });
  } else {
    // Non-flattened: return existing session
    sendCdpResponse(clientId, {
      id, sessionId,
      result: { sessionId: target.sessionId },
    });
  }
  return true;
}
```

#### Changes Required in Extension (bridge.js)

The extension already supports `sessionId` in `chrome.debugger.sendCommand()`
(Chrome 125+). The key change is ensuring `forwardCDPEvent` includes `sessionId`
from `chrome.debugger.onEvent`:

```javascript
// Already implemented in spawriter's extension:
chrome.debugger.onEvent.addListener((source, method, params) => {
  ws.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      sessionId: source.sessionId || '',  // Include child session ID
      method,
      params,
    },
  }));
});
```

The extension also needs to handle `Target.setAutoAttach` with `flatten: true`
forwarding, so that when Playwright requests auto-attach to child targets
(OOPIFs), the extension can create the appropriate child sessions:

```javascript
// When relay forwards Target.setAutoAttach:
chrome.debugger.sendCommand(
  { tabId },
  'Target.setAutoAttach',
  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
);
```

#### What This Enables

With these changes:

```typescript
// This will work!
const session = await page.context().newCDPSession(page);
await session.send('Network.enable');
session.on('Network.requestWillBeSent', (params) => { ... });

// Which means:
const screenshot = await page.screenshot();  // Works!
await page.goto('https://example.com');       // Works!
await page.reload();                          // Works!
```

---

## Implementation Plan

### Phase 1: Session Mapping (Core)

**Files:** `relay.ts`
**LOC:** ~150 new, ~50 modified
**Time:** 4-6 hours

1. Add `flattenedSessions` map and session ID generator
2. Modify `Target.attachToTarget` handler to support `flatten: true`
3. Add session-aware command routing: when a CDP command arrives with a
   `sessionId` that's in `flattenedSessions`, look up the `tabId` and forward
   to the extension with the correct debugger session
4. Add session-aware event routing: when an event arrives from the extension
   with a `sessionId`, look it up in `flattenedSessions` and route to the
   correct client
5. Handle `Target.detachFromTarget`: clean up `flattenedSessions` entry
6. Add `Target.attachToBrowserTarget` translation: when Playwright sends this
   (its preferred method), translate to `Target.attachToTarget` on the
   relay side

### Phase 2: Event Subscription Management

**Files:** `relay.ts`, extension `bridge.js`
**LOC:** ~100 new
**Time:** 2-4 hours

1. Track which CDP domains are enabled per session (e.g., `Network.enable`,
   `Debugger.enable`)
2. When a session is created, automatically forward domain enable/disable
   commands to the extension
3. Ensure events from enabled domains are routed to the correct session

### Phase 3: Lifecycle Event Propagation

**Files:** `relay.ts`
**LOC:** ~80 new
**Time:** 2-3 hours

1. Forward `Page.lifecycleEvent`, `Page.loadEventFired`, `Page.frameNavigated`
   etc. from the extension to the correct Playwright session
2. This enables `page.goto()`, `page.reload()`, and `page.waitForLoadState()`
   to work natively

### Phase 4: Remove Fallbacks

**Files:** `pw-executor.ts`
**LOC:** ~-500 removed
**Time:** 4-6 hours

1. Remove `relaySendCdp()` infrastructure
2. Remove `relayCdp()` helper
3. Remove all Tier 2 and Tier 3 fallback code paths
4. Simplify VM globals to use `cdpSession.send()` directly
5. Remove `page.evaluate()` workarounds for navigate/reload/screenshot
6. Update tests

### Phase 5: Validation

**Time:** 2-3 hours

1. Re-run full CLI E2E suite (41 tests)
2. Re-run full MCP E2E suite (32 tests)
3. Re-run unit test suite (1421 tests)
4. Verify `page.goto()`, `page.screenshot()`, `page.reload()` work natively
5. Verify `newCDPSession()` returns a valid session
6. Verify CDP event subscriptions work

**Total estimated effort:** 14-22 hours (2-3 days)

---

## Risk Analysis

### HIGH Risk: No Existing Solution — This Is Unsolved

**Risk:** After comprehensive research, **no existing project has made
`newCDPSession()` work through a Chrome extension relay**. Every extension-based
approach (playwriter, playwright-mcp, Puppeteer ExtensionTransport) shares the
same `Target.attachToBrowserTarget: Not allowed` failure. Projects that solve it
(chrome-mcp-proxy, stagehand) all use `--remote-debugging-port` which bypasses
the extension entirely.

**Implication:** spawriter would be implementing a novel approach. There is no
proven reference implementation to follow. The risk of unforeseen issues is
higher than initially estimated.

**Mitigation:** Start with a minimal proof-of-concept (Phase 1 only) before
committing to the full refactor. Validate that the approach works with
`page.goto()`, `page.screenshot()`, and `cdpSession.send()` before removing
any fallback code.

### High Risk: `Target.attachToBrowserTarget` Translation

**Risk:** Playwright internally uses `Target.attachToBrowserTarget` (not
`Target.attachToTarget`) when called from a browser-level connection. The relay
must translate this to something the extension can handle.

**Mitigation:** Intercept `Target.attachToBrowserTarget` at the relay level,
look up the target, and use the extension's `chrome.debugger` session directly.
Return a synthetic sessionId. This is what the current relay already does for
`Target.attachToTarget` (line 619). The upstream playwriter relay also does NOT
handle this command — it only handles `Target.attachToTarget`.

**Research finding:** The openclaw/openclaw project (#43287, #30426) documented
this exact issue and solved it with relay-level interception and
`withPageScopedCdpClient()`.

### Medium Risk: Lifecycle Event Propagation

**Risk:** Some Playwright operations wait for specific lifecycle events
(`domcontentloaded`, `load`, `networkidle`). If the extension doesn't forward
`Page.lifecycleEvent` reliably, Playwright's wait operations will timeout.

**Mitigation:** The extension's `chrome.debugger.onEvent` already receives all
CDP events including lifecycle events. The relay just needs to forward them
correctly. Test thoroughly with `page.goto()` and `page.waitForLoadState()`.

### Medium Risk: Binary Data

**Risk:** CDP commands like `Page.captureScreenshot` return base64-encoded data
in the JSON response. This works through the WebSocket relay. However, some
commands may return large payloads that could cause WebSocket frame issues.

**Mitigation:** WebSocket has no inherent size limit. The `ws` library handles
fragmentation automatically. Test with large screenshots (4K+ resolution).

### Low Risk: Multi-Client Session Isolation

**Risk:** If multiple CDP clients connect to the relay simultaneously, session
IDs from one client could conflict with another.

**Mitigation:** The `flattenedSessions` map tracks `clientId` per session. Event
routing already checks client ownership. Request ID remapping (if needed) can
use per-client offset ranges.

### Low Risk: Extension chrome.debugger Session Support

**Risk:** Chrome's `chrome.debugger` API may not support all session-related
operations in extensions.

**Mitigation:** Since Chrome 125, `chrome.debugger` supports flat sessions with
`sessionId` parameter. `chrome.debugger.sendCommand()` accepts
`{ tabId, sessionId }` as the debuggee. `chrome.debugger.onEvent` includes
`source.sessionId` in event callbacks.

---

## Appendix: Wire Protocol Reference

### Current spawriter Relay Protocol

**Extension → Relay (events):**
```json
{
  "method": "forwardCDPEvent",
  "params": {
    "sessionId": "optional-child-session-id",
    "method": "Network.requestWillBeSent",
    "params": { ... }
  }
}
```

**Relay → Extension (commands):**
```json
{
  "id": 42,
  "method": "forwardCDPCommand",
  "params": {
    "sessionId": "optional-child-session-id",
    "method": "Page.captureScreenshot",
    "params": { "format": "png" }
  }
}
```

**Extension → Relay (command responses):**
```json
{
  "id": 42,
  "result": { "data": "iVBORw0K..." }
}
```

### Proposed Changes to Protocol

No protocol changes needed. The existing `forwardCDPCommand` and
`forwardCDPEvent` messages already carry `sessionId`. The relay just needs to:

1. **Generate and track** `sessionId` values for `Target.attachToTarget` responses
2. **Include `sessionId`** when forwarding commands to the extension
3. **Route events** by `sessionId` back to the correct client

### CDP Commands That Must Be Intercepted at Relay Level

These commands must be handled by the relay itself (not forwarded to extension)
because they operate at the browser scope:

| Command | Relay Handling | Already Implemented |
|---------|---------------|---------------------|
| `Browser.getVersion` | Return relay version | Yes (line 536) |
| `Browser.setDownloadBehavior` | Track + fan-out to pages | Yes (line 551) |
| `Target.setAutoAttach` | Send attached events | Yes (line 569) |
| `Target.setDiscoverTargets` | Send target created events | Yes (line 577) |
| `Target.getTargets` | Return attached targets | Yes (line 585) |
| `Target.getTargetInfo` | Return target info | Yes (line 595) |
| `Target.attachToTarget` | Create session mapping | Partial (line 619) |
| `Target.attachToBrowserTarget` | Translate to attachToTarget | **NEW** |
| `Target.detachFromTarget` | Clean up session | **NEW** |
| `Target.acquireLease` | Tab lease management | Yes (line 648) |
| `Target.releaseLease` | Tab lease management | Yes (line 702) |
| `Target.listLeases` | Tab lease management | Yes (line 739) |

### CDP Domains Used by spawriter VM Globals

| Domain | VM Globals | Events Needed |
|--------|-----------|---------------|
| `Page` | screenshot, navigate, reload, clearCache | `lifecycleEvent`, `loadEventFired`, `frameNavigated`, `downloadWillBegin`, `downloadProgress` |
| `Network` | networkLog, storage (cookies) | `requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed` |
| `Fetch` | networkIntercept | `requestPaused` |
| `Accessibility` | snapshot, screenshotWithLabels | (none) |
| `DOM` | interact, screenshotWithLabels | (none) |
| `Input` | interact | (none) |
| `Runtime` | evaluateJs, cssInspect | `consoleAPICalled`, `exceptionThrown` |
| `Debugger` | dbg, editor | `scriptParsed`, `paused`, `resumed` |
| `Emulation` | emulation | (none) |
| `Performance` | performance | (none) |
| `Storage` | storage (usage) | (none) |

---

## Summary

The CDP WebSocket proxy is a significant architectural improvement that would
eliminate spawriter's three-tier fallback system. The recommended approach
(Option B: Session-Aware Command Forwarding) builds on the existing relay
infrastructure, requires ~400-500 new LOC in the relay, and enables full
Playwright API compatibility through the extension relay.

**Critical research finding:** No existing project has solved `newCDPSession()`
through a Chrome extension relay. The upstream playwriter, playwright-mcp, and
Puppeteer ExtensionTransport all share the same limitation. This would be a
novel implementation — proceed with a proof-of-concept before committing.

**Key enabler:** Chrome 125+ `chrome.debugger` flat session support means the
extension already handles `sessionId`-tagged commands and events. The relay just
needs to manage session lifecycle and routing.

**Available resources:**
- `D:\dev\0-ref\devtools-protocol` — Official CDP protocol definitions (PDL +
  JSON + TypeScript types). Install `devtools-protocol` npm package for
  type-safe relay code.
- `D:\dev\0-ref\playwriter/playwriter/src/cdp-relay.ts` — Upstream relay (2060
  LOC). Same extension-based architecture. Good reference for CDP command
  interception patterns but does NOT solve the session proxy problem.
- `browserbase/stagehand` `CdpConnection` — Best reference for session
  multiplexing logic (inflight tracking, event routing, session-to-target
  mapping). But operates on native CDP, not extension relay.

**When to implement:** After the current architecture stabilizes. The three-tier
fallback works today (zero failures). This refactor is an optimization, not a
fix. Prioritize when:
- Adding new CDP-dependent features becomes painful
- Lifecycle event propagation is needed (e.g., for `page.waitForNavigation()`)
- Binary data transfer is needed (e.g., for native `page.screenshot()`)
- A proof-of-concept validates the `Target.attachToBrowserTarget` translation
  approach works end-to-end
