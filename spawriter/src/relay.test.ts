/**
 * Tests for relay.ts logic: HTTP routes, tab ownership management, target listing,
 * extension validation, CDP event routing, and download behavior.
 *
 * Run: npx tsx --test spawriter/src/relay.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION, getCdpUrl, DEFAULT_PORT } from './utils.js';
import { OWNERSHIP_ERROR_CODE } from './protocol.js';
import { resolveCdpSessionForCaller, isPlaywrightTargetRegistryAssert, isDuplicateFrameAttachAssert, isTargetVisibleToClient, shouldEscalateAssertRecovery } from './relay.js';

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

  function handleTabInfoChanged(params: { tabId?: number; title?: string; url?: string } | undefined) {
    const tabId = params?.tabId;
    if (tabId == null) return;
    for (const target of attachedTargets.values()) {
      if (target.tabId === tabId && target.targetInfo) {
        if (params?.title != null) target.targetInfo.title = params.title;
        if (params?.url != null) target.targetInfo.url = params.url;
        break;
      }
    }
  }

  function normalizeUrlHint(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    if (/^[a-z][\w+.-]*:/i.test(trimmed)) return trimmed.toLowerCase();
    if (trimmed.startsWith('//')) return `https:${trimmed}`.toLowerCase();
    if (trimmed.startsWith('/')) return null;
    return `https://${trimmed}`.toLowerCase();
  }

  function urlMatchesHint(tabUrl: string, preferredUrlHint: string): boolean {
    const normalizedHint = normalizeUrlHint(preferredUrlHint);
    if (!normalizedHint) return false;
    const normalizedTab = normalizeUrlHint(tabUrl) ?? tabUrl.trim().toLowerCase();
    if (!normalizedTab) return false;
    if (
      normalizedTab === normalizedHint
      || normalizedTab.startsWith(normalizedHint)
      || normalizedHint.startsWith(normalizedTab)
    ) {
      return true;
    }
    try {
      const tab = new URL(normalizedTab);
      const hint = new URL(normalizedHint);
      if (tab.origin !== hint.origin) return false;
      if (tab.pathname === hint.pathname) return true;
      return tab.pathname.startsWith(hint.pathname) || hint.pathname.startsWith(tab.pathname);
    } catch {
      return normalizedTab.includes(normalizedHint) || normalizedHint.includes(normalizedTab);
    }
  }

  function extractTargetUrlHint(code: string): string | undefined {
    const patterns = [
      /(?:\bawait\s+)?navigate\(\s*(['"`])([^'"`]+)\1/,
      /page\.goto\(\s*(['"`])([^'"`]+)\1/,
      /browserFetch\(\s*(['"`])([^'"`]+)\1/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      if (match?.[2]?.trim()) return match[2].trim();
    }
    return undefined;
  }

  function pickReusableTab(code: string): { tabId: number; url: string; reason: string } | null {
    const preferredUrlHint = extractTargetUrlHint(code);
    const candidates: Array<{ tabId: number; url: string }> = [];
    for (const target of attachedTargets.values()) {
      if (target.tabId == null) continue;
      if (getTabOwner(target.tabId)) continue;
      candidates.push({ tabId: target.tabId, url: target.targetInfo?.url || '' });
    }
    if (candidates.length === 0) return null;

    candidates.reverse();

    if (preferredUrlHint) {
      const matched = candidates.find(candidate => urlMatchesHint(candidate.url, preferredUrlHint));
      if (matched) return { tabId: matched.tabId, url: matched.url, reason: 'url-match' };
    }
    return { tabId: candidates[0].tabId, url: candidates[0].url, reason: 'idle' };
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
    handleTabInfoChanged,
    extractTargetUrlHint,
    pickReusableTab,
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

// ---------------------------------------------------------------------------
// Tests: tabInfoChanged handler — live title/URL updates
// ---------------------------------------------------------------------------

describe('handleTabInfoChanged — title/URL sync from extension', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    relay.attachedTargets.set('session-1', {
      sessionId: 'session-1',
      tabId: 42,
      targetInfo: { title: 'Original Title', url: 'https://example.com', type: 'page', tabId: 42 },
    });
    relay.attachedTargets.set('session-2', {
      sessionId: 'session-2',
      tabId: 43,
      targetInfo: { title: 'Other Tab', url: 'https://other.com', type: 'page', tabId: 43 },
    });
  });

  it('should update title when title changes', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: 'New Title' });
    const target = relay.attachedTargets.get('session-1');
    assert.equal(target?.targetInfo?.title, 'New Title');
    assert.equal(target?.targetInfo?.url, 'https://example.com');
  });

  it('should update URL when URL changes', () => {
    relay.handleTabInfoChanged({ tabId: 42, url: 'https://example.com/page2' });
    const target = relay.attachedTargets.get('session-1');
    assert.equal(target?.targetInfo?.title, 'Original Title');
    assert.equal(target?.targetInfo?.url, 'https://example.com/page2');
  });

  it('should update both title and URL simultaneously', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: 'Page 2', url: 'https://example.com/page2' });
    const target = relay.attachedTargets.get('session-1');
    assert.equal(target?.targetInfo?.title, 'Page 2');
    assert.equal(target?.targetInfo?.url, 'https://example.com/page2');
  });

  it('should not affect other tabs', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: 'Changed' });
    const other = relay.attachedTargets.get('session-2');
    assert.equal(other?.targetInfo?.title, 'Other Tab');
    assert.equal(other?.targetInfo?.url, 'https://other.com');
  });

  it('should ignore unknown tabId', () => {
    relay.handleTabInfoChanged({ tabId: 999, title: 'Ghost Tab' });
    assert.equal(relay.attachedTargets.get('session-1')?.targetInfo?.title, 'Original Title');
    assert.equal(relay.attachedTargets.get('session-2')?.targetInfo?.title, 'Other Tab');
  });

  it('should ignore when tabId is missing', () => {
    relay.handleTabInfoChanged({ title: 'No Tab' });
    assert.equal(relay.attachedTargets.get('session-1')?.targetInfo?.title, 'Original Title');
  });

  it('should ignore undefined params', () => {
    relay.handleTabInfoChanged(undefined);
    assert.equal(relay.attachedTargets.get('session-1')?.targetInfo?.title, 'Original Title');
  });

  it('should handle target without targetInfo gracefully', () => {
    relay.attachedTargets.set('session-bare', { sessionId: 'session-bare', tabId: 99 });
    relay.handleTabInfoChanged({ tabId: 99, title: 'Should not crash' });
    assert.equal(relay.attachedTargets.get('session-bare')?.targetInfo, undefined);
  });

  it('should reflect updated title in /json/list output', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: 'Updated Title', url: 'https://newsite.com' });
    const targets = relay.listTargets(19989);
    const updated = targets.find(t => t.tabId === 42);
    assert.equal(updated?.title, 'Updated Title');
    assert.equal(updated?.url, 'https://newsite.com');
  });

  it('should update only the first matching target for a tabId', () => {
    relay.attachedTargets.set('session-dup', {
      sessionId: 'session-dup',
      tabId: 42,
      targetInfo: { title: 'Duplicate', url: 'https://dup.com', type: 'page', tabId: 42 },
    });
    relay.handleTabInfoChanged({ tabId: 42, title: 'Changed' });
    const original = relay.attachedTargets.get('session-1');
    const dup = relay.attachedTargets.get('session-dup');
    assert.equal(original?.targetInfo?.title, 'Changed');
    assert.equal(dup?.targetInfo?.title, 'Duplicate');
  });

  it('should handle empty string title', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: '' });
    assert.equal(relay.attachedTargets.get('session-1')?.targetInfo?.title, '');
  });

  it('should handle sequential updates correctly', () => {
    relay.handleTabInfoChanged({ tabId: 42, title: 'Step 1' });
    relay.handleTabInfoChanged({ tabId: 42, url: 'https://step2.com' });
    relay.handleTabInfoChanged({ tabId: 42, title: 'Step 3', url: 'https://step3.com' });
    const target = relay.attachedTargets.get('session-1');
    assert.equal(target?.targetInfo?.title, 'Step 3');
    assert.equal(target?.targetInfo?.url, 'https://step3.com');
  });
});

describe('extractTargetUrlHint', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
  });

  it('should parse URL from navigate call', () => {
    const result = relay.extractTargetUrlHint('await navigate("https://example.com/path")');
    assert.equal(result, 'https://example.com/path');
  });

  it('should parse URL from page.goto call', () => {
    const result = relay.extractTargetUrlHint("await page.goto('http://localhost:3000/app')");
    assert.equal(result, 'http://localhost:3000/app');
  });

  it('should return undefined for non-literal target', () => {
    const result = relay.extractTargetUrlHint('await navigate(targetUrl)');
    assert.equal(result, undefined);
  });
});

describe('pickReusableTab', () => {
  // Every blue-dot (attached, unowned) tab is reusable, whatever its URL:
  // own green tab -> any blue dot (URL match first, then newest) -> create.
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
  });

  it('should prioritize URL-matched unowned attached tab', () => {
    relay.attachedTargets.set('target-blank', {
      sessionId: 'target-blank',
      tabId: 1,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 1 },
    });
    relay.attachedTargets.set('target-match', {
      sessionId: 'target-match',
      tabId: 2,
      targetInfo: { title: 'Example', url: 'https://example.com/dashboard', type: 'page', tabId: 2 },
    });

    const result = relay.pickReusableTab('await navigate("https://example.com")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 2);
    assert.equal(result!.reason, 'url-match');
  });

  it('should fall back to the newest blue dot when the URL hint misses', () => {
    relay.attachedTargets.set('target-web', {
      sessionId: 'target-web',
      tabId: 10,
      targetInfo: { title: 'Docs', url: 'https://docs.example.com', type: 'page', tabId: 10 },
    });
    relay.attachedTargets.set('target-blank', {
      sessionId: 'target-blank',
      tabId: 11,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 11 },
    });

    const result = relay.pickReusableTab('await navigate("https://not-found.example.com")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 11, 'newest attached blue dot');
    assert.equal(result!.reason, 'idle');
  });

  it('should ignore owned URL matches and reuse an available blue dot', () => {
    relay.attachedTargets.set('target-owned', {
      sessionId: 'target-owned',
      tabId: 21,
      targetInfo: { title: 'Target', url: 'https://target.example.com', type: 'page', tabId: 21 },
    });
    relay.attachedTargets.set('target-available', {
      sessionId: 'target-available',
      tabId: 22,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 22 },
    });
    relay.claimTab(21, 'sw-other');

    const result = relay.pickReusableTab('await navigate("https://target.example.com")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 22);
    assert.equal(result!.reason, 'idle');
  });

  it('without a hint, reuses the most recently attached blue dot whatever its URL', () => {
    // A user-attached content tab is a hand-off to the agent.
    relay.attachedTargets.set('target-a', {
      sessionId: 'target-a',
      tabId: 31,
      targetInfo: { title: 'A', url: 'https://a.example.com', type: 'page', tabId: 31 },
    });
    relay.attachedTargets.set('target-b', {
      sessionId: 'target-b',
      tabId: 32,
      targetInfo: { title: 'B', url: 'https://b.example.com', type: 'page', tabId: 32 },
    });

    const result = relay.pickReusableTab('state.count = (state.count || 0) + 1');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 32, 'most recently attached wins');
    assert.equal(result!.reason, 'idle');
  });

  it('with a hint that matches nothing, still reuses a blue dot (the agent navigates it)', () => {
    relay.attachedTargets.set('blue-dot', {
      sessionId: 'blue-dot',
      tabId: 33,
      targetInfo: { title: 'Docs', url: 'https://docs.example.com', type: 'page', tabId: 33 },
    });

    const result = relay.pickReusableTab('await navigate("https://other.example.com")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 33);
    assert.equal(result!.reason, 'idle');
  });

  it('should pick the most recent among multiple blank tabs', () => {
    relay.attachedTargets.set('target-blank-1', {
      sessionId: 'target-blank-1',
      tabId: 40,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 40 },
    });
    relay.attachedTargets.set('target-blank-2', {
      sessionId: 'target-blank-2',
      tabId: 41,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 41 },
    });

    const result = relay.pickReusableTab('state.count = 1');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 41);
    assert.equal(result!.reason, 'idle');
  });

  it('should return null when all tabs are owned', () => {
    relay.attachedTargets.set('t1', {
      sessionId: 't1', tabId: 50,
      targetInfo: { title: 'Tab A', url: 'about:blank', type: 'page', tabId: 50 },
    });
    relay.attachedTargets.set('t2', {
      sessionId: 't2', tabId: 51,
      targetInfo: { title: 'Tab B', url: 'https://example.com', type: 'page', tabId: 51 },
    });
    relay.claimTab(50, 'sw-x');
    relay.claimTab(51, 'sw-y');

    const result = relay.pickReusableTab('await navigate("https://example.com")');
    assert.equal(result, null);
  });

  it('should return null when no attached targets exist', () => {
    const result = relay.pickReusableTab('await screenshot()');
    assert.equal(result, null);
  });

  it('should skip targets without tabId', () => {
    relay.attachedTargets.set('no-tab', { sessionId: 'no-tab' });
    relay.attachedTargets.set('has-tab', {
      sessionId: 'has-tab', tabId: 60,
      targetInfo: { title: 'Blank', url: 'about:blank', type: 'page', tabId: 60 },
    });

    const result = relay.pickReusableTab('state.x = 1');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 60);
  });

  it('should prefer URL match over a newer blue dot', () => {
    relay.attachedTargets.set('match', {
      sessionId: 'match', tabId: 71,
      targetInfo: { title: 'App', url: 'https://myapp.com/dashboard', type: 'page', tabId: 71 },
    });
    relay.attachedTargets.set('newer-blank', {
      sessionId: 'newer-blank', tabId: 70,
      targetInfo: { title: 'New Tab', url: 'about:blank', type: 'page', tabId: 70 },
    });

    const result = relay.pickReusableTab('await navigate("https://myapp.com")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 71);
    assert.equal(result!.reason, 'url-match');
  });

  it('should not reuse an owned tab even if its URL matches', () => {
    relay.attachedTargets.set('owned-match', {
      sessionId: 'owned-match', tabId: 80,
      targetInfo: { title: 'App', url: 'https://myapp.com', type: 'page', tabId: 80 },
    });
    relay.claimTab(80, 'sw-busy');

    const result = relay.pickReusableTab('await navigate("https://myapp.com")');
    assert.equal(result, null);
  });

  it('should treat chrome://newtab/ as a reusable blue dot', () => {
    relay.attachedTargets.set('newtab', {
      sessionId: 'newtab', tabId: 90,
      targetInfo: { title: 'New Tab', url: 'chrome://newtab/', type: 'page', tabId: 90 },
    });

    const result = relay.pickReusableTab('console.log("hi")');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 90);
    assert.equal(result!.reason, 'idle');
  });

  it('should skip owned tabs and pick the newest available blue dot', () => {
    relay.attachedTargets.set('owned-blank', {
      sessionId: 'owned-blank', tabId: 130,
      targetInfo: { title: 'Blank', url: 'about:blank', type: 'page', tabId: 130 },
    });
    relay.attachedTargets.set('gmail', {
      sessionId: 'gmail', tabId: 131,
      targetInfo: { title: 'Gmail', url: 'https://mail.google.com', type: 'page', tabId: 131 },
    });
    relay.attachedTargets.set('free-newtab', {
      sessionId: 'free-newtab', tabId: 132,
      targetInfo: { title: 'New Tab', url: 'chrome://newtab/', type: 'page', tabId: 132 },
    });
    relay.claimTab(130, 'sw-busy');

    const result = relay.pickReusableTab('state.x = 1');
    assert.notEqual(result, null);
    assert.equal(result!.tabId, 132, 'newest unowned blue dot wins');
    assert.equal(result!.reason, 'idle');
  });
});

// ===========================================================================
// Tests: S4 — resolveCdpSessionForCaller (HTTP /cli/cdp ownership enforcement)
// ===========================================================================

describe('resolveCdpSessionForCaller (S4)', () => {
  function makeTargets(entries: Array<{ sessionId: string; tabId?: number }>) {
    const map = new Map<string, { tabId?: number; sessionId: string }>();
    for (const e of entries) map.set(e.sessionId, e);
    return map;
  }

  it('without caller session, returns the first target (legacy internal use)', () => {
    const targets = makeTargets([{ sessionId: 'cdp-1', tabId: 1 }, { sessionId: 'cdp-2', tabId: 2 }]);
    assert.equal(resolveCdpSessionForCaller(targets, () => undefined, undefined), 'cdp-1');
  });

  it('without caller session and no targets, returns undefined', () => {
    assert.equal(resolveCdpSessionForCaller(makeTargets([]), () => undefined, undefined), undefined);
  });

  it('caller gets its own tab even when other targets come first', () => {
    const targets = makeTargets([{ sessionId: 'cdp-1', tabId: 1 }, { sessionId: 'cdp-2', tabId: 2 }]);
    const ownerOf = (tabId: number) => (tabId === 2 ? 'sw-me' : 'sw-other');
    assert.equal(resolveCdpSessionForCaller(targets, ownerOf, 'sw-me'), 'cdp-2');
  });

  it('caller owning nothing gets undefined — never another session tab', () => {
    const targets = makeTargets([{ sessionId: 'cdp-1', tabId: 1 }, { sessionId: 'cdp-2', tabId: 2 }]);
    const ownerOf = () => 'sw-other';
    assert.equal(resolveCdpSessionForCaller(targets, ownerOf, 'sw-me'), undefined);
  });

  it('caller never falls through to an unowned tab', () => {
    const targets = makeTargets([{ sessionId: 'cdp-1', tabId: 1 }]);
    assert.equal(resolveCdpSessionForCaller(targets, () => undefined, 'sw-me'), undefined);
  });

  it('targets without tabId never match a caller', () => {
    const targets = makeTargets([{ sessionId: 'cdp-1' }]);
    const ownerOf = () => 'sw-me';
    assert.equal(resolveCdpSessionForCaller(targets, ownerOf, 'sw-me'), undefined);
  });
});

// ===========================================================================
// Tests: S8 — Target.createTarget / Target.closeTarget through the relay
// ===========================================================================

describe('S8 regression: Target.createTarget/closeTarget implemented', () => {
  const relaySource = readFileSync(new URL('./relay.ts', import.meta.url), 'utf-8');
  const bridgeSource = readFileSync(new URL('../../extension/src/ai_bridge/bridge.js', import.meta.url), 'utf-8');

  it('relay routes Target.createTarget and Target.closeTarget to async handlers', () => {
    assert.ok(relaySource.includes("method === 'Target.createTarget'"));
    assert.ok(relaySource.includes("method === 'Target.closeTarget'"));
    assert.ok(relaySource.includes('handleCreateTarget('));
    assert.ok(relaySource.includes('handleCloseTarget('));
  });

  it('createTarget forces a new tab and claims it for the caller session', () => {
    assert.ok(relaySource.includes("sendExtensionCommand('connectTabByMatch', { url: createUrl, forceCreate: true }"));
    assert.ok(relaySource.includes('claimTab(newTabId, callerSession)'));
  });

  it('closeTarget refuses to close a tab owned by another session', () => {
    assert.ok(relaySource.includes('owner !== callerSession'));
    assert.ok(relaySource.includes('Cannot close.'));
  });

  it('extension handles closeTab via browser.tabs.remove', () => {
    assert.ok(bridgeSource.includes('"closeTab"') || bridgeSource.includes("'closeTab'"));
    assert.ok(bridgeSource.includes('tabs.remove'));
  });

  it('closeTarget resolves targetId by real CDP id or relay sessionId (the /json/list id)', () => {
    assert.ok(relaySource.includes('buildTargetInfo(t).targetId === targetId || t.sessionId === targetId'));
  });
});

// ===========================================================================
// Tests: target lifecycle events must reach Playwright as browser-level
// events (no top-level sessionId), or pages are never created/closed.
// ===========================================================================

describe('regression: live target lifecycle events are browser-level', () => {
  const relaySource = readFileSync(new URL('./relay.ts', import.meta.url), 'utf-8');

  it('live Target.attachedToTarget is sent per-client without top-level sessionId', () => {
    // A top-level sessionId makes Playwright route the event to a
    // not-yet-existing CRSession and drop it: live-attached tabs would
    // never become pages (newPage/bind/switch all hang on this).
    const block = relaySource.slice(
      relaySource.indexOf("method === 'Target.attachedToTarget' && sessionId"),
      relaySource.indexOf('Target.tabAvailable'),
    );
    assert.ok(block.includes('sendToCDPClient(cdpClientId'), 'expected per-client send loop');
    assert.ok(block.includes('boundSession'), 'expected per-client ownership filter');
    const sendCall = block.slice(block.indexOf('sendToCDPClient(cdpClientId'), block.indexOf('});') + 3);
    // sessionId may only appear inside params, never as a sibling of method/params.
    const outsideParams = sendCall.replace(/params:\s*\{[\s\S]*\}\s*,/, 'params: {},');
    assert.ok(!/\bsessionId\b/.test(outsideParams), 'live attachedToTarget must not have top-level sessionId');
  });

  it('Target.detachedFromTarget is broadcast browser-level and enriched with targetId', () => {
    // Playwright resolves the dying page by params.targetId; the extension
    // only sends params.sessionId. Without enrichment page.close() hangs.
    const idx = relaySource.indexOf("method === 'Target.detachedFromTarget'");
    assert.ok(idx > -1);
    const block = relaySource.slice(idx, relaySource.indexOf('maybeSynthesizeBrowserDownloadEvent', idx));
    assert.ok(block.includes('detachedTargetId'), 'expected targetId enrichment');
    assert.ok(block.includes('broadcastToCDPClients({'), 'expected browser-level broadcast');
    assert.ok(block.includes('return;'), 'must return instead of falling through to routeCdpEvent');
    assert.ok(!block.includes('routeCdpEvent(method'), 'must not route with top-level sessionId');
  });
});

// ===========================================================================
// Tests: auto-acquisition only ever sees attached (dotted) tabs. Undotted
// user tabs must be invisible to every automatic path; blue-dot tabs are
// agent territory by convention and freely reusable.
// ===========================================================================

describe('regression: auto-acquisition is confined to attached (dotted) tabs', () => {
  const relaySource = readFileSync(new URL('./relay.ts', import.meta.url), 'utf-8');

  it('pickReusableAttachedTab is the sole reuse decision point and only sees attachedTargets', () => {
    const idx = relaySource.indexOf('function pickReusableAttachedTab');
    assert.ok(idx > -1);
    const fn = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
    assert.ok(fn.includes('attachedTargets.values()'), 'must iterate attachedTargets only');
    assert.ok(fn.includes('getTabOwner(target.tabId)) continue'), 'must skip owned tabs');

    // Reuse callers: /connect-tab and the execute auto-acquire path. Nothing
    // else may pick tabs, and nothing may enumerate raw browser tabs.
    const reuseCalls = relaySource.match(/pickReusableAttachedTab\(/g) ?? [];
    assert.equal(reuseCalls.length, 3, 'definition + exactly two callers');
  });
});

// ===========================================================================
// Tests: behavioral — live attach/detach over a real relay process. This is
// the end-to-end guarantee behind newPage()/page.close()/bind/switch: a tab
// attached after a CDP client connects must surface as a browser-level
// attachedToTarget, and its detach must carry the targetId.
// ===========================================================================

describe('behavioral: live target lifecycle over WS', () => {
  it('pw client gets browser-level attach and targetId-enriched detach', async () => {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const os = await import('node:os');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { default: WebSocket } = await import('ws');

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.join(srcDir, '..');
    const tsxCli = path.join(pkgRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const port = 21000 + (process.pid % 2000);
    // Isolate the child's relay.log from the real one.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'spawriter-test-'));

    const child = spawn(
      process.execPath,
      [tsxCli, path.join(srcDir, 'cli.ts'), 'relay', '--port', String(port)],
      {
        stdio: 'ignore',
        env: { ...process.env, SSPA_MCP_PORT: String(port), TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      },
    );

    try {
      const deadline = Date.now() + 20000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { up = true; break; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
      }
      assert.ok(up, 'relay child did not start in time');

      const openWs = (url: string, opts?: Record<string, unknown>) =>
        new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
          const ws = new WebSocket(url, opts);
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        });

      const ext = await openWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { origin: 'chrome-extension://testextension' },
      });
      const received: Array<{ method?: string; sessionId?: string; params?: any }> = [];
      // FP2: a page target is replayed only to the client that owns its tab, so
      // declare the session at connect time and claim tab 42 for it.
      const pwSession = 'sess-e2e-attach';
      const pw = await openWs(`ws://127.0.0.1:${port}/cdp/pw-test-1?session=${pwSession}`);
      pw.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));
      await fetch(`http://127.0.0.1:${port}/cli/tab/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 42, sessionId: pwSession }),
      });

      const waitForMethod = async (method: string) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const msg = received.find(m => m.method === method);
          if (msg) return msg;
          await new Promise(r => setTimeout(r, 50));
        }
        return assert.fail(`did not receive ${method}; got: ${received.map(m => m.method).join(', ') || '(nothing)'}`);
      };

      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          sessionId: 'spawriter-tab-42-1',
          params: {
            sessionId: 'spawriter-tab-42-1',
            targetInfo: { targetId: 'TT42', type: 'page', tabId: 42, url: 'about:blank', title: '' },
          },
        },
      }));

      const attach = await waitForMethod('Target.attachedToTarget');
      assert.equal(attach.sessionId, undefined, 'live attach must not carry a top-level sessionId');
      assert.equal(attach.params.sessionId, 'spawriter-tab-42-1');
      assert.equal(attach.params.targetInfo.targetId, 'TT42');

      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          sessionId: 'spawriter-tab-42-1',
          params: { sessionId: 'spawriter-tab-42-1', reason: 'tab-removed' },
        },
      }));

      const detach = await waitForMethod('Target.detachedFromTarget');
      assert.equal(detach.sessionId, undefined, 'detach must not carry a top-level sessionId');
      assert.equal(detach.params.targetId, 'TT42', 'detach must be enriched with targetId');

      ext.close();
      pw.close();
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 200));
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ===========================================================================
// Tests: duplicate-attach containment. The extension re-announces every tab on
// resync (service-worker wake, relay reconnect). Forwarding such a re-announce
// verbatim makes Playwright's CRBrowser assert ("Duplicate target …"), which
// surfaces as an unhandled rejection and used to kill the whole relay.
// ===========================================================================

describe('isPlaywrightTargetRegistryAssert', () => {
  it('matches the CRBrowser duplicate-target assert', () => {
    assert.ok(isPlaywrightTargetRegistryAssert(new Error('Duplicate target spawriter-tab-1842658130-1765507333411')));
  });

  it('matches generic assertion errors from playwright chromium internals', () => {
    const err = new Error('Assertion error');
    err.stack = `Error: Assertion error\n    at assert (/x/node_modules/playwright-core/lib/utils/isomorphic/assert.js:5:11)\n    at CRBrowser._onAttachedToTarget (/x/node_modules/playwright-core/lib/server/chromium/crBrowser.js:154:30)`;
    assert.ok(isPlaywrightTargetRegistryAssert(err));
  });

  it('does not match unrelated errors', () => {
    assert.ok(!isPlaywrightTargetRegistryAssert(new Error('ECONNREFUSED 127.0.0.1:9222')));
    const other = new Error('Assertion error');
    other.stack = 'Error: Assertion error\n    at somewhere (/x/app/main.js:1:1)';
    assert.ok(!isPlaywrightTargetRegistryAssert(other));
  });

  it('matches the CRSession stale-response assert', () => {
    // crConnection.js:129 `assert(!object.id, ...)` — a response routed to a
    // session object that replaced the one holding the callback.
    const err = new Error('Assertion error');
    err.stack = `Error: Assertion error\n    at assert (/x/node_modules/playwright-core/lib/utils/isomorphic/assert.js:5:11)\n    at CRSession._onMessage (/x/node_modules/playwright-core/lib/server/chromium/crConnection.js:129:30)`;
    assert.ok(isPlaywrightTargetRegistryAssert(err));
  });
});

describe('isDuplicateFrameAttachAssert', () => {
  const frameAttachedAssert = () => {
    const err = new Error('Assertion error');
    err.stack = 'Error: Assertion error\n'
      + '    at assert (/x/node_modules/playwright-core/lib/utils/isomorphic/assert.js:26:11)\n'
      + '    at FrameManager.frameAttached (/x/node_modules/playwright-core/lib/server/frames.js:113:31)\n'
      + '    at FrameSession._onFrameAttached (/x/node_modules/playwright-core/lib/server/chromium/crPage.js:507:29)\n'
      + '    at /x/node_modules/playwright-core/lib/server/chromium/crConnection.js:133:14';
    return err;
  };

  it('matches the duplicate Page.frameAttached init race', () => {
    assert.ok(isDuplicateFrameAttachAssert(frameAttachedAssert()));
  });

  it('is a subset of the registry-assert classifier (still handled, never fatal)', () => {
    assert.ok(isPlaywrightTargetRegistryAssert(frameAttachedAssert()));
  });

  it('does not match other chromium asserts (those still escalate on bursts)', () => {
    const err = new Error('Assertion error');
    err.stack = 'Error: Assertion error\n    at CRSession._onMessage (/x/node_modules/playwright-core/lib/server/chromium/crConnection.js:129:30)';
    assert.ok(!isDuplicateFrameAttachAssert(err));
  });
});

describe('shouldEscalateAssertRecovery', () => {
  it('stays log-only below the burst threshold and escalates at it', () => {
    const t0 = 10_000_000;
    assert.equal(shouldEscalateAssertRecovery(t0), false);
    assert.equal(shouldEscalateAssertRecovery(t0 + 1_000), false);
    assert.equal(shouldEscalateAssertRecovery(t0 + 2_000), true, 'third assert within the window escalates');
    // Escalation clears the window; the next assert starts a fresh count.
    assert.equal(shouldEscalateAssertRecovery(t0 + 3_000), false);
  });

  it('a slow trickle outside the window never escalates', () => {
    const t0 = 20_000_000;
    assert.equal(shouldEscalateAssertRecovery(t0), false);
    assert.equal(shouldEscalateAssertRecovery(t0 + 31_000), false);
    assert.equal(shouldEscalateAssertRecovery(t0 + 62_000), false);
  });
});

describe('regression: duplicate attach announces are contained', () => {
  const relaySource = readFileSync(new URL('./relay.ts', import.meta.url), 'utf-8');
  const bridgeSource = readFileSync(new URL('../../extension/src/ai_bridge/bridge.js', import.meta.url), 'utf-8');

  it('relay tracks per-client announced targets and skips re-announces', () => {
    assert.ok(relaySource.includes('announcedTargets: Map<string, string>'), 'CDPClient must track announced targets');
    const block = relaySource.slice(
      relaySource.indexOf("method === 'Target.attachedToTarget' && sessionId"),
      relaySource.indexOf('Target.tabAvailable'),
    );
    assert.ok(block.includes('announcedTargets.get(sessionId) === announcedId) continue'), 'live attach must skip already-announced clients');
    assert.ok(block.includes("reason: 'target-id-changed'"), 'targetId change must detach the old identity first');
  });

  it('every detach broadcast carries a targetId so Playwright can unregister the page', () => {
    assert.ok(
      relaySource.includes("targetId: staleTargetId, reason: 'target-replaced'"),
      'target-replaced detach must carry targetId',
    );
    assert.ok(
      relaySource.includes('targetId: buildTargetInfo(target).targetId'),
      'extension-disconnect detach must carry targetId',
    );
  });

  it('announce bookkeeping is cleared on every detach path', () => {
    const calls = relaySource.match(/clearAnnouncedTarget\(/g) ?? [];
    assert.ok(calls.length >= 4, `definition + replace/idchange/detach callers, got ${calls.length}`);
    assert.ok(relaySource.includes('client.announcedTargets.clear()'), 'extension disconnect must reset announce maps');
  });

  it('relay survives playwright target-registry asserts instead of exiting', () => {
    assert.ok(relaySource.includes('isPlaywrightTargetRegistryAssert'), 'error handlers must classify registry asserts');
    assert.ok(relaySource.includes('relayExecutorManager.resetAll()'), 'recovery must reset executors, not exit');
  });

  it('extension resync is single-flight', () => {
    assert.ok(bridgeSource.includes('if (resyncInFlight) return resyncInFlight'), 'concurrent resyncs must share one pass');
    assert.ok(bridgeSource.includes('doResyncAttachedTabs().finally'), 'in-flight marker must always clear');
  });

  it('extension mints the targetId once per attach and reuses it on resync', () => {
    // The main frame id changes on cross-process navigation (prerender
    // activation / BFCache swap); re-reading it re-announces the same live
    // session as a "new" target and churns Playwright's registry.
    assert.match(
      bridgeSource,
      /attachedTabs\.set\(tabId, \{\s*sessionId,\s*targetId,/,
      'attachTab must persist the minted targetId with the entry',
    );
    assert.ok(bridgeSource.includes('if (!existing.targetId)'), 'resync must mint only when the entry has none');
    assert.ok(bridgeSource.includes('targetId: existing.targetId'), 'resync must re-announce the stored targetId');
  });

  it('relay drops child-target attach/detach churn instead of treating it as tab announces', () => {
    const block = relaySource.slice(
      relaySource.indexOf("method === 'Target.attachedToTarget' && sessionId"),
      relaySource.indexOf('Target.tabAvailable'),
    );
    assert.ok(
      block.includes('innerSessionId !== undefined && innerSessionId !== sessionId'),
      'attaches whose inner sessionId differs from the envelope must not touch the registry',
    );
    const detachStart = relaySource.indexOf("method === 'Target.detachedFromTarget'");
    const detachBlock = relaySource.slice(
      detachStart,
      relaySource.indexOf('maybeSynthesizeBrowserDownloadEvent', detachStart),
    );
    assert.ok(
      detachBlock.includes('detachedSessionId !== sessionId'),
      'detaches whose inner sessionId differs from the envelope must be dropped',
    );
  });
});

describe('behavioral: duplicate attach announces over WS', () => {
  it('re-announces are deduped per client; detaches re-arm announcing', async () => {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const os = await import('node:os');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { default: WebSocket } = await import('ws');

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.join(srcDir, '..');
    const tsxCli = path.join(pkgRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const port = 23000 + (process.pid % 2000);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'spawriter-test-'));

    const child = spawn(
      process.execPath,
      [tsxCli, path.join(srcDir, 'cli.ts'), 'relay', '--port', String(port)],
      {
        stdio: 'ignore',
        env: { ...process.env, SSPA_MCP_PORT: String(port), TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      },
    );

    try {
      const deadline = Date.now() + 20000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { up = true; break; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
      }
      assert.ok(up, 'relay child did not start in time');

      const openWs = (url: string, opts?: Record<string, unknown>) =>
        new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
          const ws = new WebSocket(url, opts);
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        });

      const received: Array<{ method?: string; params?: any }> = [];
      // FP2: page targets reach only the owning client; bind a session and
      // (re-)claim tab 42 for it before each announce phase.
      const dupSession = 'sess-e2e-dup';
      const claimTab42 = () => fetch(`http://127.0.0.1:${port}/cli/tab/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 42, sessionId: dupSession }),
      });
      const pw = await openWs(`ws://127.0.0.1:${port}/cdp/pw-test-dup?session=${dupSession}`);
      pw.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));

      const attaches = () => received.filter(m => m.method === 'Target.attachedToTarget');
      const detaches = () => received.filter(m => m.method === 'Target.detachedFromTarget');
      const waitFor = async (pred: () => boolean, what: string) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          if (pred()) return;
          await new Promise(r => setTimeout(r, 50));
        }
        assert.fail(`timeout waiting for ${what}; got: ${received.map(m => m.method).join(', ') || '(nothing)'}`);
      };
      const announce = (ext: InstanceType<typeof WebSocket>, sessionId: string, targetId: string) =>
        ext.send(JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId,
            params: {
              sessionId,
              targetInfo: { targetId, type: 'page', tabId: 42, url: 'about:blank', title: '' },
            },
          },
        }));

      let ext = await openWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { origin: 'chrome-extension://testextension' },
      });
      await claimTab42();

      // 1. First announce reaches the client.
      announce(ext, 'spawriter-tab-42-1', 'TT42');
      await waitFor(() => attaches().length === 1, 'first attach');

      // 2. Identical re-announce (extension resync) must NOT be forwarded again.
      announce(ext, 'spawriter-tab-42-1', 'TT42');
      await new Promise(r => setTimeout(r, 400));
      assert.equal(attaches().length, 1, 'duplicate announce must be swallowed');

      // 2b. Child-target churn (OOPIF auto-attach forwarded under the tab's
      //     envelope sessionId, no tabId in targetInfo — the Turnstile
      //     pattern): must neither corrupt the tab registry nor emit a
      //     'target-id-changed' detach that would close the live page.
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          sessionId: 'spawriter-tab-42-1',
          params: {
            sessionId: 'oopif-child-1',
            targetInfo: { targetId: 'OOPIF1', type: 'iframe', url: 'https://challenges.cloudflare.com/x' },
            waitingForDebugger: false,
          },
        },
      }));
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          sessionId: 'spawriter-tab-42-1',
          params: { sessionId: 'oopif-child-1' },
        },
      }));
      await new Promise(r => setTimeout(r, 400));
      assert.equal(attaches().length, 1, 'child-target attach must not become a tab announce');
      assert.equal(detaches().length, 0, 'child-target churn must not detach the tab');
      const listed = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ tabId?: number; targetId?: string }>;
      assert.equal(listed.find(t => t.tabId === 42)?.targetId, 'TT42', 'registry must keep the tab targetId');

      // 3. Same session, new targetId (cross-process nav while bridge was down):
      //    old identity is detached, new one announced.
      announce(ext, 'spawriter-tab-42-1', 'TT42b');
      await waitFor(() => attaches().length === 2, 'attach with new targetId');
      assert.ok(
        detaches().some(m => m.params?.targetId === 'TT42' && m.params?.reason === 'target-id-changed'),
        'old targetId must be detached before the new announce',
      );

      // 4. New session for the same tab (debugger re-attach): stale session is
      //    detached with its targetId, then the new session is announced.
      announce(ext, 'spawriter-tab-42-2', 'TT43');
      await waitFor(() => attaches().length === 3, 'attach for replacement session');
      assert.ok(
        detaches().some(m => m.params?.sessionId === 'spawriter-tab-42-1' && m.params?.targetId === 'TT42b'),
        'replaced session detach must carry its targetId',
      );

      // 5. Extension drops: detach is enriched, announce bookkeeping resets,
      //    so the post-reconnect resync is forwarded again.
      ext.close();
      await waitFor(
        () => detaches().some(m => m.params?.reason === 'extension-disconnected' && m.params?.targetId === 'TT43'),
        'enriched extension-disconnected detach',
      );

      ext = await openWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { origin: 'chrome-extension://testextension' },
      });
      // The extension drop reset the browser-side mirror, clearing tab
      // ownership; re-claim so the post-reconnect announce reaches the owner.
      await claimTab42();
      announce(ext, 'spawriter-tab-42-2', 'TT43');
      await waitFor(() => attaches().length === 4, 're-announce after reconnect must be forwarded');

      ext.close();
      pw.close();
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 200));
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ===========================================================================
// Tests: spawriter-tab-page-mapping-fix.md regression suite (FP1–FP5). Numbers
// in comments map to the document's "Regression Tests" list.
// ===========================================================================

describe('FP2: strict Playwright target visibility (isTargetVisibleToClient)', () => {
  // 5: unbound client (early setAutoAttach/setDiscoverTargets replay window).
  it('hides every page target from an unbound client but shows browser-level', () => {
    assert.equal(isTargetVisibleToClient(42, undefined, 'sess-a'), false);
    assert.equal(isTargetVisibleToClient(42, undefined, undefined), false);
    // Browser-level targets (no tabId) bootstrap Playwright and stay visible.
    assert.equal(isTargetVisibleToClient(null, undefined, undefined), true);
    assert.equal(isTargetVisibleToClient(undefined, undefined, undefined), true);
  });

  // 6: a bound client only ever sees targets its own session owns.
  it('shows a bound client only its own owned targets', () => {
    assert.equal(isTargetVisibleToClient(42, 'sess-a', 'sess-a'), true);
    assert.equal(isTargetVisibleToClient(42, 'sess-a', 'sess-b'), false);
    assert.equal(isTargetVisibleToClient(42, 'sess-a', undefined), false);
  });

  // 2: a created+claimed tab is visible only to its owner client.
  it('a tab claimed for a session is invisible to other clients', () => {
    const relay = createRelayState();
    relay.claimTab(99, 'owner-sess');
    const owner = relay.getTabOwner(99);
    assert.equal(isTargetVisibleToClient(99, 'owner-sess', owner), true);
    assert.equal(isTargetVisibleToClient(99, 'other-sess', owner), false);
    assert.equal(isTargetVisibleToClient(99, undefined, owner), false);
  });
});

describe('FP1–FP5: relay source invariants', () => {
  const relaySource = readFileSync(new URL('./relay.ts', import.meta.url), 'utf-8');

  // 7: every Playwright target replay path filters through isTargetVisibleToClient.
  it('all five replay paths go through isTargetVisibleToClient', () => {
    const calls = relaySource.match(/isTargetVisibleToClient\(/g) ?? [];
    assert.ok(calls.length >= 6, `expected definition + 5 call sites, got ${calls.length}`);
    for (const fn of ['function sendAttachedToTargetEvents', 'function sendTargetCreatedEvents']) {
      const idx = relaySource.indexOf(fn);
      const body = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
      assert.ok(body.includes('isTargetVisibleToClient('), `${fn} must filter`);
    }
    for (const handler of ["case 'Target.getTargets'", "case 'Target.getTargetInfo'"]) {
      const idx = relaySource.indexOf(handler);
      const body = relaySource.slice(idx, idx + 800);
      assert.ok(body.includes('isTargetVisibleToClient('), `${handler} must filter`);
    }
  });

  // 1: /connect-tab claims atomically for the caller session.
  it('connect-tab accepts sessionId and claims the tab before returning', () => {
    const idx = relaySource.indexOf("app.post('/connect-tab'");
    const body = relaySource.slice(idx, relaySource.indexOf('\napp.post(', idx + 1));
    assert.ok(body.includes('sessionId'), 'must accept sessionId');
    assert.ok(body.includes('claimForSession('), 'reuse and create paths must claim');
    assert.ok(body.includes('replayClaimedTargetToOwner('), 'claimed target must replay to owner');
  });

  // 3: the atomic claim is all-or-nothing (no provisional ownership, so no
  // explicit pending-connect hold is needed — strict visibility already hides
  // an unclaimed target from every client).
  it('a lost connect claim leaves no provisional ownership', () => {
    const idx = relaySource.indexOf("app.post('/connect-tab'");
    const body = relaySource.slice(idx, relaySource.indexOf('\napp.post(', idx + 1));
    const cf = body.slice(body.indexOf('claimForSession ='), body.indexOf('respondFor ='));
    assert.ok(cf.includes('if (!r.ok) return false'), 'a lost claim must not set ownership');
  });

  // 9: claim replays only to the owner's CDP client.
  it('replayClaimedTargetToOwner sends only to the owner client', () => {
    const idx = relaySource.indexOf('function replayClaimedTargetToOwner');
    const body = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
    assert.ok(body.includes('sessionToClientId.get(sessionId)'), 'resolves owner client by session');
    assert.ok(body.includes('sendToCDPClient(clientId'), 'sends to that single client');
  });

  // 10: resetRelaySession clears all per-session relay state.
  it('resetRelaySession clears ownership, activity, bindings, executor, virtual sessions', () => {
    const idx = relaySource.indexOf('async function resetRelaySession');
    const body = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
    assert.ok(body.includes('releaseAllTabs(sessionId)'), 'releases owned tabs');
    assert.ok(body.includes('sessionActivity.delete(sessionId)'), 'clears activity');
    assert.ok(body.includes('sessionToClientId.delete(sessionId)'), 'clears session→client');
    assert.ok(body.includes('pwClientToSession.delete'), 'clears client→session');
    assert.ok(body.includes('relayExecutorManager.remove(sessionId)'), 'removes executor');
    assert.ok(body.includes('clearVirtualSessionsForRealSession'), 'clears virtual sessions');
  });

  // 11: reset, delete, and stale sweep all delegate to resetRelaySession.
  it('reset, delete, and stale sweep all delegate to resetRelaySession', () => {
    const calls = relaySource.match(/resetRelaySession\(/g) ?? [];
    assert.ok(calls.length >= 4, `expected definition + three callers, got ${calls.length}`);
    assert.ok(relaySource.includes("app.post('/cli/session/reset'"));
    assert.ok(relaySource.includes("app.post('/cli/session/delete'"));
  });

  // 13: assert recovery resets the bridge target graph and virtual maps.
  it('resetBridgeState clears the target graph, announces, and virtual maps', () => {
    const idx = relaySource.indexOf('function resetBridgeState');
    const body = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
    assert.ok(body.includes('tabOwners.clear()'), 'releases ownership');
    assert.ok(body.includes('attachedTargets.clear()'), 'empties attached targets for resync rebuild');
    assert.ok(body.includes('announcedTargets.clear()'), 'clears announce bookkeeping');
    assert.ok(body.includes('virtualBrowserSessions.clear()'));
    assert.ok(body.includes('virtualToRealSession.clear()'));
    assert.ok(body.includes('realToVirtualSessions.clear()'));
  });

  // 14: the CDP socket close handler drops connection bindings ONLY. Tab
  // ownership is session-scoped and must survive a reconnect: the executor's
  // stale-context recovery closes the socket and reconnects immediately, and
  // releasing tabs here made strict visibility hide the tab from the new
  // client ("No targets attached" on every recovery retry).
  it('CDP websocket close clears client bindings but never releases tabs', () => {
    const idx = relaySource.indexOf('log(`CDP WebSocket disconnected');
    const body = relaySource.slice(idx, idx + 900);
    assert.ok(body.includes('pwClientToSession.delete(clientId)'), 'clears client→session');
    assert.ok(body.includes('sessionToClientId.delete(sid)'), 'clears session→client');
    assert.ok(!body.includes('releaseAllTabs('), 'ownership must survive CDP reconnects');
  });

  // 15: registry-assert recovery never tears down the bridge; a full executor
  // reset happens only for rate-limited assert bursts. Bridge teardown here
  // used to amplify one dropped Playwright message into a full disconnect
  // storm (detach broadcast → every page closed → resync → re-assert loop).
  it('registry-assert recovery is rate-limited and never resets bridge state', () => {
    const idx = relaySource.indexOf('function handleRecoverableProcessError');
    const body = relaySource.slice(idx, relaySource.indexOf('\nfunction ', idx + 1));
    assert.ok(body.includes('isPlaywrightTargetRegistryAssert(reason)'), 'classifies registry asserts');
    assert.ok(body.includes('isDuplicateFrameAttachAssert(reason)'), 'benign frameAttached duplicates bypass escalation');
    assert.ok(body.indexOf('isDuplicateFrameAttachAssert') < body.indexOf('shouldEscalateAssertRecovery'), 'bypass is checked before the burst counter');
    assert.ok(body.includes('shouldEscalateAssertRecovery()'), 'escalation is rate-limited');
    assert.ok(body.includes('relayExecutorManager.resetAll()'), 'burst recovery resets executors');
    assert.ok(!body.includes('resetBridgeState('), 'assert recovery must not tear down the bridge');
  });
});

describe('FP4: session cleanup behavioral parity', () => {
  // 12: releasing a session leaves no tab owned by it; others keep theirs.
  it('releasing a session leaves no owned tabs', () => {
    const relay = createRelayState();
    relay.claimTab(1, 'sess-a');
    relay.claimTab(2, 'sess-a');
    relay.claimTab(3, 'sess-b');
    assert.equal(relay.releaseAllTabs('sess-a'), 2);
    assert.equal(relay.getTabOwner(1), undefined);
    assert.equal(relay.getTabOwner(2), undefined);
    assert.equal(relay.getTabOwner(3), 'sess-b', 'other sessions keep their tabs');
  });
});

describe('FP2 behavioral: ownership isolation over WS', () => {
  // 8: two CDP clients, one owns the tab; only the owner receives the page.
  it('only the owner client receives a claimed tab page target', async () => {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const os = await import('node:os');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { default: WebSocket } = await import('ws');

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCli = path.join(srcDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const port = 25000 + (process.pid % 2000);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'spawriter-test-'));

    const child = spawn(
      process.execPath,
      [tsxCli, path.join(srcDir, 'cli.ts'), 'relay', '--port', String(port)],
      { stdio: 'ignore', env: { ...process.env, SSPA_MCP_PORT: String(port), TEMP: tmp, TMP: tmp, TMPDIR: tmp } },
    );

    try {
      const deadline = Date.now() + 20000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { up = true; break; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
      }
      assert.ok(up, 'relay child did not start in time');

      const openWs = (url: string, opts?: Record<string, unknown>) =>
        new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
          const ws = new WebSocket(url, opts);
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        });

      const ext = await openWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { origin: 'chrome-extension://testextension' },
      });

      const ownerMsgs: Array<{ method?: string; params?: any }> = [];
      const otherMsgs: Array<{ method?: string; params?: any }> = [];
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-owner?session=sess-owner`);
      const other = await openWs(`ws://127.0.0.1:${port}/cdp/pw-other?session=sess-other`);
      owner.on('message', (d: Buffer) => ownerMsgs.push(JSON.parse(d.toString())));
      other.on('message', (d: Buffer) => otherMsgs.push(JSON.parse(d.toString())));

      // Owner claims tab 77; the other session never does.
      await fetch(`http://127.0.0.1:${port}/cli/tab/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 77, sessionId: 'sess-owner' }),
      });

      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          sessionId: 'spawriter-tab-77-1',
          params: { sessionId: 'spawriter-tab-77-1', targetInfo: { targetId: 'T77', type: 'page', tabId: 77, url: 'about:blank', title: '' } },
        },
      }));

      const end = Date.now() + 5000;
      let ownerGotIt = false;
      while (Date.now() < end) {
        ownerGotIt = ownerMsgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === 'T77');
        if (ownerGotIt) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(ownerGotIt, 'owner must receive the page target attach');
      // Same window for the other client; it must never see the page target.
      await new Promise(r => setTimeout(r, 400));
      assert.ok(
        !otherMsgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.tabId === 77),
        'a non-owner client must never receive the page target',
      );

      ext.close(); owner.close(); other.close();
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 200));
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

describe('FP1/FP5 behavioral E2E (real relay over WS)', () => {
  // Shared spawn harness: boots a real relay child, hands the test an openWs that
  // tracks its sockets, and tears everything down. Keeps the two E2E cases below
  // free of duplicated boot/cleanup boilerplate.
  async function withRelay(
    port: number,
    run: (ctx: { port: number; openWs: (url: string, opts?: Record<string, unknown>) => Promise<InstanceType<typeof import('ws').default>> }) => Promise<void>,
  ): Promise<void> {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const os = await import('node:os');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { default: WebSocket } = await import('ws');

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCli = path.join(srcDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'spawriter-test-'));
    const child = spawn(
      process.execPath,
      [tsxCli, path.join(srcDir, 'cli.ts'), 'relay', '--port', String(port)],
      { stdio: 'ignore', env: { ...process.env, SSPA_MCP_PORT: String(port), TEMP: tmp, TMP: tmp, TMPDIR: tmp } },
    );
    const openSockets: Array<InstanceType<typeof WebSocket>> = [];
    const openWs = (url: string, opts?: Record<string, unknown>) =>
      new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const ws = new WebSocket(url, opts);
        openSockets.push(ws);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });

    try {
      const deadline = Date.now() + 20000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) { up = true; break; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
      }
      assert.ok(up, 'relay child did not start in time');
      await run({ port, openWs });
    } finally {
      for (const ws of openSockets) { try { ws.close(); } catch { /* already closed */ } }
      child.kill();
      await new Promise(r => setTimeout(r, 200));
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const PORT_BASE = 27000 + (process.pid % 1500);

  // FP1 + FP3 end-to-end: a single /connect-tab call claims the created tab for
  // the caller, and only that owner's CDP client receives the page target.
  it('connect-tab atomically claims a created tab and replays only to the owner', async () => {
    await withRelay(PORT_BASE, async ({ port, openWs }) => {
      const ext = await openWs(`ws://127.0.0.1:${port}/extension`, { headers: { origin: 'chrome-extension://testextension' } });
      // Simulated extension: answer connectTabByMatch with a freshly created tab.
      ext.on('message', (d: Buffer) => {
        const msg = JSON.parse(d.toString());
        if (msg.method === 'connectTabByMatch') {
          ext.send(JSON.stringify({ id: msg.id, success: true, tabId: 777, created: true }));
        }
      });
      const ownerMsgs: Array<{ method?: string; params?: any }> = [];
      const otherMsgs: Array<{ method?: string; params?: any }> = [];
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-owner?session=sess-fp1`);
      const other = await openWs(`ws://127.0.0.1:${port}/cdp/pw-other?session=sess-other`);
      owner.on('message', (d: Buffer) => ownerMsgs.push(JSON.parse(d.toString())));
      other.on('message', (d: Buffer) => otherMsgs.push(JSON.parse(d.toString())));

      const res = await fetch(`http://127.0.0.1:${port}/connect-tab`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/', create: true, sessionId: 'sess-fp1' }),
      });
      const body = await res.json() as { success: boolean; tabId?: number; claimed?: boolean; created?: boolean };
      assert.equal(body.success, true, 'connect-tab succeeds');
      assert.equal(body.tabId, 777);
      assert.equal(body.created, true);
      assert.equal(body.claimed, true, 'connect-tab claims for the caller session in one round-trip');

      // The extension then attaches the created tab; strict visibility + claim
      // replay mean the owner sees it and the other session never does.
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          sessionId: 'spawriter-tab-777-1',
          params: { sessionId: 'spawriter-tab-777-1', targetInfo: { targetId: 'T777', type: 'page', tabId: 777, url: 'https://example.com/', title: '' } },
        },
      }));

      const end = Date.now() + 5000;
      let ownerGot = false;
      while (Date.now() < end) {
        ownerGot = ownerMsgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === 'T777');
        if (ownerGot) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(ownerGot, 'owner receives the claimed page target');
      await new Promise(r => setTimeout(r, 300));
      assert.ok(
        !otherMsgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.tabId === 777),
        'a non-owner client never sees the claimed page target',
      );
    });
  });

  // FP5 end-to-end: an extension drop runs resetBridgeState, which must release
  // ownership and detach the page (with its targetId) for the owning client.
  it('extension disconnect releases the tab and detaches the owner page', async () => {
    await withRelay(PORT_BASE + 1, async ({ port, openWs }) => {
      const ext = await openWs(`ws://127.0.0.1:${port}/extension`, { headers: { origin: 'chrome-extension://testextension' } });
      const msgs: Array<{ method?: string; params?: any }> = [];
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-rel?session=sess-rel`);
      owner.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString())));
      await fetch(`http://127.0.0.1:${port}/cli/tab/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 88, sessionId: 'sess-rel' }),
      });
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          sessionId: 'spawriter-tab-88-1',
          params: { sessionId: 'spawriter-tab-88-1', targetInfo: { targetId: 'T88', type: 'page', tabId: 88, url: 'about:blank', title: '' } },
        },
      }));

      const waitFor = async (pred: () => boolean, what: string) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) { if (pred()) return; await new Promise(r => setTimeout(r, 50)); }
        assert.fail(`timeout waiting for ${what}; got: ${msgs.map(m => m.method).join(', ') || '(nothing)'}`);
      };
      await waitFor(() => msgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === 'T88'), 'owner attach');

      ext.close();
      await waitFor(() => msgs.some(m => m.method === 'Target.tabReleased' && m.params?.tabId === 88), 'tabReleased on extension drop');
      await waitFor(() => msgs.some(m => m.method === 'Target.detachedFromTarget' && m.params?.targetId === 'T88'), 'detached (with targetId) on extension drop');
    });
  });

  // ---- Shared helpers for the broader E2E matrix below ------------------------
  type RelayMsg = { id?: number; method?: string; sessionId?: string; params?: any; result?: any };
  const collect = (ws: { on: (ev: string, cb: (d: Buffer) => void) => void }): RelayMsg[] => {
    const msgs: RelayMsg[] = [];
    ws.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString())));
    return msgs;
  };
  const openExt = (port: number, openWs: (url: string, opts?: Record<string, unknown>) => Promise<any>) =>
    openWs(`ws://127.0.0.1:${port}/extension`, { headers: { origin: 'chrome-extension://testextension' } });
  const claimVia = (port: number, tabId: number, sessionId: string, force = false) =>
    fetch(`http://127.0.0.1:${port}/cli/tab/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, sessionId, force }),
    });
  const attachPage = (
    ext: { send: (s: string) => void },
    cdpSession: string, targetId: string, tabId: number | undefined, url = 'about:blank', type = 'page',
  ) => ext.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      sessionId: cdpSession,
      params: { sessionId: cdpSession, targetInfo: { targetId, type, tabId, url, title: '' } },
    },
  }));
  const hasAttach = (msgs: RelayMsg[], targetId: string) =>
    msgs.some(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === targetId);
  const waitUntil = async (pred: () => boolean, what: string, dump?: () => string) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (pred()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(`timeout waiting for ${what}${dump ? `; got: ${dump()}` : ''}`);
  };

  // Concurrent claims on one tab must be atomic: exactly one wins (200), the
  // other is rejected (409), so ownership is single and stable (FP1).
  it('concurrent claims on the same tab — exactly one wins', async () => {
    await withRelay(PORT_BASE + 2, async ({ port }) => {
      const [a, b] = await Promise.all([claimVia(port, 500, 'sess-A'), claimVia(port, 500, 'sess-B')]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], 'one claim succeeds, the other conflicts');
      const conflict = a.status === 409 ? await a.json() : await b.json();
      assert.match(conflict.error, /owned by sess-(A|B)/, 'the conflict names the actual owner');
    });
  });

  // Strict visibility end-to-end (FP2): two owners each see only their own page
  // target, both over the live attach and via Target.getTargets.
  it('two sessions are isolated: each sees only its own target (+ getTargets filter)', async () => {
    await withRelay(PORT_BASE + 3, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const a = await openWs(`ws://127.0.0.1:${port}/cdp/pw-a?session=sess-ia`);
      const b = await openWs(`ws://127.0.0.1:${port}/cdp/pw-b?session=sess-ib`);
      const am = collect(a), bm = collect(b);
      await claimVia(port, 601, 'sess-ia');
      await claimVia(port, 602, 'sess-ib');
      attachPage(ext, 'spawriter-tab-601-1', 'TA', 601, 'https://a/');
      attachPage(ext, 'spawriter-tab-602-1', 'TB', 602, 'https://b/');

      await waitUntil(() => hasAttach(am, 'TA'), 'A sees TA', () => am.map(m => m.method).join(','));
      await waitUntil(() => hasAttach(bm, 'TB'), 'B sees TB', () => bm.map(m => m.method).join(','));
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!hasAttach(am, 'TB'), 'A never sees the other-owned target');
      assert.ok(!hasAttach(bm, 'TA'), 'B never sees the other-owned target');

      a.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      await waitUntil(() => am.some(m => m.id === 1 && m.result), 'getTargets reply for A');
      const ids = (am.find(m => m.id === 1)!.result.targetInfos as Array<{ targetId: string }>).map(t => t.targetId);
      assert.ok(ids.includes('TA'), 'A getTargets includes its own target');
      assert.ok(!ids.includes('TB'), 'A getTargets excludes the other-owned target');
    });
  });

  // A CDP-session swap on the same tab (debugger re-attach / cross-process nav):
  // the stale target is detached, but ownership is keyed by tabId so the owner
  // still receives the replacement target.
  it('a CDP-session swap on the same tab keeps the owner and replays the new target', async () => {
    await withRelay(PORT_BASE + 4, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-sw?session=sess-sw`);
      const msgs = collect(owner);
      await claimVia(port, 700, 'sess-sw');
      attachPage(ext, 'spawriter-tab-700-1', 'TOLD', 700, 'https://x/');
      await waitUntil(() => hasAttach(msgs, 'TOLD'), 'owner sees the first target');

      attachPage(ext, 'spawriter-tab-700-2', 'TNEW', 700, 'https://x/');
      await waitUntil(() => msgs.some(m => m.method === 'Target.detachedFromTarget' && m.params?.targetId === 'TOLD'), 'stale target detached');
      await waitUntil(() => hasAttach(msgs, 'TNEW'), 'owner sees the replacement target (ownership preserved)');
    });
  });

  // Explicit release transfers a tab: the old owner is notified, and a different
  // session can re-claim it and receive the still-attached page target (FP3/FP4).
  it('release frees a tab and a new session can re-claim and see its target', async () => {
    await withRelay(PORT_BASE + 5, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const a = await openWs(`ws://127.0.0.1:${port}/cdp/pw-ra?session=sess-ra`);
      const b = await openWs(`ws://127.0.0.1:${port}/cdp/pw-rb?session=sess-rb`);
      const am = collect(a), bm = collect(b);
      await claimVia(port, 800, 'sess-ra');
      attachPage(ext, 'spawriter-tab-800-1', 'T800', 800, 'https://r/');
      await waitUntil(() => hasAttach(am, 'T800'), 'A sees its target');

      assert.equal((await claimVia(port, 800, 'sess-rb')).status, 409, 'an owned tab is not claimable by others');

      const rel = await fetch(`http://127.0.0.1:${port}/cli/tab/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 800, sessionId: 'sess-ra' }),
      });
      assert.equal(rel.status, 200, 'owner releases its tab');
      await waitUntil(() => am.some(m => m.method === 'Target.tabReleased' && m.params?.tabId === 800), 'old owner notified of release');
      assert.equal((await claimVia(port, 800, 'sess-rb')).status, 200, 'released tab is re-claimable');
      await waitUntil(() => hasAttach(bm, 'T800'), 'new owner receives the replayed target');
    });
  });

  // A CDP client dropping (Playwright disconnect/reconnect) must NOT release
  // the session's tabs: the executor's stale-context recovery closes the socket
  // and reconnects under the same session, and strict visibility would hide a
  // released (unowned) tab from the new client ("No targets attached" on every
  // recovery retry). Ownership is session-scoped, not connection-scoped.
  it('a CDP client disconnect keeps the session tab claims', async () => {
    await withRelay(PORT_BASE + 6, async ({ port, openWs }) => {
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-dc?session=sess-dc`);
      const observer = await openWs(`ws://127.0.0.1:${port}/cdp/pw-ob?session=sess-ob`);
      const om = collect(observer);
      await claimVia(port, 900, 'sess-dc');
      assert.equal((await claimVia(port, 900, 'sess-ob')).status, 409, 'tab owned while the client is connected');

      owner.close();
      await new Promise(r => setTimeout(r, 500));
      assert.ok(
        !om.some(m => m.method === 'Target.tabReleased' && m.params?.tabId === 900),
        'no release broadcast on disconnect',
      );
      assert.equal((await claimVia(port, 900, 'sess-ob')).status, 409, 'claim survives the owner reconnect window');
      assert.equal((await claimVia(port, 900, 'sess-dc')).status, 200, 'the owning session itself can still re-claim');
    });
  });

  // An unbound CDP client (no session declared) is in the early setAutoAttach
  // window (FP2): it must receive no page target, but browser-level targets
  // (no tabId) still bootstrap it.
  it('an unbound client gets no page target but still sees browser-level targets', async () => {
    await withRelay(PORT_BASE + 7, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const unbound = await openWs(`ws://127.0.0.1:${port}/cdp/pw-unbound`);
      const um = collect(unbound);
      await claimVia(port, 1000, 'sess-owner');
      attachPage(ext, 'spawriter-tab-1000-1', 'TPAGE', 1000, 'https://p/');
      attachPage(ext, 'browser-sess-1', 'TBROWSER', undefined, '', 'browser');

      await waitUntil(() => hasAttach(um, 'TBROWSER'), 'unbound sees the browser-level target', () => um.map(m => m.method).join(','));
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!hasAttach(um, 'TPAGE'), 'unbound never sees a page target');
    });
  });

  // Force-claim takes a tab from its current owner and notifies them, so a stuck
  // session can be recovered without leaving a phantom owner (claimTab force path).
  it('force-claim takes a tab from its owner and notifies the old owner', async () => {
    await withRelay(PORT_BASE + 8, async ({ port, openWs }) => {
      const a = await openWs(`ws://127.0.0.1:${port}/cdp/pw-fa?session=sess-fa`);
      const am = collect(a);
      await claimVia(port, 1100, 'sess-fa');
      assert.equal((await claimVia(port, 1100, 'sess-fb', true)).status, 200, 'force claim succeeds');
      await waitUntil(
        () => am.some(m => m.method === 'Target.tabReleased' && m.params?.tabId === 1100 && m.params?.reason === 'force-takeover'),
        'old owner notified of force-takeover', () => am.map(m => m.method).join(','),
      );
      assert.equal((await claimVia(port, 1100, 'sess-fa')).status, 409, 'old owner can no longer claim without force');
    });
  });

  // connect-tab must reuse an idle, unowned attached tab (decided against the
  // relay's own state, never by scanning the user's tabs) rather than create one.
  it('connect-tab reuses an idle attached tab instead of creating one', async () => {
    await withRelay(PORT_BASE + 9, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      attachPage(ext, 'spawriter-tab-1200-1', 'TIDLE', 1200, 'https://reuse.example/');
      await new Promise(r => setTimeout(r, 200));
      const res = await fetch(`http://127.0.0.1:${port}/connect-tab`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://reuse.example/', sessionId: 'sess-reuse' }),
      });
      const body = await res.json() as { success: boolean; tabId?: number; reused?: boolean; created?: boolean; claimed?: boolean };
      assert.equal(body.success, true);
      assert.equal(body.tabId, 1200, 'reused the idle tab');
      assert.equal(body.reused, true, 'flagged as a reuse');
      assert.notEqual(body.created, true, 'did not create a new tab');
      assert.equal(body.claimed, true, 'atomically claimed for the caller');
    });
  });

  // Target.getTargetInfo is the fifth visibility call site: an owner can read its
  // own target but an other-owned target is reported as missing (FP2).
  it('Target.getTargetInfo is visibility-filtered like getTargets', async () => {
    await withRelay(PORT_BASE + 10, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const a = await openWs(`ws://127.0.0.1:${port}/cdp/pw-gi?session=sess-gia`);
      const am = collect(a);
      await claimVia(port, 1300, 'sess-gia');
      await claimVia(port, 1301, 'sess-gib');
      attachPage(ext, 'spawriter-tab-1300-1', 'GA', 1300);
      attachPage(ext, 'spawriter-tab-1301-1', 'GB', 1301);
      await waitUntil(() => hasAttach(am, 'GA'), 'owner sees its own target');

      a.send(JSON.stringify({ id: 10, method: 'Target.getTargetInfo', params: { targetId: 'GA' } }));
      a.send(JSON.stringify({ id: 11, method: 'Target.getTargetInfo', params: { targetId: 'GB' } }));
      await waitUntil(() => am.some(m => m.id === 10) && am.some(m => m.id === 11), 'both getTargetInfo replies');
      assert.equal(am.find(m => m.id === 10)!.result?.targetInfo?.targetId, 'GA', 'own target is returned');
      const other = am.find(m => m.id === 11)!;
      assert.ok(other.error && !other.result, 'an other-owned target is not exposed');
    });
  });

  // Extension resync re-announces every tab. An identical re-announce must be
  // deduplicated (a duplicate attach trips CRBrowser's assert), but a changed
  // targetId on the same CDP session (cross-process nav) must detach then re-attach.
  it('same-session re-announce dedups an identical target and detaches on targetId change', async () => {
    await withRelay(PORT_BASE + 11, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-ra2?session=sess-ra2`);
      const msgs = collect(owner);
      await claimVia(port, 1400, 'sess-ra2');
      attachPage(ext, 'spawriter-tab-1400-1', 'RA1', 1400);
      await waitUntil(() => hasAttach(msgs, 'RA1'), 'first attach');

      attachPage(ext, 'spawriter-tab-1400-1', 'RA1', 1400);
      await new Promise(r => setTimeout(r, 300));
      const ra1 = msgs.filter(m => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === 'RA1').length;
      assert.equal(ra1, 1, 'identical re-announce is deduplicated');

      attachPage(ext, 'spawriter-tab-1400-1', 'RA2', 1400);
      await waitUntil(() => msgs.some(m => m.method === 'Target.detachedFromTarget' && m.params?.targetId === 'RA1'), 'old targetId detached on change');
      await waitUntil(() => hasAttach(msgs, 'RA2'), 'new targetId attached');
    });
  });

  // A page closing: the extension forwards a detach for that CDP session. The
  // relay enriches it with the targetId (Playwright resolves the page by it) and
  // frees the tab so another session can take over.
  it('an extension detachedFromTarget detaches the page and frees the tab', async () => {
    await withRelay(PORT_BASE + 12, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      const owner = await openWs(`ws://127.0.0.1:${port}/cdp/pw-dt?session=sess-dt`);
      const msgs = collect(owner);
      await claimVia(port, 1500, 'sess-dt');
      attachPage(ext, 'spawriter-tab-1500-1', 'DT', 1500);
      await waitUntil(() => hasAttach(msgs, 'DT'), 'owner attach');

      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: { method: 'Target.detachedFromTarget', sessionId: 'spawriter-tab-1500-1', params: { sessionId: 'spawriter-tab-1500-1' } },
      }));
      await waitUntil(() => msgs.some(m => m.method === 'Target.detachedFromTarget' && m.params?.targetId === 'DT'), 'detach carries the enriched targetId');
      await waitUntil(() => msgs.some(m => m.method === 'Target.tabReleased' && m.params?.tabId === 1500 && m.params?.reason === 'tab-detached'), 'tab freed on page close');
      assert.equal((await claimVia(port, 1500, 'sess-dt2')).status, 200, 're-claimable after the page closed');
    });
  });

  // Connect-time replay (the remaining two FP2 visibility call sites): a late
  // owner client replays its owned target on setAutoAttach (attachedToTarget) and
  // setDiscoverTargets (targetCreated); a different session sees neither.
  it('connect-time replay (setAutoAttach / setDiscoverTargets) is visibility-filtered', async () => {
    await withRelay(PORT_BASE + 13, async ({ port, openWs }) => {
      const ext = await openExt(port, openWs);
      await claimVia(port, 1600, 'sess-rpa');
      attachPage(ext, 'spawriter-tab-1600-1', 'RP', 1600);
      await new Promise(r => setTimeout(r, 200));

      const a = await openWs(`ws://127.0.0.1:${port}/cdp/pw-rpa?session=sess-rpa`);
      const am = collect(a);
      a.send(JSON.stringify({ id: 20, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
      await waitUntil(() => hasAttach(am, 'RP'), 'owner replays its target on setAutoAttach', () => am.map(m => m.method).join(','));
      a.send(JSON.stringify({ id: 21, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      await waitUntil(() => am.some(m => m.method === 'Target.targetCreated' && m.params?.targetInfo?.targetId === 'RP'), 'owner replays its target on setDiscoverTargets');

      const b = await openWs(`ws://127.0.0.1:${port}/cdp/pw-rpb?session=sess-rpb`);
      const bm = collect(b);
      b.send(JSON.stringify({ id: 22, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
      b.send(JSON.stringify({ id: 23, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      await new Promise(r => setTimeout(r, 400));
      assert.ok(!hasAttach(bm, 'RP'), 'a non-owner gets no attachedToTarget replay');
      assert.ok(!bm.some(m => m.method === 'Target.targetCreated' && m.params?.targetInfo?.targetId === 'RP'), 'a non-owner gets no targetCreated replay');
    });
  });
});
