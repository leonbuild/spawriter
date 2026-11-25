/**
 * Transport V2 — Extension-side wire protocol layer.
 * W08 §16.7 of the stability plan.
 *
 * Manages the connection between Extension ↔ Relay with:
 * - Generation-based fencing (stale callbacks no-op)
 * - Credit-based flow control (backpressure)
 * - Sequence-based ordering
 * - Keepalive ping/pong
 * - Bounded queues (byte + frame caps)
 * - Reconnect with backoff
 *
 * Pure logic layer — actual WebSocket/Port I/O is injected via callbacks.
 */

const WIRE_VERSION = 2;

/** @enum {string} */
const TransportState = /** @type {const} */ ({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  HANDSHAKE: "handshake",
  READY: "ready",
  DRAINING: "draining",
  CLOSED: "closed",
});

/**
 * @typedef {object} TransportConfig
 * @property {number} [initialCredit=64]
 * @property {number} [replenishThreshold=16]
 * @property {number} [maxQueueFrames=256]
 * @property {number} [maxQueueBytes=4194304]
 * @property {number} [keepaliveMs=10000]
 * @property {number} [keepaliveTimeoutMs=5000]
 * @property {number} [maxReconnectDelayMs=30000]
 * @property {number} [baseReconnectDelayMs=500]
 * @property {number} [maxFrameBytes=98304]
 */

/**
 * @typedef {object} TransportMetrics
 * @property {string} state
 * @property {number} generation
 * @property {number} sentSeq
 * @property {number} recvSeq
 * @property {number} sendCredit
 * @property {number} queuedFrames
 * @property {number} queuedBytes
 * @property {number} droppedFrames
 * @property {number} reconnects
 * @property {number} lastPingRttMs
 */

