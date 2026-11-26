import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runG0S, runG1Arch, runG0, runG1, runG2, runG3, runG4, runGates } from './gate-runner.js';

describe('Gate Runner', () => {
  it('G0-S passes with default config', () => {
    const r = runG0S();
    assert.equal(r.gate, 'G0-S');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 2);
    assert.equal(r.failed, 0);
  });

  it('G-1 passes with evidence file present', () => {
    const r = runG1Arch();
    assert.equal(r.gate, 'G-1');
    // Will be PASS if evidence file exists, BLOCKED otherwise.
    assert(['PASS', 'BLOCKED'].includes(r.status));
  });

  it('G0 passes with frozen config', () => {
    const r = runG0();
    assert.equal(r.gate, 'G0');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 2);
  });

  it('G1 console/transport gate passes', () => {
    const r = runG1();
    assert.equal(r.gate, 'G1');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 3);
  });

  it('G2 execution/admission gate passes', () => {
    const r = runG2();
    assert.equal(r.gate, 'G2');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 3);
  });

  it('G3 ownership/navigation gate passes', () => {
    const r = runG3();
    assert.equal(r.gate, 'G3');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 3);
  });

  it('G4 health/diagnostics gate passes', () => {
    const r = runG4();
    assert.equal(r.gate, 'G4');
    assert.equal(r.status, 'PASS');
    assert(r.passed >= 3);
  });

  it('G5-G8 pass from evidence or BLOCKED', () => {
    const report = runGates(['G5', 'G6', 'G7', 'G8']);
    for (const g of report.gates) {
      assert(['PASS', 'BLOCKED'].includes(g.status), `${g.gate}: unexpected ${g.status}`);
    }
  });

  it('full gate report has correct structure', () => {
    const report = runGates(['G0-S', 'G0']);
    assert(report.timestamp);
    assert(report.freezeDate);
    assert(report.freezeSha);
    assert(report.node);
    assert(report.os);
    assert.equal(report.gates.length, 2);
    assert(['PASS', 'FAIL', 'BLOCKED'].includes(report.overallStatus));
  });

  it('reports NOT_RUN for unknown gate', () => {
    const report = runGates(['G99']);
    assert.equal(report.gates[0].status, 'NOT_RUN');
  });
});
