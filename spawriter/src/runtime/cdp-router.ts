/**
 * CDP event router — deterministic target-aware event dispatch.
 *
 * §5.2 of the stability plan. Pure logic: receives events, resolves
 * destinations, and returns a list of (clientId, payload) pairs.
 * No network I/O — the caller is responsible for actual sends.
 */

import type { SessionId, SessionRegistry } from './session-registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteDestination {
  clientId: string;
  sessionId: string;
  payload: CdpEventPayload;
}

export interface CdpEventPayload {
  method: string;
  params: unknown;
  sessionId?: string;
}

/** Events that should never be dropped by the router (protocol-critical). */
export const ROUTER_CRITICAL_EVENTS = new Set([
  'Target.targetCreated',
  'Target.targetDestroyed',
  'Target.targetInfoChanged',
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Target.targetCrashed',
  'Inspector.targetCrashed',
  'Inspector.targetReloadedAfterCrash',
  'Page.frameAttached',
  'Page.frameDetached',
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Page.lifecycleEvent',
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed',
  'Page.fileChooserOpened',
  'Page.downloadWillBegin',
  'Page.downloadProgress',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Runtime.exceptionThrown',
  'Runtime.bindingCalled',
  'Fetch.requestPaused',
  'Fetch.authRequired',
]);

/** Events dropped before routing (high-frequency noise). */
export const DROPPED_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
]);

// ─── Client registry ─────────────────────────────────────────────────────────

export interface ConnectedClient {
  id: string;
  sessionId: SessionId;
  /** CDP sessions this client has subscribed/attached to. */
  subscribedSessions: Set<string>;
  /** Is this a Playwright client (prefix pw-)? */
  isPlaywright: boolean;
  /** Is the client connection open? */
  isOpen: () => boolean;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export interface CdpRouterConfig {
  /** Maximum events per second per client before sampling. */
  maxEventsPerSecondPerClient?: number;
}

/**
 * Stateless CDP event routing.
 *
 * The router receives an event and a set of connected clients, and returns
 * the list of (client, payload) pairs to send. It does NOT send anything
 * itself, keeping it fully testable without network.
 */
export class CdpRouter {
  private readonly _maxPerSec: number;

  /** Per-client event counter for rate awareness. */
  private _clientEventCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(config: CdpRouterConfig = {}) {
    this._maxPerSec = config.maxEventsPerSecondPerClient ?? 2000;
  }

  /**
   * Route an event from the extension to connected clients.
   *
   * @param method - CDP method name.
   * @param params - CDP event parameters.
   * @param physicalSessionId - The real CDP sessionId from the extension.
   * @param clients - Currently connected clients.
   * @param resolveTabId - Maps sessionId → tabId (or undefined).
   * @param resolveOwner - Maps tabId → owning sessionId (or undefined).
   * @param resolveVirtualSessions - Maps (realSessionId, clientId) → virtual session IDs.
   * @returns List of destinations to deliver to.
   */
  route(
    method: string,
    params: unknown,
    physicalSessionId: string | undefined,
    clients: Iterable<ConnectedClient>,
    resolveTabId: (sessionId: string) => number | undefined,
    resolveOwner: (tabId: number) => SessionId | undefined,
    resolveVirtualSessions: (realSessionId: string, clientId: string) => string[],
  ): RouteDestination[] {
    // Drop known noise.
    if (method && DROPPED_EVENTS.has(method)) return [];

    const destinations: RouteDestination[] = [];
    const sent = new Set<string>(); // dedup key: `${clientId}:${destinationSessionId}`

    if (!physicalSessionId) {
      // Browser-level event: broadcast to all open clients.
      for (const client of clients) {
        if (!client.isOpen()) continue;
        const key = `${client.id}:browser`;
        if (sent.has(key)) continue;
        sent.add(key);
        destinations.push({
          clientId: client.id,
          sessionId: client.sessionId,
          payload: { method, params },
        });
      }
      return destinations;
    }

    // Resolve physical target ownership.
    const tabId = resolveTabId(physicalSessionId);
    const ownerSessionId = tabId != null ? resolveOwner(tabId) : undefined;

    for (const client of clients) {
      if (!client.isOpen()) continue;

      // Check ownership: only send to the owning session's clients
      // (or broadcast non-owned target events to pw- clients for discovery).
      const isOwner = ownerSessionId === client.sessionId;
      const isDiscovery = !ownerSessionId && client.isPlaywright;

      if (!isOwner && !isDiscovery) continue;

      // Send on the real session ID.
      const realKey = `${client.id}:${physicalSessionId}`;
      if (!sent.has(realKey)) {
        sent.add(realKey);
        destinations.push({
          clientId: client.id,
          sessionId: client.sessionId,
          payload: { method, params, sessionId: physicalSessionId },
        });
      }

      // Send on virtual session IDs.
      const virtualIds = resolveVirtualSessions(physicalSessionId, client.id);
      for (const vid of virtualIds) {
        const vKey = `${client.id}:${vid}`;
        if (sent.has(vKey)) continue;
        sent.add(vKey);
        destinations.push({
          clientId: client.id,
          sessionId: client.sessionId,
          payload: { method, params, sessionId: vid },
        });
      }
    }

    return destinations;
  }

  /**
   * Track an event delivery for rate monitoring.
   */
  recordDelivery(clientId: string, nowMs: number = Date.now()): void {
    let counter = this._clientEventCounts.get(clientId);
    if (!counter || nowMs - counter.windowStart > 1000) {
      counter = { count: 0, windowStart: nowMs };
      this._clientEventCounts.set(clientId, counter);
    }
    counter.count++;
  }

  /**
   * Check if a client is over the rate threshold.
   */
  isClientOverRate(clientId: string, nowMs: number = Date.now()): boolean {
    const counter = this._clientEventCounts.get(clientId);
    if (!counter) return false;
    if (nowMs - counter.windowStart > 1000) return false;
    return counter.count >= this._maxPerSec;
  }

  /**
   * Reset rate counters (e.g., on client disconnect).
   */
  resetClient(clientId: string): void {
    this._clientEventCounts.delete(clientId);
  }
}
