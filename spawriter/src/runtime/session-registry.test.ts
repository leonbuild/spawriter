import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from './session-registry.js';

describe('SessionRegistry', () => {
  let reg: SessionRegistry;

  beforeEach(() => {
    reg = new SessionRegistry(64);
  });

  describe('session lifecycle', () => {
    it('creates a session', () => {
      const s = reg.createSession('sw-1', 'principal-1');
      assert.equal(s.id, 'sw-1');
      assert.equal(s.principalId, 'principal-1');
      assert.equal(s.status, 'idle');
      assert.equal(s.activeTabId, null);
      assert.equal(s.executeEpoch, 0);
    });

    it('rejects duplicate session ID', () => {
      reg.createSession('sw-1', 'p');
      assert.throws(() => reg.createSession('sw-1', 'p'), /already exists/);
    });

    it('enforces max sessions', () => {
      const small = new SessionRegistry(2);
      small.createSession('a', 'p');
      small.createSession('b', 'p');
      assert.throws(() => small.createSession('c', 'p'), /Maximum sessions/);
    });

    it('advances execute epoch', () => {
      reg.createSession('sw-1', 'p');
      assert.equal(reg.nextExecuteEpoch('sw-1'), 1);
      assert.equal(reg.nextExecuteEpoch('sw-1'), 2);
    });

    it('sets session status', () => {
      reg.createSession('sw-1', 'p');
      reg.setSessionStatus('sw-1', 'executing');
      assert.equal(reg.getSession('sw-1')!.status, 'executing');
    });

    it('deletes idle session', () => {
      reg.createSession('sw-1', 'p');
      assert(reg.deleteSession('sw-1'));
      assert(!reg.hasSession('sw-1'));
    });

    it('rejects deleting active session', () => {
      reg.createSession('sw-1', 'p');
      reg.setSessionStatus('sw-1', 'executing');
      assert.throws(() => reg.deleteSession('sw-1'), /Cannot delete/);
    });
  });

  describe('physical targets', () => {
    it('registers and retrieves targets', () => {
      const t = reg.registerTarget({
        tabId: 1, targetId: 'target-1', realSessionId: 'real-1',
        transportEpoch: 'epoch-1', attachmentEpoch: 1,
      });
      assert.equal(t.tabId, 1);
      assert.equal(t.health, 'unverified');
      assert.equal(reg.getTarget(1, 'target-1'), t);
      assert.equal(reg.getTargetByTabId(1), t);
    });

    it('updates existing target info', () => {
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r1',
        transportEpoch: 'e1', attachmentEpoch: 1,
      });
      const updated = reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r2',
        transportEpoch: 'e2', attachmentEpoch: 2,
      });
      assert.equal(updated.realSessionId, 'r2');
      assert.equal(reg.targetCount, 1);
    });

    it('removes targets', () => {
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      assert(reg.removeTarget(1, 't'));
      assert.equal(reg.getTarget(1, 't'), undefined);
    });

    it('sets target health', () => {
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      reg.setTargetHealth(1, 't', 'healthy');
      assert.equal(reg.getTarget(1, 't')!.health, 'healthy');
    });
  });

  describe('leases', () => {
    it('creates a lease and sets active target', () => {
      reg.createSession('sw-1', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      const lease = reg.createLease('sw-1', 1);
      assert.equal(lease.sessionId, 'sw-1');
      assert.equal(lease.tabId, 1);
      assert.equal(lease.status, 'owned');
      assert.equal(reg.getSession('sw-1')!.activeTabId, 1);
    });

    it('rejects lease on tab owned by another session', () => {
      reg.createSession('sw-1', 'p');
      reg.createSession('sw-2', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      reg.createLease('sw-1', 1);
      assert.throws(() => reg.createLease('sw-2', 1), /already owned/);
    });

    it('releases lease and clears active target', () => {
      reg.createSession('sw-1', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      reg.createLease('sw-1', 1);
      assert(reg.releaseLease('sw-1', 1));
      assert.equal(reg.getSession('sw-1')!.activeTabId, null);
      assert.equal(reg.getTarget(1, 't')!.owner, undefined);
    });

    it('increments lease epoch', () => {
      reg.createSession('sw-1', 'p');
      const l1 = reg.createLease('sw-1', 1);
      reg.releaseLease('sw-1', 1);
      const l2 = reg.createLease('sw-1', 1);
      assert(l2.leaseEpoch > l1.leaseEpoch);
    });
  });

  describe('clients', () => {
    it('registers and retrieves clients', () => {
      reg.createSession('sw-1', 'p');
      const client = reg.registerClient('client-1', 'sw-1');
      assert.equal(client.id, 'client-1');
      assert.equal(client.sessionId, 'sw-1');
      assert.equal(reg.getClient('client-1'), client);
    });

    it('rejects client for non-existent session', () => {
      assert.throws(() => reg.registerClient('c', 'no-session'), /not found/);
    });

    it('removes client and its virtual sessions', () => {
      reg.createSession('sw-1', 'p');
      reg.registerClient('client-1', 'sw-1');
      reg.registerVirtualSession({
        id: 'vs-1', clientId: 'client-1', realSessionId: 'r',
        attachmentEpoch: 1, leaseEpoch: 1, kind: 'page',
      });
      assert.equal(reg.virtualSessionCount, 1);
      reg.removeClient('client-1');
      assert.equal(reg.getClient('client-1'), undefined);
      assert.equal(reg.virtualSessionCount, 0);
    });
  });

  describe('virtual sessions', () => {
    it('manages virtual sessions', () => {
      reg.createSession('sw-1', 'p');
      reg.registerClient('c-1', 'sw-1');
      reg.registerVirtualSession({
        id: 'vs-1', clientId: 'c-1', realSessionId: 'r',
        attachmentEpoch: 1, leaseEpoch: 1, kind: 'browser',
      });
      assert.equal(reg.getVirtualSession('vs-1')!.kind, 'browser');
      assert.equal(reg.getVirtualSessionsByClient('c-1').length, 1);
      assert(reg.removeVirtualSession('vs-1'));
      assert.equal(reg.virtualSessionCount, 0);
    });
  });

  describe('idle sweep', () => {
    it('identifies idle sessions', () => {
      reg.createSession('active', 'p');
      reg.createSession('idle', 'p');
      // Fake last activity by directly modifying (testing only)
      const idle = reg.getSession('idle')!;
      idle.lastActivityMono -= 2_000_000; // 2000s ago
      const idles = reg.getIdleSessions(1_800_000);
      assert.deepEqual(idles, ['idle']);
    });

    it('skips sessions with active tabs', () => {
      reg.createSession('with-tab', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      reg.createLease('with-tab', 1);
      const session = reg.getSession('with-tab')!;
      session.lastActivityMono -= 2_000_000;
      assert.deepEqual(reg.getIdleSessions(1_800_000), []);
    });
  });

  describe('diagnostics', () => {
    it('returns registry counts', () => {
      reg.createSession('sw-1', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      const diag = reg.diagnostics();
      assert.equal(diag.sessions, 1);
      assert.equal(diag.targets, 1);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      reg.createSession('sw-1', 'p');
      reg.registerTarget({
        tabId: 1, targetId: 't', realSessionId: 'r',
        transportEpoch: 'e', attachmentEpoch: 1,
      });
      reg.reset();
      assert.equal(reg.sessionCount, 0);
      assert.equal(reg.targetCount, 0);
    });
  });
});
