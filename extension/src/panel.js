import browser from "webextension-polyfill";

createPanel().catch((err) => {
  console.error("Something happened in createPanel()");
  throw err;
});

async function createPanel() {
  let portToBackground;
  let detachVisibility; // 清理当前 panelWindow 的 visibilitychange 监听
  let currentPanelWindow;

  const connectPort = (panelWindow) => {
    // 如果已有连接，先断开再重连，避免残留
    if (portToBackground) {
      try {
        portToBackground.disconnect();
      } catch (_) {}
    }

    portToBackground = browser.runtime.connect({ name: "panel-devtools" });

    // Send init message with the inspected tabId
    portToBackground.postMessage({
      type: "init",
      tabId: browser.devtools.inspectedWindow.tabId,
    });

    portToBackground.onMessage.addListener((msg) => {
      const custEvent = new CustomEvent("ext-content-script", {
        detail: msg,
      });
      panelWindow.dispatchEvent(custEvent);
    });

    // 监听断开，通知面板并尝试重连
    portToBackground.onDisconnect.addListener(() => {
      const evt = new CustomEvent("ext-port-disconnected", {
        detail: { timestamp: Date.now() },
      });
      panelWindow.dispatchEvent(evt);

      // 尝试在短延迟后重连（面板若已隐藏，onShown 会再重连）
      setTimeout(() => {
        if (panelWindow.document.visibilityState === "visible") {
          connectPort(panelWindow);
          const refreshEvent = new CustomEvent("ext-panel-shown", {
            detail: { timestamp: Date.now(), reason: "port-reconnect" },
          });
          panelWindow.dispatchEvent(refreshEvent);
        }
      }, 500);
    });

    // 面板可见时，通知刷新
    const refreshEvent = new CustomEvent("ext-panel-shown", {
      detail: { timestamp: Date.now(), reason: "panel-shown" },
    });
    panelWindow.dispatchEvent(refreshEvent);
  };

  const panel = await browser.devtools.panels.create(
    "spawriter",
    "/build/icons/icon-32.png",
    "/build/panel.html"
  );

  panel.onShown.addListener((panelWindow) => {
    // 清理上一次的 visibilitychange 监听，避免累积
    if (detachVisibility) {
      detachVisibility();
      detachVisibility = null;
    }
    currentPanelWindow = panelWindow;

    connectPort(panelWindow);

    // 面板可见性变化时，如果从 hidden->visible，主动重连并刷新
    const onVisibility = () => {
      if (panelWindow.document.visibilityState === "visible") {
        connectPort(panelWindow);
      }
    };
    panelWindow.document.addEventListener("visibilitychange", onVisibility);
    detachVisibility = () => {
      panelWindow.document.removeEventListener("visibilitychange", onVisibility);
    };

    // 清理监听
    panelWindow.addEventListener("unload", () => {
      if (detachVisibility) detachVisibility();
      detachVisibility = null;
    });
  });

  panel.onHidden.addListener(() => {
    // 面板隐藏时清除可见性监听，防止重复添加
    if (detachVisibility) {
      detachVisibility();
      detachVisibility = null;
    }
    currentPanelWindow = null;

    if (portToBackground) {
      try {
        portToBackground.disconnect();
      } catch (_) {}
      portToBackground = null;
    }
  });
}
