import browser from "webextension-polyfill";

(function () {
  "use strict";

  const RELAY_PORT = "19989";
  const RELAY_URL = `ws://localhost:${RELAY_PORT}/extension`;

  let ws = null;
  let connectionPromise = null;
  let attachedTabs = new Map();
  let tabStates = new Map();
  let debuggerEventListenerRegistered = false;
  let consecutiveConnectionFailures = 0;
  let lastConnectionWarningAt = 0;
  let maintainLoopTimer = null;

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
    if (ws?.readyState === WebSocket.OPEN) return "connected";
    if (connectionPromise) return "connecting";
    return "idle";
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
  }

  function getConnectedCount() {
    return Array.from(tabStates.values()).filter((s) => s === "connected").length;
  }

  const icons = {
    connected: {
      path: {
        "16": "/icons/icon-green-16.png",
        "32": "/icons/icon-green-32.png",
        "48": "/icons/icon-green-48.png",
        "128": "/icons/icon-green-128.png",
      },
    },
    gray: {
      path: {
        "16": "/icons/icon-gray-16.png",
        "32": "/icons/icon-gray-32.png",
        "48": "/icons/icon-gray-48.png",
        "128": "/icons/icon-gray-128.png",
      },
    },
    idle: {
      path: {
        "16": "/icons/icon-16.png",
        "32": "/icons/icon-32.png",
        "48": "/icons/icon-48.png",
        "128": "/icons/icon-128.png",
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

    browser.tabs.onUpdated.addListener(() => {
      updateIcons();
    });

    debuggerEventListenerRegistered = true;
  }

  function emitDetachedFromTarget(tabId, reason) {
    const tabInfo = attachedTabs.get(tabId);
    if (!tabInfo) return;

    attachedTabs.delete(tabId);
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

  async function ensureConnection() {
    if (ws?.readyState === WebSocket.OPEN) return;
    if (connectionPromise) return connectionPromise;

    connectionPromise = connect();
    try {
      await connectionPromise;
    } finally {
      connectionPromise = null;
    }
  }

  function reportConnectionFailure(err) {
    consecutiveConnectionFailures += 1;
    const now = Date.now();
    const shouldWarn =
      consecutiveConnectionFailures === 1 ||
      now - lastConnectionWarningAt >= 60000;

    if (shouldWarn) {
      lastConnectionWarningAt = now;
      warn(
        `Relay unavailable (${err?.message || err}). Auto-retrying every 5s.`,
        `failure_count=${consecutiveConnectionFailures}`
      );
    }
  }

  function reportConnectionRecovery() {
    if (consecutiveConnectionFailures > 0) {
      log(
        `Relay connection recovered after ${consecutiveConnectionFailures} failed attempt(s)`
      );
    }
    consecutiveConnectionFailures = 0;
    lastConnectionWarningAt = 0;
  }

  async function connect() {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://localhost:${RELAY_PORT}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) break;
        if (attempt === 29)
          throw new Error(`Relay server unhealthy status: ${response.status}`);
        await sleep(1000);
      } catch (e) {
        if (attempt === 29) throw new Error("Relay server not available");
        await sleep(1000);
      }
    }

    log("Connecting to relay:", RELAY_URL);
    ws = new WebSocket(RELAY_URL);

    await new Promise((resolve, reject) => {
      let timeoutFired = false;
      const timeout = setTimeout(() => {
        timeoutFired = true;
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.onopen = () => {
        if (timeoutFired) return;
        clearTimeout(timeout);
        log("WebSocket connected");
        updateIcons();
        resolve();
      };

      ws.onerror = () => {
        if (!timeoutFired) {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        }
      };

      ws.onclose = (event) => {
        if (!timeoutFired) {
          clearTimeout(timeout);
          log("WebSocket closed:", event.code, event.reason);
        }
        for (const tabId of attachedTabs.keys()) {
          setTabState(tabId, "idle");
        }
        attachedTabs.clear();
        updateIcons();
        syncTabGroup();
      };
    });

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.method === "ping") {
          sendMessage({ method: "pong" });
          return;
        }

        if (message.method === "forwardCDPCommand") {
          // Fire-and-forget: allow concurrent CDP commands instead of
          // serializing through await, which caused head-of-line blocking
          // when slow commands (e.g. Accessibility.getFullAXTree) blocked
          // faster ones (e.g. Runtime.evaluate).
          handleCDPCommand(message).catch((e) => {
            error("Unhandled error in CDP command:", e);
            sendMessage({ id: message.id, error: e.message || String(e) });
          });
          return;
        }

        if (message.method === "connectActiveTab") {
          handleRelayMessage(message)
            .then((result) => sendMessage({ id: message.id, ...result }))
            .catch((e) => sendMessage({ id: message.id, success: false, error: e.message }));
          return;
        }

        error("Unknown message from relay:", message);
      } catch (e) {
        error("Error handling message:", e);
      }
    };
  }

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
      sendMessage({ id, error: err.message });
    }
  }

  function sendMessage(message) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      warn("Cannot send message, WebSocket not connected");
    }
  }

  async function connectTab(tabId) {
    try {
      log(`Starting connection to tab ${tabId}`);
      setTabState(tabId, "connecting");
      updateIcons();

      await ensureConnection();
      await attachTab(tabId);
      startMaintainLoop();

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

    if (attachedTabs.size === 0) {
      stopMaintainLoop();
    }
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
      return;
    }
    try {
      const connectedTabIds = [...attachedTabs.keys()];
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
      warn("syncTabGroup failed:", e.message);
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

    if (!attachedTabs.has(activeTab.id)) {
      await connectTab(activeTab.id);
    }

    return activeTab.id;
  }

  async function clearCacheAndReload(tabId) {
    await browser.browsingData.remove(
      { since: 0 },
      { cache: true, serviceWorkers: true }
    );
    await browser.tabs.reload(tabId, { bypassCache: true });
    log(`Cleared cache and reloaded tab ${tabId}`);
  }

  function startMaintainLoop() {
    stopMaintainLoop();
    async function loop() {
      if (attachedTabs.size === 0) return;
      try {
        await ensureConnection();
        reportConnectionRecovery();
      } catch (err) {
        reportConnectionFailure(err);
      } finally {
        updateIcons();
        if (attachedTabs.size > 0) {
          maintainLoopTimer = setTimeout(loop, 5000);
        }
      }
    }
    loop();
  }

  function stopMaintainLoop() {
    if (maintainLoopTimer) {
      clearTimeout(maintainLoopTimer);
      maintainLoopTimer = null;
    }
  }

  async function handleRelayMessage(message) {
    if (message.method === "connectActiveTab") {
      const tabId = await ensureActiveTabAttached();
      return { success: true, tabId };
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

  async function init() {
    log("spawriter bridge initializing...");
    ensureDebuggerEventListener();
    updateIcons();

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return undefined;

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
          wsConnected: getConnectionState() === "connected",
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

    log("spawriter bridge initialized (idle, click toolbar icon on any tab to attach)");
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
        ensureConnection,
        detachAllTabs,
      };
    }
  }
})();
