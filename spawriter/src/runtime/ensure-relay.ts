import { getRelayPort } from '../utils.js';

let relayProcess: ReturnType<typeof import('child_process').spawn> | null = null;

export async function ensureRelayServer(options?: {
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
}): Promise<boolean> {
  const port = getRelayPort();
  const logger = options?.logger || console;

  const isRunning = await checkRelayRunning(port);
  if (isRunning) return false;

  logger.log(`Starting relay server on port ${port}...`);

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
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
