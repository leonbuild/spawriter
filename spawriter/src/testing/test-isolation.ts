/**
 * Test isolation utilities.
 *
 * Ensures all tests run with dedicated TEMP, SSPA_DATA_ROOT, port, and
 * Chrome profile. Prevents any test from touching production relay at port
 * 19989 or the user's Chrome profile.
 *
 * §17.1/C12 of the stability plan.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface IsolatedRunRoot {
  /** Unique run ID. */
  runId: string;
  /** Root directory for this test run. */
  root: string;
  /** Subdirectories. */
  dirs: {
    profile: string;
    credentials: string;
    pairing: string;
    journal: string;
    locks: string;
    logs: string;
    downloads: string;
    fixtures: string;
    reports: string;
    temp: string;
  };
  /** Random port (not 19989). */
  port: number;
  /** Random token. */
  token: string;
  /** Environment overrides for child processes. */
  env: Record<string, string>;
}

/**
 * Create an isolated test run root.
 * Sets up directories and generates unique ports/tokens.
 */
export function createIsolatedRunRoot(prefix: string = 'spawriter-stability'): IsolatedRunRoot {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const root = path.join(os.tmpdir(), `${prefix}-${runId}`);

  const subdirs = [
    'profile', 'credentials', 'pairing', 'journal', 'locks',
    'logs', 'downloads', 'fixtures', 'reports', 'temp',
  ] as const;

  const dirs: Record<string, string> = {};
  for (const name of subdirs) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    dirs[name] = dir;
  }

  // Random port: use 0 (let OS pick) or a random high port
  // Port 0 is preferred for server tests; for relay config we pick a random high port
  const port = 10000 + Math.floor(Math.random() * 55000);

  // Random token
  const token = crypto.randomBytes(32).toString('hex');

  const env: Record<string, string> = {
    SSPA_MCP_PORT: String(port),
    SSPA_MCP_TOKEN: token,
    SSPA_DATA_ROOT: path.join(root, 'journal'),
    SSPA_LOG_DIR: path.join(root, 'logs'),
    TEMP: path.join(root, 'temp'),
    TMP: path.join(root, 'temp'),
    TMPDIR: path.join(root, 'temp'),
  };

  return {
    runId,
    root,
    dirs: dirs as IsolatedRunRoot['dirs'],
    port,
    token,
    env,
  };
}

/**
 * Validate that isolation is correctly configured.
 * Throws if production paths could be reached.
 */
export function validateIsolation(runRoot: IsolatedRunRoot): void {
  // Port must not be 19989 (production default)
  if (runRoot.port === 19989) {
    throw new Error('Test isolation violation: port is 19989 (production default)');
  }

  // Data root must be under our temp directory
  if (!runRoot.dirs.journal.startsWith(runRoot.root)) {
    throw new Error('Test isolation violation: data root escapes run root');
  }

  // Check for symlink/junction escape
  for (const [name, dir] of Object.entries(runRoot.dirs)) {
    const realDir = fs.realpathSync(dir);
    if (!realDir.startsWith(fs.realpathSync(runRoot.root))) {
      throw new Error(
        `Test isolation violation: ${name} dir resolves outside run root (${realDir})`,
      );
    }
  }

  // Verify SSPA_DATA_ROOT is set and not empty
  if (!runRoot.env.SSPA_DATA_ROOT) {
    throw new Error('Test isolation violation: SSPA_DATA_ROOT is empty');
  }

  // Verify no production environment variables leak through
  const dangerousVars = ['SSPA_MCP_TOKEN'];
  for (const v of dangerousVars) {
    if (process.env[v] && process.env[v] !== runRoot.env[v]) {
      throw new Error(
        `Test isolation violation: production ${v} could leak into test`,
      );
    }
  }
}

/**
 * Clean up an isolated run root.
 * Only removes directories under the known root.
 */
export function cleanupRunRoot(runRoot: IsolatedRunRoot): void {
  try {
    const realRoot = fs.realpathSync(runRoot.root);
    // Safety: only remove if it's actually in the temp directory
    if (!realRoot.startsWith(fs.realpathSync(os.tmpdir()))) {
      throw new Error('Refusing to clean directory outside temp');
    }
    fs.rmSync(runRoot.root, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

/**
 * Apply isolation environment to the current process (for test runners).
 * Returns a restore function.
 */
export function applyIsolationEnv(runRoot: IsolatedRunRoot): () => void {
  const saved: Record<string, string | undefined> = {};

  // Save and clear all SSPA_* vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SSPA_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  // Save TEMP/TMP/TMPDIR
  saved['TEMP'] = process.env.TEMP;
  saved['TMP'] = process.env.TMP;
  saved['TMPDIR'] = process.env.TMPDIR;

  // Apply isolated env
  for (const [key, value] of Object.entries(runRoot.env)) {
    process.env[key] = value;
  }

  return () => {
    // Restore original env
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Clear isolation env that wasn't in original
    for (const key of Object.keys(runRoot.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
  };
}
