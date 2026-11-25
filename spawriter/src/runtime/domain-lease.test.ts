import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DomainLeaseTracker } from './domain-lease.js';

describe('DomainLeaseTracker', () => {
  let tracker: DomainLeaseTracker;

  beforeEach(() => {
    tracker = new DomainLeaseTracker({ maxDomainsPerTarget: 4, maxHoldersPerDomain: 3 });
  });

  describe('acquire (T16/T53)', () => {
    it('creates a new domain record on first acquire', () => {
      const record = tracker.acquire('t1', 'Runtime', 'helper-1');
      assert(record);
      assert.equal(record.enableState, 'enabling');
      assert(record.holders.has('helper-1'));
    });

    it('adds a second holder to existing domain', () => {
      tracker.acquire('t1', 'Runtime', 'helper-1');
      const record = tracker.acquire('t1', 'Runtime', 'client-2');
      assert(record);
      assert.equal(record.holders.size, 2);
    });

    it('rejects when at domain-per-target limit', () => {
      tracker.acquire('t1', 'D1', 'h1');
      tracker.acquire('t1', 'D2', 'h1');
      tracker.acquire('t1', 'D3', 'h1');
      tracker.acquire('t1', 'D4', 'h1');
      assert.equal(tracker.acquire('t1', 'D5', 'h1'), null);
    });

    it('rejects when at holder limit', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.acquire('t1', 'Runtime', 'h2');
      tracker.acquire('t1', 'Runtime', 'h3');
      assert.equal(tracker.acquire('t1', 'Runtime', 'h4'), null);
    });

    it('re-enables failed domain on new acquire', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.markFailed('t1', 'Runtime', 'CDP error');
      tracker.acquire('t1', 'Runtime', 'h2');
      assert.equal(tracker.get('t1', 'Runtime')?.enableState, 'enabling');
    });
  });

  describe('markEnabled / markFailed', () => {
    it('marks domain enabled', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      assert(tracker.markEnabled('t1', 'Runtime'));
      assert.equal(tracker.get('t1', 'Runtime')?.enableState, 'enabled');
    });

    it('marks domain failed with error', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      assert(tracker.markFailed('t1', 'Runtime', 'timeout'));
      const record = tracker.get('t1', 'Runtime')!;
      assert.equal(record.enableState, 'failed');
      assert.equal(record.lastError, 'timeout');
    });
  });

  describe('release (T16/T53)', () => {
    it('release returns false while holders remain', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.acquire('t1', 'Runtime', 'h2');
      assert.equal(tracker.release('t1', 'Runtime', 'h1'), false);
      assert.equal(tracker.get('t1', 'Runtime')?.holders.size, 1);
    });

    it('release returns true when last holder leaves', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      assert.equal(tracker.release('t1', 'Runtime', 'h1'), true);
    });
  });

  describe('releaseHolder', () => {
    it('releases all domains for a holder', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.acquire('t1', 'DOM', 'h1');
      tracker.acquire('t2', 'AX', 'h1');
      const freed = tracker.releaseHolder('h1');
      assert.equal(freed.length, 3);
    });

    it('does not free domains with other holders', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.acquire('t1', 'Runtime', 'h2');
      const freed = tracker.releaseHolder('h1');
      assert.equal(freed.length, 0);
    });
  });

  describe('removeTarget', () => {
    it('removes all records for a target', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.acquire('t1', 'DOM', 'h1');
      tracker.acquire('t2', 'Runtime', 'h1');
      assert.equal(tracker.removeTarget('t1'), 2);
      assert.equal(tracker.get('t1', 'Runtime'), undefined);
      assert(tracker.get('t2', 'Runtime'));
    });
  });

  describe('recordEvent', () => {
    it('increments event count', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.recordEvent('t1', 'Runtime');
      tracker.recordEvent('t1', 'Runtime');
      assert.equal(tracker.get('t1', 'Runtime')?.eventCount, 2);
    });
  });

  describe('diagnostics', () => {
    it('reports state breakdown', () => {
      tracker.acquire('t1', 'Runtime', 'h1');
      tracker.markEnabled('t1', 'Runtime');
      tracker.acquire('t1', 'DOM', 'h1');
      const diag = tracker.diagnostics();
      assert.equal(diag.totalRecords, 2);
      assert.equal(diag.byState.enabled, 1);
      assert.equal(diag.byState.enabling, 1);
    });
  });
});
