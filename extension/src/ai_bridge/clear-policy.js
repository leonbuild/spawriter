// Policy: browser-wide data clearing is functionally unsupported.
//
// The extension drives the user's real Chrome profile, so an unscoped clear
// wipes cookies/logins/service workers for every signed-in site, not just the
// automated tab. Mirror of spawriter/src/cdp-clear-policy.ts (relay side);
// the bridge enforces it again here as the last hop before chrome.debugger.
//
// Pure module: no imports, no browser globals — also imported by the Node
// test suite (spawriter/src/cdp-clear-policy.test.ts).

/** CDP methods whose semantics are inherently browser-wide. Always denied. */
export const GLOBAL_CLEAR_CDP_METHODS = new Set([
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  // Playwright's context.clearCookies() (with or without filters) lands here:
  // it is implemented as "clear ALL cookies, re-add the non-matching ones".
  "Storage.clearCookies",
]);

/** Returns a denial reason for browser-wide clear commands, else null. */
export function getGlobalClearDenial(method) {
  if (GLOBAL_CLEAR_CDP_METHODS.has(method)) {
    return (
      `${method} is blocked by spawriter: it wipes data for the whole browser profile, ` +
      "not just the automated tab. Use origin-scoped alternatives (storage/clearCacheAndReload helpers)."
    );
  }
  return null;
}

/**
 * Validates that a Storage.clearDataForOrigin request targets exactly the
 * tab's current origin. Returns a denial reason, else null.
 */
export function getClearDataForOriginDenial(requestedOrigin, tabUrl) {
  let tabOrigin = null;
  try {
    const url = new URL(tabUrl);
    if (url.protocol === "http:" || url.protocol === "https:") tabOrigin = url.origin;
  } catch (_) {
    /* not a parseable URL */
  }
  if (!tabOrigin) {
    return `Storage.clearDataForOrigin is blocked: cannot resolve an http(s) origin for the target tab (url: ${tabUrl}).`;
  }
  if (requestedOrigin !== tabOrigin) {
    return (
      `Storage.clearDataForOrigin is blocked: requested origin "${requestedOrigin}" does not match ` +
      `the tab's current origin "${tabOrigin}". Cross-origin clearing is not supported.`
    );
  }
  return null;
}

/**
 * Builds origin-scoped arguments for browser.browsingData.remove().
 *
 * Never returns unscoped removal options: when the platform cannot scope a
 * data type to the tab's origin, that type is dropped rather than cleared
 * globally (Firefox cannot origin-scope the HTTP cache; callers compensate
 * with a bypassCache reload).
 *
 * @param {string} tabUrl - URL of the tab whose origin is being cleared.
 * @param {{cache?: boolean, serviceWorkers?: boolean, cacheStorage?: boolean}} requestedDataTypes
 * @param {boolean} isFirefox
 * @returns {{removalOptions: object, dataTypes: object} | {error: string}}
 */
export function buildScopedBrowsingDataArgs(tabUrl, requestedDataTypes, isFirefox) {
  let origin;
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: `Cannot clear browsing data for non-http(s) tab (url: ${tabUrl}).` };
    }
    origin = url.origin;
  } catch (_) {
    return { error: `Cannot clear browsing data: invalid tab URL "${tabUrl}".` };
  }

  // Whitelist: cookie/history/password wipes are never allowed through this
  // path, whatever the caller asked for.
  const dataTypes = {};
  for (const key of ["cache", "serviceWorkers", "cacheStorage"]) {
    if (requestedDataTypes?.[key]) dataTypes[key] = true;
  }

  if (isFirefox) {
    // Firefox ignores Chrome's `origins` option (which would silently make the
    // call global) and cannot hostname-scope the HTTP cache at all.
    delete dataTypes.cache;
    if (Object.keys(dataTypes).length === 0) {
      return { error: "No origin-scopable data types requested (Firefox cannot scope the HTTP cache; use a bypassCache reload)." };
    }
    return {
      removalOptions: { since: 0, hostnames: [new URL(tabUrl).hostname] },
      dataTypes,
    };
  }

  if (Object.keys(dataTypes).length === 0) {
    return { error: "No allowed data types requested (allowed: cache, serviceWorkers, cacheStorage)." };
  }
  return {
    removalOptions: { since: 0, origins: [origin] },
    dataTypes,
  };
}
