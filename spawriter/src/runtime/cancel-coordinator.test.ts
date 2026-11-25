import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CancelCoordinator } from './cancel-coordinator.js';

describe('CancelCoordinator', () => {
  let cc: CancelCoordinator;

  beforeEach(() => {
    cc = new CancelCoordinator({ phaseTimeoutMs: 100, totalGraceMs: 500, maxConcurrent: 4 });
  });

  describe('initiation (T09/T12)', () => {
    it('initiates a cancel operation', () => {
      const record = cc.initiate('r1', 'sw-1', 'user_cancel');
      assert(record);
      assert.equal(record.phase, 'revoke');
      assert.equal(record.reason, 'user_cancel');
      assert(record.revokeEpoch > 0);
    });

    it('returns existing record on duplicate initiation', () => {
      const r1 = cc.initiate('r1', 'sw-1', 'user_cancel');
      const r2 = cc.initiate('r1', 'sw-1', 'deadline');
      assert.equal(r1, r2);
    });

    it('rejects when at capacity', () => {
      for (let i = 0; i < 4; i++) cc.initiate(`r${i}`, 'sw-1', 'user_cancel');
      assert.equal(cc.initiate('r4', 'sw-1', 'user_cancel'), null);
    });

    it('tracks pending commands', () => {
      const record = cc.initiate('r1', 'sw-1', 'user_cancel', ['c1', 'c2']);
      assert(record);
      assert.deepEqual(record.pendingCommandIds, ['c1', 'c2']);
    });
  });

  describe('phase transitions (T12/T49)', () => {
    it('advances through phases: revoke → stop → cleanup → done', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      assert(cc.advance('r1')); // → stop
      assert.equal(cc.get('r1')?.phase, 'stop');
      assert(cc.advance('r1')); // → cleanup
      assert.equal(cc.get('r1')?.phase, 'cleanup');
      assert(cc.advance('r1')); // → done
      assert.equal(cc.get('r1')?.phase, 'done');
    });

    it('cannot advance past done', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      cc.advance('r1');
      cc.advance('r1');
      cc.advance('r1');
      assert(!cc.advance('r1'));
    });

    it('records transitions', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      cc.advance('r1');
      const record = cc.get('r1')!;
      assert.equal(record.transitions.length, 2);
      assert.equal(record.transitions[0].from, 'idle');
      assert.equal(record.transitions[0].to, 'revoke');
      assert.equal(record.transitions[1].from, 'revoke');
      assert.equal(record.transitions[1].to, 'stop');
    });
  });

  describe('quarantine', () => {
    it('forces quarantine from any active phase', () => {
      cc.initiate('r1', 'sw-1', 'deadline');
      assert(cc.quarantine('r1'));
      assert.equal(cc.get('r1')?.phase, 'quarantine');
    });

    it('cannot quarantine already done', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      cc.advance('r1'); cc.advance('r1'); cc.advance('r1');
      assert(!cc.quarantine('r1'));
    });
  });

  describe('scope watermark (T12/T61)', () => {
    it('blocks commands at or below revoke epoch', () => {
      const record = cc.initiate('r1', 'sw-1', 'user_cancel')!;
      assert(cc.isBlocked('r1', record.revokeEpoch));
      assert(cc.isBlocked('r1', record.revokeEpoch - 1));
    });

    it('does not block commands after revoke epoch', () => {
      const record = cc.initiate('r1', 'sw-1', 'user_cancel')!;
      assert(!cc.isBlocked('r1', record.revokeEpoch + 1));
    });
  });

  describe('command settling', () => {
    it('settles individual commands', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel', ['c1', 'c2', 'c3']);
      assert(!cc.allCommandsSettled('r1'));
      cc.settleCommand('r1', 'c1');
      cc.settleCommand('r1', 'c2');
      cc.settleCommand('r1', 'c3');
      assert(cc.allCommandsSettled('r1'));
    });
  });

  describe('timeout checks', () => {
    it('checkTimeouts quarantines expired total grace', () => {
      const cc2 = new CancelCoordinator({ phaseTimeoutMs: 0, totalGraceMs: 0 });
      cc2.initiate('r1', 'sw-1', 'deadline');
      const timedOut = cc2.checkTimeouts();
      assert(timedOut.length >= 1);
      assert.equal(timedOut[0].phase, 'quarantine');
    });
  });

  describe('isCancelling', () => {
    it('true during active cancel', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      assert(cc.isCancelling('r1'));
    });

    it('false when done', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      cc.advance('r1'); cc.advance('r1'); cc.advance('r1');
      assert(!cc.isCancelling('r1'));
    });
  });

  describe('remove and sweep', () => {
    it('removes only terminal records', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      assert.equal(cc.remove('r1'), undefined);
      cc.advance('r1'); cc.advance('r1'); cc.advance('r1');
      assert(cc.remove('r1'));
    });

    it('sweeps old terminal records', () => {
      const cc2 = new CancelCoordinator({ phaseTimeoutMs: 0, totalGraceMs: 0 });
      cc2.initiate('r1', 'sw-1', 'user_cancel');
      cc2.advance('r1'); cc2.advance('r1'); cc2.advance('r1');
      assert.equal(cc2.sweep(0), 1);
    });
  });

  describe('diagnostics', () => {
    it('reports phase breakdown', () => {
      cc.initiate('r1', 'sw-1', 'user_cancel');
      cc.initiate('r2', 'sw-1', 'deadline');
      cc.advance('r2'); cc.advance('r2'); cc.advance('r2');
      const diag = cc.diagnostics();
      assert.equal(diag.active, 2);
      assert.equal(diag.byPhase.revoke, 1);
      assert.equal(diag.byPhase.done, 1);
      assert.equal(diag.stats.initiated, 2);
    });
  });
});
