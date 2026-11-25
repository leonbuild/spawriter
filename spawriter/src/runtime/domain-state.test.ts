import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TabDomainState, type ExecutionContextInfo } from './domain-state.js';

function makeCtx(id: number, opts: { isDefault?: boolean; frameId?: string; type?: string } = {}): ExecutionContextInfo {
  return {
    id,
    origin: 'https://example.com',
    name: `ctx-${id}`,
    auxData: {
      isDefault: opts.isDefault ?? false,
      type: opts.type ?? 'default',
      frameId: opts.frameId ?? 'main',
    },
  };
}

describe('TabDomainState', () => {
  let state: TabDomainState;

  beforeEach(() => {
    state = new TabDomainState({ maxContextsPerTab: 10, maxFramesPerTab: 10, maxReplayBufferPerTab: 20 });
  });

  describe('context lifecycle', () => {
    it('creates and retrieves a context', () => {
      state.contextCreated(makeCtx(1), 100);
      assert.equal(state.getContext(1)?.name, 'ctx-1');
    });

    it('destroys a context', () => {
      state.contextCreated(makeCtx(1), 100);
      state.contextDestroyed(1, 200);
      assert.equal(state.getContext(1), undefined);
    });

    it('clears all contexts', () => {
      state.contextCreated(makeCtx(1), 100);
      state.contextCreated(makeCtx(2), 110);
      state.contextsCleared(200);
      assert.equal(state.getAllContexts().length, 0);
      assert.equal(state.documentGeneration, 1);
    });

    it('tracks document generation across navigations', () => {
      state.contextsCleared(100);
      state.contextsCleared(200);
      assert.equal(state.documentGeneration, 2);
    });

    it('evicts non-default context when at capacity', () => {
      for (let i = 0; i < 10; i++) {
        state.contextCreated(makeCtx(i, { isDefault: i === 0 }), i);
      }
      // Add one more — should evict a non-default.
      state.contextCreated(makeCtx(99), 100);
      assert.equal(state.getAllContexts().length, 10);
      // Default context should survive.
      assert(state.getContext(0) !== undefined);
    });

    it('finds default context', () => {
      state.contextCreated(makeCtx(1, { isDefault: false }), 100);
      state.contextCreated(makeCtx(2, { isDefault: true, type: 'default' }), 110);
      assert.equal(state.getDefaultContext()?.id, 2);
    });
  });

  describe('replay buffer', () => {
    it('records events', () => {
      state.contextCreated(makeCtx(1), 100);
      state.contextDestroyed(1, 200);
      const buf = state.getReplayBuffer();
      assert.equal(buf.length, 2);
      assert.equal(buf[0].kind, 'created');
      assert.equal(buf[1].kind, 'destroyed');
    });

    it('bounds the buffer size', () => {
      for (let i = 0; i < 25; i++) {
        state.contextCreated(makeCtx(i), i);
      }
      assert(state.getReplayBuffer().length <= 20);
    });

    it('clears on contextsCleared but adds the clear event', () => {
      state.contextCreated(makeCtx(1), 100);
      state.contextsCleared(200);
      const buf = state.getReplayBuffer();
      assert.equal(buf.length, 1);
      assert.equal(buf[0].kind, 'cleared');
    });
  });

  describe('snapshot', () => {
    it('starts not complete', () => {
      assert(!state.snapshotComplete);
    });

    it('marks snapshot complete', () => {
      state.markSnapshotComplete();
      assert(state.snapshotComplete);
    });

    it('resets snapshot on clear', () => {
      state.markSnapshotComplete();
      state.contextsCleared(100);
      assert(!state.snapshotComplete);
    });
  });

  describe('frame lifecycle', () => {
    it('attaches and detaches frames', () => {
      assert(state.frameAttached('f1', undefined, 100));
      assert.equal(state.getFrame('f1')?.id, 'f1');
      assert(state.frameDetached('f1'));
      assert.equal(state.getFrame('f1'), undefined);
    });

    it('handles duplicate frameAttached', () => {
      state.frameAttached('f1', undefined, 100);
      assert(!state.frameAttached('f1', undefined, 200));
    });

    it('tracks frame navigation', () => {
      state.frameAttached('f1', undefined, 100);
      state.frameNavigated('f1', 'https://example.com/page2', 200);
      assert.equal(state.getFrame('f1')?.url, 'https://example.com/page2');
    });

    it('bounds frame count', () => {
      for (let i = 0; i < 15; i++) {
        state.frameAttached(`f${i}`, undefined, i);
      }
      assert.equal(state.getAllFrames().length, 10);
    });
  });

  describe('frame tree loading', () => {
    it('loads snapshot frames', () => {
      state.loadFrameTree([
        { id: 'f1', url: 'https://a.com' },
        { id: 'f2', parentId: 'f1', url: 'https://b.com' },
      ], 100);
      assert.equal(state.getAllFrames().length, 2);
      assert(state.getFrame('f1')?.snapshotSeen);
    });

    it('updates existing frames from snapshot', () => {
      state.frameAttached('f1', undefined, 50);
      state.loadFrameTree([{ id: 'f1', url: 'https://updated.com' }], 100);
      assert.equal(state.getFrame('f1')?.url, 'https://updated.com');
      assert(state.getFrame('f1')?.snapshotSeen);
    });
  });

  describe('diagnostics', () => {
    it('reports correct counts', () => {
      state.contextCreated(makeCtx(1), 100);
      state.frameAttached('f1', undefined, 100);
      state.markSnapshotComplete();
      const d = state.diagnostics();
      assert.equal(d.contexts, 1);
      assert.equal(d.frames, 1);
      assert.equal(d.snapshotComplete, true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      state.contextCreated(makeCtx(1), 100);
      state.frameAttached('f1', undefined, 100);
      state.contextsCleared(200);
      state.reset();
      assert.equal(state.getAllContexts().length, 0);
      assert.equal(state.getAllFrames().length, 0);
      assert.equal(state.documentGeneration, 0);
    });
  });
});
