/**
 * Tests for MCP server logic: ensureSession mutex, AX tree formatting,
 * and command timeout classification.
 *
 * Run: npx tsx --test mcp/src/mcp.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
function formatAXTreeAsText(nodes) {
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.nodeId, node);
    }
    const lines = [];
    function walk(nodeId, depth) {
        const node = nodeMap.get(nodeId);
        if (!node)
            return;
        if (node.ignored) {
            for (const childId of node.childIds ?? []) {
                walk(childId, depth);
            }
            return;
        }
        const role = node.role?.value ?? '';
        const name = node.name?.value ?? '';
        const props = [];
        for (const prop of node.properties ?? []) {
            const v = prop.value?.value;
            if (v === undefined || v === false || v === '')
                continue;
            if (prop.name === 'focusable')
                continue;
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
function getCommandTimeout(method) {
    return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
}
// ---------------------------------------------------------------------------
// Test: ensureSession mutex pattern
// ---------------------------------------------------------------------------
function createMutexSessionFactory() {
    let sessionPromise = null;
    let callCount = 0;
    async function doEnsureSession() {
        callCount++;
        const id = callCount;
        await new Promise((r) => setTimeout(r, 50));
        return `session-${id}`;
    }
    async function ensureSession() {
        if (sessionPromise) {
            return sessionPromise;
        }
        sessionPromise = doEnsureSession();
        try {
            return await sessionPromise;
        }
        finally {
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
        const nodes = [
            { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'My Page' }, childIds: ['2'] },
            { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Hello World' } },
        ];
        const text = formatAXTreeAsText(nodes);
        assert.ok(text.includes('RootWebArea "My Page"'));
        assert.ok(text.includes('  heading "Hello World"'));
    });
    it('should skip ignored nodes but walk their children', () => {
        const nodes = [
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
        const nodes = [
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
//# sourceMappingURL=mcp.test.js.map