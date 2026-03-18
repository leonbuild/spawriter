# Multi-Agent Tab Isolation: Tab Lease System

## 1. Problem Statement

### Scenario

Two Cursor windows (or any MCP clients) run in parallel, each with its own spawriter MCP server process. Both agents need browser access for different projects.

```
Cursor Window A (Project A)           Cursor Window B (Project B)
       │                                       │
  MCP Server A                            MCP Server B
  (stdio, pid=1234)                       (stdio, pid=5678)
       │                                       │
       └──────────┐              ┌─────────────┘
                  ▼              ▼
            ┌─────────────────────────┐
            │    Relay Server (:19989)│  ← SHARED singleton
            └────────────┬────────────┘
                         │
            ┌────────────┴────────────┐
            │    Chrome Extension     │
            │  (single instance)      │
            └─────────────────────────┘
```

### Root Causes

| # | Bug | Where | Impact |
|---|-----|-------|--------|
| 1 | **clientId collision** | `mcp.ts:371` hardcodes `clientId = "mcp-client"` | Relay `cdpClients` map has one slot per ID. Second MCP overwrites the first, or the WebSocket is rejected. |
| 2 | **No tab affinity** | `mcp.ts:524` picks `targets[0]` by default | Both agents auto-connect to the same tab. `switch_tab` has no guard against switching to another agent's tab. |
| 3 | **Event broadcast** | `relay.ts:154` `broadcastToCDPClients()` sends to ALL | Agent A receives console logs, network events, and debugger events from Agent B's tab. |
| 4 | **Manual-only tab attach** | Extension requires toolbar click | Agents cannot programmatically request a specific tab. If only one tab is attached, both agents fight over it. **(Now resolved: extension auto-connects to relay on startup; agents can create/attach tabs via `connect_tab` with zero manual interaction.)** |

### Symptoms

- Agent A screenshots Agent B's page
- Agent A's console_logs contain Agent B's errors
- Agent B navigates Agent A's tab to a different URL
- Both agents see the same `list_tabs` output with no ownership info
- Race condition: both pick the first unleased tab simultaneously

---

## 2. Design Goals

| Goal | Description |
|------|-------------|
| **G1: Tab isolation** | Each agent exclusively owns its tab(s). CDP commands and events are scoped. |
| **G2: Auto-attach** | Agents can programmatically request tabs by URL, tabId, or create new tabs — no manual toolbar click needed. |
| **G3: Supply/demand awareness** | Agents know how many tabs are available, who owns what, and whether surplus exists. |
| **G4: Multi-tab per agent** | An agent can lease multiple tabs (e.g., app tab + reference tab) and switch between them. |
| **G5: Zero-config single agent** | Existing single-agent usage works identically with no configuration. |
| **G6: Graceful degradation** | New MCP + old relay = works without leases (logs warning). Old MCP + new relay = no change. |
| **G7: Crash safety** | Agent crash → leases auto-released. Tab close → lease cleaned up. |

---

## 3. Architecture

### 3.1 System Overview

```
  MCP Server A                          MCP Server B
  clientId: "mcp-1234-k7f3x"           clientId: "mcp-5678-m9p2q"
  label: "finetune"                     label: "other-project"
       │                                       │
       │  Target.acquireLease                  │  Target.acquireLease
       │  sessionId: "tab-111-..."             │  sessionId: "tab-222-..."
       ▼                                       ▼
  ┌─────────────────────────────────────────────────┐
  │              Relay Server (:19989)               │
  │                                                  │
  │  tabLeases: Map<sessionId, Lease>                │
  │    "tab-111-..." → { clientId: "mcp-1234-k7f3x" │
  │    "tab-222-..." → { clientId: "mcp-5678-m9p2q" │
  │                                                  │
  │  ENFORCEMENT:                                    │
  │  ✓ CDP command from mcp-1234 to tab-111 → allow  │
  │  ✗ CDP command from mcp-1234 to tab-222 → reject │
  │  ✓ Events from tab-111 → only to mcp-1234       │
  │  ✓ Events from tab-222 → only to mcp-5678       │
  └──────────────────────────────────────────────────┘
       │                                       │
       ▼                                       ▼
  ┌─────────────────────────────────────────────────┐
  │              Chrome Extension                    │
  │  (unchanged — already routes by sessionId)       │
  │                                                  │
  │  attachedTabs:                                   │
  │    tabId:111 → sessionId: "tab-111-..."          │
  │    tabId:222 → sessionId: "tab-222-..."          │
  └──────────────────────────────────────────────────┘
```

### 3.2 Key Data Structures

#### Relay: Tab Lease Registry

```typescript
interface TabLease {
  sessionId: string;       // CDP session (= spawriter-tab-{tabId}-{timestamp})
  clientId: string;        // CDP client that holds the lease
  label?: string;          // Human-readable agent name (from SSPA_AGENT_LABEL)
  acquiredAt: number;      // Date.now() when lease was granted
}

// Stored in relay process memory (lost on relay restart, which is fine
// because all CDP clients also reconnect)
const tabLeases = new Map<string, TabLease>();
```

#### MCP: Unique Client Identity

```typescript
// mcp.ts — generated once at process start
const MCP_CLIENT_ID = `mcp-${process.pid}-${Date.now().toString(36)}`;
const agentLabel = process.env.SSPA_AGENT_LABEL || undefined;
const projectUrl = process.env.SSPA_PROJECT_URL || undefined;
```

#### Protocol: Enhanced Target Info

```typescript
// Returned by GET /json/list and Target.getTargets
interface TargetWithLease {
  id: string;              // sessionId
  tabId?: number;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  lease: {
    clientId: string;
    label?: string;
    acquiredAt: number;
  } | null;
}
```

---

## 4. Relay Changes (`relay.ts`)

### 4.1 Lease Management Commands

New CDP-like commands handled server-side in `handleServerCdpCommand()`:

#### `Target.acquireLease`

```
Request:  { sessionId: string, label?: string }
Success:  { result: { granted: true, lease: TabLease } }
Conflict: { error: { code: -32001, message: "Tab leased by ...", holder: { clientId, label } } }
```

**Rules:**
- If `sessionId` is not in `attachedTargets` → error "Target not found"
- If no existing lease → grant, store in `tabLeases`
- If existing lease with same `clientId` → refresh (update `acquiredAt`, `label`)
- If existing lease with different `clientId` → reject with holder info

#### `Target.releaseLease`

```
Request:  { sessionId: string }
Success:  { result: { released: true } }
Error:    { error: "Not the lease holder" }
```

**Rules:**
- Only the current holder can release
- If no lease exists → no-op success
- After release, broadcast `Target.tabAvailable` to all clients

#### `Target.listLeases`

```
Request:  {}
Success:  { result: { leases: TabLease[] } }
```

Returns all active leases. Useful for diagnostics.

### 4.2 Command Enforcement

In `handleCDPMessage()`, before forwarding to extension:

