# Extension Update: Relay/CLI/MCP ↔ Extension Compatibility Audit

> Date: 2026-04-15
> Scope: `extension/src/ai_bridge/bridge.js` (sole bridge file), `extension/src/offscreen.js`
> Dependency: Requires relay.ts ownership system (see `TAB_OWNERSHIP_DESIGN.md`)
> Build: `npm run webpack-build` in `extension/` after changes, then reload extension in Chrome
> Audit method: Line-by-line comparison of relay.ts `sendToExtension` calls, `handleExtensionMessage` handlers, HTTP endpoints, and CDP command flow against bridge.js `handleRelayIncoming`, `sendMessage`, and `handleCDPCommand`.

---

## Part 1: Tab Lease → Tab Ownership Migration (DONE)

The extension's bridge.js was updated to replace the per-session lease state tracking with a per-tab ownership model. The old system tracked leases by `sessionId` (one lease per CDP session). The new system tracks ownership by `tabId` (one owner per Chrome tab), aligning with the relay's `tabOwners` Map and enabling multi-agent tab isolation.

### Data Model Change

| Aspect | Old (lease) | New (ownership) |
|---|---|---|
| Key | `sessionId` (string) | `tabId` (number) |
| Value | `{ claimedAt }` | `{ sessionId, claimedAt }` |
| Variable | `leaseStateBySessionId` | `tabOwnership` |
| Lookup | Check session → find tab | Direct `tabOwnership.has(tabId)` |

### Changed Functions

| Function | Line | Change |
|---|---|---|
| `getConnectedCount()` | 77-79 | `leaseStateBySessionId.size` → `tabOwnership.size` |
| `isTabOwned(tabId)` | 89-91 | Was `isTabLeased()`. Direct `tabOwnership.has(tabId)` |
| `syncOwnershipStates()` | 93-101 | Was `syncLeaseDrivenStates()`. Iterates `attachedTabs`, checks `tabOwnership.has(tabId)` |
| `applyOwnershipSnapshot()` | 103-113 | Was `applyLeaseSnapshot()`. Receives `{ ownership: [{ tabId, sessionId, claimedAt }] }` |
| `buildBadgeInfo(ownedCount, ...)` | 142 | Was `leaseCount`. Logic unchanged |

### Changed Event Handlers (in `handleRelayIncoming()`, line 442)

| Old Event | New Event | Line | Handler |
|---|---|---|---|
| `Target.leaseSnapshot` | `Target.ownershipSnapshot` | 470-472 | `applyOwnershipSnapshot(params.ownership)` |
| `Target.leaseAcquired` | `Target.tabClaimed` | 475-481 | `tabOwnership.set(tabId, { sessionId, claimedAt })` |
| `Target.leaseReleased` / `Target.leaseLost` | `Target.tabReleased` | 484-490 | `tabOwnership.delete(tabId)` |

### Changed Lifecycle Points

| Location | Line | Change |
|---|---|---|
| `attachTab()` | 734 | `isTabLeased(tabId)` → `isTabOwned(tabId)` |
| `resyncAttachedTabs()` | 830 | `isTabLeased(tabId)` → `isTabOwned(tabId)` |
| `emitDetachedFromTarget()` | 317 | `leaseStateBySessionId.delete(sessionId)` → `tabOwnership.delete(tabId)` |
| `init()` | 988 | `leaseStateBySessionId.clear()` → `tabOwnership.clear()` |
| Polling interval (5s `/json/list`) | 995-1010 | Reads `target.owner` field, populates `tabOwnership` |
| WS open handler | 1067-1076 | `tabOwnership.clear()`; `requestOwnershipSnapshot` |
| WS closed handler | 1058-1066 | `tabOwnership.clear()` |
| Init WS reconnect | 1017-1025 | `tabOwnership.clear()`; `requestOwnershipSnapshot` |

### Tab Title Prefix Mapping (unchanged)

