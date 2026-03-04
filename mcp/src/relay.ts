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

const app = new Hono();

interface ExtensionCmdPending {
  ws: WebSocket;
  timeoutId: ReturnType<typeof setTimeout>;
}

let extensionWs: WebSocket | null = null;
const cdpClients = new Map<string, CDPClient>();
const attachedTargets = new Map<string, AttachedTarget>();
const pendingRequests = new Map<number, PendingRequest>();
const pendingExtensionCmdRequests = new Map<number, ExtensionCmdPending>();
let nextExtensionRequestId = 1;

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

app.get('/version', (c) => {
  return c.json({ version: VERSION });
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
      id: targetInfo.targetId ?? target.sessionId,
      tabId: target.tabId,
      type: targetInfo.type ?? 'page',
      title: targetInfo.title ?? '',
      url: targetInfo.url ?? '',
      webSocketDebuggerUrl: getCdpUrl(getRelayPort(), target.sessionId),
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

function sendCdpError(clientId: string, payload: { id: number; sessionId?: string; error: string }): void {
  sendToCDPClient(clientId, { id: payload.id, sessionId: payload.sessionId, error: { message: payload.error } });
}

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
  }, 30000);

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

    default:
      return false;
  }
}

function handleExtensionMessage(data: Buffer) {
  try {
    const message = JSON.parse(data.toString()) as ExtensionMessage;

    if (message.method === 'pong') {
      log('Received pong from extension');
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
        attachedTargets.set(sessionId, {
          sessionId,
          tabId: targetInfo?.tabId,
          targetInfo,
        });

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
        return;
      }

      if (method === 'Target.detachedFromTarget') {
        const detachedSessionId = (params as { sessionId?: string }).sessionId;
        if (detachedSessionId) {
          attachedTargets.delete(detachedSessionId);
        }
      }

      broadcastToCDPClients({ method, params, sessionId });
      return;
    }

    if ('id' in message) {
      const response = message as { id: number; result?: unknown; error?: string };

      const cmdPending = pendingExtensionCmdRequests.get(response.id);
      if (cmdPending) {
        clearTimeout(cmdPending.timeoutId);
        pendingExtensionCmdRequests.delete(response.id);
        try {
          cmdPending.ws.send(JSON.stringify(response.error ? { success: false, error: response.error } : { success: true, ...(response.result as object) }));
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

      ws.on('message', (data) => {
        handleExtensionMessage(rawDataToBuffer(data));
      });

      ws.on('close', () => {
        log('Extension WebSocket disconnected');
        if (extensionWs === ws) {
          extensionWs = null;
        }
        attachedTargets.clear();
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timeoutId);
          sendCdpError(pending.clientId, {
            id: pending.clientMessageId,
            sessionId: pending.sessionId,
            error: 'Extension disconnected',
          });
        }
        pendingRequests.clear();
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
        cdpClients.delete(clientId);
        for (const [requestId, pending] of pendingRequests.entries()) {
          if (pending.clientId === clientId) {
            clearTimeout(pending.timeoutId);
            pendingRequests.delete(requestId);
          }
        }
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

  server.listen(port, () => {
    log(`Relay server started on port ${port}`);
    log(`Extension endpoint: ws://localhost:${port}/extension`);
    log(`CDP endpoint: ws://localhost:${port}/cdp/:clientId`);
  });

  setInterval(() => {
    if (extensionWs?.readyState === WebSocket.OPEN) {
      extensionWs.send(JSON.stringify({ method: 'ping' }));
    }
  }, 30000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelayServer().catch((e) => {
    error('Failed to start relay server:', e);
    process.exit(1);
  });
}
