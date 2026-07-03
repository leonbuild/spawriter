import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForPageLoad,
  buildPageReadyExpression,
  FILTERED_DOMAINS,
  FILTERED_EXTENSIONS,
} from './wait-for-page-load.js';

function readyResult(ready: boolean, readyState = 'complete', pendingRequests: string[] = []) {
  return JSON.stringify({ ready, readyState, pendingRequests });
}

describe('buildPageReadyExpression', () => {
  it('embeds the filter lists and thresholds', () => {
    const expr = buildPageReadyExpression();
    for (const domain of FILTERED_DOMAINS.slice(0, 3)) assert.ok(expr.includes(domain));
    for (const ext of FILTERED_EXTENSIONS.slice(0, 2)) assert.ok(expr.includes(ext));
    assert.ok(expr.includes('10000'));
    assert.ok(expr.includes('3000'));
    assert.ok(expr.includes('document.readyState'));
  });
});

describe('waitForPageLoad', () => {
  it('fast path: returns immediately when the page is already settled', async () => {
    let calls = 0;
    const result = await waitForPageLoad(async () => {
      calls++;
      return readyResult(true);
    });
    assert.equal(result.success, true);
    assert.equal(result.timedOut, false);
    assert.equal(calls, 1);
    assert.ok(result.waitTimeMs < 400, `fast path took ${result.waitTimeMs}ms`);
  });

  it('polls until pending requests settle', async () => {
    let calls = 0;
    const result = await waitForPageLoad(
      async () => {
        calls++;
        if (calls < 3) return readyResult(false, 'complete', ['https://example.com/api/slow']);
        return readyResult(true);
      },
      { minWait: 10, pollInterval: 10 },
    );
    assert.equal(result.success, true);
    assert.ok(calls >= 3);
  });

  it('times out and reports the blocking requests', async () => {
    const result = await waitForPageLoad(
      async () => readyResult(false, 'interactive', ['document.readyState: interactive']),
      { timeout: 100, minWait: 10, pollInterval: 10 },
    );
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.readyState, 'interactive');
    assert.deepEqual(result.pendingRequests, ['document.readyState: interactive']);
  });

  it('caps reported pending requests at 10', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `https://example.com/r${i}`);
    const result = await waitForPageLoad(async () => readyResult(false, 'complete', many), {
      timeout: 60,
      minWait: 5,
      pollInterval: 5,
    });
    assert.equal(result.pendingRequests.length, 10);
  });

  it('reports evaluate failure during polling without throwing', async () => {
    let calls = 0;
    const result = await waitForPageLoad(
      async () => {
        calls++;
        if (calls === 1) return readyResult(false);
        throw new Error('Execution context was destroyed');
      },
      { minWait: 5, pollInterval: 5, timeout: 500 },
    );
    assert.equal(result.success, false);
    assert.equal(result.readyState, 'error');
    assert.equal(result.timedOut, false);
  });

  it('survives a failing first check and keeps polling', async () => {
    let calls = 0;
    const result = await waitForPageLoad(
      async () => {
        calls++;
        if (calls === 1) throw new Error('mid-navigation');
        return readyResult(true);
      },
      { minWait: 5, pollInterval: 5, timeout: 500 },
    );
    assert.equal(result.success, true);
  });
});
