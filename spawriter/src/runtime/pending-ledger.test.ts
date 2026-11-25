import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PendingLedger } from './pending-ledger.js';

function makeCmd(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    clientId: 'pw-1',
    clientMessageId: 1,
    realSessionId: 'sess-1',
    sessionId: 'sw-1',
    leaseEpoch: 1,
    connectionEpoch: 1,
    transportEpoch: 1,
    executeEpoch: 1,
    method: 'Runtime.evaluate',
    ...overrides,
  };
}

describe('PendingLedger', () => {
  let ledger: PendingLedger;

  beforeEach(() => {
    ledger = new PendingLedger({ maxPerTab: 4, maxPerTransport: 8, criticalReserve: 2 });
  });

  describe('register and settle', () => {
    it('registers a command and returns relayId', () => {
      const id = ledger.register(makeCmd());
      assert(id !== null);
      assert(typeof id === 'number');
    });

    it('settles a command', () => {
      const id = ledger.register(makeCmd())!;
      ledger.markSent(id);
      const cmd = ledger.settle(id);
      assert(cmd);
      assert.equal(cmd.relayId, id);
      assert.equal(cmd.state, 'sent');
    });

    it('returns null for double settle', () => {
      const id = ledger.register(makeCmd())!;
      ledger.settle(id);
      const second = ledger.settle(id);
      assert.equal(second, null);
    });
  });

  describe('capacity (T07/T47)', () => {
    it('rejects when per-tab limit reached', () => {
      for (let i = 0; i < 2; i++) {
        assert(ledger.register(makeCmd({ requestId: `req-${i}` })) !== null);
      }
      // 4 max - 2 critical reserve = 2 for normal methods.
      const rejected = ledger.register(makeCmd({ requestId: 'req-2' }));
      assert.equal(rejected, null);
    });

    it('allows critical methods in reserve slots', () => {
      for (let i = 0; i < 2; i++) {
        ledger.register(makeCmd({ requestId: `req-${i}` }));
      }
      // Normal slots full, but critical should still work.
      const id = ledger.register(makeCmd({
        requestId: 'req-critical',
        method: 'Page.handleJavaScriptDialog',
      }));
      assert(id !== null);
    });

    it('rejects when transport limit reached', () => {
      for (let i = 0; i < 6; i++) {
        ledger.register(makeCmd({
          requestId: `req-${i}`,
          realSessionId: `sess-${i}`, // different tabs
        }));
      }
      // 8 max - 2 reserve = 6 for normal.
      const rejected = ledger.register(makeCmd({
        requestId: 'req-6',
        realSessionId: 'sess-6',
      }));
      assert.equal(rejected, null);
    });
  });

  describe('timeout (T06)', () => {
    it('expires commands past deadline', async () => {
      const id = ledger.register(makeCmd(), 10)!; // 10ms timeout
      await new Promise((r) => setTimeout(r, 20));
      const expired = ledger.checkTimeouts();
      assert.equal(expired.length, 1);
      assert.equal(expired[0].relayId, id);
    });

    it('creates tombstone for expired command', async () => {
      const id = ledger.register(makeCmd(), 10)!;
      await new Promise((r) => setTimeout(r, 20));
      ledger.checkTimeouts();
      // Late settle should return null and increment late counter.
      const result = ledger.settle(id);
      assert.equal(result, null);
      assert(ledger.diagnostics().stats.late >= 1);
    });
  });

  describe('cancel', () => {
    it('cancels all commands for a session', () => {
      ledger.register(makeCmd({ requestId: 'req-1', sessionId: 'sw-1' }));
      ledger.register(makeCmd({ requestId: 'req-2', sessionId: 'sw-1' }));
      ledger.register(makeCmd({ requestId: 'req-3', sessionId: 'sw-2', realSessionId: 'sess-2' }));

      const cancelled = ledger.cancelBySession('sw-1');
      assert.equal(cancelled.length, 2);
      assert.equal(ledger.diagnostics().pending, 1);
    });

    it('cancels all commands for a client', () => {
      ledger.register(makeCmd({ requestId: 'req-1', clientId: 'pw-1' }));
      ledger.register(makeCmd({ requestId: 'req-2', clientId: 'pw-2', realSessionId: 'sess-2' }));

      const cancelled = ledger.cancelByClient('pw-1');
      assert.equal(cancelled.length, 1);
      assert.equal(ledger.diagnostics().pending, 1);
    });
  });

  describe('epoch validation', () => {
    it('validates matching epochs', () => {
      const id = ledger.register(makeCmd())!;
      assert(ledger.validateEpochs(id, { connectionEpoch: 1, transportEpoch: 1, executeEpoch: 1 }));
    });

    it('rejects mismatched epoch', () => {
      const id = ledger.register(makeCmd())!;
      assert(!ledger.validateEpochs(id, { connectionEpoch: 2, transportEpoch: 1, executeEpoch: 1 }));
    });
  });

  describe('reset', () => {
    it('clears all pending and creates tombstones', () => {
      ledger.register(makeCmd({ requestId: 'req-1' }));
      ledger.register(makeCmd({ requestId: 'req-2', realSessionId: 'sess-2' }));
      ledger.reset();
      assert.equal(ledger.diagnostics().pending, 0);
      assert(ledger.diagnostics().tombstones >= 2);
    });
  });

  describe('diagnostics', () => {
    it('reports correct counts', () => {
      ledger.register(makeCmd());
      const diag = ledger.diagnostics();
      assert.equal(diag.pending, 1);
      assert.equal(diag.stats.sent, 1);
    });
  });
});
