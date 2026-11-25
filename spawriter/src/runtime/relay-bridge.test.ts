import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RelayRuntime } from './relay-runtime.js';
import { RelayBridge, type BridgeCallbacks } from './relay-bridge.js';

describe('RelayBridge', () => {
  let runtime: RelayRuntime;
  let bridge: RelayBridge;
  let tempDir: string;
  const broadcasts: Array<{ method: string; params: Record<string, unknown> }> = [];
  const snapshots: string[] = [];

  const callbacks: BridgeCallbacks = {
    broadcastCdpEvent: (m, p) => broadcasts.push({ method: m, params: p }),
    sendOwnershipSnapshot: (r) => snapshots.push(r),
    log: () => {},
    error: () => {},
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rb-'));
    runtime = new RelayRuntime({ instanceId: 'test', logDir: tempDir });
    bridge = new RelayBridge(runtime, callbacks);
    broadcasts.length = 0;
    snapshots.length = 0;
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('tab ownership', () => {
    it('claims a tab', () => {
      runtime.registry.createSession('sw-1', 'agent-1');
      const result = bridge.claimTab(42, 'sw-1');
      assert(result.ok);
      assert.equal(bridge.getTabOwner(42), 'sw-1');
      assert(broadcasts.some((b) => b.method === 'Target.tabClaimed'));
      assert(snapshots.includes('claim'));
    });

    it('rejects claim when owned by another', () => {
      runtime.registry.createSession('sw-1', 'a1');
      runtime.registry.createSession('sw-2', 'a2');
      bridge.claimTab(42, 'sw-1');
      const result = bridge.claimTab(42, 'sw-2');
      assert(!result.ok);
      assert.equal(result.owner, 'sw-1');
    });

    it('force claim takes over', () => {
      runtime.registry.createSession('sw-1', 'a1');
      runtime.registry.createSession('sw-2', 'a2');
      bridge.claimTab(42, 'sw-1');
      const result = bridge.claimTab(42, 'sw-2', true);
      assert(result.ok);
      assert.equal(bridge.getTabOwner(42), 'sw-2');
    });

    it('releases a tab', () => {
      runtime.registry.createSession('sw-1', 'a1');
      bridge.claimTab(42, 'sw-1');
      assert(bridge.releaseTab(42, 'sw-1'));
      assert.equal(bridge.getTabOwner(42), undefined);
    });

    it('releases all tabs for session', () => {
      runtime.registry.createSession('sw-1', 'a1');
      bridge.claimTab(42, 'sw-1');
      bridge.claimTab(43, 'sw-1');
      assert.equal(bridge.releaseAllTabs('sw-1'), 2);
      assert.equal(bridge.getOwnedTabs('sw-1').length, 0);
    });
  });

  describe('validateAndAdmit', () => {
    it('admits a valid request', () => {
      runtime.registry.createSession('sw-test1', 'agent-1');
      const result = bridge.validateAndAdmit({
        sessionId: 'sw-test1',
        code: 'page.url()',
        timeoutMs: 5000,
        requestId: 'r1',
        principalId: 'agent-1',
      });
      assert(result.admitted);
      assert(result.task);
    });

    it('rejects invalid session ID', () => {
      const result = bridge.validateAndAdmit({
        sessionId: 'invalid',
        code: 'page.url()',
        requestId: 'r1',
        principalId: 'agent-1',
      });
      assert(!result.admitted);
      assert.equal(result.errorCode, 'INVALID_SESSION');
    });

    it('rejects empty code', () => {
      const result = bridge.validateAndAdmit({
        sessionId: 'sw-test1',
        code: '',
        requestId: 'r1',
        principalId: 'agent-1',
      });
      assert(!result.admitted);
      assert.equal(result.errorCode, 'INVALID_CODE');
    });

    it('rejects when draining', () => {
      runtime.startDrain();
      const result = bridge.validateAndAdmit({
        sessionId: 'sw-test1',
        code: 'page.url()',
        requestId: 'r1',
        principalId: 'agent-1',
      });
      assert(!result.admitted);
      assert(result.errorCode === 'RELAY_DRAINING');
    });
  });

  describe('event attribution', () => {
    it('delivers events for owned tabs', () => {
      runtime.attribution.setOwner(42, {
        sessionId: 'sw-1',
        transportEpoch: 1,
        connectionEpoch: 1,
        executeEpoch: 1,
        leaseEpoch: 1,
      });
      const result = bridge.shouldDeliverEvent(42, 1, 1);
      assert(result.deliver);
    });

    it('rejects stale events', () => {
      runtime.attribution.setOwner(42, {
        sessionId: 'sw-1',
        transportEpoch: 2,
        connectionEpoch: 1,
        executeEpoch: 1,
        leaseEpoch: 1,
      });
      const result = bridge.shouldDeliverEvent(42, 1, 1);
      assert(!result.deliver);
    });
  });
});