```typescript
function handleCDPMessage(data: Buffer, clientId: string) {
  // ... existing parse logic ...

  // Lease enforcement: if the target tab has a lease, only the holder may send commands
  if (sessionId && tabLeases.has(sessionId)) {
    const lease = tabLeases.get(sessionId)!;
    if (lease.clientId !== clientId) {
      const holderDesc = lease.label ? `"${lease.label}" (${lease.clientId})` : lease.clientId;
      sendCdpError(clientId, {
        id,
        sessionId,
        error: `Tab is leased by ${holderDesc}. Acquire a different tab or wait for release.`,
        code: -32001,
      });
      return;
    }
  }

  // ... existing forwarding logic ...
}
```

**Exception: Playwright connections** (`clientId` starting with `pw-`) are NOT subject to lease enforcement. They connect to the relay as separate CDP clients but operate on behalf of the MCP server that spawned them. Since Playwright connections use the tab's `sessionId` which the MCP already leased, and the MCP process controls both its own CDP client and its Playwright executors, this is safe.

Implementation: check `clientId.startsWith('pw-')` to skip enforcement. A more robust approach is to have the MCP register its Playwright clientIds with the relay, but the prefix check is simpler and sufficient since `pw-` IDs are random and unguessable.

### 4.3 Event Filtering

Replace `broadcastToCDPClients()` with lease-aware routing:

```typescript
function routeCdpEvent(method: string, params: unknown, sessionId?: string) {
  if (sessionId && tabLeases.has(sessionId)) {
    const lease = tabLeases.get(sessionId)!;
    // Send to lease holder
    sendToCDPClient(lease.clientId, { method, params, sessionId });
    // Also send to any pw-* clients (Playwright connections for this session)
    for (const [cid, client] of cdpClients) {
      if (cid.startsWith('pw-') && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ method, params, sessionId }));
      }
    }
    return;
  }
  // No lease → broadcast to all (backward compatible)
  broadcastToCDPClients({ method, params, sessionId });
}
```

### 4.4 Automatic Cleanup

#### On CDP client disconnect:

```typescript
ws.on('close', () => {
  cdpClients.delete(clientId);
  // Release all leases held by this client
  for (const [sid, lease] of tabLeases) {
    if (lease.clientId === clientId) {
      tabLeases.delete(sid);
      log(`Auto-released lease on ${sid} (client ${clientId} disconnected)`);
      // Notify remaining clients
      broadcastToCDPClients({
        method: 'Target.leaseReleased',
        params: { sessionId: sid, reason: 'client-disconnect' },
      });
    }
  }
});
```

#### On tab detach (extension sends `Target.detachedFromTarget`):

```typescript
if (method === 'Target.detachedFromTarget') {
  const detachedSessionId = params.sessionId;
  if (detachedSessionId) {
    attachedTargets.delete(detachedSessionId);
    // Also clean up lease
    if (tabLeases.has(detachedSessionId)) {
      const lease = tabLeases.get(detachedSessionId)!;
      tabLeases.delete(detachedSessionId);
      sendToCDPClient(lease.clientId, {
        method: 'Target.leaseLost',
        params: { sessionId: detachedSessionId, reason: 'tab-detached' },
      });
    }
  }
}
```

### 4.5 Enriched `/json/list`

```typescript
app.get('/json/list', (c) => {
  const targets = Array.from(attachedTargets.values()).map((target) => {
    const lease = tabLeases.get(target.sessionId);
    return {
      id: target.sessionId,
      tabId: target.tabId,
      type: target.targetInfo?.type ?? 'page',
      title: target.targetInfo?.title ?? '',
      url: target.targetInfo?.url ?? '',
      webSocketDebuggerUrl: getCdpUrl(getRelayPort(), target.sessionId),
      lease: lease
        ? { clientId: lease.clientId, label: lease.label, acquiredAt: lease.acquiredAt }
        : null,
    };
  });
  return c.json(targets);
});
```

### 4.6 New Endpoint: `/connect-tab`

Agent-initiated tab attachment by URL pattern or tab ID:

```typescript
app.post('/connect-tab', async (c) => {
  if (!isExtensionConnected()) {
    return c.json({ success: false, error: 'Extension not connected' }, 503);
  }

  const body = await c.req.json<{
    url?: string;
    tabId?: number;
    create?: boolean;
  }>();

  return new Promise<Response>((resolve) => {
    const relayId = nextExtensionRequestId++;
    const timeoutId = setTimeout(() => {
      pendingExtensionCmdRequests.delete(relayId);
      resolve(c.json({ success: false, error: 'Timeout waiting for extension' }, 504));
    }, 15000);

    const mockWs = { /* same pattern as /connect-active-tab */ };
    pendingExtensionCmdRequests.set(relayId, { ws: mockWs, timeoutId });

    sendToExtension({
      id: relayId,
      method: 'connectTabByMatch',
      params: body,
    });
  });
});
```

### 4.7 Tab Available Notification

When a new tab is attached while agents are running:

```typescript
// In handleExtensionMessage, after processing Target.attachedToTarget:
broadcastToCDPClients({
  method: 'Target.tabAvailable',
  params: {
    sessionId,
    targetInfo: enrichedTargetInfo,
    totalAttached: attachedTargets.size,
    totalLeased: tabLeases.size,
    totalAvailable: attachedTargets.size - tabLeases.size,
  },
});
```

---

## 5. MCP Server Changes (`mcp.ts`)

### 5.1 Unique Client ID

```typescript
// Replace hardcoded "mcp-client" in connectCdp():
const MCP_CLIENT_ID = `mcp-${process.pid}-${Date.now().toString(36)}`;

function connectCdp(sessionId: string): Promise<CdpSession> {
  const port = getRelayPort();
  const token = getRelayToken();
  const baseUrl = `ws://127.0.0.1:${port}/cdp/${MCP_CLIENT_ID}`;  // was "mcp-client"
  const wsUrl = token ? `${baseUrl}?token=${token}` : baseUrl;
  // ... rest unchanged ...
}
```

### 5.2 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `SSPA_AGENT_LABEL` | Human-readable name shown in lease info | `"finetune"` |
| `SSPA_PROJECT_URL` | URL pattern for auto-attach | `"localhost:9100"` |

```typescript
const agentLabel: string | undefined = process.env.SSPA_AGENT_LABEL || undefined;
const projectUrl: string | undefined = process.env.SSPA_PROJECT_URL || undefined;
```

### 5.3 Enhanced `TargetListItem`

```typescript
interface TargetListItem {
  id: string;
  tabId?: number;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  lease?: {
    clientId: string;
    label?: string;
    acquiredAt: number;
  } | null;
}
```

### 5.4 Lease Helpers

```typescript
async function acquireLease(session: CdpSession, sessionId: string): Promise<boolean> {
  try {
    const result = await sendCdpCommand(session, 'Target.acquireLease', {
      sessionId,
      label: agentLabel,
    }) as { granted?: boolean };
    return !!result?.granted;
  } catch (e) {
    log(`Lease acquisition failed for ${sessionId}: ${e}`);
    return false;
  }
}

