import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TabUiState } from './tab-ui-state.js';

/**
 * Helper: create a TabUiState with fake APIs and fast timers.
 */
function createTestState(overrides = {}) {
  const markerCalls = [];
  const persistCalls = [];
  const iconCalls = [];

  const state = new TabUiState(
    {
      applyMarker: async (tabId, prefix) => {
        markerCalls.push({ tabId, prefix });
        if (overrides.markerDelay) {
          await new Promise((r) => setTimeout(r, overrides.markerDelay));
        }
      },
      persistStorage: async (data) => {
        persistCalls.push(data);
      },
      renderIcons: (counts) => {
        iconCalls.push(counts);
      },
    },
    {
      coalesceMs: 10,
      iconBatchMs: 20,
      persistDebounceMs: 20,
      maxConcurrentMarkers: overrides.maxConcurrentMarkers ?? 5,
    },
  );

  return { state, markerCalls, persistCalls, iconCalls };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TabUiState', () => {
  /** @type {TabUiState | null} */
  let state;

  afterEach(() => {
    if (state) { state.dispose(); state = null; }
  });

  describe('coalescing (T04)', () => {
    it('coalesces rapid updates into a single flush', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connecting', attached: true, titlePrefix: '⏳' });
      state.update(1, { state: 'connected', owned: true, titlePrefix: '🟢' });
      state.update(1, { state: 'connected', owned: true, titlePrefix: '🟢' });

      await wait(50);

      // Only the last update should be committed.
      const snap = state.getSnapshot(1);
      assert.equal(snap.state, 'connected');
      assert.equal(snap.titlePrefix, '🟢');

      // Marker should be applied with the final prefix.
      assert(ctx.markerCalls.length >= 1);
      assert.equal(ctx.markerCalls[ctx.markerCalls.length - 1].prefix, '🟢');

      // Coalesced count should be > 0.
      assert(state.diagnostics().coalesced > 0);
    });
  });

  describe('icon batching', () => {
    it('batches icon updates across multiple tabs', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true, owned: true });
      state.update(2, { state: 'idle', attached: true });
      state.update(3, { state: 'connected', attached: true, owned: true });

      await wait(100);

      // Should have at most a couple of icon calls, not one per tab.
      assert(ctx.iconCalls.length >= 1 && ctx.iconCalls.length <= 3,
        `Expected 1-3 icon calls, got ${ctx.iconCalls.length}`);

      const last = ctx.iconCalls[ctx.iconCalls.length - 1];
      assert.equal(last.connected, 2);
      assert.equal(last.idle, 1);
    });
  });

  describe('persistence debouncing', () => {
    it('persists only non-idle states', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true });
      state.update(2, { state: 'idle', attached: false });
      state.update(3, { state: 'connecting', attached: true });

      await wait(100);

      assert(ctx.persistCalls.length >= 1);
      const last = ctx.persistCalls[ctx.persistCalls.length - 1];
      assert.equal(last[1], 'connected');
      assert.equal(last[3], 'connecting');
      assert.equal(last[2], undefined); // idle is excluded
    });
  });

  describe('title marker single-flight', () => {
    it('queues markers when concurrency is saturated', async () => {
      const ctx = createTestState({ maxConcurrentMarkers: 1, markerDelay: 30 });
      state = ctx.state;

      // Both trigger marker changes simultaneously.
      state.update(1, { titlePrefix: 'A' });
      state.update(2, { titlePrefix: 'B' });

      await wait(100);

      // Both markers should eventually be applied.
      const applied = new Set(ctx.markerCalls.map((c) => c.tabId));
      assert(applied.has(1), 'Tab 1 marker applied');
      assert(applied.has(2), 'Tab 2 marker applied');
    });

    it('re-applies when prefix changes during in-flight marker', async () => {
      const ctx = createTestState({ markerDelay: 30 });
      state = ctx.state;

      state.update(1, { titlePrefix: 'A' });

      await wait(15); // Marker is in-flight.

      // Queue a new prefix change.
      state.update(1, { titlePrefix: 'B' });

      await wait(100);

      // Should have applied both A and B.
      const tab1Calls = ctx.markerCalls.filter((c) => c.tabId === 1);
      assert(tab1Calls.length >= 2, 'Expected at least 2 marker applications');
      assert.equal(tab1Calls[tab1Calls.length - 1].prefix, 'B');
    });
  });

  describe('remove', () => {
    it('cleans all state for removed tab', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true });
      await wait(50);

      state.remove(1);
      const snap = state.getSnapshot(1);
      assert.equal(snap.state, 'idle');
      assert.equal(snap.attached, false);
    });
  });

  describe('getCounts', () => {
    it('reports 0 for empty state', () => {
      const ctx = createTestState();
      state = ctx.state;

      const counts = state.getCounts();
      assert.equal(counts.connected, 0);
      assert.equal(counts.idle, 0);
    });

    it('counts after committed updates', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true, owned: true });
      state.update(2, { state: 'idle', attached: true });
      state.update(3, { state: 'connecting', attached: true });

      await wait(50);

      const counts = state.getCounts();
      assert.equal(counts.connected, 1);
      assert.equal(counts.idle, 1);
    });
  });

  describe('no-op for same values (T04)', () => {
    it('does not trigger icon update for unchanged state', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true, owned: true });
      await wait(50);

      const beforeIcons = ctx.iconCalls.length;
      const beforePersist = ctx.persistCalls.length;

      // Same update again.
      state.update(1, { state: 'connected', attached: true, owned: true });
      await wait(50);

      // No new icon calls or persist calls.
      assert.equal(ctx.iconCalls.length, beforeIcons, 'No new icon calls');
      assert.equal(ctx.persistCalls.length, beforePersist, 'No new persist calls');
    });
  });

  describe('flushAll', () => {
    it('flushes all pending updates synchronously', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true });
      state.update(2, { state: 'connected', attached: true });

      // Don't wait — flush immediately.
      state.flushAll();

      assert.equal(state.getSnapshot(1).state, 'connected');
      assert.equal(state.getSnapshot(2).state, 'connected');
    });
  });

  describe('diagnostics', () => {
    it('reports cumulative stats', async () => {
      const ctx = createTestState();
      state = ctx.state;

      state.update(1, { state: 'connected', attached: true });
      state.update(1, { state: 'idle', attached: true });
      await wait(50);

      const diag = state.diagnostics();
      assert.equal(diag.tabs, 1);
      assert.equal(diag.updates, 2);
      assert(diag.coalesced >= 0);
    });
  });

  describe('30-tab stability (T04/T43 partial)', () => {
    it('handles 30 tabs without excessive API calls', async () => {
      const ctx = createTestState();
      state = ctx.state;

      for (let i = 1; i <= 30; i++) {
        state.update(i, { state: 'connected', attached: true, owned: true, titlePrefix: `T${i}` });
      }

      await wait(100);

      // All 30 tabs committed.
      assert.equal(state.diagnostics().tabs, 30);

      // Icon batching should mean far fewer icon calls than 30.
      assert(ctx.iconCalls.length < 15, `Expected < 15 icon calls, got ${ctx.iconCalls.length}`);

      // Persist calls should be few.
      assert(ctx.persistCalls.length < 15, `Expected < 15 persist calls, got ${ctx.persistCalls.length}`);
    });
  });
});
