/**
 * Resource budget tracker — W11/T66 §16.10.
 *
 * Manages global resource budgets: worker count, heap memory,
 * queue depth, body/result byte limits. Prevents unbounded resource
 * consumption across sessions and workers. Pure logic, no I/O.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResourceBudgetConfig {
  /** Max concurrent workers. Default: 10. */
  maxWorkers?: number;
  /** Max active (running) workers. Default: 4. */
  maxActiveWorkers?: number;
  /** Worker heap limit (MiB). Default: 384. */
  workerHeapMiB?: number;
  /** Global worker budget (MiB). Default: 2048. */
  globalBudgetMiB?: number;
  /** Max queued tasks globally. Default: 16. */
  globalQueueLimit?: number;
  /** Max result bytes pending delivery. Default: 67108864 (64 MiB). */
  resultPendingBytes?: number;
  /** Max HTTP body bytes. Default: 1048576 (1 MiB). */
  httpBodyBytes?: number;
  /** Max code payload bytes. Default: 524288 (512 KiB). */
  codePayloadBytes?: number;
  /** Idle worker timeout (ms). Default: 300000. */
  idleWorkerMs?: number;
}

export interface WorkerAllocation {
  id: string;
  sessionId: string;
  heapMiB: number;
  startedMono: number;
  lastActiveMono: number;
  state: 'idle' | 'active' | 'stopping';
}

export interface BudgetSnapshot {
  workers: { total: number; active: number; idle: number; stopping: number };
  memory: { allocatedMiB: number; budgetMiB: number };
  queue: { depth: number; limit: number };
  results: { pendingBytes: number; limitBytes: number };
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

export class ResourceBudget {
  private readonly maxWorkers: number;
  private readonly maxActive: number;
  private readonly workerHeapMiB: number;
  private readonly globalBudgetMiB: number;
  private readonly globalQueueLimit: number;
  private readonly resultPendingLimit: number;
  private readonly httpBodyLimit: number;
  private readonly codePayloadLimit: number;
  private readonly idleWorkerMs: number;

  private workers = new Map<string, WorkerAllocation>();
  private queueDepth = 0;
  private resultPendingBytes = 0;

  constructor(config: ResourceBudgetConfig = {}) {
    this.maxWorkers = config.maxWorkers ?? 10;
    this.maxActive = config.maxActiveWorkers ?? 4;
    this.workerHeapMiB = config.workerHeapMiB ?? 384;
    this.globalBudgetMiB = config.globalBudgetMiB ?? 2048;
    this.globalQueueLimit = config.globalQueueLimit ?? 16;
    this.resultPendingLimit = config.resultPendingBytes ?? 67_108_864;
    this.httpBodyLimit = config.httpBodyBytes ?? 1_048_576;
    this.codePayloadLimit = config.codePayloadBytes ?? 524_288;
    this.idleWorkerMs = config.idleWorkerMs ?? 300_000;
  }

  // ─── Worker budget ─────────────────────────────────────────────────

  /**
   * Try to allocate a worker. Returns the allocation or null if over budget.
   */
  allocateWorker(id: string, sessionId: string, heapMiB?: number): WorkerAllocation | null {
    if (this.workers.has(id)) return this.workers.get(id)!;
    if (this.workers.size >= this.maxWorkers) return null;

    const usedHeap = heapMiB ?? this.workerHeapMiB;
    if (this.totalAllocatedMiB() + usedHeap > this.globalBudgetMiB) return null;

    const activeCount = this.countByState('active');
    if (activeCount >= this.maxActive) return null;

    const now = monoNowMs();
    const alloc: WorkerAllocation = {
      id,
      sessionId,
      heapMiB: usedHeap,
      startedMono: now,
      lastActiveMono: now,
      state: 'active',
    };
    this.workers.set(id, alloc);
    return alloc;
  }

  /**
   * Mark a worker as idle.
   */
  markIdle(id: string): boolean {
    const w = this.workers.get(id);
    if (!w || w.state === 'stopping') return false;
    w.state = 'idle';
    return true;
  }

  /**
   * Mark a worker as active.
   */
  markActive(id: string): boolean {
    const w = this.workers.get(id);
    if (!w || w.state === 'stopping') return false;
    w.state = 'active';
    w.lastActiveMono = monoNowMs();
    return true;
  }

  /**
   * Mark a worker as stopping (pending exit).
   */
  markStopping(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    w.state = 'stopping';
    return true;
  }

  /**
   * Release a worker allocation.
   */
  releaseWorker(id: string): WorkerAllocation | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    this.workers.delete(id);
    return w;
  }

  /**
   * Find idle workers that have exceeded the timeout.
   */
  findIdleExpired(maxIdleMs?: number): WorkerAllocation[] {
    const limit = maxIdleMs ?? this.idleWorkerMs;
    const now = monoNowMs();
    const expired: WorkerAllocation[] = [];
    for (const w of this.workers.values()) {
      if (w.state === 'idle' && now - w.lastActiveMono >= limit) {
        expired.push(w);
      }
    }
    return expired;
  }

  // ─── Queue budget ──────────────────────────────────────────────────

  /**
   * Try to reserve a queue slot. Returns false if over limit.
   */
  reserveQueue(): boolean {
    if (this.queueDepth >= this.globalQueueLimit) return false;
    this.queueDepth++;
    return true;
  }

  /**
   * Release a queue slot.
   */
  releaseQueue(): void {
    if (this.queueDepth > 0) this.queueDepth--;
  }

  // ─── Result buffer budget ──────────────────────────────────────────

  /**
   * Try to reserve bytes for a pending result.
   */
  reserveResult(bytes: number): boolean {
    if (this.resultPendingBytes + bytes > this.resultPendingLimit) return false;
    this.resultPendingBytes += bytes;
    return true;
  }

  /**
   * Release result buffer bytes.
   */
  releaseResult(bytes: number): void {
    this.resultPendingBytes = Math.max(0, this.resultPendingBytes - bytes);
  }

  // ─── Payload validation ────────────────────────────────────────────

  /**
   * Check if an HTTP body is within limits.
   */
  validateBodySize(bytes: number): boolean {
    return bytes <= this.httpBodyLimit;
  }

  /**
   * Check if a code payload is within limits.
   */
  validateCodeSize(bytes: number): boolean {
    return bytes <= this.codePayloadLimit;
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  snapshot(): BudgetSnapshot {
    return {
      workers: {
        total: this.workers.size,
        active: this.countByState('active'),
        idle: this.countByState('idle'),
        stopping: this.countByState('stopping'),
      },
      memory: {
        allocatedMiB: this.totalAllocatedMiB(),
        budgetMiB: this.globalBudgetMiB,
      },
      queue: {
        depth: this.queueDepth,
        limit: this.globalQueueLimit,
      },
      results: {
        pendingBytes: this.resultPendingBytes,
        limitBytes: this.resultPendingLimit,
      },
    };
  }

  reset(): void {
    this.workers.clear();
    this.queueDepth = 0;
    this.resultPendingBytes = 0;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private totalAllocatedMiB(): number {
    let total = 0;
    for (const w of this.workers.values()) total += w.heapMiB;
    return total;
  }

  private countByState(state: WorkerAllocation['state']): number {
    let count = 0;
    for (const w of this.workers.values()) if (w.state === state) count++;
    return count;
  }
}
