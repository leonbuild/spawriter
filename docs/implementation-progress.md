# Spawriter MCP Stability — Implementation Progress

> Based on: `05-implementation-plan-spawriter-mcp-stability-20261125.md` V2.4
> Started: 2026-11-25
> HEAD at start: `71ca016b3385456986bebe7b94e84f71c435c2fb`

## Environment Baseline

| Item | Value |
|---|---|
| Node | v26.3.0 |
| npm | 11.16.0 |
| playwright-core | 1.59.1 (locked) |
| Windows | 10.0.26300.9974 |
| package-lock SHA256 | `5746fbd7f0ac0b3676ae3a55daf87667bbb6293c587935acea90528da00cda7c` |
| Evidence dir | `docs/evidence/baseline-20261125-161706/` |

## Work Package Status

| Work | Status | Changed Files | Test IDs | Test Pass Count | Notes |
|---|---|---|---|---|---|
| W00a/G0-S | DONE | `testing/test-isolation.ts` | T39/T71 | 11/11 | Isolated RunRoot, random port, env overrides |
| G-1 | ALL_PASS | `runtime/g1-adr.ts` + tests, `runtime/g1-chrome-experiments.test.ts` | F01–F07 all PASS | 14/14 | ADR frozen; Chrome experiments F04/F05/F06/F07 validated; console storm T01-T03 validated |
| W00b/G0 | DONE | `runtime/config-freeze.ts`, `runtime/gate-runner.ts` | T39/T40/T71 | 20/20 | Config freeze validated, gate runner G0-S→G4 PASS |
| W01 | MODULE_DONE | `ext/traffic-governor.js`, `ext/bridge.js` (integrated) | T01–03/T41–42 | 22/22 | Governor integrated into bridge.js event handler; tab cleanup on remove |
| W02 | MODULE_DONE | `ext/tab-ui-state.js` | T04/T43 | 12/12 | Coalesce, icon batch, persist debounce, marker single-flight |
| W03 | MODULE_DONE | `runtime/session-registry.ts`, `runtime/cdp-router.ts`, `runtime/bounded-logger.ts`, `runtime/pending-ledger.ts`, `runtime/event-attribution.ts`, `runtime/dirty-journal.ts` | T05–07/T44–47/T62 partial | 23+12+14+14+16=79 | Pure-logic layer complete; relay.ts wiring done (dual-write) |
| W04 | MODULE_DONE | `runtime/execution-coordinator.ts`, `runtime/state-checkpoint.ts` | T08–10/T15/T23/T48 partial | 28+16=44 | Admission, FIFO, cancel, deadline, drain, sweep + VM state checkpoint |
| W05 | MODULE_DONE | `ext/debugger-lifecycle.js`, `runtime/cancel-coordinator.ts` | T09/T12/T49/T61 partial | 13+18=31 | Single-flight attach/detach + multi-phase cancel/revoke/quarantine |
| W06 | MODULE_DONE | `runtime/runtime-control.ts`, `runtime/request-validator.ts`, `runtime/credential-store.ts` | T48/T50–51/T64/T72 partial | 19+24+17=60 | Unified control surface + request validation + credential/pairing store |
| W07 | MODULE_DONE | `runtime/domain-state.ts`, `runtime/domain-lease.ts` | T16–17/T53 partial | 20+14=34 | Context/frame lifecycle + CDP domain lease reference counting |
| W08 | MODULE_DONE | `runtime/wire-protocol.ts`, `ext/ai_bridge/transport.js` | T18–19/T42/T45/T54/T65 partial | 18+23=41 | Envelope codec, flow control, credit backpressure, extension transport V2 |
| W09 | MODULE_DONE | `runtime/navigation.ts` | T08/T14/T20–21 partial | 18/18 | Navigation state machine, timeout, network idle tracking |
| W10 | MODULE_DONE | `runtime/health.ts`, `runtime/instance-lock.ts` | T22/T56 partial | 15+11=26 | Health monitor, circuit breaker, watchdog, single-instance lock |
| W11 | DONE | `runtime/process-guard.ts`, `runtime/resource-budget.ts`, `runtime/worker-ipc.ts`, `runtime/executor-supervisor.ts`, `runtime/executor-worker.ts` | T24/T25/T57/T66/T73 partial + supervisor/worker tests | 19+15+13+10=57 | Process lifecycle + resource budget + IPC + supervisor + worker + relay wiring |
| W12 | OPTIONAL | ADR | — | — | — |
| W13 | MODULE_DONE | `ext/panel-app/import-map/refresh-coordinator.js` | T34–36 partial | 14/14 | Single-flight eval, debounce, document epoch, degraded state |

## Module Summary

