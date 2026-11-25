/**
 * CDP Domain lease tracker — W07 §7.3/7.4.
 *
 * Tracks which clients/helpers hold references to CDP domains
 * (Runtime, Accessibility, DOM, Network, Fetch, Page, etc.) per target.
 * Manages shared enable/disable lifecycle with reference counting.
 * Pure logic, no I/O.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EnableState = 'disabled' | 'enabling' | 'enabled' | 'failed';

export interface DomainRecord {
  domain: string;
  targetKey: string;
  enableState: EnableState;
  holders: Set<string>;
  enabledAtMono?: number;
  eventCount: number;
  enableCount: number;
  lastError?: string;
}

export interface DomainLeaseConfig {
  /** Maximum domains tracked per target. Default: 32. */
  maxDomainsPerTarget?: number;
  /** Maximum holders per domain. Default: 16. */
  maxHoldersPerDomain?: number;
  /** Maximum total domain records. Default: 256. */
  maxTotalRecords?: number;
}

// ─── Lease Tracker ───────────────────────────────────────────────────────────

export class DomainLeaseTracker {
  private readonly maxDomainsPerTarget: number;
  private readonly maxHoldersPerDomain: number;
  private readonly maxTotalRecords: number;

  /** Key: `${targetKey}:${domain}` */
  private records = new Map<string, DomainRecord>();
  /** Count of domains per target. */
  private targetCounts = new Map<string, number>();

  constructor(config: DomainLeaseConfig = {}) {
    this.maxDomainsPerTarget = config.maxDomainsPerTarget ?? 32;
    this.maxHoldersPerDomain = config.maxHoldersPerDomain ?? 16;
    this.maxTotalRecords = config.maxTotalRecords ?? 256;
  }

  /**
   * Acquire a lease on a domain. Returns the record state.
   * If the domain is not yet enabled, sets state to 'enabling'.
   */
  acquire(targetKey: string, domain: string, holderId: string): DomainRecord | null {
    const key = `${targetKey}:${domain}`;
    let record = this.records.get(key);

    if (!record) {
      // Check capacity.
      const targetCount = this.targetCounts.get(targetKey) ?? 0;
      if (targetCount >= this.maxDomainsPerTarget) return null;
      if (this.records.size >= this.maxTotalRecords) return null;

      record = {
        domain,
        targetKey,
        enableState: 'enabling',
        holders: new Set(),
        eventCount: 0,
        enableCount: 0,
      };
      this.records.set(key, record);
      this.targetCounts.set(targetKey, targetCount + 1);
    }

    if (record.holders.size >= this.maxHoldersPerDomain) return null;

    record.holders.add(holderId);

    if (record.enableState === 'disabled' || record.enableState === 'failed') {
      record.enableState = 'enabling';
    }

    return record;
  }

  /**
   * Mark a domain as successfully enabled.
   */
  markEnabled(targetKey: string, domain: string): boolean {
    const record = this.records.get(`${targetKey}:${domain}`);
    if (!record) return false;
    record.enableState = 'enabled';
    record.enabledAtMono = monoNowMs();
    record.enableCount++;
    return true;
  }

  /**
   * Mark a domain enable as failed.
   */
  markFailed(targetKey: string, domain: string, error?: string): boolean {
    const record = this.records.get(`${targetKey}:${domain}`);
    if (!record) return false;
    record.enableState = 'failed';
    record.lastError = error;
    return true;
  }

  /**
   * Release a holder's lease on a domain.
   * Returns true if this was the last holder (domain can be disabled).
   */
  release(targetKey: string, domain: string, holderId: string): boolean {
    const key = `${targetKey}:${domain}`;
    const record = this.records.get(key);
    if (!record) return false;

    record.holders.delete(holderId);

    if (record.holders.size === 0) {
      return true; // Last holder — caller should disable
    }
    return false;
  }

  /**
   * Remove all leases for a holder across all targets.
   * Returns domains that became holder-free (can be disabled).
   */
  releaseHolder(holderId: string): Array<{ targetKey: string; domain: string }> {
    const freed: Array<{ targetKey: string; domain: string }> = [];
    for (const [, record] of this.records) {
      if (record.holders.delete(holderId) && record.holders.size === 0) {
        freed.push({ targetKey: record.targetKey, domain: record.domain });
      }
    }
    return freed;
  }

  /**
   * Remove a domain record entirely (target detached / generation change).
   */
  removeDomain(targetKey: string, domain: string): boolean {
    const key = `${targetKey}:${domain}`;
    if (!this.records.delete(key)) return false;
    const count = (this.targetCounts.get(targetKey) ?? 1) - 1;
    if (count <= 0) this.targetCounts.delete(targetKey);
    else this.targetCounts.set(targetKey, count);
    return true;
  }

  /**
   * Remove all domain records for a target.
   */
  removeTarget(targetKey: string): number {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.targetKey === targetKey) {
        this.records.delete(key);
        removed++;
      }
    }
    this.targetCounts.delete(targetKey);
    return removed;
  }

  /**
   * Record a domain event (for diagnostics).
   */
  recordEvent(targetKey: string, domain: string): void {
    const record = this.records.get(`${targetKey}:${domain}`);
    if (record) record.eventCount++;
  }

  /**
   * Get a domain record.
   */
  get(targetKey: string, domain: string): DomainRecord | undefined {
    return this.records.get(`${targetKey}:${domain}`);
  }

  /**
   * Check if a domain has any active holders.
   */
  hasHolders(targetKey: string, domain: string): boolean {
    const record = this.records.get(`${targetKey}:${domain}`);
    return record != null && record.holders.size > 0;
  }

  /**
   * List all domains for a target.
   */
  listDomains(targetKey: string): DomainRecord[] {
    const result: DomainRecord[] = [];
    for (const record of this.records.values()) {
      if (record.targetKey === targetKey) result.push(record);
    }
    return result;
  }

  diagnostics(): {
    totalRecords: number;
    totalTargets: number;
    byState: Record<EnableState, number>;
  } {
    const byState: Record<EnableState, number> = {
      disabled: 0, enabling: 0, enabled: 0, failed: 0,
    };
    for (const record of this.records.values()) {
      byState[record.enableState]++;
    }
    return {
      totalRecords: this.records.size,
      totalTargets: this.targetCounts.size,
      byState,
    };
  }

  reset(): void {
    this.records.clear();
    this.targetCounts.clear();
  }
}
