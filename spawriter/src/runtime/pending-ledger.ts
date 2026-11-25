/**
 * Pending command ledger — tracks in-flight CDP commands with deadlines,
 * epoch validation, and bounded capacity.
 *
 * §5.3 of the stability plan. Each pending command has an owner
 * (session, client, epoch), a deadline, and state (queued/sent).
 * Late responses produce tombstones rather than resolving new requests.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingCommand {
  /** Relay-assigned sequential ID. */
  relayId: number;
  /** Original request ID from the caller. */
  requestId: string;
  /** Client that sent the command. */
  clientId: string;
  /** Client's message ID for response matching. */
  clientMessageId: number;
  /** Physical CDP session the command targets. */
  realSessionId: string;
  /** Destination session ID (may be virtual). */
  destinationSessionId?: string;
  /** Owning session. */
  sessionId: string;
  /** Epochs for epoch-based gating. */
  leaseEpoch: number;
  connectionEpoch: number;
  transportEpoch: number;
  executeEpoch: number;
  /** CDP method. */
  method: string;
  /** Monotonic timestamp when sent. */
  sentAtMono: number;
  /** Monotonic deadline. */
  deadlineMono: number;
  /** State. */
  state: 'queued' | 'sent';
}

export interface PendingLedgerConfig {
  /** Max pending per tab. */
  maxPerTab?: number;
  /** Max pending per transport. */
  maxPerTransport?: number;
  /** Reserved slots for critical commands (cancel/dialog/Fetch). */
  criticalReserve?: number;
  /** Default command timeout in ms. */
  defaultTimeoutMs?: number;
}

/** Set of CDP methods that get reserved slots. */
const CRITICAL_METHODS = new Set([
  'Page.handleJavaScriptDialog',
  'Fetch.continueRequest',
  'Fetch.failRequest',
  'Fetch.fulfillRequest',
  'Runtime.terminateExecution',
  'Page.stopLoading',
]);

// ─── Ledger ──────────────────────────────────────────────────────────────────

export class PendingLedger {
  private readonly maxPerTab: number;
  private readonly maxPerTransport: number;
  private readonly criticalReserve: number;
  private readonly defaultTimeoutMs: number;

  private nextRelayId = 1;

  /** All pending commands by relayId. */
  private commands = new Map<number, PendingCommand>();

  /** Count per tab (by realSessionId → count). */
  private perTabCount = new Map<string, number>();

  /** Total count. */
  private totalCount = 0;

  /** Tombstones for late responses (bounded). */
  private tombstones = new Map<number, { settledMono: number; method: string }>();
  private maxTombstones = 1024;

  /** Stats. */
  private _stats = {
    sent: 0,
    settled: 0,
    timedOut: 0,
    late: 0,
    rejected: 0,
  };

  constructor(config: PendingLedgerConfig = {}) {
    this.maxPerTab = config.maxPerTab ?? 64;
    this.maxPerTransport = config.maxPerTransport ?? 256;
    this.criticalReserve = config.criticalReserve ?? 8;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 20_000;
  }

  /**
   * Register a new pending command. Returns the relayId or null if rejected.
   */
  register(cmd: Omit<PendingCommand, 'relayId' | 'sentAtMono' | 'deadlineMono' | 'state'>, timeoutMs?: number): number | null {
    const isCritical = CRITICAL_METHODS.has(cmd.method);
    const tabCount = this.perTabCount.get(cmd.realSessionId) ?? 0;
    const effectiveMaxTab = isCritical ? this.maxPerTab : this.maxPerTab - this.criticalReserve;
    const effectiveMaxTransport = isCritical ? this.maxPerTransport : this.maxPerTransport - this.criticalReserve;

    if (tabCount >= effectiveMaxTab) {
      this._stats.rejected++;
      return null;
    }
    if (this.totalCount >= effectiveMaxTransport) {
      this._stats.rejected++;
      return null;
    }

    const now = monoNowMs();
    const relayId = this.nextRelayId++;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    const pending: PendingCommand = {
      ...cmd,
      relayId,
      sentAtMono: now,
      deadlineMono: now + timeout,
      state: 'queued',
    };

    this.commands.set(relayId, pending);
    this.perTabCount.set(cmd.realSessionId, tabCount + 1);
    this.totalCount++;
    this._stats.sent++;

    return relayId;
  }

  /**
   * Mark a command as sent (dispatched to the extension).
   */
  markSent(relayId: number): void {
    const cmd = this.commands.get(relayId);
    if (cmd) cmd.state = 'sent';
  }

