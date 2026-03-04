// Background script for spawriter
// Runs as a Service Worker in Manifest V3

import browser from "webextension-polyfill";

// AI Bridge module (MCP support)
import "./ai_bridge/bridge.js";

// Store active connections to devtools panels
// Map of tabId -> port
// Note: In Service Worker, this state may be lost when worker is terminated
// But connections will be re-established when panel is opened
let portsToPanel = new Map();

// Handle clear cache request
async function handleClearCache(msg) {
  const { tabId, dataTypes } = msg;

  try {
    // Clear browsing data
    // Note: Firefox doesn't support cacheStorage property
    await browser.browsingData.remove(
      { since: 0 },
      dataTypes || {
        cache: true,
        serviceWorkers: true,
      }
    );

    // Reload the tab with cache bypass
    await browser.tabs.reload(tabId, { bypassCache: true });

    return { success: true };
  } catch (error) {
    console.error("Error clearing cache:", error);
    return { success: false, error: error.message };
  }
}

// Handle tabs.reload request from devtools panel
async function handleTabsReload(msg) {
  const { tabId, bypassCache } = msg;
  try {
    await browser.tabs.reload(tabId, { bypassCache: !!bypassCache });
    return { success: true };
  } catch (error) {
    console.error("Error reloading tab:", error);
    return { success: false, error: error.message };
  }
}

// Handle tabs.get request from devtools panel
async function handleTabsGet(msg) {
  const { tabId } = msg;
  try {
    const tab = await browser.tabs.get(tabId);
    return { success: true, tab };
  } catch (error) {
    console.error("Error getting tab:", error);
    return { success: false, error: error.message };
  }
}

// Listen for messages from content scripts and devtools panel
browser.runtime.onMessage.addListener((msg, sender) => {
  // Alive check from panel
  if (msg.type === "panel-ping") {
    return Promise.resolve({ ok: true, ts: Date.now() });
  }

  // Handle clear-cache request from devtools panel
  if (msg.type === "clear-cache") {
    return handleClearCache(msg);
  }

  // Handle tabs.reload request from devtools panel
  if (msg.type === "tabs-reload") {
    return handleTabsReload(msg);
  }

  // Handle tabs.get request from devtools panel
  if (msg.type === "tabs-get") {
    return handleTabsGet(msg);
  }

  // Forward message to the devtools panel for the same tab
  const tabId = sender.tab?.id;
  if (tabId) {
    const port = portsToPanel.get(tabId);
    if (port) {
      try {
        port.postMessage(msg);
      } catch (e) {
        // Port might be disconnected
        portsToPanel.delete(tabId);
      }
    }
  }
});

// Listen for connections from devtools panels
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel-devtools") return;

  // Get the tabId from the port name or use a message to set it
  port.onMessage.addListener((msg) => {
    if (msg.type === "init" && msg.tabId) {
      portsToPanel.set(msg.tabId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    // Remove the port from the map
    for (const [tabId, p] of portsToPanel.entries()) {
      if (p === port) {
        portsToPanel.delete(tabId);
        break;
      }
    }
  });
});

// Listen for tab updates and notify the corresponding panel
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const port = portsToPanel.get(tabId);
  if (port && changeInfo.status === "complete") {
    try {
      port.postMessage({
        type: "tab-updated",
        tabId,
        changeInfo,
      });
    } catch (e) {
      // Port might be disconnected
      portsToPanel.delete(tabId);
    }
  }
});

// Listen for toolbar button (action) click - Toggle spawriter per-tab
browser.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    if (typeof globalThis.__spawriter?.toggleTab === "function") {
      await globalThis.__spawriter.toggleTab(tab.id);
    } else {
      const response = await browser.runtime.sendMessage({
        type: "spawriter-toggle",
        tabId: tab.id,
      });
      console.log("spawriter toggle result:", response);
    }
  } catch (error) {
    console.error("Error toggling spawriter tab:", error);
  }
});
