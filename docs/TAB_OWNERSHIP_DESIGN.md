# Tab Ownership Design — Implementation Specification

> Goal: Every agent clearly knows which tabs are theirs, which belong to others, and cannot accidentally operate on another agent's tab.

### Implementation Status

| Section | Status | Notes |
|---|---|---|
| 1. `protocol.ts` | **PLANNED** | Old `LeaseInfo` / `LEASE_ERROR_CODE` still in place |
| 2. `relay.ts` — Core Ownership Map | **PLANNED** | Old `TabLease` / `tabLeases` / lease functions still in place |
| 3. `pw-executor.ts` — Executor Binding | **PLANNED** | No `ownedTabIds` / `activeTabId` / `switchToTab` yet; still uses `pages[0]` |
| 4. `mcp.ts` — MCP Integration | **PLANNED** | Still uses lease-based `TargetListItem`; no relay claim calls |
| 5. `cli.ts` — CLI Commands | **PLANNED** | No `session bind` command |
| 6. `extension/bridge.js` — Extension UI | **PLANNED** | Still uses `leaseStateBySessionId` / lease events |
| 7. `lease.test.ts` → `ownership.test.ts` | **PLANNED** | File not yet renamed; tests still use lease registry |
| 8. `relay.test.ts` — Update References | **PLANNED** | ~150 lease references remain |

> **This document is a design specification, not a changelog.** All code changes described below are planned but not yet implemented. The current codebase uses the old lease system throughout. Do not treat code blocks as "already landed" — they are the target implementation.

---

## The Problem

All `PlaywrightExecutor` instances connect via `chromium.connectOverCDP()` and grab `pages[0]` (pw-executor.ts:344). Multiple sessions share the same browser tab. The existing "lease" system only guards CDP WebSocket clients — CLI (`/cli/execute`) and MCP paths bypass it entirely.

## Design: Session-Tab Ownership

### Rules

1. **One tab → one owner.** A tab can be owned by at most one session.
2. **One session → many tabs.** A session can own multiple tabs.
3. **One active tab.** The executor operates on the active tab; `switch` changes it.
4. **Auto-claim.** First `execute` auto-claims an unclaimed tab (single-agent ease).
5. **Universal.** Enforced for all paths: CLI HTTP, MCP, CDP WebSocket.
6. **Auto-release.** Session delete / MCP disconnect / 30min idle → release all tabs.

---

## File-by-File Changes

### 1. `spawriter/src/protocol.ts`

**Remove** the old lease types (lines 70-90). **Add** ownership types.

```typescript
// REMOVE these (lines 70-90):
// export interface LeaseInfo { ... }
// export interface TargetWithLease { ... }
// export const LEASE_ERROR_CODE = -32001;

// ADD:
export const OWNERSHIP_ERROR_CODE = -32001;

export interface TabOwnership {
  tabId: number;
  sessionId: string;
  claimedAt: number;
}
```

### 2. `spawriter/src/relay.ts` — Core Ownership Map

**Replace** the `TabLease` interface + `tabLeases` Map + all lease functions with:

```typescript
// REMOVE: interface TabLease { sessionId, clientId, label, acquiredAt }  (line 74-79)
// REMOVE: const tabLeases = new Map<string, TabLease>();                 (line 81)
// REMOVE: getLeaseInfo()                                                 (line 83-87)
// REMOVE: releaseClientLeases()                                          (line 89-105)
// REMOVE: isPlaywrightClient()                                           (line 107-109)
// REMOVE: sendLeaseSnapshotToExtension()                                 (line 270-288)
// REMOVE: checkLeaseEnforcement()                                        (line 906-923)
// REMOVE: routeCdpEvent() — will be replaced                            (line 925-937)
// REMOVE: All Target.acquireLease / Target.releaseLease / Target.listLeases case handlers (line 648-748)

// ADD:
const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
const sessionActivity = new Map<string, number>(); // sessionId → last activity timestamp
// Maps agent session (sw-xxx / mcp-xxx) → CDP WS clientId for event routing
const sessionToClientId = new Map<string, string>();

function claimTab(tabId: number, sessionId: string, force?: boolean): { ok: boolean; owner?: string } {
  const existing = tabOwners.get(tabId);
  if (existing && existing.sessionId !== sessionId) {
    if (!force) return { ok: false, owner: existing.sessionId };
    // Force takeover: notify old owner (cf. opencode-browser broker.cjs:349-362)
    broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'force-takeover', previousOwner: existing.sessionId });
  }
  tabOwners.set(tabId, { sessionId, claimedAt: Date.now() });
  sessionActivity.set(sessionId, Date.now());
  broadcastOwnershipEvent('Target.tabClaimed', { tabId, sessionId, claimedAt: Date.now() });
  sendOwnershipSnapshotToExtension('claim');
  return { ok: true };
}

function touchClaim(tabId: number, sessionId: string): void {
  const existing = tabOwners.get(tabId);
  if (!existing || existing.sessionId !== sessionId) return;
  sessionActivity.set(sessionId, Date.now());
}

function releaseTab(tabId: number, sessionId: string): boolean {
  const existing = tabOwners.get(tabId);
  if (!existing || existing.sessionId !== sessionId) return false;
  tabOwners.delete(tabId);
  broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'explicit-release' });
  sendOwnershipSnapshotToExtension('release');
  return true;
}

function releaseAllTabs(sessionId: string): number {
  const toRelease: number[] = [];
  for (const [tabId, owner] of tabOwners) {
    if (owner.sessionId === sessionId) toRelease.push(tabId);
  }
  for (const tabId of toRelease) {
    tabOwners.delete(tabId);
    broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'session-cleanup' });
  }
  if (toRelease.length > 0) sendOwnershipSnapshotToExtension('session-cleanup');
  return toRelease.length;
}

function getOwnedTabs(sessionId: string): number[] {
  return [...tabOwners.entries()]
    .filter(([, o]) => o.sessionId === sessionId)
    .map(([tabId]) => tabId);
}

function getTabOwner(tabId: number): string | undefined {
  return tabOwners.get(tabId)?.sessionId;
}

function resolveTabIdFromSession(cdpSessionId: string): number | undefined {
  return attachedTargets.get(cdpSessionId)?.tabId ?? undefined;
}

function sendOwnershipSnapshotToExtension(reason: string): void {
  if (extensionWs?.readyState !== WebSocket.OPEN) return;
  const ownership = [...tabOwners.entries()].map(([tabId, o]) => ({
    tabId,
    sessionId: o.sessionId,
    claimedAt: o.claimedAt,
  }));
  sendToExtension({
    method: 'Target.ownershipSnapshot',
    params: { reason, ownership },
  });
}

function broadcastOwnershipEvent(method: string, params: Record<string, unknown>): void {
  broadcastToCDPClients({ method, params });
}

// Stale session sweep — configurable TTL, self-tuning interval (cf. opencode-browser broker.cjs:30-38)
const DEFAULT_STALE_TTL = 30 * 60 * 1000;
const STALE_SESSION_TTL = (() => {
  const raw = process.env.SPAWRITER_CLAIM_TTL_MS;
  const val = Number(raw);
  return Number.isFinite(val) && val >= 0 ? val : DEFAULT_STALE_TTL;
})();
const SWEEP_INTERVAL = STALE_SESSION_TTL > 0
  ? Math.min(Math.max(10000, Math.floor(STALE_SESSION_TTL / 2)), 60000)
  : 0;

if (SWEEP_INTERVAL > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastActive] of sessionActivity) {
      if (now - lastActive > STALE_SESSION_TTL) {
        const count = releaseAllTabs(sessionId);
        if (count > 0) log(`Stale session ${sessionId}: released ${count} tab(s)`);
        sessionActivity.delete(sessionId);
        sessionToClientId.delete(sessionId);
        // Clean up any pw-client bindings for this session
        for (const [pwId, sid] of pwClientToSession) {
          if (sid === sessionId) pwClientToSession.delete(pwId);
        }
        relayExecutorManager.remove(sessionId);
      }
    }
    // Also clean orphan sessions (no claims, stale activity)
    for (const [sessionId, lastActive] of sessionActivity) {
      if (getOwnedTabs(sessionId).length === 0 && now - lastActive > STALE_SESSION_TTL) {
        sessionActivity.delete(sessionId);
        sessionToClientId.delete(sessionId);
      }
    }
  }, SWEEP_INTERVAL);
}
```

**Replace `checkLeaseEnforcement`** (line 906-923) with `checkOwnership`:

