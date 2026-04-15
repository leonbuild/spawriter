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
}

interface PendingRequest {
  clientId: string;
  clientMessageId: number;
  sessionId?: string;
  timeoutId: ReturnType<typeof setTimeout>;
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

// ---------------------------------------------------------------------------
// Tab Ownership System — multi-agent tab isolation
// ---------------------------------------------------------------------------

const tabOwners = new Map<number, { sessionId: string; claimedAt: number }>();
const sessionActivity = new Map<string, number>();
const sessionToClientId = new Map<string, string>();
const pwClientToSession = new Map<string, string>();

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
  }, SWEEP_INTERVAL);
}

const ALLOWED_EXTENSION_IDS = getAllowedExtensionIds();
const ALLOW_ANY_EXTENSION = ALLOWED_EXTENSION_IDS.length === 0;


app.get('/', (c) => {
  return c.text('OK');
});

app.post('/connect-active-tab', async (c) => {
  if (!isExtensionConnected()) {
    return c.json({ success: false, error: 'Extension not connected' }, 503);
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
      method: 'connectActiveTab',
    });
  });
});

app.post('/connect-tab', async (c) => {
  if (!isExtensionConnected()) {
    return c.json({ success: false, error: 'Extension not connected' }, 503);
  }

  const body = await c.req.json<{ url?: string; tabId?: number; create?: boolean }>().catch(() => ({}));

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

function addPendingRequest(
  relayId: number,
  pending: Omit<PendingRequest, 'timeoutId'>
): void {
  const timeoutId = setTimeout(() => {
    const timeoutPending = pendingRequests.get(relayId);
    if (!timeoutPending) {
      return;
    }
    pendingRequests.delete(relayId);
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

function sendAttachedToTargetEvents(clientId: string): void {
  for (const target of attachedTargets.values()) {
    const targetInfo = buildTargetInfo(target);
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
  for (const target of attachedTargets.values()) {
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
              attachedTargets.delete(existingSessionId);
              if (incomingTabId != null && tabOwners.has(incomingTabId)) {
                tabOwners.delete(incomingTabId);
                broadcastOwnershipEvent('Target.tabReleased', { tabId: incomingTabId, reason: 'target-replaced' });
                sendOwnershipSnapshotToExtension('target-replaced');
              }
              broadcastToCDPClients({
                method: 'Target.detachedFromTarget',
                params: { sessionId: existingSessionId, reason: 'target-replaced' },
              });
            }
          }
        }
        attachedTargets.set(sessionId, {
          sessionId,
          tabId: incomingTabId,
          targetInfo,
        });

        if ((targetInfo?.type ?? 'page') === 'page') {
          applyDownloadBehaviorToTarget(sessionId);
        }

        const enrichedTargetInfo = buildTargetInfo(attachedTargets.get(sessionId)!);
        broadcastToCDPClients({
          method,
          params: {
            ...params as Record<string, unknown>,
            sessionId,
            targetInfo: { ...enrichedTargetInfo, attached: true },
          },
          sessionId,
        });

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
        if (detachedSessionId) {
          const detachedTarget = attachedTargets.get(detachedSessionId);
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
        error(`Received response for unknown request id: ${response.id}`);
        return;
      }

      clearTimeout(pending.timeoutId);
      pendingRequests.delete(response.id);
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
  }

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
  const tabId = resolveTabIdFromSession(sessionId);
  if (tabId != null) {
    const owner = tabOwners.get(tabId);
    if (owner) {
      const ownerClientId = sessionToClientId.get(owner.sessionId);
      if (ownerClientId) {
        sendToCDPClient(ownerClientId, { method, params, sessionId });
      }
      for (const [cid, client] of cdpClients) {
        if (cid.startsWith('pw-') && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ method, params, sessionId }));
        }
      }
      return;
    }
  }
  broadcastToCDPClients({ method, params, sessionId });
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

      if (!checkOwnership(clientId, params.sessionId, id)) return;

      const relayId = nextExtensionRequestId++;
      if (!isExtensionConnected()) {
        sendCdpError(clientId, {
          id,
          sessionId: params.sessionId,
          error: 'Extension not connected',
        });
        return;
      }
      addPendingRequest(relayId, {
        clientId,
        clientMessageId: id,
        sessionId: params.sessionId,
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

    const serverHandled = handleServerCdpCommand(clientId, {
      id,
      method,
      params,
      sessionId,
    });

    if (serverHandled) {
      return;
    }

    if (!checkOwnership(clientId, sessionId, id)) return;

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
    });

    sendToExtension({
      id: relayId,
      method: 'forwardCDPCommand',
      params: {
        method,
        sessionId,
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

function getActiveSessionId(): string | undefined {
  for (const target of attachedTargets.values()) {
    return target.sessionId;
  }
  return undefined;
}

function relaySendCdp(method: string, params?: Record<string, unknown>, timeout = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      reject(new Error('No attached target'));
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
      for (const target of attachedTargets.values()) {
        if (target.tabId != null && !tabOwners.has(target.tabId)) {
          const claim = claimTab(target.tabId, body.sessionId);
          if (claim.ok) {
            executor.claimTab(target.tabId, target.targetInfo?.url);
            break;
          }
        }
      }
    }

    const activeTabId = executor.getActiveTabId();
    if (activeTabId != null) {
      const owner = getTabOwner(activeTabId);
      if (owner && owner !== body.sessionId) {
        return c.json({
          text: `Tab ${activeTabId} is owned by session "${owner}". Use tab list to see available tabs.`,
          images: [], screenshots: [], isError: true,
        }, 403);
      }
    }

    const existingPwClientId = executor.getLastCdpClientId?.();
    if (existingPwClientId) {
      pwClientToSession.set(existingPwClientId, body.sessionId);
    }
    executor.onCdpClientCreated = (newClientId: string) => {
      pwClientToSession.set(newClientId, body.sessionId);
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
    executor.claimTab(tabId, url);
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

    const result = await relaySendCdp(method, params, timeout);
    return c.json({ result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export async function startRelayServer(): Promise<void> {
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
            params: { sessionId: target.sessionId, reason: 'extension-disconnected' },
          });
        }
        attachedTargets.clear();
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
            clearTimeout(pending.timeoutId);
            pendingRequests.delete(requestId);
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
