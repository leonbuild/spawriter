/**
 * Tests for MCP server logic: ensureSession mutex, AX tree formatting,
 * and command timeout classification.
 *
 * Run: npx tsx --test mcp/src/mcp.test.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Test: formatAXTreeAsText (inline copy to test without exporting from mcp.ts)
// ---------------------------------------------------------------------------

interface AXNode {
  nodeId: string;
  parentId?: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

function formatAXTreeAsText(nodes: AXNode[]): string {
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  const lines: string[] = [];

  function walk(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (node.ignored) {
      for (const childId of node.childIds ?? []) {
        walk(childId, depth);
      }
      return;
    }

    const role = node.role?.value ?? '';
    const name = node.name?.value ?? '';

    const props: string[] = [];
    for (const prop of node.properties ?? []) {
      const v = prop.value?.value;
      if (v === undefined || v === false || v === '') continue;
      if (prop.name === 'focusable') continue;
      props.push(`${prop.name}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }

    const indent = '  '.repeat(depth);
    const nameStr = name ? ` "${name}"` : '';
    const propsStr = props.length > 0 ? ` [${props.join(', ')}]` : '';
    if (role || name) {
      lines.push(`${indent}${role}${nameStr}${propsStr}`);
    }

    for (const childId of node.childIds ?? []) {
      walk(childId, depth + 1);
    }
  }

  const rootNode = nodes.find((n) => !n.parentId);
  if (rootNode) {
    walk(rootNode.nodeId, 0);
  }

  return lines.join('\n') || '(empty accessibility tree)';
}

// ---------------------------------------------------------------------------
// Test: getCommandTimeout
// ---------------------------------------------------------------------------

const SLOW_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'Page.captureScreenshot',
  'Network.clearBrowserCache',
  'Network.clearBrowserCookies',
  'Page.reload',
  'Page.navigate',
]);

function getCommandTimeout(method: string): number {
  return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
}

// ---------------------------------------------------------------------------
// Test: ensureSession mutex pattern
// ---------------------------------------------------------------------------

function createMutexSessionFactory() {
  let sessionPromise: Promise<string> | null = null;
  let callCount = 0;

  async function doEnsureSession(): Promise<string> {
    callCount++;
    const id = callCount;
    await new Promise((r) => setTimeout(r, 50));
    return `session-${id}`;
  }

  async function ensureSession(): Promise<string> {
    if (sessionPromise) {
      return sessionPromise;
    }
    sessionPromise = doEnsureSession();
    try {
      return await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  return { ensureSession, getCallCount: () => callCount };
}

// =========================================================================
// Tests
// =========================================================================

describe('formatAXTreeAsText', () => {
  it('should return empty message for no nodes', () => {
    assert.equal(formatAXTreeAsText([]), '(empty accessibility tree)');
  });

  it('should format a simple tree', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'My Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Hello World' } },
    ];
    const text = formatAXTreeAsText(nodes);
    assert.ok(text.includes('RootWebArea "My Page"'));
    assert.ok(text.includes('  heading "Hello World"'));
  });

  it('should skip ignored nodes but walk their children', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: true, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Click' } },
    ];
    const text = formatAXTreeAsText(nodes);
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes('button "Click"'));
    // button should be at depth 1, not 2, since parent was ignored
    assert.ok(lines[1].startsWith('  button'));
  });

  it('should include non-trivial properties', () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        role: { type: 'role', value: 'link' },
        name: { type: 'computedString', value: 'Home' },
        properties: [
          { name: 'url', value: { type: 'string', value: 'https://example.com' } },
          { name: 'focusable', value: { type: 'booleanOrUndefined', value: true } },
        ],
      },
    ];
    const text = formatAXTreeAsText(nodes);
    assert.ok(text.includes('[url=https://example.com]'));
    // focusable should be excluded
    assert.ok(!text.includes('focusable'));
  });
});

describe('getCommandTimeout', () => {
  it('should return 60s for slow commands', () => {
    assert.equal(getCommandTimeout('Accessibility.getFullAXTree'), 60000);
    assert.equal(getCommandTimeout('Page.captureScreenshot'), 60000);
    assert.equal(getCommandTimeout('Page.reload'), 60000);
    assert.equal(getCommandTimeout('Page.navigate'), 60000);
  });

  it('should return 30s for normal commands', () => {
    assert.equal(getCommandTimeout('Runtime.evaluate'), 30000);
    assert.equal(getCommandTimeout('Accessibility.enable'), 30000);
    assert.equal(getCommandTimeout('DOM.getDocument'), 30000);
  });
});

describe('ensureSession mutex', () => {
  it('should only create one session when called concurrently', async () => {
    const { ensureSession, getCallCount } = createMutexSessionFactory();

    const [s1, s2, s3] = await Promise.all([
      ensureSession(),
      ensureSession(),
      ensureSession(),
    ]);

    assert.equal(getCallCount(), 1, 'doEnsureSession should be called exactly once');
    assert.equal(s1, s2, 'all callers should get the same session');
    assert.equal(s2, s3, 'all callers should get the same session');
    assert.equal(s1, 'session-1');
  });

  it('should create a new session on the next call after the first completes', async () => {
    const { ensureSession, getCallCount } = createMutexSessionFactory();

    const s1 = await ensureSession();
    assert.equal(s1, 'session-1');

    const s2 = await ensureSession();
    assert.equal(s2, 'session-2');
    assert.equal(getCallCount(), 2);
  });
});

// ---------------------------------------------------------------------------
// Test: Override sync logic (pure function simulation)
// ---------------------------------------------------------------------------

interface SavedOverride {
  url: string;
  enabled: boolean;
}

type SavedOverrides = Record<string, SavedOverride>;
type PageOverrideMap = Record<string, string>;

/**
 * Pure logic extracted from useImportMapOverrides for testability.
 * Detects external changes between page overrides and saved overrides.
 */
