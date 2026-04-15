/**
 * Tests for relay.ts logic: HTTP routes, tab ownership management, target listing,
 * extension validation, CDP event routing, and download behavior.
 *
 * Run: npx tsx --test spawriter/src/relay.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, getCdpUrl, DEFAULT_PORT } from './utils.js';
import { OWNERSHIP_ERROR_CODE } from './protocol.js';

// ---------------------------------------------------------------------------
// Simulated relay state (mirrors relay.ts structures)
// ---------------------------------------------------------------------------

interface TargetInfo {
  targetId?: string;
  title?: string;
  url?: string;
  type?: string;
  tabId?: number;
}

interface AttachedTarget {
  sessionId: string;
  tabId?: number;
  targetInfo?: TargetInfo;
}

interface DownloadBehavior {
  behavior: string;
  downloadPath?: string;
}

function createRelayState() {
  const attachedTargets = new Map<string, AttachedTarget>();
  const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
  const sessionActivity = new Map<string, number>();
  const downloadBehaviors = new Map<string, DownloadBehavior>();

  function claimTab(tabId: number, sessionId: string, force?: boolean): { ok: boolean; owner?: string } {
    const existing = tabOwners.get(tabId);
    if (existing && existing.sessionId !== sessionId) {
      if (!force) return { ok: false, owner: existing.sessionId };
    }
    tabOwners.set(tabId, { sessionId, claimedAt: Date.now() });
    sessionActivity.set(sessionId, Date.now());
    return { ok: true };
  }

  function releaseTab(tabId: number, sessionId: string): boolean {
    const existing = tabOwners.get(tabId);
    if (!existing || existing.sessionId !== sessionId) return false;
    tabOwners.delete(tabId);
    return true;
  }

  function releaseAllTabs(sessionId: string): number {
    const toRelease: number[] = [];
    for (const [tabId, o] of tabOwners) {
      if (o.sessionId === sessionId) toRelease.push(tabId);
    }
    for (const tabId of toRelease) tabOwners.delete(tabId);
    return toRelease.length;
  }

  function getTabOwner(tabId: number): string | undefined {
    return tabOwners.get(tabId)?.sessionId;
  }

  function checkOwnership(sessionId: string, tabId: number): { allowed: boolean; error?: string } {
    const owner = tabOwners.get(tabId);
    if (!owner) return { allowed: true };
    if (owner.sessionId !== sessionId) {
      return { allowed: false, error: `Tab ${tabId} is owned by session "${owner.sessionId}"` };
    }
    return { allowed: true };
  }

  function listTargets(port: number) {
    return Array.from(attachedTargets.values()).map((target) => {
      const ti = target.targetInfo ?? {};
      return {
        id: target.sessionId,
        tabId: target.tabId,
        type: ti.type ?? 'page',
        title: ti.title ?? '',
        url: ti.url ?? '',
        webSocketDebuggerUrl: getCdpUrl(port, target.sessionId),
        owner: target.tabId != null ? (getTabOwner(target.tabId) ?? null) : null,
      };
    });
  }

  function routeCdpEvent(
    tabId: number | undefined,
    cdpClients: Map<string, object>,
    sessionToClientId: Map<string, string>,
  ): string[] {
    const recipients: string[] = [];
    if (tabId == null) {
      for (const clientId of cdpClients.keys()) recipients.push(clientId);
      return recipients;
    }
    const owner = tabOwners.get(tabId);
    if (owner) {
      const ownerClientId = sessionToClientId.get(owner.sessionId);
      if (ownerClientId && cdpClients.has(ownerClientId)) {
        recipients.push(ownerClientId);
      }
      return recipients;
    }
    for (const clientId of cdpClients.keys()) recipients.push(clientId);
    return recipients;
  }

  return {
    attachedTargets,
    tabOwners,
    sessionActivity,
    downloadBehaviors,
    claimTab,
    releaseTab,
    releaseAllTabs,
    getTabOwner,
    checkOwnership,
    listTargets,
    routeCdpEvent,
  };
}

// ---------------------------------------------------------------------------
// Extension origin validation (mirrors relay.ts)
// ---------------------------------------------------------------------------

function validateExtensionOrigin(
  origin: string | null,
  allowedIds: string[],
  allowAny: boolean
): boolean {
  if (!origin) return false;
  const match = origin.match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) return false;
  if (allowAny) return true;
  return allowedIds.includes(match[1]);
}

// ---------------------------------------------------------------------------
// Tests: /version and /json/version routes
// ---------------------------------------------------------------------------

describe('GET /version route logic', () => {
  it('should return the VERSION', () => {
    const response = { version: VERSION };
    assert.equal(response.version, VERSION);
    assert.match(response.version, /^\d+\.\d+\.\d+/);
  });
});

describe('GET /json/version route logic', () => {
  it('should include Browser, Protocol-Version, and webSocketDebuggerUrl', () => {
    const port = DEFAULT_PORT;
    const response = {
      Browser: `spawriter/${VERSION}`,
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: getCdpUrl(port),
    };
    assert.equal(response.Browser, `spawriter/${VERSION}`);
    assert.equal(response['Protocol-Version'], '1.3');
    assert.equal(response.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/cdp/default`);
  });
});

// ---------------------------------------------------------------------------
// Tests: /json/list route
// ---------------------------------------------------------------------------

describe('GET /json/list route logic', () => {
  it('should return empty array when no targets', () => {
    const relay = createRelayState();
    const targets = relay.listTargets(19989);
    assert.deepEqual(targets, []);
  });

  it('should list attached targets with correct fields', () => {
    const relay = createRelayState();
    relay.attachedTargets.set('session-1', {
      sessionId: 'session-1',
      tabId: 42,
      targetInfo: { type: 'page', title: 'Test Page', url: 'https://example.com', tabId: 42 },
    });
    const targets = relay.listTargets(19989);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'session-1');
    assert.equal(targets[0].tabId, 42);
    assert.equal(targets[0].type, 'page');
    assert.equal(targets[0].title, 'Test Page');
    assert.equal(targets[0].url, 'https://example.com');
    assert.match(targets[0].webSocketDebuggerUrl, /ws:\/\/127\.0\.0\.1:19989\/cdp\/session-1/);
    assert.equal(targets[0].owner, null);
  });

  it('should include owner when a tab is claimed', () => {
    const relay = createRelayState();
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Page 1', url: 'https://a.com', type: 'page' },
    });
    relay.claimTab(1, 'sw-agent-a');
    const targets = relay.listTargets(19989);
    assert.equal(targets[0].owner, 'sw-agent-a');
  });

  it('should handle targets without targetInfo', () => {
    const relay = createRelayState();
    relay.attachedTargets.set('s2', { sessionId: 's2' });
    const targets = relay.listTargets(19989);
    assert.equal(targets[0].type, 'page');
    assert.equal(targets[0].title, '');
    assert.equal(targets[0].url, '');
  });

  it('should list multiple targets', () => {
    const relay = createRelayState();
    for (let i = 0; i < 5; i++) {
      relay.attachedTargets.set(`s-${i}`, {
        sessionId: `s-${i}`,
        tabId: i,
        targetInfo: { title: `Tab ${i}`, url: `https://${i}.com`, type: 'page' },
      });
    }
    const targets = relay.listTargets(19989);
    assert.equal(targets.length, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: Extension origin validation
// ---------------------------------------------------------------------------

describe('Extension origin validation', () => {
  it('should reject null origin', () => {
    assert.equal(validateExtensionOrigin(null, [], false), false);
  });

  it('should reject non-extension origin', () => {
    assert.equal(validateExtensionOrigin('https://example.com', [], false), false);
  });

  it('should accept any extension when allowAny is true', () => {
    assert.equal(
      validateExtensionOrigin('chrome-extension://abcdef123', [], true),
      true
    );
  });

  it('should accept extension in allowlist', () => {
    assert.equal(
      validateExtensionOrigin('chrome-extension://abc123', ['abc123', 'def456'], false),
      true
    );
  });

  it('should reject extension not in allowlist', () => {
    assert.equal(
      validateExtensionOrigin('chrome-extension://xyz789', ['abc123'], false),
      false
    );
  });

  it('should handle extension origin with path', () => {
    assert.equal(
      validateExtensionOrigin('chrome-extension://abc123/some/path', ['abc123'], false),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Ownership enforcement on CDP commands
// ---------------------------------------------------------------------------

describe('Ownership enforcement on CDP commands', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Tab', url: 'https://a.com', type: 'page' },
    });
  });

  it('should allow commands when no ownership exists', () => {
    const result = relay.checkOwnership('sw-a', 1);
    assert.equal(result.allowed, true);
  });

  it('should allow commands from the tab owner', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.checkOwnership('sw-a', 1);
    assert.equal(result.allowed, true);
  });

  it('should block commands from non-owner', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.checkOwnership('sw-b', 1);
    assert.equal(result.allowed, false);
    assert.ok(result.error?.includes('sw-a'));
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab claim / release
// ---------------------------------------------------------------------------

describe('Relay-level ownership operations', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Tab 1', url: 'https://a.com', type: 'page' },
    });
    relay.attachedTargets.set('s2', {
      sessionId: 's2',
      tabId: 2,
      targetInfo: { title: 'Tab 2', url: 'https://b.com', type: 'page' },
    });
  });

  it('should claim unclaimed tab', () => {
    const result = relay.claimTab(1, 'sw-a');
    assert.equal(result.ok, true);
  });

  it('should allow re-claim by same session', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.claimTab(1, 'sw-a');
    assert.equal(result.ok, true);
  });

  it('should reject claim for tab held by another', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.claimTab(1, 'sw-b');
    assert.equal(result.ok, false);
    assert.equal(result.owner, 'sw-a');
  });

  it('should allow force claim on tab held by another', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.claimTab(1, 'sw-b', true);
    assert.equal(result.ok, true);
    assert.equal(relay.getTabOwner(1), 'sw-b');
  });

  it('should release tab by owner', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.releaseTab(1, 'sw-a');
    assert.equal(result, true);
    assert.equal(relay.tabOwners.size, 0);
  });

  it('should fail to release tab by non-owner', () => {
    relay.claimTab(1, 'sw-a');
    const result = relay.releaseTab(1, 'sw-b');
    assert.equal(result, false);
  });

  it('should release all tabs for a session', () => {
    relay.claimTab(1, 'sw-a');
    relay.claimTab(2, 'sw-a');
    const count = relay.releaseAllTabs('sw-a');
    assert.equal(count, 2);
    assert.equal(relay.tabOwners.size, 0);
  });

  it('should only release matching session tabs', () => {
    relay.claimTab(1, 'sw-a');
    relay.claimTab(2, 'sw-b');
    const count = relay.releaseAllTabs('sw-a');
    assert.equal(count, 1);
    assert.equal(relay.tabOwners.size, 1);
    assert.equal(relay.getTabOwner(2), 'sw-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: CDP event routing with ownership
// ---------------------------------------------------------------------------

describe('CDP event routing', () => {
  it('should broadcast to all clients when no tabId', () => {
    const relay = createRelayState();
    const clients = new Map([['c1', {}], ['c2', {}]]);
    const s2c = new Map<string, string>();
    const recipients = relay.routeCdpEvent(undefined, clients, s2c);
    assert.equal(recipients.length, 2);
  });

  it('should broadcast to all when tab has no owner', () => {
    const relay = createRelayState();
    const clients = new Map([['c1', {}], ['c2', {}]]);
    const s2c = new Map<string, string>();
    const recipients = relay.routeCdpEvent(42, clients, s2c);
    assert.equal(recipients.length, 2);
  });

  it('should route only to owner client when tab is owned', () => {
    const relay = createRelayState();
    relay.claimTab(42, 'sw-a');
    const clients = new Map([['c1', {}], ['c2', {}]]);
    const s2c = new Map([['sw-a', 'c1']]);
    const recipients = relay.routeCdpEvent(42, clients, s2c);
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0], 'c1');
  });

  it('should return empty when owner client is not connected', () => {
    const relay = createRelayState();
    relay.claimTab(42, 'sw-a');
    const clients = new Map([['c1', {}]]);
    const s2c = new Map([['sw-a', 'disconnected']]);
    const recipients = relay.routeCdpEvent(42, clients, s2c);
    assert.equal(recipients.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Download behavior tracking
// ---------------------------------------------------------------------------

describe('Download behavior tracking', () => {
  it('should store and retrieve download behavior per client', () => {
    const relay = createRelayState();
    relay.downloadBehaviors.set('c1', { behavior: 'allow', downloadPath: '/tmp' });
    const entry = relay.downloadBehaviors.get('c1');
    assert.equal(entry?.behavior, 'allow');
    assert.equal(entry?.downloadPath, '/tmp');
  });

  it('should allow deny behavior', () => {
    const relay = createRelayState();
    relay.downloadBehaviors.set('c1', { behavior: 'deny' });
    assert.equal(relay.downloadBehaviors.get('c1')?.behavior, 'deny');
  });

  it('should clean up on client disconnect', () => {
    const relay = createRelayState();
    relay.downloadBehaviors.set('c1', { behavior: 'allow' });
    relay.downloadBehaviors.delete('c1');
    assert.equal(relay.downloadBehaviors.has('c1'), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Target attach / detach lifecycle
// ---------------------------------------------------------------------------

describe('Target attach/detach lifecycle', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
  });

  it('should add and remove targets', () => {
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Test', url: 'https://test.com', type: 'page' },
    });
    assert.equal(relay.attachedTargets.size, 1);
    relay.attachedTargets.delete('s1');
    assert.equal(relay.attachedTargets.size, 0);
  });

  it('should clean up ownership when target is removed', () => {
    relay.attachedTargets.set('s1', { sessionId: 's1', tabId: 1 });
    relay.claimTab(1, 'sw-a');
    assert.equal(relay.tabOwners.size, 1);
    relay.attachedTargets.delete('s1');
    relay.tabOwners.delete(1);
    assert.equal(relay.tabOwners.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: OWNERSHIP_ERROR_CODE
// ---------------------------------------------------------------------------

describe('OWNERSHIP_ERROR_CODE', () => {
  it('should be -32001', () => {
    assert.equal(OWNERSHIP_ERROR_CODE, -32001);
  });

  it('should be usable in CDP error responses', () => {
    const errorResponse = {
      id: 1,
      error: { code: OWNERSHIP_ERROR_CODE, message: 'Tab owned by another session' },
    };
    assert.equal(errorResponse.error.code, -32001);
  });
});

// ---------------------------------------------------------------------------
// Tests: Multi-agent isolation scenario
// ---------------------------------------------------------------------------

describe('Multi-agent isolation scenario', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    for (let i = 1; i <= 3; i++) {
      relay.attachedTargets.set(`tab-${i}`, {
        sessionId: `tab-${i}`,
        tabId: i,
        targetInfo: { title: `Page ${i}`, url: `https://${i}.com`, type: 'page' },
      });
    }
  });

  it('should allow multiple sessions to own different tabs', () => {
    assert.equal(relay.claimTab(1, 'sw-a').ok, true);
    assert.equal(relay.claimTab(2, 'sw-b').ok, true);
    assert.equal(relay.claimTab(3, 'sw-c').ok, true);
    assert.equal(relay.tabOwners.size, 3);
  });

  it('should prevent session from using another session tab', () => {
    relay.claimTab(1, 'sw-a');
    relay.claimTab(2, 'sw-b');

    assert.equal(relay.checkOwnership('sw-a', 1).allowed, true);
    assert.equal(relay.checkOwnership('sw-a', 2).allowed, false);
    assert.equal(relay.checkOwnership('sw-b', 2).allowed, true);
    assert.equal(relay.checkOwnership('sw-b', 1).allowed, false);
  });

  it('should clean up all tabs when session disconnects', () => {
    relay.claimTab(1, 'sw-a');
    relay.claimTab(3, 'sw-a');
    relay.claimTab(2, 'sw-b');

    const released = relay.releaseAllTabs('sw-a');
    assert.equal(released, 2);
    assert.equal(relay.tabOwners.size, 1);

    assert.equal(relay.claimTab(1, 'sw-c').ok, true);
    assert.equal(relay.claimTab(3, 'sw-c').ok, true);
  });

  it('should route events correctly in multi-agent scenario', () => {
    relay.claimTab(1, 'sw-a');
    relay.claimTab(2, 'sw-b');
    const clients = new Map([['c-a', {}], ['c-b', {}]]);
    const s2c = new Map([['sw-a', 'c-a'], ['sw-b', 'c-b']]);

    const tab1Recipients = relay.routeCdpEvent(1, clients, s2c);
    assert.deepEqual(tab1Recipients, ['c-a']);

    const tab2Recipients = relay.routeCdpEvent(2, clients, s2c);
    assert.deepEqual(tab2Recipients, ['c-b']);

    const tab3Recipients = relay.routeCdpEvent(3, clients, s2c);
    assert.equal(tab3Recipients.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: EADDRINUSE handling
// ---------------------------------------------------------------------------

describe('EADDRINUSE error handling logic', () => {
  function handleServerError(err: { code?: string }): 'exit-graceful' | 'exit-error' | 'ignore' {
    if (err.code === 'EADDRINUSE') return 'exit-graceful';
    return 'exit-error';
  }

  it('should exit gracefully on EADDRINUSE', () => {
    assert.equal(handleServerError({ code: 'EADDRINUSE' }), 'exit-graceful');
  });

  it('should exit with error on other errors', () => {
    assert.equal(handleServerError({ code: 'EACCES' }), 'exit-error');
  });

  it('should exit with error on unknown errors', () => {
    assert.equal(handleServerError({}), 'exit-error');
  });
});

// ---------------------------------------------------------------------------
// Tests: Idle shutdown logic
// ---------------------------------------------------------------------------

describe('Idle shutdown decision logic', () => {
  function shouldShutdown(cdpClientCount: number, hasExtension: boolean): boolean {
    return cdpClientCount === 0 && !hasExtension;
  }

  it('should shut down when no CDP clients and no extension', () => {
    assert.equal(shouldShutdown(0, false), true);
  });

  it('should not shut down when CDP clients are connected', () => {
    assert.equal(shouldShutdown(1, false), false);
    assert.equal(shouldShutdown(3, false), false);
  });

  it('should not shut down when extension is connected', () => {
    assert.equal(shouldShutdown(0, true), false);
  });

  it('should not shut down when both are connected', () => {
    assert.equal(shouldShutdown(2, true), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkIdleShutdown timer behavior
// ---------------------------------------------------------------------------

describe('checkIdleShutdown timer lifecycle', () => {
  function createIdleChecker() {
    let timerSet = false;
    let timerCleared = false;
    let shutdownCalled = false;

    function checkIdleShutdown(cdpClientCount: number, hasExtension: boolean) {
      timerCleared = timerSet;
      if (cdpClientCount > 0 || hasExtension) {
        timerSet = false;
        return;
      }
      timerSet = true;
    }

    function fireTimer(cdpClientCount: number, hasExtension: boolean) {
      if (!timerSet) return;
      if (cdpClientCount === 0 && !hasExtension) {
        shutdownCalled = true;
      }
      timerSet = false;
    }

    return {
      checkIdleShutdown,
      fireTimer,
      state: () => ({ timerSet, timerCleared, shutdownCalled }),
    };
  }

  it('should set timer when no clients at startup', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    assert.equal(checker.state().timerSet, true);
  });

  it('should not set timer when clients are present', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(1, false);
    assert.equal(checker.state().timerSet, false);
  });

  it('should cancel timer when client connects', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    assert.equal(checker.state().timerSet, true);
    checker.checkIdleShutdown(1, false);
    assert.equal(checker.state().timerSet, false);
    assert.equal(checker.state().timerCleared, true);
  });

  it('should trigger shutdown when timer fires with no clients', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    checker.fireTimer(0, false);
    assert.equal(checker.state().shutdownCalled, true);
  });

  it('should NOT trigger shutdown when timer fires but clients reconnected', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    checker.checkIdleShutdown(1, false);
    checker.fireTimer(1, false);
    assert.equal(checker.state().shutdownCalled, false);
  });

  it('should re-arm timer after client disconnects again', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    checker.checkIdleShutdown(1, false);
    assert.equal(checker.state().timerSet, false);
    checker.checkIdleShutdown(0, false);
    assert.equal(checker.state().timerSet, true);
  });

  it('should cancel timer when extension connects', () => {
    const checker = createIdleChecker();
    checker.checkIdleShutdown(0, false);
    assert.equal(checker.state().timerSet, true);
    checker.checkIdleShutdown(0, true);
    assert.equal(checker.state().timerSet, false);
  });
});
