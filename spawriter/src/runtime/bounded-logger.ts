/**
 * Bounded segment-based logger with rotation.
 *
 * Replaces the synchronous appendFileSync relay.log and the read-then-rewrite
 * cdp.jsonl rotation with a proper segment-based ring.
 *
 * §5.5 of the stability plan:
 * - Per-file 10MiB, max 5 segments, queue 2MiB.
 * - UTF-8 Buffer.byteLength, not char count.
 * - Segment rotation via close/rename, not readFile+split.
 * - Serial write loop; disk-slow → drop low-priority, count.
 * - Startup: new segment with instanceId, don't truncate evidence.
 * - Flush on graceful drain; fatal best-effort bounded.
 * - Sensitive content redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Priority levels for log entries. */
export type LogPriority = 'critical' | 'normal' | 'low';

export interface BoundedLoggerOptions {
  /** Directory for log segments. */
  dir: string;
  /** Base name without extension (e.g. 'relay' → relay-0.log). */
  baseName: string;
  /** Instance ID included in segment filenames. */
  instanceId: string;
  /** Max bytes per segment (default 10MiB). */
  segmentBytes?: number;
  /** Max retained segments (default 5). */
  maxSegments?: number;
  /** Max queue bytes in memory (default 2MiB). */
  queueBytes?: number;
  /** Flush interval ms (default 200). */
  flushIntervalMs?: number;
}

interface QueueEntry {
  line: string;
  byteSize: number;
  priority: LogPriority;
}

export class BoundedLogger {
  private readonly dir: string;
  private readonly baseName: string;
  private readonly instanceId: string;
  private readonly segmentBytes: number;
  private readonly maxSegments: number;
  private readonly maxQueueBytes: number;
  private readonly flushIntervalMs: number;

  private queue: QueueEntry[] = [];
  private queueByteTotal = 0;
  private currentSegmentPath: string;
  private currentSegmentBytes = 0;
  private segmentIndex = 0;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private closed = false;

  // Metrics
  private _droppedLow = 0;
  private _droppedNormal = 0;
  private _totalWritten = 0;
  private _totalDropped = 0;
  private _rotations = 0;

  constructor(opts: BoundedLoggerOptions) {
    this.dir = opts.dir;
    this.baseName = opts.baseName;
    this.instanceId = opts.instanceId;
    this.segmentBytes = opts.segmentBytes ?? 10 * 1024 * 1024;
    this.maxSegments = opts.maxSegments ?? 5;
    this.maxQueueBytes = opts.queueBytes ?? 2 * 1024 * 1024;
    this.flushIntervalMs = opts.flushIntervalMs ?? 200;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch { /* best effort */ }

    this.currentSegmentPath = this.newSegmentPath();
    this.startFlushTimer();
  }

  /**
   * Enqueue a log line. Low-priority lines are dropped first when queue is full.
   */
  log(line: string, priority: LogPriority = 'normal'): void {
    if (this.closed) return;

    const byteSize = Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline

    // If queue is over budget, drop low-priority first
    if (this.queueByteTotal + byteSize > this.maxQueueBytes) {
      if (priority === 'low') {
        this._droppedLow++;
        this._totalDropped++;
        return;
      }
      // Try to free space by dropping low-priority entries
      this.evictLowPriority(byteSize);
      if (this.queueByteTotal + byteSize > this.maxQueueBytes) {
        if (priority === 'normal') {
          this._droppedNormal++;
          this._totalDropped++;
          return;
        }
        // Critical: force evict normal entries too
        this.evictNormalPriority(byteSize);
        if (this.queueByteTotal + byteSize > this.maxQueueBytes) {
          this._totalDropped++;
          return; // even critical can't fit
        }
      }
    }

    this.queue.push({ line, byteSize, priority });
    this.queueByteTotal += byteSize;
  }

  /**
   * Synchronous best-effort write for fatal/shutdown.
   */
  logSync(line: string): void {
    try {
      fs.appendFileSync(this.currentSegmentPath, line + '\n');
    } catch { /* best effort */ }
  }

  /**
   * Flush all pending entries and close.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.stopFlushTimer();
    await this.flush();
  }

  /**
   * Flush queued entries to disk.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, Math.min(this.queue.length, 100));
        const batchBytes = batch.reduce((sum, e) => sum + e.byteSize, 0);
        this.queueByteTotal -= batchBytes;

        const content = batch.map((e) => e.line).join('\n') + '\n';
        const writeBytes = Buffer.byteLength(content, 'utf-8');

        // Rotate if needed
        if (this.currentSegmentBytes + writeBytes > this.segmentBytes) {
          await this.rotate();
        }

        try {
          await fs.promises.appendFile(this.currentSegmentPath, content);
          this.currentSegmentBytes += writeBytes;
          this._totalWritten += batch.length;
        } catch {
          // Disk error: entries lost, count them
          this._totalDropped += batch.length;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Diagnostic metrics. */
  get metrics() {
    return {
      droppedLow: this._droppedLow,
      droppedNormal: this._droppedNormal,
      totalWritten: this._totalWritten,
      totalDropped: this._totalDropped,
      rotations: this._rotations,
      queueBytes: this.queueByteTotal,
      queueEntries: this.queue.length,
      currentSegmentBytes: this.currentSegmentBytes,
    };
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async rotate(): Promise<void> {
    // Close current, start new segment
    this.segmentIndex++;
    this._rotations++;
    this.currentSegmentPath = this.newSegmentPath();
    this.currentSegmentBytes = 0;

    // Clean up old segments
    await this.cleanOldSegments();
  }

  private newSegmentPath(): string {
    return path.join(
      this.dir,
      `${this.baseName}-${this.instanceId}-${this.segmentIndex}.log`,
    );
  }

  private async cleanOldSegments(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.dir);
      const prefix = `${this.baseName}-`;
      const segments = files
        .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
        .sort();

      if (segments.length > this.maxSegments) {
        const toRemove = segments.slice(0, segments.length - this.maxSegments);
        for (const file of toRemove) {
          try {
            await fs.promises.unlink(path.join(this.dir, file));
          } catch { /* best effort */ }
        }
      }
    } catch { /* ignore readdir errors */ }
  }

  private evictLowPriority(neededBytes: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queueByteTotal + neededBytes <= this.maxQueueBytes) break;
      if (this.queue[i].priority === 'low') {
        this.queueByteTotal -= this.queue[i].byteSize;
        this.queue.splice(i, 1);
        this._droppedLow++;
        this._totalDropped++;
      }
    }
  }

  private evictNormalPriority(neededBytes: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queueByteTotal + neededBytes <= this.maxQueueBytes) break;
      if (this.queue[i].priority === 'normal') {
        this.queueByteTotal -= this.queue[i].byteSize;
        this.queue.splice(i, 1);
        this._droppedNormal++;
        this._totalDropped++;
      }
    }
  }
}

/** Redact sensitive values from log entries. */
export function redactSensitive(text: string): string {
  // Cookie/Authorization header values
  let result = text.replace(
    /(cookie|authorization|set-cookie|proxy-authorization)\s*[:=]\s*\S+/gi,
    '$1: [REDACTED]',
  );
  // Bearer tokens
  result = result.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]');
  // Common secret patterns
  result = result.replace(/(token|secret|password|credential|apikey)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  return result;
}
