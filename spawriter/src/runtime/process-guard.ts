/**
 * Process guard — monitors child processes, detects hangs, and enforces
 * graceful/hard termination with bounded timeouts.
 *
 * §6.5/9.1/W11 of the stability plan. Inspired by Playwright's process-guard
 * pattern. Pure logic + child_process integration.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProcessState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'killed';

export interface ManagedProcess {
  id: string;
  pid: number;
  state: ProcessState;
  epoch: number;
  startedMono: number;
  stoppedMono?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  restartCount: number;
}

export interface ProcessGuardConfig {
  /** Maximum time to wait for graceful shutdown (ms). */
  gracefulTimeoutMs?: number;
  /** Maximum time before SIGKILL after graceful timeout (ms). */
  killTimeoutMs?: number;
  /** Maximum restart attempts before giving up. */
  maxRestarts?: number;
  /** Restart backoff base in ms. */
  restartBackoffMs?: number;
  /** Maximum child processes tracked. */
  maxProcesses?: number;
}

// ─── ProcessGuard ────────────────────────────────────────────────────────────

export class ProcessGuard {
  private readonly gracefulTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartBackoffMs: number;
  private readonly maxProcesses: number;

  /** All tracked processes by ID. */
  private processes = new Map<string, ManagedProcess>();

  /** Next epoch value per process ID. */
  private nextEpoch = new Map<string, number>();

  /** Pending shutdown timers. */
  private shutdownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Global epoch counter. */
  private globalEpoch = 0;

  constructor(config: ProcessGuardConfig = {}) {
    this.gracefulTimeoutMs = config.gracefulTimeoutMs ?? 10_000;
    this.killTimeoutMs = config.killTimeoutMs ?? 5_000;
    this.maxRestarts = config.maxRestarts ?? 3;
    this.restartBackoffMs = config.restartBackoffMs ?? 1_000;
    this.maxProcesses = config.maxProcesses ?? 20;
  }

  /**
   * Register a new process to be guarded.
   */
  register(id: string, pid: number): ManagedProcess {
    if (this.processes.size >= this.maxProcesses) {
      // Evict oldest stopped/crashed process.
      let evicted = false;
      for (const [eid, proc] of this.processes) {
        if (proc.state === 'stopped' || proc.state === 'crashed' || proc.state === 'killed') {
          this.processes.delete(eid);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        throw new Error(`Process guard capacity (${this.maxProcesses}) reached`);
      }
    }

    const epoch = (this.nextEpoch.get(id) ?? 0) + 1;
    this.nextEpoch.set(id, epoch);
    this.globalEpoch++;

    const proc: ManagedProcess = {
      id,
      pid,
      state: 'starting',
      epoch,
      startedMono: monoNowMs(),
      restartCount: this.processes.get(id)?.restartCount ?? 0,
    };

    this.processes.set(id, proc);
    return proc;
  }

  /**
   * Mark a process as running.
   */
  markRunning(id: string): void {
    const proc = this.processes.get(id);
    if (proc && proc.state === 'starting') {
      proc.state = 'running';
    }
  }

  /**
   * Record a process exit.
   */
  recordExit(id: string, exitCode: number | null, signal: string | null): void {
    const proc = this.processes.get(id);
    if (!proc) return;

    proc.stoppedMono = monoNowMs();
    proc.exitCode = exitCode;
    proc.exitSignal = signal;

    if (proc.state === 'stopping') {
      proc.state = 'stopped';
    } else if (signal === 'SIGKILL') {
      proc.state = 'killed';
    } else {
      proc.state = 'crashed';
    }

    // Clear any pending shutdown timer.
    this.clearShutdownTimer(id);
  }

  /**
   * Initiate graceful shutdown of a process.
   * Returns the process info. Caller should send SIGTERM to the PID.
   */
  initiateShutdown(id: string): ManagedProcess | null {
    const proc = this.processes.get(id);
    if (!proc) return null;
    if (proc.state === 'stopped' || proc.state === 'crashed' || proc.state === 'killed') {
      return proc;
    }

    proc.state = 'stopping';

    // Set a timer for the graceful timeout.
    this.clearShutdownTimer(id);
    const timer = setTimeout(() => {
      this.shutdownTimers.delete(id);
      // If still not stopped after graceful timeout, it needs SIGKILL.
      const current = this.processes.get(id);
      if (current && current.state === 'stopping') {
        // The caller should send SIGKILL at this point.
        // We set a final timer for the kill timeout.
        const killTimer = setTimeout(() => {
          this.shutdownTimers.delete(id);
          const final = this.processes.get(id);
          if (final && final.state === 'stopping') {
            final.state = 'killed';
            final.stoppedMono = monoNowMs();
          }
        }, this.killTimeoutMs);
        if (typeof killTimer === 'object' && 'unref' in killTimer) {
          (killTimer as NodeJS.Timer).unref();
        }
        this.shutdownTimers.set(id, killTimer);
      }
    }, this.gracefulTimeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timer).unref();
    }
    this.shutdownTimers.set(id, timer);

    return proc;
  }

