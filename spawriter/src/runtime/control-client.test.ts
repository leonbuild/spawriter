import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeControl } from './runtime-control.js';
import { ExecutionCoordinator } from './execution-coordinator.js';
import { SessionRegistry } from './session-registry.js';
import { HealthMonitor } from './health.js';

describe('RuntimeControl', () => {
  let registry: SessionRegistry;
  let coordinator: ExecutionCoordinator;
  let health: HealthMonitor;
  let client: RuntimeControl;

  beforeEach(() => {
    registry = new SessionRegistry();
    coordinator = new ExecutionCoordinator({ registry });
    health = new HealthMonitor();
    client = new RuntimeControl({
      registry,
      coordinator,
      health,
      relayInstanceId: 'test-relay',
    });
  });

  describe('session management', () => {
    it('creates a session', () => {
      const result = client.createSession('principal-1', 'sw-test');
      assert.equal(result.sessionId, 'sw-test');
      assert.equal(result.created, true);
    });

    it('returns created=false for duplicate', () => {
      client.createSession('principal-1', 'sw-test');
      const result = client.createSession('principal-1', 'sw-test');
      assert.equal(result.created, false);
    });

    it('auto-generates sessionId', () => {
      const result = client.createSession('principal-1');
      assert(result.sessionId.startsWith('sw-'));
      assert(result.created);
    });

    it('gets a session', () => {
      client.createSession('p', 'sw-1');
      const session = client.getSession('sw-1');
      assert(session);
      assert.equal(session?.principalId, 'p');
    });

    it('deletes a session', () => {
      client.createSession('p', 'sw-1');
      assert(client.deleteSession('sw-1'));
      assert.equal(client.getSession('sw-1'), undefined);
    });

    it('cancels running task on delete', () => {
      client.createSession('p', 'sw-1');
      const task = client.admitExecution({
        sessionId: 'sw-1',
        code: 'test',
        principalId: 'p',
      });
      client.deleteSession('sw-1');
      assert(task.signal.signal.aborted);
    });

    it('resets a session', () => {
      client.createSession('p', 'sw-1');
      client.admitExecution({ sessionId: 'sw-1', code: 'test', principalId: 'p' });
      client.resetSession('sw-1');
      assert.equal(registry.getSession('sw-1')?.status, 'idle');
    });
  });

  describe('execution (T50/T51 partial)', () => {
    it('admits and completes an execution', () => {
      client.createSession('p', 'sw-1');
      const task = client.admitExecution({
        sessionId: 'sw-1',
        code: 'test',
        principalId: 'p',
      });
      assert.equal(task.status, 'acquiring');

      client.completeExecution(task.requestId);
      const status = client.getExecutionStatus(task.requestId);
      assert.equal(status?.status, 'completed');
      assert.equal(status?.outcome, 'succeeded');
    });

    it('fails an execution', () => {
      client.createSession('p', 'sw-1');
      const task = client.admitExecution({
        sessionId: 'sw-1',
        code: 'test',
        principalId: 'p',
      });

      client.failExecution(task.requestId, 'CDP_COMMAND_TIMEOUT');
      const status = client.getExecutionStatus(task.requestId);
      assert.equal(status?.status, 'failed');
      assert.equal(status?.errorCode, 'CDP_COMMAND_TIMEOUT');
    });

    it('cancels an execution', () => {
      client.createSession('p', 'sw-1');
      const task = client.admitExecution({
        sessionId: 'sw-1',
        code: 'test',
        principalId: 'p',
      });

      const result = client.cancelExecution(task.requestId);
      assert.equal(result.outcome, 'not_started');
    });

    it('returns null for unknown execution', () => {
      assert.equal(client.getExecutionStatus('unknown'), null);
    });

    it('cancel returns not_started for unknown request', () => {
      const result = client.cancelExecution('unknown');
      assert.equal(result.outcome, 'not_started');
      assert.equal(result.cancelled, false);
    });
  });

  describe('tab management', () => {
    it('claims and releases a tab', () => {
      client.createSession('p', 'sw-1');
      registry.registerTarget({ tabId: 42, targetId: 'target-42', realSessionId: 'sess-42', transportEpoch: 1, attachmentEpoch: 1 });

      const claim = client.claimTab(42, 'sw-1');
      assert(claim.ok);

      assert(client.releaseTab(42, 'sw-1'));
    });

    it('rejects claim for nonexistent session', () => {
      registry.registerTarget({ tabId: 42, targetId: 'target-42', realSessionId: 'sess-42', transportEpoch: 1, attachmentEpoch: 1 });
      const claim = client.claimTab(42, 'sw-nonexistent');
      assert(!claim.ok);
    });

    it('reports diagnostics', () => {
      client.createSession('p', 'sw-1');
      const diag = client.listSessions();
      assert.equal(diag.sessions, 1);
    });
  });

  describe('health and drain', () => {
    it('reports health', () => {
      const metrics = client.getHealth();
      assert.equal(metrics.status, 'healthy');
    });

    it('starts drain', () => {
      const result = client.startDrain();
      assert(result.draining);
    });

    it('reports drain status', () => {
      const status = client.getDrainStatus();
      assert(!status.draining);
    });
  });

  describe('version', () => {
    it('reports instance info', () => {
      const v = client.getVersion();
      assert.equal(v.instanceId, 'test-relay');
      assert.equal(v.protocol, '1.0');
    });
  });
});
