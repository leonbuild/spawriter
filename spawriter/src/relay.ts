import { Hono } from 'hono';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import http from 'http';
import { pathToFileURL } from 'node:url';
import {
  getRelayPort,
  getRelayToken,
  getCdpUrl,
  getAllowedExtensionIds,
  isLocalhost,
  log,
  error,
  enableFileLog,
  VERSION,
} from './utils.js';
import type {
  ExtensionEventMessage,
  ExtensionLogMessage,
  ExtensionMessage,
} from './protocol.js';
import { OWNERSHIP_ERROR_CODE } from './protocol.js';
import { ExecutorManager } from './pw-executor.js';

interface CDPClient {
  ws: WebSocket;
  /** sessionId → targetId already delivered to this client via Target.attachedToTarget.
   *  Playwright hard-asserts ("Duplicate target") on a second attach for a known
   *  targetId, so every announce path must consult and update this map. */
  announcedTargets: Map<string, string>;
}

interface PendingRequest {
  clientId: string;
  clientMessageId: number;
  sessionId?: string;
  timeoutId: ReturnType<typeof setTimeout>;
  method?: string;
  createdAt: number;
}

interface TargetInfo {
  targetId?: string;
  title?: string;
  url?: string;
  type?: string;
  tabId?: number;
  browserContextId?: string;
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

const app = new Hono();

interface ExtensionCmdPending {
  ws: WebSocket;
  timeoutId: ReturnType<typeof setTimeout>;
}

let extensionWs: WebSocket | null = null;
const cdpClients = new Map<string, CDPClient>();
const attachedTargets = new Map<string, AttachedTarget>();
let activeDownloadBehavior: DownloadBehavior | null = null;
const pendingRequests = new Map<number, PendingRequest>();
const pendingExtensionCmdRequests = new Map<number, ExtensionCmdPending>();
let nextExtensionRequestId = 1;
let relayProcessErrorHandlersInstalled = false;

export function isRecoverablePlaywrightDialogRace(reason: unknown): boolean {
  const text = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
    : String(reason);
  return text.includes('Page.handleJavaScriptDialog') && text.includes('No dialog is showing');
}

// Playwright's CRBrowser hard-asserts when its page registry sees an attach for
// a targetId it already knows (or similar registry corruption). That rejection
// fires inside playwright-core's event handler — no executor call site can catch
// it. It only poisons the in-process Playwright connections, never the relay's
// own state, so the correct blast radius is "reset the executors", not "kill
// the relay" (which would tear down the extension bridge and every CLI session).
export function isPlaywrightTargetRegistryAssert(reason: unknown): boolean {
  const text = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
    : String(reason);
  if (text.includes('Duplicate target ')) return true;
  return text.includes('Assertion error') && /[\\/]chromium[\\/]cr(?:Browser|Connection|ServiceWorker|Page)/.test(text);
}

function handleRecoverableProcessError(reason: unknown, origin: string): boolean {
  if (isRecoverablePlaywrightDialogRace(reason)) {
    error(`Recovered Playwright dialog race (${origin}):`, reason);
    return true;
  }
  if (isPlaywrightTargetRegistryAssert(reason)) {
    error(`Playwright target-registry assert (${origin}); resetting executors instead of exiting:`, reason);
    void relayExecutorManager.resetAll().catch((e) => {
      error('Executor reset after target-registry assert failed:', e);
    });
    return true;
  }
  return false;
}

function installRelayProcessErrorHandlers(): void {
  if (relayProcessErrorHandlersInstalled) return;
  relayProcessErrorHandlersInstalled = true;

  process.on('unhandledRejection', (reason) => {
    if (handleRecoverableProcessError(reason, 'unhandledRejection')) return;
    error('Unhandled rejection in relay, exiting:', reason);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });

  process.on('uncaughtException', (err, origin) => {
    if (handleRecoverableProcessError(err, origin)) return;
    error(`Uncaught exception in relay (${origin}), exiting:`, err);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
}

// ---------------------------------------------------------------------------
// Tab Ownership System — multi-agent tab isolation
// ---------------------------------------------------------------------------

const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
const sessionActivity = new Map<string, number>();
const sessionToClientId = new Map<string, string>();
const pwClientToSession = new Map<string, string>();

// ---------------------------------------------------------------------------
// Virtual CDP session multiplexing — enables newCDPSession() through relay
// ---------------------------------------------------------------------------
// When Playwright calls newCDPSession(page), it sends:
//   1. Target.attachToBrowserTarget → returns virtual browser session
//   2. Target.attachToTarget via that browser session → returns virtual page session
// Commands on virtual page sessions are translated to real session IDs.
// Events for real sessions are duplicated to all mapped virtual sessions.

const virtualBrowserSessions = new Set<string>();
const virtualToRealSession = new Map<string, string>();
const realToVirtualSessions = new Map<string, Set<string>>();
let virtualSessionCounter = 0;

function claimTab(tabId: number, sessionId: string, force?: boolean): { ok: boolean; owner?: string } {
  const existing = tabOwners.get(tabId);
  if (existing && existing.sessionId !== sessionId) {
    if (!force) return { ok: false, owner: existing.sessionId };
    broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'force-takeover', previousOwner: existing.sessionId });
  }
  tabOwners.set(tabId, { sessionId, claimedAt: Date.now() });
  sessionActivity.set(sessionId, Date.now());
  broadcastOwnershipEvent('Target.tabClaimed', { tabId, sessionId, claimedAt: Date.now() });
  sendOwnershipSnapshotToExtension('claim');
  return { ok: true };
}

function touchClaim(tabId: number, sessionId: string): void {
  const existing = tabOwners.get(tabId);
  if (!existing || existing.sessionId !== sessionId) return;
  sessionActivity.set(sessionId, Date.now());
}

function releaseTab(tabId: number, sessionId: string): boolean {
  const existing = tabOwners.get(tabId);
  if (!existing || existing.sessionId !== sessionId) return false;
  tabOwners.delete(tabId);
  broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'explicit-release' });
  sendOwnershipSnapshotToExtension('release');
  return true;
}

function releaseAllTabs(sessionId: string): number {
  const toRelease: number[] = [];
  for (const [tabId, owner] of tabOwners) {
    if (owner.sessionId === sessionId) toRelease.push(tabId);
  }
  for (const tabId of toRelease) {
    tabOwners.delete(tabId);
    broadcastOwnershipEvent('Target.tabReleased', { tabId, reason: 'session-cleanup' });
  }
  if (toRelease.length > 0) sendOwnershipSnapshotToExtension('session-cleanup');
  return toRelease.length;
}

function getOwnedTabs(sessionId: string): number[] {
  return [...tabOwners.entries()]
    .filter(([, o]) => o.sessionId === sessionId)
    .map(([tabId]) => tabId);
}