class TransportV2 {
  /**
   * @param {TransportConfig} [config]
   */
  constructor(config = {}) {
    this._initialCredit = config.initialCredit ?? 64;
    this._replenishThreshold = config.replenishThreshold ?? 16;
    this._maxQueueFrames = config.maxQueueFrames ?? 256;
    this._maxQueueBytes = config.maxQueueBytes ?? 4_194_304;
    this._keepaliveMs = config.keepaliveMs ?? 10_000;
    this._keepaliveTimeoutMs = config.keepaliveTimeoutMs ?? 5_000;
    this._maxReconnectDelayMs = config.maxReconnectDelayMs ?? 30_000;
    this._baseReconnectDelayMs = config.baseReconnectDelayMs ?? 500;
    this._maxFrameBytes = config.maxFrameBytes ?? 98_304;

    /** @type {string} */
    this._state = TransportState.DISCONNECTED;
    this._generation = 0;
    this._sentSeq = 0;
    this._recvSeq = 0;
    this._sendCredit = this._initialCredit;
    this._receiveCredit = this._initialCredit;
    this._outstanding = 0;

    /** @type {Array<{env: object, bytes: number}>} */
    this._queue = [];
    this._queueBytes = 0;

    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._keepaliveTimeoutTimer = null;
    this._pendingPingId = 0;
    this._lastPingRttMs = -1;

    this._stats = {
      droppedFrames: 0,
      reconnects: 0,
      creditStalls: 0,
      keepaliveTimeouts: 0,
    };

    // Callbacks (injected)
    /** @type {((data: string) => void) | null} */
    this.onSend = null;
    /** @type {((envelope: object) => void) | null} */
    this.onMessage = null;
    /** @type {((reason: string) => void) | null} */
    this.onDisconnect = null;
    /** @type {((generation: number) => void) | null} */
    this.onReady = null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Signal that the underlying connection is open (call after WS.onopen / Port.connect).
   */
  connectionOpened() {
    if (this._state === TransportState.CLOSED) return;
    this._generation++;
    this._sentSeq = 0;
    this._recvSeq = 0;
    this._sendCredit = this._initialCredit;
    this._receiveCredit = this._initialCredit;
    this._outstanding = 0;
    this._clearQueue();
    this._reconnectAttempts = 0;
    this._state = TransportState.HANDSHAKE;

    this._sendControl({
      type: "hello",
      version: WIRE_VERSION,
      generation: this._generation,
      credit: this._initialCredit,
    });
  }

  /**
   * Process a handshake response from the relay.
   * @param {object} helloAck
   */
  handshakeCompleted(helloAck) {
    if (this._state !== TransportState.HANDSHAKE) return;
    if (helloAck.version !== WIRE_VERSION) {
      this._disconnect("version_mismatch");
      return;
    }
    this._state = TransportState.READY;
    this._startKeepalive();
    this._drainQueue();
    if (this.onReady) this.onReady(this._generation);
  }

  /**
   * Signal that the underlying connection closed.
   * @param {string} [reason]
   */
  connectionClosed(reason = "unknown") {
    const wasReady = this._state === TransportState.READY || this._state === TransportState.HANDSHAKE;
    this._stopTimers();
    this._state = TransportState.DISCONNECTED;
    if (this.onDisconnect && wasReady) {
      this.onDisconnect(reason);
    }
  }

  /**
   * Close permanently. No more reconnects.
   */
  close() {
    this._stopTimers();
    this._clearQueue();
    this._state = TransportState.CLOSED;
  }

  /**
   * Begin draining (stop sending new non-critical messages).
   */
  startDrain() {
    if (this._state === TransportState.READY) {
      this._state = TransportState.DRAINING;
      this._sendControl({ type: "fence", generation: this._generation, reason: "drain" });
    }
  }

  // ─── Sending ─────────────────────────────────────────────────────────

  /**
   * Send a data message (event/command/response).
   * @param {string} kind - 'event' | 'command' | 'response'
   * @param {unknown} payload
   * @param {object} [opts]
   * @param {boolean} [opts.critical=false]
   * @returns {boolean} Whether the message was accepted (sent or queued).
   */
  send(kind, payload, opts = {}) {
    if (this._state === TransportState.CLOSED) return false;
    if (this._state === TransportState.DRAINING && !opts.critical) return false;

    const env = this._buildEnvelope(kind, payload);
    const bytes = this._estimateBytes(env);

    if (bytes > this._maxFrameBytes && !opts.critical) {
      this._stats.droppedFrames++;
      return false;
    }

    if (this._state === TransportState.READY && this._canSend()) {
      this._doSend(env);
      return true;
    }

    // Queue it.
    if (this._queue.length >= this._maxQueueFrames || this._queueBytes + bytes > this._maxQueueBytes) {
      this._stats.droppedFrames++;
      return false;
    }

    this._queue.push({ env, bytes });
    this._queueBytes += bytes;
    return true;
  }

  // ─── Receiving ───────────────────────────────────────────────────────

  /**
   * Process incoming data from the connection.
   * @param {string} rawData
   */
  receive(rawData) {
    let env;
    try {
      env = JSON.parse(rawData);
    } catch {
      return; // Invalid JSON — drop silently.
    }

    if (!env || env.v !== WIRE_VERSION) return;

    // Generation fence: reject messages from old generations.
    if (env.gen < this._generation) return;

    // Sequence check.
    if (typeof env.seq === "number" && env.seq > 0) {
      this._recvSeq = env.seq;
      this._receiveCredit--;
      if (this._receiveCredit <= this._replenishThreshold) {
        const amount = this._initialCredit - this._receiveCredit;
        this._receiveCredit = this._initialCredit;
        this._sendControl({ type: "credit", amount });
      }
    }

    // Process ACK.
    if (typeof env.ack === "number") {
      const acked = env.ack - (this._sentSeq - this._outstanding);
      if (acked > 0) {
        this._outstanding = Math.max(0, this._outstanding - acked);
        this._drainQueue();
      }
    }

    // Process credit.
    if (typeof env.credit === "number" && env.credit > 0) {
      this._sendCredit += env.credit;
      this._drainQueue();
    }

    // Handle control messages.
    if (env.k === "control") {
      this._handleControl(env.p);
      return;
    }

    // Deliver to consumer.
    if (this.onMessage) {
      this.onMessage(env);
    }
  }

  // ─── Reconnect ───────────────────────────────────────────────────────

  /**
   * Calculate the reconnect delay.
   * @returns {number} Delay in ms, or -1 if closed.
   */
  getReconnectDelay() {
    if (this._state === TransportState.CLOSED) return -1;
    const delay = Math.min(
      this._baseReconnectDelayMs * Math.pow(2, this._reconnectAttempts),
      this._maxReconnectDelayMs,
    );
    this._reconnectAttempts++;
    this._stats.reconnects++;
    return delay;
  }

  /**
   * Reset reconnect counter (after a successful connection).
   */
  resetReconnectCounter() {
    this._reconnectAttempts = 0;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────

  /** @returns {TransportMetrics} */
  metrics() {
    return {
      state: this._state,
      generation: this._generation,
      sentSeq: this._sentSeq,
      recvSeq: this._recvSeq,
      sendCredit: this._sendCredit,
      queuedFrames: this._queue.length,
      queuedBytes: this._queueBytes,
      droppedFrames: this._stats.droppedFrames,
      reconnects: this._stats.reconnects,
      lastPingRttMs: this._lastPingRttMs,
    };
  }

  get state() { return this._state; }
  get generation() { return this._generation; }

  // ─── Internal ────────────────────────────────────────────────────────

  /** @private */
  _buildEnvelope(kind, payload) {
    return {
      v: WIRE_VERSION,
      k: kind,
      seq: 0, // Filled on send.
      gen: this._generation,
      p: payload,
    };
  }

  /** @private */
  _doSend(env) {
    env.seq = ++this._sentSeq;
    env.ack = this._recvSeq;
    this._sendCredit--;
    this._outstanding++;
    if (this.onSend) this.onSend(JSON.stringify(env));
  }

  /** @private */
  _canSend() {
    return this._sendCredit > 0;
  }

  /** @private */
  _drainQueue() {
    while (this._queue.length > 0 && this._state === TransportState.READY && this._canSend()) {
      const item = this._queue.shift();
      this._queueBytes -= item.bytes;
      this._doSend(item.env);
    }
  }

  /** @private */
  _clearQueue() {
    this._stats.droppedFrames += this._queue.length;
    this._queue = [];
    this._queueBytes = 0;
  }

  /** @private */
  _sendControl(payload) {
    const env = {
      v: WIRE_VERSION,
      k: "control",
      seq: 0,
      gen: this._generation,
      p: payload,
    };
    if (this.onSend) this.onSend(JSON.stringify(env));
  }

  /** @private */
  _handleControl(payload) {
    if (!payload) return;
    switch (payload.type) {
      case "pong":
        if (payload.id === this._pendingPingId) {
          this._lastPingRttMs = Date.now() - payload.sentAt;
          this._pendingPingId = 0;
          this._clearKeepaliveTimeout();
        }
        break;
      case "ping":
        this._sendControl({
          type: "pong",
          id: payload.id,
          sentAt: payload.sentAt,
          receivedAt: Date.now(),
        });
        break;
      case "fence":
        if (payload.generation > this._generation) {
          this._generation = payload.generation;
          this._clearQueue();
        }
        break;
      case "credit":
        if (typeof payload.amount === "number") {
          this._sendCredit += payload.amount;
          this._drainQueue();
        }
        break;
    }
  }

  /** @private */
  _startKeepalive() {
    this._stopTimers();
    this._keepaliveTimer = setInterval(() => {
      if (this._state !== TransportState.READY) return;
      this._pendingPingId = Date.now();
      this._sendControl({ type: "ping", id: this._pendingPingId, sentAt: this._pendingPingId });
      this._keepaliveTimeoutTimer = setTimeout(() => {
        this._stats.keepaliveTimeouts++;
        this._disconnect("keepalive_timeout");
      }, this._keepaliveTimeoutMs);
      if (this._keepaliveTimeoutTimer.unref) this._keepaliveTimeoutTimer.unref();
    }, this._keepaliveMs);
    if (this._keepaliveTimer.unref) this._keepaliveTimer.unref();
  }

  /** @private */
  _clearKeepaliveTimeout() {
    if (this._keepaliveTimeoutTimer) {
      clearTimeout(this._keepaliveTimeoutTimer);
      this._keepaliveTimeoutTimer = null;
    }
  }

  /** @private */
  _stopTimers() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    this._clearKeepaliveTimeout();
  }

  /** @private */
  _disconnect(reason) {
    this._stopTimers();
    this._state = TransportState.DISCONNECTED;
    if (this.onDisconnect) this.onDisconnect(reason);
  }

  /** @private */
  _estimateBytes(env) {
    // Conservative estimate: JSON stringify + overhead.
    try {
      const payloadStr = typeof env.p === "string" ? env.p : JSON.stringify(env.p);
      return payloadStr.length + 100;
    } catch {
      return 200;
    }
  }
}

export { TransportV2, TransportState, WIRE_VERSION };
