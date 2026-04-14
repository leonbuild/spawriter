/**
 * Tests for utility functions in utils.ts.
 *
 * Run: npx tsx --test mcp/src/utils.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION,
  DEFAULT_PORT,
  getEnv,
  sleep,
  getRelayPort,
  getRelayToken,
  getAllowedExtensionIds,
  getCdpUrl,
  isLocalhost,
  log,
  error,
  getAgentLabel,
  getProjectUrl,
  generateMcpClientId,
} from './utils.js';

// ---------------------------------------------------------------------------
// VERSION & DEFAULT_PORT
// ---------------------------------------------------------------------------

describe('VERSION', () => {
  it('should be a semver string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
  });
});

describe('DEFAULT_PORT', () => {
  it('should be 19989', () => {
    assert.equal(DEFAULT_PORT, 19989);
  });
});

// ---------------------------------------------------------------------------
// getEnv
// ---------------------------------------------------------------------------

describe('getEnv', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  it('should return env var value when set', () => {
    process.env.__TEST_UTILS_VAR = 'hello';
    assert.equal(getEnv('__TEST_UTILS_VAR'), 'hello');
  });

  it('should return undefined when env var is not set and no default', () => {
    delete process.env.__TEST_UTILS_MISSING;
    assert.equal(getEnv('__TEST_UTILS_MISSING'), undefined);
  });

  it('should return default value when env var is not set', () => {
    delete process.env.__TEST_UTILS_MISSING;
    assert.equal(getEnv('__TEST_UTILS_MISSING', 'fallback'), 'fallback');
  });

  it('should prefer env var over default value', () => {
    process.env.__TEST_UTILS_VAR = 'actual';
    assert.equal(getEnv('__TEST_UTILS_VAR', 'fallback'), 'actual');
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('should resolve after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });

  it('should return a Promise', () => {
    const result = sleep(1);
    assert.ok(result instanceof Promise);
  });
});

// ---------------------------------------------------------------------------
// getRelayPort
// ---------------------------------------------------------------------------

describe('getRelayPort', () => {
  const origPort = process.env.SSPA_MCP_PORT;

  afterEach(() => {
    if (origPort !== undefined) {
      process.env.SSPA_MCP_PORT = origPort;
    } else {
      delete process.env.SSPA_MCP_PORT;
    }
  });

  it('should return DEFAULT_PORT when SSPA_MCP_PORT is not set', () => {
    delete process.env.SSPA_MCP_PORT;
    assert.equal(getRelayPort(), DEFAULT_PORT);
  });

  it('should parse SSPA_MCP_PORT when set', () => {
    process.env.SSPA_MCP_PORT = '12345';
    assert.equal(getRelayPort(), 12345);
  });

  it('should return DEFAULT_PORT for non-numeric SSPA_MCP_PORT', () => {
    process.env.SSPA_MCP_PORT = 'abc';
    assert.equal(getRelayPort(), NaN); // parseInt('abc') → NaN
  });
});

// ---------------------------------------------------------------------------
// getRelayToken
// ---------------------------------------------------------------------------

describe('getRelayToken', () => {
  const origToken = process.env.SSPA_MCP_TOKEN;

  afterEach(() => {
    if (origToken !== undefined) {
      process.env.SSPA_MCP_TOKEN = origToken;
    } else {
      delete process.env.SSPA_MCP_TOKEN;
    }
  });

  it('should return undefined when SSPA_MCP_TOKEN is not set', () => {
    delete process.env.SSPA_MCP_TOKEN;
    assert.equal(getRelayToken(), undefined);
  });

  it('should return token when set', () => {
    process.env.SSPA_MCP_TOKEN = 'secret-token';
    assert.equal(getRelayToken(), 'secret-token');
  });
});

// ---------------------------------------------------------------------------
// getAllowedExtensionIds
// ---------------------------------------------------------------------------

describe('getAllowedExtensionIds', () => {
  const origIds = process.env.SSPA_EXTENSION_IDS;

  afterEach(() => {
    if (origIds !== undefined) {
      process.env.SSPA_EXTENSION_IDS = origIds;
    } else {
      delete process.env.SSPA_EXTENSION_IDS;
    }
  });

  it('should return empty array when not set', () => {
    delete process.env.SSPA_EXTENSION_IDS;
    assert.deepEqual(getAllowedExtensionIds(), []);
  });

  it('should parse comma-separated IDs', () => {
    process.env.SSPA_EXTENSION_IDS = 'abc123,def456';
    assert.deepEqual(getAllowedExtensionIds(), ['abc123', 'def456']);
  });

  it('should trim whitespace from IDs', () => {
    process.env.SSPA_EXTENSION_IDS = '  abc , def  ';
    assert.deepEqual(getAllowedExtensionIds(), ['abc', 'def']);
  });

  it('should filter out empty strings', () => {
    process.env.SSPA_EXTENSION_IDS = 'abc,,def,';
    assert.deepEqual(getAllowedExtensionIds(), ['abc', 'def']);
  });

  it('should return empty array for empty string', () => {
    process.env.SSPA_EXTENSION_IDS = '';
    assert.deepEqual(getAllowedExtensionIds(), []);
  });
});

// ---------------------------------------------------------------------------
// getCdpUrl
// ---------------------------------------------------------------------------

describe('getCdpUrl', () => {
  it('should build URL with default clientId', () => {
    assert.equal(getCdpUrl(19989), 'ws://127.0.0.1:19989/cdp/default');
  });

  it('should build URL with custom clientId', () => {
    assert.equal(getCdpUrl(12345, 'agent-1'), 'ws://127.0.0.1:12345/cdp/agent-1');
  });

  it('should use "default" when clientId is undefined', () => {
    assert.equal(getCdpUrl(8080, undefined), 'ws://127.0.0.1:8080/cdp/default');
  });
});

// ---------------------------------------------------------------------------
// isLocalhost
// ---------------------------------------------------------------------------

describe('isLocalhost', () => {
  it('should return true for 127.0.0.1', () => {
    assert.equal(isLocalhost('127.0.0.1'), true);
  });

  it('should return true for ::1', () => {
    assert.equal(isLocalhost('::1'), true);
  });

  it('should return true for ::ffff:127.0.0.1', () => {
    assert.equal(isLocalhost('::ffff:127.0.0.1'), true);
  });

  it('should return false for other addresses', () => {
    assert.equal(isLocalhost('192.168.1.1'), false);
    assert.equal(isLocalhost('10.0.0.1'), false);
    assert.equal(isLocalhost('0.0.0.0'), false);
    assert.equal(isLocalhost(''), false);
    assert.equal(isLocalhost('localhost'), false);
  });
});

// ---------------------------------------------------------------------------
// log / error
// ---------------------------------------------------------------------------

describe('log', () => {
  it('should write to stderr with [SPAWRITER] prefix', () => {
    const chunks: Buffer[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    log('test message', 42);

    process.stderr.write = orig;
    const output = Buffer.concat(chunks).toString();
    assert.match(output, /\[SPAWRITER\]/);
    assert.match(output, /test message 42/);
  });
});

describe('error', () => {
  it('should write to stderr with [SPAWRITER ERROR] prefix', () => {
    const chunks: Buffer[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    error('bad thing');

    process.stderr.write = orig;
    const output = Buffer.concat(chunks).toString();
    assert.match(output, /\[SPAWRITER ERROR\]/);
    assert.match(output, /bad thing/);
  });
});

// ---------------------------------------------------------------------------
// getAgentLabel
// ---------------------------------------------------------------------------

describe('getAgentLabel', () => {
  const origLabel = process.env.SSPA_AGENT_LABEL;

  afterEach(() => {
    if (origLabel !== undefined) {
      process.env.SSPA_AGENT_LABEL = origLabel;
    } else {
      delete process.env.SSPA_AGENT_LABEL;
    }
  });

  it('should return undefined when not set', () => {
    delete process.env.SSPA_AGENT_LABEL;
    assert.equal(getAgentLabel(), undefined);
  });

  it('should return the label when set', () => {
    process.env.SSPA_AGENT_LABEL = 'my-agent';
    assert.equal(getAgentLabel(), 'my-agent');
  });

  it('should return undefined for empty string', () => {
    process.env.SSPA_AGENT_LABEL = '';
    assert.equal(getAgentLabel(), undefined);
  });
});

// ---------------------------------------------------------------------------
// getProjectUrl
// ---------------------------------------------------------------------------

describe('getProjectUrl', () => {
  const origUrl = process.env.SSPA_PROJECT_URL;

  afterEach(() => {
    if (origUrl !== undefined) {
      process.env.SSPA_PROJECT_URL = origUrl;
    } else {
      delete process.env.SSPA_PROJECT_URL;
    }
  });

  it('should return undefined when not set', () => {
    delete process.env.SSPA_PROJECT_URL;
    assert.equal(getProjectUrl(), undefined);
  });

  it('should return the URL when set', () => {
    process.env.SSPA_PROJECT_URL = 'http://localhost:3000';
    assert.equal(getProjectUrl(), 'http://localhost:3000');
  });
});

// ---------------------------------------------------------------------------
// generateMcpClientId
// ---------------------------------------------------------------------------

describe('generateMcpClientId', () => {
  it('should start with "mcp-"', () => {
    assert.match(generateMcpClientId(), /^mcp-/);
  });

  it('should include the PID', () => {
    const id = generateMcpClientId();
    assert.ok(id.includes(String(process.pid)));
  });

  it('should generate unique IDs across different timestamps', async () => {
    const id1 = generateMcpClientId();
    await sleep(2);
    const id2 = generateMcpClientId();
    assert.notEqual(id1, id2);
  });

  it('should match expected format: mcp-{pid}-{base36}', () => {
    assert.match(generateMcpClientId(), /^mcp-\d+-[a-z0-9]+$/);
  });
});
