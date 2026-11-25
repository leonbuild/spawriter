/**
 * Dirty-protection journal — W03/W05 §16.5/T62.
 *
 * Tracks "risk records" for in-flight mutations that may leave the target
 * in an unknown state if the task is interrupted (crash, cancel, timeout).
 * Records are created before dispatch, resolved after confirmation, and
 * checked during recovery to decide if a target is safe to reuse.
 *
 * Bounded: max records per target, max globally. Unresolved records block
 * target release to AVAILABLE. Pure logic, no I/O.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskStatus = 'pending' | 'confirmed' | 'failed' | 'unknown' | 'cleaned';

export interface RiskRecord {
  id: string;
  targetKey: string;
  sessionId: string;
  executeEpoch: number;
  method: string;
  riskLevel: RiskLevel;
  status: RiskStatus;
  createdMono: number;
  resolvedMono?: number;
  /** Whether the method has observable side effects. */
  hasSideEffects: boolean;
  /** Brief description of what might be dirty. */
  scope?: string;
}

export interface DirtyJournalConfig {
  /** Max records per target. Default: 32. */
  maxPerTarget?: number;
  /** Max total records. Default: 512. */
  maxTotal?: number;
  /** Safety reserve for clean operations. Default: 8. */
  cleanReserve?: number;
}

// Method risk classification.
const HIGH_RISK_METHODS = new Set([
  'Page.navigate', 'Page.reload', 'Page.setDocumentContent',
  'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Network.setRequestInterception', 'Fetch.enable', 'Fetch.fulfillRequest',
  'Debugger.setBreakpoint', 'Debugger.setBreakpointByUrl',
  'DOM.setAttributeValue', 'DOM.setOuterHTML', 'DOM.removeNode',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setGeolocationOverride',
  'Network.emulateNetworkConditions',
  'Storage.clearDataForOrigin',
]);

const MEDIUM_RISK_METHODS = new Set([
  'Page.stopLoading', 'Runtime.terminateExecution',
  'Page.captureScreenshot', 'Page.printToPDF',
  'Debugger.resume', 'Debugger.stepOver', 'Debugger.stepInto',
  'Network.getResponseBody',
  'Accessibility.getFullAXTree', 'DOM.getDocument',
]);

// ─── Journal ─────────────────────────────────────────────────────────────────

export class DirtyJournal {
  private readonly maxPerTarget: number;
  private readonly maxTotal: number;
  private readonly cleanReserve: number;

  private records = new Map<string, RiskRecord>();
  private targetCounts = new Map<string, number>();
  private _stats = {
    created: 0,
    confirmed: 0,
    failed: 0,
    cleaned: 0,
  };

  constructor(config: DirtyJournalConfig = {}) {
    this.maxPerTarget = config.maxPerTarget ?? 32;
    this.maxTotal = config.maxTotal ?? 512;
    this.cleanReserve = config.cleanReserve ?? 8;
  }

  /**
   * Record a risk entry before dispatching a command.
   * Returns the record, or null if at capacity.
   */
  recordRisk(
    id: string,
    targetKey: string,
    sessionId: string,
    executeEpoch: number,
    method: string,
    scope?: string,
  ): RiskRecord | null {
    if (this.records.has(id)) return this.records.get(id)!;

    const targetCount = this.targetCounts.get(targetKey) ?? 0;
    const isClean = this.isCleanMethod(method);
    const usablePerTarget = this.maxPerTarget - (isClean ? 0 : this.cleanReserve);
    const usableTotal = this.maxTotal - (isClean ? 0 : this.cleanReserve);

    if (!isClean && targetCount >= usablePerTarget) return null;
    if (!isClean && this.records.size >= usableTotal) return null;
    if (isClean && targetCount >= this.maxPerTarget) return null;
    if (isClean && this.records.size >= this.maxTotal) return null;

    const record: RiskRecord = {
      id,
      targetKey,
      sessionId,
      executeEpoch,
      method,
      riskLevel: this.classifyRisk(method),
      status: 'pending',
      createdMono: monoNowMs(),
      hasSideEffects: HIGH_RISK_METHODS.has(method),
      scope,
    };

    this.records.set(id, record);
    this.targetCounts.set(targetKey, targetCount + 1);
    this._stats.created++;
    return record;
  }

