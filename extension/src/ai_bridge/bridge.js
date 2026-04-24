import browser from "webextension-polyfill";

(function () {
  "use strict";

  let attachedTabs = new Map();
  let tabStates = new Map();
  let tabOwnership = new Map();
  let debuggerEventListenerRegistered = false;
  let offscreenReady = false;

  // Trace recording state
  const TRACE_MAX_EVENTS = 10000;
  let traceEvents = [];
  let traceActive = false;

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
    if (url === 'about:blank') return false;
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
    return tabOwnership.size;
  }

  function getIdleAttachedCount() {
    let count = 0;
    for (const tabId of attachedTabs.keys()) {
      if (getTabState(tabId) !== "connected") count++;
    }
    return count;
  }

  function isTabOwned(tabId) {
    return tabOwnership.has(tabId);
  }

  function normalizeUrlHint(url) {
    if (!url || typeof url !== "string") return "";
    const trimmed = url.trim().toLowerCase();
    if (!trimmed) return "";
    if (/^[a-z][\w+.-]*:/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("//")) return `https:${trimmed}`;
    if (trimmed.startsWith("/")) return trimmed;
    return `https://${trimmed}`;
  }

  function tabMatchesHint(tab, urlHint) {
    const rawHint = (urlHint || "").trim().toLowerCase();
    if (!rawHint) return false;
    const normalizedHint = normalizeUrlHint(urlHint);
    const tabUrl = (tab?.url || "").toLowerCase();
    const tabTitle = (tab?.title || "").toLowerCase();

    if (tabUrl && !isRestrictedUrl(tab.url)) {
      if (
        tabUrl.includes(rawHint) ||
        (normalizedHint && tabUrl.includes(normalizedHint))
      ) {
        return true;
      }
    }

    return !!tabTitle && tabTitle.includes(rawHint);
  }

  function tabReuseScore(tab) {
    const tabId = tab?.id;
    if (tabId == null) return Number.MAX_SAFE_INTEGER;
    const attached = attachedTabs.has(tabId);
    const owned = isTabOwned(tabId);
    if (attached && !owned) return 0;
    if (!attached && !owned) return 1;
    if (attached && owned) return 2;
    return 3;
  }

  function pickBestMatchingTab(allTabs, urlHint) {
    const matches = allTabs
      .filter((tab) => tab?.id != null && tabMatchesHint(tab, urlHint))
      .sort((a, b) => tabReuseScore(a) - tabReuseScore(b));
    return matches[0];
  }

  function syncOwnershipStates() {
    for (const [tabId] of attachedTabs.entries()) {
      const owned = tabOwnership.has(tabId);
      const nextState = owned ? "connected" : "idle";
      setTabState(tabId, nextState);
      markTabTitle(tabId, nextState);
    }
    updateIcons();
  }

  function applyOwnershipSnapshot(ownership) {
    tabOwnership.clear();
    if (Array.isArray(ownership)) {
      for (const entry of ownership) {
        if (entry?.tabId != null) {
          tabOwnership.set(entry.tabId, { sessionId: entry.sessionId, claimedAt: entry.claimedAt });
        }
      }
    }
    syncOwnershipStates();
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

  function buildBadgeInfo(ownedCount, idleCount) {
    if (ownedCount > 0 && idleCount > 0) {
      return { text: `${ownedCount}·${idleCount}`, color: "#4CAF50" };
    } else if (ownedCount > 0) {
      return { text: String(ownedCount), color: "#4CAF50" };
    } else if (idleCount > 0) {
      return { text: String(idleCount), color: "#3F51B5" };
    }
    return { text: "", color: "#9E9E9E" };
  }

  async function updateIcons() {
    const connectedCount = getConnectedCount();
    const idleCount = getIdleAttachedCount();

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

    const globalBadge = buildBadgeInfo(connectedCount, idleCount);

    log(`[updateIcons] connected=${connectedCount} idle=${idleCount}, tabStates=${JSON.stringify([...tabStates.entries()])}, attachedTabs=${JSON.stringify([...attachedTabs.keys()])}`);

    for (const tabId of allTabIds) {
      const state = tabId !== undefined ? getTabState(tabId) : "idle";
      const tabUrl = tabId !== undefined ? tabUrlMap.get(tabId) : undefined;
      const restricted = tabId !== undefined && isRestrictedUrl(tabUrl);
      const attached = tabId !== undefined && attachedTabs.has(tabId);

      let title, badgeText, badgeColor, iconPath;

      if (restricted) {
        title = "spawriter - Cannot attach to this page";
        badgeText = globalBadge.text;
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
        title = `spawriter - In use by agent (${connectedCount} owned` + (idleCount > 0 ? `, ${idleCount} idle)` : ")");
        badgeText = globalBadge.text;
        badgeColor = "#4CAF50";
        iconPath = icons.connected.path;
      } else if (attached) {
        title = `spawriter - Attached, no owner (${idleCount} idle` + (connectedCount > 0 ? `, ${connectedCount} owned)` : ")");
        badgeText = globalBadge.text;
        badgeColor = "#3F51B5";
        iconPath = icons.idle.path;
      } else {
        title = "spawriter - Click to attach debugger";
        badgeText = globalBadge.text;
        badgeColor = globalBadge.color;
        iconPath = icons.idle.path;
      }

      if (tabId !== undefined) {
        log(`[updateIcons] tabId=${tabId} state=${state} attached=${attached} restricted=${restricted} badge="${badgeText}" badgeColor=${badgeColor}`);
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
        markTabTitle(tabId, getTabState(tabId));
      }
      if (attachedTabs.has(tabId) && (changeInfo.title || changeInfo.url)) {
        sendMessage({
          method: "tabInfoChanged",
          params: {
            tabId,
            ...(changeInfo.title && { title: changeInfo.title }),
            ...(changeInfo.url && { url: changeInfo.url }),
          },
        });
      }
    });

    debuggerEventListenerRegistered = true;
  }

  const TAB_TITLE_PREFIXES = {
    connected: "🟢 ",
    idle: "🔵 ",
    connecting: "🟡 ",
    error: "🔴 ",
  };
  const ALL_PREFIXES_RE_SRC = "^(?:🟢 |🟡 |🔴 |🔵 )+";

  const pendingTitleUpdates = new Map();

  function markTabTitle(tabId, stateOrBool) {
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    const prefix = state ? TAB_TITLE_PREFIXES[state] || null : null;

    const existing = pendingTitleUpdates.get(tabId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      pendingTitleUpdates.delete(tabId);
      _applyTabTitle(tabId, prefix).catch(() => {});
    }, 50);
    pendingTitleUpdates.set(tabId, { timer, prefix });
  }

  async function _applyTabTitle(tabId, prefix) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (newPrefix, reSrc) => {
          const re = new RegExp(reSrc);
          if (window.__spawriterTitleObserver) {
            window.__spawriterTitleObserver.disconnect();
            window.__spawriterTitleObserver = null;
          }
          if (window.__spawriterOrigTitleDesc) {
            Object.defineProperty(document, "title", window.__spawriterOrigTitleDesc);
            window.__spawriterOrigTitleDesc = null;
          }
          document.title = (newPrefix || '') + document.title.replace(re, '');
        },
        args: [prefix, ALL_PREFIXES_RE_SRC],
      });
    } catch (e) {
      warn(`markTabTitle failed for tab ${tabId}:`, e?.message || e);
    }
  }

  function emitDetachedFromTarget(tabId, reason) {
    const tabInfo = attachedTabs.get(tabId);
    if (!tabInfo) return;

    tabOwnership.delete(tabId);
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

  async function handleTraceCommand(message) {
    const params = message.params || {};
    const action = params.action;

    if (action === "start") {
      traceActive = true;
      traceEvents = [];
      for (const [tabId] of attachedTabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["build/contentTrace.js"],
          });
          chrome.tabs.sendMessage(tabId, { type: "trace_start" });
        } catch (e) {
          warn(`Failed to inject trace script into tab ${tabId}:`, e);
        }
      }
      return { status: "recording" };
    }

    if (action === "stop") {
      traceActive = false;
      const events = [...traceEvents];
      traceEvents = [];
      for (const [tabId] of attachedTabs) {
        try {
          chrome.tabs.sendMessage(tabId, { type: "trace_stop" });
        } catch (_) {}
      }
      return { status: "stopped", events, count: events.length };
    }

    if (action === "status") {
      return { recording: traceActive, eventCount: traceEvents.length };
    }

    return { error: `Unknown trace action: ${action}` };
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

    if (message.method === "trace") {
      handleTraceCommand(message)
        .then((result) => sendMessage({ id: message.id, ...result }))
        .catch((e) => sendMessage({ id: message.id, error: e.message || String(e) }));
      return;
    }

    if (message.method === "Target.ownershipSnapshot") {
      applyOwnershipSnapshot(message?.params?.ownership || []);
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
      markTabTitle(tabId, "connecting");
      updateIcons();

      await ensureRelayConnected();
      await attachTab(tabId);

      log(`Successfully connected to tab ${tabId}`);
    } catch (err) {
      error(`Failed to connect tab ${tabId}:`, err);
      setTabState(tabId, "error");
      markTabTitle(tabId, "error");
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
    const attached = attachedTabs.has(tabId);

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
    } else if (attached && state === "idle") {
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
    const initialState = isTabOwned(tabId) ? "connected" : "idle";
    setTabState(tabId, initialState);

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
    markTabTitle(tabId, initialState);
    updateIcons();
    syncTabGroup();
    return { tabId, sessionId };
  }

  async function syncTabGroup() {
    // Tab grouping disabled — status shown via title prefix emoji instead
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

      if (liveAttached.length === 0 && attachedTabs.size === 0) {
        log("resyncAttachedTabs: no live debugger sessions found");
        return;
      }

      log(`resyncAttachedTabs: ${liveAttached.length} live debugger sessions, ${attachedTabs.size} in attachedTabs`);

      const liveTabIds = new Set(liveAttached.map((t) => t.tabId));

      // Remove stale entries for tabs no longer attached
      for (const [tabId] of [...attachedTabs.entries()]) {
        if (!liveTabIds.has(tabId)) {
          log(`resyncAttachedTabs: removing stale entry for tab ${tabId}`);
          emitDetachedFromTarget(tabId, "debugger-gone");
        }
      }

      for (const target of liveAttached) {
        const tabId = target.tabId;
        let existing = attachedTabs.get(tabId);

        if (!existing) {
          const sessionId = `spawriter-tab-${tabId}-${Date.now()}`;
          existing = { sessionId, attachedAt: Date.now() };
          attachedTabs.set(tabId, existing);
          setTabState(tabId, isTabOwned(tabId) ? "connected" : "idle");
          log(`resyncAttachedTabs: new entry for tab ${tabId} with sessionId ${sessionId}`);
        }

        // Re-announce to relay (may be a new relay after reconnect)
        let mainFrameId = existing.sessionId;
        try {
          const frameTree = await chrome.debugger.sendCommand(
            { tabId },
            "Page.getFrameTree"
          );
          mainFrameId = frameTree?.frameTree?.frame?.id || existing.sessionId;
        } catch (e) {
          warn(`resyncAttachedTabs: failed to get frame tree for tab ${tabId}:`, e?.message);
        }

        let tab;
        try {
          tab = await browser.tabs.get(tabId);
        } catch (_) {}

        sendMessage({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            sessionId: existing.sessionId,
            params: {
              sessionId: existing.sessionId,
              targetInfo: {
                targetId: mainFrameId,
                type: "page",
                tabId,
                title: tab?.title || target.title || "",
                url: tab?.url || target.url || "",
              },
            },
          },
        });

        const nextState = isTabOwned(tabId) ? "connected" : "idle";
        setTabState(tabId, nextState);
        markTabTitle(tabId, nextState);
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
        const forceCreate = message.params?.forceCreate;
        if (!forceCreate) {
          const allTabs = await browser.tabs.query({});
          const match = pickBestMatchingTab(allTabs, url);

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
        }

        if (create || forceCreate) {
          const fullUrl = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
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
    tabOwnership.clear();
    for (const tabId of attachedTabs.keys()) {
      setTabState(tabId, "idle");
    }
    ensureDebuggerEventListener();
    updateIcons();

    setInterval(async () => {
      try {
        const resp = await fetch("http://localhost:19989/json/list", { signal: AbortSignal.timeout(2000) });
        const targets = await resp.json();
        tabOwnership.clear();
        for (const target of targets) {
          if (target.owner && target.tabId != null) {
            tabOwnership.set(target.tabId, {
              sessionId: target.owner,
              claimedAt: 0,
            });
          }
        }
        syncOwnershipStates();
      } catch (_) {}
    }, 5000);

    ensureOffscreen()
      .then(async () => {
        try {
          const resp = await chrome.runtime.sendMessage({ type: "ws-status" });
          if (resp?.state === "open") {
            offscreenReady = true;
            tabOwnership.clear();
            for (const [tabId] of attachedTabs.entries()) {
              setTabState(tabId, "idle");
              markTabTitle(tabId, "idle");
            }
            resyncAttachedTabs().then(async () => {
              await sleep(500);
              sendMessage({ method: "requestOwnershipSnapshot" });
            });
          }
        } catch (_) {}
      })
      .catch((e) => {
        error("Offscreen setup failed:", e.message);
      });

    log("spawriter bridge initialized (offscreen relay connection active)");
  }

  // Register message listener synchronously at module scope to avoid
  // missing messages when the service worker wakes from termination.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return undefined;

    if (message.type === "trace_event" && traceActive) {
      if (traceEvents.length >= TRACE_MAX_EVENTS) {
        traceEvents.shift();
      }
      traceEvents.push(message.payload);
      return;
    }

    if (message.type === "ws-message") {
      handleRelayIncoming(message.payload);
      return;
    }

    if (message.type === "ws-state-change") {
      offscreenReady = message.state === "open";
      log("Relay WebSocket state:", message.state);
      if (message.state === "closed") {
        tabOwnership.clear();
        for (const tabId of attachedTabs.keys()) {
          setTabState(tabId, "idle");
          markTabTitle(tabId, "idle");
        }
        updateIcons();
        syncTabGroup();
      }
      if (message.state === "open") {
        tabOwnership.clear();
        for (const [tabId] of attachedTabs.entries()) {
          setTabState(tabId, "idle");
          markTabTitle(tabId, "idle");
        }
        updateIcons();
        resyncAttachedTabs().then(async () => {
          await sleep(500);
          sendMessage({ method: "requestOwnershipSnapshot" });
          syncTabGroup();
        });
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