function detectOverrideChanges(
  pageMap: PageOverrideMap,
  savedOverrides: SavedOverrides
): { hasChanges: boolean; merged: SavedOverrides } {
  const pageKeys = new Set(Object.keys(pageMap));
  const savedKeys = new Set(Object.keys(savedOverrides));
  let hasChanges = false;
  const merged: SavedOverrides = { ...savedOverrides };

  for (const appName of pageKeys) {
    const pageUrl = pageMap[appName];
    const saved = savedOverrides[appName];
    if (!saved || saved.url !== pageUrl) {
      merged[appName] = { url: pageUrl, enabled: true };
      hasChanges = true;
    } else if (saved && !saved.enabled && pageUrl) {
      merged[appName] = { ...saved, enabled: true };
      hasChanges = true;
    }
  }

  for (const appName of savedKeys) {
    if (savedOverrides[appName]?.enabled && !pageKeys.has(appName)) {
      merged[appName] = { ...savedOverrides[appName], enabled: false };
      hasChanges = true;
    }
  }

  return { hasChanges, merged };
}

/**
 * Pure logic: import page overrides into empty savedOverrides (fresh install scenario).
 */
function importPageOverrides(
  pageMap: PageOverrideMap,
  savedOverrides: SavedOverrides
): { hasNewOverrides: boolean; merged: SavedOverrides } {
  const merged = { ...savedOverrides };
  let hasNewOverrides = false;

  for (const [appName, pageUrl] of Object.entries(pageMap)) {
    if (pageUrl && !savedOverrides[appName]) {
      merged[appName] = { url: pageUrl, enabled: true };
      hasNewOverrides = true;
    }
  }

  return { hasNewOverrides, merged };
}

describe('detectOverrideChanges', () => {
  it('should detect no changes when page and saved are in sync', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9100/app.js' };
    const saved: SavedOverrides = { '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true } };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, false);
  });

  it('should detect new override added on page (MCP set)', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9100/app.js' };
    const saved: SavedOverrides = {};
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.deepEqual(result.merged['@cnic/main'], { url: 'http://localhost:9100/app.js', enabled: true });
  });

  it('should detect override URL change (MCP modified URL)', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9200/app.js' };
    const saved: SavedOverrides = { '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true } };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9200/app.js');
  });

  it('should detect override removed from page (MCP remove)', () => {
    const pageMap = {};
    const saved: SavedOverrides = { '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true } };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].enabled, false);
  });

  it('should re-enable disabled override if page has it active', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9100/app.js' };
    const saved: SavedOverrides = { '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: false } };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].enabled, true);
  });

  it('should handle multiple apps with mixed changes', () => {
    const pageMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
      '@journal/review': { url: 'http://localhost:9120/app.js', enabled: true },
    };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    // @cnic/main unchanged
    assert.deepEqual(result.merged['@cnic/main'], { url: 'http://localhost:9100/app.js', enabled: true });
    // @journal/edit is new
    assert.deepEqual(result.merged['@journal/edit'], { url: 'http://localhost:9130/app.js', enabled: true });
    // @journal/review was removed from page
    assert.equal(result.merged['@journal/review'].enabled, false);
  });
});