```typescript
// Maps pw-* CDP clientId → the agent sessionId that created it
const pwClientToSession = new Map<string, string>();

function checkOwnership(clientId: string, cdpSessionId: string | undefined, id: number): boolean {
  if (!cdpSessionId) return true;
  const tabId = resolveTabIdFromSession(cdpSessionId);
  if (tabId == null) return true; // target has no tabId (e.g. service worker)
  const owner = tabOwners.get(tabId);
  if (!owner) return true; // unclaimed tab = open access

  // Direct CDP client match (e.g. extension WS client)
  const ownerClientId = sessionToClientId.get(owner.sessionId);
  if (ownerClientId === clientId) return true;

  // pw-* clients: only allow if explicitly registered to the owning session.
  // Registration happens in /cli/execute when the executor connects via connectOverCDP().
  // SECURITY: Do NOT allow arbitrary pw-* prefixed clients — require explicit binding.
  if (clientId.startsWith('pw-')) {
    const boundSession = pwClientToSession.get(clientId);
    if (boundSession === owner.sessionId) return true;
  }

  sendCdpError(clientId, {
    id,
    sessionId: cdpSessionId,
    error: `Tab ${tabId} is owned by session "${owner.sessionId}". Cannot operate.`,
    code: OWNERSHIP_ERROR_CODE,
  });
  return false;
}
```

> **Note on pw-client allowance**: When a `PlaywrightExecutor` connects via `chromium.connectOverCDP()`, it creates a CDP client with id `pw-<timestamp>-<random>`. This client must be explicitly registered to the owning session via `pwClientToSession.set(clientId, sessionId)`. Registration happens in `/cli/execute` (see below). **Do NOT use prefix-based allowlisting** — the `clientId` comes from the URL path and can be forged by any localhost process connecting to `/cdp/pw-fake`.

**Replace `routeCdpEvent`** (line 925-937):

```typescript
function routeCdpEvent(method: string, params: unknown, sessionId?: string): void {
  if (!sessionId) {
    broadcastToCDPClients({ method, params, sessionId });
    return;
  }
  const tabId = resolveTabIdFromSession(sessionId);
  if (tabId != null) {
    const owner = tabOwners.get(tabId);
    if (owner) {
      // Route to the owning session's CDP client
      const ownerClientId = sessionToClientId.get(owner.sessionId);
      if (ownerClientId) {
        sendToCDPClient(ownerClientId, { method, params, sessionId });
      }
      // Also route to all pw-* clients (executor connections)
      for (const [cid, client] of cdpClients) {
        if (cid.startsWith('pw-') && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ method, params, sessionId }));
        }
      }
      return;
    }
  }
  // Unclaimed tab or no tabId — broadcast to all
  broadcastToCDPClients({ method, params, sessionId });
}
```

**Replace lease-related CDP commands** in `handleServerCdpCommand` (line 644-748):

```typescript
    // -----------------------------------------------------------------------
    // Tab Ownership commands (replace Target.acquireLease / releaseLease / listLeases)
    // -----------------------------------------------------------------------

    case 'Target.claimTab': {
      const claimTabId = asNumber(params?.tabId);
      const claimSessionId = asString(params?.sessionId);
      const claimForce = !!params?.force;
      if (claimTabId == null || !claimSessionId) {
        sendCdpError(clientId, { id, sessionId, error: 'Target.claimTab requires params.tabId (number) and params.sessionId (string)' });
        return true;
      }
      const result = claimTab(claimTabId, claimSessionId, claimForce);
      if (!result.ok) {
        sendToCDPClient(clientId, {
          id, sessionId,
          error: { code: OWNERSHIP_ERROR_CODE, message: `Tab ${claimTabId} owned by ${result.owner}` },
        });
        return true;
      }
      sessionToClientId.set(claimSessionId, clientId);
      sendCdpResponse(clientId, { id, sessionId, result: { claimed: true, tabId: claimTabId } });
      return true;
    }

    case 'Target.releaseTab': {
      const releaseTabId = asNumber(params?.tabId);
      const releaseSessionId = asString(params?.sessionId);
      if (releaseTabId == null || !releaseSessionId) {
        sendCdpError(clientId, { id, sessionId, error: 'Target.releaseTab requires params.tabId and params.sessionId' });
        return true;
      }
      const released = releaseTab(releaseTabId, releaseSessionId);
      if (!released) {
        sendCdpError(clientId, { id, sessionId, error: 'Not the owner' });
        return true;
      }
      sendCdpResponse(clientId, { id, sessionId, result: { released: true } });
      return true;
    }

    case 'Target.listOwnership': {
      const ownershipList = [...tabOwners.entries()].map(([tid, o]) => ({
        tabId: tid,
        sessionId: o.sessionId,
        claimedAt: o.claimedAt,
      }));
      sendCdpResponse(clientId, { id, sessionId, result: { ownership: ownershipList } });
      return true;
    }
```

**Replace lease reference in `Target.getTargets`** (line 585-593):

```typescript
    case 'Target.getTargets': {
      const targetInfos = Array.from(attachedTargets.values()).map((target) => ({
        ...buildTargetInfo(target),
        attached: true,
        owner: target.tabId != null ? (getTabOwner(target.tabId) ?? null) : null,
      }));
      sendCdpResponse(clientId, { id, sessionId, result: { targetInfos } });
      return true;
    }
```

**Modify `/cli/execute`** (line 1106-1115) — add ownership enforcement:

```typescript
app.post('/cli/execute', async (c) => {
  try {
    const body = await c.req.json() as { sessionId: string; code: string; timeout?: number };
    const executor = relayExecutorManager.getOrCreate(body.sessionId);
    sessionActivity.set(body.sessionId, Date.now());

    // Auto-claim: if executor has no active tab, find one
    if (executor.getActiveTabId() == null) {
      for (const target of attachedTargets.values()) {
        if (target.tabId != null && !tabOwners.has(target.tabId)) {
          const claim = claimTab(target.tabId, body.sessionId);
          if (claim.ok) {
            executor.claimTab(target.tabId, target.targetInfo?.url);
            break;
          }
        }
      }
    }

    // Verify ownership of active tab
    const activeTabId = executor.getActiveTabId();
    if (activeTabId != null) {
      const owner = getTabOwner(activeTabId);
      if (owner && owner !== body.sessionId) {
        return c.json({
          text: `Tab ${activeTabId} is owned by session "${owner}". Use tab list to see available tabs.`,
          images: [], screenshots: [], isError: true,
        }, 403);
      }
    }

    // Register pw-client binding: the executor's CDP clientId is bound to this session.
    // This is checked by checkOwnership() to prevent pw-* prefix spoofing.
    const pwClientId = executor.getLastCdpClientId?.();
    if (pwClientId) {
      pwClientToSession.set(pwClientId, body.sessionId);
    }

    const result = await executor.execute(body.code, body.timeout || 10000);

    // Touch claim after successful execution (avoid re-broadcasting ownership events)
    if (activeTabId != null) touchClaim(activeTabId, body.sessionId);

    return c.json({ text: result.text, images: result.images, screenshots: result.screenshots, isError: result.isError });
  } catch (err: any) {
    return c.json({ text: err.message, images: [], screenshots: [], isError: true }, 500);
  }
});
```

**Modify `/cli/cdp`** (line 1147-1156) — add `sessionId` to request schema:

```typescript
app.post('/cli/cdp', async (c) => {
  try {
    const { method, params, sessionId, timeout } = await c.req.json() as {
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      timeout?: number;
    };
    if (!method) return c.json({ error: 'method is required' }, 400);

    if (sessionId) {
      sessionActivity.set(sessionId, Date.now());
      // Ownership check: if the command targets a specific CDP session,
      // verify the calling agent session owns that tab
      const targetCdpSession = params?.sessionId as string | undefined;
      if (targetCdpSession) {
        const tabId = resolveTabIdFromSession(targetCdpSession);
        if (tabId != null) {
          const owner = getTabOwner(tabId);
          if (owner && owner !== sessionId) {
            return c.json({ error: `Tab ${tabId} owned by session "${owner}"` }, 403);
          }
        }
      }
    }

    const result = await relaySendCdp(method, params, timeout);
    return c.json({ result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
```

**Modify `/cli/session/delete`** (line 1132-1137) — release tabs on delete:

```typescript
app.post('/cli/session/delete', async (c) => {
  const { sessionId } = await c.req.json();
  releaseAllTabs(sessionId);
  sessionActivity.delete(sessionId);
  sessionToClientId.delete(sessionId);
  const ok = await relayExecutorManager.remove(sessionId);
  if (!ok) return c.json({ error: 'Session not found' }, 404);
  return c.json({ success: true });
});
```

**Add new endpoints** (after existing `/cli/session/*` routes):

