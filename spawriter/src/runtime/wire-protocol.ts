/**
 * Wire protocol V2 — framing, envelope types, backpressure, and fence markers.
 *
 * §8/W08 of the stability plan. Defines the message envelope format,
 * credit-based flow control, and generation fencing for the Extension↔Relay
 * transport. Pure types and codec — no I/O.
 */

// ─── Envelope ────────────────────────────────────────────────────────────────

export const WIRE_VERSION = 2;
export const MAX_FRAME_SIZE = 8 * 1024 * 1024; // 8 MiB
export const MAX_ENVELOPE_OVERHEAD = 512; // generous estimate for JSON envelope

export type MessageKind =
  | 'event'      // CDP event from extension
  | 'command'    // CDP command to extension
  | 'response'   // CDP response from extension
  | 'control'    // Control messages (ping, fence, credit, etc.)
  | 'ack'        // Acknowledgment
  | 'fence'      // Generation fence marker
  | 'error';     // Transport error

export interface WireEnvelope {
  /** Protocol version. */
  v: number;
  /** Message kind. */
  k: MessageKind;
  /** Sequence number (monotonically increasing per direction). */
  seq: number;
  /** Transport generation epoch. */
  gen: number;
  /** Optional: acknowledged sequence from the other side. */
  ack?: number;
  /** Optional: credits granted (for backpressure). */
  credit?: number;
  /** Payload. */
  p: unknown;
  /** Payload byte size (for accounting). */
  sz?: number;
  /** Timestamp (ms since connection start). */
  ts?: number;
}

// ─── Control messages ────────────────────────────────────────────────────────

export interface PingMessage {
  type: 'ping';
  id: number;
  sentAt: number;
}

export interface PongMessage {
  type: 'pong';
  id: number;
  sentAt: number;
  receivedAt: number;
}

export interface FenceMessage {
  type: 'fence';
  generation: number;
  reason: 'reconnect' | 'upgrade' | 'drain' | 'error';
  /** Previous generation to retire. */
  retireGen?: number;
}

export interface CreditMessage {
  type: 'credit';
  /** Number of messages the sender can accept. */
  amount: number;
}

// ─── V2 Handshake (§16.7) ────────────────────────────────────────────────────

export interface HelloMessage {
  type: 'hello';
  version: number;
  /** Client-generated challenge nonce. */
  challenge: string;
  /** Client capabilities. */
  capabilities: string[];
  /** Client build SHA or version identifier. */
  buildId?: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  version: number;
  /** Server's proof: HMAC(challenge, sharedSecret) or echo for initial pairing. */
  proof: string;
  /** Initial telemetry credit. */
  telemetryCredit: number;
  /** Initial critical-data credit. */
  criticalCredit: number;
  /** Server's negotiated features. */
  features: string[];
  /** Server build SHA. */
  buildId?: string;
  /** Instance ID. */
  instanceId?: string;
}

export interface RejectMessage {
  type: 'reject';
  version: number;
  code: 'VERSION_MISMATCH' | 'AUTH_FAILED' | 'UPGRADE_REQUIRED' | 'BUSY';
  message: string;
}

export type HandshakePayload = HelloMessage | WelcomeMessage | RejectMessage;

export type ControlPayload = PingMessage | PongMessage | FenceMessage | CreditMessage | HandshakePayload;

// ─── Codec ───────────────────────────────────────────────────────────────────

/**
 * Encode an envelope to a JSON string.
 */
export function encodeEnvelope(envelope: WireEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Decode a JSON string to an envelope. Returns null on invalid input.
 */
export function decodeEnvelope(data: string): WireEnvelope | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== WIRE_VERSION) return null;
    if (!parsed.k || typeof parsed.seq !== 'number' || typeof parsed.gen !== 'number') return null;
    return parsed as WireEnvelope;
  } catch {
    return null;
  }
}

/**
 * Validate an envelope's basic structure.
 */
export function validateEnvelope(env: WireEnvelope): string | null {
  if (env.v !== WIRE_VERSION) return `Unsupported version: ${env.v}`;
  if (typeof env.seq !== 'number' || env.seq < 0) return 'Invalid seq';
  if (typeof env.gen !== 'number' || env.gen < 0) return 'Invalid gen';
  if (!['event', 'command', 'response', 'control', 'ack', 'fence', 'error'].includes(env.k)) {
    return `Unknown kind: ${env.k}`;
  }
  return null;
}

// ─── Flow control ────────────────────────────────────────────────────────────

