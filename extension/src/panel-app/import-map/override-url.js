/**
 * URL validation and preflight for import-map overrides.
 *
 * Allows JS, JSON, and any HTTP(S) resource consumable by
 * SystemJS / import maps. Rejects dangerous schemes and
 * detects HTML fallback responses (soft 404s).
 */
import { evalCmd } from "../../inspected-window.helper.js";

const DANGEROUS_SCHEMES = ["javascript:", "data:", "file:"];
const MAX_URL_LENGTH = 4096;

/**
 * Validate a URL string without network I/O.
 *
 * @param {string} url  raw input
 * @param {string} pageOrigin  for resolving relative URLs
 * @returns {{ valid: boolean, resolved: string|null, error?: string }}
 */
export function validateOverrideUrl(url, pageOrigin) {
  if (!url || typeof url !== "string") {
    return { valid: false, resolved: null, error: "URL is required" };
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return { valid: false, resolved: null, error: "URL is required" };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { valid: false, resolved: null, error: `URL exceeds ${MAX_URL_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed, pageOrigin || undefined);
  } catch {
    return { valid: false, resolved: null, error: "Invalid URL" };
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    return { valid: false, resolved: null, error: `Scheme "${proto}" is not allowed` };
  }

  for (const scheme of DANGEROUS_SCHEMES) {
    if (trimmed.toLowerCase().startsWith(scheme)) {
      return { valid: false, resolved: null, error: `Scheme "${scheme}" is not allowed` };
    }
  }

  return { valid: true, resolved: parsed.href };
}

/**
 * Name validation.
 * @param {string} name
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateImportName(name) {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Name is required" };
  }
  if (name.length > 512) {
    return { valid: false, error: "Name exceeds 512 characters" };
  }
  return { valid: true };
}

/**
 * Preflight a URL on the inspected page (using page-context fetch).
 * Detects HTTP errors, CORS failures, and HTML fallback (soft 404).
 *
 * @param {string} url  absolute URL
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function preflightUrl(url) {
  try {
    const resultJson = await evalCmd(`(async function() {
      var url = ${JSON.stringify(url)};
      try {
        var resp = await fetch(url, { method: "HEAD", mode: "cors", cache: "no-store" });
        if (resp.status === 405) {
          resp = await fetch(url, { method: "GET", mode: "cors", cache: "no-store" });
        }
        if (!resp.ok) {
          return JSON.stringify({ ok: false, error: "HTTP " + resp.status });
        }
        var ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("text/html")) {
          return JSON.stringify({ ok: false, error: "Response is HTML (possible soft-404 fallback)" });
        }
        // For GET responses, also check body start
        if (resp.bodyUsed === false && resp.body) {
          try {
            var reader = resp.body.getReader();
            var chunk = await reader.read();
            reader.cancel();
            if (chunk.value) {
              var text = new TextDecoder().decode(chunk.value.slice(0, 100)).trim().toLowerCase();
              if (text.startsWith("<!doctype") || text.startsWith("<html")) {
                return JSON.stringify({ ok: false, error: "Response body starts with HTML (soft-404)" });
              }
            }
          } catch(e) { /* body check best-effort */ }
        }
        return JSON.stringify({ ok: true });
      } catch (e) {
        if (e.name === "TypeError") {
          return JSON.stringify({ ok: false, error: "Network/CORS error: " + e.message });
        }
        return JSON.stringify({ ok: false, error: e.message || String(e) });
      }
    })()`);

    return typeof resultJson === "string" ? JSON.parse(resultJson) : resultJson;
  } catch (err) {
    return { ok: false, error: "Preflight failed: " + (err?.message || err) };
  }
}
