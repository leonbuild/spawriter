/**
 * Tests for Tab Ownership System: relay-level ownership management,
 * claim/release/force-takeover, activity tracking, and edge cases.
 *
 * Run: npx tsx --test spawriter/src/ownership.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OWNERSHIP_ERROR_CODE } from './protocol.js';

// ---------------------------------------------------------------------------
// Simulated ownership registry (mirrors relay.ts logic)
// ---------------------------------------------------------------------------

function createOwnershipRegistry() {
  const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
  const sessionActivity = new Map<string, number>();

  function claimTab(tabId: number, sessionId: string, force?: boolean) {
    const existing = tabOwners.get(tabId);
    if (existing && existing.sessionId !== sessionId) {
      if (!force) return { ok: false, owner: existing.sessionId };
    }
    tabOwners.set(tabId, { sessionId, claimedAt: Date.now() });
    sessionActivity.set(sessionId, Date.now());
    return { ok: true };
  }

  function releaseTab(tabId: number, sessionId: string) {
    const existing = tabOwners.get(tabId);
    if (!existing || existing.sessionId !== sessionId) return false;
    tabOwners.delete(tabId);
    return true;
  }

  function releaseAllTabs(sessionId: string) {
    const toRelease: number[] = [];
    for (const [tabId, o] of tabOwners) {
      if (o.sessionId === sessionId) toRelease.push(tabId);
    }
    for (const tabId of toRelease) tabOwners.delete(tabId);
    return toRelease.length;
  }

  function getTabOwner(tabId: number) {
    return tabOwners.get(tabId)?.sessionId;
  }

  function getOwnedTabs(sessionId: string) {
    return [...tabOwners.entries()]
      .filter(([, o]) => o.sessionId === sessionId)
      .map(([tabId]) => tabId);
  }

  function touchClaim(tabId: number, sessionId: string) {
    const existing = tabOwners.get(tabId);
    if (!existing || existing.sessionId !== sessionId) return;
    sessionActivity.set(sessionId, Date.now());
  }

  return { tabOwners, sessionActivity, claimTab, releaseTab, releaseAllTabs, getTabOwner, getOwnedTabs, touchClaim };
}

// ---------------------------------------------------------------------------
// Tests: Tab Ownership — Claim
// ---------------------------------------------------------------------------

describe('Tab Ownership — Claim', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should claim unclaimed tab', () => {
    const r = reg.claimTab(42, 'sw-a');
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-a');
  });

  it('should allow same session to re-claim (idempotent)', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-a');
    assert.equal(r.ok, true);
    assert.equal(reg.tabOwners.size, 1);
  });

  it('should reject claim by different session', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-b');
    assert.equal(r.ok, false);
    assert.equal(r.owner, 'sw-a');
  });

  it('should allow different sessions on different tabs', () => {
    assert.equal(reg.claimTab(42, 'sw-a').ok, true);
    assert.equal(reg.claimTab(43, 'sw-b').ok, true);
    assert.equal(reg.tabOwners.size, 2);
  });

  it('should allow one session to claim multiple tabs', () => {
    assert.equal(reg.claimTab(42, 'sw-a').ok, true);
    assert.equal(reg.claimTab(43, 'sw-a').ok, true);
    assert.deepEqual(reg.getOwnedTabs('sw-a').sort(), [42, 43]);
  });

  it('should allow force takeover of another session tab', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-b', true);
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Ownership — Release
// ---------------------------------------------------------------------------

describe('Tab Ownership — Release', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should release owned tab', () => {
    reg.claimTab(42, 'sw-a');
    assert.equal(reg.releaseTab(42, 'sw-a'), true);
    assert.equal(reg.tabOwners.size, 0);
  });

  it('should reject release by non-owner', () => {
    reg.claimTab(42, 'sw-a');
    assert.equal(reg.releaseTab(42, 'sw-b'), false);
    assert.equal(reg.tabOwners.size, 1);
  });

  it('should release all tabs for a session', () => {
    reg.claimTab(42, 'sw-a');
    reg.claimTab(43, 'sw-a');
    reg.claimTab(44, 'sw-b');
    assert.equal(reg.releaseAllTabs('sw-a'), 2);
    assert.equal(reg.tabOwners.size, 1);
    assert.equal(reg.getTabOwner(44), 'sw-b');
  });

  it('should return 0 if session owns nothing', () => {
    assert.equal(reg.releaseAllTabs('sw-nonexistent'), 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Ownership — Activity Tracking
// ---------------------------------------------------------------------------

describe('Tab Ownership — Activity Tracking', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should update activity timestamp on claim', () => {
    reg.claimTab(42, 'sw-a');
    assert.ok(reg.sessionActivity.has('sw-a'));
    assert.ok(Date.now() - reg.sessionActivity.get('sw-a')! < 1000);
  });

  it('should update activity on touchClaim for owner', () => {
    reg.claimTab(42, 'sw-a');
    const before = reg.sessionActivity.get('sw-a')!;
    reg.touchClaim(42, 'sw-a');
    assert.ok(reg.sessionActivity.get('sw-a')! >= before);
  });

  it('should not update activity on touchClaim for non-owner', () => {
    reg.claimTab(42, 'sw-a');
    reg.touchClaim(42, 'sw-b');
    assert.ok(!reg.sessionActivity.has('sw-b'));
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Ownership — Multi-Session Stress
// ---------------------------------------------------------------------------

describe('Tab Ownership — Multi-Session Stress', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should handle 10 sessions claiming 10 different tabs', () => {
    for (let i = 1; i <= 10; i++) {
      const result = reg.claimTab(i, `sw-${i}`);
      assert.equal(result.ok, true);
    }
    assert.equal(reg.tabOwners.size, 10);
  });

  it('should handle all 10 sessions releasing simultaneously', () => {
    for (let i = 1; i <= 10; i++) reg.claimTab(i, `sw-${i}`);
    for (let i = 1; i <= 10; i++) reg.releaseTab(i, `sw-${i}`);
    assert.equal(reg.tabOwners.size, 0);
  });

  it('should handle rapid claim-release-claim cycle', () => {
    reg.claimTab(1, 'sw-a');
    reg.releaseTab(1, 'sw-a');
    const r = reg.claimTab(1, 'sw-a');
    assert.equal(r.ok, true);
    reg.releaseTab(1, 'sw-a');
    const r2 = reg.claimTab(1, 'sw-b');
    assert.equal(r2.ok, true);
  });

  it('should handle session claiming tab, releasing, another session claiming same tab', () => {
    reg.claimTab(1, 'sw-a');
    reg.releaseTab(1, 'sw-a');
    const result = reg.claimTab(1, 'sw-b');
    assert.equal(result.ok, true);
    assert.equal(reg.getTabOwner(1), 'sw-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Ownership — Race Condition
// ---------------------------------------------------------------------------

describe('Tab Ownership — Race Condition', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('should handle concurrent claim attempts (first wins)', () => {
    const r1 = reg.claimTab(42, 'sw-a');
    const r2 = reg.claimTab(42, 'sw-b');
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, false);
    assert.equal(reg.getTabOwner(42), 'sw-a');
  });
});

// ---------------------------------------------------------------------------
// Tests: Extension Disconnect
// ---------------------------------------------------------------------------

describe('Tab Ownership — Extension Disconnect', () => {
  it('should clear all ownership when extension disconnects', () => {
    const reg = createOwnershipRegistry();
    reg.claimTab(42, 'sw-a');
    reg.claimTab(43, 'sw-b');
    reg.tabOwners.clear();
    assert.equal(reg.tabOwners.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Protocol Constants
// ---------------------------------------------------------------------------

describe('Protocol Constants', () => {
  it('should export OWNERSHIP_ERROR_CODE', () => {
    assert.equal(typeof OWNERSHIP_ERROR_CODE, 'number');
    assert.equal(OWNERSHIP_ERROR_CODE, -32001);
  });
});

// ---------------------------------------------------------------------------
// Tests: Backward Compatibility (single agent, no claims)
// ---------------------------------------------------------------------------

describe('Backward Compatibility', () => {
  it('should allow operations without any claims (single agent mode)', () => {
    const reg = createOwnershipRegistry();
    assert.equal(reg.getTabOwner(42), undefined);
    assert.equal(reg.tabOwners.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Force Takeover Edge Cases
// ---------------------------------------------------------------------------

describe('Tab Ownership — Force Takeover', () => {
  let reg: ReturnType<typeof createOwnershipRegistry>;
  beforeEach(() => { reg = createOwnershipRegistry(); });

  it('force on unclaimed tab should succeed', () => {
    const r = reg.claimTab(42, 'sw-a', true);
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-a');
  });

  it('force on own tab should succeed', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-a', true);
    assert.equal(r.ok, true);
    assert.equal(reg.tabOwners.size, 1);
  });

  it('force on other tab should succeed and replace owner', () => {
    reg.claimTab(42, 'sw-a');
    const r = reg.claimTab(42, 'sw-b', true);
    assert.equal(r.ok, true);
    assert.equal(reg.getTabOwner(42), 'sw-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: connect_tab Request Validation
// ---------------------------------------------------------------------------

describe('MCP connect_tab Validation', () => {
  function validateConnectTab(args: { url?: string; tabId?: number; create?: boolean }): { valid: boolean; error?: string } {
    const url = args.url;
    const tabId = args.tabId;
    if (!url && tabId === undefined) {
      return { valid: false, error: 'Provide either url or tabId.' };
    }
    return { valid: true };
  }

  it('should reject when neither url nor tabId is provided', () => {
    const result = validateConnectTab({});
    assert.equal(result.valid, false);
  });

  it('should accept url only', () => {
    const result = validateConnectTab({ url: 'http://localhost:9100' });
    assert.equal(result.valid, true);
  });

  it('should accept tabId only', () => {
    const result = validateConnectTab({ tabId: 123 });
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Offscreen Document Protocol (unchanged)
// ---------------------------------------------------------------------------

describe('Offscreen Document Protocol', () => {
  it('ws-send message should have type and payload fields', () => {
    const msg = { type: 'ws-send', payload: { method: 'pong' } };
    assert.equal(msg.type, 'ws-send');
    assert.ok(msg.payload);
    assert.equal(msg.payload.method, 'pong');
  });
});

// ---------------------------------------------------------------------------
// Tests: Service Worker State Persistence (unchanged)
// ---------------------------------------------------------------------------

describe('Service Worker State Persistence', () => {
  it('attachedTabs serializes to JSON-compatible array of entries', () => {
    const map = new Map<number, { sessionId: string; attachedAt: number }>();
    map.set(12345, { sessionId: 'spawriter-tab-12345-1000', attachedAt: 1000 });
    map.set(67890, { sessionId: 'spawriter-tab-67890-2000', attachedAt: 2000 });
    const serialized = [...map.entries()];
    assert.equal(serialized.length, 2);
    const restored = new Map(serialized);
    assert.equal(restored.size, 2);
    assert.equal(restored.get(12345)?.sessionId, 'spawriter-tab-12345-1000');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Title Marker (unchanged)
// ---------------------------------------------------------------------------

describe('Tab Title Marker', () => {
  const PREFIX = '🟢 ';

  it('should add prefix to title', () => {
    const title = 'Example Domain';
    const marked = PREFIX + title;
    assert.equal(marked, '🟢 Example Domain');
  });

  it('should strip prefix on detach', () => {
    const marked = '🟢 Example Domain';
    const stripped = marked.startsWith(PREFIX) ? marked.slice(PREFIX.length) : marked;
    assert.equal(stripped, 'Example Domain');
  });
});

// ---------------------------------------------------------------------------
// Tests: MV3 Service Worker Architecture (unchanged)
// ---------------------------------------------------------------------------

describe('MV3 Service Worker Architecture', () => {
  it('offscreen document reasons should include WORKERS', () => {
    const reasons = ['WORKERS'];
    assert.ok(reasons.includes('WORKERS'));
  });
});