| State | Prefix | Meaning |
|---|---|---|
| `connected` | 🟢 | Tab is owned by an agent session |
| `idle` | 🔵 | Tab is attached but not owned |
| `connecting` | 🟡 | Tab is in the process of attaching |
| `error` | 🔴 | Tab encountered an error |

---

## Part 2: Relay → Extension Message Compatibility

Every `sendToExtension()` call in relay.ts sends a JSON message to the extension via WebSocket. The extension receives these in `handleRelayIncoming()` (bridge.js).

### Messages relay sends to extension

| Message method | Relay source (relay.ts) | Bridge handler (bridge.js) | Status |
|---|---|---|---|
| `ping` | `setInterval` (line 1490-1495) | line 443-445: responds with `pong` | **OK** |
| `forwardCDPCommand` | `handleCDPMessage` (line 967), `relaySendCdp` (line 1070), download behavior (line 547) | line 448-453: `handleCDPCommand()` → `chrome.debugger.sendCommand()` | **OK** |
| `connectActiveTab` | `POST /connect-active-tab` (line 193) | line 456: `ensureActiveTabAttached()` | **OK** |
| `connectTabByMatch` | `POST /connect-tab` (line 234) | line 456: URL/tabId matching + tab creation | **OK** |
| `trace` | `POST /trace` (line 288) | line 463-467: `handleTraceCommand()` | **OK** |
| `Target.ownershipSnapshot` | `sendOwnershipSnapshotToExtension()` (line 133-144) | line 470-472: `applyOwnershipSnapshot()` | **OK** |
| `Target.tabClaimed` | `broadcastOwnershipEvent()` (line 146) → **CDP clients only** | line 475-481: handler exists but **never received** — relay sends to `broadcastToCDPClients`, not `sendToExtension` | **OK** (dead code, harmless) |
| `Target.tabReleased` | `broadcastOwnershipEvent()` (line 146) → **CDP clients only** | line 484-490: handler exists but **never received** — same | **OK** (dead code, harmless) |

### Messages extension sends to relay

| Message | Bridge source (bridge.js) | Relay handler (relay.ts) | Status |
|---|---|---|---|
| `pong` | line 444: response to `ping` | line 760: ignored | **OK** |
| `keepalive` | offscreen.js line 84-88: periodic 20s | line 760: ignored | **OK** |
| `requestOwnershipSnapshot` | line 1025, 1076: on init/reconnect | line 764-766: `sendOwnershipSnapshotToExtension('requested')` | **OK** |
| `log` | `sendMessage` for logging | line 769-774: `isExtensionLogMessage()` handler | **OK** |
| `forwardCDPEvent` | line 738 (attach), 321-328 (detach), debugger events | line 777-853: `isExtensionEventMessage()` → processes `Target.attachedToTarget`, `Target.detachedFromTarget`, etc. | **OK** |
| `{ id, result }` / `{ id, error }` | line 602/618: CDP command responses | line 856-884: `pendingRequests` or `pendingExtensionCmdRequests` lookup | **OK** |

---

## Part 3: HTTP Endpoint Compatibility

All relay HTTP endpoints (relay.ts) verified against extension bridge.js interactions:

