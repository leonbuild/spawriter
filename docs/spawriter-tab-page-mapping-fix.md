# spawriter Tab/Page Mapping Failure Fix

> **Status: implemented and verified (2026-06-25).** All five fix plans (FP1–FP5)
> are live in `spawriter/src/{relay.ts,cli.ts,mcp.ts,runtime/control-client.ts}`,
> and the 15 regression tests plus fourteen real-relay E2E cases are landed in `relay.test.ts` / `cli.test.ts`. Full
> suite: `npm test` → 1610 pass / 0 fail; `npm run typecheck` clean. The Root
> Cause and Fix Plan sections are kept as the analysis that drove the change, with
> per-item state marked inline; the net result and the one deviation from the
> original plan are under [Implementation Status](#implementation-status).
>
> A follow-up live run against real Chrome then surfaced a sixth, page-side cause
> the relay-only analysis had missed: `No page found for owned tab N` came from
> Playwright page-to-tab matching inside the executor, not from ownership. It is
> fixed in `pw-executor.ts` and written up under
> [Live-verification root cause](#live-verification-root-cause-page-to-tab-matching).

## Problem

The wuhuncn category page is reachable over plain HTTP:

- Status: `200`
- Content-Type: `text/html; charset=UTF-8`

The observed failure is in spawriter's browser bridge, not in the target site:

- `No page found for owned tab 1842665035 after 3000ms`
- `No page found for owned tab 1842665040 after 3000ms`
- `Playwright target-registry assert (unhandledRejection); resetting executors instead of exiting`
- `OWNERSHIP BLOCKED: client=..., tabId=1842665040, owner=sw-mqt4ewx5-0y04, pwBound=mcp-mcp-11940-mqstu917::wuhuncn-category-audit`

At the time of inspection, two sessions owned tabs for the same target URL:

- `1842665035`: owned by `mcp-mcp-11940-mqstu917::wuhuncn-category-audit`
- `1842665040`: owned by `sw-mqt4ewx5-0y04`

This means the relay had split ownership across MCP and CLI flows, while Playwright target registration had already become polluted by earlier attach events.

## Root Cause

> Every root cause below is now closed; each heading names the fix plan that
> closed it. The body text stays in its original present tense as the pre-fix
> analysis.

### 1. `/connect-tab` and claim are not atomic — fixed by FP1

`/connect-tab` accepts only `url`, `tabId`, `create`, and `forceCreate`. It does not know the caller's session, so it cannot claim the tab before the extension attaches or reuses it.

Current flow:

1. MCP or CLI calls `/connect-tab`.
2. Relay asks the extension to attach or create a tab.
3. Extension emits `Target.attachedToTarget`.
4. Relay may broadcast that target while it is still unowned.
5. MCP or CLI later calls `/cli/tab/claim`.

That gap is enough for another Playwright client to see and register a target it will not own.

Relevant code:

- `spawriter/src/relay.ts`: `/connect-tab`
- `spawriter/src/cli.ts`: `tabs connect`
- `spawriter/src/mcp.ts`: `requestConnectTab`
- `spawriter/src/runtime/control-client.ts`: `connectTab`

### 2. Unbound Playwright clients can see all targets — fixed by FP2

`sendAttachedToTargetEvents()` only applies ownership filtering when `pwClientToSession.get(clientId)` has already bound the Playwright CDP client to a relay session. During early `Target.setAutoAttach` or `Target.setDiscoverTargets` replay, that binding can still be `undefined`.

In that unbound window, the `if (target.tabId != null && sessionId)` guard is skipped and the client can receive every attached target, including targets that are already owned by other sessions. This matches the real log line where `sessionToClientId=undefined` while `pwBound` points at the MCP audit session.

Once Playwright sees a target, it creates target/page registry state. If that target belongs to another session, or is later claimed by another session, the old client can still carry stale registry state. That stale registration is a direct path to target-registry asserts and later ownership blocks.

### 3. Unowned targets are visible to bound Playwright clients — fixed by FP2

Even after a Playwright client is bound, the current filters still expose unowned targets. That is fine for a tab list UI, but unsafe for Playwright execution because claim can happen after target replay.

The same risk exists in:

- live `Target.attachedToTarget` broadcast
- `sendTargetCreatedEvents()`
- `Target.getTargets`
- `Target.getTargetInfo`

### 4. Recovering from Playwright target-registry assert is incomplete — fixed by FP5

`handleRecoverableProcessError()` currently resets executors on target-registry asserts, but the relay-level state can remain dirty:

- `tabOwners`
- `attachedTargets`
- per-client `announcedTargets`
- `sessionToClientId`
- `pwClientToSession`
- `virtualBrowserSessions`
- `virtualToRealSession`
- `realToVirtualSessions`

Resetting only executors disconnects Playwright, but does not guarantee the next Playwright connection receives a clean target graph.

### 5. CLI reset, delete, and stale sweep have inconsistent cleanup semantics — fixed by FP4

MCP reset releases owned tabs and deletes relay sessions owned by that MCP process.

CLI `/cli/session/reset` only calls `executor.reset()`. It does not release tab ownership or clear relay session ownership state. `PlaywrightExecutor.clearConnectionState()` intentionally preserves logical tab ownership:

- `ownedTabIds`
- `activeTabId`
- `tabIdToUrl`

So `spawriter session reset <id>` can reconnect to the same stale owned tab and repeat `No page found for owned tab`.

There are also three different relay cleanup paths:

- `/cli/session/reset`: only resets the executor.
- `/cli/session/delete`: releases tabs, clears `sessionActivity` and `sessionToClientId`, and removes the executor, but does not clear matching `pwClientToSession` entries.
- stale session sweep: releases tabs, clears `sessionActivity`, clears `sessionToClientId`, removes matching `pwClientToSession` entries, and removes the executor.

None of these paths clear virtual session maps, so stale `virtualBrowserSessions`, `virtualToRealSession`, or `realToVirtualSessions` entries can survive a session lifecycle boundary.

## Fix Plan

### 1. Make connect and claim one relay operation — implemented

Extend `/connect-tab` to accept `sessionId`.

New request shape:

```ts
{
  url?: string;
  tabId?: number;
  create?: boolean;
  forceCreate?: boolean;
  sessionId?: string;
}
```

Required behavior:

- If `sessionId` is provided and an idle attached tab is reused, claim it before returning.
- If `sessionId` is provided and a new tab is created, claim it as soon as the tab ID is known.
- Do not broadcast that target to unrelated Playwright clients while it is in the unclaimed handoff window. This falls out of FP2 for free: an unowned page target is invisible to every client, so no separate pending-hold bookkeeping is required.
- Claim synchronously inside `/connect-tab` via `claimForSession` so the target is owned the instant its tab ID is known, then replay it to the owner (FP3). A lost claim returns `claimed: false` and writes no ownership.
- Return enough target information for executor claim:
  - `tabId`
  - `url`
  - `targetId`
  - `created`
  - `reused`

Update callers:

- `ControlClient.connectTab(opts)` should include `sessionId`.
- CLI `tabs connect` should pass `sessionId` directly to `connectTab`.
- MCP `requestConnectTab()` should pass `mySessionId`.
- Remove the separate claim-after-connect path where possible.

Keep `/cli/tab/claim` for explicit switch/bind flows, but normal connect should not need a second request.

### 2. Separate tab listing visibility from Playwright target visibility — implemented

Keep `/json/list` broad: it can show all attached tabs and owners.

For CDP/Playwright target delivery, use strict visibility:

- If a CDP client is not yet bound to a relay session, do not replay page targets to it.
- If a CDP client is bound to a relay session, it should receive only targets owned by that session.
- It should not receive targets owned by another session.
- It should not receive unowned targets.
- Playwright execution must bind `pwClientToSession` before `Target.setAutoAttach` or `Target.setDiscoverTargets` can replay page targets.

Apply this to:

- `sendAttachedToTargetEvents(clientId)`
- `sendTargetCreatedEvents(clientId)`
- live `Target.attachedToTarget` broadcast
- `Target.getTargets`
- `Target.getTargetInfo`

### 3. Replay target to the owner after claim — implemented

When `/cli/tab/claim` succeeds:

1. Store ownership with `claimTab(tabId, sessionId)`.
2. Update the relay executor with `executor.claimTab(tabId, url, targetId)`.
3. If `sessionToClientId` has a Playwright client for `sessionId`, replay the claimed target only to that client.

This avoids the current reliance on timing: a Playwright client that connects before claim should still receive the target after claim, but only if it owns it.

### 4. Add relay-level session reset — implemented

Create one helper, for example:

```ts
async function resetRelaySession(sessionId: string): Promise<void>
```

It should:

- release all tabs owned by `sessionId`
- clear `sessionActivity`
- clear `sessionToClientId`
- remove matching `pwClientToSession` entries
- reset and remove the executor
- clear virtual sessions linked to the session's targets

Use it from:

- `/cli/session/reset`
- `/cli/session/delete`
- stale session sweep

MCP reset can keep releasing all MCP-owned sessions, but should use the same relay-side primitive for consistency.

### 5. Harden target-registry assert recovery — implemented

Replace the executor-only recovery with a bridge-state recovery step.

On target-registry assert:

1. Broadcast `Target.detachedFromTarget` with `targetId` for every attached target, then clear `attachedTargets` so it is rebuilt from the extension resync.
2. Clear every CDP client's `announcedTargets`.
3. Clear virtual session maps:
   - `virtualBrowserSessions`
   - `virtualToRealSession`
   - `realToVirtualSessions`
4. Release current ownership or mark it invalid.
5. Reset all executors.
6. Request an extension resync if available. If there is no resync command, document that `spawriter relay --replace` is required after this recovery path.

Do not silently keep old ownership after this class of assertion. The registry is already known to be inconsistent.

These steps cover every dirty state from root cause 4: `announcedTargets` (step 2), the virtual session maps (step 3), `attachedTargets` (step 1, rebuilt by step 6), and `tabOwners` (step 4). `sessionToClientId` and `pwClientToSession` converge indirectly: `relayExecutorManager.resetAll()` in step 5 drops the Playwright connections, and the CDP WebSocket close handler then clears both maps and releases their tabs. If a future change stops `resetAll()` from disconnecting clients, clear `sessionToClientId` and `pwClientToSession` explicitly in this path.

This recovery is process-wide and can interrupt healthy concurrent sessions. That trade-off is acceptable only for target-registry asserts, because the assertion means Playwright's global target graph is already inconsistent. For narrower command errors, use session-local reset instead.

## Regression Tests

> All 15 are landed and green, plus fourteen real-relay E2E cases (below); full suite 1610 pass / 0 fail. Each item is
> tagged Behavioral / Source / End-to-end to match how it is actually verified,
> and names its test file. Tests 1–3 were re-specified to the implemented design
> (synchronous atomic claim, no pending-connect hold; see FP1 and Implementation
> Status).

Reuse the three harnesses already in the suite; add no new framework:

- Behavioral: pure functions from `createRelayState()` / `createOwnershipRegistry()`.
- Source invariant: `relaySource.includes(...)` / slice checks that guard structural rules.
- End-to-end: spawn the relay and drive it over a CDP WebSocket (see `behavioral: live target lifecycle over WS`).

While implementing the fix, factor the new logic into two reusable units so it is testable the same way the suite already tests `isPlaywrightTargetRegistryAssert` (exported, imported) or `routeCdpEvent` (mirrored in `createRelayState`). They also remove the duplication the fix targets:

- `isTargetVisibleToClient(tabId, boundSessionId, owner)` — the one visibility rule shared by every replay path.
- `resetRelaySession(sessionId)` — the one cleanup routine shared by every session teardown.

### Connect / claim atomicity

1. Source — `/connect-tab` accepts `sessionId` and claims via `claimForSession` on both the idle-reuse and create paths, then replays via `replayClaimedTargetToOwner` before returning. *(`relay.test.ts`)*
2. Behavioral — a created+claimed tab is visible only to its owner: after `claimTab`, `isTargetVisibleToClient` is true for the owner client and false for every other client and for an unbound client. *(`relay.test.ts`)*
3. Source — the atomic claim is all-or-nothing: a lost `claimForSession` (`if (!r.ok) return false`) writes no provisional ownership, so the original pending-hold timeout path is unnecessary. *(`relay.test.ts`)*
4. Source — `ControlClient.connectTab` includes `sessionId`; `tabs connect` forwards it and only claims as a fallback when the atomic claim was lost; `requestConnectTab` passes `mySessionId` and the `connect` case trusts `result.claimed`. *(`cli.test.ts`)*

### Playwright target visibility

5. Behavioral — `isTargetVisibleToClient(tabId, undefined, owner)` is false for every page target (unbound client during early `setAutoAttach` / `setDiscoverTargets`); browser-level targets (`tabId == null`) stay visible. *(`relay.test.ts`)*
6. Behavioral — for a bound client it is true only for its own owned targets; false for other-session-owned and for unowned. *(`relay.test.ts`)*
7. Source — `sendAttachedToTargetEvents`, `sendTargetCreatedEvents`, the live `Target.attachedToTarget` loop, `Target.getTargets`, and `Target.getTargetInfo` all go through `isTargetVisibleToClient` (definition + five call sites). *(`relay.test.ts`)*
8. End-to-end — two CDP clients bind different sessions; the owner claims the tab and receives its page target, the non-owner never does. *(`relay.test.ts`)*

### Claim replay

9. Source — `replayClaimedTargetToOwner` resolves the owner client via `sessionToClientId.get(sessionId)` and sends only to that single client. *(`relay.test.ts`)*

### Session cleanup parity

10. Source — `resetRelaySession` releases owned tabs and clears `sessionActivity`, `sessionToClientId`, matching `pwClientToSession`, the executor, and virtual session maps. *(`relay.test.ts`)*
11. Source — `/cli/session/reset`, `/cli/session/delete`, and the stale sweep all delegate to `resetRelaySession`. *(`relay.test.ts`)*
12. Behavioral — releasing a session leaves no tab owned by it while other sessions keep theirs (`createRelayState` mirror). *(`relay.test.ts`)*

### Assert-recovery state hygiene

13. Source — `resetBridgeState` clears `tabOwners`, empties `attachedTargets` for resync rebuild, clears every client's `announcedTargets`, and clears the three virtual session maps. *(`relay.test.ts`)*
14. Source — the CDP WebSocket close handler drops `pwClientToSession` and `sessionToClientId` and releases that client's tabs (the convergence relied on after `resetAll()`). *(`relay.test.ts`)*
15. Source — the recovery branch references `isPlaywrightTargetRegistryAssert`, `resetBridgeState`, and `relayExecutorManager.resetAll()`; only this branch is process-wide while ordinary command failures stay session-local. *(`relay.test.ts`)*

### Real-relay behavioral E2E

Fourteen cases boot an actual relay child and drive it over WebSockets, lifting the
relay invariants from structural to behavioral coverage (`relay.test.ts`):

- **FP1 + FP3** — a single `POST /connect-tab {create, sessionId}` returns
  `claimed: true`; the simulated extension then attaches the created tab and only
  the owner's CDP client receives it.
- **FP5** — an extension disconnect runs `resetBridgeState`; the owner receives
  both `Target.tabReleased` and a `Target.detachedFromTarget` carrying the page's
  `targetId`.
- **FP1 concurrency** — two simultaneous claims on one tab resolve to exactly one
  `200` and one `409`; ownership is single and the conflict names the real owner.
- **FP2 isolation** — two owners each attach a page target; each CDP client sees
  only its own, both on the live attach and through `Target.getTargets`.
- **CDP-session swap** — a second attach for the same `tabId` (different CDP
  session) detaches the stale `targetId` yet still replays the new target to the
  unchanged owner.
- **Release + re-claim** — an owned tab is `409` to others; after the owner
  releases it, it broadcasts `Target.tabReleased`, becomes re-claimable, and the
  new owner gets the still-attached target replayed (FP3/FP4).
- **Disconnect release** — a CDP client dropping releases the tabs it owned; an
  observer is notified and can take over (FP4 close-handler convergence).
- **Unbound window** — a CDP client with no declared session receives no page
  target but still sees browser-level targets (FP2 early `setAutoAttach` window).
- **Force-takeover** — a `force` claim takes a tab from its owner, broadcasts
  `Target.tabReleased {reason: force-takeover}` to them, and the old owner can no
  longer claim it without force.
- **Idle reuse** — with an idle unowned tab attached, `POST /connect-tab {url}`
  returns `reused: true, claimed: true` for that tab and creates nothing.
- **getTargetInfo filter** — the fifth visibility call site: an owner reads its
  own target but an other-owned `targetId` comes back as an error, not info.
- **Re-announce hygiene** — on extension resync an identical re-announce is
  deduplicated (no duplicate attach to trip CRBrowser), while a changed
  `targetId` on the same CDP session detaches the old and attaches the new.
- **Page-close detach** — an extension `Target.detachedFromTarget` is enriched
  with the page `targetId`, frees the tab (`reason: tab-detached`), and leaves it
  re-claimable.
- **Connect-time replay** — a late owner client replays its owned target on
  `setAutoAttach` (`attachedToTarget`) and `setDiscoverTargets` (`targetCreated`);
  a different session sees neither. This completes E2E coverage of all five FP2
  visibility call sites.

Extended in place, no duplication: `relay.test.ts`, `cli.test.ts`.

## Manual Recovery

> With FP1–FP5 in place the split-ownership failure should not recur on its own.
> This stays as the fastest way to clear a wedged relay (e.g. after a forced kill
> or an external Chrome crash).

When this failure appears, do not keep retrying `execute` against the same sessions. Release both conflicting tabs and restart the relay:

```powershell
spawriter tabs release 1842665035 -s "mcp-mcp-11940-mqstu917::wuhuncn-category-audit"
spawriter tabs release 1842665040 -s "sw-mqt4ewx5-0y04"
spawriter session delete "sw-mqt4ewx5-0y04"
spawriter relay --replace
```

Then use only one transport at a time for a given browser workflow; prefer MCP.

## Acceptance Criteria

The fix is complete when:

- ✅ Connecting a tab and claiming it is atomic from the relay's perspective. (FP1; tests 1–4 + real-relay E2E)
- ✅ Unbound Playwright clients receive no page target replay until they are associated with a relay session. (FP2; tests 5, 8)
- ✅ Playwright clients only see targets owned by their relay session. (FP2; tests 6, 8)
- ✅ CLI and MCP reset clear equivalent relay state. (FP4; tests 10–12)
- ✅ Target-registry assert recovery does not leave stale targets or ownership behind. (FP5; tests 13–14)
- ✅ Target-registry assert recovery is explicitly process-wide, while ordinary command failures remain session-local. (FP5; test 15)
- ✅ The wuhuncn category page can be navigated, snapshotted, and evaluated through either MCP or CLI after a fresh relay start. *(Verified live on 2026-06-25 against real Chrome — CLI `tabs connect --force-create` + `execute`, and MCP `tab connect` + `execute` on the tab that had been failing — both returned page data; navigate + snapshot + evaluate + screenshot all succeeded. This run exposed a sixth root cause, below.)*

## Implementation Status

Implemented and verified on 2026-06-25: `npm test` → 1610 pass / 0 fail,
`npm run typecheck` clean.

| Fix plan | Where it lives |
|----------|----------------|
| FP1 connect+claim atomic | `relay.ts` `/connect-tab` (`claimForSession`, `respondFor`); `runtime/control-client.ts` `connectTab`; `cli.ts` `tabs connect`; `mcp.ts` `requestConnectTab` + `connect` case |
| FP2 strict target visibility | `relay.ts` `isTargetVisibleToClient`, applied in `sendAttachedToTargetEvents`, `sendTargetCreatedEvents`, the live attach loop, `Target.getTargets`, `Target.getTargetInfo` |
| FP3 claim replay to owner | `relay.ts` `replayClaimedTargetToOwner` |
| FP4 unified session reset | `relay.ts` `resetRelaySession` + `clearVirtualSessionsForRealSession`, used by `/cli/session/reset`, `/cli/session/delete`, and the stale sweep |
| FP5 bridge-state assert recovery | `relay.ts` `resetBridgeState`, called from `handleRecoverableProcessError` and the extension-disconnect close handler |
| Page-to-tab matching (live root cause) | `pw-executor.ts` `resolvePageTargetId` (CDP `Target.getTargetInfo`) + `findPageForTab` / `findPageByUrl`; awaited by `waitForPageForTab`; `switchToTab` does sync URL best-effort |

### Deviation from the original plan

- **No pending-connect hold (original FP1 bullet, old test 3).** It is redundant:
  FP2 already makes an unowned page target invisible to every client, and
  `/connect-tab` now claims synchronously before returning, so there is no
  unclaimed replay window to guard. The claim is all-or-nothing instead.
- **CDP clients may declare their session at connect time** via
  `/cdp/<id>?session=<sid>`. This binds `pwClientToSession` before any
  `setAutoAttach` / `setDiscoverTargets` replay — the strongest form of the
  "bind before targets replay" rule — and lets the two updated E2E tests act as
  owners. Executors that bind later through `onCdpClientCreated` are unaffected.
- **Ownership is keyed by `tabId`, not by CDP session.** A CDP-session swap on
  the same tab (debugger re-attach, cross-process nav) keeps the owner; only the
  stale CDP target is detached, so strict visibility never strands the owner.

## Live-verification root cause: page-to-tab matching

The relay-side fixes (FP1–FP5) were necessary but not sufficient. A live run
against real Chrome after a fresh relay start still failed every `execute` on a
newly created tab with:

```
Error executing code: No page found for owned tab <N> after 3000ms
```

Ownership was correct — the relay claimed the tab and the owner's CDP client
received the page target. The break was one layer up, inside the per-session
`PlaywrightExecutor`: it could not map the owned `tabId` to the right Playwright
`Page`.

### Cause

`findPageForTab` matched a `Page` to a tab by reading Playwright's internal
`page._delegate._targetId`. Over a `connectOverCDP` connection the client-side
`Page` has **no `_delegate`**, so that read was always `undefined`: targetId
matching silently never fired and the code fell back to URL matching. URL
matching is ambiguous by construction — a freshly created tab is `about:blank`,
and so are others — so the executor either picked the wrong page or, when its own
page had not attached yet, found nothing and threw. The relay was healthy; the
failure was entirely in page resolution.

### Fix (`pw-executor.ts`)

- `resolvePageTargetId(page)` reads the real CDP `targetId` over a short-lived
  session — `page.context().newCDPSession(page)` → `Target.getTargetInfo` —
  instead of the unavailable `_delegate`. Results are cached in a `WeakMap`
  (a page keeps its `targetId` for life), so the extra round-trip happens at most
  once per page.
- `findPageForTab` is now async and prefers the recorded `targetId`
  (`tabIdToTargetId`, set at claim time), using `findPageByUrl` only as a
  fallback when no `targetId` was recorded or CDP is momentarily unavailable.
- `waitForPageForTab` awaits the async match; `switchToTab` stays synchronous
  with a URL best-effort and leaves the authoritative targetId match to
  `ensureConnection` → `waitForPageForTab`.

### Verified live (2026-06-25)

- CLI: `tabs connect --force-create` on a new wuhuncn tab, then `execute` →
  `{ title: '🟢 周门丛书', links: 17 }`.
- MCP: `tab connect` re-attached the exact tab that had been failing
  (`1842665089`), then `execute` succeeded; a full `navigate` + `snapshot` +
  `evaluate` + `screenshot` round all returned page data.
- Regression: `pw-executor.test.ts` exercises the matching path directly —
  `findPageForTab` targetId disambiguation of two `about:blank` pages (mocked
  `newCDPSession`) and URL fallback in three cases (no targetId recorded, no open
  page carries the targetId, CDP session unavailable); `resolvePageTargetId`
  caching + session detach; and `switchToTab` deferring to `ensureConnection`
  when URL cannot match. Full suite `npm test` → 1610 pass / 0 fail;
  `npm run typecheck` clean.
