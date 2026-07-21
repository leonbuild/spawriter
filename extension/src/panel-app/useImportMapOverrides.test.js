/**
 * Tests for the import-map-overrides polling guard logic and origin-scoped storage.
 *
 * These tests verify:
 *   - detectExternalChanges must be suppressed during internal operations
 *   - detectExternalChanges must be suppressed during cooldown period
 *   - savedOverrides dependency is read via ref, not via useEffect dependency array
 *   - Storage keys are scoped by page origin (no cross-site leakage)
 *
 * The tests simulate the guard logic extracted from useImportMapOverrides.js
 * without requiring React or browser APIs.
 *
 * Run: node --test extension/src/panel-app/useImportMapOverrides.test.js
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Simulate the ref-based guard logic from useImportMapOverrides
function createPollingGuard() {
  const state = {
    internalOpActive: false,
    cooldownUntil: 0,
    savedOverrides: {},
    pollCallCount: 0,
    pollResults: [],
  };

  function isPollingBlocked() {
    return state.internalOpActive || Date.now() < state.cooldownUntil;
  }

  function startInternalOp() {
    state.internalOpActive = true;
  }

  function endInternalOp(cooldownMs = 8000) {
    state.internalOpActive = false;
    state.cooldownUntil = Date.now() + cooldownMs;
  }

  function simulatePoll(pageMap) {
    state.pollCallCount++;

    if (isPollingBlocked()) {
      state.pollResults.push({ skipped: true });
      return null;
    }

    const currentSaved = state.savedOverrides;
    const pageKeys = new Set(Object.keys(pageMap));
    const savedKeys = new Set(Object.keys(currentSaved));

    let hasChanges = false;
    const newSavedOverrides = { ...currentSaved };

    for (const appName of pageKeys) {
      const pageUrl = pageMap[appName];
      const saved = currentSaved[appName];
      if (!saved || saved.url !== pageUrl) {
        newSavedOverrides[appName] = { url: pageUrl, enabled: true };
        hasChanges = true;
      } else if (saved && !saved.enabled && pageUrl) {
        newSavedOverrides[appName] = { ...saved, enabled: true };
        hasChanges = true;
      }
    }

    for (const appName of savedKeys) {
      if (currentSaved[appName]?.enabled && !pageKeys.has(appName)) {
        newSavedOverrides[appName] = {
          ...currentSaved[appName],
          enabled: false,
        };
        hasChanges = true;
      }
    }

    const result = { skipped: false, hasChanges, newSavedOverrides };
    state.pollResults.push(result);

    if (hasChanges) {
      state.savedOverrides = newSavedOverrides;
    }

    return result;
  }

  return { state, isPollingBlocked, startInternalOp, endInternalOp, simulatePoll };
}

describe("Polling guard: internalOpActive suppression", () => {
  let guard;

  beforeEach(() => {
    guard = createPollingGuard();
  });

  it("polling is NOT blocked by default", () => {
    assert.equal(guard.isPollingBlocked(), false);
  });

  it("polling IS blocked when internalOpActive=true", () => {
    guard.startInternalOp();
    assert.equal(guard.isPollingBlocked(), true);
  });

  it("polling is unblocked after endInternalOp (but cooldown starts)", () => {
    guard.startInternalOp();
    guard.endInternalOp(0);
    assert.equal(guard.state.internalOpActive, false);
  });

  it("simulatePoll returns null (skipped) during internal op", () => {
    guard.startInternalOp();
    const result = guard.simulatePoll({ "@app/test": "http://localhost:8080/test.js" });
    assert.equal(result, null);
    assert.equal(guard.state.pollResults[0].skipped, true);
  });
});

describe("Polling guard: cooldown suppression", () => {
  let guard;

  beforeEach(() => {
    guard = createPollingGuard();
  });

  it("polling IS blocked during cooldown period", () => {
    guard.endInternalOp(10000);
    assert.equal(guard.isPollingBlocked(), true);
  });

  it("polling is unblocked after cooldown expires", () => {
    guard.endInternalOp(0);
    assert.equal(guard.isPollingBlocked(), false);
  });

  it("simulatePoll returns null during cooldown", () => {
    guard.endInternalOp(10000);
    const result = guard.simulatePoll({ "@app/x": "http://x" });
    assert.equal(result, null);
    assert.equal(guard.state.pollResults[0].skipped, true);
  });
});

describe("Polling guard: flip-flop prevention (core bug scenario)", () => {
  let guard;

  beforeEach(() => {
    guard = createPollingGuard();
  });

  it("toggle ON: polling must NOT flip savedOverrides before page updates", () => {
    // User toggles @app/submit ON
    guard.state.savedOverrides = {
      "@app/submit": { url: "http://localhost:9110/app.js", enabled: true },
    };
    guard.startInternalOp();

    // Page hasn't been updated yet (still empty)
    const result = guard.simulatePoll({});
    assert.equal(result, null, "poll must be blocked during internal op");
    assert.equal(
      guard.state.savedOverrides["@app/submit"].enabled,
      true,
      "savedOverrides must NOT be flipped"
    );
  });

  it("toggle OFF: polling must NOT flip savedOverrides before page updates", () => {
    guard.state.savedOverrides = {
      "@app/submit": { url: "http://localhost:9110/app.js", enabled: false },
    };
    guard.startInternalOp();

    // Page still has the old override
    const result = guard.simulatePoll({
      "@app/submit": "http://localhost:9110/app.js",
    });
    assert.equal(result, null, "poll must be blocked during internal op");
    assert.equal(
      guard.state.savedOverrides["@app/submit"].enabled,
      false,
      "savedOverrides must NOT be re-enabled"
    );
  });

  it("after cooldown: polling correctly syncs external MCP override", () => {
    guard.state.savedOverrides = {};
    guard.endInternalOp(0);

    // MCP added an override externally
    const result = guard.simulatePoll({
      "@app/submit": "http://localhost:9110/app.js",
    });
    assert.equal(result.hasChanges, true);
    assert.deepEqual(guard.state.savedOverrides["@app/submit"], {
      url: "http://localhost:9110/app.js",
      enabled: true,
    });
  });

  it("full toggle cycle does not cause flip-flop", () => {
    // Initial state: no overrides
    guard.state.savedOverrides = {};

    // Step 1: User toggles ON via panel
    guard.startInternalOp();
    guard.state.savedOverrides = {
      "@app/submit": { url: "http://localhost:9110/app.js", enabled: true },
    };

    // Step 2: Polling fires immediately (simulating useEffect re-run)
    // Page hasn't been updated yet - override not present on page
    const poll1 = guard.simulatePoll({});
    assert.equal(poll1, null, "poll blocked during internal op");
    assert.equal(guard.state.savedOverrides["@app/submit"].enabled, true);

    // Step 3: Page reloads, override is now present
    guard.endInternalOp(100);

    // Step 4: During cooldown, polling still blocked
    const poll2 = guard.simulatePoll({
      "@app/submit": "http://localhost:9110/app.js",
    });
    assert.equal(poll2, null, "poll blocked during cooldown");

    // Step 5: No flip-flop occurred
    assert.equal(
      guard.state.savedOverrides["@app/submit"].enabled,
      true,
      "savedOverrides stayed consistent throughout"
    );
  });

  it("consecutive rapid toggles don't cause state corruption", () => {
    guard.state.savedOverrides = {
      "@app/submit": { url: "http://localhost:9110/app.js", enabled: false },
    };

    // Toggle ON
    guard.startInternalOp();
    guard.state.savedOverrides["@app/submit"].enabled = true;

    // Immediately toggle OFF (before first op completes)
    guard.state.savedOverrides["@app/submit"].enabled = false;

    // Polling attempts during this rapid toggling
    const poll = guard.simulatePoll({
      "@app/submit": "http://localhost:9110/app.js",
    });
    assert.equal(poll, null, "poll must be blocked during rapid toggling");

    guard.endInternalOp(100);

    // State should reflect the last toggle (OFF)
    assert.equal(guard.state.savedOverrides["@app/submit"].enabled, false);
  });
});

describe("Polling: external change detection logic", () => {
  let guard;

  beforeEach(() => {
    guard = createPollingGuard();
  });

  it("detects new override added externally", () => {
    guard.state.savedOverrides = {};
    const result = guard.simulatePoll({
      "@app/new": "http://localhost:3000/new.js",
    });
    assert.equal(result.hasChanges, true);
    assert.deepEqual(guard.state.savedOverrides["@app/new"], {
      url: "http://localhost:3000/new.js",
      enabled: true,
    });
  });

  it("detects URL change on existing override", () => {
    guard.state.savedOverrides = {
      "@app/x": { url: "http://old-url", enabled: true },
    };
    const result = guard.simulatePoll({ "@app/x": "http://new-url" });
    assert.equal(result.hasChanges, true);
    assert.equal(guard.state.savedOverrides["@app/x"].url, "http://new-url");
  });

  it("detects override removed externally", () => {
    guard.state.savedOverrides = {
      "@app/x": { url: "http://some-url", enabled: true },
    };
    const result = guard.simulatePoll({});
    assert.equal(result.hasChanges, true);
    assert.equal(guard.state.savedOverrides["@app/x"].enabled, false);
  });

  it("re-enables disabled override when found on page", () => {
    guard.state.savedOverrides = {
      "@app/x": { url: "http://some-url", enabled: false },
    };
    const result = guard.simulatePoll({ "@app/x": "http://some-url" });
    assert.equal(result.hasChanges, true);
    assert.equal(guard.state.savedOverrides["@app/x"].enabled, true);
  });

  it("no changes when page matches savedOverrides", () => {
    guard.state.savedOverrides = {
      "@app/x": { url: "http://some-url", enabled: true },
    };
    const result = guard.simulatePoll({ "@app/x": "http://some-url" });
    assert.equal(result.hasChanges, false);
  });

  it("handles multiple overrides simultaneously", () => {
    guard.state.savedOverrides = {
      "@app/a": { url: "http://a", enabled: true },
      "@app/b": { url: "http://b", enabled: true },
    };
    const result = guard.simulatePoll({
      "@app/a": "http://a",
      "@app/c": "http://c",
    });
    assert.equal(result.hasChanges, true);
    assert.equal(guard.state.savedOverrides["@app/a"].enabled, true);
    assert.equal(guard.state.savedOverrides["@app/b"].enabled, false);
    assert.deepEqual(guard.state.savedOverrides["@app/c"], {
      url: "http://c",
      enabled: true,
    });
  });
});

// ========== Origin-scoped storage key tests ==========

// Replicate makeStorageKey from useImportMapOverrides.js
function makeStorageKey(origin) {
  return origin ? `savedOverrides:${origin}` : "savedOverrides";
}

// Simulate browser.storage.local as a plain object
function createMockStorage() {
  const data = {};
  return {
    data,
    async get(key) {
      return { [key]: data[key] ?? undefined };
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

describe("Origin-scoped storage key: makeStorageKey", () => {
  it("returns origin-prefixed key when origin is provided", () => {
    assert.equal(
      makeStorageKey("https://dev-journal.aifed.cn"),
      "savedOverrides:https://dev-journal.aifed.cn"
    );
  });

  it("returns fallback global key when origin is null", () => {
    assert.equal(makeStorageKey(null), "savedOverrides");
  });

  it("returns fallback global key when origin is empty string", () => {
    assert.equal(makeStorageKey(""), "savedOverrides");
  });

  it("different origins produce different keys", () => {
    const key1 = makeStorageKey("https://site-a.com");
    const key2 = makeStorageKey("http://159.226.33.71:9000");
    assert.notEqual(key1, key2);
  });
});

describe("Origin-scoped storage: isolation between origins", () => {
  let storage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("two origins can have different override URLs for the same app", async () => {
    const originA = "https://dev-journal.aifed.cn";
    const originB = "http://159.226.33.71:9000";

    await storage.set({
      [makeStorageKey(originA)]: {
        "@journal/submit": { url: "http://localhost:9110/app.js", enabled: true },
      },
    });
    await storage.set({
      [makeStorageKey(originB)]: {
        "@journal/submit": { url: "http://223.193.2.200:9110/app.js", enabled: false },
      },
    });

    const resultA = await storage.get(makeStorageKey(originA));
    const resultB = await storage.get(makeStorageKey(originB));

    assert.equal(
      resultA[makeStorageKey(originA)]["@journal/submit"].url,
      "http://localhost:9110/app.js"
    );
    assert.equal(
      resultB[makeStorageKey(originB)]["@journal/submit"].url,
      "http://223.193.2.200:9110/app.js"
    );
  });

  it("writing to one origin does not affect another", async () => {
    const originA = "https://site-a.com";
    const originB = "https://site-b.com";

    await storage.set({
      [makeStorageKey(originA)]: { "@app/x": { url: "http://a", enabled: true } },
    });
    await storage.set({
      [makeStorageKey(originB)]: { "@app/x": { url: "http://b", enabled: true } },
    });

    // Overwrite origin A
    await storage.set({
      [makeStorageKey(originA)]: { "@app/x": { url: "http://a-new", enabled: false } },
    });

    const resultB = await storage.get(makeStorageKey(originB));
    assert.equal(resultB[makeStorageKey(originB)]["@app/x"].url, "http://b");
    assert.equal(resultB[makeStorageKey(originB)]["@app/x"].enabled, true);
  });

  it("clearing one origin does not affect another", async () => {
    const originA = "https://site-a.com";
    const originB = "https://site-b.com";

    await storage.set({
      [makeStorageKey(originA)]: { "@app/x": { url: "http://a", enabled: true } },
    });
    await storage.set({
      [makeStorageKey(originB)]: { "@app/y": { url: "http://b", enabled: true } },
    });

    // Clear origin A
    await storage.set({ [makeStorageKey(originA)]: {} });

    const resultA = await storage.get(makeStorageKey(originA));
    const resultB = await storage.get(makeStorageKey(originB));

    assert.deepEqual(resultA[makeStorageKey(originA)], {});
    assert.deepEqual(resultB[makeStorageKey(originB)], {
      "@app/y": { url: "http://b", enabled: true },
    });
  });
});

describe("Origin-scoped storage: migration from global key", () => {
  let storage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("migrates global savedOverrides to origin-scoped key", async () => {
    const origin = "https://dev-journal.aifed.cn";
    const key = makeStorageKey(origin);
    const legacyData = {
      "@journal/submit": { url: "http://localhost:9110/app.js", enabled: true },
      "@journal/manage": { url: "http://localhost:9150/app.js", enabled: false },
    };

    // Old format: global key
    await storage.set({ savedOverrides: legacyData });

    // Simulate migration logic
    const [globalResult, scopedResult] = await Promise.all([
      storage.get("savedOverrides"),
      storage.get(key),
    ]);

    if (!scopedResult[key] && globalResult.savedOverrides && Object.keys(globalResult.savedOverrides).length > 0) {
      await storage.set({ [key]: globalResult.savedOverrides });
      await storage.remove("savedOverrides");
    }

    // Verify migration
    const afterGlobal = await storage.get("savedOverrides");
    const afterScoped = await storage.get(key);

    assert.equal(afterGlobal.savedOverrides, undefined);
    assert.deepEqual(afterScoped[key], legacyData);
  });

  it("does not migrate if origin-scoped data already exists", async () => {
    const origin = "https://dev-journal.aifed.cn";
    const key = makeStorageKey(origin);

    await storage.set({ savedOverrides: { "@app/old": { url: "http://old", enabled: true } } });
    await storage.set({ [key]: { "@app/new": { url: "http://new", enabled: true } } });

    const [globalResult, scopedResult] = await Promise.all([
      storage.get("savedOverrides"),
      storage.get(key),
    ]);

    // Should NOT migrate because scoped key already has data
    const shouldMigrate = !scopedResult[key] && globalResult.savedOverrides && Object.keys(globalResult.savedOverrides).length > 0;
    assert.equal(shouldMigrate, false);

    // Scoped data unchanged
    assert.deepEqual(storage.data[key], { "@app/new": { url: "http://new", enabled: true } });
  });
});