function getTabOwner(tabId: number): string | undefined {
  return tabOwners.get(tabId)?.sessionId;
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

// Blue-dot (attached, unowned) tabs are agent territory: every one of them
// is reusable, including tabs the user attached and navigated on purpose to
// hand a page to an agent. Undotted tabs are never visible here. Acquisition
// order: own green tab -> any blue-dot tab -> create new. Within blue dots,
// an exact URL match for the agent's destination wins, then the most
// recently attached.
function pickReusableAttachedTab(preferredUrlHint?: string): { tabId: number; url: string; reason: string } | null {
  const candidates: Array<{ tabId: number; url: string }> = [];
  for (const target of attachedTargets.values()) {
    if (target.tabId == null) continue;
    if (getTabOwner(target.tabId)) continue;
    candidates.push({ tabId: target.tabId, url: target.targetInfo?.url || '' });
  }
  if (candidates.length === 0) return null;

  // Map preserves insertion order; newest attached first.
  candidates.reverse();

  if (preferredUrlHint) {
    const matched = candidates.find(c => urlMatchesHint(c.url, preferredUrlHint));
    if (matched) return { tabId: matched.tabId, url: matched.url, reason: 'url-match' };
  }
  return { tabId: candidates[0].tabId, url: candidates[0].url, reason: 'idle' };
}

function resolveTabIdFromSession(cdpSessionId: string): number | undefined {
  return attachedTargets.get(cdpSessionId)?.tabId ?? undefined;
}

function sendOwnershipSnapshotToExtension(reason: string): void {
  if (extensionWs?.readyState !== WebSocket.OPEN) return;
  const ownership = [...tabOwners.entries()].map(([tabId, o]) => ({
    tabId,
    sessionId: o.sessionId,
    claimedAt: o.claimedAt,
  }));
  sendToExtension({
    method: 'Target.ownershipSnapshot',
    params: { reason, ownership },
  });
}

function broadcastOwnershipEvent(method: string, params: Record<string, unknown>): void {
  broadcastToCDPClients({ method, params });
}

const DEFAULT_STALE_TTL = 30 * 60 * 1000;
const STALE_SESSION_TTL = (() => {
  const raw = process.env.SPAWRITER_CLAIM_TTL_MS;
  const val = Number(raw);
  return Number.isFinite(val) && val >= 0 ? val : DEFAULT_STALE_TTL;
})();
const SWEEP_INTERVAL = STALE_SESSION_TTL > 0
  ? Math.min(Math.max(10000, Math.floor(STALE_SESSION_TTL / 2)), 60000)
  : 0;

function startStaleSweep(): void {
  if (SWEEP_INTERVAL <= 0) return;
  // unref: the sweep must never keep the process alive on its own
  // (e.g. when this module is imported without starting the server).
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastActive] of sessionActivity) {
      if (now - lastActive > STALE_SESSION_TTL) {
        const count = releaseAllTabs(sessionId);
        if (count > 0) log(`Stale session ${sessionId}: released ${count} tab(s)`);
        sessionActivity.delete(sessionId);
        sessionToClientId.delete(sessionId);
        for (const [pwId, sid] of pwClientToSession) {
          if (sid === sessionId) pwClientToSession.delete(pwId);
        }
        relayExecutorManager.remove(sessionId);
      }
    }
    for (const [sessionId, lastActive] of sessionActivity) {
      if (getOwnedTabs(sessionId).length === 0 && now - lastActive > STALE_SESSION_TTL) {
        sessionActivity.delete(sessionId);
        sessionToClientId.delete(sessionId);
      }
    }
  }, SWEEP_INTERVAL).unref();
}

const ALLOWED_EXTENSION_IDS = getAllowedExtensionIds();
const ALLOW_ANY_EXTENSION = ALLOWED_EXTENSION_IDS.length === 0;


app.get('/', (c) => {
  return c.text('OK');
});

app.post('/connect-tab', async (c) => {
  if (!isExtensionConnected()) {
    return c.json({ success: false, error: 'Extension not connected' }, 503);
  }

  const body: { url?: string; tabId?: number; create?: boolean; forceCreate?: boolean } =
    await c.req.json<{ url?: string; tabId?: number; create?: boolean; forceCreate?: boolean }>().catch(() => ({}));

  // Idle reuse is decided here, against the authoritative attachedTargets /
  // tabOwners state. The extension never scans the user's open tabs (S9).
  if (body.url && body.tabId === undefined && !body.forceCreate) {
    const reusable = pickReusableAttachedTab(body.url);
    if (reusable) {
      log(`/connect-tab: reusing idle tab ${reusable.tabId} (${reusable.reason}) for "${body.url}"`);
      return c.json({ success: true, tabId: reusable.tabId, reused: true });
    }
  }

  return new Promise<Response>((resolve) => {
    const relayId = nextExtensionRequestId++;
    const timeoutId = setTimeout(() => {
      pendingExtensionCmdRequests.delete(relayId);
      resolve(c.json({ success: false, error: 'Timeout waiting for extension' }, 504));
    }, 15000);

    const mockWs = {
      send(data: string) {
        clearTimeout(timeoutId);
        pendingExtensionCmdRequests.delete(relayId);
        try {
          resolve(c.json(JSON.parse(data)));
        } catch {
          resolve(c.json({ success: false, error: 'Invalid response' }, 500));
        }
      },
      readyState: 1,
    } as unknown as WebSocket;

    pendingExtensionCmdRequests.set(relayId, { ws: mockWs, timeoutId });

    sendToExtension({
      id: relayId,
      method: 'connectTabByMatch',
      params: body,
    });
  });
});

app.post('/trace', async (c) => {
  if (!isExtensionConnected()) {
    return c.json({ error: 'Extension not connected' }, 503);
  }

  const body = await c.req.json<{ action: string }>().catch(() => ({ action: '' }));

  return new Promise<Response>((resolve) => {
    const relayId = nextExtensionRequestId++;
    const timeoutId = setTimeout(() => {
      pendingExtensionCmdRequests.delete(relayId);
      resolve(c.json({ error: 'Timeout waiting for extension' }, 504));
    }, 15000);

    const mockWs = {
      send(data: string) {
        clearTimeout(timeoutId);
        pendingExtensionCmdRequests.delete(relayId);
        try {
          resolve(c.json(JSON.parse(data)));
        } catch {
          resolve(c.json({ error: 'Invalid response' }, 500));
        }
      },
      readyState: 1,
    } as unknown as WebSocket;

    pendingExtensionCmdRequests.set(relayId, { ws: mockWs, timeoutId });

    sendToExtension({
      id: relayId,
      method: 'trace',
      params: body,
    });
  });
});

app.get('/version', (c) => {
  return c.json({ version: VERSION });
});

app.post('/shutdown', (c) => {
  log('Shutdown requested via /shutdown endpoint');
  setTimeout(() => process.exit(0), 100);
  return c.json({ ok: true });
});

app.get('/json/version', (c) => {
  const port = getRelayPort();
  return c.json({
    Browser: `spawriter/${VERSION}`,
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: getCdpUrl(port),
  });
});

app.get('/json/list', (c) => {
  const targets = Array.from(attachedTargets.values()).map((target) => {
    const targetInfo = target.targetInfo ?? {};
    return {
      id: target.sessionId,
      targetId: buildTargetInfo(target).targetId,
      tabId: target.tabId,
      type: targetInfo.type ?? 'page',
      title: targetInfo.title ?? '',
      url: targetInfo.url ?? '',
      webSocketDebuggerUrl: getCdpUrl(getRelayPort(), target.sessionId),
      owner: target.tabId != null ? (getTabOwner(target.tabId) ?? null) : null,
    };
  });
  return c.json(targets);
});

function sendExtensionCommand(method: string, params?: Record<string, unknown>, timeoutMs = 10000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!isExtensionConnected()) {
      reject(new Error('Extension not connected'));
      return;
    }
    const relayId = nextExtensionRequestId++;
    const timeoutId = setTimeout(() => {
      pendingExtensionCmdRequests.delete(relayId);
      reject(new Error(`Extension command ${method} timed out`));
    }, timeoutMs);

    const mockWs = {
      send(data: string) {
        clearTimeout(timeoutId);
        pendingExtensionCmdRequests.delete(relayId);
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response from extension')); }
      },
      readyState: 1,
    } as unknown as WebSocket;

    pendingExtensionCmdRequests.set(relayId, { ws: mockWs, timeoutId });
    sendToExtension({ id: relayId, method, params });
  });
}

function sendToExtension(message: unknown): void {
  if (extensionWs?.readyState === WebSocket.OPEN) {
    extensionWs.send(JSON.stringify(message));
  } else {
    error('Extension WebSocket not connected, cannot send message');
  }
}

// sendOwnershipSnapshotToExtension is defined above with the ownership system

function isExtensionConnected(): boolean {
  return extensionWs?.readyState === WebSocket.OPEN;
}