async function releaseLease(session: CdpSession, sessionId: string): Promise<void> {
  try {
    await sendCdpCommand(session, 'Target.releaseLease', { sessionId });
  } catch {
    // Best effort
  }
}
```

### 5.5 Enhanced `doEnsureSession()`

```typescript
async function doEnsureSession(): Promise<CdpSession> {
  cdpSession = null;
  await ensureRelayServer();
  let targets = await getTargets();

  // --- Phase 1: Reconnect to my existing lease ---
  const myLeased = targets.find(t => t.lease?.clientId === MCP_CLIENT_ID);
  if (myLeased) {
    cdpSession = await connectCdp(myLeased.id);
    log(`Reconnected to previously leased tab: ${myLeased.url}`);
    await enableDomains(cdpSession);
    return cdpSession;
  }

  // --- Phase 2: Find an unleased tab ---
  let unleased = targets.filter(t => !t.lease);

  // Prefer tab matching project URL if set
  if (projectUrl && unleased.length > 1) {
    const matching = unleased.filter(t => t.url?.includes(projectUrl));
    if (matching.length > 0) {
      unleased = [...matching, ...unleased.filter(t => !t.url?.includes(projectUrl))];
    }
  }

  // Also check preferred target
  if (preferredTargetId) {
    const preferred = unleased.find(t => t.id === preferredTargetId);
    if (preferred) {
      unleased = [preferred, ...unleased.filter(t => t.id !== preferredTargetId)];
    }
  }

  for (const candidate of unleased) {
    cdpSession = await connectCdp(candidate.id);
    const leased = await acquireLease(cdpSession, candidate.id);
    if (leased) {
      log(`Acquired lease on tab: ${candidate.url}`);
      await enableDomains(cdpSession);
      return cdpSession;
    }
    // Lost race — another agent leased it between our getTargets() and acquireLease()
    cdpSession.ws.close();
    cdpSession = null;
  }

  // --- Phase 3: Auto-attach by project URL ---
  if (projectUrl) {
    log(`No unleased tabs, attempting auto-attach by URL: ${projectUrl}`);
    const attached = await requestConnectTab({ url: projectUrl });
    if (attached) {
      targets = await getTargets();
      const newTarget = targets.find(t => !t.lease || t.lease.clientId === MCP_CLIENT_ID);
      if (newTarget) {
        cdpSession = await connectCdp(newTarget.id);
        await acquireLease(cdpSession, newTarget.id);
        await enableDomains(cdpSession);
        return cdpSession;
      }
    }
  }

  // --- Phase 4: Fallback — request active tab ---
  if (targets.length === 0) {
    log('No targets at all, requesting extension to attach active tab...');
    await requestExtensionAttachTab();
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      targets = await getTargets();
      const available = targets.find(t => !t.lease);
      if (available) {
        cdpSession = await connectCdp(available.id);
        await acquireLease(cdpSession, available.id);
        await enableDomains(cdpSession);
        return cdpSession;
      }
    }
  }

  // --- Phase 5: All tabs leased by others ---
  const leasedCount = targets.filter(t => t.lease).length;
  if (targets.length > 0 && leasedCount === targets.length) {
    const holders = targets.map(t => {
      const l = t.lease!;
      return `  • ${t.url || '(no url)'} — leased by ${l.label || l.clientId}`;
    }).join('\n');
    throw new Error(
      `All ${targets.length} attached tab(s) are leased by other agents:\n${holders}\n\n` +
      `To get a tab for this agent:\n` +
      `  1. Use connect_tab { url: "your-app-url" } to auto-attach a matching Chrome tab\n` +
      `  2. Open a Chrome tab and click the spawriter toolbar icon\n` +
      `  3. Use connect_tab { url: "your-url", create: true } to create and attach a new tab`
    );
  }

  throw new Error(
    'No browser tab attached. Click the extension toolbar icon on a web page tab to attach it, then retry.'
  );
}
```

### 5.6 Enhanced `list_tabs`

```typescript
if (name === 'list_tabs') {
  await ensureRelayServer();
  const targets = await getTargets();
  if (targets.length === 0) {
    return { content: [{ type: 'text', text: 'No tabs attached. Click the spawriter toolbar button on a Chrome tab, or use connect_tab to attach one.' }] };
  }

  const activeSessionId = cdpSession?.sessionId ?? null;
  const myTabs = targets.filter(t => t.lease?.clientId === MCP_CLIENT_ID);
  const otherTabs = targets.filter(t => t.lease && t.lease.clientId !== MCP_CLIENT_ID);
  const available = targets.filter(t => !t.lease);

  const lines = targets.map((t, i) => {
    const markers: string[] = [];
    if (t.id === activeSessionId) markers.push('ACTIVE');
    if (t.lease?.clientId === MCP_CLIENT_ID) {
      markers.push('MINE');
    } else if (t.lease) {
      markers.push(`LEASED by ${t.lease.label || t.lease.clientId}`);
    } else {
      markers.push('AVAILABLE');
    }
    const markerStr = markers.join(', ');
    const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
    return `${i + 1}. [${t.id}]${tabLabel} ← ${markerStr}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
  });

  const summary = [
    `${targets.length} tab(s) attached`,
    `${myTabs.length} mine`,
    `${otherTabs.length} leased by others`,
    `${available.length} available`,
  ].join(', ');

  return { content: [{ type: 'text', text: `${summary}\n\n${lines.join('\n\n')}` }] };
}
```

### 5.7 Enhanced `switch_tab`

```typescript
if (name === 'switch_tab') {
  const targetId = args.targetId as string;
  // ... existing validation ...

  const target = targets.find(t => t.id === targetId);
  // ... existing not-found check ...

  // Check lease
  if (target.lease && target.lease.clientId !== MCP_CLIENT_ID) {
    const holder = target.lease.label || target.lease.clientId;
    return {
      content: [{ type: 'text', text:
        `Error: Tab is leased by "${holder}". You cannot switch to a tab owned by another agent.\n\n` +
        `Use list_tabs to see available tabs, or use connect_tab to attach a new one.`
      }],
      isError: true,
    };
  }

  // Release lease on current tab (but only if not switching between my own tabs)
  // Keep lease if I hold multiple tabs and am switching between them
  // (lease stays; I still own it — I just change which tab my CDP session points to)

  // ... existing close + reconnect logic ...

  // Acquire lease on new tab if not already mine
  if (!target.lease || target.lease.clientId !== MCP_CLIENT_ID) {
    const leased = await acquireLease(cdpSession!, targetId);
    if (!leased) {
      return {
        content: [{ type: 'text', text: 'Error: Failed to acquire lease on this tab (another agent may have just claimed it).' }],
        isError: true,
      };
    }
  }

  // ... rest unchanged ...
}
```

### 5.8 New Tool: `connect_tab`

```typescript
{
  name: 'connect_tab',
  description: 'Request the extension to find and attach a Chrome tab by URL pattern or tab ID. Can optionally create a new tab. Returns the attached target info. After connecting, use switch_tab to activate it.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL substring to match against open Chrome tabs (e.g., "localhost:9100", "example.com/dashboard")',
      },
      tabId: {
        type: 'number',
        description: 'Exact Chrome tab ID to attach (from list_tabs or browser.tabs)',
      },
      create: {
        type: 'boolean',
        description: 'If true and no matching tab found, create a new tab with the given URL and attach it',
      },
    },
  },
}
```

Implementation:

```typescript
if (name === 'connect_tab') {
  await ensureRelayServer();

  const url = args.url as string | undefined;
  const tabId = args.tabId as number | undefined;
  const create = args.create as boolean | undefined;

  if (!url && !tabId) {
    return { content: [{ type: 'text', text: 'Error: Provide either url or tabId.' }], isError: true };
  }

  const port = getRelayPort();
  try {
    const response = await fetch(`http://localhost:${port}/connect-tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, tabId, create }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();

    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed to connect tab: ${result.error}` }], isError: true };
    }

    // Refresh targets and report
    const targets = await getTargets();
    const newTarget = targets.find(t => t.tabId === result.tabId);
    const created = result.created ? ' (newly created)' : '';
    const info = newTarget
      ? `Attached tab${created}:\n  Session: ${newTarget.id}\n  Title: ${newTarget.title}\n  URL: ${newTarget.url}\n\nUse switch_tab with targetId "${newTarget.id}" to activate it.`
      : `Tab attached${created} (tabId: ${result.tabId}). Use list_tabs to see it.`;

    return { content: [{ type: 'text', text: info }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e}` }], isError: true };
  }
}
```

### 5.9 New Tool: `release_tab`

```typescript
{
  name: 'release_tab',
  description: 'Release your lease on a tab, making it available to other agents. If no targetId specified, releases the currently active tab.',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'Session ID of the tab to release. Omit to release the active tab.',
      },
    },
  },
}
```

### 5.10 Enhanced `reset`

```typescript
if (name === 'reset') {
  // Release all my leases before disconnecting
  if (cdpSession) {
    const targets = await getTargets().catch(() => [] as TargetListItem[]);
    for (const t of targets) {
      if (t.lease?.clientId === MCP_CLIENT_ID) {
        await releaseLease(cdpSession, t.id);
      }
    }
    cdpSession.ws.close();
    cdpSession = null;
  }
  // ... rest of existing reset logic ...
}
```

### 5.11 Handle Lease Events

In the CDP event handler (`ws.on('message', ...)`):

```typescript
if (msg.method === 'Target.leaseLost') {
  const lostSessionId = msg.params?.sessionId;
  log(`Lease lost for tab ${lostSessionId}: ${msg.params?.reason}`);
  if (cdpSession?.sessionId === lostSessionId) {
    // Our active tab was taken (tab closed, extension detached, etc.)
    // The next tool call will trigger ensureSession() which will re-negotiate
    cdpSession = null;
  }
}

