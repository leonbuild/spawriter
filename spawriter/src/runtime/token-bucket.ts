/**
 * Token bucket rate limiter for console event governance.
 *
 * Uses a monotonic clock. Each bucket has a fixed rate (tokens/s) and burst
 * capacity. The accept() method returns whether a token is available without
 * blocking.
 *
 * §4.2 of the stability plan.
 */

import { monoNowMs } from './execution-context.js';

export interface TokenBucketOptions {
  /** Sustained rate in tokens per second. */
  rate: number;
  /** Maximum burst size (bucket capacity). */
  burst: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMono: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.rate <= 0 || !Number.isFinite(opts.rate)) {
      throw new RangeError(`rate must be a finite positive number, got ${opts.rate}`);
    }
    if (opts.burst < 1 || !Number.isFinite(opts.burst)) {
      throw new RangeError(`burst must be a finite positive integer, got ${opts.burst}`);
    }
    this.rate = opts.rate;
    this.burst = Math.floor(opts.burst);
    this.tokens = this.burst;
    this.lastRefillMono = monoNowMs();
  }

  /**
   * Try to consume one token. Returns true if a token was available.
   */
  tryConsume(nowMono?: number): boolean {
    const now = nowMono ?? monoNowMs();
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Current available tokens (fractional).
   */
  available(nowMono?: number): number {
    const now = nowMono ?? monoNowMs();
    this.refill(now);
    return this.tokens;
  }

  private refill(nowMono: number): void {
    const elapsedMs = nowMono - this.lastRefillMono;
    if (elapsedMs <= 0) return;
    const added = (elapsedMs / 1000) * this.rate;
    this.tokens = Math.min(this.burst, this.tokens + added);
    this.lastRefillMono = nowMono;
  }
}

/**
 * Console event signature for deduplication.
 * Built from: type + first primitive text (bounded) + top frame + context.
 */
export function consoleSignature(
  type: string,
  text: string | undefined,
  topFrame: string | undefined,
  contextId: number | undefined,
): string {
  const truncText = text ? text.slice(0, 200) : '';
  return `${type}|${truncText}|${topFrame ?? ''}|${contextId ?? ''}`;
}

export interface SignatureEntry {
  count: number;
  firstSeenMono: number;
  lastSeenMono: number;
}

/**
 * Bounded LRU signature map for console deduplication.
 * Evicts oldest entries when capacity is reached.
 */
export class SignatureMap {
  private readonly map = new Map<string, SignatureEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private evictedCount = 0;

  constructor(maxEntries: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Record a signature hit. Returns the entry with updated count.
   * Returns null if this is the first occurrence.
   */
  hit(sig: string, nowMono?: number): SignatureEntry | null {
    const now = nowMono ?? monoNowMs();
    this.evictExpired(now);

    const existing = this.map.get(sig);
    if (existing) {
      existing.count++;
      existing.lastSeenMono = now;
      // Move to end for LRU (delete+set)
      this.map.delete(sig);
      this.map.set(sig, existing);
      return existing;
    }

    // Evict oldest if at capacity
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.evictedCount++;
      }
    }

    const entry: SignatureEntry = { count: 1, firstSeenMono: now, lastSeenMono: now };
    this.map.set(sig, entry);
    return null; // first occurrence
  }

  /** Number of distinct signatures currently tracked. */
  get size(): number {
    return this.map.size;
  }

  /** Total evictions due to capacity. */
  get evictions(): number {
    return this.evictedCount;
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
  }

  private evictExpired(nowMono: number): void {
    for (const [key, entry] of this.map) {
      if (nowMono - entry.lastSeenMono > this.ttlMs) {
        this.map.delete(key);
        this.evictedCount++;
      } else {
        break; // oldest first, so once we find a valid one, stop
      }
    }
  }
}