describe('importPageOverrides (fresh install sync)', () => {
  it('should import page overrides into empty savedOverrides', () => {
    const pageMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    const saved: SavedOverrides = {};
    const result = importPageOverrides(pageMap, saved);
    assert.equal(result.hasNewOverrides, true);
    assert.deepEqual(result.merged['@cnic/main'], { url: 'http://localhost:9100/app.js', enabled: true });
    assert.deepEqual(result.merged['@journal/edit'], { url: 'http://localhost:9130/app.js', enabled: true });
  });

  it('should not overwrite existing savedOverrides', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9200/app.js' };
    const saved: SavedOverrides = { '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: false } };
    const result = importPageOverrides(pageMap, saved);
    assert.equal(result.hasNewOverrides, false);
    // Should keep existing entry unchanged
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9100/app.js');
    assert.equal(result.merged['@cnic/main'].enabled, false);
  });

  it('should handle empty page map', () => {
    const pageMap = {};
    const saved: SavedOverrides = {};
    const result = importPageOverrides(pageMap, saved);
    assert.equal(result.hasNewOverrides, false);
    assert.deepEqual(result.merged, {});
  });

  it('should add only new overrides while keeping existing ones', () => {
    const pageMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
    };
    const result = importPageOverrides(pageMap, saved);
    assert.equal(result.hasNewOverrides, true);
    assert.equal(Object.keys(result.merged).length, 2);
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9100/app.js');
    assert.deepEqual(result.merged['@journal/edit'], { url: 'http://localhost:9130/app.js', enabled: true });
  });
});

// ---------------------------------------------------------------------------
// Test: formatAXTreeAsText – additional edge cases
// ---------------------------------------------------------------------------

