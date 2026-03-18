import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { getRelayPort, getRelayToken, getAgentLabel, getProjectUrl, generateMcpClientId, log, error, sleep, VERSION, } from './utils.js';
import { PlaywrightExecutor, ExecutorManager } from './pw-executor.js';
let relayServerProcess = null;
let cdpSession = null;
let sessionPromise = null;
let preferredTargetId = null;
const MCP_CLIENT_ID = generateMcpClientId();
const agentLabel = getAgentLabel();
const projectUrl = getProjectUrl();
const pwExecutor = new PlaywrightExecutor();
const executorManager = new ExecutorManager();
const MAX_CONSOLE_LOGS = 1000;
const consoleLogs = [];
function addConsoleLog(entry) {
    consoleLogs.push(entry);
    if (consoleLogs.length > MAX_CONSOLE_LOGS) {
        consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE_LOGS);
    }
}
function clearConsoleLogs() {
    consoleLogs.length = 0;
}
function getConsoleLogs(options = {}) {
    const count = Math.min(Math.max(options.count || 50, 1), MAX_CONSOLE_LOGS);
    const level = options.level || 'all';
    const search = (options.search || '').toLowerCase();
    let filtered = consoleLogs;
    if (level !== 'all')
        filtered = filtered.filter(log => log.level === level);
    if (search)
        filtered = filtered.filter(log => log.text.toLowerCase().includes(search));
    return filtered.slice(-count);
}
function formatConsoleLogs(logs, totalCount) {
    if (logs.length === 0)
        return `No console logs captured (${totalCount} total in buffer)`;
    const lines = logs.map(log => {
        const time = new Date(log.timestamp).toISOString().slice(11, 23);
        const loc = log.url ? ` (${log.url}${log.lineNumber !== undefined ? ':' + log.lineNumber : ''})` : '';
        return `[${time}] [${log.level.toUpperCase().padEnd(5)}] ${log.text}${loc}`;
    });
    return `Console logs (${logs.length}/${totalCount} total):\n${lines.join('\n')}`;
}
const MAX_NETWORK_ENTRIES = 500;
const networkLog = new Map();
let interceptEnabled = false;
const interceptRules = new Map();
let interceptNextId = 1;
function clearInterceptState() {
    interceptEnabled = false;
    interceptRules.clear();
    interceptNextId = 1;
}
async function handleFetchPaused(session, params) {
    const reqId = params.requestId;
    const requestUrl = params.request?.url || '';
    const reqResourceType = params.resourceType || '';
    for (const rule of interceptRules.values()) {
        const urlMatch = !rule.urlPattern || requestUrl.includes(rule.urlPattern) ||
            new RegExp(rule.urlPattern.replace(/\*/g, '.*')).test(requestUrl);
        const typeMatch = !rule.resourceType || reqResourceType.toLowerCase() === rule.resourceType.toLowerCase();
        if (!urlMatch || !typeMatch)
            continue;
        if (rule.block) {
            await sendCdpCommand(session, 'Fetch.failRequest', { requestId: reqId, errorReason: 'BlockedByClient' });
            return;
        }
        if (rule.mockStatus !== undefined) {
            const responseHeaders = Object.entries(rule.mockHeaders || { 'Content-Type': 'application/json' })
                .map(([n, v]) => ({ name: n, value: v }));
            const body = rule.mockBody ? Buffer.from(rule.mockBody).toString('base64') : '';
            await sendCdpCommand(session, 'Fetch.fulfillRequest', {
                requestId: reqId,
                responseCode: rule.mockStatus,
                responseHeaders,
                body,
            });
            return;
        }
    }
    await sendCdpCommand(session, 'Fetch.continueRequest', { requestId: reqId });
}
function clearNetworkLog() {
    networkLog.clear();
}
function getNetworkEntries(options = {}) {
    const count = Math.min(Math.max(options.count || 50, 1), MAX_NETWORK_ENTRIES);
    const urlFilter = (options.urlFilter || '').toLowerCase();
    const statusFilter = options.statusFilter || 'all';
    let entries = Array.from(networkLog.values());
    if (urlFilter)
        entries = entries.filter(e => e.url.toLowerCase().includes(urlFilter));
    if (statusFilter !== 'all') {
        entries = entries.filter(e => {
            if (statusFilter === 'ok')
                return e.status !== undefined && e.status >= 200 && e.status < 400;
            if (statusFilter === 'error')
                return !!e.error || (e.status !== undefined && e.status >= 400);
            if (statusFilter === '4xx')
                return e.status !== undefined && e.status >= 400 && e.status < 500;
            if (statusFilter === '5xx')
                return e.status !== undefined && e.status >= 500;
            return true;
        });
    }
    return entries.slice(-count);
}
function formatNetworkEntries(entries, totalCount) {
    if (entries.length === 0)
        return `No network entries captured (${totalCount} total in buffer)`;
    const lines = entries.map(e => {
        const st = e.error ? `ERR:${e.error}` : (e.status !== undefined ? `${e.status}` : '...');
        const dur = e.endTime && e.startTime ? `${e.endTime - e.startTime}ms` : '...';
        const sz = e.size ? ` ${(e.size / 1024).toFixed(1)}KB` : '';
        return `[${e.requestId}] ${e.method.padEnd(6)} ${st.padEnd(15)} ${dur.padStart(7)}${sz}  ${e.url}`;
    });
    return `Network (${entries.length}/${totalCount} total):\n${lines.join('\n')}\n\nUse network_detail { requestId: "..." } to inspect headers and body.`;
}
// ---------------------------------------------------------------------------
// CDP event dispatch
// ---------------------------------------------------------------------------
function handleCdpEvent(method, params) {
    switch (method) {
        case 'Runtime.consoleAPICalled': {
            const type = params.type || 'log';
            const args = params.args || [];
            const text = args.map(arg => {
                if (arg.value !== undefined)
                    return String(arg.value);
                if (arg.description)
                    return arg.description;
                return `[${arg.type}]`;
            }).join(' ');
            const stackTrace = params.stackTrace;
            const topFrame = stackTrace?.callFrames?.[0];
            addConsoleLog({
                level: type, text, timestamp: Date.now(),
                url: topFrame?.url, lineNumber: topFrame?.lineNumber,
            });
            break;
        }
        case 'Runtime.exceptionThrown': {
            const details = params.exceptionDetails;
            addConsoleLog({
                level: 'error',
                text: details?.exception?.description || details?.text || 'Unknown exception',
                timestamp: Date.now(), url: details?.url, lineNumber: details?.lineNumber,
            });
            break;
        }
        case 'Network.requestWillBeSent': {
            const requestId = params.requestId;
            const request = params.request;
            if (requestId && request) {
                networkLog.set(requestId, {
                    requestId, url: request.url, method: request.method, startTime: Date.now(),
                    requestHeaders: request.headers,
                    postData: request.postData,
                    hasPostData: request.hasPostData,
                    resourceType: params.type,
                });
                if (networkLog.size > MAX_NETWORK_ENTRIES) {
                    const firstKey = networkLog.keys().next().value;
                    if (firstKey)
                        networkLog.delete(firstKey);
                }
            }
            break;
        }
        case 'Network.responseReceived': {
            const entry = networkLog.get(params.requestId);
            if (entry) {
                const r = params.response;
                if (r) {
                    entry.status = r.status;
                    entry.statusText = r.statusText;
                    entry.mimeType = r.mimeType;
                    entry.responseHeaders = r.headers;
                }
                entry.endTime = Date.now();
            }
            break;
        }
        case 'Network.loadingFinished': {
            const entry = networkLog.get(params.requestId);
            if (entry) {
                entry.endTime = entry.endTime || Date.now();
                if (typeof params.encodedDataLength === 'number')
                    entry.size = params.encodedDataLength;
            }
            break;
        }
        case 'Network.loadingFailed': {
            const entry = networkLog.get(params.requestId);
            if (entry) {
                entry.error = params.errorText || 'Failed';
                entry.endTime = Date.now();
            }
            break;
        }
    }
}
async function ensureRelayServer() {
    try {
        const response = await fetch(`http://localhost:${getRelayPort()}/version`, {
            signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
            log('Relay server already running');
            return;
        }
    }
    catch {
        log('Relay server not running, attempting to start...');
    }
    try {
        const { spawn } = await import('child_process');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const relayPath = path.join(__dirname, 'relay.js');
        relayServerProcess = spawn('node', [relayPath], {
            stdio: 'ignore',
            detached: true,
        });
        relayServerProcess.unref();
        for (let i = 0; i < 10; i++) {
            await sleep(1000);
            try {
                await fetch(`http://localhost:${getRelayPort()}/version`, {
                    signal: AbortSignal.timeout(1000),
                });
                log('Relay server started successfully');
                return;
            }
            catch {
                log('Waiting for relay server...');
            }
        }
        throw new Error('Failed to start relay server');
    }
    catch (e) {
        error('Error starting relay server:', e);
        throw e;
    }
}
async function requestExtensionAttachTab() {
    const port = getRelayPort();
    try {
        const response = await fetch(`http://localhost:${port}/connect-active-tab`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        return !!result.success;
    }
    catch (e) {
        error('Failed to request extension to attach tab:', e);
        return false;
    }
}
async function getTargets() {
    const port = getRelayPort();
    try {
        const response = await fetch(`http://localhost:${port}/json/list`, {
            signal: AbortSignal.timeout(2000),
        });
        return await response.json();
    }
    catch {
        return [];
    }
}
function connectCdp(sessionId) {
    const port = getRelayPort();
    const token = getRelayToken();
    const baseUrl = `ws://127.0.0.1:${port}/cdp/${MCP_CLIENT_ID}`;
    const wsUrl = token ? `${baseUrl}?token=${token}` : baseUrl;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('CDP WebSocket connection timeout'));
        }, 10000);
        ws.on('open', () => {
            clearTimeout(timeout);
            const session = {
                ws,
                sessionId,
                nextId: 1,
                pendingRequests: new Map(),
            };
            // Heartbeat: detect silent disconnects
            let pongReceived = true;
            const heartbeat = setInterval(() => {
                if (!pongReceived) {
                    log('CDP heartbeat timeout, closing connection');
                    clearInterval(heartbeat);
                    ws.terminate();
                    return;
                }
                pongReceived = false;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 30000);
            ws.on('pong', () => {
                pongReceived = true;
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id !== undefined) {
                        const pending = session.pendingRequests.get(msg.id);
                        if (pending) {
                            session.pendingRequests.delete(msg.id);
                            clearTimeout(pending.timer);
                            if (msg.error) {
                                pending.reject(new Error(msg.error.message));
                            }
                            else {
                                pending.resolve(msg.result);
                            }
                        }
                        return;
                    }
                    if (msg.method && msg.params) {
                        handleCdpEvent(msg.method, msg.params);
                        handleDebuggerEvent(msg.method, msg.params);
                        handleLeaseEvent(msg.method, msg.params);
                        if (msg.method === 'Fetch.requestPaused' && interceptEnabled) {
                            handleFetchPaused(session, msg.params).catch(() => { });
                        }
                    }
                }
                catch {
                    // ignore parse errors
                }
            });
            ws.on('close', () => {
                clearInterval(heartbeat);
                for (const pending of session.pendingRequests.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('CDP connection closed'));
                }
                session.pendingRequests.clear();
                if (cdpSession === session) {
                    cdpSession = null;
                }
            });
            ws.on('error', (err) => {
                error('CDP WebSocket error:', err.message);
            });
            resolve(session);
        });
        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`CDP connection failed: ${err.message}`));
        });
    });
}
function sendCdpCommand(session, method, params, commandTimeout = 30000) {
    return new Promise((resolve, reject) => {
        if (session.ws.readyState !== WebSocket.OPEN) {
            reject(new Error('CDP connection not open'));
            return;
        }
        const id = session.nextId++;
        const timer = setTimeout(() => {
            session.pendingRequests.delete(id);
            reject(new Error(`CDP command timeout: ${method}`));
        }, commandTimeout);
        session.pendingRequests.set(id, { resolve, reject, timer });
        const message = { id, method };
        if (session.sessionId) {
            message.sessionId = session.sessionId;
        }
        if (params) {
            message.params = params;
        }
        session.ws.send(JSON.stringify(message));
    });
}
let leaseSupported = null;
async function acquireLease(session, targetSessionId) {
    if (leaseSupported === false)
        return true;
    try {
        const result = await sendCdpCommand(session, 'Target.acquireLease', {
            sessionId: targetSessionId,
            label: agentLabel,
        });
        leaseSupported = true;
        return !!result?.granted;
    }
    catch (e) {
        log(`Lease acquisition failed for ${targetSessionId}: ${e}`);
        if (leaseSupported === null) {
            log('Lease commands not supported by relay — running without isolation');
            leaseSupported = false;
            return true;
        }
        return false;
    }
}
async function releaseLease(session, targetSessionId) {
    try {
        await sendCdpCommand(session, 'Target.releaseLease', { sessionId: targetSessionId });
    }
    catch {
        // Best effort
    }
}
async function releaseAllMyLeases(session) {
    try {
        const targets = await getTargets();
        for (const t of targets) {
            if (t.lease?.clientId === MCP_CLIENT_ID) {
                await releaseLease(session, t.id);
            }
        }
    }
    catch {
        // Best effort
    }
}
async function enableDomains(session) {
    try {
        await sendCdpCommand(session, 'Network.enable', {
            maxTotalBufferSize: 10 * 1024 * 1024,
            maxResourceBufferSize: 5 * 1024 * 1024,
            maxPostDataSize: 65536,
        });
        await sendCdpCommand(session, 'Runtime.enable');
    }
    catch {
        log('Domain enable failed (may already be enabled by relay)');
    }
}
async function requestConnectTab(params) {
    const port = getRelayPort();
    try {
        const response = await fetch(`http://localhost:${port}/connect-tab`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(18000),
        });
        return await response.json();
    }
    catch (e) {
        error('Failed to request connect-tab:', e);
        return { success: false };
    }
}
async function ensureSession() {
    if (cdpSession?.ws.readyState === WebSocket.OPEN) {
        return cdpSession;
    }
    // Mutex: if another call is already establishing a session, piggyback on it
    if (sessionPromise) {
        return sessionPromise;
    }
    sessionPromise = doEnsureSession();
    try {
        return await sessionPromise;
    }
    finally {
        sessionPromise = null;
    }
}
async function doEnsureSession() {
    cdpSession = null;
    await ensureRelayServer();
    let targets = await getTargets();
    // Phase 1: Reconnect to my existing lease
    const myLeased = targets.find(t => t.lease?.clientId === MCP_CLIENT_ID);
    if (myLeased) {
        log(`Reconnecting to previously leased tab: ${myLeased.url}`);
        cdpSession = await connectCdp(myLeased.id);
        await enableDomains(cdpSession);
        return cdpSession;
    }
    // Phase 2: Find an unleased tab
    let unleased = targets.filter(t => !t.lease);
    if (projectUrl && unleased.length > 1) {
        const matching = unleased.filter(t => t.url?.includes(projectUrl));
        if (matching.length > 0) {
            unleased = [...matching, ...unleased.filter(t => !t.url?.includes(projectUrl))];
        }
    }
    if (preferredTargetId) {
        const preferred = unleased.find(t => t.id === preferredTargetId);
        if (preferred) {
            unleased = [preferred, ...unleased.filter(t => t.id !== preferredTargetId)];
        }
    }
    for (const candidate of unleased) {
        try {
            cdpSession = await connectCdp(candidate.id);
            const leased = await acquireLease(cdpSession, candidate.id);
            if (leased) {
                log(`Acquired lease on tab: ${candidate.url}`);
                preferredTargetId = candidate.id;
                await enableDomains(cdpSession);
                return cdpSession;
            }
            cdpSession.ws.close();
            cdpSession = null;
        }
        catch (e) {
            log(`Failed to connect to candidate ${candidate.id}: ${e}`);
            if (cdpSession) {
                cdpSession.ws.close();
                cdpSession = null;
            }
        }
    }
    // Phase 3: Auto-attach by project URL
    if (projectUrl) {
        log(`No unleased tabs, attempting auto-attach by URL: ${projectUrl}`);
        const attached = await requestConnectTab({ url: projectUrl });
        if (attached.success) {
            await sleep(1000);
            targets = await getTargets();
            const newTarget = targets.find(t => !t.lease || t.lease.clientId === MCP_CLIENT_ID);
            if (newTarget) {
                cdpSession = await connectCdp(newTarget.id);
                await acquireLease(cdpSession, newTarget.id);
                preferredTargetId = newTarget.id;
                await enableDomains(cdpSession);
                return cdpSession;
            }
        }
    }
    // Phase 4: Fallback — request active tab
    if (targets.length === 0) {
        log('No targets at all, requesting extension to attach active tab...');
        await requestExtensionAttachTab();
        for (let i = 0; i < 10; i++) {
            await sleep(1000);
            targets = await getTargets();
            const available = targets.find(t => !t.lease);
            if (available) {
                cdpSession = await connectCdp(available.id);
                await acquireLease(cdpSession, available.id);
                preferredTargetId = available.id;
                await enableDomains(cdpSession);
                return cdpSession;
            }
            if (targets.length > 0)
                break;
        }
    }
    // Phase 5: All tabs leased by others
    const leasedCount = targets.filter(t => t.lease).length;
    if (targets.length > 0 && leasedCount === targets.length) {
        const holders = targets.map(t => {
            const l = t.lease;
            return `  • ${t.url || '(no url)'} — leased by ${l.label || l.clientId}`;
        }).join('\n');
        throw new Error(`All ${targets.length} attached tab(s) are leased by other agents:\n${holders}\n\n` +
            `To get a tab for this agent:\n` +
            `  1. Use connect_tab { url: "your-app-url" } to auto-attach a matching Chrome tab\n` +
            `  2. Open a Chrome tab and click the spawriter toolbar icon\n` +
            `  3. Use connect_tab { url: "your-url", create: true } to create and attach a new tab`);
    }
    throw new Error('No browser tab attached. Click the extension toolbar icon on a web page tab to attach it, or use connect_tab to attach one.');
}
const SLOW_CDP_COMMANDS = new Set([
    'Accessibility.getFullAXTree',
    'Page.captureScreenshot',
    'Network.clearBrowserCache',
    'Network.clearBrowserCookies',
    'Page.reload',
    'Page.navigate',
]);
function getCommandTimeout(method) {
    return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
}
async function evaluateJs(session, expression, evalTimeout = 30000) {
    const result = await sendCdpCommand(session, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: evalTimeout,
    }, evalTimeout + 5000);
    if (result.exceptionDetails) {
        throw new Error(`JS error: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
}
function formatAXTreeAsText(nodes) {
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.nodeId, node);
    }
    const lines = [];
    function walk(nodeId, depth) {
        const node = nodeMap.get(nodeId);
        if (!node)
            return;
        if (node.ignored) {
            for (const childId of node.childIds ?? []) {
                walk(childId, depth);
            }
            return;
        }
        const role = node.role?.value ?? '';
        const name = node.name?.value ?? '';
        const props = [];
        for (const prop of node.properties ?? []) {
            const v = prop.value?.value;
            if (v === undefined || v === false || v === '')
                continue;
            if (prop.name === 'focusable')
                continue;
            props.push(`${prop.name}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
        const indent = '  '.repeat(depth);
        const nameStr = name ? ` "${name}"` : '';
        const propsStr = props.length > 0 ? ` [${props.join(', ')}]` : '';
        if (role || name) {
            lines.push(`${indent}${role}${nameStr}${propsStr}`);
        }
        for (const childId of node.childIds ?? []) {
            walk(childId, depth + 1);
        }
    }
    const rootNode = nodes.find((n) => !n.parentId);
    if (rootNode) {
        walk(rootNode.nodeId, 0);
    }
    return lines.join('\n') || '(empty accessibility tree)';
}
// ---------------------------------------------------------------------------
// Accessibility snapshot diff & search
// ---------------------------------------------------------------------------
let lastSnapshot = null;
// ---------------------------------------------------------------------------
// Debugger state
// ---------------------------------------------------------------------------
let debuggerEnabled = false;
const breakpoints = new Map();
let debuggerPaused = false;
let currentCallFrameId = null;
const knownScripts = new Map();
function handleDebuggerEvent(method, params) {
    switch (method) {
        case 'Debugger.paused': {
            debuggerPaused = true;
            const callFrames = params.callFrames;
            currentCallFrameId = callFrames?.[0]?.callFrameId ?? null;
            break;
        }
        case 'Debugger.resumed':
            debuggerPaused = false;
            currentCallFrameId = null;
            break;
        case 'Debugger.scriptParsed': {
            const url = params.url;
            const scriptId = params.scriptId;
            if (url && scriptId && !url.startsWith('chrome') && !url.startsWith('devtools')) {
                knownScripts.set(scriptId, { scriptId, url });
            }
            break;
        }
    }
}
function handleLeaseEvent(method, params) {
    if (method === 'Target.leaseLost') {
        const lostSessionId = params.sessionId;
        const reason = params.reason;
        log(`Lease lost for tab ${lostSessionId}: ${reason}`);
        if (cdpSession?.sessionId === lostSessionId) {
            cdpSession = null;
        }
    }
    if (method === 'Target.tabAvailable') {
        const info = params.targetInfo;
        log(`New tab available: ${info?.url || '(unknown)'} (${params.totalAvailable} total available)`);
    }
    if (method === 'Target.leaseReleased') {
        log(`Tab lease released: ${params.sessionId} (${params.reason})`);
    }
}
function computeSnapshotDiff(oldSnap, newSnap) {
    const oldLines = oldSnap.split('\n');
    const newLines = newSnap.split('\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    const added = newLines.filter(l => !oldSet.has(l));
    const removed = oldLines.filter(l => !newSet.has(l));
    if (added.length === 0 && removed.length === 0) {
        return 'No changes since last snapshot.';
    }
    const parts = [];
    if (removed.length > 0) {
        parts.push(`Removed (${removed.length}):\n${removed.map(l => `- ${l}`).join('\n')}`);
    }
    if (added.length > 0) {
        parts.push(`Added (${added.length}):\n${added.map(l => `+ ${l}`).join('\n')}`);
    }
    return parts.join('\n\n');
}
function searchSnapshot(snapshot, query) {
    const lines = snapshot.split('\n');
    const lowerQuery = query.toLowerCase();
    const matchIndices = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
            matchIndices.push(i);
            if (matchIndices.length >= 20)
                break;
        }
    }
    if (matchIndices.length === 0)
        return 'No matches found';
    const CONTEXT_LINES = 3;
    const included = new Set();
    for (const idx of matchIndices) {
        for (let i = Math.max(0, idx - CONTEXT_LINES); i <= Math.min(lines.length - 1, idx + CONTEXT_LINES); i++) {
            included.add(i);
        }
    }
    const sorted = [...included].sort((a, b) => a - b);
    const result = [];
    for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && sorted[i - 1] !== sorted[i] - 1)
            result.push('---');
        const line = lines[sorted[i]];
        const isMatch = line.toLowerCase().includes(lowerQuery);
        result.push(isMatch ? `>>> ${line}` : `    ${line}`);
    }
    return `Search results for "${query}" (${matchIndices.length} matches):\n${result.join('\n')}`;
}
// ---------------------------------------------------------------------------
// Labeled screenshot: inject numbered overlays on interactive elements
// ---------------------------------------------------------------------------
const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
    'tab', 'treeitem', 'row',
]);
function getInteractiveElements(nodes) {
    const elements = [];
    let idx = 1;
    for (const node of nodes) {
        if (node.ignored)
            continue;
        const role = node.role?.value;
        if (!role || !INTERACTIVE_ROLES.has(role))
            continue;
        if (!node.backendDOMNodeId)
            continue;
        elements.push({
            index: idx++,
            role,
            name: node.name?.value ?? '',
            backendDOMNodeId: node.backendDOMNodeId,
        });
    }
    return elements;
}
function buildLabelInjectionScript(labels) {
    return `(function() {
    var container = document.createElement('div');
    container.id = '__spawriter_labels__';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    ${labels.map(l => `
    (function(){
      var d=document.createElement('div');
      d.textContent='${l.index}';
      d.style.cssText='position:absolute;left:${l.x}px;top:${l.y}px;width:${Math.max(l.width, 14)}px;height:${Math.max(l.height, 14)}px;border:2px solid #e11d48;border-radius:3px;font-size:10px;font-weight:bold;color:#fff;background:rgba(225,29,72,0.85);display:flex;align-items:center;justify-content:center;line-height:1;pointer-events:none;';
      container.appendChild(d);
    })();`).join('')}
    document.body.appendChild(container);
  })()`;
}
const REMOVE_LABELS_SCRIPT = `(function() {
  var el = document.getElementById('__spawriter_labels__');
  if (el) el.remove();
})()`;
function formatLabelLegend(elements) {
    if (elements.length === 0)
        return 'No interactive elements found.';
    const lines = elements.map(e => `[${e.index}] ${e.role}${e.name ? ` "${e.name}"` : ''}`);
    return `Interactive elements (${elements.length}):\n${lines.join('\n')}`;
}
const server = new Server({
    name: 'spawriter',
    version: VERSION,
}, {
    capabilities: {
        tools: {},
    },
});
const tools = [
    {
        name: 'screenshot',
        description: 'Take a screenshot of the current page. With labels=true, overlays numbered labels on interactive elements and returns their accessibility info.',
        inputSchema: {
            type: 'object',
            properties: {
                labels: { type: 'boolean', description: 'Overlay numbered labels on interactive elements (buttons, links, inputs, etc.)' },
            },
        },
    },
    {
        name: 'accessibility_snapshot',
        description: 'Get accessibility snapshot of the page. Supports search to find specific elements and diff to see changes since last call.',
        inputSchema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Search for elements matching this text (case-insensitive). Returns matching lines with context.' },
                diff: { type: 'boolean', description: 'Show diff against the previous snapshot (default: true when no search)' },
            },
        },
    },
    {
        name: 'execute',
        description: 'Execute JavaScript code in the page context',
        inputSchema: {
            type: 'object',
            properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
            required: ['code'],
        },
    },
    {
        name: 'dashboard_state',
        description: 'Get single-spa Inspector dashboard state, app statuses, and override effective state',
        inputSchema: {
            type: 'object',
            properties: { appName: { type: 'string', description: 'Optional app name to highlight one app state' } },
        },
    },
    {
        name: 'console_logs',
        description: 'Get captured browser console logs (log, warn, error, info, debug). Logs are captured in real-time from Runtime.consoleAPICalled and Runtime.exceptionThrown CDP events.',
        inputSchema: {
            type: 'object',
            properties: {
                count: { type: 'number', description: 'Number of recent logs to return (default: 50, max: 1000)' },
                level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug', 'all'], description: 'Filter by log level (default: all)' },
                search: { type: 'string', description: 'Filter logs containing this text' },
                clear: { type: 'boolean', description: 'Clear log buffer after returning results' },
            },
        },
    },
    {
        name: 'network_log',
        description: 'Get captured network requests. Shows URL, method, status, timing, size, and errors. Captured from Network CDP events in real-time.',
        inputSchema: {
            type: 'object',
            properties: {
                count: { type: 'number', description: 'Number of recent entries to return (default: 50, max: 500)' },
                url_filter: { type: 'string', description: 'Filter by URL substring' },
                status_filter: { type: 'string', enum: ['all', 'ok', 'error', '4xx', '5xx'], description: 'Filter by response status category (default: all)' },
                clear: { type: 'boolean', description: 'Clear network buffer after returning results' },
            },
        },
    },
    {
        name: 'network_detail',
        description: `Get full details of a network request including headers and body content.
Use network_log first to find the requestId, then use this tool to inspect details.
Can retrieve: request headers, request body (POST data), response headers, response body.`,
        inputSchema: {
            type: 'object',
            properties: {
                requestId: { type: 'string', description: 'Request ID from network_log output (required)' },
                include: {
                    type: 'string',
                    description: 'Comma-separated list of sections to include: request_headers, request_body, response_headers, response_body, all (default: all)',
                },
                max_body_size: { type: 'number', description: 'Max response body size in chars to return (default: 10000). Use 0 for headers only.' },
            },
            required: ['requestId'],
        },
    },
    {
        name: 'playwright_execute',
        description: `Execute code in a Node.js VM sandbox with full Playwright API access.
Available variables: page (Playwright Page), context (BrowserContext), state (persistent object across calls).
Use for: complex interactions, form filling, multi-step flows, Playwright locators, multi-page scenarios.
For simple/fast JS in page context, use the 'execute' tool instead.`,
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript code to execute. Has access to page, context, state, and standard globals.' },
                timeout: { type: 'number', description: 'Execution timeout in ms (default: 30000)' },
            },
            required: ['code'],
        },
    },
    {
        name: 'reset',
        description: 'Reset the CDP connection, Playwright executor, and clear all captured console logs and network entries',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'clear_cache_and_reload',
        description: `Clear browser cache/storage and optionally reload the page.
Supports granular control over what to clear via the "clear" parameter.
Legacy "mode" parameter still works for backward compatibility.`,
        inputSchema: {
            type: 'object',
            properties: {
                clear: {
                    type: 'string',
                    description: 'Comma-separated types to clear: cache, cookies, local_storage, session_storage, cache_storage, indexeddb, service_workers, all. Default: "cache"',
                },
                origin: {
                    type: 'string',
                    description: 'Scope storage/cookie clearing to this origin (e.g. "https://cursor.com"). Default: current page origin. Does not affect "cache" (always global).',
                },
                reload: { type: 'boolean', description: 'Whether to reload the page after clearing. Default: true' },
                mode: { type: 'string', enum: ['light', 'aggressive'], description: '(Deprecated) Legacy mode. "light" = reload only, "aggressive" = clear cache (global) + cookies (current page origin only, not all browser cookies) + reload. Prefer "clear" parameter for granular control. Overridden by "clear" if both are provided.' },
            },
        },
    },
    {
        name: 'ensure_fresh_render',
        description: 'Ensure the page is freshly rendered (clear cache if needed)',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'navigate',
        description: 'Navigate to a URL',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'URL to navigate to' } },
            required: ['url'],
        },
    },
    {
        name: 'override_app',
        description: 'Manage import-map-overrides for single-spa apps: set a localhost override, remove it, toggle enable/disable, or reset all overrides',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['set', 'remove', 'enable', 'disable', 'reset_all'], description: 'Action to perform on the override' },
                appName: { type: 'string', description: 'Module specifier (e.g. @cnic/main). Required for set/remove/enable/disable.' },
                url: { type: 'string', description: 'Override URL (e.g. http://localhost:9100/app.js). Required for "set" action.' },
            },
            required: ['action'],
        },
    },
    {
        name: 'app_action',
        description: 'Control single-spa application lifecycle: mount, unmount, or unload an app. After the action, triggers reroute to apply changes.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['mount', 'unmount', 'unload'], description: 'Lifecycle action to perform' },
                appName: { type: 'string', description: 'Application name (e.g. @cnic/main)' },
            },
            required: ['action', 'appName'],
        },
    },
    {
        name: 'debugger',
        description: `Control the JavaScript debugger via CDP. Set breakpoints, step through code, inspect variables.
Actions: enable, set_breakpoint, remove_breakpoint, list_breakpoints, resume, step_over, step_into, step_out, inspect_variables, evaluate, list_scripts, pause_on_exceptions.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['enable', 'set_breakpoint', 'remove_breakpoint', 'list_breakpoints', 'resume', 'step_over', 'step_into', 'step_out', 'inspect_variables', 'evaluate', 'list_scripts', 'pause_on_exceptions'],
                    description: 'Debugger action to perform',
                },
                file: { type: 'string', description: 'Script URL for set_breakpoint (use list_scripts to find URLs)' },
                line: { type: 'number', description: '1-based line number for set_breakpoint' },
                condition: { type: 'string', description: 'Conditional expression for set_breakpoint (only pause when true)' },
                breakpointId: { type: 'string', description: 'Breakpoint ID for remove_breakpoint' },
                expression: { type: 'string', description: 'JS expression for evaluate (accesses local scope when paused)' },
                search: { type: 'string', description: 'URL substring filter for list_scripts' },
                state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'Exception pause mode for pause_on_exceptions' },
            },
            required: ['action'],
        },
    },
    {
        name: 'css_inspect',
        description: 'Get computed CSS styles for an element identified by a CSS selector. Returns key visual properties.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to identify the element (e.g. "#header", ".btn-primary")' },
                properties: { type: 'string', description: 'Comma-separated list of specific CSS properties to inspect (default: common visual properties)' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'session_manager',
        description: `Manage Playwright executor sessions. Each session has its own browser connection and persistent state.\nActions: list, create, switch, remove, remove_all.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'create', 'switch', 'remove', 'remove_all'],
                    description: 'Session management action',
                },
                sessionId: { type: 'string', description: 'Session identifier for create/switch/remove (e.g. "feature-xyz", "debug-session")' },
            },
            required: ['action'],
        },
    },
    {
        name: 'list_tabs',
        description: 'List all Chrome tabs currently attached to spawriter. Shows session ID, tab ID, title, URL, which tab is active, and lease status (MINE / LEASED by X / AVAILABLE). In multi-agent setups, tabs are isolated via leases.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'switch_tab',
        description: 'Switch the MCP session to a different attached Chrome tab. Cannot switch to a tab leased by another agent. Acquires lease on the new tab if available. Cleared on switch: console logs, network entries, intercept rules, debugger state, snapshot baseline. Preserved: Playwright sessions and leases on other tabs.',
        inputSchema: {
            type: 'object',
            properties: {
                targetId: { type: 'string', description: 'Session ID of the target tab (from list_tabs output)' },
            },
            required: ['targetId'],
        },
    },
    {
        name: 'connect_tab',
        description: 'Request the extension to find and attach a Chrome tab by URL pattern or tab ID. Can optionally create a new tab if none matches. After connecting, use switch_tab to activate it, or it will be auto-selected on next tool call.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL substring to match against open Chrome tabs (e.g., "localhost:9100", "example.com/dashboard")' },
                tabId: { type: 'number', description: 'Exact Chrome tab ID to attach' },
                create: { type: 'boolean', description: 'If true and no matching tab found, create a new tab with the given URL and attach it' },
            },
        },
    },
    {
        name: 'release_tab',
        description: 'Release your lease on a tab, making it available to other agents. If no targetId specified, releases the currently active tab.',
        inputSchema: {
            type: 'object',
            properties: {
                targetId: { type: 'string', description: 'Session ID of the tab to release. Omit to release the active tab.' },
            },
        },
    },
    {
        name: 'storage',
        description: `Manage browser storage: cookies, localStorage, sessionStorage, cache.
Actions: get_cookies, set_cookie, delete_cookie, get_local_storage, set_local_storage, remove_local_storage, get_session_storage, clear_storage, get_storage_usage.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['get_cookies', 'set_cookie', 'delete_cookie', 'get_local_storage', 'set_local_storage', 'remove_local_storage', 'get_session_storage', 'clear_storage', 'get_storage_usage'],
                    description: 'Storage action',
                },
                key: { type: 'string', description: 'Storage key for get/set/remove localStorage/sessionStorage' },
                value: { type: 'string', description: 'Value for set operations' },
                name: { type: 'string', description: 'Cookie name for set/delete' },
                domain: { type: 'string', description: 'Cookie domain' },
                url: { type: 'string', description: 'URL for cookie operations' },
                path: { type: 'string', description: 'Cookie path' },
                secure: { type: 'boolean', description: 'Cookie secure flag' },
                httpOnly: { type: 'boolean', description: 'Cookie httpOnly flag' },
                sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'], description: 'Cookie sameSite attribute' },
                expires: { type: 'number', description: 'Cookie expiry (Unix timestamp)' },
                origin: { type: 'string', description: 'Origin for clear/usage operations' },
                storage_types: { type: 'string', description: 'Comma-separated types to clear: cookies,local_storage,session_storage,cache_storage,indexeddb,service_workers' },
            },
            required: ['action'],
        },
    },
    {
        name: 'performance',
        description: `Monitor page performance: runtime metrics, Web Vitals (LCP/CLS/INP/TTFB), memory usage, resource timing.
Actions: get_metrics, get_web_vitals, get_memory, get_resource_timing.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['get_metrics', 'get_web_vitals', 'get_memory', 'get_resource_timing'],
                    description: 'Performance action',
                },
                count: { type: 'number', description: 'Number of resource entries to return (default: 20, for get_resource_timing)' },
                type_filter: { type: 'string', description: 'Filter resource entries by type (e.g. script, css, img, fetch, xmlhttprequest)' },
            },
            required: ['action'],
        },
    },
    {
        name: 'editor',
        description: `View and edit page JavaScript and CSS sources in real-time. Supports hot-reload.
Actions: list_sources, get_source, edit_source, search_source, list_stylesheets, get_stylesheet, edit_stylesheet.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list_sources', 'get_source', 'edit_source', 'search_source', 'list_stylesheets', 'get_stylesheet', 'edit_stylesheet'],
                    description: 'Editor action',
                },
                scriptId: { type: 'string', description: 'Script ID from list_sources' },
                styleSheetId: { type: 'string', description: 'Stylesheet ID from list_stylesheets' },
                search: { type: 'string', description: 'Search string for filtering/searching' },
                content: { type: 'string', description: 'New content for edit operations' },
                line_start: { type: 'number', description: 'Start line for partial source view (1-based)' },
                line_end: { type: 'number', description: 'End line for partial source view (1-based)' },
            },
            required: ['action'],
        },
    },
    {
        name: 'network_intercept',
        description: `Intercept and modify network requests. Mock API responses, block requests, modify headers.
Actions: enable, disable, list_rules, add_rule, remove_rule.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['enable', 'disable', 'list_rules', 'add_rule', 'remove_rule'],
                    description: 'Intercept action',
                },
                rule_id: { type: 'string', description: 'Rule ID for remove_rule' },
                url_pattern: { type: 'string', description: 'URL pattern to match (glob: * for any)' },
                resource_type: { type: 'string', description: 'Resource type filter (XHR, Fetch, Document, Script, Stylesheet, Image, Font, Other)' },
                mock_status: { type: 'number', description: 'HTTP status code for mock response' },
                mock_headers: { type: 'string', description: 'JSON string of response headers for mock' },
                mock_body: { type: 'string', description: 'Response body for mock' },
                block: { type: 'boolean', description: 'Block matching requests (respond with 404)' },
            },
            required: ['action'],
        },
    },
    {
        name: 'emulation',
        description: `Emulate devices, network conditions, geolocation, timezone, color scheme, and media features.
Actions: set_device, set_user_agent, set_geolocation, set_timezone, set_locale, set_network_conditions, set_media, clear_all.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['set_device', 'set_user_agent', 'set_geolocation', 'set_timezone', 'set_locale', 'set_network_conditions', 'set_media', 'clear_all'],
                    description: 'Emulation action',
                },
                width: { type: 'number', description: 'Viewport width (for set_device)' },
                height: { type: 'number', description: 'Viewport height (for set_device)' },
                device_scale_factor: { type: 'number', description: 'Device pixel ratio (for set_device, default: 1)' },
                mobile: { type: 'boolean', description: 'Mobile mode (for set_device)' },
                user_agent: { type: 'string', description: 'User agent string (for set_user_agent)' },
                latitude: { type: 'number', description: 'Latitude (for set_geolocation)' },
                longitude: { type: 'number', description: 'Longitude (for set_geolocation)' },
                accuracy: { type: 'number', description: 'Accuracy in meters (for set_geolocation, default: 1)' },
                timezone_id: { type: 'string', description: 'IANA timezone (for set_timezone, e.g. America/New_York)' },
                locale: { type: 'string', description: 'Locale string (for set_locale, e.g. en-US)' },
                preset: { type: 'string', enum: ['offline', 'slow-3g', 'fast-3g', '4g', 'wifi'], description: 'Network condition preset' },
                download: { type: 'number', description: 'Download throughput bytes/sec (custom network)' },
                upload: { type: 'number', description: 'Upload throughput bytes/sec (custom network)' },
                latency: { type: 'number', description: 'Latency in ms (custom network)' },
                features: { type: 'string', description: 'Comma-separated media features (e.g. prefers-color-scheme:dark,prefers-reduced-motion:reduce)' },
            },
            required: ['action'],
        },
    },
    {
        name: 'page_content',
        description: `Get structured page content: clean HTML, text, metadata, or search the DOM.
Actions: get_html, get_text, get_metadata, search_dom.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['get_html', 'get_text', 'get_metadata', 'search_dom'],
                    description: 'Content action',
                },
                selector: { type: 'string', description: 'CSS selector to scope content (default: body)' },
                search: { type: 'string', description: 'Search string for search_dom' },
                max_length: { type: 'number', description: 'Max output length in chars (default: 50000)' },
                include_styles: { type: 'boolean', description: 'Include inline styles in HTML output (default: false)' },
            },
            required: ['action'],
        },
    },
];
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});
const MCP_REQUEST_TIMEOUT = 120000; // 2 minutes hard cap for any tool call
function withTimeout(promise, ms, toolName) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Tool "${toolName}" timed out after ${ms / 1000}s. The browser may be busy or unreachable. Try again or call reset.`));
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const handleToolCall = async () => {
        if (name === 'reset') {
            if (cdpSession) {
                await releaseAllMyLeases(cdpSession);
                cdpSession.ws.close();
                cdpSession = null;
            }
            preferredTargetId = null;
            clearConsoleLogs();
            clearNetworkLog();
            clearInterceptState();
            lastSnapshot = null;
            await pwExecutor.reset();
            debuggerEnabled = false;
            breakpoints.clear();
            debuggerPaused = false;
            currentCallFrameId = null;
            knownScripts.clear();
            await executorManager.resetAll();
            return { content: [{ type: 'text', text: 'Connection reset. Console logs, network entries, Playwright state, debugger state, leases, and sessions cleared.' }] };
        }
        if (name === 'list_tabs') {
            await ensureRelayServer();
            const targets = await getTargets();
            if (targets.length === 0) {
                return { content: [{ type: 'text', text: 'No tabs attached. Click the spawriter toolbar button on a Chrome tab, or use connect_tab to attach one.' }] };
            }
            const activeSessionId = cdpSession?.sessionId ?? null;
            const myTabs = targets.filter(t => t.lease?.clientId === MCP_CLIENT_ID);
            const otherTabs = targets.filter(t => t.lease && t.lease.clientId !== MCP_CLIENT_ID);
            const availableTabs = targets.filter(t => !t.lease);
            const lines = targets.map((t, i) => {
                const markers = [];
                if (t.id === activeSessionId)
                    markers.push('ACTIVE');
                if (t.lease?.clientId === MCP_CLIENT_ID) {
                    markers.push('MINE');
                }
                else if (t.lease) {
                    markers.push(`LEASED by ${t.lease.label || t.lease.clientId}`);
                }
                else {
                    markers.push('AVAILABLE');
                }
                const markerStr = markers.join(', ');
                const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
                return `${i + 1}. [${t.id}]${tabLabel} ← ${markerStr}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
            });
            const summary = [
                `${targets.length} tab(s) attached`,
                `${myTabs.length} mine`,
                `${otherTabs.length} leased by others`,
                `${availableTabs.length} available`,
            ].join(', ');
            return { content: [{ type: 'text', text: `${summary}\n\n${lines.join('\n\n')}` }] };
        }
        if (name === 'switch_tab') {
            const targetId = args.targetId;
            if (!targetId) {
                return { content: [{ type: 'text', text: 'Error: targetId is required. Use list_tabs to see available targets.' }], isError: true };
            }
            await ensureRelayServer();
            const targets = await getTargets();
            const target = targets.find(t => t.id === targetId);
            if (!target) {
                const available = targets.map(t => `  ${t.id} — ${t.url || '(no url)'}`).join('\n') || '  (none)';
                return { content: [{ type: 'text', text: `Error: target "${targetId}" not found.\n\nAvailable targets:\n${available}` }], isError: true };
            }
            if (target.lease && target.lease.clientId !== MCP_CLIENT_ID) {
                const holder = target.lease.label || target.lease.clientId;
                return {
                    content: [{ type: 'text', text: `Error: Tab is leased by "${holder}". You cannot switch to a tab owned by another agent.\n\n` +
                                `Use list_tabs to find an available tab, or use connect_tab to attach a new one.`
                        }],
                    isError: true,
                };
            }
            if (cdpSession?.sessionId === targetId && cdpSession.ws.readyState === WebSocket.OPEN) {
                return { content: [{ type: 'text', text: `Already connected to this tab: ${target.title || target.url || '(no title)'}` }] };
            }
            if (cdpSession) {
                cdpSession.ws.close();
                cdpSession = null;
            }
            clearConsoleLogs();
            clearNetworkLog();
            clearInterceptState();
            lastSnapshot = null;
            debuggerEnabled = false;
            breakpoints.clear();
            debuggerPaused = false;
            currentCallFrameId = null;
            knownScripts.clear();
            try {
                cdpSession = await connectCdp(targetId);
            }
            catch (e) {
                preferredTargetId = null;
                return { content: [{ type: 'text', text: `Error: failed to connect to tab "${targetId}". The tab may have been closed or the relay may be unreachable.\nDetail: ${String(e)}\n\nUse list_tabs to see available tabs, or call reset and retry.` }], isError: true };
            }
            preferredTargetId = targetId;
            if (!target.lease || target.lease.clientId !== MCP_CLIENT_ID) {
                const leased = await acquireLease(cdpSession, targetId);
                if (!leased) {
                    return { content: [{ type: 'text', text: 'Error: Failed to acquire lease on this tab (another agent may have just claimed it). Use list_tabs to see available tabs.' }], isError: true };
                }
            }
            await enableDomains(cdpSession);
            return { content: [{ type: 'text', text: `Switched to tab: ${target.title || '(no title)'}\nURL: ${target.url || '(no url)'}\nSession: ${targetId}\n\nCleared: console logs, network entries, intercept rules, debugger state, snapshot baseline.\nPreserved: Playwright sessions, leases on other tabs.` }] };
        }
        if (name === 'connect_tab') {
            await ensureRelayServer();
            const url = args.url;
            const tabId = args.tabId;
            const create = args.create;
            if (!url && tabId === undefined) {
                return { content: [{ type: 'text', text: 'Error: Provide either url or tabId.' }], isError: true };
            }
            let result = await requestConnectTab({ url, tabId, create });
            if (!result.success && result.error === 'Extension not connected') {
                log('Extension not connected, retrying connect_tab (waiting for extension service worker)...');
                for (let retry = 0; retry < 6; retry++) {
                    await sleep(2000);
                    result = await requestConnectTab({ url, tabId, create });
                    if (result.success || result.error !== 'Extension not connected')
                        break;
                    log(`connect_tab retry ${retry + 1}/6...`);
                }
            }
            if (!result.success) {
                return { content: [{ type: 'text', text: `Failed to connect tab: ${result.error || 'Unknown error'}` }], isError: true };
            }
            await sleep(500);
            const targets = await getTargets();
            const newTarget = targets.find(t => t.tabId === result.tabId);
            const created = result.created ? ' (newly created)' : '';
            const info = newTarget
                ? `Attached tab${created}:\n  Session: ${newTarget.id}\n  Title: ${newTarget.title}\n  URL: ${newTarget.url}\n\nUse switch_tab with targetId "${newTarget.id}" to activate it, or it will be auto-selected on the next tool call.`
                : `Tab attached${created} (tabId: ${result.tabId}). Use list_tabs to see it.`;
            return { content: [{ type: 'text', text: info }] };
        }
        if (name === 'release_tab') {
            const targetId = args.targetId || cdpSession?.sessionId;
            if (!targetId) {
                return { content: [{ type: 'text', text: 'No active tab to release. Specify targetId or ensure a session is active.' }], isError: true };
            }
            try {
                const session = await ensureSession();
                await releaseLease(session, targetId);
                if (targetId === cdpSession?.sessionId) {
                    cdpSession = null;
                }
                return { content: [{ type: 'text', text: `Released lease on tab ${targetId}. It is now available to other agents.` }] };
            }
            catch (e) {
                return { content: [{ type: 'text', text: `Error releasing lease: ${e}` }], isError: true };
            }
        }
        if (name === 'playwright_execute') {
            try {
                await ensureRelayServer();
                const code = args.code;
                const timeout = args.timeout || 30000;
                const result = await pwExecutor.execute(code, timeout);
                return {
                    content: [{ type: 'text', text: result.text }],
                    isError: result.isError || undefined,
                };
            }
            catch (e) {
                error('Error in playwright_execute:', e);
                return {
                    content: [{ type: 'text', text: `Error: ${String(e)}` }],
                    isError: true,
                };
            }
        }
        if (name === 'console_logs') {
            const logs = getConsoleLogs({
                count: args.count,
                level: args.level,
                search: args.search,
            });
            const text = formatConsoleLogs(logs, consoleLogs.length);
            if (args.clear)
                clearConsoleLogs();
            return { content: [{ type: 'text', text }] };
        }
        if (name === 'network_log') {
            const entries = getNetworkEntries({
                count: args.count,
                urlFilter: args.url_filter,
                statusFilter: args.status_filter,
            });
            const text = formatNetworkEntries(entries, networkLog.size);
            if (args.clear)
                clearNetworkLog();
            return { content: [{ type: 'text', text }] };
        }
        if (name === 'network_detail') {
            const requestId = args.requestId;
            const entry = networkLog.get(requestId);
            if (!entry)
                return { content: [{ type: 'text', text: `Request "${requestId}" not found. Use network_log to list available requests.` }] };
            const includeStr = (args.include || 'all').toLowerCase();
            const sections = includeStr === 'all'
                ? ['request_headers', 'request_body', 'response_headers', 'response_body']
                : includeStr.split(',').map(s => s.trim());
            const maxBodySize = args.max_body_size ?? 10000;
            const parts = [];
            const dur = entry.endTime && entry.startTime ? `${entry.endTime - entry.startTime}ms` : 'pending';
            parts.push(`Request: ${entry.method} ${entry.url}`);
            parts.push(`Status: ${entry.status ?? '(pending)'} ${entry.statusText || ''}`);
            parts.push(`Type: ${entry.resourceType || 'unknown'} | MIME: ${entry.mimeType || 'unknown'} | Duration: ${dur} | Size: ${entry.size ? `${(entry.size / 1024).toFixed(1)}KB` : 'unknown'}`);
            if (entry.error)
                parts.push(`Error: ${entry.error}`);
            if (sections.includes('request_headers') && entry.requestHeaders) {
                const hdrs = Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
                parts.push(`\nRequest Headers:\n${hdrs}`);
            }
            if (sections.includes('request_body')) {
                if (entry.postData) {
                    let bodyText = entry.postData;
                    if (bodyText.length > maxBodySize && maxBodySize > 0)
                        bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
                    parts.push(`\nRequest Body:\n${bodyText}`);
                }
                else if (entry.hasPostData) {
                    try {
                        const session = await ensureSession();
                        const result = await sendCdpCommand(session, 'Network.getRequestPostData', { requestId });
                        if (result?.postData) {
                            let bodyText = result.base64Encoded ? Buffer.from(result.postData, 'base64').toString('utf-8') : result.postData;
                            if (bodyText.length > maxBodySize && maxBodySize > 0)
                                bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
                            parts.push(`\nRequest Body:\n${bodyText}`);
                        }
                        else {
                            parts.push('\nRequest Body: (not available)');
                        }
                    }
                    catch {
                        parts.push('\nRequest Body: (not available - request may have been evicted from buffer)');
                    }
                }
                else {
                    parts.push('\nRequest Body: (none - GET or no body)');
                }
            }
            if (sections.includes('response_headers') && entry.responseHeaders) {
                const hdrs = Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
                parts.push(`\nResponse Headers:\n${hdrs}`);
            }
            if (sections.includes('response_body') && maxBodySize > 0) {
                try {
                    const session = await ensureSession();
                    const result = await sendCdpCommand(session, 'Network.getResponseBody', { requestId });
                    if (result?.body !== undefined) {
                        let bodyText = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf-8') : result.body;
                        if (bodyText.length > maxBodySize)
                            bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
                        parts.push(`\nResponse Body:\n${bodyText}`);
                    }
                    else {
                        parts.push('\nResponse Body: (empty)');
                    }
                }
                catch {
                    parts.push('\nResponse Body: (not available - may have been evicted from browser buffer. Try requesting sooner after the network call.)');
                }
            }
            return { content: [{ type: 'text', text: parts.join('\n') }] };
        }
        try {
            const session = await ensureSession();
            switch (name) {
                case 'screenshot': {
                    const withLabels = args.labels;
                    if (!withLabels) {
                        const result = await sendCdpCommand(session, 'Page.captureScreenshot', { format: 'png' }, getCommandTimeout('Page.captureScreenshot'));
                        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
                    }
                    await sendCdpCommand(session, 'Accessibility.enable', undefined, getCommandTimeout('Accessibility.enable'));
                    await sendCdpCommand(session, 'DOM.enable', undefined, getCommandTimeout('DOM.enable'));
                    const axResult = await sendCdpCommand(session, 'Accessibility.getFullAXTree', undefined, getCommandTimeout('Accessibility.getFullAXTree'));
                    const interactive = getInteractiveElements(axResult.nodes ?? []);
                    const labelPositions = [];
                    for (const el of interactive) {
                        try {
                            const boxModel = await sendCdpCommand(session, 'DOM.getBoxModel', { backendNodeId: el.backendDOMNodeId });
                            if (boxModel?.model) {
                                const b = boxModel.model.border;
                                const x = Math.min(b[0], b[2], b[4], b[6]);
                                const y = Math.min(b[1], b[3], b[5], b[7]);
                                const maxX = Math.max(b[0], b[2], b[4], b[6]);
                                const maxY = Math.max(b[1], b[3], b[5], b[7]);
                                labelPositions.push({ index: el.index, x, y, width: maxX - x, height: maxY - y });
                            }
                        }
                        catch {
                            // Element might not be visible
                        }
                    }
                    if (labelPositions.length > 0) {
                        await evaluateJs(session, buildLabelInjectionScript(labelPositions));
                    }
                    const screenshotResult = await sendCdpCommand(session, 'Page.captureScreenshot', { format: 'png' }, getCommandTimeout('Page.captureScreenshot'));
                    if (labelPositions.length > 0) {
                        await evaluateJs(session, REMOVE_LABELS_SCRIPT).catch(() => { });
                    }
                    const legend = formatLabelLegend(interactive);
                    return {
                        content: [
                            { type: 'image', data: screenshotResult.data, mimeType: 'image/png' },
                            { type: 'text', text: legend },
                        ],
                    };
                }
                case 'accessibility_snapshot': {
                    await sendCdpCommand(session, 'Accessibility.enable', undefined, getCommandTimeout('Accessibility.enable'));
                    const axResult = await sendCdpCommand(session, 'Accessibility.getFullAXTree', undefined, getCommandTimeout('Accessibility.getFullAXTree'));
                    const fullText = formatAXTreeAsText(axResult.nodes ?? []);
                    const searchQuery = args.search;
                    const showDiff = args.diff;
                    if (searchQuery) {
                        lastSnapshot = fullText;
                        return { content: [{ type: 'text', text: searchSnapshot(fullText, searchQuery) }] };
                    }
                    const shouldDiff = showDiff !== false && lastSnapshot !== null;
                    if (shouldDiff && lastSnapshot) {
                        const diffText = computeSnapshotDiff(lastSnapshot, fullText);
                        lastSnapshot = fullText;
                        return { content: [{ type: 'text', text: diffText }] };
                    }
                    lastSnapshot = fullText;
                    return { content: [{ type: 'text', text: fullText }] };
                }
                case 'execute': {
                    const code = args.code;
                    const value = await evaluateJs(session, code);
                    const textResult = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                    return {
                        content: [{ type: 'text', text: textResult ?? 'undefined' }],
                    };
                }
                case 'dashboard_state': {
                    const targetAppName = typeof args.appName === 'string' && args.appName.trim().length > 0
                        ? JSON.stringify(args.appName.trim())
                        : 'null';
                    const dashboardCode = `(function(requestedAppName) {
          var devtools = window.__SINGLE_SPA_DEVTOOLS__;
          var exposedMethods = devtools && devtools.exposedMethods;
          var hasSingleSpaDevtools = !!(exposedMethods && typeof exposedMethods.getRawAppData === 'function');
          var rawApps = hasSingleSpaDevtools ? (exposedMethods.getRawAppData() || []) : [];
          var imo = window.importMapOverrides;
          var overrideMap = imo && typeof imo.getOverrideMap === 'function' ? imo.getOverrideMap() : null;
          var overrides = overrideMap && overrideMap.imports ? overrideMap.imports : {};
          var apps = Array.isArray(rawApps) ? rawApps.map(function(app) {
            var ad = app.devtools || {};
            var name = app.name || '';
            var overrideUrl = overrides[name] || null;
            return { name: name, status: app.status || 'UNKNOWN', overrideUrl: overrideUrl, activeWhenForced: ad.activeWhenForced || null, hasOverlays: !!ad.overlays };
          }) : [];
          var activeOverrides = {};
          for (var key in overrides) { activeOverrides[key] = overrides[key]; }
          return JSON.stringify({
            pageUrl: location.href,
            hasSingleSpaDevtools: hasSingleSpaDevtools,
            hasImportMapOverrides: !!imo,
            appCount: apps.length,
            activeOverrides: activeOverrides,
            apps: apps
          });
        })(${targetAppName})`;
                    const value = await evaluateJs(session, dashboardCode);
                    return {
                        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                    };
                }
                case 'clear_cache_and_reload': {
                    const legacyMode = args.mode;
                    const clearArg = args.clear;
                    const shouldReload = args.reload !== false;
                    let clearTypes;
                    if (clearArg) {
                        const raw = clearArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
                        clearTypes = new Set(raw.includes('all')
                            ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
                            : raw);
                    }
                    else if (legacyMode === 'aggressive') {
                        clearTypes = new Set(['cache', 'cookies']);
                    }
                    else {
                        clearTypes = new Set();
                    }
                    const origin = args.origin || await evaluateJs(session, 'window.location.origin');
                    const cleared = [];
                    if (clearTypes.has('cache')) {
                        await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, getCommandTimeout('Network.clearBrowserCache'));
                        cleared.push('cache (global)');
                    }
                    if (clearTypes.has('cookies')) {
                        const cookieResult = await sendCdpCommand(session, 'Network.getCookies');
                        const originHost = new URL(origin).hostname;
                        const matching = (cookieResult?.cookies || []).filter(c => {
                            const isDotPrefixed = c.domain.startsWith('.');
                            const cd = isDotPrefixed ? c.domain.slice(1) : c.domain;
                            if (isDotPrefixed && !originHost.includes('.'))
                                return false;
                            return originHost === cd || originHost.endsWith('.' + cd);
                        });
                        for (const c of matching) {
                            await sendCdpCommand(session, 'Network.deleteCookies', { name: c.name, domain: c.domain });
                        }
                        cleared.push(`cookies (${origin}, ${matching.length} removed)`);
                    }
                    const storageTypeParts = [];
                    if (clearTypes.has('local_storage'))
                        storageTypeParts.push('local_storage');
                    if (clearTypes.has('session_storage'))
                        storageTypeParts.push('session_storage');
                    if (clearTypes.has('cache_storage'))
                        storageTypeParts.push('cache_storage');
                    if (clearTypes.has('indexeddb'))
                        storageTypeParts.push('indexeddb');
                    if (clearTypes.has('service_workers'))
                        storageTypeParts.push('service_workers');
                    if (storageTypeParts.length > 0) {
                        await sendCdpCommand(session, 'Storage.clearDataForOrigin', { origin, storageTypes: storageTypeParts.join(',') });
                        cleared.push(`${storageTypeParts.join(', ')} (${origin})`);
                    }
                    if (shouldReload) {
                        await sendCdpCommand(session, 'Page.reload', { ignoreCache: true }, getCommandTimeout('Page.reload'));
                        await sleep(2000);
                        cleared.push('page reloaded');
                    }
                    const summary = cleared.length > 0 ? `Cleared: ${cleared.join('; ')}` : 'Page reloaded (no storage cleared)';
                    return {
                        content: [{ type: 'text', text: summary }],
                    };
                }
                case 'ensure_fresh_render': {
                    await sendCdpCommand(session, 'Page.reload', { ignoreCache: true }, getCommandTimeout('Page.reload'));
                    await sleep(2000);
                    return {
                        content: [{ type: 'text', text: 'Page reloaded with fresh cache' }],
                    };
                }
                case 'navigate': {
                    await sendCdpCommand(session, 'Page.navigate', { url: args.url }, getCommandTimeout('Page.navigate'));
                    await sleep(2000);
                    return {
                        content: [{ type: 'text', text: `Navigated to ${args.url}` }],
                    };
                }
                case 'override_app': {
                    const action = args.action;
                    const appName = args.appName;
                    const overrideUrl = args.url;
                    let code;
                    switch (action) {
                        case 'set':
                            if (!appName || !overrideUrl) {
                                return { content: [{ type: 'text', text: 'Error: "set" requires both appName and url' }] };
                            }
                            code = `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.addOverride(${JSON.stringify(appName)}, ${JSON.stringify(overrideUrl)});
              return JSON.stringify({ success: true, action: 'set', appName: ${JSON.stringify(appName)}, url: ${JSON.stringify(overrideUrl)} });
            })()`;
                            break;
                        case 'remove':
                            if (!appName) {
                                return { content: [{ type: 'text', text: 'Error: "remove" requires appName' }] };
                            }
                            code = `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.removeOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'remove', appName: ${JSON.stringify(appName)} });
            })()`;
                            break;
                        case 'enable':
                            if (!appName) {
                                return { content: [{ type: 'text', text: 'Error: "enable" requires appName' }] };
                            }
                            code = `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.enableOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'enable', appName: ${JSON.stringify(appName)} });
            })()`;
                            break;
                        case 'disable':
                            if (!appName) {
                                return { content: [{ type: 'text', text: 'Error: "disable" requires appName' }] };
                            }
                            code = `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.disableOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'disable', appName: ${JSON.stringify(appName)} });
            })()`;
                            break;
                        case 'reset_all':
                            code = `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.resetOverrides();
              return JSON.stringify({ success: true, action: 'reset_all' });
            })()`;
                            break;
                        default:
                            return { content: [{ type: 'text', text: 'Error: unknown action "' + action + '". Use: set, remove, enable, disable, reset_all' }] };
                    }
                    const value = await evaluateJs(session, code);
                    const resultText = typeof value === 'string' ? value : JSON.stringify(value);
                    // Auto-reload so the page reflects the new override state (matches DevTools panel behavior)
                    let reloaded = false;
                    try {
                        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                        if (parsed && parsed.success) {
                            await sendCdpCommand(session, 'Page.reload', { ignoreCache: true }, getCommandTimeout('Page.reload'));
                            await sleep(2000);
                            reloaded = true;
                        }
                    }
                    catch { /* parse failed – skip reload */ }
                    return {
                        content: [{ type: 'text', text: reloaded ? resultText + ' (page reloaded)' : resultText }],
                    };
                }
                case 'app_action': {
                    const action = args.action;
                    const appName = args.appName;
                    const actionCode = `(async function() {
          var singleSpa = window.__SINGLE_SPA_DEVTOOLS__;
          var exposedMethods = singleSpa && singleSpa.exposedMethods;
          if (!exposedMethods) return JSON.stringify({ success: false, error: 'single-spa devtools not available' });

          var rawApps = exposedMethods.getRawAppData() || [];
          var app = rawApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
          if (!app) return JSON.stringify({ success: false, error: 'App not found: ${appName.replace(/'/g, "\\'")}' });

          var action = ${JSON.stringify(action)};
          try {
            if (action === 'mount') {
              if (typeof app.devtools?.activeWhenForced === 'function') {
                app.devtools.activeWhenForced(true);
              }
              await exposedMethods.reroute();
            } else if (action === 'unmount') {
              if (typeof app.devtools?.activeWhenForced === 'function') {
                app.devtools.activeWhenForced(false);
              }
              await exposedMethods.reroute();
            } else if (action === 'unload') {
              if (typeof exposedMethods.toLoadPromise === 'function') {
                await exposedMethods.unregisterApplication(${JSON.stringify(appName)});
              }
              await exposedMethods.reroute();
            }
            var updatedApps = exposedMethods.getRawAppData() || [];
            var updatedApp = updatedApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
            return JSON.stringify({ success: true, action: action, appName: ${JSON.stringify(appName)}, newStatus: updatedApp ? updatedApp.status : 'UNKNOWN' });
          } catch (e) {
            return JSON.stringify({ success: false, error: e.message || String(e) });
          }
        })()`;
                    const value = await evaluateJs(session, actionCode);
                    return {
                        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
                    };
                }
                case 'debugger': {
                    const action = args.action;
                    switch (action) {
                        case 'enable': {
                            await sendCdpCommand(session, 'Debugger.enable');
                            await sendCdpCommand(session, 'Runtime.enable');
                            debuggerEnabled = true;
                            return { content: [{ type: 'text', text: 'Debugger enabled. Scripts will be parsed and breakpoints can be set.' }] };
                        }
                        case 'set_breakpoint': {
                            const file = args.file;
                            const line = args.line;
                            const condition = args.condition;
                            if (!file || !line)
                                return { content: [{ type: 'text', text: 'Error: set_breakpoint requires file and line' }] };
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                await sendCdpCommand(session, 'Runtime.enable');
                                debuggerEnabled = true;
                            }
                            const result = await sendCdpCommand(session, 'Debugger.setBreakpointByUrl', {
                                lineNumber: line - 1,
                                urlRegex: file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                                columnNumber: 0,
                                ...(condition ? { condition } : {}),
                            });
                            breakpoints.set(result.breakpointId, { id: result.breakpointId, file, line });
                            return { content: [{ type: 'text', text: `Breakpoint set: ${result.breakpointId} at ${file}:${line}${condition ? ` (condition: ${condition})` : ''}` }] };
                        }
                        case 'remove_breakpoint': {
                            const bpId = args.breakpointId;
                            if (!bpId)
                                return { content: [{ type: 'text', text: 'Error: remove_breakpoint requires breakpointId' }] };
                            await sendCdpCommand(session, 'Debugger.removeBreakpoint', { breakpointId: bpId });
                            breakpoints.delete(bpId);
                            return { content: [{ type: 'text', text: `Breakpoint removed: ${bpId}` }] };
                        }
                        case 'list_breakpoints': {
                            const bps = Array.from(breakpoints.values());
                            if (bps.length === 0)
                                return { content: [{ type: 'text', text: 'No active breakpoints.' }] };
                            const lines = bps.map(bp => `${bp.id}: ${bp.file}:${bp.line}`);
                            return { content: [{ type: 'text', text: `Active breakpoints (${bps.length}):\n${lines.join('\n')}` }] };
                        }
                        case 'resume': {
                            if (!debuggerPaused)
                                return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
                            await sendCdpCommand(session, 'Debugger.resume');
                            return { content: [{ type: 'text', text: 'Resumed execution.' }] };
                        }
                        case 'step_over': {
                            if (!debuggerPaused)
                                return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
                            await sendCdpCommand(session, 'Debugger.stepOver');
                            return { content: [{ type: 'text', text: 'Stepped over.' }] };
                        }
                        case 'step_into': {
                            if (!debuggerPaused)
                                return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
                            await sendCdpCommand(session, 'Debugger.stepInto');
                            return { content: [{ type: 'text', text: 'Stepped into.' }] };
                        }
                        case 'step_out': {
                            if (!debuggerPaused)
                                return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
                            await sendCdpCommand(session, 'Debugger.stepOut');
                            return { content: [{ type: 'text', text: 'Stepped out.' }] };
                        }
                        case 'inspect_variables': {
                            if (!debuggerPaused || !currentCallFrameId)
                                return { content: [{ type: 'text', text: 'Debugger is not paused at a breakpoint.' }] };
                            const evalResult = await sendCdpCommand(session, 'Debugger.evaluateOnCallFrame', {
                                callFrameId: currentCallFrameId,
                                expression: '(function(){ var __r = {}; try { var __s = arguments.callee.caller; } catch(e) {} return JSON.stringify(__r); })()',
                                returnByValue: true,
                            });
                            return { content: [{ type: 'text', text: evalResult?.result?.value ?? 'Unable to inspect variables (try using evaluate action instead)' }] };
                        }
                        case 'evaluate': {
                            const expression = args.expression;
                            if (!expression)
                                return { content: [{ type: 'text', text: 'Error: evaluate requires expression' }] };
                            let evalResult;
                            if (debuggerPaused && currentCallFrameId) {
                                evalResult = await sendCdpCommand(session, 'Debugger.evaluateOnCallFrame', {
                                    callFrameId: currentCallFrameId,
                                    expression,
                                    returnByValue: true,
                                    generatePreview: true,
                                });
                            }
                            else {
                                evalResult = await sendCdpCommand(session, 'Runtime.evaluate', {
                                    expression,
                                    returnByValue: true,
                                    awaitPromise: true,
                                });
                            }
                            const val = evalResult?.result?.value;
                            const text = val !== undefined ? (typeof val === 'string' ? val : JSON.stringify(val, null, 2)) : (evalResult?.result?.description || 'undefined');
                            return { content: [{ type: 'text', text }] };
                        }
                        case 'list_scripts': {
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                await sendCdpCommand(session, 'Runtime.enable');
                                debuggerEnabled = true;
                                await new Promise(r => setTimeout(r, 200));
                            }
                            const searchStr = (args.search || '').toLowerCase();
                            let scripts = Array.from(knownScripts.values());
                            if (searchStr)
                                scripts = scripts.filter(s => s.url.toLowerCase().includes(searchStr));
                            scripts = scripts.slice(0, 30);
                            if (scripts.length === 0)
                                return { content: [{ type: 'text', text: 'No scripts found.' }] };
                            const scriptLines = scripts.map(s => `${s.scriptId}: ${s.url}`);
                            return { content: [{ type: 'text', text: `Scripts (${scripts.length}):\n${scriptLines.join('\n')}` }] };
                        }
                        case 'pause_on_exceptions': {
                            const state = args.state || 'none';
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                debuggerEnabled = true;
                            }
                            await sendCdpCommand(session, 'Debugger.setPauseOnExceptions', { state });
                            return { content: [{ type: 'text', text: `Pause on exceptions: ${state}` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown debugger action: ${action}` }] };
                    }
                }
                case 'css_inspect': {
                    const selector = args.selector;
                    const requestedProps = (args.properties || '').split(',').map(p => p.trim()).filter(Boolean);
                    const defaultProps = [
                        'display', 'position', 'width', 'height', 'margin', 'padding',
                        'color', 'background-color', 'font-size', 'font-weight', 'font-family',
                        'border', 'border-radius', 'opacity', 'visibility', 'overflow',
                        'flex-direction', 'justify-content', 'align-items', 'gap',
                        'z-index', 'box-shadow', 'text-align',
                    ];
                    const propsToGet = requestedProps.length > 0 ? requestedProps : defaultProps;
                    const code = `(function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ error: 'Element not found: ' + ${JSON.stringify(selector)} });
          var cs = getComputedStyle(el);
          var result = {};
          ${JSON.stringify(propsToGet)}.forEach(function(p) { result[p] = cs.getPropertyValue(p); });
          result.__tagName = el.tagName.toLowerCase();
          result.__className = el.className || '';
          result.__id = el.id || '';
          var rect = el.getBoundingClientRect();
          result.__bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          return JSON.stringify(result);
        })()`;
                    const value = await evaluateJs(session, code);
                    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                    if (parsed?.error)
                        return { content: [{ type: 'text', text: parsed.error }] };
                    const tag = parsed.__tagName;
                    const id = parsed.__id ? `#${parsed.__id}` : '';
                    const cls = parsed.__className ? `.${parsed.__className.split(' ').join('.')}` : '';
                    const bounds = parsed.__bounds;
                    const header = `Element: <${tag}${id}${cls}> (${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y})`;
                    delete parsed.__tagName;
                    delete parsed.__className;
                    delete parsed.__id;
                    delete parsed.__bounds;
                    const propLines = Object.entries(parsed)
                        .filter(([, v]) => v !== '' && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== 'visible' && v !== '0px')
                        .map(([k, v]) => `  ${k}: ${v}`);
                    return { content: [{ type: 'text', text: `${header}\n\nComputed styles:\n${propLines.join('\n') || '  (no non-default styles)'}` }] };
                }
                case 'session_manager': {
                    const action = args.action;
                    const sessionId = args.sessionId;
                    switch (action) {
                        case 'list': {
                            const sessions = executorManager.listSessions();
                            if (sessions.length === 0)
                                return { content: [{ type: 'text', text: 'No active sessions.' }] };
                            const lines = sessions.map(s => `${s.id}: connected=${s.connected}, stateKeys=[${s.stateKeys.join(', ')}]`);
                            return { content: [{ type: 'text', text: `Sessions (${sessions.length}):\n${lines.join('\n')}` }] };
                        }
                        case 'create': {
                            if (!sessionId)
                                return { content: [{ type: 'text', text: 'Error: create requires sessionId' }] };
                            const existing = executorManager.get(sessionId);
                            if (existing)
                                return { content: [{ type: 'text', text: `Session "${sessionId}" already exists.` }] };
                            executorManager.getOrCreate(sessionId);
                            return { content: [{ type: 'text', text: `Session "${sessionId}" created.` }] };
                        }
                        case 'switch': {
                            if (!sessionId)
                                return { content: [{ type: 'text', text: 'Error: switch requires sessionId' }] };
                            const executor = executorManager.get(sessionId);
                            if (!executor)
                                return { content: [{ type: 'text', text: `Session "${sessionId}" not found. Use "create" first.` }] };
                            return { content: [{ type: 'text', text: `Switched to session "${sessionId}". Use playwright_execute with this session context.` }] };
                        }
                        case 'remove': {
                            if (!sessionId)
                                return { content: [{ type: 'text', text: 'Error: remove requires sessionId' }] };
                            const removed = await executorManager.remove(sessionId);
                            return { content: [{ type: 'text', text: removed ? `Session "${sessionId}" removed.` : `Session "${sessionId}" not found.` }] };
                        }
                        case 'remove_all': {
                            const count = executorManager.size;
                            await executorManager.resetAll();
                            return { content: [{ type: 'text', text: `All ${count} sessions removed.` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown session action: ${action}. Use: list, create, switch, remove, remove_all` }] };
                    }
                }
                case 'storage': {
                    const action = args.action;
                    switch (action) {
                        case 'get_cookies': {
                            const result = await sendCdpCommand(session, 'Network.getCookies');
                            const cookies = result?.cookies || [];
                            if (cookies.length === 0)
                                return { content: [{ type: 'text', text: 'No cookies found.' }] };
                            const lines = cookies.map(c => `${c.name}=${String(c.value).slice(0, 80)}${String(c.value).length > 80 ? '...' : ''} (domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite || 'None'})`);
                            return { content: [{ type: 'text', text: `Cookies (${cookies.length}):\n${lines.join('\n')}` }] };
                        }
                        case 'set_cookie': {
                            const cookieName = args.name;
                            const cookieValue = args.value;
                            if (!cookieName || cookieValue === undefined)
                                return { content: [{ type: 'text', text: 'Error: set_cookie requires name and value' }] };
                            const cookieParams = { name: cookieName, value: cookieValue };
                            if (args.domain)
                                cookieParams.domain = args.domain;
                            if (args.url)
                                cookieParams.url = args.url;
                            if (args.path)
                                cookieParams.path = args.path;
                            if (args.secure !== undefined)
                                cookieParams.secure = args.secure;
                            if (args.httpOnly !== undefined)
                                cookieParams.httpOnly = args.httpOnly;
                            if (args.sameSite)
                                cookieParams.sameSite = args.sameSite;
                            if (args.expires)
                                cookieParams.expires = args.expires;
                            if (!cookieParams.url && !cookieParams.domain) {
                                const pageUrl = await evaluateJs(session, 'window.location.href');
                                cookieParams.url = pageUrl;
                            }
                            const result = await sendCdpCommand(session, 'Network.setCookie', cookieParams);
                            return { content: [{ type: 'text', text: result?.success ? `Cookie "${cookieName}" set.` : `Failed to set cookie "${cookieName}".` }] };
                        }
                        case 'delete_cookie': {
                            const cookieName = args.name;
                            if (!cookieName)
                                return { content: [{ type: 'text', text: 'Error: delete_cookie requires name' }] };
                            const delParams = { name: cookieName };
                            if (args.domain)
                                delParams.domain = args.domain;
                            if (args.url)
                                delParams.url = args.url;
                            if (args.path)
                                delParams.path = args.path;
                            if (!delParams.url && !delParams.domain) {
                                const pageUrl = await evaluateJs(session, 'window.location.href');
                                delParams.url = pageUrl;
                            }
                            await sendCdpCommand(session, 'Network.deleteCookies', delParams);
                            return { content: [{ type: 'text', text: `Cookie "${cookieName}" deleted.` }] };
                        }
                        case 'get_local_storage':
                        case 'get_session_storage': {
                            const isLocal = action === 'get_local_storage';
                            const storageType = isLocal ? 'localStorage' : 'sessionStorage';
                            const key = args.key;
                            if (key) {
                                const val = await evaluateJs(session, `${storageType}.getItem(${JSON.stringify(key)})`);
                                return { content: [{ type: 'text', text: val !== null ? `${storageType}[${key}] = ${String(val)}` : `${storageType}[${key}] = (not set)` }] };
                            }
                            const result = await evaluateJs(session, `JSON.stringify(Object.fromEntries(Object.entries(${storageType})))`);
                            const parsed = typeof result === 'string' ? JSON.parse(result) : {};
                            const entries = Object.entries(parsed);
                            if (entries.length === 0)
                                return { content: [{ type: 'text', text: `${storageType} is empty.` }] };
                            const lines = entries.map(([k, v]) => {
                                const vs = String(v);
                                return `  ${k}: ${vs.slice(0, 200)}${vs.length > 200 ? '...' : ''}`;
                            });
                            return { content: [{ type: 'text', text: `${storageType} (${entries.length} entries):\n${lines.join('\n')}` }] };
                        }
                        case 'set_local_storage': {
                            const key = args.key;
                            const val = args.value;
                            if (!key || val === undefined)
                                return { content: [{ type: 'text', text: 'Error: set_local_storage requires key and value' }] };
                            await evaluateJs(session, `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(val)})`);
                            return { content: [{ type: 'text', text: `localStorage[${key}] set.` }] };
                        }
                        case 'remove_local_storage': {
                            const key = args.key;
                            if (!key)
                                return { content: [{ type: 'text', text: 'Error: remove_local_storage requires key' }] };
                            await evaluateJs(session, `localStorage.removeItem(${JSON.stringify(key)})`);
                            return { content: [{ type: 'text', text: `localStorage[${key}] removed.` }] };
                        }
                        case 'clear_storage': {
                            const origin = args.origin || await evaluateJs(session, 'window.location.origin');
                            const types = args.storage_types || 'all';
                            await sendCdpCommand(session, 'Storage.clearDataForOrigin', { origin, storageTypes: types });
                            return { content: [{ type: 'text', text: `Storage cleared for ${origin} (types: ${types}).` }] };
                        }
                        case 'get_storage_usage': {
                            const origin = args.origin || await evaluateJs(session, 'window.location.origin');
                            const result = await sendCdpCommand(session, 'Storage.getUsageAndQuota', { origin });
                            const total = `Usage: ${(result.usage / 1024).toFixed(1)}KB / ${(result.quota / (1024 * 1024)).toFixed(1)}MB (${((result.usage / result.quota) * 100).toFixed(1)}%)`;
                            const breakdown = (result.usageBreakdown || [])
                                .filter(b => b.usage > 0)
                                .map(b => `  ${b.storageType}: ${(b.usage / 1024).toFixed(1)}KB`)
                                .join('\n');
                            return { content: [{ type: 'text', text: `${total}${breakdown ? '\n\nBreakdown:\n' + breakdown : ''}` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown storage action: ${action}` }] };
                    }
                }
                case 'performance': {
                    const action = args.action;
                    switch (action) {
                        case 'get_metrics': {
                            await sendCdpCommand(session, 'Performance.enable');
                            const result = await sendCdpCommand(session, 'Performance.getMetrics');
                            await sendCdpCommand(session, 'Performance.disable');
                            const metrics = result?.metrics || [];
                            if (metrics.length === 0)
                                return { content: [{ type: 'text', text: 'No metrics available.' }] };
                            const keyMetrics = ['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount',
                                'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
                                'JSHeapUsedSize', 'JSHeapTotalSize'];
                            const lines = metrics
                                .filter(m => keyMetrics.includes(m.name))
                                .map(m => {
                                if (m.name.includes('HeapUsedSize') || m.name.includes('HeapTotalSize'))
                                    return `  ${m.name}: ${(m.value / (1024 * 1024)).toFixed(2)}MB`;
                                if (m.name.includes('Duration'))
                                    return `  ${m.name}: ${(m.value * 1000).toFixed(1)}ms`;
                                return `  ${m.name}: ${m.value}`;
                            });
                            return { content: [{ type: 'text', text: `Performance Metrics:\n${lines.join('\n')}` }] };
                        }
                        case 'get_web_vitals': {
                            const code = `JSON.stringify({
              lcp: window.__spawriter_lcp || null,
              cls: window.__spawriter_cls || null,
              inp: window.__spawriter_inp || null,
              fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null,
              ttfb: performance.getEntriesByType('navigation')[0]?.responseStart || null,
              domInteractive: performance.getEntriesByType('navigation')[0]?.domInteractive || null,
              domComplete: performance.getEntriesByType('navigation')[0]?.domComplete || null,
              loadTime: performance.getEntriesByType('navigation')[0]?.loadEventEnd || null,
            })`;
                            const raw = await evaluateJs(session, code);
                            const vitals = typeof raw === 'string' ? JSON.parse(raw) : {};
                            const fmt = (val, unit, good, poor) => {
                                if (val === null || val === undefined)
                                    return '(not measured)';
                                const s = unit === 'ms' ? `${val.toFixed(0)}ms` : val.toFixed(3);
                                const grade = val <= good ? '✅ Good' : val <= poor ? '⚠️ Needs Improvement' : '❌ Poor';
                                return `${s} ${grade}`;
                            };
                            const lines = [
                                `  LCP: ${fmt(vitals.lcp, 'ms', 2500, 4000)}`,
                                `  CLS: ${fmt(vitals.cls, '', 0.1, 0.25)}`,
                                `  INP: ${fmt(vitals.inp, 'ms', 200, 500)}`,
                                `  FCP: ${vitals.fcp ? `${vitals.fcp.toFixed(0)}ms` : '(not available)'}`,
                                `  TTFB: ${vitals.ttfb ? `${vitals.ttfb.toFixed(0)}ms` : '(not available)'}`,
                                `  DOM Interactive: ${vitals.domInteractive ? `${vitals.domInteractive.toFixed(0)}ms` : '(n/a)'}`,
                                `  DOM Complete: ${vitals.domComplete ? `${vitals.domComplete.toFixed(0)}ms` : '(n/a)'}`,
                                `  Load: ${vitals.loadTime ? `${vitals.loadTime.toFixed(0)}ms` : '(n/a)'}`,
                            ];
                            const observerCode = `
              if (!window.__spawriter_lcp_obs) {
                window.__spawriter_lcp = 0; window.__spawriter_cls = 0; window.__spawriter_inp = Infinity;
                new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_lcp = e.startTime; }).observe({type:'largest-contentful-paint',buffered:true});
                new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_cls += e.value; }).observe({type:'layout-shift',buffered:true});
                new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_inp = Math.min(window.__spawriter_inp, e.duration); }).observe({type:'event',buffered:true,durationThreshold:16});
                window.__spawriter_lcp_obs = true;
              }
              'observers_active'`;
                            await evaluateJs(session, observerCode);
                            return { content: [{ type: 'text', text: `Web Vitals:\n${lines.join('\n')}\n\n(Note: LCP/CLS/INP require observers — run this tool again for updated values after page interaction.)` }] };
                        }
                        case 'get_memory': {
                            await sendCdpCommand(session, 'Performance.enable');
                            const result = await sendCdpCommand(session, 'Performance.getMetrics');
                            await sendCdpCommand(session, 'Performance.disable');
                            const m = Object.fromEntries((result?.metrics || []).map(x => [x.name, x.value]));
                            const heapUsed = m['JSHeapUsedSize'] || 0;
                            const heapTotal = m['JSHeapTotalSize'] || 0;
                            const nodes = m['Nodes'] || 0;
                            const listeners = m['JSEventListeners'] || 0;
                            const docs = m['Documents'] || 0;
                            const frames = m['Frames'] || 0;
                            return { content: [{ type: 'text', text: `Memory:\n  JS Heap: ${(heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(heapTotal / (1024 * 1024)).toFixed(2)}MB (${heapTotal > 0 ? ((heapUsed / heapTotal) * 100).toFixed(1) : 0}%)\n  DOM Nodes: ${nodes}\n  Event Listeners: ${listeners}\n  Documents: ${docs}\n  Frames: ${frames}` }] };
                        }
                        case 'get_resource_timing': {
                            const count = args.count || 20;
                            const typeFilter = args.type_filter || '';
                            const code = `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
              name: e.name, type: e.initiatorType, duration: e.duration,
              transferSize: e.transferSize, decodedBodySize: e.decodedBodySize,
              startTime: e.startTime
            })))`;
                            const raw = await evaluateJs(session, code);
                            let resources = typeof raw === 'string' ? JSON.parse(raw) : [];
                            if (typeFilter)
                                resources = resources.filter(r => r.type.toLowerCase().includes(typeFilter.toLowerCase()));
                            resources.sort((a, b) => b.duration - a.duration);
                            resources = resources.slice(0, count);
                            if (resources.length === 0)
                                return { content: [{ type: 'text', text: 'No resource timing entries found.' }] };
                            const lines = resources.map(r => {
                                const url = r.name.length > 80 ? '...' + r.name.slice(-77) : r.name;
                                return `  ${r.duration.toFixed(0).padStart(6)}ms  ${(r.transferSize / 1024).toFixed(1).padStart(7)}KB  ${r.type.padEnd(12)}  ${url}`;
                            });
                            return { content: [{ type: 'text', text: `Resource Timing (top ${resources.length} by duration):\n  ${' '.padEnd(6)}ms  ${' '.padEnd(7)}KB  ${'type'.padEnd(12)}  URL\n${lines.join('\n')}` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown performance action: ${action}` }] };
                    }
                }
                case 'editor': {
                    const action = args.action;
                    switch (action) {
                        case 'list_sources': {
                            const search = (args.search || '').toLowerCase();
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                await sendCdpCommand(session, 'Runtime.enable');
                                debuggerEnabled = true;
                                await new Promise(r => setTimeout(r, 200));
                            }
                            let scripts = Array.from(knownScripts.values()).filter(s => s.url && !s.url.startsWith('chrome-extension://'));
                            if (search)
                                scripts = scripts.filter(s => s.url.toLowerCase().includes(search));
                            scripts = scripts.slice(0, 50);
                            if (scripts.length === 0)
                                return { content: [{ type: 'text', text: 'No scripts found.' }] };
                            const lines = scripts.map(s => `  [${s.scriptId}] ${s.url}`);
                            return { content: [{ type: 'text', text: `Scripts (${scripts.length}):\n${lines.join('\n')}` }] };
                        }
                        case 'get_source': {
                            const scriptId = args.scriptId;
                            if (!scriptId)
                                return { content: [{ type: 'text', text: 'Error: get_source requires scriptId' }] };
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                debuggerEnabled = true;
                            }
                            const result = await sendCdpCommand(session, 'Debugger.getScriptSource', { scriptId });
                            let source = result?.scriptSource || '(empty)';
                            const lineStart = args.line_start;
                            const lineEnd = args.line_end;
                            if (lineStart || lineEnd) {
                                const srcLines = source.split('\n');
                                const start = Math.max(1, lineStart || 1) - 1;
                                const end = Math.min(srcLines.length, lineEnd || srcLines.length);
                                source = srcLines.slice(start, end).map((l, i) => `${(start + i + 1).toString().padStart(5)}| ${l}`).join('\n');
                            }
                            else if (source.length > 50000) {
                                source = source.slice(0, 50000) + `\n[Truncated to 50000 chars. Use line_start/line_end for specific ranges.]`;
                            }
                            return { content: [{ type: 'text', text: source }] };
                        }
                        case 'edit_source': {
                            const scriptId = args.scriptId;
                            const content = args.content;
                            if (!scriptId || !content)
                                return { content: [{ type: 'text', text: 'Error: edit_source requires scriptId and content' }] };
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                debuggerEnabled = true;
                            }
                            try {
                                await sendCdpCommand(session, 'Debugger.setScriptSource', { scriptId, scriptSource: content });
                                return { content: [{ type: 'text', text: `Script ${scriptId} updated (hot-reload applied).` }] };
                            }
                            catch (e) {
                                const code = `
                try {
                  const s = document.createElement('script');
                  s.textContent = ${JSON.stringify(content)};
                  document.head.appendChild(s);
                  'Script injected via DOM.'
                } catch(e) { 'Fallback failed: ' + e.message }`;
                                const fb = await evaluateJs(session, code);
                                return { content: [{ type: 'text', text: `setScriptSource failed (${String(e)}). Fallback: ${fb}` }] };
                            }
                        }
                        case 'search_source': {
                            const search = args.search;
                            if (!search)
                                return { content: [{ type: 'text', text: 'Error: search_source requires search string' }] };
                            if (!debuggerEnabled) {
                                await sendCdpCommand(session, 'Debugger.enable');
                                debuggerEnabled = true;
                                await new Promise(r => setTimeout(r, 200));
                            }
                            const scripts = Array.from(knownScripts.values()).filter(s => s.url && !s.url.startsWith('chrome-extension://'));
                            const matches = [];
                            for (const s of scripts.slice(0, 30)) {
                                try {
                                    const result = await sendCdpCommand(session, 'Debugger.searchInContent', { scriptId: s.scriptId, query: search });
                                    if (result?.result?.length) {
                                        matches.push(`${s.url} (${result.result.length} matches):`);
                                        for (const m of result.result.slice(0, 5)) {
                                            matches.push(`  L${m.lineNumber + 1}: ${m.lineContent.trim().slice(0, 120)}`);
                                        }
                                        if (result.result.length > 5)
                                            matches.push(`  ... and ${result.result.length - 5} more`);
                                    }
                                }
                                catch { /* skip scripts that can't be searched */ }
                            }
                            return { content: [{ type: 'text', text: matches.length > 0 ? `Search results for "${search}":\n${matches.join('\n')}` : `No results for "${search}" in loaded scripts.` }] };
                        }
                        case 'list_stylesheets': {
                            await sendCdpCommand(session, 'CSS.enable');
                            await sendCdpCommand(session, 'DOM.enable');
                            const result = await sendCdpCommand(session, 'CSS.getStyleSheets' in {} ? 'CSS.getStyleSheets' : 'Runtime.evaluate', {
                                expression: `JSON.stringify(Array.from(document.styleSheets).map((s, i) => ({ id: i, href: s.href || '(inline)', disabled: s.disabled, rules: s.cssRules?.length || 0 })))`,
                                returnByValue: true,
                            });
                            const sheets = typeof result?.result?.value === 'string'
                                ? JSON.parse((result?.result).value)
                                : [];
                            if (sheets.length === 0)
                                return { content: [{ type: 'text', text: 'No stylesheets found.' }] };
                            const lines = sheets.map((s) => `  [${s.id}] ${s.href} (${s.rules} rules${s.disabled ? ', disabled' : ''})`);
                            return { content: [{ type: 'text', text: `Stylesheets (${sheets.length}):\n${lines.join('\n')}` }] };
                        }
                        case 'get_stylesheet': {
                            const idx = args.styleSheetId;
                            if (idx === undefined)
                                return { content: [{ type: 'text', text: 'Error: get_stylesheet requires styleSheetId' }] };
                            const code = `(() => {
              const s = document.styleSheets[${parseInt(idx, 10)}];
              if (!s) return 'Stylesheet not found.';
              try { return Array.from(s.cssRules).map(r => r.cssText).join('\\n'); }
              catch(e) { return 'Cannot read rules (CORS): ' + e.message; }
            })()`;
                            let cssText = await evaluateJs(session, code);
                            if (cssText.length > 50000)
                                cssText = cssText.slice(0, 50000) + '\n[Truncated]';
                            return { content: [{ type: 'text', text: cssText }] };
                        }
                        case 'edit_stylesheet': {
                            const idx = args.styleSheetId;
                            const content = args.content;
                            if (idx === undefined || !content)
                                return { content: [{ type: 'text', text: 'Error: edit_stylesheet requires styleSheetId and content' }] };
                            const code = `(() => {
              const s = document.styleSheets[${parseInt(idx, 10)}];
              if (!s) return 'Stylesheet not found.';
              while (s.cssRules.length > 0) s.deleteRule(0);
              const rules = ${JSON.stringify(content)}.split('}').filter(r => r.trim());
              rules.forEach(r => { try { s.insertRule(r.trim() + '}', s.cssRules.length); } catch(e) {} });
              return 'Stylesheet updated (' + s.cssRules.length + ' rules applied).';
            })()`;
                            const result = await evaluateJs(session, code);
                            return { content: [{ type: 'text', text: String(result) }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown editor action: ${action}` }] };
                    }
                }
                case 'network_intercept': {
                    const action = args.action;
                    switch (action) {
                        case 'enable': {
                            const patterns = [{ urlPattern: args.url_pattern || '*', requestStage: 'Request' }];
                            await sendCdpCommand(session, 'Fetch.enable', { patterns });
                            interceptEnabled = true;
                            return { content: [{ type: 'text', text: `Network interception enabled. ${interceptRules.size} rules active.` }] };
                        }
                        case 'disable': {
                            await sendCdpCommand(session, 'Fetch.disable');
                            interceptEnabled = false;
                            return { content: [{ type: 'text', text: 'Network interception disabled.' }] };
                        }
                        case 'list_rules': {
                            const rules = Array.from(interceptRules.values());
                            if (rules.length === 0)
                                return { content: [{ type: 'text', text: `No intercept rules. Interception is ${interceptEnabled ? 'enabled' : 'disabled'}.` }] };
                            const lines = rules.map(r => {
                                const parts = [`[${r.id}] pattern="${r.urlPattern}"`];
                                if (r.resourceType)
                                    parts.push(`type=${r.resourceType}`);
                                if (r.block)
                                    parts.push('→ BLOCK');
                                else if (r.mockStatus !== undefined)
                                    parts.push(`→ mock ${r.mockStatus}`);
                                return parts.join(' ');
                            });
                            return { content: [{ type: 'text', text: `Intercept rules (${rules.length}, ${interceptEnabled ? 'enabled' : 'disabled'}):\n${lines.join('\n')}` }] };
                        }
                        case 'add_rule': {
                            const urlPattern = args.url_pattern;
                            if (!urlPattern)
                                return { content: [{ type: 'text', text: 'Error: add_rule requires url_pattern' }] };
                            const ruleId = `rule_${interceptNextId++}`;
                            const rule = { id: ruleId, urlPattern, resourceType: args.resource_type };
                            if (args.block) {
                                rule.block = true;
                            }
                            else if (args.mock_status !== undefined) {
                                rule.mockStatus = args.mock_status;
                                if (args.mock_headers)
                                    rule.mockHeaders = JSON.parse(args.mock_headers);
                                if (args.mock_body !== undefined)
                                    rule.mockBody = args.mock_body;
                            }
                            interceptRules.set(ruleId, rule);
                            return { content: [{ type: 'text', text: `Rule added: ${ruleId} (pattern="${urlPattern}"${rule.block ? ', block' : ''}${rule.mockStatus !== undefined ? `, mock ${rule.mockStatus}` : ''})` }] };
                        }
                        case 'remove_rule': {
                            const ruleId = args.rule_id;
                            if (!ruleId)
                                return { content: [{ type: 'text', text: 'Error: remove_rule requires rule_id' }] };
                            const removed = interceptRules.delete(ruleId);
                            return { content: [{ type: 'text', text: removed ? `Rule ${ruleId} removed.` : `Rule ${ruleId} not found.` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown intercept action: ${action}` }] };
                    }
                }
                case 'emulation': {
                    const action = args.action;
                    switch (action) {
                        case 'set_device': {
                            const width = args.width || 375;
                            const height = args.height || 812;
                            const dpr = args.device_scale_factor || 1;
                            const mobile = args.mobile ?? false;
                            await sendCdpCommand(session, 'Emulation.setDeviceMetricsOverride', {
                                width, height, deviceScaleFactor: dpr, mobile,
                            });
                            return { content: [{ type: 'text', text: `Device emulation: ${width}x${height} @${dpr}x${mobile ? ' (mobile)' : ''}` }] };
                        }
                        case 'set_user_agent': {
                            const ua = args.user_agent;
                            if (!ua)
                                return { content: [{ type: 'text', text: 'Error: set_user_agent requires user_agent' }] };
                            await sendCdpCommand(session, 'Emulation.setUserAgentOverride', { userAgent: ua });
                            return { content: [{ type: 'text', text: `User agent set.` }] };
                        }
                        case 'set_geolocation': {
                            const lat = args.latitude;
                            const lng = args.longitude;
                            if (lat === undefined || lng === undefined)
                                return { content: [{ type: 'text', text: 'Error: set_geolocation requires latitude and longitude' }] };
                            await sendCdpCommand(session, 'Emulation.setGeolocationOverride', {
                                latitude: lat, longitude: lng, accuracy: args.accuracy || 1,
                            });
                            return { content: [{ type: 'text', text: `Geolocation: ${lat}, ${lng}` }] };
                        }
                        case 'set_timezone': {
                            const tz = args.timezone_id;
                            if (!tz)
                                return { content: [{ type: 'text', text: 'Error: set_timezone requires timezone_id' }] };
                            await sendCdpCommand(session, 'Emulation.setTimezoneOverride', { timezoneId: tz });
                            return { content: [{ type: 'text', text: `Timezone: ${tz}` }] };
                        }
                        case 'set_locale': {
                            const loc = args.locale;
                            if (!loc)
                                return { content: [{ type: 'text', text: 'Error: set_locale requires locale' }] };
                            await sendCdpCommand(session, 'Emulation.setLocaleOverride', { locale: loc });
                            return { content: [{ type: 'text', text: `Locale: ${loc}` }] };
                        }
                        case 'set_network_conditions': {
                            const presets = {
                                'offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
                                'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
                                'fast-3g': { offline: false, latency: 562, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
                                '4g': { offline: false, latency: 170, downloadThroughput: 1.5 * 1024 * 1024, uploadThroughput: 750 * 1024 },
                                'wifi': { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024, uploadThroughput: 15 * 1024 * 1024 },
                            };
                            const preset = args.preset;
                            const params = preset && presets[preset]
                                ? presets[preset]
                                : {
                                    offline: false,
                                    latency: args.latency || 0,
                                    downloadThroughput: args.download || -1,
                                    uploadThroughput: args.upload || -1,
                                };
                            await sendCdpCommand(session, 'Network.emulateNetworkConditions', params);
                            return { content: [{ type: 'text', text: `Network: ${preset || 'custom'} (latency=${params.latency}ms, down=${params.downloadThroughput > 0 ? (params.downloadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'}, up=${params.uploadThroughput > 0 ? (params.uploadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'})` }] };
                        }
                        case 'set_media': {
                            const features = (args.features || '').split(',').filter(f => f.includes(':')).map(f => {
                                const [n, v] = f.trim().split(':');
                                return { name: n.trim(), value: v.trim() };
                            });
                            await sendCdpCommand(session, 'Emulation.setEmulatedMedia', { features });
                            return { content: [{ type: 'text', text: `Media features: ${features.map(f => `${f.name}:${f.value}`).join(', ') || '(cleared)'}` }] };
                        }
                        case 'clear_all': {
                            await sendCdpCommand(session, 'Emulation.clearDeviceMetricsOverride');
                            await sendCdpCommand(session, 'Emulation.setEmulatedMedia', { features: [] });
                            try {
                                await sendCdpCommand(session, 'Emulation.clearGeolocationOverride');
                            }
                            catch { /* ok */ }
                            try {
                                await sendCdpCommand(session, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
                            }
                            catch { /* ok */ }
                            return { content: [{ type: 'text', text: 'All emulations cleared.' }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown emulation action: ${action}` }] };
                    }
                }
                case 'page_content': {
                    const action = args.action;
                    const selector = args.selector || 'body';
                    const maxLength = args.max_length || 50000;
                    switch (action) {
                        case 'get_html': {
                            const includeStyles = args.include_styles ?? false;
                            const code = includeStyles
                                ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || '(element not found)'`
                                : `(() => {
                  const el = document.querySelector(${JSON.stringify(selector)});
                  if (!el) return '(element not found)';
                  const clone = el.cloneNode(true);
                  clone.querySelectorAll('[style]').forEach(e => e.removeAttribute('style'));
                  clone.querySelectorAll('script,noscript').forEach(e => e.remove());
                  return clone.outerHTML;
                })()`;
                            let html = await evaluateJs(session, code);
                            if (html.length > maxLength)
                                html = html.slice(0, maxLength) + `\n[Truncated to ${maxLength} chars]`;
                            return { content: [{ type: 'text', text: html }] };
                        }
                        case 'get_text': {
                            const code = `document.querySelector(${JSON.stringify(selector)})?.innerText || '(element not found)'`;
                            let text = await evaluateJs(session, code);
                            if (text.length > maxLength)
                                text = text.slice(0, maxLength) + `\n[Truncated to ${maxLength} chars]`;
                            return { content: [{ type: 'text', text }] };
                        }
                        case 'get_metadata': {
                            const code = `JSON.stringify({
              title: document.title,
              url: location.href,
              description: document.querySelector('meta[name="description"]')?.content || null,
              charset: document.characterSet,
              lang: document.documentElement.lang || null,
              viewport: document.querySelector('meta[name="viewport"]')?.content || null,
              ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
              ogDescription: document.querySelector('meta[property="og:description"]')?.content || null,
              ogImage: document.querySelector('meta[property="og:image"]')?.content || null,
              canonical: document.querySelector('link[rel="canonical"]')?.href || null,
              favicon: document.querySelector('link[rel="icon"]')?.href || document.querySelector('link[rel="shortcut icon"]')?.href || null,
              scripts: document.querySelectorAll('script[src]').length,
              stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length,
              images: document.querySelectorAll('img').length,
              links: document.querySelectorAll('a[href]').length,
            })`;
                            const raw = await evaluateJs(session, code);
                            const meta = typeof raw === 'string' ? JSON.parse(raw) : {};
                            const lines = Object.entries(meta)
                                .filter(([, v]) => v !== null && v !== undefined)
                                .map(([k, v]) => `  ${k}: ${v}`);
                            return { content: [{ type: 'text', text: `Page Metadata:\n${lines.join('\n')}` }] };
                        }
                        case 'search_dom': {
                            const search = args.search;
                            if (!search)
                                return { content: [{ type: 'text', text: 'Error: search_dom requires search string' }] };
                            const code = `(() => {
              const results = [];
              const walker = document.createTreeWalker(document.querySelector(${JSON.stringify(selector)}) || document.body, NodeFilter.SHOW_ELEMENT);
              const needle = ${JSON.stringify(search.toLowerCase())};
              while (walker.nextNode()) {
                const el = walker.currentNode;
                const tag = el.tagName.toLowerCase();
                const id = el.id ? '#' + el.id : '';
                const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
                const text = (el.textContent || '').slice(0, 200).trim();
                const attrs = Array.from(el.attributes).map(a => a.name + '="' + a.value + '"').join(' ');
                const match = tag.includes(needle) || id.toLowerCase().includes(needle) ||
                  cls.toLowerCase().includes(needle) || text.toLowerCase().includes(needle) ||
                  attrs.toLowerCase().includes(needle);
                if (match) {
                  results.push('<' + tag + id + cls + '> ' + text.slice(0, 100));
                  if (results.length >= 50) break;
                }
              }
              return JSON.stringify(results);
            })()`;
                            const raw = await evaluateJs(session, code);
                            const results = typeof raw === 'string' ? JSON.parse(raw) : [];
                            if (results.length === 0)
                                return { content: [{ type: 'text', text: `No elements found matching "${search}".` }] };
                            return { content: [{ type: 'text', text: `DOM search for "${search}" (${results.length} results):\n${results.map(r => `  ${r}`).join('\n')}` }] };
                        }
                        default:
                            return { content: [{ type: 'text', text: `Unknown page_content action: ${action}` }] };
                    }
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                    };
            }
        }
        catch (e) {
            error(`Error executing tool ${name}:`, e);
            cdpSession = null;
            return {
                content: [{ type: 'text', text: `Error: ${String(e)}` }],
                isError: true,
            };
        }
    }; // end handleToolCall
    try {
        return await withTimeout(handleToolCall(), MCP_REQUEST_TIMEOUT, name);
    }
    catch (e) {
        error(`Tool ${name} global timeout:`, e);
        return {
            content: [{ type: 'text', text: `Error: ${String(e)}` }],
            isError: true,
        };
    }
});
async function main() {
    log('Starting MCP server...');
    process.on('uncaughtException', (err) => {
        error('Uncaught exception (recovered):', err.message);
        if (cdpSession) {
            cdpSession.ws.close();
            cdpSession = null;
        }
    });
    process.on('unhandledRejection', (reason) => {
        error('Unhandled rejection (recovered):', String(reason));
    });
    ensureRelayServer().catch((e) => {
        log('Relay server pre-start failed (will retry on first tool call):', String(e));
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('MCP server ready');
    process.on('SIGINT', async () => {
        log('Shutting down...');
        if (cdpSession) {
            await releaseAllMyLeases(cdpSession).catch(() => { });
            cdpSession.ws.close();
        }
        process.exit(0);
    });
}
export async function startMcpServer() {
    await main();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        error('Fatal error:', e);
        process.exit(1);
    });
}
//# sourceMappingURL=mcp.js.map