function sendToCDPClient(clientId: string, message: unknown): void {
  const client = cdpClients.get(clientId);
  if (client?.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

function broadcastToCDPClients(message: unknown): void {
  for (const client of cdpClients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

function validateExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const match = origin.match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) return false;
  const id = match[1];
  if (ALLOW_ANY_EXTENSION) {
    log(`Allowing extension origin without allowlist: ${id}`);
    return true;
  }
  return ALLOWED_EXTENSION_IDS.includes(id);
}

function validateCdpOrigin(origin: string | null): boolean {
  if (!origin) {
    // Node.js clients usually do not send Origin.
    return true;
  }
  const match = origin.match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) {
    return false;
  }
  const id = match[1];
  if (ALLOW_ANY_EXTENSION) {
    return true;
  }
  return ALLOWED_EXTENSION_IDS.includes(id);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseForwardCommandParams(
  value: unknown
): { method: string; sessionId?: string; params?: Record<string, unknown> } | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const method = asString(record.method);
  if (!method) {
    return undefined;
  }
  return {
    method,
    sessionId: asString(record.sessionId),
    params: asRecord(record.params),
  };
}

function isExtensionLogMessage(message: ExtensionMessage): message is ExtensionLogMessage {
  return message.method === 'log' && !!asRecord((message as { params?: unknown }).params);
}

function isExtensionEventMessage(message: ExtensionMessage): message is ExtensionEventMessage {
  return message.method === 'forwardCDPEvent' && !!asRecord((message as { params?: unknown }).params);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    );
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(String(data));
}

const DEFAULT_BROWSER_CONTEXT_ID = 'default-browser-context';

function targetIdForTab(tabId: number): string | undefined {
  const target = [...attachedTargets.values()].find(t => t.tabId === tabId);
  return target ? buildTargetInfo(target).targetId : undefined;
}

function buildTargetInfo(target: AttachedTarget): TargetInfo {
  const targetInfo = target.targetInfo ?? {};
  return {
    targetId: targetInfo.targetId ?? target.sessionId,
    type: targetInfo.type ?? 'page',
    title: targetInfo.title ?? '',
    url: targetInfo.url ?? '',
    tabId: target.tabId ?? targetInfo.tabId,
    browserContextId: targetInfo.browserContextId ?? DEFAULT_BROWSER_CONTEXT_ID,
  };
}

function sendCdpResponse(clientId: string, payload: { id: number; sessionId?: string; result?: unknown }): void {
  sendToCDPClient(clientId, payload);
}

function sendCdpError(clientId: string, payload: { id: number; sessionId?: string; error: string; code?: number }): void {
  const errorObj: { message: string; code?: number } = { message: payload.error };
  if (payload.code !== undefined) errorObj.code = payload.code;
  sendToCDPClient(clientId, { id: payload.id, sessionId: payload.sessionId, error: errorObj });
}

const RELAY_REQUEST_TIMEOUT_MS = 90000;
const RECENTLY_DELETED_MAX = 200;
const recentlyDeletedRequests = new Map<number, { method?: string; deleteReason: string; deletedAt: number; createdAt: number }>();

function deletePendingRequest(relayId: number, reason: string): PendingRequest | undefined {
  const entry = pendingRequests.get(relayId);
  if (!entry) return undefined;
  clearTimeout(entry.timeoutId);
  pendingRequests.delete(relayId);
  recentlyDeletedRequests.set(relayId, {
    method: entry.method,
    deleteReason: reason,
    deletedAt: Date.now(),
    createdAt: entry.createdAt,
  });
  if (recentlyDeletedRequests.size > RECENTLY_DELETED_MAX) {
    const oldest = recentlyDeletedRequests.keys().next().value;
    if (oldest !== undefined) recentlyDeletedRequests.delete(oldest);
  }
  return entry;
}

function addPendingRequest(
  relayId: number,
  pending: Omit<PendingRequest, 'timeoutId'>
): void {
  const timeoutId = setTimeout(() => {
    const timeoutPending = deletePendingRequest(relayId, 'timeout');
    if (!timeoutPending) {
      return;
    }
    sendCdpError(timeoutPending.clientId, {
      id: timeoutPending.clientMessageId,
      sessionId: timeoutPending.sessionId,
      error: 'Extension request timeout',
    });
  }, RELAY_REQUEST_TIMEOUT_MS);

  pendingRequests.set(relayId, {
    ...pending,
    timeoutId,
  });
}

// Forget a session's announce bookkeeping once a detach for it has been
// broadcast, so a later legitimate re-attach is forwarded again.
function clearAnnouncedTarget(sessionId: string): void {
  for (const client of cdpClients.values()) {
    client.announcedTargets.delete(sessionId);
  }
}

function sendAttachedToTargetEvents(clientId: string): void {
  // Only expose targets that this client's session owns (or unclaimed targets)
  // to prevent Playwright from initializing pages it can't control
  const sessionId = pwClientToSession.get(clientId);
  const client = cdpClients.get(clientId);
  for (const target of attachedTargets.values()) {
    if (target.tabId != null && sessionId) {
      const owner = tabOwners.get(target.tabId);
      if (owner && owner.sessionId !== sessionId) continue;
    }
    const targetInfo = buildTargetInfo(target);
    const announcedId = targetInfo.targetId ?? target.sessionId;
    if (client?.announcedTargets.get(target.sessionId) === announcedId) continue;
    client?.announcedTargets.set(target.sessionId, announcedId);
    sendToCDPClient(clientId, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: target.sessionId,
        targetInfo: {
          ...targetInfo,
          attached: true,
        },
        waitingForDebugger: false,
      },
    });
  }
}

function sendTargetCreatedEvents(clientId: string): void {
  const sessionId = pwClientToSession.get(clientId);
  for (const target of attachedTargets.values()) {
    if (target.tabId != null && sessionId) {
      const owner = tabOwners.get(target.tabId);
      if (owner && owner.sessionId !== sessionId) continue;
    }
    const targetInfo = buildTargetInfo(target);
    sendToCDPClient(clientId, {
      method: 'Target.targetCreated',
      params: {
        targetInfo: {
          ...targetInfo,
          attached: true,
        },
      },
    });
  }
}

function toPageDownloadParams(dl: DownloadBehavior): { behavior: string; downloadPath?: string } {
  const pageBehavior = dl.behavior === 'allowAndName' ? 'allow' : dl.behavior;
  const result: { behavior: string; downloadPath?: string } = { behavior: pageBehavior };
  if (pageBehavior === 'allow' && dl.downloadPath) {
    result.downloadPath = dl.downloadPath;
  }
  return result;
}

// Fire-and-forget: responses are intentionally not tracked since download
// behavior is best-effort and extension CDP may reorder responses.
function applyDownloadBehaviorToAllPages(dl: DownloadBehavior): void {
  if (!isExtensionConnected()) return;
  const pageParams = toPageDownloadParams(dl);
  for (const target of attachedTargets.values()) {
    if ((target.targetInfo?.type ?? 'page') === 'page') {
      const relayId = nextExtensionRequestId++;
      sendToExtension({
        id: relayId,
        method: 'forwardCDPCommand',
        params: {
          method: 'Page.setDownloadBehavior',
          sessionId: target.sessionId,
          params: pageParams,
        },
      });
    }
  }
}

function applyDownloadBehaviorToTarget(targetSessionId: string): void {
  if (!isExtensionConnected() || !activeDownloadBehavior) return;
  const pageParams = toPageDownloadParams(activeDownloadBehavior);
  const relayId = nextExtensionRequestId++;
  sendToExtension({
    id: relayId,
    method: 'forwardCDPCommand',
    params: {
      method: 'Page.setDownloadBehavior',
      sessionId: targetSessionId,
      params: pageParams,
    },
  });
}

function maybeSynthesizeBrowserDownloadEvent(method: string, params: unknown): void {
  const browserMethod =
    method === 'Page.downloadWillBegin' ? 'Browser.downloadWillBegin' :
    method === 'Page.downloadProgress' ? 'Browser.downloadProgress' :
    null;
  if (browserMethod) {
    broadcastToCDPClients({ method: browserMethod, params });
  }
}

