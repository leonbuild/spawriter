/**
 * Event attribution barrier — determines whether a CDP event belongs to the
 * current owner/epoch or is a stale/orphaned event from a previous generation.
 *
 * §16.7/5.2 of the stability plan. Prevents events from previous
 * transport/connection/execution epochs from being delivered to current
 * owners. Pure logic, no I/O.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EventEpochs {
  transportEpoch: number;
  connectionEpoch: number;
  executeEpoch?: number;
  leaseEpoch?: number;
}

export interface AttributionResult {
  /** Whether the event should be forwarded. */
  deliver: boolean;
  /** Why the event was dropped (if not delivered). */
  reason?: 'stale_transport' | 'stale_connection' | 'stale_execution' | 'stale_lease' | 'no_owner' | 'unknown_target';
  /** The resolved owner session ID. */
  ownerSessionId?: string;
}

export interface OwnerInfo {
  sessionId: string;
  transportEpoch: number;
  connectionEpoch: number;
  executeEpoch: number;
  leaseEpoch: number;
}

// ─── Barrier ─────────────────────────────────────────────────────────────────

export interface AttributionBarrierConfig {
  /** Whether to track stale event counts for diagnostics. */
  trackStats?: boolean;
}

export class EventAttributionBarrier {
  private readonly trackStats: boolean;

  /** Current owner info per tab. */
  private owners = new Map<number, OwnerInfo>();

  /** Statistics. */
  private _stats = {
    delivered: 0,
    staleTransport: 0,
    staleConnection: 0,
    staleExecution: 0,
    staleLease: 0,
    noOwner: 0,
    unknownTarget: 0,
  };

  constructor(config: AttributionBarrierConfig = {}) {
    this.trackStats = config.trackStats ?? true;
  }

  // ─── Owner management ──────────────────────────────────────────────────

  /**
   * Register or update the current owner for a tab.
   */
  setOwner(tabId: number, owner: OwnerInfo): void {
    this.owners.set(tabId, { ...owner });
  }

  /**
   * Remove the owner for a tab.
   */
  removeOwner(tabId: number): void {
    this.owners.delete(tabId);
  }

  /**
   * Get the current owner for a tab.
   */
  getOwner(tabId: number): OwnerInfo | undefined {
    return this.owners.get(tabId);
  }

  // ─── Attribution ───────────────────────────────────────────────────────

  /**
   * Check whether an event should be delivered to the current owner.
   *
   * @param tabId - The tab the event originates from.
   * @param eventEpochs - The epochs the event was generated under.
   * @param isCritical - Whether the event is protocol-critical (always deliver if owner matches).
   */
  check(tabId: number, eventEpochs: EventEpochs, isCritical: boolean = false): AttributionResult {
    const owner = this.owners.get(tabId);

    if (!owner) {
      // No owner — might be discovery or unowned tab.
      this._stats.noOwner++;
      return { deliver: false, reason: 'no_owner' };
    }

    // Check transport epoch.
    if (eventEpochs.transportEpoch < owner.transportEpoch) {
      this._stats.staleTransport++;
      return { deliver: false, reason: 'stale_transport', ownerSessionId: owner.sessionId };
    }

    // Check connection epoch.
    if (eventEpochs.connectionEpoch < owner.connectionEpoch) {
      this._stats.staleConnection++;
      return { deliver: false, reason: 'stale_connection', ownerSessionId: owner.sessionId };
    }

    // For non-critical events, also check execution and lease epochs.
    if (!isCritical) {
      if (eventEpochs.executeEpoch != null && eventEpochs.executeEpoch < owner.executeEpoch) {
        this._stats.staleExecution++;
        return { deliver: false, reason: 'stale_execution', ownerSessionId: owner.sessionId };
      }

      if (eventEpochs.leaseEpoch != null && eventEpochs.leaseEpoch < owner.leaseEpoch) {
        this._stats.staleLease++;
        return { deliver: false, reason: 'stale_lease', ownerSessionId: owner.sessionId };
      }
    }

    this._stats.delivered++;
    return { deliver: true, ownerSessionId: owner.sessionId };
  }

  /**
   * Check event for an unknown target (no tab mapping).
   */
  checkUnknownTarget(): AttributionResult {
    this._stats.unknownTarget++;
    return { deliver: false, reason: 'unknown_target' };
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  diagnostics(): {
    owners: number;
    stats: typeof this._stats;
  } {
    return {
      owners: this.owners.size,
      stats: { ...this._stats },
    };
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.owners.clear();
    this._stats = {
      delivered: 0,
      staleTransport: 0,
      staleConnection: 0,
      staleExecution: 0,
      staleLease: 0,
      noOwner: 0,
      unknownTarget: 0,
    };
  }
}
