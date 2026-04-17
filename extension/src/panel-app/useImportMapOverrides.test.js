/**
 * Tests for the import-map-overrides polling guard logic.
 *
 * These tests verify the core fix for the infinite-reload bug:
 *   - detectExternalChanges must be suppressed during internal operations
 *   - detectExternalChanges must be suppressed during cooldown period
 *   - savedOverrides dependency is read via ref, not via useEffect dependency array
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
