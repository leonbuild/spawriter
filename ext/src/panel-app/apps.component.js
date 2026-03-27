import React, { useState, useEffect, useMemo } from "react";
import { Scoped, always } from "kremling";
import AppStatusOverride from "./app-status-override.component";
import Button from "./button";
import ToggleSwitch from "./toggle-switch";
import ClearCacheButton from "./clear-cache-button";
import { evalDevtoolsCmd, evalCmd } from "../inspected-window.helper.js";
import useImportMapOverrides from "./useImportMapOverrides";
import ToggleGroup from "./toggle-group";
import ToggleOption from "./toggle-option";
import browser from "webextension-polyfill";

const OFF = "off",
  ON = "on",
  LIST = "list",
  PAGE = "page";

export default function Apps(props) {
  const importMaps = useImportMapOverrides();
  const [hovered, setHovered] = useState();
  const [overlaysEnabled, setOverlaysEnabled] = useState(OFF);

  // 编辑状态管理：记录哪些 app 正在编辑
  const [editingApps, setEditingApps] = useState({});
  // 编辑中的临时值
  const [editValues, setEditValues] = useState({});
  // Reset All 确认状态
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // 文件输入 ref
  const fileInputRef = React.useRef(null);
  // 导入/导出消息提示
  const [importExportMessage, setImportExportMessage] = useState(null); // { type: 'success' | 'error', text: '...' }
  // 排序方式：'status' 或 'appname'
  const [sortBy, setSortBy] = useState('status');
  // Clear Cache 按钮状态 - 共享给两个按钮
  const [clearCacheState, setClearCacheState] = useState({ isClearing: false, status: null });

  // 根据排序方式排序 apps
  const sortedApps = useMemo(() => {
    if (sortBy === 'appname') {
      return sortAppsByName(props.apps);
    } else {
      return sortApps(props.apps);
    }
  }, [props.apps, sortBy]);

  const { mounted: mountedApps, other: otherApps } = useMemo(
    () => groupApps(props.apps),
    [props.apps]
  );

  // Sync dashboard state into inspected page so MCP can read it directly.
  useEffect(() => {
    const dashboardSnapshot = {
      overlaysEnabled,
      sortBy,
      importMapsEnabled: importMaps.enabled,
      importMapsLoading: importMaps.isLoading,
      importMapsProtocolError: importMaps.protocolError?.message || null,
      savedOverrides: importMaps.savedOverrides,
      activeOverrides: importMaps.overrides,
      showResetConfirm,
      clearCacheState,
      appStates: props.apps.map((app) => ({
        name: app.name,
        status: app.status,
        activeWhenForced: app.devtools?.activeWhenForced || null,
        hasOverlays: !!app.devtools?.overlays,
      })),
      updatedAt: new Date().toISOString(),
    };

    evalDevtoolsCmd(`mcpDashboardState = ${JSON.stringify(dashboardSnapshot)}`).catch(
      (err) => {
        console.debug(
          "[spawriter] Failed syncing dashboard snapshot for MCP:",
          err?.message || err
        );
      }
    );
  }, [
    overlaysEnabled,
    sortBy,
    importMaps.enabled,
    importMaps.isLoading,
    importMaps.protocolError,
    importMaps.savedOverrides,
    importMaps.overrides,
    showResetConfirm,
    clearCacheState,
    props.apps,
  ]);

  // Export override URLs
  const handleExportOverrides = async () => {
    try {
      const tempData = {};
      
      props.apps.forEach(app => {
        const savedConfig = importMaps.savedOverrides[app.name];
        tempData[app.name] = savedConfig?.url || '';
      });

      const sortedKeys = Object.keys(tempData).sort((a, b) => 
        a.toUpperCase().localeCompare(b.toUpperCase())
      );
      
      const exportData = {};
      sortedKeys.forEach(key => {
        exportData[key] = tempData[key];
      });

      let siteHost = '';
      try {
        siteHost = await evalCmd('window.location.host');
        if (Array.isArray(siteHost)) siteHost = siteHost[0] || '';
        siteHost = String(siteHost).replace(/[^a-zA-Z0-9._-]/g, '_');
      } catch (_) {}

      const dataStr = JSON.stringify(exportData, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const filename = siteHost
        ? `single-spa-overrides_${siteHost}.json`
        : 'single-spa-overrides.json';
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      
      const appsWithUrls = Object.values(exportData).filter(url => url.trim()).length;
      const totalApps = Object.keys(exportData).length;
      
      setImportExportMessage({ 
        type: 'success', 
        text: `Successfully exported ${totalApps} app(s) (${appsWithUrls} with URLs)` 
      });
      setTimeout(() => setImportExportMessage(null), 5000);
    } catch (err) {
      console.error('Error exporting overrides:', err);
      setImportExportMessage({ type: 'error', text: 'Export failed. Check console for details.' });
      setTimeout(() => setImportExportMessage(null), 5000);
    }
  };

  // Click import button
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  // Import override URLs
  const handleImportOverrides = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        // Validate JSON format
        let importedData;
        try {
          importedData = JSON.parse(event.target.result);
        } catch (parseErr) {
          setImportExportMessage({ type: 'error', text: 'Import failed: Invalid JSON format' });
          setTimeout(() => setImportExportMessage(null), 5000);
          return;
        }

        // Validate object type
        if (!importedData || typeof importedData !== 'object' || Array.isArray(importedData)) {
          setImportExportMessage({ type: 'error', text: 'Import failed: Must be object format' });
          setTimeout(() => setImportExportMessage(null), 5000);
          return;
        }

        // Save imported data to savedOverrides with enabled set to false
        const newSavedOverrides = {};
        const skippedApps = [];  // Track skipped apps (invalid types or empty URLs)
        
        Object.entries(importedData).forEach(([appName, url]) => {
          // Validate URL is string - skip non-strings and track them
          if (typeof url !== 'string') {
            skippedApps.push(appName);
            return;
          }
          
          // Skip empty URLs (don't import them) and track them
          if (!url.trim()) {
            skippedApps.push(appName);
            return;
          }
          
          newSavedOverrides[appName] = {
            url: url.trim(),
            enabled: false  // Disabled by default
          };
        });

        // If all apps were skipped (invalid types or empty URLs)
        if (Object.keys(newSavedOverrides).length === 0) {
          setImportExportMessage({ type: 'error', text: 'Import failed: No valid URLs found' });
          setTimeout(() => setImportExportMessage(null), 5000);
          return;
        }

        // Merge with existing savedOverrides
        const mergedOverrides = {
          ...importMaps.savedOverrides,
          ...newSavedOverrides
        };

        // Save to storage
        await browser.storage.local.set({ savedOverrides: mergedOverrides });
        
        // Immediately reload the savedOverrides state to show in UI
        await importMaps.loadSavedOverrides();
        
        // Apply imported overrides to the page
        // Note: This will reload the page after applying overrides
        setTimeout(() => {
          importMaps.ensureSavedOverridesApplied("import", mergedOverrides);
        }, 100);
        
        // Show import result
        const successCount = Object.keys(newSavedOverrides).length;
        const totalApps = Object.keys(importedData).length;
        const skippedCount = skippedApps.length;
        
        let message = `Successfully imported ${successCount} app(s)`;
        if (skippedCount > 0) {
          message += ` (${skippedCount} invalid/empty URL(s) ignored)`;
        }
        
        setImportExportMessage({ type: 'success', text: message });
        setTimeout(() => setImportExportMessage(null), 5000);
      } catch (err) {
        console.error('Error importing overrides:', err);
        setImportExportMessage({ type: 'error', text: 'Import failed: ' + err.message });
        setTimeout(() => setImportExportMessage(null), 5000);
      }
    };
    
    reader.onerror = () => {
      setImportExportMessage({ type: 'error', text: 'Import failed: Cannot read file' });
      setTimeout(() => setImportExportMessage(null), 5000);
    };
    
    reader.readAsText(file);
    
    // Reset input to allow selecting the same file again
    e.target.value = '';
  };

  useEffect(() => {
    if (overlaysEnabled === LIST && hovered) {
      overlayApp(hovered);
      return () => {
        deOverlayApp(hovered);
      };
    }
  }, [overlaysEnabled, hovered]);

  useEffect(() => {
    if (overlaysEnabled === ON) {
      mountedApps.forEach((app) => overlayApp(app));
      otherApps.forEach((app) => deOverlayApp(app));
      return () => {
        mountedApps.forEach((app) => deOverlayApp(app));
      };
    }
  }, [overlaysEnabled, mountedApps, otherApps]);

  // 开始编辑
  const startEdit = (appName) => {
    setEditingApps({ ...editingApps, [appName]: true });
    setEditValues({
      ...editValues,
      [appName]: importMaps.savedOverrides[appName]?.url || ""
    });
  };

  // 取消编辑
  const cancelEdit = (appName) => {
    setEditingApps({ ...editingApps, [appName]: false });
    setEditValues({ ...editValues, [appName]: "" });
  };

  // 保存并刷新
  const handleSaveAndRefresh = async (appName) => {
    const url = editValues[appName];
    if (url && url.trim()) {
      // 有 URL，保存并启用
      await importMaps.saveOverride(appName, url.trim());
    } else {
      // 空 URL，清空地址并关闭 toggle
      await importMaps.clearSavedOverride(appName);
    }
    setEditingApps({ ...editingApps, [appName]: false });
  };

  // Toggle 切换
  const handleToggle = async (appName, enabled) => {
    await importMaps.toggleOverride(appName, enabled);
  };

  // 获取显示的 URL 值
  const getDisplayUrl = (appName) => {
    if (editingApps[appName]) {
      return editValues[appName] || "";
    }
    return importMaps.savedOverrides[appName]?.url || "";
  };

  // 判断 toggle 是否启用
  const isToggleEnabled = (appName) => {
    return importMaps.savedOverrides[appName]?.enabled || false;
  };

  // 判断是否有保存的 URL
  const hasSavedUrl = (appName) => {
    return !!importMaps.savedOverrides[appName]?.url;
  };

  // 验证 URL 是否以 .js 结尾
  const isValidJsUrl = (url) => {
    if (!url || !url.trim()) return true; // 空值不显示错误
    return url.trim().toLowerCase().endsWith('.js');
  };

  return (
    <Scoped css={css}>
      <span>
        <div className="toolbar">
          <ClearCacheButton 
            sharedState={clearCacheState} 
            setSharedState={setClearCacheState}
          />
        </div>
        
        <div className="toolbar toolbar-second">
          <ToggleGroup
            name="overlaysDisplayOption"
            value={overlaysEnabled}
            onChange={(e) => setOverlaysEnabled(e.target.value)}
          >
            <legend style={{ display: "inline" }}>Overlays</legend>
            <ToggleOption value={OFF}>Off</ToggleOption>
            <ToggleOption value={ON}>On</ToggleOption>
            <ToggleOption value={LIST}>List Hover</ToggleOption>
          </ToggleGroup>
          
          <ToggleGroup
            name="sortByOption"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <legend style={{ display: "inline" }}>Sort by</legend>
            <ToggleOption value="appname">AppName</ToggleOption>
            <ToggleOption value="status">Status</ToggleOption>
          </ToggleGroup>
          
          {importMaps.enabled && (
            <div className="override-import-export">
              <span className="override-label">Overrides</span>
              <Button 
                className="export-btn"
                onClick={handleExportOverrides}
              >
                Export
              </Button>
              <Button 
                className="import-btn"
                onClick={handleImportClick}
              >
                Import
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImportOverrides}
                style={{ display: 'none' }}
              />
              {importExportMessage && (
                <span className={`override-message ${importExportMessage.type}`}>
                  {importExportMessage.text}
                </span>
              )}
            </div>
          )}
        </div>
        <div role="table" className={"table"}>
          <div role="row">
            <span role="columnheader">App Name</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Actions</span>
            {importMaps.enabled && (
              <span role="columnheader" className="import-override-header">
                Import Override
                {showResetConfirm ? (
                  <span className="reset-confirm">
                    <span className="reset-confirm-text">Delete all saved overrides and refresh?</span>
                    <Button 
                      className="reset-confirm-btn"
                      onClick={() => {
                        importMaps.clearAllOverrides();
                        setShowResetConfirm(false);
                      }}
                    >
                      Confirm
                    </Button>
                    <Button 
                      className="reset-cancel-btn"
                      onClick={() => setShowResetConfirm(false)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button 
                    className="reset-all-btn"
                    onClick={() => setShowResetConfirm(true)}
                  >
                    Reset All
                  </Button>
                )}
              </span>
            )}
          </div>
          {sortedApps.map((app) => (
            <div
              role="row"
              key={app.name}
              onMouseEnter={() => setHovered(app)}
              onMouseLeave={() => setHovered()}
            >
              <div role="cell" className="app-name">{app.name}</div>
              <div role="cell">
                <span
                  className={always("app-status")
                    .maybe("app-mounted", app.status === "MOUNTED")
                    .maybe("app-not-mounted", app.status === "NOT_MOUNTED")
                    .maybe("app-not-loaded", app.status === "NOT_LOADED")
                    .maybe("app-not-bootstrapped", app.status === "NOT_BOOTSTRAPPED")
                    .maybe("app-unloading", app.status === "UNLOADING")
                    .maybe("app-loading", app.status === "LOADING_SOURCE_CODE")
                    .maybe("app-bootstrapping", app.status === "BOOTSTRAPPING")
                    .maybe("app-mounting", app.status === "MOUNTING")
                    .maybe("app-unmounting", app.status === "UNMOUNTING")
                    .maybe("app-broken", app.status === "SKIP_BECAUSE_BROKEN")
                    .maybe("app-load-error", app.status === "LOAD_ERROR")}
                >
                  {app.status.replace(/_/g, " ")}
                </span>
              </div>
              <div role="cell">
                <AppStatusOverride app={app} />
              </div>
              {importMaps.enabled && (
                <div role="cell" className="import-override-cell">
                  {/* Toggle 开关 */}
                  <div className="toggle-wrapper">
                    <ToggleSwitch
                      checked={isToggleEnabled(app.name)}
                      onChange={(enabled) => handleToggle(app.name, enabled)}
                      disabled={!hasSavedUrl(app.name)}
                    />
                  </div>
                  
                  {/* Input 容器 */}
                  <div className="input-container">
                    <div className="input-wrapper">
                      <input
                        className={always("import-override")
                          .maybe("editing", editingApps[app.name])
                          .maybe("invalid", editingApps[app.name] && !isValidJsUrl(editValues[app.name]))
                          .maybe("active", isToggleEnabled(app.name) && hasSavedUrl(app.name))}
                        value={getDisplayUrl(app.name)}
                        readOnly={!editingApps[app.name]}
                        onChange={(e) => {
                          setEditValues({ ...editValues, [app.name]: e.target.value });
                        }}
                        onClick={() => {
                          // 当 input 为空时，点击 input 进入 edit 模式
                          if (!editingApps[app.name] && !getDisplayUrl(app.name)) {
                            startEdit(app.name);
                          }
                        }}
                        onKeyDown={(e) => {
                          // 在编辑模式下按 Enter 键触发保存
                          if (e.key === "Enter" && editingApps[app.name]) {
                            e.preventDefault();
                            handleSaveAndRefresh(app.name);
                          }
                        }}
                        placeholder="Enter override URL..."
                      />
                      {/* Clear 按钮 - 仅在 edit 模式且有内容时显示 */}
                      {editingApps[app.name] && editValues[app.name] && (
                        <button
                          className="input-clear-btn"
                          onClick={() => setEditValues({ ...editValues, [app.name]: "" })}
                          type="button"
                          title="Clear"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {/* 验证提示 - 仅在 edit 模式且 URL 不以 .js 结尾时显示 */}
                    {editingApps[app.name] && !isValidJsUrl(editValues[app.name]) && (
                      <span className="url-warning">URL of an APP must end with .js</span>
                    )}
                  </div>
                  
                  {/* 按钮容器 - 固定宽度防止 UI 跳动 */}
                  <div className="override-buttons">
                    {editingApps[app.name] ? (
                      <>
                        <Button onClick={() => handleSaveAndRefresh(app.name)}>
                          Save
                        </Button>
                        <Button onClick={() => cancelEdit(app.name)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => startEdit(app.name)}>
                        Edit
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        
        <div className="bottom-toolbar">
          <ClearCacheButton 
            sharedState={clearCacheState} 
            setSharedState={setClearCacheState}
          />
        </div>
      </span>
    </Scoped>
  );
}

// 状态优先级映射（数字越小排越前）
// 排序逻辑：已挂载 > 正在挂载/卸载 > 未挂载(已加载) > 正在加载/启动 > 未加载 > 错误
const STATUS_PRIORITY = {
  MOUNTED: 1,              // 已挂载
  MOUNTING: 2,             // 正在挂载
  UNMOUNTING: 2,           // 正在卸载
  UNLOADING: 2,            // 正在卸载资源
  NOT_MOUNTED: 3,          // 未挂载（已加载过）
  LOADING_SOURCE_CODE: 4,  // 正在加载源代码
  NOT_BOOTSTRAPPED: 4,     // 尚未启动（已加载但未执行 bootstrap）
  BOOTSTRAPPING: 4,        // 正在启动
  NOT_LOADED: 5,           // 未加载
  SKIP_BECAUSE_BROKEN: 6,  // 因错误跳过
  LOAD_ERROR: 6,           // 加载错误
};

function getAppPriority(app) {
  return STATUS_PRIORITY[app.status] ?? 99;
}

function sortApps(apps) {
  return [...apps]
    // 先按名称排序（作为相同优先级时的次要排序）
    .sort((a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase()))
    // 再按状态优先级排序（稳定排序，相同优先级保持名称顺序）
    .sort((a, b) => getAppPriority(a) - getAppPriority(b));
}

function sortAppsByName(apps) {
  return [...apps].sort((a, b) => 
    a.name.toUpperCase().localeCompare(b.name.toUpperCase())
  );
}

function groupApps(apps) {
  const [mounted, other] = apps.reduce(
    (list, app) => {
      const group =
        app.status === "MOUNTED" || !!app.devtools.activeWhenForced ? 0 : 1;
      list[group].push(app);
      return list;
    },
    [[], []]
  );
  mounted.sort((a, b) => a.name.localeCompare(b.name));
  other.sort((a, b) => a.name.localeCompare(b.name));
  return {
    mounted,
    other,
  };
}

function overlayApp(app) {
  if (
    app.status !== "SKIP_BECAUSE_BROKEN" &&
    app.status !== "NOT_LOADED" &&
    app.devtools &&
    app.devtools.overlays
  ) {
    evalDevtoolsCmd(`overlay('${app.name}')`).catch((err) => {
      console.error(`Error overlaying application: ${app.name}`, err);
    });
  }
}

function deOverlayApp(app) {
  if (app.devtools && app.devtools.overlays) {
    evalDevtoolsCmd(`removeOverlay('${app.name}')`).catch((err) => {
      console.error(`Error removing overlay on application: ${app.name}`, err);
    });
  }
}

const css = `
:root {
  --gray: #82889a;
  --blue-light: #96b0ff;
  --blue: #3366ff;
  --blue-dark: #2850c8;
  --pink: #e62e5c;
  --green: #28cb51;
  --table-spacing: .5rem;
  --text-primary: #1a1a1a;
  --text-secondary: #82889a;
  --bg-tab: #f0f0f0;
}
body {
  font-family: sans-serif;
  color: var(--text-primary);
}

body.dark {
  --text-primary: #F8F8F2;
  --text-secondary: #a0a0a0;
  --bg-tab: #3c3c3c;
  background-color: #272822;
}

/* Tab 样式 - 自动适配黑白主题 */
[data-reach-tab-list] {
  background: var(--bg-tab);
}

[data-reach-tab] {
  color: var(--text-primary);
  font-weight: 500;
}

[data-reach-tab][data-selected] {
  border-bottom-color: var(--blue);
}

/* App Name 样式 - 加粗加重 */
& .app-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #1a1a1a;
}

body.dark & .app-name {
  color: #ffffff;
}

& .toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 16px;
  padding: 4px var(--table-spacing);
  margin-bottom: 4px;
}

& .toolbar-second {
  margin-bottom: 0;
  padding-left: var(--table-spacing);
  white-space: nowrap;
  overflow-x: visible;
  align-items: center;
  gap: 16px;
  flex-wrap: nowrap;
}

& .bottom-toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 4px var(--table-spacing);
  margin-top: 0;
}

& .override-import-export {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 0;
  white-space: nowrap;
  flex-wrap: nowrap;
  flex-shrink: 0;
}

& .override-label {
  color: var(--gray);
  font-size: .9rem;
  font-weight: 500;
  white-space: nowrap;
  margin-right: 0;
  line-height: 1.2;
  user-select: none;
}

& .export-btn,
& .import-btn {
  background-color: var(--blue);
  color: #fff;
  font-size: .75rem;
  padding: .3rem .6rem;
  white-space: nowrap;
  line-height: 1.2;
  user-select: none;
  box-sizing: border-box;
  margin-left: 0;
}

& .export-btn:hover,
& .import-btn:hover {
  background-color: var(--blue-dark);
  outline: none;
}

& .override-message {
  font-size: .75rem;
  font-weight: 500;
  white-space: nowrap;
  margin-left: 8px;
}

& .override-message.success {
  color: var(--green);
}

& .override-message.error {
  color: var(--pink);
}

& [role="table"] {
  display: table;
  border-collapse: separate;
  border-spacing: calc(var(--table-spacing) * 2) 2px;
  padding: 0;
  margin-left: calc(var(--table-spacing) - var(--table-spacing) * 2);
}

& [role="columnheader"] {
  color: var(--gray);
  font-size: .9rem;
  padding-left: .25rem;
  text-align: left;
  white-space: nowrap;
  line-height: 1.2;
}

& [role="row"] {
  display: table-row;
}

& [role="row"] [role="cell"],
& [role="row"] [role="columnheader"] {
  display: table-cell;
  vertical-align: top;
  white-space: nowrap;
  padding-top: 2px;
}

& .app-status {
  border-radius: 1rem;
  color: #fff;
  font-size: .75rem;
  padding: .25rem .5rem .125rem;
  text-shadow: 0px 2px 4px rgba(0,0,0,.15);
  text-transform: capitalize;
}

& .app-mounted {
  background-color: var(--green);
}

& .app-not-mounted {
  background-color: var(--gray);
}

& .app-not-loaded {
  background-color: #9e9e9e;
}

& .app-unloading {
  background-color: #ff9800;
}

& .app-not-bootstrapped {
  background-color: #b0b0b0;
}

& .app-loading {
  background-color: var(--blue);
}

& .app-bootstrapping {
  background-color: #ff9800;
}

& .app-mounting {
  background-color: #8bc34a;
}

& .app-unmounting {
  background-color: #ff9800;
}

& .app-broken {
  background-color: #f44336;
}

& .app-load-error {
  background-color: #f44336;
}

& .import-override-cell {
  display: inline-flex !important;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

& .toggle-wrapper {
  flex-shrink: 0;
}

& .input-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
}

& .input-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

& .url-warning {
  color: var(--pink);
  font-size: .65rem;
  white-space: nowrap;
}

& .import-override.invalid {
  border-color: var(--pink);
}

& .input-clear-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  border: none;
  background: #999;
  color: #fff;
  border-radius: 50%;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

& .input-clear-btn:hover {
  background: #666;
}

& .override-buttons {
  display: inline-flex;
  gap: 4px;
  width: 130px;
  flex-shrink: 0;
  justify-content: flex-start;
  align-self: flex-start;
}

& .override-buttons .button {
  min-width: 60px;
  text-align: center;
}

& .import-override {
  border: 1.5px solid lightgrey;
  border-radius: 3px;
  box-sizing: border-box;
  font-size: .75rem;
  padding: .2rem;
  padding-right: 22px;
  transition: all .15s ease-in-out;
  width: 210px;
}

& .import-override:read-only {
  background-color: #f5f5f5;
  cursor: default;
}

& .import-override.editing {
  background-color: #fff;
  border-color: var(--blue);
}

& .import-override:focus {
  border-color: var(--blue);
  outline: none;
}

& .import-override.active {
  color: var(--green);
  font-weight: 600;
}

& .import-override-header {
  display: flex;
  align-items: center;
  gap: 12px;
  vertical-align: middle;
}

& .reset-all-btn {
  background-color: var(--pink);
  color: #fff;
  font-size: .7rem;
  padding: .2rem .5rem;
  line-height: 1.2;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
}

& .reset-all-btn:hover {
  background-color: #c4264f;
}

& .reset-confirm {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

& .reset-confirm-text {
  color: var(--pink);
  font-size: .75rem;
  font-weight: normal;
  line-height: 1.2;
}

& .reset-confirm-btn {
  background-color: var(--pink);
  color: #fff;
  font-size: .7rem;
  padding: .2rem .5rem;
  line-height: 1.2;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
}

& .reset-confirm-btn:hover {
  background-color: #c4264f;
}

& .reset-cancel-btn {
  background-color: var(--gray);
  color: #fff;
  font-size: .7rem;
  padding: .2rem .5rem;
  line-height: 1.2;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
}

& .reset-cancel-btn:hover {
  background-color: #6a6f7d;
}
`;
