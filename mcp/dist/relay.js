import { Hono } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { pathToFileURL } from 'node:url';
import { getRelayPort, getRelayToken, getCdpUrl, getAllowedExtensionIds, isLocalhost, log, error, VERSION, } from './utils.js';
import { LEASE_ERROR_CODE } from './protocol.js';
const app = new Hono();
let extensionWs = null;
const cdpClients = new Map();
const attachedTargets = new Map();
let activeDownloadBehavior = null;
const pendingRequests = new Map();
const pendingExtensionCmdRequests = new Map();
let nextExtensionRequestId = 1;
const tabLeases = new Map();
function getLeaseInfo(sessionId) {
    const lease = tabLeases.get(sessionId);
    if (!lease)
        return null;
    return { clientId: lease.clientId, label: lease.label, acquiredAt: lease.acquiredAt };
}
function releaseClientLeases(clientId, reason) {
    let released = false;
    for (const [sid, lease] of tabLeases) {
        if (lease.clientId === clientId) {
            tabLeases.delete(sid);
            released = true;
            log(`Auto-released lease on ${sid} (${reason})`);
            broadcastToCDPClients({
                method: 'Target.leaseReleased',
                params: { sessionId: sid, reason },
            });
        }
    }
    if (released) {
        sendLeaseSnapshotToExtension(reason);
    }
}
function isPlaywrightClient(clientId) {
    return clientId.startsWith('pw-');
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
    return new Promise((resolve) => {
        const relayId = nextExtensionRequestId++;
        const timeoutId = setTimeout(() => {
            pendingExtensionCmdRequests.delete(relayId);
            resolve(c.json({ success: false, error: 'Timeout waiting for extension' }, 504));
        }, 15000);
        const mockWs = {
            send(data) {
                clearTimeout(timeoutId);
                pendingExtensionCmdRequests.delete(relayId);
                try {
                    resolve(c.json(JSON.parse(data)));
                }
                catch {
                    resolve(c.json({ success: false, error: 'Invalid response' }, 500));
                }
            },
            readyState: 1,
        };
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
    const body = await c.req.json().catch(() => ({}));
    return new Promise((resolve) => {
        const relayId = nextExtensionRequestId++;
        const timeoutId = setTimeout(() => {
            pendingExtensionCmdRequests.delete(relayId);
            resolve(c.json({ success: false, error: 'Timeout waiting for extension' }, 504));
        }, 15000);
        const mockWs = {
            send(data) {
                clearTimeout(timeoutId);
                pendingExtensionCmdRequests.delete(relayId);
                try {
                    resolve(c.json(JSON.parse(data)));
                }
                catch {
                    resolve(c.json({ success: false, error: 'Invalid response' }, 500));
                }
            },
            readyState: 1,
        };
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
    const body = await c.req.json().catch(() => ({ action: '' }));
    return new Promise((resolve) => {
        const relayId = nextExtensionRequestId++;
        const timeoutId = setTimeout(() => {
            pendingExtensionCmdRequests.delete(relayId);
            resolve(c.json({ error: 'Timeout waiting for extension' }, 504));
        }, 15000);
        const mockWs = {
            send(data) {
                clearTimeout(timeoutId);
                pendingExtensionCmdRequests.delete(relayId);
                try {
                    resolve(c.json(JSON.parse(data)));
                }
                catch {
                    resolve(c.json({ error: 'Invalid response' }, 500));
                }
            },
            readyState: 1,
        };
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
            lease: getLeaseInfo(target.sessionId),
        };
    });
    return c.json(targets);
});
function sendToExtension(message) {
    if (extensionWs?.readyState === WebSocket.OPEN) {
        extensionWs.send(JSON.stringify(message));
    }
    else {
        error('Extension WebSocket not connected, cannot send message');
    }
}
function sendLeaseSnapshotToExtension(reason) {
    if (extensionWs?.readyState !== WebSocket.OPEN)
        return;
    sendToExtension({
        method: 'Target.leaseSnapshot',
        params: {
            reason,
            leases: Array.from(tabLeases.values()).map((lease) => {
                const target = attachedTargets.get(lease.sessionId);
                return {
                    sessionId: lease.sessionId,
                    clientId: lease.clientId,
                    label: lease.label,
                    acquiredAt: lease.acquiredAt,
                    tabId: target?.tabId,
                };
            }),
        },
    });
}
function isExtensionConnected() {
    return extensionWs?.readyState === WebSocket.OPEN;
}
function sendToCDPClient(clientId, message) {
    const client = cdpClients.get(clientId);
    if (client?.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}
function broadcastToCDPClients(message) {
    for (const client of cdpClients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
}
function validateExtensionOrigin(origin) {
    if (!origin)
        return false;
    const match = origin.match(/^chrome-extension:\/\/([^/]+)/);
    if (!match)
        return false;
    const id = match[1];
    if (ALLOW_ANY_EXTENSION) {
        log(`Allowing extension origin without allowlist: ${id}`);
        return true;
    }
    return ALLOWED_EXTENSION_IDS.includes(id);
}
function validateCdpOrigin(origin) {
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
function asRecord(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    return value;
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asNumber(value) {
    return typeof value === 'number' ? value : undefined;
}
function parseForwardCommandParams(value) {
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
function isExtensionLogMessage(message) {
    return message.method === 'log' && !!asRecord(message.params);
}
function isExtensionEventMessage(message) {
    return message.method === 'forwardCDPEvent' && !!asRecord(message.params);
}
function rawDataToBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    return Buffer.from(String(data));
}
const DEFAULT_BROWSER_CONTEXT_ID = 'default-browser-context';
function buildTargetInfo(target) {
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
function sendCdpResponse(clientId, payload) {
    sendToCDPClient(clientId, payload);
}
function sendCdpError(clientId, payload) {
    const errorObj = { message: payload.error };
    if (payload.code !== undefined)
        errorObj.code = payload.code;
    sendToCDPClient(clientId, { id: payload.id, sessionId: payload.sessionId, error: errorObj });
}
const RELAY_REQUEST_TIMEOUT_MS = 90000;
function addPendingRequest(relayId, pending) {
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
function sendAttachedToTargetEvents(clientId) {
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
function sendTargetCreatedEvents(clientId) {
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
function toPageDownloadParams(dl) {
    const pageBehavior = dl.behavior === 'allowAndName' ? 'allow' : dl.behavior;
    const result = { behavior: pageBehavior };
    if (pageBehavior === 'allow' && dl.downloadPath) {
        result.downloadPath = dl.downloadPath;
    }
    return result;
}
// Fire-and-forget: responses are intentionally not tracked since download
// behavior is best-effort and extension CDP may reorder responses.
function applyDownloadBehaviorToAllPages(dl) {
    if (!isExtensionConnected())
        return;
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
function applyDownloadBehaviorToTarget(targetSessionId) {
    if (!isExtensionConnected() || !activeDownloadBehavior)
        return;
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
function maybeSynthesizeBrowserDownloadEvent(method, params) {
    const browserMethod = method === 'Page.downloadWillBegin' ? 'Browser.downloadWillBegin' :
        method === 'Page.downloadProgress' ? 'Browser.downloadProgress' :
            null;
    if (browserMethod) {
        broadcastToCDPClients({ method: browserMethod, params });
    }
}
function handleServerCdpCommand(clientId, message) {
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
            const dlParams = params;
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
            if (params?.discover) {
                sendTargetCreatedEvents(clientId);
            }
            sendCdpResponse(clientId, { id, sessionId, result: {} });
            return true;
        }
        case 'Target.getTargets': {
            const targetInfos = Array.from(attachedTargets.values()).map((target) => ({
                ...buildTargetInfo(target),
                attached: true,
                lease: getLeaseInfo(target.sessionId),
            }));
            sendCdpResponse(clientId, { id, sessionId, result: { targetInfos } });
            return true;
        }
        case 'Target.getTargetInfo': {
            const requestedTargetId = params?.targetId;
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
            const requestedTargetId = params?.targetId;
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
        // Tab Lease commands
        // -----------------------------------------------------------------------
        case 'Target.acquireLease': {
            const leaseSessionId = params?.sessionId;
            const leaseLabel = params?.label;
            if (!leaseSessionId) {
                sendCdpError(clientId, { id, sessionId, error: 'Target.acquireLease requires params.sessionId' });
                return true;
            }
            if (!attachedTargets.has(leaseSessionId)) {
                sendCdpError(clientId, { id, sessionId, error: `Target ${leaseSessionId} not found` });
                return true;
            }
            const existing = tabLeases.get(leaseSessionId);
            if (existing && existing.clientId !== clientId) {
                const holderDesc = existing.label ? `"${existing.label}" (${existing.clientId})` : existing.clientId;
                sendToCDPClient(clientId, {
                    id,
                    sessionId,
                    error: {
                        code: LEASE_ERROR_CODE,
                        message: `Tab is leased by ${holderDesc}`,
                    },
                    holder: { clientId: existing.clientId, label: existing.label },
                });
                return true;
            }
            const lease = {
                sessionId: leaseSessionId,
                clientId,
                label: leaseLabel,
                acquiredAt: Date.now(),
            };
            tabLeases.set(leaseSessionId, lease);
            log(`Lease granted: ${leaseSessionId} → ${clientId}${leaseLabel ? ` (${leaseLabel})` : ''}`);
            if (isExtensionConnected()) {
                sendToExtension({
                    method: 'Target.leaseAcquired',
                    params: { sessionId: leaseSessionId, lease: getLeaseInfo(leaseSessionId) },
                });
            }
            sendLeaseSnapshotToExtension('acquire');
            sendCdpResponse(clientId, {
                id,
                sessionId,
                result: { granted: true, lease: getLeaseInfo(leaseSessionId) },
            });
            return true;
        }
        case 'Target.releaseLease': {
            const releaseSessionId = params?.sessionId;
            if (!releaseSessionId) {
                sendCdpError(clientId, { id, sessionId, error: 'Target.releaseLease requires params.sessionId' });
                return true;
            }
            const existing = tabLeases.get(releaseSessionId);
            if (!existing) {
                sendCdpResponse(clientId, { id, sessionId, result: { released: true } });
                return true;
            }
            if (existing.clientId !== clientId) {
                sendCdpError(clientId, { id, sessionId, error: 'Not the lease holder' });
                return true;
            }
            tabLeases.delete(releaseSessionId);
            log(`Lease released: ${releaseSessionId} by ${clientId}`);
            if (isExtensionConnected()) {
                sendToExtension({
                    method: 'Target.leaseReleased',
                    params: { sessionId: releaseSessionId, reason: 'explicit-release' },
                });
            }
            sendLeaseSnapshotToExtension('explicit-release');
            broadcastToCDPClients({
                method: 'Target.leaseReleased',
                params: { sessionId: releaseSessionId, reason: 'explicit-release' },
            });
            sendCdpResponse(clientId, { id, sessionId, result: { released: true } });
            return true;
        }
        case 'Target.listLeases': {
            const leases = Array.from(tabLeases.values()).map(l => ({
                sessionId: l.sessionId,
                clientId: l.clientId,
                label: l.label,
                acquiredAt: l.acquiredAt,
            }));
            sendCdpResponse(clientId, { id, sessionId, result: { leases } });
            return true;
        }
        default:
            return false;
    }
}
function handleExtensionMessage(data) {
    try {
        const message = JSON.parse(data.toString());
        if (message.method === 'pong' || message.method === 'keepalive') {
            return;
        }
        if (message.method === 'requestLeaseSnapshot') {
            sendLeaseSnapshotToExtension('extension-request');
            return;
        }
        if (isExtensionLogMessage(message)) {
            const params = message.params;
            const level = params.level ?? 'log';
            const args = Array.isArray(params.args) ? params.args : [];
            log(`[EXT LOG ${level}]`, ...args);
            return;
        }
        if (isExtensionEventMessage(message)) {
            const { sessionId, method, params } = message.params;
            if (method === 'Target.attachedToTarget' && sessionId) {
                const targetInfo = params.targetInfo;
                const incomingTabId = targetInfo?.tabId;
                if (incomingTabId !== undefined) {
                    for (const [existingSessionId, existing] of attachedTargets) {
                        if (existing.tabId === incomingTabId && existingSessionId !== sessionId) {
                            log(`Replacing stale target for tabId ${incomingTabId}: ${existingSessionId} → ${sessionId}`);
                            attachedTargets.delete(existingSessionId);
                            const staleLease = tabLeases.get(existingSessionId);
                            if (staleLease) {
                                tabLeases.delete(existingSessionId);
                                sendToCDPClient(staleLease.clientId, {
                                    method: 'Target.leaseLost',
                                    params: { sessionId: existingSessionId, reason: 'target-replaced' },
                                });
                                if (isExtensionConnected()) {
                                    sendToExtension({
                                        method: 'Target.leaseLost',
                                        params: { sessionId: existingSessionId, reason: 'target-replaced' },
                                    });
                                }
                                sendLeaseSnapshotToExtension('target-replaced');
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
                const enrichedTargetInfo = buildTargetInfo(attachedTargets.get(sessionId));
                broadcastToCDPClients({
                    method,
                    params: {
                        ...params,
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
                        totalLeased: tabLeases.size,
                        totalAvailable: attachedTargets.size - tabLeases.size,
                    },
                });
                return;
            }
            if (method === 'Target.detachedFromTarget') {
                const detachedSessionId = params.sessionId;
                if (detachedSessionId) {
                    attachedTargets.delete(detachedSessionId);
                    const lease = tabLeases.get(detachedSessionId);
                    if (lease) {
                        tabLeases.delete(detachedSessionId);
                        log(`Lease cleaned up for detached tab ${detachedSessionId}`);
                        sendToCDPClient(lease.clientId, {
                            method: 'Target.leaseLost',
                            params: { sessionId: detachedSessionId, reason: 'tab-detached' },
                        });
                        if (isExtensionConnected()) {
                            sendToExtension({
                                method: 'Target.leaseLost',
                                params: { sessionId: detachedSessionId, reason: 'tab-detached' },
                            });
                        }
                        sendLeaseSnapshotToExtension('tab-detached');
                    }
                }
            }
            maybeSynthesizeBrowserDownloadEvent(method, params);
            routeCdpEvent(method, params, sessionId);
            return;
        }
        if ('id' in message) {
            const response = message;
            const cmdPending = pendingExtensionCmdRequests.get(response.id);
            if (cmdPending) {
                clearTimeout(cmdPending.timeoutId);
                pendingExtensionCmdRequests.delete(response.id);
                try {
                    const { id: _id, ...rest } = message;
                    cmdPending.ws.send(JSON.stringify(rest));
                }
                catch {
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
    }
    catch (e) {
        error('Error parsing extension message:', e);
    }
}
function checkLeaseEnforcement(clientId, sessionId, id) {
    if (!sessionId || isPlaywrightClient(clientId))
        return true;
    const lease = tabLeases.get(sessionId);
    if (!lease)
        return true;
    if (lease.clientId !== clientId) {
        const holderDesc = lease.label ? `"${lease.label}" (${lease.clientId})` : lease.clientId;
        sendCdpError(clientId, {
            id,
            sessionId,
            error: `Tab is leased by ${holderDesc}. Acquire a different tab or wait for release.`,
            code: LEASE_ERROR_CODE,
        });
        return false;
    }
    return true;
}
function routeCdpEvent(method, params, sessionId) {
    if (sessionId && tabLeases.has(sessionId)) {
        const lease = tabLeases.get(sessionId);
        sendToCDPClient(lease.clientId, { method, params, sessionId });
        for (const [cid, client] of cdpClients) {
            if (isPlaywrightClient(cid) && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ method, params, sessionId }));
            }
        }
        return;
    }
    broadcastToCDPClients({ method, params, sessionId });
}
function handleCDPMessage(data, clientId) {
    try {
        const parsed = JSON.parse(data.toString());
        const method = asString(parsed.method);
        const id = asNumber(parsed.id);
        if (method === 'forwardCDPCommand') {
            const params = parseForwardCommandParams(parsed.params);
            if (!params || id === undefined) {
                return;
            }
            if (!checkLeaseEnforcement(clientId, params.sessionId, id))
                return;
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
        if (!checkLeaseEnforcement(clientId, sessionId, id))
            return;
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
    }
    catch (e) {
        error('Error parsing CDP message:', e);
    }
}
export async function startRelayServer() {
    const port = getRelayPort();
    if (ALLOW_ANY_EXTENSION) {
        error('No SSPA_EXTENSION_IDS configured. Allowing any chrome-extension origin.');
    }
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', `http://localhost:${port}`);
            const init = {
                method: req.method,
                headers: req.headers,
            };
            if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
                const chunks = [];
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
        }
        catch {
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
            extensionWs = ws;
            sendLeaseSnapshotToExtension('extension-connected');
            ws.on('message', (data) => {
                handleExtensionMessage(rawDataToBuffer(data));
            });
            ws.on('close', () => {
                log('Extension WebSocket disconnected');
                if (extensionWs === ws) {
                    extensionWs = null;
                }
                for (const [sid, lease] of tabLeases) {
                    sendToCDPClient(lease.clientId, {
                        method: 'Target.leaseLost',
                        params: { sessionId: sid, reason: 'extension-disconnected' },
                    });
                }
                tabLeases.clear();
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
                ws: ws,
            });
            ws.on('message', (data) => {
                handleCDPMessage(rawDataToBuffer(data), clientId);
            });
            ws.on('close', () => {
                log(`CDP WebSocket disconnected: ${clientId}`);
                const current = cdpClients.get(clientId);
                if (current?.ws === ws) {
                    cdpClients.delete(clientId);
                    releaseClientLeases(clientId, `client ${clientId} disconnected`);
                }
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
                    const message = JSON.parse(rawDataToBuffer(data).toString());
                    if (!isExtensionConnected()) {
                        ws.send(JSON.stringify({ success: false, error: 'Extension not connected' }));
                        return;
                    }
                    const relayId = nextExtensionRequestId++;
                    const timeoutId = setTimeout(() => {
                        pendingExtensionCmdRequests.delete(relayId);
                        ws.send(JSON.stringify({ success: false, error: 'Extension request timeout' }));
                    }, 15000);
                    pendingExtensionCmdRequests.set(relayId, { ws: ws, timeoutId });
                    sendToExtension({
                        id: relayId,
                        method: message.method,
                        params: message,
                    });
                }
                catch (e) {
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
//# sourceMappingURL=relay.js.map