function handleServerCdpCommand(
  clientId: string,
  message: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
): boolean {
  const { id, method, params, sessionId } = message;

  switch (method) {
    case 'Browser.getVersion': {
      sendCdpResponse(clientId, {
        id,
        sessionId,
        result: {
          protocolVersion: '1.3',
          product: `spawriter/${VERSION}`,
          revision: VERSION,
          userAgent: 'spawriter-cdp-relay',
          jsVersion: 'V8',
        },
      });
      return true;
    }

    case 'Browser.setDownloadBehavior': {
      const dlParams = params as { behavior?: string; downloadPath?: string } | undefined;
      if (!dlParams?.behavior) {
        sendCdpError(clientId, { id, sessionId, error: 'behavior is required for Browser.setDownloadBehavior' });
        return true;
      }

      activeDownloadBehavior = {
        behavior: dlParams.behavior,
        downloadPath: dlParams.downloadPath,
      };

      applyDownloadBehaviorToAllPages(activeDownloadBehavior);

      sendCdpResponse(clientId, { id, sessionId, result: {} });
      return true;
    }

    case 'Target.setAutoAttach': {
      if (!sessionId) {
        sendAttachedToTargetEvents(clientId);
      }
      sendCdpResponse(clientId, { id, sessionId, result: {} });
      return true;
    }

    case 'Target.setDiscoverTargets': {
      if ((params as { discover?: boolean } | undefined)?.discover) {
        sendTargetCreatedEvents(clientId);
      }
      sendCdpResponse(clientId, { id, sessionId, result: {} });
      return true;
    }

    case 'Target.getTargets': {
      const targetInfos = Array.from(attachedTargets.values()).map((target) => ({
        ...buildTargetInfo(target),
        attached: true,
        owner: target.tabId != null ? (getTabOwner(target.tabId) ?? null) : null,
      }));
      sendCdpResponse(clientId, { id, sessionId, result: { targetInfos } });
      return true;
    }

    case 'Target.getTargetInfo': {
      const requestedTargetId = (params as { targetId?: string } | undefined)?.targetId;
      const targetById = requestedTargetId
        ? Array.from(attachedTargets.values()).find((target) => {
          const targetInfo = buildTargetInfo(target);
          return targetInfo.targetId === requestedTargetId;
        })
        : undefined;
      const targetBySession = sessionId ? attachedTargets.get(sessionId) : undefined;
      const target = targetById ?? targetBySession ?? Array.from(attachedTargets.values())[0];

      if (!target) {
        sendCdpError(clientId, { id, sessionId, error: 'No targets attached' });
        return true;
      }

      sendCdpResponse(clientId, {
        id,
        sessionId,
        result: { targetInfo: buildTargetInfo(target) },
      });
      return true;
    }

    case 'Target.attachToBrowserTarget': {
      const vbsId = `vbs-${Date.now()}-${++virtualSessionCounter}`;
      virtualBrowserSessions.add(vbsId);
      sendCdpResponse(clientId, { id, sessionId, result: { sessionId: vbsId } });
      return true;
    }

    case 'Target.attachToTarget': {
      const requestedTargetId = (params as { targetId?: string } | undefined)?.targetId;
      if (!requestedTargetId) {
        sendCdpError(clientId, { id, sessionId, error: 'Target.attachToTarget requires targetId' });
        return true;
      }

      const target = Array.from(attachedTargets.values()).find((entry) => {
        const targetInfo = buildTargetInfo(entry);
        return targetInfo.targetId === requestedTargetId;
      });

      if (!target) {
        sendCdpError(clientId, { id, sessionId, error: `Target ${requestedTargetId} not found` });
        return true;
      }

      // If sent through a virtual browser session, create a virtual page session
      // that maps to the real one — this enables CDP event forwarding
      if (sessionId && virtualBrowserSessions.has(sessionId)) {
        const vpsId = `vps-${Date.now()}-${++virtualSessionCounter}`;
        virtualToRealSession.set(vpsId, target.sessionId);
        if (!realToVirtualSessions.has(target.sessionId)) {
          realToVirtualSessions.set(target.sessionId, new Set());
        }
        realToVirtualSessions.get(target.sessionId)!.add(vpsId);
        sendCdpResponse(clientId, { id, sessionId, result: { sessionId: vpsId } });
        return true;
      }

      sendCdpResponse(clientId, {
        id,
        sessionId,
        result: { sessionId: target.sessionId },
      });
      return true;
    }


    // -----------------------------------------------------------------------
    // Tab Ownership commands
    // -----------------------------------------------------------------------

    case 'Target.claimTab': {
      const claimTabId = asNumber(params?.tabId);
      const claimSessionId = asString(params?.sessionId);
      const claimForce = !!params?.force;
      if (claimTabId == null || !claimSessionId) {
        sendCdpError(clientId, { id, sessionId, error: 'Target.claimTab requires params.tabId (number) and params.sessionId (string)' });
        return true;
      }
      const result = claimTab(claimTabId, claimSessionId, claimForce);
      if (!result.ok) {
        sendToCDPClient(clientId, {
          id, sessionId,
          error: { code: OWNERSHIP_ERROR_CODE, message: `Tab ${claimTabId} owned by ${result.owner}` },
        });
        return true;
      }
      sessionToClientId.set(claimSessionId, clientId);
      sendCdpResponse(clientId, { id, sessionId, result: { claimed: true, tabId: claimTabId } });
      return true;
    }

    case 'Target.releaseTab': {
      const releaseTabId = asNumber(params?.tabId);
      const releaseSessionId = asString(params?.sessionId);
      if (releaseTabId == null || !releaseSessionId) {
        sendCdpError(clientId, { id, sessionId, error: 'Target.releaseTab requires params.tabId and params.sessionId' });
        return true;
      }
      const released = releaseTab(releaseTabId, releaseSessionId);
      if (!released) {
        sendCdpError(clientId, { id, sessionId, error: 'Not the owner' });
        return true;
      }
      sendCdpResponse(clientId, { id, sessionId, result: { released: true } });
      return true;
    }

    case 'Target.listOwnership': {
      const ownershipList = [...tabOwners.entries()].map(([tid, o]) => ({
        tabId: tid,
        sessionId: o.sessionId,
        claimedAt: o.claimedAt,
      }));
      sendCdpResponse(clientId, { id, sessionId, result: { ownership: ownershipList } });
      return true;
    }

    default:
      return false;
  }
}

