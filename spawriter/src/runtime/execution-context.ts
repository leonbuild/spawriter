/**
 * Execution context: deadline management, abort signal, and request identity.
 *
 * Every execution (MCP, CLI, internal) gets a context that tracks remaining
 * budget using the local monotonic clock, provides a composable AbortSignal,
 * and carries immutable identity fields.
 *
 * §16.2/16.5 of the stability plan.
 */

import { ExecutionTimeoutError, type ExecutionPhase } from './execution-errors.js';

/**
 * Monotonic clock wrapper — process.hrtime.bigint() converted to milliseconds.
 * All deadline arithmetic uses this, never Date.now().
 */
export function monoNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Stage-level timeout caps (ms). */
export const STAGE_CAPS: Record<string, number> = {
  connect: 15_000,
  attach: 15_000,
  resolve_target: 2_000,
  warmup: 1_000,
  cdp_command: 20_000,
  navigate: 30_000,
  screenshot: 30_000,
  snapshot: 30_000,
  recovery: 5_000,
};

/** Default execution timeout (ms). */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MIN_EXEC_TIMEOUT_MS = 100;
export const MAX_EXEC_TIMEOUT_MS = 120_000;
export const RECOVERY_GRACE_MS = 5_000;

/**
 * Validate and clamp a user-supplied timeout.
 */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_EXEC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      `Invalid timeout: ${timeoutMs}; must be a finite positive number between ${MIN_EXEC_TIMEOUT_MS} and ${MAX_EXEC_TIMEOUT_MS}`,
    );
  }
  if (timeoutMs < MIN_EXEC_TIMEOUT_MS) return MIN_EXEC_TIMEOUT_MS;
  if (timeoutMs > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return Math.floor(timeoutMs);
}

/**
 * Immutable identity for one execution request.
 */
export interface ExecutionIdentity {
  /** Relay instance ID (changes on restart). */
  readonly relayInstanceId: string;
  /** Authenticated principal (never from user body). */
  readonly principalId: string;
  /** Client-generated opaque request ID. */
  readonly requestId: string;
  /** Immutable effective session ID. */
  readonly sessionId: string;
  /** Monotonically changes on worker restart. */
  readonly workerEpoch: number;
  /** Changes per admitted task. */
  readonly executeEpoch: number;
  /** Changes per CDP socket. */
  readonly connectionEpoch: number;
}

/**
 * Target binding — identifies the physical Chrome target for this execution.
 */
export interface TargetBinding {
  readonly tabId: number;
  readonly targetId: string;
  readonly realSessionId: string;
  readonly leaseEpoch: number;
  readonly transportEpoch: string;
  readonly attachmentEpoch: number;
  readonly installationId: string;
  readonly browserEpoch: string;
  readonly documentEpoch?: number;
  readonly childSessionId?: string;
}

/**
 * A deadline-aware execution context.
 *
 * Created at admission time with a fixed deadline. All subsequent operations
 * consume budget from this context. The abort controller allows cooperative
 * cancellation from any entry point (HTTP disconnect, MCP signal, CLI Ctrl-C).
 */
export class ExecutionContext {
  readonly identity: ExecutionIdentity;
  readonly deadlineMono: number;
  readonly startMono: number;
  private readonly _ac: AbortController;
  private _target: TargetBinding | null = null;

  constructor(identity: ExecutionIdentity, timeoutMs: number) {
    this.identity = identity;
    this.startMono = monoNowMs();
    this.deadlineMono = this.startMono + clampTimeout(timeoutMs);
    this._ac = new AbortController();
  }

  /** The composable abort signal for this execution. */
  get signal(): AbortSignal {
    return this._ac.signal;
  }

  /** Whether cancellation has been requested. */
  get cancelled(): boolean {
    return this._ac.signal.aborted;
  }

  /** The currently bound target (set after admission). */
  get target(): TargetBinding | null {
    return this._target;
  }

  /** Bind a target after admission. Immutable once set. */
  bindTarget(target: TargetBinding): void {
    if (this._target) {
      throw new Error('Target already bound; cannot rebind during execution');
    }
    this._target = target;
  }

  /**
   * Remaining budget in milliseconds.
   * Returns 0 if deadline has passed. Never negative.
   */
  remainingMs(): number {
    return Math.max(0, this.deadlineMono - monoNowMs());
  }

  /** Total elapsed time since start. */
  elapsedMs(): number {
    return monoNowMs() - this.startMono;
  }

  /** Whether the deadline has passed. */
  isExpired(): boolean {
    return monoNowMs() >= this.deadlineMono;
  }

  /**
   * Compute the budget for a named stage.
   * Returns min(remaining, stageCap). Throws if no budget left.
   */
  stageBudgetMs(stage: string): number {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      throw new ExecutionTimeoutError(
        `No budget remaining for stage ${stage}`,
        stage as ExecutionPhase,
      );
    }
    const cap = STAGE_CAPS[stage];
    return cap !== undefined ? Math.min(remaining, cap) : remaining;
  }

  /**
   * Cancel the execution. Idempotent.
   */
  cancel(reason?: string): void {
    if (!this._ac.signal.aborted) {
      this._ac.abort(reason ?? 'cancelled');
    }
  }

  /**
   * Create a child AbortSignal that aborts when either this context's signal
   * or an external signal fires, whichever comes first.
   */
  composeSignal(externalSignal?: AbortSignal): AbortSignal {
    if (!externalSignal) return this.signal;
    return AbortSignal.any([this.signal, externalSignal]);
  }

  /**
   * Run a promise with the remaining stage budget.
   * Throws ExecutionTimeoutError if the stage times out.
   * Throws CancelledError if cancelled.
   */
  async withStageBudget<T>(
    stage: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const budget = this.stageBudgetMs(stage);
    const ac = new AbortController();
    const composed = AbortSignal.any([this.signal, ac.signal]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerReject: ((err: Error) => void) | undefined;
    try {
      const result = await Promise.race([
        fn(composed),
        new Promise<never>((_resolve, reject) => {
          timerReject = reject;
          timer = setTimeout(() => {
            ac.abort('stage_timeout');
            reject(
              new ExecutionTimeoutError(
                `Stage ${stage} timed out after ${budget}ms`,
                stage as ExecutionPhase,
              ),
            );
          }, budget);
          // Unref the timer so it doesn't keep the process alive
          if (timer && typeof timer === 'object' && 'unref' in timer) {
            (timer as NodeJS.Timeout).unref();
          }
        }),
      ]);
      return result;
    } catch (err) {
      if (this.cancelled && !(err instanceof ExecutionTimeoutError)) {
        throw new ExecutionTimeoutError(
          `Stage ${stage} cancelled`,
          stage as ExecutionPhase,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique instance ID for the relay.
 */
export function generateInstanceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `relay-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
