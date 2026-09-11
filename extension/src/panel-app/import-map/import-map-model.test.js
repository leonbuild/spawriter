/**
 * Unit tests for import-map-model.js pure functions.
 *
 * Covers classification, union building, sorting, drift detection,
 * orphan visibility, and scopes warning.
 *
 * Run: node --test extension/src/panel-app/import-map/import-map-model.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyImportName,
  buildImportEntries,
  sortEntries,
  countActiveDependencies,
  splitByKind,
  detectScopes,
} from "./import-map-model.js";

// -- Fixture: snapshot matching the live dev-journal page (15 imports) --

const LIVE_DEFAULT_IMPORTS = {
  "single-spa": "/js/single-spa.min.js",
  "single-spa-vue": "/js/single-spa-vue.js",
  axios: "/js/axios.min.js",
  "core-js": "/js/core-js-index.js",
  moment: "/js/moment.min.js",
  "@cnic/i18n": "/i18n/i18n.json",
  "@cnic/site-setting": "/config/config.json",
  "@cnic/root-config": "/cnic-root-config.js",
  "@cnic/main": "/app/main/app.js",
  "@journal/submit": "/app/submit/app.js",
  "@journal/review": "/app/review/app.js",
  "@journal/proofread": "/app/proofread/app.js",
  "@journal/edit": "/app/edit/app.js",
  "@journal/publish": "/app/publish/app.js",
  "@journal/manage": "/app/manage/app.js",
};

const LIVE_REGISTERED_APPS = [
  { name: "@cnic/main", status: "MOUNTED" },
  { name: "@journal/edit", status: "NOT_MOUNTED" },
  { name: "@journal/manage", status: "MOUNTED" },
  { name: "@journal/proofread", status: "NOT_LOADED" },
  { name: "@journal/publish", status: "NOT_LOADED" },
  { name: "@journal/review", status: "NOT_LOADED" },
  { name: "@journal/submit", status: "NOT_LOADED" },
];

function liveSnapshot(overrides = {}) {
  return {
    defaultImports: LIVE_DEFAULT_IMPORTS,
    activeOverrides: overrides,
    registeredApps: LIVE_REGISTERED_APPS,
  };
}

// ===== U01–U04: classification =====

describe("classifyImportName", () => {
  it("U01: @cnic/main → app", () => {
    assert.equal(classifyImportName("@cnic/main"), "app");
  });

  it("U02: @cnic/i18n → app (even if not registered)", () => {
    assert.equal(classifyImportName("@cnic/i18n"), "app");
  });

  it("U03: single-spa → dependency", () => {
    assert.equal(classifyImportName("single-spa"), "dependency");
  });

  it("U04: single-spa-vue → dependency", () => {
    assert.equal(classifyImportName("single-spa-vue"), "dependency");
  });

  it("axios → dependency", () => {
    assert.equal(classifyImportName("axios"), "dependency");
  });

  it("core-js → dependency", () => {
    assert.equal(classifyImportName("core-js"), "dependency");
  });

  it("moment → dependency", () => {
    assert.equal(classifyImportName("moment"), "dependency");
  });
});

// ===== U05: merged count =====

describe("buildImportEntries — live page fixture", () => {
  it("U05: 15 default imports → 7 registered app + 8 dependency (3 reclassified)", () => {
    const entries = buildImportEntries(liveSnapshot(), {});
    assert.equal(entries.length, 15);
    const apps = entries.filter((e) => e.kind === "app");
    const deps = entries.filter((e) => e.kind === "dependency");
    assert.equal(apps.length, 7, "only registered scoped packages stay as app");
    assert.equal(deps.length, 8, "5 bare-name + 3 unregistered scoped");
  });

  it("registered apps have lifecycle status", () => {
    const entries = buildImportEntries(liveSnapshot(), {});
    const main = entries.find((e) => e.name === "@cnic/main");
    assert.equal(main.registered, true);
    assert.equal(main.lifecycleStatus, "MOUNTED");
  });

  it("unregistered scoped import reclassified to dependency", () => {
    const entries = buildImportEntries(liveSnapshot(), {});
    const i18n = entries.find((e) => e.name === "@cnic/i18n");
    assert.equal(i18n.registered, false);
    assert.equal(i18n.lifecycleStatus, null);
    assert.equal(i18n.kind, "dependency", "unregistered scoped → dependency");
  });
});

// ===== U06–U08: orphan entries =====

describe("buildImportEntries — orphan entries", () => {
  it("U06: name only in activeOverrides → active-only orphan", () => {
    const snap = {
      defaultImports: {},
      activeOverrides: { "@org/ghost": "http://ghost.js" },
      registeredApps: [],
    };
    const entries = buildImportEntries(snap, {});
    const ghost = entries.find((e) => e.name === "@org/ghost");
    assert.ok(ghost);
    assert.equal(ghost.sourceState, "active-only");
    assert.equal(ghost.actualEnabled, true);
  });

  it("U07: name only in savedOverrides → saved-only orphan", () => {
    const snap = { defaultImports: {}, activeOverrides: {}, registeredApps: [] };
    const saved = { "@org/old": { url: "http://old.js", enabled: false } };
    const entries = buildImportEntries(snap, saved);
    const old = entries.find((e) => e.name === "@org/old");
    assert.ok(old);
    assert.equal(old.sourceState, "saved-only");
  });

  it("U08: name only in registeredApps → registered-only", () => {
    const snap = {
      defaultImports: {},
      activeOverrides: {},
      registeredApps: [{ name: "@org/dynamic", status: "MOUNTED" }],
    };
    const entries = buildImportEntries(snap, {});
    const dyn = entries.find((e) => e.name === "@org/dynamic");
    assert.ok(dyn);
    assert.equal(dyn.sourceState, "registered-only");
    assert.equal(dyn.registered, true);
  });
});

// ===== U09–U11: sync status =====

describe("buildImportEntries — sync status", () => {
  it("U09: saved enabled=false, actual absent → synced", () => {
    const snap = { defaultImports: {}, activeOverrides: {}, registeredApps: [] };
    const saved = { "@org/x": { url: "http://x.js", enabled: false } };
    const entries = buildImportEntries(snap, saved);
    assert.equal(entries[0].syncStatus, "synced");
    assert.equal(entries[0].actualEnabled, false);
  });

  it("U10: saved enabled=true, actual absent → drift", () => {
    const snap = { defaultImports: {}, activeOverrides: {}, registeredApps: [] };
    const saved = { "@org/x": { url: "http://x.js", enabled: true } };
    const entries = buildImportEntries(snap, saved);
    assert.equal(entries[0].syncStatus, "drift");
    assert.equal(entries[0].actualEnabled, false);
  });

  it("U11: saved URL ≠ actual URL → drift", () => {
    const snap = {
      defaultImports: {},
      activeOverrides: { "@org/x": "http://actual.js" },
      registeredApps: [],
    };
    const saved = { "@org/x": { url: "http://saved.js", enabled: true } };
    const entries = buildImportEntries(snap, saved);
    const x = entries[0];
    assert.equal(x.syncStatus, "drift");
    assert.equal(x.activeOverrideUrl, "http://actual.js");
    assert.equal(x.savedUrl, "http://saved.js");
  });

  it("saved URL = actual URL, both enabled → synced", () => {
    const snap = {
      defaultImports: {},
      activeOverrides: { "@org/x": "http://same.js" },
      registeredApps: [],
    };
    const saved = { "@org/x": { url: "http://same.js", enabled: true } };
    const entries = buildImportEntries(snap, saved);
    assert.equal(entries[0].syncStatus, "synced");
  });
});

// ===== U12–U13: dependency folding =====

describe("countActiveDependencies", () => {
  it("U13: no active dependency override → 0", () => {
    const entries = buildImportEntries(liveSnapshot(), {});
    assert.equal(countActiveDependencies(entries), 0);
  });

  it("U12: 1 active dependency → 1", () => {
    const entries = buildImportEntries(
      liveSnapshot({ "single-spa": "/js/single-spa.dev.js" }),
      {}
    );
    assert.equal(countActiveDependencies(entries), 1);
  });
});

// ===== U14–U17: URL validation is in override-url.js, tested separately =====

// ===== U18: scopes warning =====

describe("detectScopes", () => {
  it("U18: non-empty scopes → warning", () => {
    const result = detectScopes({ "https://example.com/": { lodash: "/lodash.js" } });
    assert.equal(result.hasScopes, true);
    assert.equal(result.count, 1);
  });

  it("empty scopes → no warning", () => {
    assert.deepEqual(detectScopes({}), { hasScopes: false, count: 0 });
  });

  it("null/undefined → no warning", () => {
    assert.deepEqual(detectScopes(null), { hasScopes: false, count: 0 });
    assert.deepEqual(detectScopes(undefined), { hasScopes: false, count: 0 });
  });
});

// ===== sorting =====

describe("sortEntries", () => {
  it("apps before dependencies, alpha within each group", () => {
    const entries = buildImportEntries(liveSnapshot(), {});
    const sorted = sortEntries(entries);
    const kinds = sorted.map((e) => e.kind);
    const firstDepIdx = kinds.indexOf("dependency");
    const lastAppIdx = kinds.lastIndexOf("app");
    assert.ok(lastAppIdx < firstDepIdx, "all apps should come before all deps");

    const appNames = sorted.filter((e) => e.kind === "app").map((e) => e.name);
    const depNames = sorted.filter((e) => e.kind === "dependency").map((e) => e.name);
    assert.deepEqual(appNames, [...appNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    assert.deepEqual(depNames, [...depNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  });
});

// ===== splitByKind =====

describe("splitByKind", () => {
  it("splits 15 entries into 7 apps and 8 deps", () => {
    const sorted = sortEntries(buildImportEntries(liveSnapshot(), {}));
    const { apps, deps } = splitByKind(sorted);
    assert.equal(apps.length, 7, "only registered scoped packages");
    assert.equal(deps.length, 8, "5 bare-name + 3 unregistered scoped");
  });
});

// ===== actualEnabled uses hasOwnProperty =====

describe("actualEnabled uses property existence, not URL truthiness", () => {
  it("empty-string override URL is still actualEnabled=true", () => {
    const snap = {
      defaultImports: {},
      activeOverrides: { "@org/x": "" },
      registeredApps: [],
    };
    const entries = buildImportEntries(snap, {});
    assert.equal(entries[0].actualEnabled, true);
  });
});

// ===== effectiveUrl =====

describe("effectiveUrl", () => {
  it("uses activeOverrideUrl when override is active", () => {
    const snap = {
      defaultImports: { "@org/x": "/default.js" },
      activeOverrides: { "@org/x": "/override.js" },
      registeredApps: [],
    };
    const entries = buildImportEntries(snap, {});
    assert.equal(entries[0].effectiveUrl, "/override.js");
  });

  it("falls back to defaultUrl when no override", () => {
    const snap = {
      defaultImports: { "@org/x": "/default.js" },
      activeOverrides: {},
      registeredApps: [],
    };
    const entries = buildImportEntries(snap, {});
    assert.equal(entries[0].effectiveUrl, "/default.js");
  });
});
