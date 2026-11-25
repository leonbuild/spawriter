/**
 * Typed execution errors for the Spawriter relay.
 *
 * Every error that can occur during execute/navigate/CDP command is classified
 * with a machine-readable code, outcome, and phase so that callers can
 * distinguish "never sent" from "result unknown" from "confirmed failure".
 *
 * §16.1/6.1 of the stability plan.
 */

/** Machine-readable error codes. */
export type ExecutionErrorCode =
  | 'SESSION_BUSY'
  | 'INSUFFICIENT_BUDGET'
  | 'CANCELLED_BEFORE_START'
  | 'CDP_COMMAND_TIMEOUT'
  | 'EXECUTION_TIMEOUT'
  | 'CANCELLED'
  | 'CONNECTION_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'TARGET_DETACHED'
  | 'TARGET_UNHEALTHY'
  | 'TRANSPORT_OVERLOADED'
  | 'RELAY_DRAINING'
  | 'EXECUTOR_RESTARTED'
  | 'INTERNAL_ERROR'
  | 'RESOURCE_LIMIT'
  | 'STATE_UNSERIALIZABLE'
  | 'STATE_LIMIT'
  | 'RESULT_LIMIT'
  | 'UPGRADE_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'PAIRING_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'REQUEST_IN_PROGRESS'
  | 'SHARED_RESOURCE_CONFLICT'
  | 'SERVICE_CONFLICT'
  | 'UNSUPPORTED_SCOPE'
  | 'HANDLE_EXPIRED'
  | 'REF_EXPIRED'
  | 'AMBIGUOUS_REF'
  | 'JOURNAL_DEGRADED';

/**
 * Outcome of a command/task from the caller's perspective.
 * - not_started: nothing was sent to Chrome
 * - failed: Chrome confirmed failure
 * - succeeded: Chrome confirmed success
 * - unknown: command was sent but we don't know the result
 */
export type ExecutionOutcome = 'not_started' | 'failed' | 'succeeded' | 'unknown';

/**
 * Recovery state after an error.
 * - none: no recovery needed
 * - recovered: target is healthy again
 * - quarantined: target is isolated, needs manual check
 * - released: target was released
 */
export type RecoveryState = 'none' | 'recovered' | 'quarantined' | 'released';

/** Phase where the error occurred. */
export type ExecutionPhase =
  | 'admission'
  | 'queue'
  | 'connect'
  | 'attach'
  | 'warmup'
  | 'execute'
  | 'navigate'
  | 'screenshot'
  | 'snapshot'
  | 'cdp_command'
  | 'recovery'
  | 'finishing'
  | 'commit';

/** Structured error metadata attached to execute responses. */
export interface ExecutionErrorMeta {
  requestId: string;
  code: ExecutionErrorCode;
  phase: ExecutionPhase;
  outcome: ExecutionOutcome;
  recovery: RecoveryState;
  retryable: boolean;
  stateRevision?: number;
  stateRolledBack?: boolean;
  stateLost?: boolean;
}

/**
 * Base class for all typed execution errors.
 * Carries a machine-readable code and structured metadata.
 */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly phase: ExecutionPhase;
  readonly outcome: ExecutionOutcome;
  readonly recovery: RecoveryState;
  readonly retryable: boolean;

  constructor(
    code: ExecutionErrorCode,
    message: string,
    opts?: {
      phase?: ExecutionPhase;
      outcome?: ExecutionOutcome;
      recovery?: RecoveryState;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'ExecutionError';
    this.code = code;
    this.phase = opts?.phase ?? 'execute';
    this.outcome = opts?.outcome ?? 'unknown';
    this.recovery = opts?.recovery ?? 'none';
    this.retryable = opts?.retryable ?? false;
  }

  toMeta(requestId: string): ExecutionErrorMeta {
    return {
      requestId,
      code: this.code,
      phase: this.phase,
      outcome: this.outcome,
      recovery: this.recovery,
      retryable: this.retryable,
    };
  }
}

/** Timeout during a CDP command (already sent to Chrome). */
export class CdpCommandTimeoutError extends ExecutionError {
  readonly method: string;
  readonly elapsedMs: number;

  constructor(method: string, elapsedMs: number, opts?: { cause?: unknown }) {
    super('CDP_COMMAND_TIMEOUT', `CDP command ${method} timed out after ${elapsedMs}ms`, {
      phase: 'cdp_command',
      outcome: 'unknown',
      retryable: false,
      cause: opts?.cause,
    });
    this.name = 'CdpCommandTimeoutError';
    this.method = method;
    this.elapsedMs = elapsedMs;
  }
}