  /**
   * Check if a process should be restarted (not exceeding max restarts).
   */
  shouldRestart(id: string): { restart: boolean; backoffMs: number } {
    const proc = this.processes.get(id);
    if (!proc) return { restart: false, backoffMs: 0 };
    if (proc.state !== 'crashed' && proc.state !== 'killed') {
      return { restart: false, backoffMs: 0 };
    }

    if (proc.restartCount >= this.maxRestarts) {
      return { restart: false, backoffMs: 0 };
    }

    const backoff = this.restartBackoffMs * Math.pow(2, proc.restartCount);
    return { restart: true, backoffMs: Math.min(backoff, 30_000) };
  }

  /**
   * Increment the restart count for a process.
   */
  recordRestart(id: string): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.restartCount++;
    }
  }

  /**
   * Get a managed process by ID.
   */
  getProcess(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  /**
   * Check if a process is alive (starting or running).
   */
  isAlive(id: string): boolean {
    const proc = this.processes.get(id);
    return proc != null && (proc.state === 'starting' || proc.state === 'running');
  }

  /**
   * Check if a process needs force-kill (past graceful timeout while stopping).
   */
  needsForceKill(id: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || proc.state !== 'stopping') return false;
    // Check if graceful timeout has elapsed.
    const elapsed = monoNowMs() - (proc.stoppedMono ?? proc.startedMono);
    return elapsed > this.gracefulTimeoutMs;
  }

  /**
   * Get all tracked processes.
   */
  listAll(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  /**
   * Get all alive processes.
   */
  listAlive(): ManagedProcess[] {
    return this.listAll().filter(p => p.state === 'starting' || p.state === 'running');
  }

  /**
   * Diagnostic info.
   */
  diagnostics(): {
    total: number;
    alive: number;
    stopping: number;
    stopped: number;
    crashed: number;
    globalEpoch: number;
  } {
    let alive = 0, stopping = 0, stopped = 0, crashed = 0;
    for (const p of this.processes.values()) {
      switch (p.state) {
        case 'starting':
        case 'running':
          alive++;
          break;
        case 'stopping':
          stopping++;
          break;
        case 'stopped':
          stopped++;
          break;
        case 'crashed':
        case 'killed':
          crashed++;
          break;
      }
    }
    return {
      total: this.processes.size,
      alive,
      stopping,
      stopped,
      crashed,
      globalEpoch: this.globalEpoch,
    };
  }

  /**
   * Dispose all timers.
   */
  dispose(): void {
    for (const timer of this.shutdownTimers.values()) {
      clearTimeout(timer);
    }
    this.shutdownTimers.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private clearShutdownTimer(id: string): void {
    const existing = this.shutdownTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.shutdownTimers.delete(id);
    }
  }
}