```typescript
app.post('/cli/tab/claim', async (c) => {
  const { tabId, sessionId, force } = await c.req.json();
  if (tabId == null || !sessionId) return c.json({ error: 'tabId and sessionId required' }, 400);
  const result = claimTab(tabId, sessionId, !!force);
  if (!result.ok) return c.json({ error: `Tab ${tabId} owned by ${result.owner}` }, 409);
  const executor = relayExecutorManager.get(sessionId);
  if (executor) {
    // Resolve URL from attachedTargets for Page→tabId mapping
    const url = [...attachedTargets.values()]
      .find(t => t.tabId === tabId)?.targetInfo?.url;
    executor.claimTab(tabId, url);
  }
  return c.json({ success: true });
});

app.post('/cli/tab/release', async (c) => {
  const { tabId, sessionId } = await c.req.json();
  if (tabId == null || !sessionId) return c.json({ error: 'tabId and sessionId required' }, 400);
  const released = releaseTab(tabId, sessionId);
  if (!released) return c.json({ error: 'Not the owner' }, 403);
  const executor = relayExecutorManager.get(sessionId);
  if (executor) executor.releaseTab(tabId);
  return c.json({ success: true });
});

app.post('/cli/session/activity', async (c) => {
  const { sessionId } = await c.req.json();
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  sessionActivity.set(sessionId, Date.now());
  return c.json({ success: true });
});
```

**Modify `/json/list`** (line 246-260) — replace lease info with ownership:

```typescript
app.get('/json/list', (c) => {
  const targets = Array.from(attachedTargets.values()).map((target) => {
    const targetInfo = target.targetInfo ?? {};
    return {
      id: target.sessionId,
      tabId: target.tabId,
      type: targetInfo.type ?? 'page',
      title: targetInfo.title ?? '',
      url: targetInfo.url ?? '',
      webSocketDebuggerUrl: getCdpUrl(getRelayPort(), target.sessionId),
      owner: target.tabId != null ? (getTabOwner(target.tabId) ?? null) : null,
    };
  });
  return c.json(targets);
});
```

**Modify extension connect handler** (line 1213-1215) — send ownership snapshot:

```typescript
// Change: sendLeaseSnapshotToExtension('extension-connected');
// To:
sendOwnershipSnapshotToExtension('extension-connected');
```

**Modify extension disconnect handler** (line 1221-1253) — clear ownership:

```typescript
ws.on('close', () => {
  log('Extension WebSocket disconnected');
  if (extensionWs === ws) extensionWs = null;

  // Notify all CDP clients their tabs lost ownership
  for (const [tabId, owner] of tabOwners) {
    broadcastToCDPClients({
      method: 'Target.tabReleased',
      params: { tabId, reason: 'extension-disconnected' },
    });
  }
  tabOwners.clear();
  sessionActivity.clear();
  sessionToClientId.clear();
  pwClientToSession.clear();

  // ... rest of existing cleanup (detach targets, clear pending requests) unchanged ...
});
```

**Modify CDP client disconnect handler** (line 1291-1304) — release client's tabs:

```typescript
ws.on('close', () => {
  log(`CDP WebSocket disconnected: ${clientId}`);
  const current = cdpClients.get(clientId);
  if (current?.ws === ws) {
    cdpClients.delete(clientId);
    // Clean up pw-client → session binding
    pwClientToSession.delete(clientId);
    // Find and release tabs owned by sessions using this clientId
    for (const [sid, cid] of sessionToClientId) {
      if (cid === clientId) {
        releaseAllTabs(sid);
        sessionToClientId.delete(sid);
      }
    }
  }
  // ... rest of existing cleanup (clear pending requests, checkIdleShutdown) unchanged ...
});
```

**Modify extension message handler** — handle `requestOwnershipSnapshot`:

```typescript
// Replace (line 763):
// if (message.method === 'requestLeaseSnapshot') { sendLeaseSnapshotToExtension(...) }
// With:
if (message.method === 'requestOwnershipSnapshot') {
  sendOwnershipSnapshotToExtension('requested');
  return;
}
```

**Modify `Target.attachedToTarget` handler** (line 780-840) — replace stale lease cleanup with ownership cleanup:

```typescript
// Line 787-800: When replacing stale target for same tabId, clean up ownership
// REMOVE: staleLease = tabLeases.get(existingSessionId); tabLeases.delete(...)
// ADD:
if (incomingTabId != null && tabOwners.has(incomingTabId)) {
  tabOwners.delete(incomingTabId);
  broadcastOwnershipEvent('Target.tabReleased', { tabId: incomingTabId, reason: 'target-replaced' });
  sendOwnershipSnapshotToExtension('target-replaced');
}

// Line 836-837: Replace totalLeased/totalAvailable in Target.tabAvailable event
// REMOVE: totalLeased: tabLeases.size, totalAvailable: attachedTargets.size - tabLeases.size
// ADD:
totalOwned: tabOwners.size,
totalAvailable: attachedTargets.size - tabOwners.size,
```

**Modify `Target.detachedFromTarget` handler** (line 843-864) — clean ownership on detach:

```typescript
// Line 847-861: Replace lease cleanup with ownership cleanup
const detachedTarget = attachedTargets.get(detachedSessionId);
if (detachedTarget?.tabId != null) {
  const hadOwner = tabOwners.has(detachedTarget.tabId);
  tabOwners.delete(detachedTarget.tabId);
  if (hadOwner) {
    log(`Ownership cleaned up for detached tab ${detachedTarget.tabId}`);
    broadcastOwnershipEvent('Target.tabReleased', { tabId: detachedTarget.tabId, reason: 'tab-detached' });
    sendOwnershipSnapshotToExtension('tab-detached');
  }
}
attachedTargets.delete(detachedSessionId);
```

### 3. `spawriter/src/pw-executor.ts` — Executor Binding

**Add** to `PlaywrightExecutor` class (after private fields, around line 245):

```typescript
private ownedTabIds = new Set<number>();
private activeTabId: number | null = null;
private tabIdToUrl = new Map<number, string>(); // tabId → last known URL
private lastCdpClientId: string | null = null; // set during ensureConnection()

getActiveTabId(): number | null { return this.activeTabId; }
getOwnedTabIds(): Set<number> { return this.ownedTabIds; }
getLastCdpClientId(): string | null { return this.lastCdpClientId; }

claimTab(tabId: number, url?: string): void {
  this.ownedTabIds.add(tabId);
  if (url) this.tabIdToUrl.set(tabId, url);
  if (this.activeTabId == null) this.activeTabId = tabId;
}

switchToTab(tabId: number): void {
  if (!this.ownedTabIds.has(tabId)) {
    throw new Error(`Tab ${tabId} not owned by this session. Owned: [${[...this.ownedTabIds].join(', ')}]`);
  }
  this.activeTabId = tabId;
  this.page = null; // force re-resolve on next execute
}

releaseTab(tabId: number): void {
  this.ownedTabIds.delete(tabId);
  this.tabIdToUrl.delete(tabId);
  if (this.activeTabId === tabId) {
    this.activeTabId = this.ownedTabIds.size > 0 ? [...this.ownedTabIds][0] : null;
    this.page = null;
  }
}
```

**Modify `ensureConnection()`** (line 315-358):

Add `lastCdpClientId` capture (after line 323 where `clientId` is generated):

```typescript
this.lastCdpClientId = clientId; // stored for pwClientToSession binding in relay
```

Replace lines 343-344 (`const pages = ...` through `const page = pages[0] ...`):

```typescript
const pages = context.pages().filter(p => !p.isClosed());

let page: Page;
if (this.activeTabId != null && pages.length > 1) {
  // Try to find the page matching our active tab by URL
  const targetUrl = this.tabIdToUrl.get(this.activeTabId);
  const targetPage = targetUrl
    ? pages.find(p => p.url() === targetUrl || p.url().startsWith(targetUrl))
    : undefined;
  page = targetPage ?? pages[0] ?? await context.newPage();

  if (!targetPage && targetUrl) {
    this.logger?.log(`Could not find page for tab ${this.activeTabId} (url: ${targetUrl}), using first available page`);
  }
} else {
  page = pages.length > 0 ? pages[0] : await context.newPage();
}

// Update URL mapping for tracking
if (this.activeTabId != null) {
  this.tabIdToUrl.set(this.activeTabId, page.url());
}
```

> **How Page → tabId mapping works**: When `claimTab(tabId, url)` is called (from `/cli/tab/claim` or auto-claim in `/cli/execute`), the tab's current URL is stored in `tabIdToUrl`. The relay knows the URL via `attachedTargets[sessionId].targetInfo.url`. On `ensureConnection()`, the executor matches `context.pages()` by URL. For single-tab scenarios (most common), `pages[0]` is always correct. For multi-tab, URL matching is best-effort; pages navigating away may mismatch — the caller should re-claim after navigation.

**Modify `clearConnectionState()`** (line ~1948) — preserve ownership:

```typescript
// In clearConnectionState(), do NOT clear ownedTabIds/activeTabId/tabIdToUrl.
// These are logical ownership, not connection state.
// Only clear: browser, context, page, isConnected, pagesWithListeners
```

**`ExecutorManager.get()` already exists** (`pw-executor.ts:2007`), returns `PlaywrightExecutor | null`. No changes needed.

