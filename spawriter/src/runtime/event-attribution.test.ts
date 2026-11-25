import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventAttributionBarrier } from './event-attribution.js';

describe('EventAttributionBarrier', () => {
  let barrier: EventAttributionBarrier;

  const owner = {
    sessionId: 'sw-1',
    transportEpoch: 2,
    connectionEpoch: 3,
    executeEpoch: 5,
    leaseEpoch: 1,
  };

  beforeEach(() => {
    barrier = new EventAttributionBarrier();
    barrier.setOwner(42, owner);
  });

  describe('delivery', () => {
    it('delivers event with matching epochs', () => {
      const result = barrier.check(42, { transportEpoch: 2, connectionEpoch: 3 });
      assert(result.deliver);
      assert.equal(result.ownerSessionId, 'sw-1');
    });

    it('delivers event with newer epochs', () => {
      const result = barrier.check(42, { transportEpoch: 3, connectionEpoch: 4 });
      assert(result.deliver);
    });
  });

  describe('stale rejection (T05/T44)', () => {
    it('rejects stale transport epoch', () => {
      const result = barrier.check(42, { transportEpoch: 1, connectionEpoch: 3 });
      assert(!result.deliver);
      assert.equal(result.reason, 'stale_transport');
    });

    it('rejects stale connection epoch', () => {
      const result = barrier.check(42, { transportEpoch: 2, connectionEpoch: 2 });
      assert(!result.deliver);
      assert.equal(result.reason, 'stale_connection');
    });

    it('rejects stale execution epoch', () => {
      const result = barrier.check(42, { transportEpoch: 2, connectionEpoch: 3, executeEpoch: 4 });
      assert(!result.deliver);
      assert.equal(result.reason, 'stale_execution');
    });

    it('rejects stale lease epoch', () => {
      const result = barrier.check(42, { transportEpoch: 2, connectionEpoch: 3, leaseEpoch: 0 });
      assert(!result.deliver);
      assert.equal(result.reason, 'stale_lease');
    });
  });

  describe('critical events', () => {
    it('delivers critical events even with stale execute epoch', () => {
      const result = barrier.check(42, { transportEpoch: 2, connectionEpoch: 3, executeEpoch: 1 }, true);
      assert(result.deliver);
    });

    it('still rejects critical events with stale transport', () => {
      const result = barrier.check(42, { transportEpoch: 1, connectionEpoch: 3 }, true);
      assert(!result.deliver);
      assert.equal(result.reason, 'stale_transport');
    });
  });

  describe('no owner', () => {
    it('rejects events for unowned tabs', () => {
      const result = barrier.check(99, { transportEpoch: 2, connectionEpoch: 3 });
      assert(!result.deliver);
      assert.equal(result.reason, 'no_owner');
    });
  });

  describe('unknown target', () => {
    it('rejects with unknown_target reason', () => {
      const result = barrier.checkUnknownTarget();
      assert(!result.deliver);
      assert.equal(result.reason, 'unknown_target');
    });
  });

  describe('owner management', () => {
    it('updates owner', () => {
      barrier.setOwner(42, { ...owner, executeEpoch: 10 });
      const updated = barrier.getOwner(42);
      assert.equal(updated?.executeEpoch, 10);
    });

    it('removes owner', () => {
      barrier.removeOwner(42);
      assert.equal(barrier.getOwner(42), undefined);
    });
  });

  describe('diagnostics', () => {
    it('tracks stats', () => {
      barrier.check(42, { transportEpoch: 2, connectionEpoch: 3 }); // deliver
      barrier.check(42, { transportEpoch: 1, connectionEpoch: 3 }); // stale_transport
      barrier.check(99, { transportEpoch: 2, connectionEpoch: 3 }); // no_owner

      const diag = barrier.diagnostics();
      assert.equal(diag.stats.delivered, 1);
      assert.equal(diag.stats.staleTransport, 1);
      assert.equal(diag.stats.noOwner, 1);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      barrier.check(42, { transportEpoch: 2, connectionEpoch: 3 });
      barrier.reset();
      assert.equal(barrier.diagnostics().owners, 0);
      assert.equal(barrier.diagnostics().stats.delivered, 0);
    });
  });
});
