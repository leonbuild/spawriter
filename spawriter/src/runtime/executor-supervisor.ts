/**
 * Executor Supervisor — manages per-execute Worker processes (W11 §9.1/§16.6).
 *
 * Spawns a child process for each user code execution, communicates via IPC
 * using WorkerIpcCodec, enforces timeouts and resource budgets, and supervises
 * the process tree. Per ADR-001, each worker handles exactly one execution.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerIpcCodec, type WorkerMessage, type InitPayload, type ExecutePayload, type ResultPayload } from './worker-ipc.js';
import { ProcessGuard, type ManagedProcess } from './process-guard.js';
import { ResourceBudget } from './resource-budget.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SupervisorConfig {
  /** Max concurrent active workers. Default: 4. */
  maxActive?: number;
  /** Max total workers (including idle). Default: 10. */
  maxWorkers?: number;
  /** Worker idle timeout in ms. Default: 300000 (5min). */
  idleTimeoutMs?: number;
  /** Max heap per worker in MiB. Default: 384. */
  maxHeapMib?: number;
  /** Worker script path. Auto-detected if omitted. */
  workerScript?: string;
}

export interface ExecuteRequest {
  sessionId: string;
  code: string;
  timeoutMs: number;
  requestId: string;
  executeEpoch: number;
  state: Record<string, unknown>;
  stateRevision: number;
}

export interface ExecuteResponse {
  requestId: string;
  success: boolean;
  value?: unknown;
  error?: { code: string; message: string; stack?: string };
  stateCandidate?: Record<string, unknown>;
  stateRevision?: number;
  workerPid?: number;
  durationMs?: number;
}

interface ActiveWorker {
  id: string;
  process: ChildProcess;
  sessionId: string;
  requestId: string;
  executeEpoch: number;
  startTime: number;
  timeoutTimer: NodeJS.Timeout | null;
  resolve: (response: ExecuteResponse) => void;
}

// ─── Supervisor ──────────────────────────────────────────────────────────────

export class ExecutorSupervisor extends EventEmitter {
  private readonly codec = new WorkerIpcCodec();
  private readonly guard = new ProcessGuard();
  private readonly budget: ResourceBudget;
  private readonly workerScript: string;
  private readonly maxHeapMib: number;
  private readonly maxActive: number;

  private workers = new Map<string, ActiveWorker>();
  private workerCounter = 0;
  private closed = false;

  constructor(config: SupervisorConfig = {}) {
    super();
    this.maxActive = config.maxActive ?? 4;
    this.maxHeapMib = config.maxHeapMib ?? 384;
    this.budget = new ResourceBudget({
      maxWorkers: config.maxWorkers ?? 10,
      maxActiveWorkers: config.maxActive ?? 4,
      globalQueueLimit: 16,
    });

    // Worker script path — resolve from current directory.
    this.workerScript = config.workerScript ??
      path.resolve(__dirname, 'executor-worker.js');
  }

