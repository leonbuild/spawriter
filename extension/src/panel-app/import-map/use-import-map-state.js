/**
 * React hook: orchestrates import-map override state.
 *
 * Single source of truth for the panel UI:
 *   - snapshot (page data)
 *   - savedOverrides (browser.storage.local, origin-scoped)
 *   - entries (unified row model from import-map-model)
 *   - pendingByName (in-flight operations)
 *   - errorByName (per-entry errors)
 *
 * Lifecycle: INITIALIZING → RESTORING → READY → APPLYING → RELOADING → VERIFYING → READY|ERROR
 */
import { useState, useEffect, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import { evalDevtoolsCmd } from "../../inspected-window.helper.js";
import {
  readImportMapSnapshot,
  addOverride,
  removeOverride,
  removeOverrideFromLocalStorage,
  clearAllOverridesFromLocalStorage,
  getCurrentOverrideMap,
  waitForImportMapReady,
} from "./import-map-page.js";
import {
  loadSavedOverrides,
  writeSavedOverrides,
  migrateStorage,
  makeStorageKey,
  buildExportData,
  parseImportData,
} from "./override-storage.js";
import { buildImportEntries, sortEntries, countActiveDependencies, splitByKind, detectScopes } from "./import-map-model.js";
import { validateOverrideUrl, validateImportName, preflightUrl } from "./override-url.js";

let operationSeq = 0;

async function reloadPage() {
  const tabId = browser.devtools.inspectedWindow.tabId;
  try {
    await browser.runtime.sendMessage({ type: "tabs-reload", tabId, bypassCache: true });
  } catch (err) {
    if (err.message?.includes("Extension context invalidated")) return;
    throw err;
  }
}

async function waitForPageLoad(maxWaitMs = 30000) {
  const tabId = browser.devtools.inspectedWindow.tabId;
  const start = Date.now();
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const resp = await browser.runtime.sendMessage({ type: "tabs-get", tabId });
        if (resp?.tab?.status === "complete") { resolve(true); return; }
      } catch { resolve(false); return; }
      if (Date.now() - start > maxWaitMs) { resolve(false); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @returns {ImportMapState}
 */
export default function useImportMapState() {
  const [phase, setPhase] = useState("initializing"); // initializing | restoring | ready | applying | error
  const [snapshot, setSnapshot] = useState(null);
  const [savedOverrides, setSavedOverrides] = useState({});
  const [pendingByName, setPendingByName] = useState({});
  const [errorByName, setErrorByName] = useState({});
  const [fatalError, setFatalError] = useState(null);

  const originRef = useRef(null);
  const savedRef = useRef(savedOverrides);
  savedRef.current = savedOverrides;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const pendingRef = useRef(pendingByName);
  pendingRef.current = pendingByName;
  const refreshVersionRef = useRef(0);

  if (fatalError) throw fatalError;

  // --- derived state ---
  const entries = snapshot
    ? sortEntries(buildImportEntries(snapshot, savedOverrides || {}))
    : [];
  const { apps, deps } = splitByKind(entries);
  const activeDependencyCount = countActiveDependencies(entries);
  const scopeInfo = snapshot ? detectScopes(snapshot.overrideScopes) : { hasScopes: false, count: 0 };

  // --- helpers ---

  const persistSaved = useCallback(async (next) => {
    setSavedOverrides(next);
    savedRef.current = next;
    await writeSavedOverrides(originRef.current, next);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    const snap = await readImportMapSnapshot();
    // Discard if a newer refresh started (prevents stale Phase 2 from overwriting fresher data)
    if (refreshVersionRef.current !== version) return snap;
    if (snap) {
      // Preserve defaultImports when Phase 2 (getDefaultMap) returned empty (same origin only)
      const prev = snapshotRef.current;
      if (prev && snap.origin === prev.origin
          && Object.keys(snap.defaultImports).length === 0
          && Object.keys(prev.defaultImports || {}).length > 0) {
        snap.defaultImports = prev.defaultImports;
        snap.effectiveImports = prev.effectiveImports || {};
      }
      setSnapshot(snap);
      snapshotRef.current = snap;
      originRef.current = snap.origin || originRef.current;
    }
    return snap;
  }, []);

  // Sync dashboard state into inspected page for MCP reads
  useEffect(() => {
    if (!snapshot) return;
    const state = {
      importMapsEnabled: true,
      savedOverrides,
      activeOverrides: snapshot.activeOverrides,
      entries: entries.map((e) => ({ name: e.name, kind: e.kind, actualEnabled: e.actualEnabled, syncStatus: e.syncStatus })),
      phase,
      updatedAt: new Date().toISOString(),
    };
    evalDevtoolsCmd(`mcpDashboardState = ${JSON.stringify(state)}`).catch(() => {});
  }, [snapshot, savedOverrides, phase]);

  // --- init ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Read snapshot
      const snap = await readImportMapSnapshot();
      if (cancelled) return;
      if (!snap) {
        // importMapOverrides not available — show UI anyway with empty state
        setPhase("ready");
        return;
      }
      setSnapshot(snap);
      snapshotRef.current = snap;
      originRef.current = snap.origin;

      // 2. Migrate + load storage
      setPhase("restoring");
      await migrateStorage(snap.origin);
      let saved = await loadSavedOverrides(snap.origin);

      // 3. Import any page-level overrides not yet in storage
      const pageKeys = Object.keys(snap.activeOverrides);
      let imported = false;
      for (const name of pageKeys) {
        if (!saved[name]) {
          saved[name] = { url: snap.activeOverrides[name], enabled: true };
          imported = true;
        }
      }
      if (imported) await writeSavedOverrides(snap.origin, saved);
      if (cancelled) return;
      setSavedOverrides(saved);
      savedRef.current = saved;

      // 4. Restore: batch diff and apply
      const ready = await waitForImportMapReady(5000);
      if (!ready || cancelled) { setPhase("ready"); return; }

      let needsReload = false;
      for (const [name, rec] of Object.entries(saved)) {
        const shouldBeActive = rec.enabled && !!rec.url;
        const pageUrl = snap.activeOverrides[name];
        if (shouldBeActive && pageUrl !== rec.url) {
          await addOverride(name, rec.url);
          needsReload = true;
        } else if (!shouldBeActive && pageUrl) {
          await removeOverride(name);
          needsReload = true;
        }
      }
      for (const name of Object.keys(snap.activeOverrides)) {
        if (!saved[name]) {
          await removeOverride(name);
          needsReload = true;
        }
      }

      if (needsReload && !cancelled) {
        await reloadPage();
        await waitForPageLoad();
        await delay(300);
        await refreshSnapshot();
      }

      if (!cancelled) setPhase("ready");
    })().catch((err) => {
      if (!cancelled) setFatalError(err);
    });
    return () => { cancelled = true; };
  }, []);

  // --- external change detection (3s poll) ---
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const POLL_MS = 3000;

    const poll = async () => {
      if (cancelled) return;
      try {
        const pageMap = await getCurrentOverrideMap();
        if (cancelled || !pageMap) return;

        const current = savedRef.current;
        const pending = pendingRef.current;
        const pageKeys = new Set(Object.keys(pageMap));
        const savedKeys = new Set(Object.keys(current));
        let changed = false;
        const next = { ...current };

        for (const name of pageKeys) {
          if (pending[name]) continue; // skip in-flight names
          const pageUrl = pageMap[name];
          const saved = current[name];
          if (!saved || saved.url !== pageUrl) {
            next[name] = { url: pageUrl, enabled: true };
            changed = true;
          } else if (saved && !saved.enabled && pageUrl) {
            next[name] = { ...saved, enabled: true };
            changed = true;
          }
        }
        for (const name of savedKeys) {
          if (pending[name]) continue;
          if (current[name]?.enabled && !pageKeys.has(name)) {
            next[name] = { ...current[name], enabled: false };
            changed = true;
          }
        }

        if (changed && !cancelled) {
          await persistSaved(next);
          // Also refresh snapshot so entries reflect actual state
          await refreshSnapshot();
        }
      } catch {
        // best-effort
      }
    };

    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [phase, persistSaved, refreshSnapshot]);

  // --- tab-updated / panel-shown / routing-event listeners ---
  useEffect(() => {
    const tabId = browser.devtools.inspectedWindow.tabId;

    const onExtEvent = async (event) => {
      const msg = event.detail;
      if (msg?.type === "tab-updated" && msg.tabId === tabId) {
        await handleNavigationOrRefresh();
      }
      if (msg?.from === "single-spa" && msg?.type === "routing-event") {
        await refreshSnapshot();
      }
    };

    const onPanelShown = () => { refreshSnapshot(); };

    async function handleNavigationOrRefresh() {
      const snap = await readImportMapSnapshot();
      if (!snap) return;

      // Preserve defaultImports when Phase 2 returned empty (same origin only)
      const prev = snapshotRef.current;
      if (prev && snap.origin === prev.origin
          && Object.keys(snap.defaultImports).length === 0
          && Object.keys(prev.defaultImports || {}).length > 0) {
        snap.defaultImports = prev.defaultImports;
        snap.effectiveImports = prev.effectiveImports || {};
      }

      setSnapshot(snap);
      snapshotRef.current = snap;

      if (snap.origin && snap.origin !== originRef.current) {
        originRef.current = snap.origin;
        const saved = await loadSavedOverrides(snap.origin);
        setSavedOverrides(saved);
        savedRef.current = saved;
      }
    }

    window.addEventListener("ext-content-script", onExtEvent);
    window.addEventListener("ext-panel-shown", onPanelShown);

    if (browser.devtools?.network?.onNavigated) {
      const onNav = () => { handleNavigationOrRefresh(); };
      browser.devtools.network.onNavigated.addListener(onNav);
      return () => {
        browser.devtools.network.onNavigated.removeListener(onNav);
        window.removeEventListener("ext-content-script", onExtEvent);
        window.removeEventListener("ext-panel-shown", onPanelShown);
      };
    }

    return () => {
      window.removeEventListener("ext-content-script", onExtEvent);
      window.removeEventListener("ext-panel-shown", onPanelShown);
    };
  }, [refreshSnapshot]);

  // --- user actions ---

  const enableOverride = useCallback(async (name, url) => {
    const nameCheck = validateImportName(name);
    if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
    const urlCheck = validateOverrideUrl(url, originRef.current);
    if (!urlCheck.valid) return { ok: false, error: urlCheck.error };

    const opId = ++operationSeq;
    setPendingByName((p) => ({ ...p, [name]: { id: opId, expectedEnabled: true, expectedUrl: url, startedAt: Date.now() } }));

    try {
      const next = { ...savedRef.current, [name]: { url, enabled: true } };
      await persistSaved(next);

      const ok = await addOverride(name, url);
      if (!ok) throw new Error("addOverride failed");

      await reloadPage();
      await waitForPageLoad();

      // Clear SYNCING immediately after page load; verification runs in background
      setPendingByName((p) => { const n = { ...p }; delete n[name]; return n; });

      // Optimistic snapshot: update activeOverrides so count reflects immediately
      // (refreshSnapshot Phase 2 can take up to 5s polling getDefaultMap)
      // Functional update ensures concurrent toggles compose correctly
      setSnapshot(prev => {
        if (!prev) return prev;
        return { ...prev, activeOverrides: { ...prev.activeOverrides, [name]: url } };
      });

      await delay(300);
      const snap = await refreshSnapshot();

      if (snap && !Object.prototype.hasOwnProperty.call(snap.activeOverrides, name)) {
        setErrorByName((e) => ({ ...e, [name]: "Override not active after reload" }));
      } else {
        setErrorByName((e) => { const n = { ...e }; delete n[name]; return n; });
      }
      return { ok: true };
    } catch (err) {
      setPendingByName((p) => { const n = { ...p }; delete n[name]; return n; });
      setErrorByName((e) => ({ ...e, [name]: err.message }));
      return { ok: false, error: err.message };
    }
  }, [persistSaved, refreshSnapshot]);

  const disableOverride = useCallback(async (name) => {
    const opId = ++operationSeq;
    setPendingByName((p) => ({ ...p, [name]: { id: opId, expectedEnabled: false, startedAt: Date.now() } }));

    try {
      const saved = savedRef.current[name];
      const next = { ...savedRef.current, [name]: { url: saved?.url || "", enabled: false } };
      await persistSaved(next);

      await removeOverride(name);
      await removeOverrideFromLocalStorage(name);

      await reloadPage();
      await waitForPageLoad();

      // Clear SYNCING immediately after page load
      setPendingByName((p) => { const n = { ...p }; delete n[name]; return n; });

      // Optimistic snapshot: remove from activeOverrides so count reflects immediately
      // Functional update ensures concurrent toggles compose correctly
      setSnapshot(prev => {
        if (!prev) return prev;
        const ao = { ...prev.activeOverrides };
        delete ao[name];
        return { ...prev, activeOverrides: ao };
      });

      await delay(300);
      await refreshSnapshot();
      setErrorByName((e) => { const n = { ...e }; delete n[name]; return n; });
      return { ok: true };
    } catch (err) {
      setPendingByName((p) => { const n = { ...p }; delete n[name]; return n; });
      setErrorByName((e) => ({ ...e, [name]: err.message }));
      return { ok: false, error: err.message };
    }
  }, [persistSaved, refreshSnapshot]);

  const toggleOverride = useCallback(async (name, enabled) => {
    if (enabled) {
      const url = savedRef.current[name]?.url;
      if (!url) return { ok: false, error: "No URL saved" };
      return enableOverride(name, url);
    }
    return disableOverride(name);
  }, [enableOverride, disableOverride]);

  const deleteEntry = useCallback(async (name) => {
    const next = { ...savedRef.current };
    delete next[name];
    await persistSaved(next);
    await removeOverride(name).catch(() => {});
    await removeOverrideFromLocalStorage(name).catch(() => {});
    await refreshSnapshot();
    return { ok: true };
  }, [persistSaved, refreshSnapshot]);

  const saveUrl = useCallback(async (name, url) => {
    const trimmed = (url || "").trim();
    if (!trimmed) {
      // Clear
      const next = { ...savedRef.current };
      delete next[name];
      await persistSaved(next);
      await removeOverride(name);
      await removeOverrideFromLocalStorage(name);
      await reloadPage();
      await waitForPageLoad();
      await delay(300);
      await refreshSnapshot();
      return { ok: true };
    }

    const urlCheck = validateOverrideUrl(trimmed, originRef.current);
    if (!urlCheck.valid) return { ok: false, error: urlCheck.error };

    const next = { ...savedRef.current, [name]: { url: trimmed, enabled: true } };
    await persistSaved(next);
    return enableOverride(name, trimmed);
  }, [persistSaved, enableOverride, refreshSnapshot]);

  const clearAllOverrides = useCallback(async () => {
    setPhase("applying");
    try {
      const current = savedRef.current;
      for (const name of Object.keys(current)) {
        await removeOverride(name);
      }
      await clearAllOverridesFromLocalStorage();
      await persistSaved({});
      await reloadPage();
      await waitForPageLoad();
      await delay(300);
      await refreshSnapshot();
    } catch (err) {
      console.warn("[spawriter] clearAllOverrides error:", err);
    } finally {
      setPhase("ready");
    }
  }, [persistSaved, refreshSnapshot]);

  const exportOverrides = useCallback(() => {
    const active = snapshotRef.current?.activeOverrides || {};
    return buildExportData(originRef.current, savedRef.current, active);
  }, []);

  const importOverrides = useCallback(async (jsonString) => {
    const parsed = parseImportData(jsonString);
    if (parsed.error) return { ok: false, error: parsed.error, skipped: [] };

    const merged = { ...savedRef.current, ...parsed.overrides };
    await persistSaved(merged);

    // Batch apply enabled entries
    let needsReload = false;
    for (const [name, rec] of Object.entries(parsed.overrides)) {
      if (rec.enabled && rec.url) {
        await addOverride(name, rec.url);
        needsReload = true;
      }
    }
    if (needsReload) {
      await reloadPage();
      await waitForPageLoad();
      await delay(300);
    }
    await refreshSnapshot();

    return {
      ok: true,
      imported: Object.keys(parsed.overrides).length,
      skipped: parsed.skipped || [],
    };
  }, [persistSaved, refreshSnapshot]);

  // --- preflight ---
  const preflightOverrideUrl = useCallback(async (url) => {
    const check = validateOverrideUrl(url, originRef.current);
    if (!check.valid) return { ok: false, error: check.error };
    return preflightUrl(check.resolved);
  }, []);

  return {
    phase,
    available: !!snapshot,
    origin: originRef.current,
    snapshot,
    savedOverrides,
    entries,
    apps,
    deps,
    activeDependencyCount,
    scopeInfo,
    pendingByName,
    errorByName,
    // actions
    enableOverride,
    disableOverride,
    toggleOverride,
    saveUrl,
    deleteEntry,
    clearAllOverrides,
    exportOverrides,
    importOverrides,
    preflightOverrideUrl,
    refreshSnapshot,
  };
}
