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
import { resolveCdpSessionForCaller, isPlaywrightTargetRegistryAssert } from './relay.js';

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
    const block = relaySource.slice(idx, idx + 1600);
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
      const pw = await openWs(`ws://127.0.0.1:${port}/cdp/pw-test-1`);
      pw.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));

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
      const pw = await openWs(`ws://127.0.0.1:${port}/cdp/pw-test-dup`);
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

      // 1. First announce reaches the client.
      announce(ext, 'spawriter-tab-42-1', 'TT42');
      await waitFor(() => attaches().length === 1, 'first attach');

      // 2. Identical re-announce (extension resync) must NOT be forwarded again.
      announce(ext, 'spawriter-tab-42-1', 'TT42');
      await new Promise(r => setTimeout(r, 400));
      assert.equal(attaches().length, 1, 'duplicate announce must be swallowed');

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