| Endpoint | relay.ts line | Extension involvement | Status |
|---|---|---|---|
| `GET /json/list` | 320-334 | Extension polls every 5s (bridge.js:995-1010), reads `owner` field | **OK** |
| `POST /connect-tab` | 234-286 | Relay sends `connectTabByMatch` to extension WS | **OK** |
| `POST /connect-active-tab` | 193-232 | Relay sends `connectActiveTab` to extension WS | **OK** |
| `POST /trace` | 288-318 | Relay sends `trace` to extension WS | **OK** |
| `POST /cli/execute` | 1107-1157 | No direct extension call; Playwright CDP flows through `forwardCDPCommand` | **OK** |
| `POST /cli/tab/claim` | 1192-1204 | HTTP-only; relay updates `tabOwners`, triggers `sendOwnershipSnapshotToExtension()` | **OK** |
| `POST /cli/tab/release` | 1206-1214 | HTTP-only; same as above | **OK** |
| `POST /cli/session/activity` | 1216-1221 | HTTP-only; updates `sessionActivity` timestamp | **OK** |
| `POST /cli/cdp` | 1223-1252 | Relay calls `relaySendCdp()` → `sendToExtension({ method: 'forwardCDPCommand' })` directly | **OK** |
| `POST /cli/session/new` | 1159-1167 | No extension involvement | **OK** |
| `POST /cli/session/delete` | 1174-1182 | Calls `releaseAllTabs()` → ownership snapshot to extension | **OK** |
| `POST /cli/session/reset` | 1184-1190 | Resets executor; no direct extension call | **OK** |
| `GET /cli/sessions` | 1169-1172 | No extension involvement | **OK** |
| `POST /shutdown` | 305-309 | No extension involvement | **OK** |
| `GET /version` | 301-303 | No extension involvement | **OK** |

---

## Part 4: CDP Command Flow

### Full path (5 hops):

```
Playwright page.evaluate() / cdpSession.send()
  → Playwright CDP WS connection
    → Relay handleCDPMessage() → ownership check → sendToExtension({ method: 'forwardCDPCommand', ... })
      → Extension offscreen WS → service worker handleRelayIncoming → handleCDPCommand()
        → chrome.debugger.sendCommand({ tabId }, method, params) → Chrome DevTools Protocol
          → Response: sendMessage({ id, result }) → relay pendingRequests → Playwright WS
```

### CDP domains used by VM globals (all supported by `chrome.debugger`):

| CDP Domain | VM Globals | Extension support |
|---|---|---|
| `Runtime.evaluate` | `evaluateJs()`, `interact()`, `singleSpa.*` | **OK** |
| `Accessibility.getFullAXTree` | `snapshot()` | **OK** — in `SLOW_CDP_METHODS` (60s timeout) |
| `Page.captureScreenshot` | `screenshot()`, `screenshotWithLabels()` | **OK** — in `SLOW_CDP_METHODS` (60s timeout) |
| `Page.navigate` / `Page.reload` | `navigate()`, `ensureFreshRender()` | **OK** — in `SLOW_CDP_METHODS` (60s timeout) |
| `DOM.enable/getBoxModel/resolveNode` | `screenshotWithLabels()`, `interact()` | **OK** |
| `Input.dispatchMouseEvent/KeyEvent` | `interact()` | **OK** |
| `Network.*` (enable, cookies, conditions) | `storage()`, `emulation()` | **OK** |
| `Network.clearBrowserCache/Cookies` | `clearCacheAndReload()` | **OK** — in `SLOW_CDP_METHODS` (60s timeout) |
| `Fetch.enable/disable/fulfillRequest/continueRequest` | `networkIntercept` | **OK** |
| `Debugger.*` | `dbg`, `editor()` | **OK** |
| `Storage.getUsageAndQuota/clearDataForOrigin` | `storage()`, `clearCacheAndReload()` | **OK** |
| `Emulation.*` | `emulation()` | **OK** |
| `Performance.enable/getMetrics` | `performance()` | **OK** |

### Extension special handling:

| Feature | Code location | Purpose | Status |
|---|---|---|---|
| `SLOW_CDP_METHODS` (60s timeout) | bridge.js:498-505 | `Accessibility.getFullAXTree`, `Page.captureScreenshot`, `Network.clearBrowserCache`, `Network.clearBrowserCookies`, `Page.reload`, `Page.navigate` — these get 60s instead of 30s | **OK** |
| `DOMAINS_TO_RECYCLE` | bridge.js:583-591 | Disable→re-enable `Runtime.enable`/`Page.enable` to avoid stale state | **OK** |
| Auto re-attach on "not attached" | bridge.js:604-617 | Detects debugger detached, calls `emitDetachedFromTarget()` + `attachTab()` + retry | **OK** |
| `sendCommandWithTimeout` | bridge.js:509-537 | Promise wrapper with configurable timeout for `chrome.debugger.sendCommand` | **OK** |

