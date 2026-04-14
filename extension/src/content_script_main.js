// This script runs in the MAIN world (page context)
// It can access window.__SINGLE_SPA_DEVTOOLS__ directly

import { setupOverlayHelpers } from "./inspected-window-helpers/overlay-helpers";

// Install devtools object
if (!window.__SINGLE_SPA_DEVTOOLS__) {
  Object.defineProperty(window, "__SINGLE_SPA_DEVTOOLS__", {
    value: {},
  });
}

// Restore overlay helpers (keeps default single-spa container fallback)
setupOverlayHelpers();

// Setup force mount/unmount functions
(function setupMountAndUnmount() {
  const forceMount = forceMountUnmount.bind(null, true);
  const forceUnmount = forceMountUnmount.bind(null, false);

  function revertForceMountUnmount(appName) {
    const { reroute } = window.__SINGLE_SPA_DEVTOOLS__.exposedMethods;

    const app = getAppByName(appName);
    if (app.devtools.activeWhenBackup) {
      app.activeWhen = app.devtools.activeWhenBackup;
      delete app.devtools.activeWhenBackup;
      delete app.devtools.activeWhenForced;
    }
    reroute();
  }

  function forceMountUnmount(shouldMount, appName) {
    const {
      getRawAppData,
      toLoadPromise,
      toBootstrapPromise,
      NOT_LOADED,
      reroute,
    } = window.__SINGLE_SPA_DEVTOOLS__.exposedMethods;
    const app = getRawAppData().find((rawapp) => rawapp.name === appName);

    if (!app.devtools.activeWhenBackup) {
      app.devtools.activeWhenBackup = app.activeWhen;
    }

    app.devtools.activeWhenForced = shouldMount ? "on" : "off";
    app.activeWhen = () => shouldMount;

    if (shouldMount && app.status === NOT_LOADED) {
      toLoadPromise(app)
        .then(() => toBootstrapPromise(app))
        .then(() => reroute())
        .catch((err) => {
          console.error(
            `Something failed in the process of loading and bootstrapping your force mounted app (${app.name}):`,
            err
          );
          throw err;
        });
    } else {
      reroute();
    }
  }

  function getAppByName(appName) {
    const { getRawAppData } = window.__SINGLE_SPA_DEVTOOLS__.exposedMethods;
    return getRawAppData().find((rawApp) => rawApp.name === appName);
  }

  window.__SINGLE_SPA_DEVTOOLS__.forceUnmount = forceUnmount;
  window.__SINGLE_SPA_DEVTOOLS__.forceMount = forceMount;
  window.__SINGLE_SPA_DEVTOOLS__.revertForceMountUnmount = revertForceMountUnmount;
})();

// Dispatch event when single-spa routing happens
// This will be caught by the isolated content script
function dispatchStatusRefresh(reason) {
  // reason 可用于后续扩展或调试
  window.dispatchEvent(
    new CustomEvent("spawriter:routing-event", {
      detail: { reason },
    })
  );
}

// 触发时机更多，避免网络慢或切换路由时状态滞后
[
  "single-spa:routing-event",
  "single-spa:before-routing-event",
  "single-spa:app-change",
  "single-spa:app-change-error",
  "single-spa:no-app-change",
].forEach((evtName) => {
  window.addEventListener(evtName, () => dispatchStatusRefresh(evtName));
});

// 页面从 BFCache/隐藏恢复时再派发一次，避免错过事件
window.addEventListener("pageshow", () => dispatchStatusRefresh("pageshow"));
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    dispatchStatusRefresh("visibilitychange-visible");
  }
});

