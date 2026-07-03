import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Shared with the extension service worker (kept import-free there for this reason).
import { decidePopupRelocation, POPUP_SOURCE_TTL_MS } from '../../extension/src/ai_bridge/popup-relocation.mjs';

function input(overrides?: Record<string, unknown>) {
  return {
    windowType: 'popup',
    windowId: 100,
    tabIds: [7],
    sourceTabByTabId: new Map([[7, 3]]),
    attachedTabIds: new Set([3]),
    ...overrides,
  };
}

describe('decidePopupRelocation', () => {
  it('relocates a popup whose opener is an attached tab', () => {
    const decision = decidePopupRelocation(input());
    assert.deepEqual(decision, { relocate: true, sourceTabId: 3 });
  });

  it('ignores normal windows', () => {
    const decision = decidePopupRelocation(input({ windowType: 'normal' }));
    assert.deepEqual(decision, { relocate: false, reason: 'not-a-popup' });
  });

  it('ignores windows without an id', () => {
    const decision = decidePopupRelocation(input({ windowId: undefined }));
    assert.equal(decision.relocate, false);
  });

  it('skips popups with no tabs after retries', () => {
    const decision = decidePopupRelocation(input({ tabIds: [] }));
    assert.deepEqual(decision, { relocate: false, reason: 'no-tabs' });
  });

  it('leaves popups from unattached tabs alone (normal Chrome behavior)', () => {
    const decision = decidePopupRelocation(input({ attachedTabIds: new Set([99]) }));
    assert.deepEqual(decision, { relocate: false, reason: 'source-not-attached' });
  });

  it('leaves popups with unknown openers alone', () => {
    const decision = decidePopupRelocation(input({ sourceTabByTabId: new Map() }));
    assert.deepEqual(decision, { relocate: false, reason: 'source-not-attached' });
  });

  it('finds the attached opener among multiple popup tabs', () => {
    const decision = decidePopupRelocation(
      input({
        tabIds: [7, 8],
        sourceTabByTabId: new Map([
          [7, 99],
          [8, 3],
        ]),
      }),
    );
    assert.deepEqual(decision, { relocate: true, sourceTabId: 3 });
  });

  it('exports a bounded source-map TTL', () => {
    assert.ok(POPUP_SOURCE_TTL_MS >= 1000 && POPUP_SOURCE_TTL_MS <= 60000);
  });
});
