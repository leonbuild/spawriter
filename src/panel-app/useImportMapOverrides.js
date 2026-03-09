import { useState, useEffect, useCallback, useRef } from "react";
import { evalCmd, ProtocolError } from "../inspected-window.helper.js";
import browser from "webextension-polyfill";

// 全局操作版本号，用于识别最新的操作
let globalOperationVersion = 0;

// 使用 bypassCache 刷新页面，确保加载最新资源
async function reloadWithBypassCache() {
  const tabId = browser.devtools.inspectedWindow.tabId;
  // 通过 background script 调用 tabs.reload（在 Firefox devtools panel 中直接调用 tabs API 会失败）
  try {
    await browser.runtime.sendMessage({
      type: "tabs-reload",
      tabId,
      bypassCache: true,
    });
  } catch (err) {
    // Silently handle extension context invalidation
    if (err.message && err.message.includes("Extension context invalidated")) {
      console.debug("[spawriter] Service worker terminated during reload, this is expected");
      return;
    }
    throw err;
  }
}

// 判断是否为可恢复的协议错误（不应导致面板崩溃）
function isRecoverableProtocolError(err) {
  return err instanceof ProtocolError || err?.isRecoverable === true;
}

// 等待页面加载完成
async function waitForPageLoad(maxWaitMs = 30000) {
  const tabId = browser.devtools.inspectedWindow.tabId;
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const checkStatus = async () => {
      try {
        // 通过 background script 获取 tab 状态（在 Firefox devtools panel 中直接调用 tabs API 会失败）
        const response = await browser.runtime.sendMessage({
          type: "tabs-get",
          tabId,
        });
        if (response?.tab?.status === "complete") {
          resolve(true);
          return;
        }
        
        // 超时检查
        if (Date.now() - startTime > maxWaitMs) {
          console.warn("[spawriter] Page load timeout, proceeding anyway");
          resolve(false);
          return;
        }
        
        // 继续等待
        setTimeout(checkStatus, 200);
      } catch (err) {
        // Silently handle extension context invalidation
        if (err.message && err.message.includes("Extension context invalidated")) {
          console.debug("[spawriter] Service worker terminated during status check");
          resolve(false);
          return;
        }
        console.warn("[spawriter] Error checking tab status:", err);
        resolve(false);
      }
    };
    
    checkStatus();
  });
}

// 延迟函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 等待 importMapOverrides 对象可用
async function ensureImportMapOverridesReady(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start <= maxWaitMs) {
    try {
      const ready = await evalCmd(`(function() {
        return !!(window.importMapOverrides && window.importMapOverrides.addOverride && window.importMapOverrides.removeOverride);
      })()`, { retries: 0 });
      if (ready) return true;
    } catch (err) {
      // 对于协议错误交由上层处理；这里仅作为存在性检查
      if (!isRecoverableProtocolError(err)) {
        console.debug("[spawriter] ensureImportMapOverridesReady non-recoverable:", err?.message || err);
      }
    }
    await delay(200);
  }
  return false;
}

// 判断错误是否由 importMapOverrides 未加载导致
function isMissingImportMapOverrides(err) {
  const msg = err?.message || "";
  return (
    msg.includes("importMapOverrides") ||
    msg.includes("addOverride") ||
    msg.includes("removeOverride") ||
    msg.includes("Cannot read properties of undefined")
  );
}