### 4. `spawriter/src/mcp.ts` — MCP Integration

**Change `TargetListItem` interface** (line 272-279):

```typescript
interface TargetListItem {
  id: string;
  tabId?: number;
  type: string;
  title: string;
  url: string;
  owner?: string | null; // sessionId of owner, or null if unclaimed
}
```

**Architecture decision: relay is single source of truth.** The MCP process does NOT track ownership in its own executor. Instead:
- MCP calls relay HTTP endpoints (`/cli/tab/claim`, `/cli/tab/release`) for ownership operations
- MCP reads ownership state from `/json/list` (the `owner` field)
- The executor's `claimTab()` / `releaseTab()` is called to track which tab the executor should target, but the relay is authoritative

**Modify `handleTabAction`** (line 185-270):

For `case 'connect'`: After successful `requestConnectTab()`, auto-claim via relay:

```typescript
case 'connect': {
  await ensureRelayServer();
  const url = args.url as string | undefined;
  const tabId = args.tabId as number | undefined;
  const create = args.create as boolean | undefined;
  if (!url && tabId === undefined) {
    return { content: [{ type: 'text', text: formatError({ error: 'Missing required parameter', hint: 'Provide either url or tabId to identify the tab to connect' }) }], isError: true };
  }
  let result = await requestConnectTab(port, { url, tabId, create });
  if (!result.success && (result as any).error === 'Extension not connected') {
    for (let retry = 0; retry < 6; retry++) {
      await sleep(2000);
      result = await requestConnectTab(port, { url, tabId, create });
      if (result.success || (result as any).error !== 'Extension not connected') break;
    }
  }
  if (!result.success) {
    return { content: [{ type: 'text', text: formatError({ error: `Failed to connect tab: ${(result as any).error || 'Unknown error'}`, recovery: 'reset' }) }], isError: true };
  }

  // Auto-claim the connected tab — relay is the single source of truth
  let claimStatus = 'unclaimed';
  if (result.tabId != null) {
    const mySessionId = `mcp-${effectiveClientId || 'default'}`;
    try {
      const claimResp = await fetch(`http://localhost:${port}/cli/tab/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: result.tabId, sessionId: mySessionId }),
      });
      if (claimResp.ok) {
        claimStatus = 'claimed';
        const executor = await getOrCreateExecutor();
        executor.claimTab(result.tabId, url);
      } else {
        const claimErr = await claimResp.json().catch(() => ({}));
        claimStatus = `claim failed: ${(claimErr as any).error || claimResp.status}`;
      }
    } catch (e: any) {
      claimStatus = `claim failed: ${e.message}`;
    }
  }

  await sleep(500);
  const targets = await getTargets(port);
  const newTarget = targets.find(t => t.tabId === result.tabId);
  const created = result.created ? ' (newly created)' : '';
  const info = newTarget
    ? `Attached tab${created}:\n  Session: ${newTarget.id}\n  Title: ${newTarget.title}\n  URL: ${newTarget.url}\n  Ownership: ${claimStatus}`
    : `Tab attached${created} (tabId: ${result.tabId}). Ownership: ${claimStatus}. Use tab { action: "list" } to see it.`;
  return { content: [{ type: 'text', text: info }] };
}
```

For `case 'list'`: Replace lease display with ownership display:

```typescript
case 'list': {
  await ensureRelayServer();
  const targets = await getTargets(port);
  if (targets.length === 0) {
    return { content: [{ type: 'text', text: 'No tabs attached. Click the spawriter toolbar button on a Chrome tab, or use tab { action: "connect", url: "..." } to attach one.' }] };
  }
  const mySessionId = `mcp-${effectiveClientId || 'default'}`;
  const executor = await getOrCreateExecutor();
  const lines = targets.map((t, i) => {
    const markers: string[] = [];
    if (t.owner === mySessionId) {
      markers.push(t.tabId === executor.getActiveTabId() ? 'MINE ★' : 'MINE');
    } else if (t.owner) {
      markers.push(t.owner);
    } else {
      markers.push('AVAILABLE');
    }
    const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
    return `${i + 1}. [${t.id}]${tabLabel} ← ${markers.join(', ')}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
  });
  const myTabs = targets.filter(t => t.owner === mySessionId);
  const otherTabs = targets.filter(t => t.owner && t.owner !== mySessionId);
  const availableTabs = targets.filter(t => !t.owner);
  const summary = `${targets.length} tab(s), ${myTabs.length} mine, ${otherTabs.length} owned by others, ${availableTabs.length} available`;
  return { content: [{ type: 'text', text: `${summary}\n\n${lines.join('\n\n')}` }] };
}
```

For `case 'switch'`: Change from `targetId` (string) to `tabId` (number):

```typescript
case 'switch': {
  const switchTabId = args.tabId as number;
  if (!switchTabId) {
    return { content: [{ type: 'text', text: formatError({ error: 'tabId is required (number)', hint: 'Use tab { action: "list" } to see available tabs and their tabIds' }) }], isError: true };
  }
  await ensureRelayServer();
  const targets = await getTargets(port);
  const target = targets.find(t => t.tabId === switchTabId);
  if (!target) {
    const available = targets.map(t => `  tabId ${t.tabId} — ${t.url || '(no url)'}`).join('\n') || '  (none)';
    return { content: [{ type: 'text', text: formatError({ error: `Tab ${switchTabId} not found`, hint: `Available tabs:\n${available}` }) }], isError: true };
  }
  const mySessionId = `mcp-${effectiveClientId || 'default'}`;
  if (target.owner && target.owner !== mySessionId) {
    return { content: [{ type: 'text', text: formatError({ error: `Tab ${switchTabId} owned by ${target.owner}`, hint: 'You can only switch to tabs you own or unclaimed tabs' }) }], isError: true };
  }
  // Auto-claim if unclaimed — must succeed before updating local executor
  if (!target.owner) {
    try {
      const claimResp = await fetch(`http://localhost:${port}/cli/tab/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: switchTabId, sessionId: mySessionId }),
      });
      if (!claimResp.ok) {
        const claimErr = await claimResp.json().catch(() => ({}));
        return { content: [{ type: 'text', text: formatError({ error: `Failed to claim tab ${switchTabId}: ${(claimErr as any).error || claimResp.status}` }) }], isError: true };
      }
    } catch (e: any) {
      return { content: [{ type: 'text', text: formatError({ error: `Failed to claim tab ${switchTabId}: ${e.message}` }) }], isError: true };
    }
  }
  const executor = await getOrCreateExecutor();
  executor.claimTab(switchTabId, target.url);
  executor.switchToTab(switchTabId);
  return { content: [{ type: 'text', text: `Switched to tab ${switchTabId}: ${target.title || '(no title)'}\nURL: ${target.url || '(no url)'}` }] };
}
```

For `case 'release'`: Actually release via relay (currently a no-op):

```typescript
case 'release': {
  const releaseTabId = args.tabId as number | undefined;
  const mySessionId = `mcp-${effectiveClientId || 'default'}`;
  if (releaseTabId) {
    try {
      await fetch(`http://localhost:${port}/cli/tab/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: releaseTabId, sessionId: mySessionId }),
      });
    } catch {}
    const executor = await getOrCreateExecutor();
    executor.releaseTab(releaseTabId);
    return { content: [{ type: 'text', text: `Tab ${releaseTabId} released.` }] };
  }
  // Release all owned tabs
  const targets = await getTargets(port);
  let releasedCount = 0;
  for (const t of targets) {
    if (t.owner === mySessionId && t.tabId != null) {
      try {
        await fetch(`http://localhost:${port}/cli/tab/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabId: t.tabId, sessionId: mySessionId }),
        });
        releasedCount++;
      } catch {}
    }
  }
  const executor = await getOrCreateExecutor();
  for (const tabId of [...executor.getOwnedTabIds()]) {
    executor.releaseTab(tabId);
  }
  return { content: [{ type: 'text', text: `Released ${releasedCount} tab(s).` }] };
}
```

**Update MCP `tab` tool schema** (line ~370-386):

```typescript
description: `Tab management for multi-agent isolation.
- connect: Connect to a tab by URL or tabId (auto-claims ownership)
- list: List all tabs with ownership status
- switch: Switch active tab by tabId (claims if unclaimed)
- release: Release tab ownership (by tabId, or all if omitted)`,
inputSchema: {
  // ...
  properties: {
    action: { type: 'string', enum: ['connect', 'list', 'switch', 'release'], description: 'Tab action' },
    url: { type: 'string', description: 'Tab URL (for connect)' },
    create: { type: 'boolean', description: 'Create new tab if not found (for connect)' },
    tabId: { type: 'number', description: 'Chrome tab ID (for connect, switch, release)' },
    session_id: { type: 'string', description: 'Session ID for per-agent tab isolation' },
  },
  // REMOVE: targetId property
}
```

**Modify MCP `execute` handler** (~line 407): Add activity tracking:

```typescript
// Before executor.execute(), add:
const mcpSessionId = `mcp-${effectiveClientId || 'default'}`;
fetch(`http://localhost:${port}/cli/session/activity`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: mcpSessionId }),
}).catch(() => {});
```

**Modify MCP `remoteRelaySendCdp`** (~line 137): Pass `sessionId` through to `/cli/cdp` for ownership enforcement:

```typescript
async function remoteRelaySendCdp(
  method: string,
  params?: Record<string, unknown>,
  timeout?: number,
  sessionId?: string,
): Promise<unknown> {
  const port = getRelayPort();
  const mcpSessionId = sessionId || `mcp-${getEffectiveClientId() || 'default'}`;
  const resp = await fetch(`http://localhost:${port}/cli/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, timeout, sessionId: mcpSessionId }),
    signal: AbortSignal.timeout(timeout || 30000),
  });
  const json = await resp.json() as { result?: unknown; error?: string };
  if (!resp.ok || json.error) throw new Error(json.error || `CDP ${method} failed (${resp.status})`);
  return json.result;
}
```

> **Why this matters**: Without `sessionId` in the `/cli/cdp` request, the relay cannot enforce ownership — it falls back to `getActiveSessionId()` which returns the first attached target, breaking multi-agent isolation. Every code path that sends CDP commands on behalf of an agent session must include the session identity.

### 5. `spawriter/src/cli.ts` — CLI Commands

**Add `session bind <tabId>` command** after existing session commands (~line 250):

```typescript
cli.command('session bind <tabId>', 'Bind session to a specific tab')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .option('-s, --session <name>', 'Session ID (required)')
  .action(async (tabId: string, options: Record<string, unknown>) => {
    const sessionId = options.session as string;
    if (!sessionId) { console.error('Error: -s/--session is required.'); process.exit(1); }
    const port = getRelayPort();
    const response = await fetch(`http://localhost:${port}/cli/tab/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: Number(tabId), sessionId }),
    });
    const result = await response.json();
    if (response.ok) {
      console.log(`Session ${sessionId} bound to tab ${tabId}.`);
    } else {
      console.error(`Failed: ${result.error || 'Unknown error'}`);
      process.exit(1);
    }
  });
