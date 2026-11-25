import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessGuard } from './process-guard.js';

describe('ProcessGuard', () => {
  let guard: ProcessGuard;

  beforeEach(() => {
    guard = new ProcessGuard({
      gracefulTimeoutMs: 100,
      killTimeoutMs: 50,
      maxRestarts: 3,
      restartBackoffMs: 10,
      maxProcesses: 5,
    });
  });

  afterEach(() => {
    guard.dispose();
  });

  describe('register and lifecycle', () => {
    it('registers a new process in starting state', () => {
      const proc = guard.register('worker-1', 1234);
      assert.equal(proc.id, 'worker-1');
      assert.equal(proc.pid, 1234);
      assert.equal(proc.state, 'starting');
      assert.equal(proc.epoch, 1);
    });

    it('transitions to running', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      assert.equal(guard.getProcess('worker-1')?.state, 'running');
    });

    it('records exit as crashed when unexpected', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      guard.recordExit('worker-1', 1, null);
      assert.equal(guard.getProcess('worker-1')?.state, 'crashed');
      assert.equal(guard.getProcess('worker-1')?.exitCode, 1);
    });

    it('records exit as stopped when graceful', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      guard.initiateShutdown('worker-1');
      guard.recordExit('worker-1', 0, null);
      assert.equal(guard.getProcess('worker-1')?.state, 'stopped');
    });

    it('records SIGKILL exit as killed', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      guard.recordExit('worker-1', null, 'SIGKILL');
      assert.equal(guard.getProcess('worker-1')?.state, 'killed');
    });
  });

  describe('epoch tracking', () => {
    it('increments epoch on re-register', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 0, null);
      const proc2 = guard.register('worker-1', 5678);
      assert.equal(proc2.epoch, 2);
      assert.equal(proc2.pid, 5678);
    });
  });

  describe('restart policy (T24/T57)', () => {
    it('allows restart after crash', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 1, null);
      const { restart, backoffMs } = guard.shouldRestart('worker-1');
      assert(restart);
      assert(backoffMs >= 10);
    });

    it('denies restart after max restarts', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 1, null);
      guard.recordRestart('worker-1');
      guard.recordRestart('worker-1');
      guard.recordRestart('worker-1');
      assert(!guard.shouldRestart('worker-1').restart);
    });

    it('applies exponential backoff', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 1, null);

      const r0 = guard.shouldRestart('worker-1');
      assert.equal(r0.backoffMs, 10); // 10 * 2^0

      guard.recordRestart('worker-1');
      guard.register('worker-1', 2345);
      guard.recordExit('worker-1', 1, null);
      const r1 = guard.shouldRestart('worker-1');
      assert.equal(r1.backoffMs, 20); // 10 * 2^1
    });

    it('does not restart running process', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      assert(!guard.shouldRestart('worker-1').restart);
    });
  });

  describe('shutdown (T23/T25)', () => {
    it('transitions to stopping state', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      guard.initiateShutdown('worker-1');
      assert.equal(guard.getProcess('worker-1')?.state, 'stopping');
    });

    it('returns null for unknown process', () => {
      assert.equal(guard.initiateShutdown('unknown'), null);
    });

    it('returns process for already stopped', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 0, null);
      const proc = guard.initiateShutdown('worker-1');
      assert(proc);
      assert.equal(proc.state, 'crashed'); // exited without stopping first
    });
  });

  describe('queries', () => {
    it('isAlive returns true for running', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      assert(guard.isAlive('worker-1'));
    });

    it('isAlive returns false for stopped', () => {
      guard.register('worker-1', 1234);
      guard.recordExit('worker-1', 0, null);
      assert(!guard.isAlive('worker-1'));
    });

    it('listAlive returns only living processes', () => {
      guard.register('worker-1', 1234);
      guard.markRunning('worker-1');
      guard.register('worker-2', 2345);
      guard.recordExit('worker-2', 1, null);

      const alive = guard.listAlive();
      assert.equal(alive.length, 1);
      assert.equal(alive[0].id, 'worker-1');
    });
  });

  describe('capacity', () => {
    it('evicts old stopped process when at capacity', () => {
      for (let i = 0; i < 5; i++) {
        guard.register(`w-${i}`, 1000 + i);
      }
      // All 5 slots full.
      guard.recordExit('w-0', 0, null);
      // Should be able to add one more by evicting w-0.
      const proc = guard.register('w-5', 2000);
      assert.equal(proc.id, 'w-5');
      assert.equal(guard.getProcess('w-0'), undefined);
    });

    it('throws when all slots are alive', () => {
      for (let i = 0; i < 5; i++) {
        guard.register(`w-${i}`, 1000 + i);
        guard.markRunning(`w-${i}`);
      }
      assert.throws(() => guard.register('w-5', 2000), /capacity/);
    });
  });

  describe('diagnostics', () => {
    it('reports correct counts', () => {
      guard.register('w-1', 1000);
      guard.markRunning('w-1');
      guard.register('w-2', 2000);
      guard.recordExit('w-2', 1, null);
      guard.register('w-3', 3000);
      guard.initiateShutdown('w-3');

      const diag = guard.diagnostics();
      assert.equal(diag.total, 3);
      assert.equal(diag.alive, 1);
      assert.equal(diag.stopping, 1);
      assert.equal(diag.crashed, 1);
    });
  });
});
