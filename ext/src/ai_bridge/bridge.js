import browser from "webextension-polyfill";

(function () {
  "use strict";

  let attachedTabs = new Map();
  let tabStates = new Map();
  let debuggerEventListenerRegistered = false;
  let offscreenReady = false;

  async function persistState() {
    try {
      await chrome.storage.session.set({
        _attachedTabs: [...attachedTabs.entries()],
        _tabStates: [...tabStates.entries()],
      });
    } catch (_) {}
  }

  async function restoreState() {
    try {
      const data = await chrome.storage.session.get(["_attachedTabs", "_tabStates"]);
      if (data._attachedTabs) attachedTabs = new Map(data._attachedTabs);
      if (data._tabStates) tabStates = new Map(data._tabStates);
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    console.log("[spawriter]", new Date().toISOString(), ...args);
  }

  function error(...args) {
    console.error("[spawriter ERROR]", new Date().toISOString(), ...args);
  }

  function warn(...args) {
    console.warn("[spawriter WARN]", new Date().toISOString(), ...args);
  }

  function isRestrictedUrl(url) {
    if (!url) return false;
    return (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:")
    );
  }

  function getConnectionState() {
    return offscreenReady ? "connected" : "idle";
  }

  function getTabState(tabId) {
    return tabStates.get(tabId) || "idle";
  }

  function setTabState(tabId, state) {
    if (state === "idle") {
      tabStates.delete(tabId);
    } else {
      tabStates.set(tabId, state);
    }
    persistState();
  }

  function getConnectedCount() {
    return Array.from(tabStates.values()).filter((s) => s === "connected").length;
  }

  const icons = {
    connected: {
      path: {
        "16": "/build/icons/icon-green-16.png",
        "32": "/build/icons/icon-green-32.png",
        "48": "/build/icons/icon-green-48.png",
        "128": "/build/icons/icon-green-128.png",
      },
    },
    gray: {
      path: {
        "16": "/build/icons/icon-gray-16.png",
        "32": "/build/icons/icon-gray-32.png",
        "48": "/build/icons/icon-gray-48.png",
        "128": "/build/icons/icon-gray-128.png",
      },
    },
    idle: {
      path: {
        "16": "/build/icons/icon-16.png",
        "32": "/build/icons/icon-32.png",
        "48": "/build/icons/icon-48.png",
        "128": "/build/icons/icon-128.png",
      },
    },
  };

  async function updateIcons() {
    const connectedCount = getConnectedCount();

    const actionApi =
      typeof browser !== "undefined" && browser.action
        ? browser.action
        : chrome.action;
    if (!actionApi) return;

    let allTabs;
    try {
      allTabs = await browser.tabs.query({});
    } catch (e) {
      warn("updateIcons: tabs.query failed:", e.message);
      return;
    }

    const tabUrlMap = new Map(allTabs.map((t) => [t.id, t.url]));
    const allTabIds = [
      undefined,
      ...allTabs.map((t) => t.id).filter((id) => id !== undefined),
    ];

    for (const tabId of allTabIds) {
      const state = tabId !== undefined ? getTabState(tabId) : "idle";
      const tabUrl = tabId !== undefined ? tabUrlMap.get(tabId) : undefined;
      const restricted = tabId !== undefined && isRestrictedUrl(tabUrl);

      let title, badgeText, badgeColor, iconPath;

      if (restricted) {
        title = "spawriter - Cannot attach to this page";
        badgeText = connectedCount > 0 ? String(connectedCount) : "";
        badgeColor = "#9E9E9E";
        iconPath = icons.gray.path;
      } else if (state === "error") {
        title = "spawriter - Error (click to retry)";
        badgeText = "!";
        badgeColor = "#F44336";
        iconPath = icons.gray.path;
      } else if (state === "connecting") {
        title = "spawriter - Connecting...";
        badgeText = "...";
        badgeColor = "#FFC107";
        iconPath = icons.gray.path;
      } else if (state === "connected") {
        title = "spawriter - Connected (click to disconnect)";
        badgeText = connectedCount > 0 ? String(connectedCount) : "";
        badgeColor = "#4CAF50";
        iconPath = icons.connected.path;
      } else {
        title = "spawriter - Click to attach debugger";
        badgeText = connectedCount > 0 ? String(connectedCount) : "";
        badgeColor = "#9E9E9E";
        iconPath = icons.idle.path;
      }

      try {
        void actionApi.setIcon({ tabId, path: iconPath });
        void actionApi.setTitle({ tabId, title });
        void actionApi.setBadgeText({ tabId, text: badgeText });
        void actionApi.setBadgeBackgroundColor({ tabId, color: badgeColor });
      } catch (e) {
        /* ignore per-tab errors */
      }
    }
  }

  function ensureDebuggerEventListener() {
    if (debuggerEventListenerRegistered) return;
    if (!chrome.debugger?.onEvent || !chrome.debugger?.onDetach) {
      error("chrome.debugger API not available — extension may lack 'debugger' permission");
      return;
    }

    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source?.tabId;
      if (typeof tabId !== "number") return;

      const tabInfo = attachedTabs.get(tabId);
      if (!tabInfo) return;

      sendMessage({
        method: "forwardCDPEvent",
        params: { method, sessionId: tabInfo.sessionId, params },
      });
    });

    chrome.debugger.onDetach.addListener((source, detachReason) => {
      const tabId = source?.tabId;
      if (typeof tabId !== "number") return;
      emitDetachedFromTarget(tabId, detachReason || "detached");
      setTabState(tabId, "idle");
      updateIcons();
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      emitDetachedFromTarget(tabId, "tab-removed");
      setTabState(tabId, "idle");
      updateIcons();
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      updateIcons();
      if (changeInfo.status === "complete" && attachedTabs.has(tabId)) {
        markTabTitle(tabId, true);
      }
    });

    debuggerEventListenerRegistered = true;
  }

  const TAB_TITLE_PREFIX = "🟢 ";

  async function markTabTitle(tabId, attach) {
    try {
      const prefix = TAB_TITLE_PREFIX;
      if (attach) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (p) => {
            if (window.__spawriterTitleObserver) return;
            const ensure = () => {
              if (!document.title.startsWith(p)) document.title = p + document.title;
            };
            ensure();
            const titleEl = document.querySelector("title");
            if (titleEl) {
              const obs = new MutationObserver(ensure);
              obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
              window.__spawriterTitleObserver = obs;
            }
            const origDesc = Object.getOwnPropertyDescriptor(Document.prototype, "title") ||
                             Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "title");
            if (origDesc?.set) {
              Object.defineProperty(document, "title", {
                get: origDesc.get,
                set(v) {
                  origDesc.set.call(this, v.startsWith(p) ? v : p + v);
                },
                configurable: true,
              });
              window.__spawriterOrigTitleDesc = origDesc;
            }
          },
          args: [prefix],
        });
      } else {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (p) => {
            if (window.__spawriterTitleObserver) {
              window.__spawriterTitleObserver.disconnect();
              window.__spawriterTitleObserver = null;
            }
            if (window.__spawriterOrigTitleDesc) {
              Object.defineProperty(document, "title", window.__spawriterOrigTitleDesc);
              window.__spawriterOrigTitleDesc = null;
            }
            if (document.title.startsWith(p)) document.title = document.title.slice(p.length);
          },
          args: [prefix],
        });
      }
    } catch (_) {}
  }

  function emitDetachedFromTarget(tabId, reason) {
    const tabInfo = attachedTabs.get(tabId);
    if (!tabInfo) return;

    attachedTabs.delete(tabId);
    persistState();
    markTabTitle(tabId, false);
    sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.detachedFromTarget",
        sessionId: tabInfo.sessionId,
        params: { sessionId: tabInfo.sessionId, reason },
      },
    });
    log(`Detached target for tab ${tabId}: ${reason}`);
  }

  // --- Offscreen-based WebSocket communication ---

  let offscreenCreating = null;

  async function ensureOffscreen() {
    if (offscreenCreating) return offscreenCreating;
    offscreenCreating = _createOffscreen();
    try {
      await offscreenCreating;
    } finally {
      offscreenCreating = null;
    }
  }

  async function _createOffscreen() {
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (existingContexts.length > 0) {
        log("Offscreen document already exists");
        return;
      }
    } catch (e) {
      warn("getContexts failed:", e.message);
    }

    try {
      await chrome.offscreen.createDocument({
        url: "build/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Persistent WebSocket connection to spawriter CDP relay",
      });
      log("Offscreen document created successfully");
    } catch (e) {
      if (e.message?.includes("Only a single offscreen")) {
        log("Offscreen document already exists (race)");
      } else {
        error("Failed to create offscreen document:", e.message);
        throw e;
      }
    }
  }

  async function ensureRelayConnected() {
    await ensureOffscreen();
    if (offscreenReady) return;
    for (let i = 0; i < 20; i++) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "ws-status" });
        if (resp?.state === "open") {
          offscreenReady = true;
          return;
        }
      } catch (_) {}
      await sleep(500);
    }
    warn("Relay WebSocket not open after waiting");
  }

  function sendMessage(message) {
    try {
      chrome.runtime.sendMessage({ type: "ws-send", payload: message }).catch(() => {
        warn("Cannot send message, offscreen not available");
      });
    } catch (_) {
      warn("Cannot send message, offscreen not available");
    }
  }

  function handleRelayIncoming(message) {
    if (message.method === "ping") {
      sendMessage({ method: "pong" });
      return;
    }

    if (message.method === "forwardCDPCommand") {
      handleCDPCommand(message).catch((e) => {
        error("Unhandled error in CDP command:", e);
        sendMessage({ id: message.id, error: e.message || String(e) });
      });
      return;
    }

    if (message.method === "connectActiveTab" || message.method === "connectTabByMatch") {
      handleRelayMessage(message)
        .then((result) => sendMessage({ id: message.id, ...result }))
        .catch((e) => sendMessage({ id: message.id, success: false, error: e.message }));
      return;
    }

    error("Unknown message from relay:", message);
  }

  // --- CDP command handling ---

  const SLOW_CDP_METHODS = new Set([
    "Accessibility.getFullAXTree",
    "Page.captureScreenshot",
    "Network.clearBrowserCache",
    "Network.clearBrowserCookies",
    "Page.reload",
    "Page.navigate",
  ]);
  const CDP_COMMAND_TIMEOUT_MS = 30000;
  const CDP_SLOW_COMMAND_TIMEOUT_MS = 60000;

  function sendCommandWithTimeout(tabId, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Extension CDP timeout (${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);

      chrome.debugger
        .sendCommand({ tabId }, method, params)
        .then(
          (result) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(result);
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          }
        );
    });
  }

  async function handleCDPCommand(message) {
    const { id, params } = message;
    const { method, sessionId, params: cdpParams } = params;

    let targetTabId = null;
    if (sessionId) {
      for (const [tabId, info] of attachedTabs.entries()) {
        if (info.sessionId === sessionId) {
          targetTabId = tabId;
          break;
        }
      }
      if (!targetTabId) {
        warn(`handleCDPCommand: sessionId ${sessionId} not found in attachedTabs (${attachedTabs.size} tabs known)`);
        sendMessage({ id, error: `Session ${sessionId} not found. Tab may have been detached or extension restarted.` });
        return;
      }
    }

    if (!targetTabId && attachedTabs.size > 0) {
      const firstEntry = attachedTabs.entries().next();
      if (!firstEntry.done) {
        targetTabId = firstEntry.value[0];
      }
    }

    if (!targetTabId) {
      try {
        targetTabId = await ensureActiveTabAttached();
      } catch (attachErr) {
        error(
          "No target tab available for CDP command:",
          attachErr?.message || attachErr
        );
      }
    }

    if (!targetTabId) {
      sendMessage({ id, error: "No target tab attached" });
      return;
    }

    try {
      const DOMAINS_TO_RECYCLE = ["Runtime.enable", "Page.enable"];
      if (DOMAINS_TO_RECYCLE.includes(method)) {
        const disableMethod = method.replace(".enable", ".disable");
        try {
          await chrome.debugger.sendCommand({ tabId: targetTabId }, disableMethod);
        } catch (_) {
          /* ignore disable errors */
        }
      }

      const timeoutMs = SLOW_CDP_METHODS.has(method)
        ? CDP_SLOW_COMMAND_TIMEOUT_MS
        : CDP_COMMAND_TIMEOUT_MS;
      const result = await sendCommandWithTimeout(
        targetTabId,
        method,
        cdpParams,
        timeoutMs
      );
      sendMessage({ id, result });
    } catch (err) {
      if (err.message && err.message.includes("not attached")) {
        warn(`handleCDPCommand: debugger detached for tab ${targetTabId}, attempting re-attach`);
        try {
          try { await chrome.debugger.detach({ tabId: targetTabId }); } catch (_) {}
          emitDetachedFromTarget(targetTabId, "debugger-lost");
          await attachTab(targetTabId);
          const result = await sendCommandWithTimeout(targetTabId, method, cdpParams, CDP_COMMAND_TIMEOUT_MS);
          sendMessage({ id, result });
          return;
        } catch (retryErr) {
          sendMessage({ id, error: `Re-attach failed: ${retryErr.message}` });
          return;
        }
      }
      sendMessage({ id, error: err.message });
    }
  }

  // --- Tab management ---

  async function connectTab(tabId) {
    try {
      log(`Starting connection to tab ${tabId}`);
      setTabState(tabId, "connecting");
      updateIcons();

      await ensureRelayConnected();
      await attachTab(tabId);

      log(`Successfully connected to tab ${tabId}`);
    } catch (err) {
      error(`Failed to connect tab ${tabId}:`, err);
      setTabState(tabId, "error");
      updateIcons();
    }
  }

  async function disconnectTab(tabId) {
    const tabInfo = attachedTabs.get(tabId);
    if (tabInfo) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch (e) {
        error(`Error detaching tab ${tabId}:`, e);
      }
      emitDetachedFromTarget(tabId, "user-disconnect");
    }
    setTabState(tabId, "idle");
    updateIcons();
    syncTabGroup();
  }

  async function toggleTab(tabId) {
    if (!tabId) return;

    try {
      const tab = await browser.tabs.get(tabId);
      if (isRestrictedUrl(tab?.url)) {
        log(`Cannot attach to restricted URL: ${tab.url}`);
        return;
      }
    } catch (e) {
      error("toggleTab: cannot get tab info:", e.message);
      return;
    }

    const state = getTabState(tabId);

    if (state === "error") {
      await disconnectTab(tabId);
      return;
    }

    if (state === "connecting") {
      log(`Tab ${tabId} is already connecting, ignoring click`);
      return;
    }

    if (state === "connected") {
      await disconnectTab(tabId);
    } else {
      await connectTab(tabId);
    }
  }

  async function attachTab(tabId, options = {}) {
    const skipAttachedEvent = options.skipAttachedEvent || false;

    const tab = await browser.tabs.get(tabId);
    if (isRestrictedUrl(tab?.url)) {
      throw new Error(`Cannot attach restricted URL: ${tab.url}`);
    }

    await chrome.debugger.attach({ tabId }, "1.3");

    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Page.enable"),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable"),
    ]);

    const sessionId = `spawriter-tab-${tabId}-${Date.now()}`;
    let mainFrameId = sessionId;
    try {
      const frameTree = await chrome.debugger.sendCommand(
        { tabId },
        "Page.getFrameTree"
      );
      mainFrameId = frameTree?.frameTree?.frame?.id || sessionId;
    } catch (e) {
      warn(`attachTab: failed to get frame tree for tab ${tabId}:`, e?.message);
    }
    const targetInfo = {
      targetId: mainFrameId,
      type: "page",
      tabId,
      title: tab?.title || "",
      url: tab?.url || "",
    };

    attachedTabs.set(tabId, {
      sessionId,
      attachedAt: Date.now(),
    });
    persistState();
    setTabState(tabId, "connected");

    if (!skipAttachedEvent) {
      sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          sessionId,
          params: { sessionId, targetInfo },
        },
      });
    }

    log(`Attached to tab ${tabId}, sessionId: ${sessionId}`);
    markTabTitle(tabId, true);
    updateIcons();
    syncTabGroup();
    return { tabId, sessionId };
  }

  async function syncTabGroup() {
    if (
      typeof chrome === "undefined" ||
      !chrome.tabs?.group ||
      !chrome.tabGroups?.update
    ) {
      log("syncTabGroup: tab group API not available");
      return;
    }
    try {
      const connectedTabIds = [...attachedTabs.keys()];
      log(`syncTabGroup: ${connectedTabIds.length} connected tabs:`, connectedTabIds);
      const existingGroups = await chrome.tabGroups.query({
        title: "spawriter",
      });

      if (connectedTabIds.length === 0) {
        for (const group of existingGroups) {
          const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
          const idsToUngroup = tabsInGroup
            .map((t) => t.id)
            .filter((id) => id !== undefined);
          if (idsToUngroup.length > 0) {
            await chrome.tabs.ungroup(idsToUngroup);
          }
        }
        return;
      }

      const groupId =
        existingGroups.length > 0 ? existingGroups[0].id : undefined;
      if (groupId !== undefined) {
        await chrome.tabs.group({ tabIds: connectedTabIds, groupId });
      } else {
        const newGroupId = await chrome.tabs.group({
          tabIds: connectedTabIds,
        });
        await chrome.tabGroups.update(newGroupId, {
          title: "spawriter",
          color: "green",
        });
      }
    } catch (e) {
      warn("syncTabGroup failed:", e.message, e.stack);
    }
  }

  async function detachAllTabs() {
    const tabIds = [...attachedTabs.keys()];
    for (const tabId of tabIds) {
      await disconnectTab(tabId);
    }
  }

  async function getActiveTab() {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tabs[0] || null;
  }

  async function ensureActiveTabAttached() {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) throw new Error("No active tab found");

    const needsAttach = !attachedTabs.has(activeTab.id) || !(await isDebuggerAttached(activeTab.id));
    if (needsAttach) {
      if (attachedTabs.has(activeTab.id)) {
        emitDetachedFromTarget(activeTab.id, "stale-entry");
      }
      await connectTab(activeTab.id);
    }

    return activeTab.id;
  }

  async function isDebuggerAttached(tabId) {
    try {
      const targets = await chrome.debugger.getTargets();
      return targets.some((t) => t.tabId === tabId && t.attached);
    } catch (_) {
      return false;
    }
  }

  async function resyncAttachedTabs() {
    try {
      const targets = await chrome.debugger.getTargets();
      const liveAttached = targets.filter(
        (t) => t.attached && t.type === "page" && t.tabId && !isRestrictedUrl(t.url)
      );

      if (liveAttached.length === 0) {
        log("resyncAttachedTabs: no live debugger sessions found");
        return;
      }

      log(`resyncAttachedTabs: found ${liveAttached.length} live debugger sessions`);

      for (const target of liveAttached) {
        const tabId = target.tabId;
        if (attachedTabs.has(tabId)) continue;

        const sessionId = `spawriter-tab-${tabId}-${Date.now()}`;
        let mainFrameId = sessionId;
        try {
          const frameTree = await chrome.debugger.sendCommand(
            { tabId },
            "Page.getFrameTree"
          );
          mainFrameId = frameTree?.frameTree?.frame?.id || sessionId;
        } catch (e) {
          warn(`resyncAttachedTabs: failed to get frame tree for tab ${tabId}:`, e?.message);
        }

        let tab;
        try {
          tab = await browser.tabs.get(tabId);
        } catch (_) {}

        attachedTabs.set(tabId, {
          sessionId,
          attachedAt: Date.now(),
        });
        setTabState(tabId, "connected");

        const targetInfo = {
          targetId: mainFrameId,
          type: "page",
          tabId,
          title: tab?.title || target.title || "",
          url: tab?.url || target.url || "",
        };
        sendMessage({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            sessionId,
            params: { sessionId, targetInfo },
          },
        });

        log(`resyncAttachedTabs: re-registered tab ${tabId} with sessionId ${sessionId}`);
      }

      persistState();
      updateIcons();
      syncTabGroup();
    } catch (e) {
      error("resyncAttachedTabs: failed:", e?.message || e);
    }
  }

  async function clearCacheAndReload(tabId) {
    if (browser.browsingData?.remove) {
      await browser.browsingData.remove(
        { since: 0 },
        { cache: true, serviceWorkers: true }
      );
    } else {
      warn("browsingData API not available, skipping cache clear");
    }
    await browser.tabs.reload(tabId, { bypassCache: true });
    log(`Cleared cache and reloaded tab ${tabId}`);
  }

  // --- Relay message handlers (commands from relay via offscreen) ---

  async function handleRelayMessage(message) {
    if (message.method === "connectActiveTab") {
      const tabId = await ensureActiveTabAttached();
      return { success: true, tabId };
    }

    if (message.method === "connectTabByMatch") {
      const { url, tabId, create } = message.params || {};

      if (tabId) {
        try {
          const tab = await browser.tabs.get(tabId);
          if (isRestrictedUrl(tab?.url)) {
            return { success: false, error: `Cannot attach restricted URL: ${tab.url}` };
          }
          const needsAttach = !attachedTabs.has(tabId) || !(await isDebuggerAttached(tabId));
          if (needsAttach) {
            if (attachedTabs.has(tabId)) {
              emitDetachedFromTarget(tabId, "stale-entry");
            }
            await connectTab(tabId);
          }
          return { success: true, tabId };
        } catch (e) {
          return { success: false, error: `Tab ${tabId} not found: ${e.message}` };
        }
      }

      if (url) {
        const allTabs = await browser.tabs.query({});
        let match = allTabs.find(
          (t) => t.url && t.url.includes(url) && !isRestrictedUrl(t.url)
        );
        if (!match) {
          match = allTabs.find(
            (t) =>
              t.title &&
              t.title.toLowerCase().includes(url.toLowerCase()) &&
              !isRestrictedUrl(t.url)
          );
        }

        if (match) {
          const needsAttach = !attachedTabs.has(match.id) || !(await isDebuggerAttached(match.id));
          if (needsAttach) {
            if (attachedTabs.has(match.id)) {
              emitDetachedFromTarget(match.id, "stale-entry");
            }
            await connectTab(match.id);
          }
          return { success: true, tabId: match.id };
        }

        if (create) {
          const fullUrl = url.startsWith("http") ? url : `https://${url}`;
          const newTab = await browser.tabs.create({ url: fullUrl, active: false });
          await sleep(1000);
          await connectTab(newTab.id);
          return { success: true, tabId: newTab.id, created: true };
        }

        return {
          success: false,
          error: `No tab matching "${url}" found. Set create: true to create one.`,
        };
      }

      const activeTabId = await ensureActiveTabAttached();
      return { success: true, tabId: activeTabId };
    }

    if (message.method === "clearCacheAndReload") {
      const tabId = message.tabId || (await getActiveTab())?.id;
      if (!tabId) return { success: false, error: "No tab specified" };
      await clearCacheAndReload(tabId);
      return { success: true };
    }

    if (message.method === "getTabs") {
      const tabs = await browser.tabs.query({});
      return { success: true, tabs };
    }

    return { success: false, error: "Unknown command" };
  }

  // --- Init ---

  async function init() {
    log("spawriter bridge initializing...");
    await restoreState();
    ensureDebuggerEventListener();
    updateIcons();

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return undefined;

      if (message.type === "ws-message") {
        handleRelayIncoming(message.payload);
        return;
      }

      if (message.type === "ws-state-change") {
        offscreenReady = message.state === "open";
        log("Relay WebSocket state:", message.state);
        if (message.state === "closed") {
          for (const tabId of attachedTabs.keys()) {
            setTabState(tabId, "idle");
          }
          attachedTabs.clear();
          persistState();
          updateIcons();
          syncTabGroup();
        }
        if (message.state === "open") {
          resyncAttachedTabs();
        }
        return;
      }

      if (message.type === "spawriter-toggle") {
        const tabId = message.tabId;
        if (tabId) {
          toggleTab(tabId)
            .then(() => sendResponse({ success: true }))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            );
        } else {
          sendResponse({ success: false, error: "No tabId provided" });
        }
        return true;
      }

      if (message.type === "spawriter-status") {
        sendResponse({
          connectedCount: getConnectedCount(),
          wsConnected: offscreenReady,
          attachedTabIds: [...attachedTabs.keys()],
        });
        return true;
      }

      if (message.type === "ai-bridge-command") {
        const command = message.payload || message;
        handleRelayMessage(command)
          .then(sendResponse)
          .catch((err) =>
            sendResponse({ success: false, error: err.message })
          );
        return true;
      }

      return undefined;
    });

    ensureOffscreen()
      .then(async () => {
        try {
          const resp = await chrome.runtime.sendMessage({ type: "ws-status" });
          if (resp?.state === "open") {
            offscreenReady = true;
            resyncAttachedTabs();
          }
        } catch (_) {}
      })
      .catch((e) => {
        error("Offscreen setup failed:", e.message);
      });

    log("spawriter bridge initialized (offscreen relay connection active)");
  }

  if (typeof browser !== "undefined") {
    init();

    if (typeof globalThis !== "undefined") {
      globalThis.__spawriter = {
        toggleTab,
        connectTab,
        disconnectTab,
        getConnectionState,
        getTabState,
        getConnectedCount,
        attachTab,
        getActiveTab,
        ensureActiveTabAttached,
        clearCacheAndReload,
        detachAllTabs,
      };
    }
  }
})();