```

### 6. `extension/src/ai_bridge/bridge.js` — Extension UI

**Replace** `leaseStateBySessionId` with `tabOwnership` (line 8):

```javascript
// REMOVE: let leaseStateBySessionId = new Map();
// ADD:
let tabOwnership = new Map(); // tabId (number) → { sessionId, claimedAt }
```

**Replace `getConnectedCount()`** (line 77-79):

```javascript
function getConnectedCount() {
  return tabOwnership.size;
}
```

**Replace `isTabLeased()`** (line 89-93):

```javascript
function isTabOwned(tabId) {
  return tabOwnership.has(tabId);
}
```

**Replace `syncLeaseDrivenStates()`** (line 95-112):

```javascript
function syncOwnershipStates() {
  for (const [tabId] of attachedTabs.entries()) {
    const owned = tabOwnership.has(tabId);
    const nextState = owned ? "connected" : "idle";
    setTabState(tabId, nextState);
    markTabTitle(tabId, nextState);
  }
  updateIcons();
}
```

**Replace `applyLeaseSnapshot()`** (line 114-124):

```javascript
function applyOwnershipSnapshot(ownership) {
  tabOwnership.clear();
  if (Array.isArray(ownership)) {
    for (const entry of ownership) {
      if (entry?.tabId != null) {
        tabOwnership.set(entry.tabId, { sessionId: entry.sessionId, claimedAt: entry.claimedAt });
      }
    }
  }
  syncOwnershipStates();
}
```

**Replace all lease event handlers** (line 483-505) in `handleRelayIncoming()`:

```javascript
// REMOVE: Target.leaseSnapshot, Target.leaseAcquired, Target.leaseReleased, Target.leaseLost handlers

if (message.method === "Target.ownershipSnapshot") {
  applyOwnershipSnapshot(message?.params?.ownership || []);
  return;
}

if (message.method === "Target.tabClaimed") {
  const { tabId, sessionId, claimedAt } = message?.params || {};
  if (tabId != null) {
    tabOwnership.set(tabId, { sessionId, claimedAt });
    syncOwnershipStates();
  }
  return;
}

if (message.method === "Target.tabReleased") {
  const { tabId } = message?.params || {};
  if (tabId != null) {
    tabOwnership.delete(tabId);
    syncOwnershipStates();
  }
  return;
}
```

**Replace `emitDetachedFromTarget` lease cleanup** (line 328-329):

```javascript
// REMOVE: leaseStateBySessionId.delete(tabInfo.sessionId);
// ADD:
tabOwnership.delete(tabId);
```

**Replace `isTabLeased()` calls** (line 748, 844, 883):

All `isTabLeased(tabId)` → `isTabOwned(tabId)`.
All `leaseStateBySessionId.has(sessionId) ? "connected" : "idle"` → `tabOwnership.has(tabId) ? "connected" : "idle"`.

**Replace init() cleanup** (line 1002):

```javascript
// REMOVE: leaseStateBySessionId.clear();
// ADD:
tabOwnership.clear();
```

**Replace polling interval** (line 1009-1026):

```javascript
setInterval(async () => {
  try {
    const resp = await fetch("http://localhost:19989/json/list", { signal: AbortSignal.timeout(2000) });
    const targets = await resp.json();
    tabOwnership.clear();
    for (const target of targets) {
      if (target.owner && target.tabId != null) {
        tabOwnership.set(target.tabId, {
          sessionId: target.owner,
          claimedAt: 0,
        });
      }
    }
    syncOwnershipStates();
  } catch (_) {}
}, 5000);
```

**Replace WS reconnect handlers** (line 1034, 1075, 1084):

All `leaseStateBySessionId.clear()` → `tabOwnership.clear()`.

**Replace `requestLeaseSnapshot`** (line 1041, 1092):

All `sendMessage({ method: "requestLeaseSnapshot" })` → `sendMessage({ method: "requestOwnershipSnapshot" })`.

**Replace returned API** (line 1145):

`getConnectedCount` remains (already updated to use `tabOwnership.size`).

### 7. `spawriter/src/lease.test.ts` → `ownership.test.ts`

Rename file. Replace `createLeaseRegistry()` with `createOwnershipRegistry()`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OWNERSHIP_ERROR_CODE } from './protocol.js';

function createOwnershipRegistry() {
  const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
  const sessionActivity = new Map<string, number>();

  function claimTab(tabId: number, sessionId: string, force?: boolean) {
    const existing = tabOwners.get(tabId);
    if (existing && existing.sessionId !== sessionId) {
      if (!force) return { ok: false, owner: existing.sessionId };
    }
    tabOwners.set(tabId, { sessionId, claimedAt: Date.now() });
    sessionActivity.set(sessionId, Date.now());
    return { ok: true };
  }

  function releaseTab(tabId: number, sessionId: string) {
    const existing = tabOwners.get(tabId);
    if (!existing || existing.sessionId !== sessionId) return false;
    tabOwners.delete(tabId);
    return true;
  }

  function releaseAllTabs(sessionId: string) {
    const toRelease: number[] = [];
    for (const [tabId, o] of tabOwners) {
      if (o.sessionId === sessionId) toRelease.push(tabId);
    }
    for (const tabId of toRelease) tabOwners.delete(tabId);
    return toRelease.length;
  }

  function getTabOwner(tabId: number) {
    return tabOwners.get(tabId)?.sessionId;
  }

  function getOwnedTabs(sessionId: string) {
    return [...tabOwners.entries()]
      .filter(([, o]) => o.sessionId === sessionId)
      .map(([tabId]) => tabId);
  }

  return { tabOwners, sessionActivity, claimTab, releaseTab, releaseAllTabs, getTabOwner, getOwnedTabs };
}

describe('Tab Ownership — Claim', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should claim unclaimed tab', () => {
    const r = reg.claimTab(42, 'sw-a');
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-a');
  });

  it('should allow same session to re-claim (idempotent)', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-a');
    assert.equal(r.ok, true);
    assert.equal(reg.tabOwners.size, 1);
  });

  it('should reject claim by different session', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-b');
    assert.equal(r.ok, false);
    assert.equal(r.owner, 'sw-a');
  });

  it('should allow different sessions on different tabs', () => {
    assert.equal(reg.claimTab(42, 'sw-a').ok, true);
    assert.equal(reg.claimTab(43, 'sw-b').ok, true);
    assert.equal(reg.tabOwners.size, 2);
  });

  it('should allow one session to claim multiple tabs', () => {
    assert.equal(reg.claimTab(42, 'sw-a').ok, true);
    assert.equal(reg.claimTab(43, 'sw-a').ok, true);
    assert.deepEqual(reg.getOwnedTabs('sw-a').sort(), [42, 43]);
  });

  it('should allow force takeover of another session tab', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-b', true);
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-b');
  });
});

describe('Tab Ownership — Release', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should release owned tab', () => {
    reg.claimTab(42, 'sw-a');
    assert.equal(reg.releaseTab(42, 'sw-a'), true);
    assert.equal(reg.tabOwners.size, 0);
  });

  it('should reject release by non-owner', () => {
    reg.claimTab(42, 'sw-a');
    assert.equal(reg.releaseTab(42, 'sw-b'), false);
    assert.equal(reg.tabOwners.size, 1);
  });

  it('should release all tabs for a session', () => {
    reg.claimTab(42, 'sw-a');
    reg.claimTab(43, 'sw-a');
    reg.claimTab(44, 'sw-b');
    assert.equal(reg.releaseAllTabs('sw-a'), 2);
    assert.equal(reg.tabOwners.size, 1);
    assert.equal(reg.getTabOwner(44), 'sw-b');
  });

  it('should return 0 if session owns nothing', () => {
    assert.equal(reg.releaseAllTabs('sw-nonexistent'), 0);
  });
});

describe('Tab Ownership — Activity Tracking', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should update activity timestamp on claim', () => {
    reg.claimTab(42, 'sw-a');
    assert.ok(reg.sessionActivity.has('sw-a'));
    assert.ok(Date.now() - reg.sessionActivity.get('sw-a')! < 1000);
  });
});

// Additional tests to write during implementation (see Integration Test Plan below)
```

