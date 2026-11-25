/**
 * Debugger lifecycle — single-flight attach/detach, CDP domain initialization,
 * and bounded outstanding command tracking.
 *
 * §4/W05 of the stability plan. Encapsulates the Chrome debugger API calls
 * and enforces concurrency constraints. Pure logic module with injected
 * Chrome APIs for testability.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

const CDP_PROTOCOL_VERSION = '1.3';
const DOMAIN_INIT_TIMEOUT_MS = 10_000;
const DETACH_TIMEOUT_MS = 5_000;
const MAX_PENDING_COMMANDS = 64;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {'idle' | 'attaching' | 'attached' | 'initializing' | 'ready' | 'detaching' | 'error'} DebuggerState
 *
 * @typedef {Object} TabDebuggerInfo
 * @property {number} tabId
 * @property {DebuggerState} state
 * @property {string | null} sessionId
 * @property {string | null} targetId
 * @property {number} attachedAtMono
 * @property {number} pendingCommands
 * @property {string | null} lastError
 *
 * @typedef {Object} DebuggerLifecycleConfig
 * @property {number} [domainInitTimeoutMs]
 * @property {number} [detachTimeoutMs]
 * @property {number} [maxPendingCommands]
 * @property {() => number} [now]
 *
 * @typedef {Object} ChromeApis
 * @property {(target: {tabId: number}, version: string) => Promise<void>} attach
 * @property {(target: {tabId: number}) => Promise<void>} detach
 * @property {(target: {tabId: number}, method: string, params?: object) => Promise<any>} sendCommand
 * @property {() => Promise<Array<{tabId?: number, attached: boolean}>>} getTargets
 */

// ─── DebuggerLifecycle ───────────────────────────────────────────────────────

export class DebuggerLifecycle {
  /**
   * @param {ChromeApis} chrome
   * @param {DebuggerLifecycleConfig} [config]
   */
  constructor(chrome, config = {}) {
    this._chrome = chrome;
    this._initTimeoutMs = config.domainInitTimeoutMs ?? DOMAIN_INIT_TIMEOUT_MS;
    this._detachTimeoutMs = config.detachTimeoutMs ?? DETACH_TIMEOUT_MS;
    this._maxPending = config.maxPendingCommands ?? MAX_PENDING_COMMANDS;
    this._now = config.now ?? (() => performance.now());

    /** @type {Map<number, TabDebuggerInfo>} */
    this._tabs = new Map();

    /** @type {Map<number, Promise<TabDebuggerInfo>>} In-flight attach/detach single-flights. */
    this._flights = new Map();

    this._stats = {
      attaches: 0,
      detaches: 0,
      errors: 0,
      commandsSent: 0,
      commandsCompleted: 0,
      commandsRejected: 0,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Attach to a tab, enable domains, return ready info.
   * Single-flight: concurrent calls for the same tab coalesce.
   *
   * @param {number} tabId
   * @returns {Promise<TabDebuggerInfo>}
   */
  async attach(tabId) {
    // If already in a flight (attaching/detaching), wait for it.
    const existing = this._flights.get(tabId);
    if (existing) return existing;

    // If already attached/ready, return the info.
    const info = this._tabs.get(tabId);
    if (info && (info.state === 'attached' || info.state === 'ready')) {
      return info;
    }

    const flight = this._doAttach(tabId);
    this._flights.set(tabId, flight);
    try {
      return await flight;
    } finally {
      this._flights.delete(tabId);
    }
  }

  /**
   * Detach from a tab. Single-flight.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async detach(tabId) {
    const existing = this._flights.get(tabId);
    if (existing) {
      // If currently attaching, wait then detach.
      try { await existing; } catch { /* continue to detach */ }
    }

    const info = this._tabs.get(tabId);
    if (!info || info.state === 'idle') return;