describe('formatAXTreeAsText (edge cases)', () => {
  it('should handle deep nesting (3+ levels)', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'main' }, name: { type: 'computedString', value: '' }, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { type: 'role', value: 'section' }, name: { type: 'computedString', value: 'Content' }, childIds: ['4'] },
      { nodeId: '4', parentId: '3', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' } },
    ];
    const text = formatAXTreeAsText(nodes);
    const lines = text.split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0].startsWith('RootWebArea'));
    assert.ok(lines[1].startsWith('  main'));
    assert.ok(lines[2].startsWith('    section'));
    assert.ok(lines[3].startsWith('      button'));
  });

  it('should skip node with no role and no name', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'OK' } },
    ];
    const text = formatAXTreeAsText(nodes);
    const lines = text.split('\n');
    // Node 2 has no role/name -> not printed, but its child is walked
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('RootWebArea'));
    assert.ok(lines[1].includes('button "OK"'));
  });

  it('should handle multiple ignored nodes in a chain', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: true, childIds: ['3'] },
      { nodeId: '3', parentId: '2', ignored: true, childIds: ['4'] },
      { nodeId: '4', parentId: '3', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Deep' } },
    ];
    const text = formatAXTreeAsText(nodes);
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    // Both ignored nodes skipped, heading at depth 1
    assert.ok(lines[1].startsWith('  heading'));
  });

  it('should handle boolean true properties', () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        role: { type: 'role', value: 'checkbox' },
        name: { type: 'computedString', value: 'Accept' },
        properties: [
          { name: 'checked', value: { type: 'tristate', value: true } },
          { name: 'disabled', value: { type: 'boolean', value: false } },
        ],
      },
    ];
    const text = formatAXTreeAsText(nodes);
    assert.ok(text.includes('[checked=true]'));
    assert.ok(!text.includes('disabled'));
  });

  it('should handle orphan nodes without root', () => {
    const nodes: AXNode[] = [
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Orphan' } },
    ];
    const text = formatAXTreeAsText(nodes);
    assert.equal(text, '(empty accessibility tree)');
  });

  it('should handle node referencing non-existent child', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['999'] },
    ];
    const text = formatAXTreeAsText(nodes);
    assert.ok(text.includes('RootWebArea "Page"'));
    const lines = text.split('\n');
    assert.equal(lines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Test: ensureSession mutex – error recovery
// ---------------------------------------------------------------------------

describe('ensureSession mutex (error recovery)', () => {
  it('should release mutex when session creation fails', async () => {
    let callCount = 0;
    let sessionPromise: Promise<string> | null = null;

    async function doEnsureSession(): Promise<string> {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      if (callCount === 1) throw new Error('Connection refused');
      return `session-${callCount}`;
    }

    async function ensureSession(): Promise<string> {
      if (sessionPromise) return sessionPromise;
      sessionPromise = doEnsureSession();
      try {
        return await sessionPromise;
      } finally {
        sessionPromise = null;
      }
    }

    // First call should fail
    await assert.rejects(ensureSession, /Connection refused/);
    // Mutex should be released, second call should succeed
    const s2 = await ensureSession();
    assert.equal(s2, 'session-2');
    assert.equal(callCount, 2);
  });

  it('concurrent callers should all see the same error', async () => {
    let sessionPromise: Promise<string> | null = null;

    async function doEnsureSession(): Promise<string> {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('Network timeout');
    }

    async function ensureSession(): Promise<string> {
      if (sessionPromise) return sessionPromise;
      sessionPromise = doEnsureSession();
      try {
        return await sessionPromise;
      } finally {
        sessionPromise = null;
      }
    }

    const results = await Promise.allSettled([
      ensureSession(),
      ensureSession(),
      ensureSession(),
    ]);

    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.ok((result as PromiseRejectedResult).reason.message.includes('Network timeout'));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: getCommandTimeout – additional cases
// ---------------------------------------------------------------------------

describe('getCommandTimeout (additional)', () => {
  it('should return 60s for Network.clearBrowserCookies', () => {
    assert.equal(getCommandTimeout('Network.clearBrowserCookies'), 60000);
    assert.equal(getCommandTimeout('Network.clearBrowserCache'), 60000);
  });

  it('should return 30s for unknown/custom commands', () => {
    assert.equal(getCommandTimeout('Custom.myMethod'), 30000);
    assert.equal(getCommandTimeout(''), 30000);
  });
});

// ---------------------------------------------------------------------------
// Test: app_action JS code generation
// ---------------------------------------------------------------------------

function buildAppActionCode(action: string, appName: string): string {
  return `(async function() {
          var singleSpa = window.__SINGLE_SPA_DEVTOOLS__;
          var exposedMethods = singleSpa && singleSpa.exposedMethods;
          if (!exposedMethods) return JSON.stringify({ success: false, error: 'single-spa devtools not available' });

          var rawApps = exposedMethods.getRawAppData() || [];
          var app = rawApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
          if (!app) return JSON.stringify({ success: false, error: 'App not found: ${appName.replace(/'/g, "\\'")}'  });

          var action = ${JSON.stringify(action)};
          try {
            if (action === 'mount') {
              if (typeof app.devtools?.activeWhenForced === 'function') {
                app.devtools.activeWhenForced(true);
              }
              await exposedMethods.reroute();
            } else if (action === 'unmount') {
              if (typeof app.devtools?.activeWhenForced === 'function') {
                app.devtools.activeWhenForced(false);
              }
              await exposedMethods.reroute();
            } else if (action === 'unload') {
              if (typeof exposedMethods.toLoadPromise === 'function') {
                await exposedMethods.unregisterApplication(${JSON.stringify(appName)});
              }
              await exposedMethods.reroute();
            }
            var updatedApps = exposedMethods.getRawAppData() || [];
            var updatedApp = updatedApps.find(function(a) { return a.name === ${JSON.stringify(appName)}; });
            return JSON.stringify({ success: true, action: action, appName: ${JSON.stringify(appName)}, newStatus: updatedApp ? updatedApp.status : 'UNKNOWN' });
          } catch (e) {
            return JSON.stringify({ success: false, error: e.message || String(e) });
          }
        })()`;
}

describe('app_action JS code generation', () => {
  it('mount: should include activeWhenForced(true) and reroute', () => {
    const code = buildAppActionCode('mount', '@cnic/main');
    assert.ok(code.includes('activeWhenForced(true)'));
    assert.ok(code.includes('reroute()'));
    assert.ok(code.includes('"mount"'));
  });

  it('unmount: should include activeWhenForced(false) and reroute', () => {
    const code = buildAppActionCode('unmount', '@cnic/main');
    assert.ok(code.includes('activeWhenForced(false)'));
    assert.ok(code.includes('reroute()'));
  });

  it('unload: should include unregisterApplication and reroute', () => {
    const code = buildAppActionCode('unload', '@journal/edit');
    assert.ok(code.includes('unregisterApplication'));
    assert.ok(code.includes('@journal/edit'));
    assert.ok(code.includes('reroute()'));
  });

  it('should properly escape appName with special characters', () => {
    const code = buildAppActionCode('mount', "@org/app's-name");
    assert.ok(code.includes("@org/app's-name") || code.includes("@org/app\\'s-name"));
    assert.ok(code.startsWith('(async function()'));
  });

  it('should include error handling', () => {
    const code = buildAppActionCode('mount', '@cnic/main');
    assert.ok(code.includes('catch (e)'));
    assert.ok(code.includes('success: false'));
    assert.ok(code.includes('error: e.message'));
  });

  it('should check for __SINGLE_SPA_DEVTOOLS__ availability', () => {
    const code = buildAppActionCode('mount', '@cnic/main');
    assert.ok(code.includes('__SINGLE_SPA_DEVTOOLS__'));
    assert.ok(code.includes('single-spa devtools not available'));
  });

  it('should check if app exists before acting', () => {
    const code = buildAppActionCode('mount', '@missing/app');
    assert.ok(code.includes('App not found'));
  });
});

// ---------------------------------------------------------------------------
// Test: override_app parameter validation
// ---------------------------------------------------------------------------

/**
 * Simulates the override_app parameter validation and JS code generation
 * logic from mcp.ts without needing a live CDP session.
 */
function buildOverrideCode(
  action: string,
  appName?: string,
  url?: string,
): { error?: string; code?: string } {
  switch (action) {
    case 'set':
      if (!appName || !url) return { error: '"set" requires both appName and url' };
      return {
        code: `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.addOverride(${JSON.stringify(appName)}, ${JSON.stringify(url)});
              return JSON.stringify({ success: true, action: 'set', appName: ${JSON.stringify(appName)}, url: ${JSON.stringify(url)} });
            })()`,
      };
    case 'remove':
      if (!appName) return { error: '"remove" requires appName' };
      return {
        code: `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.removeOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'remove', appName: ${JSON.stringify(appName)} });
            })()`,
      };
    case 'enable':
      if (!appName) return { error: '"enable" requires appName' };
      return {
        code: `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.enableOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'enable', appName: ${JSON.stringify(appName)} });
            })()`,
      };
    case 'disable':
      if (!appName) return { error: '"disable" requires appName' };
      return {
        code: `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.disableOverride(${JSON.stringify(appName)});
              return JSON.stringify({ success: true, action: 'disable', appName: ${JSON.stringify(appName)} });
            })()`,
      };
    case 'reset_all':
      return {
        code: `(function() {
              if (!window.importMapOverrides) return JSON.stringify({ success: false, error: 'importMapOverrides not available' });
              window.importMapOverrides.resetOverrides();
              return JSON.stringify({ success: true, action: 'reset_all' });
            })()`,
      };
    default:
      return { error: `unknown action "${action}". Use: set, remove, enable, disable, reset_all` };
  }
}

describe('override_app parameter validation', () => {
  it('set: should reject missing appName', () => {
    const result = buildOverrideCode('set', undefined, 'http://localhost:9100/app.js');
    assert.ok(result.error);
    assert.ok(result.error!.includes('requires both'));
  });

  it('set: should reject missing url', () => {
    const result = buildOverrideCode('set', '@cnic/main', undefined);
    assert.ok(result.error);
    assert.ok(result.error!.includes('requires both'));
  });

  it('set: should reject both missing', () => {
    const result = buildOverrideCode('set');
    assert.ok(result.error);
  });

  it('set: should produce valid code with proper params', () => {
    const result = buildOverrideCode('set', '@cnic/main', 'http://localhost:9100/app.js');
    assert.ok(!result.error);
    assert.ok(result.code);
    assert.ok(result.code!.includes('addOverride'));
    assert.ok(result.code!.includes('@cnic/main'));
    assert.ok(result.code!.includes('http://localhost:9100/app.js'));
  });

  it('remove: should reject missing appName', () => {
    const result = buildOverrideCode('remove');
    assert.ok(result.error);
    assert.ok(result.error!.includes('requires appName'));
  });

  it('remove: should produce valid code', () => {
    const result = buildOverrideCode('remove', '@journal/edit');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('removeOverride'));
    assert.ok(result.code!.includes('@journal/edit'));
  });

  it('enable: should reject missing appName', () => {
    const result = buildOverrideCode('enable');
    assert.ok(result.error);
  });

  it('enable: should produce valid code', () => {
    const result = buildOverrideCode('enable', '@cnic/main');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('enableOverride'));
  });

  it('disable: should reject missing appName', () => {
    const result = buildOverrideCode('disable');
    assert.ok(result.error);
  });

  it('disable: should produce valid code', () => {
    const result = buildOverrideCode('disable', '@journal/edit');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('disableOverride'));
  });

  it('reset_all: should not require appName or url', () => {
    const result = buildOverrideCode('reset_all');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('resetOverrides'));
  });

  it('unknown action: should return error', () => {
    const result = buildOverrideCode('toggle');
    assert.ok(result.error);
    assert.ok(result.error!.includes('unknown action'));
    assert.ok(result.error!.includes('toggle'));
  });
});

// ---------------------------------------------------------------------------
// Test: override_app JS code safety (special characters in appName / url)
// ---------------------------------------------------------------------------

describe('override_app JS code generation', () => {
  it('should properly escape quotes in appName', () => {
    const result = buildOverrideCode('set', '@org/"special', 'http://localhost:9100/app.js');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('"'));
    // JSON.stringify handles the escaping; ensure it doesn't break the IIFE
    assert.ok(result.code!.startsWith('(function()'));
    assert.ok(result.code!.endsWith('})()'));
  });

  it('should properly escape backslashes in url', () => {
    const result = buildOverrideCode('set', '@cnic/main', 'http://localhost:9100/app\\test.js');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('\\\\'));
  });

  it('should handle scoped package names with slashes', () => {
    const result = buildOverrideCode('remove', '@scope/deep/nested/app');
    assert.ok(!result.error);
    assert.ok(result.code!.includes('@scope/deep/nested/app'));
  });
});

