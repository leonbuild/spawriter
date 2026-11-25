/**
 * Execution coordinator: admission, queuing, deadline, cancel, and recovery.
 *
 * Each session has at most 1 running + 1 queued task. The coordinator manages
 * the lifecycle from admission to terminal state.
 *
 * §16.5/6.2 of the stability plan.
 */

import { monoNowMs, type ExecutionIdentity } from './execution-context.js';
import {
  SessionBusyError,
  RelayDrainingError,
  CancelledError,
  ExecutionTimeoutError,
  type ExecutionErrorCode,
  type ExecutionOutcome,
} from './execution-errors.js';
import type { SessionRegistry, SessionId } from './session-registry.js';

export type TaskStatus =
  | 'queued'
  | 'acquiring'
  | 'executing'
  | 'finishing'
  | 'cancelling'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface TaskRecord {
  requestId: string;
  sessionId: SessionId;
  identity: ExecutionIdentity;
  status: TaskStatus;
  deadlineMono: number;
  startMono: number;
  outcome: ExecutionOutcome;
  errorCode?: ExecutionErrorCode;
  signal: AbortController;
  /** Payload hash for idempotency. */
  payloadHash?: string;
  /** Whether the task has been dispatched to Chrome. */
  nativeDispatched: boolean;
}

export interface CoordinatorOptions {
  registry: SessionRegistry;
  maxGlobalQueued?: number;
  sessionQueueLimit?: number;
  defaultTimeoutMs?: number;
  recoveryGraceMs?: number;
}

export class ExecutionCoordinator {
  private readonly registry: SessionRegistry;
  private readonly maxGlobalQueued: number;
  private readonly sessionQueueLimit: number;
  private readonly defaultTimeoutMs: number;
  private readonly recoveryGraceMs: number;

  /** All active/queued tasks by requestId. */
  private tasks = new Map<string, TaskRecord>();
  /** Per-session task queues (requestIds). */
  private sessionQueues = new Map<SessionId, string[]>();
  /** Currently running task per session. */
  private runningTasks = new Map<SessionId, string>();

  private draining = false;
  private globalQueued = 0;

  constructor(opts: CoordinatorOptions) {
    this.registry = opts.registry;
    this.maxGlobalQueued = opts.maxGlobalQueued ?? 16;
    this.sessionQueueLimit = opts.sessionQueueLimit ?? 1;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.recoveryGraceMs = opts.recoveryGraceMs ?? 5_000;
  }

