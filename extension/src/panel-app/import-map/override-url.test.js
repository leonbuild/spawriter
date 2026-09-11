/**
 * Tests for override-url.js validation (pure functions only; preflight needs browser).
 *
 * Run: node --test extension/src/panel-app/import-map/override-url.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateOverrideUrl, validateImportName } from "./override-url.js";

const ORIGIN = "https://dev-journal.aifed.cn";

describe("validateOverrideUrl", () => {
  it("U14: JSON URL is valid", () => {
    const r = validateOverrideUrl("/i18n/i18n.json", ORIGIN);
    assert.equal(r.valid, true);
    assert.equal(r.resolved, "https://dev-journal.aifed.cn/i18n/i18n.json");
  });

  it("U15: root-relative URL resolves with page origin", () => {
    const r = validateOverrideUrl("/app/main/app.js", ORIGIN);
    assert.equal(r.valid, true);
    assert.equal(r.resolved, "https://dev-journal.aifed.cn/app/main/app.js");
  });

  it("absolute https URL is valid", () => {
    const r = validateOverrideUrl("https://cdn.example.com/lib.js", ORIGIN);
    assert.equal(r.valid, true);
  });

  it("absolute http URL is valid", () => {
    const r = validateOverrideUrl("http://localhost:8080/app.js", ORIGIN);
    assert.equal(r.valid, true);
  });

  it("U16: javascript: URL is rejected", () => {
    const r = validateOverrideUrl("javascript:alert(1)", ORIGIN);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes("javascript:"));
  });

  it("data: URL is rejected", () => {
    const r = validateOverrideUrl("data:text/javascript,void(0)", ORIGIN);
    assert.equal(r.valid, false);
  });

  it("file: URL is rejected", () => {
    const r = validateOverrideUrl("file:///etc/passwd", ORIGIN);
    assert.equal(r.valid, false);
  });

  it("empty URL is rejected", () => {
    const r = validateOverrideUrl("", ORIGIN);
    assert.equal(r.valid, false);
  });

  it("whitespace-only URL is rejected", () => {
    const r = validateOverrideUrl("   ", ORIGIN);
    assert.equal(r.valid, false);
  });

  it("URL exceeding 4096 chars is rejected", () => {
    const r = validateOverrideUrl("https://x.com/" + "a".repeat(4100), ORIGIN);
    assert.equal(r.valid, false);
  });
});

describe("validateImportName", () => {
  it("valid scoped name", () => {
    assert.equal(validateImportName("@cnic/main").valid, true);
  });

  it("valid bare name", () => {
    assert.equal(validateImportName("single-spa").valid, true);
  });

  it("empty name is rejected", () => {
    assert.equal(validateImportName("").valid, false);
  });

  it("name over 512 chars is rejected", () => {
    assert.equal(validateImportName("a".repeat(513)).valid, false);
  });
});
