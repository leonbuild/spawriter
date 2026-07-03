import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { fileURLToPath } from 'node:url';
import { goke } from 'goke';
import { z } from 'zod';
import { VERSION, getRelayPort, getRelayToken } from './utils.js';
import { ControlClient } from './runtime/control-client.js';
import { ensureRelayServer } from './runtime/ensure-relay.js';
import { canEmitKittyGraphics, emitKittyImage } from './runtime/kitty-graphics.js';

Buffer.prototype[util.inspect.custom as any] = function () {
  return `<Buffer ${this.length} bytes>`;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getControlClient(options: { host?: string; token?: string; port?: number }): ControlClient {
  let raw = options.host || process.env.SSPA_RELAY_HOST || '';
  const token = options.token || getRelayToken();

  if (raw && /^https?:\/\//.test(raw)) {
    return new ControlClient(raw.replace(/\/$/, ''), token);
  }

  const host = raw || '127.0.0.1';
  const port = options.port || getRelayPort();
  return new ControlClient(`http://${host}:${port}`, token);
}

const cli = goke('spawriter');

// === Default command: MCP server or -e code execution ===
cli
  .command('', 'Start the MCP server or execute code with -e')
  .option('--host <host>', 'Remote relay server host (or set SSPA_RELAY_HOST)')
  .option('--token <token>', 'Authentication token (or set SSPA_RELAY_TOKEN)')
  .option('-s, --session <name>', 'Session ID (required for -e)')
  .option('-e, --eval [code]', "Execute code and exit. Omit the value or pass '-' to read code from stdin (avoids shell quoting issues)")
  .option('-f, --file <path>', 'Execute code from a file and exit')
  .option('--timeout <ms>', 'Execution timeout in ms (default: 30000)')
  .option('--port <port>', 'Relay HTTP port (default: 19989)')
  .action(async (options: Record<string, unknown>) => {
    if (options.eval !== undefined || options.file !== undefined) {
      let code: string;
      if (options.file !== undefined) {
        try {
          code = fs.readFileSync(String(options.file), 'utf-8');
        } catch (e: any) {
          console.error(`Error: cannot read file "${options.file}": ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } else if (options.eval === '-' || options.eval === '' || options.eval === true) {
        code = await readStdin();
      } else {
        code = String(options.eval);
      }
      await executeCode({
        code,
        timeout: Number(options.timeout) || 30000,
        sessionId: options.session as string | undefined,
        host: options.host as string | undefined,
        token: options.token as string | undefined,
      });
      return;
    }

    if (options.port) {
      process.env.SSPA_MCP_PORT = String(options.port);
    }
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
  });

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

// === executeCode: core code execution function ===
async function executeCode(options: {
  code: string;
  timeout: number;
  sessionId?: string;
  host?: string;
  token?: string;
}): Promise<void> {
  const { code, timeout, host, token } = options;
  const sessionId = options.sessionId || process.env.SSPA_SESSION;

  if (!sessionId) {
    console.error('Error: -s/--session is required for -e.');
    console.error('Run `spawriter session new` first to get a session ID.');
    process.exitCode = 1;
    return;
  }

  const rawHost = host || process.env.SSPA_RELAY_HOST || '';
  const authToken = token || getRelayToken();
  let serverUrl: string;
  if (rawHost && /^https?:\/\//.test(rawHost)) {
    serverUrl = rawHost.replace(/\/$/, '');
  } else {
    serverUrl = `http://${rawHost || '127.0.0.1'}:${getRelayPort()}`;
  }

  if (!host && !process.env.SSPA_RELAY_HOST) {
    await ensureRelayServer();
  }

  const doFetch = async () => {
    const response = await fetch(`${serverUrl}/cli/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ sessionId, code, timeout, cwd: process.cwd() }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text}`);
    }

    return (await response.json()) as {
      text: string;
      images: Array<{ data: string; mimeType: string }>;
      isError: boolean;
    };
  };

  try {
    let result: Awaited<ReturnType<typeof doFetch>>;
    try {
      result = await doFetch();
    } catch (firstError: any) {
      if (firstError.cause?.code === 'ECONNREFUSED') {
        console.error('Relay not reachable, restarting and retrying...');
        await ensureRelayServer({ force: true });
        await new Promise(r => setTimeout(r, 1500));
        result = await doFetch();
      } else {
        throw firstError;
      }
    }

    if (result.text) {
      if (result.isError) {
        console.error(result.text);
      } else {
        console.log(result.text);
      }
    }

    if (canEmitKittyGraphics() && result.images?.length > 0) {
      for (const img of result.images) {
        if (img.data) emitKittyImage(img.data);
      }
    }

    // process.exitCode instead of process.exit: lets libuv drain undici
    // keep-alive handles naturally (process.exit mid-close crashes on Windows).
    if (result.isError) process.exitCode = 1;
  } catch (error: any) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('Error: Cannot connect to relay server after retry.');
      console.error('Check `spawriter relay` or logs.');
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

// === skill ===
cli.command('skill', 'Print the full spawriter usage instructions').action(() => {
  // __dirname is spawriter/dist (built) or spawriter/src (tsx), so ../.. is the repo root.
  const candidates = [
    path.join(__dirname, '..', '..', 'AGENTS_Unified.md'),
    path.join(__dirname, '..', 'AGENTS_Unified.md'),
  ];
  const skillPath = candidates.find(p => fs.existsSync(p));

  if (!skillPath) {
    console.error('AGENTS_Unified.md not found.');
    process.exitCode = 1;
    return;
  }
  console.log(fs.readFileSync(skillPath, 'utf-8'));
});

// === serve (MCP server) ===
cli.command('serve', 'Start the MCP server (includes relay if not running)')
  .option('--port <port>', 'Port (default: 19989)')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (options: Record<string, unknown>) => {
    if (options.port) process.env.SSPA_MCP_PORT = String(options.port);
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
  });

// === relay ===
cli.command('relay', 'Start the CDP relay server')
  .option('--port <port>', 'Port (default: 19989)')
  .option('--host <host>', 'Bind host (default: 127.0.0.1; a public host requires --token)')
  .option('--token <token>', 'Auth token (required for public host)')
  .option('--replace', 'Kill existing server if running')
  .action(async (options: Record<string, unknown>) => {
    const port = Number(options.port) || getRelayPort();

    if (options.replace) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          console.log(`Port ${port} in use, stopping existing server...`);
          try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* ignore */ }
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 500));
            try { await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) }); } catch { break; }
          }
        }
      } catch { /* not running */ }
    }

    process.env.SSPA_MCP_PORT = String(port);
    if (options.token) process.env.SSPA_MCP_TOKEN = String(options.token);
    const { startRelayServer } = await import('./relay.js');
    await startRelayServer({ host: options.host as string | undefined });
  });