function handleExtensionMessage(data: Buffer) {
  try {
    const message = JSON.parse(data.toString()) as ExtensionMessage;

    if (message.method === 'pong' || message.method === 'keepalive') {
      return;
    }

    if (message.method === 'requestOwnershipSnapshot') {
      sendOwnershipSnapshotToExtension('requested');
      return;
    }

    if (message.method === 'tabInfoChanged') {
      const params = (message as any).params as { tabId?: number; title?: string; url?: string } | undefined;
      const tabId = params?.tabId;
      if (tabId != null) {
        for (const target of attachedTargets.values()) {
          if (target.tabId === tabId && target.targetInfo) {
            if (params?.title != null) target.targetInfo.title = params.title;
            if (params?.url != null) target.targetInfo.url = params.url;
            break;
          }
        }
      }
      return;
    }

    if (isExtensionLogMessage(message)) {
      const params = message.params as { level?: string; args?: unknown[] };
      const level = params.level ?? 'log';
      const args = Array.isArray(params.args) ? params.args : [];
      log(`[EXT LOG ${level}]`, ...args);
      return;
    }

    if (isExtensionEventMessage(message)) {
      const { sessionId, method, params } = message.params;

      if (method === 'Target.attachedToTarget' && sessionId) {
        const targetInfo = (params as { targetInfo?: TargetInfo }).targetInfo;
        const incomingTabId = targetInfo?.tabId;
        if (incomingTabId !== undefined) {
          for (const [existingSessionId, existing] of attachedTargets) {
            if (existing.tabId === incomingTabId && existingSessionId !== sessionId) {
              log(`Replacing stale target for tabId ${incomingTabId}: ${existingSessionId} → ${sessionId}`);
              // Enrich with targetId or Playwright cannot resolve which page
              // died and keeps it registered — the next attach for the same
              // frame then hits CRBrowser's "Duplicate target" assert.
              const staleTargetId = buildTargetInfo(existing).targetId;
              attachedTargets.delete(existingSessionId);
              if (incomingTabId != null && tabOwners.has(incomingTabId)) {
                tabOwners.delete(incomingTabId);
                broadcastOwnershipEvent('Target.tabReleased', { tabId: incomingTabId, reason: 'target-replaced' });
                sendOwnershipSnapshotToExtension('target-replaced');
              }
              broadcastToCDPClients({
                method: 'Target.detachedFromTarget',
                params: { sessionId: existingSessionId, targetId: staleTargetId, reason: 'target-replaced' },
              });
              clearAnnouncedTarget(existingSessionId);
            }
          }
        }
        // Same-session re-announce (extension resync after reconnect): if the
        // targetId changed underneath (e.g. cross-process navigation while the
        // bridge was down), detach the old identity first so no client keeps a
        // page registered under it.
        const previous = attachedTargets.get(sessionId);
        const previousTargetId = previous ? buildTargetInfo(previous).targetId : undefined;
        attachedTargets.set(sessionId, {
          sessionId,
          tabId: incomingTabId,
          targetInfo,
        });
        const enrichedTargetInfo = buildTargetInfo(attachedTargets.get(sessionId)!);
        if (previousTargetId !== undefined && previousTargetId !== enrichedTargetInfo.targetId) {
          broadcastToCDPClients({
            method: 'Target.detachedFromTarget',
            params: { sessionId, targetId: previousTargetId, reason: 'target-id-changed' },
          });
          clearAnnouncedTarget(sessionId);
        }

        if ((targetInfo?.type ?? 'page') === 'page') {
          applyDownloadBehaviorToTarget(sessionId);
        }

        // Browser-level event: no top-level sessionId, or Playwright routes it
        // to a not-yet-existing CRSession and drops it (live-attached tabs
        // would never become pages). Apply the same per-client ownership
        // filter as the connect-time replay in sendAttachedToTargetEvents.
        // Skip clients that already saw this (sessionId, targetId) pair: the
        // extension re-announces every tab on resync, and a duplicate attach
        // makes Playwright's CRBrowser assert and unwind the whole process.
        const announcedId = enrichedTargetInfo.targetId ?? sessionId;
        for (const [cdpClientId, cdpClient] of cdpClients) {
          const boundSession = pwClientToSession.get(cdpClientId);
          if (incomingTabId != null && boundSession) {
            const owner = tabOwners.get(incomingTabId);
            if (owner && owner.sessionId !== boundSession) continue;
          }
          if (cdpClient.announcedTargets.get(sessionId) === announcedId) continue;
          cdpClient.announcedTargets.set(sessionId, announcedId);
          sendToCDPClient(cdpClientId, {
            method,
            params: {
              ...params as Record<string, unknown>,
              sessionId,
              targetInfo: { ...enrichedTargetInfo, attached: true },
            },
          });
        }

        broadcastToCDPClients({
          method: 'Target.tabAvailable',
          params: {
            sessionId,
            targetInfo: enrichedTargetInfo,
            totalAttached: attachedTargets.size,
            totalOwned: tabOwners.size,
            totalAvailable: attachedTargets.size - tabOwners.size,
          },
        });
        return;
      }

      if (method === 'Target.detachedFromTarget') {
        const detachedSessionId = (params as { sessionId?: string }).sessionId;
        let detachedTargetId: string | undefined;
        if (detachedSessionId) {
          const detachedTarget = attachedTargets.get(detachedSessionId);
          if (detachedTarget) detachedTargetId = buildTargetInfo(detachedTarget).targetId;
          if (detachedTarget?.tabId != null) {
            const hadOwner = tabOwners.has(detachedTarget.tabId);
            tabOwners.delete(detachedTarget.tabId);
            if (hadOwner) {
              log(`Ownership cleaned up for detached tab ${detachedTarget.tabId}`);
              broadcastOwnershipEvent('Target.tabReleased', { tabId: detachedTarget.tabId, reason: 'tab-detached' });
              sendOwnershipSnapshotToExtension('tab-detached');
            }
          }
          attachedTargets.delete(detachedSessionId);
        }
        // Browser-level event: no top-level sessionId, or Playwright routes it
        // into the dying child session instead of the browser-level handler
        // that marks the page closed — page.close() would then hang forever.
        // Playwright resolves the page by params.targetId, which the extension
        // does not include, so enrich it from the attached-target registry.
        broadcastToCDPClients({
          method,
          params: detachedTargetId
            ? { ...(params as Record<string, unknown>), targetId: detachedTargetId }
            : params,
        });
        if (detachedSessionId) clearAnnouncedTarget(detachedSessionId);
        return;
      }

      maybeSynthesizeBrowserDownloadEvent(method, params);
      routeCdpEvent(method, params, sessionId);
      return;
    }

    if ('id' in message) {
      const response = message as { id: number; result?: unknown; error?: string };

      const cmdPending = pendingExtensionCmdRequests.get(response.id);
      if (cmdPending) {
        clearTimeout(cmdPending.timeoutId);
        pendingExtensionCmdRequests.delete(response.id);
        try {
          const { id: _id, ...rest } = message as unknown as Record<string, unknown>;
          cmdPending.ws.send(JSON.stringify(rest));
        } catch {
          // cmd ws may have closed
        }
        return;
      }

      const pending = pendingRequests.get(response.id);
      if (!pending) {
        const deleted = recentlyDeletedRequests.get(response.id);
        if (deleted) {
          const ageMs = Date.now() - deleted.createdAt;
          error(`Late response for relay id ${response.id}: method=${deleted.method ?? '?'}, deletedReason=${deleted.deleteReason}, age=${(ageMs / 1000).toFixed(1)}s`);
        } else {
          error(`Received response for unknown request id: ${response.id}`);
        }
        return;
      }

      deletePendingRequest(response.id, 'completed');
      const payload = response.error
        ? { id: pending.clientMessageId, sessionId: pending.sessionId, error: { message: response.error } }
        : { id: pending.clientMessageId, sessionId: pending.sessionId, result: response.result };

      sendToCDPClient(pending.clientId, payload);
    }
  } catch (e) {
    error('Error parsing extension message:', e);
  }
}

function checkOwnership(clientId: string, cdpSessionId: string | undefined, id: number): boolean {
  if (!cdpSessionId) return true;
  const tabId = resolveTabIdFromSession(cdpSessionId);
  if (tabId == null) return true;
  const owner = tabOwners.get(tabId);
  if (!owner) return true;

  const ownerClientId = sessionToClientId.get(owner.sessionId);
  if (ownerClientId === clientId) return true;

  if (clientId.startsWith('pw-')) {
    const boundSession = pwClientToSession.get(clientId);
    if (boundSession === owner.sessionId) return true;
    if (boundSession === undefined) return true;
  }

  log(`OWNERSHIP BLOCKED: client=${clientId}, cdpSession=${cdpSessionId}, tabId=${tabId}, owner=${owner.sessionId}, sessionToClientId=${ownerClientId}, pwBound=${pwClientToSession.get(clientId)}`);
  sendCdpError(clientId, {
    id,
    sessionId: cdpSessionId,
    error: `Tab ${tabId} is owned by session "${owner.sessionId}". Cannot operate.`,
    code: OWNERSHIP_ERROR_CODE,
  });
  return false;
}