// ---------------------------------------------------------------------------
// Test: detectOverrideChanges – additional edge cases
// ---------------------------------------------------------------------------

describe('detectOverrideChanges (edge cases)', () => {
  it('should handle both page and saved being empty', () => {
    const result = detectOverrideChanges({}, {});
    assert.equal(result.hasChanges, false);
    assert.deepEqual(result.merged, {});
  });

  it('should not mark disabled saved override as changed if page also has no override', () => {
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: false },
    };
    const result = detectOverrideChanges({}, saved);
    assert.equal(result.hasChanges, false);
    assert.equal(result.merged['@cnic/main'].enabled, false);
  });

  it('should handle page override with empty URL string', () => {
    const pageMap: PageOverrideMap = { '@cnic/main': '' };
    const saved: SavedOverrides = {};
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].url, '');
    assert.equal(result.merged['@cnic/main'].enabled, true);
  });

  it('should detect URL change from one localhost port to another', () => {
    const pageMap = { '@cnic/main': 'http://localhost:9200/app.js' };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
    };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9200/app.js');
    assert.equal(result.merged['@cnic/main'].enabled, true);
  });

  it('should handle many apps with no changes (performance scenario)', () => {
    const pageMap: PageOverrideMap = {};
    const saved: SavedOverrides = {};
    for (let i = 0; i < 50; i++) {
      const name = `@org/app-${i}`;
      const url = `http://localhost:${9000 + i}/app.js`;
      pageMap[name] = url;
      saved[name] = { url, enabled: true };
    }
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, false);
    assert.equal(Object.keys(result.merged).length, 50);
  });

  it('should handle reset_all scenario: all page overrides removed at once', () => {
    const pageMap: PageOverrideMap = {};
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
      '@journal/edit': { url: 'http://localhost:9130/app.js', enabled: true },
      '@journal/review': { url: 'http://localhost:9120/app.js', enabled: true },
    };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@cnic/main'].enabled, false);
    assert.equal(result.merged['@journal/edit'].enabled, false);
    assert.equal(result.merged['@journal/review'].enabled, false);
    // URLs should be preserved
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9100/app.js');
    assert.equal(result.merged['@journal/edit'].url, 'http://localhost:9130/app.js');
  });

  it('should handle simultaneous add and remove of different apps', () => {
    const pageMap: PageOverrideMap = {
      '@journal/submit': 'http://localhost:9140/app.js',
    };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
    };
    const result = detectOverrideChanges(pageMap, saved);
    assert.equal(result.hasChanges, true);
    assert.equal(result.merged['@journal/submit'].enabled, true);
    assert.equal(result.merged['@cnic/main'].enabled, false);
  });
});

