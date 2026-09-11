/**
 * Origin-scoped saved-override storage.
 *
 * Pure functions (makeStorageKey, buildExportData, parseImportData, validation)
 * have no browser dependency and are directly testable in Node.
 *
 * Browser I/O functions (load/write/migrate) lazily import webextension-polyfill
 * so the module can be imported in Node for testing the pure surface.
 */

const STORAGE_SCHEMA_VERSION_KEY = "overrideStorageSchemaVersion";
const CURRENT_SCHEMA_VERSION = 2;
const MAX_NAME_LENGTH = 512;
const MAX_URL_LENGTH = 4096;
const DANGEROUS_SCHEMES = ["javascript:", "data:", "file:"];

/** @returns {import("webextension-polyfill").Browser} */
function getBrowser() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("webextension-polyfill");
}

/**
 * Origin-scoped storage key.
 * @param {string|null} origin
 * @returns {string}
 */
export function makeStorageKey(origin) {
  return origin ? `savedOverrides:${origin}` : "savedOverrides";
}

/**
 * Load saved overrides for a given origin.
 * @param {string|null} origin
 * @returns {Promise<Object<string, {url:string, enabled:boolean}>>}
 */
export async function loadSavedOverrides(origin) {
  const key = makeStorageKey(origin);
  const result = await getBrowser().storage.local.get(key);
  return result[key] || {};
}

/**
 * Write saved overrides for a given origin.
 * @param {string|null} origin
 * @param {Object<string, {url:string, enabled:boolean}>} overrides
 */
export async function writeSavedOverrides(origin, overrides) {
  await getBrowser().storage.local.set({ [makeStorageKey(origin)]: overrides });
}

/**
 * Run one-time migration: global key → origin-scoped key,
 * and fix records missing `enabled` field.
 * Does NOT delete bare-name entries (unlike previous code).
 *
 * @param {string} origin
 * @returns {Promise<Object|null>}  migrated data, or null if nothing to migrate
 */
export async function migrateStorage(origin) {
  const key = makeStorageKey(origin);
  const storage = getBrowser().storage.local;
  const [globalResult, scopedResult, versionResult] = await Promise.all([
    storage.get("savedOverrides"),
    storage.get(key),
    storage.get(STORAGE_SCHEMA_VERSION_KEY),
  ]);

  const currentVersion = versionResult[STORAGE_SCHEMA_VERSION_KEY] || 0;
  let migrated = null;

  // Phase 1: migrate global → scoped (if scoped is empty)
  if (
    !scopedResult[key] &&
    globalResult.savedOverrides &&
    Object.keys(globalResult.savedOverrides).length > 0
  ) {
    migrated = globalResult.savedOverrides;
    await storage.set({ [key]: migrated });
    await storage.remove("savedOverrides");
  }

  // Phase 2: fix records — add missing `enabled`, discard invalid entries
  const data = migrated || scopedResult[key];
  if (data && currentVersion < CURRENT_SCHEMA_VERSION) {
    const cleaned = {};
    for (const [name, record] of Object.entries(data)) {
      if (!isValidStorageEntry(name, record)) continue;
      cleaned[name] = {
        url: String(record.url || "").slice(0, MAX_URL_LENGTH),
        enabled: typeof record.enabled === "boolean" ? record.enabled : false,
      };
    }
    await storage.set({
      [key]: cleaned,
      [STORAGE_SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION,
    });
    return cleaned;
  }

  return migrated;
}

/**
 * Validate a single storage entry.
 */
function isValidStorageEntry(name, record) {
  if (typeof name !== "string" || !name || name.length > MAX_NAME_LENGTH) return false;
  if (!record || typeof record !== "object") return false;
  const url = record.url;
  if (typeof url !== "string") return false;
  if (url) {
    for (const scheme of DANGEROUS_SCHEMES) {
      if (url.toLowerCase().startsWith(scheme)) return false;
    }
  }
  return true;
}

/**
 * Build export data (v2 format) from entries.
 *
 * @param {string} origin
 * @param {Object<string, {url:string, enabled:boolean}>} savedOverrides
 * @param {Object<string, string>} activeOverrides  page-level overrides
 * @returns {{ version: number, origin: string, overrides: object }}
 */
export function buildExportData(origin, savedOverrides, activeOverrides) {
  const merged = {};
  const allNames = new Set([
    ...Object.keys(savedOverrides),
    ...Object.keys(activeOverrides),
  ]);
  for (const name of [...allNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const saved = savedOverrides[name];
    const activeUrl = activeOverrides[name];
    merged[name] = {
      url: saved?.url || activeUrl || "",
      enabled: activeUrl != null ? true : saved?.enabled || false,
    };
  }
  return { version: 2, origin, overrides: merged };
}

/**
 * Parse and validate import data (supports v1 `{name: url}` and v2 format).
 *
 * @param {string} jsonString  raw file content
 * @returns {{ overrides: Object<string, {url:string, enabled:boolean}>, skipped: string[], version: number } | { error: string }}
 */
export function parseImportData(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return { error: "Invalid JSON format" };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Must be an object" };
  }

  // v2 format: { version: 2, origin: "...", overrides: { ... } }
  if (data.version === 2 && data.overrides && typeof data.overrides === "object") {
    return parseOverrideEntries(data.overrides, 2);
  }

  // v1 format: { "name": "url" } or { "name": { url, enabled } }
  return parseOverrideEntries(data, 1);
}

function parseOverrideEntries(obj, version) {
  const overrides = {};
  const skipped = [];

  for (const [name, value] of Object.entries(obj)) {
    if (!name || typeof name !== "string" || name.length > MAX_NAME_LENGTH) {
      skipped.push(name);
      continue;
    }

    // v1: value is a string URL
    if (typeof value === "string") {
      const url = value.trim();
      if (!url) { skipped.push(name); continue; }
      if (url.length > MAX_URL_LENGTH || DANGEROUS_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) {
        skipped.push(name);
        continue;
      }
      overrides[name] = { url, enabled: false };
      continue;
    }

    // v2: value is { url, enabled }
    if (value && typeof value === "object" && typeof value.url === "string") {
      const url = value.url.trim();
      if (!url) { skipped.push(name); continue; }
      if (url.length > MAX_URL_LENGTH || DANGEROUS_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) {
        skipped.push(name);
        continue;
      }
      overrides[name] = { url, enabled: !!value.enabled };
      continue;
    }

    skipped.push(name);
  }

  if (Object.keys(overrides).length === 0) {
    return { error: "No valid entries found" };
  }

  return { overrides, skipped, version };
}
