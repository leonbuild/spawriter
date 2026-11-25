/**
 * Single-instance lock — prevents multiple relay instances from running
 * on the same data root simultaneously.
 *
 * §8.2/W10 of the stability plan. Uses a lockfile with PID + nonce + start
 * identity for safe stale detection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { monoNowMs, generateInstanceId } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LockInfo {
  pid: number;
  instanceId: string;
  nonce: string;
  port: number;
  startedAt: string;
  startMono: number;
}

export interface LockResult {
  acquired: boolean;
  lockInfo?: LockInfo;
  existingLock?: LockInfo;
  stale?: boolean;
}

export interface InstanceLockConfig {
  /** Path to the data root directory. */
  dataRoot: string;
  /** Port the relay will listen on. */
  port: number;
  /** Instance ID for this relay. */
  instanceId?: string;
  /** Stale lock timeout in ms (default: 60_000). */
  staleLockTimeoutMs?: number;
}

const LOCK_FILE_NAME = 'relay.lock';

// ─── Implementation ──────────────────────────────────────────────────────────

export class InstanceLock {
  private readonly dataRoot: string;
  private readonly lockPath: string;
  private readonly port: number;
  private readonly instanceId: string;
  private readonly staleLockTimeoutMs: number;

  private lockInfo: LockInfo | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: InstanceLockConfig) {
    this.dataRoot = config.dataRoot;
    this.lockPath = path.join(config.dataRoot, LOCK_FILE_NAME);
    this.port = config.port;
    this.instanceId = config.instanceId ?? generateInstanceId();
    this.staleLockTimeoutMs = config.staleLockTimeoutMs ?? 60_000;
  }

  /**
   * Try to acquire the lock. Returns the lock result.
   */
  acquire(): LockResult {
    // Ensure data root exists.
    fs.mkdirSync(this.dataRoot, { recursive: true });

    // Check for existing lock.
    const existing = this.readLock();
    if (existing) {
      // Check if the process is still alive.
      if (this.isProcessAlive(existing.pid)) {
        return {
          acquired: false,
          existingLock: existing,
          stale: false,
        };
      }

      // Process is dead — stale lock. Remove it.
      this.removeLockFile();
    }

    // Write the lock.
    const nonce = Math.random().toString(36).slice(2, 14);
    const info: LockInfo = {
      pid: process.pid,
      instanceId: this.instanceId,
      nonce,
      port: this.port,
      startedAt: new Date().toISOString(),
      startMono: monoNowMs(),
    };

    try {
      // Use exclusive create to prevent races.
      fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), { flag: 'wx' });
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        // Another process grabbed it between our check and write.
        const raced = this.readLock();
        return {
          acquired: false,
          existingLock: raced ?? undefined,
          stale: false,
        };
      }
      throw err;
    }

    // Verify our write landed (paranoid double-check).
    const verify = this.readLock();
    if (!verify || verify.nonce !== nonce || verify.pid !== process.pid) {
      return { acquired: false, existingLock: verify ?? undefined };
    }

    this.lockInfo = info;
    return { acquired: true, lockInfo: info };
  }

  /**
   * Release the lock.
   */
  release(): void {
    this.stopRefresh();
    if (!this.lockInfo) return;

    // Only remove if it's still our lock.
    const current = this.readLock();
    if (current && current.nonce === this.lockInfo.nonce && current.pid === process.pid) {
      this.removeLockFile();
    }
    this.lockInfo = null;
  }

  /**
   * Start periodic refresh (keeps the lock file mtime fresh for stale detection).
   */
  startRefresh(intervalMs: number = 15_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.lockInfo) {
        try {
          // Touch the file to update mtime.
          const now = new Date();
          fs.utimesSync(this.lockPath, now, now);
        } catch {
          // Lock file may have been removed externally.
        }
      }
    }, intervalMs);
    if (this.refreshTimer && typeof this.refreshTimer === 'object' && 'unref' in this.refreshTimer) {
      (this.refreshTimer as NodeJS.Timer).unref();
    }
  }

  /**
   * Stop the refresh timer.
   */
  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Check if this instance holds the lock.
   */
  isHeld(): boolean {
    if (!this.lockInfo) return false;
    const current = this.readLock();
    return current != null && current.nonce === this.lockInfo.nonce && current.pid === process.pid;
  }

  /**
   * Get the current lock holder info (if any).
   */
  getHolder(): LockInfo | null {
    return this.readLock();
  }

  get currentInstanceId(): string {
    return this.instanceId;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private readLock(): LockInfo | null {
    try {
      const content = fs.readFileSync(this.lockPath, 'utf8');
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }

  private removeLockFile(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Best-effort.
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