  /**
   * Settle a command (response received). Returns the command or null if
   * it was already settled or is a tombstone (late).
   */
  settle(relayId: number): PendingCommand | null {
    const cmd = this.commands.get(relayId);
    if (!cmd) {
      // Check if it's a tombstone (late response).
      if (this.tombstones.has(relayId)) {
        this._stats.late++;
        return null;
      }
      return null;
    }

    this.commands.delete(relayId);
    const tabCount = this.perTabCount.get(cmd.realSessionId) ?? 0;
    this.perTabCount.set(cmd.realSessionId, Math.max(0, tabCount - 1));
    this.totalCount--;
    this._stats.settled++;

    return cmd;
  }

  /**
   * Check and expire timed-out commands. Returns the expired commands.
   */
  checkTimeouts(): PendingCommand[] {
    const now = monoNowMs();
    const expired: PendingCommand[] = [];

    for (const [relayId, cmd] of this.commands) {
      if (now >= cmd.deadlineMono) {
        expired.push(cmd);
        this.commands.delete(relayId);

        const tabCount = this.perTabCount.get(cmd.realSessionId) ?? 0;
        this.perTabCount.set(cmd.realSessionId, Math.max(0, tabCount - 1));
        this.totalCount--;
        this._stats.timedOut++;

        // Tombstone so late response is detected.
        this.addTombstone(relayId, cmd.method, now);
      }
    }

    return expired;
  }

  /**
   * Cancel all pending commands for a session. Returns the cancelled commands.
   */
  cancelBySession(sessionId: string): PendingCommand[] {
    const cancelled: PendingCommand[] = [];
    for (const [relayId, cmd] of this.commands) {
      if (cmd.sessionId === sessionId) {
        cancelled.push(cmd);
        this.commands.delete(relayId);

        const tabCount = this.perTabCount.get(cmd.realSessionId) ?? 0;
        this.perTabCount.set(cmd.realSessionId, Math.max(0, tabCount - 1));
        this.totalCount--;

        this.addTombstone(relayId, cmd.method, monoNowMs());
      }
    }
    return cancelled;
  }

  /**
   * Cancel all pending commands for a client. Returns the cancelled commands.
   */
  cancelByClient(clientId: string): PendingCommand[] {
    const cancelled: PendingCommand[] = [];
    for (const [relayId, cmd] of this.commands) {
      if (cmd.clientId === clientId) {
        cancelled.push(cmd);
        this.commands.delete(relayId);

        const tabCount = this.perTabCount.get(cmd.realSessionId) ?? 0;
        this.perTabCount.set(cmd.realSessionId, Math.max(0, tabCount - 1));
        this.totalCount--;

        this.addTombstone(relayId, cmd.method, monoNowMs());
      }
    }
    return cancelled;
  }

  /**
   * Validate that a pending command's epochs still match.
   */
  validateEpochs(relayId: number, currentEpochs: {
    connectionEpoch: number;
    transportEpoch: number;
    executeEpoch: number;
  }): boolean {
    const cmd = this.commands.get(relayId);
    if (!cmd) return false;

    return cmd.connectionEpoch === currentEpochs.connectionEpoch &&
      cmd.transportEpoch === currentEpochs.transportEpoch &&
      cmd.executeEpoch === currentEpochs.executeEpoch;
  }

  /**
   * Get a pending command by relayId.
   */
  get(relayId: number): PendingCommand | undefined {
    return this.commands.get(relayId);
  }

  /**
   * Diagnostic info.
   */
  diagnostics(): {
    pending: number;
    tombstones: number;
    stats: typeof this._stats;
  } {
    return {
      pending: this.totalCount,
      tombstones: this.tombstones.size,
      stats: { ...this._stats },
    };
  }

  /**
   * Reset all state.
   */
  reset(): void {
    const all = [...this.commands.values()];
    this.commands.clear();
    this.perTabCount.clear();
    this.totalCount = 0;
    // Tombstone all.
    const now = monoNowMs();
    for (const cmd of all) {
      this.addTombstone(cmd.relayId, cmd.method, now);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private addTombstone(relayId: number, method: string, settledMono: number): void {
    if (this.tombstones.size >= this.maxTombstones) {
      // Evict oldest tombstone.
      const first = this.tombstones.keys().next().value;
      if (first !== undefined) this.tombstones.delete(first);
    }
    this.tombstones.set(relayId, { settledMono, method });
  }
}