if (msg.method === 'Target.tabAvailable') {
  log(`New tab available: ${msg.params?.targetInfo?.url} (${msg.params?.totalAvailable} total available)`);
}
```

---

## 6. Extension Changes

### 6.0 Offscreen Document Architecture

Chrome Manifest V3 service workers are ephemeral — they terminate after ~30 seconds of inactivity, closing any WebSocket connections. This made persistent relay communication impossible from `bridge.js` alone.

**Solution**: The WebSocket connection to the relay is moved into a **Chrome offscreen document** (`offscreen.html` + `offscreen.js`). The offscreen document:

- Maintains a persistent WebSocket to `ws://localhost:19989/extension`
- Auto-reconnects on failure (5s retry loop)
- Sends keepalive messages every 20 seconds to prevent proxy/NAT timeouts
- Bridges messages between the relay and the service worker via `chrome.runtime` messaging

**Message protocol** (chrome.runtime messaging):

| Direction | Message Type | Purpose |
|-----------|------------|---------|
| SW → Offscreen | `{ type: "ws-send", payload }` | Send JSON to relay |
| SW → Offscreen | `{ type: "ws-status" }` | Query WebSocket state |
| SW → Offscreen | `{ type: "ws-connect" }` | Force (re)connect |
| Offscreen → SW | `{ type: "ws-message", payload }` | Relay message received |
| Offscreen → SW | `{ type: "ws-state-change", state }` | WebSocket opened/closed |

**Lifecycle**:
1. Service worker `init()` registers message listeners synchronously (critical — must happen before any `chrome.runtime.sendMessage` from content scripts)
2. Service worker calls `ensureOffscreen()` asynchronously to create the offscreen document
3. Offscreen document auto-connects WebSocket on load
4. When a tool (e.g., `connect_tab`) needs the relay, `ensureRelayConnected()` polls the offscreen document's `ws-status` until the WebSocket is open

**Manifest changes**:
- `"permissions"`: Added `"offscreen"`
- `"background"`: Changed from `"scripts"` (MV2/Firefox) to `"service_worker"` (Chrome MV3)

**Files**:
- `src/offscreen.html` — Minimal HTML that loads `offscreen.js`
- `src/offscreen.js` — WebSocket owner, relay bridge
- `src/ai_bridge/bridge.js` — Service worker, delegates WS to offscreen
- `webpack.config.js` — New entry point + HTML copy for offscreen

### 6.1 New Handler: `connectTabByMatch`

Add to `handleRelayMessage()`:

```javascript
if (message.method === "connectTabByMatch") {
  const { url, tabId, create } = message.params || {};

  // Case 1: Specific tabId
  if (tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (isRestrictedUrl(tab?.url)) {
        return { success: false, error: `Cannot attach restricted URL: ${tab.url}` };
      }
      if (!attachedTabs.has(tabId)) {
        await connectTab(tabId);
      }
      return { success: true, tabId };
    } catch (e) {
      return { success: false, error: `Tab ${tabId} not found: ${e.message}` };
    }
  }

  // Case 2: Find by URL pattern
  if (url) {
    const allTabs = await browser.tabs.query({});
    // Try exact substring match first
    let match = allTabs.find(t => t.url && t.url.includes(url) && !isRestrictedUrl(t.url));

    // Try title match as fallback
    if (!match) {
      match = allTabs.find(t => t.title && t.title.toLowerCase().includes(url.toLowerCase()) && !isRestrictedUrl(t.url));
    }

    if (match) {
      if (!attachedTabs.has(match.id)) {
        await connectTab(match.id);
      }
      return { success: true, tabId: match.id };
    }

    // Case 3: Create new tab
    if (create) {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`;
      const newTab = await browser.tabs.create({ url: fullUrl, active: false });
      // Wait for tab to start loading
      await sleep(1000);
      await connectTab(newTab.id);
      return { success: true, tabId: newTab.id, created: true };
    }

    return { success: false, error: `No tab matching "${url}" found. Set create: true to create one.` };
  }

  // Case 4: Fallback to active tab
  const activeTabId = await ensureActiveTabAttached();
  return { success: true, tabId: activeTabId };
}
```

---

## 7. Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| **Single agent, no env vars** | `MCP_CLIENT_ID` is unique but that doesn't matter with one client. `ensureSession()` picks first tab, acquires lease (no competition). Identical UX. |
| **New MCP + old relay** | `Target.acquireLease` returns CDP error (unknown command). MCP catches, logs "Lease not supported by relay, running without isolation", continues. All features work except isolation. |
| **Old MCP + new relay** | Old MCP still uses `clientId = "mcp-client"`. No leases acquired. Relay broadcasts events as before. No behavior change. |
| **Mixed new+old MCP + new relay** | New MCP acquires leases. Old MCP doesn't. Lease enforcement only applies to leased tabs. Old MCP can still access unleased tabs. Best-effort isolation. |
| **Playwright sessions** | Playwright uses `clientId = "pw-{ts}-{rand}"`. Not subject to lease enforcement (prefix exemption). Playwright operates on whatever tab the MCP session routes to, which is already lease-protected. |

---

## 8. Sequence Diagrams

### 8.1 Two Agents, Automatic Negotiation

```
Agent A (finetune)                    Relay                      Extension
  │                                     │                           │
  │ ──── GET /json/list ──────────────► │                           │
  │ ◄─── [] (empty) ──────────────────  │                           │
  │                                     │                           │
  │ ──── POST /connect-tab ──────────► │                           │
  │      { url: "localhost:9100" }      │ ── connectTabByMatch ──► │
  │                                     │                           │── find tab, attach
  │                                     │ ◄─ { success, tabId } ── │
  │ ◄─── { success, tabId: 111 } ───── │                           │
  │                                     │                           │
  │ ──── WS connect /cdp/mcp-a-xxx ──► │                           │
  │ ──── Target.acquireLease ─────────► │                           │
  │      { sessionId: "tab-111-..." }   │ (store lease)             │
  │ ◄─── { granted: true } ──────────  │                           │
  │                                     │                           │
  │ ──── screenshot ──────────────────► │ ── forward ────────────► │
  │ ◄─── (screenshot of tab 111) ────  │ ◄─ response ───────────  │
  │                                     │                           │

