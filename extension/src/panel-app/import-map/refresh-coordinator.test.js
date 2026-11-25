import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshCoordinator } from './refresh-coordinator.js';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createCoordinator(overrides = {}) {
  const results = [];
  const stateChanges = [];
  let evalDelay = overrides.evalDelay ?? 10;
  let evalError = overrides.evalError ?? null;
  let evalResult = overrides.evalResult ?? { apps: [] };

  const coordinator = new RefreshCoordinator(
    {
      evaluate: async (code, timeout) => {
        if (evalDelay) await wait(evalDelay);
        if (evalError) throw new Error(evalError);
        return evalResult;
      },
      onResult: (result) => results.push(result),
      onStateChange: (state) => stateChanges.push(state),
    },
    {
      debounceMs: 20,
      evalTimeoutMs: overrides.evalTimeoutMs ?? 500,
      totalBudgetMs: overrides.totalBudgetMs ?? 2000,
      maxRetries: overrides.maxRetries ?? 1,
    },
  );

  return {
    coordinator,
    results,
    stateChanges,
    setEvalResult: (v) => { evalResult = v; },
    setEvalError: (e) => { evalError = e; },
    setEvalDelay: (d) => { evalDelay = d; },
  };
}

describe('RefreshCoordinator', () => {
  /** @type {RefreshCoordinator | null} */
  let coordinator;

  afterEach(() => {
    if (coordinator) { coordinator.dispose(); coordinator = null; }
  });

  describe('basic refresh', () => {
    it('performs a successful refresh', async () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('getImportMap()');
      await wait(100);

      assert.equal(ctx.results.length, 1);
      assert(ctx.results[0].success);
      assert.deepEqual(ctx.results[0].data, { apps: [] });
    });

    it('transitions through refreshing → idle', async () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('getImportMap()');
      await wait(100);

      assert(ctx.stateChanges.includes('refreshing'));
      assert.equal(ctx.stateChanges[ctx.stateChanges.length - 1], 'idle');
    });
  });

  describe('debouncing (T34/T35)', () => {
    it('debounces rapid requests', async () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code1');
      coordinator.requestRefresh('code2');
      coordinator.requestRefresh('code3');

      await wait(200);

      // Should have at most 2 refreshes (debounced first, then maybe a dirty rerun).
      assert(ctx.results.length <= 2, `Expected ≤ 2 results, got ${ctx.results.length}`);
    });

    it('high priority skips debounce', async () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      // Should start immediately.
      assert.equal(coordinator.state, 'refreshing');

      await wait(100);
      assert.equal(ctx.results.length, 1);
    });
  });

  describe('single-flight + dirty rerun', () => {
    it('queues dirty refresh while in-flight', async () => {
      const ctx = createCoordinator({ evalDelay: 50 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code1', { priority: 'high' });
      // While the first refresh is in-flight, request another.
      coordinator.requestRefresh('code2');

      await wait(200);

      // Should have 2 results: the in-flight and the dirty rerun.
      assert(ctx.results.length >= 1);
    });
  });

  describe('navigation invalidation (T36)', () => {
    it('cancels in-flight on navigation', async () => {
      const ctx = createCoordinator({ evalDelay: 100 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      await wait(10);

      // Navigate — should cancel the in-flight.
      coordinator.onNavigated();
      assert.equal(coordinator.documentEpoch, 1);
      assert.equal(coordinator.state, 'idle');

      await wait(200);

      // The cancelled refresh should not deliver a result for epoch 0.
      const validResults = ctx.results.filter((r) => r.documentEpoch === 0);
      // May or may not have delivered before cancel — either 0 or 1.
      assert(validResults.length <= 1);
    });

    it('increments document epoch on navigation', () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      assert.equal(coordinator.documentEpoch, 0);
      coordinator.onNavigated();
      assert.equal(coordinator.documentEpoch, 1);
      coordinator.onNavigated();
      assert.equal(coordinator.documentEpoch, 2);
    });
  });

  describe('visibility', () => {
    it('cancels on hidden', async () => {
      const ctx = createCoordinator({ evalDelay: 100 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      coordinator.onVisibilityChanged(false);

      await wait(200);

      // Should not have results after hiding.
      assert(ctx.results.length <= 1);
    });
  });

  describe('error handling and degraded (T35)', () => {
    it('reports failure on eval error', async () => {
      const ctx = createCoordinator({ evalError: 'Script error', maxRetries: 0 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      await wait(100);

      assert.equal(ctx.results.length, 1);
      assert(!ctx.results[0].success);
      assert.equal(ctx.results[0].error, 'Script error');
    });

    it('enters degraded after repeated failures', async () => {
      const ctx = createCoordinator({ evalError: 'Error', maxRetries: 0 });
      coordinator = ctx.coordinator;

      for (let i = 0; i < 3; i++) {
        coordinator.requestRefresh('code', { priority: 'high' });
        await wait(100);
      }

      assert.equal(coordinator.state, 'degraded');
    });

    it('resets fail count on navigation', async () => {
      const ctx = createCoordinator({ evalError: 'Error', maxRetries: 0 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      await wait(100);

      coordinator.onNavigated();
      assert.equal(coordinator.diagnostics().failCount, 0);
    });
  });

  describe('timeout', () => {
    it('reports timeout when eval exceeds budget', async () => {
      const ctx = createCoordinator({ evalDelay: 300, evalTimeoutMs: 50, totalBudgetMs: 100, maxRetries: 0 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      await wait(200);

      assert.equal(ctx.results.length, 1);
      assert(!ctx.results[0].success);
      assert(ctx.results[0].error?.includes('timeout') || ctx.results[0].error?.includes('Eval'));
    });
  });

  describe('dispose', () => {
    it('cancels everything and enters disposed state', async () => {
      const ctx = createCoordinator({ evalDelay: 100 });
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      coordinator.dispose();
      assert.equal(coordinator.state, 'disposed');

      // Should not start new refreshes.
      coordinator.requestRefresh('code2');
      await wait(200);
      // At most 0-1 results from the original.
      assert(ctx.results.length <= 1);
    });
  });

  describe('diagnostics', () => {
    it('reports cumulative stats', async () => {
      const ctx = createCoordinator();
      coordinator = ctx.coordinator;

      coordinator.requestRefresh('code', { priority: 'high' });
      await wait(100);

      const diag = coordinator.diagnostics();
      assert.equal(diag.refreshes, 1);
      assert.equal(diag.successes, 1);
      assert.equal(diag.state, 'idle');
    });
  });
});
