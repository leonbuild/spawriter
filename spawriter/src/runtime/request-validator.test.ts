import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RequestValidator } from './request-validator.js';

describe('RequestValidator', () => {
  let v: RequestValidator;

  beforeEach(() => {
    v = new RequestValidator({
      maxBodyBytes: 1000,
      maxCodeBytes: 500,
      minTimeoutMs: 100,
      maxTimeoutMs: 60000,
      maxResultTextBytes: 200,
      maxResultImageBytes: 1000,
      maxResultWireBytes: 1500,
    });
  });

  describe('validateSessionId (T64)', () => {
    it('accepts valid session IDs', () => {
      assert(v.validateSessionId('sw-abc123').valid);
      assert(v.validateSessionId('sw-a1b2c3d4e5f6').valid);
    });

    it('rejects empty', () => {
      assert(!v.validateSessionId('').valid);
      assert(!v.validateSessionId(null).valid);
      assert(!v.validateSessionId(undefined).valid);
    });

    it('rejects invalid format', () => {
      assert(!v.validateSessionId('invalid').valid);
      assert(!v.validateSessionId('sw-').valid);
      assert(!v.validateSessionId('sw-ABC').valid); // uppercase
      assert(!v.validateSessionId('pw-abc123').valid); // wrong prefix
    });
  });

  describe('validateTimeout (T48)', () => {
    it('accepts valid timeout', () => {
      assert(v.validateTimeout(5000).valid);
      assert(v.validateTimeout(100).valid);
      assert(v.validateTimeout(60000).valid);
    });

    it('accepts null/undefined (optional)', () => {
      assert(v.validateTimeout(null).valid);
      assert(v.validateTimeout(undefined).valid);
    });

    it('rejects below minimum', () => {
      const r = v.validateTimeout(50);
      assert(!r.valid);
      assert.equal(r.errorCode, 'INVALID_TIMEOUT');
    });

    it('rejects above maximum', () => {
      assert(!v.validateTimeout(120001).valid);
    });

    it('rejects non-finite', () => {
      assert(!v.validateTimeout(Infinity).valid);
      assert(!v.validateTimeout(NaN).valid);
      assert(!v.validateTimeout('5000').valid);
    });
  });

  describe('validateBodySize', () => {
    it('accepts within limit', () => {
      assert(v.validateBodySize(1000).valid);
    });

    it('rejects over limit', () => {
      assert(!v.validateBodySize(1001).valid);
    });
  });

  describe('validateCodeSize', () => {
    it('accepts within limit', () => {
      assert(v.validateCodeSize('a'.repeat(500)).valid);
    });

    it('rejects over limit', () => {
      assert(!v.validateCodeSize('a'.repeat(501)).valid);
    });
  });

  describe('validateResultSize', () => {
    it('accepts within limits', () => {
      assert(v.validateResultSize(100, 500).valid);
    });

    it('rejects text over limit', () => {
      assert(!v.validateResultSize(201).valid);
    });

    it('rejects image over limit', () => {
      assert(!v.validateResultSize(100, 1001).valid);
    });

    it('rejects total over wire limit', () => {
      assert(v.validateResultSize(200, 1000).valid); // 1200 < 1500 OK
      assert(!v.validateResultSize(200, 1000, 1501).valid === false); // need actual over-limit
      // Push total above 1500: textBytes=200, imageBytes=1000 => 1200 OK; use bigger
      const r = new RequestValidator({ maxResultTextBytes: 10000, maxResultImageBytes: 10000, maxResultWireBytes: 500 });
      assert(!r.validateResultSize(300, 300).valid); // 600 > 500
    });
  });

  describe('validateRequestId', () => {
    it('accepts valid request IDs', () => {
      assert(v.validateRequestId('req-abc-123').valid);
    });

    it('rejects empty', () => {
      assert(!v.validateRequestId('').valid);
    });

    it('rejects too long', () => {
      assert(!v.validateRequestId('x'.repeat(129)).valid);
    });
  });

  describe('validateExecuteRequest (T48)', () => {
    it('accepts valid request', () => {
      assert(v.validateExecuteRequest({
        sessionId: 'sw-abc123',
        code: 'page.url()',
        timeoutMs: 5000,
      }).valid);
    });

    it('rejects missing session', () => {
      assert(!v.validateExecuteRequest({ code: 'x' }).valid);
    });

    it('rejects empty code', () => {
      assert(!v.validateExecuteRequest({ sessionId: 'sw-abc123', code: '' }).valid);
    });

    it('rejects oversized code', () => {
      assert(!v.validateExecuteRequest({
        sessionId: 'sw-abc123',
        code: 'x'.repeat(501),
      }).valid);
    });

    it('rejects invalid timeout', () => {
      assert(!v.validateExecuteRequest({
        sessionId: 'sw-abc123',
        code: 'x',
        timeoutMs: 50,
      }).valid);
    });
  });

  describe('limits', () => {
    it('reports configured limits', () => {
      const lim = v.limits();
      assert.equal(lim.maxBodyBytes, 1000);
      assert.equal(lim.maxCodeBytes, 500);
    });
  });
});