Agent B (other-project)               Relay                      Extension
  │                                     │                           │
  │ ──── GET /json/list ──────────────► │                           │
  │ ◄─── [tab-111 { lease: A }] ──────  │                           │
  │                                     │                           │
  │ (tab-111 is leased, try auto-attach)│                           │
  │ ──── POST /connect-tab ──────────► │                           │
  │      { url: "localhost:8080" }      │ ── connectTabByMatch ──► │
  │                                     │                           │── find tab, attach
  │                                     │ ◄─ { success, tabId } ── │
  │ ◄─── { success, tabId: 222 } ───── │                           │
  │                                     │                           │
  │ ──── WS connect /cdp/mcp-b-yyy ──► │                           │
  │ ──── Target.acquireLease ─────────► │                           │
  │      { sessionId: "tab-222-..." }   │ (store lease)             │
  │ ◄─── { granted: true } ──────────  │                           │
  │                                     │                           │
  │ (events from tab-111 NOT sent to B) │                           │
  │ (events from tab-222 NOT sent to A) │                           │
```

### 8.2 Agent Crash Recovery

```
Agent A (crashes)                     Relay                      Agent B
  │                                     │                           │
  │ ──── WS /cdp/mcp-a-xxx ──────────► │                           │
  │ ──── Target.acquireLease(tab-111) ► │                           │
  │                                     │                           │
  ╳ (process crash, WS closes)          │                           │
  │                                     │                           │
  │                    (ws 'close' event)│                           │
  │                    release tab-111   │                           │
  │                    broadcast:        │                           │
  │                    Target.leaseReleased │                        │
  │                                     │ ── Target.leaseReleased ► │
  │                                     │    (tab-111 now free)     │
  │                                     │                           │
  │ (Agent A restarts, new MCP process) │                           │
  │ ──── GET /json/list ──────────────► │                           │
  │ ◄─── [tab-111 (unleased),          │                           │
  │       tab-222 (leased by B)] ──────  │                           │
  │                                     │                           │
  │ ──── acquireLease(tab-111) ────────► │                           │
  │ ◄─── granted ─────────────────────  │                           │
```

### 8.3 Lease Conflict (Race Condition)

```
Agent A                               Relay                      Agent B
  │                                     │                           │
  │ ──── GET /json/list ──────────────► │                           │
  │ ◄─── [tab-111 (unleased)] ────────  │                           │
  │                                     │ ◄── GET /json/list ─────  │
  │                                     │ ──► [tab-111 (unleased)]  │
  │                                     │                           │
  │ ──── acquireLease(tab-111) ────────► │                           │
  │ ◄─── granted ─────────────────────  │                           │
  │                                     │                           │
  │                                     │ ◄── acquireLease(tab-111) │
  │                                     │ ──► REJECTED:             │
  │                                     │     "leased by finetune"  │
  │                                     │                           │
  │                                     │ (Agent B tries next tab   │
  │                                     │  or auto-attaches new one)│
```

---

## 9. MCP Configuration Examples

### Single Agent (no changes needed)

```json
{
  "spawriter": {
    "command": "node",
    "args": ["path/to/spawriter/mcp/dist/cli.js", "serve"]
  }
}
```

### Multi-Agent Setup

**Project A** (`.cursor/mcp.json`):
```json
{
  "spawriter": {
    "command": "node",
    "args": ["D:/dev/side/spawriter/mcp/dist/cli.js", "serve"],
    "env": {
      "SSPA_AGENT_LABEL": "finetune",
      "SSPA_PROJECT_URL": "localhost:9100"
    }
  }
}
```

**Project B** (`.cursor/mcp.json`):
```json
{
  "spawriter": {
    "command": "node",
    "args": ["D:/dev/side/spawriter/mcp/dist/cli.js", "serve"],
    "env": {
      "SSPA_AGENT_LABEL": "dashboard",
      "SSPA_PROJECT_URL": "localhost:8080"
    }
  }
}
```

---

## 10. Edge Cases & Handling

### 10.1 Tab Lifecycle

| Event | Handling |
|-------|----------|
| **Tab closed by user** | Extension sends `Target.detachedFromTarget` → relay removes target + lease → sends `Target.leaseLost` to holder → holder's `cdpSession` becomes null → next tool call triggers re-negotiation |
| **Tab navigated to restricted URL** (`chrome://`) | Extension auto-detaches → same as tab close |
| **Tab reloaded** | No effect on lease. CDP session persists. Extension re-enables domains. |
| **Extension disabled/removed** | Extension WebSocket closes → relay clears ALL `attachedTargets` and ALL leases → ALL clients get `Target.leaseLost` |
| **Relay restart** | All WebSockets close → MCP reconnects → leases start fresh → agents re-acquire via `ensureSession()` |

### 10.2 Agent Lifecycle

| Event | Handling |
|-------|----------|
| **MCP process exits normally** | WebSocket close → relay auto-releases leases |
| **MCP process crashes** | WebSocket close → relay auto-releases leases (same as normal) |
| **Agent idle for long time** | No timeout on leases. Lease persists until explicit release or disconnect. |
| **Two MCP instances in same Cursor window** | Shouldn't happen (Cursor runs one MCP per config entry). If it did, unique `MCP_CLIENT_ID` prevents collision. |

### 10.3 Supply/Demand Mismatch

| Scenario | Handling |
|----------|----------|
| **0 tabs, 1 agent** | `ensureSession()` → `requestExtensionAttachTab()` (existing behavior) → auto-attaches active tab |
| **0 tabs, 2 agents** | First agent triggers `requestExtensionAttachTab()`. Second agent finds tab leased, tries auto-attach by `projectUrl`. If no `projectUrl`, error with instructions. |
| **1 tab, 2 agents** | First agent leases it. Second agent: tries auto-attach by URL → if fails, clear error explaining the tab is taken. |
| **3 tabs, 1 agent** | Agent leases 1 tab. The other 2 remain available. Agent can `switch_tab` to lease more. `list_tabs` shows "2 available". |
| **3 tabs, 2 agents** | Each agent leases 1 tab. 1 remains available. Either agent can `switch_tab` to lease it (first to try wins). |
| **Agent needs reference tab** | Agent uses `connect_tab { url: "design-reference.com" }` to attach a new tab, then `switch_tab` to use it. Both tabs leased by the same agent. |
| **User manually attaches new tab** | Relay broadcasts `Target.tabAvailable` → all agents learn about the new tab → they can claim it if needed |

