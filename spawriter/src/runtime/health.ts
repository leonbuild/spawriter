/**
 * Health monitor and circuit breaker for relay stability.
 *
 * §10/W10 of the stability plan. Tracks metrics, provides health status,
 * and supports an independent watchdog interface.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'draining';

export interface HealthMetrics {
  /** Relay uptime in ms. */
  uptimeMs: number;
  /** Number of active sessions. */
  activeSessions: number;
  /** Number of active executions. */
  activeExecutions: number;
  /** Number of queued executions. */
  queuedExecutions: number;
  /** Extension WebSocket connected? */
  extensionConnected: boolean;
  /** Total events forwarded. */
  eventsForwarded: number;
  /** Total events dropped. */
  eventsDropped: number;
  /** Total execution errors. */
  executionErrors: number;
  /** Total CDP command timeouts. */
  cdpTimeouts: number;
  /** Circuit breaker trips. */
  circuitBreakerTrips: number;
  /** Health status. */
  status: HealthStatus;
  /** Last heartbeat monotonic timestamp. */
  lastHeartbeatMono: number;
  /** Error rate (errors per minute, rolling). */
  errorRatePerMin: number;
}

export interface HealthConfig {
  /** Heartbeat interval in ms. Default 10_000. */
  heartbeatIntervalMs?: number;
  /** Max errors per minute before circuit breaker trips. Default 30. */
  errorRateThreshold?: number;
  /** Circuit breaker cool-down period in ms. Default 60_000. */
  circuitBreakerCooldownMs?: number;
  /** Max seconds without heartbeat before unhealthy. Default 30_000. */
  watchdogTimeoutMs?: number;
  /** Error rate rolling window in ms. Default 60_000. */
  errorWindowMs?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class HealthMonitor {
  private readonly _heartbeatIntervalMs: number;
  private readonly _errorRateThreshold: number;
  private readonly _circuitBreakerCooldownMs: number;
  private readonly _watchdogTimeoutMs: number;
  private readonly _errorWindowMs: number;

  private _startMono: number;
  private _lastHeartbeatMono: number;
  private _status: HealthStatus = 'healthy';

  // Counters.
  private _eventsForwarded = 0;
  private _eventsDropped = 0;
  private _executionErrors = 0;
  private _cdpTimeouts = 0;
  private _circuitBreakerTrips = 0;

  // Extension connectivity.
  private _extensionConnected = false;

  // Session/execution counts (externally updated).
  private _activeSessions = 0;
  private _activeExecutions = 0;
  private _queuedExecutions = 0;

  // Circuit breaker state.
  private _circuitBreakerOpen = false;
  private _circuitBreakerOpenedAt = 0;

  // Rolling error window.
  private _errorTimestamps: number[] = [];

  // Heartbeat timer.
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Listeners for status changes.
  private _onStatusChange: ((status: HealthStatus) => void)[] = [];

  constructor(config: HealthConfig = {}) {
    this._heartbeatIntervalMs = config.heartbeatIntervalMs ?? 10_000;
    this._errorRateThreshold = config.errorRateThreshold ?? 30;
    this._circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? 60_000;
    this._watchdogTimeoutMs = config.watchdogTimeoutMs ?? 30_000;
    this._errorWindowMs = config.errorWindowMs ?? 60_000;

    const now = monoNowMs();
    this._startMono = now;
    this._lastHeartbeatMono = now;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the heartbeat timer.
   */
  start(): void {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      this._heartbeat();
    }, this._heartbeatIntervalMs);
    // Don't prevent process exit.
    if (this._heartbeatTimer && typeof this._heartbeatTimer === 'object' && 'unref' in this._heartbeatTimer) {
      (this._heartbeatTimer as NodeJS.Timer).unref();
    }
  }