/** Timeout during connection/attachment (may or may not have been sent). */
export class ConnectionTimeoutError extends ExecutionError {
  constructor(message: string, opts?: { cause?: unknown }) {
    super('CONNECTION_TIMEOUT', message, {
      phase: 'connect',
      outcome: 'not_started',
      retryable: true,
      cause: opts?.cause,
    });
    this.name = 'ConnectionTimeoutError';
  }
}

/** Overall execution timeout. */
export class ExecutionTimeoutError extends ExecutionError {
  constructor(message: string, phase?: ExecutionPhase, opts?: { cause?: unknown }) {
    super('EXECUTION_TIMEOUT', message, {
      phase: phase ?? 'execute',
      outcome: 'unknown',
      retryable: false,
      cause: opts?.cause,
    });
    this.name = 'ExecutionTimeoutError';
  }
}

/** Navigation failed with an errorText from Chrome. */
export class NavigationError extends ExecutionError {
  readonly errorText: string;
  readonly requestedUrl: string;

  constructor(requestedUrl: string, errorText: string, opts?: { cause?: unknown }) {
    super('NAVIGATION_FAILED', `Navigation to ${requestedUrl} failed: ${errorText}`, {
      phase: 'navigate',
      outcome: 'failed',
      retryable: false,
      cause: opts?.cause,
    });
    this.name = 'NavigationError';
    this.errorText = errorText;
    this.requestedUrl = requestedUrl;
  }
}

/** Session is busy — another task is running or queued. */
export class SessionBusyError extends ExecutionError {
  constructor(sessionId: string) {
    super('SESSION_BUSY', `Session ${sessionId} is busy`, {
      phase: 'admission',
      outcome: 'not_started',
      retryable: true,
    });
    this.name = 'SessionBusyError';
  }
}

/** Target was detached or crashed. */
export class TargetDetachedError extends ExecutionError {
  constructor(message: string) {
    super('TARGET_DETACHED', message, {
      phase: 'execute',
      outcome: 'unknown',
      retryable: false,
    });
    this.name = 'TargetDetachedError';
  }
}

/** Target is unhealthy (quarantined or recovering). */
export class TargetUnhealthyError extends ExecutionError {
  constructor(message: string) {
    super('TARGET_UNHEALTHY', message, {
      phase: 'admission',
      outcome: 'not_started',
      retryable: false,
    });
    this.name = 'TargetUnhealthyError';
  }
}

/** Cancelled before or during execution. */
export class CancelledError extends ExecutionError {
  constructor(phase: ExecutionPhase, outcome: ExecutionOutcome) {
    const code = phase === 'admission' || phase === 'queue'
      ? 'CANCELLED_BEFORE_START'
      : 'CANCELLED';
    super(code, `Execution cancelled during ${phase}`, {
      phase,
      outcome,
      retryable: false,
    });
    this.name = 'CancelledError';
  }
}

/** Relay is draining — no new tasks accepted. */
export class RelayDrainingError extends ExecutionError {
  constructor() {
    super('RELAY_DRAINING', 'Relay is draining; try again after restart', {
      phase: 'admission',
      outcome: 'not_started',
      retryable: true,
    });
    this.name = 'RelayDrainingError';
  }
}

/**
 * Check whether an error is a typed ExecutionError.
 */
export function isExecutionError(err: unknown): err is ExecutionError {
  return err instanceof ExecutionError;
}

/**
 * Classify an unknown error into a typed ExecutionError.
 * Preserves already-typed errors; wraps others as INTERNAL_ERROR.
 */
export function classifyError(err: unknown, phase?: ExecutionPhase): ExecutionError {
  if (isExecutionError(err)) return err;

  const message = err instanceof Error ? err.message : String(err);

  // Heuristic classification based on known error patterns
  if (/timed?\s*out/i.test(message)) {
    if (/connect/i.test(message)) {
      return new ConnectionTimeoutError(message, { cause: err });
    }
    if (/navigat/i.test(message)) {
      return new ExecutionTimeoutError(message, 'navigate', { cause: err });
    }
    return new ExecutionTimeoutError(message, phase, { cause: err });
  }

  if (/target\s+closed|target\s+crash|page\s+closed|context\s+destroyed/i.test(message)) {
    return new TargetDetachedError(message);
  }

  if (/net::ERR_/i.test(message)) {
    return new NavigationError('', message, { cause: err });
  }

  return new ExecutionError('INTERNAL_ERROR', message, {
    phase: phase ?? 'execute',
    outcome: 'unknown',
    cause: err,
  });
}