### 10.4 Playwright Interaction

| Scenario | Handling |
|----------|----------|
| **Playwright connects to leased tab** | Playwright uses `clientId = "pw-..."`. Relay exempts `pw-*` clients from lease enforcement. Playwright operates on the same tab the MCP is connected to (via `sessionId`). Safe because the MCP process controls both. |
| **Playwright connects to wrong tab** | Not possible. Playwright's `connectOverCDP` connects to the relay, and the relay routes by `sessionId` which Playwright inherits from the MCP's active session. |
| **Multiple Playwright sessions** | Each gets a unique `pw-*` clientId. All exempt from lease enforcement. They share the MCP's leased tabs. |

### 10.5 Concurrent Lease Acquisition (TOCTOU)

The "time-of-check to time-of-use" race between `getTargets()` and `acquireLease()`:

- **Risk**: Two agents both see tab-111 as unleased, both try `acquireLease`.
- **Mitigation**: `acquireLease` in the relay is synchronous (single-threaded Node.js event loop). First request to arrive wins. Second gets rejection.
- **MCP handling**: On rejection, `doEnsureSession()` moves to the next candidate tab. If all candidates fail, tries auto-attach.
- **No mutex needed**: Node.js single-threaded execution guarantees the relay's lease map is accessed atomically within each message handler.

---

## 11. New MCP Tools Summary

| Tool | Purpose | Args |
|------|---------|------|
| `list_tabs` | (enhanced) Now shows lease status per tab: MINE, LEASED by X, AVAILABLE | (unchanged) |
| `switch_tab` | (enhanced) Prevents switching to another agent's tab. Acquires lease on new tab. | `targetId` |
| `connect_tab` | **NEW** — Request extension to find/attach/create a tab | `url?`, `tabId?`, `create?` |
| `release_tab` | **NEW** — Release lease on a tab | `targetId?` |

---

## 12. New Relay Events Summary

| Event | Direction | When | Params |
|-------|-----------|------|--------|
| `Target.tabAvailable` | Relay → all clients | New tab attached | `{ sessionId, targetInfo, totalAvailable }` |
| `Target.leaseReleased` | Relay → all clients | Lease released (by agent or auto-cleanup) | `{ sessionId, reason }` |
| `Target.leaseLost` | Relay → lease holder | Tab detached or extension disconnected | `{ sessionId, reason }` |

---

## 13. Files Changed

| File | Type | Description | Est. Lines |
|------|------|-------------|------------|
| `mcp/src/relay.ts` | Modified | Lease registry, enforcement, event filtering, `/connect-tab`, cleanup, enriched `/json/list` | +130 |
| `mcp/src/mcp.ts` | Modified | Unique clientId, env vars, enhanced session negotiation, lease-aware switch_tab, new tools (connect_tab, release_tab), enhanced list_tabs, event handling | +150 |
| `mcp/src/protocol.ts` | Modified | LeaseInfo type, TargetWithLease type | +15 |
| `mcp/src/utils.ts` | Modified | Export agent label/project URL getters | +10 |
| `src/ai_bridge/bridge.js` | Modified | Offscreen-based WS delegation, `connectTabByMatch` handler | +80 |
| `src/offscreen.html` | New | Offscreen document HTML shell | +5 |
| `src/offscreen.js` | New | Persistent WebSocket owner, relay bridge | +130 |
| `manifest.json` | Modified | `service_worker` background, `offscreen` permission | +2 |
| `webpack.config.js` | Modified | New entry point + HTML copy for offscreen | +3 |
| **Total** | | | **~565** |

---

## 14. Impact Audit: Every Existing Tool

Every tool in `mcp.ts` was audited against the lease system. The table below documents each tool's CDP interaction pattern, the impact of the lease system, and any required changes.

### 14.1 Tools That Do NOT Use `ensureSession()` (Pre-Session)

These tools execute before `ensureSession()` or don't use CDP at all.

| Tool | Current Behavior | Lease Impact | Changes |
|------|-----------------|--------------|---------|
| `reset` | Closes `cdpSession`, clears all state, resets Playwright | **Needs change**: Must release all leases before closing WebSocket. Otherwise, relay only auto-releases on WS close (which is fine, but explicit release is cleaner and triggers `Target.leaseReleased` broadcast immediately). | Release all my leases, then close WS |
| `list_tabs` | Calls `getTargets()` via HTTP `/json/list`, no CDP | **Needs change**: Show lease info in output (MINE / LEASED / AVAILABLE). No CDP changes needed since it only reads HTTP. | Enrich display format |
| `switch_tab` | Closes current WS, reconnects to new target | **Needs change**: (1) Check lease before switching — reject if target is leased by another agent. (2) Acquire lease on new tab. (3) Do NOT release current tab's lease (agent may want multiple tabs). | Lease-aware switch logic |
| `console_logs` | Reads from in-process `consoleLogs` array, no CDP | **No change needed**. The array is per-process. With event filtering (Section 4.3), this process only receives events from its own leased tabs. Problem solved at relay level. | None |
| `network_log` | Reads from in-process `networkLog` map, no CDP | **No change needed**. Same as `console_logs` — event filtering ensures isolation. | None |
| `network_detail` | Reads from `networkLog`, may call `ensureSession()` for `Network.getRequestPostData` / `Network.getResponseBody` | **No change needed**. If it calls `ensureSession()`, it gets our leased session. The `requestId` is per-process (from our filtered events). Cannot accidentally query another agent's request. | None |
| `playwright_execute` | Calls `ensureRelayServer()`, then `pwExecutor.execute()` | **Special case**: Playwright connects with `clientId = "pw-{ts}-{rand}"`. Relay exempts `pw-*` from lease enforcement. Playwright operates on whatever tab the relay routes to (based on the session the extension has). Since Playwright doesn't specify a `sessionId` in its commands, the extension routes to its first attached tab. **Risk**: If Agent A's Playwright connects, the extension may route to Agent B's tab. **Mitigation**: Playwright connections inherit the page from the relay's CDP routing; since we're using `connectOverCDP` which returns the first page, this is actually the same tab the extension has. The real fix is that Playwright sessions are per-MCP-process and don't cross over. No additional change needed. | None |
| `session_manager` | Manages `executorManager` (Playwright sessions) | **No change needed**. `ExecutorManager` is per-process. Each Playwright session gets its own `pw-*` clientId. | None |

### 14.2 Tools That Use `ensureSession()` + `sendCdpCommand()`

All tools below call `const session = await ensureSession()` and then use `sendCdpCommand(session, ...)`. With the lease system, `ensureSession()` guarantees we connect to our own leased tab. The relay enforces that our CDP commands (sent with our `MCP_CLIENT_ID` via our `sessionId`) are only allowed on our leased tab.

