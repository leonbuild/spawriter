/**
 * Console event traffic governor for the Extension.
 *
 * Classifies CDP events, applies per-tab and global rate limiting,
 * deduplicates repeated console messages, and trims deep stacks.
 *
 * §4.1–4.2 of the stability plan. This module is pure logic with no
 * Chrome API dependencies — all external state is injected.
 */

// ─── Event classification ───

/**
 * Events dropped at source (never forwarded).
 * Only events that no Playwright API depends on.
 */
const DROPPED_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
]);

/**
 * Protocol-critical events: must be forwarded in order, never dropped.
 */
const PROTOCOL_CRITICAL = new Set([
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Target.targetCreated',
  'Target.targetDestroyed',
  'Target.targetInfoChanged',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Page.frameAttached',
  'Page.frameDetached',
  'Page.frameNavigated',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.lifecycleEvent',
  'Page.navigatedWithinDocument',
  'Page.domContentEventFired',
  'Page.loadEventFired',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
  'Page.fileChooserOpened',
  'Page.downloadWillBegin',
  'Page.downloadProgress',
  'Fetch.requestPaused',
  'Fetch.authRequired',
  'Debugger.paused',
  'Debugger.resumed',
  'Debugger.scriptParsed',
]);

// ─── Token bucket ───

class TokenBucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefill = performance.now();
  }

  tryConsume(now) {
    now = now ?? performance.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rate);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }
}

// ─── Signature map ───

class SignatureMap {
  constructor(maxEntries, ttlMs) {
    this.map = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.evictions = 0;
  }

  hit(sig, now) {
    now = now ?? performance.now();
    this._evictExpired(now);

    const entry = this.map.get(sig);
    if (entry) {
      entry.count++;
      entry.lastSeen = now;
      this.map.delete(sig);
      this.map.set(sig, entry);
      return entry;
    }

    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }

    const newEntry = { count: 1, firstSeen: now, lastSeen: now };
    this.map.set(sig, newEntry);
    return null;
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  _evictExpired(now) {
    for (const [key, entry] of this.map) {
      if (now - entry.lastSeen > this.ttlMs) {
        this.map.delete(key);
        this.evictions++;
      } else {
        break;
      }
    }
  }
}

// ─── Stack trimming ───

const MAX_STACK_FRAMES_NORMAL = 5;
const MAX_STACK_FRAMES_ERROR = 10;
const MAX_ARGS_TEXT_LENGTH = 2000;

/**
 * Trim a stackTrace to at most maxFrames.
 * Returns a new object (or undefined) — never mutates the original.
 */
function trimStack(stackTrace, maxFrames) {
  if (!stackTrace || !stackTrace.callFrames) return stackTrace;
  if (stackTrace.callFrames.length <= maxFrames) return stackTrace;
  return {
    ...stackTrace,
    callFrames: stackTrace.callFrames.slice(0, maxFrames),
    parent: undefined,
    parentId: undefined,
  };
}

// ─── Console signature ───

function consoleSignature(type, args, topFrame, contextId) {
  let textPart = '';
  if (args && args.length > 0) {
    const first = args[0];
    if (first && (first.type === 'string' || first.type === 'number' || first.type === 'boolean')) {
      const val = String(first.value ?? first.description ?? '');
      textPart = val.slice(0, 200);
    }
  }
  const framePart = topFrame
    ? `${topFrame.url || ''}:${topFrame.lineNumber || 0}`
    : '';
  return `${type}|${textPart}|${framePart}|${contextId ?? ''}`;
}

// ─── Per-tab state ───

class TabGovernor {
  constructor(tabId, config) {
    this.tabId = tabId;
    this.bucket = new TokenBucket(config.ratePerTab, config.burstPerTab);
    this.signatures = new SignatureMap(config.signatureMaxPerTab, config.signatureTtlMs);
    this.bytesForwarded = 0;
    this.bytesCap = config.bytesPerTab;
    this.accepted = 0;
    this.dropped = 0;
    this.trimmed = 0;
  }

  reset() {
    this.signatures.clear();
    this.bytesForwarded = 0;
    this.accepted = 0;
    this.dropped = 0;
    this.trimmed = 0;
  }
}

// ─── Main governor ───

const DEFAULT_CONFIG = {
  ratePerTab: 100,
  burstPerTab: 200,
  globalRate: 500,
  globalBurst: 1000,
  bytesPerTab: 1_048_576,  // 1MiB
  bytesGlobal: 4_194_304,  // 4MiB
  eventBytesMax: 65_536,   // 64KiB single event
  signatureMaxPerTab: 1024,
  signatureMaxGlobal: 8192,
  signatureTtlMs: 60_000,
};