**Integration Test Plan** — required before merging the ownership migration:

| # | Category | Test Case | Verification |
|---|---|---|---|
| 1 | **Cross-session isolation** | Session A claims tab 42; session B tries `/cli/execute` on tab 42 | B gets 403 with ownership error |
| 2 | **Cross-session isolation** | Session A claims tab 42; session B sends CDP command targeting tab 42's CDP session | B gets `OWNERSHIP_ERROR_CODE` |
| 3 | **Auto-claim** | Session A calls `/cli/execute` with no prior claim; one unclaimed tab exists | Tab auto-claimed by A; verify `tabOwners` has entry |
| 4 | **Auto-claim** | Session A calls `/cli/execute`; all tabs are owned by others | A gets descriptive error, not silent fallback to wrong tab |
| 5 | **Force takeover** | Session A owns tab 42; session B calls `/cli/tab/claim` with `force: true` | B succeeds; A receives `Target.tabReleased` event with `reason: 'force-takeover'` |
| 6 | **TTL cleanup** | Set `SPAWRITER_CLAIM_TTL_MS=100`; session A claims tab; wait 200ms | Sweep releases tab; `tabOwners` empty; `sessionActivity` cleaned |
| 7 | **Session delete** | Session A claims 2 tabs; `POST /cli/session/delete` for A | Both tabs released; ownership snapshot sent to extension |
| 8 | **Extension disconnect** | Extension WS closes | All `tabOwners` cleared; all CDP clients get `Target.tabReleased` |
| 9 | **Tab detach** | Extension sends `Target.detachedFromTarget` for owned tab | `tabOwners` entry removed; ownership snapshot sent |
| 10 | **CDP client disconnect** | CDP WS client for session A disconnects | All tabs owned via that client released |
| 11 | **pw-client binding** | Connect with `clientId=pw-fake` without registration; target owned tab | Rejected by `checkOwnership` (not in `pwClientToSession`) |
| 12 | **pw-client binding** | `/cli/execute` registers pw-client; same client targets owned tab | Allowed by `checkOwnership` |
| 13 | **MCP claim error propagation** | Relay rejects claim (409); MCP `tab connect` | MCP returns error with claim failure detail, NOT silent success |
| 14 | **MCP claim error propagation** | Relay rejects claim (409); MCP `tab switch` | MCP returns error, local executor NOT updated |
| 15 | **Read-only bypass** | Session A does NOT own tab 42; calls `tab list` | Succeeds (exempt from ownership) |
| 16 | **Read-only bypass** | Session A does NOT own tab 42; runs `snapshot()` via `/cli/execute` with `readOnly: true` | Succeeds (exempt from ownership) |
| 17 | **Session activity** | Session A claims tab; calls `/cli/execute` 5 times | `sessionActivity` timestamp updates each time; no duplicate ownership events |
| 18 | **touchClaim vs claimTab** | Session A owns tab; `/cli/execute` completes | Only `sessionActivity` updated (touchClaim), no `Target.tabClaimed` re-broadcast |
| 19 | **`/cli/cdp` session pass-through** | MCP sends CDP via `/cli/cdp` with `sessionId`; targets tab owned by different session | Gets 403 ownership error |
| 20 | **`/cli/cdp` session pass-through** | MCP sends CDP via `/cli/cdp` without `sessionId` | Falls through to `getActiveSessionId()` (backward compat, single-agent) |
| 21 | **Orphan session cleanup** | Session has no claims and no activity for `STALE_SESSION_TTL` | `sessionActivity` and `sessionToClientId` entries removed |
| 22 | **Extension ownership snapshot** | Session A claims tab; extension sends `requestOwnershipSnapshot` | Extension receives `Target.ownershipSnapshot` with correct entries |

### 8. `spawriter/src/relay.test.ts` — Update References (818 LOC, ~150 lease references)

**Test suites requiring changes** (identified from current file):

| Suite | Lines | Change Required |
|---|---|---|
| `GET /json/list route logic` | ~217 | `lease: getLeaseInfo(...)` → `owner: getTabOwner(tabId)` in response assertions |
| `Lease enforcement on CDP commands` | ~325 | **Rename** to "Ownership enforcement on CDP commands". Replace `checkLeaseEnforcement` with `checkOwnership`. Remove `isPlaywrightClient` exemption tests. |
| `Relay-level lease operations` | ~366 | **Rename** to "Relay-level ownership operations". All `Target.acquireLease` → `Target.claimTab`, `Target.releaseLease` → `Target.releaseTab`, `Target.listLeases` → `Target.listOwnership`. Change keying from `sessionId` (string) to `tabId` (number). |
| `CDP event routing` | ~448 | Replace `tabLeases.has(sessionId)` logic with `tabOwners`-based routing via `resolveTabIdFromSession`. |
| `LEASE_ERROR_CODE` | ~565 | **Rename** to "OWNERSHIP_ERROR_CODE". Update import. |
| `Multi-agent isolation scenario` | ~583 | Replace lease acquisition/rejection with tab claim/rejection by tabId. |
| `Lease label handling` | ~651 | **Remove** this suite — labels are dropped in the new design. |

**Global replacements across the file:**
- `import { LEASE_ERROR_CODE }` → `import { OWNERSHIP_ERROR_CODE }`
- `import type { LeaseInfo }` → remove (no longer used)
- All `tabLeases` references → `tabOwners`
- All `getLeaseInfo(...)` → `getTabOwner(tabId)`
- All `sendLeaseSnapshotToExtension(...)` → `sendOwnershipSnapshotToExtension(...)`
- All `Target.leaseSnapshot` / `Target.leaseAcquired` / `Target.leaseReleased` → `Target.ownershipSnapshot` / `Target.tabClaimed` / `Target.tabReleased`

---

## TargetListItem Response Format

The `/json/list` response changes from:

```json
{ "id": "...", "tabId": 42, "url": "...", "title": "...", "lease": { "clientId": "mcp-a", "label": "agent-a" } }
```

To:

```json
{ "id": "...", "tabId": 42, "url": "...", "title": "...", "owner": "sw-abc123" }
```

Where `owner` is the sessionId that owns this tab, or `null` if unclaimed.

---

## Extension → Relay Event Protocol

| Old Event | New Event | Payload |
|---|---|---|
| `Target.leaseSnapshot` | `Target.ownershipSnapshot` | `{ ownership: [{ tabId, sessionId, claimedAt }] }` |
| `Target.leaseAcquired` | `Target.tabClaimed` | `{ tabId, sessionId, claimedAt }` |
| `Target.leaseReleased` | `Target.tabReleased` | `{ tabId, reason }` |
| `Target.leaseLost` | `Target.tabReleased` | `{ tabId, reason }` |
| `requestLeaseSnapshot` | `requestOwnershipSnapshot` | (no params) |

---

## CDP Commands

| Old Command | New Command | Params | Response |
|---|---|---|---|
| `Target.acquireLease` | `Target.claimTab` | `{ tabId: number, sessionId: string, force?: boolean }` | `{ claimed: true, tabId }` or error |
| `Target.releaseLease` | `Target.releaseTab` | `{ tabId: number, sessionId: string }` | `{ released: true }` or error |
| `Target.listLeases` | `Target.listOwnership` | (none) | `{ ownership: [{ tabId, sessionId, claimedAt }] }` |

---

