// Ported from playwriter (MIT) src/cdp-log.ts: a dedicated JSONL log for CDP
// traffic, separate from relay.log, with string truncation, batched writes
// and size-capped rotation so protocol debugging never floods the disk.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CdpLogDirection = 'from-playwright' | 'to-playwright' | 'from-extension' | 'to-extension';

export type CdpLogEntry = {
  timestamp: string;
  direction: CdpLogDirection;
  clientId?: string;
  message: unknown;
};

export type CdpLogger = {
  log(entry: CdpLogEntry): void;
  /** Wait for all pending writes (and any in-flight rotation) to complete. */
  flush(): Promise<void>;
  logFilePath: string;
};

// CDP events dropped entirely (not forwarded to Playwright clients, not
// logged). Only events no Playwright API depends on — playwright-core 1.56
// never subscribes to either. They dominate traffic on realtime/large pages
// and saturate the relay (see playwriter issue #96).
export const DROPPED_CDP_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
]);

// Events filtered from cdp.jsonl only (still forwarded: *ExtraInfo feeds
// Playwright's allHeaders(), webSocketFrame* feeds page.on('websocket')).
export const NOISY_LOG_EVENTS = new Set([
  ...DROPPED_CDP_EVENTS,
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
  'Network.requestServedFromCache',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketFrameError',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
]);

const DEFAULT_MAX_STRING_LENGTH = Number(process.env.SSPA_CDP_LOG_MAX_STRING_LENGTH || 2000);
const DEFAULT_MAX_ENTRIES = 10_000;
const FLUSH_INTERVAL_MS = 500;

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function createTruncatingReplacer({ maxStringLength }: { maxStringLength: number }) {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === 'string') return truncateString(value, maxStringLength);
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 2) return fallback;
  return Math.floor(value);
}

export function createCdpLogger({
  logFilePath,
  maxStringLength,
  maxEntries,
}: { logFilePath: string; maxStringLength?: number; maxEntries?: number }): CdpLogger {
  const logDir = path.dirname(logFilePath);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFilePath, '');
  } catch {
    // Unwritable log location must never break the relay; log() below will
    // keep failing silently through the queue's catch.
  }

  let queue: Promise<void> = Promise.resolve();
  let lineCount = 0;
  const maxLength = maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const envMaxEntries = Number(process.env.SSPA_CDP_LOG_MAX_ENTRIES);
  const resolvedMaxEntries = resolvePositiveInt(maxEntries, resolvePositiveInt(envMaxEntries, DEFAULT_MAX_ENTRIES));
  // Keep half the entries after rotation so we don't rotate on every write.
  const keepAfterRotation = Math.floor(resolvedMaxEntries / 2);

  // Batch buffer: without batching, high-frequency CDP events cause thousands
  // of appendFile calls per second.
  let buffer: string[] = [];
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Atomic rotation: write to temp file then rename to avoid corruption.
  const rotate = async (): Promise<void> => {
    try {
      const content = await fs.promises.readFile(logFilePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      const kept = lines.slice(-keepAfterRotation);
      const tmpPath = `${logFilePath}.tmp`;
      await fs.promises.writeFile(tmpPath, kept.join('\n') + '\n');
      await fs.promises.rename(tmpPath, logFilePath);
      lineCount = kept.length;
    } catch {
      // If rotation fails (disk error, permissions), keep logging without it;
      // lineCount stays high so rotation is retried on the next flush.
    }
  };

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];
    try {
      await fs.promises.appendFile(logFilePath, lines.join('\n') + '\n');
    } catch {
      return;
    }
    lineCount += lines.length;
    if (lineCount > resolvedMaxEntries) await rotate();
  };

  const log = (entry: CdpLogEntry): void => {
    const replacer = createTruncatingReplacer({ maxStringLength: maxLength });
    buffer.push(JSON.stringify(entry, replacer));
    if (!flushTimer) {
      flushTimer = setInterval(() => {
        queue = queue.then(flushBuffer);
      }, FLUSH_INTERVAL_MS);
      flushTimer.unref();
    }
  };

  const flush = async (): Promise<void> => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    queue = queue.then(flushBuffer);
    await queue;
  };

  return { log, flush, logFilePath };
}