    const flight = this._doDetach(tabId);
    this._flights.set(tabId, flight);
    try {
      await flight;
    } finally {
      this._flights.delete(tabId);
    }
  }

  /**
   * Send a CDP command through the debugger API.
   * Bounded: rejects if max pending commands exceeded.
   *
   * @param {number} tabId
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async sendCommand(tabId, method, params) {
    const info = this._tabs.get(tabId);
    if (!info || (info.state !== 'attached' && info.state !== 'ready' && info.state !== 'initializing')) {
      this._stats.commandsRejected++;
      throw new Error(`Tab ${tabId} not attached (state: ${info?.state ?? 'unknown'})`);
    }

    if (info.pendingCommands >= this._maxPending) {
      this._stats.commandsRejected++;
      throw new Error(`Tab ${tabId}: max pending commands (${this._maxPending}) exceeded`);
    }

    info.pendingCommands++;
    this._stats.commandsSent++;
    try {
      const result = await this._chrome.sendCommand({ tabId }, method, params);
      this._stats.commandsCompleted++;
      return result;
    } catch (err) {
      this._stats.errors++;
      throw err;
    } finally {
      info.pendingCommands = Math.max(0, info.pendingCommands - 1);
    }
  }

  /**
   * Get info for a tab.
   *
   * @param {number} tabId
   * @returns {TabDebuggerInfo | undefined}
   */
  getInfo(tabId) {
    return this._tabs.get(tabId);
  }

  /**
   * Check if a tab is attached.
   *
   * @param {number} tabId
   * @returns {boolean}
   */
  isAttached(tabId) {
    const info = this._tabs.get(tabId);
    return info != null && (info.state === 'attached' || info.state === 'ready' || info.state === 'initializing');
  }

  /**
   * Remove all state for a tab (tab closed, etc.).
   *
   * @param {number} tabId
   */
  removeTab(tabId) {
    this._tabs.delete(tabId);
    this._flights.delete(tabId);
  }

  diagnostics() {
    return {
      tabs: this._tabs.size,
      flights: this._flights.size,
      ...this._stats,
    };
  }

  dispose() {
    this._tabs.clear();
    this._flights.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * @param {number} tabId
   * @returns {Promise<TabDebuggerInfo>}
   */
  async _doAttach(tabId) {
    const info = {
      tabId,
      state: /** @type {DebuggerState} */ ('attaching'),
      sessionId: null,
      targetId: null,
      attachedAtMono: this._now(),
      pendingCommands: 0,
      lastError: null,
    };
    this._tabs.set(tabId, info);

    try {
      await this._chrome.attach({ tabId }, CDP_PROTOCOL_VERSION);
      info.state = 'attached';
      this._stats.attaches++;

      // Enable core domains with timeout.
      info.state = 'initializing';
      await this._withTimeout(
        Promise.all([
          this._chrome.sendCommand({ tabId }, 'Page.enable'),
          this._chrome.sendCommand({ tabId }, 'Runtime.enable'),
          this._chrome.sendCommand({ tabId }, 'Network.enable'),
        ]),
        this._initTimeoutMs,
        `Domain init timeout for tab ${tabId}`,
      );

      // Get frame tree for target ID.
      let targetId = `spawriter-tab-${tabId}-${Date.now()}`;
      try {
        const frameTree = await this._withTimeout(
          this._chrome.sendCommand({ tabId }, 'Page.getFrameTree'),
          2000,
          'getFrameTree timeout',
        );
        targetId = frameTree?.frameTree?.frame?.id || targetId;
      } catch {
        // non-fatal
      }

      info.sessionId = `spawriter-tab-${tabId}-${Date.now()}`;
      info.targetId = targetId;
      info.state = 'ready';
      return info;
    } catch (err) {
      info.state = 'error';
      info.lastError = err?.message ?? String(err);
      this._stats.errors++;
      throw err;
    }
  }

  /**
   * @param {number} tabId
   * @returns {Promise<TabDebuggerInfo>}
   */
  async _doDetach(tabId) {
    const info = this._tabs.get(tabId);
    if (!info) return { tabId, state: 'idle', sessionId: null, targetId: null, attachedAtMono: 0, pendingCommands: 0, lastError: null };

    info.state = 'detaching';
    try {
      await this._withTimeout(
        this._chrome.detach({ tabId }),
        this._detachTimeoutMs,
        `Detach timeout for tab ${tabId}`,
      );
      this._stats.detaches++;
    } catch {
      // Best-effort.
    }

    info.state = 'idle';
    info.sessionId = null;
    info.pendingCommands = 0;
    this._tabs.delete(tabId);
    return info;
  }

  /**
   * @param {Promise<any>} promise
   * @param {number} ms
   * @param {string} message
   * @returns {Promise<any>}
   */
  _withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      }, ms);

      promise.then(
        (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } },
        (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
      );
    });
  }
}