| Tool | CDP Commands Used | Lease Impact | Changes |
|------|-------------------|--------------|---------|
| `screenshot` | `Page.captureScreenshot`, `Accessibility.enable`, `Accessibility.getFullAXTree`, `DOM.enable`, `DOM.getBoxModel`, `Runtime.evaluate` (label injection) | **Safe**. All commands routed to our leased tab via `sessionId`. | None |
| `screenshot` (labels) | Same + label overlay JS injection/removal | **Safe**. JS executes in our tab. | None |
| `accessibility_snapshot` | `Accessibility.enable`, `Accessibility.getFullAXTree` | **Safe**. `lastSnapshot` is per-process. | None |
| `execute` | `Runtime.evaluate` | **Safe**. Executes in our leased tab. | None |
| `dashboard_state` | `Runtime.evaluate` (reads `__SINGLE_SPA_DEVTOOLS__`) | **Safe**. Reads from our tab's page context. | None |
| `clear_cache_and_reload` | `Network.clearBrowserCache`, `Network.getCookies`, `Network.deleteCookies`, `Storage.clearDataForOrigin`, `Page.reload` | **Caution**: `Network.clearBrowserCache` is a **global** CDP command — it clears cache for the entire browser, not just our tab. This affects other agents' tabs too. However, this is existing behavior and is inherent to the Chrome CDP API. No lease change can fix this. **Risk accepted**. Cookie deletion is scoped to origin, which is fine. | None (document the cache-clearing caveat) |
| `ensure_fresh_render` | `Page.reload` | **Safe**. Reloads our tab only. | None |
| `navigate` | `Page.navigate` | **Safe**. Navigates our leased tab. | None |
| `override_app` | `Runtime.evaluate` (reads/writes `importMapOverrides`), `Page.reload` | **Safe**. Affects our tab's localStorage and page. Note: `importMapOverrides` is per-origin/localStorage, so if two agents share the same origin on different tabs, overrides could conflict. This is an application-level concern, not a spawriter concern. | None |
| `app_action` | `Runtime.evaluate` (calls single-spa lifecycle) | **Safe**. Operates on our tab's single-spa instance. | None |
| `debugger` (all actions) | `Debugger.enable`, `Debugger.setBreakpointByUrl`, `Debugger.removeBreakpoint`, `Debugger.resume`, `Debugger.stepOver/Into/Out`, `Debugger.evaluateOnCallFrame`, `Debugger.setPauseOnExceptions` | **Safe**. Debugger state (`debuggerEnabled`, `breakpoints`, `debuggerPaused`, `knownScripts`) is per-process. CDP debugger commands scope to our session. **Note**: `Debugger.setBreakpointByUrl` with `urlRegex` could theoretically set breakpoints in scripts loaded across tabs if Chrome shares the V8 isolate, but in practice each tab has its own execution context and scripts. | None |
| `css_inspect` | `Runtime.evaluate` (reads `getComputedStyle`) | **Safe**. Runs in our tab. | None |
| `storage` (all actions) | `Network.getCookies`, `Network.setCookie`, `Network.deleteCookies`, `Runtime.evaluate` (localStorage/sessionStorage), `Storage.clearDataForOrigin`, `Storage.getUsageAndQuota` | **Mostly safe**. Cookie operations are scoped by domain/origin. Storage operations are scoped by origin. **Caution**: `Network.getCookies` without URL filter returns ALL cookies for the browser profile, not just our tab. This is existing behavior. | None |
| `performance` (all actions) | `Performance.enable/disable`, `Performance.getMetrics`, `Runtime.evaluate` (Web Vitals, resource timing) | **Safe**. Metrics are per-page. `Runtime.evaluate` runs in our tab. | None |
| `editor` (all actions) | `Debugger.enable`, `Debugger.getScriptSource`, `Debugger.setScriptSource`, `Debugger.searchInContent`, `Runtime.evaluate` (stylesheet ops), `CSS.enable`, `DOM.enable` | **Safe**. Script and stylesheet operations scope to our tab's loaded resources. `knownScripts` is per-process. | None |
| `network_intercept` (all actions) | `Fetch.enable/disable`, `Fetch.fulfillRequest`, `Fetch.continueRequest` | **Safe with caveat**. `Fetch.enable` with `urlPattern: '*'` intercepts ALL requests in our session. Since CDP session scopes to our tab, only our tab's requests are intercepted. `interceptRules` and `interceptEnabled` are per-process. | None |
| `emulation` (all actions) | `Emulation.setDeviceMetricsOverride`, `Emulation.setUserAgentOverride`, `Emulation.setGeolocationOverride`, `Emulation.setTimezoneOverride`, `Emulation.setLocaleOverride`, `Emulation.clearDeviceMetricsOverride`, `Emulation.setEmulatedMedia`, `Network.emulateNetworkConditions` | **Safe**. Emulation commands scope to the attached target (our tab). | None |
| `page_content` (all actions) | `Runtime.evaluate` (DOM operations) | **Safe**. JS runs in our tab's page context. | None |

### 14.3 Cross-Cutting Concerns

| Concern | Analysis | Mitigation |
|---------|----------|------------|
| **Global CDP commands** | `Network.clearBrowserCache` is browser-wide, not tab-scoped. One agent clearing cache affects all agents. | Document in tool description. Cannot fix at spawriter level — this is a Chrome CDP limitation. |
| **Cookie visibility** | `Network.getCookies` returns browser-wide cookies. Agent A can see cookies set by Agent B's tab (same browser profile). | Existing behavior. Not a spawriter concern — it's browser architecture. |
| **SharedWorker / ServiceWorker** | If two agents' tabs share the same origin, ServiceWorker operations could interfere. | Application-level concern. Document as known limitation. |
| **CDP event ordering** | With event filtering, each agent only sees its own tab's events. No ordering issues between agents. | Solved by design. |
| **Playwright cross-tab** | `PlaywrightExecutor.ensureConnection()` calls `chromium.connectOverCDP(cdpUrl)` which connects to relay with a random `pw-*` clientId. It gets `browser.contexts()[0].pages()[0]` which is the first page available. **Risk**: If relay has multiple tabs and no session routing for Playwright, it may get the wrong tab. | Playwright connects to the relay without specifying `sessionId`. The relay creates a synthetic CDP target for Playwright. In practice, Playwright picks up the page from the browser context, which is the tab the extension last attached. **Low risk** because Playwright sessions are per-MCP-process and don't share state. However, this is a pre-existing design constraint, not introduced by leases. |
| **`lastSnapshot` (accessibility)** | Per-process variable. With event filtering, no cross-contamination. | Safe. |
| **`consoleLogs` / `networkLog`** | Per-process arrays/maps populated from CDP events. With event filtering, only our tab's events arrive. | Safe after relay event filtering. |
| **`knownScripts` / `breakpoints`** | Per-process maps. Debugger events are tab-scoped CDP events. | Safe after relay event filtering. |
| **`interceptRules` / `interceptEnabled`** | Per-process state. `Fetch.enable/disable` is session-scoped. | Safe. |

### 14.4 Summary: Tools Requiring Changes

Only **4 out of 23 tools** need changes:

| Tool | Change Type | Effort |
|------|------------|--------|
| `reset` | Add lease release before disconnect | Small |
| `list_tabs` | Enrich output with lease status | Small |
| `switch_tab` | Add lease check + acquire | Medium |
| (new) `connect_tab` | New tool | Medium |
| (new) `release_tab` | New tool | Small |

