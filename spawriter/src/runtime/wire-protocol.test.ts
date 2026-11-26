import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRE_VERSION,
  encodeEnvelope,
  decodeEnvelope,
  validateEnvelope,
  FlowControl,
  HandshakeManager,
  GOLDEN_VECTORS,
  type WireEnvelope,
  type HelloMessage,
  type WelcomeMessage,
  type RejectMessage,
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

describe('HandshakeManager', () => {
  it('creates HELLO message', () => {
    const mgr = new HandshakeManager();
    const hello = mgr.createHello();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.version, 2);
    assert(hello.challenge.startsWith('ch-'));
    assert(hello.capabilities.includes('v2-flow'));
    assert.equal(mgr.getState(), 'hello_sent');
  });

  it('server processes HELLO and returns WELCOME', () => {
    const server = new HandshakeManager({ instanceId: 'srv-1' });
    const hello: HelloMessage = {
      type: 'hello', version: 2,
      challenge: 'test-ch', capabilities: ['v2-flow', 'v2-fence'],
    };
    const response = server.processHello(hello);
    assert.equal(response.type, 'welcome');
    assert.equal(server.getState(), 'established');
    const welcome = response as WelcomeMessage;
    assert.equal(welcome.proof, 'proof-test-ch');
    assert(welcome.features.includes('v2-flow'));
    assert.equal(welcome.instanceId, 'srv-1');
  });

  it('server rejects wrong version HELLO', () => {
    const server = new HandshakeManager();
    const hello: HelloMessage = {
      type: 'hello', version: 99,
      challenge: 'ch-wrong', capabilities: [],
    };
    const response = server.processHello(hello);
    assert.equal(response.type, 'reject');
    assert.equal(server.getState(), 'rejected');
    assert.equal((response as RejectMessage).code, 'VERSION_MISMATCH');
  });

  it('client validates WELCOME proof', () => {
    const client = new HandshakeManager();
    const hello = client.createHello();

    const server = new HandshakeManager();
    const welcome = server.processHello(hello) as WelcomeMessage;

    const accepted = client.processWelcome(welcome);
    assert.equal(accepted, true);
    assert.equal(client.getState(), 'established');
  });

  it('client rejects bad proof', () => {
    const client = new HandshakeManager();
    client.createHello();

    const fakeWelcome: WelcomeMessage = {
      type: 'welcome', version: 2, proof: 'wrong-proof',
      telemetryCredit: 256000, criticalCredit: 512000, features: [],
    };
    const accepted = client.processWelcome(fakeWelcome);
    assert.equal(accepted, false);
  });

  it('reset returns to idle', () => {
    const mgr = new HandshakeManager();
    mgr.createHello();
    assert.equal(mgr.getState(), 'hello_sent');
    mgr.reset();
    assert.equal(mgr.getState(), 'idle');
  });

  it('diagnostics returns config', () => {
    const mgr = new HandshakeManager({ buildId: 'test-123' });
    const diag = mgr.diagnostics();
    assert.equal(diag.state, 'idle');
    assert.equal(diag.buildId, 'test-123');
    assert.equal(diag.version, 2);
  });
});

describe('Golden Vectors (§16.7.5)', () => {
  it('validHello produces WELCOME', () => {
    const server = new HandshakeManager();
    const result = server.processHello(GOLDEN_VECTORS.validHello.input);
    assert.equal(result.type, 'welcome');
  });

  it('wrongVersion produces REJECT', () => {
    const server = new HandshakeManager();
    const result = server.processHello(GOLDEN_VECTORS.wrongVersion.input);
    assert.equal(result.type, 'reject');
    assert.equal((result as RejectMessage).code, 'VERSION_MISMATCH');
  });

  it('validEnvelope decodes successfully', () => {
    const decoded = decodeEnvelope(GOLDEN_VECTORS.validEnvelope.input);
    assert.notEqual(decoded, null);
    assert.equal(decoded!.v, 2);
    assert.equal(decoded!.k, 'control');
  });

  it('invalidVersion fails to decode', () => {
    const decoded = decodeEnvelope(GOLDEN_VECTORS.invalidVersion.input);
    assert.equal(decoded, null);
  });

  it('seqGap is detectable', () => {
    const frames = GOLDEN_VECTORS.seqGap.frames;
    assert.equal(frames[0].seq, 1);
    assert.equal(frames[1].seq, 5);
    assert(frames[1].seq - frames[0].seq > 1, 'Gap should be detectable');
  });

  it('fenceWithRetire has correct structure', () => {
    const fence = GOLDEN_VECTORS.fenceWithRetire.input;
    assert.equal(fence.type, 'fence');
    assert.equal(fence.generation, 5);
    assert.equal(fence.retireGen, 4);
  });
});
