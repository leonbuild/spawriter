/**
 * Per-tab UI state manager — dirty diff, debounced persistence, title markers,
 * and batched icon updates.
 *
 * §4.3 / W02 of the stability plan. Pure logic module with injected Chrome APIs
 * for testability.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Minimum interval between coalesced updates for each tab (ms). */
const COALESCE_MS = 150;

/** Minimum interval between global icon update passes (ms). */
const ICON_BATCH_MS = 200;

/** Minimum interval between storage persistence flushes (ms). */
const PERSIST_DEBOUNCE_MS = 300;

/** Maximum number of tabs whose title markers are concurrently applied. */
const MAX_CONCURRENT_MARKERS = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── TabUiState ──────────────────────────────────────────────────────────────

/**
 * @typedef {'idle' | 'connecting' | 'connected' | 'error'} TabState
 *
 * @typedef {Object} TabSnapshot
 * @property {TabState} state
 * @property {boolean} attached
 * @property {boolean} owned
 * @property {string} badgeText
 * @property {string} badgeColor
 * @property {string} titlePrefix
 *
 * @typedef {Object} TabUiConfig
 * @property {number} [coalesceMs]
 * @property {number} [iconBatchMs]
 * @property {number} [persistDebounceMs]
 * @property {number} [maxConcurrentMarkers]
 * @property {() => number} [now] - Monotonic clock; defaults to performance.now.
 */

export class TabUiState {
  /**
   * @param {Object} apis - Injected browser APIs for testability.
   * @param {(tabId: number, prefix: string) => Promise<void>} apis.applyMarker
   * @param {(state: object) => Promise<void>} apis.persistStorage
   * @param {(counts: { connected: number; idle: number }) => void} apis.renderIcons
   * @param {TabUiConfig} [config]
   */
  constructor(apis, config = {}) {
    this._apis = apis;
    this._coalesceMs = config.coalesceMs ?? COALESCE_MS;
    this._iconBatchMs = config.iconBatchMs ?? ICON_BATCH_MS;
    this._persistDebounceMs = config.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    this._maxConcurrentMarkers = config.maxConcurrentMarkers ?? MAX_CONCURRENT_MARKERS;
    this._now = config.now ?? (() => performance.now());

    /** @type {Map<number, TabSnapshot>} Last committed snapshot per tab. */
    this._committed = new Map();

    /** @type {Map<number, TabSnapshot>} Next snapshot to process per tab (dirty). */
    this._pending = new Map();

    /** @type {Map<number, ReturnType<typeof setTimeout>>} Coalesce timers. */
    this._timers = new Map();

    /** @type {ReturnType<typeof setTimeout> | null} Batched icon timer. */
    this._iconTimer = null;
    this._iconDirty = false;

    /** @type {ReturnType<typeof setTimeout> | null} Persistence timer. */
    this._persistTimer = null;
    this._persistDirty = false;

    /** @type {Set<number>} Tabs with marker application in-flight. */
    this._markerInflight = new Set();

    /** @type {Set<number>} Tabs awaiting marker after current in-flight completes. */
    this._markerQueued = new Set();

    // Statistics for diagnostics.
    this._stats = {
      updates: 0,
      coalesced: 0,
      iconPasses: 0,
      persists: 0,
      markerApplied: 0,
      markerSkipped: 0,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Update the state for a single tab. Coalesces rapid changes.
   *
   * @param {number} tabId
   * @param {Partial<TabSnapshot>} patch
   */
  update(tabId, patch) {
    this._stats.updates++;

    const current = this._pending.get(tabId) ?? this._committed.get(tabId) ?? defaultSnapshot();
    const next = { ...current, ...patch };
    this._pending.set(tabId, next);

    // If a timer is already running for this tab, we're coalescing.
    if (this._timers.has(tabId)) {
      this._stats.coalesced++;
      return;
    }

    this._timers.set(
      tabId,
      setTimeout(() => {
        this._timers.delete(tabId);
        this._flush(tabId);
      }, this._coalesceMs),
    );
  }

  /**
   * Remove a tab (tab closed / detached). Cleans all state.
   *
   * @param {number} tabId
   */
  remove(tabId) {
    const timer = this._timers.get(tabId);
    if (timer) clearTimeout(timer);
    this._timers.delete(tabId);

    this._committed.delete(tabId);
    this._pending.delete(tabId);
    this._markerInflight.delete(tabId);
    this._markerQueued.delete(tabId);

    this._schedulePersist();
    this._scheduleIcons();
  }

  /**
   * Force a synchronous flush for all pending updates. For use on shutdown.
   */
  flushAll() {
    for (const [tabId, timer] of this._timers) {
      clearTimeout(timer);
      this._flush(tabId);
    }
    this._timers.clear();
  }

  /**
   * @returns {{ connected: number; idle: number }}
   */
  getCounts() {
    let connected = 0;
    let idle = 0;
    for (const snap of this._committed.values()) {
      if (snap.state === 'connected') connected++;
      else if (snap.state === 'idle' && snap.attached) idle++;
    }
    return { connected, idle };
  }

  /**
   * @param {number} tabId
   * @returns {TabSnapshot}
   */
  getSnapshot(tabId) {
    return this._committed.get(tabId) ?? defaultSnapshot();
  }

  /**
   * Diagnostic counters.
   */
  diagnostics() {
    return {
      tabs: this._committed.size,
      pendingFlush: this._pending.size,
      pendingTimers: this._timers.size,
      markerInflight: this._markerInflight.size,
      ...this._stats,
    };
  }

  /**
   * Dispose all timers. After calling this the instance must not be used.
   */
  dispose() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    if (this._iconTimer) { clearTimeout(this._iconTimer); this._iconTimer = null; }
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /** @param {number} tabId */
  _flush(tabId) {
    const next = this._pending.get(tabId);
    if (!next) return;
    this._pending.delete(tabId);

    const prev = this._committed.get(tabId);
    this._committed.set(tabId, next);

    const needIcon = !prev || prev.state !== next.state || prev.attached !== next.attached || prev.owned !== next.owned;
    const needMarker = !prev || prev.titlePrefix !== next.titlePrefix;
    const needPersist = !prev || prev.state !== next.state || prev.attached !== next.attached;

    if (needMarker) this._applyMarker(tabId, next.titlePrefix);
    if (needIcon) this._scheduleIcons();
    if (needPersist) this._schedulePersist();
  }

  _scheduleIcons() {
    this._iconDirty = true;
    if (this._iconTimer) return;
    this._iconTimer = setTimeout(() => {
      this._iconTimer = null;
      if (!this._iconDirty) return;
      this._iconDirty = false;
      this._stats.iconPasses++;
      this._apis.renderIcons(this.getCounts());
    }, this._iconBatchMs);
  }

  _schedulePersist() {
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      if (!this._persistDirty) return;
      this._persistDirty = false;
      this._stats.persists++;
      const state = Object.fromEntries(
        [...this._committed.entries()]
          .filter(([, s]) => s.state !== 'idle')
          .map(([id, s]) => [id, s.state]),
      );
      this._apis.persistStorage(state).catch(() => {});
    }, this._persistDebounceMs);
  }