| Module | File | Tests | Lines |
|---|---|---|---|
| Execution Errors | `src/runtime/execution-errors.ts` | 20 | ~230 |
| Execution Context | `src/runtime/execution-context.ts` | 24 | ~180 |
| Token Bucket | `src/runtime/token-bucket.ts` | 15 | ~140 |
| Bounded Logger | `src/runtime/bounded-logger.ts` | 15 | ~230 |
| Config | `src/runtime/config.ts` | 5 | ~290 |
| Session Registry | `src/runtime/session-registry.ts` | 23 | ~290 |
| Execution Coordinator | `src/runtime/execution-coordinator.ts` | 28 | ~310 |
| CDP Router | `src/runtime/cdp-router.ts` | 12 | ~200 |
| Health Monitor | `src/runtime/health.ts` | 15 | ~230 |
| Domain State | `src/runtime/domain-state.ts` | 20 | ~270 |
| Navigation | `src/runtime/navigation.ts` | 18 | ~240 |
| Runtime Control | `src/runtime/runtime-control.ts` | 19 | ~260 |
| Instance Lock | `src/runtime/instance-lock.ts` | 11 | ~200 |
| Process Guard | `src/runtime/process-guard.ts` | 19 | ~270 |
| Pending Ledger | `src/runtime/pending-ledger.ts` | 14 | ~260 |
| State Checkpoint | `src/runtime/state-checkpoint.ts` | 16 | ~220 |
| Event Attribution | `src/runtime/event-attribution.ts` | 14 | ~150 |
| Wire Protocol V2 | `src/runtime/wire-protocol.ts` | 18 | ~240 |
| Cancel Coordinator | `src/runtime/cancel-coordinator.ts` | 18 | ~270 |
| Domain Lease | `src/runtime/domain-lease.ts` | 14 | ~220 |
| Dirty Journal | `src/runtime/dirty-journal.ts` | 16 | ~260 |
| Resource Budget | `src/runtime/resource-budget.ts` | 15 | ~230 |
| Request Validator | `src/runtime/request-validator.ts` | 24 | ~190 |
| Credential Store | `src/runtime/credential-store.ts` | 17 | ~210 |
| Worker IPC Codec | `src/runtime/worker-ipc.ts` | 13 | ~200 |
| G-1 ADR | `src/runtime/g1-adr.ts` | 11 | ~110 |
| G-1 Chrome Experiments | `src/runtime/g1-chrome-experiments.test.ts` | 3 | ~110 |
| Relay Runtime | `src/runtime/relay-runtime.ts` | 13 | ~240 |
| Relay Bridge | `src/runtime/relay-bridge.ts` | 11+30 | ~240 |
| Test Isolation | `src/testing/test-isolation.ts` | 11 | ~160 |
| Traffic Governor (ext) | `ext/ai_bridge/traffic-governor.js` | 22 | ~220 |
| Tab UI State (ext) | `ext/ai_bridge/tab-ui-state.js` | 12 | ~260 |
| Debugger Lifecycle (ext) | `ext/ai_bridge/debugger-lifecycle.js` | 13 | ~290 |
| Transport V2 (ext) | `ext/ai_bridge/transport.js` | 23 | ~370 |
| Refresh Coordinator (ext) | `ext/panel-app/import-map/refresh-coordinator.js` | 14 | ~300 |
| Barrel Export | `src/runtime/index.ts` | — | ~230 |
| Config Freeze | `src/runtime/config-freeze.ts` | 10 | ~160 |
| Gate Runner | `src/runtime/gate-runner.ts` | 10 | ~400 |
| Executor Worker | `src/runtime/executor-worker.ts` | 4 | ~200 |
| Executor Supervisor | `src/runtime/executor-supervisor.ts` | 6 | ~280 |
| **Total new** | **41 modules** | **678+101=779** | **~9,650** |

## Test Totals

| Scope | Pass | Fail |
|---|---|---|
| spawriter (all `src/**/*.test.ts`) | 678 | 0 |
| extension (all `src/**/*.test.js` incl. panel-app) | 101 | 0 |
| **Total** | **779** | **0** |

## Wiring Status

### relay.ts Deep Wiring ✅ COMPLETE
- **RelayRuntime** instantiated via `getOrCreateRuntime()`
- **RelayBridge** wired with callbacks for broadcast/ownership/logging
- `/diagnostics` endpoint — exposes both runtime and legacy state
- `/shutdown` — wired through `runtime.startDrain()` → `runtime.close()`
- Health monitor — extension connect/disconnect, CDP forward/drop counts
- **claimTab** — dual-write to `relayBridge.claimTab()` with try/catch guard
- **releaseTab** — dual-write to `relayBridge.releaseTab()` with try/catch guard
- **checkOwnership** — dual-read from bridge `checkOwnership()`, drift logging
- **routeCdpEvent** — dual-read from bridge `shouldDeliverEvent()` for epoch attribution
- **addPendingRequest** — dual-write to `runtime.pending.register()` with correct PendingCommand interface
- CDP event forwarded/dropped — tracked through `relayBridge.recordCdpForward()`/`recordCdpDrop()`

### bridge.js Integration ✅ COMPLETE
- **TrafficGovernor** — fully integrated (prior session)
- **TabUIState** — imported, `getTabUI(tabId)` factory wired, cleanup on tab remove
- **DebuggerLifecycle** — imported, `getDebuggerLC(tabId)` factory with chrome.debugger callbacks
- **TransportV2** — imported, available for offscreen connection wiring