export interface FlowControlConfig {
  /** Initial credit (messages the peer can send). */
  initialCredit?: number;
  /** Credit replenish threshold. */
  replenishThreshold?: number;
  /** Maximum outstanding (unacked) messages. */
  maxOutstanding?: number;
}

export class FlowControl {
  private readonly initialCredit: number;
  private readonly replenishThreshold: number;
  private readonly maxOutstanding: number;

  /** Credits available for sending. */
  private sendCredit: number;
  /** Credits available for receiving (how many the peer can send). */
  private receiveCredit: number;
  /** Number of messages sent but not yet acked. */
  private outstanding: number = 0;
  /** Last sequence number sent. */
  private lastSentSeq: number = 0;
  /** Last sequence number received. */
  private lastReceivedSeq: number = 0;
  /** Last sequence we've acked to the peer. */
  private lastAckedSeq: number = 0;

  constructor(config: FlowControlConfig = {}) {
    this.initialCredit = config.initialCredit ?? 64;
    this.replenishThreshold = config.replenishThreshold ?? 16;
    this.maxOutstanding = config.maxOutstanding ?? 128;
    this.sendCredit = this.initialCredit;
    this.receiveCredit = this.initialCredit;
  }

  /**
   * Check if we can send a message.
   */
  canSend(): boolean {
    return this.sendCredit > 0 && this.outstanding < this.maxOutstanding;
  }

  /**
   * Record a sent message.
   */
  recordSent(): number {
    this.sendCredit--;
    this.outstanding++;
    return ++this.lastSentSeq;
  }

  /**
   * Record a received message. Returns true if we should replenish credit.
   */
  recordReceived(seq: number): boolean {
    this.lastReceivedSeq = seq;
    this.receiveCredit--;
    return this.receiveCredit <= this.replenishThreshold;
  }

  /**
   * Process an ack from the peer.
   */
  processAck(ackedSeq: number): void {
    const acked = ackedSeq - (this.lastSentSeq - this.outstanding);
    if (acked > 0) {
      this.outstanding = Math.max(0, this.outstanding - acked);
    }
  }

  /**
   * Process credit from the peer.
   */
  processCredit(amount: number): void {
    this.sendCredit += amount;
  }

  /**
   * Calculate credit to send to the peer (replenish).
   */
  calculateReplenish(): number {
    const consumed = this.initialCredit - this.receiveCredit;
    if (consumed >= this.replenishThreshold) {
      this.receiveCredit += consumed;
      this.lastAckedSeq = this.lastReceivedSeq;
      return consumed;
    }
    return 0;
  }

  /**
   * Reset flow control (new connection).
   */
  reset(): void {
    this.sendCredit = this.initialCredit;
    this.receiveCredit = this.initialCredit;
    this.outstanding = 0;
    this.lastSentSeq = 0;
    this.lastReceivedSeq = 0;
    this.lastAckedSeq = 0;
  }

  diagnostics(): {
    sendCredit: number;
    receiveCredit: number;
    outstanding: number;
    lastSentSeq: number;
    lastReceivedSeq: number;
  } {
    return {
      sendCredit: this.sendCredit,
      receiveCredit: this.receiveCredit,
      outstanding: this.outstanding,
      lastSentSeq: this.lastSentSeq,
      lastReceivedSeq: this.lastReceivedSeq,
    };
  }
}

// ─── V2 Handshake State Machine (§16.7.5) ────────────────────────────────────

export type HandshakeState = 'idle' | 'hello_sent' | 'established' | 'rejected';

export interface HandshakeConfig {
  /** Protocol version to negotiate. */
  version?: number;
  /** Supported capabilities. */
  capabilities?: string[];
  /** Build ID for version tracking. */
  buildId?: string;
  /** Initial telemetry credit to offer. */
  telemetryCredit?: number;
  /** Initial critical-data credit to offer. */
  criticalCredit?: number;
  /** Instance ID for the server. */
  instanceId?: string;
}

export class HandshakeManager {
  private state: HandshakeState = 'idle';
  private challenge: string = '';
  private readonly config: Required<Omit<HandshakeConfig, 'instanceId'>> & { instanceId?: string };

  constructor(config: HandshakeConfig = {}) {
    this.config = {
      version: config.version ?? WIRE_VERSION,
      capabilities: config.capabilities ?? ['v2-flow', 'v2-fence', 'v2-chunk'],
      buildId: config.buildId ?? 'unknown',
      telemetryCredit: config.telemetryCredit ?? 256 * 1024,
      criticalCredit: config.criticalCredit ?? 512 * 1024,
      instanceId: config.instanceId,
    };
  }