function routeCdpEvent(method: string, params: unknown, sessionId?: string): void {
  if (!sessionId) {
    broadcastToCDPClients({ method, params, sessionId });
    return;
  }

  const sendToPwClients = (sid: string) => {
    for (const [cid, client] of cdpClients) {
      if (cid.startsWith('pw-') && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ method, params, sessionId: sid }));
      }
    }
  };

  const tabId = resolveTabIdFromSession(sessionId);
  if (tabId != null) {
    const owner = tabOwners.get(tabId);
    if (owner) {
      const ownerClientId = sessionToClientId.get(owner.sessionId);
      if (ownerClientId) {
        sendToCDPClient(ownerClientId, { method, params, sessionId });
      }
      sendToPwClients(sessionId);
      // Duplicate events to all virtual sessions mapped to this real session
      const virtualSessions = realToVirtualSessions.get(sessionId);
      if (virtualSessions) {
        for (const vpsId of virtualSessions) sendToPwClients(vpsId);
      }
      return;
    }
  }
  broadcastToCDPClients({ method, params, sessionId });
  // Also broadcast to virtual sessions
  const virtualSessions = realToVirtualSessions.get(sessionId);
  if (virtualSessions) {
    for (const vpsId of virtualSessions) sendToPwClients(vpsId);
  }
}

// ---------------------------------------------------------------------------
// Target.createTarget / Target.closeTarget — browser-level commands that the
// extension cannot forward via chrome.debugger.sendCommand({tabId}). They are
// implemented with chrome.tabs.create/remove, enabling context.newPage() and
// page.close() through the relay (S8).
// ---------------------------------------------------------------------------

async function handleCreateTarget(clientId: string, id: number, url?: string): Promise<void> {
  const createUrl = url || 'about:blank';
  try {
    const result = await sendExtensionCommand('connectTabByMatch', { url: createUrl, forceCreate: true }, 15000);
    const newTabId = result.tabId as number | undefined;
    if (!result.success || typeof newTabId !== 'number') {
      sendCdpError(clientId, { id, error: `createTarget failed: ${(result as { error?: string }).error || 'unknown'}` });
      return;
    }
    let target: AttachedTarget | undefined;
    for (let i = 0; i < 25; i++) {
      target = [...attachedTargets.values()].find(t => t.tabId === newTabId);
      if (target) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!target) {
      sendCdpError(clientId, { id, error: 'createTarget: tab did not attach in time' });
      return;
    }
    const callerSession = pwClientToSession.get(clientId);
    if (callerSession) claimTab(newTabId, callerSession);
    sendCdpResponse(clientId, { id, result: { targetId: buildTargetInfo(target).targetId } });
  } catch (e: any) {
    sendCdpError(clientId, { id, error: `createTarget error: ${e.message}` });
  }
}

async function handleCloseTarget(clientId: string, id: number, sessionId: string | undefined, targetId?: string): Promise<void> {
  // Match real CDP targetId first; fall back to relay sessionId, which is
  // what /json/list exposes as `id`.
  const target = targetId
    ? [...attachedTargets.values()].find(t => buildTargetInfo(t).targetId === targetId || t.sessionId === targetId)
    : (sessionId ? attachedTargets.get(sessionId) : undefined);
  if (target?.tabId == null) {
    sendCdpError(clientId, { id, sessionId, error: 'closeTarget: target not found' });
    return;
  }
  const owner = getTabOwner(target.tabId);
  const callerSession = pwClientToSession.get(clientId);
  if (owner && callerSession && owner !== callerSession) {
    sendCdpError(clientId, { id, sessionId, error: `Tab ${target.tabId} is owned by session "${owner}". Cannot close.` });
    return;
  }
  try {
    const result = await sendExtensionCommand('closeTab', { tabId: target.tabId }, 10000);
    if (!result.success) {
      sendCdpError(clientId, { id, sessionId, error: `closeTarget failed: ${(result as { error?: string }).error || 'unknown'}` });
      return;
    }
    sendCdpResponse(clientId, { id, sessionId, result: { success: true } });
  } catch (e: any) {
    sendCdpError(clientId, { id, sessionId, error: `closeTarget error: ${e.message}` });
  }
}

function handleCDPMessage(data: Buffer, clientId: string) {
  try {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    const method = asString(parsed.method);
    const id = asNumber(parsed.id);

    if (method === 'forwardCDPCommand') {
      const params = parseForwardCommandParams(parsed.params);
      if (!params || id === undefined) {
        return;
      }

      // Translate virtual session IDs to real ones
      const origSessionId = params.sessionId;
      const realSid = origSessionId ? (virtualToRealSession.get(origSessionId) ?? origSessionId) : origSessionId;
      if (realSid !== origSessionId) params.sessionId = realSid;

      if (!checkOwnership(clientId, realSid, id)) return;

      const relayId = nextExtensionRequestId++;
      if (!isExtensionConnected()) {
        sendCdpError(clientId, {
          id,
          sessionId: origSessionId,
          error: 'Extension not connected',
        });
        return;
      }
      addPendingRequest(relayId, {
        clientId,
        clientMessageId: id,
        sessionId: origSessionId,
        method: params.method as string | undefined,
        createdAt: Date.now(),
      });
      sendToExtension({
        id: relayId,
        method: 'forwardCDPCommand',
        params,
      });
      return;
    }

    if (!method || id === undefined) {
      return;
    }

    const params = asRecord(parsed.params);
    const sessionId = asString(parsed.sessionId);

    // Browser-level tab lifecycle requires awaiting the extension, so it is
    // handled outside the synchronous server-command switch.
    if (method === 'Target.createTarget') {
      void handleCreateTarget(clientId, id, (params as { url?: string } | undefined)?.url);
      return;
    }
    if (method === 'Target.closeTarget') {
      void handleCloseTarget(clientId, id, sessionId, (params as { targetId?: string } | undefined)?.targetId);
      return;
    }

    const serverHandled = handleServerCdpCommand(clientId, {
      id,
      method,
      params,
      sessionId,
    });

    if (serverHandled) {
      return;
    }

    // Translate virtual session IDs to real ones before forwarding
    const realSessionId = sessionId ? (virtualToRealSession.get(sessionId) ?? sessionId) : sessionId;

    if (!checkOwnership(clientId, realSessionId, id)) return;

    const relayId = nextExtensionRequestId++;
    if (!isExtensionConnected()) {
      sendCdpError(clientId, {
        id,
        sessionId,
        error: 'Extension not connected',
      });
      return;
    }
    addPendingRequest(relayId, {
      clientId,
      clientMessageId: id,
      sessionId,
      method,
      createdAt: Date.now(),
    });

    sendToExtension({
      id: relayId,
      method: 'forwardCDPCommand',
      params: {
        method,
        sessionId: realSessionId,
        params,
      },
    });
  } catch (e) {
    error('Error parsing CDP message:', e);
  }
}

// ---------------------------------------------------------------------------
// Direct CDP command sender for the executor (bypasses Playwright CDPSession)
// ---------------------------------------------------------------------------

// Resolves the target CDP session strictly within tabs owned by the caller.
// Without a caller session (internal use) the legacy first-target behavior
// applies; with one, never fall through to another session's tab (S4).
export function resolveCdpSessionForCaller(
  targets: ReadonlyMap<string, { tabId?: number; sessionId: string }>,
  ownerOf: (tabId: number) => string | undefined,
  callerSessionId?: string,
): string | undefined {
  if (!callerSessionId) {
    for (const target of targets.values()) return target.sessionId;
    return undefined;
  }
  for (const target of targets.values()) {
    if (target.tabId != null && ownerOf(target.tabId) === callerSessionId) {
      return target.sessionId;
    }
  }
  return undefined;
}

function relaySendCdp(method: string, params?: Record<string, unknown>, timeout = 30000, callerSessionId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sessionId = resolveCdpSessionForCaller(attachedTargets, getTabOwner, callerSessionId);
    if (!sessionId) {
      reject(new Error(callerSessionId
        ? `No tab owned by session "${callerSessionId}". Connect a tab first.`
        : 'No attached target'));
      return;
    }
    if (!isExtensionConnected()) {
      reject(new Error('Extension not connected'));
      return;
    }
    const relayId = nextExtensionRequestId++;
    const timeoutId = setTimeout(() => {
      pendingExtensionCmdRequests.delete(relayId);
      reject(new Error(`Relay CDP timeout: ${method}`));
    }, timeout);

    const mockWs = {
      readyState: 1,
      send(data: string) {
        clearTimeout(timeoutId);
        pendingExtensionCmdRequests.delete(relayId);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.result ?? parsed);
        } catch (e) {
          reject(e);
        }
      },
      close() {},
    } as unknown as import('ws').WebSocket;

    pendingExtensionCmdRequests.set(relayId, { ws: mockWs, timeoutId });

    sendToExtension({
      id: relayId,
      method: 'forwardCDPCommand',
      params: { method, sessionId, params: params || {} },
    });
  });
}

