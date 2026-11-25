import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CdpRouter, DROPPED_EVENTS, ROUTER_CRITICAL_EVENTS, type ConnectedClient } from './cdp-router.js';

function makeClient(id: string, sessionId: string, opts: { isPlaywright?: boolean; open?: boolean } = {}): ConnectedClient {
  return {
    id,
    sessionId,
    subscribedSessions: new Set(),
    isPlaywright: opts.isPlaywright ?? false,
    isOpen: () => opts.open ?? true,
  };
}

describe('CdpRouter', () => {
  let router: CdpRouter;

  const noVirtual = () => [];
  const noOwner = () => undefined;
  const noTab = () => undefined;

  beforeEach(() => {
    router = new CdpRouter();
  });

  describe('dropped events', () => {
    it('drops Network.dataReceived', () => {
      const clients = [makeClient('c1', 'sw-1', { isPlaywright: true })];
      const result = router.route('Network.dataReceived', {}, 'sess-1', clients, noTab, noOwner, noVirtual);
      assert.equal(result.length, 0);
    });

    it('drops Network.resourceChangedPriority', () => {
      const clients = [makeClient('c1', 'sw-1', { isPlaywright: true })];
      const result = router.route('Network.resourceChangedPriority', {}, 'sess-1', clients, noTab, noOwner, noVirtual);
      assert.equal(result.length, 0);
    });
  });

  describe('browser-level events (no sessionId)', () => {
    it('broadcasts to all open clients', () => {
      const clients = [
        makeClient('c1', 'sw-1'),
        makeClient('c2', 'sw-2'),
      ];
      const result = router.route('Browser.downloadWillBegin', { guid: 'x' }, undefined, clients, noTab, noOwner, noVirtual);
      assert.equal(result.length, 2);
      assert.equal(result[0].clientId, 'c1');
      assert.equal(result[1].clientId, 'c2');
    });

    it('skips closed clients', () => {
      const clients = [
        makeClient('c1', 'sw-1', { open: false }),
        makeClient('c2', 'sw-2'),
      ];
      const result = router.route('Browser.downloadWillBegin', {}, undefined, clients, noTab, noOwner, noVirtual);
      assert.equal(result.length, 1);
      assert.equal(result[0].clientId, 'c2');
    });
  });

  describe('owned target events', () => {
    it('routes to the owning session client', () => {
      const clients = [
        makeClient('pw-1', 'sw-1', { isPlaywright: true }),
        makeClient('pw-2', 'sw-2', { isPlaywright: true }),
      ];
      const resolveTab = (sid: string) => sid === 'sess-1' ? 42 : undefined;
      const resolveOwner = (tabId: number) => tabId === 42 ? 'sw-1' : undefined;

      const result = router.route('Page.loadEventFired', { timestamp: 1 }, 'sess-1', clients, resolveTab, resolveOwner, noVirtual);
      assert.equal(result.length, 1);
      assert.equal(result[0].clientId, 'pw-1');
      assert.equal(result[0].payload.sessionId, 'sess-1');
    });
  });

  describe('unowned target events (discovery)', () => {
    it('broadcasts to pw- clients when target has no owner', () => {
      const clients = [
        makeClient('pw-1', 'sw-1', { isPlaywright: true }),
        makeClient('ext-1', 'sw-2', { isPlaywright: false }),
      ];
      const resolveTab = (sid: string) => sid === 'sess-1' ? 42 : undefined;
      // No owner for tab 42.

      const result = router.route('Page.loadEventFired', {}, 'sess-1', clients, resolveTab, noOwner, noVirtual);
      assert.equal(result.length, 1);
      assert.equal(result[0].clientId, 'pw-1');
    });
  });

  describe('virtual sessions', () => {
    it('sends event on both real and virtual session IDs', () => {
      const clients = [makeClient('pw-1', 'sw-1', { isPlaywright: true })];
      const resolveTab = () => 42;
      const resolveOwner = () => 'sw-1';
      const resolveVirtual = (realSid: string, clientId: string) =>
        realSid === 'sess-1' && clientId === 'pw-1' ? ['v-sess-1'] : [];

      const result = router.route('Runtime.executionContextCreated', {}, 'sess-1', clients, resolveTab, resolveOwner, resolveVirtual);
      assert.equal(result.length, 2);
      assert.equal(result[0].payload.sessionId, 'sess-1');
      assert.equal(result[1].payload.sessionId, 'v-sess-1');
    });
  });

  describe('deduplication', () => {
    it('never sends the same (client, sessionId) pair twice', () => {
      const clients = [makeClient('pw-1', 'sw-1', { isPlaywright: true })];
      const resolveTab = () => 42;
      const resolveOwner = () => 'sw-1';
      // Virtual resolves to same as real — should be deduped.
      const resolveVirtual = (_r: string, _c: string) => ['sess-1'];

      const result = router.route('Page.loadEventFired', {}, 'sess-1', clients, resolveTab, resolveOwner, resolveVirtual);
      assert.equal(result.length, 1);
    });
  });

  describe('rate tracking', () => {
    it('detects clients over rate limit', () => {
      const rtr = new CdpRouter({ maxEventsPerSecondPerClient: 5 });
      const now = Date.now();
      for (let i = 0; i < 5; i++) rtr.recordDelivery('c1', now);
      assert(rtr.isClientOverRate('c1', now));
    });

    it('resets on new window', () => {
      const rtr = new CdpRouter({ maxEventsPerSecondPerClient: 5 });
      const now = Date.now();
      for (let i = 0; i < 5; i++) rtr.recordDelivery('c1', now);
      assert(!rtr.isClientOverRate('c1', now + 1001));
    });

    it('resets on client disconnect', () => {
      const rtr = new CdpRouter({ maxEventsPerSecondPerClient: 5 });
      const now = Date.now();
      for (let i = 0; i < 10; i++) rtr.recordDelivery('c1', now);
      rtr.resetClient('c1');
      assert(!rtr.isClientOverRate('c1', now));
    });
  });

  describe('critical events set', () => {
    it('contains essential protocol events', () => {
      assert(ROUTER_CRITICAL_EVENTS.has('Target.targetCreated'));
      assert(ROUTER_CRITICAL_EVENTS.has('Runtime.executionContextCreated'));
      assert(ROUTER_CRITICAL_EVENTS.has('Page.javascriptDialogOpening'));
    });

    it('does not overlap with dropped events', () => {
      for (const event of DROPPED_EVENTS) {
        assert(!ROUTER_CRITICAL_EVENTS.has(event), `${event} should not be both critical and dropped`);
      }
    });
  });
});
