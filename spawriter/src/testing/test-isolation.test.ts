import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createIsolatedRunRoot,
  validateIsolation,
  cleanupRunRoot,
  applyIsolationEnv,
  type IsolatedRunRoot,
} from './test-isolation.js';

describe('Test Isolation (T39/T71)', () => {
  let runRoot: IsolatedRunRoot | undefined;

  afterEach(() => {
    if (runRoot) {
      cleanupRunRoot(runRoot);
      runRoot = undefined;
    }
  });

  it('creates isolated run root with all subdirectories', () => {
    runRoot = createIsolatedRunRoot();
    assert(fs.existsSync(runRoot.root));
    for (const dir of Object.values(runRoot.dirs)) {
      assert(fs.existsSync(dir), `${dir} should exist`);
    }
  });

  it('assigns a non-production port', () => {
    runRoot = createIsolatedRunRoot();
    assert.notEqual(runRoot.port, 19989);
    assert(runRoot.port > 0 && runRoot.port <= 65535);
  });

  it('generates a unique token', () => {
    runRoot = createIsolatedRunRoot();
    assert(runRoot.token.length >= 32);
  });

  it('generates unique run IDs', () => {
    runRoot = createIsolatedRunRoot();
    const root2 = createIsolatedRunRoot();
    assert.notEqual(runRoot.runId, root2.runId);
    cleanupRunRoot(root2);
  });

  it('validates isolation correctly', () => {
    runRoot = createIsolatedRunRoot();
    validateIsolation(runRoot); // should not throw
  });

  it('rejects port 19989', () => {
    runRoot = createIsolatedRunRoot();
    const bad = { ...runRoot, port: 19989 };
    assert.throws(() => validateIsolation(bad), /19989/);
  });

  it('sets correct env variables', () => {
    runRoot = createIsolatedRunRoot();
    assert.equal(runRoot.env.SSPA_MCP_PORT, String(runRoot.port));
    assert(runRoot.env.SSPA_DATA_ROOT.includes(runRoot.runId));
    assert(runRoot.env.SSPA_LOG_DIR.includes(runRoot.runId));
  });

  it('applies and restores environment', () => {
    runRoot = createIsolatedRunRoot();
    const originalPort = process.env.SSPA_MCP_PORT;

    const restore = applyIsolationEnv(runRoot);
    assert.equal(process.env.SSPA_MCP_PORT, String(runRoot.port));
    assert.equal(process.env.SSPA_DATA_ROOT, runRoot.dirs.journal);

    restore();
    assert.equal(process.env.SSPA_MCP_PORT, originalPort);
  });

  it('cleans up run root', () => {
    const root = createIsolatedRunRoot();
    const rootPath = root.root;
    assert(fs.existsSync(rootPath));
    cleanupRunRoot(root);
    assert(!fs.existsSync(rootPath));
  });

  it('refuses to clean outside temp directory', () => {
    runRoot = createIsolatedRunRoot();
    const realRoot = fs.realpathSync(runRoot.root);
    const realTemp = fs.realpathSync(os.tmpdir());
    assert(realRoot.startsWith(realTemp), 'Run root must be under temp');
  });

  it('directories do not escape via symlinks', () => {
    runRoot = createIsolatedRunRoot();
    // All dirs should resolve under the run root
    for (const [name, dir] of Object.entries(runRoot.dirs)) {
      const realDir = fs.realpathSync(dir);
      const realRoot = fs.realpathSync(runRoot.root);
      assert(
        realDir.startsWith(realRoot),
        `${name} (${realDir}) escapes run root (${realRoot})`,
      );
    }
  });
});
