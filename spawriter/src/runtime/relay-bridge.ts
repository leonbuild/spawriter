/**
 * Relay integration bridge — safe delegation layer between relay.ts and
 * the pure-logic module layer.
 *
 * relay.ts calls these bridge functions instead of manipulating global Maps
 * directly. Each function wraps the pure-logic module with relay.ts
 * side effects (broadcasting, extension communication, logging).
 *
 * Integration is incremental: relay.ts can adopt one bridge function at a
 * time without breaking existing behavior.
 */

import { RelayRuntime } from './relay-runtime.js';
import { type ExecutionIdentity } from './execution-context.js';
import { type TaskRecord } from './execution-coordinator.js';
import { type ValidationResult } from './request-validator.js';
import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BridgeCallbacks {
  /** Broadcast a CDP event to all clients. */
  broadcastCdpEvent: (method: string, params: Record<string, unknown>) => void;
  /** Send ownership snapshot to extension. */
  sendOwnershipSnapshot: (reason: string) => void;
  /** Log a message. */
  log: (msg: string) => void;
  /** Log an error. */
  error: (msg: string) => void;
}

export interface ClaimResult {
  ok: boolean;
  owner?: string;
  error?: string;
}

export interface AdmitResult {
  admitted: boolean;
  task?: TaskRecord;
  error?: string;
  errorCode?: string;
}

// ─── Bridge ──────────────────────────────────────────────────────────────────

/** Monotonic counter for execution epochs. */
let executeEpochCounter = 0;

export class RelayBridge {
  readonly runtime: RelayRuntime;
  private cb: BridgeCallbacks;

  constructor(runtime: RelayRuntime, callbacks: BridgeCallbacks) {
    this.runtime = runtime;
    this.cb = callbacks;
  }

  // ─── Tab ownership (replaces tabOwners Map) ────────────────────────

  claimTab(tabId: number, sessionId: string, force?: boolean): ClaimResult {
    // Check if another session owns this tab via registry leases.
    let existingOwner: string | undefined;
    for (const lease of this.iterLeases()) {
      if (lease.tabId === tabId && lease.sessionId !== sessionId && lease.status === 'owned') {
        existingOwner = lease.sessionId;
        break;
      }
    }

    if (existingOwner) {
      if (!force) return { ok: false, owner: existingOwner };
      this.cb.broadcastCdpEvent('Target.tabReleased', {
        tabId,
        reason: 'force-takeover',
        previousOwner: existingOwner,
      });
      this.runtime.registry.releaseLease(existingOwner, tabId);
    }

    try {
      this.runtime.registry.createLease(sessionId, tabId);
    } catch {
      // Session might not exist yet — this is OK during integration.
      // Fall through and return ok anyway; the caller manages the session.
    }

    this.cb.broadcastCdpEvent('Target.tabClaimed', {
      tabId,
      sessionId,
      claimedAt: Date.now(),
    });
    this.cb.sendOwnershipSnapshot('claim');
    return { ok: true };
  }

  releaseTab(tabId: number, sessionId: string): boolean {
    const lease = this.runtime.registry.getLease(sessionId, tabId);
    if (!lease) return false;
    this.runtime.registry.releaseLease(sessionId, tabId);
    this.cb.broadcastCdpEvent('Target.tabReleased', { tabId, reason: 'explicit-release' });
    this.cb.sendOwnershipSnapshot('release');
    return true;
  }

  releaseAllTabs(sessionId: string): number {
    const owned = this.getOwnedTabs(sessionId);
    for (const tabId of owned) {
      this.runtime.registry.releaseLease(sessionId, tabId);
      this.cb.broadcastCdpEvent('Target.tabReleased', { tabId, reason: 'session-cleanup' });
    }
    if (owned.length > 0) this.cb.sendOwnershipSnapshot('session-cleanup');
    return owned.length;
  }