const relayExecutorManager = new ExecutorManager({ maxSessions: 10, relaySendCdp });
startStaleSweep();

// ---------------------------------------------------------------------------
// CLI control routes (inlined from former control-routes.ts)
// Security middleware: Sec-Fetch-Site, Content-Type, and token auth
// ---------------------------------------------------------------------------

app.use('/cli/*', async (c, next) => {
  const secFetchSite = c.req.header('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'none' && secFetchSite !== 'same-origin') {
    return c.json({ error: 'Cross-origin requests not allowed' }, 403);
  }
  if (c.req.method === 'POST') {
    const contentType = c.req.header('content-type');
    if (!contentType?.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 400);
    }
  }
  const token = getRelayToken();
  if (token) {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

app.post('/cli/execute', async (c) => {
  try {
    const body = await c.req.json() as { sessionId: string; code: string; timeout?: number };
    const executor = relayExecutorManager.getOrCreate(body.sessionId);
    sessionActivity.set(body.sessionId, Date.now());

    if (executor.getActiveTabId() == null) {
      const targetUrlHint = extractTargetUrlHint(body.code);
      const ownedTabIds = getOwnedTabs(body.sessionId);
      const ownedTabId = targetUrlHint
        ? (
          ownedTabIds.find((tabId) => {
            const tabUrl = [...attachedTargets.values()].find(t => t.tabId === tabId)?.targetInfo?.url || '';
            return urlMatchesHint(tabUrl, targetUrlHint);
          }) ?? ownedTabIds[0]
        )
        : ownedTabIds[0];
      if (ownedTabId != null) {
        const url = [...attachedTargets.values()].find(t => t.tabId === ownedTabId)?.targetInfo?.url;
        executor.claimTab(ownedTabId, url, targetIdForTab(ownedTabId));
      } else {
        const reusableTab = pickReusableAttachedTab(targetUrlHint);
        if (reusableTab) {
          const claim = claimTab(reusableTab.tabId, body.sessionId);
          if (claim.ok) {
            executor.claimTab(reusableTab.tabId, reusableTab.url, targetIdForTab(reusableTab.tabId));
            log(`Auto-reused attached tab ${reusableTab.tabId} for session ${body.sessionId} (${reusableTab.reason}${targetUrlHint ? `, hint=${targetUrlHint}` : ''})`);
          }
        }

        if (executor.getActiveTabId() == null && isExtensionConnected()) {
          try {
            const createUrl = targetUrlHint || 'about:blank';
            const result = await sendExtensionCommand('connectTabByMatch', {
              url: createUrl,
              forceCreate: true,
            });
            if (result.success && typeof result.tabId === 'number') {
              for (let i = 0; i < 20; i++) {
                if ([...attachedTargets.values()].find(t => t.tabId === result.tabId)) break;
                await new Promise(r => setTimeout(r, 200));
              }
              const claim = claimTab(result.tabId as number, body.sessionId);
              if (claim.ok) {
                const tabUrl = [...attachedTargets.values()]
                  .find(t => t.tabId === result.tabId)?.targetInfo?.url || createUrl;
                executor.claimTab(result.tabId as number, tabUrl, targetIdForTab(result.tabId as number));
                log(`Created new tab ${result.tabId} for session ${body.sessionId}${targetUrlHint ? ` (hint: ${targetUrlHint})` : ''}`);
              }
            }
          } catch (e: any) {
            log(`Tab creation failed for session ${body.sessionId}: ${e.message}`);
          }
        }
      }
    }

    const activeTabId = executor.getActiveTabId();
    if (activeTabId == null) {
      return c.json({
        text: 'No tab connected to this session. Use the CLI: spawriter -s <id> tab connect <url>',
        images: [], screenshots: [], isError: true,
      }, 400);
    }
    {
      const owner = getTabOwner(activeTabId);
      if (owner && owner !== body.sessionId) {
        return c.json({
          text: `Tab ${activeTabId} is owned by session "${owner}". Use tab list to see available tabs.`,
          images: [], screenshots: [], isError: true,
        }, 403);
      }
      if (!owner) {
        const claim = claimTab(activeTabId, body.sessionId);
        if (!claim.ok) {
          return c.json({
            text: `Failed to claim tab ${activeTabId} (owned by ${claim.owner}). Use tab list to see available tabs.`,
            images: [], screenshots: [], isError: true,
          }, 403);
        }
        log(`Auto-claimed unowned tab ${activeTabId} for session ${body.sessionId} before execute`);
      }
    }

    const existingPwClientId = executor.getLastCdpClientId?.();
    if (existingPwClientId) {
      pwClientToSession.set(existingPwClientId, body.sessionId);
    }
    executor.onCdpClientCreated = (newClientId: string) => {
      pwClientToSession.set(newClientId, body.sessionId);
      sessionToClientId.set(body.sessionId, newClientId);
    };

    const result = await executor.execute(body.code, body.timeout || 10000);

    const latestPwClientId = executor.getLastCdpClientId?.();
    if (latestPwClientId && latestPwClientId !== existingPwClientId) {
      pwClientToSession.set(latestPwClientId, body.sessionId);
    }

    if (activeTabId != null) touchClaim(activeTabId, body.sessionId);

    return c.json({ text: result.text, images: result.images, screenshots: result.screenshots, isError: result.isError });
  } catch (err: any) {
    return c.json({ text: err.message, images: [], screenshots: [], isError: true }, 500);
  }
});

app.post('/cli/session/new', async (c) => {
  try {
    const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    relayExecutorManager.getOrCreate(id);
    return c.json({ id });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get('/cli/sessions', (c) => {
  const sessions = relayExecutorManager.listSessions();
  return c.json({ sessions: sessions.map(s => ({ id: s.id, connected: s.connected, stateKeys: s.stateKeys })) });
});

app.post('/cli/session/delete', async (c) => {
  const { sessionId } = await c.req.json();
  releaseAllTabs(sessionId);
  sessionActivity.delete(sessionId);
  sessionToClientId.delete(sessionId);
  const ok = await relayExecutorManager.remove(sessionId);
  if (!ok) return c.json({ error: 'Session not found' }, 404);
  return c.json({ success: true });
});

app.post('/cli/session/reset', async (c) => {
  const { sessionId } = await c.req.json();
  const executor = relayExecutorManager.get(sessionId);
  if (!executor) return c.json({ error: 'Session not found' }, 404);
  await executor.reset();
  return c.json({ success: true });
});

app.post('/cli/tab/claim', async (c) => {
  const { tabId, sessionId, force } = await c.req.json();
  if (tabId == null || !sessionId) return c.json({ error: 'tabId and sessionId required' }, 400);
  const result = claimTab(tabId, sessionId, !!force);
  if (!result.ok) return c.json({ error: `Tab ${tabId} owned by ${result.owner}` }, 409);
  const executor = relayExecutorManager.get(sessionId);
  if (executor) {
    const url = [...attachedTargets.values()]
      .find(t => t.tabId === tabId)?.targetInfo?.url;
    executor.claimTab(tabId, url, targetIdForTab(tabId));
    // An explicit claim means "use this tab now" — without this, a later
    // claim (bind/switch) would never redirect execute away from the first tab.
    executor.switchToTab(tabId);
  }
  return c.json({ success: true });
});

app.post('/cli/tab/release', async (c) => {
  const { tabId, sessionId } = await c.req.json();
  if (tabId == null || !sessionId) return c.json({ error: 'tabId and sessionId required' }, 400);
  const released = releaseTab(tabId, sessionId);
  if (!released) return c.json({ error: 'Not the owner' }, 403);
  const executor = relayExecutorManager.get(sessionId);
  if (executor) executor.releaseTab(tabId);
  return c.json({ success: true });
});

app.post('/cli/session/activity', async (c) => {
  const { sessionId } = await c.req.json();
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
  sessionActivity.set(sessionId, Date.now());
  return c.json({ success: true });
});

app.post('/cli/cdp', async (c) => {
  try {
    const { method, params, sessionId, timeout } = await c.req.json() as {
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      timeout?: number;
    };
    if (!method) return c.json({ error: 'method is required' }, 400);

    if (sessionId) {
      sessionActivity.set(sessionId, Date.now());
      const targetCdpSession = params?.sessionId as string | undefined;
      if (targetCdpSession) {
        const tabId = resolveTabIdFromSession(targetCdpSession);
        if (tabId != null) {
          const owner = getTabOwner(tabId);
          if (owner && owner !== sessionId) {
            return c.json({ error: `Tab ${tabId} owned by session "${owner}"` }, 403);
          }
        }
      }
    }

    const result = await relaySendCdp(method, params, timeout, sessionId);
    return c.json({ result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export async function startRelayServer(): Promise<void> {
  installRelayProcessErrorHandlers();
  // The relay is usually spawned with stdio:'ignore' — mirror logs to the
  // file that `spawriter logfile` points at, or they are lost entirely.
  const os = await import('node:os');
  const path = await import('node:path');
  enableFileLog(path.join(os.tmpdir(), 'spawriter', 'relay.log'));
  const port = getRelayPort();
  if (ALLOW_ANY_EXTENSION) {
    error('No SSPA_EXTENSION_IDS configured. Allowing any chrome-extension origin.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const init: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers: req.headers as any,
      };

      if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        init.body = Buffer.concat(chunks);
        init.duplex = 'half';
      }

      const request = new Request(url, init);
      const response = await app.fetch(request);
      const body = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end('Error');
    }
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const remoteAddr = req.socket?.remoteAddress || '';
    const origin = req.headers.origin || '';

    if (!isLocalhost(remoteAddr)) {
      error(`Rejected connection from non-localhost: ${remoteAddr}`);
      ws.close(1008, 'Connection only allowed from localhost');
      return;
    }

    const pathname = req.url?.split('?')[0] || '';

    if (pathname === '/extension') {
      if (!validateExtensionOrigin(origin)) {
        error(`Rejected extension connection with invalid origin: ${origin}. Allowed: ${ALLOWED_EXTENSION_IDS.join(', ') || 'none'}`);
        ws.close(1008, 'Invalid origin');
        return;
      }

      log('Extension WebSocket connected');
      extensionWs = ws as WebSocket;
      sendOwnershipSnapshotToExtension('extension-connected');

      ws.on('message', (data) => {
        handleExtensionMessage(rawDataToBuffer(data));
      });

      ws.on('close', () => {
        log('Extension WebSocket disconnected');
        if (extensionWs === ws) {
          extensionWs = null;
        }

        for (const [tabId] of tabOwners) {
          broadcastToCDPClients({
            method: 'Target.tabReleased',
            params: { tabId, reason: 'extension-disconnected' },
          });
        }
        tabOwners.clear();
        sessionActivity.clear();
        sessionToClientId.clear();
        pwClientToSession.clear();

        for (const target of attachedTargets.values()) {
          broadcastToCDPClients({
            method: 'Target.detachedFromTarget',
            params: {
              sessionId: target.sessionId,
              // Without targetId Playwright cannot unregister the page, and the
              // re-announce after the extension reconnects would be a duplicate.
              targetId: buildTargetInfo(target).targetId,
              reason: 'extension-disconnected',
            },
          });
        }
        attachedTargets.clear();
        for (const client of cdpClients.values()) {
          client.announcedTargets.clear();
        }
        activeDownloadBehavior = null;
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timeoutId);
          sendCdpError(pending.clientId, {
            id: pending.clientMessageId,
            sessionId: pending.sessionId,
            error: 'Extension disconnected',
          });
        }
        pendingRequests.clear();
        checkIdleShutdown();
      });

      ws.on('error', (err) => {
        error('Extension WebSocket error:', err.message);
      });
      return;
    }

    if (pathname.startsWith('/cdp/')) {
      const clientId = pathname.slice(5);
      const token = getRelayToken();

      if (!validateCdpOrigin(origin)) {
        error(`Rejected CDP connection with invalid origin: ${origin}`);
        ws.close(1008, 'Invalid origin');
        return;
      }

      if (token) {
        const url = new URL(req.url || '', `http://localhost:${port}`);
        const providedToken = url.searchParams.get('token');
        if (providedToken !== token) {
          error('Rejected CDP connection with invalid token');
          ws.close(1008, 'Invalid token');
          return;
        }
      }

      log(`CDP WebSocket connected: ${clientId}`);

    cdpClients.set(clientId, {
      ws: ws as WebSocket,
      announcedTargets: new Map(),
    });

      ws.on('message', (data) => {
        handleCDPMessage(rawDataToBuffer(data), clientId);
      });

      ws.on('close', () => {
        log(`CDP WebSocket disconnected: ${clientId}`);
        const current = cdpClients.get(clientId);
        if (current?.ws === ws) {
          cdpClients.delete(clientId);
          pwClientToSession.delete(clientId);
          for (const [sid, cid] of sessionToClientId) {
            if (cid === clientId) {
              releaseAllTabs(sid);
              sessionToClientId.delete(sid);
            }
          }
        }
        for (const [requestId, pending] of pendingRequests.entries()) {
          if (pending.clientId === clientId) {
            deletePendingRequest(requestId, 'client-disconnect');
          }
        }
        checkIdleShutdown();
      });

      ws.on('error', (err) => {
        error(`CDP WebSocket error (${clientId}):`, err.message);
      });

      return;
    }

    if (pathname === '/extension-cmd') {
      log('Extension command WebSocket connected');

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(rawDataToBuffer(data).toString()) as { method: string; [key: string]: unknown };

          if (!isExtensionConnected()) {
            ws.send(JSON.stringify({ success: false, error: 'Extension not connected' }));
            return;
          }

          const relayId = nextExtensionRequestId++;
          const timeoutId = setTimeout(() => {
            pendingExtensionCmdRequests.delete(relayId);
            ws.send(JSON.stringify({ success: false, error: 'Extension request timeout' }));
          }, 15000);

          pendingExtensionCmdRequests.set(relayId, { ws: ws as WebSocket, timeoutId });

          sendToExtension({
            id: relayId,
            method: message.method,
            params: message,
          });
        } catch (e) {
          ws.send(JSON.stringify({ success: false, error: String(e) }));
        }
      });

      ws.on('close', () => {
        log('Extension command WebSocket disconnected');
      });

      return;
    }

    ws.close(1008, 'Unknown endpoint');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} already in use — another relay instance is running. Exiting gracefully.`);
      process.exit(0);
    }
    error('Relay server error:', err.message);
    process.exit(1);
  });

  server.listen(port, () => {
    log(`Relay server started on port ${port}`);
    log(`Extension endpoint: ws://localhost:${port}/extension`);
    log(`CDP endpoint: ws://localhost:${port}/cdp/:clientId`);
  });

  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function checkIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    if (cdpClients.size > 0 || extensionWs) return;
    idleTimer = setTimeout(() => {
      if (cdpClients.size === 0 && !extensionWs) {
        log('No clients connected for 5 minutes. Shutting down idle relay.');
        process.exit(0);
      }
    }, IDLE_TIMEOUT_MS);
  }

  checkIdleShutdown();

  setInterval(() => {
    if (extensionWs?.readyState === WebSocket.OPEN) {
      extensionWs.send(JSON.stringify({ method: 'ping' }));
    }
    checkIdleShutdown();
  }, 30000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelayServer().catch((e) => {
    error('Failed to start relay server:', e);
    process.exit(1);
  });
}
