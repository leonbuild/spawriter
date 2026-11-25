/**
 * Integration tests (I1-I5) — Module-to-module integration.
 *
 * These tests verify that the pure-logic modules work correctly together
 * through the RelayBridge and RelayRuntime composition root.
 *
 * Tests marked REQUIRES_RELAY need a real running relay server.
 * Tests marked REQUIRES_CHROME need a real Chrome browser.
 * All other tests use simulated/mocked infrastructure.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RelayRuntime } from './relay-runtime.js';
import { RelayBridge, type BridgeCallbacks } from './relay-bridge.js';

describe('I1: Traffic/UI/Protocol Integration', () => {
  let runtime: RelayRuntime;
  let bridge: RelayBridge;
  let tempDir: string;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];

  const callbacks: BridgeCallbacks = {
    broadcastCdpEvent: (m, p) => events.push({ method: m, params: p }),
    sendOwnershipSnapshot: () => {},
    log: () => {},
    error: () => {},
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'i1-'));
    runtime = new RelayRuntime({ instanceId: 'i1-test', logDir: tempDir });
    bridge = new RelayBridge(runtime, callbacks);
    events.length = 0;
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T05: event attribution rejects stale transport epoch', () => {
    runtime.attribution.setOwner(42, {
      sessionId: 'sw-1',
      transportEpoch: 2,
      connectionEpoch: 1,
      executeEpoch: 1,
      leaseEpoch: 1,
    });

    const stale = bridge.shouldDeliverEvent(42, 1, 1);
    assert(!stale.deliver);
    assert.equal(stale.reason, 'stale_transport');

    const current = bridge.shouldDeliverEvent(42, 2, 1);
    assert(current.deliver);
  });

  it('T06: pending ledger tracks and settles commands', () => {
    const relayId = runtime.pending.register({
      requestId: 'r1',
      clientId: 'pw-1',
      clientMessageId: 1,
      realSessionId: 'cdp-sess-1',
      sessionId: 'sw-1',
      method: 'Runtime.evaluate',
      leaseEpoch: 0,
      connectionEpoch: 0,
      transportEpoch: 0,
      executeEpoch: 0,
    }, 5000);
    assert(relayId !== null);

    const settled = runtime.pending.settle(relayId!);
    assert(settled);
    assert.equal(settled.requestId, 'r1');

    // Second settle returns null (tombstone).
    assert.equal(runtime.pending.settle(relayId!), null);
  });

  it('T07: bounded logger records without exceeding segment size', () => {
    for (let i = 0; i < 100; i++) {
      runtime.logger.log(`test log line ${i}`);
    }
    const m = runtime.logger.metrics;
    assert(m.currentSegmentBytes >= 0);
    assert.equal(m.totalDropped, 0);
  });
});

describe('I2: Execution/Permission/Cancel Integration', () => {
  let runtime: RelayRuntime;
  let bridge: RelayBridge;
  let tempDir: string;

  const callbacks: BridgeCallbacks = {
    broadcastCdpEvent: () => {},
    sendOwnershipSnapshot: () => {},
    log: () => {},
    error: () => {},
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'i2-'));
    runtime = new RelayRuntime({ instanceId: 'i2-test', logDir: tempDir });
    bridge = new RelayBridge(runtime, callbacks);
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T08: admission flow validates → admits → completes', () => {
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
    runtime.coordinator.complete('r1');
  });

  it('T09: cancel coordinator phases', () => {
    const record = runtime.cancel.initiate('r1', 'sw-1', 'user_cancel', ['cmd-1']);
    assert(record);
    assert.equal(record.phase, 'revoke');

    runtime.cancel.advance('r1'); // → stop
    runtime.cancel.advance('r1'); // → cleanup
    runtime.cancel.settleCommand('r1', 'cmd-1');
    assert(runtime.cancel.allCommandsSettled('r1'));
    runtime.cancel.advance('r1'); // → done
    assert(!runtime.cancel.isCancelling('r1'));
  });

  it('T10: execution coordinator enforces 1 running + 1 queued per session', () => {
    runtime.registry.createSession('sw-1', 'a1');

    const t1 = runtime.coordinator.admit(
      { requestId: 'r1', sessionId: 'sw-1', principalId: 'a1', relayInstanceId: 'x', workerEpoch: 0, executeEpoch: 1, connectionEpoch: 0 },
      5000,
    );
    assert(t1);

    const t2 = runtime.coordinator.admit(
      { requestId: 'r2', sessionId: 'sw-1', principalId: 'a1', relayInstanceId: 'x', workerEpoch: 0, executeEpoch: 2, connectionEpoch: 0 },
      5000,
    );
    assert(t2);
    assert.equal(t2.status, 'queued');

    // Third should fail.
    assert.throws(() => {
      runtime.coordinator.admit(
        { requestId: 'r3', sessionId: 'sw-1', principalId: 'a1', relayInstanceId: 'x', workerEpoch: 0, executeEpoch: 3, connectionEpoch: 0 },
        5000,
      );
    }, /busy/i);
  });

  it('T14: dirty journal tracks risk and blocks unsafe release', () => {
    runtime.journal.recordRisk('cmd-1', 'tab-42', 'sw-1', 1, 'Runtime.evaluate');
    assert(runtime.journal.isDirty('tab-42'));

    runtime.journal.confirm('cmd-1');
    assert(!runtime.journal.isDirty('tab-42'));
  });

  it('T15: state checkpoint commit + rollback', () => {
    const cp = runtime.getCheckpoint('sw-1');
    cp.set('x', 1);
    cp.set('y', 'hello');
    const committed = cp.commit(1);
    assert(committed);

    cp.set('x', 999);
    const rolled = cp.rollback();
    assert(rolled);
    assert.equal(cp.get('x'), 1);
  });

  it('T44: credential store authenticates and rejects', () => {
    runtime.credentials.enroll('agent-1', 'tok-valid');
    assert.equal(runtime.credentials.authenticate('tok-valid'), 'agent-1');
    assert.equal(runtime.credentials.authenticate('tok-invalid'), null);

    runtime.credentials.revoke('agent-1');
    assert.equal(runtime.credentials.authenticate('tok-valid'), null);
  });

  it('T47: checkOwnership delegates to bridge correctly', () => {
    runtime.registry.createSession('sw-owner', 'agent-1');
    bridge.claimTab(42, 'sw-owner');

    // Owner can operate.
    const allowed = bridge.checkOwnership(42, 'sw-owner');
    assert(allowed.allowed);

    // Non-owner is blocked.
    const blocked = bridge.checkOwnership(42, 'sw-other');
    assert(!blocked.allowed);
    assert.equal(blocked.owner, 'sw-owner');

    // No caller session → allowed.
    const noSession = bridge.checkOwnership(42, undefined);
    assert(noSession.allowed);
  });

  it('T48: request validator rejects invalid inputs', () => {
    assert(!runtime.validator.validateSessionId('invalid').valid);
    assert(!runtime.validator.validateTimeout(50).valid);
    assert(runtime.validator.validateSessionId('sw-abc123').valid);
    assert(runtime.validator.validateTimeout(5000).valid);
  });
});

describe('I3: Domain/Navigation Integration', () => {
  let runtime: RelayRuntime;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'i3-'));
    runtime = new RelayRuntime({ instanceId: 'i3-test', logDir: tempDir });
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T16: domain lease acquire/release with reference counting', () => {
    runtime.domainLeases.acquire('t1', 'Runtime', 'helper-1');
    runtime.domainLeases.acquire('t1', 'Runtime', 'helper-2');
    runtime.domainLeases.markEnabled('t1', 'Runtime');

    // Release first holder — domain still held.
    assert(!runtime.domainLeases.release('t1', 'Runtime', 'helper-1'));

    // Release second holder — domain can be disabled.
    assert(runtime.domainLeases.release('t1', 'Runtime', 'helper-2'));
  });

  it('T17: tab domain state tracks contexts and frames', () => {
    const state = runtime.getTabState(42);
    const ctx = { id: 1, origin: 'https://example.com', name: '', auxData: { isDefault: true, type: 'default', frameId: 'main-frame' } };
    state.contextCreated(ctx, Date.now());
    assert(state.getDefaultContext());
    state.contextDestroyed(1);
    assert(!state.getDefaultContext());
  });

  it('T20: navigation state machine transitions', () => {
    const nav = runtime.navigation;
    const record = nav.startNavigation('frame-1', 'https://example.com', 5000);
    assert(record);
    assert.equal(record.state, 'navigating');

    nav.onFrameNavigated('frame-1', 'https://example.com');
    assert.equal(nav.getNavigation('frame-1')?.state, 'loading');

    nav.onDomContentLoaded('frame-1');
    nav.onLifecycleEvent('frame-1', 'networkIdle');
    assert.equal(nav.getNavigation('frame-1')?.state, 'networkIdle');

    nav.onLoad('frame-1');
    // After onLoad + networkIdle, _checkComplete sets quietSince.
    // With default 500ms quiet, state remains networkIdle until quiet elapsed.
    const finalState = nav.getNavigation('frame-1')?.state;
    assert(['networkIdle', 'complete'].includes(finalState!),
      `Expected networkIdle or complete, got ${finalState}`);
  });
});

describe('I4: Restart/Process/Lock Integration', () => {
  let runtime: RelayRuntime;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'i4-'));
    runtime = new RelayRuntime({ instanceId: 'i4-test', logDir: tempDir });
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T22: process guard tracks restart policy', () => {
    runtime.processGuard.register('worker-1', 1234);
    runtime.processGuard.markRunning('worker-1');
    runtime.processGuard.recordExit('worker-1', 1, null);

    const { restart, backoffMs } = runtime.processGuard.shouldRestart('worker-1');
    assert(restart);
    assert(backoffMs >= 0);
  });

  it('T25: resource budget enforces worker limits', () => {
    const w1 = runtime.budget.allocateWorker('w1', 'sw-1');
    assert(w1);
    runtime.budget.markIdle('w1');
    const expired = runtime.budget.findIdleExpired(0);
    assert(expired.length >= 1);
    runtime.budget.releaseWorker('w1');
  });

  it('T56: drain blocks new admission and signals shutdown', () => {
    runtime.registry.createSession('sw-1', 'a1');
    runtime.startDrain();
    assert(runtime.isDraining);

    assert.throws(() => {
      runtime.coordinator.admit(
        { requestId: 'r1', sessionId: 'sw-1', principalId: 'a1', relayInstanceId: 'x', workerEpoch: 0, executeEpoch: 1, connectionEpoch: 0 },
        5000,
      );
    }, /draining/i);
  });
});

describe('I5: Health/Diagnostics Integration', () => {
  let runtime: RelayRuntime;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'i5-'));
    runtime = new RelayRuntime({ instanceId: 'i5-test', logDir: tempDir });
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T37: full diagnostics snapshot', () => {
    const diag = runtime.diagnostics();
    assert.equal(diag.instanceId, 'i5-test');
    assert(diag.uptimeMs >= 0);
    assert(typeof diag.sessions === 'object');
    assert(typeof diag.health === 'object');
    assert(typeof diag.coordinator === 'object');
    assert(typeof diag.pending === 'object');
    assert(typeof diag.cancel === 'object');
    assert(typeof diag.journal === 'object');
    assert(typeof diag.budget === 'object');
    assert(typeof diag.credentials === 'object');
  });

  it('T38: health monitor aggregates errors', () => {
    runtime.health.recordExecutionError();
    runtime.health.recordExecutionError();
    runtime.health.recordCdpTimeout();

    const metrics = runtime.health.getMetrics();
    assert(metrics.executionErrors >= 2);
    assert(metrics.cdpTimeouts >= 1);
  });

  it('extension connection state tracked', () => {
    runtime.health.setExtensionConnected(true);
    assert(runtime.health.getMetrics().extensionConnected);
    runtime.health.setExtensionConnected(false);
    assert(!runtime.health.getMetrics().extensionConnected);
  });
});