  /** Create a HELLO message (client side). */
  createHello(): HelloMessage {
    this.challenge = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.state = 'hello_sent';
    return {
      type: 'hello',
      version: this.config.version,
      challenge: this.challenge,
      capabilities: this.config.capabilities,
      buildId: this.config.buildId,
    };
  }

  /** Process a HELLO and create a WELCOME (server side). */
  processHello(hello: HelloMessage): WelcomeMessage | RejectMessage {
    if (hello.version !== this.config.version) {
      this.state = 'rejected';
      return {
        type: 'reject',
        version: this.config.version,
        code: 'VERSION_MISMATCH',
        message: `Expected version ${this.config.version}, got ${hello.version}`,
      };
    }

    this.state = 'established';
    return {
      type: 'welcome',
      version: this.config.version,
      proof: `proof-${hello.challenge}`,
      telemetryCredit: this.config.telemetryCredit,
      criticalCredit: this.config.criticalCredit,
      features: this.config.capabilities.filter(c => hello.capabilities.includes(c)),
      buildId: this.config.buildId,
      instanceId: this.config.instanceId,
    };
  }

  /** Process a WELCOME response (client side). */
  processWelcome(welcome: WelcomeMessage): boolean {
    if (this.state !== 'hello_sent') return false;
    if (welcome.version !== this.config.version) return false;
    if (welcome.proof !== `proof-${this.challenge}`) return false;
    this.state = 'established';
    return true;
  }

  /** Process a REJECT response (client side). */
  processReject(_reject: RejectMessage): void {
    this.state = 'rejected';
  }

  getState(): HandshakeState { return this.state; }

  reset(): void {
    this.state = 'idle';
    this.challenge = '';
  }

  diagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      version: this.config.version,
      capabilities: this.config.capabilities,
      buildId: this.config.buildId,
    };
  }
}

// ─── Golden Test Vectors (§16.7.5) ───────────────────────────────────────────
// Canonical test vectors for interoperability testing between Relay and Extension.

export const GOLDEN_VECTORS = {
  validHello: {
    input: { type: 'hello', version: 2, challenge: 'test-ch-001', capabilities: ['v2-flow', 'v2-fence'], buildId: 'test-build' } satisfies HelloMessage,
    expectWelcome: true,
  },
  wrongVersion: {
    input: { type: 'hello', version: 99, challenge: 'test-ch-002', capabilities: ['v2-flow'], buildId: 'test-build' } satisfies HelloMessage,
    expectReject: 'VERSION_MISMATCH',
  },
  validEnvelope: {
    input: '{"v":2,"k":"control","seq":1,"gen":1,"p":{"type":"ping","id":1,"sentAt":1000}}',
    expectDecoded: true,
  },
  invalidVersion: {
    input: '{"v":1,"k":"event","seq":1,"gen":1,"p":{}}',
    expectDecoded: false,
  },
  seqGap: {
    description: 'seq jumps from 1 to 5 — receiver should detect gap',
    frames: [
      { v: 2, k: 'event' as MessageKind, seq: 1, gen: 1, p: {} },
      { v: 2, k: 'event' as MessageKind, seq: 5, gen: 1, p: {} },
    ],
  },
  duplicateAck: {
    description: 'Same ack value sent twice — should be idempotent',
    frames: [
      { v: 2, k: 'ack' as MessageKind, seq: 1, gen: 1, ack: 3, p: {} },
      { v: 2, k: 'ack' as MessageKind, seq: 2, gen: 1, ack: 3, p: {} },
    ],
  },
  oversizedFrame: {
    description: 'Frame exceeding MAX_FRAME_SIZE should be rejected',
    payloadSize: MAX_FRAME_SIZE + 1,
  },
  oldGeneration: {
    description: 'Message with old generation epoch should be dropped',
    currentGen: 5,
    frame: { v: 2, k: 'event' as MessageKind, seq: 1, gen: 3, p: {} },
  },
  fenceWithRetire: {
    input: { type: 'fence', generation: 5, reason: 'reconnect' as const, retireGen: 4 } satisfies FenceMessage,
  },
  cancelFence: {
    description: 'Cancel fence should stop active execution',
    input: { type: 'fence', generation: 6, reason: 'drain' as const, retireGen: 5 } satisfies FenceMessage,
  },
} as const;