---

## Part 5: Server CDP Commands (relay-intercepted, NOT forwarded to extension)

These are handled by `handleServerCdpCommand()` (relay.ts line 585-754) and never reach the extension:

| Command | relay.ts line | Extension impact |
|---|---|---|
| `Browser.getVersion` | 592-604 | None — returns spawriter version |
| `Browser.setDownloadBehavior` | 607-623 | Extension handles forwarded `Page.setDownloadBehavior` via `applyDownloadBehaviorToAllPages()` |
| `Target.setAutoAttach` | 625-631 | None — sends `Target.attachedToTarget` events to CDP clients |
| `Target.setDiscoverTargets` | 633-639 | None — sends `Target.targetCreated` events to CDP clients |
| `Target.getTargets` | 641-649 | None — returns target list with `owner` field |
| `Target.getTargetInfo` | 651-673 | None — returns single target info |
| `Target.attachToTarget` | 675-698 | None — returns sessionId |
| `Target.claimTab` | 704-723 | Triggers `sendOwnershipSnapshotToExtension()` via `claimTab()` |
| `Target.releaseTab` | 725-740 | Triggers `sendOwnershipSnapshotToExtension()` via `releaseTab()` |
| `Target.listOwnership` | 742-752 | None — returns ownership map |

---

## Part 6: Identified Gaps and Actionable Items

### 6.1 Stale title/URL in `/json/list` — FUNCTIONAL GAP

**Issue**: The relay stores tab title and URL at `Target.attachedToTarget` time and never updates them. When a user navigates to a different page, `/json/list` returns the original title/URL.

**Who is affected**:
- **MCP `tab list`** — agents see wrong titles/URLs when deciding which tab to switch to. Could cause agents to operate on the wrong tab.
- **`/json/list` HTTP endpoint** — any client polling this gets stale data.
- **Extension polling** — uses `owner` field only, not title/URL, so no impact.

**Root cause**: `attachedTargets` Map is populated once in the `Target.attachedToTarget` handler (relay.ts line 800-804, stores `targetInfo` including `title` and `url`). The `title` and `url` fields are read from this stored data by `/json/list` (relay.ts line 327-328) and `buildTargetInfo()` (relay.ts line 452-460). No subsequent update mechanism exists — relay has no `Target.targetInfoChanged` handler.

On the extension side, `chrome.tabs.onUpdated` (bridge.js line 270) fires on navigation and title changes. However, its handler only calls `updateIcons()` and `markTabTitle()` for emoji prefixes — it does NOT report the new title/URL back to the relay.

**Proposed fix** (bridge.js + relay.ts):

1. **bridge.js**: On `chrome.tabs.onUpdated` with `changeInfo.url` or `changeInfo.title`, send a new event `tabInfoChanged` to the relay:

```javascript
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  updateIcons();
  if (changeInfo.status === "complete" && attachedTabs.has(tabId)) {
    markTabTitle(tabId, getTabState(tabId));
  }
  // NEW: report title/URL changes to relay
  if (attachedTabs.has(tabId) && (changeInfo.title || changeInfo.url)) {
    sendMessage({
      method: "tabInfoChanged",
      params: {
        tabId,
        ...(changeInfo.title && { title: changeInfo.title }),
        ...(changeInfo.url && { url: changeInfo.url }),
      },
    });
  }
});
```

2. **relay.ts**: Handle `tabInfoChanged` in `handleExtensionMessage` (after line 766, before `isExtensionLogMessage` check):

```typescript
if (message.method === 'tabInfoChanged') {
  const { tabId, title, url } = (message as any).params ?? {};
  if (tabId == null) return;
  for (const [, target] of attachedTargets) {
    if (target.tabId === tabId && target.targetInfo) {
      if (title != null) target.targetInfo.title = title;
      if (url != null) target.targetInfo.url = url;
      break;
    }
  }
  return;
}
```