## New HTTP Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/cli/tab/claim` | `{ tabId, sessionId, force? }` | `{ success: true }` or `{ error: "Tab N owned by S" }` (409) |
| POST | `/cli/tab/release` | `{ tabId, sessionId }` | `{ success: true }` or `{ error: "Not the owner" }` (403) |
| POST | `/cli/session/activity` | `{ sessionId }` | `{ success: true }` |

---

## Agent Documentation Updates

### AGENTS_MCP.md — Connection Protocol

```
1. Determine session_id (use agent transcript UUID).
2. Call tab { action: "list" } to see available tabs.
3. Call tab { action: "connect", url: "...", session_id: "..." } to claim a tab.
4. All subsequent execute calls operate on your claimed tab.
5. Call tab { action: "release", tabId: N } when done.
```

### AGENTS_CLI.md — Session Management

```bash
spawriter session new                    # create session
spawriter session bind 42 -s sw-abc123  # bind to tab 42
spawriter -s sw-abc123 -e 'page.url()'  # operates on tab 42
spawriter session delete sw-abc123      # releases all tabs
```

---

## Industry Comparison & Research Notes

### Is this the optimal practice?

**Yes.** Our design follows the industry-standard pattern for shared-browser multi-agent isolation. Here's the evidence:

**opencode-browser** (different-ai, v4.6.1) — the closest reference implementation — uses an **almost identical architecture**. Full source code audit follows:

**Core data structures** (`bin/broker.cjs`):
- `claims: Map<tabId, { sessionId, claimedAt, lastSeenAt }>` — same as our `tabOwners`, with additional `lastSeenAt` for TTL sweep
- `sessionState: Map<sessionId, { defaultTabId, lastSeenAt }>` — dual-layer tracking: per-session default tab + last activity. **Design insight: they track `defaultTabId` per session**, so a session can own many tabs but has one "default" for implicit use

**Ownership enforcement** (`broker.cjs:handleTool`, line 235-281):
- `wantsTab(toolName)` filter function — tools like `get_tabs`, `get_active_tab`, `open_tab`, `list_downloads` bypass ownership checks. **Design insight: read-only tools don't need tab ownership**
- Before every tool that `wantsTab()`: resolve tabId (from args or session default), then `checkClaim(tabId, sessionId)` rejects if different session owns it
- After execution: `touchClaim(tabId, sessionId)` updates `lastSeenAt` and auto-sets default tab

**Auto-create tab** (`broker.cjs:ensureSessionTab`, line 225-233):
- If a session's tool call needs a tab but the session has no default tab, broker calls extension `open_tab({ active: false })` to create a background tab, claims it, and sets it as default. **Design insight: auto-create, not just auto-claim existing tabs**

**`touchClaim` vs `setClaim` distinction** (`broker.cjs`, line 163-180):
- `setClaim(tabId, sessionId)` — always writes; preserves `claimedAt` from any previous claim on that tab (regardless of which session held it), only sets fresh `claimedAt` when no prior claim exists. This means a force-takeover retains the original claim timestamp.
- `touchClaim(tabId, sessionId)` — only updates `lastSeenAt` if already owned by same session, or creates new claim if unclaimed. Rejects silently if owned by different session. **Design insight: touch is safe for implicit operations**

**Force takeover** (`broker.cjs:claim_tab handler`, line 349-362):
- `{ tabId, force: true }` — if tab owned by other session and `force=true`, it clears the other session's default tab link, then overwrites claim. **Already implemented, not optional**

**Configurable TTL** (`broker.cjs`, line 30-38):
- `OPENCODE_BROWSER_CLAIM_TTL_MS` env var, default 5 minutes
- Sweep interval = `min(max(10s, TTL/2), 60s)` — self-tuning based on TTL
- `cleanupStaleClaims()` sweeps both `claims` (by `lastSeenAt`) AND `sessionState` (orphan sessions with no claims)

**Tab close auto-release** (`broker.cjs:handleTool`, line 265-278):
- When `close_tab` succeeds, broker calls `releaseClaim(tabId)` and clears session default. **Design insight: tab close must always clean up ownership**

**Session disconnect auto-release** (`broker.cjs`, line 427):
- On socket close, `releaseClaimsForSession(client.sessionId)` releases all claims AND deletes `sessionState`

**Architecture** (`Plugin <-> Broker <-> Native Host <-> Extension`):
- Plugin talks to broker over unix socket (Windows: named pipe)
- Broker is the **single source of truth for ownership** — the extension knows nothing about ownership
- Native Host is a transparent bridge (length-prefixed JSON on stdin/stdout ↔ JSON lines on socket)
- Extension executes tools via `chrome.scripting.executeScript()` and `chrome.tabs` API — no CDP at all

**browser-use** (2026 update) — uses tab locking:
- Mutating commands lock tabs, read-only commands work across any tab
- Per-session daemons with isolated browser state
- Agent registry with 5min inactivity cleanup

**Playwright MCP PR #39703** — proposed `tabId` mechanism (closed by maintainer who said "use two browsers"):
- Each tab gets a stable 6-char alphanumeric ID
- Optional `tabId` parameter on all tools
- Community strongly disagreed with closure — 24+ reactions requesting reconsideration

