(function () {
  'use strict';

  const RELAY_PORT = '19988';
  const RELAY_URL = `ws://localhost:${RELAY_PORT}/extension`;

  let ws = null;
  let connectionPromise = null;
  let attachedTabs = new Map();
  let nextMessageId = 1;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    console.log('[AI-Bridge]', new Date().toISOString(), ...args);
  }

  function error(...args) {
    console.error('[AI-Bridge ERROR]', new Date().toISOString(), ...args);
  }

  async function ensureConnection() {
    if (ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (connectionPromise) {
      return connectionPromise;
    }

    connectionPromise = connect();
    try {
      await connectionPromise;
    } finally {
      connectionPromise = null;
    }
  }

  async function connect() {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://localhost:${RELAY_PORT}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          break;
        }
      } catch (e) {
        if (attempt === 29) {
          throw new Error('Relay server not available');
        }
        await sleep(1000);
      }
    }

    log('Connecting to relay:', RELAY_URL);
    ws = new WebSocket(RELAY_URL);

    await new Promise((resolve, reject) => {
      let timeoutFired = false;
      const timeout = setTimeout(() => {
        timeoutFired = true;
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.onopen = () => {
        if (timeoutFired) return;
        clearTimeout(timeout);
        log('WebSocket connected');
        resolve();
      };

      ws.onerror = (err) => {
        if (!timeoutFired) {
          clearTimeout(timeout);
          reject(new Error('WebSocket connection failed'));
        }
      };

      ws.onclose = (event) => {
        if (!timeoutFired) {
          clearTimeout(timeout);
          log('WebSocket closed:', event.code, event.reason);
        }
      };
    });

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.method === 'ping') {
          sendMessage({ method: 'pong' });
          return;
        }

        if (message.method === 'forwardCDPCommand') {
          await handleCDPCommand(message);
          return;
        }

        error('Unknown message from relay:', message);
      } catch (e) {
        error('Error handling message:', e);
      }
    };
  }

  async function handleCDPCommand(message) {
    const { id, params } = message;
    const { method, sessionId, params: cdpParams } = params;

    let targetTabId = null;
    let targetSessionId = sessionId;

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
      sendMessage({
        id,
        error: 'No target tab attached',
      });
      return;
    }

    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: targetTabId },
        method,
        cdpParams
      );

      sendMessage({
        id,
        result,
      });
    } catch (err) {
      sendMessage({
        id,
        error: err.message,
      });
    }
  }

  function sendMessage(message) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      error('Cannot send message, WebSocket not connected');
    }
  }

  async function attachTab(tabId, options = {}) {
    const skipAttachedEvent = options.skipAttachedEvent || false;

    try {
      await chrome.debugger.attach({ tabId }, '1.3');

      await Promise.all([
        chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
        chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
        chrome.debugger.sendCommand({ tabId }, 'Network.enable'),
      ]);

      const sessionId = `tab-${tabId}-${Date.now()}`;

      attachedTabs.set(tabId, {
        sessionId,
        attachedAt: Date.now(),
      });

      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId !== tabId) return;

        const tabInfo = attachedTabs.get(tabId);
        if (!tabInfo) return;

        sendMessage({
          method: 'forwardCDPEvent',
          params: {
            method,
            sessionId: tabInfo.sessionId,
            params,
          },
        });
      });

      if (!skipAttachedEvent) {
        sendMessage({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              targetInfo: {
                targetId: sessionId,
                type: 'page',
                tabId,
              },
            },
          },
        });
      }

      log(`Attached to tab ${tabId}, sessionId: ${sessionId}`);
      return { tabId, sessionId };
    } catch (err) {
      error(`Failed to attach tab ${tabId}:`, err);
      throw err;
    }
  }

  async function detachTab(tabId) {
    const tabInfo = attachedTabs.get(tabId);
    if (tabInfo) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch (e) {
        error(`Error detaching tab ${tabId}:`, e);
      }
      attachedTabs.delete(tabId);
      log(`Detached from tab ${tabId}`);
    }
  }

  async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function ensureActiveTabAttached() {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
      throw new Error('No active tab found');
    }

    if (!attachedTabs.has(activeTab.id)) {
      await attachTab(activeTab.id);
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

  async function handleRelayMessage(message) {
    if (message.method === 'connectActiveTab') {
      const tabId = await ensureActiveTabAttached();
      return { success: true, tabId };
    }

    if (message.method === 'clearCacheAndReload') {
      const tabId = message.tabId || await getActiveTab()?.id;
      if (!tabId) {
        return { success: false, error: 'No tab specified' };
      }
      await clearCacheAndReload(tabId);
      return { success: true };
    }

    if (message.method === 'getTabs') {
      const tabs = await browser.tabs.query({});
      return { success: true, tabs };
    }

    return { success: false, error: 'Unknown command' };
  }

  function maintainLoop() {
    ensureConnection().catch((err) => {
      error('Connection error, will retry:', err.message);
    });

    setTimeout(maintainLoop, 5000);
  }

  async function init() {
    log('AI Bridge initializing...');

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleRelayMessage(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    });

    maintainLoop();

    log('AI Bridge initialized');
  }

  if (typeof browser !== 'undefined') {
    init();

    if (typeof window !== 'undefined') {
      window.__aiBridge = {
        attachTab,
        detachTab,
        getActiveTab,
        ensureActiveTabAttached,
        clearCacheAndReload,
        ensureConnection,
      };
    }
  }
})();
