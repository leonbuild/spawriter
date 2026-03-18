/**
 * Offscreen document for spawriter.
 *
 * Owns the persistent WebSocket connection to the CDP relay server.
 * The MV3 service worker cannot maintain long-lived WebSocket connections
 * because it gets terminated after ~30s of inactivity. This offscreen
 * document survives independently and bridges relay ↔ service-worker
 * communication via chrome.runtime messaging.
 *
 * Protocol (chrome.runtime messages):
 *   SW → Offscreen:
 *     { type: "ws-send", payload: <object> }   — send JSON to relay
 *     { type: "ws-status" }                     — query WebSocket state
 *     { type: "ws-connect" }                    — force (re)connect
 *
 *   Offscreen → SW:
 *     { type: "ws-message", payload: <object> } — relay message received
 *     { type: "ws-state-change", state: "open"|"closed" }
 */

const RELAY_PORT = "19989";
const RELAY_URL = `ws://localhost:${RELAY_PORT}/extension`;
const KEEPALIVE_MS = 20000;
const RECONNECT_DELAY_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const MAX_CONNECT_ATTEMPTS = 30;

let ws = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let connecting = false;

function log(...args) {
  console.log("[spawriter-offscreen]", ...args);
}

function notifyServiceWorker(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

async function healthCheck() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), HEALTH_CHECK_TIMEOUT_MS);
    const resp = await fetch(`http://localhost:${RELAY_PORT}`, {
      method: "HEAD",
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    return resp.ok;
  } catch {
    return false;
  }
}

async function connectWebSocket() {
  if (ws?.readyState === WebSocket.OPEN || connecting) return;
  connecting = true;

  try {
    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      if (await healthCheck()) break;
      if (i === MAX_CONNECT_ATTEMPTS - 1) {
        connecting = false;
        scheduleReconnect();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    ws = new WebSocket(RELAY_URL);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS timeout")), 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        log("WebSocket connected");
        notifyServiceWorker({ type: "ws-state-change", state: "open" });

        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: "keepalive" }));
          }
        }, KEEPALIVE_MS);

        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WS error"));
      };
    });

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        notifyServiceWorker({ type: "ws-message", payload: data });
      } catch (e) {
        log("Failed to parse relay message:", e);
      }
    };

    ws.onclose = () => {
      log("WebSocket closed");
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      ws = null;
      notifyServiceWorker({ type: "ws-state-change", state: "closed" });
      scheduleReconnect();
    };
  } catch (e) {
    log("Connect failed:", e.message);
    ws = null;
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_DELAY_MS);
}

function sendToRelay(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "ws-send") {
    const ok = sendToRelay(message.payload);
    sendResponse({ sent: ok });
    return;
  }

  if (message.type === "ws-status") {
    sendResponse({
      state: ws?.readyState === WebSocket.OPEN ? "open" : "closed",
      connecting,
    });
    return;
  }

  if (message.type === "ws-connect") {
    connectWebSocket().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

connectWebSocket();
