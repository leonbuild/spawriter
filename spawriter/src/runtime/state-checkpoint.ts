/**
 * State checkpoint — bounded, versioned state storage for user VM state
 * across executions within a session.
 *
 * §16.6 of the stability plan. Each checkpoint is tagged with an execution
 * epoch; rollback on failure restores the last committed checkpoint.
 * Transient and non-serializable values are tracked and excluded.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Checkpoint {
  /** Execution epoch that committed this checkpoint. */
  executeEpoch: number;
  /** Serialized state (JSON string). */
  serialized: string;
  /** Byte size of the serialized state. */
  byteSize: number;
  /** Monotonic timestamp of commit. */
  committedMono: number;
  /** Keys that were present but non-serializable. */
  transientKeys: string[];
  /** Keys that exceeded individual value size cap. */
  oversizedKeys: string[];
}

export interface CheckpointConfig {
  /** Maximum total serialized byte size. */
  maxByteSize?: number;
  /** Maximum individual value byte size. */
  maxValueByteSize?: number;
  /** Maximum number of top-level keys. */
  maxKeys?: number;
  /** Maximum checkpoints to retain. */
  maxHistory?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class StateCheckpoint {
  private readonly maxByteSize: number;
  private readonly maxValueByteSize: number;
  private readonly maxKeys: number;
  private readonly maxHistory: number;

  /** Checkpoint history (most recent last). */
  private history: Checkpoint[] = [];

  /** Current live state (not yet committed). */
  private live: Map<string, unknown> = new Map();

  /** Set of keys known to be non-serializable. */
  private transientKeys = new Set<string>();

  constructor(config: CheckpointConfig = {}) {
    this.maxByteSize = config.maxByteSize ?? 2 * 1024 * 1024; // 2 MiB
    this.maxValueByteSize = config.maxValueByteSize ?? 512 * 1024; // 512 KiB
    this.maxKeys = config.maxKeys ?? 256;
    this.maxHistory = config.maxHistory ?? 5;
  }

  // ─── Live state ────────────────────────────────────────────────────────

  /**
   * Set a value in the live state.
   */
  set(key: string, value: unknown): void {
    if (this.live.size >= this.maxKeys && !this.live.has(key)) {
      throw new Error(`State key limit (${this.maxKeys}) reached`);
    }
    this.live.set(key, value);
    // Reset transient flag — will be re-evaluated on commit.
    this.transientKeys.delete(key);
  }

  /**
   * Get a value from the live state.
   */
  get(key: string): unknown {
    return this.live.get(key);
  }

  /**
   * Delete a key from the live state.
   */
  delete(key: string): boolean {
    this.transientKeys.delete(key);
    return this.live.delete(key);
  }

  /**
   * Check if a key exists.
   */
  has(key: string): boolean {
    return this.live.has(key);
  }

  /**
   * Get all keys in the live state.
   */
  keys(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Get the live state as a plain object (serializable values only).
   */
  toObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.live) {
      if (!this.transientKeys.has(key)) {
        obj[key] = value;
      }
    }
    return obj;
  }

  // ─── Checkpoint lifecycle ──────────────────────────────────────────────

  /**
   * Commit the current live state as a checkpoint.
   * Returns the checkpoint or null if serialization fails/exceeds limits.
   */
  commit(executeEpoch: number): Checkpoint | null {
    const transient: string[] = [];
    const oversized: string[] = [];
    const serializable: Record<string, unknown> = {};

    for (const [key, value] of this.live) {
      try {
        const json = JSON.stringify(value);
        if (json === undefined) {
          transient.push(key);
          this.transientKeys.add(key);
          continue;
        }
        const byteSize = Buffer.byteLength(json, 'utf8');
        if (byteSize > this.maxValueByteSize) {
          oversized.push(key);
          continue;
        }
        serializable[key] = value;
      } catch {
        transient.push(key);
        this.transientKeys.add(key);
      }
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(serializable);
    } catch {
      return null;
    }

    const byteSize = Buffer.byteLength(serialized, 'utf8');
    if (byteSize > this.maxByteSize) {
      return null;
    }

    const checkpoint: Checkpoint = {
      executeEpoch,
      serialized,
      byteSize,
      committedMono: monoNowMs(),
      transientKeys: transient,
      oversizedKeys: oversized,
    };

    this.history.push(checkpoint);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return checkpoint;
  }

  /**
   * Rollback to the last committed checkpoint.
   * Returns the restored checkpoint, or null if no checkpoint exists.
   */
  rollback(): Checkpoint | null {
    if (this.history.length === 0) return null;

    const checkpoint = this.history[this.history.length - 1];
    try {
      const data = JSON.parse(checkpoint.serialized);
      this.live = new Map(Object.entries(data));
      this.transientKeys = new Set(checkpoint.transientKeys);
      return checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Rollback to a specific epoch.
   */
  rollbackToEpoch(executeEpoch: number): Checkpoint | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].executeEpoch <= executeEpoch) {
        const checkpoint = this.history[i];
        // Trim history to this point.
        this.history = this.history.slice(0, i + 1);
        try {
          const data = JSON.parse(checkpoint.serialized);
          this.live = new Map(Object.entries(data));
          this.transientKeys = new Set(checkpoint.transientKeys);
          return checkpoint;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Get the last committed checkpoint.
   */
  lastCheckpoint(): Checkpoint | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /**
   * Get the number of committed checkpoints.
   */
  get checkpointCount(): number {
    return this.history.length;
  }

  /**
   * Reset all state and history.
   */
  reset(): void {
    this.live.clear();
    this.history = [];
    this.transientKeys.clear();
  }

  /**
   * Diagnostic info.
   */
  diagnostics(): {
    liveKeys: number;
    transientKeys: number;
    checkpoints: number;
    lastEpoch: number | null;
    totalBytes: number;
  } {
    return {
      liveKeys: this.live.size,
      transientKeys: this.transientKeys.size,
      checkpoints: this.history.length,
      lastEpoch: this.history.length > 0 ? this.history[this.history.length - 1].executeEpoch : null,
      totalBytes: this.history.reduce((sum, c) => sum + c.byteSize, 0),
    };
  }
}
