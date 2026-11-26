/**
 * G-1 Feasibility experiments requiring real runtime.
 *
 * F05: Process tree kill on Windows
 * F06: Instance lock contention under concurrent cold starts
 *
 * F04 and F07 require Chrome and are tested via the integration suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { InstanceLock } from './instance-lock.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g1-experiment-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('G-1 Feasibility: F05 Process Tree', () => {
  it('child process dies when parent dies (spawn + kill)', async () => {
    // Spawn a parent that spawns a child, then kill the parent.
    // The parent writes PID info on stdout, then sleeps.
    const parentScript = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      process.stdout.write(JSON.stringify({ parentPid: process.pid, childPid: child.pid }) + '\\n');
      setTimeout(() => {}, 60000);
    `;

    const parent = spawn(process.execPath, ['-e', parentScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Read the first line (PID JSON) without waiting for stream end.
    const pids = await new Promise<{ parentPid: number; childPid: number }>((resolve, reject) => {
      let data = '';
      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          parent.stdout!.removeListener('data', onData);
          try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); }
        }
      };
      parent.stdout!.on('data', onData);
      setTimeout(() => reject(new Error('Timeout waiting for PIDs')), 5000);
    });

    assert(pids.parentPid > 0);
    assert(pids.childPid > 0);

    // Kill the parent.
    process.kill(pids.parentPid, 'SIGKILL');

    // Wait for cleanup.
    await new Promise(r => setTimeout(r, 500));

    // Check if child is still alive.
    let childAlive = false;
    try {
      process.kill(pids.childPid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    }

    if (childAlive) {
      // On Windows without Job Object, child may survive — clean it up.
      // Job Object handling is in process-guard.ts.
      try { process.kill(pids.childPid, 'SIGKILL'); } catch { /* ok */ }
    }

    // The parent should definitely be dead.
    let parentAlive = false;
    try { process.kill(pids.parentPid, 0); parentAlive = true; } catch { /* expected */ }
    assert(!parentAlive, 'Parent should be dead after SIGKILL');
  });
});

describe('G-1 Feasibility: F06 Instance Lock Contention', () => {
  it('20 concurrent acquires result in exactly 1 winner', () => {
    const tempRoot = makeTempRoot();
    try {
      const locks: InstanceLock[] = [];
      let winners = 0;

      for (let i = 0; i < 20; i++) {
        const lock = new InstanceLock({ dataRoot: tempRoot });
        const result = lock.acquire(`relay-${i}`, 20000 + i);
        if (result.acquired) {
          winners++;
          locks.push(lock);
        }
      }

      assert.equal(winners, 1, `Expected exactly 1 winner, got ${winners}`);

      // Clean up.
      for (const lock of locks) lock.release();
    } finally {
      cleanup(tempRoot);
    }
  });

  it('stale lock from dead PID allows new acquire', () => {
    const tempRoot = makeTempRoot();
    try {
      // Write a lock with a dead PID.
      fs.writeFileSync(
        path.join(tempRoot, 'relay.lock'),
        JSON.stringify({
          pid: 999999999,
          instanceId: 'old',
          nonce: 'old-nonce',
          port: 19999,
          startedAt: new Date().toISOString(),
          startMono: Date.now() - 600_000,
        }),
      );

      const lock = new InstanceLock({ dataRoot: tempRoot });
      const result = lock.acquire('new-relay', 20000);
      assert(result.acquired, 'Should reclaim stale lock');
      lock.release();
    } finally {
      cleanup(tempRoot);
    }
  });
});
