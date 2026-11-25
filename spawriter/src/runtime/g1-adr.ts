/**
 * G-1 Architecture Decision Record — Feasibility experiments (F01–F07).
 *
 * Frozen decisions for the stability plan. These decisions are based on
 * the pure-logic module layer and must be validated with real Chrome/process
 * experiments before full integration (I1-I5).
 *
 * This file documents the decisions; the experiments require real runtime.
 */

// ─── ADR-001: Executor Mode ─────────────────────────────────────────────────
// Decision: per-execute Worker (one Node child process per user script execution)
// Rationale: §16.6 — only way to guarantee all async continuations terminate
// Alternative: per-session Worker (rejected — cannot prove async resource cleanup)
// Status: FROZEN by plan §16.6
export const EXECUTOR_MODE = 'per-execute' as const;

// ─── ADR-002: Transport Mode ────────────────────────────────────────────────
// Decision: WebSocket via offscreen document (Service Worker WS not persistent)
// Rationale: MV3 service worker terminates after ~30s inactivity
// Alternative: chrome.runtime.Port (may be evaluated in G-1 F03)
// Status: PENDING G-1 F03 validation
export const TRANSPORT_MODE = 'websocket-offscreen' as const;

// ─── ADR-003: State Checkpoint Contract ─────────────────────────────────────
// Decision: JSON-only checkpoint, 256KiB per session, 4MiB global
// Rationale: §16.6 — no functions, handles, circular refs, BigInt
// Status: FROZEN by plan §16.6
export const CHECKPOINT_CONTRACT = {
  maxSessionBytes: 262_144,
  maxGlobalBytes: 4_194_304,
  maxDepth: 32,
  maxNodes: 10_000,
  allowedTypes: ['null', 'boolean', 'number', 'string', 'array', 'object'] as const,
  rejectedTypes: ['undefined', 'NaN', 'Infinity', 'BigInt', 'function', 'handle', 'circular', 'accessor', 'prototype'] as const,
} as const;

// ─── ADR-004: Wire Protocol ─────────────────────────────────────────────────
// Decision: V2 envelope with generation fencing, credit-based flow control
// Rationale: §16.7 — prevents console storms, enables backpressure
// V1 compatibility: reject execution, not silently downgrade
// Status: IMPLEMENTED (wire-protocol.ts + transport.js)
export const WIRE_VERSION = 2;

// ─── ADR-005: Process Tree Supervision ──────────────────────────────────────
// Decision: Windows Job Object (kill-on-close) + POSIX process group
// Rationale: §16.6 — parent death must kill all descendants
// Status: PENDING G-1 F05 validation on Windows
export const PROCESS_TREE_METHOD = 'job-object' as const;

// ─── ADR-006: Single Instance Lock ──────────────────────────────────────────
// Decision: Lockfile with PID + nonce + start identity, stale detection
// Rationale: §8.2 — prevents duplicate Relay processes
// Status: IMPLEMENTED (instance-lock.ts)
export const INSTANCE_LOCK_METHOD = 'lockfile' as const;

// ─── ADR-007: Domain Lifecycle ──────────────────────────────────────────────
// Decision: Reference-counted domain leases with physical enable/disable
// Rationale: §7.3 — shared Runtime/AX/DOM between helpers and clients
// Status: IMPLEMENTED (domain-lease.ts + domain-state.ts)
export const DOMAIN_LIFECYCLE = 'reference-counted' as const;

// ─── Feasibility Experiments ─────────────────────────────────────────────────
// These require real Chrome and cannot be unit-tested.

export interface FeasibilityResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'blocked' | 'not_run';
  evidence?: string;
  notes?: string;
}

/**
 * F01: Worker process spawn + IPC roundtrip latency
 * Measures: cold start, warm start, IPC message roundtrip
 * Pass criteria: cold < 500ms, warm < 100ms, IPC RTT < 10ms
 */
export const F01_WORKER_LATENCY = 'F01';

/**
 * F02: State checkpoint serialize + validate + commit cycle
 * Measures: 256KiB JSON serialize, validate, CAS commit
 * Pass criteria: < 50ms for 256KiB, rejection of non-JSON types
 */
export const F02_CHECKPOINT_CYCLE = 'F02';

/**
 * F03: Transport V2 handshake + credit flow under load
 * Measures: handshake latency, credit stall recovery, 1000 msg/s
 * Pass criteria: handshake < 100ms, no message loss at 1000/s
 */
export const F03_TRANSPORT_LOAD = 'F03';

/**
 * F04: CDP command roundtrip through extension + relay
 * Measures: Page.navigate, Runtime.evaluate, screenshot latency
 * Pass criteria: evaluate < 200ms, navigate < 2s, screenshot < 3s
 */
export const F04_CDP_ROUNDTRIP = 'F04';

/**
 * F05: Process tree kill on Windows (Job Object)
 * Measures: parent death → child death, spawn → kill latency
 * Pass criteria: all descendants dead within 1s of parent exit
 */
export const F05_PROCESS_TREE = 'F05';

/**
 * F06: Instance lock contention under 20 concurrent cold starts
 * Measures: exactly 1 Relay, no orphans, no unknown PID kills
 * Pass criteria: single winner, others get EEXIST within 2s
 */
export const F06_INSTANCE_LOCK = 'F06';

/**
 * F07: Navigation state machine accuracy vs real Chrome
 * Measures: 100 navigations, state transitions match events
 * Pass criteria: 0 mismatched states, 0 stuck navigations
 */
export const F07_NAVIGATION_ACCURACY = 'F07';