// ---------------------------------------------------------------------------
// Test: importPageOverrides – additional edge cases
// ---------------------------------------------------------------------------

describe('importPageOverrides (edge cases)', () => {
  it('should ignore page overrides with empty URL', () => {
    const pageMap: PageOverrideMap = { '@cnic/main': '' };
    const saved: SavedOverrides = {};
    const result = importPageOverrides(pageMap, saved);
    // Empty URL should be skipped (the `if (pageUrl &&` guard)
    assert.equal(result.hasNewOverrides, false);
    assert.equal(Object.keys(result.merged).length, 0);
  });

  it('should handle large number of page overrides', () => {
    const pageMap: PageOverrideMap = {};
    for (let i = 0; i < 20; i++) {
      pageMap[`@org/app-${i}`] = `http://localhost:${9000 + i}/app.js`;
    }
    const result = importPageOverrides(pageMap, {});
    assert.equal(result.hasNewOverrides, true);
    assert.equal(Object.keys(result.merged).length, 20);
    for (let i = 0; i < 20; i++) {
      const name = `@org/app-${i}`;
      assert.equal(result.merged[name].enabled, true);
      assert.equal(result.merged[name].url, `http://localhost:${9000 + i}/app.js`);
    }
  });

  it('should not modify the original savedOverrides object', () => {
    const pageMap = { '@journal/edit': 'http://localhost:9130/app.js' };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
    };
    const savedCopy = JSON.parse(JSON.stringify(saved));
    importPageOverrides(pageMap, saved);
    assert.deepEqual(saved, savedCopy);
  });

  it('should preserve disabled state of existing overrides', () => {
    const pageMap = {
      '@cnic/main': 'http://localhost:9999/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: false },
    };
    const result = importPageOverrides(pageMap, saved);
    assert.equal(result.hasNewOverrides, true);
    // Existing entry is not touched (even though page has different URL)
    assert.equal(result.merged['@cnic/main'].url, 'http://localhost:9100/app.js');
    assert.equal(result.merged['@cnic/main'].enabled, false);
    // New entry is added
    assert.deepEqual(result.merged['@journal/edit'], { url: 'http://localhost:9130/app.js', enabled: true });
  });
});

