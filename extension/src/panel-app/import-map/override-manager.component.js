import React, { useState, useRef, useMemo, useEffect } from "react";
import { Scoped } from "kremling";
import useImportMapState from "./use-import-map-state";
import OverrideSection from "./override-section.component";
import AppStatusOverride from "../app-status-override.component";
import Button from "../button";
import ClearCacheButton from "../clear-cache-button";
import ToggleGroup from "../toggle-group";
import ToggleOption from "../toggle-option";
import { evalDevtoolsCmd } from "../../inspected-window.helper.js";
import { overrideManagerCss } from "./override-manager.css";

const OFF = "off", ON = "on", LIST = "list";

/**
 * Top-level override manager: two sections (Apps, Dependencies),
 * toolbar with import/export/reset, overlays, and scope warnings.
 *
 * Receives `apps` (registered lifecycle apps) and `theme` from PanelRoot
 * so it can render lifecycle overlays. But if `apps` is unavailable, the
 * override UI still works.
 */
export default function OverrideManager({ apps: registeredApps, theme }) {
  const state = useImportMapState();
  const {
    phase, available, apps, deps, activeDependencyCount, scopeInfo,
    pendingByName, errorByName,
    toggleOverride, saveUrl, deleteEntry, clearAllOverrides,
    exportOverrides, importOverrides,
  } = state;

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [importExportMessage, setImportExportMessage] = useState(null);
  const [clearCacheState, setClearCacheState] = useState({ isClearing: false, status: null });
  const [overlaysEnabled, setOverlaysEnabled] = useState(OFF);
  const [hovered, setHovered] = useState(null);
  const fileInputRef = useRef(null);

  // Build a lookup from registered apps for lifecycle actions
  const appsByName = useMemo(() => {
    if (!registeredApps) return new Map();
    return new Map(registeredApps.map((a) => [a.name, a]));
  }, [registeredApps]);

  // Overlay handling
  const { mounted: mountedApps, other: otherApps } = useMemo(() => {
    if (!registeredApps) return { mounted: [], other: [] };
    const m = [], o = [];
    for (const app of registeredApps) {
      const group = app.status === "MOUNTED" || !!app.devtools?.activeWhenForced ? m : o;
      group.push(app);
    }
    return { mounted: m, other: o };
  }, [registeredApps]);

  useEffect(() => {
    if (overlaysEnabled === LIST && hovered) {
      overlayApp(hovered);
      return () => deOverlayApp(hovered);
    }
  }, [overlaysEnabled, hovered]);

  useEffect(() => {
    if (overlaysEnabled === ON) {
      mountedApps.forEach(overlayApp);
      otherApps.forEach(deOverlayApp);
      return () => mountedApps.forEach(deOverlayApp);
    }
  }, [overlaysEnabled, mountedApps, otherApps]);

  const flash = (type, text) => {
    setImportExportMessage({ type, text });
    setTimeout(() => setImportExportMessage(null), 5000);
  };

  // Export
  const handleExport = async () => {
    try {
      const data = exportOverrides();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const host = (state.origin || "").replace(/[^a-zA-Z0-9._-]/g, "_");
      a.download = host ? `spawriter-overrides_${host}.json` : "spawriter-overrides.json";
      a.click();
      URL.revokeObjectURL(url);
      const total = Object.keys(data.overrides).length;
      flash("success", `Exported ${total} override(s)`);
    } catch (err) {
      flash("error", "Export failed: " + err.message);
    }
  };

  // Import
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const text = await file.text();
    const result = await importOverrides(text);
    if (!result.ok) {
      flash("error", "Import failed: " + result.error);
    } else {
      let msg = `Imported ${result.imported} override(s)`;
      if (result.skipped.length) msg += ` (${result.skipped.length} skipped)`;
      flash("success", msg);
    }
  };

  // Reset All
  const handleResetAll = async () => {
    setShowResetConfirm(false);
    await clearAllOverrides();
    flash("success", "All overrides cleared");
  };

  const renderAppActions = (entry) => {
    const regApp = appsByName.get(entry.name);
    if (!regApp) return null;
    return (
      <AppStatusOverride
        app={{
          name: entry.name,
          status: regApp.status || entry.lifecycleStatus || "UNKNOWN",
          devtools: regApp.devtools || {},
        }}
      />
    );
  };

  const handleRowHover = (entry) => {
    if (!registeredApps) return;
    const app = appsByName.get(entry.name);
    if (app) setHovered(app);
  };
  const handleRowLeave = () => setHovered(null);

  if (!available && phase === "ready") {
    return (
      <Scoped css={overrideManagerCss}>
        <div className="om-root">
          <p className="om-notice">importMapOverrides not detected on this page.</p>
        </div>
      </Scoped>
    );
  }

  return (
    <Scoped css={overrideManagerCss}>
      <div className="om-root">
        {/* Toolbar */}
        <div className="om-toolbar">
          <ClearCacheButton sharedState={clearCacheState} setSharedState={setClearCacheState} />
        </div>
        <div className="om-toolbar">
          <ToggleGroup name="overlaysDisplayOption" value={overlaysEnabled} onChange={(e) => setOverlaysEnabled(e.target.value)}>
            <legend style={{ display: "inline" }}>Overlays</legend>
            <ToggleOption value={OFF}>Off</ToggleOption>
            <ToggleOption value={ON}>On</ToggleOption>
            <ToggleOption value={LIST}>List Hover</ToggleOption>
          </ToggleGroup>
          <div className="om-toolbar-right">
            <span className="om-label">Overrides</span>
            <Button className="om-btn" onClick={handleExport}>Export</Button>
            <Button className="om-btn" onClick={() => fileInputRef.current?.click()}>Import</Button>
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportFile} style={{ display: "none" }} />
            {showResetConfirm ? (
              <span className="reset-confirm">
                <span className="reset-confirm-text">Delete all saved overrides and refresh?</span>
                <Button className="om-btn-danger" onClick={handleResetAll}>Confirm</Button>
                <Button className="om-btn-secondary" onClick={() => setShowResetConfirm(false)}>Cancel</Button>
              </span>
            ) : (
              <Button className="om-btn-danger" onClick={() => setShowResetConfirm(true)}>Reset All</Button>
            )}
            {importExportMessage && (
              <span className={`om-message om-message-${importExportMessage.type}`}>
                {importExportMessage.text}
              </span>
            )}
          </div>
        </div>  {/* end second toolbar */}

        {/* Scopes warning */}
        {scopeInfo.hasScopes && (
          <div className="om-warning" role="alert">
            ⚠ {scopeInfo.count} scoped override(s) exist. Editing scoped overrides is not yet supported.
          </div>
        )}

        {/* Phase indicator */}
        {(phase === "restoring" || phase === "applying") && (
          <div className="om-phase">
            {phase === "restoring" ? "Restoring saved overrides…" : "Applying…"}
          </div>
        )}

        {/* Applications section — always expanded */}
        <OverrideSection
          title="Applications"
          entries={apps}
          activeCount={apps.filter((e) => e.actualEnabled).length}
          collapsible={false}
          onToggle={toggleOverride}
          onSaveUrl={saveUrl}
          onDelete={deleteEntry}
          pendingByName={pendingByName}
          errorByName={errorByName}
          renderAppActions={renderAppActions}
          onRowHover={handleRowHover}
          onRowLeave={handleRowLeave}
        />

        {/* Dependencies section — collapsible */}
        <OverrideSection
          title="Dependencies"
          entries={deps}
          activeCount={activeDependencyCount}
          collapsible={true}
          onToggle={toggleOverride}
          onSaveUrl={saveUrl}
          onDelete={deleteEntry}
          pendingByName={pendingByName}
          errorByName={errorByName}
          renderAppActions={null}
          onRowHover={null}
          onRowLeave={null}
        />

        {/* Bottom toolbar */}
        <div className="om-toolbar om-toolbar-bottom">
          <ClearCacheButton sharedState={clearCacheState} setSharedState={setClearCacheState} />
        </div>
      </div>
    </Scoped>
  );
}

function overlayApp(app) {
  if (app?.status !== "SKIP_BECAUSE_BROKEN" && app?.status !== "NOT_LOADED" && app?.devtools?.overlays) {
    evalDevtoolsCmd(`overlay(${JSON.stringify(app.name)})`).catch(() => {});
  }
}

function deOverlayApp(app) {
  if (app?.devtools?.overlays) {
    evalDevtoolsCmd(`removeOverlay(${JSON.stringify(app.name)})`).catch(() => {});
  }
}