  /**
   * @param {number} tabId
   * @param {string} prefix
   */
  _applyMarker(tabId, prefix) {
    if (this._markerInflight.has(tabId)) {
      this._markerQueued.add(tabId);
      this._stats.markerSkipped++;
      return;
    }

    if (this._markerInflight.size >= this._maxConcurrentMarkers) {
      this._markerQueued.add(tabId);
      this._stats.markerSkipped++;
      return;
    }

    this._markerInflight.add(tabId);
    this._stats.markerApplied++;
    this._apis.applyMarker(tabId, prefix).catch(() => {}).finally(() => {
      this._markerInflight.delete(tabId);
      // If a newer prefix was queued while we were in-flight, re-apply.
      if (this._markerQueued.has(tabId)) {
        this._markerQueued.delete(tabId);
        const snap = this._committed.get(tabId);
        if (snap) this._applyMarker(tabId, snap.titlePrefix);
      }
      // Drain queued tabs if concurrency freed.
      for (const qTabId of this._markerQueued) {
        if (this._markerInflight.size >= this._maxConcurrentMarkers) break;
        this._markerQueued.delete(qTabId);
        const snap = this._committed.get(qTabId);
        if (snap) this._applyMarker(qTabId, snap.titlePrefix);
      }
    });
  }
}

/** @returns {TabSnapshot} */
function defaultSnapshot() {
  return {
    state: /** @type {const} */ ('idle'),
    attached: false,
    owned: false,
    badgeText: '',
    badgeColor: '#888',
    titlePrefix: '',
  };
}
