# Spawriter Tab Color State Repair Plan (Audit + Test Cases)

## Goal

This document defines a deterministic tab color-state model and a repair plan for the current implementation.

User requirements translated into engineering constraints:

1. Each color maps to exactly one semantic state.
2. If a tab has a state, it must show the corresponding colored dot/prefix and icon color.
3. If a tab does not have that state, it must not show that state's dot/prefix and color.


## Scope Audited

- `ext/src/ai_bridge/bridge.js`
- `mcp/src/mcp.test.ts`
- Related behavior references:
  - `mcp/src/mcp.ts` (`acquireLease`, `releaseLease`, `setTabTitlePrefix`)
  - `mcp/src/relay.ts` (lease protocol events)

## Implementation Status (Now)

Implemented in this round:

- `bridge.js`
  - Added lease-aware state reconciliation (`applyLeaseSnapshot`, `syncLeaseDrivenStates`).
  - Added relay message handlers for `Target.leaseSnapshot`, `Target.leaseAcquired`, `Target.leaseReleased`, `Target.leaseLost`.
  - Removed forced green behavior on attach/open; attached tabs default to blue until lease is present.
  - Added lease snapshot pull on reconnect (`requestLeaseSnapshot`).
  - Updated toggle behavior so attached-idle tabs can disconnect correctly.
- `relay.ts`
  - Added lease snapshot push channel (`Target.leaseSnapshot`) for extension.
  - Emit lease updates to extension on acquire/release/lost and on extension connect.
  - Added extension-side snapshot request handling (`requestLeaseSnapshot`).
- `mcp.test.ts`
  - Replaced weak "attach is green" expectation with lease-aware transition expectations (blue before lease, green with lease, blue after release).

Verification results:

- `npx tsx --test src/mcp.test.ts` -> pass (`961` tests, `0` fail)
- `npx tsx --test src/relay.test.ts` -> pass (`46` tests, `0` fail)


## Audit Conclusion

Current modification does **not** fix the original issue ("green should mean agent actively using the tab via lease").

### Finding A (High): Bridge still has no lease-awareness

`bridge.js` icon/title rendering uses local `tabStates` only (`connected/connecting/error/idle`) and does not consume lease events/states.

```384:412:ext/src/ai_bridge/bridge.js
  function handleRelayIncoming(message) {
    if (message.method === "ping") { ... }
    if (message.method === "forwardCDPCommand") { ... }
    if (message.method === "connectActiveTab" || message.method === "connectTabByMatch") { ... }
    if (message.method === "trace") { ... }
    error("Unknown message from relay:", message);
  }
```

No lease event handling (`leaseAcquired/released/lost`) is present in bridge.

### Finding B (High): New change forces green in non-lease states

Current patch sets attached tabs directly to `connected` and green prefix at attach and ws-open recovery.

```646:665:ext/src/ai_bridge/bridge.js
    setTabState(tabId, "connected");
    ...
    markTabTitle(tabId, "connected");
    updateIcons();
```

```929:933:ext/src/ai_bridge/bridge.js
        if (message.state === "open") {
          for (const [tabId, info] of attachedTabs.entries()) {
            setTabState(tabId, "connected");
            markTabTitle(tabId, "connected");
          }
```

This violates "green == actively in-use by agent lease" because it turns green on generic attachment/reconnect.

### Finding C (Medium): `onUpdated` now preserves local connected state and can overwrite lease-intended blue

```215:219:ext/src/ai_bridge/bridge.js
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      updateIcons();
      if (changeInfo.status === "complete" && attachedTabs.has(tabId)) {
        markTabTitle(tabId, getTabState(tabId));
      }
    });
```

If `tabState` is `connected`, reload completion re-applies green, even if MCP-side lease was released and title should be blue.

### Finding D (Medium): Test change is tautological and does not validate runtime behavior

```9330:9337:mcp/src/mcp.test.ts
  it('bridge attachTab should set connected (green)', () => {
    const bridgeAttachState = "connected";
    const TAB_TITLE_PREFIXES: Record<string, string> = {
      connected: "🟢 ", idle: "🔵 ", connecting: "🟡 ", error: "🔴 ",
    };
    assert.equal(TAB_TITLE_PREFIXES[bridgeAttachState], '🟢 ');
  });
```

This only asserts a local constant mapping and cannot detect real lease/state regressions.


## Canonical Color-State Model (Required)

Use one canonical visual state per tab:

| State ID | Meaning | Dot/Prefix | Icon Color | Source of Truth |
|---|---|---|---|---|
| `DETACHED` | Not attached by spawriter | none | idle/default | `attachedTabs` absence |
| `ATTACHED_IDLE` | Attached, no active lease | blue (`🔵`) | blue/default-attached style | lease state = none |
| `ATTACHED_IN_USE` | Attached, lease held by agent | green (`🟢`) | green | lease state = held |
| `CONNECTING` | Attaching/reconnecting | yellow (`🟡`) | yellow/gray with connecting badge | bridge transition |
| `ERROR` | Attach/CDP error | red (`🔴`) | red/gray error badge | bridge transition |

Hard invariants:

1. `ATTACHED_IN_USE` must be shown **only** when lease is held.
2. Any attached state (`ATTACHED_IDLE`, `ATTACHED_IN_USE`, `CONNECTING`, `ERROR`) must show corresponding prefix and icon color.
3. `DETACHED` must have no colored prefix.
4. No tab may display two state colors simultaneously.

### Guarantee statement (what must be true)

To match your requirement precisely:

- **Agent lease is active -> must be green (`🟢`)**.
- **Agent lease is released/cancelled -> must be blue (`🔵`)**.
- **No lease state -> must not be green**.

