/**
 * Navigation coordinator — classifies, times, and manages navigation lifecycle.
 *
 * §6.5/W09 of the stability plan. Pure logic: receives CDP lifecycle events
 * and returns decisions (wait, timeout, stop, done).
 *
 * Tracks the navigation state machine per frame:
 *   idle → navigating → loading → networkIdle → complete
 *   any → failed (on error or timeout)
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type NavigationState = 'idle' | 'navigating' | 'loading' | 'networkIdle' | 'complete' | 'failed';

export interface NavigationRecord {
  frameId: string;
  url: string;
  state: NavigationState;
  startMono: number;
  deadlineMono: number;
  loaderId?: string;
  errorText?: string;
  /** Number of outstanding network requests. */
  pendingRequests: number;
  /** Whether the DOMContentLoaded event has fired. */
  domContentLoaded: boolean;
  /** Whether the Load event has fired. */
  loadFired: boolean;
}

export interface NavigationConfig {
  /** Default navigation timeout in ms. */
  defaultTimeoutMs?: number;
  /** Network idle threshold: max concurrent requests to consider idle. */
  networkIdleThreshold?: number;
  /** Network idle quiet period in ms. */
  networkIdleQuietMs?: number;
  /** Maximum pending navigations tracked per tab. */
  maxPerTab?: number;
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export class NavigationCoordinator {
  private readonly _defaultTimeoutMs: number;
  private readonly _networkIdleThreshold: number;
  private readonly _networkIdleQuietMs: number;
  private readonly _maxPerTab: number;

  /** Active navigations by frameId. */
  private _navigations = new Map<string, NavigationRecord>();

  /** Pending network request count per frameId. */
  private _pendingNetworkByFrame = new Map<string, number>();

  /** Last time the pending count went below threshold, per frame. */
  private _quietSinceMono = new Map<string, number>();

  constructor(config: NavigationConfig = {}) {
    this._defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
    this._networkIdleThreshold = config.networkIdleThreshold ?? 2;
    this._networkIdleQuietMs = config.networkIdleQuietMs ?? 500;
    this._maxPerTab = config.maxPerTab ?? 16;
  }

  // ─── Navigation lifecycle ──────────────────────────────────────────────

  /**
   * Start tracking a navigation.
   */
  startNavigation(
    frameId: string,
    url: string,
    timeoutMs?: number,
    loaderId?: string,
  ): NavigationRecord {
    const now = monoNowMs();
    const timeout = timeoutMs ?? this._defaultTimeoutMs;

    // Discard any existing navigation for this frame.
    this._navigations.delete(frameId);

    if (this._navigations.size >= this._maxPerTab) {
      // Evict the oldest.
      let oldest: string | null = null;
      let oldestStart = Infinity;
      for (const [fid, nav] of this._navigations) {
        if (nav.startMono < oldestStart) {
          oldestStart = nav.startMono;
          oldest = fid;
        }
      }
      if (oldest) this._navigations.delete(oldest);
    }

    const record: NavigationRecord = {
      frameId,
      url,
      state: 'navigating',
      startMono: now,
      deadlineMono: now + timeout,
      loaderId,
      pendingRequests: 0,
      domContentLoaded: false,
      loadFired: false,
    };

    this._navigations.set(frameId, record);
    return record;
  }

  /**
   * Handle Page.frameNavigated — the main frame has committed a navigation.
   */
  onFrameNavigated(frameId: string, url: string): void {
    const nav = this._navigations.get(frameId);
    if (!nav) return;
    nav.url = url;
    if (nav.state === 'navigating') {
      nav.state = 'loading';
    }
  }

  /**
   * Handle Page.domContentEventFired.
   */
  onDomContentLoaded(frameId: string): void {
    const nav = this._navigations.get(frameId);
    if (nav) nav.domContentLoaded = true;
  }

  /**
   * Handle Page.loadEventFired.
   */
  onLoad(frameId: string): void {
    const nav = this._navigations.get(frameId);
    if (nav) {
      nav.loadFired = true;
      this._checkComplete(frameId);
    }
  }

  /**
   * Handle Page.lifecycleEvent (networkIdle, etc.).
   */
  onLifecycleEvent(frameId: string, name: string): void {
    const nav = this._navigations.get(frameId);
    if (!nav) return;

    if (name === 'networkIdle' || name === 'networkAlmostIdle') {
      if (nav.state === 'loading' || nav.state === 'navigating') {
        nav.state = 'networkIdle';
      }
      this._checkComplete(frameId);
    }
  }

  /**
   * Track a network request starting.
   */
  onNetworkRequestStarted(frameId: string): void {
    const count = (this._pendingNetworkByFrame.get(frameId) ?? 0) + 1;
    this._pendingNetworkByFrame.set(frameId, count);
    this._quietSinceMono.delete(frameId);

    const nav = this._navigations.get(frameId);
    if (nav) nav.pendingRequests = count;
  }

  /**
   * Track a network request finishing.
   */
  onNetworkRequestFinished(frameId: string): void {
    const count = Math.max(0, (this._pendingNetworkByFrame.get(frameId) ?? 0) - 1);
    this._pendingNetworkByFrame.set(frameId, count);

    const nav = this._navigations.get(frameId);
    if (nav) nav.pendingRequests = count;

    if (count <= this._networkIdleThreshold) {
      if (!this._quietSinceMono.has(frameId)) {
        this._quietSinceMono.set(frameId, monoNowMs());
      }
      this._checkComplete(frameId);
    }
  }

  /**
   * Handle navigation error.
   */
  onNavigationError(frameId: string, errorText: string): void {
    const nav = this._navigations.get(frameId);
    if (!nav) return;
    nav.state = 'failed';
    nav.errorText = errorText;
  }

  // ─── Query ─────────────────────────────────────────────────────────────

  /**
   * Get the navigation record for a frame.
   */
  getNavigation(frameId: string): NavigationRecord | undefined {
    return this._navigations.get(frameId);
  }

  /**
   * Check if a navigation has timed out.
   */
  isTimedOut(frameId: string): boolean {
    const nav = this._navigations.get(frameId);
    if (!nav) return false;
    return monoNowMs() >= nav.deadlineMono;
  }

  /**
   * Check if a frame is currently navigating.
   */
  isNavigating(frameId: string): boolean {
    const nav = this._navigations.get(frameId);
    if (!nav) return false;
    return nav.state === 'navigating' || nav.state === 'loading';
  }

  /**
   * Remove a completed or failed navigation.
   */
  removeNavigation(frameId: string): void {
    this._navigations.delete(frameId);
    this._pendingNetworkByFrame.delete(frameId);
    this._quietSinceMono.delete(frameId);
  }

  /**
   * Check all navigations for timeouts. Returns timed-out frameIds.
   */
  checkTimeouts(): string[] {
    const now = monoNowMs();
    const timedOut: string[] = [];
    for (const [frameId, nav] of this._navigations) {
      if (now >= nav.deadlineMono && nav.state !== 'complete' && nav.state !== 'failed') {
        nav.state = 'failed';
        nav.errorText = 'Navigation timeout';
        timedOut.push(frameId);
      }
    }
    return timedOut;
  }

  /**
   * Diagnostic info.
   */
  diagnostics(): { active: number; completed: number; failed: number } {
    let active = 0;
    let completed = 0;
    let failed = 0;
    for (const nav of this._navigations.values()) {
      if (nav.state === 'complete') completed++;
      else if (nav.state === 'failed') failed++;
      else active++;
    }
    return { active, completed, failed };
  }

  /**
   * Reset all navigation state.
   */
  reset(): void {
    this._navigations.clear();
    this._pendingNetworkByFrame.clear();
    this._quietSinceMono.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private _checkComplete(frameId: string): void {
    const nav = this._navigations.get(frameId);
    if (!nav) return;
    if (nav.state === 'complete' || nav.state === 'failed') return;

    // Complete when load event fired AND network is idle.
    if (nav.loadFired && nav.pendingRequests <= this._networkIdleThreshold) {
      const quietSince = this._quietSinceMono.get(frameId);
      if (quietSince && monoNowMs() - quietSince >= this._networkIdleQuietMs) {
        nav.state = 'complete';
      } else if (!quietSince) {
        this._quietSinceMono.set(frameId, monoNowMs());
      }
    }
  }
}
