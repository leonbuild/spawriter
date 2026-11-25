import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionContext,
  monoNowMs,
  clampTimeout,
  generateRequestId,
  generateInstanceId,
  DEFAULT_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from './execution-context.js';
import { ExecutionTimeoutError } from './execution-errors.js';

describe('monoNowMs', () => {
  it('returns a positive number', () => {
    const t = monoNowMs();
    assert(typeof t === 'number');
    assert(t > 0);
  });

  it('is monotonically increasing', () => {
    const a = monoNowMs();
    const b = monoNowMs();
    assert(b >= a);
  });
});

describe('clampTimeout', () => {
  it('returns default for undefined', () => {
    assert.equal(clampTimeout(undefined), DEFAULT_EXEC_TIMEOUT_MS);
  });

  it('clamps below minimum', () => {
    assert.equal(clampTimeout(10), MIN_EXEC_TIMEOUT_MS);
  });

  it('clamps above maximum', () => {
    assert.equal(clampTimeout(999_999), MAX_EXEC_TIMEOUT_MS);
  });

  it('passes valid timeout through', () => {
    assert.equal(clampTimeout(5000), 5000);
  });

  it('floors fractional values', () => {
    assert.equal(clampTimeout(5000.7), 5000);
  });

  it('rejects NaN', () => {
    assert.throws(() => clampTimeout(NaN), RangeError);
  });

  it('rejects Infinity', () => {
    assert.throws(() => clampTimeout(Infinity), RangeError);
  });

  it('rejects negative', () => {
    assert.throws(() => clampTimeout(-1), RangeError);
  });
});

describe('ExecutionContext', () => {
  const baseIdentity = {
    relayInstanceId: 'relay-test',
    principalId: 'principal-test',
    requestId: 'req-1',
    sessionId: 'sw-test',
    workerEpoch: 1,
    executeEpoch: 1,
    connectionEpoch: 1,
  };

  it('tracks remaining budget', () => {
    const ctx = new ExecutionContext(baseIdentity, 5000);
    const remaining = ctx.remainingMs();
    assert(remaining > 0 && remaining <= 5000);
    assert(!ctx.isExpired());
  });

  it('elapsed increases', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    assert(ctx.elapsedMs() >= 0);
  });

  it('cancel sets aborted state', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    assert(!ctx.cancelled);
    ctx.cancel('test');
    assert(ctx.cancelled);
    assert(ctx.signal.aborted);
  });

  it('cancel is idempotent', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    ctx.cancel('first');
    ctx.cancel('second'); // should not throw
    assert(ctx.cancelled);
  });

  it('bindTarget sets target', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    assert.equal(ctx.target, null);
    const target = {
      tabId: 1,
      targetId: 'target-1',
      realSessionId: 'real-1',
      leaseEpoch: 1,
      transportEpoch: 'epoch-1',
      attachmentEpoch: 1,
      installationId: 'install-1',
      browserEpoch: 'browser-1',
    };
    ctx.bindTarget(target);
    assert.deepEqual(ctx.target, target);
  });

  it('bindTarget rejects double bind', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    const target = {
      tabId: 1, targetId: 't', realSessionId: 'r',
      leaseEpoch: 1, transportEpoch: 'e', attachmentEpoch: 1,
      installationId: 'i', browserEpoch: 'b',
    };
    ctx.bindTarget(target);
    assert.throws(() => ctx.bindTarget(target), /already bound/);
  });

  it('stageBudgetMs respects caps', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    // connect cap is 15s, but remaining is ~30s, so should get 15s
    const budget = ctx.stageBudgetMs('connect');
    assert(budget <= 15_000);
    assert(budget > 0);
  });

  it('stageBudgetMs throws when expired', () => {
    // Create a context with 0 budget (minimum is 100ms but we can test near-expiry)
    const ctx = new ExecutionContext(baseIdentity, 100);
    // Wait slightly (this is a timing test, give it some slack)
    const start = Date.now();
    while (Date.now() - start < 150) { /* spin */ }
    assert.throws(() => ctx.stageBudgetMs('connect'), ExecutionTimeoutError);
  });

  it('withStageBudget resolves fast operations', async () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    const result = await ctx.withStageBudget('cdp_command', async () => 42);
    assert.equal(result, 42);
  });

  it('withStageBudget times out slow operations', async () => {
    const ctx = new ExecutionContext(baseIdentity, 300);
    await assert.rejects(
      () => ctx.withStageBudget('cdp_command', async (signal) => {
        return new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        });
      }),
      (err: unknown) => err instanceof ExecutionTimeoutError,
    );
  });

  it('composeSignal combines with external signal', () => {
    const ctx = new ExecutionContext(baseIdentity, 30000);
    const external = new AbortController();
    const composed = ctx.composeSignal(external.signal);
    assert(!composed.aborted);
    external.abort();
    assert(composed.aborted);
  });
});

describe('generateRequestId', () => {
  it('produces 32-char hex string', () => {
    const id = generateRequestId();
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    assert.notEqual(a, b);
  });
});

describe('generateInstanceId', () => {
  it('starts with relay-', () => {
    const id = generateInstanceId();
    assert(id.startsWith('relay-'));
  });
});
