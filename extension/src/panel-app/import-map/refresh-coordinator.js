/**
 * Refresh coordinator — single-flight, debounced, per-tab/document refresh
 * coordination for the DevTools panel.
 *
 * §7.6/W13 of the stability plan. Prevents parallel import-map reads,
 * manages document generation tracking, and enforces deadlines on
 * inspectedWindow.eval calls.
 *
 * Pure logic module with injected eval/state APIs for testability.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_EVAL_TIMEOUT_MS = 1500;
const DEFAULT_TOTAL_BUDGET_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_SCHEDULE = [150, 300, 500];

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {'idle' | 'refreshing' | 'dirty' | 'degraded' | 'disposed'} CoordinatorState
 *
 * @typedef {Object} RefreshResult
 * @property {boolean} success
 * @property {any} data
 * @property {string | null} error
 * @property {number} documentEpoch
 * @property {boolean} stale - True if the data may be from a previous document.
 *
 * @typedef {Object} RefreshCoordinatorConfig
 * @property {number} [debounceMs]
 * @property {number} [evalTimeoutMs]
 * @property {number} [totalBudgetMs]
 * @property {number} [maxRetries]
 * @property {() => number} [now]
 *
 * @typedef {Object} RefreshApis
 * @property {(code: string, timeout: number) => Promise<any>} evaluate
 * @property {(result: RefreshResult) => void} onResult
 * @property {(state: CoordinatorState) => void} onStateChange
 */

export class RefreshCoordinator {
  /**
   * @param {RefreshApis} apis
   * @param {RefreshCoordinatorConfig} [config]
   */
  constructor(apis, config = {}) {
    this._apis = apis;
    this._debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this._evalTimeoutMs = config.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this._totalBudgetMs = config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    this._maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._now = config.now ?? (() => performance.now());

    /** @type {CoordinatorState} */
    this._state = 'idle';

    /** @type {number} Document generation counter — increments on navigation. */
    this._documentEpoch = 0;

    /** @type {number | null} Tab ID currently associated. */
    this._tabId = null;

    /** @type {ReturnType<typeof setTimeout> | null} Debounce timer. */
    this._debounceTimer = null;

    /** @type {boolean} Dirty flag — a refresh was requested while one is in-flight. */
    this._dirty = false;

    /** @type {AbortController | null} Current in-flight abort controller. */
    this._inflight = null;

    /** @type {RefreshResult | null} Last successful result. */
    this._lastResult = null;

    /** @type {number} Count of consecutive eval failures. */
    this._failCount = 0;

    this._stats = {
      refreshes: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      debounced: 0,
      documentChanges: 0,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Request a refresh. Debounces rapid calls, single-flights, and queues dirty.
   *
   * @param {string} code - JavaScript to evaluate in the inspected page.
   * @param {{ priority?: 'normal' | 'high' }} [opts]
   */
  requestRefresh(code, opts = {}) {
    if (this._state === 'disposed') return;

    if (this._inflight) {
      this._dirty = true;
      this._pendingCode = code;
      this._stats.debounced++;
      return;
    }

    if (opts.priority === 'high') {
      this._cancelDebounce();
      this._startRefresh(code);
      return;
    }

    this._cancelDebounce();
    this._pendingCode = code;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._startRefresh(code);
    }, this._debounceMs);
  }

  /**
   * Notify of a navigation event — invalidates the current document.
   */
  onNavigated() {
    this._documentEpoch++;
    this._stats.documentChanges++;
    this._cancelInflight();
    this._cancelDebounce();
    this._dirty = false;
    this._failCount = 0;
    this._lastResult = null;
    this._setState('idle');
  }

  /**
   * Notify of panel visibility change.
   *
   * @param {boolean} visible
   */
  onVisibilityChanged(visible) {
    if (!visible) {
      this._cancelInflight();
      this._cancelDebounce();
    }
  }

  /**
   * Dispose the coordinator. Cancels all pending work.
   */
  dispose() {
    this._cancelInflight();
    this._cancelDebounce();
    this._setState('disposed');
  }

  /**
   * @returns {RefreshResult | null}
   */
  get lastResult() {
    return this._lastResult;
  }

  get state() {
    return this._state;
  }

  get documentEpoch() {
    return this._documentEpoch;
  }

  diagnostics() {
    return {
      state: this._state,
      documentEpoch: this._documentEpoch,
      dirty: this._dirty,
      inflight: this._inflight !== null,
      failCount: this._failCount,
      ...this._stats,
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * @param {string} code
   */
  async _startRefresh(code) {
    if (this._state === 'disposed') return;

    const epoch = this._documentEpoch;
    const ac = new AbortController();
    this._inflight = ac;
    this._setState('refreshing');
    this._stats.refreshes++;

    const startTime = this._now();
    let retries = 0;
    let lastError = null;

    while (retries <= this._maxRetries) {
      if (ac.signal.aborted || this._documentEpoch !== epoch) break;

      const elapsed = this._now() - startTime;
      if (elapsed >= this._totalBudgetMs) {
        this._stats.timeouts++;
        lastError = 'Total budget exceeded';
        break;
      }

      try {
        const remaining = Math.min(this._evalTimeoutMs, this._totalBudgetMs - elapsed);
        const data = await this._evaluateWithTimeout(code, remaining, ac.signal);

        if (this._documentEpoch !== epoch) break;

        const result = {
          success: true,
          data,
          error: null,
          documentEpoch: epoch,
          stale: false,
        };
        this._lastResult = result;
        this._failCount = 0;
        this._stats.successes++;
        this._apis.onResult(result);
        this._finishRefresh(epoch);
        return;
      } catch (err) {
        lastError = err?.message ?? String(err);
        retries++;
        if (retries <= this._maxRetries && !ac.signal.aborted && this._documentEpoch === epoch) {
          const backoff = BACKOFF_SCHEDULE[retries - 1] ?? 500;
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    // Failed after all retries.
    if (this._documentEpoch === epoch && !ac.signal.aborted) {
      this._failCount++;
      this._stats.failures++;
      const result = {
        success: false,
        data: null,
        error: lastError,
        documentEpoch: epoch,
        stale: this._lastResult?.documentEpoch === epoch,
      };
      this._apis.onResult(result);

      if (this._failCount >= 3) {
        this._setState('degraded');
      }
    }

    this._finishRefresh(epoch);
  }

  /**
   * @param {string} code
   * @param {number} timeoutMs
   * @param {AbortSignal} signal
   * @returns {Promise<any>}
   */
  _evaluateWithTimeout(code, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Aborted'));

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Eval timeout'));
        }
      }, timeoutMs);

      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Aborted'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this._apis.evaluate(code, timeoutMs).then(
        (val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(val);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(err);
          }
        },
      );
    });
  }

  /** @param {number} epoch */
  _finishRefresh(epoch) {
    this._inflight = null;

    if (this._dirty && this._documentEpoch === epoch && this._state !== 'disposed') {
      this._dirty = false;
      const code = this._pendingCode;
      if (code) this._startRefresh(code);
    } else {
      this._dirty = false;
      if (this._state === 'refreshing') {
        this._setState('idle');
      }
    }
  }

  _cancelInflight() {
    if (this._inflight) {
      this._inflight.abort();
      this._inflight = null;
    }
  }

  _cancelDebounce() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /** @param {CoordinatorState} state */
  _setState(state) {
    if (state === this._state) return;
    this._state = state;
    try { this._apis.onStateChange(state); } catch { /* listener error */ }
  }
}