export default function useImportMapOverrides() {
  const [importMapsEnabled, setImportMapEnabled] = useState(false);
  const [overrides, setOverrides] = useState({});
  const [savedOverrides, setSavedOverrides] = useState({});
  const [appError, setAppError] = useState();
  // 新增：加载状态，用于显示页面正在加载
  const [isLoading, setIsLoading] = useState(false);
  // 新增：协议错误状态（可恢复，不崩溃）
  const [protocolError, setProtocolError] = useState(null);
  // 新增：用于跟踪当前操作版本号的 ref
  const currentOperationRef = useRef(0);
  // 新增：是否正在进行验证刷新，避免无限循环
  const isVerifyingRef = useRef(false);
  // 新增：是否正在从已保存配置中应用到页面，避免重复触发
  const isApplyingSavedRef = useRef(false);

  if (appError) {
    throw appError;
  }

  // ========== 新增：验证和同步方法 ==========

  // 获取页面上当前的 override 状态
  async function getPageOverrideState(appName) {
    try {
      const result = await evalCmd(`(function() {
        if (!window.importMapOverrides) return null;
        const overrides = window.importMapOverrides.getOverrideMap();
        return overrides.imports["${appName}"] || null;
      })()`);
      return result;
    } catch (err) {
      console.warn("[spawriter] Error getting page override state:", err);
      return null;
    }
  }

  // 获取页面上完整的 override map
  async function getCurrentOverrideMap() {
    try {
      const result = await evalCmd(`(function() {
        if (!window.importMapOverrides) return null;
        const overrides = window.importMapOverrides.getOverrideMap();
        return overrides.imports || {};
      })()`);
      return result;
    } catch (err) {
      console.warn("[spawriter] Error getting current override map:", err);
      return null;
    }
  }

  // 确保页面上的 import map 与保存的状态一致（用于页面刷新/重新进入）
  async function ensureSavedOverridesApplied(reason = "unknown", overridesMap = savedOverrides) {
    if (!importMapsEnabled) {
      return;
    }
    const effectiveOverrides = overridesMap || {};
    if (Object.keys(effectiveOverrides).length === 0) {
      return;
    }
    if (isApplyingSavedRef.current) {
      console.debug("[spawriter] Skipping ensureSavedOverridesApplied - already running");
      return;
    }

    let needsRetry = false;
    isApplyingSavedRef.current = true;
    try {
      await waitForPageLoad();

      const ready = await ensureImportMapOverridesReady();
      if (!ready) {
        console.debug("[spawriter] importMapOverrides not ready, schedule retry ensureSavedOverridesApplied");
        needsRetry = true;
        return;
      }

      const pageMap = await getCurrentOverrideMap();
      if (pageMap === null) {
        console.debug("[spawriter] importMapOverrides not ready, skip ensure step");
        needsRetry = true;
        return;
      }

      let changed = false;

      // 遍历保存的配置，确保页面状态一致
      for (const [appName, saved] of Object.entries(effectiveOverrides)) {
        const expectedUrl = saved?.url;
        const expectedEnabled = saved?.enabled && !!expectedUrl;
        const pageUrl = pageMap[appName];

        if (expectedEnabled) {
          if (pageUrl !== expectedUrl) {
            console.debug(`[spawriter] Applying saved override for ${appName} (reason=${reason})`);
            const ok = await addOverride(appName, expectedUrl);
            changed = changed || ok;
            if (!ok) needsRetry = true;
          }
        } else {
          if (pageUrl) {
            console.debug(`[spawriter] Removing stale override for ${appName} (reason=${reason})`);
            const ok = await removeOverride(appName);
            changed = changed || ok;
            if (!ok) needsRetry = true;
          }
        }
      }

      // 如果页面上有额外的 override 但未在 savedOverrides 中，也移除以保持一致
      for (const pageAppName of Object.keys(pageMap)) {
        if (!effectiveOverrides[pageAppName]) {
          console.debug(`[spawriter] Removing extra override ${pageAppName} not in savedOverrides (reason=${reason})`);
          const ok = await removeOverride(pageAppName);
          changed = changed || ok;
          if (!ok) needsRetry = true;
        }
      }

      if (changed) {
        await reloadWithBypassCache();
      }
    } catch (err) {
      console.warn("[spawriter] Error ensuring saved overrides applied:", err);
    } finally {
      isApplyingSavedRef.current = false;
    }

    // 需要重试时安排一次延时重试
    if (needsRetry && importMapsEnabled && Object.keys(effectiveOverrides).length > 0) {
      setTimeout(() => {
        ensureSavedOverridesApplied(`${reason}-retry`, effectiveOverrides);
      }, 500);
    }
  }

  // 验证页面状态是否与期望状态一致
  async function verifyAndSyncState(appName, expectedEnabled, expectedUrl, operationVersion) {
    // 如果不是最新操作，跳过验证
    if (operationVersion !== currentOperationRef.current) {
      console.debug(`[spawriter] Skipping verification for outdated operation (v${operationVersion}, current: v${currentOperationRef.current})`);
      return;
    }

    // 避免验证时的无限循环
    if (isVerifyingRef.current) {
      console.debug("[spawriter] Skipping verification - already verifying");
      return;
    }

    try {
      isVerifyingRef.current = true;
      
      // 等待页面加载完成
      await waitForPageLoad();
      
      // 再次检查是否仍是最新操作
      if (operationVersion !== currentOperationRef.current) {
        console.debug(`[spawriter] Operation outdated after page load (v${operationVersion}, current: v${currentOperationRef.current})`);
        return;
      }

      // 等待一小段时间让 importMapOverrides 初始化
      await delay(500);

      // 获取页面上的实际状态
      const pageOverrideUrl = await getPageOverrideState(appName);
      
      // 判断页面状态是否正确
      const pageHasOverride = !!pageOverrideUrl;
      const shouldHaveOverride = expectedEnabled && !!expectedUrl;

      console.debug(`[spawriter] Verifying state for ${appName}:`, {
        pageHasOverride,
        pageOverrideUrl,
        shouldHaveOverride,
        expectedEnabled,
        expectedUrl,
        operationVersion
      });

      // 如果状态不一致，需要修复
      if (pageHasOverride !== shouldHaveOverride) {
        console.warn(`[spawriter] State mismatch detected for ${appName}! Page: ${pageHasOverride}, Expected: ${shouldHaveOverride}. Resyncing...`);
        
        // 再次检查是否仍是最新操作
        if (operationVersion !== currentOperationRef.current) {
          console.debug("[spawriter] Operation outdated, skipping resync");
          return;
        }

        // 重新应用正确的状态
        let ok = true;
        if (shouldHaveOverride) {
          ok = await addOverride(appName, expectedUrl);
        } else {
          ok = await removeOverride(appName);
        }

        if (ok) {
          // 再次刷新页面
          await reloadWithBypassCache();
        } else {
          // 如果仍未就绪，稍后再补偿
          setTimeout(() => {
            ensureSavedOverridesApplied("verify-retry");
          }, 400);
        }
        
        // 递归验证，但只验证一次（通过 isVerifyingRef 控制）
        // 注意：这里不再递归验证，因为我们已经设置了 isVerifyingRef
      }
    } catch (err) {
      console.warn("[spawriter] Error during state verification:", err);
    } finally {
      isVerifyingRef.current = false;
    }
  }

  // ========== 原有方法 ==========

  async function checkImportMapOverrides() {
    try {
      const hasImportMapsEnabled = await evalCmd(`(function() {
        return !!window.importMapOverrides
      })()`);
      setProtocolError(null); // 成功后清除协议错误
      return hasImportMapsEnabled;
    } catch (err) {
      // 对于可恢复的协议错误，不抛出，只记录
      if (isRecoverableProtocolError(err)) {
        console.debug("[spawriter] Recoverable error during checkImportMapOverrides:", err.message);
        setProtocolError(err);
        return false;
      }
      err.message = `Error during hasImporMapsEnabled. ${err.message}`;
      setAppError(err);
    }
  }

  async function getImportMapOverrides() {
    try {
      const { imports } = await evalCmd(`(function() {
        return window.importMapOverrides.getOverrideMap()
      })()`);
      setOverrides(imports);
      setProtocolError(null); // 成功后清除协议错误
    } catch (err) {
      // 对于可恢复的协议错误，不抛出，只记录
      if (isRecoverableProtocolError(err)) {
        console.debug("[spawriter] Recoverable error during getImportMapOverrides:", err.message);
        setProtocolError(err);
        return;
      }
      err.message = `Error during getImportMapOverrides. ${err.message}`;
      setAppError(err);
    }
  }

  async function addOverride(currentMap, currentUrl) {
    try {
      const ready = await ensureImportMapOverridesReady();
      if (!ready) {
        console.warn("[spawriter] addOverride skipped because importMapOverrides not ready");
        return false;
      }
      await evalCmd(`(function() {
        return window.importMapOverrides.addOverride("${currentMap}", "${currentUrl}")
      })()`);
      return true;
    } catch (err) {
      if (isMissingImportMapOverrides(err)) {
        console.warn("[spawriter] addOverride failed because importMapOverrides missing (will retry later)");
        return false;
      }
      err.message = `Error during addOverride. ${err.message}`;
      setAppError(err);
      return false;
    }
  }

  async function removeOverride(currentMap) {
    try {
      const ready = await ensureImportMapOverridesReady();
      if (!ready) {
        console.warn("[spawriter] removeOverride skipped because importMapOverrides not ready");
        // Fallback: directly remove from localStorage as backup
        await removeOverrideFromLocalStorage(currentMap);
        return false;
      }
      await evalCmd(`(function() {
        return window.importMapOverrides.removeOverride("${currentMap}")
      })()`);
      return true;
    } catch (err) {
      if (isMissingImportMapOverrides(err)) {
        console.warn("[spawriter] removeOverride failed because importMapOverrides missing (will retry later)");
        // Fallback: directly remove from localStorage as backup
        await removeOverrideFromLocalStorage(currentMap);
        return false;
      }
      err.message = `Error during removeOverride. ${err.message}`;
      setAppError(err);
      return false;
    }
  }

  // Fallback method: directly remove override from localStorage
  // This is used when importMapOverrides is not ready but we need to ensure the override is removed
  async function removeOverrideFromLocalStorage(appName) {
    try {
      await evalCmd(`(function() {
        // import-map-overrides stores overrides with key format: import-map-override:${appName}
        localStorage.removeItem("import-map-override:${appName}");
        console.debug("[spawriter] Directly removed localStorage key: import-map-override:${appName}");
      })()`);
    } catch (err) {
      console.warn("[spawriter] Failed to directly remove from localStorage:", err);
    }
  }

  // Clear all import-map-override entries from localStorage
  // This ensures complete cleanup when Reset All is called
  async function clearAllOverridesFromLocalStorage() {
    try {
      await evalCmd(`(function() {
        // Find and remove all localStorage keys that start with "import-map-override:"
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("import-map-override:")) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => {
          localStorage.removeItem(key);
          console.debug("[spawriter] Directly removed localStorage key:", key);
        });
        console.debug("[spawriter] Cleared " + keysToRemove.length + " import-map-override entries from localStorage");
      })()`);
    } catch (err) {
      console.warn("[spawriter] Failed to clear all overrides from localStorage:", err);
    }
  }

  async function batchSetOverrides() {
    try {
      const overrideCalls = Object.entries(overrides).map(([map, url]) =>
        !url ? removeOverride(map) : addOverride(map, url)
      );
      await Promise.all(overrideCalls);
      await reloadWithBypassCache();
    } catch (err) {
      err.message = `Error during batchSetOverrides. ${err.message}`;
      setAppError(err);
    }
  }

  // ========== 新增方法: Storage 操作 ==========

  // 从 browser.storage.local 加载已保存的 overrides
  const loadSavedOverrides = useCallback(async () => {
    try {
      const result = await browser.storage.local.get("savedOverrides");
      if (result.savedOverrides) {
        setSavedOverrides(result.savedOverrides);
        return result.savedOverrides;
      }
      return {};
    } catch (err) {
      err.message = `Error loading saved overrides: ${err.message}`;
      setAppError(err);
      return {};
    }
  }, []);

  // 保存单个 override 到 storage，并应用到页面
  const saveOverride = useCallback(async (appName, url) => {
    try {
      // 递增全局操作版本号
      globalOperationVersion++;
      const thisOperationVersion = globalOperationVersion;
      currentOperationRef.current = thisOperationVersion;
      
      console.debug(`[spawriter] Save override for ${appName}: url=${url}, version=${thisOperationVersion}`);

      const newSavedOverrides = {
        ...savedOverrides,
        [appName]: { url, enabled: true }
      };
      await browser.storage.local.set({ savedOverrides: newSavedOverrides });
      setSavedOverrides(newSavedOverrides);
      
      // 检查这是否仍是最新操作
      if (thisOperationVersion !== currentOperationRef.current) {
        console.debug(`[spawriter] Operation ${thisOperationVersion} superseded, skipping page update`);
        return;
      }

      // 应用到页面
      const ok = await addOverride(appName, url);
      if (!ok) {
        // importMapOverrides 尚未就绪，稍后再补偿
        setTimeout(() => {
          ensureSavedOverridesApplied("save-retry", newSavedOverrides);
        }, 400);
        return;
      }

      // 再次检查
      if (thisOperationVersion !== currentOperationRef.current) {
        return;
      }

      // 使用 bypassCache 刷新，确保加载新的 override 资源
      await reloadWithBypassCache();

      // 页面刷新后验证状态
      setTimeout(() => {
        verifyAndSyncState(appName, true, url, thisOperationVersion);
      }, 100);
    } catch (err) {
      err.message = `Error saving override: ${err.message}`;
      setAppError(err);
    }
  }, [savedOverrides]);

  // 切换单个 override 的启用状态
  const toggleOverride = useCallback(async (appName, enabled) => {
    try {
      const saved = savedOverrides[appName];
      if (!saved) return;

      // 递增全局操作版本号，标记这是最新的操作
      globalOperationVersion++;
      const thisOperationVersion = globalOperationVersion;
      currentOperationRef.current = thisOperationVersion;
      
      console.debug(`[spawriter] Toggle override for ${appName}: enabled=${enabled}, version=${thisOperationVersion}`);

      // 更新 storage 中的 enabled 状态
      const newSavedOverrides = {
        ...savedOverrides,
        [appName]: { ...saved, enabled }
      };
      await browser.storage.local.set({ savedOverrides: newSavedOverrides });
      setSavedOverrides(newSavedOverrides);

      // 检查这是否仍是最新操作
      if (thisOperationVersion !== currentOperationRef.current) {
        console.debug(`[spawriter] Operation ${thisOperationVersion} superseded by ${currentOperationRef.current}, skipping page update`);
        return;
      }

      // 应用或移除 override
      let ok = true;
      if (enabled) {
        ok = await addOverride(appName, saved.url);
      } else {
        ok = await removeOverride(appName);
        // 关闭时，无论 API 是否成功，都直接清理 localStorage 作为保障
        await removeOverrideFromLocalStorage(appName);
      }
      if (!ok) {
        setTimeout(() => {
          ensureSavedOverridesApplied("toggle-retry", newSavedOverrides);
        }, 400);
        return;
      }

      // 再次检查是否仍是最新操作
      if (thisOperationVersion !== currentOperationRef.current) {
        console.debug(`[spawriter] Operation ${thisOperationVersion} superseded before reload, skipping`);
        return;
      }

      // 使用 bypassCache 刷新，确保加载正确的资源（override 或原版）
      await reloadWithBypassCache();

      // 页面刷新后验证状态是否正确
      // 使用 setTimeout 让刷新先开始，然后异步验证
      setTimeout(() => {
        verifyAndSyncState(appName, enabled, saved.url, thisOperationVersion);
      }, 100);
      
    } catch (err) {
      err.message = `Error toggling override: ${err.message}`;
      setAppError(err);
    }
  }, [savedOverrides]);

  // 清除已保存的 override
  const clearSavedOverride = useCallback(async (appName) => {
    // 递增全局操作版本号
    globalOperationVersion++;
    const thisOperationVersion = globalOperationVersion;
    currentOperationRef.current = thisOperationVersion;
    
    console.debug(`[spawriter] Clear override for ${appName}, version=${thisOperationVersion}`);

    try {
      const newSavedOverrides = { ...savedOverrides };
      delete newSavedOverrides[appName];
      await browser.storage.local.set({ savedOverrides: newSavedOverrides });
      setSavedOverrides(newSavedOverrides);
      
      // 检查这是否仍是最新操作
      if (thisOperationVersion !== currentOperationRef.current) {
        return;
      }

      // 同时移除页面上的 override（通过 API）
      const ok = await removeOverride(appName);
      
      // 无论 API 是否成功，都直接清理 localStorage 作为保障
      await removeOverrideFromLocalStorage(appName);
      
      if (!ok) {
        setTimeout(() => {
          ensureSavedOverridesApplied("clear-saved-retry", newSavedOverrides);
        }, 400);
      }
    } catch (err) {
      err.message = `Error clearing saved override: ${err.message}`;
      setAppError(err);
    }
    
    // 再次检查
    if (thisOperationVersion !== currentOperationRef.current) {
      return;
    }

    // 无论如何都刷新页面，使用 bypassCache 确保加载原版资源
    await reloadWithBypassCache();

    // 页面刷新后验证状态
    setTimeout(() => {
      verifyAndSyncState(appName, false, null, thisOperationVersion);
    }, 100);
  }, [savedOverrides]);

  // 清除所有已保存的 overrides
  const clearAllOverrides = useCallback(async () => {
    // 递增全局操作版本号
    globalOperationVersion++;
    const thisOperationVersion = globalOperationVersion;
    currentOperationRef.current = thisOperationVersion;
    
    console.debug(`[spawriter] Clear all overrides, version=${thisOperationVersion}`);

    try {
      // 移除页面上所有的 overrides (通过 importMapOverrides API)
      const removePromises = await Promise.all(
        Object.keys(savedOverrides).map(appName => removeOverride(appName))
      );
      const anyRemoveFailed = removePromises.some((ok) => ok === false);
      
      // 无论 API 是否成功，都直接清理 localStorage 作为保障
      // 这确保即使 importMapOverrides 未加载，也能完全清除
      await clearAllOverridesFromLocalStorage();
      
      // 检查这是否仍是最新操作
      if (thisOperationVersion !== currentOperationRef.current) {
        return;
      }

      // 清空扩展的 storage
      await browser.storage.local.set({ savedOverrides: {} });
      setSavedOverrides({});
      
      // 使用 bypassCache 刷新页面，确保加载原版资源
      await reloadWithBypassCache();

      // 对于 clearAll，我们不需要单独验证每个 app，
      // 但如果需要，可以在这里添加批量验证逻辑
      if (anyRemoveFailed) {
        setTimeout(() => {
          ensureSavedOverridesApplied("clear-all-retry", {});
        }, 400);
      }
    } catch (err) {
      err.message = `Error clearing all overrides: ${err.message}`;
      setAppError(err);
    }
  }, [savedOverrides]);

  // ========== 初始化 ==========

  // 初始化时加载 importMapOverrides 和已保存的配置
  useEffect(() => {
    async function initImportMapsOverrides() {
      const hasImportMapsEnabled = await checkImportMapOverrides();
      if (hasImportMapsEnabled) {
        setImportMapEnabled(hasImportMapsEnabled);
        await getImportMapOverrides();
        const saved = await loadSavedOverrides();
        await ensureSavedOverridesApplied("init", saved);
      }
    }

    try {
      initImportMapsOverrides();
    } catch (err) {
      err.message = `Error during initImportMapsOverrides. ${err.message}`;
      setAppError(err);
    }
  }, []);

  // 监听页面加载完成（包括手动刷新）后再校验一次
  // 注意：在 Firefox devtools panel 中无法直接访问 browser.tabs API，
  // 需要通过 background script 转发 tab-updated 事件
  useEffect(() => {
    const tabId = browser.devtools.inspectedWindow.tabId;
    const handler = (event) => {
      const msg = event.detail;
      if (msg?.type === "tab-updated" && msg.tabId === tabId) {
        ensureSavedOverridesApplied("tab-updated");
      }
    };

    // 监听从 background script 通过 port 转发的事件
    window.addEventListener("ext-content-script", handler);
    return () => window.removeEventListener("ext-content-script", handler);
  }, [importMapsEnabled, savedOverrides]);

  // ========== 原有方法 ==========

  const setOverride = (mapping, url) => {
    const newOverrides = {
      ...overrides,
      [mapping]: url,
    };
    setOverrides(newOverrides);
  };

  // ========== 返回值 ==========

  return {
    enabled: importMapsEnabled,
    overrides,
    savedOverrides,
    setOverride,
    saveOverride,
    toggleOverride,
    clearSavedOverride,
    clearAllOverrides,
    commitOverrides: batchSetOverrides,
    loadSavedOverrides,  // 暴露加载方法供外部使用
    ensureSavedOverridesApplied,  // 暴露应用方法供外部使用
    // 新增：暴露状态和方法供外部使用
    isLoading,
    protocolError,
    clearProtocolError: () => setProtocolError(null),
  };
}
