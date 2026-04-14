/**
 * Tests for relay.ts logic: HTTP routes, lease management, target listing,
 * extension validation, CDP event routing, and download behavior.
 *
 * Run: npx tsx --test spawriter/src/relay.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, getCdpUrl, DEFAULT_PORT } from './utils.js';
import { LEASE_ERROR_CODE } from './protocol.js';
import type { LeaseInfo } from './protocol.js';

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

interface TabLease {
  clientId: string;
  label?: string;
  acquiredAt: number;
}

interface DownloadBehavior {
  behavior: string;
  downloadPath?: string;
}

function createRelayState() {
  const attachedTargets = new Map<string, AttachedTarget>();
  const leases = new Map<string, TabLease>();
  const downloadBehaviors = new Map<string, DownloadBehavior>();

  function getLeaseInfo(sessionId: string): LeaseInfo | null {
    const lease = leases.get(sessionId);
    if (!lease) return null;
    return {
      clientId: lease.clientId,
      label: lease.label,
      acquiredAt: lease.acquiredAt,
    };
  }

  function acquireLease(
    clientId: string,
    sessionId: string,
    label?: string
  ): { granted: boolean; error?: string; holder?: { clientId: string; label?: string } } {
    if (!attachedTargets.has(sessionId)) {
      return { granted: false, error: `Target ${sessionId} not found` };
    }
    const existing = leases.get(sessionId);
    if (existing && existing.clientId !== clientId) {
      return {
        granted: false,
        error: `Tab leased by ${existing.label || existing.clientId}`,
        holder: { clientId: existing.clientId, label: existing.label },
      };
    }
    leases.set(sessionId, { clientId, label, acquiredAt: Date.now() });
    return { granted: true };
  }

  function releaseLease(
    clientId: string,
    sessionId: string
  ): { released: boolean; error?: string } {
    const existing = leases.get(sessionId);
    if (!existing) return { released: true };
    if (existing.clientId !== clientId) return { released: false, error: 'Not the lease holder' };
    leases.delete(sessionId);
    return { released: true };
  }

  function releaseAllLeases(clientId: string): number {
    let count = 0;
    for (const [sessionId, lease] of leases) {
      if (lease.clientId === clientId) {
        leases.delete(sessionId);
        count++;
      }
    }
    return count;
  }

  function checkLeaseEnforcement(
    clientId: string,
    sessionId: string
  ): { allowed: boolean; error?: string } {
    const lease = leases.get(sessionId);
    if (!lease) return { allowed: true };
    if (lease.clientId !== clientId) {
      return { allowed: false, error: `Tab leased by ${lease.label || lease.clientId}` };
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
        lease: getLeaseInfo(target.sessionId),
      };
    });
  }

  return {
    attachedTargets,
    leases,
    downloadBehaviors,
    getLeaseInfo,
    acquireLease,
    releaseLease,
    releaseAllLeases,
    checkLeaseEnforcement,
    listTargets,
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
// CDP event routing (mirrors relay.ts logic)
// ---------------------------------------------------------------------------

function routeCdpEvent(
  sessionId: string | undefined,
  leases: Map<string, TabLease>,
  cdpClients: Map<string, { ws: { send: (data: string) => void } }>
): string[] {
  const recipients: string[] = [];

  if (!sessionId) {
    for (const clientId of cdpClients.keys()) {
      recipients.push(clientId);
    }
    return recipients;
  }

  const lease = leases.get(sessionId);
  if (lease) {
    if (cdpClients.has(lease.clientId)) {
      recipients.push(lease.clientId);
    }
    return recipients;
  }

  for (const clientId of cdpClients.keys()) {
    recipients.push(clientId);
  }
  return recipients;
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
    assert.equal(targets[0].lease, null);
  });

  it('should include lease info when a lease exists', () => {
    const relay = createRelayState();
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Page 1', url: 'https://a.com', type: 'page' },
    });
    relay.acquireLease('agent-a', 's1', 'Agent A');
    const targets = relay.listTargets(19989);
    assert.notEqual(targets[0].lease, null);
    assert.equal(targets[0].lease!.clientId, 'agent-a');
    assert.equal(targets[0].lease!.label, 'Agent A');
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
// Tests: Lease enforcement on CDP commands
// ---------------------------------------------------------------------------

describe('Lease enforcement on CDP commands', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    relay.attachedTargets.set('s1', {
      sessionId: 's1',
      tabId: 1,
      targetInfo: { title: 'Tab', url: 'https://a.com', type: 'page' },
    });
  });

  it('should allow commands when no lease exists', () => {
    const result = relay.checkLeaseEnforcement('agent-a', 's1');
    assert.equal(result.allowed, true);
  });

  it('should allow commands from the lease holder', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.checkLeaseEnforcement('agent-a', 's1');
    assert.equal(result.allowed, true);
  });

  it('should block commands from non-holder', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.checkLeaseEnforcement('agent-b', 's1');
    assert.equal(result.allowed, false);
    assert.ok(result.error?.includes('leased by'));
  });

  it('should include label in error when available', () => {
    relay.acquireLease('agent-a', 's1', 'Agent Alpha');
    const result = relay.checkLeaseEnforcement('agent-b', 's1');
    assert.ok(result.error?.includes('Agent Alpha'));
  });
});

// ---------------------------------------------------------------------------
// Tests: Lease acquire / release
// ---------------------------------------------------------------------------

describe('Relay-level lease operations', () => {
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

  it('should grant lease for unlocked target', () => {
    const result = relay.acquireLease('agent-a', 's1');
    assert.equal(result.granted, true);
  });

  it('should allow re-acquire by same client', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.acquireLease('agent-a', 's1');
    assert.equal(result.granted, true);
  });

  it('should reject lease for target held by another', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.acquireLease('agent-b', 's1');
    assert.equal(result.granted, false);
    assert.ok(result.holder);
    assert.equal(result.holder!.clientId, 'agent-a');
  });

  it('should reject lease for non-existent target', () => {
    const result = relay.acquireLease('agent-a', 'nonexistent');
    assert.equal(result.granted, false);
    assert.ok(result.error?.includes('not found'));
  });

  it('should release lease by holder', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.releaseLease('agent-a', 's1');
    assert.equal(result.released, true);
    assert.equal(relay.leases.size, 0);
  });

  it('should fail to release lease by non-holder', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.releaseLease('agent-b', 's1');
    assert.equal(result.released, false);
  });

  it('should succeed to release non-existent lease', () => {
    const result = relay.releaseLease('agent-a', 's2');
    assert.equal(result.released, true);
  });

  it('should release all leases for a client', () => {
    relay.acquireLease('agent-a', 's1');
    relay.acquireLease('agent-a', 's2');
    const count = relay.releaseAllLeases('agent-a');
    assert.equal(count, 2);
    assert.equal(relay.leases.size, 0);
  });

  it('should only release the matching client leases', () => {
    relay.acquireLease('agent-a', 's1');
    relay.acquireLease('agent-b', 's2');
    const count = relay.releaseAllLeases('agent-a');
    assert.equal(count, 1);
    assert.equal(relay.leases.size, 1);
    assert.equal(relay.leases.has('s2'), true);
  });
});

// ---------------------------------------------------------------------------
// Tests: CDP event routing with leases
// ---------------------------------------------------------------------------

describe('CDP event routing', () => {
  it('should broadcast to all clients when no sessionId', () => {
    const leases = new Map<string, TabLease>();
    const clients = new Map([
      ['c1', { ws: { send: () => {} } }],
      ['c2', { ws: { send: () => {} } }],
    ]);
    const recipients = routeCdpEvent(undefined, leases, clients);
    assert.equal(recipients.length, 2);
    assert.ok(recipients.includes('c1'));
    assert.ok(recipients.includes('c2'));
  });

  it('should broadcast to all when session has no lease', () => {
    const leases = new Map<string, TabLease>();
    const clients = new Map([
      ['c1', { ws: { send: () => {} } }],
      ['c2', { ws: { send: () => {} } }],
    ]);
    const recipients = routeCdpEvent('some-session', leases, clients);
    assert.equal(recipients.length, 2);
  });

  it('should route only to lease holder when leased', () => {
    const leases = new Map<string, TabLease>();
    leases.set('s1', { clientId: 'c1', acquiredAt: Date.now() });
    const clients = new Map([
      ['c1', { ws: { send: () => {} } }],
      ['c2', { ws: { send: () => {} } }],
    ]);
    const recipients = routeCdpEvent('s1', leases, clients);
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0], 'c1');
  });

  it('should return empty when lease holder is not connected', () => {
    const leases = new Map<string, TabLease>();
    leases.set('s1', { clientId: 'disconnected-agent', acquiredAt: Date.now() });
    const clients = new Map([
      ['c1', { ws: { send: () => {} } }],
    ]);
    const recipients = routeCdpEvent('s1', leases, clients);
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

  it('should clean up leases when target is removed', () => {
    relay.attachedTargets.set('s1', { sessionId: 's1', tabId: 1 });
    relay.acquireLease('agent-a', 's1');
    assert.equal(relay.leases.size, 1);

    relay.attachedTargets.delete('s1');
    relay.leases.delete('s1');
    assert.equal(relay.leases.size, 0);
  });

  it('should handle simultaneous targets from same tab (re-attach)', () => {
    relay.attachedTargets.set('s1', { sessionId: 's1', tabId: 1 });
    relay.attachedTargets.set('s1-new', { sessionId: 's1-new', tabId: 1 });
    assert.equal(relay.attachedTargets.size, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: LEASE_ERROR_CODE
// ---------------------------------------------------------------------------

describe('LEASE_ERROR_CODE', () => {
  it('should be -32001', () => {
    assert.equal(LEASE_ERROR_CODE, -32001);
  });

  it('should be usable in CDP error responses', () => {
    const errorResponse = {
      id: 1,
      error: { code: LEASE_ERROR_CODE, message: 'Tab leased by another agent' },
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

  it('should allow multiple agents to lease different tabs', () => {
    assert.equal(relay.acquireLease('agent-a', 'tab-1').granted, true);
    assert.equal(relay.acquireLease('agent-b', 'tab-2').granted, true);
    assert.equal(relay.acquireLease('agent-c', 'tab-3').granted, true);
    assert.equal(relay.leases.size, 3);
  });

  it('should prevent agent from using another agent tab', () => {
    relay.acquireLease('agent-a', 'tab-1');
    relay.acquireLease('agent-b', 'tab-2');

    assert.equal(relay.checkLeaseEnforcement('agent-a', 'tab-1').allowed, true);
    assert.equal(relay.checkLeaseEnforcement('agent-a', 'tab-2').allowed, false);
    assert.equal(relay.checkLeaseEnforcement('agent-b', 'tab-2').allowed, true);
    assert.equal(relay.checkLeaseEnforcement('agent-b', 'tab-1').allowed, false);
  });

  it('should clean up all leases when agent disconnects', () => {
    relay.acquireLease('agent-a', 'tab-1');
    relay.acquireLease('agent-a', 'tab-3');
    relay.acquireLease('agent-b', 'tab-2');

    const released = relay.releaseAllLeases('agent-a');
    assert.equal(released, 2);
    assert.equal(relay.leases.size, 1);

    assert.equal(relay.acquireLease('agent-c', 'tab-1').granted, true);
    assert.equal(relay.acquireLease('agent-c', 'tab-3').granted, true);
  });

  it('should route events correctly in multi-agent scenario', () => {
    relay.acquireLease('agent-a', 'tab-1');
    relay.acquireLease('agent-b', 'tab-2');

    const clients = new Map([
      ['agent-a', { ws: { send: () => {} } }],
      ['agent-b', { ws: { send: () => {} } }],
    ]);

    const tab1Recipients = routeCdpEvent('tab-1', relay.leases, clients);
    assert.deepEqual(tab1Recipients, ['agent-a']);

    const tab2Recipients = routeCdpEvent('tab-2', relay.leases, clients);
    assert.deepEqual(tab2Recipients, ['agent-b']);

    const tab3Recipients = routeCdpEvent('tab-3', relay.leases, clients);
    assert.equal(tab3Recipients.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lease label display
// ---------------------------------------------------------------------------

describe('Lease label handling', () => {
  let relay: ReturnType<typeof createRelayState>;

  beforeEach(() => {
    relay = createRelayState();
    relay.attachedTargets.set('s1', { sessionId: 's1', tabId: 1 });
  });

  it('should store label when provided', () => {
    relay.acquireLease('agent-a', 's1', 'My Agent');
    assert.equal(relay.getLeaseInfo('s1')?.label, 'My Agent');
  });

  it('should allow lease without label', () => {
    relay.acquireLease('agent-a', 's1');
    assert.equal(relay.getLeaseInfo('s1')?.label, undefined);
  });

  it('should use label in denial message', () => {
    relay.acquireLease('agent-a', 's1', 'Build Agent');
    const result = relay.acquireLease('agent-b', 's1');
    assert.ok(result.error?.includes('Build Agent'));
  });

  it('should use clientId in denial when no label', () => {
    relay.acquireLease('agent-a', 's1');
    const result = relay.acquireLease('agent-b', 's1');
    assert.ok(result.error?.includes('agent-a'));
  });
});

// ---------------------------------------------------------------------------
// Tests: EADDRINUSE handling (Fix #1)
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
// Tests: Idle shutdown logic (Fix #4)
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
// Tests: checkIdleShutdown timer behavior (Fix #4 — behavioral)
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
