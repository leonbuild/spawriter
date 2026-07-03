/**
 * Integration tests for the relay control plane: the CSRF guard, the
 * non-`/cli/*` route protection, token gating, the extension-facing popup
 * relocation ownership flow, and the CDP JSONL log. These boot the real
 * server on an ephemeral loopback port (SSPA_MCP_PORT=0) and probe it over
 * HTTP and WebSocket.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type * as http from 'node:http';
import { WebSocket } from 'ws';

let server: http.Server;
let base: string;

before(async () => {
  process.env.SSPA_MCP_PORT = '0';
  delete process.env.SSPA_MCP_TOKEN;
  delete process.env.SSPA_RELAY_BIND_HOST;
  delete process.env.SSPA_EXTENSION_IDS;
  const { startRelayServer } = await import('./relay.js');
  server = await startRelayServer({ host: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.SSPA_MCP_TOKEN;
  if (server) {
    server.close();
    await once(server, 'close').catch(() => {});
  }
});

describe('relay HTTP control plane', () => {
  it('serves the unauthenticated health check', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'OK');
  });

  it('rejects cross-site requests on every route (CSRF/DNS-rebinding guard)', async () => {
    for (const path of ['/version', '/cli/sessions', '/shutdown']) {
      const res = await fetch(`${base}${path}`, {
        method: path === '/shutdown' ? 'POST' : 'GET',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(res.status, 403, `expected 403 for cross-site ${path}`);
    }
  });

  it('allows non-browser clients (no sec-fetch-site) to read version', async () => {
    const res = await fetch(`${base}/version`);
    assert.equal(res.status, 200);
    const body = await res.json() as { version: string };
    assert.equal(typeof body.version, 'string');
  });

  it('enforces application/json content-type on /cli POST', async () => {
    const res = await fetch(`${base}/cli/execute`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /Content-Type/i);
  });

  it('executes /cli path without a token when none is configured (no 401)', async () => {
    const res = await fetch(`${base}/cli/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json() as { sessions: unknown[] };
    assert.ok(Array.isArray(body.sessions));
  });

  it('reports no tab connected (not a crash) when executing with no extension', async () => {
    const res = await fetch(`${base}/cli/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'itest', code: '1+1' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { isError: boolean; text: string };
    assert.equal(body.isError, true);
    assert.match(body.text, /No tab connected/i);
  });

  it('gates /cli routes behind the token when SSPA_MCP_TOKEN is set', async () => {
    process.env.SSPA_MCP_TOKEN = 'secret-token';
    try {
      const noAuth = await fetch(`${base}/cli/sessions`);
      assert.equal(noAuth.status, 401);

      const badAuth = await fetch(`${base}/cli/sessions`, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(badAuth.status, 401);

      const goodAuth = await fetch(`${base}/cli/sessions`, { headers: { authorization: 'Bearer secret-token' } });
      assert.equal(goodAuth.status, 200);
    } finally {
      delete process.env.SSPA_MCP_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------
// Extension-facing flows: popup relocation ownership + CDP JSONL log
// ---------------------------------------------------------------------------

function connectFakeExtension(): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/extension`, {
    headers: { origin: 'chrome-extension://itestfakeextension' },
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function announceTab(ws: WebSocket, tabId: number, sessionId: string): void {
  ws.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      sessionId,
      params: {
        sessionId,
        targetInfo: { targetId: `target-${tabId}`, type: 'page', tabId, title: `Tab ${tabId}`, url: 'https://example.com' },
      },
    },
  }));
}

async function listTargets(): Promise<Array<{ tabId?: number; owner: string | null }>> {
  const res = await fetch(`${base}/json/list`);
  assert.equal(res.status, 200);
  return await res.json() as Array<{ tabId?: number; owner: string | null }>;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('popup relocation ownership (extension flow)', () => {
  let ws: WebSocket;

  before(async () => {
    ws = await connectFakeExtension();
  });

  after(() => {
    ws?.close();
  });

  it('auto-claims a relocated popup for the opener tab owner', async () => {
    announceTab(ws, 301, 'sess-tab-301');
    await waitFor(async () => (await listTargets()).find((t) => t.tabId === 301), 'tab 301 announce');

    const claim = await fetch(`${base}/cli/tab/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: 301, sessionId: 'popup-owner-session' }),
    });
    assert.equal(claim.status, 200);

    announceTab(ws, 302, 'sess-tab-302');
    await waitFor(async () => (await listTargets()).find((t) => t.tabId === 302), 'tab 302 announce');

    ws.send(JSON.stringify({ method: 'popupRelocated', params: { tabId: 302, sourceTabId: 301 } }));

    const popupTarget = await waitFor(async () => {
      const target = (await listTargets()).find((t) => t.tabId === 302);
      return target?.owner ? target : undefined;
    }, 'popup ownership');
    assert.equal(popupTarget.owner, 'popup-owner-session');
  });

  it('leaves a popup available when the opener is unowned', async () => {
    announceTab(ws, 303, 'sess-tab-303');
    announceTab(ws, 304, 'sess-tab-304');
    await waitFor(async () => (await listTargets()).find((t) => t.tabId === 304), 'tab 304 announce');

    ws.send(JSON.stringify({ method: 'popupRelocated', params: { tabId: 304, sourceTabId: 303 } }));
    // Give the relay time to (wrongly) claim; ownership must stay empty.
    await new Promise((r) => setTimeout(r, 300));
    const target = (await listTargets()).find((t) => t.tabId === 304);
    assert.ok(target, 'tab 304 should be announced');
    assert.equal(target!.owner, null);
  });
});

describe('CDP JSONL log', () => {
  it('records extension traffic but not dropped noisy events', async () => {
    const ws = await connectFakeExtension();
    try {
      announceTab(ws, 401, 'sess-tab-401');
      ws.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: { method: 'Network.dataReceived', sessionId: 'sess-tab-401', params: { requestId: 'r1' } },
      }));
      // The logger batches writes on a 500ms interval.
      await new Promise((r) => setTimeout(r, 800));

      const logPath = path.join(os.tmpdir(), 'spawriter', 'cdp.jsonl');
      assert.ok(fs.existsSync(logPath), 'cdp.jsonl should exist');
      const content = fs.readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('sess-tab-401'), 'announce should be logged');
      assert.ok(content.includes('"direction":"from-extension"'));
      assert.ok(!content.includes('Network.dataReceived'), 'dropped events must not be logged');

      const lines = content.trim().split('\n');
      const parsed = JSON.parse(lines[lines.length - 1]);
      assert.equal(typeof parsed.timestamp, 'string');
      assert.ok(['from-extension', 'to-extension', 'from-playwright', 'to-playwright'].includes(parsed.direction));
    } finally {
      ws.close();
    }
  });
});
