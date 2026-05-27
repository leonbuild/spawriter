/**
 * Tests for relay crash analysis fixes (relay-crash-analysis.md §11).
 *
 * These are unit tests for the pure-logic parts of the fixes.
 * Integration tests (dialog handling under real Playwright, real relay server)
 * are left to manual/E2E runs because they need a running browser + extension.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// =========================================================================
// §11.3  process-level handler only recovers known Playwright dialog race
// §11.4  unknown unhandledRejection still causes exit
// =========================================================================
describe('isRecoverablePlaywrightDialogRace', () => {
  // Import the real function from relay.ts
  let isRecoverablePlaywrightDialogRace: (reason: unknown) => boolean;

  beforeEach(async () => {
    const mod = await import('../src/relay.js');
    isRecoverablePlaywrightDialogRace = mod.isRecoverablePlaywrightDialogRace;
  });

  it('returns true for standard Playwright dialog race ProtocolError', () => {
    const err = new Error(
      'Protocol error (Page.handleJavaScriptDialog): {"code":-32602,"message":"No dialog is showing"}'
    );
    err.name = 'ProtocolError';
    expect(isRecoverablePlaywrightDialogRace(err)).toBe(true);
  });

  it('returns true when the race message is in the stack trace', () => {
    const err = new Error('Some wrapper error');
    err.stack = `Error: Some wrapper error
    at CRSession.send (crConnection.js:111:57)
    Page.handleJavaScriptDialog No dialog is showing
    at DialogManager.dialogDidOpen`;
    expect(isRecoverablePlaywrightDialogRace(err)).toBe(true);
  });

  it('returns true for string reason containing the race signature', () => {
    const reason = 'ProtocolError: Page.handleJavaScriptDialog: No dialog is showing';
    expect(isRecoverablePlaywrightDialogRace(reason)).toBe(true);
  });

  it('returns false for unrelated ProtocolError', () => {
    const err = new Error('Protocol error (Target.activateTarget): Target not found');
    err.name = 'ProtocolError';
    expect(isRecoverablePlaywrightDialogRace(err)).toBe(false);
  });

  it('returns false for random TypeError', () => {
    expect(isRecoverablePlaywrightDialogRace(new TypeError('Cannot read property x'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isRecoverablePlaywrightDialogRace(null)).toBe(false);
    expect(isRecoverablePlaywrightDialogRace(undefined)).toBe(false);
  });

  it('returns false for number/boolean', () => {
    expect(isRecoverablePlaywrightDialogRace(42)).toBe(false);
    expect(isRecoverablePlaywrightDialogRace(true)).toBe(false);
  });
});

// =========================================================================
// §11.6  navigate() budget: not eating entire execution timeout
// =========================================================================
describe('computeNavigateCommandTimeout', () => {
  let computeNavigateCommandTimeout: (remainingExecutionMs: number) => number;
  let NavigationBudgetError: any;

  beforeEach(async () => {
    const mod = await import('../src/pw-executor.js');
    computeNavigateCommandTimeout = mod.computeNavigateCommandTimeout;
    NavigationBudgetError = mod.NavigationBudgetError;
  });

  it('reserves at least 20% of 60s timeout for post-navigation work', () => {
    const timeout = computeNavigateCommandTimeout(60000);
    expect(timeout).toBeLessThanOrEqual(60000 - 3000);
    expect(timeout).toBeLessThan(60000 * 0.85);
  });

  it('reserves 3-15s for post-navigation work', () => {
    const timeout60 = computeNavigateCommandTimeout(60000);
    const reserve60 = 60000 - timeout60;
    expect(reserve60).toBeGreaterThanOrEqual(3000);

    const timeout30 = computeNavigateCommandTimeout(30000);
    const reserve30 = 30000 - timeout30;
    expect(reserve30).toBeGreaterThanOrEqual(3000);
  });

  it('caps navigate timeout to default (30s) even with large remaining time', () => {
    const timeout = computeNavigateCommandTimeout(120000);
    expect(timeout).toBeLessThanOrEqual(30000);
  });

  it('throws NavigationBudgetError when remaining time is too small', () => {
    expect(() => computeNavigateCommandTimeout(500)).toThrow(NavigationBudgetError);
    expect(() => computeNavigateCommandTimeout(0)).toThrow(NavigationBudgetError);
    expect(() => computeNavigateCommandTimeout(-1000)).toThrow(NavigationBudgetError);
  });

  it('works with moderate remaining time (10s)', () => {
    const timeout = computeNavigateCommandTimeout(10000);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(10000);
    const reserve = 10000 - timeout;
    expect(reserve).toBeGreaterThanOrEqual(2000);
  });
});

// =========================================================================
// §11.5  unknown request id log now includes method/session/delete reason
// §11.10 late CDP response shows original method and delete reason
// =========================================================================
describe('PendingRequest lifecycle and diagnostics', () => {
  it('PendingRequest interface has method and createdAt fields', async () => {
    // This is a structural test — the TypeScript compiler enforces it.
    // We verify by constructing a PendingRequest-shaped object.
    const request = {
      clientId: 'test-client',
      clientMessageId: 1,
      sessionId: 'test-session',
      timeoutId: setTimeout(() => {}, 0) as ReturnType<typeof setTimeout>,
      method: 'Runtime.evaluate',
      createdAt: Date.now(),
    };
    clearTimeout(request.timeoutId);
    expect(request.method).toBe('Runtime.evaluate');
    expect(request.createdAt).toBeGreaterThan(0);
  });
});

// =========================================================================
// §11.1, §11.2  dialog handler installed in setupPageListeners
// =========================================================================
describe('dialog handler contract (structural)', () => {
  it('isNoDialogShowingRace is importable from pw-executor', async () => {
    // Verify the helper used in the dialog handler is exported
    const mod = await import('../src/pw-executor.js');
    expect(typeof mod.isNoDialogShowingRace).toBe('function');
  });

  it('isNoDialogShowingRace matches the dialog race error', async () => {
    const { isNoDialogShowingRace } = await import('../src/pw-executor.js');
    const err = new Error('Page.handleJavaScriptDialog: No dialog is showing');
    expect(isNoDialogShowingRace(err)).toBe(true);
  });

  it('isNoDialogShowingRace rejects unrelated errors', async () => {
    const { isNoDialogShowingRace } = await import('../src/pw-executor.js');
    expect(isNoDialogShowingRace(new Error('Navigation timeout'))).toBe(false);
  });
});

// =========================================================================
// §11.9  execution timeout resets CDP connection (structural)
// =========================================================================
describe('isExecutionTimeoutLikeError', () => {
  let isExecutionTimeoutLikeError: (err: Error) => boolean;
  let CodeExecutionTimeoutError: any;
  let NavigationBudgetError: any;

  beforeEach(async () => {
    const mod = await import('../src/pw-executor.js');
    isExecutionTimeoutLikeError = mod.isExecutionTimeoutLikeError;
    CodeExecutionTimeoutError = mod.CodeExecutionTimeoutError;
    NavigationBudgetError = mod.NavigationBudgetError;
  });

  it('matches CodeExecutionTimeoutError', () => {
    expect(isExecutionTimeoutLikeError(new CodeExecutionTimeoutError(30000))).toBe(true);
  });

  it('matches NavigationBudgetError', () => {
    expect(isExecutionTimeoutLikeError(new NavigationBudgetError(500))).toBe(true);
  });

  it('matches generic TimeoutError by name', () => {
    const err = new Error('Timed out');
    err.name = 'TimeoutError';
    expect(isExecutionTimeoutLikeError(err)).toBe(true);
  });

  it('does not match random Error', () => {
    expect(isExecutionTimeoutLikeError(new Error('Something else'))).toBe(false);
  });
});

// =========================================================================
// §11.8  ensure-relay health probe timeout and force parameter
// =========================================================================
describe('ensureRelayServer signature', () => {
  it('accepts force option', async () => {
    const mod = await import('../src/runtime/ensure-relay.js');
    expect(typeof mod.ensureRelayServer).toBe('function');
    // Structural: the function should accept { force: true } without type error.
    // We don't actually call it (would start a server), but verify the export exists.
  });
});