  /**
   * Stop the heartbeat timer.
   */
  stop(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Register a status change listener.
   */
  onStatusChange(fn: (status: HealthStatus) => void): void {
    this._onStatusChange.push(fn);
  }

  // ─── Event recording ─────────────────────────────────────────────────────

  recordEventForwarded(count: number = 1): void {
    this._eventsForwarded += count;
  }

  recordEventDropped(count: number = 1): void {
    this._eventsDropped += count;
  }

  recordExecutionError(): void {
    this._executionErrors++;
    this._errorTimestamps.push(monoNowMs());
    this._checkCircuitBreaker();
  }

  recordCdpTimeout(): void {
    this._cdpTimeouts++;
    this._errorTimestamps.push(monoNowMs());
    this._checkCircuitBreaker();
  }

  setExtensionConnected(connected: boolean): void {
    this._extensionConnected = connected;
    if (!connected) {
      this._setStatus('degraded');
    }
  }

  updateCounts(active: { sessions?: number; executions?: number; queued?: number }): void {
    if (active.sessions != null) this._activeSessions = active.sessions;
    if (active.executions != null) this._activeExecutions = active.executions;
    if (active.queued != null) this._queuedExecutions = active.queued;
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  get status(): HealthStatus {
    return this._status;
  }

  get isCircuitBreakerOpen(): boolean {
    return this._circuitBreakerOpen;
  }

  /**
   * Set draining status.
   */
  setDraining(): void {
    this._setStatus('draining');
  }

  /**
   * Get full health metrics snapshot.
   */
  getMetrics(): HealthMetrics {
    const now = monoNowMs();
    return {
      uptimeMs: now - this._startMono,
      activeSessions: this._activeSessions,
      activeExecutions: this._activeExecutions,
      queuedExecutions: this._queuedExecutions,
      extensionConnected: this._extensionConnected,
      eventsForwarded: this._eventsForwarded,
      eventsDropped: this._eventsDropped,
      executionErrors: this._executionErrors,
      cdpTimeouts: this._cdpTimeouts,
      circuitBreakerTrips: this._circuitBreakerTrips,
      status: this._status,
      lastHeartbeatMono: this._lastHeartbeatMono,
      errorRatePerMin: this._computeErrorRate(now),
    };
  }

  /**
   * External watchdog check: is the monitor alive and responsive?
   */
  isWatchdogHealthy(): boolean {
    const now = monoNowMs();
    return now - this._lastHeartbeatMono < this._watchdogTimeoutMs;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private _heartbeat(): void {
    const now = monoNowMs();
    this._lastHeartbeatMono = now;
    this._pruneErrorWindow(now);
    this._checkCircuitBreakerCooldown(now);

    // Re-evaluate overall status.
    if (this._status === 'draining') return;

    if (this._circuitBreakerOpen) {
      this._setStatus('unhealthy');
    } else if (!this._extensionConnected) {
      this._setStatus('degraded');
    } else if (this._computeErrorRate(now) > this._errorRateThreshold * 0.5) {
      this._setStatus('degraded');
    } else {
      this._setStatus('healthy');
    }
  }

  private _checkCircuitBreaker(): void {
    if (this._circuitBreakerOpen) return;
    const now = monoNowMs();
    const rate = this._computeErrorRate(now);
    if (rate >= this._errorRateThreshold) {
      this._circuitBreakerOpen = true;
      this._circuitBreakerOpenedAt = now;
      this._circuitBreakerTrips++;
      this._setStatus('unhealthy');
    }
  }

  private _checkCircuitBreakerCooldown(now: number): void {
    if (!this._circuitBreakerOpen) return;
    if (now - this._circuitBreakerOpenedAt >= this._circuitBreakerCooldownMs) {
      this._circuitBreakerOpen = false;
    }
  }

  private _computeErrorRate(now: number): number {
    this._pruneErrorWindow(now);
    // Errors per minute.
    const windowSec = this._errorWindowMs / 1000;
    return (this._errorTimestamps.length / windowSec) * 60;
  }

  private _pruneErrorWindow(now: number): void {
    const cutoff = now - this._errorWindowMs;
    while (this._errorTimestamps.length > 0 && this._errorTimestamps[0] < cutoff) {
      this._errorTimestamps.shift();
    }
  }

  private _setStatus(status: HealthStatus): void {
    if (status === this._status) return;
    const prev = this._status;
    this._status = status;
    for (const fn of this._onStatusChange) {
      try { fn(status); } catch { /* listener error must not break health */ }
    }
  }
}
