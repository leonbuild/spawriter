import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRE_VERSION,
  encodeEnvelope,
  decodeEnvelope,
  validateEnvelope,
  FlowControl,
  type WireEnvelope,
} from './wire-protocol.js';

describe('WireProtocol', () => {
  describe('encode/decode', () => {
    it('round-trips a valid envelope', () => {
      const env: WireEnvelope = {
        v: WIRE_VERSION,
        k: 'event',
        seq: 1,
        gen: 1,
        p: { method: 'Page.loadEventFired', params: {} },
      };
      const encoded = encodeEnvelope(env);
      const decoded = decodeEnvelope(encoded);
      assert(decoded);
      assert.equal(decoded.v, WIRE_VERSION);
      assert.equal(decoded.k, 'event');
      assert.equal(decoded.seq, 1);
    });

    it('rejects invalid JSON', () => {
      assert.equal(decodeEnvelope('not json'), null);
    });

    it('rejects wrong version', () => {
      const env = { v: 999, k: 'event', seq: 1, gen: 1, p: {} };
      assert.equal(decodeEnvelope(JSON.stringify(env)), null);
    });

    it('rejects missing fields', () => {
      assert.equal(decodeEnvelope(JSON.stringify({ v: WIRE_VERSION })), null);
    });
  });

  describe('validateEnvelope', () => {
    it('accepts valid envelope', () => {
      const env: WireEnvelope = { v: WIRE_VERSION, k: 'command', seq: 0, gen: 0, p: null };
      assert.equal(validateEnvelope(env), null);
    });

    it('rejects invalid kind', () => {
      const env = { v: WIRE_VERSION, k: 'bogus' as any, seq: 0, gen: 0, p: null };
      assert(validateEnvelope(env)?.includes('Unknown kind'));
    });

    it('rejects negative seq', () => {
      const env: WireEnvelope = { v: WIRE_VERSION, k: 'event', seq: -1, gen: 0, p: null };
      assert(validateEnvelope(env)?.includes('Invalid seq'));
    });
  });
});

describe('FlowControl', () => {
  let fc: FlowControl;

  beforeEach(() => {
    fc = new FlowControl({ initialCredit: 4, replenishThreshold: 2, maxOutstanding: 6 });
  });

  describe('sending', () => {
    it('allows sending within credit', () => {
      assert(fc.canSend());
      fc.recordSent();
      assert(fc.canSend());
    });

    it('blocks sending when credit exhausted', () => {
      for (let i = 0; i < 4; i++) fc.recordSent();
      assert(!fc.canSend());
    });

    it('blocks sending when max outstanding reached', () => {
      const big = new FlowControl({ initialCredit: 100, maxOutstanding: 3 });
      for (let i = 0; i < 3; i++) big.recordSent();
      assert(!big.canSend());
    });

    it('assigns sequential seq numbers', () => {
      assert.equal(fc.recordSent(), 1);
      assert.equal(fc.recordSent(), 2);
    });
  });

  describe('receiving', () => {
    it('tracks received messages', () => {
      const needsReplenish = fc.recordReceived(1);
      assert(!needsReplenish); // 4 - 1 = 3 > threshold 2
    });

    it('signals replenish when below threshold', () => {
      fc.recordReceived(1);
      fc.recordReceived(2);
      const needsReplenish = fc.recordReceived(3);
      assert(needsReplenish); // 4 - 3 = 1 <= threshold 2
    });
  });

  describe('credit management (T18/T19)', () => {
    it('replenishes credit', () => {
      fc.recordReceived(1);
      fc.recordReceived(2);
      fc.recordReceived(3);
      const amount = fc.calculateReplenish();
      assert.equal(amount, 3);
    });

    it('does not replenish below threshold', () => {
      fc.recordReceived(1);
      assert.equal(fc.calculateReplenish(), 0);
    });

    it('processes peer credit', () => {
      for (let i = 0; i < 4; i++) fc.recordSent();
      assert(!fc.canSend());
      fc.processCredit(2);
      assert(fc.canSend());
    });

    it('processes ack to reduce outstanding', () => {
      fc.recordSent(); // seq 1
      fc.recordSent(); // seq 2
      fc.processAck(1);
      assert.equal(fc.diagnostics().outstanding, 1);
    });
  });

  describe('reset', () => {
    it('restores initial state', () => {
      fc.recordSent();
      fc.recordReceived(1);
      fc.reset();
      const diag = fc.diagnostics();
      assert.equal(diag.sendCredit, 4);
      assert.equal(diag.outstanding, 0);
    });
  });
});
