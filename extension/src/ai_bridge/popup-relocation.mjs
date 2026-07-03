// Pure decision logic for popup relocation, kept import-free so the relay's
// node:test suite can exercise it directly (bridge.js pulls in browser APIs).
//
// A popup window is relocated into its opener's window only when the opener
// is a spawriter-attached tab: the debugger cannot follow into separate popup
// windows, so OAuth/login popups would otherwise dead-end the agent. Popups
// from unrelated tabs keep normal Chrome behavior.

/**
 * @param {{
 *   windowType: string | undefined,
 *   windowId: number | undefined,
 *   tabIds: number[],
 *   sourceTabByTabId: Map<number, number>,
 *   attachedTabIds: Set<number>,
 * }} input
 * @returns {{ relocate: false, reason: string } | { relocate: true, sourceTabId: number }}
 */
export function decidePopupRelocation({ windowType, windowId, tabIds, sourceTabByTabId, attachedTabIds }) {
  if (windowType !== "popup" || windowId === undefined || windowId === null) {
    return { relocate: false, reason: "not-a-popup" };
  }
  if (!tabIds || tabIds.length === 0) {
    return { relocate: false, reason: "no-tabs" };
  }
  for (const tabId of tabIds) {
    const sourceTabId = sourceTabByTabId.get(tabId);
    if (sourceTabId !== undefined && attachedTabIds.has(sourceTabId)) {
      return { relocate: true, sourceTabId };
    }
  }
  return { relocate: false, reason: "source-not-attached" };
}

// chrome.tabs.Tab.openerTabId is unreliable for window.open popups (left null
// on recent Chromium), so track source tabs via webNavigation's
// onCreatedNavigationTarget instead. Entries expire to cap memory for plain
// new-tab cases that never trigger windows.onCreated.
export const POPUP_SOURCE_TTL_MS = 10000;