### offscreen.js TransportV2 Wiring ✅ COMPLETE
- TransportV2 dynamically imported with try/catch fallback
- `USE_TRANSPORT_V2` flag controls V2 vs V1 path (default: V1 for backward compat)
- WebSocket `onopen` → V2 `connectionOpened()` or V1 keepalive
- WebSocket `onmessage` → V2 `receive()` or V1 JSON parse
- WebSocket `onclose` → V2 `connectionClosed()` + reconnect
- `sendToRelay()` → V2 `send()` or V1 `ws.send()`
- `ws-transport-status` message query for V2 metrics

### G-1 ADR Experiments ✅ ALL PASS (including Chrome)
- ADR frozen decisions documented in `g1-adr.ts`
- 7 ADR decisions: executor mode, transport, checkpoint, wire protocol, process tree, instance lock, domain lifecycle
- 11 offline experiments pass: checkpoint serialization, flow control at 1000 msg/s, IPC codec, instance lock, navigation state machine
- **F04 CDP roundtrip**: PASS — evaluate max 12ms, navigate max 1675ms, screenshot p50 ~600ms
- **F05 Process tree**: PASS — parent SIGKILL dead in 556ms, child cleanup validated
- **F06 Instance lock**: PASS — 20 concurrent acquires → exactly 1 winner; stale PID reclaim works
- **F07 Navigation accuracy**: PASS — 20/20 navigations completed with correct state across 5 domains
- **T01-T03 Console storm**: PASS — browser responsive at 5ms eval latency after 2500-event storm
- Evidence: `docs/evidence/g1-chrome-experiments-20261126.json`

### Integration Tests (I1-I5) ✅ COMPLETE
- I1: Traffic/UI/Protocol — event attribution fencing, pending ledger, logger
- I2: Execution/Permission/Cancel — admission flow, cancel phases, ownership delegation, checkpoint, credentials, validation
- I3: Domain/Navigation — domain lease ref counting, tab domain state, navigation transitions
- I4: Restart/Process/Lock — process guard, resource budget, drain → admission block
- I5: Health/Diagnostics — full diagnostics snapshot, error aggregation, extension connection
- 30 integration tests, all pass

### Gate Status

| Gate | Status | Evidence |
|---|---|---|
| G0-S | ✅ PASS | Config isolation, freeze validation |
| G-1 | ✅ PASS | All 8 experiments (F01-F07, T01-T03) |
| G0 | ✅ PASS | Config freeze, RelayRuntime instantiation |
| G1 | ✅ PASS | Event attribution, pending ledger, bounded logger |
| G2 | ✅ PASS | Admission flow, cancel phases, request validator |
| G3 | ✅ PASS | Domain lease ref counting, navigation state, ownership |
| G4 | ✅ PASS | Health monitor, full diagnostics, drain blocks admission |
| G5 | ✅ PASS | Real Chrome: tab ownership, CDP evaluate, navigate, screenshot, snapshot, console, content |
| G6 | ✅ PASS | Real Chrome: state persistence, multi-step workflow, complex evaluate, error propagation, back-to-back nav |
| G7 | ✅ PASS | Real Chrome: 100/100 navigations, 0 failures, 0 timeouts, avg 1876ms, p95 3580ms |
| G8 | ✅ PASS | Real Chrome: 23/23 regression tests — MCP core, state, navigation, content, storage, single-spa, error handling |

### Worker Isolation (§9.1) ✅ COMPLETE
- **executor-worker.ts** — Per-execute child process entry point: IPC handling, sandboxed execution, state transfer, heartbeat, shutdown
- **executor-supervisor.ts** — Spawns/supervises worker processes, budget enforcement, timeout management, IPC encoding, diagnostics
- **relay.ts** — `USE_WORKER_ISOLATION=true` env var routes `/cli/execute` through ExecutorSupervisor; state round-trips via getUserState/setUserState
- **pw-executor.ts** — Added `getUserState()`/`setUserState()` for Worker isolation state handoff
- 10 tests (6 supervisor + 4 worker) all pass

### TransportV2 Default ✅ ENABLED
- **offscreen.js** — `USE_TRANSPORT_V2 = true` (was `false`); V2 is now the default wire protocol
- V2 provides credit-based flow control, envelope fencing, and backpressure
- Set `USE_TRANSPORT_V2=false` only for diagnostic fallback

### Remaining Work

✅ **ALL GATES PASS** — Core implementation complete.
✅ **Worker isolation** — executor-supervisor + executor-worker ready, relay wired.
✅ **TransportV2** — enabled as default.

Evidence files:
- `docs/evidence/g1-chrome-experiments-20261126.json` — F01-F07 + T01-T03
- `docs/evidence/g5-g7-chrome-gates-20261126.json` — G5-G7 Chrome gate tests
- `docs/evidence/g8-release-regression-20261126.json` — G8 release regression (23 tests)
