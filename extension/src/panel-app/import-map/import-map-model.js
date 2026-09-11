/**
 * Pure-function model for import-map override entries.
 *
 * Classifies import names, merges multiple data sources into a unified
 * row model, and computes derived state (drift, orphan, sync status).
 * No side-effects, no DOM, no React — testable with plain Node.
 */

/**
 * @param {string} name
 * @returns {"app"|"dependency"}
 */
export function classifyImportName(name) {
  return /^@[^/]+\/.+/.test(name) ? "app" : "dependency";
}

/**
 * Build a deduplicated, classified list of import entries from four sources.
 *
 * @param {{ defaultImports: Object<string,string>, activeOverrides: Object<string,string>, registeredApps: Array<{name:string, status:string, devtools?:object}> }} snapshot
 * @param {Object<string, {url:string, enabled:boolean}>} savedOverrides
 * @returns {ImportEntry[]}
 */
export function buildImportEntries(snapshot, savedOverrides) {
  const { defaultImports = {}, activeOverrides = {}, registeredApps = [] } = snapshot;
  const safe = savedOverrides && typeof savedOverrides === "object" ? savedOverrides : {};

  const names = new Set([
    ...Object.keys(defaultImports),
    ...Object.keys(activeOverrides),
    ...Object.keys(safe),
    ...registeredApps.map((a) => a.name),
  ]);

  const appsByName = new Map(registeredApps.map((a) => [a.name, a]));
  const entries = [];

  for (const name of names) {
    if (!name) continue;

    let kind = classifyImportName(name);
    const defaultUrl = defaultImports[name] ?? null;
    const savedRecord = safe[name];
    const savedUrl = savedRecord?.url ?? null;
    const activeOverrideUrl = Object.prototype.hasOwnProperty.call(activeOverrides, name)
      ? activeOverrides[name]
      : null;
    const desiredEnabled = !!(savedRecord?.enabled && savedUrl);
    const actualEnabled = Object.prototype.hasOwnProperty.call(activeOverrides, name);

    const effectiveUrl = actualEnabled ? activeOverrideUrl : defaultUrl;
    const regApp = appsByName.get(name);
    const registered = !!regApp;
    const lifecycleStatus = regApp?.status ?? null;

    const sourceState = deriveSourceState(name, defaultImports, activeOverrides, safe, appsByName);
    const syncStatus = deriveSyncStatus(desiredEnabled, actualEnabled, savedUrl, activeOverrideUrl);

    // Unregistered scoped packages are effectively shared dependencies
    if (kind === "app" && !registered) kind = "dependency";

    entries.push({
      name,
      kind,
      defaultUrl,
      savedUrl,
      activeOverrideUrl,
      effectiveUrl,
      desiredEnabled,
      actualEnabled,
      registered,
      lifecycleStatus,
      sourceState,
      syncStatus,
    });
  }

  return entries;
}

/**
 * Determine how the name was discovered.
 * @returns {"default"|"saved-only"|"active-only"|"registered-only"}
 */
function deriveSourceState(name, defaultImports, activeOverrides, savedOverrides, appsByName) {
  const inDefault = Object.prototype.hasOwnProperty.call(defaultImports, name);
  if (inDefault) return "default";

  const inActive = Object.prototype.hasOwnProperty.call(activeOverrides, name);
  const inSaved = Object.prototype.hasOwnProperty.call(savedOverrides, name);
  const inRegistered = appsByName.has(name);

  if (inSaved && !inActive && !inRegistered) return "saved-only";
  if (inActive && !inSaved && !inRegistered) return "active-only";
  if (inRegistered && !inActive && !inSaved) return "registered-only";

  // Present in multiple non-default sources — just default to "default"-like treatment
  return "default";
}

/**
 * @returns {"synced"|"drift"|"restoring"|"error"}
 */
function deriveSyncStatus(desiredEnabled, actualEnabled, savedUrl, activeOverrideUrl) {
  if (desiredEnabled === actualEnabled) {
    if (!actualEnabled) return "synced";
    // Both enabled — check URL match
    return savedUrl === activeOverrideUrl ? "synced" : "drift";
  }
  // Mismatch between desired and actual
  return "drift";
}

/**
 * Sort entries: apps first (alpha), then dependencies (alpha).
 * @param {ImportEntry[]} entries
 * @returns {ImportEntry[]}
 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "app" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Count active dependency overrides.
 * @param {ImportEntry[]} entries
 * @returns {number}
 */
export function countActiveDependencies(entries) {
  return entries.filter((e) => e.kind === "dependency" && e.actualEnabled).length;
}

/**
 * Split sorted entries into app and dependency groups.
 * @param {ImportEntry[]} entries  already-sorted entries
 * @returns {{ apps: ImportEntry[], deps: ImportEntry[] }}
 */
export function splitByKind(entries) {
  const apps = [];
  const deps = [];
  for (const e of entries) {
    (e.kind === "app" ? apps : deps).push(e);
  }
  return { apps, deps };
}

/**
 * Detect whether scopes exist in the override map (not yet editable).
 * @param {object} overrideScopes  `getOverrideMap().scopes`
 * @returns {{ hasScopes: boolean, count: number }}
 */
export function detectScopes(overrideScopes) {
  if (!overrideScopes || typeof overrideScopes !== "object") {
    return { hasScopes: false, count: 0 };
  }
  const count = Object.keys(overrideScopes).length;
  return { hasScopes: count > 0, count };
}
