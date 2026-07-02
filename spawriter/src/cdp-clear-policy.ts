// Policy: browser-wide data clearing is functionally unsupported.
//
// The relay drives the user's real Chrome profile, so a browser-wide clear
// wipes logins/cookies for every site the user is signed into — not just the
// tab under automation. This module is the single source of truth for which
// CDP clearing commands are forbidden and which origins a scoped clear may
// target. Enforced at every CDP ingress (relay WS clients, /cli/cdp,
// relaySendCdp) and mirrored in the extension bridge
// (extension/src/ai_bridge/clear-policy.js) as defense in depth.

/** CDP methods whose semantics are inherently browser-wide. Always denied. */
export const GLOBAL_CLEAR_CDP_METHODS: ReadonlySet<string> = new Set([
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  // Playwright's context.clearCookies() (with or without filters) lands here:
  // it is implemented as "clear ALL cookies, re-add the non-matching ones".
  'Storage.clearCookies',
]);

const SCOPED_ALTERNATIVES =
  'Use origin-scoped alternatives instead: storage("delete_cookie", {name, domain}), ' +
  'storage("clear_storage", {storage_types}), or clearCacheAndReload({clear}).';

/**
 * Returns a denial reason when the CDP command would clear data beyond the
 * current page origin, or null when the command is allowed.
 */
export function getCdpClearDenial(method: string, params?: Record<string, unknown>): string | null {
  if (GLOBAL_CLEAR_CDP_METHODS.has(method)) {
    return `${method} is blocked by spawriter: it wipes data for the whole browser profile, ` +
      `not just the automated tab. ${SCOPED_ALTERNATIVES}`;
  }
  if (method === 'Storage.clearDataForOrigin') {
    const origin = typeof params?.origin === 'string' ? params.origin : '';
    if (!isExactHttpOrigin(origin)) {
      return `Storage.clearDataForOrigin is blocked: "${origin}" is not a single http(s) origin. ` +
        `Wildcard or browser-wide clearing is not supported. ${SCOPED_ALTERNATIVES}`;
    }
  }
  return null;
}

/** True only for an exact http(s) origin string like "https://example.com:8080". */
export function isExactHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch {
    return false;
  }
}
