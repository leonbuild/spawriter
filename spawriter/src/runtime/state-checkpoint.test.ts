import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateCheckpoint } from './state-checkpoint.js';

describe('StateCheckpoint', () => {
  let cp: StateCheckpoint;

  beforeEach(() => {
    cp = new StateCheckpoint({ maxKeys: 10, maxHistory: 3 });
  });

  describe('live state', () => {
    it('sets and gets values', () => {
      cp.set('x', 42);
      assert.equal(cp.get('x'), 42);
      assert(cp.has('x'));
    });

    it('deletes values', () => {
      cp.set('x', 42);
      assert(cp.delete('x'));
      assert(!cp.has('x'));
    });

    it('lists keys', () => {
      cp.set('a', 1);
      cp.set('b', 2);
      assert.deepEqual(cp.keys().sort(), ['a', 'b']);
    });

    it('rejects when at key limit', () => {
      for (let i = 0; i < 10; i++) cp.set(`k${i}`, i);
      assert.throws(() => cp.set('overflow', 0), /limit/);
    });

    it('toObject returns serializable keys', () => {
      cp.set('x', 42);
      cp.set('fn', () => {}); // non-serializable
      cp.commit(1); // marks fn as transient
      const obj = cp.toObject();
      assert.equal(obj.x, 42);
      assert.equal(obj.fn, undefined);
    });
  });

  describe('commit (T15/T48)', () => {
    it('commits the live state', () => {
      cp.set('x', 1);
      cp.set('y', 'hello');
      const result = cp.commit(1);
      assert(result);
      assert.equal(result.executeEpoch, 1);
      assert(result.byteSize > 0);
    });

    it('tracks transient keys', () => {
      cp.set('x', 1);
      cp.set('fn', () => {});
      const result = cp.commit(1);
      assert(result);
      assert(result.transientKeys.includes('fn'));
    });

    it('tracks oversized values', () => {
      const big = new StateCheckpoint({ maxValueByteSize: 10 });
      big.set('small', 'hi');
      big.set('large', 'x'.repeat(100));
      const result = big.commit(1);
      assert(result);
      assert(result.oversizedKeys.includes('large'));
    });

    it('returns null if total exceeds max byte size', () => {
      const tiny = new StateCheckpoint({ maxByteSize: 10 });
      tiny.set('x', 'very long string that exceeds the limit');
      assert.equal(tiny.commit(1), null);
    });

    it('limits history', () => {
      cp.set('x', 1); cp.commit(1);
      cp.set('x', 2); cp.commit(2);
      cp.set('x', 3); cp.commit(3);
      cp.set('x', 4); cp.commit(4);
      assert.equal(cp.checkpointCount, 3); // maxHistory = 3
    });
  });

  describe('rollback (T15/T48)', () => {
    it('restores last checkpoint', () => {
      cp.set('x', 1);
      cp.commit(1);
      cp.set('x', 999);
      cp.set('y', 'new');
      const restored = cp.rollback();
      assert(restored);
      assert.equal(cp.get('x'), 1);
      assert(!cp.has('y'));
    });

    it('returns null with no checkpoints', () => {
      assert.equal(cp.rollback(), null);
    });

    it('rollbackToEpoch finds correct checkpoint', () => {
      cp.set('x', 1); cp.commit(1);
      cp.set('x', 2); cp.commit(2);
      cp.set('x', 3); cp.commit(3);
      cp.set('x', 999);

      const restored = cp.rollbackToEpoch(2);
      assert(restored);
      assert.equal(restored.executeEpoch, 2);
      assert.equal(cp.get('x'), 2);
      assert.equal(cp.checkpointCount, 2); // trimmed history
    });

    it('rollbackToEpoch returns null for missing epoch', () => {
      cp.set('x', 1); cp.commit(5);
      assert.equal(cp.rollbackToEpoch(1), null); // no epoch <= 1
    });
  });

  describe('reset', () => {
    it('clears everything', () => {
      cp.set('x', 1);
      cp.commit(1);
      cp.reset();
      assert.equal(cp.keys().length, 0);
      assert.equal(cp.checkpointCount, 0);
    });
  });

  describe('diagnostics', () => {
    it('reports correct state', () => {
      cp.set('a', 1);
      cp.set('b', 2);
      cp.commit(1);
      const diag = cp.diagnostics();
      assert.equal(diag.liveKeys, 2);
      assert.equal(diag.checkpoints, 1);
      assert.equal(diag.lastEpoch, 1);
      assert(diag.totalBytes > 0);
    });
  });
});
