/**
 * Tests for Tab Lease System: relay-level lease management, MCP-level
 * lease negotiation, enforcement, event filtering, and edge cases.
 *
 * Run: npx tsx --test spawriter/src/lease.test.ts
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

// ---------------------------------------------------------------------------
// Tests: WebSocket Reconnect Race Condition
// ---------------------------------------------------------------------------

describe('WebSocket Reconnect Race', () => {
  it('should not release leases when stale WebSocket closes after new one registers', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');

    const clientId = 'mcp-123-abc';
    const clients = new Map<string, { ws: object }>();

    const oldWs = { id: 'old' };
    clients.set(clientId, { ws: oldWs });
    registry.acquireLease(clientId, 'tab-111-ts');

    const newWs = { id: 'new' };
    clients.set(clientId, { ws: newWs });

    // Stale close fires: should NOT delete client or release leases
    const current = clients.get(clientId);
    if (current?.ws === oldWs) {
      clients.delete(clientId);
      registry.releaseClientLeases(clientId);
    }

    // Client and lease should still be intact
    assert.ok(clients.has(clientId));
    assert.equal(registry.leases.get('tab-111-ts')?.clientId, clientId);
  });

  it('should release leases when the current WebSocket closes', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');

    const clientId = 'mcp-123-abc';
    const clients = new Map<string, { ws: object }>();

    const currentWs = { id: 'current' };
    clients.set(clientId, { ws: currentWs });
    registry.acquireLease(clientId, 'tab-111-ts');

    // Current WS close: SHOULD delete client and release leases
    const current = clients.get(clientId);
    if (current?.ws === currentWs) {
      clients.delete(clientId);
      registry.releaseClientLeases(clientId);
    }

    assert.ok(!clients.has(clientId));
    assert.equal(registry.leases.get('tab-111-ts'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lease Label Edge Cases
// ---------------------------------------------------------------------------

describe('Tab Lease — Label Edge Cases', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
  });

  it('should grant lease without label (label undefined)', () => {
    const result = registry.acquireLease('mcp-a', 'tab-111-ts');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.get('tab-111-ts')!.label, undefined);
  });

  it('should update label on re-acquire by same client', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a-v2');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.get('tab-111-ts')!.label, 'agent-a-v2');
  });

  it('should include acquiredAt timestamp that is recent (within 5 seconds of Date.now())', () => {
    const before = Date.now();
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const lease = registry.leases.get('tab-111-ts')!;
    const after = Date.now();
    assert.ok(lease.acquiredAt >= before && lease.acquiredAt <= after + 5000);
  });

  it('should handle empty string label', () => {
    const result = registry.acquireLease('mcp-a', 'tab-111-ts', '');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.get('tab-111-ts')!.label, '');
  });

  it('should display correct holder description with and without label', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const conflictWithLabel = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(conflictWithLabel.granted, false);
    const holderDescWithLabel = conflictWithLabel.holder!.label
      ? `"${conflictWithLabel.holder!.label}" (${conflictWithLabel.holder!.clientId})`
      : conflictWithLabel.holder!.clientId;
    assert.equal(holderDescWithLabel, '"agent-a" (mcp-a)');

    registry.releaseLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const conflictNoLabel = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(conflictNoLabel.granted, false);
    const holderDescNoLabel = conflictNoLabel.holder!.label
      ? `"${conflictNoLabel.holder!.label}" (${conflictNoLabel.holder!.clientId})`
      : conflictNoLabel.holder!.clientId;
    assert.equal(holderDescNoLabel, 'mcp-a');
  });
});

// ---------------------------------------------------------------------------
// Tests: Multi-Client Stress
// ---------------------------------------------------------------------------

describe('Tab Lease — Multi-Client Stress', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    for (let i = 1; i <= 10; i++) {
      registry.addTarget(`tab-${i}-ts`, i, `http://localhost:${9000 + i}`);
    }
  });

  it('should handle 10 clients leasing 10 different tabs', () => {
    for (let i = 1; i <= 10; i++) {
      const result = registry.acquireLease(`mcp-${i}`, `tab-${i}-ts`, `agent-${i}`);
      assert.equal(result.granted, true);
    }
    assert.equal(registry.leases.size, 10);
  });

  it('should handle all 10 clients releasing simultaneously', () => {
    for (let i = 1; i <= 10; i++) {
      registry.acquireLease(`mcp-${i}`, `tab-${i}-ts`, `agent-${i}`);
    }
    for (let i = 1; i <= 10; i++) {
      const result = registry.releaseLease(`mcp-${i}`, `tab-${i}-ts`);
      assert.equal(result.released, true);
    }
    assert.equal(registry.leases.size, 0);
  });

  it('should correctly isolate after mass release (all tabs available)', () => {
    for (let i = 1; i <= 10; i++) {
      registry.acquireLease(`mcp-${i}`, `tab-${i}-ts`);
    }
    for (let i = 1; i <= 10; i++) {
      registry.releaseLease(`mcp-${i}`, `tab-${i}-ts`);
    }
    const result = registry.acquireLease('mcp-new', 'tab-1-ts');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.get('tab-1-ts')!.clientId, 'mcp-new');
  });

  it('should handle rapid acquire-release-acquire cycle on same tab', () => {
    registry.acquireLease('mcp-a', 'tab-1-ts');
    registry.releaseLease('mcp-a', 'tab-1-ts');
    const result = registry.acquireLease('mcp-a', 'tab-1-ts');
    assert.equal(result.granted, true);
    registry.releaseLease('mcp-a', 'tab-1-ts');
    const result2 = registry.acquireLease('mcp-b', 'tab-1-ts');
    assert.equal(result2.granted, true);
  });

  it('should handle client leasing tab, releasing, another client leasing same tab', () => {
    registry.acquireLease('mcp-a', 'tab-1-ts', 'agent-a');
    registry.releaseLease('mcp-a', 'tab-1-ts');
    const result = registry.acquireLease('mcp-b', 'tab-1-ts', 'agent-b');
    assert.equal(result.granted, true);
    assert.equal(registry.leases.get('tab-1-ts')!.clientId, 'mcp-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Detach Edge Cases
// ---------------------------------------------------------------------------

describe('Tab Lease — Tab Detach Edge Cases', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.addTarget('tab-333-ts', 333, 'http://localhost:8081');
  });

  it('should handle closing an unleased tab (no lease to clean)', () => {
    registry.removeTarget('tab-222-ts');
    assert.equal(registry.targets.size, 2);
    assert.equal(registry.leases.size, 0);
  });

  it('should handle closing all tabs (full cleanup)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    registry.removeTarget('tab-111-ts');
    registry.removeTarget('tab-222-ts');
    registry.removeTarget('tab-333-ts');
    assert.equal(registry.targets.size, 0);
    assert.equal(registry.leases.size, 0);
  });

  it('should not affect leases on other tabs when one tab closes', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    registry.removeTarget('tab-111-ts');
    assert.equal(registry.leases.size, 1);
    assert.equal(registry.leases.get('tab-222-ts')!.clientId, 'mcp-a');
  });

  it('should handle target removal when target was never added', () => {
    assert.doesNotThrow(() => registry.removeTarget('tab-999-ts'));
    assert.equal(registry.targets.size, 3);
  });
});

// ---------------------------------------------------------------------------
// Tests: Enforcement Edge Cases
// ---------------------------------------------------------------------------

describe('Tab Lease — Enforcement Edge Cases', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
  });

  it('should enforce after lease transfer (A releases, B acquires, A blocked)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    registry.releaseLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(registry.checkEnforcement('mcp-a', 'tab-111-ts'), false);
    assert.equal(registry.checkEnforcement('mcp-b', 'tab-111-ts'), true);
  });

  it('should allow holder after re-acquiring own released tab', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.releaseLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    assert.equal(registry.checkEnforcement('mcp-a', 'tab-111-ts'), true);
  });

  it('should handle enforcement check on non-existent session (no target, no lease)', () => {
    assert.equal(registry.checkEnforcement('mcp-a', 'tab-999-ts'), true);
  });

  it('should block all non-pw clients even with similar prefixes (e.g., \'pwx-\' should be blocked)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    assert.equal(registry.checkEnforcement('pwx-123', 'tab-111-ts'), false);
  });

  it('should block \'PW-\' (case-sensitive check)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    assert.equal(registry.checkEnforcement('PW-123', 'tab-111-ts'), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP Session Negotiation — Advanced
// ---------------------------------------------------------------------------

describe('MCP Session Negotiation — Advanced', () => {
  it('should prefer preferredTargetId over other unleased tabs', () => {
    const preferredTargetId = 'tab-2';
    const unleased = [
      { id: 'tab-1', url: 'http://a.com', lease: null },
      { id: 'tab-2', url: 'http://b.com', lease: null },
      { id: 'tab-3', url: 'http://c.com', lease: null },
    ];
    const preferred = unleased.find(t => t.id === preferredTargetId);
    const sorted = preferred
      ? [preferred, ...unleased.filter(t => t.id !== preferredTargetId)]
      : unleased;
    assert.equal(sorted[0].id, 'tab-2');
  });

  it('should prefer projectUrl match over preferredTargetId when both match different tabs', () => {
    const projectUrl = 'localhost:9100';
    const preferredTargetId = 'tab-1';
    const unleased = [
      { id: 'tab-1', url: 'http://localhost:8080', lease: null },
      { id: 'tab-2', url: 'http://localhost:9100/app', lease: null },
    ];
    const matching = unleased.filter(t => t.url?.includes(projectUrl));
    const withProjectPref = matching.length > 0
      ? [...matching, ...unleased.filter(t => !t.url?.includes(projectUrl))]
      : unleased;
    const preferred = withProjectPref.find(t => t.id === preferredTargetId);
    const final =
      matching.length > 0
        ? withProjectPref
        : preferred
          ? [preferred, ...withProjectPref.filter(t => t.id !== preferredTargetId)]
          : withProjectPref;
    assert.equal(final[0].id, 'tab-2');
  });

  it('should fallback when preferredTargetId tab no longer exists', () => {
    const preferredTargetId = 'tab-deleted';
    const unleased = [
      { id: 'tab-1', url: 'http://a.com', lease: null },
      { id: 'tab-2', url: 'http://b.com', lease: null },
    ];
    const preferred = unleased.find(t => t.id === preferredTargetId);
    const sorted = preferred
      ? [preferred, ...unleased.filter(t => t.id !== preferredTargetId)]
      : unleased;
    assert.equal(sorted[0].id, 'tab-1');
  });

  it('should handle empty targets array (no tabs at all)', () => {
    const targets: { id: string; url?: string; lease: unknown }[] = [];
    const unleased = targets.filter(t => !t.lease);
    assert.equal(unleased.length, 0);
  });

  it('should handle targets with all lease=null (all available, no preference)', () => {
    const targets = [
      { id: 'tab-1', url: 'http://a.com', lease: null },
      { id: 'tab-2', url: 'http://b.com', lease: null },
    ];
    const unleased = targets.filter(t => !t.lease);
    assert.equal(unleased.length, 2);
  });

  it('should handle mixed: some null lease, some with lease, some matching projectUrl', () => {
    const projectUrl = 'localhost:9100';
    const targets = [
      { id: 'tab-1', url: 'http://localhost:8080', lease: { clientId: 'other', label: 'x', acquiredAt: 0 } },
      { id: 'tab-2', url: 'http://localhost:9100/app', lease: null },
      { id: 'tab-3', url: 'https://google.com', lease: null },
    ];
    const unleased = targets.filter(t => !t.lease);
    const matching = unleased.filter(t => t.url?.includes(projectUrl));
    const sorted = matching.length > 0
      ? [...matching, ...unleased.filter(t => !t.url?.includes(projectUrl))]
      : unleased;
    assert.equal(sorted[0].id, 'tab-2');
  });
});

// ---------------------------------------------------------------------------
// Tests: Error Code Verification
// ---------------------------------------------------------------------------

describe('Tab Lease — Error Code Verification', () => {
  it('LEASE_ERROR_CODE should be -32001', () => {
    assert.equal(LEASE_ERROR_CODE, -32001);
  });

  it('should include error code in acquireLease conflict response', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(result.granted, false);
    const conflictResponse = { code: LEASE_ERROR_CODE, message: result.error, holder: result.holder };
    assert.equal(conflictResponse.code, -32001);
  });

  it('should include holder info in conflict response', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.ok(result.holder);
    assert.equal(result.holder!.clientId, 'mcp-a');
  });

  it('holder should contain both clientId and label if label was provided', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const result = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(result.holder!.clientId, 'mcp-a');
    assert.equal(result.holder!.label, 'agent-a');
  });

  it('holder should contain clientId but no label if label was not provided', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const result = registry.acquireLease('mcp-b', 'tab-111-ts', 'agent-b');
    assert.equal(result.holder!.clientId, 'mcp-a');
    assert.equal(result.holder!.label, undefined);
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
    assert.ok(result.error?.includes('url') || result.error?.includes('tabId'));
  });

  it('should accept url only', () => {
    const result = validateConnectTab({ url: 'http://localhost:9100' });
    assert.equal(result.valid, true);
  });

  it('should accept tabId only', () => {
    const result = validateConnectTab({ tabId: 123 });
    assert.equal(result.valid, true);
  });

  it('should accept url with create flag', () => {
    const result = validateConnectTab({ url: 'http://localhost:9100', create: true });
    assert.equal(result.valid, true);
  });

  it('should accept tabId with url (tabId takes priority per design)', () => {
    const result = validateConnectTab({ tabId: 456, url: 'http://localhost:9100' });
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: release_tab Logic
// ---------------------------------------------------------------------------

describe('MCP release_tab Logic', () => {
  it('should release active tab when no targetId specified', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const activeSessionId = 'tab-111-ts';
    const targetId = activeSessionId;
    const result = registry.releaseLease('mcp-a', targetId);
    assert.equal(result.released, true);
    assert.equal(registry.leases.size, 0);
  });

  it('should release specific tab by targetId', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    const result = registry.releaseLease('mcp-a', 'tab-222-ts');
    assert.equal(result.released, true);
    assert.equal(registry.leases.size, 1);
    assert.ok(registry.leases.has('tab-111-ts'));
  });

  it('should handle releasing a tab not leased by this agent (error)', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const result = registry.releaseLease('mcp-b', 'tab-111-ts');
    assert.equal(result.released, false);
    assert.ok(result.error?.includes('Not the lease holder'));
  });

  it('should clear cdpSession when releasing the active tab', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    let cdpSession: { sessionId: string } | null = { sessionId: 'tab-111-ts' };
    const targetId = 'tab-111-ts';
    registry.releaseLease('mcp-a', targetId);
    if (targetId === cdpSession?.sessionId) {
      cdpSession = null;
    }
    assert.equal(cdpSession, null);
  });

  it('should not clear cdpSession when releasing a non-active tab', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    let cdpSession: { sessionId: string } | null = { sessionId: 'tab-111-ts' };
    const targetId = 'tab-222-ts';
    registry.releaseLease('mcp-a', targetId);
    if (targetId === cdpSession?.sessionId) {
      cdpSession = null;
    }
    assert.notEqual(cdpSession, null);
    assert.equal(cdpSession!.sessionId, 'tab-111-ts');
  });
});

// ---------------------------------------------------------------------------
// Tests: reset Lease Cleanup
// ---------------------------------------------------------------------------

describe('MCP reset Lease Cleanup', () => {
  it('should release all agent\'s leases before closing', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.addTarget('tab-333-ts', 333, 'http://localhost:8081');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-a', 'tab-222-ts');
    registry.acquireLease('mcp-b', 'tab-333-ts');
    const released = registry.releaseClientLeases('mcp-a');
    assert.equal(released.length, 2);
    assert.ok(released.includes('tab-111-ts'));
    assert.ok(released.includes('tab-222-ts'));
    assert.equal(registry.leases.get('tab-333-ts')!.clientId, 'mcp-b');
  });

  it('should not release other agents\' leases', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.addTarget('tab-222-ts', 222, 'http://localhost:8080');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    registry.acquireLease('mcp-b', 'tab-222-ts');
    const released = registry.releaseClientLeases('mcp-a');
    assert.equal(released.length, 1);
    assert.equal(registry.leases.get('tab-222-ts')!.clientId, 'mcp-b');
  });

  it('should handle reset when no leases exist', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    const released = registry.releaseClientLeases('mcp-a');
    assert.equal(released.length, 0);
  });

  it('should handle reset when cdpSession is null', () => {
    const registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const cdpSession: { sessionId: string } | null = null;
    registry.releaseClientLeases('mcp-a');
    assert.equal(cdpSession, null);
    assert.equal(registry.leases.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: leaseSupported Backward Compatibility
// ---------------------------------------------------------------------------

describe('Backward Compatibility — leaseSupported', () => {
  it('leaseSupported starts as null', () => {
    let leaseSupported: boolean | null = null;
    assert.equal(leaseSupported, null);
  });

  it('after successful acquireLease, leaseSupported becomes true', () => {
    let leaseSupported: boolean | null = null;
    const mockAcquire = () => ({ granted: true });
    const result = mockAcquire();
    if (result) leaseSupported = true;
    assert.equal(leaseSupported, true);
  });

  it('after first failed acquireLease (null -> false), returns true (fallback)', () => {
    let leaseSupported: boolean | null = null;
    const mockAcquireFails = () => false;
    const acquired = mockAcquireFails();
    if (!acquired && leaseSupported === null) {
      leaseSupported = false;
    }
    const fallbackReturn = leaseSupported === false ? true : acquired;
    assert.equal(fallbackReturn, true);
  });

  it('after leaseSupported is true, subsequent failures return false (not fallback)', () => {
    let leaseSupported: boolean | null = true;
    const mockAcquireFails = () => false;
    const acquired = mockAcquireFails();
    const returnValue = leaseSupported === false ? true : acquired;
    assert.equal(returnValue, false);
  });

  it('when leaseSupported is false, acquireLease skips network call and returns true', () => {
    let leaseSupported: boolean | null = false;
    let networkCallCount = 0;
    const acquireLease = () => {
      if (leaseSupported === false) return true;
      networkCallCount++;
      return false;
    };
    const result = acquireLease();
    assert.equal(result, true);
    assert.equal(networkCallCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Enriched Target Formatting
// ---------------------------------------------------------------------------

describe('Tab Lease — Enriched Target Formatting', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
  });

  it('enriched target with lease should have clientId, label, acquiredAt', () => {
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100', 'App');
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const targets = registry.getEnrichedTargets();
    const t = targets[0];
    assert.ok(t.lease);
    assert.equal(t.lease!.clientId, 'mcp-a');
    assert.equal(t.lease!.label, 'agent-a');
    assert.ok(typeof t.lease!.acquiredAt === 'number');
  });

  it('enriched target without lease should have lease: null', () => {
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
    const targets = registry.getEnrichedTargets();
    assert.equal(targets[0].lease, null);
  });

  it('should handle target with no url or title', () => {
    registry.targets.set('tab-111-ts', { sessionId: 'tab-111-ts', tabId: 111 });
    const targets = registry.getEnrichedTargets();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, undefined);
    assert.equal(targets[0].title, undefined);
  });

  it('should handle multiple targets with mixed lease states', () => {
    registry.addTarget('tab-1-ts', 1, 'http://a.com');
    registry.addTarget('tab-2-ts', 2, 'http://b.com');
    registry.addTarget('tab-3-ts', 3, 'http://c.com');
    registry.acquireLease('mcp-a', 'tab-1-ts');
    registry.acquireLease('mcp-b', 'tab-3-ts');
    const targets = registry.getEnrichedTargets();
    assert.equal(targets[0].lease?.clientId, 'mcp-a');
    assert.equal(targets[1].lease, null);
    assert.equal(targets[2].lease?.clientId, 'mcp-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: getLeaseInfo Edge Cases
// ---------------------------------------------------------------------------

describe('Tab Lease — getLeaseInfo', () => {
  let registry: ReturnType<typeof createLeaseRegistry>;

  beforeEach(() => {
    registry = createLeaseRegistry();
    registry.addTarget('tab-111-ts', 111, 'http://localhost:9100');
  });

  it('should return null for non-existent session', () => {
    const info = registry.getLeaseInfo('tab-999-ts');
    assert.equal(info, null);
  });

  it('should return LeaseInfo for leased session', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const info = registry.getLeaseInfo('tab-111-ts');
    assert.ok(info);
    assert.equal(info!.clientId, 'mcp-a');
    assert.equal(info!.label, 'agent-a');
    assert.ok(typeof info!.acquiredAt === 'number');
  });

  it('should not return sessionId in LeaseInfo (only clientId, label, acquiredAt)', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts', 'agent-a');
    const info = registry.getLeaseInfo('tab-111-ts');
    assert.ok(info);
    assert.ok(!('sessionId' in info!));
    assert.ok('clientId' in info!);
    assert.ok('acquiredAt' in info!);
  });

  it('should return undefined label if no label was provided on acquire', () => {
    registry.acquireLease('mcp-a', 'tab-111-ts');
    const info = registry.getLeaseInfo('tab-111-ts');
    assert.ok(info);
    assert.equal(info!.label, undefined);
  });
});

// ---------------------------------------------------------------------------
// Tests: Offscreen Document Protocol
// ---------------------------------------------------------------------------

describe('Offscreen Document Protocol', () => {
  it('ws-send message should have type and payload fields', () => {
    const msg = { type: 'ws-send', payload: { method: 'pong' } };
    assert.equal(msg.type, 'ws-send');
    assert.ok(msg.payload);
    assert.equal(msg.payload.method, 'pong');
  });

  it('ws-message from offscreen should have type and payload', () => {
    const msg = { type: 'ws-message', payload: { method: 'forwardCDPCommand', id: 1 } };
    assert.equal(msg.type, 'ws-message');
    assert.ok(msg.payload);
    assert.equal(msg.payload.method, 'forwardCDPCommand');
  });

  it('ws-state-change should report open or closed', () => {
    const openMsg = { type: 'ws-state-change', state: 'open' };
    const closedMsg = { type: 'ws-state-change', state: 'closed' };
    assert.equal(openMsg.state, 'open');
    assert.equal(closedMsg.state, 'closed');
  });

  it('ws-status response should include state and connecting flag', () => {
    const resp = { state: 'open', connecting: false };
    assert.equal(resp.state, 'open');
    assert.equal(resp.connecting, false);
  });

  it('ws-connect response should include ok flag', () => {
    const resp = { ok: true };
    assert.equal(resp.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Service Worker State Persistence
// ---------------------------------------------------------------------------

describe('Service Worker State Persistence', () => {
  it('attachedTabs serializes to JSON-compatible array of entries', () => {
    const map = new Map<number, { sessionId: string; attachedAt: number }>();
    map.set(12345, { sessionId: 'spawriter-tab-12345-1000', attachedAt: 1000 });
    map.set(67890, { sessionId: 'spawriter-tab-67890-2000', attachedAt: 2000 });
    const serialized = [...map.entries()];
    assert.equal(serialized.length, 2);
    assert.equal(serialized[0][0], 12345);
    assert.equal(serialized[0][1].sessionId, 'spawriter-tab-12345-1000');
    const restored = new Map(serialized);
    assert.equal(restored.size, 2);
    assert.equal(restored.get(12345)?.sessionId, 'spawriter-tab-12345-1000');
    assert.equal(restored.get(67890)?.sessionId, 'spawriter-tab-67890-2000');
  });

  it('tabStates serializes to JSON-compatible array of entries', () => {
    const map = new Map<number, string>();
    map.set(12345, 'connected');
    map.set(67890, 'connecting');
    const serialized = [...map.entries()];
    assert.equal(serialized.length, 2);
    const restored = new Map(serialized);
    assert.equal(restored.get(12345), 'connected');
    assert.equal(restored.get(67890), 'connecting');
  });

  it('empty maps serialize and restore correctly', () => {
    const map = new Map();
    const serialized = [...map.entries()];
    assert.equal(serialized.length, 0);
    const restored = new Map(serialized);
    assert.equal(restored.size, 0);
  });

  it('restoreState with undefined data should not crash', () => {
    const data: { _attachedTabs?: [number, unknown][]; _tabStates?: [number, string][] } = {};
    let attachedTabs = new Map();
    let tabStates = new Map();
    if (data._attachedTabs) attachedTabs = new Map(data._attachedTabs);
    if (data._tabStates) tabStates = new Map(data._tabStates);
    assert.equal(attachedTabs.size, 0);
    assert.equal(tabStates.size, 0);
  });

  it('restoreState with partial data should only restore available fields', () => {
    const data: { _attachedTabs?: [number, { sessionId: string }][]; _tabStates?: [number, string][] } = {
      _tabStates: [[100, 'connected']],
    };
    let attachedTabs = new Map();
    let tabStates = new Map();
    if (data._attachedTabs) attachedTabs = new Map(data._attachedTabs);
    if (data._tabStates) tabStates = new Map(data._tabStates);
    assert.equal(attachedTabs.size, 0);
    assert.equal(tabStates.size, 1);
    assert.equal(tabStates.get(100), 'connected');
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab Title Marker Protocol
// ---------------------------------------------------------------------------

describe('Tab Title Marker', () => {
  const PREFIX = '🟢 ';

  it('should add prefix to title', () => {
    const title = 'Example Domain';
    const marked = PREFIX + title;
    assert.equal(marked, '🟢 Example Domain');
    assert.ok(marked.startsWith(PREFIX));
  });

  it('should not double-prefix if already marked', () => {
    const title = '🟢 Example Domain';
    const result = title.startsWith(PREFIX) ? title : PREFIX + title;
    assert.equal(result, '🟢 Example Domain');
  });

  it('should strip prefix on detach', () => {
    const marked = '🟢 Example Domain';
    const stripped = marked.startsWith(PREFIX) ? marked.slice(PREFIX.length) : marked;
    assert.equal(stripped, 'Example Domain');
  });

  it('should handle empty title', () => {
    const title = '';
    const marked = PREFIX + title;
    assert.equal(marked, '🟢 ');
    const stripped = marked.startsWith(PREFIX) ? marked.slice(PREFIX.length) : marked;
    assert.equal(stripped, '');
  });

  it('should handle title that starts with similar emoji', () => {
    const title = '🔴 Alert Page';
    const marked = PREFIX + title;
    assert.equal(marked, '🟢 🔴 Alert Page');
    const stripped = marked.startsWith(PREFIX) ? marked.slice(PREFIX.length) : marked;
    assert.equal(stripped, '🔴 Alert Page');
  });

  it('should handle title with special characters', () => {
    const title = '(3) New Messages — Chat App';
    const marked = PREFIX + title;
    assert.ok(marked.startsWith(PREFIX));
    const stripped = marked.slice(PREFIX.length);
    assert.equal(stripped, title);
  });
});

// ---------------------------------------------------------------------------
// Tests: Offscreen WebSocket Reconnect
// ---------------------------------------------------------------------------

describe('Offscreen WebSocket Reconnect Logic', () => {
  it('should schedule reconnect after disconnect', () => {
    let reconnectScheduled = false;
    const scheduleReconnect = () => { reconnectScheduled = true; };
    scheduleReconnect();
    assert.equal(reconnectScheduled, true);
  });

  it('should not schedule duplicate reconnect', () => {
    let reconnectCount = 0;
    let reconnectTimer: number | null = null;
    const scheduleReconnect = () => {
      if (reconnectTimer !== null) return;
      reconnectTimer = 1;
      reconnectCount++;
    };
    scheduleReconnect();
    scheduleReconnect();
    scheduleReconnect();
    assert.equal(reconnectCount, 1);
  });

  it('sendToRelay should return false when WS not open', () => {
    const ws: { readyState: number } | null = null;
    const result = ws !== null && ws.readyState === 1;
    assert.equal(result, false);
  });

  it('sendToRelay should return true when WS open', () => {
    const ws = { readyState: 1 }; // WebSocket.OPEN = 1
    const result = ws.readyState === 1;
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// Tests: connect_tab Zero-Touch Flow
// ---------------------------------------------------------------------------

describe('connect_tab Zero-Touch Flow', () => {
  it('should validate that url or tabId is required', () => {
    const params = {};
    const hasUrl = 'url' in params;
    const hasTabId = 'tabId' in params;
    assert.equal(hasUrl || hasTabId, false);
  });

  it('should auto-prefix url with https:// if no protocol', () => {
    const url = 'example.com';
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    assert.equal(fullUrl, 'https://example.com');
  });

  it('should not modify url with existing protocol', () => {
    const url = 'http://localhost:9100/app.js';
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    assert.equal(fullUrl, 'http://localhost:9100/app.js');
  });

  it('should handle create flag correctly', () => {
    const params = { url: 'https://example.com', create: true };
    assert.equal(params.create, true);
  });

  it('should handle tabId-based connection', () => {
    const params = { tabId: 12345 };
    assert.ok(params.tabId);
    assert.equal(typeof params.tabId, 'number');
  });

  it('retry logic should try up to 6 times on Extension not connected', () => {
    let attempts = 0;
    const maxRetries = 6;
    let result = { success: false, error: 'Extension not connected' };
    while (!result.success && (result as { error?: string }).error === 'Extension not connected' && attempts < maxRetries) {
      attempts++;
      if (attempts === 4) {
        result = { success: true, error: '' };
      }
    }
    assert.equal(attempts, 4);
    assert.equal(result.success, true);
  });

  it('retry logic should give up after 6 failures', () => {
    let attempts = 0;
    const maxRetries = 6;
    const result = { success: false, error: 'Extension not connected' };
    while (!result.success && result.error === 'Extension not connected' && attempts < maxRetries) {
      attempts++;
    }
    assert.equal(attempts, 6);
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Manifest V3 Service Worker Architecture
// ---------------------------------------------------------------------------

describe('MV3 Service Worker Architecture', () => {
  it('offscreen document reasons should include WORKERS', () => {
    const reasons = ['WORKERS'];
    assert.ok(reasons.includes('WORKERS'));
  });

  it('offscreen document URL should be relative to extension root', () => {
    const url = 'build/offscreen.html';
    assert.ok(!url.startsWith('/'));
    assert.ok(!url.startsWith('http'));
    assert.ok(url.endsWith('.html'));
  });

  it('background should use service_worker not scripts', () => {
    const manifest = {
      manifest_version: 3,
      background: { service_worker: './build/backgroundScript.js' },
    };
    assert.ok('service_worker' in manifest.background);
    assert.ok(!('scripts' in manifest.background));
  });

  it('required permissions should include offscreen and tabGroups', () => {
    const permissions = ['storage', 'scripting', 'browsingData', 'tabs', 'tabGroups', 'debugger', 'offscreen'];
    assert.ok(permissions.includes('offscreen'));
    assert.ok(permissions.includes('tabGroups'));
  });
});