// === session new ===
cli.command('session new', 'Create a new session and print the session ID')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (options: Record<string, unknown>) => {
    if (!options.host && !process.env.SSPA_RELAY_HOST) {
      await ensureRelayServer();
    }
    const client = getControlClient(options as any);
    const result = await client.createSession({ cwd: process.cwd() });
    console.log(result.id);
  });

// === session list ===
cli.command('session list', 'List all active sessions')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (options: Record<string, unknown>) => {
    if (!options.host && !process.env.SSPA_RELAY_HOST) {
      await ensureRelayServer();
    }
    const client = getControlClient(options as any);
    const { sessions } = await client.listSessions();

    if (sessions.length === 0) {
      console.log('No active sessions. Run `spawriter session new` to create one.');
      return;
    }

    const idWidth = Math.max(2, ...sessions.map(s => s.id.length));
    console.log('ID'.padEnd(idWidth) + '  STATUS');
    console.log('-'.repeat(idWidth + 15));
    for (const s of sessions) {
      const status = s.connected ? 'connected' : 'disconnected';
      console.log(s.id.padEnd(idWidth) + '  ' + status);
    }
  });

// === session delete ===
cli.command('session delete <id>', 'Delete a session')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (id: string, options: Record<string, unknown>) => {
    const client = getControlClient(options as any);
    await client.deleteSession(id);
    console.log(`Session ${id} deleted.`);
  });

// === session reset ===
cli.command('session reset <id>', 'Reset the browser connection for a session')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .action(async (id: string, options: Record<string, unknown>) => {
    const client = getControlClient(options as any);
    const result = await client.resetSession(id);
    console.log(`Connection reset.${result.pageUrl ? ` Current: ${result.pageUrl}` : ''}${result.pagesCount != null ? ` (${result.pagesCount} pages)` : ''}`);
  });