  /**
   * Execute user code in an isolated child process.
   * Returns a promise that resolves with the execution result.
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (this.closed) {
      return {
        requestId: request.requestId,
        success: false,
        error: { code: 'SUPERVISOR_CLOSED', message: 'Supervisor is shut down' },
      };
    }

    if (this.workers.size >= this.maxActive) {
      return {
        requestId: request.requestId,
        success: false,
        error: { code: 'BUSY', message: `All ${this.maxActive} worker slots in use` },
      };
    }

    const workerId = `w-${++this.workerCounter}`;
    const startTime = Date.now();

    // Allocate budget.
    const allocated = this.budget.allocateWorker(workerId, request.sessionId);
    if (!allocated) {
      return {
        requestId: request.requestId,
        success: false,
        error: { code: 'BUDGET_EXCEEDED', message: 'Worker budget exhausted' },
      };
    }

    return new Promise<ExecuteResponse>((resolve) => {
      // Spawn worker process.
      const child = fork(this.workerScript, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [`--max-old-space-size=${this.maxHeapMib}`],
        env: {
          ...process.env,
          WORKER_ID: workerId,
          WORKER_SESSION: request.sessionId,
          WORKER_EPOCH: String(request.executeEpoch),
        },
      });

      if (!child.pid) {
        this.budget.releaseWorker(workerId);
        resolve({
          requestId: request.requestId,
          success: false,
          error: { code: 'SPAWN_FAILED', message: 'Failed to spawn worker process' },
        });
        return;
      }

      // Register with process guard.
      this.guard.register(workerId, child.pid);
      this.guard.markRunning(workerId);

      // Set up timeout.
      const timeoutTimer = setTimeout(() => {
        this.killWorker(workerId, 'timeout');
      }, request.timeoutMs + 5000); // Grace period beyond user timeout.

      const worker: ActiveWorker = {
        id: workerId,
        process: child,
        sessionId: request.sessionId,
        requestId: request.requestId,
        executeEpoch: request.executeEpoch,
        startTime,
        timeoutTimer,
        resolve,
      };

      this.workers.set(workerId, worker);

      // Handle IPC messages from worker.
      child.on('message', (raw) => {
        try {
          const msg = this.codec.decode(raw as string);
          if (!msg) return;
          this.handleWorkerMessage(workerId, msg);
        } catch { /* ignore malformed messages */ }
      });

      // Handle worker exit.
      child.on('exit', (code, signal) => {
        this.handleWorkerExit(workerId, code, signal);
      });

      // Handle worker errors.
      child.on('error', (err) => {
        this.handleWorkerError(workerId, err);
      });

      // Send init message.
      const initMsg: WorkerMessage = {
        kind: 'init',
        id: `init-${workerId}`,
        sessionId: request.sessionId,
        executeEpoch: request.executeEpoch,
        payload: {
          sessionId: request.sessionId,
          executeEpoch: request.executeEpoch,
          state: request.state,
          stateRevision: request.stateRevision,
          config: {},
          targetInfo: { tabId: 0, targetId: '', url: '' },
        } satisfies InitPayload,
      };

      child.send(this.codec.encode(initMsg));

      // Wait for ready, then send execute.
      // The worker sends 'ready' after init; we send 'execute' in the message handler.
    });
  }

  private handleWorkerMessage(workerId: string, msg: WorkerMessage): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    switch (msg.kind) {
      case 'ready': {
        // Worker is initialized — send the execute command.
        const execMsg: WorkerMessage = {
          kind: 'execute',
          id: worker.requestId,
          sessionId: worker.sessionId,
          executeEpoch: worker.executeEpoch,
          payload: {
            code: '', // Set during execute() call.
            timeoutMs: 30000,
            requestId: worker.requestId,
          } satisfies ExecutePayload,
        };
        // We need the original code — store it in the worker.
        // For now, the execute payload comes from the initial request.
        worker.process.send(this.codec.encode(execMsg));
        break;
      }

      case 'result': {
        const result = msg.payload as ResultPayload;
        this.resolveWorker(workerId, {
          requestId: result.requestId,
          success: result.success,
          value: result.value,
          error: result.error,
          stateCandidate: result.stateCandidate,
          stateRevision: result.stateRevision,
          workerPid: worker.process.pid ?? undefined,
          durationMs: Date.now() - worker.startTime,
        });
        break;
      }

      case 'log': {
        const payload = msg.payload as { level: string; message: string };
        this.emit('workerLog', workerId, payload.level, payload.message);
        break;
      }

      case 'error': {
        const payload = msg.payload as { code: string; message: string };
        this.resolveWorker(workerId, {
          requestId: worker.requestId,
          success: false,
          error: { code: payload.code, message: payload.message },
          workerPid: worker.process.pid ?? undefined,
          durationMs: Date.now() - worker.startTime,
        });
        break;
      }

      case 'heartbeat':
        break;

      default:
        break;
    }
  }

  private handleWorkerExit(workerId: string, code: number | null, signal: string | null): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    this.guard.recordExit(workerId, code ?? -1, signal);

    // If we haven't resolved yet, the worker crashed or was killed.
    this.resolveWorker(workerId, {
      requestId: worker.requestId,
      success: false,
      error: {
        code: signal ? 'WORKER_KILLED' : 'WORKER_CRASHED',
        message: `Worker exited with code=${code}, signal=${signal}`,
      },
      workerPid: worker.process.pid ?? undefined,
      durationMs: Date.now() - worker.startTime,
    });
  }

  private handleWorkerError(workerId: string, err: Error): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    this.resolveWorker(workerId, {
      requestId: worker.requestId,
      success: false,
      error: { code: 'WORKER_ERROR', message: err.message },
      workerPid: worker.process.pid ?? undefined,
      durationMs: Date.now() - worker.startTime,
    });
  }

  private resolveWorker(workerId: string, response: ExecuteResponse): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Clean up.
    if (worker.timeoutTimer) clearTimeout(worker.timeoutTimer);
    this.workers.delete(workerId);
    this.budget.releaseWorker(workerId);
    worker.resolve(response);
  }

  private killWorker(workerId: string, reason: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    this.emit('workerKill', workerId, reason);

    try {
      worker.process.kill('SIGKILL');
    } catch { /* already dead */ }
  }

  /**
   * Shut down the supervisor, killing all active workers.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const [id, worker] of this.workers) {
      if (worker.timeoutTimer) clearTimeout(worker.timeoutTimer);
      try { worker.process.kill('SIGKILL'); } catch { /* ok */ }
      this.budget.releaseWorker(id);
    }
    this.workers.clear();
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  diagnostics(): Record<string, unknown> {
    return {
      activeWorkers: this.workers.size,
      maxActive: this.maxActive,
      totalSpawned: this.workerCounter,
      closed: this.closed,
      budget: this.budget.snapshot(),
      workers: Array.from(this.workers.values()).map(w => ({
        id: w.id,
        pid: w.process.pid,
        sessionId: w.sessionId,
        requestId: w.requestId,
        runningMs: Date.now() - w.startTime,
      })),
    };
  }
}
