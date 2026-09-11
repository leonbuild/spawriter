/**
 * Page-level operations for import-map overrides.
 *
 * Reads a consistent snapshot in a single evalCmd, and wraps
 * addOverride / removeOverride with JSON.stringify-safe interpolation.
 */
import { evalCmd, ProtocolError } from "../../inspected-window.helper.js";

/**
 * Read a consistent import-map snapshot from the inspected page.
 * All data is gathered in one evaluation to avoid cross-change skew.
 *
 * @returns {Promise<ImportMapSnapshot|null>}
 */
export async function readImportMapSnapshot() {
  try {
    // Phase 1: synchronous data (override map, registered apps)
    const syncRaw = await evalCmd(`(function () {
      var imo = window.importMapOverrides;
      var devtools = window.__SINGLE_SPA_DEVTOOLS__ && window.__SINGLE_SPA_DEVTOOLS__.exposedMethods;
      if (!imo) return JSON.stringify({ available: false });

      var overrideMap = typeof imo.getOverrideMap === "function" ? imo.getOverrideMap() : { imports: {}, scopes: {} };
      var registeredApps = devtools && typeof devtools.getRawAppData === "function" ? (devtools.getRawAppData() || []) : [];
      var hasGetDefaultMap = typeof imo.getDefaultMap === "function";

      return JSON.stringify({
        available: true,
        pageUrl: location.href,
        origin: location.origin,
        hasGetDefaultMap: hasGetDefaultMap,
        activeOverrides: (overrideMap && overrideMap.imports) || {},
        overrideScopes: (overrideMap && overrideMap.scopes) || {},
        registeredApps: registeredApps.map(function (app) {
          return { name: app.name, status: app.status, devtools: app.devtools || {} };
        })
      });
    })()`);

    if (!syncRaw) return null;
    const syncData = typeof syncRaw === "string" ? JSON.parse(syncRaw) : syncRaw;
    if (!syncData || syncData.available === false) return null;

    // Phase 2: async getDefaultMap — store result in a page global, then read back
    let defaultImports = {};
    let effectiveImports = {};
    if (syncData.hasGetDefaultMap) {
      try {
        await evalCmd(`(function() {
          var imo = window.importMapOverrides;
          Promise.all([
            typeof imo.getDefaultMap === "function" ? imo.getDefaultMap() : Promise.resolve(null),
            typeof imo.getCurrentPageMap === "function" ? imo.getCurrentPageMap() : Promise.resolve(null)
          ]).then(function(results) {
            window.__spawriter_defaultMap = results[0];
            window.__spawriter_currentPageMap = results[1];
          }).catch(function() {
            window.__spawriter_defaultMap = null;
            window.__spawriter_currentPageMap = null;
          });
        })()`);
        // Wait briefly for the promise to resolve
        await new Promise((r) => setTimeout(r, 200));
        const mapRaw = await evalCmd(`(function() {
          var dm = window.__spawriter_defaultMap;
          var cm = window.__spawriter_currentPageMap;
          delete window.__spawriter_defaultMap;
          delete window.__spawriter_currentPageMap;
          return JSON.stringify({
            defaultImports: (dm && dm.imports) || {},
            effectiveImports: (cm && cm.imports) || {}
          });
        })()`);
        if (mapRaw) {
          const maps = typeof mapRaw === "string" ? JSON.parse(mapRaw) : mapRaw;
          defaultImports = maps.defaultImports || {};
          effectiveImports = maps.effectiveImports || {};
        }
      } catch {
        // Fall through with empty defaults
      }
    }

    return {
      available: true,
      pageUrl: syncData.pageUrl,
      origin: syncData.origin,
      defaultImports,
      activeOverrides: syncData.activeOverrides || {},
      effectiveImports,
      overrideScopes: syncData.overrideScopes || {},
      registeredApps: syncData.registeredApps || [],
    };
  } catch (err) {
    if (err instanceof ProtocolError) {
      console.debug("[spawriter] Recoverable error during readImportMapSnapshot:", err.message);
      return null;
    }
    throw err;
  }
}

/**
 * Check whether importMapOverrides is available on the page.
 * @returns {Promise<boolean>}
 */
export async function checkImportMapAvailable() {
  try {
    return await evalCmd(`!!(window.importMapOverrides && window.importMapOverrides.addOverride && window.importMapOverrides.removeOverride)`);
  } catch {
    return false;
  }
}

/**
 * Wait until importMapOverrides is ready (up to maxWaitMs).
 * @param {number} maxWaitMs
 * @returns {Promise<boolean>}
 */
export async function waitForImportMapReady(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start <= maxWaitMs) {
    if (await checkImportMapAvailable()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Add an import-map override on the inspected page.
 * Uses JSON.stringify for safe interpolation.
 *
 * @param {string} name
 * @param {string} url
 * @returns {Promise<boolean>} true on success
 */
export async function addOverride(name, url) {
  try {
    const ready = await waitForImportMapReady(3000);
    if (!ready) return false;
    await evalCmd(`(function() {
      window.importMapOverrides.addOverride(${JSON.stringify(name)}, ${JSON.stringify(url)});
    })()`);
    return true;
  } catch (err) {
    console.warn("[spawriter] addOverride failed:", err?.message);
    return false;
  }
}

/**
 * Remove an import-map override from the inspected page.
 *
 * @param {string} name
 * @returns {Promise<boolean>} true on success
 */
export async function removeOverride(name) {
  try {
    const ready = await waitForImportMapReady(3000);
    if (!ready) {
      await removeOverrideFromLocalStorage(name);
      return false;
    }
    await evalCmd(`(function() {
      window.importMapOverrides.removeOverride(${JSON.stringify(name)});
    })()`);
    return true;
  } catch (err) {
    console.warn("[spawriter] removeOverride failed:", err?.message);
    await removeOverrideFromLocalStorage(name);
    return false;
  }
}

/**
 * Fallback: directly remove the localStorage key used by import-map-overrides.
 * @param {string} name
 */
export async function removeOverrideFromLocalStorage(name) {
  try {
    await evalCmd(`(function() {
      localStorage.removeItem(${JSON.stringify("import-map-override:" + name)});
    })()`);
  } catch (err) {
    console.warn("[spawriter] Failed to remove from localStorage:", err?.message);
  }
}

/**
 * Clear all import-map-override:* keys from inspected-page localStorage.
 */
export async function clearAllOverridesFromLocalStorage() {
  try {
    await evalCmd(`(function() {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf("import-map-override:") === 0) keys.push(key);
      }
      keys.forEach(function(k) { localStorage.removeItem(k); });
    })()`);
  } catch (err) {
    console.warn("[spawriter] Failed to clear all overrides from localStorage:", err?.message);
  }
}

/**
 * Read back the current override map from the page (single-field check).
 * @returns {Promise<Object<string,string>|null>}
 */
export async function getCurrentOverrideMap() {
  try {
    const result = await evalCmd(`(function() {
      if (!window.importMapOverrides) return null;
      var m = window.importMapOverrides.getOverrideMap();
      return (m && m.imports) || {};
    })()`);
    return result;
  } catch {
    return null;
  }
}
