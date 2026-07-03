/**
 * Tests for ScopedFS path scoping, including re-scoping via configure() which
 * backs the relay's per-request cwd threading (screenshots must land in the
 * caller's project, not the relay's spawn dir).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScopedFS } from './scoped-fs.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('ScopedFS scoping', () => {
  let dirA: string;
  let dirB: string;

  before(() => {
    dirA = makeTempDir('sfs-a-');
    dirB = makeTempDir('sfs-b-');
  });

  after(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('allows writes inside the scoped base dir', () => {
    const sfs = new ScopedFS([dirA, os.tmpdir()], dirA);
    const target = path.join(dirA, 'ok.txt');
    sfs.writeFileSync(target, 'hello');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  });

  it('blocks writes outside the allowed dirs with EPERM', () => {
    const sfs = new ScopedFS([dirA], dirA);
    assert.throws(
      () => sfs.writeFileSync(path.join(dirB, 'nope.txt'), 'x'),
      (err: NodeJS.ErrnoException) => err.code === 'EPERM',
    );
  });

  it('does not treat a sibling with a shared prefix as inside scope', () => {
    // dirA + "-x" shares the string prefix but must not be allowed.
    const sibling = dirA + '-sibling';
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const sfs = new ScopedFS([dirA], dirA);
      assert.throws(
        () => sfs.writeFileSync(path.join(sibling, 'f.txt'), 'x'),
        (err: NodeJS.ErrnoException) => err.code === 'EPERM',
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('configure() re-points the scope to a new dir (relay cwd threading)', () => {
    // Scope strictly to dirA/dirB (no tmp) so the re-scope is observable even
    // though both temp dirs live under os.tmpdir().
    const sfs = new ScopedFS([dirA], dirA);
    assert.throws(() => sfs.writeFileSync(path.join(dirB, 'before.txt'), 'x'),
      (err: NodeJS.ErrnoException) => err.code === 'EPERM');

    sfs.configure([dirB], dirB);

    sfs.writeFileSync(path.join(dirB, 'after.txt'), 'y');
    assert.equal(fs.readFileSync(path.join(dirB, 'after.txt'), 'utf8'), 'y');
    assert.throws(() => sfs.writeFileSync(path.join(dirA, 'again.txt'), 'x'),
      (err: NodeJS.ErrnoException) => err.code === 'EPERM');
  });
});
