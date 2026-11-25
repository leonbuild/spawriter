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

export type ControlPayload = PingMessage | PongMessage | FenceMessage | CreditMessage;

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
