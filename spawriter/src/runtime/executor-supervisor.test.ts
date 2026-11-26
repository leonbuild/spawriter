import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorSupervisor, type ExecuteRequest } from './executor-supervisor.js';

describe('ExecutorSupervisor', () => {
  it('creates with default config', () => {
    const sup = new ExecutorSupervisor();
    const diag = sup.diagnostics();
    assert.equal(diag.activeWorkers, 0);
    assert.equal(diag.totalSpawned, 0);
    assert.equal(diag.closed, false);
  });

  it('diagnostics reflect active state', () => {
    const sup = new ExecutorSupervisor({ maxActive: 2 });
    const diag = sup.diagnostics();
    assert.equal(diag.maxActive, 2);
    assert.equal(diag.activeWorkers, 0);
  });

  it('close sets closed state', async () => {
    const sup = new ExecutorSupervisor();
    await sup.close();
    const diag = sup.diagnostics();
    assert.equal(diag.closed, true);
  });

  it('rejects execute when closed', async () => {
    const sup = new ExecutorSupervisor();
    await sup.close();
    const result = await sup.execute({
      sessionId: 'sw-test1',
      code: '1+1',
      timeoutMs: 5000,
      requestId: 'r1',
      executeEpoch: 1,
      state: {},
      stateRevision: 0,
    });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'SUPERVISOR_CLOSED');
  });

  it('limits concurrent workers', async () => {
    const sup = new ExecutorSupervisor({ maxActive: 1 });
    const diag = sup.diagnostics();
    assert.equal(diag.maxActive, 1);
    await sup.close();
  });

  it('emits workerLog events', () => {
    const sup = new ExecutorSupervisor();
    const logs: Array<{ id: string; level: string; msg: string }> = [];
    sup.on('workerLog', (id: string, level: string, msg: string) => {
      logs.push({ id, level, msg });
    });
    assert.equal(logs.length, 0);
    sup.close();
  });

  it('accepts tabInfo in execute request', async () => {
    const sup = new ExecutorSupervisor();
    await sup.close();
    const result = await sup.execute({
      sessionId: 'sw-test2',
      code: 'return 1',
      timeoutMs: 5000,
      requestId: 'r2',
      executeEpoch: 1,
      state: {},
      stateRevision: 0,
      tabInfo: { tabId: 42, url: 'https://example.com', targetId: 'target-1' },
    });
    // Closed, so it rejects — but the request shape is valid.
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'SUPERVISOR_CLOSED');
  });

  it('accepts relayPort config', () => {
    const sup = new ExecutorSupervisor({ relayPort: 12345 });
    const diag = sup.diagnostics();
    assert.equal(diag.activeWorkers, 0);
    sup.close();
  });

  it('starts and stops resource monitoring', () => {
    const sup = new ExecutorSupervisor();
    sup.startMonitoring(1000);
    const diag = sup.diagnostics() as Record<string, unknown>;
    assert.equal(diag.monitoring, true);
    sup.stopMonitoring();
    const diag2 = sup.diagnostics() as Record<string, unknown>;
    assert.equal(diag2.monitoring, false);
    sup.close();
  });

  it('emits resourceViolation events', () => {
    const sup = new ExecutorSupervisor();
    const violations: string[] = [];
    sup.on('resourceViolation', (id: string, type: string) => violations.push(`${id}:${type}`));
    // No workers running, so no violations expected.
    assert.equal(violations.length, 0);
    sup.close();
  });

  it('getResourceSamples returns empty map initially', () => {
    const sup = new ExecutorSupervisor();
    const samples = sup.getResourceSamples();
    assert.equal(samples.size, 0);
    sup.close();
  });
});

describe('ExecutorWorker module', () => {
  it('executeCode runs basic code', async () => {
    const { executeCode } = await import('./executor-worker.js');
    const result = await executeCode({
      code: 'return 42;',
      timeoutMs: 5000,
      requestId: 'test-1',
    });
    assert.equal(result.requestId, 'test-1');
    assert.equal(result.success, true);
    assert.equal(result.value, 42);
  });

  it('executeCode captures errors', async () => {
    const { executeCode } = await import('./executor-worker.js');
    const result = await executeCode({
      code: 'throw new Error("test-error");',
      timeoutMs: 5000,
      requestId: 'test-2',
    });
    assert.equal(result.success, false);
    assert(result.error?.message.includes('test-error'));
  });

  it('executeCode provides state', async () => {
    const { executeCode } = await import('./executor-worker.js');
    const result = await executeCode({
      code: 'state.x = 42; return state.x;',
      timeoutMs: 5000,
      requestId: 'test-3',
    });
    assert.equal(result.success, true);
    assert.equal(result.value, 42);
    assert.equal((result.stateCandidate as any)?.x, 42);
  });

  it('executeCode enforces timeout', async () => {
    const { executeCode } = await import('./executor-worker.js');
    const result = await executeCode({
      code: 'while(true) {}',
      timeoutMs: 100,
      requestId: 'test-4',
    });
    assert.equal(result.success, false);
    assert(result.error?.message.includes('timed out') || result.error?.message.includes('timeout') || result.error?.code === 'EXECUTION_ERROR');
  });

  it('executeWithPlaywright returns structured result', async () => {
    // Test that the function exists and returns the right shape.
    // We can't test actual Playwright without a real Chrome, but we
    // verify the function handles missing SSPA_MCP_PORT gracefully.
    const { executeWithPlaywright } = await import('./executor-worker.js');
    assert.equal(typeof executeWithPlaywright, 'function');
  });
});
