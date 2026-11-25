import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HealthMonitor } from './health.js';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      heartbeatIntervalMs: 100,
      errorRateThreshold: 5,
      circuitBreakerCooldownMs: 200,
      watchdogTimeoutMs: 500,
      errorWindowMs: 1000,
    });
  });

  describe('initial state', () => {
    it('starts healthy', () => {
      assert.equal(monitor.status, 'healthy');
      assert(!monitor.isCircuitBreakerOpen);
    });

    it('reports zero metrics', () => {
      const m = monitor.getMetrics();
      assert.equal(m.eventsForwarded, 0);
      assert.equal(m.eventsDropped, 0);
      assert.equal(m.executionErrors, 0);
      assert.equal(m.cdpTimeouts, 0);
      assert.equal(m.status, 'healthy');
    });
  });

  describe('event recording', () => {
    it('tracks forwarded events', () => {
      monitor.recordEventForwarded(10);
      assert.equal(monitor.getMetrics().eventsForwarded, 10);
    });

    it('tracks dropped events', () => {
      monitor.recordEventDropped(5);
      assert.equal(monitor.getMetrics().eventsDropped, 5);
    });

    it('tracks execution errors', () => {
      monitor.recordExecutionError();
      monitor.recordExecutionError();
      assert.equal(monitor.getMetrics().executionErrors, 2);
    });

    it('tracks CDP timeouts', () => {
      monitor.recordCdpTimeout();
      assert.equal(monitor.getMetrics().cdpTimeouts, 1);
    });
  });

  describe('extension connectivity', () => {
    it('degrades when extension disconnects', () => {
      monitor.setExtensionConnected(false);
      assert.equal(monitor.status, 'degraded');
    });
  });

  describe('circuit breaker (T22)', () => {
    it('trips on high error rate', () => {
      for (let i = 0; i < 10; i++) {
        monitor.recordExecutionError();
      }
      assert(monitor.isCircuitBreakerOpen);
      assert.equal(monitor.status, 'unhealthy');
      assert.equal(monitor.getMetrics().circuitBreakerTrips, 1);
    });

    it('does not trip below threshold', () => {
      // With threshold=5/min and window=1000ms, 1 error in that window = 60/min.
      // Use a higher threshold to test sub-threshold behavior.
      const m = new HealthMonitor({
        errorRateThreshold: 100,
        errorWindowMs: 1000,
      });
      m.recordExecutionError();
      assert(!m.isCircuitBreakerOpen);
    });
  });

  describe('draining', () => {
    it('reports draining status', () => {
      monitor.setDraining();
      assert.equal(monitor.status, 'draining');
    });
  });

  describe('watchdog', () => {
    it('reports healthy when heartbeat is recent', () => {
      assert(monitor.isWatchdogHealthy());
    });
  });

  describe('count updates', () => {
    it('updates session and execution counts', () => {
      monitor.updateCounts({ sessions: 3, executions: 2, queued: 1 });
      const m = monitor.getMetrics();
      assert.equal(m.activeSessions, 3);
      assert.equal(m.activeExecutions, 2);
      assert.equal(m.queuedExecutions, 1);
    });
  });

  describe('status change listener', () => {
    it('fires on status transition', () => {
      const statuses: string[] = [];
      monitor.onStatusChange((s) => statuses.push(s));
      monitor.setExtensionConnected(false);
      monitor.setDraining();
      assert.deepEqual(statuses, ['degraded', 'draining']);
    });

    it('does not fire for same status', () => {
      const statuses: string[] = [];
      monitor.onStatusChange((s) => statuses.push(s));
      monitor.setExtensionConnected(false);
      monitor.setExtensionConnected(false);
      assert.equal(statuses.length, 1);
    });

    it('handles listener errors gracefully', () => {
      monitor.onStatusChange(() => { throw new Error('test'); });
      // Should not throw.
      monitor.setExtensionConnected(false);
      assert.equal(monitor.status, 'degraded');
    });
  });
});
