import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { getRelayPort, getRelayToken, log, error, sleep, VERSION, } from './utils.js';
let relayServerProcess = null;
let cdpSession = null;
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
    const baseUrl = `ws://127.0.0.1:${port}/cdp/mcp-client`;
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
                    }
                }
                catch {
                    // ignore parse errors
                }
            });
            ws.on('close', () => {
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
async function ensureSession() {
    if (cdpSession?.ws.readyState === WebSocket.OPEN) {
        return cdpSession;
    }
    cdpSession = null;
    await ensureRelayServer();
    let targets = await getTargets();
    if (targets.length === 0) {
        log('No targets found, requesting extension to attach active tab...');
        await requestExtensionAttachTab();
        for (let i = 0; i < 10 && targets.length === 0; i++) {
            await sleep(1000);
            targets = await getTargets();
        }
    }
    if (targets.length === 0) {
        throw new Error('No browser tab attached. Click the extension toolbar icon on a web page tab to attach it, then retry.');
    }
    const sessionId = targets[0].id;
    log('Connecting to CDP relay, target:', targets[0].url);
    cdpSession = await connectCdp(sessionId);
    log('CDP session established');
    return cdpSession;
}
async function evaluateJs(session, expression) {
    const result = await sendCdpCommand(session, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (result.exceptionDetails) {
        throw new Error(`JS error: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
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
        description: 'Take a screenshot of the current page',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'accessibility_snapshot',
        description: 'Get accessibility snapshot of the page',
        inputSchema: { type: 'object', properties: {} },
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
        name: 'reset',
        description: 'Reset the CDP connection',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'clear_cache_and_reload',
        description: 'Clear browser cache and reload the page',
        inputSchema: {
            type: 'object',
            properties: { mode: { type: 'string', enum: ['light', 'aggressive'], description: 'Clear mode' } },
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
];
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'reset') {
        if (cdpSession) {
            cdpSession.ws.close();
            cdpSession = null;
        }
        return { content: [{ type: 'text', text: 'Connection reset' }] };
    }
    try {
        const session = await ensureSession();
        switch (name) {
            case 'screenshot': {
                const result = await sendCdpCommand(session, 'Page.captureScreenshot', { format: 'png' });
                return {
                    content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
                };
            }
            case 'accessibility_snapshot': {
                await sendCdpCommand(session, 'Accessibility.enable');
                const snapshot = await sendCdpCommand(session, 'Accessibility.getFullAXTree');
                return {
                    content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
                };
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
          var apps = Array.isArray(rawApps) ? rawApps.map(function(app) {
            var ad = app.devtools || {};
            return { name: app.name || '', status: app.status || 'UNKNOWN', activeWhenForced: ad.activeWhenForced || null, hasOverlays: !!ad.overlays };
          }) : [];
          return JSON.stringify({ pageUrl: location.href, hasSingleSpaDevtools: hasSingleSpaDevtools, appCount: apps.length, apps: apps });
        })(${targetAppName})`;
                const value = await evaluateJs(session, dashboardCode);
                return {
                    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                };
            }
            case 'clear_cache_and_reload': {
                const mode = args.mode || 'light';
                if (mode === 'aggressive') {
                    await sendCdpCommand(session, 'Network.clearBrowserCache');
                    await sendCdpCommand(session, 'Network.clearBrowserCookies');
                }
                await sendCdpCommand(session, 'Page.reload', { ignoreCache: true });
                await sleep(2000);
                return {
                    content: [{ type: 'text', text: `Cache cleared with mode: ${mode}` }],
                };
            }
            case 'ensure_fresh_render': {
                await sendCdpCommand(session, 'Page.reload', { ignoreCache: true });
                await sleep(2000);
                return {
                    content: [{ type: 'text', text: 'Page reloaded with fresh cache' }],
                };
            }
            case 'navigate': {
                await sendCdpCommand(session, 'Page.navigate', { url: args.url });
                await sleep(2000);
                return {
                    content: [{ type: 'text', text: `Navigated to ${args.url}` }],
                };
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