import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionError,
  CdpCommandTimeoutError,
  ConnectionTimeoutError,
  ExecutionTimeoutError,
  NavigationError,
  SessionBusyError,
  TargetDetachedError,
  TargetUnhealthyError,
  CancelledError,
  RelayDrainingError,
  isExecutionError,
  classifyError,
} from './execution-errors.js';

describe('ExecutionError hierarchy', () => {
  it('base ExecutionError carries code and metadata', () => {
    const err = new ExecutionError('INTERNAL_ERROR', 'something broke', {
      phase: 'execute',
      outcome: 'unknown',
    });
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(err.phase, 'execute');
    assert.equal(err.outcome, 'unknown');
    assert.equal(err.recovery, 'none');
    assert.equal(err.retryable, false);
    assert(err instanceof Error);
    assert(isExecutionError(err));
  });

  it('toMeta produces structured metadata', () => {
    const err = new ExecutionError('SESSION_BUSY', 'busy', {
      phase: 'admission',
      outcome: 'not_started',
      retryable: true,
    });
    const meta = err.toMeta('req-123');
    assert.equal(meta.requestId, 'req-123');
    assert.equal(meta.code, 'SESSION_BUSY');
    assert.equal(meta.phase, 'admission');
    assert.equal(meta.outcome, 'not_started');
    assert.equal(meta.retryable, true);
  });

  it('CdpCommandTimeoutError records method and elapsed', () => {
    const err = new CdpCommandTimeoutError('Page.navigate', 23748);
    assert.equal(err.code, 'CDP_COMMAND_TIMEOUT');
    assert.equal(err.method, 'Page.navigate');
    assert.equal(err.elapsedMs, 23748);
    assert.equal(err.phase, 'cdp_command');
    assert.equal(err.outcome, 'unknown');
    assert(err instanceof ExecutionError);
  });

  it('ConnectionTimeoutError is not_started and retryable', () => {
    const err = new ConnectionTimeoutError('CDP connect timed out');
    assert.equal(err.code, 'CONNECTION_TIMEOUT');
    assert.equal(err.outcome, 'not_started');
    assert.equal(err.retryable, true);
  });

  it('ExecutionTimeoutError carries phase', () => {
    const err = new ExecutionTimeoutError('took too long', 'navigate');
    assert.equal(err.code, 'EXECUTION_TIMEOUT');
    assert.equal(err.phase, 'navigate');
    assert.equal(err.outcome, 'unknown');
  });

  it('NavigationError records URL and errorText', () => {
    const err = new NavigationError('https://example.com', 'net::ERR_ABORTED');
    assert.equal(err.errorText, 'net::ERR_ABORTED');
    assert.equal(err.requestedUrl, 'https://example.com');
    assert.equal(err.outcome, 'failed');
  });

  it('SessionBusyError is not_started', () => {
    const err = new SessionBusyError('sw-abc');
    assert.equal(err.code, 'SESSION_BUSY');
    assert.equal(err.outcome, 'not_started');
  });

  it('TargetDetachedError is unknown', () => {
    const err = new TargetDetachedError('page closed');
    assert.equal(err.code, 'TARGET_DETACHED');
    assert.equal(err.outcome, 'unknown');
  });

  it('TargetUnhealthyError is not_started', () => {
    const err = new TargetUnhealthyError('quarantined');
    assert.equal(err.code, 'TARGET_UNHEALTHY');
    assert.equal(err.outcome, 'not_started');
  });

  it('CancelledError distinguishes pre-start from during', () => {
    const pre = new CancelledError('queue', 'not_started');
    assert.equal(pre.code, 'CANCELLED_BEFORE_START');

    const during = new CancelledError('execute', 'unknown');
    assert.equal(during.code, 'CANCELLED');
  });

  it('RelayDrainingError is not_started and retryable', () => {
    const err = new RelayDrainingError();
    assert.equal(err.code, 'RELAY_DRAINING');
    assert.equal(err.retryable, true);
  });
});

describe('classifyError', () => {
  it('preserves typed ExecutionError', () => {
    const original = new CdpCommandTimeoutError('Runtime.evaluate', 5000);
    assert.equal(classifyError(original), original);
  });

  it('classifies timeout messages', () => {
    const err = classifyError(new Error('Timeout 23748ms exceeded'));
    assert(err instanceof ExecutionTimeoutError);
  });

  it('classifies connection timeouts', () => {
    const err = classifyError(new Error('connect ETIMEDOUT'));
    assert(err instanceof ConnectionTimeoutError);
  });

  it('classifies navigation timeouts', () => {
    const err = classifyError(new Error('Navigation timeout of 30000 ms exceeded'));
    assert(err instanceof ExecutionTimeoutError);
    assert.equal(err.phase, 'navigate');
  });

  it('classifies target closed', () => {
    const err = classifyError(new Error('Target closed'));
    assert(err instanceof TargetDetachedError);
  });

  it('classifies context destroyed', () => {
    const err = classifyError(new Error('Execution context destroyed'));
    assert(err instanceof TargetDetachedError);
  });

  it('classifies net::ERR as navigation error', () => {
    const err = classifyError(new Error('net::ERR_ABORTED'));
    assert(err instanceof NavigationError);
  });

  it('wraps unknown errors as INTERNAL_ERROR', () => {
    const err = classifyError(new Error('something unexpected'));
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(err.outcome, 'unknown');
  });

  it('wraps non-Error values', () => {
    const err = classifyError('string error');
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert(err.message.includes('string error'));
  });
});