This guarantee is enforceable only when visual state is derived from lease truth, not from generic "attached/connected" transport state.


## Comprehensive Audit Checklist

Current code status against guarantee requirements:

| Area | Requirement | Current Status | Result |
|---|---|---|---|
| Bridge state source | Green/blue derived from lease | Derived from `tabStates` (`connected`) | **Fail** |
| Bridge event input | Receives lease acquire/release/lost | No lease message handling in `handleRelayIncoming` | **Fail** |
| Attach transition | Attach without lease should be blue | Current patch writes connected/green on attach | **Fail** |
| WS reconnect | Reconcile by actual leases | Current patch sets all attached to green | **Fail** |
| Reload stability | Reload must not corrupt lease color | `onUpdated` writes raw local state | **Fail** |
| Test quality | Behavior-based transition assertions | Tautological constant assertions | **Fail** |

Summary: the code currently cannot guarantee "lease active = green, release = blue".


## Repair Design

### 1) Bridge state model split

In `bridge.js`, split "transport attach" and "lease use":

- Keep attach lifecycle state: `connecting/error/detached`.
- Add lease map keyed by `sessionId` or `tabId`:
  - `leaseStateByTabId: Map<number, "leased" | "unleased">`
- Derive visual state through a single function:
  - `computeVisualState(tabId): DETACHED | ATTACHED_IDLE | ATTACHED_IN_USE | CONNECTING | ERROR`

### 2) Lease event propagation into bridge

Add handling in `handleRelayIncoming` for lease events:

- `Target.leaseAcquired`
- `Target.leaseReleased`
- `Target.leaseLost`
- Optional bootstrap: request `Target.listLeases` after ws-open and reconcile all attached tabs.

Guarantee implementation detail:

1. Build a `leaseStateBySessionId` map from these events.
2. Build tab visual state from `(attachedState, leaseState)` with deterministic precedence.
3. On any uncertainty (missing/late lease info), default attached tabs to blue (safe fallback), never green.

### 3) Stop forcing green on attach/open

Replace current forced green transitions:

- `attachTab`: set attached base state, but visual should be `ATTACHED_IDLE` unless lease acquired event arrives.
- `ws-state-change: open`: restore attachment, then reconcile leases; do not set all attached tabs to green.
- `tabs.onUpdated complete`: call `markTabTitle(tabId, stateFromComputeVisualState)` (not raw `getTabState`).

### 4) Align MCP and bridge semantics

`mcp.ts` already uses green on acquire and blue on release:

```1892:1894:mcp/src/mcp.ts
      const session = await ensureSession(releaseSessionId);
      await setTabTitlePrefix(session, '🔵 ');
      await releaseLease(session, targetId);
```

Bridge must not overwrite this with stale local `connected`.


## Test Plan (Required)

### A. Replace weak tests in `mcp/src/mcp.test.ts`

Current constant-only tests should be replaced with behavior tests that exercise state transitions.

#### Test Case Matrix

1. **Attach without lease**
   - Given tab attached, no lease.
   - Expect visual state = `ATTACHED_IDLE`, prefix blue, not green.

2. **Acquire lease**
   - Given attached tab, receive `leaseAcquired`.
   - Expect transition blue -> green.

3. **Release lease**
   - Given leased tab, receive `leaseReleased`.
   - Expect transition green -> blue.

4. **Lease lost**
   - Given leased tab, receive `leaseLost`.
   - Expect transition green -> blue (or detached if session invalidated by design).

5. **WS reconnect reconciliation**
   - Given multiple attached tabs, mixed leases.
   - On ws-open + lease sync, expect each tab correct color by lease.

6. **Tab reload does not corrupt lease color**
   - Given leased tab, trigger `tabs.onUpdated complete`.
   - Expect still green.
   - Given unleased attached tab, same flow -> stays blue.

7. **Error state isolation**
   - Given attach error, show red.
   - On successful reattach and no lease -> blue.

8. **Detached cleanup**
   - Given detached tab, no prefix/color remains.

9. **No lease event fallback**
   - Given attached tab and no lease events yet.
   - Must default to blue, never green.

10. **Multi-tab no bleed**
    - Lease change on tab A must not change tab B color.

### B. Integration tests (relay + bridge contract)

Add/extend tests to validate:

- `Target.acquireLease` emits event consumable by bridge state.
- `Target.releaseLease`/`Target.leaseLost` propagate and are reflected.
- Bridge event handling updates icon/title deterministically.
- Out-of-order event handling still converges after `Target.listLeases` reconciliation.
- WS reconnect after event loss still converges to correct green/blue mapping.

### C. Manual verification script

1. Attach tab via extension click -> blue.
2. `connect_tab` + `switch_tab` active agent lease -> green.
3. `release_tab` -> blue.
4. Close tab / detach -> no prefix.
5. Reopen/reload tab with mixed lease ownership -> colors remain correct.


## Acceptance Criteria

A fix is accepted only if:

1. Green appears only when lease is held.
2. Attached-but-unleased always shows blue.
3. Detached shows no state color/prefix.
4. Automated tests cover all transitions above and fail on regression.
5. No tautological tests (constant assertions without exercising runtime logic).
6. Reconnect/reload race conditions still satisfy "lease active = green, released = blue".


## Recommended Implementation Order

1. Introduce `computeVisualState` and migrate `updateIcons` + `markTabTitle` to use it.
2. Add lease event handling in bridge + ws-open lease reconciliation.
3. Remove forced green writes on attach/ws-open.
4. Replace weak tests with transition-driven tests.
5. Run full `mcp.test.ts` and extension-specific state tests.

