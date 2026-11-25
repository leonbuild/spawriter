/**
 * Session, Lease, and Target registry for the Spawriter relay.
 *
 * Separates Chrome tab, physical debugger generation, logical Session,
 * CDP client, and virtual CDP session. Prohibits ID mixups.
 *
 * §5.1/16.2 of the stability plan.
 */

import { monoNowMs } from './execution-context.js';

// ───── Types ─────

export type SessionId = string;
export type LeaseStatus = 'owned' | 'recovering' | 'quarantined' | 'released';
export type TargetHealthState = 'unverified' | 'healthy' | 'recovering' | 'quarantined' | 'closed';

export interface Lease {
  sessionId: SessionId;
  tabId: number;
  leaseEpoch: number;
  status: LeaseStatus;
  createdMono: number;
}

export interface PhysicalTarget {
  tabId: number;
  targetId: string;
  realSessionId: string;
  transportEpoch: string;
  attachmentEpoch: number;
  owner?: Lease;
  health: TargetHealthState;
  url?: string;
  title?: string;
}

export interface CdpClient {
  id: string;
  sessionId: SessionId;
  connectionEpoch: number;
  announced: Set<string>;
  createdMono: number;
}

export interface VirtualSession {
  id: string;
  clientId: string;
  parentVirtualBrowserId?: string;
  realSessionId: string;
  attachmentEpoch: number;
  leaseEpoch: number;
  kind: 'browser' | 'page';
}

export interface SessionState {
  id: SessionId;
  principalId: string;
  activeTabId: number | null;
  activeTargetId: string | null;
  leaseEpoch: number;
  revision: number;
  workerEpoch: number;
  executeEpoch: number;
  status: 'idle' | 'queued' | 'executing' | 'finishing' | 'recovering' | 'unhealthy' | 'disposing' | 'closed';
  createdMono: number;
  lastActivityMono: number;
  stateRevision: number;
}

// ───── Registry ─────

export class SessionRegistry {
  private sessions = new Map<SessionId, SessionState>();
  private physicalTargets = new Map<string, PhysicalTarget>(); // key: tabId-targetId
  private leases = new Map<string, Lease>(); // key: sessionId-tabId
  private clients = new Map<string, CdpClient>(); // key: clientId
  private virtualSessions = new Map<string, VirtualSession>(); // key: vsId
  private revision = 0;
  private readonly maxSessions: number;

  constructor(maxSessions: number = 64) {
    this.maxSessions = maxSessions;
  }

  // ───── Session lifecycle ─────

