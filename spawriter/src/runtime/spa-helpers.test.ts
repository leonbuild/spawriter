/**
 * Tests for runtime/spa-helpers.ts — single-spa code generation utilities.
 * Imports directly from production code.
 *
 * Run: npx tsx --test spawriter/src/runtime/spa-helpers.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDashboardStateCode,
  buildOverrideCode,
  buildAppActionCode,
  type OverrideState,
  detectOverrideChanges,
  importPageOverrides,
} from './spa-helpers.js';

// ---------------------------------------------------------------------------
// buildDashboardStateCode
// ---------------------------------------------------------------------------
describe('buildDashboardStateCode', () => {
  it('generates code without appName', () => {
    const code = buildDashboardStateCode();
    assert.ok(code.includes('__SINGLE_SPA_DEVTOOLS__'));
    assert.ok(code.includes('importMapOverrides'));
    assert.ok(code.includes('(null)'));
  });

  it('generates code with appName', () => {
    const code = buildDashboardStateCode('my-app');
    assert.ok(code.includes('"my-app"'));
  });

  it('trims whitespace-only appName', () => {
    const code = buildDashboardStateCode('   ');
    assert.ok(code.includes('(null)'));
  });

  it('escapes special characters in appName', () => {
    const code = buildDashboardStateCode('@org/app"test');
    assert.ok(code.includes(JSON.stringify('@org/app"test')));
  });
});

// ---------------------------------------------------------------------------
// buildOverrideCode
// ---------------------------------------------------------------------------
describe('buildOverrideCode', () => {
  it('generates set code with appName and url', () => {
    const { code, error } = buildOverrideCode('set', 'my-app', 'http://localhost:8080/app.js');
    assert.ok(!error);
    assert.ok(code.includes('addOverride'));
    assert.ok(code.includes('"my-app"'));
    assert.ok(code.includes('http://localhost:8080/app.js'));
  });

  it('returns error for set without appName', () => {
    const { error } = buildOverrideCode('set', undefined, 'http://url');
    assert.ok(error);
    assert.ok(error!.includes('requires'));
  });

  it('returns error for set without url', () => {
    const { error } = buildOverrideCode('set', 'app', undefined);
    assert.ok(error);
  });

  it('generates remove code', () => {
    const { code, error } = buildOverrideCode('remove', 'my-app');
    assert.ok(!error);
    assert.ok(code.includes('removeOverride'));
  });

  it('returns error for remove without appName', () => {
    const { error } = buildOverrideCode('remove');
    assert.ok(error);
  });

  it('generates enable code', () => {
    const { code, error } = buildOverrideCode('enable', 'my-app');
    assert.ok(!error);
    assert.ok(code.includes('enableOverride'));
  });

  it('generates disable code', () => {
    const { code, error } = buildOverrideCode('disable', 'my-app');
    assert.ok(!error);
    assert.ok(code.includes('disableOverride'));
  });

  it('generates reset_all code', () => {
    const { code, error } = buildOverrideCode('reset_all');
    assert.ok(!error);
    assert.ok(code.includes('resetOverrides'));
  });

  it('returns error for unknown action', () => {
    const { error } = buildOverrideCode('bogus');
    assert.ok(error);
    assert.ok(error!.includes('unknown action'));
  });

  it('wraps in IIFE returning JSON', () => {
    const { code } = buildOverrideCode('reset_all');
    assert.ok(code.includes('JSON.stringify'));
    assert.ok(code.includes('(function()'));
  });
});

// ---------------------------------------------------------------------------
// buildAppActionCode
// ---------------------------------------------------------------------------
describe('buildAppActionCode', () => {
  it('generates mount code', () => {
    const code = buildAppActionCode('mount', 'my-app');
    assert.ok(code.includes('mount'));
    assert.ok(code.includes('"my-app"'));
    assert.ok(code.includes('activeWhenForced'));
    assert.ok(code.includes('reroute'));
  });

  it('generates unmount code', () => {
    const code = buildAppActionCode('unmount', 'my-app');
    assert.ok(code.includes('unmount'));
    assert.ok(code.includes('activeWhenForced'));
  });

  it('generates unload code', () => {
    const code = buildAppActionCode('unload', 'my-app');
    assert.ok(code.includes('unregisterApplication'));
  });

  it('wraps in async IIFE', () => {
    const code = buildAppActionCode('mount', 'test');
    assert.ok(code.includes('async function'));
  });

  it('includes error handling', () => {
    const code = buildAppActionCode('mount', 'test');
    assert.ok(code.includes('catch'));
    assert.ok(code.includes('JSON.stringify'));
  });

  it('returns updated status', () => {
    const code = buildAppActionCode('mount', 'test');
    assert.ok(code.includes('newStatus'));
    assert.ok(code.includes('getRawAppData'));
  });
});

// ---------------------------------------------------------------------------
// detectOverrideChanges
// ---------------------------------------------------------------------------
describe('detectOverrideChanges', () => {
  it('detects added overrides', () => {
    const page: OverrideState = { '@org/app': 'http://localhost:8080/app.js' };
    const saved: OverrideState = {};
    const { added, removed, changed } = detectOverrideChanges(page, saved);
    assert.deepEqual(added, ['@org/app']);
    assert.deepEqual(removed, []);
    assert.deepEqual(changed, []);
  });

  it('detects removed overrides', () => {
    const page: OverrideState = {};
    const saved: OverrideState = { '@org/app': 'http://localhost:8080/app.js' };
    const { added, removed, changed } = detectOverrideChanges(page, saved);
    assert.deepEqual(added, []);
    assert.deepEqual(removed, ['@org/app']);
    assert.deepEqual(changed, []);
  });

  it('detects changed overrides', () => {
    const page: OverrideState = { app: 'http://new-url' };
    const saved: OverrideState = { app: 'http://old-url' };
    const { added, removed, changed } = detectOverrideChanges(page, saved);
    assert.deepEqual(changed, ['app']);
  });

  it('handles identical states', () => {
    const state: OverrideState = { a: '1', b: '2' };
    const { added, removed, changed } = detectOverrideChanges(state, state);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(changed.length, 0);
  });

  it('handles empty states', () => {
    const { added, removed, changed } = detectOverrideChanges({}, {});
    assert.equal(added.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(changed.length, 0);
  });

  it('handles mixed additions, removals, and changes', () => {
    const page: OverrideState = { a: '1', b: 'new-b', c: '3' };
    const saved: OverrideState = { a: '1', b: 'old-b', d: '4' };
    const { added, removed, changed } = detectOverrideChanges(page, saved);
    assert.deepEqual(added, ['c']);
    assert.deepEqual(removed, ['d']);
    assert.deepEqual(changed, ['b']);
  });
});

// ---------------------------------------------------------------------------
// importPageOverrides
// ---------------------------------------------------------------------------
describe('importPageOverrides', () => {
  it('merges page overrides over saved', () => {
    const page: OverrideState = { a: '1' };
    const saved: OverrideState = { b: '2' };
    const result = importPageOverrides(page, saved);
    assert.deepEqual(result, { a: '1', b: '2' });
  });

  it('page overrides take precedence', () => {
    const page: OverrideState = { a: 'new' };
    const saved: OverrideState = { a: 'old' };
    assert.equal(importPageOverrides(page, saved).a, 'new');
  });

  it('empty page returns saved', () => {
    const saved: OverrideState = { x: '1' };
    assert.deepEqual(importPageOverrides({}, saved), { x: '1' });
  });

  it('empty saved returns page', () => {
    const page: OverrideState = { x: '1' };
    assert.deepEqual(importPageOverrides(page, {}), { x: '1' });
  });
});
