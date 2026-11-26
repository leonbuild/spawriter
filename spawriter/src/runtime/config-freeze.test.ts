import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FROZEN_DEFAULTS,
  FREEZE_DATE,
  FREEZE_BUILD_SHA,
  validateAgainstFreeze,
  loadAndValidateConfig,
} from './config-freeze.js';
import { loadConfig, type StabilityConfig } from './config.js';

describe('W00b Config Freeze', () => {
  it('frozen defaults are immutable', () => {
    assert.throws(() => {
      (FROZEN_DEFAULTS as any).execTimeoutMs = 999;
    });
  });

  it('freeze metadata is set', () => {
    assert.equal(FREEZE_DATE, '2026-11-26');
    assert(FREEZE_BUILD_SHA.length > 10);
  });

  it('default config matches frozen defaults', () => {
    const config = loadConfig();
    for (const [key, frozenVal] of Object.entries(FROZEN_DEFAULTS)) {
      const actual = config[key as keyof StabilityConfig];
      assert.equal(
        actual,
        frozenVal,
        `${key}: expected ${frozenVal}, got ${actual}`,
      );
    }
  });

  it('no violations with default config', () => {
    const config = loadConfig();
    const violations = validateAgainstFreeze(config);
    assert.equal(violations.length, 0, `Unexpected violations: ${JSON.stringify(violations)}`);
  });

  it('detects hard field relaxation', () => {
    const config = { ...loadConfig(), sessionMax: 999 };
    const violations = validateAgainstFreeze(config);
    assert(violations.length > 0);
    assert(violations.some(v => v.field === 'sessionMax'));
  });

  it('detects task model change', () => {
    const config = { ...loadConfig(), taskModel: 'per-session' as const };
    const violations = validateAgainstFreeze(config);
    assert(violations.length > 0);
    assert(violations.some(v => v.field === 'taskModel'));
  });

  it('allows tightening (lower values)', () => {
    const config = { ...loadConfig(), sessionMax: 32 };
    const violations = validateAgainstFreeze(config);
    assert.equal(violations.length, 0);
  });

  it('loadAndValidateConfig succeeds with defaults', () => {
    const config = loadAndValidateConfig();
    assert(config.execTimeoutMs > 0);
    assert.equal(config.taskModel, 'per-execute');
  });

  it('loadAndValidateConfig throws on violation', () => {
    const original = process.env.SSPA_SESSION_MAX;
    try {
      process.env.SSPA_SESSION_MAX = '999';
      assert.throws(() => loadAndValidateConfig(), /freeze violation/i);
    } finally {
      if (original === undefined) delete process.env.SSPA_SESSION_MAX;
      else process.env.SSPA_SESSION_MAX = original;
    }
  });

  it('all frozen fields have positive finite values', () => {
    for (const [key, val] of Object.entries(FROZEN_DEFAULTS)) {
      if (typeof val === 'number') {
        assert(Number.isFinite(val), `${key} is not finite`);
        assert(val >= 0, `${key} is negative`);
      }
    }
  });
});
