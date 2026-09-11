export function buildDashboardStateCode(appName?: string): string {
  const targetAppName = typeof appName === 'string' && appName.trim().length > 0
    ? JSON.stringify(appName.trim())
    : 'null';

  // Unified snapshot: includes defaultImports, activeOverrides, classified entries
  return `(async function(requestedAppName) {
    var devtools = window.__SINGLE_SPA_DEVTOOLS__;
    var exposedMethods = devtools && devtools.exposedMethods;
    var hasSingleSpaDevtools = !!(exposedMethods && typeof exposedMethods.getRawAppData === 'function');
    var rawApps = hasSingleSpaDevtools ? (exposedMethods.getRawAppData() || []) : [];
    var imo = window.importMapOverrides;
    var hasIMO = !!(imo && typeof imo.getOverrideMap === 'function');
    var overrideMap = hasIMO ? imo.getOverrideMap() : { imports: {}, scopes: {} };
    var overrides = (overrideMap && overrideMap.imports) || {};
    var scopes = (overrideMap && overrideMap.scopes) || {};

    var defaultImports = {};
    if (hasIMO && typeof imo.getDefaultMap === 'function') {
      try { var dm = await imo.getDefaultMap(); defaultImports = (dm && dm.imports) || {}; } catch(e) {}
    }

    var allNames = {};
    var k;
    for (k in defaultImports) allNames[k] = true;
    for (k in overrides) allNames[k] = true;
    for (var i = 0; i < rawApps.length; i++) { if (rawApps[i].name) allNames[rawApps[i].name] = true; }

    var entries = [];
    for (var name in allNames) {
      var kind = /^@[^/]+\\/.+/.test(name) ? 'app' : 'dependency';
      var regApp = null;
      for (var j = 0; j < rawApps.length; j++) { if (rawApps[j].name === name) { regApp = rawApps[j]; break; } }
      entries.push({
        name: name,
        kind: kind,
        defaultUrl: defaultImports[name] || null,
        activeOverrideUrl: overrides.hasOwnProperty(name) ? overrides[name] : null,
        actualEnabled: overrides.hasOwnProperty(name),
        registered: !!regApp,
        lifecycleStatus: regApp ? (regApp.status || 'UNKNOWN') : null
      });
    }

    var apps = Array.isArray(rawApps) ? rawApps.map(function(app) {
      var ad = app.devtools || {};
      return { name: app.name || '', status: app.status || 'UNKNOWN', overrideUrl: overrides[app.name] || null, activeWhenForced: ad.activeWhenForced || null, hasOverlays: !!ad.overlays };
    }) : [];

    var activeOverrides = {};
    for (k in overrides) activeOverrides[k] = overrides[k];

    return JSON.stringify({
      pageUrl: location.href,
      hasSingleSpaDevtools: hasSingleSpaDevtools,
      hasImportMapOverrides: hasIMO,
      appCount: apps.length,
      defaultImports: defaultImports,
      activeOverrides: activeOverrides,
      overrideScopes: scopes,
      entries: entries,
      apps: apps
    });
  })(${targetAppName})`;
}

// All import names (scoped @org/name and bare names like "single-spa")
// can be overridden. The classification is used only for UI grouping.
function classifyImportName(name: string): 'app' | 'dependency' {
  return /^@[^/]+\/.+/.test(name) ? 'app' : 'dependency';
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
  return `(async function() {
    var imo = window.importMapOverrides;
    if (!imo || typeof imo.getOverrideMap !== 'function') return JSON.stringify({ present: false, reason: 'importMapOverrides not available' });
    var overrideMap = imo.getOverrideMap();
    var imports = overrideMap && overrideMap.imports ? overrideMap.imports : {};
    var url = imports[${JSON.stringify(appName)}] || null;
    var lsKey = 'import-map-override:' + ${JSON.stringify(appName)};
    var lsVal = null;
    try { lsVal = localStorage.getItem(lsKey); } catch(e) {}

    var preflight = null;
    if (url) {
      try {
        var resp = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
        if (resp.status === 405) resp = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
        var ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!resp.ok) { preflight = { ok: false, error: 'HTTP ' + resp.status }; }
        else if (ct.includes('text/html')) { preflight = { ok: false, error: 'Response is HTML (possible soft-404)' }; }
        else { preflight = { ok: true }; }
      } catch(e) { preflight = { ok: false, error: e.message || String(e) }; }
    }

    return JSON.stringify({ present: !!url, url: url, localStorageKey: lsKey, localStorageValue: lsVal, preflight: preflight });
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
