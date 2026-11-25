import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, SignatureMap, consoleSignature } from './token-bucket.js';
import { monoNowMs } from './execution-context.js';

describe('TokenBucket', () => {
  it('allows burst up to capacity', () => {
    const bucket = new TokenBucket({ rate: 100, burst: 200 });
    let consumed = 0;
    const now = monoNowMs();
    for (let i = 0; i < 300; i++) {
      if (bucket.tryConsume(now)) consumed++;
    }
    assert.equal(consumed, 200); // burst capacity
  });

  it('refills over time', () => {
    const bucket = new TokenBucket({ rate: 1000, burst: 10 });
    const t0 = monoNowMs();
    // Drain all tokens
    for (let i = 0; i < 20; i++) bucket.tryConsume(t0);
    assert.equal(bucket.available(t0), 0);
    // After 100ms at 1000/s = 100 tokens, capped at burst 10
    assert(bucket.available(t0 + 100) > 0);
  });

  it('rejects invalid rate', () => {
    assert.throws(() => new TokenBucket({ rate: 0, burst: 10 }), RangeError);
    assert.throws(() => new TokenBucket({ rate: -1, burst: 10 }), RangeError);
    assert.throws(() => new TokenBucket({ rate: NaN, burst: 10 }), RangeError);
  });

  it('rejects invalid burst', () => {
    assert.throws(() => new TokenBucket({ rate: 100, burst: 0 }), RangeError);
    assert.throws(() => new TokenBucket({ rate: 100, burst: NaN }), RangeError);
  });

  it('available never exceeds burst', () => {
    const bucket = new TokenBucket({ rate: 100, burst: 50 });
    // After a long time, tokens should cap at burst
    const farFuture = monoNowMs() + 100_000;
    assert(bucket.available(farFuture) <= 50);
  });
});

describe('consoleSignature', () => {
  it('produces consistent signatures', () => {
    const sig1 = consoleSignature('warning', 'some text', 'frame.js:10', 1);
    const sig2 = consoleSignature('warning', 'some text', 'frame.js:10', 1);
    assert.equal(sig1, sig2);
  });

  it('distinguishes different types', () => {
    const sig1 = consoleSignature('warning', 'text', 'f', 1);
    const sig2 = consoleSignature('error', 'text', 'f', 1);
    assert.notEqual(sig1, sig2);
  });

  it('truncates long text', () => {
    const longText = 'x'.repeat(1000);
    const sig = consoleSignature('log', longText, undefined, undefined);
    assert(sig.length < 1000); // text truncated to 200
  });

  it('handles undefined fields', () => {
    const sig = consoleSignature('log', undefined, undefined, undefined);
    assert.equal(typeof sig, 'string');
    assert(sig.includes('log'));
  });
});

describe('SignatureMap', () => {
  it('tracks first occurrence', () => {
    const map = new SignatureMap(100, 60_000);
    const now = monoNowMs();
    const result = map.hit('sig1', now);
    assert.equal(result, null); // first occurrence
    assert.equal(map.size, 1);
  });

  it('counts subsequent hits', () => {
    const map = new SignatureMap(100, 60_000);
    const now = monoNowMs();
    map.hit('sig1', now);
    const second = map.hit('sig1', now + 10);
    assert.notEqual(second, null);
    assert.equal(second!.count, 2);

    const third = map.hit('sig1', now + 20);
    assert.equal(third!.count, 3);
  });

  it('evicts oldest when at capacity', () => {
    const map = new SignatureMap(3, 60_000);
    const now = monoNowMs();
    map.hit('a', now);
    map.hit('b', now + 1);
    map.hit('c', now + 2);
    assert.equal(map.size, 3);

    map.hit('d', now + 3); // should evict 'a'
    assert.equal(map.size, 3);
    assert.equal(map.evictions, 1);

    // 'a' should be treated as new
    const aAgain = map.hit('a', now + 4);
    assert.equal(aAgain, null);
  });

  it('evicts expired entries', () => {
    const map = new SignatureMap(100, 100); // 100ms TTL
    const now = monoNowMs();
    map.hit('old', now);
    map.hit('new', now + 200); // 200ms later, 'old' expired
    assert.equal(map.size, 1); // only 'new' remains
  });

  it('handles 10,000 unique signatures within capacity', () => {
    const map = new SignatureMap(10_000, 60_000);
    const now = monoNowMs();
    for (let i = 0; i < 10_000; i++) {
      map.hit(`sig-${i}`, now);
    }
    assert.equal(map.size, 10_000);
    assert.equal(map.evictions, 0);
  });

  it('clear resets state', () => {
    const map = new SignatureMap(100, 60_000);
    map.hit('a', monoNowMs());
    map.hit('b', monoNowMs());
    map.clear();
    assert.equal(map.size, 0);
  });
});
