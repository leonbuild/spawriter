// Ported from playwriter (MIT) src/wait-for-page-load.ts, adapted to
// spawriter's expression-based evaluator so it works over both the Playwright
// CDP session and the relay CDP fallback.
import { sleep } from '../utils.js';

// Third-party ad/analytics/chat domains whose requests routinely hang or
// long-poll; treating them as pending would make every wait time out.
export const FILTERED_DOMAINS = [
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'google-analytics',
  'googletagmanager',
  'facebook.net',
  'fbcdn.net',
  'twitter.com',
  'linkedin.com',
  'hotjar',
  'mixpanel',
  'segment.io',
  'segment.com',
  'newrelic',
  'datadoghq',
  'sentry.io',
  'fullstory',
  'amplitude',
  'intercom',
  'crisp.chat',
  'zdassets.com',
  'zendesk',
  'tawk.to',
  'hubspot',
  'marketo',
  'pardot',
  'optimizely',
  'crazyegg',
  'mouseflow',
  'clarity.ms',
  'bing.com/bat',
  'ads.',
  'analytics.',
  'tracking.',
  'pixel.',
];

// Decorative asset types that may load lazily; only ignored once slow.
export const FILTERED_EXTENSIONS = ['.gif', '.ico', '.cur', '.woff', '.woff2', '.ttf', '.otf', '.eot'];

export const STUCK_REQUEST_THRESHOLD_MS = 10000;
export const SLOW_RESOURCE_THRESHOLD_MS = 3000;

export interface PageReadyCheck {
  ready: boolean;
  readyState: string;
  pendingRequests: string[];
}

export interface WaitForPageLoadOptions {
  timeout?: number;
  pollInterval?: number;
  minWait?: number;
}

export interface WaitForPageLoadResult {
  success: boolean;
  readyState: string;
  pendingRequests: string[];
  waitTimeMs: number;
  timedOut: boolean;
}

export type ExpressionEvaluator = (expression: string) => Promise<unknown>;

/**
 * In-page readiness probe: document.readyState must be 'complete' and no
 * meaningful resource may still be in flight (responseEnd === 0), where
 * ad/tracking domains, data: URLs, stuck requests (>10s) and slow decorative
 * assets (>3s) do not count as meaningful.
 */
export function buildPageReadyExpression(): string {
  return `(() => {
    const filteredDomains = ${JSON.stringify(FILTERED_DOMAINS)};
    const filteredExtensions = ${JSON.stringify(FILTERED_EXTENSIONS)};
    const stuckThreshold = ${STUCK_REQUEST_THRESHOLD_MS};
    const slowResourceThreshold = ${SLOW_RESOURCE_THRESHOLD_MS};
    const readyState = document.readyState;
    if (readyState !== 'complete') {
      return JSON.stringify({ ready: false, readyState, pendingRequests: ['document.readyState: ' + readyState] });
    }
    const resources = performance.getEntriesByType('resource');
    const now = performance.now();
    const pendingRequests = resources
      .filter((r) => {
        if (r.responseEnd > 0) return false;
        const elapsed = now - r.startTime;
        const url = r.name.toLowerCase();
        if (url.startsWith('data:')) return false;
        if (filteredDomains.some((domain) => url.includes(domain))) return false;
        if (elapsed > stuckThreshold) return false;
        if (elapsed > slowResourceThreshold && filteredExtensions.some((ext) => url.includes(ext))) return false;
        return true;
      })
      .map((r) => r.name);
    return JSON.stringify({ ready: pendingRequests.length === 0, readyState, pendingRequests });
  })()`;
}

function parseReadyCheck(raw: unknown): PageReadyCheck {
  if (typeof raw === 'string') return JSON.parse(raw) as PageReadyCheck;
  if (raw && typeof raw === 'object') return raw as PageReadyCheck;
  throw new Error(`Unexpected page-ready probe result: ${String(raw)}`);
}

/**
 * Wait until the page has genuinely settled: readyState complete AND no
 * meaningful pending network requests. Unlike waitForLoadState('load'), this
 * catches SPA content that loads after the load event, while ignoring
 * analytics beacons that would otherwise stall the wait forever.
 */
export async function waitForPageLoad(
  evaluateJs: ExpressionEvaluator,
  options?: WaitForPageLoadOptions,
): Promise<WaitForPageLoadResult> {
  const { timeout = 30000, pollInterval = 100, minWait = 500 } = options ?? {};
  const startTime = Date.now();
  let lastReadyState = '';
  let lastPendingRequests: string[] = [];

  const checkPageReady = async (): Promise<PageReadyCheck> =>
    parseReadyCheck(await evaluateJs(buildPageReadyExpression()));

  // Fast path: if already settled, return without the minWait delay.
  try {
    const firstCheck = await checkPageReady();
    if (firstCheck.ready) {
      return {
        success: true,
        readyState: firstCheck.readyState,
        pendingRequests: [],
        waitTimeMs: Date.now() - startTime,
        timedOut: false,
      };
    }
    lastReadyState = firstCheck.readyState;
    lastPendingRequests = firstCheck.pendingRequests;
  } catch {
    // First check failed (e.g. mid-navigation); continue with polling.
  }

  // Let JS settle and catch late-starting requests before polling.
  await sleep(minWait);

  while (Date.now() - startTime < timeout) {
    try {
      const { ready, readyState, pendingRequests } = await checkPageReady();
      lastReadyState = readyState;
      lastPendingRequests = pendingRequests;
      if (ready) {
        return {
          success: true,
          readyState,
          pendingRequests: [],
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        };
      }
    } catch {
      return {
        success: false,
        readyState: 'error',
        pendingRequests: ['page evaluate failed - page may have closed or navigated'],
        waitTimeMs: Date.now() - startTime,
        timedOut: false,
      };
    }
    await sleep(pollInterval);
  }

  return {
    success: false,
    readyState: lastReadyState,
    pendingRequests: lastPendingRequests.slice(0, 10),
    waitTimeMs: Date.now() - startTime,
    timedOut: true,
  };
}
