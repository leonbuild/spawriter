/**
 * Worker IPC message protocol — W11 §9.1/§16.6/§16.10.
 *
 * Defines the structured message types for Relay ↔ Worker communication.
 * Validates messages, enforces size limits, and provides serialization.
 * Pure types + codec, no actual IPC.
 */

// ─── Message types ───────────────────────────────────────────────────────────

export type WorkerMessageKind =
  | 'init'           // Relay → Worker: initialize with state + config
  | 'execute'        // Relay → Worker: run user code
  | 'cancel'         // Relay → Worker: cancel current execution
  | 'cdp_event'      // Relay → Worker: forwarded CDP event
  | 'cdp_response'   // Relay → Worker: forwarded CDP response
  | 'cdp_command'    // Worker → Relay: CDP command request
  | 'result'         // Worker → Relay: execution result
  | 'state_commit'   // Worker → Relay: state checkpoint
  | 'log'            // Worker → Relay: console/diagnostic output
  | 'ready'          // Worker → Relay: worker ready for execution
  | 'error'          // Worker → Relay: unrecoverable error
  | 'heartbeat'      // Both: keepalive
  | 'shutdown';      // Relay → Worker: graceful shutdown

export interface WorkerMessage {
  kind: WorkerMessageKind;
  /** Request or correlation ID. */
  id: string;
  /** Session ID. */
  sessionId: string;
  /** Execute epoch for ordering/fencing. */
  executeEpoch: number;
  /** Payload. */
  payload: unknown;
  /** Payload byte size estimate. */
  byteSize?: number;
}

// ─── Payloads ────────────────────────────────────────────────────────────────

export interface InitPayload {
  sessionId: string;
  executeEpoch: number;
  state: Record<string, unknown>;
  stateRevision: number;
  config: Record<string, unknown>;
  targetInfo: { tabId: number; targetId: string; url: string };
}

export interface ExecutePayload {
  code: string;
  timeoutMs: number;
  requestId: string;
}

export interface CdpCommandPayload {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  relayId: number;
}

export interface ResultPayload {
  requestId: string;
  success: boolean;
  value?: unknown;
  error?: { code: string; message: string; stack?: string };
  stateCandidate?: Record<string, unknown>;
  stateRevision?: number;
  outputLines?: string[];
}

export interface StateCommitPayload {
  stateRevision: number;
  state: Record<string, unknown>;
  transientKeys: string[];
  byteSize: number;
}

export interface LogPayload {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  args: unknown[];
  timestamp: number;
}

// ─── Codec / Validation ──────────────────────────────────────────────────────

export interface IpcCodecConfig {
  /** Max message byte size. Default: 16777216 (16 MiB). */
  maxMessageBytes?: number;
  /** Max state byte size. Default: 262144 (256 KiB). */
  maxStateBytes?: number;
  /** Max result text bytes. Default: 65536. */
  maxResultTextBytes?: number;
  /** Max output lines. Default: 1000. */
  maxOutputLines?: number;
}

export class WorkerIpcCodec {
  private readonly maxMessageBytes: number;
  private readonly maxStateBytes: number;
  private readonly maxResultTextBytes: number;
  private readonly maxOutputLines: number;

  constructor(config: IpcCodecConfig = {}) {
    this.maxMessageBytes = config.maxMessageBytes ?? 16_777_216;
    this.maxStateBytes = config.maxStateBytes ?? 262_144;
    this.maxResultTextBytes = config.maxResultTextBytes ?? 65_536;
    this.maxOutputLines = config.maxOutputLines ?? 1000;
  }

  /**
   * Encode a message to a JSON string. Returns null if oversized.
   */
  encode(msg: WorkerMessage): string | null {
    try {
      const json = JSON.stringify(msg);
      if (json.length > this.maxMessageBytes) return null;
      return json;
    } catch {
      return null;
    }
  }

  /**
   * Decode a JSON string to a message. Returns null on invalid input.
   */
  decode(data: string): WorkerMessage | null {
    try {
      if (data.length > this.maxMessageBytes) return null;
      const msg = JSON.parse(data);
      if (!this.isValidStructure(msg)) return null;
      return msg as WorkerMessage;
    } catch {
      return null;
    }
  }

  /**
   * Validate basic message structure.
   */
  isValidStructure(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (typeof m.kind !== 'string') return false;
    if (typeof m.id !== 'string') return false;
    if (typeof m.sessionId !== 'string') return false;
    if (typeof m.executeEpoch !== 'number') return false;
    return true;
  }

  /**
   * Validate a state commit payload size.
   */
  validateStateSize(state: Record<string, unknown>): boolean {
    try {
      const json = JSON.stringify(state);
      return json.length <= this.maxStateBytes;
    } catch {
      return false;
    }
  }

  /**
   * Validate result payload.
   */
  validateResult(result: ResultPayload): { valid: boolean; error?: string } {
    if (result.outputLines && result.outputLines.length > this.maxOutputLines) {
      return { valid: false, error: `Too many output lines: ${result.outputLines.length}` };
    }
    try {
      const valueStr = result.value != null ? JSON.stringify(result.value) : '';
      if (valueStr.length > this.maxResultTextBytes) {
        return { valid: false, error: `Result value too large: ${valueStr.length}B` };
      }
    } catch {
      return { valid: false, error: 'Result value not serializable' };
    }
    return { valid: true };
  }

  /**
   * Build common message fields.
   */
  buildMessage(kind: WorkerMessageKind, id: string, sessionId: string, executeEpoch: number, payload: unknown): WorkerMessage {
    return { kind, id, sessionId, executeEpoch, payload };
  }
}