  /**
   * Confirm a command completed successfully.
   */
  confirm(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') return false;
    record.status = 'confirmed';
    record.resolvedMono = monoNowMs();
    this._stats.confirmed++;
    return true;
  }

  /**
   * Mark a command as failed.
   */
  fail(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending') return false;
    record.status = 'failed';
    record.resolvedMono = monoNowMs();
    this._stats.failed++;
    return true;
  }

  /**
   * Mark a risk record as cleaned (recovery verified safe).
   */
  markCleaned(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.status = 'cleaned';
    record.resolvedMono = monoNowMs();
    this._stats.cleaned++;
    return true;
  }

  /**
   * Check if a target has unresolved (dirty) risk records.
   */
  isDirty(targetKey: string): boolean {
    for (const record of this.records.values()) {
      if (record.targetKey === targetKey) {
        if (record.status === 'pending' || record.status === 'failed' || record.status === 'unknown') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a target has any high-risk unresolved records.
   */
  hasHighRiskPending(targetKey: string): boolean {
    for (const record of this.records.values()) {
      if (record.targetKey === targetKey && record.riskLevel === 'high' && record.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all unresolved records for a target.
   */
  getPending(targetKey: string): RiskRecord[] {
    const result: RiskRecord[] = [];
    for (const record of this.records.values()) {
      if (record.targetKey === targetKey && record.status === 'pending') {
        result.push(record);
      }
    }
    return result;
  }

  /**
   * Mark all pending records for an epoch as unknown (task interrupted).
   */
  markEpochUnknown(targetKey: string, executeEpoch: number): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.targetKey === targetKey && record.executeEpoch === executeEpoch && record.status === 'pending') {
        record.status = 'unknown';
        record.resolvedMono = monoNowMs();
        count++;
      }
    }
    return count;
  }

  /**
   * Sweep resolved records older than maxAgeMs.
   */
  sweep(maxAgeMs: number = 60_000): number {
    const now = monoNowMs();
    let swept = 0;
    for (const [id, record] of this.records) {
      if (record.status === 'pending' || record.status === 'unknown') continue;
      if (record.resolvedMono != null && now - record.resolvedMono >= maxAgeMs) {
        this.records.delete(id);
        const count = (this.targetCounts.get(record.targetKey) ?? 1) - 1;
        if (count <= 0) this.targetCounts.delete(record.targetKey);
        else this.targetCounts.set(record.targetKey, count);
        swept++;
      }
    }
    return swept;
  }

  /**
   * Remove all records for a target.
   */
  removeTarget(targetKey: string): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.targetKey === targetKey) {
        this.records.delete(id);
        removed++;
      }
    }
    this.targetCounts.delete(targetKey);
    return removed;
  }

  get(id: string): RiskRecord | undefined {
    return this.records.get(id);
  }

  diagnostics(): {
    total: number;
    byStatus: Record<RiskStatus, number>;
    byRisk: Record<RiskLevel, number>;
    stats: typeof this._stats;
  } {
    const byStatus: Record<RiskStatus, number> = { pending: 0, confirmed: 0, failed: 0, unknown: 0, cleaned: 0 };
    const byRisk: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0 };
    for (const record of this.records.values()) {
      byStatus[record.status]++;
      byRisk[record.riskLevel]++;
    }
    return { total: this.records.size, byStatus, byRisk, stats: { ...this._stats } };
  }

  reset(): void {
    this.records.clear();
    this.targetCounts.clear();
    this._stats = { created: 0, confirmed: 0, failed: 0, cleaned: 0 };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private classifyRisk(method: string): RiskLevel {
    if (HIGH_RISK_METHODS.has(method)) return 'high';
    if (MEDIUM_RISK_METHODS.has(method)) return 'medium';
    return 'low';
  }

  private isCleanMethod(method: string): boolean {
    return method === 'Page.stopLoading' || method === 'Runtime.terminateExecution';
  }
}
