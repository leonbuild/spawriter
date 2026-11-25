/**
 * Cancel and capability revoke coordinator — W05 §16.5/16.8.
 *
 * Manages the multi-phase cancel flow: revoke → stop → cleanup → quarantine.
 * Pure state machine with deterministic phase transitions, no I/O.
 *
 * Cancel phases:
 *   1. REVOKE  — Scope watermark set, no new commands accepted
 *   2. STOP    — Page.stopLoading / Runtime.terminateExecution issued
 *   3. CLEANUP — Wait for in-flight commands to settle, cleanup grace
 *   4. DONE    — Cancel complete, session ready for next task
 *   5. QUARANTINE — Could not confirm stop, session marked unsafe
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CancelPhase = 'idle' | 'revoke' | 'stop' | 'cleanup' | 'done' | 'quarantine';

export type CancelReason =
  | 'user_cancel'    // Explicit cancel from user/MCP
  | 'deadline'       // Execution deadline reached
  | 'drain'          // Server draining
  | 'session_reset'  // Session reset/delete
  | 'error';         // Unrecoverable error

export interface CancelRecord {
  requestId: string;
  sessionId: string;
  phase: CancelPhase;
  reason: CancelReason;
  revokeEpoch: number;
  startMono: number;
  phaseDeadlineMono: number;
  totalDeadlineMono: number;
  /** Commands revoked (sent before cancel but not yet settled). */
  pendingCommandIds: string[];
  /** Whether side effects occurred before cancel. */
  hadSideEffects: boolean;
  /** Phase transition log for diagnostics. */
  transitions: Array<{ from: CancelPhase; to: CancelPhase; mono: number }>;
}

export interface CancelCoordinatorConfig {
  /** Per-phase timeout (ms). Default: 2000. */
  phaseTimeoutMs?: number;
  /** Total grace budget (ms). Default: 5000. */
  totalGraceMs?: number;
  /** Max concurrent cancel operations. Default: 8. */
  maxConcurrent?: number;
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export class CancelCoordinator {
  private readonly phaseTimeoutMs: number;
  private readonly totalGraceMs: number;
  private readonly maxConcurrent: number;

  private readonly active = new Map<string, CancelRecord>();
  private nextRevokeEpoch = 1;

  private _stats = {
    initiated: 0,
    completed: 0,
    quarantined: 0,
    phasesTimedOut: 0,
  };

  constructor(config: CancelCoordinatorConfig = {}) {
    this.phaseTimeoutMs = config.phaseTimeoutMs ?? 2000;
    this.totalGraceMs = config.totalGraceMs ?? 5000;
    this.maxConcurrent = config.maxConcurrent ?? 8;
  }

  /**
   * Initiate a cancel operation.
   * Returns the cancel record, or null if at capacity.
   */
  initiate(
    requestId: string,
    sessionId: string,
    reason: CancelReason,
    pendingCommandIds: string[] = [],
    hadSideEffects: boolean = false,
  ): CancelRecord | null {
    if (this.active.has(requestId)) {
      return this.active.get(requestId)!;
    }

    if (this.active.size >= this.maxConcurrent) {
      return null;
    }

    const now = monoNowMs();
    const record: CancelRecord = {
      requestId,
      sessionId,
      phase: 'revoke',
      reason,
      revokeEpoch: this.nextRevokeEpoch++,
      startMono: now,
      phaseDeadlineMono: now + this.phaseTimeoutMs,
      totalDeadlineMono: now + this.totalGraceMs,
      pendingCommandIds: [...pendingCommandIds],
      hadSideEffects,
      transitions: [{ from: 'idle', to: 'revoke', mono: now }],
    };

    this.active.set(requestId, record);
    this._stats.initiated++;
    return record;
  }

  /**
   * Advance to the next phase.
   * Returns false if the transition is invalid.
   */
  advance(requestId: string): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;

    const now = monoNowMs();
    const nextPhase = this.nextPhase(record.phase);

    if (!nextPhase) return false;

    record.transitions.push({ from: record.phase, to: nextPhase, mono: now });
    record.phase = nextPhase;
    record.phaseDeadlineMono = now + this.phaseTimeoutMs;

    if (nextPhase === 'done') {
      this._stats.completed++;
    } else if (nextPhase === 'quarantine') {
      this._stats.quarantined++;
    }

    return true;
  }

