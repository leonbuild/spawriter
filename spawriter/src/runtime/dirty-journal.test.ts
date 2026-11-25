import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DirtyJournal } from './dirty-journal.js';

describe('DirtyJournal', () => {
  let journal: DirtyJournal;

  beforeEach(() => {
    journal = new DirtyJournal({ maxPerTarget: 8, maxTotal: 20, cleanReserve: 2 });
  });

  describe('recordRisk (T62)', () => {
    it('creates a risk record', () => {
      const record = journal.recordRisk('cmd-1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert(record);
      assert.equal(record.riskLevel, 'high');
      assert.equal(record.status, 'pending');
      assert(record.hasSideEffects);
    });

    it('classifies risk levels', () => {
      const high = journal.recordRisk('c1', 't1', 'sw-1', 1, 'Page.navigate');
      const med = journal.recordRisk('c2', 't1', 'sw-1', 1, 'Page.captureScreenshot');
      const low = journal.recordRisk('c3', 't1', 'sw-1', 1, 'Target.getTargetInfo');
      assert.equal(high?.riskLevel, 'high');
      assert.equal(med?.riskLevel, 'medium');
      assert.equal(low?.riskLevel, 'low');
    });

    it('returns existing on duplicate id', () => {
      const r1 = journal.recordRisk('cmd-1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      const r2 = journal.recordRisk('cmd-1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert.equal(r1, r2);
    });

    it('rejects at per-target limit (minus clean reserve)', () => {
      for (let i = 0; i < 6; i++) {
        journal.recordRisk(`c${i}`, 't1', 'sw-1', 1, 'Runtime.evaluate');
      }
      assert.equal(journal.recordRisk('overflow', 't1', 'sw-1', 1, 'Runtime.evaluate'), null);
    });

    it('clean methods can use reserve slots', () => {
      for (let i = 0; i < 6; i++) {
        journal.recordRisk(`c${i}`, 't1', 'sw-1', 1, 'Runtime.evaluate');
      }
      const clean = journal.recordRisk('clean1', 't1', 'sw-1', 1, 'Page.stopLoading');
      assert(clean);
    });
  });

  describe('confirm / fail', () => {
    it('confirms a pending record', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert(journal.confirm('c1'));
      assert.equal(journal.get('c1')?.status, 'confirmed');
    });

    it('fails a pending record', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert(journal.fail('c1'));
      assert.equal(journal.get('c1')?.status, 'failed');
    });

    it('does not re-confirm a resolved record', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.confirm('c1');
      assert(!journal.confirm('c1'));
    });
  });

  describe('isDirty (T62)', () => {
    it('clean target when all confirmed', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.confirm('c1');
      assert(!journal.isDirty('t1'));
    });

    it('dirty with pending records', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert(journal.isDirty('t1'));
    });

    it('dirty with failed records', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.fail('c1');
      assert(journal.isDirty('t1'));
    });
  });

  describe('markEpochUnknown', () => {
    it('marks pending records for epoch as unknown', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.recordRisk('c2', 't1', 'sw-1', 2, 'Runtime.evaluate');
      assert.equal(journal.markEpochUnknown('t1', 1), 1);
      assert.equal(journal.get('c1')?.status, 'unknown');
      assert.equal(journal.get('c2')?.status, 'pending');
    });
  });

  describe('markCleaned', () => {
    it('marks a record as cleaned', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.fail('c1');
      assert(journal.markCleaned('c1'));
      assert.equal(journal.get('c1')?.status, 'cleaned');
      assert(!journal.isDirty('t1'));
    });
  });

  describe('sweep', () => {
    it('sweeps old resolved records', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.confirm('c1');
      assert.equal(journal.sweep(0), 1);
    });

    it('does not sweep pending or unknown', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      assert.equal(journal.sweep(0), 0);
    });
  });

  describe('removeTarget', () => {
    it('removes all records for a target', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.recordRisk('c2', 't1', 'sw-1', 1, 'Page.navigate');
      assert.equal(journal.removeTarget('t1'), 2);
    });
  });

  describe('diagnostics', () => {
    it('reports breakdown', () => {
      journal.recordRisk('c1', 't1', 'sw-1', 1, 'Runtime.evaluate');
      journal.recordRisk('c2', 't1', 'sw-1', 1, 'Page.captureScreenshot');
      journal.confirm('c2');
      const diag = journal.diagnostics();
      assert.equal(diag.total, 2);
      assert.equal(diag.byStatus.pending, 1);
      assert.equal(diag.byStatus.confirmed, 1);
      assert.equal(diag.byRisk.high, 1);
      assert.equal(diag.byRisk.medium, 1);
    });
  });
});
