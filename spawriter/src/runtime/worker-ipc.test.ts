import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerIpcCodec, type WorkerMessage, type ResultPayload } from './worker-ipc.js';

describe('WorkerIpcCodec', () => {
  let codec: WorkerIpcCodec;

  beforeEach(() => {
    codec = new WorkerIpcCodec({
      maxMessageBytes: 1000,
      maxStateBytes: 200,
      maxResultTextBytes: 100,
      maxOutputLines: 5,
    });
  });

  describe('encode/decode', () => {
    it('round-trips a valid message', () => {
      const msg: WorkerMessage = {
        kind: 'execute',
        id: 'req-1',
        sessionId: 'sw-abc',
        executeEpoch: 1,
        payload: { code: 'page.url()' },
      };
      const encoded = codec.encode(msg);
      assert(encoded);
      const decoded = codec.decode(encoded);
      assert(decoded);
      assert.equal(decoded.kind, 'execute');
      assert.equal(decoded.id, 'req-1');
    });

    it('rejects oversized encode', () => {
      const msg: WorkerMessage = {
        kind: 'execute',
        id: 'req-1',
        sessionId: 'sw-abc',
        executeEpoch: 1,
        payload: { code: 'x'.repeat(2000) },
      };
      assert.equal(codec.encode(msg), null);
    });

    it('rejects oversized decode', () => {
      assert.equal(codec.decode('x'.repeat(1001)), null);
    });

    it('rejects invalid JSON', () => {
      assert.equal(codec.decode('not json'), null);
    });

    it('rejects invalid structure', () => {
      assert.equal(codec.decode(JSON.stringify({ kind: 'execute' })), null); // missing fields
    });
  });

  describe('isValidStructure', () => {
    it('requires kind, id, sessionId, executeEpoch', () => {
      assert(!codec.isValidStructure(null));
      assert(!codec.isValidStructure({}));
      assert(!codec.isValidStructure({ kind: 'x' }));
      assert(codec.isValidStructure({ kind: 'x', id: 'r1', sessionId: 'sw-1', executeEpoch: 1, payload: null }));
    });
  });

  describe('validateStateSize (T73)', () => {
    it('accepts within limit', () => {
      assert(codec.validateStateSize({ x: 1 }));
    });

    it('rejects oversized state', () => {
      assert(!codec.validateStateSize({ data: 'x'.repeat(300) }));
    });
  });

  describe('validateResult (T73)', () => {
    it('accepts valid result', () => {
      const result: ResultPayload = {
        requestId: 'r1',
        success: true,
        value: 'hello',
        outputLines: ['line 1'],
      };
      assert(codec.validateResult(result).valid);
    });

    it('rejects too many output lines', () => {
      const result: ResultPayload = {
        requestId: 'r1',
        success: true,
        outputLines: Array(6).fill('line'),
      };
      assert(!codec.validateResult(result).valid);
    });

    it('rejects oversized value', () => {
      const result: ResultPayload = {
        requestId: 'r1',
        success: true,
        value: 'x'.repeat(200),
      };
      assert(!codec.validateResult(result).valid);
    });

    it('rejects unserializable value', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result: ResultPayload = {
        requestId: 'r1',
        success: true,
        value: circular,
      };
      assert(!codec.validateResult(result).valid);
    });
  });

  describe('buildMessage', () => {
    it('constructs a message', () => {
      const msg = codec.buildMessage('ready', 'r1', 'sw-1', 1, null);
      assert.equal(msg.kind, 'ready');
      assert.equal(msg.sessionId, 'sw-1');
    });
  });
});
