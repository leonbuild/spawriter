/**
 * Regression tests for relay crash-analysis fixes.
 *
 * Pure-logic coverage for the recoverable-error classifiers and the navigate
 * budget. Integration behaviour (real Playwright dialogs, a live relay) is left
 * to E2E runs that need a browser + extension.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRecoverablePlaywrightDialogRace, isPortInUseError } from './relay.js';
import {
  computeNavigateCommandTimeout,
  NavigationBudgetError,
  isNoDialogShowingRace,
  isExecutionTimeoutLikeError,
  CodeExecutionTimeoutError,
} from './pw-executor.js';
import { ensureRelayServer } from './runtime/ensure-relay.js';

describe('isRecoverablePlaywrightDialogRace', () => {
  it('returns true for standard Playwright dialog race ProtocolError', () => {
    const err = new Error('Protocol error (Page.handleJavaScriptDialog): {"code":-32602,"message":"No dialog is showing"}');
    err.name = 'ProtocolError';
    assert.equal(isRecoverablePlaywrightDialogRace(err), true);
  });

  it('returns true when the race message is in the stack trace', () => {
    const err = new Error('Some wrapper error');
    err.stack = 'Error: Some wrapper error\n  Page.handleJavaScriptDialog No dialog is showing';
    assert.equal(isRecoverablePlaywrightDialogRace(err), true);
  });

  it('returns true for string reason containing the race signature', () => {
    assert.equal(isRecoverablePlaywrightDialogRace('ProtocolError: Page.handleJavaScriptDialog: No dialog is showing'), true);
  });

  it('returns false for unrelated ProtocolError', () => {
    const err = new Error('Protocol error (Target.activateTarget): Target not found');
    err.name = 'ProtocolError';
    assert.equal(isRecoverablePlaywrightDialogRace(err), false);
  });

  it('returns false for random TypeError, null, and primitives', () => {
    assert.equal(isRecoverablePlaywrightDialogRace(new TypeError('Cannot read property x')), false);
    assert.equal(isRecoverablePlaywrightDialogRace(null), false);
    assert.equal(isRecoverablePlaywrightDialogRace(undefined), false);
    assert.equal(isRecoverablePlaywrightDialogRace(42), false);
    assert.equal(isRecoverablePlaywrightDialogRace(true), false);
  });
});

describe('isPortInUseError', () => {
  it('matches an EADDRINUSE errno error', () => {
    const err = new Error('listen EADDRINUSE: address already in use :::19989') as NodeJS.ErrnoException;
    err.code = 'EADDRINUSE';
    assert.equal(isPortInUseError(err), true);
  });

  it('does not match other errno codes or non-errors', () => {
    const epipe = new Error('write EPIPE') as NodeJS.ErrnoException;
    epipe.code = 'EPIPE';
    assert.equal(isPortInUseError(epipe), false);
    assert.equal(isPortInUseError(new Error('EADDRINUSE mentioned only in text')), false);
    assert.equal(isPortInUseError('EADDRINUSE'), false);
    assert.equal(isPortInUseError(null), false);
  });
});

describe('computeNavigateCommandTimeout', () => {
  it('reserves post-navigation headroom on a 60s budget', () => {
    const timeout = computeNavigateCommandTimeout(60000);
    assert.ok(timeout <= 60000 - 3000);
    assert.ok(timeout < 60000 * 0.85);
  });

  it('reserves at least 3s for post-navigation work', () => {
    assert.ok(60000 - computeNavigateCommandTimeout(60000) >= 3000);
    assert.ok(30000 - computeNavigateCommandTimeout(30000) >= 3000);
  });

  it('caps navigate timeout to the 30s default even with a huge budget', () => {
    assert.ok(computeNavigateCommandTimeout(120000) <= 30000);
  });

  it('throws NavigationBudgetError when remaining time is too small', () => {
    assert.throws(() => computeNavigateCommandTimeout(500), NavigationBudgetError);
    assert.throws(() => computeNavigateCommandTimeout(0), NavigationBudgetError);
    assert.throws(() => computeNavigateCommandTimeout(-1000), NavigationBudgetError);
  });

  it('works with a moderate 10s budget', () => {
    const timeout = computeNavigateCommandTimeout(10000);
    assert.ok(timeout > 0 && timeout < 10000);
    assert.ok(10000 - timeout >= 2000);
  });
});

describe('isNoDialogShowingRace', () => {
  it('matches the dialog race error and rejects unrelated ones', () => {
    assert.equal(isNoDialogShowingRace(new Error('Page.handleJavaScriptDialog: No dialog is showing')), true);
    assert.equal(isNoDialogShowingRace(new Error('Navigation timeout')), false);
  });
});

describe('isExecutionTimeoutLikeError', () => {
  it('matches CodeExecutionTimeoutError and NavigationBudgetError', () => {
    assert.equal(isExecutionTimeoutLikeError(new CodeExecutionTimeoutError(30000)), true);
    assert.equal(isExecutionTimeoutLikeError(new NavigationBudgetError(500)), true);
  });

  it('matches a generic TimeoutError by name but not a random Error', () => {
    const err = new Error('Timed out');
    err.name = 'TimeoutError';
    assert.equal(isExecutionTimeoutLikeError(err), true);
    assert.equal(isExecutionTimeoutLikeError(new Error('Something else')), false);
  });
});

describe('ensureRelayServer export', () => {
  it('is a function (structural — not invoked to avoid starting a server)', () => {
    assert.equal(typeof ensureRelayServer, 'function');
  });
});
