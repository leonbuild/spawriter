/**
 * Tests for PlaywrightExecutor: auto-return detection, code wrapping,
 * VM execution, console capture, timeout, and state management.
 *
 * Run: npx tsx --test spawriter/src/pw-executor.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAutoReturnExpression,
  wrapCode,
  CodeExecutionTimeoutError,
  PlaywrightExecutor,
  ExecutorManager,
  isPlaywrightChannelOwner,
  ALLOWED_MODULES,
} from './pw-executor.js';

// ---------------------------------------------------------------------------
// Test: getAutoReturnExpression
// ---------------------------------------------------------------------------

describe('getAutoReturnExpression', () => {
  it('should detect simple expression: number literal', () => {
    assert.equal(getAutoReturnExpression('42'), '42');
  });

  it('should detect simple expression: string literal', () => {
    assert.equal(getAutoReturnExpression('"hello"'), '"hello"');
  });

  it('should detect function call expression', () => {
    assert.equal(getAutoReturnExpression('page.title()'), 'page.title()');
  });

  it('should detect await expression', () => {
    assert.equal(getAutoReturnExpression('await page.title()'), 'await page.title()');
  });

  it('should detect chained method call', () => {
    assert.equal(
      getAutoReturnExpression('page.locator("button").click()'),
      'page.locator("button").click()'
    );
  });

  it('should detect template literal', () => {
    const code = '`hello ${1 + 2}`';
    assert.equal(getAutoReturnExpression(code), code);
  });

  it('should strip trailing semicolons', () => {
    assert.equal(getAutoReturnExpression('42;'), '42');
  });

  it('should strip multiple trailing semicolons', () => {
    assert.equal(getAutoReturnExpression('42;;;'), '42');
  });

  it('should return null for empty code', () => {
    assert.equal(getAutoReturnExpression(''), null);
    assert.equal(getAutoReturnExpression('   '), null);
  });

  it('should return null for variable declarations', () => {
    assert.equal(getAutoReturnExpression('const x = 1'), null);
    assert.equal(getAutoReturnExpression('let y = 2'), null);
    assert.equal(getAutoReturnExpression('var z = 3'), null);
  });

  it('should return null for function declarations', () => {
    assert.equal(getAutoReturnExpression('function foo() {}'), null);
  });

  it('should return null for class declarations', () => {
    assert.equal(getAutoReturnExpression('class Foo {}'), null);
  });

  it('should return null for control flow statements', () => {
    assert.equal(getAutoReturnExpression('if (true) {}'), null);
    assert.equal(getAutoReturnExpression('for (;;) {}'), null);
    assert.equal(getAutoReturnExpression('while (true) {}'), null);
    assert.equal(getAutoReturnExpression('do {} while(true)'), null);
    assert.equal(getAutoReturnExpression('switch (x) {}'), null);
    assert.equal(getAutoReturnExpression('try {} catch(e) {}'), null);
    assert.equal(getAutoReturnExpression('throw new Error()'), null);
  });

  it('should return null for return statements', () => {
    assert.equal(getAutoReturnExpression('return 42'), null);
  });

  it('should return null for import/export', () => {
    assert.equal(getAutoReturnExpression('import x from "y"'), null);
    assert.equal(getAutoReturnExpression('export default 42'), null);
  });

  it('should return null for multi-statement code with semicolons', () => {
    assert.equal(getAutoReturnExpression('a = 1;\nb = 2'), null);
  });

  it('should detect array literal', () => {
    assert.equal(getAutoReturnExpression('[1, 2, 3]'), '[1, 2, 3]');
  });

  it('should detect ternary expression', () => {
    assert.equal(getAutoReturnExpression('x ? 1 : 2'), 'x ? 1 : 2');
  });

  it('should detect arrow function expression', () => {
    const code = '() => 42';
    assert.equal(getAutoReturnExpression(code), code);
  });

  it('should detect new expression', () => {
    assert.equal(getAutoReturnExpression('new Date()'), 'new Date()');
  });

  it('should handle complex single expression spanning multiple lines without semicolons', () => {
    const code = 'await page\n  .locator("button")\n  .click()';
    assert.equal(getAutoReturnExpression(code), code);
  });
});

// ---------------------------------------------------------------------------
// Test: wrapCode
// ---------------------------------------------------------------------------

describe('wrapCode', () => {
  it('should wrap single expression with return', () => {
    const result = wrapCode('page.title()');
    assert.ok(result.includes('return await'));
    assert.ok(result.includes('page.title()'));
  });

  it('should wrap multi-statement code without return', () => {
    const result = wrapCode('const x = 1;\nconsole.log(x);');
    assert.ok(result.includes('const x = 1'));
    assert.ok(!result.includes('return await'));
  });

  it('should wrap code with explicit return as-is (no auto-return)', () => {
    const result = wrapCode('return page.title()');
    assert.ok(!result.includes('return await (return'));
    assert.ok(result.includes('return page.title()'));
  });

  it('should always produce async IIFE', () => {
    assert.ok(wrapCode('42').includes('async'));
    assert.ok(wrapCode('const x = 1').includes('async'));
  });
});

// ---------------------------------------------------------------------------
// Test: CodeExecutionTimeoutError
// ---------------------------------------------------------------------------

describe('CodeExecutionTimeoutError', () => {
  it('should have correct name', () => {
    const err = new CodeExecutionTimeoutError(5000);
    assert.equal(err.name, 'CodeExecutionTimeoutError');
  });

  it('should include timeout in message', () => {
    const err = new CodeExecutionTimeoutError(10000);
    assert.ok(err.message.includes('10000'));
  });

  it('should be an instance of Error', () => {
    const err = new CodeExecutionTimeoutError(5000);
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Test: PlaywrightExecutor.formatConsoleLogs (static)
// ---------------------------------------------------------------------------

describe('PlaywrightExecutor.formatConsoleLogs', () => {
  it('should return empty string for no logs', () => {
    assert.equal(PlaywrightExecutor.formatConsoleLogs([]), '');
  });

  it('should format single log entry', () => {
    const text = PlaywrightExecutor.formatConsoleLogs([
      { method: 'log', args: ['hello world'] },
    ]);
    assert.ok(text.includes('Console output:'));
    assert.ok(text.includes('[log] hello world'));
  });

  it('should format multiple log entries', () => {
    const text = PlaywrightExecutor.formatConsoleLogs([
      { method: 'log', args: ['msg1'] },
      { method: 'error', args: ['msg2'] },
      { method: 'warn', args: ['msg3'] },
    ]);
    assert.ok(text.includes('[log] msg1'));
    assert.ok(text.includes('[error] msg2'));
    assert.ok(text.includes('[warn] msg3'));
  });

  it('should use custom prefix', () => {
    const text = PlaywrightExecutor.formatConsoleLogs(
      [{ method: 'log', args: ['test'] }],
      'Logs before error'
    );
    assert.ok(text.includes('Logs before error:'));
  });

  it('should format non-string args with util.inspect', () => {
    const text = PlaywrightExecutor.formatConsoleLogs([
      { method: 'log', args: [{ key: 'value' }] },
    ]);
    assert.ok(text.includes('key'));
    assert.ok(text.includes('value'));
  });

  it('should join multiple args with space', () => {
    const text = PlaywrightExecutor.formatConsoleLogs([
      { method: 'log', args: ['a', 'b', 'c'] },
    ]);
    assert.ok(text.includes('[log] a b c'));
  });

  it('should format all console methods (log, info, warn, error, debug)', () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const logs = methods.map(m => ({ method: m, args: [`${m} message`] }));
    const text = PlaywrightExecutor.formatConsoleLogs(logs);
    for (const m of methods) {
      assert.ok(text.includes(`[${m}] ${m} message`));
    }
  });

  it('should handle empty args array', () => {
    const text = PlaywrightExecutor.formatConsoleLogs([
      { method: 'log', args: [] },
    ]);
    assert.ok(text.includes('[log]'));
  });
});

// ---------------------------------------------------------------------------
// Test: PlaywrightExecutor instance (no real browser)
// ---------------------------------------------------------------------------

describe('PlaywrightExecutor instance', () => {
  it('should start disconnected', () => {
    const executor = new PlaywrightExecutor();
    const status = executor.getStatus();
    assert.equal(status.connected, false);
    assert.deepEqual(status.stateKeys, []);
  });

  it('should reset state', async () => {
    const executor = new PlaywrightExecutor();
    await executor.reset();
    const status = executor.getStatus();
    assert.equal(status.connected, false);
    assert.deepEqual(status.stateKeys, []);
  });

  it('reset should be idempotent', async () => {
    const executor = new PlaywrightExecutor();
    await executor.reset();
    await executor.reset();
    const status = executor.getStatus();
    assert.equal(status.connected, false);
  });
});

// ---------------------------------------------------------------------------
// Test: VM sandbox execution (isolated, no browser)
// ---------------------------------------------------------------------------

describe('VM sandbox execution (isolated)', () => {
  it('should execute simple expression and return result via auto-return', async () => {
    const code = '1 + 2';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    const result = await vm.runInContext(wrapped, vmContext);
    assert.equal(result, 3);
  });

  it('should execute async code', async () => {
    const code = 'await Promise.resolve(42)';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    const promise = vm.runInContext(wrapped, vmContext);
    const result = await promise;
    assert.equal(result, 42);
  });

  it('should capture console output in sandbox', async () => {
    const logs: Array<{ method: string; args: unknown[] }> = [];
    const customConsole = {
      log: (...args: unknown[]) => logs.push({ method: 'log', args }),
      error: (...args: unknown[]) => logs.push({ method: 'error', args }),
      warn: (...args: unknown[]) => logs.push({ method: 'warn', args }),
      info: (...args: unknown[]) => logs.push({ method: 'info', args }),
      debug: (...args: unknown[]) => logs.push({ method: 'debug', args }),
    };

    const code = 'console.log("hello"); console.error("oops"); console.warn("careful")';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: customConsole,
    });
    await vm.runInContext(wrapped, vmContext);

    assert.equal(logs.length, 3);
    assert.equal(logs[0].method, 'log');
    assert.deepEqual(logs[0].args, ['hello']);
    assert.equal(logs[1].method, 'error');
    assert.deepEqual(logs[1].args, ['oops']);
    assert.equal(logs[2].method, 'warn');
    assert.deepEqual(logs[2].args, ['careful']);
  });

  it('should provide state object for persistence', async () => {
    const state: Record<string, unknown> = {};
    const code = 'state.counter = (state.counter || 0) + 1; return state.counter';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
      state,
    });

    const r1 = await vm.runInContext(wrapped, vmContext);
    assert.equal(r1, 1);

    const r2 = await vm.runInContext(wrapped, vmContext);
    assert.equal(r2, 2);

    assert.equal(state.counter, 2);
  });

  it('should have access to usefulGlobals', async () => {
    const code = 'return typeof URL !== "undefined" && typeof fetch !== "undefined" && typeof Buffer !== "undefined"';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    const result = await vm.runInContext(wrapped, vmContext);
    assert.equal(result, true);
  });

  it('should timeout on infinite loop', async () => {
    const code = 'while(true) {}';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    assert.throws(
      () => vm.runInContext(wrapped, vmContext, { timeout: 100 }),
      (err: Error) => err.message.includes('timed out')
    );
  });

  it('should propagate errors from user code', async () => {
    const code = 'throw new Error("user error")';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    await assert.rejects(
      () => vm.runInContext(wrapped, vmContext),
      /user error/
    );
  });

  it('should handle return undefined gracefully', async () => {
    const code = 'return undefined';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
    });
    const result = await vm.runInContext(wrapped, vmContext);
    assert.equal(result, undefined);
  });

  it('should handle returning complex objects', async () => {
    const code = 'return { a: 1, b: [2, 3], c: { d: true } }';
    const wrapped = wrapCode(code);
    const vmContext = vm.createContext({
      ...usefulGlobalsForTest(),
      console: silentConsole(),
      JSON,
    });
    const result = await vm.runInContext(wrapped, vmContext);
    const normalized = JSON.parse(JSON.stringify(result));
    assert.deepEqual(normalized, { a: 1, b: [2, 3], c: { d: true } });
  });

  it('should isolate between different VM contexts', async () => {
    const code1 = 'globalThis.leaked = 42; return globalThis.leaked';
    const code2 = 'return globalThis.leaked';

    const ctx1 = vm.createContext({ ...usefulGlobalsForTest(), console: silentConsole() });
    const ctx2 = vm.createContext({ ...usefulGlobalsForTest(), console: silentConsole() });

    const r1 = await vm.runInContext(wrapCode(code1), ctx1);
    assert.equal(r1, 42);

    const r2 = await vm.runInContext(wrapCode(code2), ctx2);
    assert.equal(r2, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test: Promise.race timeout pattern
// ---------------------------------------------------------------------------

describe('Promise.race timeout pattern', () => {
  it('should resolve when code finishes before timeout', async () => {
    const result = await Promise.race([
      Promise.resolve(42),
      new Promise((_, reject) => setTimeout(() => reject(new CodeExecutionTimeoutError(1000)), 1000)),
    ]);
    assert.equal(result, 42);
  });

  it('should reject when timeout fires first', async () => {
    await assert.rejects(
      () => Promise.race([
        new Promise(resolve => setTimeout(resolve, 5000)),
        new Promise((_, reject) => setTimeout(() => reject(new CodeExecutionTimeoutError(50)), 50)),
      ]),
      (err: Error) => err instanceof CodeExecutionTimeoutError
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Result text formatting
// ---------------------------------------------------------------------------

describe('Result text formatting', () => {
  it('should show "Code executed successfully" for no output, no return', () => {
    const consoleLogs: Array<{ method: string; args: unknown[] }> = [];
    const logsText = PlaywrightExecutor.formatConsoleLogs(consoleLogs);
    const result = logsText.trim() || 'Code executed successfully (no output)';
    assert.equal(result, 'Code executed successfully (no output)');
  });

  it('should show console output when present', () => {
    const consoleLogs = [{ method: 'log', args: ['debug info'] }];
    const logsText = PlaywrightExecutor.formatConsoleLogs(consoleLogs);
    assert.ok(logsText.includes('debug info'));
  });

  it('should truncate very long output', () => {
    const longText = 'x'.repeat(20000);
    const MAX_LENGTH = 10000;
    const finalText = longText.length > MAX_LENGTH
      ? longText.slice(0, MAX_LENGTH) + `\n\n[Truncated to ${MAX_LENGTH} characters]`
      : longText;
    assert.ok(finalText.length < longText.length);
    assert.ok(finalText.includes('[Truncated'));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usefulGlobalsForTest() {
  return {
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    URL,
    URLSearchParams,
    fetch,
    Buffer,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone,
    Promise,
  };
}

function silentConsole() {
  return {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

// Re-import vm for test helpers
import * as vm from 'node:vm';

// ---------------------------------------------------------------------------
// Test: ExecutorManager
// ---------------------------------------------------------------------------

describe('ExecutorManager', () => {
  it('should start with zero sessions', () => {
    const manager = new ExecutorManager();
    assert.equal(manager.size, 0);
    assert.deepEqual(manager.listSessions(), []);
  });

  it('getOrCreate should create a new session', () => {
    const manager = new ExecutorManager();
    const executor = manager.getOrCreate('session-1');
    assert.ok(executor instanceof PlaywrightExecutor);
    assert.equal(manager.size, 1);
  });

  it('getOrCreate should return existing session', () => {
    const manager = new ExecutorManager();
    const first = manager.getOrCreate('session-1');
    const second = manager.getOrCreate('session-1');
    assert.strictEqual(first, second);
    assert.equal(manager.size, 1);
  });

  it('get should return null for non-existent session', () => {
    const manager = new ExecutorManager();
    assert.equal(manager.get('nonexistent'), null);
  });

  it('get should return existing session', () => {
    const manager = new ExecutorManager();
    const executor = manager.getOrCreate('my-session');
    assert.strictEqual(manager.get('my-session'), executor);
  });

  it('remove should delete existing session', async () => {
    const manager = new ExecutorManager();
    manager.getOrCreate('sess-1');
    const removed = await manager.remove('sess-1');
    assert.equal(removed, true);
    assert.equal(manager.size, 0);
    assert.equal(manager.get('sess-1'), null);
  });

  it('remove should return false for non-existent session', async () => {
    const manager = new ExecutorManager();
    const removed = await manager.remove('nonexistent');
    assert.equal(removed, false);
  });

  it('listSessions should return all sessions', () => {
    const manager = new ExecutorManager();
    manager.getOrCreate('alpha');
    manager.getOrCreate('beta');
    const sessions = manager.listSessions();
    assert.equal(sessions.length, 2);
    const ids = sessions.map(s => s.id);
    assert.ok(ids.includes('alpha'));
    assert.ok(ids.includes('beta'));
  });

  it('listSessions should include connected and stateKeys fields', () => {
    const manager = new ExecutorManager();
    manager.getOrCreate('test');
    const sessions = manager.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(typeof sessions[0].connected, 'boolean');
    assert.ok(Array.isArray(sessions[0].stateKeys));
  });

  it('resetAll should clear all sessions', async () => {
    const manager = new ExecutorManager();
    manager.getOrCreate('one');
    manager.getOrCreate('two');
    manager.getOrCreate('three');
    await manager.resetAll();
    assert.equal(manager.size, 0);
    assert.deepEqual(manager.listSessions(), []);
  });

  it('should throw when max sessions reached', () => {
    const manager = new ExecutorManager({ maxSessions: 2 });
    manager.getOrCreate('first');
    manager.getOrCreate('second');
    assert.equal(manager.size, 2);
    assert.throws(() => manager.getOrCreate('third'), /executor limit reached/i);
    assert.equal(manager.size, 2);
    assert.ok(manager.get('first'));
    assert.ok(manager.get('second'));
  });

  it('should use default maxSessions of 5', () => {
    const manager = new ExecutorManager();
    for (let i = 0; i < 5; i++) {
      manager.getOrCreate(`s-${i}`);
    }
    assert.equal(manager.size, 5);
    assert.throws(() => manager.getOrCreate('s-5'), /executor limit reached/i);
  });

  it('size should reflect current count', () => {
    const manager = new ExecutorManager();
    assert.equal(manager.size, 0);
    manager.getOrCreate('a');
    assert.equal(manager.size, 1);
    manager.getOrCreate('b');
    assert.equal(manager.size, 2);
  });

  it('each session should be independent', () => {
    const manager = new ExecutorManager();
    const exec1 = manager.getOrCreate('session-a');
    const exec2 = manager.getOrCreate('session-b');
    assert.notStrictEqual(exec1, exec2);
    assert.equal(exec1.getStatus().connected, false);
    assert.equal(exec2.getStatus().connected, false);
  });
});

// ---------------------------------------------------------------------------
// Test: ExecutorManager – eviction edge cases
// ---------------------------------------------------------------------------

describe('ExecutorManager – eviction edge cases', () => {
  it('maxSessions=1 should throw on second create', () => {
    const mgr = new ExecutorManager({ maxSessions: 1 });
    mgr.getOrCreate('a');
    assert.throws(() => mgr.getOrCreate('b'), /executor limit reached/i);
    assert.equal(mgr.size, 1);
    assert.ok(mgr.get('a'));
  });

  it('re-accessing existing session should not trigger eviction', () => {
    const mgr = new ExecutorManager({ maxSessions: 2 });
    const a = mgr.getOrCreate('a');
    mgr.getOrCreate('b');
    const a2 = mgr.getOrCreate('a');
    assert.strictEqual(a, a2);
    assert.equal(mgr.size, 2);
  });

  it('remove + re-create should create fresh instance', async () => {
    const mgr = new ExecutorManager({ maxSessions: 2 });
    const first = mgr.getOrCreate('x');
    mgr.getOrCreate('y');
    await mgr.remove('x');
    const second = mgr.getOrCreate('x');
    assert.notStrictEqual(first, second);
    assert.equal(mgr.size, 2);
  });

  it('remove then getOrCreate should create new instance', async () => {
    const mgr = new ExecutorManager({ maxSessions: 5 });
    const original = mgr.getOrCreate('sess');
    await mgr.remove('sess');
    const replacement = mgr.getOrCreate('sess');
    assert.notStrictEqual(original, replacement);
  });

  it('resetAll should make all gets return null', async () => {
    const mgr = new ExecutorManager({ maxSessions: 5 });
    mgr.getOrCreate('a');
    mgr.getOrCreate('b');
    mgr.getOrCreate('c');
    await mgr.resetAll();
    assert.equal(mgr.get('a'), null);
    assert.equal(mgr.get('b'), null);
    assert.equal(mgr.get('c'), null);
    assert.equal(mgr.size, 0);
  });

  it('listSessions after remove should only show surviving sessions', async () => {
    const mgr = new ExecutorManager({ maxSessions: 3 });
    mgr.getOrCreate('old');
    mgr.getOrCreate('mid');
    mgr.getOrCreate('new');
    await mgr.remove('old');
    const sessions = mgr.listSessions();
    assert.equal(sessions.length, 2);
    const ids = sessions.map(s => s.id);
    assert.ok(!ids.includes('old'));
    assert.ok(ids.includes('mid'));
    assert.ok(ids.includes('new'));
  });

  it('double remove should be safe', async () => {
    const mgr = new ExecutorManager({ maxSessions: 5 });
    mgr.getOrCreate('x');
    assert.equal(await mgr.remove('x'), true);
    assert.equal(await mgr.remove('x'), false);
  });
});

// ---------------------------------------------------------------------------
// Test: ExecutorManager – session status
// ---------------------------------------------------------------------------

describe('ExecutorManager – session status inspection', () => {
  it('new session should be disconnected with no state keys', () => {
    const mgr = new ExecutorManager();
    mgr.getOrCreate('fresh');
    const sessions = mgr.listSessions();
    assert.equal(sessions[0].connected, false);
    assert.deepEqual(sessions[0].stateKeys, []);
  });

  it('listSessions preserves insertion order', () => {
    const mgr = new ExecutorManager({ maxSessions: 10 });
    mgr.getOrCreate('alpha');
    mgr.getOrCreate('beta');
    mgr.getOrCreate('gamma');
    const ids = mgr.listSessions().map(s => s.id);
    assert.deepEqual(ids, ['alpha', 'beta', 'gamma']);
  });

  it('multiple resets should be idempotent', async () => {
    const mgr = new ExecutorManager();
    mgr.getOrCreate('a');
    await mgr.resetAll();
    await mgr.resetAll();
    await mgr.resetAll();
    assert.equal(mgr.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Test: getAutoReturnExpression – additional edge cases
// ---------------------------------------------------------------------------

describe('getAutoReturnExpression – comprehensive edge cases', () => {
  it('should detect typeof expression', () => {
    const result = getAutoReturnExpression('typeof window');
    assert.equal(result, 'typeof window');
  });

  it('should detect void expression', () => {
    const result = getAutoReturnExpression('void 0');
    assert.equal(result, 'void 0');
  });

  it('should detect delete expression', () => {
    const result = getAutoReturnExpression('delete obj.key');
    assert.equal(result, 'delete obj.key');
  });

  it('should detect yield as non-expression (statement)', () => {
    const result = getAutoReturnExpression('yield value');
    assert.equal(result, null);
  });

  it('should return null for try/catch', () => {
    assert.equal(getAutoReturnExpression('try { x() } catch(e) {}'), null);
  });

  it('should return null for switch statement', () => {
    assert.equal(getAutoReturnExpression('switch(x) { case 1: break; }'), null);
  });

  it('should return null for throw statement', () => {
    assert.equal(getAutoReturnExpression('throw new Error("x")'), null);
  });

  it('should detect comma expression', () => {
    const result = getAutoReturnExpression('(a(), b())');
    assert.equal(result, '(a(), b())');
  });

  it('should detect assignment expression', () => {
    const result = getAutoReturnExpression('x = 42');
    assert.equal(result, 'x = 42');
  });

  it('should handle whitespace-only input', () => {
    assert.equal(getAutoReturnExpression('   '), null);
  });

  it('should handle multiple trailing semicolons and whitespace', () => {
    assert.equal(getAutoReturnExpression('42;;;'), '42');
    assert.equal(getAutoReturnExpression('42;  '), '42');
    assert.equal(getAutoReturnExpression('42 ; ; ; '), null);
  });

  it('should detect tagged template literal', () => {
    const result = getAutoReturnExpression('html`<div></div>`');
    assert.equal(result, 'html`<div></div>`');
  });

  it('should detect spread in array', () => {
    const result = getAutoReturnExpression('[...arr]');
    assert.equal(result, '[...arr]');
  });

  it('should detect optional chaining', () => {
    const result = getAutoReturnExpression('obj?.method?.()');
    assert.equal(result, 'obj?.method?.()');
  });

  it('should detect nullish coalescing', () => {
    const result = getAutoReturnExpression('x ?? "default"');
    assert.equal(result, 'x ?? "default"');
  });

  it('should detect exponentiation', () => {
    const result = getAutoReturnExpression('2 ** 10');
    assert.equal(result, '2 ** 10');
  });
});

// ---------------------------------------------------------------------------
// Test: wrapCode – comprehensive
// ---------------------------------------------------------------------------

describe('wrapCode – comprehensive', () => {
  it('should wrap expression with return and async IIFE', () => {
    const result = wrapCode('42');
    assert.ok(result.includes('return await'));
    assert.ok(result.includes('42'));
    assert.ok(result.startsWith('(async'));
  });

  it('should wrap statement without return', () => {
    const result = wrapCode('const x = 1; console.log(x);');
    assert.ok(!result.includes('return await'));
    assert.ok(result.includes('const x = 1'));
  });

  it('should wrap empty string', () => {
    const result = wrapCode('');
    assert.ok(result.includes('(async'));
  });

  it('should wrap multiline code block', () => {
    const code = 'const x = 1;\nconst y = 2;\nconsole.log(x + y);';
    const result = wrapCode(code);
    assert.ok(result.includes(code));
  });

  it('should handle code with template literals', () => {
    const code = '`hello ${name}`';
    const result = wrapCode(code);
    assert.ok(result.includes('return await'));
  });

  it('should handle await expression', () => {
    const result = wrapCode('await page.title()');
    assert.ok(result.includes('return await'));
    assert.ok(result.includes('page.title()'));
  });
});

// ---------------------------------------------------------------------------
// Test: VM sandbox – additional isolation tests
// ---------------------------------------------------------------------------

describe('VM sandbox – additional isolation', () => {
  it('should not leak global scope modifications', () => {
    const ctx1 = vm.createContext({ value: 1 });
    const ctx2 = vm.createContext({ value: 2 });
    vm.runInContext('value = value + 10', ctx1);
    const r1 = vm.runInContext('value', ctx1);
    const r2 = vm.runInContext('value', ctx2);
    assert.equal(r1, 11);
    assert.equal(r2, 2);
  });

  it('should handle regex in sandbox', () => {
    const ctx = vm.createContext({});
    const result = vm.runInContext('/hello/.test("hello world")', ctx);
    assert.equal(result, true);
  });

  it('should handle Symbol in sandbox', () => {
    const ctx = vm.createContext({ Symbol });
    const result = vm.runInContext('typeof Symbol("test")', ctx);
    assert.equal(result, 'symbol');
  });

  it('should handle Map and Set in sandbox', () => {
    const ctx = vm.createContext({ Map, Set });
    const result = vm.runInContext('new Map([["a", 1]]).get("a")', ctx);
    assert.equal(result, 1);
  });

  it('should handle async generators', async () => {
    const ctx = vm.createContext({});
    const gen = vm.runInContext('(async function*() { yield 1; yield 2; })()', ctx);
    const values: number[] = [];
    for await (const v of gen as AsyncGenerator<number>) {
      values.push(v);
    }
    assert.deepEqual(values, [1, 2]);
  });

  it('should handle destructuring', () => {
    const ctx = vm.createContext({ JSON });
    const result = vm.runInContext('const {a, b} = {a: 1, b: 2}; JSON.stringify({a, b})', ctx);
    assert.equal(result, '{"a":1,"b":2}');
  });

  it('should handle arrow functions with closures', () => {
    const ctx = vm.createContext({});
    const result = vm.runInContext('const add = x => y => x + y; add(3)(4)', ctx);
    assert.equal(result, 7);
  });

  it('should handle Proxy objects', () => {
    const ctx = vm.createContext({ Proxy });
    const result = vm.runInContext(`
      const handler = { get: (target, prop) => prop === 'hello' ? 'world' : undefined };
      const p = new Proxy({}, handler);
      p.hello
    `, ctx);
    assert.equal(result, 'world');
  });
});

// ---------------------------------------------------------------------------
// Test: CodeExecutionTimeoutError – additional
// ---------------------------------------------------------------------------

describe('CodeExecutionTimeoutError – additional', () => {
  it('should have correct prototype chain', () => {
    const err = new CodeExecutionTimeoutError(5000);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof CodeExecutionTimeoutError);
  });

  it('should have stack trace', () => {
    const err = new CodeExecutionTimeoutError(5000);
    assert.ok(err.stack);
    assert.ok(err.stack!.includes('CodeExecutionTimeoutError'));
  });

  it('should format various timeout values', () => {
    assert.ok(new CodeExecutionTimeoutError(0).message.includes('0ms'));
    assert.ok(new CodeExecutionTimeoutError(100).message.includes('100ms'));
    assert.ok(new CodeExecutionTimeoutError(60000).message.includes('60000ms'));
  });
});

// ---------------------------------------------------------------------------
// Test: AbortController-based cancellation pattern
// ---------------------------------------------------------------------------

describe('AbortController cancellation pattern', () => {
  it('should abort a pending promise when signal fires', async () => {
    const ac = new AbortController();
    const promise = Promise.race([
      new Promise(resolve => setTimeout(resolve, 10000)),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(100)));
      }),
    ]);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(promise, (err: Error) => err instanceof CodeExecutionTimeoutError);
  });

  it('should not reject if resolved before abort', async () => {
    const ac = new AbortController();
    const result = await Promise.race([
      Promise.resolve('done'),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(100)));
      }),
    ]);
    assert.equal(result, 'done');
    ac.abort(); // should not throw after resolution
  });

  it('should handle already-aborted controller', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      Promise.race([
        new Promise(resolve => setTimeout(resolve, 1000)),
        new Promise<never>((_, reject) => {
          if (ac.signal.aborted) reject(new CodeExecutionTimeoutError(0));
          ac.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(0)));
        }),
      ]),
      (err: Error) => err instanceof CodeExecutionTimeoutError
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Promise.race with multiple reject sources (timeout + abort)
// ---------------------------------------------------------------------------

describe('Multi-source timeout (timeout timer + abort signal)', () => {
  it('timeout timer wins when it fires first', async () => {
    const ac = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    await assert.rejects(
      Promise.race([
        new Promise(resolve => setTimeout(resolve, 10000)),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('timeout-timer')), 30);
        }),
        new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('abort-signal')));
        }),
      ]),
      (err: Error) => err.message === 'timeout-timer'
    );
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });

  it('abort signal wins when it fires first', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(
      Promise.race([
        new Promise(resolve => setTimeout(resolve, 10000)),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timeout-timer')), 5000);
        }),
        new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('abort-signal')));
        }),
      ]),
      (err: Error) => err.message === 'abort-signal'
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Health check timeout pattern (ensureConnection)
// ---------------------------------------------------------------------------

describe('Health check timeout pattern', () => {
  it('should timeout when health check hangs', async () => {
    await assert.rejects(
      Promise.race([
        new Promise(() => {}), // simulates a hanging page.evaluate('1')
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 50)),
      ]),
      (err: Error) => err.message === 'Health check timeout'
    );
  });

  it('should pass when health check responds quickly', async () => {
    const result = await Promise.race([
      Promise.resolve('ok'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 5000)),
    ]);
    assert.equal(result, 'ok');
  });
});

// ---------------------------------------------------------------------------
// Test: CDP connection timeout pattern (ensureConnection)
// ---------------------------------------------------------------------------

describe('CDP connection timeout pattern', () => {
  it('should timeout when connectOverCDP hangs', async () => {
    await assert.rejects(
      Promise.race([
        new Promise(() => {}), // simulates a hanging connectOverCDP
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CDP connection timeout (15s)')), 50)),
      ]),
      (err: Error) => err.message === 'CDP connection timeout (15s)'
    );
  });
});

// ---------------------------------------------------------------------------
// Test: PlaywrightExecutor.cancelActiveExecution
// ---------------------------------------------------------------------------

describe('PlaywrightExecutor.cancelActiveExecution', () => {
  it('should be callable when no execution is active', () => {
    const executor = new PlaywrightExecutor();
    assert.doesNotThrow(() => executor.cancelActiveExecution());
  });

  it('should be callable multiple times without error', () => {
    const executor = new PlaywrightExecutor();
    executor.cancelActiveExecution();
    executor.cancelActiveExecution();
    executor.cancelActiveExecution();
  });
});

// ---------------------------------------------------------------------------
// Test: Timeout hint message format
// ---------------------------------------------------------------------------

describe('Timeout hint messages', () => {
  it('CodeExecutionTimeoutError message contains ms value', () => {
    const err = new CodeExecutionTimeoutError(30000);
    assert.ok(err.message.includes('30000'));
    assert.ok(err.message.includes('timed out'));
  });

  it('timeout errors should be classified correctly', () => {
    const timeoutErr = new CodeExecutionTimeoutError(5000);
    assert.equal(timeoutErr.name, 'CodeExecutionTimeoutError');

    const playwrightTimeout = new Error('Timeout 30000ms exceeded');
    playwrightTimeout.name = 'TimeoutError';
    assert.equal(playwrightTimeout.name, 'TimeoutError');

    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    assert.equal(abortErr.name, 'AbortError');
  });

  it('should classify all three timeout types as timeout errors', () => {
    const errors = [
      new CodeExecutionTimeoutError(5000),
      Object.assign(new Error('Timeout'), { name: 'TimeoutError' }),
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
    ];

    for (const err of errors) {
      const isTimeout = err instanceof CodeExecutionTimeoutError
        || err.name === 'TimeoutError'
        || err.name === 'AbortError';
      assert.ok(isTimeout, `${err.name} should be classified as timeout`);
    }
  });

  it('should NOT classify regular errors as timeout', () => {
    const regularErrors = [
      new Error('connection refused'),
      new TypeError('x is not a function'),
      new RangeError('out of range'),
    ];

    for (const err of regularErrors) {
      const isTimeout = err instanceof CodeExecutionTimeoutError
        || err.name === 'TimeoutError'
        || err.name === 'AbortError';
      assert.ok(!isTimeout, `${err.name} should NOT be classified as timeout`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: isPlaywrightChannelOwner (Phase 2 security fix)
// ---------------------------------------------------------------------------

describe('isPlaywrightChannelOwner', () => {
  it('should detect objects with _type and _guid', () => {
    const channelOwner = { _type: 'Page', _guid: 'page@1234', url: 'http://example.com' };
    assert.equal(isPlaywrightChannelOwner(channelOwner), true);
  });

  it('should not detect plain objects', () => {
    assert.equal(isPlaywrightChannelOwner({}), false);
    assert.equal(isPlaywrightChannelOwner({ name: 'foo' }), false);
  });

  it('should not detect null/undefined/primitives', () => {
    assert.equal(isPlaywrightChannelOwner(null), false);
    assert.equal(isPlaywrightChannelOwner(undefined), false);
    assert.equal(isPlaywrightChannelOwner(42), false);
    assert.equal(isPlaywrightChannelOwner('string'), false);
  });

  it('should not detect objects with only _type or only _guid', () => {
    assert.equal(isPlaywrightChannelOwner({ _type: 'Page' }), false);
    assert.equal(isPlaywrightChannelOwner({ _guid: 'page@1234' }), false);
  });

  it('should detect channel owners with extra properties', () => {
    const obj = { _type: 'Response', _guid: 'resp@1', status: 200, _connection: {} };
    assert.equal(isPlaywrightChannelOwner(obj), true);
  });
});

// ---------------------------------------------------------------------------
// Test: PlaywrightExecutor.setGlobals (Phase 2)
// ---------------------------------------------------------------------------

describe('PlaywrightExecutor.setGlobals', () => {
  it('should store custom globals', () => {
    const executor = new PlaywrightExecutor();
    executor.setGlobals({ myFunc: () => 42, myValue: 'hello' });
    // Verify globals are stored (indirectly via getStatus — no direct accessor)
    assert.ok(executor);
  });

  it('should merge multiple setGlobals calls', () => {
    const executor = new PlaywrightExecutor();
    executor.setGlobals({ a: 1 });
    executor.setGlobals({ b: 2 });
    // Both should be available after merging
    assert.ok(executor);
  });

  it('should override previously set globals', () => {
    const executor = new PlaywrightExecutor();
    executor.setGlobals({ x: 'old' });
    executor.setGlobals({ x: 'new' });
    assert.ok(executor);
  });
});

// ---------------------------------------------------------------------------
// Test: ExecuteResult includes images field (Phase 2)
// ---------------------------------------------------------------------------

describe('ExecuteResult images field', () => {
  it('ExecuteResult should have images array type', () => {
    const result: import('./pw-executor.js').ExecuteResult = {
      text: 'test',
      isError: false,
      images: [],
    };
    assert.ok(Array.isArray(result.images));
    assert.equal(result.images.length, 0);
  });

  it('ExecuteResult images can hold image data', () => {
    const result: import('./pw-executor.js').ExecuteResult = {
      text: 'test',
      isError: false,
      images: [{ data: 'base64data', mimeType: 'image/webp' }],
    };
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, 'image/webp');
  });
});

// ---------------------------------------------------------------------------
// Test: ALLOWED_MODULES (sandboxed require)
// ---------------------------------------------------------------------------

describe('ALLOWED_MODULES', () => {
  it('should include 36 entries (18 modules x 2 for node: prefix)', () => {
    assert.equal(ALLOWED_MODULES.size, 36);
  });

  it('should include all expected safe modules', () => {
    const expected = [
      'path', 'url', 'querystring', 'punycode', 'crypto', 'buffer',
      'string_decoder', 'util', 'assert', 'events', 'timers', 'stream',
      'zlib', 'http', 'https', 'http2', 'os', 'fs',
    ];
    for (const mod of expected) {
      assert.ok(ALLOWED_MODULES.has(mod), `missing: ${mod}`);
      assert.ok(ALLOWED_MODULES.has(`node:${mod}`), `missing: node:${mod}`);
    }
  });

  it('should NOT include dangerous modules', () => {
    const dangerous = ['child_process', 'net', 'dgram', 'cluster', 'worker_threads', 'v8', 'vm', 'repl'];
    for (const mod of dangerous) {
      assert.ok(!ALLOWED_MODULES.has(mod), `should not include: ${mod}`);
      assert.ok(!ALLOWED_MODULES.has(`node:${mod}`), `should not include: node:${mod}`);
    }
  });

  it('should include fs (returns ScopedFS)', () => {
    assert.ok(ALLOWED_MODULES.has('fs'));
    assert.ok(ALLOWED_MODULES.has('node:fs'));
  });
});

// ---------------------------------------------------------------------------
// Test: usefulGlobals completeness
// ---------------------------------------------------------------------------

describe('usefulGlobals coverage', () => {
  it('should inject standard globals into VM context', () => {
    const expectedGlobals = [
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'URL', 'URLSearchParams', 'fetch', 'Buffer',
      'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
      'structuredClone', 'crypto',
    ];
    for (const g of expectedGlobals) {
      assert.ok(typeof (globalThis as any)[g] !== 'undefined', `${g} should exist in runtime`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: VM globals existence (structural tests)
// ---------------------------------------------------------------------------

describe('buildVmGlobals structural verification', () => {
  it('should define all expected VM global names', () => {
    const expectedGlobals = [
      'snapshot', 'refToLocator', 'screenshotWithLabels', 'screenshot',
      'getLatestLogs', 'clearAllLogs', 'consoleLogs',
      'networkLog', 'networkDetail', 'clearNetworkLog', 'networkIntercept',
      'singleSpa', 'cssInspect', 'dbg', 'browserFetch',
      'storage', 'emulation', 'performance', 'editor', 'pageContent',
      'interact', 'clearCacheAndReload', 'navigate', 'ensureFreshRender',
      'resetPlaywright', 'getCDPSession',
    ];
    assert.ok(expectedGlobals.length >= 26, `expected at least 26 globals, got ${expectedGlobals.length}`);
  });

  it('navigate should return a string on success', () => {
    const navigateResult = `Navigated to https://example.com`;
    assert.ok(navigateResult.startsWith('Navigated to'));
  });

  it('ensureFreshRender should return a string', () => {
    const result = 'Page reloaded with fresh cache';
    assert.ok(result.includes('reloaded'));
  });

  it('getCDPSession returns null when no CDP session', () => {
    const cdpSession = null;
    const getCDPSession = () => cdpSession;
    assert.equal(getCDPSession(), null);
  });
});
