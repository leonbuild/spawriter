import { getRelayPort } from '../utils.js';

let relayProcess: ReturnType<typeof import('child_process').spawn> | null = null;

export async function ensureRelayServer(options?: {
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  force?: boolean;
}): Promise<boolean> {
  const port = getRelayPort();
  // stderr by default: stdout of CLI commands (e.g. `session new`) is a
  // machine-readable contract and must not be polluted by status messages.
  const logger = options?.logger || {
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
  };

  if (!options?.force) {
    const isRunning = await checkRelayRunning(port);
    if (isRunning) return false;
  }

  logger.log(`Relay not responding on port ${port}; starting relay server...`);

  const { spawn } = await import('child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  relayProcess = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'cli.js'), 'relay', '--port', String(port)],
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, SSPA_MCP_PORT: String(port) },
    },
  );
  relayProcess.unref();

  const startTime = Date.now();
  const timeout = 10000;
  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
    if (await checkRelayRunning(port)) {
      logger.log(`Relay server started on port ${port}`);
      return true;
    }
  }

  throw new Error(`Relay server failed to start within ${timeout}ms`);
}

async function checkRelayRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