  getOwnedTabs(sessionId: string): number[] {
    const tabs: number[] = [];
    for (const lease of this.iterLeases()) {
      if (lease.sessionId === sessionId && lease.status === 'owned') {
        tabs.push(lease.tabId);
      }
    }
    return tabs;
  }

  getTabOwner(tabId: number): string | undefined {
    for (const lease of this.iterLeases()) {
      if (lease.tabId === tabId && lease.status === 'owned') {
        return lease.sessionId;
      }
    }
    return undefined;
  }

  /**
   * Check if a client is allowed to operate on a tab.
   * Returns true if the operation should proceed; false if ownership blocks it.
   * Mirrors the legacy checkOwnership logic against registry leases.
   */
  checkOwnership(tabId: number, callerSessionId: string | undefined): { allowed: boolean; owner?: string } {
    const owner = this.getTabOwner(tabId);
    if (!owner) return { allowed: true };
    if (!callerSessionId) return { allowed: true };
    if (callerSessionId === owner) return { allowed: true };
    return { allowed: false, owner };
  }

  // ─── Admission (replaces ad-hoc execute flow) ──────────────────────

  /**
   * Validate and admit an execution request.
   * Returns structured result without throwing.
   */
  validateAndAdmit(params: {
    sessionId: string;
    code: string;
    timeoutMs?: number;
    requestId: string;
    principalId: string;
  }): AdmitResult {
    // Validate.
    const v = this.runtime.validator.validateExecuteRequest({
      sessionId: params.sessionId,
      code: params.code,
      timeoutMs: params.timeoutMs,
    });
    if (!v.valid) {
      return { admitted: false, error: v.error, errorCode: v.errorCode };
    }

    // Check draining.
    if (this.runtime.isDraining) {
      return { admitted: false, error: 'Relay is draining', errorCode: 'RELAY_DRAINING' };
    }

    // Build full identity.
    const epoch = ++executeEpochCounter;
    const identity: ExecutionIdentity = {
      relayInstanceId: this.runtime.instanceId,
      principalId: params.principalId,
      requestId: params.requestId,
      sessionId: params.sessionId,
      workerEpoch: 0,
      executeEpoch: epoch,
      connectionEpoch: 0,
    };

    // Admit.
    try {
      const task = this.runtime.coordinator.admit(identity, params.timeoutMs);
      this.runtime.health.recordEventForwarded();
      return { admitted: true, task };
    } catch (err: any) {
      this.runtime.health.recordExecutionError();
      return {
        admitted: false,
        error: err.message,
        errorCode: err.code ?? 'ADMISSION_FAILED',
      };
    }
  }

  // ─── Event attribution (replaces inline ownership check) ──────────

  /**
   * Check if a CDP event should be delivered (epoch/ownership barrier).
   */
  shouldDeliverEvent(
    tabId: number,
    transportEpoch: number,
    connectionEpoch: number,
  ): { deliver: boolean; ownerSessionId?: string; reason?: string } {
    return this.runtime.attribution.check(tabId, { transportEpoch, connectionEpoch });
  }

  // ─── Health ────────────────────────────────────────────────────────

  recordCdpForward(count: number = 1): void {
    this.runtime.health.recordEventForwarded(count);
  }

  recordCdpDrop(count: number = 1): void {
    this.runtime.health.recordEventDropped(count);
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  diagnostics(): Record<string, unknown> {
    return this.runtime.diagnostics() as unknown as Record<string, unknown>;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /** Iterate all leases in the registry (avoid needing getSessionLeases). */
  private *iterLeases() {
    // Access the diagnostics to get session count, then iterate.
    // The registry exposes getLease(sessionId, tabId) but not getAllLeases.
    // For the bridge we scan known sessions from diagnostics.
    const diag = this.runtime.registry.diagnostics();
    // This is a workaround — in the final integration, the registry should
    // expose an iterator. For now we use the lease map if accessible.
    yield* this.runtime.registry.allLeases();
  }
}
