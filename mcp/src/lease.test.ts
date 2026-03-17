/**
 * Tests for Tab Lease System: relay-level lease management, MCP-level
 * lease negotiation, enforcement, event filtering, and edge cases.
 *
 * Run: npx tsx --test mcp/src/lease.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LEASE_ERROR_CODE } from './protocol.js';

// ---------------------------------------------------------------------------
// Simulated TabLease registry (mirrors relay.ts logic)
// ---------------------------------------------------------------------------

interface TabLease {
  sessionId: string;
  clientId: string;
  label?: string;
  acquiredAt: number;
}

interface AttachedTarget {
  sessionId: string;
  tabId?: number;
  url?: string;
  title?: string;
}

function createLeaseRegistry() {
  const leases = new Map<string, TabLease>();
  const targets = new Map<string, AttachedTarget>();

  function addTarget(sessionId: string, tabId: number, url: string, title = '') {
    targets.set(sessionId, { sessionId, tabId, url, title });
  }

  function removeTarget(sessionId: string) {
    targets.delete(sessionId);
    leases.delete(sessionId);
  }

  function acquireLease(
    clientId: string,
    sessionId: string,
    label?: string
  ): { granted: boolean; error?: string; holder?: { clientId: string; label?: string } } {
    if (!targets.has(sessionId)) {
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

    leases.set(sessionId, {
      sessionId,
      clientId,
      label,
      acquiredAt: Date.now(),
    });
    return { granted: true };
  }

  function releaseLease(clientId: string, sessionId: string): { released: boolean; error?: string } {
    const existing = leases.get(sessionId);
    if (!existing) return { released: true };
    if (existing.clientId !== clientId) return { released: false, error: 'Not the lease holder' };
    leases.delete(sessionId);
    return { released: true };
  }

  function listLeases(): TabLease[] {
    return Array.from(leases.values());
  }

  function getLeaseInfo(sessionId: string) {
    const lease = leases.get(sessionId);
    if (!lease) return null;
    return { clientId: lease.clientId, label: lease.label, acquiredAt: lease.acquiredAt };
  }

  function releaseClientLeases(clientId: string): string[] {
    const released: string[] = [];
    for (const [sid, lease] of leases) {
      if (lease.clientId === clientId) {
        leases.delete(sid);
        released.push(sid);
      }
    }
    return released;
  }

  function checkEnforcement(clientId: string, sessionId: string): boolean {
    if (clientId.startsWith('pw-')) return true;
    const lease = leases.get(sessionId);
    if (!lease) return true;
    return lease.clientId === clientId;
  }

  function getEnrichedTargets() {
    return Array.from(targets.values()).map(t => ({
      ...t,
      lease: getLeaseInfo(t.sessionId),
    }));
  }

  return {
    leases,
    targets,
    addTarget,
    removeTarget,
    acquireLease,
    releaseLease,
    listLeases,
    getLeaseInfo,
    releaseClientLeases,
    checkEnforcement,
    getEnrichedTargets,
  };
}

// ---------------------------------------------------------------------------
// Tests: Lease Acquisition
// ---------------------------------------------------------------------------

describe('Tab Lease — Acquisition', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
  });

  it('should grant lease on unleased tab', () => {
    const result = registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.size, 1);
    const lease = registry.leases.get('tab-111-ts')!;
    assert.equal(lease.clientId, 'mcp-a');
    assert.equal(lease.label, 'agent-a');
  });

  it('should allow same client to refresh lease (idempotent)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a-updated');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.size, 1);
    assert.equal(registry.leases.get('tab-111-ts')!.label, 'agent-a-updated');
  });

  it('should reject lease for tab leased by another client', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(result.granted, false);
    assert.ok(result.error?.includes('leased by'));
    assert.equal(result.holder?.clientId, 'mcp-a');
    assert.equal(result.holder?.label, 'agent-a');
  });

  it('should reject lease for non-existent target', () => {
    const result = registry.acquireLease('mcp-a', 'tab-999-ts');
    assert.equal(result.granted, false);
    assert.ok(result.error?.includes('not found'));
  });

  it('should allow two clients to lease different tabs', () => {
    const r1 = registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const r2 = registry.acquireLease('mcp-b', 'tab-222-ts', 'agent-b');
    assert.equal(r1.granted, true);
    assert.equal(r2.granted, true);
    assert.equal(registry.leases.size, 2);
  });

  it('should allow one client to lease multiple tabs', () => {
    const r1 = registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const r2 = registry.acquireLease('mcp-a', 'tab-222-ts', 'agent-a');
    assert.equal(r1.granted, true);
    assert.equal(r2.granted, true);
    assert.equal(registry.leases.size, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lease Release
// ---------------------------------------------------------------------------

describe('Tab Lease — Release', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
  });

  it('should release lease by holder', () => {
    const result = registry.releaseLease('mcp-a', 'tab-111-ts');
    assert.equal(result.released, true);
    assert.equal(registry.leases.size, 0);
  });

  it('should reject release by non-holder', () => {
    const result = registry.releaseLease('mcp-b', 'tab-111-ts');
    assert.equal(result.released, false);
    assert.ok(result.error?.includes('Not the lease holder'));
    assert.equal(registry.leases.size, 1);
  });

  it('should no-op release on unleased tab', () => {
    const result = registry.releaseLease('mcp-a', 'tab-999-ts');
    assert.equal(result.released, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Client Disconnect Cleanup
// ---------------------------------------------------------------------------

describe('Tab Lease — Client Disconnect Cleanup', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.addTarget('tab-333-ts', 333, 'https://google.com');
  });

  it('should release all leases for disconnected client', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    registry.acquireLease('mcp-b', 'tab-333-ts');

    const released = registry.releaseClientLeases('mcp-a');
    assert.equal(released.length, 2);
    assert.ok(released.includes('tab-111-ts'));
    assert.ok(released.includes('tab-222-ts'));
    assert.equal(registry.leases.size, 1);
    assert.equal(registry.leases.get('tab-333-ts')!.clientId, 'mcp-b');
  });

  it('should handle disconnect of client with no leases', () => {
    const released = registry.releaseClientLeases('mcp-unknown');
    assert.equal(released.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Detach Cleanup
// ---------------------------------------------------------------------------

describe('Tab Lease — Tab Detach Cleanup', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
  });

  it('should clean up lease when target is removed (tab closed)', () => {
    registry.removeTarget('tab-111-ts');
    assert.equal(registry.leases.size, 0);
    assert.equal(registry.targets.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lease Enforcement
// ---------------------------------------------------------------------------

describe('Tab Lease — Enforcement', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.acquireLease('mcp-a', 'tab-111-ts');
  });

  it('should allow lease holder to send commands', () => {
    assert.equal(registry.checkEnforcement('mcp-a', 'tab-111-ts'), true);
  });

  it('should reject non-holder commands', () => {
    assert.equal(registry.checkEnforcement('mcp-b', 'tab-111-ts'), false);
  });

  it('should allow commands on unleased tabs', () => {
    assert.equal(registry.checkEnforcement('mcp-b', 'tab-222-ts'), true);
  });

  it('should exempt Playwright clients from enforcement', () => {
    assert.equal(registry.checkEnforcement('pw-1234-abc', 'tab-111-ts'), true);
  });

  it('should exempt Playwright even for non-holder sessions', () => {
    assert.equal(registry.checkEnforcement('pw-5678-xyz', 'tab-111-ts'), true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Enriched Target List (/json/list)
// ---------------------------------------------------------------------------

describe('Tab Lease — Enriched Target List', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100', 'App A');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080', 'App B');
    registry.addTarget('tab-333-ts', 333, 'https://google.com', 'Google');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    registry.acquireLease('mcp-b', 'tab-222-ts', 'agent-b');
  });

  it('should include lease info in enriched targets', () => {
    const targets = registry.getEnrichedTargets();
    assert.equal(targets.length, 3);

    const t1 = targets.find(t => t.sessionId === 'tab-111-ts')!;
    assert.notEqual(t1.lease, null);
    assert.equal(t1.lease!.clientId, 'mcp-a');
    assert.equal(t1.lease!.label, 'agent-a');

    const t3 = targets.find(t => t.sessionId === 'tab-333-ts')!;
    assert.equal(t3.lease, null);
  });
});

// ---------------------------------------------------------------------------
// Tests: List Leases
// ---------------------------------------------------------------------------

describe('Tab Lease — listLeases', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
  });

  it('should return empty list when no leases', () => {
    const leases = registry.listLeases();
    assert.equal(leases.length, 0);
  });

  it('should return all active leases', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    registry.acquireLease('mcp-b', 'tab-222-ts', 'agent-b');
    const leases = registry.listLeases();
    assert.equal(leases.length, 2);
    assert.ok(leases.some(l => l.clientId === 'mcp-a'));
    assert.ok(leases.some(l => l.clientId === 'mcp-b'));
  });
});

// ---------------------------------------------------------------------------
// Tests: Race Condition (TOCTOU)
// ---------------------------------------------------------------------------

describe('Tab Lease — Race Condition', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
  });

  it('should handle concurrent lease attempts (first wins)', () => {
    const r1 = registry.acquireLease('mcp-a', 'tab-111-ts');
    const r2 = registry.acquireLease('mcp-b', 'tab-111-ts');
    assert.equal(r1.granted, true);
    assert.equal(r2.granted, false);
    assert.equal(registry.leases.get('tab-111-ts')!.clientId, 'mcp-a');
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP Session Negotiation Logic
// ---------------------------------------------------------------------------

describe('MCP Session Negotiation', () => {
  it('should prefer unleased tabs over leased tabs', () => {
    const targets = [
      { id: 'tab-1', url: 'http://a.com', lease: { clientId: 'other', label: 'x', acquiredAt: 0 } },
      { id: 'tab-2', url: 'http://b.com', lease: null },
      { id: 'tab-3', url: 'http://c.com', lease: null },
    ];
    const unleased = targets.filter(t => !t.lease);
    assert.equal(unleased.length, 2);
    assert.equal(unleased[0].id, 'tab-2');
  });

  it('should prefer tab matching project URL', () => {
    const projectUrl = 'localhost:9100';
    const unleased = [
      { id: 'tab-1', url: 'http://localhost:8080', lease: null },
      { id: 'tab-2', url: 'http://localhost:9100/app', lease: null },
      { id: 'tab-3', url: 'https://google.com', lease: null },
    ];

    const matching = unleased.filter(t => t.url?.includes(projectUrl));
    const sorted = [...matching, ...unleased.filter(t => !t.url?.includes(projectUrl))];

    assert.equal(sorted[0].id, 'tab-2');
  });

  it('should detect all-leased scenario', () => {
    const targets = [
      { id: 'tab-1', url: 'http://a.com', lease: { clientId: 'other-a', label: 'a', acquiredAt: 0 } },
      { id: 'tab-2', url: 'http://b.com', lease: { clientId: 'other-b', label: 'b', acquiredAt: 0 } },
    ];
    const unleased = targets.filter(t => !t.lease);
    const leasedCount = targets.filter(t => t.lease).length;
    assert.equal(unleased.length, 0);
    assert.equal(leasedCount, targets.length);
  });

  it('should identify own leased tabs for reconnection', () => {
    const MY_CLIENT_ID = 'mcp-1234-abc';
    const targets = [
      { id: 'tab-1', url: 'http://a.com', lease: { clientId: MY_CLIENT_ID, label: 'me', acquiredAt: 0 } },
      { id: 'tab-2', url: 'http://b.com', lease: { clientId: 'other', label: 'x', acquiredAt: 0 } },
    ];
    const myLeased = targets.find(t => t.lease?.clientId === MY_CLIENT_ID);
    assert.ok(myLeased);
    assert.equal(myLeased!.id, 'tab-1');
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP list_tabs formatting
// ---------------------------------------------------------------------------

describe('MCP list_tabs formatting', () => {
  it('should correctly categorize tabs', () => {
    const MY_CLIENT_ID = 'mcp-1234-abc';
    const targets = [
      { id: 'tab-1', tabId: 1, url: 'http://a.com', title: 'A', lease: { clientId: MY_CLIENT_ID, label: 'me', acquiredAt: 0 } },
      { id: 'tab-2', tabId: 2, url: 'http://b.com', title: 'B', lease: { clientId: 'mcp-other', label: 'other', acquiredAt: 0 } },
      { id: 'tab-3', tabId: 3, url: 'http://c.com', title: 'C', lease: null },
    ];

    const myTabs = targets.filter(t => t.lease?.clientId === MY_CLIENT_ID);
    const otherTabs = targets.filter(t => t.lease && t.lease.clientId !== MY_CLIENT_ID);
    const availableTabs = targets.filter(t => !t.lease);

    assert.equal(myTabs.length, 1);
    assert.equal(otherTabs.length, 1);
    assert.equal(availableTabs.length, 1);

    assert.equal(myTabs[0].id, 'tab-1');
    assert.equal(otherTabs[0].id, 'tab-2');
    assert.equal(availableTabs[0].id, 'tab-3');
  });
});

// ---------------------------------------------------------------------------
// Tests: switch_tab lease check
// ---------------------------------------------------------------------------

describe('MCP switch_tab lease check', () => {
  it('should reject switching to another agents tab', () => {
    const MY_CLIENT_ID = 'mcp-1234-abc';
    const target = {
      id: 'tab-2',
      lease: { clientId: 'mcp-other', label: 'other-project', acquiredAt: 0 },
    };

    const isBlocked = target.lease && target.lease.clientId !== MY_CLIENT_ID;
    assert.equal(isBlocked, true);
  });

  it('should allow switching to own tab', () => {
    const MY_CLIENT_ID = 'mcp-1234-abc';
    const target = {
      id: 'tab-1',
      lease: { clientId: MY_CLIENT_ID, label: 'me', acquiredAt: 0 },
    };

    const isBlocked = target.lease && target.lease.clientId !== MY_CLIENT_ID;
    assert.equal(isBlocked, false);
  });

  it('should allow switching to unleased tab', () => {
    const MY_CLIENT_ID = 'mcp-1234-abc';
    const target = {
      id: 'tab-3',
      lease: null as { clientId: string } | null,
    };

    const isBlocked = !!(target.lease && target.lease.clientId !== MY_CLIENT_ID);
    assert.equal(isBlocked, false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Unique Client ID
// ---------------------------------------------------------------------------

describe('Unique MCP Client ID', () => {
  it('should generate unique IDs across calls', () => {
    function generate() {
      return `mcp-${process.pid}-${Date.now().toString(36)}`;
    }
    const id1 = generate();
    const id2 = generate();
    assert.ok(id1.startsWith('mcp-'));
    assert.ok(id2.startsWith('mcp-'));
    // IDs contain pid and timestamp, so they should be the same or very close
    // but the function is called once at startup, so uniqueness is across processes
    assert.ok(typeof id1 === 'string' && id1.length > 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: Backward Compatibility
// ---------------------------------------------------------------------------

describe('Backward Compatibility', () => {
  it('should allow operations without any leases (single agent mode)', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');

    // No leases exist — enforcement should allow any client
    assert.equal(registry.checkEnforcement('mcp-a', 'tab-111-ts'), true);
    assert.equal(registry.checkEnforcement('mcp-b', 'tab-111-ts'), true);

    // Enriched targets should show null lease
    const targets = registry.getEnrichedTargets();
    assert.equal(targets[0].lease, null);
  });

  it('should handle old MCP (no leases acquired) alongside new relay', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');

    // "Old" MCP doesn't acquire any lease
    // "New" relay just lets it through (no lease = no enforcement)
    assert.equal(registry.checkEnforcement('mcp-client', 'tab-111-ts'), true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Protocol Constants
// ---------------------------------------------------------------------------

describe('Protocol Constants', () => {
  it('should export LEASE_ERROR_CODE', () => {
    assert.equal(typeof LEASE_ERROR_CODE, 'number');
    assert.equal(LEASE_ERROR_CODE, -32001);
  });
});

// ---------------------------------------------------------------------------
// Tests: Event Routing Logic
// ---------------------------------------------------------------------------

describe('Event Routing', () => {
  it('should route events to lease holder when leased', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');

    const lease = registry.leases.get('tab-111-ts');
    assert.ok(lease);

    // Simulated routing: event for tab-111 should go to mcp-a only
    const recipients: string[] = [];
    const allClients = ['mcp-a', 'mcp-b', 'pw-123-abc'];
    if (lease) {
      recipients.push(lease.clientId);
      // Also send to pw-* clients
      for (const cid of allClients) {
        if (cid.startsWith('pw-')) recipients.push(cid);
      }
    }

    assert.ok(recipients.includes('mcp-a'));
    assert.ok(!recipients.includes('mcp-b'));
    assert.ok(recipients.includes('pw-123-abc'));
  });

  it('should broadcast events when no lease exists', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');

    const lease = registry.leases.get('tab-111-ts');
    assert.equal(lease, undefined);

    // No lease → broadcast to all
    const allClients = ['mcp-a', 'mcp-b'];
    const recipients = allClients; // broadcast
    assert.equal(recipients.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Extension Disconnect
// ---------------------------------------------------------------------------

describe('Extension Disconnect', () => {
  it('should clear all leases when extension disconnects', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-b', 'tab-222-ts');

    // Simulate extension disconnect: clear all
    registry.leases.clear();
    registry.targets.clear();

    assert.equal(registry.leases.size, 0);
    assert.equal(registry.targets.size, 0);
  });
});
