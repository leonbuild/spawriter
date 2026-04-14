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

function getControlClient(options: { host?: string; token?: string }): ControlClient {
  const host = options.host || process.env.SSPA_RELAY_HOST || '127.0.0.1';
  const port = getRelayPort();
  const token = options.token || getRelayToken();
  return new ControlClient(`http://${host}:${port}`, token);
}

const cli = goke('spawriter');

// === Default command: MCP server or -e code execution ===
cli
  .command('', 'Start the MCP server or execute code with -e')
  .option('--host <host>', 'Remote relay server host (or set SSPA_RELAY_HOST)')
  .option('--token <token>', 'Authentication token (or set SSPA_RELAY_TOKEN)')
  .option('-s, --session <name>', 'Session ID (required for -e)')
  .option('-e, --eval <code>', 'Execute code and exit (Playwright API + spawriter extensions)')
  .option('--timeout <ms>', 'Execution timeout in ms (default: 30000)')
  .option('--port <port>', 'Port for MCP server (default: 19989)')
  .action(async (options: Record<string, unknown>) => {
    if (options.eval) {
      await executeCode({
        code: options.eval as string,
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
    process.exit(1);
  }

  const serverHost = host || process.env.SSPA_RELAY_HOST || '127.0.0.1';
  const port = getRelayPort();
  const serverUrl = `http://${serverHost}:${port}`;
  const authToken = token || getRelayToken();

  if (!host && !process.env.SSPA_RELAY_HOST) {
    await ensureRelayServer();
  }

  try {
    const response = await fetch(`${serverUrl}/cli/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ sessionId, code, timeout }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Error: ${response.status} ${text}`);
      process.exit(1);
    }

    const result = (await response.json()) as {
      text: string;
      images: Array<{ data: string; mimeType: string }>;
      isError: boolean;
    };

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

    if (result.isError) process.exit(1);
  } catch (error: any) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('Error: Cannot connect to relay server.');
      console.error('The relay server should start automatically. Check logs.');
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
}

// === skill ===
cli.command('skill', 'Print the full spawriter usage instructions').action(() => {
  const repoRoot = path.join(__dirname, '..', '..');
  const resolvedPath = path.join(repoRoot, 'skill.md');
  const fallback = path.join(__dirname, 'skill.md');
  const skillPath = fs.existsSync(resolvedPath) ? resolvedPath : fallback;

  if (!fs.existsSync(skillPath)) {
    console.error('skill.md not found.');
    process.exit(1);
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
  .option('--host <host>', 'Bind host (default: 0.0.0.0)')
  .option('--token <token>', 'Auth token (required for public host)')
  .option('--replace', 'Kill existing server if running')
  .action(async (options: Record<string, unknown>) => {
    const port = Number(options.port) || getRelayPort();

    if (options.replace) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          console.log(`Port ${port} in use, stopping existing server...`);
          try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 500));
        }
      } catch { /* not running */ }
    }

    process.env.SSPA_MCP_PORT = String(port);
    const { startRelayServer } = await import('./relay.js');
    await startRelayServer();
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
    console.log('ID'.padEnd(idWidth) + '  CREATED');
    console.log('-'.repeat(idWidth + 21));
    for (const s of sessions) {
      const time = new Date(s.createdAt).toISOString().slice(0, 19).replace('T', ' ');
      console.log(s.id.padEnd(idWidth) + '  ' + time);
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

// === logfile ===
cli.command('logfile', 'Print log file paths').action(async () => {
  const os = await import('node:os');
  const logDir = path.join(os.tmpdir(), 'spawriter');
  console.log(`relay: ${path.join(logDir, 'relay.log')}`);
});

cli.help();
cli.version(VERSION);
cli.parse();
