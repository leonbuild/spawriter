import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NavigationCoordinator } from './navigation.js';

describe('NavigationCoordinator', () => {
  let coordinator: NavigationCoordinator;

  beforeEach(() => {
    coordinator = new NavigationCoordinator({
      defaultTimeoutMs: 1000,
      networkIdleThreshold: 2,
      networkIdleQuietMs: 50,
    });
  });

  describe('navigation lifecycle', () => {
    it('starts in navigating state', () => {
      const rec = coordinator.startNavigation('main', 'https://example.com');
      assert.equal(rec.state, 'navigating');
      assert.equal(rec.url, 'https://example.com');
    });

    it('transitions to loading on frameNavigated', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onFrameNavigated('main', 'https://example.com/page');
      assert.equal(coordinator.getNavigation('main')?.state, 'loading');
      assert.equal(coordinator.getNavigation('main')?.url, 'https://example.com/page');
    });

    it('transitions to networkIdle on lifecycle event', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onFrameNavigated('main', 'https://example.com');
      coordinator.onLifecycleEvent('main', 'networkIdle');
      assert.equal(coordinator.getNavigation('main')?.state, 'networkIdle');
    });

    it('tracks DOM content loaded', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onDomContentLoaded('main');
      assert(coordinator.getNavigation('main')?.domContentLoaded);
    });

    it('transitions to complete when load fired and network quiet', async () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onFrameNavigated('main', 'https://example.com');
      coordinator.onLoad('main');

      // Simulate quiet period.
      await new Promise((r) => setTimeout(r, 60));
      // Trigger a re-check.
      coordinator.onNetworkRequestFinished('main');

      assert.equal(coordinator.getNavigation('main')?.state, 'complete');
    });
  });

  describe('error handling', () => {
    it('marks navigation as failed on error', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onNavigationError('main', 'net::ERR_CONNECTION_REFUSED');
      const nav = coordinator.getNavigation('main');
      assert.equal(nav?.state, 'failed');
      assert.equal(nav?.errorText, 'net::ERR_CONNECTION_REFUSED');
    });
  });

  describe('network tracking', () => {
    it('tracks pending network requests', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onNetworkRequestStarted('main');
      coordinator.onNetworkRequestStarted('main');
      assert.equal(coordinator.getNavigation('main')?.pendingRequests, 2);

      coordinator.onNetworkRequestFinished('main');
      assert.equal(coordinator.getNavigation('main')?.pendingRequests, 1);
    });

    it('does not go below zero', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onNetworkRequestFinished('main');
      assert.equal(coordinator.getNavigation('main')?.pendingRequests, 0);
    });
  });

  describe('timeout (T08/T14)', () => {
    it('detects timed out navigation', async () => {
      coordinator.startNavigation('main', 'https://example.com', 10);
      await new Promise((r) => setTimeout(r, 20));
      assert(coordinator.isTimedOut('main'));
    });

    it('checkTimeouts returns timed-out frames', async () => {
      coordinator.startNavigation('main', 'https://a.com', 10);
      coordinator.startNavigation('sub', 'https://b.com', 5000);
      await new Promise((r) => setTimeout(r, 20));
      const timedOut = coordinator.checkTimeouts();
      assert(timedOut.includes('main'));
      assert(!timedOut.includes('sub'));
      assert.equal(coordinator.getNavigation('main')?.state, 'failed');
    });

    it('does not time out valid navigation', () => {
      coordinator.startNavigation('main', 'https://example.com', 60_000);
      assert(!coordinator.isTimedOut('main'));
    });
  });

  describe('isNavigating', () => {
    it('returns true for active navigation', () => {
      coordinator.startNavigation('main', 'https://example.com');
      assert(coordinator.isNavigating('main'));
    });

    it('returns false after completion', async () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.onLoad('main');
      await new Promise((r) => setTimeout(r, 60));
      coordinator.onNetworkRequestFinished('main');
      assert(!coordinator.isNavigating('main'));
    });

    it('returns false for unknown frame', () => {
      assert(!coordinator.isNavigating('unknown'));
    });
  });

  describe('eviction', () => {
    it('evicts oldest when at capacity', () => {
      const c = new NavigationCoordinator({ maxPerTab: 2 });
      c.startNavigation('f1', 'https://a.com');
      c.startNavigation('f2', 'https://b.com');
      c.startNavigation('f3', 'https://c.com');
      // f1 should have been evicted.
      assert.equal(c.getNavigation('f1'), undefined);
      assert(c.getNavigation('f2') !== undefined);
      assert(c.getNavigation('f3') !== undefined);
    });
  });

  describe('cleanup', () => {
    it('removes a navigation', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.removeNavigation('main');
      assert.equal(coordinator.getNavigation('main'), undefined);
    });

    it('resets all state', () => {
      coordinator.startNavigation('main', 'https://example.com');
      coordinator.startNavigation('sub', 'https://example.com/frame');
      coordinator.reset();
      assert.equal(coordinator.diagnostics().active, 0);
    });
  });

  describe('diagnostics', () => {
    it('reports counts', () => {
      coordinator.startNavigation('main', 'https://a.com');
      coordinator.startNavigation('sub', 'https://b.com');
      coordinator.onNavigationError('sub', 'failed');
      const d = coordinator.diagnostics();
      assert.equal(d.active, 1);
      assert.equal(d.failed, 1);
    });
  });
});
