import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionCoordinator } from './execution-coordinator.js';
import { SessionRegistry } from './session-registry.js';
import { SessionBusyError, RelayDrainingError } from './execution-errors.js';

describe('ExecutionCoordinator', () => {
  let registry: SessionRegistry;
  let coordinator: ExecutionCoordinator;

  const makeIdentity = (sessionId: string, requestId: string) => ({
    relayInstanceId: 'relay-test',
    principalId: 'principal-test',
    requestId,
    sessionId,
    workerEpoch: 1,
    executeEpoch: 1,
    connectionEpoch: 1,
  });

  beforeEach(() => {
    registry = new SessionRegistry();
    coordinator = new ExecutionCoordinator({
      registry,
      maxGlobalQueued: 4,
      sessionQueueLimit: 1,
    });
    registry.createSession('sw-1', 'p');
    registry.createSession('sw-2', 'p');
  });

  describe('admission', () => {
    it('admits a task to an idle session', () => {
      const task = coordinator.admit(makeIdentity('sw-1', 'req-1'));
      assert.equal(task.requestId, 'req-1');
      assert.equal(task.status, 'acquiring');
      assert.equal(task.outcome, 'not_started');
    });

    it('queues a second task when first is running', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      const queued = coordinator.admit(makeIdentity('sw-1', 'req-2'));
      assert.equal(queued.status, 'queued');
    });

    it('rejects third task on same session (queue limit=1)', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));
      assert.throws(
        () => coordinator.admit(makeIdentity('sw-1', 'req-3')),
        SessionBusyError,
      );
    });

    it('allows different sessions to run simultaneously', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      const task2 = coordinator.admit(makeIdentity('sw-2', 'req-2'));
      assert.equal(task2.status, 'acquiring');
    });

    it('rejects duplicate requestId', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      assert.throws(
        () => coordinator.admit(makeIdentity('sw-1', 'req-1')),
        /already exists|busy/,
      );
    });

    it('rejects when draining', () => {
      coordinator.startDrain();
      assert.throws(
        () => coordinator.admit(makeIdentity('sw-1', 'req-1')),
        RelayDrainingError,
      );
    });
  });

  describe('completion', () => {
    it('completes a running task', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.complete('req-1');
      const task = coordinator.getTask('req-1');
      assert.equal(task?.status, 'completed');
      assert.equal(task?.outcome, 'succeeded');
    });

    it('promotes queued task on completion', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));
      coordinator.complete('req-1');

      const task2 = coordinator.getTask('req-2');
      assert.equal(task2?.status, 'acquiring');
      assert.equal(coordinator.getRunningTask('sw-1')?.requestId, 'req-2');
    });

    it('sets session to idle when no more tasks', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.complete('req-1');
      assert.equal(registry.getSession('sw-1')?.status, 'idle');
    });
  });

  describe('failure', () => {
    it('marks task as failed with error code', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.fail('req-1', 'CDP_COMMAND_TIMEOUT');
      const task = coordinator.getTask('req-1');
      assert.equal(task?.status, 'failed');
      assert.equal(task?.errorCode, 'CDP_COMMAND_TIMEOUT');
    });

    it('outcome is unknown when native was dispatched', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.markNativeDispatched('req-1');
      coordinator.fail('req-1', 'EXECUTION_TIMEOUT');
      assert.equal(coordinator.getTask('req-1')?.outcome, 'unknown');
    });

    it('outcome is failed when native was not dispatched', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.fail('req-1', 'CONNECTION_TIMEOUT', 'failed');
      assert.equal(coordinator.getTask('req-1')?.outcome, 'failed');
    });
  });

  describe('cancellation (T09/T10)', () => {
    it('cancels queued task as not_started', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));
      const outcome = coordinator.cancel('req-2');
      assert.equal(outcome, 'not_started');
      assert.equal(coordinator.getTask('req-2')?.status, 'cancelled');
    });

    it('cancels running task with unknown if dispatched', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.markNativeDispatched('req-1');
      const outcome = coordinator.cancel('req-1');
      assert.equal(outcome, 'unknown');
    });

    it('cancels running task as not_started if not dispatched', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      const outcome = coordinator.cancel('req-1');
      assert.equal(outcome, 'not_started');
    });

    it('abort signal fires on cancel', () => {
      const task = coordinator.admit(makeIdentity('sw-1', 'req-1'));
      assert(!task.signal.signal.aborted);
      coordinator.cancel('req-1');
      assert(task.signal.signal.aborted);
    });

    it('completed task cannot be cancelled', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.complete('req-1');
      const outcome = coordinator.cancel('req-1');
      assert.equal(outcome, 'succeeded');
    });

    it('cancel is idempotent', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.cancel('req-1');
      coordinator.cancel('req-1'); // should not throw
    });
  });

  describe('deadline (T08)', () => {
    it('detects expired task', () => {
      const task = coordinator.admit(makeIdentity('sw-1', 'req-1'), 1);
      // The 1ms timeout should expire almost immediately
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }
      assert(coordinator.checkDeadline('req-1'));
      assert.equal(task.status, 'timeout');
    });

    it('does not expire valid task', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'), 30_000);
      assert(!coordinator.checkDeadline('req-1'));
    });

    it('remainingMs decreases', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'), 5000);
      const r1 = coordinator.remainingMs('req-1');
      assert(r1 > 0 && r1 <= 5000);
    });
  });

  describe('drain (T23)', () => {
    it('cancels queued tasks on drain', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));
      coordinator.startDrain();
      assert.equal(coordinator.getTask('req-2')?.status, 'cancelled');
    });

    it('running tasks continue during drain', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.startDrain();
      assert.equal(coordinator.getTask('req-1')?.status, 'acquiring');
    });

    it('drain complete when no running tasks', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.startDrain();
      coordinator.complete('req-1');
      assert(coordinator.isDrainComplete());
    });

    it('new tasks rejected during drain', () => {
      coordinator.startDrain();
      assert.throws(
        () => coordinator.admit(makeIdentity('sw-1', 'req-1')),
        RelayDrainingError,
      );
    });
  });

  describe('FIFO ordering (T09)', () => {
    it('runs tasks in FIFO order per session', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));

      assert.equal(coordinator.getRunningTask('sw-1')?.requestId, 'req-1');
      coordinator.complete('req-1');
      assert.equal(coordinator.getRunningTask('sw-1')?.requestId, 'req-2');
    });
  });

  describe('diagnostics', () => {
    it('reports correct counts', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.admit(makeIdentity('sw-1', 'req-2'));
      coordinator.admit(makeIdentity('sw-2', 'req-3'));

      const diag = coordinator.diagnostics();
      assert.equal(diag.running, 2); // sw-1 and sw-2
      assert.equal(diag.queued, 1); // req-2 queued
      assert.equal(diag.total, 3);
    });
  });

  describe('sweep', () => {
    it('cleans up terminal records', () => {
      coordinator.admit(makeIdentity('sw-1', 'req-1'));
      coordinator.complete('req-1');
      const swept = coordinator.sweepTerminal(0);
      assert.equal(swept, 1);
      assert.equal(coordinator.getTask('req-1'), undefined);
    });
  });
});