export class TrafficGovernor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalBucket = new TokenBucket(this.config.globalRate, this.config.globalBurst);
    this.globalSignatures = new SignatureMap(this.config.signatureMaxGlobal, this.config.signatureTtlMs);
    this.tabs = new Map();
    this.globalBytesForwarded = 0;
    this.metrics = {
      totalReceived: 0,
      droppedAtSource: 0,
      rateLimited: 0,
      byteLimited: 0,
      deduplicated: 0,
      stackTrimmed: 0,
      forwarded: 0,
    };
  }

  /**
   * Classify and decide whether to forward a CDP event.
   *
   * @param {string} method - CDP event method
   * @param {object} params - CDP event params
   * @param {number} tabId - Chrome tab ID
   * @returns {{ forward: boolean, params?: object, reason?: string }}
   */
  evaluate(method, params, tabId) {
    this.metrics.totalReceived++;

    // Drop at source
    if (DROPPED_EVENTS.has(method)) {
      this.metrics.droppedAtSource++;
      return { forward: false, reason: 'dropped_event' };
    }

    // Protocol-critical: always forward
    if (PROTOCOL_CRITICAL.has(method)) {
      this.metrics.forwarded++;
      return { forward: true, params };
    }

    // Command responses (have an 'id'): always forward
    if (params && params.id !== undefined) {
      this.metrics.forwarded++;
      return { forward: true, params };
    }

    // Console events: apply full governance
    if (method === 'Runtime.consoleAPICalled') {
      return this._evaluateConsole(params, tabId);
    }

    // Other events: forward but count
    this.metrics.forwarded++;
    return { forward: true, params };
  }

  /**
   * Get or create per-tab governor state.
   */
  getTabState(tabId) {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = new TabGovernor(tabId, this.config);
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  /**
   * Clean up tab state on detach/close.
   */
  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  /**
   * Reset all state (e.g., on extension reconnect).
   */
  reset() {
    this.tabs.clear();
    this.globalBytesForwarded = 0;
    this.globalSignatures.clear();
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics() {
    return {
      ...this.metrics,
      globalBytes: this.globalBytesForwarded,
      tabCount: this.tabs.size,
      globalSignatures: this.globalSignatures.size,
    };
  }

  // ─── Private ───

  _evaluateConsole(params, tabId) {
    const now = performance.now();
    const tab = this.getTabState(tabId);
    const type = params.type || 'log';
    const isError = type === 'error' || type === 'assert';

    // Build signature for dedup
    const topFrame = params.stackTrace?.callFrames?.[0];
    const sig = consoleSignature(type, params.args, topFrame, params.executionContextId);
    const existing = tab.signatures.hit(sig, now);

    // Allow first 1-2 occurrences, then deduplicate
    if (existing && existing.count > 2 && !isError) {
      this.metrics.deduplicated++;
      tab.dropped++;
      return { forward: false, reason: 'deduplicated' };
    }

    // Per-tab rate limit
    if (!tab.bucket.tryConsume(now)) {
      this.metrics.rateLimited++;
      tab.dropped++;
      return { forward: false, reason: 'tab_rate_limited' };
    }

    // Global rate limit
    if (!this.globalBucket.tryConsume(now)) {
      this.metrics.rateLimited++;
      tab.dropped++;
      return { forward: false, reason: 'global_rate_limited' };
    }

    // Byte budget check (rough estimate without full stringify)
    const estimatedBytes = this._estimateEventBytes(params);
    if (estimatedBytes > this.config.eventBytesMax) {
      this.metrics.byteLimited++;
      tab.dropped++;
      return { forward: false, reason: 'event_too_large' };
    }

    if (tab.bytesForwarded + estimatedBytes > tab.bytesCap) {
      this.metrics.byteLimited++;
      tab.dropped++;
      return { forward: false, reason: 'tab_byte_cap' };
    }

    if (this.globalBytesForwarded + estimatedBytes > this.config.bytesGlobal) {
      this.metrics.byteLimited++;
      tab.dropped++;
      return { forward: false, reason: 'global_byte_cap' };
    }

    // Trim stack for non-error repeated messages
    let resultParams = params;
    const maxFrames = isError ? MAX_STACK_FRAMES_ERROR : MAX_STACK_FRAMES_NORMAL;
    if (params.stackTrace && params.stackTrace.callFrames?.length > maxFrames) {
      resultParams = {
        ...params,
        stackTrace: trimStack(params.stackTrace, maxFrames),
      };
      this.metrics.stackTrimmed++;
      tab.trimmed++;
    }

    tab.bytesForwarded += estimatedBytes;
    this.globalBytesForwarded += estimatedBytes;
    tab.accepted++;
    this.metrics.forwarded++;

    return { forward: true, params: resultParams };
  }

  _estimateEventBytes(params) {
    // Quick heuristic: count args text + stack frames rather than full stringify
    let bytes = 100; // base overhead
    if (params.args) {
      for (const arg of params.args) {
        if (arg.value !== undefined) {
          bytes += String(arg.value).length;
        } else if (arg.description) {
          bytes += Math.min(arg.description.length, MAX_ARGS_TEXT_LENGTH);
        }
        bytes += 50; // per-arg overhead
      }
    }
    if (params.stackTrace?.callFrames) {
      bytes += params.stackTrace.callFrames.length * 150;
    }
    return bytes;
  }
}

// Export for testing
export {
  DROPPED_EVENTS,
  PROTOCOL_CRITICAL,
  TokenBucket as _TokenBucket,
  SignatureMap as _SignatureMap,
  trimStack as _trimStack,
  consoleSignature as _consoleSignature,
};
