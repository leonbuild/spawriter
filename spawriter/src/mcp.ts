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
  type ExecuteScreenshot,
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
  for (const name of ['AGENTS_MCP.md', 'AGENTS_Unified.md']) {
    try {
      return fs.readFileSync(path.join(repoRoot, name), 'utf-8');
    } catch { /* try next */ }
  }
  return 'spawriter: AI-assisted browser automation for single-spa micro-frontends. Execute Playwright JS code with spawriter extensions.';
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

let activeAgentId: string | null = null;

function getEffectiveClientId(agentId?: string): string {
  if (!agentId) return MCP_CLIENT_ID;
  return `${MCP_CLIENT_ID}::${agentId}`;
}

// Single source of truth for the relay-facing session ID.
// execute / single_spa / tab / cdp must all resolve through this function,
// otherwise tab ownership and execution land on different sessions (S1).
export function buildRelaySessionId(clientId: string): string {
  return `mcp-${clientId}`;
}

function getRelaySessionId(agentId?: string): string {
  return buildRelaySessionId(getEffectiveClientId(agentId ?? activeAgentId ?? undefined));
}

export function ownerBelongsToThisMcp(owner: string | null | undefined, mcpClientId: string = MCP_CLIENT_ID): boolean {
  if (!owner) return false;
  const prefix = buildRelaySessionId(mcpClientId);
  return owner === prefix || owner.startsWith(`${prefix}::`);
}

// ---------------------------------------------------------------------------
// Executor management
// ---------------------------------------------------------------------------

