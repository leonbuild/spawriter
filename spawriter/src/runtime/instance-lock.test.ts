import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstanceLock } from './instance-lock.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spawriter-lock-test-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true }); } catch {}
}

describe('InstanceLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe('acquire and release', () => {
    it('acquires the lock on first try', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      const result = lock.acquire();
      assert(result.acquired);
      assert(result.lockInfo);
      assert.equal(result.lockInfo.pid, process.pid);
      assert.equal(result.lockInfo.port, 29999);
      lock.release();
    });

    it('lock file exists while held', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      lock.acquire();
      assert(fs.existsSync(path.join(tempDir, 'relay.lock')));
      lock.release();
      assert(!fs.existsSync(path.join(tempDir, 'relay.lock')));
    });

    it('reports held status', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      assert(!lock.isHeld());
      lock.acquire();
      assert(lock.isHeld());
      lock.release();
      assert(!lock.isHeld());
    });
  });

  describe('contention (T22/T56)', () => {
    it('second lock fails when first is held by this process', () => {
      const lock1 = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      const lock2 = new InstanceLock({ dataRoot: tempDir, port: 29999 });

      const r1 = lock1.acquire();
      assert(r1.acquired);

      const r2 = lock2.acquire();
      assert(!r2.acquired);
      assert(r2.existingLock);
      assert.equal(r2.existingLock.pid, process.pid);

      lock1.release();
    });

    it('detects stale lock from dead process', () => {
      // Write a lock with a PID that doesn't exist.
      const fakeLock = {
        pid: 999999999, // very unlikely to exist
        instanceId: 'fake',
        nonce: 'stale123',
        port: 29999,
        startedAt: new Date().toISOString(),
        startMono: 0,
      };
      fs.writeFileSync(path.join(tempDir, 'relay.lock'), JSON.stringify(fakeLock));

      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      const result = lock.acquire();
      // Should succeed because the fake PID is dead.
      assert(result.acquired, 'Should acquire after stale lock cleanup');
      lock.release();
    });
  });

  describe('getHolder', () => {
    it('returns null when no lock', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      assert.equal(lock.getHolder(), null);
    });

    it('returns lock info when held', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      lock.acquire();
      const holder = lock.getHolder();
      assert(holder);
      assert.equal(holder.pid, process.pid);
      lock.release();
    });
  });

  describe('safety', () => {
    it('release is idempotent', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      lock.acquire();
      lock.release();
      lock.release(); // should not throw
    });

    it('does not remove another instance lock on release', () => {
      const lock1 = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      lock1.acquire();

      // Simulate another instance overwriting the lock (externally).
      const otherLock = {
        pid: process.pid,
        instanceId: 'other',
        nonce: 'other-nonce',
        port: 29999,
        startedAt: new Date().toISOString(),
        startMono: 0,
      };
      fs.writeFileSync(path.join(tempDir, 'relay.lock'), JSON.stringify(otherLock));

      // Release should NOT delete since the nonce doesn't match.
      lock1.release();
      assert(fs.existsSync(path.join(tempDir, 'relay.lock')));
      // Clean up.
      fs.unlinkSync(path.join(tempDir, 'relay.lock'));
    });

    it('creates data root if it does not exist', () => {
      const nestedDir = path.join(tempDir, 'nested', 'data');
      const lock = new InstanceLock({ dataRoot: nestedDir, port: 29999 });
      const result = lock.acquire();
      assert(result.acquired);
      assert(fs.existsSync(nestedDir));
      lock.release();
    });
  });

  describe('refresh', () => {
    it('starts and stops refresh timer without error', () => {
      const lock = new InstanceLock({ dataRoot: tempDir, port: 29999 });
      lock.acquire();
      lock.startRefresh(100);
      lock.stopRefresh();
      lock.release();
    });
  });
});