  createSession(sessionId: SessionId, principalId: string): SessionState {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions (${this.maxSessions}) reached`);
    }
    const now = monoNowMs();
    const session: SessionState = {
      id: sessionId,
      principalId,
      activeTabId: null,
      activeTargetId: null,
      leaseEpoch: 0,
      revision: ++this.revision,
      workerEpoch: 0,
      executeEpoch: 0,
      status: 'idle',
      createdMono: now,
      lastActivityMono: now,
      stateRevision: 0,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: SessionId): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  hasSession(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete a session. Requires no active tasks, leases already released.
   */
  deleteSession(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== 'idle' && session.status !== 'closed' && session.status !== 'unhealthy') {
      throw new Error(`Cannot delete session ${sessionId} in status ${session.status}`);
    }
    // Clean up associated virtual sessions
    for (const [vsId, vs] of this.virtualSessions) {
      if (this.clients.get(vs.clientId)?.sessionId === sessionId) {
        this.virtualSessions.delete(vsId);
      }
    }
    this.sessions.delete(sessionId);
    return true;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Advance the execute epoch for a session and return the new value.
   */
  nextExecuteEpoch(sessionId: SessionId): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.executeEpoch++;
    session.lastActivityMono = monoNowMs();
    session.revision = ++this.revision;
    return session.executeEpoch;
  }

  /**
   * Update session status.
   */
  setSessionStatus(sessionId: SessionId, status: SessionState['status']): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = status;
    session.lastActivityMono = monoNowMs();
    session.revision = ++this.revision;
  }

  // ───── Physical targets ─────

  private physicalKey(tabId: number, targetId: string): string {
    return `${tabId}-${targetId}`;
  }

  registerTarget(target: Omit<PhysicalTarget, 'health'>): PhysicalTarget {
    const key = this.physicalKey(target.tabId, target.targetId);
    const existing = this.physicalTargets.get(key);
    if (existing) {
      // Update existing target info
      existing.realSessionId = target.realSessionId;
      existing.transportEpoch = target.transportEpoch;
      existing.attachmentEpoch = target.attachmentEpoch;
      existing.url = target.url;
      existing.title = target.title;
      return existing;
    }
    const pt: PhysicalTarget = { ...target, health: 'unverified' };
    this.physicalTargets.set(key, pt);
    return pt;
  }

  getTarget(tabId: number, targetId: string): PhysicalTarget | undefined {
    return this.physicalTargets.get(this.physicalKey(tabId, targetId));
  }

  getTargetByTabId(tabId: number): PhysicalTarget | undefined {
    for (const target of this.physicalTargets.values()) {
      if (target.tabId === tabId) return target;
    }
    return undefined;
  }

  removeTarget(tabId: number, targetId: string): boolean {
    return this.physicalTargets.delete(this.physicalKey(tabId, targetId));
  }

  setTargetHealth(tabId: number, targetId: string, health: TargetHealthState): void {
    const target = this.physicalTargets.get(this.physicalKey(tabId, targetId));
    if (target) target.health = health;
  }

  get targetCount(): number {
    return this.physicalTargets.size;
  }

  // ───── Leases ─────

  private leaseKey(sessionId: SessionId, tabId: number): string {
    return `${sessionId}-${tabId}`;
  }

  /**
   * Create a lease for a session on a tab.
   * A physical target can only have one active owner.
   */
  createLease(sessionId: SessionId, tabId: number): Lease {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Check no other session owns this tab
    for (const lease of this.leases.values()) {
      if (lease.tabId === tabId && lease.sessionId !== sessionId && lease.status === 'owned') {
        throw new Error(`Tab ${tabId} is already owned by session ${lease.sessionId}`);
      }
    }

    session.leaseEpoch++;
    const lease: Lease = {
      sessionId,
      tabId,
      leaseEpoch: session.leaseEpoch,
      status: 'owned',
      createdMono: monoNowMs(),
    };
    this.leases.set(this.leaseKey(sessionId, tabId), lease);

    // Update physical target owner
    const target = this.getTargetByTabId(tabId);
    if (target) {
      target.owner = lease;
    }

    // Set as active if no active target
    if (session.activeTabId === null) {
      session.activeTabId = tabId;
      if (target) session.activeTargetId = target.targetId;
    }

    session.revision = ++this.revision;
    return lease;
  }

  getLease(sessionId: SessionId, tabId: number): Lease | undefined {
    return this.leases.get(this.leaseKey(sessionId, tabId));
  }

  releaseLease(sessionId: SessionId, tabId: number): boolean {
    const key = this.leaseKey(sessionId, tabId);
    const lease = this.leases.get(key);
    if (!lease) return false;
    lease.status = 'released';

    // Remove ownership from physical target
    const target = this.getTargetByTabId(tabId);
    if (target && target.owner?.sessionId === sessionId) {
      target.owner = undefined;
    }

    // Clear active if this was the active tab
    const session = this.sessions.get(sessionId);
    if (session && session.activeTabId === tabId) {
      session.activeTabId = null;
      session.activeTargetId = null;
    }

    this.leases.delete(key);
    if (session) session.revision = ++this.revision;
    return true;
  }

  // ───── Clients ─────

  registerClient(clientId: string, sessionId: SessionId): CdpClient {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const client: CdpClient = {
      id: clientId,
      sessionId,
      connectionEpoch: Date.now(),
      announced: new Set(),
      createdMono: monoNowMs(),
    };
    this.clients.set(clientId, client);
    return client;
  }

  getClient(clientId: string): CdpClient | undefined {
    return this.clients.get(clientId);
  }

  removeClient(clientId: string): boolean {
    // Clean up virtual sessions for this client
    for (const [vsId, vs] of this.virtualSessions) {
      if (vs.clientId === clientId) {
        this.virtualSessions.delete(vsId);
      }
    }
    return this.clients.delete(clientId);
  }

  // ───── Virtual sessions ─────

  registerVirtualSession(vs: VirtualSession): void {
    this.virtualSessions.set(vs.id, vs);
  }

  getVirtualSession(id: string): VirtualSession | undefined {
    return this.virtualSessions.get(id);
  }

  removeVirtualSession(id: string): boolean {
    return this.virtualSessions.delete(id);
  }

  /**
   * Find all virtual sessions owned by a specific client.
   */
  getVirtualSessionsByClient(clientId: string): VirtualSession[] {
    return Array.from(this.virtualSessions.values()).filter(
      (vs) => vs.clientId === clientId,
    );
  }

  get virtualSessionCount(): number {
    return this.virtualSessions.size;
  }

  // ───── Idle sweep ─────

  /**
   * Find sessions that are idle and have no active state.
   */
  getIdleSessions(maxIdleMs: number): SessionId[] {
    const now = monoNowMs();
    const result: SessionId[] = [];
    for (const session of this.sessions.values()) {
      if (
        session.status === 'idle' &&
        session.activeTabId === null &&
        now - session.lastActivityMono > maxIdleMs
      ) {
        result.push(session.id);
      }
    }
    return result;
  }

  // ───── Diagnostics ─────

  /**
   * Iterate all leases. Used by the relay bridge for ownership lookups.
   */
  *allLeases(): IterableIterator<Lease> {
    yield* this.leases.values();
  }

  diagnostics(): {
    sessions: number;
    targets: number;
    leases: number;
    clients: number;
    virtualSessions: number;
    revision: number;
  } {
    return {
      sessions: this.sessions.size,
      targets: this.physicalTargets.size,
      leases: this.leases.size,
      clients: this.clients.size,
      virtualSessions: this.virtualSessions.size,
      revision: this.revision,
    };
  }

  /**
   * Reset the entire registry. Used for testing and controlled recovery.
   */
  reset(): void {
    this.sessions.clear();
    this.physicalTargets.clear();
    this.leases.clear();
    this.clients.clear();
    this.virtualSessions.clear();
    this.revision = 0;
  }
}