// === session bind ===
cli.command('session bind <tabId>', 'Bind session to a specific tab')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .option('-s, --session <name>', 'Session ID (required)')
  .action(async (tabId: string, options: Record<string, unknown>) => {
    const sessionId = options.session as string;
    if (!sessionId) {
      console.error('Error: -s/--session is required.');
      process.exitCode = 1;
      return;
    }
    try {
      const client = getControlClient(options as any);
      await client.claimTab(sessionId, Number(tabId));
      console.log(`Session ${sessionId} bound to tab ${tabId}.`);
    } catch (error: any) {
      console.error(`Failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

// === tabs list ===
cli.command('tabs list', 'List attached tabs with ownership status')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .option('-s, --session <name>', 'Mark tabs owned by this session as MINE')
  .action(async (options: Record<string, unknown>) => {
    if (!options.host && !process.env.SSPA_RELAY_HOST) {
      await ensureRelayServer();
    }
    const client = getControlClient(options as any);
    const tabs = await client.listTabs();
    if (tabs.length === 0) {
      console.log('No attached tabs.');
      return;
    }
    const sid = options.session as string | undefined;
    console.log('TABID'.padEnd(12) + 'STATUS'.padEnd(28) + 'URL');
    for (const t of tabs) {
      const status = !t.owner ? 'AVAILABLE' : t.owner === sid ? 'MINE' : `OWNED(${t.owner})`;
      console.log(String(t.tabId ?? '?').padEnd(12) + status.padEnd(28) + t.url);
    }
  });

// === tabs connect ===
cli.command('tabs connect <url>', 'Connect to a tab by URL and claim it (like MCP tab connect)')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .option('-s, --session <name>', 'Session ID (required)')
  .option('--create', 'Create a new tab if no idle match')
  .option('--force-create', 'Always create a new tab')
  .action(async (url: string, options: Record<string, unknown>) => {
    const sessionId = options.session as string;
    if (!sessionId) {
      console.error('Error: -s/--session is required.');
      process.exitCode = 1;
      return;
    }
    if (!options.host && !process.env.SSPA_RELAY_HOST) {
      await ensureRelayServer();
    }
    try {
      const client = getControlClient(options as any);
      const result = await client.connectTab({
        url,
        create: !!options.create || !!options.forceCreate,
        forceCreate: !!options.forceCreate,
        sessionId,
      });
      if (!result.success || result.tabId == null) {
        console.error(`Failed: ${result.error || 'no tab available'}`);
        process.exitCode = 1;
        return;
      }
      // connect-tab claims atomically when sessionId is passed; fall back to an
      // explicit claim only if a concurrent caller won the race.
      if (!result.claimed) await client.claimTab(sessionId, result.tabId);
      const how = result.created ? 'created' : result.reused ? 'reused idle' : 'connected';
      console.log(`Session ${sessionId} bound to tab ${result.tabId} (${how}).`);
    } catch (error: any) {
      console.error(`Failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

// === tabs release ===
cli.command('tabs release [tabId]', 'Release owned tab(s); all owned tabs if tabId omitted')
  .option('--host <host>', 'Remote relay host')
  .option('--token <token>', 'Auth token')
  .option('-s, --session <name>', 'Session ID (required)')
  .action(async (tabId: string | undefined, options: Record<string, unknown>) => {
    const sessionId = options.session as string;
    if (!sessionId) {
      console.error('Error: -s/--session is required.');
      process.exitCode = 1;
      return;
    }
    try {
      const client = getControlClient(options as any);
      const ids = tabId != null
        ? [Number(tabId)]
        : (await client.listTabs()).filter(t => t.owner === sessionId && t.tabId != null).map(t => t.tabId as number);
      if (ids.length === 0) {
        console.log('No owned tabs to release.');
        return;
      }
      for (const id of ids) {
        await client.releaseTab(sessionId, id);
      }
      console.log(`Released tab(s): ${ids.join(', ')}.`);
    } catch (error: any) {
      console.error(`Failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

// === logfile ===
cli.command('logfile', 'Print log file paths').action(async () => {
  const os = await import('node:os');
  const logDir = path.join(os.tmpdir(), 'spawriter');
  console.log(`relay: ${path.join(logDir, 'relay.log')}`);
  console.log(`cdp: ${path.join(logDir, 'cdp.jsonl')}`);
});

cli.help();
cli.version(VERSION);
cli.parse();
