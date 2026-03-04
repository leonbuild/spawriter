// This script runs in the ISOLATED world (extension context)
// It can use browser.runtime.sendMessage but cannot access page variables directly

import browser from "webextension-polyfill";

// Listen for routing events from the MAIN world script
window.addEventListener("spawriter:routing-event", () => {
  // Send message to background script
  // Catch "Extension context invalidated" error when service worker is terminated
  browser.runtime.sendMessage({
    from: "single-spa",
    type: "routing-event",
  }).catch((err) => {
    // Silently ignore context invalidation errors
    // This happens when Chrome terminates the service worker
    // The panel will auto-reconnect when it's visible
    if (err.message && err.message.includes("Extension context invalidated")) {
      // No need to log - this is expected behavior in MV3
      return;
    }
    // Log other unexpected errors
    console.warn("spawriter: Failed to send routing event:", err);
  });
});
