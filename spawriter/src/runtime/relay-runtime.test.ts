import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RelayRuntime } from './relay-runtime.js';

describe('RelayRuntime — composition root', () => {
  let runtime: RelayRuntime;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rt-'));
    runtime = new RelayRuntime({
      instanceId: 'test-instance',
      logDir: tempDir,
      config: {
        sessionMax: 4,
        globalQueueLimit: 8,
        execTimeoutMs: 5000,
      } as any,
    });
  });

  afterEach(() => {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates with stable instance ID', () => {
      assert.equal(runtime.instanceId, 'test-instance');
      assert(!runtime.isDraining);
      assert(!runtime.isClosed);
    });

    it('auto-generates instance ID when not provided', () => {
      const rt2 = new RelayRuntime({ logDir: tempDir });
      assert(rt2.instanceId.startsWith('relay-'));
      rt2.close();
    });

    it('exposes all subsystems', () => {
      assert(runtime.registry);
      assert(runtime.coordinator);
      assert(runtime.router);
      assert(runtime.pending);
      assert(runtime.attribution);
      assert(runtime.health);
      assert(runtime.navigation);
      assert(runtime.cancel);
      assert(runtime.journal);
      assert(runtime.budget);
      assert(runtime.validator);
      assert(runtime.credentials);
      assert(runtime.processGuard);
      assert(runtime.logger);
      assert(runtime.domainLeases);
    });
  });

  describe('session + execution flow', () => {
    it('create session → admit → complete', () => {
      const session = runtime.registry.createSession('sw-test1', 'agent-1');
      assert(session);

      const task = runtime.coordinator.admit(
        { requestId: 'r1', sessionId: 'sw-test1', principalId: 'agent-1' },
        5000,
      );
      assert(task);
      assert.equal(task.status, 'acquiring');

      runtime.coordinator.complete('r1');
    });
  });

  describe('tab state management', () => {
    it('creates and retrieves tab state', () => {
      const state = runtime.getTabState(42);
      assert(state);
      assert.equal(runtime.getTabState(42), state); // Same instance
    });

    it('removes tab state and leases', () => {
      runtime.getTabState(42);
      runtime.domainLeases.acquire('42', 'Runtime', 'h1');
      runtime.removeTabState(42);
      assert(!runtime.tabStates.has(42));
      assert.equal(runtime.domainLeases.get('42', 'Runtime'), undefined);
    });
  });

  describe('checkpoint management', () => {
    it('creates and retrieves session checkpoint', () => {
      const cp = runtime.getCheckpoint('sw-test1');
      assert(cp);
      cp.set('x', 42);
      assert.equal(runtime.getCheckpoint('sw-test1').get('x'), 42);
    });

    it('removes checkpoint', () => {
      runtime.getCheckpoint('sw-test1').set('x', 1);
      runtime.removeCheckpoint('sw-test1');
      assert(!runtime.checkpoints.has('sw-test1'));
    });
  });

  describe('drain lifecycle', () => {
    it('marks draining and blocks admissions', () => {
      runtime.startDrain();
      assert(runtime.isDraining);

      assert.throws(() => {
        runtime.coordinator.admit(
          { requestId: 'r1', sessionId: 'sw-test1', principalId: 'agent-1' },
          5000,
        );
      }, /draining/i);
    });
  });

  describe('close', () => {
    it('cleans up everything', () => {
      runtime.getTabState(42);
      runtime.getCheckpoint('sw-test1');
      runtime.close();
      assert(runtime.isClosed);
      assert.equal(runtime.tabStates.size, 0);
      assert.equal(runtime.checkpoints.size, 0);
    });
  });

  describe('diagnostics', () => {
    it('returns comprehensive snapshot', () => {
      const diag = runtime.diagnostics();
      assert.equal(diag.instanceId, 'test-instance');
      assert(diag.uptimeMs >= 0);
      assert(diag.sessions);
      assert(diag.health);
      assert(diag.coordinator);
      assert(diag.pending);
      assert(diag.cancel);
      assert(diag.journal);
      assert(diag.budget);
      assert(diag.credentials);
    });
  });

  describe('cross-module integration', () => {
    it('validate → admit → record risk → complete → confirm', () => {
      // Validate the request.
      const v = runtime.validator.validateExecuteRequest({
        sessionId: 'sw-test1',
        code: 'page.url()',
        timeoutMs: 5000,
      });
      assert(v.valid);

      // Admit.
      runtime.registry.createSession('sw-test1', 'agent-1');
      const task = runtime.coordinator.admit(
        { requestId: 'r1', sessionId: 'sw-test1', principalId: 'agent-1' },
        5000,
      );
      assert.equal(task.status, 'acquiring');

      // Record risk.
      const risk = runtime.journal.recordRisk('cmd-1', 'tab-42', 'sw-test1', 1, 'Runtime.evaluate');
      assert(risk);

      // Complete.
      runtime.coordinator.complete('r1');
      runtime.journal.confirm('cmd-1');
      assert(!runtime.journal.isDirty('tab-42'));
    });

    it('health tracks events through subsystems', () => {
      runtime.health.recordEventForwarded(10);
      runtime.health.recordEventDropped(2);
      runtime.health.recordExecutionError();
      const m = runtime.health.getMetrics();
      assert.equal(m.eventsForwarded, 10);
      assert.equal(m.eventsDropped, 2);
    });
  });
});
