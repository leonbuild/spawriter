export function buildDashboardStateCode(appName?: string): string {
  const targetAppName = typeof appName === 'string' && appName.trim().length > 0
    ? JSON.stringify(appName.trim())
    : 'null';

  return `(function(requestedAppName) {
    var devtools = window.__SINGLE_SPA_DEVTOOLS__;
    var exposedMethods = devtools && devtools.exposedMethods;
    var hasSingleSpaDevtools = !!(exposedMethods && typeof exposedMethods.getRawAppData === 'function');
    var rawApps = hasSingleSpaDevtools ? (exposedMethods.getRawAppData() || []) : [];
    var imo = window.importMapOverrides;
    var overrideMap = imo && typeof imo.getOverrideMap === 'function' ? imo.getOverrideMap() : null;
    var overrides = overrideMap && overrideMap.imports ? overrideMap.imports : {};
    var apps = Array.isArray(rawApps) ? rawApps.map(function(app) {
      var ad = app.devtools || {};
      var name = app.name || '';
      var overrideUrl = overrides[name] || null;
      return { name: name, status: app.status || 'UNKNOWN', overrideUrl: overrideUrl, activeWhenForced: ad.activeWhenForced || null, hasOverlays: !!ad.overlays };
    }) : [];
    var activeOverrides = {};
    for (var key in overrides) { activeOverrides[key] = overrides[key]; }
    return JSON.stringify({
      pageUrl: location.href,
      hasSingleSpaDevtools: hasSingleSpaDevtools,
      hasImportMapOverrides: !!imo,
      appCount: apps.length,
      activeOverrides: activeOverrides,
      apps: apps
    });
  })(${targetAppName})`;
}

export function buildOverrideCode(action: string, appName?: string, url?: string): { code: string; error?: string } {
  switch (action) {
    case 'set':
      if (!appName || !url) {
        return { code: '', error: '"set" requires both appName and url' };
      }
      return { code: `(function() {
        if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
        window.importMapOverrides.addOverride(${JSON.stringify(appName)}, ${JSON.stringify(url)});
        return JSON.stringify({ success: true, action: 'set', appName: ${JSON.stringify(appName)}, url: ${JSON.stringify(url)} });
      })()` };
    case 'remove':
      if (!appName) {
        return { code: '', error: '"remove" requires appName' };
      }
      return { code: `(function() {
        if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
        window.importMapOverrides.removeOverride(${JSON.stringify(appName)});
        return JSON.stringify({ success: true, action: 'remove', appName: ${JSON.stringify(appName)} });
      })()` };
    case 'enable':
      if (!appName) {
        return { code: '', error: '"enable" requires appName' };
      }
      return { code: `(function() {
        if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
        window.importMapOverrides.enableOverride(${JSON.stringify(appName)});
        return JSON.stringify({ success: true, action: 'enable', appName: ${JSON.stringify(appName)} });
      })()` };
    case 'disable':
      if (!appName) {
        return { code: '', error: '"disable" requires appName' };
      }
      return { code: `(function() {
        if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
        window.importMapOverrides.disableOverride(${JSON.stringify(appName)});
        return JSON.stringify({ success: true, action: 'disable', appName: ${JSON.stringify(appName)} });
      })()` };
    case 'reset_all':
      return { code: `(function() {
        if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
        window.importMapOverrides.resetOverrides();
        return JSON.stringify({ success: true, action: 'reset_all' });
      })()` };
    default:
      return { code: '', error: `unknown action "${action}". Use: set, remove, enable, disable, reset_all` };
  }
}

export function buildAppActionCode(action: string, appName: string): string {
  return `(async function() {
    var singleSpa = window.__SINGLE_SPA_DEVTOOLS__;
    var exposedMethods = singleSpa && singleSpa.exposedMethods;
    if (!exposedMethods) return JSON.stringify({ success: false, error: 'single-spa devtools not available' });

    var rawApps = exposedMethods.getRawAppData() || [];
    var app = rawApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
    if (!app) return JSON.stringify({ success: false, error: 'App not found: ${appName.replace(/'/g, "\\'")}' });

    var action = ${JSON.stringify(action)};
    try {
      if (action === 'mount') {
        if (typeof app.devtools?.activeWhenForced === 'function') {
          app.devtools.activeWhenForced(true);
        }
        await exposedMethods.reroute();
      } else if (action === 'unmount') {
        if (typeof app.devtools?.activeWhenForced === 'function') {
          app.devtools.activeWhenForced(false);
        }
        await exposedMethods.reroute();
      } else if (action === 'unload') {
        if (typeof exposedMethods.toLoadPromise === 'function') {
          await exposedMethods.unregisterApplication(${JSON.stringify(appName)});
        }
        await exposedMethods.reroute();
      }
      var updatedApps = exposedMethods.getRawAppData() || [];
      var updatedApp = updatedApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
      return JSON.stringify({ success: true, action: action, appName: ${JSON.stringify(appName)}, newStatus: updatedApp ? updatedApp.status : 'UNKNOWN' });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message || String(e) });
    }
  })()`;
}

export function buildOverrideVerifyCode(appName: string): string {
  return `(function() {
    var imo = window.importMapOverrides;
    if (!imo || typeof imo.getOverrideMap !== 'function') return JSON.stringify({ present: false, reason: 'importMapOverrides not available' });
    var overrideMap = imo.getOverrideMap();
    var imports = overrideMap && overrideMap.imports ? overrideMap.imports : {};
    var url = imports[${JSON.stringify(appName)}] || null;
    var lsKey = 'import-map-override:' + ${JSON.stringify(appName)};
    var lsVal = null;
    try { lsVal = localStorage.getItem(lsKey); } catch(e) {}
    return JSON.stringify({ present: !!url, url: url, localStorageKey: lsKey, localStorageValue: lsVal });
  })()`;
}

export interface OverrideState {
  [key: string]: string;
}

export function detectOverrideChanges(
  pageOverrides: OverrideState,
  savedOverrides: OverrideState,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of Object.keys(pageOverrides)) {
    if (!(key in savedOverrides)) {
      added.push(key);
    } else if (pageOverrides[key] !== savedOverrides[key]) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(savedOverrides)) {
    if (!(key in pageOverrides)) {
      removed.push(key);
    }
  }
  return { added, removed, changed };
}

export function importPageOverrides(
  pageOverrides: OverrideState,
  savedOverrides: OverrideState,
): OverrideState {
  return { ...savedOverrides, ...pageOverrides };
}
