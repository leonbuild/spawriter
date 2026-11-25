/**
 * Runtime control surface — unified session and execution management.
 *
 * §6/W06 of the stability plan. Provides the same operations for HTTP, MCP,
 * and CLI callers with consistent identity, timeout, and status handling.
 * Pure logic layer: depends on coordinator and registry, no transport specifics.
 *
 * NOT to be confused with the existing HTTP ControlClient in control-client.ts
 * which is a fetch-based client for the relay API.
 */

import {
  ExecutionCoordinator,
  type TaskRecord,
} from './execution-coordinator.js';
import {
  SessionRegistry,
  type SessionId,
  type Lease,
} from './session-registry.js';
import { HealthMonitor, type HealthMetrics } from './health.js';
import { monoNowMs, clampTimeout, generateRequestId } from './execution-context.js';
import {
  SessionBusyError,
  RelayDrainingError,
  type ExecutionOutcome,
  type ExecutionErrorCode,
} from './execution-errors.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionCreateResult {
  sessionId: SessionId;
  created: boolean;
}

export interface ExecuteRequest {
  sessionId: SessionId;
  requestId?: string;
  code: string;
  timeoutMs?: number;
  principalId: string;
}

export interface ExecuteResult {
  requestId: string;
  status: string;
  outcome: ExecutionOutcome;
  errorCode?: ExecutionErrorCode;
}

export interface StatusResult {
  requestId: string;
  status: string;
  outcome: ExecutionOutcome;
  errorCode?: ExecutionErrorCode;
  remainingMs: number;
}

export interface CancelResult {
  requestId: string;
  outcome: ExecutionOutcome;
  cancelled: boolean;
}

export interface TabClaimResult {
  tabId: number;
  sessionId: SessionId;
  ok: boolean;
  reason?: string;
}

export interface TabListResult {
  tabs: Array<{
    tabId: number;
    owner?: SessionId;
    health: string;
    attached: boolean;
  }>;
}

export interface DrainResult {
  draining: boolean;
  drainComplete: boolean;
  activeTasks: number;
}

// ─── Runtime Control ─────────────────────────────────────────────────────────

export interface RuntimeControlDeps {
  registry: SessionRegistry;
  coordinator: ExecutionCoordinator;
  health: HealthMonitor;
  relayInstanceId: string;
}

export class RuntimeControl {
  private readonly registry: SessionRegistry;
  private readonly coordinator: ExecutionCoordinator;
  private readonly health: HealthMonitor;
  private readonly relayInstanceId: string;

  constructor(deps: RuntimeControlDeps) {
    this.registry = deps.registry;
    this.coordinator = deps.coordinator;
    this.health = deps.health;
    this.relayInstanceId = deps.relayInstanceId;
  }

  // ─── Session management ────────────────────────────────────────────────

  createSession(principalId: string, sessionId?: SessionId): SessionCreateResult {
    const id = sessionId ?? `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.registry.createSession(id, principalId);
      return { sessionId: id, created: true };
    } catch {
      return { sessionId: id, created: false };
    }
  }

  getSession(sessionId: SessionId) {
    return this.registry.getSession(sessionId);
  }

  deleteSession(sessionId: SessionId): boolean {
    if (this.coordinator.isSessionBusy(sessionId)) {
      const running = this.coordinator.getRunningTask(sessionId);
      if (running) this.coordinator.cancel(running.requestId);
    }
    return this.registry.deleteSession(sessionId);
  }

  resetSession(sessionId: SessionId): boolean {
    if (this.coordinator.isSessionBusy(sessionId)) {
      const running = this.coordinator.getRunningTask(sessionId);
      if (running) this.coordinator.cancel(running.requestId);
    }
    this.registry.setSessionStatus(sessionId, 'idle');
    return true;
  }

  listSessions() {
    return this.registry.diagnostics();
  }

  // ─── Execution ─────────────────────────────────────────────────────────

  admitExecution(request: ExecuteRequest): TaskRecord {
    const reqId = request.requestId ?? generateRequestId();
    const session = this.registry.getSession(request.sessionId);
    if (!session) {
      throw new Error(`Session ${request.sessionId} not found`);
    }

    const timeout = request.timeoutMs ? clampTimeout(request.timeoutMs) : undefined;
    const epoch = this.registry.nextExecuteEpoch(request.sessionId);

    const identity = {
      relayInstanceId: this.relayInstanceId,
      principalId: request.principalId,
      requestId: reqId,
      sessionId: request.sessionId,
      workerEpoch: 1,
      executeEpoch: epoch,
      connectionEpoch: 1,
    };

    return this.coordinator.admit(identity, timeout);
  }

  getExecutionStatus(requestId: string): StatusResult | null {
    const task = this.coordinator.getTask(requestId);
    if (!task) return null;

    return {
      requestId,
      status: task.status,
      outcome: task.outcome,
      errorCode: task.errorCode,
      remainingMs: this.coordinator.remainingMs(requestId),
    };
  }

  cancelExecution(requestId: string): CancelResult {
    const task = this.coordinator.getTask(requestId);
    if (!task) {
      return { requestId, outcome: 'not_started', cancelled: false };
    }

    const outcome = this.coordinator.cancel(requestId);
    return {
      requestId,
      outcome,
      cancelled: task.status === 'cancelled',
    };
  }

  completeExecution(requestId: string): void {
    this.coordinator.complete(requestId);
  }

  failExecution(requestId: string, errorCode: ExecutionErrorCode, outcome?: ExecutionOutcome): void {
    this.coordinator.fail(requestId, errorCode, outcome);
  }

  // ─── Tab management ────────────────────────────────────────────────────

  claimTab(tabId: number, sessionId: SessionId): TabClaimResult {
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { tabId, sessionId, ok: false, reason: 'Session not found' };
    }

    try {
      this.registry.createLease(sessionId, tabId);
      return { tabId, sessionId, ok: true };
    } catch (err) {
      return {
        tabId,
        sessionId,
        ok: false,
        reason: err instanceof Error ? err.message : 'Failed to claim',
      };
    }
  }

  releaseTab(tabId: number, sessionId: SessionId): boolean {
    return this.registry.releaseLease(sessionId, tabId);
  }

  // ─── Health and drain ──────────────────────────────────────────────────

  getHealth(): HealthMetrics {
    const diag = this.coordinator.diagnostics();
    this.health.updateCounts({
      executions: diag.running,
      queued: diag.queued,
    });
    return this.health.getMetrics();
  }

  startDrain(): DrainResult {
    this.coordinator.startDrain();
    this.health.setDraining();
    const diag = this.coordinator.diagnostics();
    return {
      draining: true,
      drainComplete: this.coordinator.isDrainComplete(),
      activeTasks: diag.running,
    };
  }

  getDrainStatus(): DrainResult {
    const diag = this.coordinator.diagnostics();
    return {
      draining: this.coordinator.isDraining,
      drainComplete: this.coordinator.isDrainComplete(),
      activeTasks: diag.running,
    };
  }

  getVersion(): { instanceId: string; buildSha: string; protocol: string } {
    return {
      instanceId: this.relayInstanceId,
      buildSha: 'dev',
      protocol: '1.0',
    };
  }
}
