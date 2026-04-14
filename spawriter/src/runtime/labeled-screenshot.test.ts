/**
 * Tests for runtime/labeled-screenshot.ts — image profile resolution
 * and screenshot capture with size guarantees.
 * Imports directly from production code.
 *
 * Run: npx tsx --test spawriter/src/runtime/labeled-screenshot.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveImageProfile,
  MAX_COMPRESS_RETRIES,
  captureWithSizeGuarantee,
  type CdpSender,
  type ImageProfile,
} from './labeled-screenshot.js';

// ---------------------------------------------------------------------------
// resolveImageProfile
// ---------------------------------------------------------------------------
describe('resolveImageProfile', () => {
  it('returns default profile for medium tier', () => {
    const p = resolveImageProfile('medium');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.maxLongEdge, 1568);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('returns high tier with PNG format', () => {
    const p = resolveImageProfile('high');
    assert.equal(p.format, 'png');
    assert.equal(p.quality, 100);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('returns low tier with small limit', () => {
    const p = resolveImageProfile('low');
    assert.equal(p.effectiveLimit, 1_000_000);
    assert.ok(p.quality <= 40);
  });

  it('resolves model hint to known profile', () => {
    const p = resolveImageProfile('medium', 'claude-opus-4.6');
    assert.equal(p.maxLongEdge, 1568);
    assert.equal(p.format, 'webp');
  });

  it('resolves partial model hint via substring', () => {
    const p = resolveImageProfile('medium', 'some-claude-opus-thing');
    assert.equal(p.format, 'webp');
  });

  it('uses tier limit when model maxBytes exceeds tier', () => {
    const p = resolveImageProfile('low', 'gpt-5.4');
    assert.equal(p.effectiveLimit, 1_000_000);
  });

  it('falls back to tier defaults for unknown model', () => {
    const p = resolveImageProfile('medium', 'unknown-model-xyz');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
  });

  it('falls back to medium for unknown tier', () => {
    const p = resolveImageProfile('bogus');
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('GPT models have larger maxLongEdge', () => {
    const p = resolveImageProfile('high', 'gpt-5.4');
    assert.ok(p.maxLongEdge >= 2048);
  });

  it('Gemini models have 1024 maxLongEdge', () => {
    const p = resolveImageProfile('medium', 'gemini-3');
    assert.equal(p.maxLongEdge, 1024);
  });
});

// ---------------------------------------------------------------------------
// MAX_COMPRESS_RETRIES
// ---------------------------------------------------------------------------
describe('MAX_COMPRESS_RETRIES', () => {
  it('is 3', () => {
    assert.equal(MAX_COMPRESS_RETRIES, 3);
  });
});

// ---------------------------------------------------------------------------
// captureWithSizeGuarantee
// ---------------------------------------------------------------------------
describe('captureWithSizeGuarantee', () => {
  function makeSender(sizeBytes: number): CdpSender {
    const base64Len = Math.ceil(sizeBytes * 4 / 3);
    const data = 'A'.repeat(base64Len);
    return async () => ({ data });
  }

  it('returns uncompressed when under limit', async () => {
    const sender = makeSender(1000);
    const profile = resolveImageProfile('medium');
    const result = await captureWithSizeGuarantee(sender, profile, 5000);
    assert.ok(!result.compressed);
    assert.equal(result.mimeType, 'image/webp');
  });

  it('compresses when over limit', async () => {
    let callCount = 0;
    const sender: CdpSender = async (_method, params) => {
      callCount++;
      if (callCount === 1) {
        return { data: 'A'.repeat(Math.ceil(10_000_000 * 4 / 3)) };
      }
      return { data: 'A'.repeat(100) };
    };
    const profile = resolveImageProfile('medium');
    const result = await captureWithSizeGuarantee(sender, profile, 5000);
    assert.ok(result.compressed);
    assert.equal(result.mimeType, 'image/webp');
    assert.ok(callCount >= 2);
  });

  it('retries up to MAX_COMPRESS_RETRIES then final fallback', async () => {
    let callCount = 0;
    const sender: CdpSender = async () => {
      callCount++;
      return { data: 'A'.repeat(Math.ceil(10_000_000 * 4 / 3)) };
    };
    const profile = resolveImageProfile('low');
    const result = await captureWithSizeGuarantee(sender, profile, 5000);
    // 1 initial + MAX_COMPRESS_RETRIES retries + 1 final fallback = 5
    assert.equal(callCount, 1 + MAX_COMPRESS_RETRIES + 1);
    assert.ok(result.compressed);
  });

  it('captures PNG format correctly', async () => {
    const sender: CdpSender = async (_method, params) => {
      assert.equal((params as any).format, 'png');
      return { data: 'AAAA' };
    };
    const profile = resolveImageProfile('high');
    const result = await captureWithSizeGuarantee(sender, profile, 5000);
    assert.equal(result.mimeType, 'image/png');
  });
});