**Estimated effort**: ~15 LOC (bridge.js) + ~15 LOC (relay.ts).

### 6.2 `Target.tabClaimed`/`Target.tabReleased` dead handlers — COSMETIC

**Issue**: `broadcastOwnershipEvent()` in relay.ts sends to `broadcastToCDPClients()`, not `sendToExtension()`. The bridge has handlers for these events (bridge.js lines 475-490) but they are never triggered. Ownership data reaches the extension only via `Target.ownershipSnapshot`.

**Impact**: None. The snapshot path works correctly. The individual event handlers are dead code but harmless.

**Potential cleanup**: Either (a) remove the dead handlers from bridge.js, or (b) have relay also send these events to the extension for real-time updates (currently batched via snapshot). Option (a) is simpler.

### 6.3 Phase F: CDP WebSocket Session Proxy — FUTURE

**Issue**: Not yet implemented (see `docs/CDP_WEBSOCKET_PROXY.md`). When implemented, bridge.js may need changes for `Target.setAutoAttach { flatten: true }` forwarding and session-aware CDP routing.

**Impact**: None currently. Three-tier fallback works for all VM globals.

---

## Part 7: Beyond Ownership — Other Extension Gaps

Compared the full CLI/MCP/relay feature set documented in `EXECUTOR_REFACTOR_PLAN.md` and `REMAINING_WORK.md` against bridge.js. All non-ownership features are fully compatible:

| Feature | CLI/MCP path | Extension path | Compatible? |
|---|---|---|---|
| All 29+ VM globals | `/cli/execute` → Playwright CDP | `forwardCDPCommand` → `chrome.debugger` | **Yes** — all CDP domains supported |
| Three-tier CDP fallback | Direct CDP → Relay CDP → page.evaluate | Extension handles `forwardCDPCommand` regardless of origin | **Yes** |
| `relaySendCdp()` internal | Relay → `sendToExtension` directly | `handleCDPCommand()` processes it the same | **Yes** |
| Network monitoring | Playwright `page.on('request'/'response')` | No extension involvement | **Yes** |
| Network interception | Playwright `page.route()` + CDP `Fetch.*` | CDP path via `forwardCDPCommand` | **Yes** |
| ScopedFS / sandboxed require | Executor VM sandbox | No extension involvement | **Yes** |
| Warning system | Executor per-execute scope | No extension involvement | **Yes** |
| Kitty graphics | CLI terminal output | No extension involvement | **Yes** |
| Download behavior | `Browser.setDownloadBehavior` → relay → `Page.setDownloadBehavior` to each page | Extension applies via `chrome.debugger` | **Yes** |
| Tab attach/detach events | Extension → relay | Already fully handled | **Yes** |
| Trace recording | `/trace` → extension WS | `handleTraceCommand()` | **Yes** |

**Conclusion**: The only functional gap between the extension and the latest CLI/MCP is the stale title/URL issue (6.1). Everything else is fully compatible.

---

## Part 8: Files NOT Changed

| File | Reason |
|---|---|
| `extension/src/offscreen.js` | Transparent WS relay; all messages forwarded unchanged |
| `extension/src/background_script.js` | Only imports bridge.js |
| `extension/src/panel-app/*` | DevTools panel UI; no relay interaction |
| `extension/src/content_script*.js` | Content scripts; no relay interaction |
| `extension/src/content_trace.js` | Trace recording in page; no relay interaction |
| `extension/src/manifest.json` | No permission changes needed |

---

## Build & Deploy

After making changes to `bridge.js`:

```bash
cd extension
npm run webpack-build    # bundles bridge.js into build/backgroundScript.js
```

Then reload the extension in Chrome at `chrome://extensions`.

> **Critical**: Changes to `bridge.js` are NOT effective until webpack rebuilds `build/backgroundScript.js`. The extension loads the built output, not the source directly.
