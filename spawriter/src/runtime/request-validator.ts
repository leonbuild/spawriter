/**
 * Request validator — W06 §16.4.
 *
 * Validates incoming HTTP/MCP/CLI requests: body size, timeout range,
 * required fields, session ID format, request identity structure.
 * Centralizes validation rules so they don't drift between transports.
 * Pure logic, no I/O.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}

export interface RequestValidatorConfig {
  /** Max HTTP body bytes. Default: 1048576. */
  maxBodyBytes?: number;
  /** Max code payload bytes. Default: 524288. */
  maxCodeBytes?: number;
  /** Min execution timeout (ms). Default: 100. */
  minTimeoutMs?: number;
  /** Max execution timeout (ms). Default: 120000. */
  maxTimeoutMs?: number;
  /** Max result text bytes. Default: 65536. */
  maxResultTextBytes?: number;
  /** Max result image bytes (decoded). Default: 8388608. */
  maxResultImageBytes?: number;
  /** Max result total wire bytes. Default: 16777216. */
  maxResultWireBytes?: number;
  /** Session ID pattern. Default: /^sw-[a-z0-9]{4,32}$/. */
  sessionIdPattern?: RegExp;
}

// ─── Validator ───────────────────────────────────────────────────────────────

export class RequestValidator {
  private readonly maxBodyBytes: number;
  private readonly maxCodeBytes: number;
  private readonly minTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxResultTextBytes: number;
  private readonly maxResultImageBytes: number;
  private readonly maxResultWireBytes: number;
  private readonly sessionIdPattern: RegExp;

  constructor(config: RequestValidatorConfig = {}) {
    this.maxBodyBytes = config.maxBodyBytes ?? 1_048_576;
    this.maxCodeBytes = config.maxCodeBytes ?? 524_288;
    this.minTimeoutMs = config.minTimeoutMs ?? 100;
    this.maxTimeoutMs = config.maxTimeoutMs ?? 120_000;
    this.maxResultTextBytes = config.maxResultTextBytes ?? 65_536;
    this.maxResultImageBytes = config.maxResultImageBytes ?? 8_388_608;
    this.maxResultWireBytes = config.maxResultWireBytes ?? 16_777_216;
    this.sessionIdPattern = config.sessionIdPattern ?? /^sw-[a-z0-9]{4,32}$/;
  }

  /**
   * Validate a session ID.
   */
  validateSessionId(sessionId: unknown): ValidationResult {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { valid: false, error: 'Session ID required', errorCode: 'INVALID_SESSION' };
    }
    if (!this.sessionIdPattern.test(sessionId)) {
      return { valid: false, error: `Invalid session ID format: ${sessionId}`, errorCode: 'INVALID_SESSION' };
    }
    return { valid: true };
  }

  /**
   * Validate execution timeout.
   */
  validateTimeout(timeoutMs: unknown): ValidationResult {
    if (timeoutMs == null) return { valid: true }; // Optional.
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
      return { valid: false, error: 'Timeout must be a finite number', errorCode: 'INVALID_TIMEOUT' };
    }
    if (timeoutMs < this.minTimeoutMs) {
      return { valid: false, error: `Timeout below minimum ${this.minTimeoutMs}ms`, errorCode: 'INVALID_TIMEOUT' };
    }
    if (timeoutMs > this.maxTimeoutMs) {
      return { valid: false, error: `Timeout exceeds maximum ${this.maxTimeoutMs}ms`, errorCode: 'INVALID_TIMEOUT' };
    }
    return { valid: true };
  }

  /**
   * Validate HTTP body size.
   */
  validateBodySize(bytes: number): ValidationResult {
    if (bytes > this.maxBodyBytes) {
      return { valid: false, error: `Body ${bytes} exceeds limit ${this.maxBodyBytes}`, errorCode: 'BODY_TOO_LARGE' };
    }
    return { valid: true };
  }

  /**
   * Validate code payload size.
   */
  validateCodeSize(code: string): ValidationResult {
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > this.maxCodeBytes) {
      return { valid: false, error: `Code ${bytes}B exceeds limit ${this.maxCodeBytes}B`, errorCode: 'CODE_TOO_LARGE' };
    }
    return { valid: true };
  }

  /**
   * Validate result size.
   */
  validateResultSize(textBytes: number, imageBytes: number = 0): ValidationResult {
    if (textBytes > this.maxResultTextBytes) {
      return { valid: false, error: `Result text ${textBytes}B exceeds ${this.maxResultTextBytes}B`, errorCode: 'RESULT_TOO_LARGE' };
    }
    if (imageBytes > this.maxResultImageBytes) {
      return { valid: false, error: `Result image ${imageBytes}B exceeds ${this.maxResultImageBytes}B`, errorCode: 'RESULT_TOO_LARGE' };
    }
    const total = textBytes + imageBytes;
    if (total > this.maxResultWireBytes) {
      return { valid: false, error: `Result total ${total}B exceeds wire limit ${this.maxResultWireBytes}B`, errorCode: 'RESULT_TOO_LARGE' };
    }
    return { valid: true };
  }

  /**
   * Validate a request ID.
   */
  validateRequestId(requestId: unknown): ValidationResult {
    if (typeof requestId !== 'string' || !requestId) {
      return { valid: false, error: 'Request ID required', errorCode: 'INVALID_REQUEST' };
    }
    if (requestId.length > 128) {
      return { valid: false, error: 'Request ID too long', errorCode: 'INVALID_REQUEST' };
    }
    return { valid: true };
  }

  /**
   * Validate an execute request's essential fields.
   */
  validateExecuteRequest(req: {
    sessionId?: unknown;
    code?: unknown;
    timeoutMs?: unknown;
    requestId?: unknown;
  }): ValidationResult {
    const sid = this.validateSessionId(req.sessionId);
    if (!sid.valid) return sid;

    if (typeof req.code !== 'string' || !req.code.trim()) {
      return { valid: false, error: 'Code required', errorCode: 'INVALID_CODE' };
    }

    const codeSize = this.validateCodeSize(req.code);
    if (!codeSize.valid) return codeSize;

    const timeout = this.validateTimeout(req.timeoutMs);
    if (!timeout.valid) return timeout;

    return { valid: true };
  }

  /**
   * Get all configured limits (for /diagnostics or docs).
   */
  limits(): Record<string, number> {
    return {
      maxBodyBytes: this.maxBodyBytes,
      maxCodeBytes: this.maxCodeBytes,
      minTimeoutMs: this.minTimeoutMs,
      maxTimeoutMs: this.maxTimeoutMs,
      maxResultTextBytes: this.maxResultTextBytes,
      maxResultImageBytes: this.maxResultImageBytes,
      maxResultWireBytes: this.maxResultWireBytes,
    };
  }
}