  /**
   * Admit a new task. Returns the TaskRecord on success.
   * Throws SessionBusyError if the session already has max queued tasks.
   * Throws RelayDrainingError if the relay is draining.
   */
  admit(
    identity: ExecutionIdentity,
    timeoutMs?: number,
    payloadHash?: string,
  ): TaskRecord {
    if (this.draining) {
      throw new RelayDrainingError();
    }

    const { sessionId, requestId } = identity;

    // Check for duplicate requestId
    const existing = this.tasks.get(requestId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error(`Request ${requestId} already exists for different session`);
      }
      if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) {
        throw new Error(`Request ${requestId} already exists with different payload`);
      }
      // Same request, return 409-like
      throw new SessionBusyError(sessionId);
    }

    // Check session exists
    const session = this.registry.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Check session queue
    const queue = this.sessionQueues.get(sessionId) ?? [];
    const running = this.runningTasks.get(sessionId);

    if (running) {
      // Already running, check queue limit
      if (queue.length >= this.sessionQueueLimit) {
        throw new SessionBusyError(sessionId);
      }
    }

    // Check global queue
    if (!running && this.globalQueued >= this.maxGlobalQueued) {
      throw new SessionBusyError(sessionId);
    }

    const now = monoNowMs();
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();

    const task: TaskRecord = {
      requestId,
      sessionId,
      identity,
      status: running ? 'queued' : 'acquiring',
      deadlineMono: now + timeout,
      startMono: now,
      outcome: 'not_started',
      signal: ac,
      payloadHash,
      nativeDispatched: false,
    };

    this.tasks.set(requestId, task);

    if (running) {
      queue.push(requestId);
      this.sessionQueues.set(sessionId, queue);
      this.globalQueued++;
    } else {
      this.runningTasks.set(sessionId, requestId);
      this.registry.setSessionStatus(sessionId, 'executing');
    }

    return task;
  }

  /**
   * Get a task by requestId.
   */
  getTask(requestId: string): TaskRecord | undefined {
    return this.tasks.get(requestId);
  }

  /**
   * Get the currently running task for a session.
   */
  getRunningTask(sessionId: SessionId): TaskRecord | undefined {
    const reqId = this.runningTasks.get(sessionId);
    return reqId ? this.tasks.get(reqId) : undefined;
  }

  /**
   * Check if a session has any active tasks.
   */
  isSessionBusy(sessionId: SessionId): boolean {
    return this.runningTasks.has(sessionId) ||
      (this.sessionQueues.get(sessionId)?.length ?? 0) > 0;
  }

  /**
   * Mark a task as having dispatched native commands.
   */
  markNativeDispatched(requestId: string): void {
    const task = this.tasks.get(requestId);
    if (task) {
      task.nativeDispatched = true;
      task.outcome = 'unknown'; // sent to Chrome, result unknown
    }
  }

  /**
   * Transition a task to executing status.
   */
  markExecuting(requestId: string): void {
    const task = this.tasks.get(requestId);
    if (task && task.status === 'acquiring') {
      task.status = 'executing';
    }
  }

  /**
   * Complete a task successfully.
   */
  complete(requestId: string): void {
    const task = this.tasks.get(requestId);
    if (!task) return;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;

    task.status = 'completed';
    task.outcome = 'succeeded';
    this.finalizeTask(requestId);
  }

  /**
   * Fail a task.
   */
  fail(requestId: string, errorCode: ExecutionErrorCode, outcome?: ExecutionOutcome): void {
    const task = this.tasks.get(requestId);
    if (!task) return;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;

    task.status = 'failed';
    task.errorCode = errorCode;
    task.outcome = outcome ?? (task.nativeDispatched ? 'unknown' : 'failed');
    task.signal.abort('failed');
    this.finalizeTask(requestId);
  }

  /**
   * Cancel a task. Returns the task's outcome.
   */
  cancel(requestId: string): ExecutionOutcome {
    const task = this.tasks.get(requestId);
    if (!task) return 'not_started';

    if (task.status === 'completed') return 'succeeded';
    if (task.status === 'failed') return task.outcome;
    if (task.status === 'cancelled') return task.outcome;

    // Determine outcome based on dispatch state
    if (task.status === 'queued') {
      task.outcome = 'not_started';
    } else {
      task.outcome = task.nativeDispatched ? 'unknown' : 'not_started';
    }

    task.status = 'cancelled';
    task.errorCode = task.outcome === 'not_started' ? 'CANCELLED_BEFORE_START' : 'CANCELLED';
    task.signal.abort('cancelled');
    this.finalizeTask(requestId);
    return task.outcome;
  }

  /**
   * Check and handle deadline expiry for a task.
   */
  checkDeadline(requestId: string): boolean {
    const task = this.tasks.get(requestId);
    if (!task) return false;

    const now = monoNowMs();
    if (now >= task.deadlineMono) {
      task.status = 'timeout';
      task.errorCode = 'EXECUTION_TIMEOUT';
      task.outcome = task.nativeDispatched ? 'unknown' : 'not_started';
      task.signal.abort('deadline');
      this.finalizeTask(requestId);
      return true;
    }
    return false;
  }

  /**
   * Get remaining budget for a task.
   */
  remainingMs(requestId: string): number {
    const task = this.tasks.get(requestId);
    if (!task) return 0;
    return Math.max(0, task.deadlineMono - monoNowMs());
  }

  /**
   * Enter draining mode.
   */
  startDrain(): void {
    this.draining = true;
    // Cancel all queued (not running) tasks
    for (const [sessionId, queue] of this.sessionQueues) {
      for (const reqId of [...queue]) {
        this.cancel(reqId);
      }
    }
  }

  /**
   * Check if draining is complete (no active tasks).
   */
  isDrainComplete(): boolean {
    return this.draining && this.runningTasks.size === 0;
  }

  /**
   * Stop draining.
   */
  stopDrain(): void {
    this.draining = false;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Diagnostic counts.
   */
  diagnostics(): {
    running: number;
    queued: number;
    total: number;
    draining: boolean;
  } {
    return {
      running: this.runningTasks.size,
      queued: this.globalQueued,
      total: this.tasks.size,
      draining: this.draining,
    };
  }

  // ─── Internal ───

  private finalizeTask(requestId: string): void {
    const task = this.tasks.get(requestId);
    if (!task) return;

    const { sessionId } = task;

    // Remove from running
    if (this.runningTasks.get(sessionId) === requestId) {
      this.runningTasks.delete(sessionId);
      // Promote next queued task
      this.promoteNext(sessionId);
    }

    // Remove from queue
    const queue = this.sessionQueues.get(sessionId);
    if (queue) {
      const idx = queue.indexOf(requestId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        this.globalQueued--;
      }
      if (queue.length === 0) {
        this.sessionQueues.delete(sessionId);
      }
    }

    // Update session status
    if (!this.runningTasks.has(sessionId) && !this.sessionQueues.has(sessionId)) {
      this.registry.setSessionStatus(sessionId, 'idle');
    }

    // Keep terminal records for a bounded time for status queries
    // (actual cleanup handled by sweep)
  }

  private promoteNext(sessionId: SessionId): void {
    const queue = this.sessionQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const nextReqId = queue.shift()!;
    this.globalQueued--;
    if (queue.length === 0) {
      this.sessionQueues.delete(sessionId);
    }

    const task = this.tasks.get(nextReqId);
    if (!task) return;

    // Check if the queued task has already expired
    if (monoNowMs() >= task.deadlineMono) {
      task.status = 'timeout';
      task.errorCode = 'EXECUTION_TIMEOUT';
      task.outcome = 'not_started';
      task.signal.abort('deadline');
      this.promoteNext(sessionId); // try next
      return;
    }

    task.status = 'acquiring';
    this.runningTasks.set(sessionId, nextReqId);
    this.registry.setSessionStatus(sessionId, 'executing');
  }

  /**
   * Clean up terminal task records older than the given age.
   */
  sweepTerminal(maxAgeMs: number = 60_000): number {
    const now = monoNowMs();
    let swept = 0;
    for (const [reqId, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'failed' ||
         task.status === 'cancelled' || task.status === 'timeout') &&
        now - task.startMono >= maxAgeMs
      ) {
        this.tasks.delete(reqId);
        swept++;
      }
    }
    return swept;
  }
}