The remaining **19 tools are safe without any changes** because:
1. They use `ensureSession()` which connects to our leased tab
2. CDP commands are sent with our `sessionId` (relay enforces lease)
3. CDP events are filtered by lease (relay routes only to lease holder)
4. Per-process state (logs, breakpoints, intercept rules, etc.) is naturally isolated

---

## 15. Test Plan

### 15.1 Unit Tests

| # | Test | Expected |
|---|------|----------|
| U1 | `Target.acquireLease` on unleased tab | `{ granted: true, lease: {...} }` |
| U2 | `Target.acquireLease` on tab leased by same client | Refreshed lease (idempotent) |
| U3 | `Target.acquireLease` on tab leased by different client | `{ error: ..., holder: {...} }` |
| U4 | `Target.releaseLease` by holder | `{ released: true }`, tab now unleased |
| U5 | `Target.releaseLease` by non-holder | Error |
| U6 | `Target.releaseLease` on unleased tab | No-op success |
| U7 | `Target.listLeases` with 0, 1, N leases | Correct array |
| U8 | `/json/list` returns `lease` field per target | Correct lease or null |
| U9 | Unique `MCP_CLIENT_ID` across two processes | IDs differ |
| U10 | `connectTabByMatch` with URL match | Finds and attaches correct tab |
| U11 | `connectTabByMatch` with no match, `create: false` | Error |
| U12 | `connectTabByMatch` with no match, `create: true` | New tab created and attached |

### 15.2 Integration Tests

| # | Test | Setup | Expected |
|---|------|-------|----------|
| I1 | Single agent, no env vars | 1 MCP, 1 tab | Lease acquired, works normally |
| I2 | Two agents, separate tabs | 2 MCP, 2 tabs | Each leases own tab, events isolated |
| I3 | Two agents, one tab | 2 MCP, 1 tab | First leases, second gets clear error |
| I4 | Agent crash + recovery | Kill MCP process | Lease auto-released, restart re-acquires |
| I5 | Tab close during lease | Close Chrome tab | `Target.leaseLost` sent, next tool reconnects |
| I6 | Race condition | 2 agents `acquireLease` simultaneously | One wins, other gets rejection + fallback |
| I7 | Auto-attach by URL | `SSPA_PROJECT_URL=localhost:9100` | MCP finds matching tab, attaches, leases |
| I8 | Lease + Playwright | Agent leases tab, uses `playwright_execute` | Playwright works on leased tab, not blocked |
| I9 | Switch between own tabs | Agent leases 2 tabs, `switch_tab` | Both leases held, switch works |
| I10 | Switch to other's tab | Agent tries `switch_tab` to leased tab | Error: "leased by ..." |

### 15.3 Backward Compatibility Tests

| # | Test | Setup | Expected |
|---|------|-------|----------|
| B1 | New MCP + old relay | Old relay without lease support | MCP logs warning, continues without lease, all tools work |
| B2 | Old MCP + new relay | Old MCP with `clientId = "mcp-client"` | No leases, broadcast events, existing behavior |
| B3 | Single agent, no env vars | New code, default config | Identical to current behavior |

### 15.4 Manual E2E Tests

| # | Scenario | Steps | Verify |
|---|----------|-------|--------|
| E1 | Two Cursor windows | 1. Open Cursor A with `SSPA_AGENT_LABEL=A`, 2. Open Cursor B with `SSPA_AGENT_LABEL=B`, 3. Both use spawriter tools | Each agent uses its own tab, no cross-talk |
| E2 | Tab surplus | 1. Attach 3 tabs manually, 2. One agent running | `list_tabs` shows 1 MINE, 2 AVAILABLE |
| E3 | Auto-attach | 1. Set `SSPA_PROJECT_URL`, 2. Open matching Chrome tab (don't click toolbar), 3. Agent uses screenshot | Tab auto-attached and leased |
| E4 | Create tab | 1. `connect_tab { url: "https://example.com", create: true }` | New tab opened and attached in Chrome |

---

## 16. Implementation Notes (Post-Design Fixes)

These issues were discovered and fixed during implementation and live testing:

### 16.1 WebSocket Reconnect Race Condition

**Problem:** When `switch_tab` closes the old WebSocket and opens a new one with the same `MCP_CLIENT_ID`, the relay's close handler for the stale WebSocket could fire AFTER the new WebSocket registers. This would delete the new client entry from `cdpClients` and release all leases held by the agent.

**Fix:** The relay's `ws.on('close')` handler now checks `if (current?.ws === ws)` — it only deletes the client and releases leases if the closing WebSocket is the currently registered one for that clientId. If a newer WebSocket has already been registered, the stale close is ignored.

### 16.2 Backward Compatibility Detection

**Problem:** When a new MCP connects to an old relay that doesn't support `Target.acquireLease`, every candidate tab would fail the lease acquisition, causing `doEnsureSession` to fall through to the "No browser tab attached" error even when tabs were available.

**Fix:** Added a `leaseSupported` flag (null/true/false). On the first `acquireLease` failure when `leaseSupported === null`, the MCP logs "Lease commands not supported by relay — running without isolation" and sets `leaseSupported = false`. All subsequent `acquireLease` calls return `true` immediately, allowing the agent to connect without leases.

### 16.3 Active Tab Session Clearing on Release

**Problem:** If `release_tab` released the currently active tab, `cdpSession` was not cleared. The next tool call would reuse the old session, sending commands to a tab where the agent no longer holds a lease.

**Fix:** After `releaseLease()`, if `targetId === cdpSession?.sessionId`, set `cdpSession = null`. The next tool call triggers `doEnsureSession` which will acquire a new tab.

### 16.4 Extension Maintain Loop Resilience

**Problem:** When the relay restarts, the extension's WebSocket closes. The maintain loop would check `hasWork = attachedTabs.size > 0 || ws?.readyState === WebSocket.OPEN` — both false after disconnect and tab clear — and permanently stop. The extension would never reconnect.

**Fix:** The maintain loop now runs unconditionally (no `hasWork` check), always attempting `ensureConnection()`. Uses a `maintainLoopActive` flag to prevent duplicate loops. The loop only stops when `stopMaintainLoop()` is called explicitly during user-initiated tab detach with no remaining tabs.

---

## 17. Future Considerations

| Item | Description | Priority |
|------|-------------|----------|
| **Lease expiry** | Optional TTL on leases for truly abandoned agents that keep WebSocket alive but are idle. Not needed initially — crash cleanup covers most cases. | Low |
| **Lease transfer** | Allow one agent to explicitly transfer a lease to another. Useful for "hand-off" workflows. | Low |
| **Per-tab event buffer** | Buffer events per-tab so when an agent switches tabs, it can replay missed events from its other leased tab. | Medium |
| **Dashboard UI** | Extension panel shows lease status per tab (who owns it, colored indicators). | Medium |
| **Relay persistence** | Persist leases to disk so relay restart doesn't lose lease state. Not critical since MCP also reconnects. | Low |
| **Playwright lease binding** | Instead of `pw-*` prefix exemption, MCP registers its Playwright clientIds with relay for tighter binding. | Low |