// ---------------------------------------------------------------------------
// Test: Full sync scenario simulation (set → detect → remove → detect)
// ---------------------------------------------------------------------------

describe('end-to-end sync simulation', () => {
  it('set override via MCP → detect change → remove override → detect removal', () => {
    // Step 1: Initial state – no overrides
    let savedOverrides: SavedOverrides = {};
    let pageMap: PageOverrideMap = {};

    // Step 2: MCP sets an override (modifies page localStorage)
    pageMap['@journal/edit'] = 'http://localhost:9130/app.js';

    // Step 3: External change detector runs
    let result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;
    assert.deepEqual(savedOverrides['@journal/edit'], { url: 'http://localhost:9130/app.js', enabled: true });

    // Step 4: After sync, no more changes
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, false);

    // Step 5: MCP removes the override
    delete pageMap['@journal/edit'];

    // Step 6: Detector runs again
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@journal/edit'].enabled, false);
    assert.equal(savedOverrides['@journal/edit'].url, 'http://localhost:9130/app.js');

    // Step 7: Stable again
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, false);
  });

  it('MCP updates URL → detect change → MCP reset_all → detect all disabled', () => {
    let savedOverrides: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
    };
    let pageMap: PageOverrideMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
    };

    // No change initially
    let result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, false);

    // MCP changes URL
    pageMap['@cnic/main'] = 'http://localhost:9999/app.js';
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@cnic/main'].url, 'http://localhost:9999/app.js');

    // MCP adds another override
    pageMap['@journal/edit'] = 'http://localhost:9130/app.js';
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;

    // MCP reset_all (clears all page overrides)
    pageMap = {};
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@cnic/main'].enabled, false);
    assert.equal(savedOverrides['@journal/edit'].enabled, false);
    // URLs preserved for re-enable
    assert.equal(savedOverrides['@cnic/main'].url, 'http://localhost:9999/app.js');
    assert.equal(savedOverrides['@journal/edit'].url, 'http://localhost:9130/app.js');
  });

  it('fresh install scenario: page has overrides, extension storage is empty', () => {
    const pageMap: PageOverrideMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    let savedOverrides: SavedOverrides = {};

    // importPageOverrides runs on init
    const importResult = importPageOverrides(pageMap, savedOverrides);
    assert.equal(importResult.hasNewOverrides, true);
    savedOverrides = importResult.merged;

    // After import, detectOverrideChanges should report no further changes
    const detectResult = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(detectResult.hasChanges, false);
  });

  it('re-enable after disable: MCP re-adds a previously disabled override', () => {
    let savedOverrides: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: false },
    };
    let pageMap: PageOverrideMap = {};

    // No change: both agree it's disabled
    let result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, false);

    // MCP re-enables by adding to page
    pageMap['@cnic/main'] = 'http://localhost:9100/app.js';
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, true);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@cnic/main'].enabled, true);
  });

  it('idempotency: running detect twice on stable state produces identical results', () => {
    const pageMap: PageOverrideMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
    };
    const saved: SavedOverrides = {
      '@cnic/main': { url: 'http://localhost:9100/app.js', enabled: true },
      '@journal/edit': { url: 'http://localhost:9130/app.js', enabled: true },
    };

    const r1 = detectOverrideChanges(pageMap, saved);
    const r2 = detectOverrideChanges(pageMap, r1.merged);
    assert.equal(r1.hasChanges, false);
    assert.equal(r2.hasChanges, false);
    assert.deepEqual(r1.merged, r2.merged);
  });

  it('rapid set→remove→set should converge to final state', () => {
    let savedOverrides: SavedOverrides = {};
    let pageMap: PageOverrideMap = {};

    // Rapid set
    pageMap['@cnic/main'] = 'http://localhost:9100/app.js';
    let result = detectOverrideChanges(pageMap, savedOverrides);
    savedOverrides = result.merged;

    // Rapid remove
    delete pageMap['@cnic/main'];
    result = detectOverrideChanges(pageMap, savedOverrides);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@cnic/main'].enabled, false);

    // Rapid set again with different URL
    pageMap['@cnic/main'] = 'http://localhost:9200/app.js';
    result = detectOverrideChanges(pageMap, savedOverrides);
    savedOverrides = result.merged;
    assert.equal(savedOverrides['@cnic/main'].enabled, true);
    assert.equal(savedOverrides['@cnic/main'].url, 'http://localhost:9200/app.js');

    // Stable
    result = detectOverrideChanges(pageMap, savedOverrides);
    assert.equal(result.hasChanges, false);
  });

  it('importPageOverrides followed by detectOverrideChanges with partial page changes', () => {
    // Extension reinstalled, page has 3 overrides
    const initialPageMap: PageOverrideMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9130/app.js',
      '@journal/review': 'http://localhost:9120/app.js',
    };
    let savedOverrides: SavedOverrides = {};

    // Step 1: Import on init
    const importResult = importPageOverrides(initialPageMap, savedOverrides);
    savedOverrides = importResult.merged;
    assert.equal(Object.keys(savedOverrides).length, 3);

    // Step 2: MCP removes one and changes another
    const updatedPageMap: PageOverrideMap = {
      '@cnic/main': 'http://localhost:9100/app.js',
      '@journal/edit': 'http://localhost:9999/app.js', // changed URL
      // @journal/review removed
    };
    const detectResult = detectOverrideChanges(updatedPageMap, savedOverrides);
    assert.equal(detectResult.hasChanges, true);
    savedOverrides = detectResult.merged;
    assert.equal(savedOverrides['@cnic/main'].enabled, true);
    assert.equal(savedOverrides['@journal/edit'].url, 'http://localhost:9999/app.js');
    assert.equal(savedOverrides['@journal/review'].enabled, false);
  });
});