**Claude in Chrome** — multiple open issues (#16267, #20100, #15193) requesting tab group isolation per session. No solution shipped yet.

**Our design advantages over alternatives:**
1. **More granular than browser-use** — we track ownership per-tab, not per-session-daemon
2. **Simpler than opencode-browser** — we don't need a separate broker process (relay serves this role); we also don't need Native Host since we use WebSocket relay
3. **More powerful than opencode-browser** — we have Playwright VM (`playwright_execute`), CDP access, debugger, network interception, single-spa tools. opencode-browser is limited to `chrome.scripting.executeScript()` (isolated world, no CDP, no Playwright API)
4. **More protective than playwriter** — upstream has zero isolation, just "create your own page"
5. **Clean break, not gradual migration** — old lease protocol fully removed, no transition code

**This will be a clean-break migration, not a backward-compatible shim.** The plan:
- Remove ALL old lease types, functions, CDP commands, and events
- Replace with entirely new ownership protocol (different data model: keyed by `tabId` not `sessionId`)
- Single-agent ease is preserved via auto-claim (a UX feature, not a compatibility compromise)
- No old code paths or fallbacks will be retained

> **Current state**: The old lease system is fully operational in the codebase. This migration has not started. See [Implementation Status](#implementation-status) at the top.

**Remaining architectural limitations** (not blockers, but future improvement opportunities):
1. **URL-based Page → tabId matching** — inherent limitation of vanilla `playwright-core`. Clean fix: fork Playwright to expose `page.targetId()` (as upstream playwriter does with `@xmorse/playwright-core`)
2. **Dual ExecutorManager** — MCP and relay run separate executors. Clean fix: merge into single executor registry with the relay as the sole host, MCP as pure HTTP client
3. **`sessionToClientId` mapping** — bridges two identifier spaces (agent session vs CDP client). Clean fix: make executor connections carry the agent session ID natively

**Actionable additions** (from opencode-browser code audit — should implement):

1. **Configurable TTL via `SPAWRITER_CLAIM_TTL_MS` env var** (ref: `broker.cjs:30-38`)
   ```typescript
   const DEFAULT_STALE_TTL = 30 * 60 * 1000;
   const STALE_SESSION_TTL = (() => {
     const raw = process.env.SPAWRITER_CLAIM_TTL_MS;
     const val = Number(raw);
     return Number.isFinite(val) && val >= 0 ? val : DEFAULT_STALE_TTL;
   })();
   ```

2. **Force takeover on `claimTab`** (ref: `broker.cjs:349-362`)
   ```typescript
   function claimTab(tabId: number, sessionId: string, force?: boolean): { ok: boolean; owner?: string } {
     const existing = tabOwners.get(tabId);
     if (existing && existing.sessionId !== sessionId) {
       if (!force) return { ok: false, owner: existing.sessionId };
       // Force takeover: notify old owner
       broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'force-takeover' });
     }
     // ... rest of claim logic
   }
   ```
   Add `force?: boolean` to `/cli/tab/claim` body and `Target.claimTab` params.

3. **`touchClaim` for implicit activity** (ref: `broker.cjs:172-180`)
   Add `touchClaim()` function separate from `claimTab()`. In `/cli/execute`, after successful execution, call `touchClaim(tabId, sessionId)` instead of `claimTab()`. This updates `lastSeenAt` without re-broadcasting ownership events.
   ```typescript
   function touchClaim(tabId: number, sessionId: string): void {
     const existing = tabOwners.get(tabId);
     if (!existing || existing.sessionId !== sessionId) return;
     sessionActivity.set(sessionId, Date.now());
   }
   ```

4. **`defaultTabId` per session** (ref: `broker.cjs:108-139`)
   Track which tab is the "default" for each session, separate from the active tab concept. When a tool call omits `tabId`, use the session's default. This is different from executor's `activeTabId`: executor is per-process, default is per-session on relay.
   ```typescript
   const sessionDefaults = new Map<string, number>(); // sessionId → defaultTabId
   ```

5. **Auto-create tab when session has no tab** (ref: `broker.cjs:ensureSessionTab`, line 225-233)
   When `/cli/execute` runs for a session with no owned tabs AND no unclaimed tabs available, consider creating a new tab via extension (`chrome.tabs.create({ active: false })`). This ensures every agent session always has a usable tab.

6. **Tab close auto-releases ownership** (ref: `broker.cjs:handleTool`, line 265-278)
   In `Target.detachedFromTarget` handler, already handled (see line 509-524 of this doc). But also ensure any explicit "close tab" tool in spawriter calls `releaseTab`.

7. **Stale sweep also cleans `sessionState`** (ref: `broker.cjs:cleanupStaleClaims`, line 182-195)
   Our current sweep only checks `sessionActivity`. Should also clean up sessions that have no claims AND are stale:
   ```typescript
   // In stale session sweep, also clean up orphan sessions:
   for (const [sessionId, lastActive] of sessionActivity) {
     const ownedCount = getOwnedTabs(sessionId).length;
     if (ownedCount === 0 && now - lastActive > STALE_SESSION_TTL) {
       sessionActivity.delete(sessionId);
       sessionToClientId.delete(sessionId);
     }
   }
   ```

8. **Self-tuning sweep interval** (ref: `broker.cjs:37-38`)
   ```typescript
   const SWEEP_INTERVAL = STALE_SESSION_TTL > 0
     ? Math.min(Math.max(10000, Math.floor(STALE_SESSION_TTL / 2)), 60000)
     : 0;
   if (SWEEP_INTERVAL > 0) setInterval(sweepStaleSessions, SWEEP_INTERVAL);
   ```

### Architectural comparison: opencode-browser vs spawriter

| Aspect | opencode-browser (v4.6.1) | spawriter (this design) |
|---|---|---|
| **Communication** | Unix socket / Named pipe (broker) | WebSocket relay + HTTP API |
| **Browser control** | `chrome.scripting.executeScript()` — isolated world, no CDP | `chrome.debugger` CDP → Playwright via `connectOverCDP()` |
| **Ownership enforcement** | Broker (`handleTool` in broker.cjs) | Relay (`checkOwnership` + `/cli/execute` + `/cli/cdp`) |
| **Tab creation** | Auto-create background tab when session has no tab | Auto-claim existing unclaimed tab (no auto-create) |
| **Default tab** | `sessionState.defaultTabId` — per session on broker | `executor.activeTabId` — per executor in process |
| **Touch vs Claim** | `touchClaim()` (update `lastSeenAt` only) vs `setClaim()` | Designed: `touchClaim()` + `claimTab()` (see relay.ts section) |
| **Force takeover** | `force: true` on `claim_tab` op | Designed: `force` param on `claimTab()` and `/cli/tab/claim` |
| **TTL** | 5min default, configurable `OPENCODE_BROWSER_CLAIM_TTL_MS` | Designed: 30min default, configurable `SPAWRITER_CLAIM_TTL_MS` |
| **Sweep interval** | Self-tuning: `min(max(10s, TTL/2), 60s)` | Designed: self-tuning (same formula) |
| **Extension awareness** | Extension knows nothing about ownership | Extension receives ownership events and displays status |
| **Playwright API** | None (extension-only) or separate `agent-browser` daemon | Full Playwright VM in relay process |
| **Read-only bypass** | `get_tabs`, `get_active_tab`, `open_tab`, `list_downloads` skip ownership | `OWNERSHIP_EXEMPT_OPERATIONS` set: `tab_list`, `accessibility_snapshot`, `console_logs`, `network_log`, `dashboard_state`, `performance_metrics`, `page_content_read`, `css_inspect` |
| **Tab close** | Auto-releases ownership on `close_tab` | Must ensure `Target.detachedFromTarget` handler covers this |
| **Agent backend** | Optional headless Playwright daemon (`agent-browser`) | N/A — always uses real Chrome via extension |

**Key lessons from opencode-browser code to incorporate:**

1. **`touchClaim()` is important.** Without it, every `execute` call re-broadcasts ownership events unnecessarily. We should use `touchClaim()` in `/cli/execute` after successful execution (already added to relay.ts section above).

2. **Read-only tool bypass.** opencode-browser exempts tools that don't mutate tab state from ownership checks via `wantsTab()`. We should implement the equivalent. Concrete design:

   ```typescript
   // In relay.ts — tools/operations that do NOT require tab ownership
   const OWNERSHIP_EXEMPT_OPERATIONS = new Set([
     'tab_list',              // MCP tab { action: "list" } — read-only enumeration
     'accessibility_snapshot', // snapshot() / accessibilitySnapshot() — read-only
     'console_logs',          // consoleLogs() — read-only
     'network_log',           // networkLog() — read-only
     'dashboard_state',       // singleSpa.status() — read-only
     'performance_metrics',   // performance() — read-only
     'page_content_read',     // pageContent("get_text"/"get_metadata") — read-only
     'css_inspect',           // cssInspect() — read-only
   ]);

   // In checkOwnership(), add at the top:
   // if (operationName && OWNERSHIP_EXEMPT_OPERATIONS.has(operationName)) return true;
   ```

   For MCP tools, the exemption is at the MCP handler level: `tab { action: "list" }` never calls `/cli/tab/claim` and works without ownership. For CLI `/cli/execute`, read-only operations still require the executor to have a page, but the ownership check in the relay can be relaxed. The exact mechanism: add an optional `readOnly?: boolean` flag to the `/cli/execute` request body; when `true`, skip ownership verification but still require the tab to be attached.

3. **Auto-create vs auto-claim.** opencode-browser creates a *new* background tab when a session has no tabs. We auto-claim an *existing* unclaimed tab. Both are valid — our approach is less disruptive (no extra tabs created), but opencode-browser's guarantees every session gets a clean tab.

4. **Broker as passive middleman.** opencode-browser's extension doesn't know about ownership at all — the broker handles it. Our extension receives ownership snapshots for UI display, which is an improvement (agents can see who owns what in the extension panel).

### Upstream playwriter (v0.0.89) comparison

The upstream [remorses/playwriter](https://github.com/remorses/playwriter) has **no tab ownership/lease system**. Key differences:

| Aspect | Upstream playwriter | spawriter (this design) |
|---|---|---|
| Tab isolation | None — "shared tabs, isolated state" | Per-tab ownership with enforcement |
| MCP tools | 2 (`execute`, `reset`) | 4 (`execute`, `reset`, `single_spa`, `tab`) |
| Page selection | `pages[0]` always | `pages[0]` + URL-matching for multi-tab |
| Multi-agent advice | "Create your own page in `state`" | Explicit claim/release API |
| Playwright fork | Yes (`@xmorse/playwright-core` with `page.targetId()`) | No — uses vanilla playwright-core |
| Session management | Single executor (no session IDs) | `ExecutorManager` with named sessions |

Upstream's approach is simpler but provides no protection against tab interference. Their agents documentation says: "Sessions have isolated state but shared browser tabs. Create separate pages to avoid interference." This is the deliberate design choice — no enforcement, just conventions.

### Page → tabId mapping: known CDP relay limitation

Research confirms this is a **well-known limitation** of CDP browser extension relays (documented in openclaw issues #30426, #20434, #1998, #3111, #1935):

- `context.newCDPSession(page)` fails through extension relay because `Target.attachToBrowserTarget` is blocked by `chrome.debugger` API
- Multiple attached tabs share the same WebSocket URL (`ws://127.0.0.1:port/cdp`)
- URL-based page matching is the accepted workaround when `page.targetId()` is unavailable

Our design uses `tabIdToUrl` mapping as the resolution strategy, which aligns with community solutions. The limitation: if two owned tabs have identical URLs, the executor may target the wrong page. This is an acceptable edge case — agents should use different URLs per tab.

### Upstream's Playwright fork advantage

The upstream maintains `@xmorse/playwright-core` which adds:
- `page.targetId()` — returns the CDP target ID for a page
- `context.getExistingCDPSession(page)` — returns existing CDP session without `attachToBrowserTarget`
- Frame-level CDP access (`frameId`, `sessionId` exposed)

This makes their Page → target resolution trivial. Spawriter uses vanilla `playwright-core`, so this path is unavailable without forking. The `tabIdToUrl` approach is the correct workaround for our architecture.

### Future consideration: Playwright fork

If spawriter ever needs precise multi-tab targeting (e.g., two tabs with identical URLs), forking playwright-core to expose `page.targetId()` would be the proper solution. The upstream's fork is maintained on a `playwriter` branch and uses a lightweight build (0.1s vs upstream's 30s) with direct dependencies instead of bundling.
