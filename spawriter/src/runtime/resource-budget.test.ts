import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceBudget } from './resource-budget.js';

describe('ResourceBudget', () => {
  let budget: ResourceBudget;

  beforeEach(() => {
    budget = new ResourceBudget({
      maxWorkers: 4,
      maxActiveWorkers: 2,
      workerHeapMiB: 256,
      globalBudgetMiB: 1024,
      globalQueueLimit: 3,
      resultPendingBytes: 1000,
      httpBodyBytes: 500,
      codePayloadBytes: 200,
      idleWorkerMs: 100,
    });
  });

  describe('worker allocation (T66)', () => {
    it('allocates a worker', () => {
      const w = budget.allocateWorker('w1', 'sw-1');
      assert(w);
      assert.equal(w.state, 'active');
      assert.equal(w.heapMiB, 256);
    });

    it('returns existing on duplicate', () => {
      const w1 = budget.allocateWorker('w1', 'sw-1');
      const w2 = budget.allocateWorker('w1', 'sw-1');
      assert.equal(w1, w2);
    });

    it('rejects at max workers', () => {
      budget.allocateWorker('w1', 'sw-1');
      budget.markIdle('w1');
      budget.allocateWorker('w2', 'sw-2');
      budget.markIdle('w2');
      budget.allocateWorker('w3', 'sw-3');
      budget.markIdle('w3');
      budget.allocateWorker('w4', 'sw-4');
      assert.equal(budget.allocateWorker('w5', 'sw-5'), null);
    });

    it('rejects at max active', () => {
      budget.allocateWorker('w1', 'sw-1');
      budget.allocateWorker('w2', 'sw-2');
      assert.equal(budget.allocateWorker('w3', 'sw-3'), null);
    });

    it('rejects when heap budget exceeded', () => {
      budget.allocateWorker('w1', 'sw-1', 512);
      budget.markIdle('w1');
      budget.allocateWorker('w2', 'sw-2', 512);
      budget.markIdle('w2');
      assert.equal(budget.allocateWorker('w3', 'sw-3', 512), null);
    });
  });

  describe('worker lifecycle', () => {
    it('marks idle and active', () => {
      budget.allocateWorker('w1', 'sw-1');
      assert(budget.markIdle('w1'));
      const snap = budget.snapshot();
      assert.equal(snap.workers.idle, 1);
      assert.equal(snap.workers.active, 0);

      assert(budget.markActive('w1'));
      assert.equal(budget.snapshot().workers.active, 1);
    });

    it('marks stopping', () => {
      budget.allocateWorker('w1', 'sw-1');
      assert(budget.markStopping('w1'));
      assert(!budget.markActive('w1'));
      assert(!budget.markIdle('w1'));
    });

    it('releases worker', () => {
      budget.allocateWorker('w1', 'sw-1');
      const w = budget.releaseWorker('w1');
      assert(w);
      assert.equal(budget.snapshot().workers.total, 0);
    });

    it('finds idle expired workers', () => {
      budget.allocateWorker('w1', 'sw-1');
      budget.markIdle('w1');
      const expired = budget.findIdleExpired(0);
      assert.equal(expired.length, 1);
    });
  });

  describe('queue budget (T66)', () => {
    it('reserves and releases queue slots', () => {
      assert(budget.reserveQueue());
      assert(budget.reserveQueue());
      assert(budget.reserveQueue());
      assert(!budget.reserveQueue()); // limit 3
      budget.releaseQueue();
      assert(budget.reserveQueue());
    });
  });

  describe('result budget', () => {
    it('reserves and releases bytes', () => {
      assert(budget.reserveResult(500));
      assert(budget.reserveResult(500));
      assert(!budget.reserveResult(100)); // over 1000
      budget.releaseResult(500);
      assert(budget.reserveResult(100));
    });
  });

  describe('payload validation', () => {
    it('validates body size', () => {
      assert(budget.validateBodySize(500));
      assert(!budget.validateBodySize(501));
    });

    it('validates code size', () => {
      assert(budget.validateCodeSize(200));
      assert(!budget.validateCodeSize(201));
    });
  });

  describe('snapshot', () => {
    it('reports comprehensive state', () => {
      budget.allocateWorker('w1', 'sw-1');
      budget.reserveQueue();
      budget.reserveResult(100);
      const s = budget.snapshot();
      assert.equal(s.workers.total, 1);
      assert.equal(s.workers.active, 1);
      assert.equal(s.memory.allocatedMiB, 256);
      assert.equal(s.queue.depth, 1);
      assert.equal(s.results.pendingBytes, 100);
    });
  });
});
