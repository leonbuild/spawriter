/**
 * Tests for override-storage.js pure functions.
 * (Storage read/write tests require browser.storage.local mock — covered in
 * existing useImportMapOverrides.test.js. Here we test export/import parsing.)
 *
 * Run: node --test extension/src/panel-app/import-map/override-storage.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeStorageKey, buildExportData, parseImportData } from "./override-storage.js";

describe("makeStorageKey", () => {
  it("origin-prefixed key", () => {
    assert.equal(makeStorageKey("https://example.com"), "savedOverrides:https://example.com");
  });
  it("null origin falls back to global", () => {
    assert.equal(makeStorageKey(null), "savedOverrides");
  });
  it("empty origin falls back to global", () => {
    assert.equal(makeStorageKey(""), "savedOverrides");
  });
});

describe("buildExportData", () => {
  it("merges saved and active overrides into v2 format", () => {
    const saved = {
      "@journal/edit": { url: "http://localhost:9130/app.js", enabled: false },
    };
    const active = {
      "single-spa": "/js/single-spa.dev.js",
    };
    const result = buildExportData("https://example.com", saved, active);
    assert.equal(result.version, 2);
    assert.equal(result.origin, "https://example.com");
    assert.equal(result.overrides["@journal/edit"].url, "http://localhost:9130/app.js");
    assert.equal(result.overrides["@journal/edit"].enabled, false);
    assert.equal(result.overrides["single-spa"].url, "/js/single-spa.dev.js");
    assert.equal(result.overrides["single-spa"].enabled, true);
  });

  it("prefers saved URL over active URL", () => {
    const saved = { "@org/x": { url: "http://saved.js", enabled: true } };
    const active = { "@org/x": "http://active.js" };
    const result = buildExportData("https://example.com", saved, active);
    assert.equal(result.overrides["@org/x"].url, "http://saved.js");
  });
});

describe("parseImportData", () => {
  it("parses v1 format {name: url}", () => {
    const json = JSON.stringify({ "@org/x": "http://x.js", "@org/y": "http://y.js" });
    const result = parseImportData(json);
    assert.ok(!result.error);
    assert.equal(result.version, 1);
    assert.equal(result.overrides["@org/x"].url, "http://x.js");
    assert.equal(result.overrides["@org/x"].enabled, false);
  });

  it("parses v2 format", () => {
    const json = JSON.stringify({
      version: 2,
      origin: "https://example.com",
      overrides: {
        "single-spa": { url: "/js/single-spa.min.js", enabled: true },
        "@org/y": { url: "http://y.js", enabled: false },
      },
    });
    const result = parseImportData(json);
    assert.ok(!result.error);
    assert.equal(result.version, 2);
    assert.equal(result.overrides["single-spa"].enabled, true);
    assert.equal(result.overrides["@org/y"].enabled, false);
  });

  it("skips empty URLs", () => {
    const json = JSON.stringify({ "@org/x": "", "@org/y": "http://y.js" });
    const result = parseImportData(json);
    assert.ok(!result.error);
    assert.equal(result.skipped.length, 1);
    assert.equal(Object.keys(result.overrides).length, 1);
  });

  it("skips non-string values in v1", () => {
    const json = JSON.stringify({ "@org/x": 123, "@org/y": "http://y.js" });
    const result = parseImportData(json);
    assert.ok(!result.error);
    assert.deepEqual(result.skipped, ["@org/x"]);
  });

  it("rejects javascript: URLs", () => {
    const json = JSON.stringify({ "@org/x": "javascript:alert(1)" });
    const result = parseImportData(json);
    assert.ok(result.error); // no valid entries
  });

  it("returns error for invalid JSON", () => {
    assert.ok(parseImportData("{bad json").error);
  });

  it("returns error for array", () => {
    assert.ok(parseImportData("[]").error);
  });

  it("returns error when all entries are invalid", () => {
    const json = JSON.stringify({ "": "http://x.js" });
    assert.ok(parseImportData(json).error);
  });

  it("S01: preserves bare-name dependency in v2 import", () => {
    const json = JSON.stringify({
      version: 2,
      overrides: {
        "single-spa": { url: "/js/single-spa.min.js", enabled: true },
        axios: { url: "/js/axios.min.js", enabled: false },
      },
    });
    const result = parseImportData(json);
    assert.ok(!result.error);
    assert.ok(result.overrides["single-spa"]);
    assert.ok(result.overrides["axios"]);
  });
});
