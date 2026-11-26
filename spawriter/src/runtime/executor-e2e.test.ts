/**
 * End-to-end test: Supervisor spawns a real Worker child process,
 * Worker runs code via vm.createContext, and returns result via IPC.
 * Tests the full IPC pipeline without requiring Chrome.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorSupervisor } from './executor-supervisor.js';

describe('Executor E2E (real child process)', () => {
  it('spawns a Worker and executes basic code', async () => {
    const sup = new ExecutorSupervisor({
      maxActive: 2,
      maxHeapMib: 128,
    });

    try {
      const result = await sup.execute({
        sessionId: 'sw-e2etest1',
        code: 'return 2 + 3;',
        timeoutMs: 15000,
        requestId: 'e2e-1',
        executeEpoch: 1,
        state: {},
        stateRevision: 0,
      });

      assert.equal(result.requestId, 'e2e-1');
      assert.equal(result.success, true);
      assert.equal(result.value, 5);
      assert(typeof result.workerPid === 'number');
      assert(typeof result.durationMs === 'number');
      assert(result.durationMs > 0);
    } finally {
      await sup.close();
    }
  });

  it('transfers state through Worker', async () => {
    const sup = new ExecutorSupervisor({ maxActive: 2 });

    try {
      const result = await sup.execute({
        sessionId: 'sw-e2etest2',
        code: 'state.count = (state.count || 0) + 1; return state.count;',
        timeoutMs: 15000,
        requestId: 'e2e-2',
        executeEpoch: 1,
        state: { count: 10 },
        stateRevision: 1,
      });

      assert.equal(result.success, true);
      assert.equal(result.value, 11);
      assert.equal((result.stateCandidate as any)?.count, 11);
      assert.equal(result.stateRevision, 2);
    } finally {
      await sup.close();
    }
  });

  it('handles errors from Worker', async () => {
    const sup = new ExecutorSupervisor({ maxActive: 2 });

    try {
      const result = await sup.execute({
        sessionId: 'sw-e2etest3',
        code: 'throw new Error("boom");',
        timeoutMs: 15000,
        requestId: 'e2e-3',
        executeEpoch: 1,
        state: {},
        stateRevision: 0,
      });

      assert.equal(result.success, false);
      assert(result.error?.message.includes('boom'));
    } finally {
      await sup.close();
    }
  });

  it('reports worker PID and duration', async () => {
    const sup = new ExecutorSupervisor({ maxActive: 2 });

    try {
      const result = await sup.execute({
        sessionId: 'sw-e2etest4',
        code: 'return "hello";',
        timeoutMs: 15000,
        requestId: 'e2e-4',
        executeEpoch: 1,
        state: {},
        stateRevision: 0,
      });

      assert.equal(result.success, true);
      assert(result.workerPid! > 0, 'Worker PID should be a positive number');
      assert(result.durationMs! >= 0, 'Duration should be non-negative');
    } finally {
      await sup.close();
    }
  });

  it('handles concurrent executions', async () => {
    const sup = new ExecutorSupervisor({ maxActive: 3 });

    try {
      const results = await Promise.all([
        sup.execute({
          sessionId: 'sw-e2econc1',
          code: 'return "a";',
          timeoutMs: 15000,
          requestId: 'conc-1',
          executeEpoch: 1,
          state: {},
          stateRevision: 0,
        }),
        sup.execute({
          sessionId: 'sw-e2econc2',
          code: 'return "b";',
          timeoutMs: 15000,
          requestId: 'conc-2',
          executeEpoch: 2,
          state: {},
          stateRevision: 0,
        }),
      ]);

      assert.equal(results[0].success, true);
      assert.equal(results[0].value, 'a');
      assert.equal(results[1].success, true);
      assert.equal(results[1].value, 'b');

      // Different PIDs — truly separate processes.
      assert.notEqual(results[0].workerPid, results[1].workerPid);
    } finally {
      await sup.close();
    }
  });
});
