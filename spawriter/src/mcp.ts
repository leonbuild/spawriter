import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getRelayPort,
  getRelayToken,
  getAgentLabel,
  getProjectUrl,
  generateMcpClientId,
  log,
  error,
  sleep,
  VERSION,
} from './utils.js';
import {
  PlaywrightExecutor,
  ExecutorManager,
  formatError,
  withTimeout,
  type ExecuteResult,
} from './pw-executor.js';
import {
  buildDashboardStateCode,
  buildOverrideCode,
  buildAppActionCode,
} from './runtime/spa-helpers.js';

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

const __mcpDirname = path.dirname(fileURLToPath(import.meta.url));

function loadPromptContent(): string {
  const repoRoot = path.join(__mcpDirname, '..', '..');
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  try {
    return fs.readFileSync(agentsPath, 'utf-8');
  } catch {
    return 'spawriter: AI-assisted browser automation for single-spa micro-frontends. Execute Playwright JS code with spawriter extensions.';
  }
}

const promptContent = loadPromptContent();

// ---------------------------------------------------------------------------
// Relay auto-start
// ---------------------------------------------------------------------------

let relayServerProcess: ReturnType<typeof import('child_process').spawn> | null = null;
let relayStartPromise: Promise<void> | null = null;

async function ensureRelayServer(): Promise<void> {
  try {
    const response = await fetch(`http://localhost:${getRelayPort()}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) return;
  } catch { /* relay not reachable */ }

  if (relayStartPromise) return relayStartPromise;
  relayStartPromise = doStartRelay();
  try {
    return await relayStartPromise;
  } finally {
    relayStartPromise = null;
  }
}

async function doStartRelay(): Promise<void> {
  log('Relay server not running, attempting to start...');
  try {
    const { spawn } = await import('child_process');
    const relayPath = path.join(__mcpDirname, 'relay.js');
    relayServerProcess = spawn('node', [relayPath], { stdio: 'ignore', detached: true });
    relayServerProcess.unref();

    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        await fetch(`http://localhost:${getRelayPort()}/version`, { signal: AbortSignal.timeout(1000) });
        log('Relay server started successfully');
        return;
      } catch {
        log('Waiting for relay server...');
      }
    }
    throw new Error('Failed to start relay server after 10 attempts');
  } catch (e) {
    error('Error starting relay server:', e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Agent session management
// ---------------------------------------------------------------------------

const MCP_CLIENT_ID = generateMcpClientId();
const agentLabel = getAgentLabel();
const projectUrl = getProjectUrl();

interface AgentSession {
  agentId: string;
  clientId: string;
  executorSessionId: string;
}

const agentSessions = new Map<string, AgentSession>();
let activeAgentId: string | null = null;

function getEffectiveClientId(agentId?: string): string {
  if (!agentId) return MCP_CLIENT_ID;
  return `${MCP_CLIENT_ID}::${agentId}`;
}

function getAgentSession(agentId: string): AgentSession {
  let session = agentSessions.get(agentId);
  if (!session) {
    session = {
      agentId,
      clientId: getEffectiveClientId(agentId),
      executorSessionId: `mcp-${agentId}`,
    };
    agentSessions.set(agentId, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Executor management
// ---------------------------------------------------------------------------

const executorManager = new ExecutorManager({ maxSessions: 10 });

async function getOrCreateExecutor(agentId?: string): Promise<PlaywrightExecutor> {
  const effectiveId = agentId || activeAgentId;
  const sessionId = effectiveId ? `mcp-${effectiveId}` : 'mcp-default';
  return executorManager.getOrCreate(sessionId);
}

// ---------------------------------------------------------------------------
// MCP result formatting
// ---------------------------------------------------------------------------

function formatMcpResult(result: ExecuteResult): {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
} {
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  for (const img of result.images) {
    content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: 'Code executed successfully (no output)' });
  }

  return { content, isError: result.isError || undefined };
}

// ---------------------------------------------------------------------------
// Tab management (relay HTTP API — stays in MCP, not in executor)
// ---------------------------------------------------------------------------

async function handleTabAction(
  action: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const port = getRelayPort();
  const sessionId = args.session_id as string | undefined;
  if (sessionId) activeAgentId = sessionId;
  const effectiveClientId = getEffectiveClientId(sessionId);

  switch (action) {
    case 'list': {
      await ensureRelayServer();
      const targets = await getTargets(port);
      if (targets.length === 0) {
        return { content: [{ type: 'text', text: 'No tabs attached. Click the spawriter toolbar button on a Chrome tab, or use tab { action: "connect", url: "..." } to attach one.' }] };
      }
      const lines = targets.map((t, i) => {
        const markers: string[] = [];
        if (t.lease?.clientId === effectiveClientId) markers.push('MINE');
        else if (t.lease) markers.push(`LEASED by ${t.lease.label || t.lease.clientId}`);
        else markers.push('AVAILABLE');
        const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
        return `${i + 1}. [${t.id}]${tabLabel} ← ${markers.join(', ')}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
      });
      const myTabs = targets.filter(t => t.lease?.clientId === effectiveClientId);
      const otherTabs = targets.filter(t => t.lease && t.lease.clientId !== effectiveClientId);
      const availableTabs = targets.filter(t => !t.lease);
      const summary = `${targets.length} tab(s), ${myTabs.length} mine, ${otherTabs.length} leased by others, ${availableTabs.length} available`;
      return { content: [{ type: 'text', text: `${summary}\n\n${lines.join('\n\n')}` }] };
    }

    case 'connect': {
      await ensureRelayServer();
      const url = args.url as string | undefined;
      const tabId = args.tabId as number | undefined;
      const create = args.create as boolean | undefined;
      if (!url && tabId === undefined) {
        return { content: [{ type: 'text', text: formatError({ error: 'Missing required parameter', hint: 'Provide either url or tabId to identify the tab to connect' }) }], isError: true };
      }
      let result = await requestConnectTab(port, { url, tabId, create });
      if (!result.success && (result as any).error === 'Extension not connected') {
        for (let retry = 0; retry < 6; retry++) {
          await sleep(2000);
          result = await requestConnectTab(port, { url, tabId, create });
          if (result.success || (result as any).error !== 'Extension not connected') break;
        }
      }
      if (!result.success) {
        return { content: [{ type: 'text', text: formatError({ error: `Failed to connect tab: ${(result as any).error || 'Unknown error'}`, recovery: 'reset' }) }], isError: true };
      }
      await sleep(500);
      const targets = await getTargets(port);
      const newTarget = targets.find(t => t.tabId === result.tabId);
      const created = result.created ? ' (newly created)' : '';
      const info = newTarget
        ? `Attached tab${created}:\n  Session: ${newTarget.id}\n  Title: ${newTarget.title}\n  URL: ${newTarget.url}`
        : `Tab attached${created} (tabId: ${result.tabId}). Use tab { action: "list" } to see it.`;
      return { content: [{ type: 'text', text: info }] };
    }

    case 'switch': {
      const targetId = args.targetId as string;
      if (!targetId) {
        return { content: [{ type: 'text', text: formatError({ error: 'targetId is required', hint: 'Use tab { action: "list" } to see available targets' }) }], isError: true };
      }
      await ensureRelayServer();
      const targets = await getTargets(port);
      const target = targets.find(t => t.id === targetId);
      if (!target) {
        const available = targets.map(t => `  ${t.id} — ${t.url || '(no url)'}`).join('\n') || '  (none)';
        return { content: [{ type: 'text', text: formatError({ error: `Target "${targetId}" not found`, hint: `Available targets:\n${available}` }) }], isError: true };
      }
      if (target.lease && target.lease.clientId !== effectiveClientId) {
        return { content: [{ type: 'text', text: formatError({ error: 'Tab leased by another agent', hint: `Tab ${targetId} is owned by "${target.lease.label || target.lease.clientId}"` }) }], isError: true };
      }
      return { content: [{ type: 'text', text: `Switched to tab: ${target.title || '(no title)'}\nURL: ${target.url || '(no url)'}` }] };
    }

    case 'release': {
      return { content: [{ type: 'text', text: 'Tab released.' }] };
    }

    default:
      return { content: [{ type: 'text', text: formatError({ error: `Unknown tab action: ${action}`, hint: 'Valid actions: connect, list, switch, release' }) }], isError: true };
  }
}

interface TargetListItem {
  id: string;
  tabId?: number;
  type: string;
  title: string;
  url: string;
  lease?: { clientId: string; label?: string } | null;
}

async function getTargets(port: number): Promise<TargetListItem[]> {
  try {
    const response = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await response.json() as TargetListItem[];
  } catch {
    return [];
  }
}

async function requestConnectTab(port: number, params: { url?: string; tabId?: number; create?: boolean }): Promise<{ success: boolean; tabId?: number; created?: boolean }> {
  try {
    const response = await fetch(`http://localhost:${port}/connect-tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(18000),
    });
    return await response.json() as { success: boolean; tabId?: number; created?: boolean };
  } catch (e) {
    error('Failed to request connect-tab:', e);
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// MCP Server setup — 4 tools
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'spawriter', version: VERSION },
  { capabilities: { tools: {}, logging: {} } },
);

function mcpLog(level: 'debug' | 'info' | 'warning' | 'error', data: string): void {
  log(data);
  server.sendLoggingMessage({ level, logger: 'spawriter', data }).catch(() => {});
}

const tools = [
  {
    name: 'execute',
    description: promptContent,
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Playwright JS code. Globals: {page, context, browser, state, singleSpa, snapshot, screenshotWithLabels, screenshot, consoleLogs, networkLog, networkDetail, networkIntercept, cssInspect, dbg, browserFetch, storage, emulation, performance, editor, pageContent, interact, clearCacheAndReload, navigate, ensureFreshRender, resetPlaywright, getCDPSession, getLatestLogs, clearAllLogs, clearNetworkLog, refToLocator}. Use ; for multiple statements.',
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in ms (default: 30000)',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'reset',
    description: 'Reset Playwright connection and all state (console logs, network entries, debugger, intercept rules, snapshots, sessions).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'single_spa',
    description: `Manage single-spa micro-frontend applications.

Actions:
- status: Get all app statuses + active import-map-overrides
- override_set: Point an app to a local dev server URL
- override_remove: Remove an override
- override_enable / override_disable: Toggle an override
- override_reset_all: Clear all overrides
- mount / unmount / unload: Force lifecycle action on an app`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'override_set', 'override_remove', 'override_enable', 'override_disable', 'override_reset_all', 'mount', 'unmount', 'unload'],
          description: 'Action to perform',
        },
        appName: { type: 'string', description: 'App name (e.g. @org/navbar)' },
        url: { type: 'string', description: 'Override URL (e.g. http://localhost:8080/main.js)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'tab',
    description: `Manage browser tabs via the Tab Lease System.

Actions:
- connect: Connect to a tab by URL (create if not found with create=true)
- list: List all available tabs with lease status
- switch: Switch to a tab by targetId
- release: Release the currently held tab`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['connect', 'list', 'switch', 'release'], description: 'Tab action' },
        url: { type: 'string', description: 'Tab URL (for connect)' },
        create: { type: 'boolean', description: 'Create new tab if not found (for connect)' },
        targetId: { type: 'string', description: 'Target session ID (for switch)' },
        tabId: { type: 'number', description: 'Chrome tab ID (for connect)' },
        session_id: { type: 'string', description: 'Session ID for per-session tab isolation' },
      },
      required: ['action'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const MCP_REQUEST_TIMEOUT = 120000;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const handleToolCall = async () => {
    if (name === 'execute') {
      const code = args.code as string;
      const timeout = (args.timeout as number) || 30000;
      if (!code) {
        return { content: [{ type: 'text', text: formatError({ error: 'Missing required parameter: code' }) }], isError: true };
      }
      await ensureRelayServer();
      const executor = await getOrCreateExecutor();
      const result = await executor.execute(code, timeout);
      return formatMcpResult(result);
    }

    if (name === 'reset') {
      await executorManager.resetAll();
      agentSessions.clear();
      activeAgentId = null;
      return { content: [{ type: 'text', text: 'Connection reset. All state cleared (console logs, network entries, Playwright state, debugger, intercept rules, snapshots, sessions).' }] };
    }

    if (name === 'single_spa') {
      const action = args.action as string;
      const appName = args.appName as string | undefined;
      const url = args.url as string | undefined;

      await ensureRelayServer();
      const executor = await getOrCreateExecutor();

      let code: string;
      switch (action) {
        case 'status':
          code = `await singleSpa.status(${appName ? JSON.stringify(appName) : ''})`;
          break;
        case 'override_set':
          code = `await singleSpa.override('set', ${JSON.stringify(appName)}, ${JSON.stringify(url)})`;
          break;
        case 'override_remove':
          code = `await singleSpa.override('remove', ${JSON.stringify(appName)})`;
          break;
        case 'override_enable':
          code = `await singleSpa.override('enable', ${JSON.stringify(appName)})`;
          break;
        case 'override_disable':
          code = `await singleSpa.override('disable', ${JSON.stringify(appName)})`;
          break;
        case 'override_reset_all':
          code = `await singleSpa.override('reset_all')`;
          break;
        case 'mount':
        case 'unmount':
        case 'unload':
          code = `await singleSpa.${action}(${JSON.stringify(appName)})`;
          break;
        default:
          return { content: [{ type: 'text', text: formatError({ error: `Unknown single_spa action: ${action}`, hint: 'Valid: status, override_set, override_remove, override_enable, override_disable, override_reset_all, mount, unmount, unload' }) }], isError: true };
      }

      const result = await executor.execute(code);
      return formatMcpResult(result);
    }

    if (name === 'tab') {
      const action = args.action as string;
      return handleTabAction(action, args);
    }

    return { content: [{ type: 'text', text: formatError({ error: `Unknown tool: ${name}`, hint: 'Available tools: execute, reset, single_spa, tab' }) }], isError: true };
  };

  try {
    return await withTimeout(handleToolCall(), MCP_REQUEST_TIMEOUT, name);
  } catch (e) {
    error(`Tool ${name} global timeout:`, e);
    return {
      content: [{ type: 'text', text: formatError({ error: `Tool "${name}" timed out after ${MCP_REQUEST_TIMEOUT / 1000}s`, hint: 'The browser may be busy or unreachable', recovery: 'reset' }) }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Starting MCP server...');

  process.on('uncaughtException', (err) => {
    error('Uncaught exception (recovered):', err.message);
  });

  process.on('unhandledRejection', (reason) => {
    error('Unhandled rejection (recovered):', String(reason));
  });

  ensureRelayServer().catch((e) => {
    log('Relay server pre-start failed (will retry on first tool call):', String(e));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLog('info', 'MCP server ready');

  process.on('SIGINT', async () => {
    log('Shutting down...');
    await executorManager.resetAll().catch(() => {});
    process.exit(0);
  });
}

export async function startMcpServer(): Promise<void> {
  await main();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    error('Fatal error:', e);
    process.exit(1);
  });
}
