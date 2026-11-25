import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DebuggerLifecycle } from './debugger-lifecycle.js';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createFakeChrome(opts = {}) {
  const calls = [];
  return {
    calls,
    attach: async ({ tabId }, version) => {
      calls.push({ type: 'attach', tabId, version });
      if (opts.attachDelay) await wait(opts.attachDelay);
      if (opts.attachError) throw new Error(opts.attachError);
    },
    detach: async ({ tabId }) => {
      calls.push({ type: 'detach', tabId });
      if (opts.detachDelay) await wait(opts.detachDelay);
    },
    sendCommand: async ({ tabId }, method, params) => {
      calls.push({ type: 'sendCommand', tabId, method, params });
      if (opts.commandDelay) await wait(opts.commandDelay);
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: `frame-${tabId}` } } };
      }
      return {};
    },
    getTargets: async () => [],
  };
}

describe('DebuggerLifecycle', () => {
  /** @type {DebuggerLifecycle | null} */
  let lifecycle;

  afterEach(() => {
    if (lifecycle) { lifecycle.dispose(); lifecycle = null; }
  });

  describe('attach', () => {
    it('attaches and initializes domains', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      const info = await lifecycle.attach(1);
      assert.equal(info.state, 'ready');
      assert.equal(info.tabId, 1);
      assert(info.sessionId?.startsWith('spawriter-tab-1-'));
      assert.equal(info.targetId, 'frame-1');

      const methods = chrome.calls.filter((c) => c.type === 'sendCommand').map((c) => c.method);
      assert(methods.includes('Page.enable'));
      assert(methods.includes('Runtime.enable'));
      assert(methods.includes('Network.enable'));
      assert(methods.includes('Page.getFrameTree'));
    });

    it('single-flights concurrent attaches', async () => {
      const chrome = createFakeChrome({ attachDelay: 20 });
      lifecycle = new DebuggerLifecycle(chrome);

      const [r1, r2] = await Promise.all([
        lifecycle.attach(1),
        lifecycle.attach(1),
      ]);

      // Both should return the same result.
      assert.equal(r1.tabId, r2.tabId);
      assert.equal(r1.sessionId, r2.sessionId);

      // Only one attach call should have been made.
      const attachCalls = chrome.calls.filter((c) => c.type === 'attach');
      assert.equal(attachCalls.length, 1);
    });

    it('returns cached info if already attached', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      const info = await lifecycle.attach(1);
      assert.equal(info.state, 'ready');

      // Only one attach call.
      const attachCalls = chrome.calls.filter((c) => c.type === 'attach');
      assert.equal(attachCalls.length, 1);
    });

    it('handles attach error', async () => {
      const chrome = createFakeChrome({ attachError: 'Permission denied' });
      lifecycle = new DebuggerLifecycle(chrome);

      await assert.rejects(() => lifecycle.attach(1), /Permission denied/);
      assert.equal(lifecycle.getInfo(1)?.state, 'error');
    });
  });

  describe('detach', () => {
    it('detaches and cleans up', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      await lifecycle.detach(1);

      assert.equal(lifecycle.getInfo(1), undefined);
      assert(!lifecycle.isAttached(1));
    });

    it('no-op for unattached tab', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.detach(42); // should not throw
    });
  });

  describe('sendCommand', () => {
    it('sends a command to an attached tab', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      const result = await lifecycle.sendCommand(1, 'Runtime.evaluate', { expression: '1+1' });
      assert.deepEqual(result, {});
    });

    it('rejects command to unattached tab', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await assert.rejects(() => lifecycle.sendCommand(99, 'Page.reload'), /not attached/);
    });

    it('rejects when pending commands at limit', async () => {
      const chrome = createFakeChrome({ commandDelay: 50 });
      lifecycle = new DebuggerLifecycle(chrome, { maxPendingCommands: 2 });

      await lifecycle.attach(1);

      // Fire 2 concurrent commands (at limit).
      const p1 = lifecycle.sendCommand(1, 'Runtime.evaluate');
      const p2 = lifecycle.sendCommand(1, 'Runtime.evaluate');

      // Third should be rejected.
      await assert.rejects(() => lifecycle.sendCommand(1, 'Runtime.evaluate'), /max pending/);

      await Promise.all([p1, p2]);
    });
  });

  describe('isAttached', () => {
    it('returns true for attached tab', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      assert(lifecycle.isAttached(1));
    });

    it('returns false for unknown tab', () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);
      assert(!lifecycle.isAttached(99));
    });
  });

  describe('removeTab', () => {
    it('removes all state for a tab', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      lifecycle.removeTab(1);
      assert.equal(lifecycle.getInfo(1), undefined);
    });
  });

  describe('diagnostics', () => {
    it('reports cumulative stats', async () => {
      const chrome = createFakeChrome();
      lifecycle = new DebuggerLifecycle(chrome);

      await lifecycle.attach(1);
      await lifecycle.sendCommand(1, 'Page.reload');
      await lifecycle.detach(1);

      const diag = lifecycle.diagnostics();
      assert.equal(diag.attaches, 1);
      assert.equal(diag.detaches, 1);
      // commandsSent counts only public sendCommand calls, not internal domain init.
      assert(diag.commandsSent >= 1, `Expected at least 1 command sent, got ${diag.commandsSent}`);
    });
  });
});