// Relay control routes require the token when SSPA_MCP_TOKEN is set; without
// these headers a token-protected relay would reject every MCP call with 401.
function relayHeaders(): Record<string, string> {
  const token = getRelayToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function remoteRelaySendCdp(method: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown> {
  const port = getRelayPort();
  const mcpSessionId = getRelaySessionId();
  const resp = await fetch(`http://localhost:${port}/cli/cdp`, {
    method: 'POST',
    headers: relayHeaders(),
    body: JSON.stringify({ method, params, timeout, sessionId: mcpSessionId }),
    signal: AbortSignal.timeout(timeout || 30000),
  });
  const json = await resp.json() as { result?: unknown; error?: string };
  if (!resp.ok || json.error) throw new Error(json.error || `CDP ${method} failed (${resp.status})`);
  return json.result;
}

const executorManager = new ExecutorManager({ maxSessions: 10, relaySendCdp: remoteRelaySendCdp });

async function getOrCreateExecutor(agentId?: string): Promise<PlaywrightExecutor> {
  const effectiveId = agentId || activeAgentId;
  const sessionId = effectiveId ? `mcp-${effectiveId}` : 'mcp-default';
  return executorManager.getOrCreate(sessionId);
}

async function executeViaRelay(code: string, timeout: number): Promise<ExecuteResult> {
  const port = getRelayPort();
  const mcpSessionId = getRelaySessionId();
  const resp = await fetch(`http://localhost:${port}/cli/execute`, {
    method: 'POST',
    headers: relayHeaders(),
    body: JSON.stringify({ sessionId: mcpSessionId, code, timeout, cwd: process.cwd() }),
  });
  const body = await resp.json() as Record<string, unknown>;
  return {
    text: (body.text as string) || '',
    images: (body.images as Array<{ data: string; mimeType: string }>) || [],
    screenshots: (body.screenshots as ExecuteScreenshot[]) || [],
    isError: (body.isError as boolean) || false,
  };
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
    if (img.mimeType === 'image/png' || img.mimeType === 'image/jpeg') {
      content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
  }
  const hasUnsupportedImages = result.images.some(i => i.mimeType !== 'image/png' && i.mimeType !== 'image/jpeg');
  if (hasUnsupportedImages && result.screenshots && result.screenshots.length > 0) {
    const textFallbacks: string[] = [];
    for (const ss of result.screenshots) {
      if (ss.snapshot) textFallbacks.push(ss.snapshot);
      if (ss.labelCount != null) textFallbacks.push(`(${ss.labelCount} interactive elements labeled)`);
    }
    if (textFallbacks.length > 0) {
      content.push({ type: 'text', text: `[Screenshot: image/webp not supported by client, text fallback below]\n${textFallbacks.join('\n')}` });
    }
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
  const mySessionId = getRelaySessionId(sessionId);

  switch (action) {
    case 'list': {
      await ensureRelayServer();
      const targets = await getTargets(port);
      if (targets.length === 0) {
        return { content: [{ type: 'text', text: 'No tabs attached. Click the spawriter toolbar button on a Chrome tab, or use tab { action: "connect", url: "..." } to attach one.' }] };
      }
      const executor = await getOrCreateExecutor();
      const lines = targets.map((t, i) => {
        const markers: string[] = [];
        if (t.owner === mySessionId) {
          markers.push(t.tabId === executor.getActiveTabId() ? 'MINE ★' : 'MINE');
        } else if (t.owner) {
          markers.push(t.owner);
        } else {
          markers.push('AVAILABLE');
        }
        const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
        return `${i + 1}. [${t.id}]${tabLabel} ← ${markers.join(', ')}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
      });
      const myTabs = targets.filter(t => t.owner === mySessionId);
      const otherTabs = targets.filter(t => t.owner && t.owner !== mySessionId);
      const availableTabs = targets.filter(t => !t.owner);
      const summary = `${targets.length} tab(s), ${myTabs.length} mine, ${otherTabs.length} owned by others, ${availableTabs.length} available`;
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
      let result = await requestConnectTab(port, { url, tabId, create, sessionId: mySessionId });
      if (!result.success && (result as any).error === 'Extension not connected') {
        for (let retry = 0; retry < 6; retry++) {
          await sleep(2000);
          result = await requestConnectTab(port, { url, tabId, create, sessionId: mySessionId });
          if (result.success || (result as any).error !== 'Extension not connected') break;
        }
      }
      if (!result.success) {
        return { content: [{ type: 'text', text: formatError({ error: `Failed to connect tab: ${(result as any).error || 'Unknown error'}`, recovery: 'reset' }) }], isError: true };
      }

      // connect-tab claims atomically for mySessionId; mirror that claim into the
      // local executor view. Only create a fallback tab when the relay could not
      // claim because a concurrent session already owns the matched tab.
      let claimStatus = 'unclaimed';
      if (result.tabId != null) {
        if (result.claimed) {
          claimStatus = 'claimed';
          const executor = await getOrCreateExecutor();
          executor.claimTab(result.tabId, result.url ?? url, result.targetId);
        } else if (create && url && !result.created) {
          const fallback = await requestConnectTab(port, { url, create: true, forceCreate: true, sessionId: mySessionId });
          if (fallback.success && fallback.claimed && fallback.tabId != null) {
            result = fallback;
            claimStatus = 'claimed (new tab created as fallback)';
            const executor = await getOrCreateExecutor();
            executor.claimTab(fallback.tabId, fallback.url ?? url, fallback.targetId);
          } else {
            claimStatus = 'fallback tab created but claim failed';
          }
        } else {
          claimStatus = 'claim failed: tab owned by another session';
        }
      }

      await sleep(500);
      const targets = await getTargets(port);
      const newTarget = targets.find(t => t.tabId === result.tabId);
      // Re-claim with full target info so tab→page resolution can use the
      // CDP targetId instead of ambiguous URL matching.
      if (newTarget && result.tabId != null && claimStatus.startsWith('claimed')) {
        const executor = await getOrCreateExecutor();
        executor.claimTab(result.tabId, newTarget.url, newTarget.targetId);
      }
      const created = result.created ? ' (newly created)' : '';
      const info = newTarget
        ? `Attached tab${created}:\n  Session: ${newTarget.id}\n  Title: ${newTarget.title}\n  URL: ${newTarget.url}\n  Ownership: ${claimStatus}`
        : `Tab attached${created} (tabId: ${result.tabId}). Ownership: ${claimStatus}. Use tab { action: "list" } to see it.`;
      return { content: [{ type: 'text', text: info }] };
    }

    case 'switch': {
      const switchTabId = args.tabId as number;
      if (!switchTabId) {
        return { content: [{ type: 'text', text: formatError({ error: 'tabId is required (number)', hint: 'Use tab { action: "list" } to see available tabs and their tabIds' }) }], isError: true };
      }
      await ensureRelayServer();
      const targets = await getTargets(port);
      const target = targets.find(t => t.tabId === switchTabId);
      if (!target) {
        const available = targets.map(t => `  tabId ${t.tabId} — ${t.url || '(no url)'}`).join('\n') || '  (none)';
        return { content: [{ type: 'text', text: formatError({ error: `Tab ${switchTabId} not found`, hint: `Available tabs:\n${available}` }) }], isError: true };
      }
      if (target.owner && target.owner !== mySessionId) {
        return { content: [{ type: 'text', text: formatError({ error: `Tab ${switchTabId} owned by ${target.owner}`, hint: 'You can only switch to tabs you own or unclaimed tabs' }) }], isError: true };
      }
      // Always claim, even when already owned: the relay-side claim also
      // switches the relay executor's active tab, so execute follows the switch.
      try {
        const claimResp = await fetch(`http://localhost:${port}/cli/tab/claim`, {
          method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify({ tabId: switchTabId, sessionId: mySessionId }),
        });
        if (!claimResp.ok) {
          const claimErr = await claimResp.json().catch(() => ({}));
          return { content: [{ type: 'text', text: formatError({ error: `Failed to claim tab ${switchTabId}: ${(claimErr as any).error || claimResp.status}` }) }], isError: true };
        }
      } catch (e: any) {
        return { content: [{ type: 'text', text: formatError({ error: `Failed to claim tab ${switchTabId}: ${e.message}` }) }], isError: true };
      }
      const executor = await getOrCreateExecutor();
      executor.claimTab(switchTabId, target.url, target.targetId);
      executor.switchToTab(switchTabId);
      return { content: [{ type: 'text', text: `Switched to tab ${switchTabId}: ${target.title || '(no title)'}\nURL: ${target.url || '(no url)'}` }] };
    }

    case 'release': {
      const releaseTabId = args.tabId as number | undefined;
      if (releaseTabId) {
        let released = false;
        try {
          const resp = await fetch(`http://localhost:${port}/cli/tab/release`, {
            method: 'POST',
            headers: relayHeaders(),
            body: JSON.stringify({ tabId: releaseTabId, sessionId: mySessionId }),
          });
          released = resp.ok;
        } catch {}
        const executor = await getOrCreateExecutor();
        executor.releaseTab(releaseTabId);
        return { content: [{ type: 'text', text: released ? `Tab ${releaseTabId} released.` : `Tab ${releaseTabId} not owned by current session (${mySessionId}).` }] };
      }
      const targets = await getTargets(port);
      let releasedCount = 0;
      for (const t of targets) {
        if (t.owner === mySessionId && t.tabId != null) {
          try {
            await fetch(`http://localhost:${port}/cli/tab/release`, {
              method: 'POST',
              headers: relayHeaders(),
              body: JSON.stringify({ tabId: t.tabId, sessionId: mySessionId }),
            });
            releasedCount++;
          } catch {}
        }
      }
      const executor = await getOrCreateExecutor();
      for (const tid of [...executor.getOwnedTabIds()]) {
        executor.releaseTab(tid);
      }
      return { content: [{ type: 'text', text: `Released ${releasedCount} tab(s).` }] };
    }

    default:
      return { content: [{ type: 'text', text: formatError({ error: `Unknown tab action: ${action}`, hint: 'Valid actions: connect, list, switch, release' }) }], isError: true };
  }
}

interface TargetListItem {
  id: string;
  targetId?: string;
  tabId?: number;
  type: string;
  title: string;
  url: string;
  owner?: string | null;
}

async function getTargets(port: number): Promise<TargetListItem[]> {
  try {
    const response = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await response.json() as TargetListItem[];
  } catch {
    return [];
  }
}

// Releases every tab owned by any session of this MCP process (base ID and
// ::agentId variants) and deletes those relay sessions. Used by reset and
// graceful shutdown so ownership never outlives the process (S3).
async function releaseAllOwnedTabs(): Promise<number> {
  const port = getRelayPort();
  let released = 0;
  try {
    const targets = await getTargets(port);
    const ownedSessions = new Set<string>();
    await Promise.all(targets
      .filter(t => t.tabId != null && ownerBelongsToThisMcp(t.owner))
      .map(t => {
        ownedSessions.add(t.owner as string);
        released++;
        return fetch(`http://localhost:${port}/cli/tab/release`, {
          method: 'POST',
          headers: relayHeaders(),
          body: JSON.stringify({ tabId: t.tabId, sessionId: t.owner }),
        }).catch(() => {});
      }));
    await Promise.all([...ownedSessions].map(sid =>
      fetch(`http://localhost:${port}/cli/session/delete`, {
        method: 'POST',
        headers: relayHeaders(),
        body: JSON.stringify({ sessionId: sid }),
      }).catch(() => {})));
  } catch { /* relay may not be running */ }
  return released;
}

async function requestConnectTab(port: number, params: { url?: string; tabId?: number; create?: boolean; forceCreate?: boolean; sessionId?: string }): Promise<{ success: boolean; tabId?: number; created?: boolean; claimed?: boolean; targetId?: string; url?: string }> {
  try {
    const response = await fetch(`http://localhost:${port}/connect-tab`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(18000),
    });
    return await response.json() as { success: boolean; tabId?: number; created?: boolean; claimed?: boolean; targetId?: string; url?: string };
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
          description: 'Playwright JS code. Globals: {page, context, browser, state, navigate, ensureFreshRender, screenshot, screenshotWithLabels, snapshot/accessibilitySnapshot, interact, refToLocator, consoleLogs, getLatestLogs, clearAllLogs, networkLog, networkDetail, clearNetworkLog, networkIntercept, dbg, editor, browserFetch, storage, emulation, performance, cssInspect, pageContent, getPageMarkdown, getCleanHTML, waitForPageLoad, getReactSource, getReactComponentInfo, singleSpa, clearCacheAndReload, getCDPSession, resetPlaywright, require, import}. Use ; for multiple statements.',
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in ms (default: 30000)',
        },
        session_id: {
          type: 'string',
          description: 'Session ID for per-agent isolation (use the same value as tab connect)',
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
        session_id: {
          type: 'string',
          description: 'Session ID for per-agent isolation (use the same value as tab connect)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'tab',
    description: `Tab management for multi-agent isolation.
- connect: Connect to a tab by URL or tabId (auto-claims ownership)
- list: List all tabs with ownership status
- switch: Switch active tab by tabId (claims if unclaimed)
- release: Release tab ownership (by tabId, or all if omitted)`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['connect', 'list', 'switch', 'release'], description: 'Tab action' },
        url: { type: 'string', description: 'Tab URL (for connect)' },
        create: { type: 'boolean', description: 'Create new tab if not found (for connect)' },
        tabId: { type: 'number', description: 'Chrome tab ID (for connect, switch, release)' },
        session_id: { type: 'string', description: 'Session ID for per-agent tab isolation' },
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
      if (args.session_id) activeAgentId = args.session_id as string;
      if (!code) {
        return { content: [{ type: 'text', text: formatError({ error: 'Missing required parameter: code' }) }], isError: true };
      }
      await ensureRelayServer();
      const result = await executeViaRelay(code, timeout);
      return formatMcpResult(result);
    }

    if (name === 'reset') {
      const released = await releaseAllOwnedTabs();
      await executorManager.resetAll();
      activeAgentId = null;
      return { content: [{ type: 'text', text: `Connection reset. All state cleared; ${released} owned tab(s) released.` }] };
    }

    if (name === 'single_spa') {
      const action = args.action as string;
      const appName = args.appName as string | undefined;
      const url = args.url as string | undefined;
      if (args.session_id) activeAgentId = args.session_id as string;

      await ensureRelayServer();

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

      const result = await executeViaRelay(code, 30000);
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

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${signal})...`);
    await releaseAllOwnedTabs().catch(() => {});
    await executorManager.resetAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  // MCP clients close stdio to terminate the server
  process.stdin.on('end', () => void gracefulShutdown('stdin-end'));
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