  /**
   * Force transition to quarantine (could not confirm stop).
   */
  quarantine(requestId: string): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;
    if (record.phase === 'done' || record.phase === 'quarantine') return false;

    const now = monoNowMs();
    record.transitions.push({ from: record.phase, to: 'quarantine', mono: now });
    record.phase = 'quarantine';
    this._stats.quarantined++;
    return true;
  }

  /**
   * Check if a cancel operation's current phase has timed out.
   */
  isPhaseTimedOut(requestId: string): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;
    return monoNowMs() >= record.phaseDeadlineMono;
  }

  /**
   * Check if a cancel operation's total grace has expired.
   */
  isTotalExpired(requestId: string): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;
    return monoNowMs() >= record.totalDeadlineMono;
  }

  /**
   * Check all active cancels for phase/total timeouts.
   * Returns records that need attention.
   */
  checkTimeouts(): CancelRecord[] {
    const now = monoNowMs();
    const timedOut: CancelRecord[] = [];

    for (const record of this.active.values()) {
      if (record.phase === 'done' || record.phase === 'quarantine') continue;

      if (now >= record.totalDeadlineMono) {
        record.transitions.push({ from: record.phase, to: 'quarantine', mono: now });
        record.phase = 'quarantine';
        this._stats.quarantined++;
        this._stats.phasesTimedOut++;
        timedOut.push(record);
      } else if (now >= record.phaseDeadlineMono) {
        this._stats.phasesTimedOut++;
        timedOut.push(record);
      }
    }

    return timedOut;
  }

  /**
   * Mark a pending command as settled during cancel.
   */
  settleCommand(requestId: string, commandId: string): void {
    const record = this.active.get(requestId);
    if (!record) return;
    const idx = record.pendingCommandIds.indexOf(commandId);
    if (idx >= 0) record.pendingCommandIds.splice(idx, 1);
  }

  /**
   * Check if all pending commands are settled for a cancel operation.
   */
  allCommandsSettled(requestId: string): boolean {
    const record = this.active.get(requestId);
    if (!record) return true;
    return record.pendingCommandIds.length === 0;
  }

  /**
   * Check if a request is being cancelled.
   */
  isCancelling(requestId: string): boolean {
    const record = this.active.get(requestId);
    return record != null && record.phase !== 'done' && record.phase !== 'quarantine';
  }

  /**
   * Check if a command should be blocked by an active cancel (scope watermark).
   */
  isBlocked(requestId: string, commandEpoch: number): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;
    if (record.phase === 'idle' || record.phase === 'done') return false;
    return commandEpoch <= record.revokeEpoch;
  }

  /**
   * Get a cancel record.
   */
  get(requestId: string): CancelRecord | undefined {
    return this.active.get(requestId);
  }

  /**
   * Remove a completed/quarantined cancel record.
   */
  remove(requestId: string): CancelRecord | undefined {
    const record = this.active.get(requestId);
    if (!record) return undefined;
    if (record.phase !== 'done' && record.phase !== 'quarantine') return undefined;
    this.active.delete(requestId);
    return record;
  }

  /**
   * Sweep terminal records older than maxAgeMs.
   */
  sweep(maxAgeMs: number = 60_000): number {
    const now = monoNowMs();
    let swept = 0;
    for (const [id, record] of this.active) {
      if (record.phase !== 'done' && record.phase !== 'quarantine') continue;
      if (now - record.startMono >= maxAgeMs) {
        this.active.delete(id);
        swept++;
      }
    }
    return swept;
  }

  diagnostics(): {
    active: number;
    byPhase: Record<CancelPhase, number>;
    stats: typeof this._stats;
  } {
    const byPhase: Record<CancelPhase, number> = {
      idle: 0, revoke: 0, stop: 0, cleanup: 0, done: 0, quarantine: 0,
    };
    for (const record of this.active.values()) {
      byPhase[record.phase]++;
    }
    return { active: this.active.size, byPhase, stats: { ...this._stats } };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private nextPhase(current: CancelPhase): CancelPhase | null {
    switch (current) {
      case 'revoke': return 'stop';
      case 'stop': return 'cleanup';
      case 'cleanup': return 'done';
      default: return null;
    }
  }
}
