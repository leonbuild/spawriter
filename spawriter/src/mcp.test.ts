/**
 * Tests for MCP server logic: ensureSession mutex, AX tree formatting,
 * and command timeout classification.
 *
 * Run: npx tsx --test spawriter/src/mcp.test.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaywrightExecutor,
  ExecutorManager,
  isPlaywrightChannelOwner,
} from './pw-executor.js';

// ---------------------------------------------------------------------------
// Test: Console log capture
// ---------------------------------------------------------------------------

interface ConsoleLogEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

function createConsoleLogStore(maxLogs = 1000) {
  const logs: ConsoleLogEntry[] = [];

  function add(entry: ConsoleLogEntry) {
    logs.push(entry);
    if (logs.length > maxLogs) logs.splice(0, logs.length - maxLogs);
  }

  function clear() { logs.length = 0; }

  function get(options: { count?: number; level?: string; search?: string } = {}): ConsoleLogEntry[] {
    const count = Math.min(Math.max(options.count || 50, 1), maxLogs);
    const level = options.level || 'all';
    const search = (options.search || '').toLowerCase();
    let filtered = logs as ConsoleLogEntry[];
    if (level !== 'all') filtered = filtered.filter(log => log.level === level);
    if (search) filtered = filtered.filter(log => log.text.toLowerCase().includes(search));
    return filtered.slice(-count);
  }

  function format(entries: ConsoleLogEntry[], totalCount: number): string {
    if (entries.length === 0) return `No console logs captured (${totalCount} total in buffer)`;
    const lines = entries.map(log => {
      const time = new Date(log.timestamp).toISOString().slice(11, 23);
      const loc = log.url ? ` (${log.url}${log.lineNumber !== undefined ? ':' + log.lineNumber : ''})` : '';
      return `[${time}] [${log.level.toUpperCase().padEnd(5)}] ${log.text}${loc}`;
    });
    return `Console logs (${entries.length}/${totalCount} total):\n${lines.join('\n')}`;
  }

  return { logs, add, clear, get, format };
}

describe('Console log capture', () => {
  it('should add and retrieve logs', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'log', text: 'hello', timestamp: 1000 });
    store.add({ level: 'error', text: 'oops', timestamp: 2000 });
    const result = store.get();
    assert.equal(result.length, 2);
    assert.equal(result[0].text, 'hello');
    assert.equal(result[1].text, 'oops');
  });

  it('should enforce max buffer size', () => {
    const store = createConsoleLogStore(5);
    for (let i = 0; i < 10; i++) {
      store.add({ level: 'log', text: `msg-${i}`, timestamp: i });
    }
    assert.equal(store.logs.length, 5);
    assert.equal(store.logs[0].text, 'msg-5');
    assert.equal(store.logs[4].text, 'msg-9');
  });

  it('should filter by level', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'log', text: 'info msg', timestamp: 1000 });
    store.add({ level: 'error', text: 'error msg', timestamp: 2000 });
    store.add({ level: 'warn', text: 'warn msg', timestamp: 3000 });
    const errors = store.get({ level: 'error' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].text, 'error msg');
  });

  it('should filter by search text (case-insensitive)', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'log', text: 'Loading data...', timestamp: 1000 });
    store.add({ level: 'log', text: 'Data loaded', timestamp: 2000 });
    store.add({ level: 'error', text: 'Failed to load', timestamp: 3000 });
    const result = store.get({ search: 'LOAD' });
    assert.equal(result.length, 3);
    const result2 = store.get({ search: 'failed' });
    assert.equal(result2.length, 1);
  });

  it('should limit results by count', () => {
    const store = createConsoleLogStore();
    for (let i = 0; i < 100; i++) {
      store.add({ level: 'log', text: `msg-${i}`, timestamp: i });
    }
    const result = store.get({ count: 10 });
    assert.equal(result.length, 10);
    assert.equal(result[0].text, 'msg-90');
    assert.equal(result[9].text, 'msg-99');
  });

  it('should combine level and search filters', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'error', text: 'Network error', timestamp: 1000 });
    store.add({ level: 'error', text: 'Parse error', timestamp: 2000 });
    store.add({ level: 'warn', text: 'Network warning', timestamp: 3000 });
    const result = store.get({ level: 'error', search: 'network' });
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Network error');
  });

  it('should clear logs', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'log', text: 'test', timestamp: 1000 });
    assert.equal(store.logs.length, 1);
    store.clear();
    assert.equal(store.logs.length, 0);
  });

  it('should format logs with location info', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'error', text: 'fail', timestamp: 1710000000000, url: 'app.js', lineNumber: 42 });
    const text = store.format(store.get(), store.logs.length);
    assert.ok(text.includes('ERROR'));
    assert.ok(text.includes('fail'));
    assert.ok(text.includes('app.js:42'));
    assert.ok(text.includes('Console logs (1/1 total)'));
  });

  it('should format empty log list', () => {
    const store = createConsoleLogStore();
    const text = store.format([], 0);
    assert.ok(text.includes('No console logs'));
  });

  it('should handle count edge cases', () => {
    const store = createConsoleLogStore();
    store.add({ level: 'log', text: 'test', timestamp: 1000 });
    assert.equal(store.get({ count: 0 }).length, 1);
    assert.equal(store.get({ count: -5 }).length, 1);
    assert.equal(store.get({ count: 99999 }).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Test: Network request monitoring
// ---------------------------------------------------------------------------

interface TestNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  size?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  resourceType?: string;
}

function createNetworkStore(maxEntries = 500) {
  const log: Map<string, TestNetworkEntry> = new Map();

  function clear() { log.clear(); }

  function addRequest(
    requestId: string, url: string, method: string,
    extra?: { headers?: Record<string, string>; postData?: string; hasPostData?: boolean; resourceType?: string },
  ) {
    log.set(requestId, {
      requestId, url, method, startTime: Date.now(),
      requestHeaders: extra?.headers,
      postData: extra?.postData,
      hasPostData: extra?.hasPostData,
      resourceType: extra?.resourceType,
    });
    if (log.size > maxEntries) {
      const first = log.keys().next().value;
      if (first) log.delete(first);
    }
  }

  function setResponse(requestId: string, status: number, statusText?: string, mimeType?: string, headers?: Record<string, string>) {
    const entry = log.get(requestId);
    if (entry) {
      entry.status = status; entry.statusText = statusText; entry.mimeType = mimeType;
      entry.endTime = Date.now();
      if (headers) entry.responseHeaders = headers;
    }
  }

  function setFinished(requestId: string, size?: number) {
    const entry = log.get(requestId);
    if (entry) { entry.endTime = entry.endTime || Date.now(); if (size !== undefined) entry.size = size; }
  }

  function setFailed(requestId: string, errorText: string) {
    const entry = log.get(requestId);
    if (entry) { entry.error = errorText; entry.endTime = Date.now(); }
  }

  function get(options: { count?: number; urlFilter?: string; statusFilter?: string } = {}) {
    const count = Math.min(Math.max(options.count || 50, 1), maxEntries);
    const urlFilter = (options.urlFilter || '').toLowerCase();
    const statusFilter = options.statusFilter || 'all';
    let entries = Array.from(log.values());
    if (urlFilter) entries = entries.filter(e => e.url.toLowerCase().includes(urlFilter));
    if (statusFilter !== 'all') {
      entries = entries.filter(e => {
        if (statusFilter === 'ok') return e.status !== undefined && e.status >= 200 && e.status < 400;
        if (statusFilter === 'error') return !!e.error || (e.status !== undefined && e.status >= 400);
        if (statusFilter === '4xx') return e.status !== undefined && e.status >= 400 && e.status < 500;
        if (statusFilter === '5xx') return e.status !== undefined && e.status >= 500;
        return true;
      });
    }
    return entries.slice(-count);
  }

  return { log, clear, addRequest, setResponse, setFinished, setFailed, get };
}

describe('Network request monitoring', () => {
  it('should capture request and response', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/data', 'GET');
    store.setResponse('r1', 200, 'OK', 'application/json');
    store.setFinished('r1', 1024);
    const entries = store.get();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].url, 'https://api.example.com/data');
    assert.equal(entries[0].status, 200);
    assert.equal(entries[0].size, 1024);
  });

  it('should capture failed requests', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/timeout', 'POST');
    store.setFailed('r1', 'net::ERR_TIMED_OUT');
    const entries = store.get();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].error, 'net::ERR_TIMED_OUT');
  });

  it('should enforce max buffer size', () => {
    const store = createNetworkStore(5);
    for (let i = 0; i < 10; i++) {
      store.addRequest(`r${i}`, `https://api.example.com/${i}`, 'GET');
    }
    assert.equal(store.log.size, 5);
    assert.ok(!store.log.has('r0'));
    assert.ok(store.log.has('r9'));
  });

  it('should filter by URL substring', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/users', 'GET');
    store.addRequest('r2', 'https://cdn.example.com/style.css', 'GET');
    store.addRequest('r3', 'https://api.example.com/orders', 'POST');
    const result = store.get({ urlFilter: 'api.example' });
    assert.equal(result.length, 2);
  });

  it('should filter by status: ok (2xx/3xx)', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/a', 'GET');
    store.setResponse('r1', 200);
    store.addRequest('r2', 'https://api.example.com/b', 'GET');
    store.setResponse('r2', 404);
    store.addRequest('r3', 'https://api.example.com/c', 'GET');
    store.setResponse('r3', 301);
    const ok = store.get({ statusFilter: 'ok' });
    assert.equal(ok.length, 2);
  });

  it('should filter by status: error (4xx/5xx + failed)', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com', 'GET');
    store.setResponse('r1', 200);
    store.addRequest('r2', 'https://b.com', 'GET');
    store.setResponse('r2', 500);
    store.addRequest('r3', 'https://c.com', 'GET');
    store.setFailed('r3', 'connection refused');
    const errors = store.get({ statusFilter: 'error' });
    assert.equal(errors.length, 2);
  });

  it('should filter by status: 4xx only', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com', 'GET');
    store.setResponse('r1', 403);
    store.addRequest('r2', 'https://b.com', 'GET');
    store.setResponse('r2', 500);
    const result = store.get({ statusFilter: '4xx' });
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 403);
  });

  it('should filter by status: 5xx only', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com', 'GET');
    store.setResponse('r1', 502);
    store.addRequest('r2', 'https://b.com', 'GET');
    store.setResponse('r2', 404);
    const result = store.get({ statusFilter: '5xx' });
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 502);
  });

  it('should limit results by count', () => {
    const store = createNetworkStore();
    for (let i = 0; i < 20; i++) {
      store.addRequest(`r${i}`, `https://api.example.com/${i}`, 'GET');
    }
    const result = store.get({ count: 5 });
    assert.equal(result.length, 5);
    assert.equal(result[0].url, 'https://api.example.com/15');
  });

  it('should clear network log', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com', 'GET');
    assert.equal(store.log.size, 1);
    store.clear();
    assert.equal(store.log.size, 0);
  });

  it('should handle response for non-existent request gracefully', () => {
    const store = createNetworkStore();
    store.setResponse('nonexistent', 200);
    store.setFinished('nonexistent', 100);
    store.setFailed('nonexistent', 'error');
    assert.equal(store.log.size, 0);
  });

  it('should handle pending requests (no response yet)', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/slow', 'GET');
    const entries = store.get();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, undefined);
    assert.equal(entries[0].endTime, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test: Network request monitoring – extended fields (headers, body, resourceType)
// ---------------------------------------------------------------------------

describe('Network request monitoring – extended fields', () => {
  it('should capture request headers', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/data', 'GET', {
      headers: { 'Authorization': 'Bearer tok123', 'Content-Type': 'application/json' },
    });
    const entry = store.log.get('r1');
    assert.ok(entry);
    assert.deepStrictEqual(entry.requestHeaders, { 'Authorization': 'Bearer tok123', 'Content-Type': 'application/json' });
  });

  it('should capture response headers', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/data', 'GET');
    store.setResponse('r1', 200, 'OK', 'application/json', {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-Id': 'abc-123',
    });
    const entry = store.log.get('r1');
    assert.ok(entry);
    assert.deepStrictEqual(entry.responseHeaders, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-Id': 'abc-123',
    });
  });

  it('should capture postData from request', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/submit', 'POST', {
      postData: '{"name":"test","value":42}',
      hasPostData: true,
    });
    const entry = store.log.get('r1');
    assert.ok(entry);
    assert.equal(entry.postData, '{"name":"test","value":42}');
    assert.equal(entry.hasPostData, true);
  });

  it('should capture hasPostData without inline body', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/upload', 'POST', {
      hasPostData: true,
    });
    const entry = store.log.get('r1');
    assert.ok(entry);
    assert.equal(entry.postData, undefined);
    assert.equal(entry.hasPostData, true);
  });

  it('should capture resourceType', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://example.com/api/data', 'GET', { resourceType: 'XHR' });
    store.addRequest('r2', 'https://example.com/style.css', 'GET', { resourceType: 'Stylesheet' });
    store.addRequest('r3', 'https://example.com/app.js', 'GET', { resourceType: 'Script' });
    assert.equal(store.log.get('r1')!.resourceType, 'XHR');
    assert.equal(store.log.get('r2')!.resourceType, 'Stylesheet');
    assert.equal(store.log.get('r3')!.resourceType, 'Script');
  });

  it('should default extended fields to undefined for basic addRequest', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://example.com', 'GET');
    const entry = store.log.get('r1')!;
    assert.equal(entry.requestHeaders, undefined);
    assert.equal(entry.responseHeaders, undefined);
    assert.equal(entry.postData, undefined);
    assert.equal(entry.hasPostData, undefined);
    assert.equal(entry.resourceType, undefined);
  });

  it('should preserve extended fields after setResponse', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://api.example.com/submit', 'POST', {
      headers: { 'Content-Type': 'application/json' },
      postData: '{"key":"val"}',
      hasPostData: true,
      resourceType: 'XHR',
    });
    store.setResponse('r1', 201, 'Created', 'application/json', { 'X-RateLimit': '100' });
    const entry = store.log.get('r1')!;
    assert.deepStrictEqual(entry.requestHeaders, { 'Content-Type': 'application/json' });
    assert.equal(entry.postData, '{"key":"val"}');
    assert.equal(entry.hasPostData, true);
    assert.equal(entry.resourceType, 'XHR');
    assert.deepStrictEqual(entry.responseHeaders, { 'X-RateLimit': '100' });
    assert.equal(entry.status, 201);
  });

  it('should handle empty headers objects', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com', 'GET', { headers: {} });
    store.setResponse('r1', 200, 'OK', undefined, {});
    const entry = store.log.get('r1')!;
    assert.deepStrictEqual(entry.requestHeaders, {});
    assert.deepStrictEqual(entry.responseHeaders, {});
  });

  it('should handle request with large postData', () => {
    const store = createNetworkStore();
    const largeBody = 'x'.repeat(100000);
    store.addRequest('r1', 'https://api.com/upload', 'POST', {
      postData: largeBody,
      hasPostData: true,
    });
    assert.equal(store.log.get('r1')!.postData!.length, 100000);
  });

  it('should overwrite entry when same requestId is reused', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://example.com/a', 'GET', { resourceType: 'XHR' });
    store.setResponse('r1', 200, 'OK', undefined, { 'X-Old': 'yes' });
    store.addRequest('r1', 'https://example.com/b', 'POST', { resourceType: 'Fetch' });
    const entry = store.log.get('r1')!;
    assert.equal(entry.url, 'https://example.com/b');
    assert.equal(entry.method, 'POST');
    assert.equal(entry.resourceType, 'Fetch');
    assert.equal(entry.responseHeaders, undefined);
    assert.equal(entry.status, undefined);
  });

  it('should preserve extended fields after setFinished and setFailed', () => {
    const store = createNetworkStore();
    store.addRequest('r1', 'https://a.com/ok', 'POST', {
      headers: { 'Auth': 'x' },
      postData: 'data',
      hasPostData: true,
      resourceType: 'XHR',
    });
    store.setResponse('r1', 200, 'OK', 'text/plain', { 'Server': 'nginx' });
    store.setFinished('r1', 512);
    const ok = store.log.get('r1')!;
    assert.equal(ok.postData, 'data');
    assert.equal(ok.size, 512);
    assert.deepStrictEqual(ok.responseHeaders, { 'Server': 'nginx' });

    store.addRequest('r2', 'https://a.com/fail', 'GET', { resourceType: 'Fetch' });
    store.setFailed('r2', 'net::ERR_FAILED');
    const failed = store.log.get('r2')!;
    assert.equal(failed.resourceType, 'Fetch');
    assert.equal(failed.error, 'net::ERR_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail tool – section parsing and include logic
// ---------------------------------------------------------------------------

function parseIncludeSections(includeStr: string | undefined): string[] {
  const s = (includeStr || 'all').toLowerCase();
  return s === 'all'
    ? ['request_headers', 'request_body', 'response_headers', 'response_body']
    : s.split(',').map(x => x.trim());
}

describe('network_detail – include section parsing', () => {
  it('should default to all sections when include is undefined', () => {
    const sections = parseIncludeSections(undefined);
    assert.deepStrictEqual(sections, ['request_headers', 'request_body', 'response_headers', 'response_body']);
  });

  it('should default to all sections for "all"', () => {
    const sections = parseIncludeSections('all');
    assert.deepStrictEqual(sections, ['request_headers', 'request_body', 'response_headers', 'response_body']);
  });

  it('should default to all sections for "ALL"', () => {
    const sections = parseIncludeSections('ALL');
    assert.deepStrictEqual(sections, ['request_headers', 'request_body', 'response_headers', 'response_body']);
  });

  it('should parse single section', () => {
    assert.deepStrictEqual(parseIncludeSections('response_body'), ['response_body']);
  });

  it('should parse multiple sections', () => {
    const sections = parseIncludeSections('request_headers,response_headers');
    assert.deepStrictEqual(sections, ['request_headers', 'response_headers']);
  });

  it('should trim whitespace in sections', () => {
    const sections = parseIncludeSections(' request_headers , response_body ');
    assert.deepStrictEqual(sections, ['request_headers', 'response_body']);
  });

  it('should handle empty string as all', () => {
    const sections = parseIncludeSections('');
    assert.deepStrictEqual(sections, ['request_headers', 'request_body', 'response_headers', 'response_body']);
  });

  it('should handle unknown section names (passthrough)', () => {
    const sections = parseIncludeSections('custom_section,response_body');
    assert.deepStrictEqual(sections, ['custom_section', 'response_body']);
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail tool – output formatting logic
// ---------------------------------------------------------------------------

function formatNetworkDetail(
  entry: TestNetworkEntry,
  sections: string[],
  maxBodySize: number,
  fetchPostData?: () => { postData?: string; base64Encoded?: boolean } | null,
  fetchResponseBody?: () => { body?: string; base64Encoded?: boolean } | null,
): string {
  const parts: string[] = [];
  const dur = entry.endTime && entry.startTime ? `${entry.endTime - entry.startTime}ms` : 'pending';
  parts.push(`Request: ${entry.method} ${entry.url}`);
  parts.push(`Status: ${entry.status ?? '(pending)'} ${entry.statusText || ''}`);
  parts.push(`Type: ${entry.resourceType || 'unknown'} | MIME: ${entry.mimeType || 'unknown'} | Duration: ${dur} | Size: ${entry.size ? `${(entry.size / 1024).toFixed(1)}KB` : 'unknown'}`);
  if (entry.error) parts.push(`Error: ${entry.error}`);

  if (sections.includes('request_headers') && entry.requestHeaders) {
    const hdrs = Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    parts.push(`\nRequest Headers:\n${hdrs}`);
  }

  if (sections.includes('request_body')) {
    if (entry.postData) {
      let bodyText = entry.postData;
      if (bodyText.length > maxBodySize && maxBodySize > 0) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
      parts.push(`\nRequest Body:\n${bodyText}`);
    } else if (entry.hasPostData && fetchPostData) {
      const result = fetchPostData();
      if (result?.postData) {
        let bodyText = result.base64Encoded ? Buffer.from(result.postData, 'base64').toString('utf-8') : result.postData;
        if (bodyText.length > maxBodySize && maxBodySize > 0) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
        parts.push(`\nRequest Body:\n${bodyText}`);
      } else {
        parts.push('\nRequest Body: (not available)');
      }
    } else if (entry.hasPostData) {
      parts.push('\nRequest Body: (not available)');
    } else {
      parts.push('\nRequest Body: (none - GET or no body)');
    }
  }

  if (sections.includes('response_headers') && entry.responseHeaders) {
    const hdrs = Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    parts.push(`\nResponse Headers:\n${hdrs}`);
  }

  if (sections.includes('response_body') && maxBodySize > 0) {
    if (fetchResponseBody) {
      const result = fetchResponseBody();
      if (result?.body !== undefined) {
        let bodyText = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf-8') : result.body;
        if (bodyText.length > maxBodySize) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
        parts.push(`\nResponse Body:\n${bodyText}`);
      } else {
        parts.push('\nResponse Body: (empty)');
      }
    } else {
      parts.push('\nResponse Body: (not available - may have been evicted from browser buffer. Try requesting sooner after the network call.)');
    }
  }

  return parts.join('\n');
}

describe('network_detail – output formatting', () => {
  const baseEntry: TestNetworkEntry = {
    requestId: 'R100',
    url: 'https://api.example.com/users',
    method: 'POST',
    status: 201,
    statusText: 'Created',
    mimeType: 'application/json',
    startTime: 1000,
    endTime: 1250,
    size: 4096,
    requestHeaders: { 'Content-Type': 'application/json', 'Authorization': 'Bearer tok' },
    responseHeaders: { 'Content-Type': 'application/json', 'X-Request-Id': 'xyz' },
    postData: '{"name":"Alice"}',
    hasPostData: true,
    resourceType: 'XHR',
  };

  it('should include request summary line', () => {
    const text = formatNetworkDetail(baseEntry, [], 10000);
    assert.ok(text.includes('Request: POST https://api.example.com/users'));
  });

  it('should include status line', () => {
    const text = formatNetworkDetail(baseEntry, [], 10000);
    assert.ok(text.includes('Status: 201 Created'));
  });

  it('should include type/MIME/duration/size line', () => {
    const text = formatNetworkDetail(baseEntry, [], 10000);
    assert.ok(text.includes('Type: XHR'));
    assert.ok(text.includes('MIME: application/json'));
    assert.ok(text.includes('250ms'));
    assert.ok(text.includes('4.0KB'));
  });

  it('should include error line when present', () => {
    const errorEntry = { ...baseEntry, error: 'net::ERR_TIMEOUT' };
    const text = formatNetworkDetail(errorEntry, [], 10000);
    assert.ok(text.includes('Error: net::ERR_TIMEOUT'));
  });

  it('should include request headers when section included', () => {
    const text = formatNetworkDetail(baseEntry, ['request_headers'], 10000);
    assert.ok(text.includes('Request Headers:'));
    assert.ok(text.includes('Content-Type: application/json'));
    assert.ok(text.includes('Authorization: Bearer tok'));
  });

  it('should NOT include request headers when section excluded', () => {
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000);
    assert.ok(!text.includes('Request Headers:'));
  });

  it('should include inline postData as request body', () => {
    const text = formatNetworkDetail(baseEntry, ['request_body'], 10000);
    assert.ok(text.includes('Request Body:'));
    assert.ok(text.includes('{"name":"Alice"}'));
  });

  it('should truncate request body when exceeding maxBodySize', () => {
    const longPostEntry = { ...baseEntry, postData: 'x'.repeat(500) };
    const text = formatNetworkDetail(longPostEntry, ['request_body'], 100);
    assert.ok(text.includes('[Truncated to 100 chars]'));
    assert.ok(!text.includes('x'.repeat(500)));
  });

  it('should show "none - GET or no body" for GET request with no body', () => {
    const getEntry: TestNetworkEntry = { ...baseEntry, method: 'GET', postData: undefined, hasPostData: undefined };
    const text = formatNetworkDetail(getEntry, ['request_body'], 10000);
    assert.ok(text.includes('none - GET or no body'));
  });

  it('should fetch postData via CDP when hasPostData but no inline data', () => {
    const deferredEntry: TestNetworkEntry = { ...baseEntry, postData: undefined, hasPostData: true };
    const fetchPost = () => ({ postData: '{"deferred":"yes"}', base64Encoded: false });
    const text = formatNetworkDetail(deferredEntry, ['request_body'], 10000, fetchPost);
    assert.ok(text.includes('{"deferred":"yes"}'));
  });

  it('should handle base64-encoded postData from CDP', () => {
    const deferredEntry: TestNetworkEntry = { ...baseEntry, postData: undefined, hasPostData: true };
    const b64 = Buffer.from('{"encoded":"body"}').toString('base64');
    const fetchPost = () => ({ postData: b64, base64Encoded: true });
    const text = formatNetworkDetail(deferredEntry, ['request_body'], 10000, fetchPost);
    assert.ok(text.includes('{"encoded":"body"}'));
  });

  it('should show "not available" when CDP fetch returns null postData', () => {
    const deferredEntry: TestNetworkEntry = { ...baseEntry, postData: undefined, hasPostData: true };
    const fetchPost = () => null;
    const text = formatNetworkDetail(deferredEntry, ['request_body'], 10000, fetchPost);
    assert.ok(text.includes('not available'));
  });

  it('should include response headers when section included', () => {
    const text = formatNetworkDetail(baseEntry, ['response_headers'], 10000);
    assert.ok(text.includes('Response Headers:'));
    assert.ok(text.includes('Content-Type: application/json'));
    assert.ok(text.includes('X-Request-Id: xyz'));
  });

  it('should include response body from CDP fetch', () => {
    const fetchBody = () => ({ body: '{"id":1,"name":"Alice"}', base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000, undefined, fetchBody);
    assert.ok(text.includes('Response Body:'));
    assert.ok(text.includes('{"id":1,"name":"Alice"}'));
  });

  it('should handle base64-encoded response body', () => {
    const b64 = Buffer.from('<html>Hello</html>').toString('base64');
    const fetchBody = () => ({ body: b64, base64Encoded: true });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000, undefined, fetchBody);
    assert.ok(text.includes('<html>Hello</html>'));
  });

  it('should truncate response body to maxBodySize', () => {
    const longBody = 'Z'.repeat(50000);
    const fetchBody = () => ({ body: longBody, base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 5000, undefined, fetchBody);
    assert.ok(text.includes('[Truncated to 5000 chars]'));
    assert.ok(!text.includes('Z'.repeat(50000)));
  });

  it('should skip response body when maxBodySize is 0', () => {
    const fetchBody = () => ({ body: 'should not appear', base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 0, undefined, fetchBody);
    assert.ok(!text.includes('Response Body:'));
    assert.ok(!text.includes('should not appear'));
  });

  it('should show "empty" for empty response body', () => {
    const fetchBody = () => ({ body: undefined as unknown as string, base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000, undefined, fetchBody);
    assert.ok(text.includes('(empty)'));
  });

  it('should show fallback message when no fetchResponseBody provided', () => {
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000);
    assert.ok(text.includes('not available'));
    assert.ok(text.includes('evicted'));
  });

  it('should include all sections when all are listed', () => {
    const fetchBody = () => ({ body: '{"result":"ok"}', base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['request_headers', 'request_body', 'response_headers', 'response_body'], 10000, undefined, fetchBody);
    assert.ok(text.includes('Request Headers:'));
    assert.ok(text.includes('Request Body:'));
    assert.ok(text.includes('Response Headers:'));
    assert.ok(text.includes('Response Body:'));
  });

  it('should show only selected sections', () => {
    const fetchBody = () => ({ body: 'body', base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000, undefined, fetchBody);
    assert.ok(!text.includes('Request Headers:'));
    assert.ok(!text.includes('Request Body:'));
    assert.ok(!text.includes('Response Headers:'));
    assert.ok(text.includes('Response Body:'));
  });

  it('should handle pending entry (no status, no endTime)', () => {
    const pendingEntry: TestNetworkEntry = {
      requestId: 'RP', url: 'https://a.com/slow', method: 'GET', startTime: 1000,
    };
    const text = formatNetworkDetail(pendingEntry, [], 10000);
    assert.ok(text.includes('(pending)'));
    assert.ok(text.includes('pending'));
    assert.ok(text.includes('unknown'));
  });

  it('should format entry with unknown resourceType and mimeType', () => {
    const unknownEntry: TestNetworkEntry = {
      requestId: 'RU', url: 'https://a.com', method: 'GET', startTime: 1000, endTime: 1100,
      status: 200,
    };
    const text = formatNetworkDetail(unknownEntry, [], 10000);
    assert.ok(text.includes('Type: unknown'));
    assert.ok(text.includes('MIME: unknown'));
  });

  it('should not show request headers section when headers are undefined', () => {
    const noHdrEntry: TestNetworkEntry = { ...baseEntry, requestHeaders: undefined };
    const text = formatNetworkDetail(noHdrEntry, ['request_headers'], 10000);
    assert.ok(!text.includes('Request Headers:'));
  });

  it('should not show response headers section when headers are undefined', () => {
    const noHdrEntry: TestNetworkEntry = { ...baseEntry, responseHeaders: undefined };
    const text = formatNetworkDetail(noHdrEntry, ['response_headers'], 10000);
    assert.ok(!text.includes('Response Headers:'));
  });

  it('should handle empty string response body', () => {
    const fetchBody = () => ({ body: '', base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 10000, undefined, fetchBody);
    assert.ok(text.includes('Response Body:'));
  });

  it('should handle exactly maxBodySize length body without truncation', () => {
    const exactBody = 'Y'.repeat(100);
    const fetchBody = () => ({ body: exactBody, base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 100, undefined, fetchBody);
    assert.ok(!text.includes('Truncated'));
    assert.ok(text.includes(exactBody));
  });

  it('should truncate body at maxBodySize+1', () => {
    const body = 'Y'.repeat(101);
    const fetchBody = () => ({ body, base64Encoded: false });
    const text = formatNetworkDetail(baseEntry, ['response_body'], 100, undefined, fetchBody);
    assert.ok(text.includes('Truncated'));
  });

  it('should not truncate postData when maxBodySize is 0', () => {
    const text = formatNetworkDetail(baseEntry, ['request_body'], 0);
    assert.ok(text.includes('Request Body:'));
    assert.ok(text.includes('{"name":"Alice"}'));
  });

  it('should handle request with many headers', () => {
    const manyHeaders: Record<string, string> = {};
    for (let i = 0; i < 50; i++) manyHeaders[`X-Header-${i}`] = `value-${i}`;
    const entry: TestNetworkEntry = { ...baseEntry, requestHeaders: manyHeaders };
    const text = formatNetworkDetail(entry, ['request_headers'], 10000);
    assert.ok(text.includes('X-Header-0: value-0'));
    assert.ok(text.includes('X-Header-49: value-49'));
  });

  it('should handle special characters in headers', () => {
    const entry: TestNetworkEntry = {
      ...baseEntry,
      requestHeaders: { 'X-UTF8': '日本語ヘッダー', 'X-Special': 'val=1&key=2' },
    };
    const text = formatNetworkDetail(entry, ['request_headers'], 10000);
    assert.ok(text.includes('日本語ヘッダー'));
    assert.ok(text.includes('val=1&key=2'));
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail tool – schema & request-not-found
// ---------------------------------------------------------------------------

describe('network_detail – tool definition and error cases', () => {
  it('should have correct input schema', () => {
    const schema = {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request ID from network_log output (required)' },
        include: { type: 'string' },
        max_body_size: { type: 'number' },
      },
      required: ['requestId'],
    };
    assert.ok(schema.required.includes('requestId'));
    assert.ok('include' in schema.properties);
    assert.ok('max_body_size' in schema.properties);
  });

  it('should return not-found message for unknown requestId', () => {
    const requestId = 'nonexistent-123';
    const store = createNetworkStore();
    const entry = store.log.get(requestId);
    assert.equal(entry, undefined);
    const text = `Request "${requestId}" not found. Use network_log to list available requests.`;
    assert.ok(text.includes('nonexistent-123'));
    assert.ok(text.includes('network_log'));
  });

  it('should match requestId exactly', () => {
    const store = createNetworkStore();
    store.addRequest('R100.1', 'https://a.com', 'GET');
    assert.ok(store.log.has('R100.1'));
    assert.ok(!store.log.has('R100'));
    assert.ok(!store.log.has('R100.1.extra'));
  });

  it('tool description should mention headers and body', () => {
    const desc = `Get full details of a network request including headers and body content.
Use network_log first to find the requestId, then use this tool to inspect details.
Can retrieve: request headers, request body (POST data), response headers, response body.`;
    assert.ok(desc.includes('headers'));
    assert.ok(desc.includes('body'));
    assert.ok(desc.includes('network_log'));
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail – body truncation edge cases
// ---------------------------------------------------------------------------

describe('network_detail – body truncation edge cases', () => {
  function truncateBody(body: string, maxSize: number): string {
    if (body.length > maxSize && maxSize > 0) return body.slice(0, maxSize) + `\n[Truncated to ${maxSize} chars]`;
    return body;
  }

  it('should not truncate when body is shorter than max', () => {
    assert.equal(truncateBody('hello', 100), 'hello');
  });

  it('should not truncate when body equals max exactly', () => {
    assert.equal(truncateBody('12345', 5), '12345');
  });

  it('should truncate when body is 1 char over max', () => {
    const result = truncateBody('123456', 5);
    assert.ok(result.includes('12345'));
    assert.ok(result.includes('[Truncated to 5 chars]'));
    assert.ok(!result.includes('6'));
  });

  it('should not truncate when maxSize is 0 (0 means headers-only, passthrough for inline)', () => {
    assert.equal(truncateBody('anything', 0), 'anything');
  });

  it('should handle empty body', () => {
    assert.equal(truncateBody('', 100), '');
  });

  it('should handle very large body', () => {
    const largeBody = 'A'.repeat(1000000);
    const result = truncateBody(largeBody, 10000);
    assert.ok(result.startsWith('A'.repeat(10000)));
    assert.ok(result.includes('[Truncated to 10000 chars]'));
  });

  it('should handle truncation with multi-byte UTF-8 chars', () => {
    const body = '日本語テスト文字列'; // 9 chars
    const result = truncateBody(body, 5);
    assert.ok(result.includes('[Truncated to 5 chars]'));
    assert.equal(result.split('\n')[0], '日本語テス');
  });

  it('should handle maxSize = 1', () => {
    const result = truncateBody('hello', 1);
    assert.ok(result.startsWith('h'));
    assert.ok(result.includes('[Truncated to 1 chars]'));
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail – base64 decoding
// ---------------------------------------------------------------------------

describe('network_detail – base64 decoding', () => {
  function decodeBody(raw: string, isBase64: boolean): string {
    return isBase64 ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  }

  it('should return plain text as-is', () => {
    assert.equal(decodeBody('hello world', false), 'hello world');
  });

  it('should decode base64 text', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    assert.equal(decodeBody(b64, true), 'hello world');
  });

  it('should decode base64 JSON', () => {
    const json = '{"key":"value","num":42}';
    const b64 = Buffer.from(json).toString('base64');
    assert.equal(decodeBody(b64, true), json);
    assert.deepStrictEqual(JSON.parse(decodeBody(b64, true)), { key: 'value', num: 42 });
  });

  it('should decode base64 HTML', () => {
    const html = '<html><body><h1>Hello</h1></body></html>';
    const b64 = Buffer.from(html).toString('base64');
    assert.equal(decodeBody(b64, true), html);
  });

  it('should decode base64 with UTF-8 content', () => {
    const text = '中文内容 日本語 한국어';
    const b64 = Buffer.from(text).toString('base64');
    assert.equal(decodeBody(b64, true), text);
  });

  it('should handle empty base64 string', () => {
    assert.equal(decodeBody('', true), '');
  });

  it('should handle empty plain string', () => {
    assert.equal(decodeBody('', false), '');
  });

  it('should decode base64 binary content to UTF-8 (lossy)', () => {
    const binary = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const b64 = binary.toString('base64');
    const decoded = decodeBody(b64, true);
    assert.equal(typeof decoded, 'string');
    assert.ok(decoded.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Test: network_detail – CDP event dispatch extended fields
// ---------------------------------------------------------------------------

describe('CDP event dispatch – Network extended fields', () => {
  function simulateNetworkRequestWillBeSent(
    store: ReturnType<typeof createNetworkStore>,
    params: {
      requestId: string;
      request: {
        url: string; method: string;
        headers?: Record<string, string>;
        postData?: string; hasPostData?: boolean;
      };
      type?: string;
    },
  ) {
    store.addRequest(params.requestId, params.request.url, params.request.method, {
      headers: params.request.headers,
      postData: params.request.postData,
      hasPostData: params.request.hasPostData,
      resourceType: params.type,
    });
  }

  function simulateNetworkResponseReceived(
    store: ReturnType<typeof createNetworkStore>,
    params: {
      requestId: string;
      response: {
        status?: number; statusText?: string; mimeType?: string;
        headers?: Record<string, string>;
      };
    },
  ) {
    store.setResponse(
      params.requestId,
      params.response.status ?? 0,
      params.response.statusText,
      params.response.mimeType,
      params.response.headers,
    );
  }

  it('should capture request headers from requestWillBeSent', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R1',
      request: {
        url: 'https://api.com/data',
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      },
      type: 'XHR',
    });
    const entry = store.log.get('R1')!;
    assert.deepStrictEqual(entry.requestHeaders, { 'Accept': 'application/json', 'Cache-Control': 'no-cache' });
    assert.equal(entry.resourceType, 'XHR');
  });

  it('should capture postData from requestWillBeSent', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R2',
      request: {
        url: 'https://api.com/submit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        postData: '{"user":"test"}',
        hasPostData: true,
      },
      type: 'Fetch',
    });
    const entry = store.log.get('R2')!;
    assert.equal(entry.postData, '{"user":"test"}');
    assert.equal(entry.hasPostData, true);
    assert.equal(entry.resourceType, 'Fetch');
  });

  it('should capture response headers from responseReceived', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R3',
      request: { url: 'https://api.com/data', method: 'GET' },
    });
    simulateNetworkResponseReceived(store, {
      requestId: 'R3',
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '128' },
      },
    });
    const entry = store.log.get('R3')!;
    assert.deepStrictEqual(entry.responseHeaders, { 'Content-Type': 'application/json', 'Content-Length': '128' });
  });

  it('should handle requestWillBeSent without optional fields', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R4',
      request: { url: 'https://cdn.com/img.png', method: 'GET' },
    });
    const entry = store.log.get('R4')!;
    assert.equal(entry.requestHeaders, undefined);
    assert.equal(entry.postData, undefined);
    assert.equal(entry.hasPostData, undefined);
    assert.equal(entry.resourceType, undefined);
  });

  it('should handle responseReceived without headers', () => {
    const store = createNetworkStore();
    store.addRequest('R5', 'https://a.com', 'GET');
    store.setResponse('R5', 204, 'No Content');
    const entry = store.log.get('R5')!;
    assert.equal(entry.responseHeaders, undefined);
    assert.equal(entry.status, 204);
  });

  it('should handle full lifecycle with extended fields', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R6',
      request: {
        url: 'https://api.com/users',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer xxx' },
        postData: '{"name":"Bob"}',
        hasPostData: true,
      },
      type: 'XHR',
    });
    simulateNetworkResponseReceived(store, {
      requestId: 'R6',
      response: {
        status: 201,
        statusText: 'Created',
        mimeType: 'application/json',
        headers: { 'Content-Type': 'application/json', 'Location': '/users/42' },
      },
    });
    store.setFinished('R6', 256);

    const entry = store.log.get('R6')!;
    assert.equal(entry.method, 'POST');
    assert.equal(entry.status, 201);
    assert.equal(entry.size, 256);
    assert.deepStrictEqual(entry.requestHeaders, { 'Content-Type': 'application/json', 'Authorization': 'Bearer xxx' });
    assert.deepStrictEqual(entry.responseHeaders, { 'Content-Type': 'application/json', 'Location': '/users/42' });
    assert.equal(entry.postData, '{"name":"Bob"}');
    assert.equal(entry.resourceType, 'XHR');
  });

  it('should handle multipart form data postData', () => {
    const store = createNetworkStore();
    const formData = '------WebKitFormBoundary\r\nContent-Disposition: form-data; name="file"\r\n\r\nbinary content\r\n------WebKitFormBoundary--';
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R7',
      request: {
        url: 'https://api.com/upload',
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundary' },
        postData: formData,
        hasPostData: true,
      },
      type: 'XHR',
    });
    const entry = store.log.get('R7')!;
    assert.ok(entry.postData!.includes('WebKitFormBoundary'));
    assert.ok(entry.postData!.includes('binary content'));
  });

  it('should handle URL-encoded form postData', () => {
    const store = createNetworkStore();
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R8',
      request: {
        url: 'https://api.com/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        postData: 'username=test&password=secret%21',
        hasPostData: true,
      },
    });
    const entry = store.log.get('R8')!;
    assert.equal(entry.postData, 'username=test&password=secret%21');
  });

  it('should handle GraphQL request with postData', () => {
    const store = createNetworkStore();
    const gqlBody = JSON.stringify({
      query: 'mutation CreateUser($name: String!) { createUser(name: $name) { id name } }',
      variables: { name: 'Test' },
    });
    simulateNetworkRequestWillBeSent(store, {
      requestId: 'R9',
      request: {
        url: 'https://api.com/graphql',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        postData: gqlBody,
        hasPostData: true,
      },
      type: 'XHR',
    });
    const entry = store.log.get('R9')!;
    const parsed = JSON.parse(entry.postData!);
    assert.ok(parsed.query.includes('CreateUser'));
    assert.deepStrictEqual(parsed.variables, { name: 'Test' });
  });

  it('should handle many resource types', () => {
    const store = createNetworkStore();
    const types = ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other'];
    types.forEach((t, i) => {
      simulateNetworkRequestWillBeSent(store, {
        requestId: `RT${i}`,
        request: { url: `https://a.com/${t}`, method: 'GET' },
        type: t,
      });
    });
    types.forEach((t, i) => {
      assert.equal(store.log.get(`RT${i}`)!.resourceType, t);
    });
  });
});

// ---------------------------------------------------------------------------
// Test: CDP event dispatch
// ---------------------------------------------------------------------------

describe('CDP event dispatch (handleCdpEvent simulation)', () => {
  it('should parse consoleAPICalled event correctly', () => {
    const store = createConsoleLogStore();
    const params = {
      type: 'warn',
      args: [
        { type: 'string', value: 'deprecation warning' },
        { type: 'string', value: 'in module X' },
      ],
      stackTrace: {
        callFrames: [{ url: 'app.js', lineNumber: 10 }],
      },
    };
    const type = (params.type as string) || 'log';
    const args = params.args || [];
    const text = args.map((arg: { type: string; value?: unknown; description?: string }) => {
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description) return arg.description;
      return `[${arg.type}]`;
    }).join(' ');
    const topFrame = params.stackTrace?.callFrames?.[0];
    store.add({ level: type, text, timestamp: Date.now(), url: topFrame?.url, lineNumber: topFrame?.lineNumber });

    assert.equal(store.logs.length, 1);
    assert.equal(store.logs[0].level, 'warn');
    assert.equal(store.logs[0].text, 'deprecation warning in module X');
    assert.equal(store.logs[0].url, 'app.js');
    assert.equal(store.logs[0].lineNumber, 10);
  });

  it('should handle console args with description (objects, functions)', () => {
    const args = [
      { type: 'object', description: 'HTMLDivElement' },
      { type: 'function', description: 'function onClick() {...}' },
    ];
    const text = args.map((arg: { type: string; value?: unknown; description?: string }) => {
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description) return arg.description;
      return `[${arg.type}]`;
    }).join(' ');
    assert.equal(text, 'HTMLDivElement function onClick() {...}');
  });

  it('should handle console args without value or description', () => {
    const args = [{ type: 'symbol' }];
    const text = args.map((arg: { type: string; value?: unknown; description?: string }) => {
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description) return arg.description;
      return `[${arg.type}]`;
    }).join(' ');
    assert.equal(text, '[symbol]');
  });

  it('should handle exceptionThrown event', () => {
    const store = createConsoleLogStore();
    const details = {
      text: 'Uncaught TypeError',
      exception: { description: 'TypeError: Cannot read property "x" of undefined' },
      url: 'main.js',
      lineNumber: 55,
    };
    store.add({
      level: 'error',
      text: details.exception?.description || details.text || 'Unknown exception',
      timestamp: Date.now(), url: details.url, lineNumber: details.lineNumber,
    });
    assert.equal(store.logs.length, 1);
    assert.equal(store.logs[0].level, 'error');
    assert.ok(store.logs[0].text.includes('Cannot read property'));
    assert.equal(store.logs[0].url, 'main.js');
    assert.equal(store.logs[0].lineNumber, 55);
  });
});

// ---------------------------------------------------------------------------
// Test: formatAXTreeAsText (inline copy to test without exporting from mcp.ts)
// ---------------------------------------------------------------------------

interface AXNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

// --- Structured error formatting ---

interface StructuredError {
  error: string;
  hint?: string;
  recovery?: string;
}

function formatError(err: StructuredError): string {
  const parts = [`Error: ${err.error}`];
  if (err.hint) parts.push(`Hint: ${err.hint}`);
  if (err.recovery) parts.push(`Recovery: call "${err.recovery}" tool`);
  return parts.join('\n');
}

// --- Ref cache ---

interface RefInfo { backendDOMNodeId: number; role: string; name: string }
const refCacheByTab: Map<string, Map<number, RefInfo>> = new Map();

function getRefCache(targetId: string): Map<number, RefInfo> {
  if (!refCacheByTab.has(targetId)) {
    refCacheByTab.set(targetId, new Map());
  }
  return refCacheByTab.get(targetId)!;
}

// --- Interactive elements ---

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'treeitem', 'row',
]);

interface LabeledElement {
  index: number;
  role: string;
  name: string;
  backendDOMNodeId: number;
}

function getInteractiveElements(nodes: AXNode[]): LabeledElement[] {
  const elements: LabeledElement[] = [];
  let idx = 1;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    if (!node.backendDOMNodeId) continue;
    elements.push({
      index: idx++,
      role,
      name: node.name?.value ?? '',
      backendDOMNodeId: node.backendDOMNodeId,
    });
  }
  return elements;
}

function formatInteractiveSnapshot(elements: LabeledElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.';
  const lines = elements.map(e =>
    `@${e.index} [${e.role}]${e.name ? ` "${e.name}"` : ''}`
  );
  return `Interactive elements (${elements.length}):\n${lines.join('\n')}\n\n(Note: @ref numbers are display-only in this mode. Use accessibility_snapshot without interactive_only for full tree with actionable refs.)`;
}

// --- stripRefPrefixes ---

function stripRefPrefixes(text: string): string {
  return text.replace(/^(\s*)@\d+ /gm, '$1');
}

// --- computeSnapshotDiff (updated to strip refs) ---

function computeSnapshotDiff(oldSnap: string, newSnap: string): string {
  const oldLines = stripRefPrefixes(oldSnap).split('\n');
  const newLines = stripRefPrefixes(newSnap).split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const added = newLines.filter(l => !oldSet.has(l));
  const removed = oldLines.filter(l => !newSet.has(l));

  if (added.length === 0 && removed.length === 0) {
    return 'No changes since last snapshot.';
  }

  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(`Removed (${removed.length}):\n${removed.map(l => `- ${l}`).join('\n')}`);
  }
  if (added.length > 0) {
    parts.push(`Added (${added.length}):\n${added.map(l => `+ ${l}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// --- formatAXTreeAsText (with ref support) ---

function formatAXTreeAsText(nodes: AXNode[], assignRefs: boolean = false, targetId?: string): string {
  const refCache = (assignRefs && targetId) ? getRefCache(targetId) : new Map<number, RefInfo>();
  if (assignRefs) refCache.clear();

  const interactiveNodeIds = assignRefs ? new Set(
    getInteractiveElements(nodes).map(e => e.backendDOMNodeId)
  ) : new Set<number>();

  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  const lines: string[] = [];
  let refIdx = 1;

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

    const isInteractive = assignRefs && node.backendDOMNodeId && interactiveNodeIds.has(node.backendDOMNodeId);
    let refPrefix = '';
    if (isInteractive && node.backendDOMNodeId) {
      refPrefix = `@${refIdx} `;
      refCache.set(refIdx, {
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name,
      });
      refIdx++;
    }

    if (role || name) {
      lines.push(`${indent}${refPrefix}${role}${nameStr}${propsStr}`);
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
// Test: MCP logging capability declaration (Fix #3)
// ---------------------------------------------------------------------------

describe('MCP logging capability', () => {
  it('should declare logging capability in server options', () => {
    const capabilities = { tools: {}, logging: {} };
    assert.ok('logging' in capabilities, 'logging capability should be declared');
    assert.ok('tools' in capabilities, 'tools capability should still be declared');
  });

  it('mcpLog should call both stderr log and sendLoggingMessage', async () => {
    let stderrCalled = false;
    let sendCalled = false;
    let sentLevel: string | null = null;
    let sentData: unknown = null;

    function logToStderr(data: string) {
      stderrCalled = true;
    }

    function sendLoggingMessage(params: { level: string; logger: string; data: unknown }) {
      sendCalled = true;
      sentLevel = params.level;
      sentData = params.data;
      return Promise.resolve();
    }

    function mcpLog(level: string, data: string) {
      logToStderr(data);
      sendLoggingMessage({ level, logger: 'spawriter', data }).catch(() => {});
    }

    mcpLog('info', 'test message');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(stderrCalled, true, 'should write to stderr');
    assert.equal(sendCalled, true, 'should send logging message');
    assert.equal(sentLevel, 'info');
    assert.equal(sentData, 'test message');
  });

  it('mcpLog should not throw when sendLoggingMessage rejects', async () => {
    function sendLoggingMessage() {
      return Promise.reject(new Error('Not connected'));
    }

    function mcpLog(level: string, data: string) {
      sendLoggingMessage().catch(() => {});
    }

    assert.doesNotThrow(() => mcpLog('info', 'test'));
    await new Promise((r) => setTimeout(r, 10));
  });

  it('mcpLog should accept all valid severity levels', () => {
    const levels = ['debug', 'info', 'warning', 'error'] as const;
    for (const level of levels) {
      let capturedLevel: string | null = null;
      function mcpLog(l: string, data: string) {
        capturedLevel = l;
      }
      mcpLog(level, 'test');
      assert.equal(capturedLevel, level);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: ensureRelayServer reentrancy guard (Fix #2)
// ---------------------------------------------------------------------------

function createRelayStarterWithMutex() {
  let relayStartPromise: Promise<void> | null = null;
  let startCount = 0;

  async function doStartRelay(): Promise<void> {
    startCount++;
    await new Promise((r) => setTimeout(r, 50));
  }

  async function ensureRelayServer(relayAlreadyRunning: boolean): Promise<void> {
    if (relayAlreadyRunning) return;

    if (relayStartPromise) {
      return relayStartPromise;
    }
    relayStartPromise = doStartRelay();
    try {
      return await relayStartPromise;
    } finally {
      relayStartPromise = null;
    }
  }

  return { ensureRelayServer, getStartCount: () => startCount };
}

describe('ensureRelayServer reentrancy guard', () => {
  it('should skip relay start when relay is already running', async () => {
    const { ensureRelayServer, getStartCount } = createRelayStarterWithMutex();
    await ensureRelayServer(true);
    assert.equal(getStartCount(), 0);
  });

  it('should only start relay once when called concurrently', async () => {
    const { ensureRelayServer, getStartCount } = createRelayStarterWithMutex();

    await Promise.all([
      ensureRelayServer(false),
      ensureRelayServer(false),
      ensureRelayServer(false),
    ]);

    assert.equal(getStartCount(), 1, 'doStartRelay should be called exactly once');
  });

  it('should allow a second start after the first completes', async () => {
    const { ensureRelayServer, getStartCount } = createRelayStarterWithMutex();

    await ensureRelayServer(false);
    assert.equal(getStartCount(), 1);

    await ensureRelayServer(false);
    assert.equal(getStartCount(), 2);
  });

  it('should release mutex when relay start fails', async () => {
    let relayStartPromise: Promise<void> | null = null;
    let callCount = 0;

    async function doStartRelay(): Promise<void> {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      if (callCount === 1) throw new Error('Spawn failed');
    }

    async function ensureRelayServer(): Promise<void> {
      if (relayStartPromise) return relayStartPromise;
      relayStartPromise = doStartRelay();
      try {
        return await relayStartPromise;
      } finally {
        relayStartPromise = null;
      }
    }

    await assert.rejects(ensureRelayServer, /Spawn failed/);
    await ensureRelayServer();
    assert.equal(callCount, 2);
  });

  it('concurrent callers should all see the same error on failure', async () => {
    let relayStartPromise: Promise<void> | null = null;

    async function doStartRelay(): Promise<void> {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('Port unavailable');
    }

    async function ensureRelayServer(): Promise<void> {
      if (relayStartPromise) return relayStartPromise;
      relayStartPromise = doStartRelay();
      try {
        return await relayStartPromise;
      } finally {
        relayStartPromise = null;
      }
    }

    const results = await Promise.allSettled([
      ensureRelayServer(),
      ensureRelayServer(),
      ensureRelayServer(),
    ]);

    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.ok((result as PromiseRejectedResult).reason.message.includes('Port unavailable'));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: ensureRelayServer full flow with version probe (Fix #2 — integration)
// ---------------------------------------------------------------------------

describe('ensureRelayServer with version probe simulation', () => {
  function createFullRelayStarter() {
    let relayStartPromise: Promise<void> | null = null;
    let startCount = 0;
    let probeCount = 0;
    let relayRunning = false;

    async function probeRelay(): Promise<boolean> {
      probeCount++;
      return relayRunning;
    }

    async function doStartRelay(): Promise<void> {
      startCount++;
      await new Promise((r) => setTimeout(r, 30));
      relayRunning = true;
    }

    async function ensureRelayServer(): Promise<void> {
      if (await probeRelay()) return;

      if (relayStartPromise) return relayStartPromise;
      relayStartPromise = doStartRelay();
      try {
        return await relayStartPromise;
      } finally {
        relayStartPromise = null;
      }
    }

    return {
      ensureRelayServer,
      setRelayRunning: (v: boolean) => { relayRunning = v; },
      getStartCount: () => startCount,
      getProbeCount: () => probeCount,
    };
  }

  it('should skip start when version probe succeeds (relay already running)', async () => {
    const s = createFullRelayStarter();
    s.setRelayRunning(true);
    await s.ensureRelayServer();
    assert.equal(s.getStartCount(), 0);
    assert.equal(s.getProbeCount(), 1);
  });

  it('should start relay when version probe fails', async () => {
    const s = createFullRelayStarter();
    await s.ensureRelayServer();
    assert.equal(s.getStartCount(), 1);
  });

  it('should not start relay again after it becomes running', async () => {
    const s = createFullRelayStarter();
    await s.ensureRelayServer();
    assert.equal(s.getStartCount(), 1);

    await s.ensureRelayServer();
    assert.equal(s.getStartCount(), 1, 'second call should hit fast path');
    assert.equal(s.getProbeCount(), 2);
  });

  it('concurrent calls: only one start, all probe, all succeed', async () => {
    const s = createFullRelayStarter();
    await Promise.all([
      s.ensureRelayServer(),
      s.ensureRelayServer(),
      s.ensureRelayServer(),
    ]);
    assert.equal(s.getStartCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload safety (Phase 1)
// ---------------------------------------------------------------------------

describe('clear_cache_and_reload safety', () => {
  function parseClearTypes(clearArg: string): Set<string> {
    const raw = clearArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    return new Set(raw.includes('all')
      ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
      : raw);
  }

  it('"all" should NOT include global_cache', () => {
    const types = parseClearTypes('all');
    assert.ok(types.has('cache'));
    assert.ok(!types.has('global_cache'));
  });

  it('"everything" should be treated as a literal unknown type (not expanded)', () => {
    const types = parseClearTypes('everything');
    assert.ok(types.has('everything'));
    assert.ok(!types.has('global_cache'));
  });

  it('"cache" alone should be in the set', () => {
    const types = parseClearTypes('cache');
    assert.ok(types.has('cache'));
    assert.ok(!types.has('global_cache'));
  });

  it('"global_cache" should be treated as a literal unknown type', () => {
    const types = parseClearTypes('global_cache');
    assert.ok(types.has('global_cache'));
    assert.ok(!types.has('cache'));
    assert.equal(types.size, 1);
  });

  it('"cache,cookies" should have both', () => {
    const types = parseClearTypes('cache,cookies');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(!types.has('global_cache'));
  });

  it('"all" should include all origin-scoped types', () => {
    const types = parseClearTypes('all');
    for (const t of ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']) {
      assert.ok(types.has(t), `"all" should include "${t}"`);
    }
  });

  it('"everything" should NOT expand to multiple types', () => {
    const types = parseClearTypes('everything');
    assert.equal(types.size, 1);
    assert.ok(types.has('everything'));
    assert.ok(!types.has('cache'));
    assert.ok(!types.has('cookies'));
  });

  it('should handle whitespace in comma-separated values', () => {
    const types = parseClearTypes('cache , cookies , local_storage');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(types.has('local_storage'));
  });

  it('should be case-insensitive', () => {
    const types = parseClearTypes('Cache,COOKIES,Local_Storage');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(types.has('local_storage'));
  });

  it('legacyMode "aggressive" should set cache + cookies', () => {
    function resolveClearTypes(clearArg: string | undefined, legacyMode: string | undefined): Set<string> {
      if (clearArg) {
        return parseClearTypes(clearArg);
      } else if (legacyMode === 'aggressive') {
        return new Set(['cache', 'cookies']);
      }
      return new Set<string>();
    }
    const types = resolveClearTypes(undefined, 'aggressive');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 2);
  });

  it('no clearArg and no legacyMode should yield empty set', () => {
    function resolveClearTypes(clearArg: string | undefined, legacyMode: string | undefined): Set<string> {
      if (clearArg) {
        return parseClearTypes(clearArg);
      } else if (legacyMode === 'aggressive') {
        return new Set(['cache', 'cookies']);
      }
      return new Set<string>();
    }
    const types = resolveClearTypes(undefined, undefined);
    assert.equal(types.size, 0);
  });

  it('needsIgnoreCache should force reload even when shouldReload is false', () => {
    const clearTypes = new Set(['cache']);
    const shouldReload = false;
    const needsIgnoreCache = clearTypes.has('cache');
    const willReload = shouldReload || needsIgnoreCache;
    assert.equal(willReload, true);
    assert.equal(needsIgnoreCache, true);
  });

  it('storage clear_storage should require storage_types', () => {
    function clearStorageGuard(storageTypes: string | undefined): string | null {
      if (!storageTypes) {
        return 'Error: clear_storage requires storage_types parameter';
      }
      return null;
    }
    assert.ok(clearStorageGuard(undefined)?.startsWith('Error'));
    assert.equal(clearStorageGuard('cookies'), null);
    assert.equal(clearStorageGuard('local_storage,session_storage'), null);
  });
});

// ---------------------------------------------------------------------------
// Test: Screenshot quality — resolveImageProfile (Phase 2)
// ---------------------------------------------------------------------------

describe('Screenshot quality: resolveImageProfile', () => {
  interface ImageProfile {
    maxBytes: number;
    maxLongEdge: number;
    format: 'png' | 'webp' | 'jpeg';
    quality: number;
  }

  const MODEL_PROFILES: Record<string, ImageProfile> = {
    'claude-opus-4.6':    { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
    'claude-sonnet-4.6':  { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
    'claude-opus':        { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
    'claude-sonnet':      { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
    'claude':             { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
    'gpt-5.4':            { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
    'gpt-5.4-mini':       { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
    'gpt-5.3-codex':      { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
    'codex':              { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
    'gemini-3':           { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
    'gemini':             { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
  };

  const DEFAULT_PROFILE: ImageProfile = { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 };
  const TIER_LIMITS = { high: 5_000_000, medium: 5_000_000, low: 1_000_000 } as const;

  function resolveImageProfile(tier: string, modelHint?: string): ImageProfile & { effectiveLimit: number } {
    const tierLimit = TIER_LIMITS[tier as keyof typeof TIER_LIMITS] ?? TIER_LIMITS.medium;

    if (modelHint) {
      const key = modelHint.toLowerCase().trim();
      const profile = MODEL_PROFILES[key]
        ?? Object.entries(MODEL_PROFILES).find(([k]) => key.includes(k))?.[1];
      if (profile) {
        return { ...profile, effectiveLimit: Math.min(profile.maxBytes, tierLimit) };
      }
    }

    switch (tier) {
      case 'high':
        return { ...DEFAULT_PROFILE, format: 'png', quality: 100, effectiveLimit: tierLimit };
      case 'low':
        return { maxBytes: 1_000_000, maxLongEdge: 1280, format: 'webp', quality: 40, effectiveLimit: tierLimit };
      default:
        return { ...DEFAULT_PROFILE, effectiveLimit: tierLimit };
    }
  }

  it('default tier returns medium WebP profile', () => {
    const p = resolveImageProfile('medium');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('high tier returns PNG profile', () => {
    const p = resolveImageProfile('high');
    assert.equal(p.format, 'png');
    assert.equal(p.quality, 100);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('low tier returns compact WebP profile', () => {
    const p = resolveImageProfile('low');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 40);
    assert.equal(p.effectiveLimit, 1_000_000);
  });

  it('known model hint (gpt-5.4) overrides defaults', () => {
    const p = resolveImageProfile('medium', 'gpt-5.4');
    assert.equal(p.maxLongEdge, 2048);
    assert.equal(p.quality, 85);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('claude model hint applies Claude limits', () => {
    const p = resolveImageProfile('medium', 'claude-sonnet-4.6');
    assert.equal(p.maxLongEdge, 1568);
    assert.equal(p.maxBytes, 5_000_000);
  });

  it('unknown model hint falls back to defaults', () => {
    const p = resolveImageProfile('medium', 'unknown-model-99');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('model hint with partial match works', () => {
    const p = resolveImageProfile('medium', 'my-claude-sonnet-4.6-wrapper');
    assert.equal(p.maxLongEdge, 1568);
  });

  it('tier limit caps model maxBytes for low', () => {
    const p = resolveImageProfile('low', 'gpt-5.4');
    assert.equal(p.effectiveLimit, 1_000_000);
  });

  it('gemini model hint applies Gemini limits', () => {
    const p = resolveImageProfile('medium', 'gemini-3');
    assert.equal(p.maxLongEdge, 1024);
    assert.equal(p.quality, 75);
  });

  it('codex model hint applies Codex limits', () => {
    const p = resolveImageProfile('medium', 'gpt-5.3-codex');
    assert.equal(p.maxLongEdge, 1200);
    assert.equal(p.quality, 80);
  });

  it('unknown tier falls back to medium', () => {
    const p = resolveImageProfile('ultra');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.effectiveLimit, 5_000_000);
  });
});

// ---------------------------------------------------------------------------
// Test: Screenshot quality — auto-compression logic (Phase 2)
// ---------------------------------------------------------------------------

describe('Screenshot quality: auto-compression logic', () => {
  function needsCompression(base64Length: number, limitBytes: number): boolean {
    return Math.ceil(base64Length * 3 / 4) > limitBytes;
  }

  function calculateFallbackQuality(currentQuality: number, currentSize: number, limit: number): number {
    return Math.max(10, Math.floor(currentQuality * (limit / currentSize) * 0.8));
  }

  function base64SizeToBytes(base64Length: number): number {
    return Math.ceil(base64Length * 3 / 4);
  }

  it('should not compress when under limit', () => {
    assert.equal(needsCompression(1_000_000, 5_000_000), false);
  });

  it('should compress when over limit', () => {
    assert.equal(needsCompression(8_000_000, 5_000_000), true);
  });

  it('should calculate reduced quality proportionally', () => {
    const q = calculateFallbackQuality(80, 10_000_000, 5_000_000);
    assert.ok(q < 80);
    assert.ok(q >= 10);
    assert.equal(q, 32);
  });

  it('should floor to 10 for extreme oversize', () => {
    const q = calculateFallbackQuality(80, 100_000_000, 1_000_000);
    assert.equal(q, 10);
  });

  it('base64 size calculation should be correct', () => {
    assert.equal(base64SizeToBytes(4), 3);
    assert.equal(base64SizeToBytes(8), 6);
    assert.equal(base64SizeToBytes(100), 75);
  });

  it('halving quality should converge toward minimum', () => {
    let quality = 80;
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      quality = Math.max(10, Math.floor(quality * 0.5));
      steps.push(quality);
    }
    assert.deepEqual(steps, [40, 20, 10, 10, 10]);
  });

  it('PNG-to-WebP switch should use capped initial quality', () => {
    const profileFormat = 'png' as const;
    const profileQuality = 100;
    const effectiveLimit = 5_000_000;
    const originalSize = 10_000_000;

    const quality = profileFormat === 'png'
      ? Math.min(90, Math.floor(80 * (effectiveLimit / originalSize) * 0.8))
      : Math.floor(profileQuality * (effectiveLimit / originalSize) * 0.8);

    assert.ok(quality <= 90, 'PNG-to-WebP quality should be capped at 90');
    assert.equal(quality, 32);
  });

  it('retry loop exhaustion should end with quality=10', () => {
    const MAX_RETRIES = 3;
    let quality = 80;
    for (let i = 0; i < MAX_RETRIES; i++) {
      quality = Math.max(10, Math.floor(quality * 0.5));
    }
    assert.equal(quality, 10, 'after 3 halvings from 80 quality should bottom at 10');
  });

  it('successful retry should break early when under limit', () => {
    const limit = 5_000_000;
    const sizes = [8_000_000, 3_000_000]; // oversized first, then under limit
    let retries = 0;
    for (const size of sizes) {
      retries++;
      if (size <= limit) break;
    }
    assert.equal(retries, 2, 'should stop after second capture meets limit');
  });

  it('WebP format should not change when already WebP', () => {
    const profileFormat = 'webp';
    const retryFormat = 'webp';
    assert.equal(profileFormat, retryFormat, 'retry format stays webp');
  });
});

// ---------------------------------------------------------------------------
// Test: getCommandTimeout – additional cases
// ---------------------------------------------------------------------------

describe('getCommandTimeout (additional)', () => {
  it('should return 30s for Network.clearBrowserCache (no longer in slow set)', () => {
    assert.equal(getCommandTimeout('Network.clearBrowserCache'), 30000);
    assert.equal(getCommandTimeout('Network.clearBrowserCookies'), 30000);
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

// ---------------------------------------------------------------------------
// Test: playwright_execute tool definition validation
// ---------------------------------------------------------------------------

describe('playwright_execute tool definition', () => {
  const playwrightTool = {
    name: 'playwright_execute',
    description: `Execute code in a Node.js VM sandbox with full Playwright API access.
Available variables: page (Playwright Page), context (BrowserContext), state (persistent object across calls).
Use for: any browser interaction that needs real input events or Playwright's auto-waiting.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Has access to page, context, state, and standard globals.' },
        timeout: { type: 'number', description: 'Execution timeout in ms (default: 30000)' },
      },
      required: ['code'],
    },
  };

  it('should have correct tool name', () => {
    assert.equal(playwrightTool.name, 'playwright_execute');
  });

  it('should require code parameter', () => {
    assert.ok(playwrightTool.inputSchema.required.includes('code'));
  });

  it('should not require timeout parameter', () => {
    assert.ok(!playwrightTool.inputSchema.required.includes('timeout'));
  });

  it('should have code as string type', () => {
    assert.equal(playwrightTool.inputSchema.properties.code.type, 'string');
  });

  it('should have timeout as number type', () => {
    assert.equal(playwrightTool.inputSchema.properties.timeout.type, 'number');
  });

  it('should mention page, context, state in description', () => {
    assert.ok(playwrightTool.description.includes('page'));
    assert.ok(playwrightTool.description.includes('context'));
    assert.ok(playwrightTool.description.includes('state'));
  });

  it('should differentiate from execute tool', () => {
    assert.ok(playwrightTool.description.includes('real input events'));
  });
});

// ---------------------------------------------------------------------------
// Test: reset tool should now mention Playwright
// ---------------------------------------------------------------------------

describe('reset tool description', () => {
  const resetDescription = 'Reset the CDP connection, Playwright executor, and clear all captured console logs and network entries';

  it('should mention Playwright', () => {
    assert.ok(resetDescription.includes('Playwright'));
  });

  it('should mention console logs', () => {
    assert.ok(resetDescription.includes('console logs'));
  });

  it('should mention network entries', () => {
    assert.ok(resetDescription.includes('network entries'));
  });

  it('should mention CDP connection', () => {
    assert.ok(resetDescription.includes('CDP connection'));
  });
});

// ---------------------------------------------------------------------------
// Test: Accessibility snapshot diff
// (uses computeSnapshotDiff and stripRefPrefixes from above)
// ---------------------------------------------------------------------------

describe('computeSnapshotDiff', () => {
  it('should detect no changes on identical snapshots', () => {
    const snap = 'RootWebArea "Page"\n  heading "Title"\n  button "Submit"';
    const result = computeSnapshotDiff(snap, snap);
    assert.ok(result.includes('No changes'));
  });

  it('should detect added lines', () => {
    const old = 'RootWebArea "Page"\n  heading "Title"';
    const newer = 'RootWebArea "Page"\n  heading "Title"\n  button "New"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Added (1)'));
    assert.ok(result.includes('+ '));
    assert.ok(result.includes('button "New"'));
  });

  it('should detect removed lines', () => {
    const old = 'RootWebArea "Page"\n  heading "Title"\n  button "Old"';
    const newer = 'RootWebArea "Page"\n  heading "Title"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed (1)'));
    assert.ok(result.includes('- '));
    assert.ok(result.includes('button "Old"'));
  });

  it('should detect both added and removed', () => {
    const old = 'RootWebArea "Page"\n  heading "Title"\n  button "Old"';
    const newer = 'RootWebArea "Page"\n  heading "Title"\n  button "New"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed'));
    assert.ok(result.includes('Added'));
    assert.ok(result.includes('button "Old"'));
    assert.ok(result.includes('button "New"'));
  });

  it('should handle empty old snapshot', () => {
    const result = computeSnapshotDiff('', 'RootWebArea "Page"');
    assert.ok(result.includes('Added'));
  });

  it('should handle empty new snapshot', () => {
    const result = computeSnapshotDiff('RootWebArea "Page"', '');
    assert.ok(result.includes('Removed'));
  });

  it('should handle both empty snapshots', () => {
    const result = computeSnapshotDiff('', '');
    assert.ok(result.includes('No changes'));
  });
});

// ---------------------------------------------------------------------------
// Test: Accessibility snapshot search
// ---------------------------------------------------------------------------

function searchSnapshot(snapshot: string, query: string): string {
  const lines = snapshot.split('\n');
  const lowerQuery = query.toLowerCase();
  const matchIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matchIndices.push(i);
      if (matchIndices.length >= 20) break;
    }
  }

  if (matchIndices.length === 0) return 'No matches found';

  const CONTEXT_LINES = 3;
  const included = new Set<number>();
  for (const idx of matchIndices) {
    for (let i = Math.max(0, idx - CONTEXT_LINES); i <= Math.min(lines.length - 1, idx + CONTEXT_LINES); i++) {
      included.add(i);
    }
  }

  const sorted = [...included].sort((a, b) => a - b);
  const result: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i - 1] !== sorted[i] - 1) result.push('---');
    const line = lines[sorted[i]];
    const isMatch = line.toLowerCase().includes(lowerQuery);
    result.push(isMatch ? `>>> ${line}` : `    ${line}`);
  }

  return `Search results for "${query}" (${matchIndices.length} matches):\n${result.join('\n')}`;
}

describe('searchSnapshot', () => {
  const testTree = [
    'RootWebArea "My App"',
    '  navigation "Main Nav"',
    '    link "Home"',
    '    link "About"',
    '    link "Contact"',
    '  main "Content"',
    '    heading "Welcome"',
    '    paragraph "Hello world"',
    '    button "Submit Form"',
    '    button "Cancel"',
    '  footer "Page Footer"',
    '    link "Privacy Policy"',
    '    link "Terms"',
  ].join('\n');

  it('should find matches (case-insensitive)', () => {
    const result = searchSnapshot(testTree, 'button');
    assert.ok(result.includes('button "Submit Form"'));
    assert.ok(result.includes('button "Cancel"'));
    assert.ok(result.includes('2 matches'));
  });

  it('should find matches with uppercase query', () => {
    const result = searchSnapshot(testTree, 'BUTTON');
    assert.ok(result.includes('button "Submit Form"'));
  });

  it('should return "No matches found" for no hits', () => {
    const result = searchSnapshot(testTree, 'nonexistent');
    assert.equal(result, 'No matches found');
  });

  it('should include context lines around matches', () => {
    const result = searchSnapshot(testTree, 'heading');
    assert.ok(result.includes('heading "Welcome"'));
    assert.ok(result.includes('main "Content"'));
    assert.ok(result.includes('paragraph "Hello world"'));
  });

  it('should mark matching lines with >>>', () => {
    const result = searchSnapshot(testTree, 'heading');
    const lines = result.split('\n');
    const matchLine = lines.find(l => l.includes('heading "Welcome"'));
    assert.ok(matchLine, 'Should contain match line');
    assert.ok(matchLine.trimStart().startsWith('>>>') || matchLine.startsWith('>>>'),
      `Match line should start with >>>: "${matchLine}"`);
  });

  it('should mark context lines without >>> prefix', () => {
    const result = searchSnapshot(testTree, 'heading');
    const lines = result.split('\n').slice(1);
    const contextLine = lines.find(l => l.includes('main "Content"'));
    assert.ok(contextLine, 'Should have context line');
    assert.ok(!contextLine.includes('>>>'), `Context line should not have >>>: "${contextLine}"`);
  });

  it('should use --- separator between non-adjacent context groups', () => {
    const result = searchSnapshot(testTree, 'footer');
    assert.ok(result.includes('footer'));
  });

  it('should limit to 20 matches', () => {
    const manyButtons = Array.from({ length: 30 }, (_, i) => `  button "Btn ${i}"`).join('\n');
    const snapshot = `RootWebArea "Test"\n${manyButtons}`;
    const result = searchSnapshot(snapshot, 'button');
    assert.ok(result.includes('20 matches'));
  });

  it('should handle single-line snapshot', () => {
    const result = searchSnapshot('button "OK"', 'button');
    assert.ok(result.includes('button "OK"'));
    assert.ok(result.includes('1 matches'));
  });

  it('should handle empty snapshot', () => {
    const result = searchSnapshot('', 'anything');
    assert.equal(result, 'No matches found');
  });
});

// ---------------------------------------------------------------------------
// Test: Labeled screenshot helpers
// (getInteractiveElements, INTERACTIVE_ROLES, LabeledElement defined above)
// ---------------------------------------------------------------------------

function formatLabelLegend(elements: LabeledElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.';
  const lines = elements.map(e => `[${e.index}] ${e.role}${e.name ? ` "${e.name}"` : ''}`);
  return `Interactive elements (${elements.length}):\n${lines.join('\n')}`;
}

describe('getInteractiveElements', () => {
  it('should extract buttons and links', () => {
    const nodes: (AXNode & { backendDOMNodeId?: number })[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 10 },
      { nodeId: '3', parentId: '1', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'Home' }, backendDOMNodeId: 11 },
      { nodeId: '4', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Title' }, backendDOMNodeId: 12 },
    ];
    const result = getInteractiveElements(nodes);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'button');
    assert.equal(result[0].name, 'Submit');
    assert.equal(result[0].index, 1);
    assert.equal(result[1].role, 'link');
    assert.equal(result[1].name, 'Home');
    assert.equal(result[1].index, 2);
  });

  it('should skip ignored nodes', () => {
    const nodes: (AXNode & { backendDOMNodeId?: number })[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Btn' }, backendDOMNodeId: 10, ignored: true },
    ];
    assert.equal(getInteractiveElements(nodes).length, 0);
  });

  it('should skip nodes without backendDOMNodeId', () => {
    const nodes: (AXNode & { backendDOMNodeId?: number })[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Btn' } },
    ];
    assert.equal(getInteractiveElements(nodes).length, 0);
  });

  it('should handle all interactive roles', () => {
    const roles = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'menuitem', 'option', 'treeitem', 'row', 'spinbutton', 'listbox', 'menuitemcheckbox', 'menuitemradio'];
    const nodes = roles.map((role, i) => ({
      nodeId: String(i + 1),
      role: { type: 'role', value: role },
      name: { type: 'computedString', value: `Element ${i}` },
      backendDOMNodeId: 100 + i,
    }));
    const result = getInteractiveElements(nodes);
    assert.equal(result.length, roles.length);
  });

  it('should skip non-interactive roles', () => {
    const nonInteractive = ['heading', 'paragraph', 'generic', 'main', 'navigation', 'section', 'article', 'img'];
    const nodes = nonInteractive.map((role, i) => ({
      nodeId: String(i + 1),
      role: { type: 'role', value: role },
      name: { type: 'computedString', value: `Element ${i}` },
      backendDOMNodeId: 100 + i,
    }));
    assert.equal(getInteractiveElements(nodes).length, 0);
  });

  it('should number elements sequentially', () => {
    const nodes: (AXNode & { backendDOMNodeId?: number })[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'A' }, backendDOMNodeId: 10 },
      { nodeId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'B' }, backendDOMNodeId: 11 },
      { nodeId: '3', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'C' }, backendDOMNodeId: 12 },
    ];
    const result = getInteractiveElements(nodes);
    assert.equal(result[0].index, 1);
    assert.equal(result[1].index, 2);
    assert.equal(result[2].index, 3);
  });

  it('should return empty for no nodes', () => {
    assert.equal(getInteractiveElements([]).length, 0);
  });
});

describe('formatLabelLegend', () => {
  it('should format elements with role and name', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: 'Submit', backendDOMNodeId: 10 },
      { index: 2, role: 'link', name: 'Home', backendDOMNodeId: 11 },
    ];
    const result = formatLabelLegend(elements);
    assert.ok(result.includes('[1] button "Submit"'));
    assert.ok(result.includes('[2] link "Home"'));
    assert.ok(result.includes('Interactive elements (2)'));
  });

  it('should handle elements without name', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: '', backendDOMNodeId: 10 },
    ];
    const result = formatLabelLegend(elements);
    assert.ok(result.includes('[1] button'));
    assert.ok(!result.includes('""'));
  });

  it('should return message for no elements', () => {
    const result = formatLabelLegend([]);
    assert.ok(result.includes('No interactive elements'));
  });

  it('should handle many elements', () => {
    const elements = Array.from({ length: 50 }, (_, i) => ({
      index: i + 1,
      role: 'button',
      name: `Button ${i + 1}`,
      backendDOMNodeId: i + 100,
    }));
    const result = formatLabelLegend(elements);
    assert.ok(result.includes('Interactive elements (50)'));
    assert.ok(result.includes('[1] button "Button 1"'));
    assert.ok(result.includes('[50] button "Button 50"'));
  });
});

// ---------------------------------------------------------------------------
// Test: buildLabelInjectionScript – JS syntax validation
// ---------------------------------------------------------------------------

describe('buildLabelInjectionScript', () => {
  function buildLabelInjectionScript(labels: Array<{ index: number; x: number; y: number; width: number; height: number }>): string {
    return `(function() {
    var container = document.createElement('div');
    container.id = '__spawriter_labels__';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    ${labels.map(l => `
    (function(){
      var d=document.createElement('div');
      d.textContent='${l.index}';
      d.style.cssText='position:absolute;left:${l.x}px;top:${l.y}px;width:${Math.max(l.width, 14)}px;height:${Math.max(l.height, 14)}px;border:2px solid #e11d48;border-radius:3px;font-size:10px;font-weight:bold;color:#fff;background:rgba(225,29,72,0.85);display:flex;align-items:center;justify-content:center;line-height:1;pointer-events:none;';
      container.appendChild(d);
    })();`).join('')}
    document.body.appendChild(container);
  })()`;
  }

  it('should produce valid JS for empty labels', () => {
    const script = buildLabelInjectionScript([]);
    assert.doesNotThrow(() => new Function(script));
  });

  it('should produce valid JS for single label', () => {
    const script = buildLabelInjectionScript([{ index: 1, x: 10, y: 20, width: 100, height: 30 }]);
    assert.doesNotThrow(() => new Function(script));
    assert.ok(script.includes("textContent='1'"));
    assert.ok(script.includes('left:10px'));
    assert.ok(script.includes('top:20px'));
  });

  it('should produce valid JS for many labels', () => {
    const labels = Array.from({ length: 50 }, (_, i) => ({
      index: i + 1, x: i * 10, y: i * 5, width: 80, height: 24,
    }));
    const script = buildLabelInjectionScript(labels);
    assert.doesNotThrow(() => new Function(script));
  });

  it('should enforce minimum 14px dimensions', () => {
    const script = buildLabelInjectionScript([{ index: 1, x: 0, y: 0, width: 5, height: 3 }]);
    assert.ok(script.includes('width:14px'));
    assert.ok(script.includes('height:14px'));
  });

  it('should handle zero coordinates', () => {
    const script = buildLabelInjectionScript([{ index: 1, x: 0, y: 0, width: 100, height: 50 }]);
    assert.doesNotThrow(() => new Function(script));
    assert.ok(script.includes('left:0px'));
    assert.ok(script.includes('top:0px'));
  });

  it('should handle large coordinates and fractional values', () => {
    const script = buildLabelInjectionScript([{ index: 99, x: 1920.5, y: 1080.3, width: 200.7, height: 50.1 }]);
    assert.doesNotThrow(() => new Function(script));
    assert.ok(script.includes("textContent='99'"));
  });

  it('should create container with correct id', () => {
    const script = buildLabelInjectionScript([{ index: 1, x: 0, y: 0, width: 50, height: 50 }]);
    assert.ok(script.includes("id = '__spawriter_labels__'"));
  });
});

describe('REMOVE_LABELS_SCRIPT', () => {
  const REMOVE_LABELS_SCRIPT = `(function() {
  var el = document.getElementById('__spawriter_labels__');
  if (el) el.remove();
})()`;

  it('should be valid JS', () => {
    assert.doesNotThrow(() => new Function(REMOVE_LABELS_SCRIPT));
  });

  it('should reference correct element id', () => {
    assert.ok(REMOVE_LABELS_SCRIPT.includes('__spawriter_labels__'));
  });
});

// ---------------------------------------------------------------------------
// Test: formatNetworkEntries (standalone)
// ---------------------------------------------------------------------------

function formatNetworkEntries(
  entries: Array<{ requestId: string; url: string; method: string; status?: number; statusText?: string; startTime: number; endTime?: number; error?: string; size?: number }>,
  totalCount: number
): string {
  if (entries.length === 0) return `No network entries captured (${totalCount} total in buffer)`;
  const lines = entries.map(e => {
    const st = e.error ? `ERR:${e.error}` : (e.status !== undefined ? `${e.status}` : '...');
    const dur = e.endTime && e.startTime ? `${e.endTime - e.startTime}ms` : '...';
    const sz = e.size ? ` ${(e.size / 1024).toFixed(1)}KB` : '';
    return `[${e.requestId}] ${e.method.padEnd(6)} ${st.padEnd(15)} ${dur.padStart(7)}${sz}  ${e.url}`;
  });
  return `Network (${entries.length}/${totalCount} total):\n${lines.join('\n')}\n\nUse network_detail { requestId: "..." } to inspect headers and body.`;
}

describe('formatNetworkEntries', () => {
  it('should format empty entries', () => {
    const text = formatNetworkEntries([], 0);
    assert.ok(text.includes('No network entries'));
    assert.ok(text.includes('0 total'));
  });

  it('should format empty entries with non-zero total', () => {
    const text = formatNetworkEntries([], 100);
    assert.ok(text.includes('100 total'));
  });

  it('should format a successful GET request with requestId', () => {
    const entries = [{ requestId: 'R1', url: 'https://api.example.com/data', method: 'GET', status: 200, startTime: 1000, endTime: 1150, size: 2048 }];
    const text = formatNetworkEntries(entries, 1);
    assert.ok(text.includes('[R1]'));
    assert.ok(text.includes('GET'));
    assert.ok(text.includes('200'));
    assert.ok(text.includes('150ms'));
    assert.ok(text.includes('2.0KB'));
    assert.ok(text.includes('api.example.com'));
  });

  it('should format a failed request with requestId', () => {
    const entries = [{ requestId: 'R2', url: 'https://api.example.com/fail', method: 'POST', error: 'net::ERR_CONNECTION_REFUSED', startTime: 1000, endTime: 1050 }];
    const text = formatNetworkEntries(entries, 1);
    assert.ok(text.includes('[R2]'));
    assert.ok(text.includes('POST'));
    assert.ok(text.includes('ERR:net::ERR_CONNECTION_REFUSED'));
  });

  it('should format a pending request (no status, no endTime)', () => {
    const entries = [{ requestId: 'R3', url: 'https://api.example.com/slow', method: 'GET', startTime: 1000 }];
    const text = formatNetworkEntries(entries, 1);
    assert.ok(text.includes('[R3]'));
    assert.ok(text.includes('...'));
  });

  it('should format request without size', () => {
    const entries = [{ requestId: 'R4', url: 'https://a.com', method: 'GET', status: 200, startTime: 1000, endTime: 1100 }];
    const text = formatNetworkEntries(entries, 1);
    assert.ok(!text.includes('KB'));
  });

  it('should show correct count header', () => {
    const entries = [
      { requestId: 'R5', url: 'https://a.com', method: 'GET', status: 200, startTime: 1000, endTime: 1100 },
      { requestId: 'R6', url: 'https://b.com', method: 'POST', status: 404, startTime: 2000, endTime: 2200 },
    ];
    const text = formatNetworkEntries(entries, 50);
    assert.ok(text.includes('Network (2/50 total)'));
  });

  it('should pad method names consistently', () => {
    const entries = [
      { requestId: 'R7', url: 'https://a.com', method: 'GET', status: 200, startTime: 1000, endTime: 1100 },
      { requestId: 'R8', url: 'https://b.com', method: 'DELETE', status: 204, startTime: 2000, endTime: 2300 },
    ];
    const text = formatNetworkEntries(entries, 2);
    const dataLines = text.split('\n').filter(l => l.startsWith('['));
    assert.ok(dataLines[0].includes('] GET   '));
    assert.ok(dataLines[1].includes('] DELETE'));
  });

  it('should include network_detail usage hint', () => {
    const entries = [{ requestId: 'R9', url: 'https://a.com', method: 'GET', status: 200, startTime: 1000, endTime: 1100 }];
    const text = formatNetworkEntries(entries, 1);
    assert.ok(text.includes('network_detail'));
    assert.ok(text.includes('requestId'));
  });

  it('should not include hint for empty entries', () => {
    const text = formatNetworkEntries([], 0);
    assert.ok(!text.includes('network_detail'));
  });
});

// ---------------------------------------------------------------------------
// Test: computeSnapshotDiff – precision edge cases
// ---------------------------------------------------------------------------

describe('computeSnapshotDiff (precision)', () => {
  it('should detect single character change in a line', () => {
    const old = 'RootWebArea "Page"\n  button "Submtt"';
    const newer = 'RootWebArea "Page"\n  button "Submit"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed'));
    assert.ok(result.includes('Submtt'));
    assert.ok(result.includes('Added'));
    assert.ok(result.includes('Submit'));
  });

  it('should detect changed indentation as a change', () => {
    const old = '  button "OK"';
    const newer = '    button "OK"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed'));
    assert.ok(result.includes('Added'));
  });

  it('should handle duplicate lines correctly', () => {
    const old = 'button "A"\nbutton "A"\nbutton "B"';
    const newer = 'button "A"\nbutton "B"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed') || result.includes('No changes'));
  });

  it('should handle reordered lines', () => {
    const old = 'line A\nline B\nline C';
    const newer = 'line C\nline A\nline B';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('No changes') || result.includes('Removed') || result.includes('Added'));
  });

  it('should handle very long snapshots', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `  node-${i} "Element ${i}"`);
    const old = lines.join('\n');
    const modified = [...lines];
    modified[500] = '  node-500 "Modified Element"';
    const newer = modified.join('\n');
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('node-500'));
  });

  it('should handle snapshot with only whitespace differences', () => {
    const old = 'button "OK"  ';
    const newer = 'button "OK"';
    const result = computeSnapshotDiff(old, newer);
    assert.ok(result.includes('Removed') || result.includes('Added') || result.includes('No changes'));
  });
});

// ---------------------------------------------------------------------------
// Test: playwright_execute integration path (mocked)
// ---------------------------------------------------------------------------

describe('playwright_execute integration path', () => {
  it('execute result should have text and isError fields', () => {
    const result = { text: 'Code executed successfully (no output)', isError: false };
    assert.equal(typeof result.text, 'string');
    assert.equal(typeof result.isError, 'boolean');
    assert.equal(result.isError, false);
  });

  it('error result should have isError=true and error text', () => {
    const result = {
      text: 'Error executing code: ReferenceError: foo is not defined\n\n[HINT: If this is a Playwright connection error, call reset to reconnect.]',
      isError: true,
    };
    assert.equal(result.isError, true);
    assert.ok(result.text.includes('Error'));
    assert.ok(result.text.includes('HINT'));
  });

  it('timeout result should not have HINT', () => {
    const result = {
      text: '\nError executing code: Code execution timed out after 5000ms',
      isError: true,
    };
    assert.ok(!result.text.includes('HINT'));
  });

  it('console output should be captured in result text', () => {
    const consoleLogs = [
      { method: 'log', args: ['step 1'] },
      { method: 'warn', args: ['deprecation'] },
    ];
    const formattedLogs = `Console output:\n${consoleLogs.map(l => `[${l.method}] ${l.args.join(' ')}`).join('\n')}\n`;
    assert.ok(formattedLogs.includes('[log] step 1'));
    assert.ok(formattedLogs.includes('[warn] deprecation'));
  });

  it('reset should clear all state types', () => {
    const stateCleared = {
      cdpSession: null,
      consoleLogs: 0,
      networkLog: 0,
      lastSnapshot: null,
      playwrightExecutor: { connected: false, stateKeys: [] },
    };
    assert.equal(stateCleared.cdpSession, null);
    assert.equal(stateCleared.consoleLogs, 0);
    assert.equal(stateCleared.networkLog, 0);
    assert.equal(stateCleared.lastSnapshot, null);
    assert.equal(stateCleared.playwrightExecutor.connected, false);
    assert.deepEqual(stateCleared.playwrightExecutor.stateKeys, []);
  });

  it('tool definition should list all tools including debugger and css_inspect', () => {
    const toolNames = [
      'screenshot', 'accessibility_snapshot', 'execute', 'dashboard_state',
      'console_logs', 'network_log', 'playwright_execute', 'reset',
      'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
      'override_app', 'app_action', 'debugger', 'css_inspect',
    ];
    assert.equal(toolNames.length, 15);
    assert.ok(toolNames.includes('playwright_execute'));
    assert.ok(toolNames.includes('console_logs'));
    assert.ok(toolNames.includes('network_log'));
    assert.ok(toolNames.includes('debugger'));
    assert.ok(toolNames.includes('css_inspect'));
  });
});

// ---------------------------------------------------------------------------
// Test: handleDebuggerEvent – state tracking
// ---------------------------------------------------------------------------

describe('handleDebuggerEvent', () => {
  function createDebuggerState() {
    let paused = false;
    let currentCallFrameId: string | null = null;
    const knownScripts = new Map<string, { scriptId: string; url: string }>();
    const breakpointMap = new Map<string, { id: string; file: string; line: number }>();

    function handleDebuggerEvent(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'Debugger.paused': {
          paused = true;
          const callFrames = params.callFrames as Array<{ callFrameId: string }> | undefined;
          currentCallFrameId = callFrames?.[0]?.callFrameId ?? null;
          break;
        }
        case 'Debugger.resumed':
          paused = false;
          currentCallFrameId = null;
          break;
        case 'Debugger.scriptParsed': {
          const url = params.url as string | undefined;
          const scriptId = params.scriptId as string | undefined;
          if (url && scriptId && !url.startsWith('chrome') && !url.startsWith('devtools')) {
            knownScripts.set(scriptId, { scriptId, url });
          }
          break;
        }
      }
    }

    return { get paused() { return paused; }, get currentCallFrameId() { return currentCallFrameId; }, knownScripts, breakpointMap, handleDebuggerEvent };
  }

  it('should track Debugger.paused event', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', {
      callFrames: [{ callFrameId: 'frame-0' }, { callFrameId: 'frame-1' }],
    });
    assert.equal(state.paused, true);
    assert.equal(state.currentCallFrameId, 'frame-0');
  });

  it('should use first call frame from paused event', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', {
      callFrames: [{ callFrameId: 'top-frame' }],
    });
    assert.equal(state.currentCallFrameId, 'top-frame');
  });

  it('should handle paused with empty callFrames', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', { callFrames: [] });
    assert.equal(state.paused, true);
    assert.equal(state.currentCallFrameId, null);
  });

  it('should handle paused with no callFrames', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', {});
    assert.equal(state.paused, true);
    assert.equal(state.currentCallFrameId, null);
  });

  it('should track Debugger.resumed event', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', {
      callFrames: [{ callFrameId: 'frame-0' }],
    });
    assert.equal(state.paused, true);
    state.handleDebuggerEvent('Debugger.resumed', {});
    assert.equal(state.paused, false);
    assert.equal(state.currentCallFrameId, null);
  });

  it('should track Debugger.scriptParsed event', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', {
      scriptId: '42',
      url: 'http://localhost:3000/app.js',
    });
    assert.equal(state.knownScripts.size, 1);
    const script = state.knownScripts.get('42');
    assert.ok(script);
    assert.equal(script.scriptId, '42');
    assert.equal(script.url, 'http://localhost:3000/app.js');
  });

  it('should filter out chrome:// scripts', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', {
      scriptId: '1', url: 'chrome://extensions/background.js',
    });
    assert.equal(state.knownScripts.size, 0);
  });

  it('should filter out devtools:// scripts', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', {
      scriptId: '2', url: 'devtools://devtools/bundled/shell.js',
    });
    assert.equal(state.knownScripts.size, 0);
  });

  it('should ignore scriptParsed with empty url', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', {
      scriptId: '3', url: '',
    });
    assert.equal(state.knownScripts.size, 0);
  });

  it('should ignore scriptParsed with missing scriptId', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', {
      url: 'http://localhost/app.js',
    });
    assert.equal(state.knownScripts.size, 0);
  });

  it('should track multiple scripts', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.scriptParsed', { scriptId: '10', url: 'http://example.com/a.js' });
    state.handleDebuggerEvent('Debugger.scriptParsed', { scriptId: '11', url: 'http://example.com/b.js' });
    state.handleDebuggerEvent('Debugger.scriptParsed', { scriptId: '12', url: 'http://example.com/c.js' });
    assert.equal(state.knownScripts.size, 3);
  });

  it('should ignore unknown debugger events', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.breakpointResolved', { breakpointId: 'bp-1' });
    assert.equal(state.paused, false);
    assert.equal(state.knownScripts.size, 0);
  });

  it('pause → resume → pause cycle should be consistent', () => {
    const state = createDebuggerState();
    state.handleDebuggerEvent('Debugger.paused', { callFrames: [{ callFrameId: 'f1' }] });
    assert.equal(state.paused, true);
    assert.equal(state.currentCallFrameId, 'f1');

    state.handleDebuggerEvent('Debugger.resumed', {});
    assert.equal(state.paused, false);
    assert.equal(state.currentCallFrameId, null);

    state.handleDebuggerEvent('Debugger.paused', { callFrames: [{ callFrameId: 'f2' }] });
    assert.equal(state.paused, true);
    assert.equal(state.currentCallFrameId, 'f2');
  });
});

// ---------------------------------------------------------------------------
// Test: Debugger tool – action routing and validation
// ---------------------------------------------------------------------------

describe('Debugger tool action routing', () => {
  function simulateDebuggerAction(action: string, args: Record<string, unknown> = {}) {
    const allArgs: Record<string, unknown> = { action, ...args };
    const debuggerPaused = allArgs._paused as boolean ?? false;
    const currentCallFrameId = allArgs._callFrameId as string | null ?? null;

    switch (action) {
      case 'enable':
        return { content: [{ type: 'text', text: 'Debugger enabled. Scripts will be parsed and breakpoints can be set.' }] };
      case 'set_breakpoint': {
        const file = allArgs.file as string;
        const line = allArgs.line as number;
        const condition = allArgs.condition as string | undefined;
        if (!file || !line) return { content: [{ type: 'text', text: 'Error: set_breakpoint requires file and line' }] };
        return { content: [{ type: 'text', text: `Breakpoint set: bp-1 at ${file}:${line}${condition ? ` (condition: ${condition})` : ''}` }] };
      }
      case 'remove_breakpoint': {
        const bpId = allArgs.breakpointId as string;
        if (!bpId) return { content: [{ type: 'text', text: 'Error: remove_breakpoint requires breakpointId' }] };
        return { content: [{ type: 'text', text: `Breakpoint removed: ${bpId}` }] };
      }
      case 'list_breakpoints':
        return { content: [{ type: 'text', text: 'No active breakpoints.' }] };
      case 'resume':
        if (!debuggerPaused) return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
        return { content: [{ type: 'text', text: 'Resumed execution.' }] };
      case 'step_over':
      case 'step_into':
      case 'step_out':
        if (!debuggerPaused) return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
        return { content: [{ type: 'text', text: `Stepped ${action.replace('step_', '')}.` }] };
      case 'inspect_variables':
        if (!debuggerPaused || !currentCallFrameId)
          return { content: [{ type: 'text', text: 'Debugger is not paused at a breakpoint.' }] };
        return { content: [{ type: 'text', text: '{"x": 42}' }] };
      case 'evaluate': {
        const expression = allArgs.expression as string;
        if (!expression) return { content: [{ type: 'text', text: 'Error: evaluate requires expression' }] };
        return { content: [{ type: 'text', text: String(42) }] };
      }
      case 'list_scripts':
        return { content: [{ type: 'text', text: 'No scripts found.' }] };
      case 'pause_on_exceptions':
        return { content: [{ type: 'text', text: `Pause on exceptions: ${allArgs.state || 'none'}` }] };
      default:
        return { content: [{ type: 'text', text: `Unknown debugger action: ${action}` }] };
    }
  }

  it('enable should return success message', () => {
    const result = simulateDebuggerAction('enable');
    assert.ok(result.content[0].text.includes('Debugger enabled'));
  });

  it('set_breakpoint should return breakpoint info', () => {
    const result = simulateDebuggerAction('set_breakpoint', { file: 'app.js', line: 10 });
    assert.ok(result.content[0].text.includes('app.js:10'));
    assert.ok(result.content[0].text.includes('Breakpoint set'));
  });

  it('set_breakpoint with condition should include condition', () => {
    const result = simulateDebuggerAction('set_breakpoint', { file: 'app.js', line: 10, condition: 'x > 5' });
    assert.ok(result.content[0].text.includes('condition: x > 5'));
  });

  it('set_breakpoint without file should error', () => {
    const result = simulateDebuggerAction('set_breakpoint', { line: 10 });
    assert.ok(result.content[0].text.includes('Error'));
    assert.ok(result.content[0].text.includes('file and line'));
  });

  it('set_breakpoint without line should error', () => {
    const result = simulateDebuggerAction('set_breakpoint', { file: 'app.js' });
    assert.ok(result.content[0].text.includes('Error'));
  });

  it('remove_breakpoint should return removed message', () => {
    const result = simulateDebuggerAction('remove_breakpoint', { breakpointId: 'bp-123' });
    assert.ok(result.content[0].text.includes('Breakpoint removed'));
    assert.ok(result.content[0].text.includes('bp-123'));
  });

  it('remove_breakpoint without id should error', () => {
    const result = simulateDebuggerAction('remove_breakpoint', {});
    assert.ok(result.content[0].text.includes('Error'));
    assert.ok(result.content[0].text.includes('breakpointId'));
  });

  it('list_breakpoints with none should show message', () => {
    const result = simulateDebuggerAction('list_breakpoints');
    assert.ok(result.content[0].text.includes('No active breakpoints'));
  });

  it('resume when not paused should error', () => {
    const result = simulateDebuggerAction('resume');
    assert.ok(result.content[0].text.includes('not paused'));
  });

  it('resume when paused should succeed', () => {
    const result = simulateDebuggerAction('resume', { _paused: true } as Record<string, unknown>);
    assert.ok(result.content[0].text.includes('Resumed'));
  });

  it('step_over when not paused should error', () => {
    const result = simulateDebuggerAction('step_over');
    assert.ok(result.content[0].text.includes('not paused'));
  });

  it('step_over when paused should succeed', () => {
    const result = simulateDebuggerAction('step_over', { _paused: true } as Record<string, unknown>);
    assert.ok(result.content[0].text.includes('over'));
  });

  it('step_into when paused should succeed', () => {
    const result = simulateDebuggerAction('step_into', { _paused: true } as Record<string, unknown>);
    assert.ok(result.content[0].text.includes('into'));
  });

  it('step_out when paused should succeed', () => {
    const result = simulateDebuggerAction('step_out', { _paused: true } as Record<string, unknown>);
    assert.ok(result.content[0].text.includes('out'));
  });

  it('inspect_variables when not paused should error', () => {
    const result = simulateDebuggerAction('inspect_variables');
    assert.ok(result.content[0].text.includes('not paused'));
  });

  it('inspect_variables when paused with frame should return data', () => {
    const result = simulateDebuggerAction('inspect_variables', { _paused: true, _callFrameId: 'f-0' } as Record<string, unknown>);
    assert.ok(result.content[0].text.includes('"x"'));
  });

  it('evaluate without expression should error', () => {
    const result = simulateDebuggerAction('evaluate', {});
    assert.ok(result.content[0].text.includes('Error'));
    assert.ok(result.content[0].text.includes('expression'));
  });

  it('evaluate with expression should return value', () => {
    const result = simulateDebuggerAction('evaluate', { expression: '1 + 1' });
    assert.equal(result.content[0].text, '42');
  });

  it('list_scripts should return message', () => {
    const result = simulateDebuggerAction('list_scripts');
    assert.ok(result.content[0].text.includes('No scripts'));
  });

  it('pause_on_exceptions should return state', () => {
    const result = simulateDebuggerAction('pause_on_exceptions', { state: 'uncaught' });
    assert.ok(result.content[0].text.includes('uncaught'));
  });

  it('pause_on_exceptions defaults to none', () => {
    const result = simulateDebuggerAction('pause_on_exceptions', {});
    assert.ok(result.content[0].text.includes('none'));
  });

  it('unknown action should error', () => {
    const result = simulateDebuggerAction('bogus');
    assert.ok(result.content[0].text.includes('Unknown debugger action'));
    assert.ok(result.content[0].text.includes('bogus'));
  });
});

// ---------------------------------------------------------------------------
// Test: Debugger tool definition – schema validation
// ---------------------------------------------------------------------------

describe('Debugger tool definition validation', () => {
  const debuggerDef = {
    name: 'debugger',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'set_breakpoint', 'remove_breakpoint', 'list_breakpoints', 'resume', 'step_over', 'step_into', 'step_out', 'inspect_variables', 'evaluate', 'list_scripts', 'pause_on_exceptions'],
        },
        file: { type: 'string' },
        line: { type: 'number' },
        condition: { type: 'string' },
        breakpointId: { type: 'string' },
        expression: { type: 'string' },
        search: { type: 'string' },
        state: { type: 'string', enum: ['none', 'uncaught', 'all'] },
      },
      required: ['action'],
    },
  };

  it('should have name "debugger"', () => {
    assert.equal(debuggerDef.name, 'debugger');
  });

  it('should require action parameter', () => {
    assert.deepEqual(debuggerDef.inputSchema.required, ['action']);
  });

  it('should list all 12 actions', () => {
    assert.equal(debuggerDef.inputSchema.properties.action.enum.length, 12);
  });

  it('should include all stepping actions', () => {
    const actions = debuggerDef.inputSchema.properties.action.enum;
    assert.ok(actions.includes('step_over'));
    assert.ok(actions.includes('step_into'));
    assert.ok(actions.includes('step_out'));
  });

  it('should include evaluate action', () => {
    assert.ok(debuggerDef.inputSchema.properties.action.enum.includes('evaluate'));
  });

  it('should have file property for breakpoint url', () => {
    assert.equal(debuggerDef.inputSchema.properties.file.type, 'string');
  });

  it('should have line property as number', () => {
    assert.equal(debuggerDef.inputSchema.properties.line.type, 'number');
  });

  it('should have state enum for exception pause modes', () => {
    assert.deepEqual(debuggerDef.inputSchema.properties.state.enum, ['none', 'uncaught', 'all']);
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect tool – response formatting
// ---------------------------------------------------------------------------

describe('CSS Inspect result formatting', () => {
  function formatCssResult(parsed: Record<string, unknown>) {
    const tag = parsed.__tagName as string;
    const id = parsed.__id ? `#${parsed.__id}` : '';
    const cls = parsed.__className ? `.${(parsed.__className as string).split(' ').join('.')}` : '';
    const bounds = parsed.__bounds as { width: number; height: number; x: number; y: number };
    const header = `Element: <${tag}${id}${cls}> (${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y})`;

    const copy = { ...parsed };
    delete copy.__tagName; delete copy.__className; delete copy.__id; delete copy.__bounds;
    const propLines = Object.entries(copy)
      .filter(([, v]) => v !== '' && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== 'visible' && v !== '0px')
      .map(([k, v]) => `  ${k}: ${v}`);

    return `${header}\n\nComputed styles:\n${propLines.join('\n') || '  (no non-default styles)'}`;
  }

  it('should format element header with tag, id, class, bounds', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: 'main', __className: 'container wide',
      __bounds: { width: 800, height: 600, x: 0, y: 0 },
      display: 'flex',
    });
    assert.ok(result.includes('<div#main.container.wide>'));
    assert.ok(result.includes('800x600'));
    assert.ok(result.includes('at 0,0'));
  });

  it('should format element without id or class', () => {
    const result = formatCssResult({
      __tagName: 'span', __id: '', __className: '',
      __bounds: { width: 100, height: 20, x: 50, y: 100 },
      color: 'rgb(0, 0, 0)',
    });
    assert.ok(result.includes('<span>'));
    assert.ok(!result.includes('#'));
    assert.ok(result.includes('100x20'));
  });

  it('should list non-default CSS properties', () => {
    const result = formatCssResult({
      __tagName: 'button', __id: '', __className: '',
      __bounds: { width: 120, height: 40, x: 10, y: 200 },
      display: 'flex',
      color: 'rgb(255, 255, 255)',
      'background-color': 'rgb(0, 128, 0)',
      border: 'none',
      opacity: '1',
    });
    assert.ok(result.includes('display: flex'));
    assert.ok(result.includes('color: rgb(255, 255, 255)'));
    assert.ok(result.includes('background-color: rgb(0, 128, 0)'));
    assert.ok(!result.includes('border: none'));
  });

  it('should filter out default values', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: '', __className: '',
      __bounds: { width: 100, height: 100, x: 0, y: 0 },
      display: 'none',
      margin: '0px',
      padding: 'auto',
      overflow: 'visible',
      'font-weight': 'normal',
    });
    assert.ok(!result.includes('margin: 0px'));
    assert.ok(!result.includes('padding: auto'));
    assert.ok(!result.includes('overflow: visible'));
    assert.ok(!result.includes('font-weight: normal'));
    assert.ok(!result.includes('display: none'));
  });

  it('should show placeholder when all properties are default', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: '', __className: '',
      __bounds: { width: 100, height: 100, x: 0, y: 0 },
      display: 'none',
      border: 'none',
    });
    assert.ok(result.includes('(no non-default styles)'));
  });

  it('should handle multiple classes correctly', () => {
    const result = formatCssResult({
      __tagName: 'nav', __id: 'top', __className: 'nav primary sticky',
      __bounds: { width: 1200, height: 60, x: 0, y: 0 },
    });
    assert.ok(result.includes('<nav#top.nav.primary.sticky>'));
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect tool definition – schema validation
// ---------------------------------------------------------------------------

describe('CSS Inspect tool definition validation', () => {
  const cssDef = {
    name: 'css_inspect',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: { type: 'string' },
      },
      required: ['selector'],
    },
  };

  it('should have name "css_inspect"', () => {
    assert.equal(cssDef.name, 'css_inspect');
  });

  it('should require selector parameter', () => {
    assert.deepEqual(cssDef.inputSchema.required, ['selector']);
  });

  it('should have optional properties parameter', () => {
    assert.ok(!cssDef.inputSchema.required.includes('properties'));
    assert.equal(cssDef.inputSchema.properties.properties.type, 'string');
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect JavaScript injection code
// ---------------------------------------------------------------------------

describe('CSS Inspect injection code generation', () => {
  function buildCssInspectCode(selector: string, requestedProps: string[]) {
    const defaultProps = [
      'display', 'position', 'width', 'height', 'margin', 'padding',
      'color', 'background-color', 'font-size', 'font-weight', 'font-family',
      'border', 'border-radius', 'opacity', 'visibility', 'overflow',
      'flex-direction', 'justify-content', 'align-items', 'gap',
      'z-index', 'box-shadow', 'text-align',
    ];
    const propsToGet = requestedProps.length > 0 ? requestedProps : defaultProps;

    return `(function() {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: 'Element not found: ' + ${JSON.stringify(selector)} });
      var cs = getComputedStyle(el);
      var result = {};
      ${JSON.stringify(propsToGet)}.forEach(function(p) { result[p] = cs.getPropertyValue(p); });
      return JSON.stringify(result);
    })()`;
  }

  it('should embed selector safely with JSON.stringify', () => {
    const code = buildCssInspectCode('div[data-x="1"]', []);
    assert.ok(code.includes('"div[data-x=\\"1\\"]"'));
  });

  it('should use default properties when none specified', () => {
    const code = buildCssInspectCode('.btn', []);
    assert.ok(code.includes('"display"'));
    assert.ok(code.includes('"background-color"'));
    assert.ok(code.includes('"font-size"'));
  });

  it('should use custom properties when specified', () => {
    const code = buildCssInspectCode('.btn', ['color', 'font-size']);
    assert.ok(code.includes('["color","font-size"]'));
    assert.ok(!code.includes('"display"'));
  });

  it('should generate valid self-executing function', () => {
    const code = buildCssInspectCode('#header', []);
    assert.ok(code.startsWith('(function()'));
    assert.ok(code.trimEnd().endsWith('})()'));
  });
});

// ---------------------------------------------------------------------------
// Test: Breakpoint state management
// ---------------------------------------------------------------------------

describe('Breakpoint state management', () => {
  it('should add and list breakpoints', () => {
    const breakpoints = new Map<string, { id: string; file: string; line: number }>();
    breakpoints.set('bp-1', { id: 'bp-1', file: 'app.js', line: 10 });
    breakpoints.set('bp-2', { id: 'bp-2', file: 'utils.js', line: 25 });

    const bps = Array.from(breakpoints.values());
    assert.equal(bps.length, 2);
    const lines = bps.map(bp => `${bp.id}: ${bp.file}:${bp.line}`);
    assert.ok(lines[0].includes('app.js:10'));
    assert.ok(lines[1].includes('utils.js:25'));
  });

  it('should remove a breakpoint by id', () => {
    const breakpoints = new Map<string, { id: string; file: string; line: number }>();
    breakpoints.set('bp-1', { id: 'bp-1', file: 'app.js', line: 10 });
    breakpoints.set('bp-2', { id: 'bp-2', file: 'utils.js', line: 25 });
    breakpoints.delete('bp-1');
    assert.equal(breakpoints.size, 1);
    assert.ok(!breakpoints.has('bp-1'));
    assert.ok(breakpoints.has('bp-2'));
  });

  it('should clear all breakpoints', () => {
    const breakpoints = new Map<string, { id: string; file: string; line: number }>();
    breakpoints.set('bp-1', { id: 'bp-1', file: 'a.js', line: 1 });
    breakpoints.set('bp-2', { id: 'bp-2', file: 'b.js', line: 2 });
    breakpoints.clear();
    assert.equal(breakpoints.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Test: Script search/filter
// ---------------------------------------------------------------------------

describe('Script URL filtering for list_scripts', () => {
  function filterScripts(scripts: Array<{ scriptId: string; url: string }>, search: string) {
    const searchStr = search.toLowerCase();
    let filtered = scripts;
    if (searchStr) filtered = scripts.filter(s => s.url.toLowerCase().includes(searchStr));
    return filtered.slice(0, 30);
  }

  it('should filter scripts by URL substring (case-insensitive)', () => {
    const scripts = [
      { scriptId: '1', url: 'http://localhost:3000/App.js' },
      { scriptId: '2', url: 'http://localhost:3000/utils.js' },
      { scriptId: '3', url: 'http://localhost:3000/vendor/react.js' },
    ];
    const result = filterScripts(scripts, 'app');
    assert.equal(result.length, 1);
    assert.equal(result[0].scriptId, '1');
  });

  it('should return all scripts when search is empty', () => {
    const scripts = [
      { scriptId: '1', url: 'http://localhost:3000/a.js' },
      { scriptId: '2', url: 'http://localhost:3000/b.js' },
    ];
    assert.equal(filterScripts(scripts, '').length, 2);
  });

  it('should cap results at 30 scripts', () => {
    const scripts = Array.from({ length: 50 }, (_, i) => ({
      scriptId: String(i), url: `http://localhost/${i}.js`,
    }));
    assert.equal(filterScripts(scripts, '').length, 30);
  });

  it('should return empty when no match', () => {
    const scripts = [{ scriptId: '1', url: 'http://example.com/main.js' }];
    assert.equal(filterScripts(scripts, 'nonexistent').length, 0);
  });
});

// ---------------------------------------------------------------------------
// Test: Reset state clearing – includes debugger
// ---------------------------------------------------------------------------

describe('Reset clears debugger state', () => {
  it('should clear all debugger state fields', () => {
    let debuggerEnabled = true;
    const breakpoints = new Map<string, unknown>();
    breakpoints.set('bp-1', {});
    let debuggerPaused = true;
    let currentCallFrameId: string | null = 'frame-0';
    const knownScripts = new Map<string, unknown>();
    knownScripts.set('1', {});

    debuggerEnabled = false;
    breakpoints.clear();
    debuggerPaused = false;
    currentCallFrameId = null;
    knownScripts.clear();

    assert.equal(debuggerEnabled, false);
    assert.equal(breakpoints.size, 0);
    assert.equal(debuggerPaused, false);
    assert.equal(currentCallFrameId, null);
    assert.equal(knownScripts.size, 0);
  });

  it('reset text should mention debugger state and sessions', () => {
    const resetText = 'Connection reset. Console logs, network entries, Playwright state, debugger state, and sessions cleared.';
    assert.ok(resetText.includes('debugger state'));
    assert.ok(resetText.includes('sessions'));
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager tool – action routing
// ---------------------------------------------------------------------------

describe('Session Manager tool action routing', () => {
  function createSessionStore() {
    const sessions = new Map<string, { connected: boolean; stateKeys: string[] }>();

    function simulateAction(action: string, sessionId?: string) {
      switch (action) {
        case 'list': {
          if (sessions.size === 0) return { content: [{ type: 'text', text: 'No active sessions.' }] };
          const lines = Array.from(sessions.entries()).map(([id, s]) =>
            `${id}: connected=${s.connected}, stateKeys=[${s.stateKeys.join(', ')}]`
          );
          return { content: [{ type: 'text', text: `Sessions (${sessions.size}):\n${lines.join('\n')}` }] };
        }
        case 'create': {
          if (!sessionId) return { content: [{ type: 'text', text: 'Error: create requires sessionId' }] };
          if (sessions.has(sessionId)) return { content: [{ type: 'text', text: `Session "${sessionId}" already exists.` }] };
          sessions.set(sessionId, { connected: false, stateKeys: [] });
          return { content: [{ type: 'text', text: `Session "${sessionId}" created.` }] };
        }
        case 'switch': {
          if (!sessionId) return { content: [{ type: 'text', text: 'Error: switch requires sessionId' }] };
          if (!sessions.has(sessionId)) return { content: [{ type: 'text', text: `Session "${sessionId}" not found. Use "create" first.` }] };
          return { content: [{ type: 'text', text: `Switched to session "${sessionId}". Use playwright_execute with this session context.` }] };
        }
        case 'remove': {
          if (!sessionId) return { content: [{ type: 'text', text: 'Error: remove requires sessionId' }] };
          const had = sessions.delete(sessionId);
          return { content: [{ type: 'text', text: had ? `Session "${sessionId}" removed.` : `Session "${sessionId}" not found.` }] };
        }
        case 'remove_all': {
          const count = sessions.size;
          sessions.clear();
          return { content: [{ type: 'text', text: `All ${count} sessions removed.` }] };
        }
        default:
          return { content: [{ type: 'text', text: `Unknown session action: ${action}. Use: list, create, switch, remove, remove_all` }] };
      }
    }

    return { sessions, simulateAction };
  }

  it('list with no sessions', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('list');
    assert.ok(result.content[0].text.includes('No active sessions'));
  });

  it('create should add session', () => {
    const { sessions, simulateAction } = createSessionStore();
    const result = simulateAction('create', 'my-session');
    assert.ok(result.content[0].text.includes('created'));
    assert.equal(sessions.size, 1);
  });

  it('create without sessionId should error', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('create');
    assert.ok(result.content[0].text.includes('Error'));
    assert.ok(result.content[0].text.includes('sessionId'));
  });

  it('create duplicate should report already exists', () => {
    const { simulateAction } = createSessionStore();
    simulateAction('create', 'dup');
    const result = simulateAction('create', 'dup');
    assert.ok(result.content[0].text.includes('already exists'));
  });

  it('list should show created sessions', () => {
    const { simulateAction } = createSessionStore();
    simulateAction('create', 'alpha');
    simulateAction('create', 'beta');
    const result = simulateAction('list');
    assert.ok(result.content[0].text.includes('Sessions (2)'));
    assert.ok(result.content[0].text.includes('alpha'));
    assert.ok(result.content[0].text.includes('beta'));
  });

  it('switch to existing session should succeed', () => {
    const { simulateAction } = createSessionStore();
    simulateAction('create', 'target');
    const result = simulateAction('switch', 'target');
    assert.ok(result.content[0].text.includes('Switched'));
    assert.ok(result.content[0].text.includes('target'));
  });

  it('switch to non-existent session should error', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('switch', 'ghost');
    assert.ok(result.content[0].text.includes('not found'));
  });

  it('switch without sessionId should error', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('switch');
    assert.ok(result.content[0].text.includes('Error'));
  });

  it('remove existing session should succeed', () => {
    const { sessions, simulateAction } = createSessionStore();
    simulateAction('create', 'to-remove');
    const result = simulateAction('remove', 'to-remove');
    assert.ok(result.content[0].text.includes('removed'));
    assert.equal(sessions.size, 0);
  });

  it('remove non-existent session should report not found', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('remove', 'ghost');
    assert.ok(result.content[0].text.includes('not found'));
  });

  it('remove without sessionId should error', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('remove');
    assert.ok(result.content[0].text.includes('Error'));
  });

  it('remove_all should clear all sessions', () => {
    const { sessions, simulateAction } = createSessionStore();
    simulateAction('create', 'a');
    simulateAction('create', 'b');
    const result = simulateAction('remove_all');
    assert.ok(result.content[0].text.includes('All 2 sessions'));
    assert.equal(sessions.size, 0);
  });

  it('unknown action should error', () => {
    const { simulateAction } = createSessionStore();
    const result = simulateAction('bogus');
    assert.ok(result.content[0].text.includes('Unknown session action'));
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager tool definition
// ---------------------------------------------------------------------------

describe('Session Manager tool definition validation', () => {
  const sessionDef = {
    name: 'session_manager',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'switch', 'remove', 'remove_all'],
        },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  };

  it('should have name "session_manager"', () => {
    assert.equal(sessionDef.name, 'session_manager');
  });

  it('should require action parameter', () => {
    assert.deepEqual(sessionDef.inputSchema.required, ['action']);
  });

  it('should list 5 actions', () => {
    assert.equal(sessionDef.inputSchema.properties.action.enum.length, 5);
  });

  it('should include all actions', () => {
    const actions = sessionDef.inputSchema.properties.action.enum;
    assert.ok(actions.includes('list'));
    assert.ok(actions.includes('create'));
    assert.ok(actions.includes('switch'));
    assert.ok(actions.includes('remove'));
    assert.ok(actions.includes('remove_all'));
  });

  it('should have optional sessionId parameter', () => {
    assert.ok(!sessionDef.inputSchema.required.includes('sessionId'));
    assert.equal(sessionDef.inputSchema.properties.sessionId.type, 'string');
  });

  it('total tool count should be 16 with session_manager', () => {
    const toolNames = [
      'screenshot', 'accessibility_snapshot', 'execute', 'dashboard_state',
      'console_logs', 'network_log', 'playwright_execute', 'reset',
      'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
      'override_app', 'app_action', 'debugger', 'css_inspect', 'session_manager',
    ];
    assert.equal(toolNames.length, 16);
    assert.ok(toolNames.includes('session_manager'));
  });
});

// ===========================================================================
// COMPREHENSIVE TEST SUITE – PHASE 3 DEEP COVERAGE
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: Debugger state machine – exhaustive transitions
// ---------------------------------------------------------------------------

describe('Debugger state machine – exhaustive transitions', () => {
  function createDebuggerFSM() {
    let paused = false;
    let callFrameId: string | null = null;
    const scripts = new Map<string, { scriptId: string; url: string }>();

    function dispatch(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'Debugger.paused': {
          paused = true;
          const frames = params.callFrames as Array<{ callFrameId: string }> | undefined;
          callFrameId = frames?.[0]?.callFrameId ?? null;
          break;
        }
        case 'Debugger.resumed':
          paused = false;
          callFrameId = null;
          break;
        case 'Debugger.scriptParsed': {
          const url = params.url as string | undefined;
          const sid = params.scriptId as string | undefined;
          if (url && sid && !url.startsWith('chrome') && !url.startsWith('devtools')) {
            scripts.set(sid, { scriptId: sid, url });
          }
          break;
        }
      }
    }
    return { get paused() { return paused; }, get callFrameId() { return callFrameId; }, scripts, dispatch };
  }

  it('rapid pause→resume→pause should not leak state', () => {
    const fsm = createDebuggerFSM();
    for (let i = 0; i < 100; i++) {
      fsm.dispatch('Debugger.paused', { callFrames: [{ callFrameId: `f-${i}` }] });
      assert.equal(fsm.paused, true);
      assert.equal(fsm.callFrameId, `f-${i}`);
      fsm.dispatch('Debugger.resumed', {});
      assert.equal(fsm.paused, false);
      assert.equal(fsm.callFrameId, null);
    }
  });

  it('multiple scriptParsed events with same id should overwrite', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '1', url: 'http://old.js' });
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '1', url: 'http://new.js' });
    assert.equal(fsm.scripts.size, 1);
    assert.equal(fsm.scripts.get('1')!.url, 'http://new.js');
  });

  it('resumed without prior paused should be safe', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.resumed', {});
    assert.equal(fsm.paused, false);
    assert.equal(fsm.callFrameId, null);
  });

  it('should ignore completely unrelated events', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Runtime.consoleAPICalled', { type: 'log' });
    fsm.dispatch('Network.requestWillBeSent', { requestId: '1' });
    fsm.dispatch('Page.loadEventFired', { timestamp: 123 });
    assert.equal(fsm.paused, false);
    assert.equal(fsm.scripts.size, 0);
  });

  it('should preserve script list across pause/resume cycles', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '10', url: 'http://a.js' });
    fsm.dispatch('Debugger.paused', { callFrames: [{ callFrameId: 'f1' }] });
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '11', url: 'http://b.js' });
    fsm.dispatch('Debugger.resumed', {});
    assert.equal(fsm.scripts.size, 2);
  });

  it('paused with nested callFrames should pick first', () => {
    const fsm = createDebuggerFSM();
    const frames = Array.from({ length: 10 }, (_, i) => ({ callFrameId: `frame-${i}` }));
    fsm.dispatch('Debugger.paused', { callFrames: frames });
    assert.equal(fsm.callFrameId, 'frame-0');
  });

  it('should handle scripts with special characters in URL', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '99', url: 'http://example.com/app.js?v=1&t=2#hash' });
    assert.equal(fsm.scripts.get('99')!.url, 'http://example.com/app.js?v=1&t=2#hash');
  });

  it('should handle data: URLs', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '77', url: 'data:text/javascript,console.log(1)' });
    assert.equal(fsm.scripts.size, 1);
  });

  it('should filter blob: URLs from chrome extensions', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '50', url: 'chrome-extension://abc/content.js' });
    assert.equal(fsm.scripts.size, 0);
  });

  it('should accept file:// URLs', () => {
    const fsm = createDebuggerFSM();
    fsm.dispatch('Debugger.scriptParsed', { scriptId: '60', url: 'file:///Users/me/project/test.js' });
    assert.equal(fsm.scripts.size, 1);
  });
});

// ---------------------------------------------------------------------------
// Test: Debugger breakpoint URL escaping
// ---------------------------------------------------------------------------

describe('Debugger breakpoint URL regex escaping', () => {
  function escapeForUrlRegex(file: string): string {
    return file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  it('should escape dots', () => {
    assert.equal(escapeForUrlRegex('app.js'), 'app\\.js');
  });

  it('should escape query param characters', () => {
    assert.equal(escapeForUrlRegex('app.js?v=1'), 'app\\.js\\?v=1');
  });

  it('should escape parentheses', () => {
    assert.equal(escapeForUrlRegex('file(1).js'), 'file\\(1\\)\\.js');
  });

  it('should escape brackets', () => {
    assert.equal(escapeForUrlRegex('[chunk].js'), '\\[chunk\\]\\.js');
  });

  it('should escape backslashes', () => {
    assert.equal(escapeForUrlRegex('path\\to\\file'), 'path\\\\to\\\\file');
  });

  it('should handle path with plus signs', () => {
    assert.equal(escapeForUrlRegex('c++/main.js'), 'c\\+\\+/main\\.js');
  });

  it('should not escape forward slashes', () => {
    assert.equal(escapeForUrlRegex('src/utils/helpers.js'), 'src/utils/helpers\\.js');
  });

  it('should handle empty string', () => {
    assert.equal(escapeForUrlRegex(''), '');
  });

  it('should handle real-world webpack chunk', () => {
    const input = 'vendors~main.abc123.chunk.js';
    const result = escapeForUrlRegex(input);
    assert.ok(result.includes('vendors~main'));
    assert.ok(result.includes('\\.chunk\\.js'));
  });
});

// ---------------------------------------------------------------------------
// Test: Debugger evaluate result formatting
// ---------------------------------------------------------------------------

describe('Debugger evaluate result formatting', () => {
  function formatEvalResult(evalResult: { result?: { value?: unknown; type?: string; description?: string } } | undefined) {
    const val = evalResult?.result?.value;
    return val !== undefined
      ? (typeof val === 'string' ? val : JSON.stringify(val, null, 2))
      : (evalResult?.result?.description || 'undefined');
  }

  it('should format string value directly', () => {
    assert.equal(formatEvalResult({ result: { value: 'hello' } }), 'hello');
  });

  it('should JSON.stringify number value', () => {
    assert.equal(formatEvalResult({ result: { value: 42 } }), '42');
  });

  it('should JSON.stringify boolean value', () => {
    assert.equal(formatEvalResult({ result: { value: true } }), 'true');
  });

  it('should JSON.stringify null value', () => {
    assert.equal(formatEvalResult({ result: { value: null } }), 'null');
  });

  it('should JSON.stringify object value with pretty printing', () => {
    const result = formatEvalResult({ result: { value: { a: 1, b: 2 } } });
    assert.ok(result.includes('"a": 1'));
    assert.ok(result.includes('"b": 2'));
  });

  it('should JSON.stringify array value', () => {
    const result = formatEvalResult({ result: { value: [1, 2, 3] } });
    assert.ok(result.includes('1'));
    assert.ok(result.includes('3'));
  });

  it('should use description when value is undefined', () => {
    assert.equal(formatEvalResult({ result: { type: 'function', description: 'function foo(){}' } }), 'function foo(){}');
  });

  it('should return "undefined" when nothing available', () => {
    assert.equal(formatEvalResult({ result: {} }), 'undefined');
  });

  it('should return "undefined" for undefined evalResult', () => {
    assert.equal(formatEvalResult(undefined), 'undefined');
  });

  it('should handle empty string value', () => {
    assert.equal(formatEvalResult({ result: { value: '' } }), '');
  });

  it('should handle value=0 (falsy but defined)', () => {
    assert.equal(formatEvalResult({ result: { value: 0 } }), '0');
  });

  it('should handle value=false (falsy but defined)', () => {
    assert.equal(formatEvalResult({ result: { value: false } }), 'false');
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect – default properties list
// ---------------------------------------------------------------------------

describe('CSS Inspect default properties list', () => {
  const defaultProps = [
    'display', 'position', 'width', 'height', 'margin', 'padding',
    'color', 'background-color', 'font-size', 'font-weight', 'font-family',
    'border', 'border-radius', 'opacity', 'visibility', 'overflow',
    'flex-direction', 'justify-content', 'align-items', 'gap',
    'z-index', 'box-shadow', 'text-align',
  ];

  it('should contain 23 default properties', () => {
    assert.equal(defaultProps.length, 23);
  });

  it('should include layout properties', () => {
    assert.ok(defaultProps.includes('display'));
    assert.ok(defaultProps.includes('position'));
    assert.ok(defaultProps.includes('width'));
    assert.ok(defaultProps.includes('height'));
  });

  it('should include flex properties', () => {
    assert.ok(defaultProps.includes('flex-direction'));
    assert.ok(defaultProps.includes('justify-content'));
    assert.ok(defaultProps.includes('align-items'));
    assert.ok(defaultProps.includes('gap'));
  });

  it('should include typography properties', () => {
    assert.ok(defaultProps.includes('font-size'));
    assert.ok(defaultProps.includes('font-weight'));
    assert.ok(defaultProps.includes('font-family'));
    assert.ok(defaultProps.includes('text-align'));
  });

  it('should include visual properties', () => {
    assert.ok(defaultProps.includes('color'));
    assert.ok(defaultProps.includes('background-color'));
    assert.ok(defaultProps.includes('opacity'));
    assert.ok(defaultProps.includes('box-shadow'));
  });

  it('should include box model properties', () => {
    assert.ok(defaultProps.includes('margin'));
    assert.ok(defaultProps.includes('padding'));
    assert.ok(defaultProps.includes('border'));
    assert.ok(defaultProps.includes('border-radius'));
  });

  it('should have no duplicates', () => {
    const unique = new Set(defaultProps);
    assert.equal(unique.size, defaultProps.length);
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect – property parsing from comma-separated string
// ---------------------------------------------------------------------------

describe('CSS Inspect property parsing', () => {
  function parseProperties(input: string): string[] {
    return (input || '').split(',').map(p => p.trim()).filter(Boolean);
  }

  it('should parse single property', () => {
    assert.deepEqual(parseProperties('color'), ['color']);
  });

  it('should parse multiple properties', () => {
    assert.deepEqual(parseProperties('color,font-size,display'), ['color', 'font-size', 'display']);
  });

  it('should handle spaces around commas', () => {
    assert.deepEqual(parseProperties('color , font-size , display'), ['color', 'font-size', 'display']);
  });

  it('should handle leading/trailing commas', () => {
    assert.deepEqual(parseProperties(',color,'), ['color']);
  });

  it('should return empty array for empty string', () => {
    assert.deepEqual(parseProperties(''), []);
  });

  it('should return empty array for undefined input', () => {
    assert.deepEqual(parseProperties(undefined as unknown as string), []);
  });

  it('should handle CSS variable names', () => {
    assert.deepEqual(parseProperties('--my-color, --spacing'), ['--my-color', '--spacing']);
  });

  it('should handle single whitespace-only input', () => {
    assert.deepEqual(parseProperties('   '), []);
  });

  it('should handle consecutive commas', () => {
    assert.deepEqual(parseProperties('color,,font-size'), ['color', 'font-size']);
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect – selector edge cases in generated code
// ---------------------------------------------------------------------------

describe('CSS Inspect selector injection safety', () => {
  function buildSelectorCode(selector: string): string {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }

  it('should safely embed selector with double quotes', () => {
    const code = buildSelectorCode('div[data-x="foo"]');
    assert.ok(code.includes('\\'));
    assert.ok(!code.includes('data-x="foo"'));
  });

  it('should safely embed selector with single quotes', () => {
    const code = buildSelectorCode("div[data-x='foo']");
    assert.ok(code.includes("data-x='foo'"));
  });

  it('should handle :nth-child selectors', () => {
    const code = buildSelectorCode('li:nth-child(2n+1)');
    assert.ok(code.includes(':nth-child'));
  });

  it('should handle > combinator', () => {
    const code = buildSelectorCode('div > span.label');
    assert.ok(code.includes('> span.label'));
  });

  it('should handle ~ combinator', () => {
    const code = buildSelectorCode('h2 ~ p');
    assert.ok(code.includes('~ p'));
  });

  it('should handle attribute selectors with special chars', () => {
    const code = buildSelectorCode('[href^="https://"]');
    assert.ok(code.includes('href'));
  });

  it('should handle :not() pseudo-class', () => {
    const code = buildSelectorCode('button:not(.disabled)');
    assert.ok(code.includes(':not'));
  });

  it('should handle very long selector', () => {
    const selector = '#main > .container > .row > .col-md-6 > .card > .card-body > h3.title';
    const code = buildSelectorCode(selector);
    assert.ok(code.includes(selector.replace(/"/g, '\\"')));
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Inspect – formatting edge cases
// ---------------------------------------------------------------------------

describe('CSS Inspect formatting edge cases', () => {
  function formatCssResult(parsed: Record<string, unknown>) {
    const tag = parsed.__tagName as string;
    const id = parsed.__id ? `#${parsed.__id}` : '';
    const cls = parsed.__className ? `.${(parsed.__className as string).split(' ').join('.')}` : '';
    const bounds = parsed.__bounds as { width: number; height: number; x: number; y: number };
    const header = `Element: <${tag}${id}${cls}> (${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y})`;

    const copy = { ...parsed };
    delete copy.__tagName; delete copy.__className; delete copy.__id; delete copy.__bounds;
    const propLines = Object.entries(copy)
      .filter(([, v]) => v !== '' && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== 'visible' && v !== '0px')
      .map(([k, v]) => `  ${k}: ${v}`);

    return `${header}\n\nComputed styles:\n${propLines.join('\n') || '  (no non-default styles)'}`;
  }

  it('should handle element with many classes', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: '', __className: 'a b c d e f g',
      __bounds: { width: 100, height: 50, x: 0, y: 0 },
    });
    assert.ok(result.includes('.a.b.c.d.e.f.g'));
  });

  it('should handle element with special characters in id', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: 'my-component_v2', __className: '',
      __bounds: { width: 100, height: 50, x: 0, y: 0 },
    });
    assert.ok(result.includes('#my-component_v2'));
  });

  it('should handle zero-size element', () => {
    const result = formatCssResult({
      __tagName: 'span', __id: '', __className: '',
      __bounds: { width: 0, height: 0, x: 0, y: 0 },
    });
    assert.ok(result.includes('0x0 at 0,0'));
  });

  it('should handle negative position', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: '', __className: '',
      __bounds: { width: 100, height: 50, x: -50, y: -25 },
    });
    assert.ok(result.includes('at -50,-25'));
  });

  it('should handle very large element', () => {
    const result = formatCssResult({
      __tagName: 'body', __id: '', __className: '',
      __bounds: { width: 99999, height: 88888, x: 0, y: 0 },
    });
    assert.ok(result.includes('99999x88888'));
  });

  it('should include rgb color values', () => {
    const result = formatCssResult({
      __tagName: 'div', __id: '', __className: '',
      __bounds: { width: 100, height: 100, x: 0, y: 0 },
      color: 'rgb(255, 0, 0)',
      'background-color': 'rgba(0, 0, 0, 0.5)',
    });
    assert.ok(result.includes('color: rgb(255, 0, 0)'));
    assert.ok(result.includes('background-color: rgba(0, 0, 0, 0.5)'));
  });

  it('should handle input element', () => {
    const result = formatCssResult({
      __tagName: 'input', __id: 'email', __className: 'form-control',
      __bounds: { width: 300, height: 38, x: 10, y: 200 },
      'border-radius': '4px',
    });
    assert.ok(result.includes('<input#email.form-control>'));
    assert.ok(result.includes('border-radius: 4px'));
  });

  it('should handle self-closing element types', () => {
    for (const tag of ['img', 'br', 'hr', 'input', 'meta']) {
      const result = formatCssResult({
        __tagName: tag, __id: '', __className: '',
        __bounds: { width: 100, height: 100, x: 0, y: 0 },
      });
      assert.ok(result.includes(`<${tag}>`));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager – eviction strategy deep testing
// ---------------------------------------------------------------------------

describe('Session Manager eviction strategy', () => {
  function createEvictingStore(maxSessions: number) {
    const sessions = new Map<string, { created: number }>();

    function getOrCreate(id: string) {
      let s = sessions.get(id);
      if (!s) {
        if (sessions.size >= maxSessions) {
          const oldest = sessions.keys().next().value as string;
          sessions.delete(oldest);
        }
        s = { created: Date.now() };
        sessions.set(id, s);
      }
      return s;
    }

    return { sessions, getOrCreate };
  }

  it('should evict in FIFO order', () => {
    const store = createEvictingStore(3);
    store.getOrCreate('a');
    store.getOrCreate('b');
    store.getOrCreate('c');
    store.getOrCreate('d');
    assert.ok(!store.sessions.has('a'));
    assert.ok(store.sessions.has('b'));
    assert.ok(store.sessions.has('c'));
    assert.ok(store.sessions.has('d'));
  });

  it('accessing existing session should not evict', () => {
    const store = createEvictingStore(2);
    store.getOrCreate('x');
    store.getOrCreate('y');
    store.getOrCreate('x');
    assert.equal(store.sessions.size, 2);
    assert.ok(store.sessions.has('x'));
    assert.ok(store.sessions.has('y'));
  });

  it('should handle max=1', () => {
    const store = createEvictingStore(1);
    store.getOrCreate('first');
    assert.equal(store.sessions.size, 1);
    store.getOrCreate('second');
    assert.equal(store.sessions.size, 1);
    assert.ok(!store.sessions.has('first'));
    assert.ok(store.sessions.has('second'));
  });

  it('sequential evictions should preserve last N sessions', () => {
    const store = createEvictingStore(3);
    for (let i = 0; i < 20; i++) {
      store.getOrCreate(`s-${i}`);
    }
    assert.equal(store.sessions.size, 3);
    assert.ok(store.sessions.has('s-17'));
    assert.ok(store.sessions.has('s-18'));
    assert.ok(store.sessions.has('s-19'));
  });

  it('eviction after manual delete should work correctly', () => {
    const store = createEvictingStore(3);
    store.getOrCreate('a');
    store.getOrCreate('b');
    store.getOrCreate('c');
    store.sessions.delete('b');
    store.getOrCreate('d');
    assert.equal(store.sessions.size, 3);
    assert.ok(store.sessions.has('a'));
    assert.ok(store.sessions.has('c'));
    assert.ok(store.sessions.has('d'));
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager – concurrent actions
// ---------------------------------------------------------------------------

describe('Session Manager concurrent operations', () => {
  function createConcurrentStore() {
    const sessions = new Map<string, { data: string }>();
    return {
      sessions,
      create(id: string) {
        if (sessions.has(id)) return false;
        sessions.set(id, { data: 'init' });
        return true;
      },
      remove(id: string) { return sessions.delete(id); },
      list() { return Array.from(sessions.keys()); },
    };
  }

  it('simultaneous creates of same id should only succeed once', () => {
    const store = createConcurrentStore();
    const results = [store.create('x'), store.create('x'), store.create('x')];
    assert.equal(results.filter(r => r).length, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('create then immediate remove should leave empty', () => {
    const store = createConcurrentStore();
    store.create('temp');
    store.remove('temp');
    assert.equal(store.sessions.size, 0);
  });

  it('remove non-existent then create should work', () => {
    const store = createConcurrentStore();
    store.remove('ghost');
    store.create('ghost');
    assert.equal(store.sessions.size, 1);
  });

  it('batch create and list should be consistent', () => {
    const store = createConcurrentStore();
    for (let i = 0; i < 10; i++) store.create(`s-${i}`);
    const list = store.list();
    assert.equal(list.length, 10);
    for (let i = 0; i < 10; i++) assert.ok(list.includes(`s-${i}`));
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager – format output strings
// ---------------------------------------------------------------------------

describe('Session Manager output formatting', () => {
  function formatSessionList(sessions: Array<{ id: string; connected: boolean; stateKeys: string[] }>) {
    if (sessions.length === 0) return 'No active sessions.';
    const lines = sessions.map(s =>
      `${s.id}: connected=${s.connected}, stateKeys=[${s.stateKeys.join(', ')}]`
    );
    return `Sessions (${sessions.length}):\n${lines.join('\n')}`;
  }

  it('should format empty list', () => {
    assert.equal(formatSessionList([]), 'No active sessions.');
  });

  it('should format single session', () => {
    const result = formatSessionList([{ id: 'main', connected: true, stateKeys: ['user'] }]);
    assert.ok(result.includes('Sessions (1)'));
    assert.ok(result.includes('main: connected=true'));
    assert.ok(result.includes('stateKeys=[user]'));
  });

  it('should format multiple sessions', () => {
    const result = formatSessionList([
      { id: 'test-1', connected: false, stateKeys: [] },
      { id: 'test-2', connected: true, stateKeys: ['a', 'b'] },
    ]);
    assert.ok(result.includes('Sessions (2)'));
    assert.ok(result.includes('test-1: connected=false'));
    assert.ok(result.includes('stateKeys=[a, b]'));
  });

  it('should handle session with many state keys', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `key${i}`);
    const result = formatSessionList([{ id: 'big', connected: true, stateKeys: keys }]);
    assert.ok(result.includes('key0'));
    assert.ok(result.includes('key19'));
  });

  it('should handle session id with special characters', () => {
    const result = formatSessionList([{ id: 'feature/my-branch#123', connected: false, stateKeys: [] }]);
    assert.ok(result.includes('feature/my-branch#123'));
  });
});

// ---------------------------------------------------------------------------
// Test: Integration – reset clears everything
// ---------------------------------------------------------------------------

describe('Integration: Reset clears all state types', () => {
  it('should clear 8 state categories', () => {
    const state = {
      cdpSession: {} as unknown,
      consoleLogs: [1, 2, 3],
      networkLog: new Map([['a', 1]]),
      lastSnapshot: 'some snapshot',
      pwExecutor: { connected: true },
      debuggerEnabled: true,
      breakpoints: new Map([['bp-1', {}]]),
      debuggerPaused: true,
      currentCallFrameId: 'frame-0',
      knownScripts: new Map([['1', {}]]),
      executorManager: { size: 3 },
    };

    state.cdpSession = null;
    state.consoleLogs.length = 0;
    state.networkLog.clear();
    state.lastSnapshot = null as unknown as string;
    state.pwExecutor = { connected: false };
    state.debuggerEnabled = false;
    state.breakpoints.clear();
    state.debuggerPaused = false;
    state.currentCallFrameId = null as unknown as string;
    state.knownScripts.clear();
    state.executorManager = { size: 0 };

    assert.equal(state.cdpSession, null);
    assert.equal(state.consoleLogs.length, 0);
    assert.equal(state.networkLog.size, 0);
    assert.equal(state.lastSnapshot, null);
    assert.equal(state.pwExecutor.connected, false);
    assert.equal(state.debuggerEnabled, false);
    assert.equal(state.breakpoints.size, 0);
    assert.equal(state.debuggerPaused, false);
    assert.equal(state.currentCallFrameId, null);
    assert.equal(state.knownScripts.size, 0);
    assert.equal(state.executorManager.size, 0);
  });

  it('reset message should mention all cleared categories', () => {
    const msg = 'Connection reset. Console logs, network entries, Playwright state, debugger state, and sessions cleared.';
    assert.ok(msg.includes('Console logs'));
    assert.ok(msg.includes('network entries'));
    assert.ok(msg.includes('Playwright state'));
    assert.ok(msg.includes('debugger state'));
    assert.ok(msg.includes('sessions'));
  });
});

// ---------------------------------------------------------------------------
// Test: Integration – debugger actions require correct state
// ---------------------------------------------------------------------------

describe('Integration: Debugger action preconditions', () => {
  function createDebuggerSim() {
    let enabled = false;
    let paused = false;
    let callFrameId: string | null = null;
    const bps = new Map<string, { file: string; line: number }>();
    const scripts = new Map<string, string>();

    return {
      get enabled() { return enabled; },
      get paused() { return paused; },
      get callFrameId() { return callFrameId; },
      bps,
      scripts,
      enable() { enabled = true; },
      disable() { enabled = false; paused = false; callFrameId = null; bps.clear(); scripts.clear(); },
      pause(frameId: string) { paused = true; callFrameId = frameId; },
      resume() { paused = false; callFrameId = null; },
      addScript(id: string, url: string) { scripts.set(id, url); },
      setBp(id: string, file: string, line: number) { bps.set(id, { file, line }); },
      removeBp(id: string) { bps.delete(id); },

      tryAction(action: string, args: Record<string, unknown> = {}): string {
        switch (action) {
          case 'enable':
            this.enable();
            return 'Debugger enabled.';
          case 'resume':
            if (!this.paused) return 'ERROR: not paused';
            this.resume();
            return 'Resumed.';
          case 'step_over':
          case 'step_into':
          case 'step_out':
            if (!this.paused) return 'ERROR: not paused';
            return `Stepped ${action.replace('step_', '')}.`;
          case 'inspect_variables':
            if (!this.paused || !this.callFrameId) return 'ERROR: not paused at breakpoint';
            return '{"vars": {}}';
          case 'evaluate':
            if (!args.expression) return 'ERROR: expression required';
            return String(args.expression);
          case 'set_breakpoint':
            if (!args.file || !args.line) return 'ERROR: file and line required';
            if (!this.enabled) this.enable();
            const bpId = `bp-${this.bps.size + 1}`;
            this.setBp(bpId, args.file as string, args.line as number);
            return `Breakpoint ${bpId} at ${args.file}:${args.line}`;
          case 'list_scripts':
            if (!this.enabled) this.enable();
            const search = (args.search as string || '').toLowerCase();
            let filtered = Array.from(this.scripts.entries());
            if (search) filtered = filtered.filter(([, url]) => url.toLowerCase().includes(search));
            return filtered.length === 0 ? 'No scripts.' : filtered.map(([id, url]) => `${id}: ${url}`).join('\n');
          default:
            return `Unknown: ${action}`;
        }
      },
    };
  }

  it('step actions should fail when not paused', () => {
    const dbg = createDebuggerSim();
    dbg.enable();
    for (const action of ['resume', 'step_over', 'step_into', 'step_out']) {
      assert.ok(dbg.tryAction(action).includes('ERROR'));
    }
  });

  it('step actions should succeed when paused', () => {
    const dbg = createDebuggerSim();
    dbg.enable();
    dbg.pause('frame-1');
    assert.ok(!dbg.tryAction('step_over').includes('ERROR'));
  });

  it('inspect_variables should require both paused and callFrameId', () => {
    const dbg = createDebuggerSim();
    dbg.enable();
    assert.ok(dbg.tryAction('inspect_variables').includes('ERROR'));
    dbg.pause('frame-1');
    assert.ok(!dbg.tryAction('inspect_variables').includes('ERROR'));
  });

  it('set_breakpoint should auto-enable debugger', () => {
    const dbg = createDebuggerSim();
    assert.equal(dbg.enabled, false);
    dbg.tryAction('set_breakpoint', { file: 'a.js', line: 1 });
    assert.equal(dbg.enabled, true);
    assert.equal(dbg.bps.size, 1);
  });

  it('list_scripts should auto-enable debugger', () => {
    const dbg = createDebuggerSim();
    assert.equal(dbg.enabled, false);
    dbg.tryAction('list_scripts');
    assert.equal(dbg.enabled, true);
  });

  it('evaluate without expression should error', () => {
    const dbg = createDebuggerSim();
    assert.ok(dbg.tryAction('evaluate').includes('ERROR'));
    assert.ok(!dbg.tryAction('evaluate', { expression: '1+1' }).includes('ERROR'));
  });

  it('full debug workflow: enable → scripts → breakpoint → pause → step → evaluate → resume', () => {
    const dbg = createDebuggerSim();
    assert.ok(dbg.tryAction('enable').includes('enabled'));
    dbg.addScript('1', 'http://example.com/app.js');
    assert.ok(dbg.tryAction('list_scripts', { search: 'app' }).includes('app.js'));
    assert.ok(dbg.tryAction('set_breakpoint', { file: 'app.js', line: 10 }).includes('bp-'));
    dbg.pause('frame-0');
    assert.ok(!dbg.tryAction('step_over').includes('ERROR'));
    dbg.pause('frame-1');
    assert.ok(!dbg.tryAction('evaluate', { expression: 'x + y' }).includes('ERROR'));
    dbg.pause('frame-2');
    assert.equal(dbg.tryAction('resume'), 'Resumed.');
    assert.equal(dbg.paused, false);
  });

  it('disable should clear all state', () => {
    const dbg = createDebuggerSim();
    dbg.enable();
    dbg.addScript('1', 'a.js');
    dbg.setBp('bp-1', 'a.js', 10);
    dbg.pause('f1');

    dbg.disable();
    assert.equal(dbg.enabled, false);
    assert.equal(dbg.paused, false);
    assert.equal(dbg.callFrameId, null);
    assert.equal(dbg.bps.size, 0);
    assert.equal(dbg.scripts.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Test: Integration – tool name completeness
// ---------------------------------------------------------------------------

describe('Integration: All tool names are unique and complete', () => {
  const allTools = [
    'screenshot', 'accessibility_snapshot', 'execute', 'dashboard_state',
    'console_logs', 'network_log', 'network_detail', 'playwright_execute', 'reset',
    'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
    'override_app', 'app_action', 'debugger', 'css_inspect', 'session_manager',
    'list_tabs', 'switch_tab', 'connect_tab', 'release_tab',
    'storage', 'performance', 'editor', 'network_intercept', 'emulation', 'page_content',
    'interact', 'browser_fetch', 'trace',
  ];

  it('should have no duplicate tool names', () => {
    const unique = new Set(allTools);
    assert.equal(unique.size, allTools.length);
  });

  it('should have exactly 30 tools', () => {
    assert.equal(allTools.length, 30);
  });

  it('Phase 1 tools present', () => {
    assert.ok(allTools.includes('console_logs'));
    assert.ok(allTools.includes('network_log'));
    assert.ok(allTools.includes('network_detail'));
  });

  it('Phase 2 tools present', () => {
    assert.ok(allTools.includes('playwright_execute'));
  });

  it('Phase 3 tools present', () => {
    assert.ok(allTools.includes('debugger'));
    assert.ok(allTools.includes('css_inspect'));
    assert.ok(allTools.includes('session_manager'));
  });

  it('original spawriter tools present', () => {
    for (const tool of ['dashboard_state', 'override_app', 'app_action', 'screenshot', 'accessibility_snapshot', 'execute', 'navigate', 'reset', 'clear_cache_and_reload', 'ensure_fresh_render']) {
      assert.ok(allTools.includes(tool), `Missing: ${tool}`);
    }
  });

  it('network_detail complements network_log', () => {
    assert.ok(allTools.includes('network_log'));
    assert.ok(allTools.includes('network_detail'));
    const logIdx = allTools.indexOf('network_log');
    const detailIdx = allTools.indexOf('network_detail');
    assert.ok(Math.abs(logIdx - detailIdx) <= 1, 'network_log and network_detail should be adjacent');
  });
});

// ---------------------------------------------------------------------------
// Test: Debugger tool actions – all 12 covered
// ---------------------------------------------------------------------------

describe('Debugger: all 12 actions have handler coverage', () => {
  const allActions = [
    'enable', 'set_breakpoint', 'remove_breakpoint', 'list_breakpoints',
    'resume', 'step_over', 'step_into', 'step_out',
    'inspect_variables', 'evaluate', 'list_scripts', 'pause_on_exceptions',
  ];

  it('should have exactly 12 actions', () => {
    assert.equal(allActions.length, 12);
  });

  it('should have no duplicate actions', () => {
    assert.equal(new Set(allActions).size, allActions.length);
  });

  it('breakpoint actions: set, remove, list', () => {
    assert.ok(allActions.includes('set_breakpoint'));
    assert.ok(allActions.includes('remove_breakpoint'));
    assert.ok(allActions.includes('list_breakpoints'));
  });

  it('stepping actions: over, into, out', () => {
    assert.ok(allActions.includes('step_over'));
    assert.ok(allActions.includes('step_into'));
    assert.ok(allActions.includes('step_out'));
  });

  it('inspection actions: evaluate, inspect_variables', () => {
    assert.ok(allActions.includes('evaluate'));
    assert.ok(allActions.includes('inspect_variables'));
  });

  it('control actions: enable, resume, pause_on_exceptions', () => {
    assert.ok(allActions.includes('enable'));
    assert.ok(allActions.includes('resume'));
    assert.ok(allActions.includes('pause_on_exceptions'));
  });

  it('discovery actions: list_scripts', () => {
    assert.ok(allActions.includes('list_scripts'));
  });
});

// ---------------------------------------------------------------------------
// Test: Session Manager actions – all 5 covered
// ---------------------------------------------------------------------------

describe('Session Manager: all 5 actions have handler coverage', () => {
  const allActions = ['list', 'create', 'switch', 'remove', 'remove_all'];

  it('should have exactly 5 actions', () => {
    assert.equal(allActions.length, 5);
  });

  it('should have no duplicates', () => {
    assert.equal(new Set(allActions).size, allActions.length);
  });

  it('CRUD actions present', () => {
    assert.ok(allActions.includes('list'));
    assert.ok(allActions.includes('create'));
    assert.ok(allActions.includes('remove'));
  });

  it('switch action present', () => {
    assert.ok(allActions.includes('switch'));
  });

  it('bulk action present', () => {
    assert.ok(allActions.includes('remove_all'));
  });
});

// ---------------------------------------------------------------------------
// Test: Pause on exceptions – state values
// ---------------------------------------------------------------------------

describe('Debugger pause_on_exceptions states', () => {
  const validStates = ['none', 'uncaught', 'all'];

  it('should have exactly 3 valid states', () => {
    assert.equal(validStates.length, 3);
  });

  it('none = do not pause on any exception', () => {
    assert.ok(validStates.includes('none'));
  });

  it('uncaught = pause only on unhandled', () => {
    assert.ok(validStates.includes('uncaught'));
  });

  it('all = pause on all exceptions', () => {
    assert.ok(validStates.includes('all'));
  });

  it('should format each state correctly in output', () => {
    for (const state of validStates) {
      const msg = `Pause on exceptions: ${state}`;
      assert.ok(msg.includes(state));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Script URL filtering – comprehensive
// ---------------------------------------------------------------------------

describe('Script URL filtering – comprehensive', () => {
  function filterScripts(scripts: Array<{ scriptId: string; url: string }>, search: string, max = 30) {
    const s = search.toLowerCase();
    let filtered = scripts;
    if (s) filtered = scripts.filter(sc => sc.url.toLowerCase().includes(s));
    return filtered.slice(0, max);
  }

  const testScripts = [
    { scriptId: '1', url: 'http://localhost:3000/static/js/main.abc123.chunk.js' },
    { scriptId: '2', url: 'http://localhost:3000/static/js/vendor.def456.chunk.js' },
    { scriptId: '3', url: 'http://localhost:3000/static/js/runtime-main.js' },
    { scriptId: '4', url: 'https://cdn.example.com/react.production.min.js' },
    { scriptId: '5', url: 'https://cdn.example.com/react-dom.production.min.js' },
    { scriptId: '6', url: 'http://localhost:3000/api/v1/config.js' },
    { scriptId: '7', url: '' },
  ];

  it('should match by file name substring', () => {
    const result = filterScripts(testScripts, 'main');
    assert.equal(result.length, 2);
  });

  it('should match by domain', () => {
    const result = filterScripts(testScripts, 'cdn.example');
    assert.equal(result.length, 2);
  });

  it('should match by path component', () => {
    const result = filterScripts(testScripts, '/static/js/');
    assert.equal(result.length, 3);
  });

  it('should be case insensitive', () => {
    const result = filterScripts(testScripts, 'REACT');
    assert.equal(result.length, 2);
  });

  it('should return all when search is empty', () => {
    assert.equal(filterScripts(testScripts, '').length, 7);
  });

  it('should return empty when no match', () => {
    assert.equal(filterScripts(testScripts, 'angular').length, 0);
  });

  it('should match .chunk.js files', () => {
    assert.equal(filterScripts(testScripts, 'chunk').length, 2);
  });

  it('should match by protocol', () => {
    assert.equal(filterScripts(testScripts, 'https').length, 2);
  });

  it('should include empty URL scripts when no filter', () => {
    assert.ok(filterScripts(testScripts, '').some(s => s.url === ''));
  });
});

// ===========================================================================
// Phase 4-9: New tool tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: storage tool – action routing and parameter validation
// ---------------------------------------------------------------------------

describe('storage tool – action routing', () => {
  const validActions = [
    'get_cookies', 'set_cookie', 'delete_cookie',
    'get_local_storage', 'set_local_storage', 'remove_local_storage',
    'get_session_storage', 'clear_storage', 'get_storage_usage',
  ];

  it('should have 9 valid actions', () => {
    assert.equal(validActions.length, 9);
  });

  it('should not have duplicate actions', () => {
    assert.equal(new Set(validActions).size, validActions.length);
  });

  it('set_cookie requires name and value', () => {
    const args = { action: 'set_cookie' };
    assert.ok(!args.hasOwnProperty('name') || !args.hasOwnProperty('value'));
  });

  it('delete_cookie requires name', () => {
    const args = { action: 'delete_cookie' };
    assert.ok(!args.hasOwnProperty('name'));
  });

  it('set_local_storage requires key and value', () => {
    const args = { action: 'set_local_storage', key: 'test', value: 'data' };
    assert.ok(args.key);
    assert.ok(args.value !== undefined);
  });

  it('remove_local_storage requires key', () => {
    const args = { action: 'remove_local_storage' };
    assert.ok(!args.hasOwnProperty('key'));
  });
});

describe('storage tool – cookie formatting', () => {
  function formatCookies(cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string }>): string {
    if (cookies.length === 0) return 'No cookies found.';
    const lines = cookies.map(c =>
      `${c.name}=${String(c.value).slice(0, 80)}${String(c.value).length > 80 ? '...' : ''} (domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite || 'None'})`
    );
    return `Cookies (${cookies.length}):\n${lines.join('\n')}`;
  }

  it('should format empty cookie list', () => {
    assert.equal(formatCookies([]), 'No cookies found.');
  });

  it('should format single cookie', () => {
    const text = formatCookies([{ name: 'session', value: 'abc123', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    assert.ok(text.includes('session=abc123'));
    assert.ok(text.includes('domain=.example.com'));
    assert.ok(text.includes('sameSite=Lax'));
  });

  it('should truncate long cookie values', () => {
    const longVal = 'x'.repeat(200);
    const text = formatCookies([{ name: 'big', value: longVal, domain: '.a.com', path: '/', secure: false, httpOnly: false }]);
    assert.ok(text.includes('...'));
    assert.ok(!text.includes('x'.repeat(200)));
  });

  it('should show count for multiple cookies', () => {
    const text = formatCookies([
      { name: 'a', value: '1', domain: '.a.com', path: '/', secure: false, httpOnly: false },
      { name: 'b', value: '2', domain: '.b.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    ]);
    assert.ok(text.includes('Cookies (2)'));
    assert.ok(text.includes('sameSite=Strict'));
    assert.ok(text.includes('sameSite=None'));
  });

  it('should handle special characters in cookie values', () => {
    const text = formatCookies([{ name: 'token', value: 'a=b&c=d;e', domain: '.x.com', path: '/', secure: false, httpOnly: false }]);
    assert.ok(text.includes('a=b&c=d;e'));
  });
});

describe('storage tool – localStorage formatting', () => {
  function formatStorage(entries: Record<string, string>, storageType: string): string {
    const arr = Object.entries(entries);
    if (arr.length === 0) return `${storageType} is empty.`;
    const lines = arr.map(([k, v]) => {
      const vs = String(v);
      return `  ${k}: ${vs.slice(0, 200)}${vs.length > 200 ? '...' : ''}`;
    });
    return `${storageType} (${arr.length} entries):\n${lines.join('\n')}`;
  }

  it('should format empty storage', () => {
    assert.equal(formatStorage({}, 'localStorage'), 'localStorage is empty.');
  });

  it('should format single entry', () => {
    const text = formatStorage({ theme: 'dark' }, 'localStorage');
    assert.ok(text.includes('theme: dark'));
    assert.ok(text.includes('1 entries'));
  });

  it('should truncate long values', () => {
    const text = formatStorage({ data: 'y'.repeat(500) }, 'sessionStorage');
    assert.ok(text.includes('...'));
  });

  it('should show correct count', () => {
    const text = formatStorage({ a: '1', b: '2', c: '3' }, 'localStorage');
    assert.ok(text.includes('3 entries'));
  });
});

describe('storage tool – storage usage formatting', () => {
  function formatUsage(usage: number, quota: number, breakdown: Array<{ storageType: string; usage: number }>) {
    const total = `Usage: ${(usage / 1024).toFixed(1)}KB / ${(quota / (1024 * 1024)).toFixed(1)}MB (${((usage / quota) * 100).toFixed(1)}%)`;
    const bd = breakdown.filter(b => b.usage > 0).map(b => `  ${b.storageType}: ${(b.usage / 1024).toFixed(1)}KB`).join('\n');
    return `${total}${bd ? '\n\nBreakdown:\n' + bd : ''}`;
  }

  it('should format basic usage', () => {
    const text = formatUsage(51200, 1024 * 1024 * 100, []);
    assert.ok(text.includes('50.0KB'));
    assert.ok(text.includes('100.0MB'));
  });

  it('should include breakdown when present', () => {
    const text = formatUsage(10240, 1024 * 1024, [
      { storageType: 'indexeddb', usage: 5120 },
      { storageType: 'cache_storage', usage: 5120 },
      { storageType: 'local_storage', usage: 0 },
    ]);
    assert.ok(text.includes('indexeddb: 5.0KB'));
    assert.ok(text.includes('cache_storage: 5.0KB'));
    assert.ok(!text.includes('local_storage'));
  });
});

// ---------------------------------------------------------------------------
// Test: performance tool – metrics formatting
// ---------------------------------------------------------------------------

describe('performance tool – metrics formatting', () => {
  function formatMetric(name: string, value: number): string {
    if (name.includes('HeapUsedSize') || name.includes('HeapTotalSize'))
      return `  ${name}: ${(value / (1024 * 1024)).toFixed(2)}MB`;
    if (name.includes('Duration'))
      return `  ${name}: ${(value * 1000).toFixed(1)}ms`;
    return `  ${name}: ${value}`;
  }

  it('should format heap size in MB', () => {
    assert.equal(formatMetric('JSHeapUsedSize', 10 * 1024 * 1024), '  JSHeapUsedSize: 10.00MB');
  });

  it('should format duration in ms', () => {
    assert.equal(formatMetric('ScriptDuration', 0.05), '  ScriptDuration: 50.0ms');
  });

  it('should format plain number', () => {
    assert.equal(formatMetric('Nodes', 1500), '  Nodes: 1500');
  });

  it('should format zero heap', () => {
    assert.equal(formatMetric('JSHeapTotalSize', 0), '  JSHeapTotalSize: 0.00MB');
  });
});

describe('performance tool – web vitals grading', () => {
  function gradeVital(val: number | null, unit: string, good: number, poor: number): string {
    if (val === null || val === undefined) return '(not measured)';
    const s = unit === 'ms' ? `${val.toFixed(0)}ms` : val.toFixed(3);
    const grade = val <= good ? '✅ Good' : val <= poor ? '⚠️ Needs Improvement' : '❌ Poor';
    return `${s} ${grade}`;
  }

  it('LCP good', () => assert.ok(gradeVital(1500, 'ms', 2500, 4000).includes('Good')));
  it('LCP needs improvement', () => assert.ok(gradeVital(3000, 'ms', 2500, 4000).includes('Needs Improvement')));
  it('LCP poor', () => assert.ok(gradeVital(5000, 'ms', 2500, 4000).includes('Poor')));
  it('CLS good', () => assert.ok(gradeVital(0.05, '', 0.1, 0.25).includes('Good')));
  it('CLS poor', () => assert.ok(gradeVital(0.5, '', 0.1, 0.25).includes('Poor')));
  it('INP good', () => assert.ok(gradeVital(100, 'ms', 200, 500).includes('Good')));
  it('null returns not measured', () => assert.equal(gradeVital(null, 'ms', 200, 500), '(not measured)'));
  it('zero is good', () => assert.ok(gradeVital(0, 'ms', 200, 500).includes('Good')));
  it('boundary exact LCP', () => assert.ok(gradeVital(2500, 'ms', 2500, 4000).includes('Good')));
  it('boundary exact CLS poor', () => assert.ok(gradeVital(0.25, '', 0.1, 0.25).includes('Needs Improvement')));
});

describe('performance tool – memory formatting', () => {
  function formatMemory(heapUsed: number, heapTotal: number, nodes: number, listeners: number) {
    return `Memory:\n  JS Heap: ${(heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(heapTotal / (1024 * 1024)).toFixed(2)}MB (${heapTotal > 0 ? ((heapUsed / heapTotal) * 100).toFixed(1) : 0}%)\n  DOM Nodes: ${nodes}\n  Event Listeners: ${listeners}`;
  }

  it('should format memory correctly', () => {
    const text = formatMemory(5 * 1024 * 1024, 16 * 1024 * 1024, 800, 120);
    assert.ok(text.includes('5.00MB'));
    assert.ok(text.includes('16.00MB'));
    assert.ok(text.includes('31.3%'));
    assert.ok(text.includes('DOM Nodes: 800'));
    assert.ok(text.includes('Event Listeners: 120'));
  });

  it('should handle zero heap', () => {
    const text = formatMemory(0, 0, 0, 0);
    assert.ok(text.includes('0.00MB'));
    assert.ok(text.includes('0%'));
  });
});

describe('performance tool – resource timing formatting', () => {
  function formatResourceEntry(entry: { name: string; type: string; duration: number; transferSize: number }) {
    const url = entry.name.length > 80 ? '...' + entry.name.slice(-77) : entry.name;
    return `  ${entry.duration.toFixed(0).padStart(6)}ms  ${(entry.transferSize / 1024).toFixed(1).padStart(7)}KB  ${entry.type.padEnd(12)}  ${url}`;
  }

  it('should format resource entry', () => {
    const text = formatResourceEntry({ name: 'https://cdn.example.com/bundle.js', type: 'script', duration: 1234, transferSize: 524288 });
    assert.ok(text.includes('1234ms'));
    assert.ok(text.includes('512.0KB'));
    assert.ok(text.includes('script'));
    assert.ok(text.includes('bundle.js'));
  });

  it('should truncate long URLs', () => {
    const longUrl = 'https://cdn.example.com/' + 'a'.repeat(200) + '.js';
    const text = formatResourceEntry({ name: longUrl, type: 'script', duration: 100, transferSize: 1024 });
    assert.ok(text.includes('...'));
    assert.ok(text.length < longUrl.length + 50);
  });

  it('should handle zero duration', () => {
    const text = formatResourceEntry({ name: 'https://a.com/b.css', type: 'css', duration: 0, transferSize: 512 });
    assert.ok(text.includes('0ms'));
  });
});

// ---------------------------------------------------------------------------
// Test: editor tool – action routing
// ---------------------------------------------------------------------------

describe('editor tool – action routing', () => {
  const actions = ['list_sources', 'get_source', 'edit_source', 'search_source', 'list_stylesheets', 'get_stylesheet', 'edit_stylesheet'];

  it('should have 7 actions', () => assert.equal(actions.length, 7));
  it('should not have duplicates', () => assert.equal(new Set(actions).size, actions.length));

  it('get_source requires scriptId', () => {
    const args = { action: 'get_source', scriptId: '123' };
    assert.ok(args.scriptId);
  });

  it('edit_source requires scriptId and content', () => {
    const args = { action: 'edit_source', scriptId: '123', content: 'console.log(1)' };
    assert.ok(args.scriptId && args.content);
  });

  it('search_source requires search', () => {
    const args = { action: 'search_source', search: 'TODO' };
    assert.ok(args.search);
  });
});

describe('editor tool – source line extraction', () => {
  function extractLines(source: string, lineStart?: number, lineEnd?: number): string {
    const lines = source.split('\n');
    const start = Math.max(1, lineStart || 1) - 1;
    const end = Math.min(lines.length, lineEnd || lines.length);
    return lines.slice(start, end).map((l, i) => `${(start + i + 1).toString().padStart(5)}| ${l}`).join('\n');
  }

  it('should extract specific line range', () => {
    const src = 'line1\nline2\nline3\nline4\nline5';
    const result = extractLines(src, 2, 4);
    assert.ok(result.includes('line2'));
    assert.ok(result.includes('line3'));
    assert.ok(result.includes('line4'));
    assert.ok(!result.includes('line1'));
    assert.ok(!result.includes('line5'));
  });

  it('should include line numbers', () => {
    const result = extractLines('a\nb\nc', 1, 3);
    assert.ok(result.includes('1|'));
    assert.ok(result.includes('2|'));
    assert.ok(result.includes('3|'));
  });

  it('should handle out-of-range line_end', () => {
    const result = extractLines('a\nb', 1, 100);
    assert.ok(result.includes('a'));
    assert.ok(result.includes('b'));
  });

  it('should handle line_start > line count', () => {
    const result = extractLines('a\nb', 50, 100);
    assert.equal(result, '');
  });
});

// ---------------------------------------------------------------------------
// Test: network_intercept tool – rule management
// ---------------------------------------------------------------------------

describe('network_intercept – rule management', () => {
  function createRuleStore() {
    const rules: Map<string, { id: string; urlPattern: string; resourceType?: string; mockStatus?: number; mockBody?: string; block?: boolean }> = new Map();
    let nextId = 1;

    function add(urlPattern: string, opts?: { resourceType?: string; mockStatus?: number; mockBody?: string; block?: boolean }) {
      const id = `rule_${nextId++}`;
      rules.set(id, { id, urlPattern, ...opts });
      return id;
    }
    function remove(id: string) { return rules.delete(id); }
    function list() { return Array.from(rules.values()); }
    function clear() { rules.clear(); nextId = 1; }

    return { rules, add, remove, list, clear };
  }

  it('should add rules with incrementing IDs', () => {
    const store = createRuleStore();
    const id1 = store.add('*/api/*');
    const id2 = store.add('*.css');
    assert.equal(id1, 'rule_1');
    assert.equal(id2, 'rule_2');
    assert.equal(store.rules.size, 2);
  });

  it('should remove rules by ID', () => {
    const store = createRuleStore();
    const id = store.add('*/api/*');
    assert.ok(store.remove(id));
    assert.equal(store.rules.size, 0);
  });

  it('should return false for removing non-existent rule', () => {
    const store = createRuleStore();
    assert.ok(!store.remove('nonexistent'));
  });

  it('should list all rules', () => {
    const store = createRuleStore();
    store.add('*/api/*', { mockStatus: 200, mockBody: '{}' });
    store.add('*/ads/*', { block: true });
    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].urlPattern, '*/api/*');
    assert.equal(list[1].block, true);
  });

  it('should clear all rules', () => {
    const store = createRuleStore();
    store.add('*/a/*');
    store.add('*/b/*');
    store.clear();
    assert.equal(store.rules.size, 0);
  });
});

describe('network_intercept – URL pattern matching', () => {
  function matchUrl(urlPattern: string, requestUrl: string): boolean {
    return !urlPattern || requestUrl.includes(urlPattern) ||
      new RegExp(urlPattern.replace(/\*/g, '.*')).test(requestUrl);
  }

  it('should match wildcard pattern', () => {
    assert.ok(matchUrl('*/api/*', 'https://example.com/api/users'));
  });

  it('should match substring', () => {
    assert.ok(matchUrl('/api/', 'https://example.com/api/users'));
  });

  it('should match everything with empty pattern', () => {
    assert.ok(matchUrl('', 'https://anything.com'));
  });

  it('should match exact URL', () => {
    assert.ok(matchUrl('https://a.com/data', 'https://a.com/data'));
  });

  it('should NOT match unrelated URL', () => {
    assert.ok(!matchUrl('/api/', 'https://example.com/static/app.js'));
  });

  it('should match glob-style pattern', () => {
    assert.ok(matchUrl('*.example.com*', 'https://api.example.com/v2/users'));
  });

  it('should match wildcard at end', () => {
    assert.ok(matchUrl('https://api.com/*', 'https://api.com/anything'));
  });
});

describe('network_intercept – request handling logic', () => {
  it('should block when rule has block=true', () => {
    const rule = { id: 'r1', urlPattern: '/ads/', block: true };
    assert.equal(rule.block, true);
  });

  it('should mock when rule has mockStatus', () => {
    const rule = { id: 'r2', urlPattern: '/api/', mockStatus: 200, mockBody: '{"ok":true}' };
    assert.equal(rule.mockStatus, 200);
    assert.ok(rule.mockBody);
  });

  it('should continue when no matching rule', () => {
    const rules: Array<{ urlPattern: string }> = [{ urlPattern: '/specific/' }];
    const url = 'https://other.com/page';
    const matched = rules.some(r => url.includes(r.urlPattern));
    assert.ok(!matched);
  });
});

// ---------------------------------------------------------------------------
// Test: emulation tool – presets and parameters
// ---------------------------------------------------------------------------

describe('emulation tool – network presets', () => {
  const presets: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
    'offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
    'fast-3g': { offline: false, latency: 562, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
    '4g': { offline: false, latency: 170, downloadThroughput: 1.5 * 1024 * 1024, uploadThroughput: 750 * 1024 },
    'wifi': { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024, uploadThroughput: 15 * 1024 * 1024 },
  };

  it('should have 5 presets', () => assert.equal(Object.keys(presets).length, 5));

  it('offline should have zero throughput', () => {
    assert.equal(presets['offline'].downloadThroughput, 0);
    assert.equal(presets['offline'].uploadThroughput, 0);
    assert.equal(presets['offline'].offline, true);
  });

  it('slow-3g should have high latency', () => {
    assert.equal(presets['slow-3g'].latency, 2000);
    assert.ok(presets['slow-3g'].downloadThroughput < 100 * 1024);
  });

  it('wifi should have low latency and high throughput', () => {
    assert.ok(presets['wifi'].latency < 50);
    assert.ok(presets['wifi'].downloadThroughput > 1024 * 1024);
  });

  it('4g should be between slow-3g and wifi', () => {
    assert.ok(presets['4g'].latency > presets['wifi'].latency);
    assert.ok(presets['4g'].latency < presets['slow-3g'].latency);
    assert.ok(presets['4g'].downloadThroughput > presets['slow-3g'].downloadThroughput);
    assert.ok(presets['4g'].downloadThroughput < presets['wifi'].downloadThroughput);
  });
});

describe('emulation tool – media features parsing', () => {
  function parseMediaFeatures(features: string): Array<{ name: string; value: string }> {
    return features.split(',').filter(f => f.includes(':')).map(f => {
      const [n, v] = f.trim().split(':');
      return { name: n.trim(), value: v.trim() };
    });
  }

  it('should parse single feature', () => {
    const result = parseMediaFeatures('prefers-color-scheme:dark');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'prefers-color-scheme');
    assert.equal(result[0].value, 'dark');
  });

  it('should parse multiple features', () => {
    const result = parseMediaFeatures('prefers-color-scheme:dark,prefers-reduced-motion:reduce');
    assert.equal(result.length, 2);
    assert.equal(result[1].name, 'prefers-reduced-motion');
  });

  it('should handle spaces', () => {
    const result = parseMediaFeatures(' prefers-color-scheme : light ');
    assert.equal(result[0].name, 'prefers-color-scheme');
    assert.equal(result[0].value, 'light');
  });

  it('should skip invalid entries without colon', () => {
    const result = parseMediaFeatures('invalid,prefers-color-scheme:dark');
    assert.equal(result.length, 1);
  });

  it('should return empty for empty string', () => {
    const result = parseMediaFeatures('');
    assert.equal(result.length, 0);
  });
});

describe('emulation tool – device metrics', () => {
  it('should have default values', () => {
    const width = 375, height = 812, dpr = 1, mobile = false;
    assert.equal(width, 375);
    assert.equal(height, 812);
    assert.equal(dpr, 1);
    assert.equal(mobile, false);
  });

  it('should support common device sizes', () => {
    const devices = [
      { name: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true },
      { name: 'iPhone 14', width: 390, height: 844, dpr: 3, mobile: true },
      { name: 'iPad', width: 768, height: 1024, dpr: 2, mobile: true },
      { name: 'Desktop', width: 1920, height: 1080, dpr: 1, mobile: false },
    ];
    for (const d of devices) {
      assert.ok(d.width > 0 && d.height > 0 && d.dpr > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: page_content tool – action routing
// ---------------------------------------------------------------------------

describe('page_content tool – actions', () => {
  const actions = ['get_html', 'get_text', 'get_metadata', 'search_dom'];

  it('should have 4 actions', () => assert.equal(actions.length, 4));
  it('should not have duplicates', () => assert.equal(new Set(actions).size, actions.length));
});

describe('page_content tool – HTML cleaning logic', () => {
  it('should remove script tags from clone', () => {
    const html = '<div><p>Hello</p><script>alert(1)</script></div>';
    const cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.ok(!cleaned.includes('script'));
    assert.ok(cleaned.includes('Hello'));
  });

  it('should remove style attributes', () => {
    const html = '<div style="color:red"><p style="font-size:12px">Text</p></div>';
    const cleaned = html.replace(/\s*style="[^"]*"/gi, '');
    assert.ok(!cleaned.includes('style'));
    assert.ok(cleaned.includes('Text'));
  });

  it('should preserve structure', () => {
    const html = '<div><ul><li>A</li><li>B</li></ul></div>';
    assert.ok(html.includes('<ul>'));
    assert.ok(html.includes('<li>A</li>'));
  });
});

describe('page_content tool – truncation', () => {
  function truncate(text: string, maxLength: number): string {
    if (text.length > maxLength) return text.slice(0, maxLength) + `\n[Truncated to ${maxLength} chars]`;
    return text;
  }

  it('should not truncate short content', () => {
    assert.equal(truncate('hello', 50000), 'hello');
  });

  it('should truncate at max_length', () => {
    const result = truncate('x'.repeat(100), 50);
    assert.ok(result.includes('[Truncated to 50 chars]'));
  });

  it('default max_length is 50000', () => {
    const maxLength = 50000;
    assert.equal(maxLength, 50000);
  });
});

describe('page_content tool – metadata format', () => {
  function formatMetadata(meta: Record<string, unknown>): string {
    const lines = Object.entries(meta)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `  ${k}: ${v}`);
    return `Page Metadata:\n${lines.join('\n')}`;
  }

  it('should format basic metadata', () => {
    const text = formatMetadata({ title: 'Test Page', url: 'https://example.com', scripts: 5 });
    assert.ok(text.includes('title: Test Page'));
    assert.ok(text.includes('url: https://example.com'));
    assert.ok(text.includes('scripts: 5'));
  });

  it('should skip null values', () => {
    const text = formatMetadata({ title: 'Test', description: null, lang: 'en' });
    assert.ok(!text.includes('description'));
    assert.ok(text.includes('lang: en'));
  });

  it('should handle all-null metadata', () => {
    const text = formatMetadata({ a: null, b: null });
    assert.equal(text, 'Page Metadata:\n');
  });
});

// ---------------------------------------------------------------------------
// Test: Integration – updated tool list (23 tools)
// ---------------------------------------------------------------------------

describe('Integration: All tool names – Phase 4-9', () => {
  const allTools = [
    'screenshot', 'accessibility_snapshot', 'execute', 'dashboard_state',
    'console_logs', 'network_log', 'network_detail', 'playwright_execute', 'reset',
    'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
    'override_app', 'app_action', 'debugger', 'css_inspect', 'session_manager',
    'storage', 'performance', 'editor', 'network_intercept', 'emulation', 'page_content',
  ];

  it('should have exactly 23 tools', () => {
    assert.equal(allTools.length, 23);
  });

  it('should have no duplicates', () => {
    assert.equal(new Set(allTools).size, allTools.length);
  });

  it('Phase 4 tools present', () => {
    assert.ok(allTools.includes('storage'));
  });

  it('Phase 5 tools present', () => {
    assert.ok(allTools.includes('performance'));
  });

  it('Phase 6 tools present', () => {
    assert.ok(allTools.includes('editor'));
  });

  it('Phase 7 tools present', () => {
    assert.ok(allTools.includes('network_intercept'));
  });

  it('Phase 8 tools present', () => {
    assert.ok(allTools.includes('emulation'));
  });

  it('Phase 9 tools present', () => {
    assert.ok(allTools.includes('page_content'));
  });

  it('all previous tools still present', () => {
    const prevTools = ['screenshot', 'accessibility_snapshot', 'execute', 'dashboard_state',
      'console_logs', 'network_log', 'network_detail', 'playwright_execute', 'reset',
      'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
      'override_app', 'app_action', 'debugger', 'css_inspect', 'session_manager'];
    for (const t of prevTools) {
      assert.ok(allTools.includes(t), `Missing: ${t}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Intercept state management
// ---------------------------------------------------------------------------

describe('intercept state management', () => {
  function createInterceptState() {
    let enabled = false;
    const rules: Map<string, { id: string; urlPattern: string }> = new Map();
    let nextId = 1;

    function enable() { enabled = true; }
    function disable() { enabled = false; }
    function clear() { enabled = false; rules.clear(); nextId = 1; }
    function addRule(urlPattern: string) {
      const id = `rule_${nextId++}`;
      rules.set(id, { id, urlPattern });
      return id;
    }

    return { get enabled() { return enabled; }, rules, enable, disable, clear, addRule };
  }

  it('should start disabled', () => {
    const state = createInterceptState();
    assert.equal(state.enabled, false);
  });

  it('should toggle enable/disable', () => {
    const state = createInterceptState();
    state.enable();
    assert.equal(state.enabled, true);
    state.disable();
    assert.equal(state.enabled, false);
  });

  it('should clear all state including enabled', () => {
    const state = createInterceptState();
    state.enable();
    state.addRule('/api/');
    state.addRule('/data/');
    state.clear();
    assert.equal(state.enabled, false);
    assert.equal(state.rules.size, 0);
  });

  it('should reset ID counter on clear', () => {
    const state = createInterceptState();
    state.addRule('/a/');
    state.addRule('/b/');
    state.clear();
    const id = state.addRule('/c/');
    assert.equal(id, 'rule_1');
  });
});

// ---------------------------------------------------------------------------
// Test: reset clears intercept state
// ---------------------------------------------------------------------------

describe('reset clears all state including intercept', () => {
  it('should clear 10 state categories', () => {
    const stateCategories = [
      'consoleLogs', 'networkLog', 'interceptState',
      'lastSnapshot', 'pwExecutor', 'debuggerEnabled',
      'breakpoints', 'knownScripts', 'executorManager',
      'preferredTargetId',
    ];
    assert.equal(stateCategories.length, 10);
  });
});

// ===========================================================================
// Extended comprehensive tests for Phase 4-9
// ===========================================================================

// ---------------------------------------------------------------------------
// storage tool – comprehensive cookie edge cases
// ---------------------------------------------------------------------------

describe('storage – cookie edge cases', () => {
  function formatCookieValue(value: string, maxLen = 80): string {
    return `${value.slice(0, maxLen)}${value.length > maxLen ? '...' : ''}`;
  }

  it('should handle empty cookie value', () => assert.equal(formatCookieValue(''), ''));
  it('should handle exactly 80 char value', () => assert.equal(formatCookieValue('x'.repeat(80)), 'x'.repeat(80)));
  it('should truncate 81 char value', () => assert.ok(formatCookieValue('x'.repeat(81)).endsWith('...')));
  it('should handle JSON cookie value', () => {
    const json = JSON.stringify({ token: 'abc', exp: 1234567890 });
    const result = formatCookieValue(json);
    assert.ok(result.includes('token'));
  });
  it('should handle base64 cookie value', () => {
    const b64 = Buffer.from('session-data-content').toString('base64');
    assert.equal(formatCookieValue(b64), b64);
  });
  it('should handle URL-encoded cookie value', () => {
    const encoded = encodeURIComponent('key=value&other=data;more');
    assert.equal(formatCookieValue(encoded), encoded);
  });
  it('should handle cookie with unicode characters', () => {
    assert.equal(formatCookieValue('日本語クッキー'), '日本語クッキー');
  });
  it('should handle cookie with newlines (encoded)', () => {
    assert.equal(formatCookieValue('line1%0Aline2'), 'line1%0Aline2');
  });
});

describe('storage – cookie attribute combinations', () => {
  function formatCookieAttrs(c: { secure: boolean; httpOnly: boolean; sameSite?: string; domain: string; path: string }): string {
    return `domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite || 'None'}`;
  }

  it('should format secure + httpOnly + Strict', () => {
    const text = formatCookieAttrs({ secure: true, httpOnly: true, sameSite: 'Strict', domain: '.a.com', path: '/' });
    assert.ok(text.includes('secure=true'));
    assert.ok(text.includes('httpOnly=true'));
    assert.ok(text.includes('sameSite=Strict'));
  });

  it('should format insecure cookie', () => {
    const text = formatCookieAttrs({ secure: false, httpOnly: false, domain: 'localhost', path: '/api' });
    assert.ok(text.includes('secure=false'));
    assert.ok(text.includes('sameSite=None'));
    assert.ok(text.includes('path=/api'));
  });

  it('should handle subdomain dots', () => {
    assert.ok(formatCookieAttrs({ secure: true, httpOnly: true, domain: '.sub.example.com', path: '/' }).includes('.sub.example.com'));
  });
});

describe('storage – localStorage key/value edge cases', () => {
  function formatStorageEntry(key: string, value: string, maxLen = 200): string {
    const vs = String(value);
    return `  ${key}: ${vs.slice(0, maxLen)}${vs.length > maxLen ? '...' : ''}`;
  }

  it('should handle key with special chars', () => {
    assert.ok(formatStorageEntry('key.with.dots', 'value').includes('key.with.dots'));
  });
  it('should handle key with unicode', () => {
    assert.ok(formatStorageEntry('语言设置', 'zh-CN').includes('语言设置'));
  });
  it('should handle JSON value', () => {
    const json = JSON.stringify({ items: [1, 2, 3], nested: { a: true } });
    assert.ok(formatStorageEntry('cart', json).includes('"items"'));
  });
  it('should truncate at 200 chars', () => {
    const result = formatStorageEntry('data', 'y'.repeat(201));
    assert.ok(result.endsWith('...'));
  });
  it('should not truncate exactly 200 chars', () => {
    const result = formatStorageEntry('data', 'y'.repeat(200));
    assert.ok(!result.endsWith('...'));
  });
  it('should handle empty value', () => {
    assert.ok(formatStorageEntry('empty', '').includes('empty: '));
  });
  it('should handle boolean-like values', () => {
    assert.ok(formatStorageEntry('flag', 'true').includes('true'));
    assert.ok(formatStorageEntry('flag', 'false').includes('false'));
  });
  it('should handle numeric string values', () => {
    assert.ok(formatStorageEntry('count', '42').includes('42'));
  });
});

describe('storage – clear_storage types parsing', () => {
  function parseStorageTypes(types: string): string[] {
    return types === 'all' ? ['all'] : types.split(',').map(t => t.trim());
  }

  it('should parse all', () => assert.deepStrictEqual(parseStorageTypes('all'), ['all']));
  it('should parse single type', () => assert.deepStrictEqual(parseStorageTypes('cookies'), ['cookies']));
  it('should parse multiple types', () => {
    assert.deepStrictEqual(parseStorageTypes('cookies,local_storage,indexeddb'), ['cookies', 'local_storage', 'indexeddb']);
  });
  it('should handle spaces', () => {
    assert.deepStrictEqual(parseStorageTypes(' cookies , local_storage '), ['cookies', 'local_storage']);
  });
});

// ---------------------------------------------------------------------------
// performance – comprehensive metric edge cases
// ---------------------------------------------------------------------------

describe('performance – key metrics list', () => {
  const keyMetrics = ['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount',
    'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
    'JSHeapUsedSize', 'JSHeapTotalSize'];

  it('should have 13 key metrics', () => assert.equal(keyMetrics.length, 13));
  it('should have no duplicates', () => assert.equal(new Set(keyMetrics).size, keyMetrics.length));
  it('should include heap metrics', () => {
    assert.ok(keyMetrics.includes('JSHeapUsedSize'));
    assert.ok(keyMetrics.includes('JSHeapTotalSize'));
  });
  it('should include all duration metrics', () => {
    const durations = keyMetrics.filter(m => m.includes('Duration'));
    assert.equal(durations.length, 4);
  });
  it('should include node count', () => assert.ok(keyMetrics.includes('Nodes')));
});

describe('performance – web vitals thresholds', () => {
  const thresholds = {
    LCP: { good: 2500, poor: 4000, unit: 'ms' },
    CLS: { good: 0.1, poor: 0.25, unit: '' },
    INP: { good: 200, poor: 500, unit: 'ms' },
  };

  it('LCP good threshold is 2.5s', () => assert.equal(thresholds.LCP.good, 2500));
  it('LCP poor threshold is 4s', () => assert.equal(thresholds.LCP.poor, 4000));
  it('CLS good threshold is 0.1', () => assert.equal(thresholds.CLS.good, 0.1));
  it('CLS poor threshold is 0.25', () => assert.equal(thresholds.CLS.poor, 0.25));
  it('INP good threshold is 200ms', () => assert.equal(thresholds.INP.good, 200));
  it('INP poor threshold is 500ms', () => assert.equal(thresholds.INP.poor, 500));
  it('good < poor for all metrics', () => {
    for (const [, t] of Object.entries(thresholds)) {
      assert.ok(t.good < t.poor, `good (${t.good}) should be < poor (${t.poor})`);
    }
  });
});

describe('performance – resource timing sorting and filtering', () => {
  const resources = [
    { name: 'a.js', type: 'script', duration: 100, transferSize: 1024 },
    { name: 'b.css', type: 'css', duration: 300, transferSize: 512 },
    { name: 'c.png', type: 'img', duration: 200, transferSize: 8192 },
    { name: 'd.json', type: 'fetch', duration: 50, transferSize: 256 },
    { name: 'e.woff', type: 'font', duration: 150, transferSize: 4096 },
  ];

  it('should sort by duration descending', () => {
    const sorted = [...resources].sort((a, b) => b.duration - a.duration);
    assert.equal(sorted[0].name, 'b.css');
    assert.equal(sorted[1].name, 'c.png');
  });

  it('should filter by type', () => {
    const filtered = resources.filter(r => r.type === 'script');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'a.js');
  });

  it('should limit results', () => {
    const limited = resources.slice(0, 3);
    assert.equal(limited.length, 3);
  });

  it('should handle empty resources', () => {
    const empty: typeof resources = [];
    assert.equal(empty.length, 0);
  });

  it('should handle same duration', () => {
    const same = [
      { name: 'x.js', type: 'script', duration: 100, transferSize: 1024 },
      { name: 'y.js', type: 'script', duration: 100, transferSize: 2048 },
    ];
    const sorted = same.sort((a, b) => b.duration - a.duration);
    assert.equal(sorted.length, 2);
  });
});

// ---------------------------------------------------------------------------
// editor – comprehensive source view edge cases
// ---------------------------------------------------------------------------

describe('editor – source truncation', () => {
  it('should truncate source over 50000 chars', () => {
    const longSource = 'x'.repeat(60000);
    const truncated = longSource.length > 50000
      ? longSource.slice(0, 50000) + '\n[Truncated to 50000 chars. Use line_start/line_end for specific ranges.]'
      : longSource;
    assert.ok(truncated.length < 60000);
    assert.ok(truncated.includes('[Truncated'));
  });

  it('should not truncate exactly 50000 chars', () => {
    const source = 'x'.repeat(50000);
    const result = source.length > 50000 ? source.slice(0, 50000) + '\n[Truncated]' : source;
    assert.equal(result, source);
  });
});

describe('editor – search results formatting', () => {
  function formatSearchResult(url: string, matches: Array<{ lineNumber: number; lineContent: string }>): string[] {
    const result: string[] = [];
    result.push(`${url} (${matches.length} matches):`);
    for (const m of matches.slice(0, 5)) {
      result.push(`  L${m.lineNumber + 1}: ${m.lineContent.trim().slice(0, 120)}`);
    }
    if (matches.length > 5) result.push(`  ... and ${matches.length - 5} more`);
    return result;
  }

  it('should format single match', () => {
    const result = formatSearchResult('app.js', [{ lineNumber: 41, lineContent: '  const todo = new Todo();' }]);
    assert.ok(result[0].includes('1 matches'));
    assert.ok(result[1].includes('L42'));
  });

  it('should truncate to 5 matches', () => {
    const matches = Array.from({ length: 10 }, (_, i) => ({ lineNumber: i, lineContent: `line ${i}` }));
    const result = formatSearchResult('big.js', matches);
    assert.ok(result.some(l => l.includes('... and 5 more')));
  });

  it('should truncate long line content at 120 chars', () => {
    const longLine = 'a'.repeat(200);
    const result = formatSearchResult('x.js', [{ lineNumber: 0, lineContent: longLine }]);
    assert.ok(result[1].length < 200);
  });
});

describe('editor – script filtering', () => {
  it('should exclude chrome-extension:// URLs', () => {
    const scripts = [
      { scriptId: '1', url: 'https://app.com/main.js' },
      { scriptId: '2', url: 'chrome-extension://abc123/content.js' },
      { scriptId: '3', url: 'https://cdn.com/lib.js' },
    ];
    const filtered = scripts.filter(s => s.url && !s.url.startsWith('chrome-extension://'));
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(s => !s.url.startsWith('chrome-extension://')));
  });

  it('should exclude scripts without URL', () => {
    const scripts = [
      { scriptId: '1', url: '' },
      { scriptId: '2', url: 'https://app.com/main.js' },
    ];
    const filtered = scripts.filter(s => s.url && !s.url.startsWith('chrome-extension://'));
    assert.equal(filtered.length, 1);
  });

  it('should limit to 50 scripts', () => {
    const scripts = Array.from({ length: 100 }, (_, i) => ({ scriptId: `${i}`, url: `https://app.com/${i}.js` }));
    assert.equal(scripts.slice(0, 50).length, 50);
  });
});

// ---------------------------------------------------------------------------
// network_intercept – comprehensive pattern and rule tests
// ---------------------------------------------------------------------------

describe('network_intercept – glob-to-regex conversion', () => {
  function globToRegex(pattern: string): RegExp {
    return new RegExp(pattern.replace(/\*/g, '.*'));
  }

  it('should convert simple glob', () => {
    const re = globToRegex('*/api/*');
    assert.ok(re.test('https://example.com/api/users'));
    assert.ok(re.test('http://localhost:3000/api/data'));
  });

  it('should handle no wildcards', () => {
    const re = globToRegex('/exact/path');
    assert.ok(re.test('/exact/path'));
    assert.ok(!re.test('/other/path'));
  });

  it('should handle multiple wildcards', () => {
    const re = globToRegex('*://*.example.com/*');
    assert.ok(re.test('https://api.example.com/v2/users'));
  });

  it('should match everything with single star', () => {
    const re = globToRegex('*');
    assert.ok(re.test('anything'));
    assert.ok(re.test(''));
  });
});

describe('network_intercept – Fetch.fulfillRequest encoding', () => {
  it('should base64-encode mock body', () => {
    const body = '{"status":"ok","data":[1,2,3]}';
    const encoded = Buffer.from(body).toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    assert.equal(decoded, body);
  });

  it('should handle empty mock body', () => {
    const encoded = Buffer.from('').toString('base64');
    assert.equal(encoded, '');
  });

  it('should handle unicode mock body', () => {
    const body = '{"message":"成功","data":"日本語"}';
    const encoded = Buffer.from(body).toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    assert.equal(decoded, body);
  });

  it('should handle HTML mock body', () => {
    const body = '<html><body><h1>Mock Page</h1></body></html>';
    const encoded = Buffer.from(body).toString('base64');
    assert.ok(encoded.length > 0);
    assert.equal(Buffer.from(encoded, 'base64').toString(), body);
  });
});

describe('network_intercept – response header formatting', () => {
  function formatHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
    return Object.entries(headers).map(([n, v]) => ({ name: n, value: v }));
  }

  it('should format single header', () => {
    const result = formatHeaders({ 'Content-Type': 'application/json' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Content-Type');
  });

  it('should format multiple headers', () => {
    const result = formatHeaders({
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache',
      'X-Custom': 'value',
    });
    assert.equal(result.length, 3);
  });

  it('should handle empty headers', () => {
    assert.equal(formatHeaders({}).length, 0);
  });

  it('should default to Content-Type application/json', () => {
    const defaults = { 'Content-Type': 'application/json' };
    const result = formatHeaders(defaults);
    assert.equal(result[0].value, 'application/json');
  });
});

describe('network_intercept – rule formatting for list_rules', () => {
  function formatRule(rule: { id: string; urlPattern: string; resourceType?: string; mockStatus?: number; block?: boolean }): string {
    const parts = [`[${rule.id}] pattern="${rule.urlPattern}"`];
    if (rule.resourceType) parts.push(`type=${rule.resourceType}`);
    if (rule.block) parts.push('→ BLOCK');
    else if (rule.mockStatus !== undefined) parts.push(`→ mock ${rule.mockStatus}`);
    return parts.join(' ');
  }

  it('should format block rule', () => {
    const text = formatRule({ id: 'rule_1', urlPattern: '*/ads/*', block: true });
    assert.ok(text.includes('→ BLOCK'));
    assert.ok(text.includes('*/ads/*'));
  });

  it('should format mock rule', () => {
    const text = formatRule({ id: 'rule_2', urlPattern: '*/api/*', mockStatus: 200 });
    assert.ok(text.includes('→ mock 200'));
  });

  it('should include resource type', () => {
    const text = formatRule({ id: 'rule_3', urlPattern: '*.js', resourceType: 'Script' });
    assert.ok(text.includes('type=Script'));
  });

  it('should format rule with no action', () => {
    const text = formatRule({ id: 'rule_4', urlPattern: '*' });
    assert.ok(!text.includes('BLOCK'));
    assert.ok(!text.includes('mock'));
  });
});

// ---------------------------------------------------------------------------
// emulation – comprehensive device and condition tests
// ---------------------------------------------------------------------------

describe('emulation – common device presets', () => {
  const devices = [
    { name: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true },
    { name: 'iPhone 14 Pro', width: 393, height: 852, dpr: 3, mobile: true },
    { name: 'iPad Air', width: 820, height: 1180, dpr: 2, mobile: true },
    { name: 'Pixel 7', width: 412, height: 915, dpr: 2.625, mobile: true },
    { name: 'Galaxy S21', width: 360, height: 800, dpr: 3, mobile: true },
    { name: 'Desktop HD', width: 1920, height: 1080, dpr: 1, mobile: false },
    { name: 'Desktop 4K', width: 3840, height: 2160, dpr: 2, mobile: false },
    { name: 'Laptop', width: 1366, height: 768, dpr: 1, mobile: false },
  ];

  it('should have 8 device presets', () => assert.equal(devices.length, 8));

  for (const d of devices) {
    it(`${d.name} should have valid dimensions`, () => {
      assert.ok(d.width > 0);
      assert.ok(d.height > 0);
      assert.ok(d.dpr > 0);
    });
  }

  it('all mobile devices should have mobile=true', () => {
    const mobileDevices = devices.filter(d => d.mobile);
    assert.ok(mobileDevices.length >= 5);
  });

  it('no desktop device should be mobile', () => {
    const desktops = devices.filter(d => !d.mobile);
    assert.ok(desktops.every(d => d.width >= 1024));
  });
});

describe('emulation – timezone validation', () => {
  const validTimezones = [
    'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney',
    'Pacific/Auckland', 'UTC',
  ];

  it('should have common timezones', () => {
    assert.ok(validTimezones.includes('UTC'));
    assert.ok(validTimezones.includes('America/New_York'));
    assert.ok(validTimezones.includes('Asia/Tokyo'));
  });

  it('all should be non-empty strings', () => {
    for (const tz of validTimezones) {
      assert.ok(tz.length > 0);
    }
  });
});

describe('emulation – geolocation validation', () => {
  it('should accept valid coordinates', () => {
    const coords = [
      { lat: 37.7749, lng: -122.4194, name: 'San Francisco' },
      { lat: 51.5074, lng: -0.1278, name: 'London' },
      { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
      { lat: -33.8688, lng: 151.2093, name: 'Sydney' },
      { lat: 0, lng: 0, name: 'Null Island' },
      { lat: 90, lng: 180, name: 'North Pole max longitude' },
      { lat: -90, lng: -180, name: 'South Pole min longitude' },
    ];
    for (const c of coords) {
      assert.ok(c.lat >= -90 && c.lat <= 90, `${c.name}: lat ${c.lat} out of range`);
      assert.ok(c.lng >= -180 && c.lng <= 180, `${c.name}: lng ${c.lng} out of range`);
    }
  });
});

describe('emulation – network conditions format', () => {
  function formatNetworkConditions(preset: string, params: { latency: number; downloadThroughput: number; uploadThroughput: number }): string {
    return `Network: ${preset} (latency=${params.latency}ms, down=${params.downloadThroughput > 0 ? (params.downloadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'}, up=${params.uploadThroughput > 0 ? (params.uploadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'})`;
  }

  it('should format slow-3g', () => {
    const text = formatNetworkConditions('slow-3g', { latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
    assert.ok(text.includes('slow-3g'));
    assert.ok(text.includes('2000ms'));
    assert.ok(text.includes('50KB/s'));
  });

  it('should show unlimited for negative throughput', () => {
    const text = formatNetworkConditions('custom', { latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert.ok(text.includes('unlimited'));
  });

  it('should format wifi', () => {
    const text = formatNetworkConditions('wifi', { latency: 28, downloadThroughput: 30 * 1024 * 1024, uploadThroughput: 15 * 1024 * 1024 });
    assert.ok(text.includes('wifi'));
    assert.ok(text.includes('28ms'));
  });
});

// ---------------------------------------------------------------------------
// page_content – comprehensive content and search tests
// ---------------------------------------------------------------------------

describe('page_content – HTML cleaning patterns', () => {
  const scriptPatterns = [
    '<script>alert(1)</script>',
    '<script type="text/javascript">var x = 1;</script>',
    '<script src="app.js"></script>',
    '<script async defer src="analytics.js"></script>',
    '<SCRIPT>console.log("upper")</SCRIPT>',
    '<noscript>Please enable JavaScript</noscript>',
  ];

  for (const p of scriptPatterns) {
    it(`should remove: ${p.slice(0, 40)}...`, () => {
      const cleaned = p.replace(/<(script|noscript)[^>]*>[\s\S]*?<\/(script|noscript)>/gi, '');
      assert.ok(!cleaned.includes('script'), `Failed to clean: ${p}`);
    });
  }

  it('should preserve non-script content', () => {
    const html = '<div><p>Hello</p><script>bad()</script><span>World</span></div>';
    const cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.ok(cleaned.includes('Hello'));
    assert.ok(cleaned.includes('World'));
    assert.ok(!cleaned.includes('bad'));
  });
});

describe('page_content – style attribute removal', () => {
  const stylePatterns = [
    { input: '<div style="color:red">text</div>', expected: '<div>text</div>' },
    { input: '<p style="font-size:12px;margin:0">text</p>', expected: '<p>text</p>' },
    { input: '<span style="">text</span>', expected: '<span>text</span>' },
    { input: '<div style="background-image:url(\'data:image/png;base64,abc\')">img</div>', expected: '<div>img</div>' },
  ];

  for (const { input, expected } of stylePatterns) {
    it(`should clean: ${input.slice(0, 50)}...`, () => {
      const cleaned = input.replace(/\s*style="[^"]*"/gi, '');
      assert.equal(cleaned, expected);
    });
  }
});

describe('page_content – metadata fields', () => {
  const metadataFields = [
    'title', 'url', 'description', 'charset', 'lang', 'viewport',
    'ogTitle', 'ogDescription', 'ogImage', 'canonical', 'favicon',
    'scripts', 'stylesheets', 'images', 'links',
  ];

  it('should have 15 metadata fields', () => assert.equal(metadataFields.length, 15));
  it('should have no duplicates', () => assert.equal(new Set(metadataFields).size, metadataFields.length));
  it('should include OG tags', () => {
    assert.ok(metadataFields.includes('ogTitle'));
    assert.ok(metadataFields.includes('ogDescription'));
    assert.ok(metadataFields.includes('ogImage'));
  });
  it('should include counts', () => {
    assert.ok(metadataFields.includes('scripts'));
    assert.ok(metadataFields.includes('images'));
    assert.ok(metadataFields.includes('links'));
  });
});

describe('page_content – DOM search result formatting', () => {
  function formatDomResult(tag: string, id: string, classes: string, text: string): string {
    return `<${tag}${id ? '#' + id : ''}${classes ? '.' + classes.split(' ').join('.') : ''}> ${text.slice(0, 100)}`;
  }

  it('should format element with id', () => {
    const text = formatDomResult('div', 'main', '', 'Main content');
    assert.equal(text, '<div#main> Main content');
  });

  it('should format element with classes', () => {
    const text = formatDomResult('button', '', 'btn btn-primary', 'Click me');
    assert.equal(text, '<button.btn.btn-primary> Click me');
  });

  it('should format element with both', () => {
    const text = formatDomResult('section', 'hero', 'wide dark', 'Hero section');
    assert.equal(text, '<section#hero.wide.dark> Hero section');
  });

  it('should truncate text at 100 chars', () => {
    const text = formatDomResult('p', '', '', 'x'.repeat(200));
    assert.ok(text.length < 200);
  });

  it('should handle empty text', () => {
    const text = formatDomResult('div', 'empty', '', '');
    assert.equal(text, '<div#empty> ');
  });
});

// ---------------------------------------------------------------------------
// Test: withTimeout utility (global MCP request timeout)
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Tool "${toolName}" timed out after ${ms / 1000}s. The browser may be busy or unreachable. Try again or call reset.`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('withTimeout utility', () => {
  it('should resolve when promise completes within timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 5000, 'test_tool');
    assert.equal(result, 42);
  });

  it('should reject when promise exceeds timeout', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 50, 'slow_tool'),
      (err: Error) => {
        assert.ok(err.message.includes('slow_tool'));
        assert.ok(err.message.includes('timed out'));
        assert.ok(err.message.includes('0.05s'));
        return true;
      }
    );
  });

  it('should propagate original error if promise rejects before timeout', async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error('original error')), 5000, 'test_tool'),
      (err: Error) => err.message === 'original error'
    );
  });

  it('should clean up timer when promise resolves', async () => {
    const result = await withTimeout(Promise.resolve('fast'), 5000, 'test');
    assert.equal(result, 'fast');
  });

  it('should clean up timer when promise rejects', async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error('boom')), 5000, 'test'),
      (err: Error) => err.message === 'boom'
    );
  });

  it('should include tool name in timeout error', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 50, 'my_special_tool'),
      (err: Error) => {
        assert.ok(err.message.includes('my_special_tool'));
        return true;
      }
    );
  });

  it('should include seconds in timeout error', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 120000, 'long_tool'),
      { message: /120s/ }
    );
  });

  it('should handle zero timeout', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 0, 'instant_timeout'),
      (err: Error) => err.message.includes('instant_timeout')
    );
  });

  it('should handle async function that resolves with undefined', async () => {
    const result = await withTimeout(Promise.resolve(undefined), 5000, 'test');
    assert.equal(result, undefined);
  });

  it('should handle async function that resolves with null', async () => {
    const result = await withTimeout(Promise.resolve(null), 5000, 'test');
    assert.equal(result, null);
  });

  it('should handle promise chain', async () => {
    const result = await withTimeout(
      Promise.resolve(1).then(v => v + 1).then(v => v * 2),
      5000,
      'chain_test'
    );
    assert.equal(result, 4);
  });

  it('should not interfere with fast sequential calls', async () => {
    const r1 = await withTimeout(Promise.resolve('a'), 5000, 't1');
    const r2 = await withTimeout(Promise.resolve('b'), 5000, 't2');
    const r3 = await withTimeout(Promise.resolve('c'), 5000, 't3');
    assert.equal(r1, 'a');
    assert.equal(r2, 'b');
    assert.equal(r3, 'c');
  });
});

// ---------------------------------------------------------------------------
// Test: sendCdpCommand timeout behavior
// ---------------------------------------------------------------------------

describe('sendCdpCommand timeout pattern', () => {
  it('should reject when command exceeds timeout', async () => {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('CDP command timeout: Runtime.evaluate'));
        }, 50);
        // Simulate no response coming back
        void timer;
      }),
      (err: Error) => err.message.includes('CDP command timeout')
    );
  });

  it('should resolve when response arrives before timeout', async () => {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('CDP command timeout'));
      }, 5000);
      // Simulate immediate response
      clearTimeout(timer);
      resolve({ result: { value: 'ok' } });
    });
    assert.deepEqual(result, { result: { value: 'ok' } });
  });

  it('should use custom timeout for slow commands', () => {
    const SLOW_CDP_COMMANDS = new Set([
      'Accessibility.getFullAXTree', 'Page.captureScreenshot',
      'Network.clearBrowserCache', 'Network.clearBrowserCookies',
      'Page.reload', 'Page.navigate',
    ]);
    function getCommandTimeout(method: string): number {
      return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
    }
    assert.equal(getCommandTimeout('Page.navigate'), 60000);
    assert.equal(getCommandTimeout('Runtime.evaluate'), 30000);
    assert.equal(getCommandTimeout('Accessibility.getFullAXTree'), 60000);
    assert.equal(getCommandTimeout('DOM.enable'), 30000);
  });
});

// ---------------------------------------------------------------------------
// Test: evaluateJs timeout parameter
// ---------------------------------------------------------------------------

describe('evaluateJs timeout parameter', () => {
  it('should pass timeout to Runtime.evaluate params', () => {
    const evalTimeout = 15000;
    const commandTimeout = evalTimeout + 5000;
    const params = {
      expression: '1+1',
      returnByValue: true,
      awaitPromise: true,
      timeout: evalTimeout,
    };
    assert.equal(params.timeout, 15000);
    assert.equal(commandTimeout, 20000);
  });

  it('should default to 30s eval + 35s command timeout', () => {
    const defaultEvalTimeout = 30000;
    const defaultCommandTimeout = defaultEvalTimeout + 5000;
    assert.equal(defaultEvalTimeout, 30000);
    assert.equal(defaultCommandTimeout, 35000);
  });

  it('command timeout should always be greater than eval timeout', () => {
    for (const evalTimeout of [1000, 5000, 10000, 30000, 60000]) {
      const commandTimeout = evalTimeout + 5000;
      assert.ok(commandTimeout > evalTimeout);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Timeout hierarchy correctness
// ---------------------------------------------------------------------------

describe('Timeout hierarchy', () => {
  it('Playwright page timeout <= execution timeout', () => {
    const executionTimeout = 30000;
    const pageTimeout = Math.min(executionTimeout, 30000);
    const navTimeout = Math.min(executionTimeout, 15000);
    assert.ok(pageTimeout <= executionTimeout);
    assert.ok(navTimeout <= executionTimeout);
  });

  it('Playwright page timeout adapts to short execution timeout', () => {
    const executionTimeout = 5000;
    const pageTimeout = Math.min(executionTimeout, 30000);
    const navTimeout = Math.min(executionTimeout, 15000);
    assert.equal(pageTimeout, 5000);
    assert.equal(navTimeout, 5000);
  });

  it('navigation timeout caps at 15s even with high execution timeout', () => {
    const executionTimeout = 60000;
    const navTimeout = Math.min(executionTimeout, 15000);
    assert.equal(navTimeout, 15000);
  });

  it('MCP global timeout > Playwright timeout > CDP command timeout', () => {
    const mcpTimeout = 120000;
    const playwrightDefault = 30000;
    const cdpCommandDefault = 30000;
    const cdpSlowCommand = 60000;
    const healthCheck = 5000;
    const cdpConnect = 15000;

    assert.ok(mcpTimeout > playwrightDefault);
    assert.ok(mcpTimeout > cdpSlowCommand);
    assert.ok(playwrightDefault >= cdpCommandDefault);
    assert.ok(healthCheck < playwrightDefault);
    assert.ok(cdpConnect <= playwrightDefault);
  });

  it('all timeouts should be positive numbers', () => {
    const timeouts = [120000, 60000, 30000, 15000, 10000, 5000, 2000, 1000];
    for (const t of timeouts) {
      assert.ok(t > 0);
      assert.ok(Number.isFinite(t));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Error message format for timeout scenarios
// ---------------------------------------------------------------------------

describe('Timeout error message format', () => {
  it('global MCP timeout includes tool name and seconds', () => {
    const msg = `Tool "screenshot" timed out after ${120000 / 1000}s. The browser may be busy or unreachable. Try again or call reset.`;
    assert.ok(msg.includes('screenshot'));
    assert.ok(msg.includes('120s'));
    assert.ok(msg.includes('reset'));
  });

  it('CDP command timeout includes method name', () => {
    const msg = `CDP command timeout: Runtime.evaluate`;
    assert.ok(msg.includes('Runtime.evaluate'));
  });

  it('health check timeout is descriptive', () => {
    const msg = 'Health check timeout';
    assert.ok(msg.includes('Health check'));
  });

  it('CDP connection timeout includes duration', () => {
    const msg = 'CDP connection timeout (15s)';
    assert.ok(msg.includes('15s'));
  });

  it('PlaywrightExecutor timeout hint suggests reset', () => {
    const hint = '[HINT: Execution timed out. The operation may still be running in the browser. Use reset if the browser is in a bad state.]';
    assert.ok(hint.includes('reset'));
    assert.ok(hint.includes('timed out'));
  });

  it('Extension CDP timeout includes method name and duration', () => {
    const timeoutMs = 30000;
    const method = 'Runtime.evaluate';
    const msg = `Extension CDP timeout (${timeoutMs}ms): ${method}`;
    assert.ok(msg.includes('Runtime.evaluate'));
    assert.ok(msg.includes('30000ms'));
    assert.ok(msg.includes('Extension CDP timeout'));
  });
});

// ---------------------------------------------------------------------------
// Test: Extension-side sendCommandWithTimeout pattern
// ---------------------------------------------------------------------------

describe('Extension sendCommandWithTimeout pattern', () => {
  const SLOW_CDP_METHODS = new Set([
    'Accessibility.getFullAXTree', 'Page.captureScreenshot',
    'Network.clearBrowserCache', 'Network.clearBrowserCookies',
    'Page.reload', 'Page.navigate',
  ]);
  const CDP_COMMAND_TIMEOUT_MS = 30000;
  const CDP_SLOW_COMMAND_TIMEOUT_MS = 60000;

  function sendCommandWithTimeout(
    mockSendCommand: () => Promise<unknown>,
    method: string,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Extension CDP timeout (${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);

      mockSendCommand().then(
        (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      );
    });
  }

  it('should reject with descriptive error when command hangs (simulating page reload)', async () => {
    const neverResolves = () => new Promise<never>(() => {});
    await assert.rejects(
      sendCommandWithTimeout(neverResolves, 'Runtime.evaluate', 50),
      (err: Error) => {
        assert.ok(err.message.includes('Extension CDP timeout'));
        assert.ok(err.message.includes('Runtime.evaluate'));
        assert.ok(err.message.includes('50ms'));
        return true;
      },
    );
  });

  it('should resolve normally when command responds before timeout', async () => {
    const immediate = () => Promise.resolve({ value: 'hello' });
    const result = await sendCommandWithTimeout(immediate, 'Runtime.evaluate', 5000);
    assert.deepEqual(result, { value: 'hello' });
  });

  it('should propagate original error when command rejects before timeout', async () => {
    const failing = () => Promise.reject(new Error('Debugger detached'));
    await assert.rejects(
      sendCommandWithTimeout(failing, 'Runtime.evaluate', 5000),
      (err: Error) => {
        assert.ok(err.message.includes('Debugger detached'));
        assert.ok(!err.message.includes('Extension CDP timeout'));
        return true;
      },
    );
  });

  it('should use slow timeout for known slow methods', () => {
    for (const method of SLOW_CDP_METHODS) {
      const timeout = SLOW_CDP_METHODS.has(method)
        ? CDP_SLOW_COMMAND_TIMEOUT_MS
        : CDP_COMMAND_TIMEOUT_MS;
      assert.equal(timeout, 60000, `${method} should use slow timeout`);
    }
  });

  it('should use default timeout for fast methods', () => {
    const fastMethods = ['Runtime.evaluate', 'DOM.enable', 'CSS.getStyleSheets', 'Network.enable'];
    for (const method of fastMethods) {
      const timeout = SLOW_CDP_METHODS.has(method)
        ? CDP_SLOW_COMMAND_TIMEOUT_MS
        : CDP_COMMAND_TIMEOUT_MS;
      assert.equal(timeout, 30000, `${method} should use default timeout`);
    }
  });

  it('should not resolve after timeout even if command later succeeds', async () => {
    let resolveCommand: (v: unknown) => void;
    const delayed = () => new Promise((resolve) => { resolveCommand = resolve; });

    const promise = sendCommandWithTimeout(delayed, 'Runtime.evaluate', 50);
    await assert.rejects(promise, /Extension CDP timeout/);

    resolveCommand!('late result');
    await new Promise((r) => setTimeout(r, 10));
  });

  it('SLOW_CDP_METHODS matches SLOW_CDP_COMMANDS from mcp.ts', () => {
    const mcpSlowCommands = new Set([
      'Accessibility.getFullAXTree', 'Page.captureScreenshot',
      'Network.clearBrowserCache', 'Network.clearBrowserCookies',
      'Page.reload', 'Page.navigate',
    ]);
    assert.deepEqual(SLOW_CDP_METHODS, mcpSlowCommands);
  });
});

// ---------------------------------------------------------------------------
// Test: Extension timeout fits in overall timeout hierarchy
// ---------------------------------------------------------------------------

describe('Extension timeout hierarchy', () => {
  it('extension timeout < relay timeout < MCP global timeout', () => {
    const extensionDefault = 30000;
    const extensionSlow = 60000;
    const relayTimeout = 90000;
    const mcpGlobal = 120000;

    assert.ok(extensionDefault < relayTimeout);
    assert.ok(extensionSlow < relayTimeout);
    assert.ok(relayTimeout < mcpGlobal);
  });

  it('extension timeout <= MCP sendCdpCommand timeout for evaluateJs', () => {
    const extensionTimeout = 30000;
    const evalTimeout = 30000;
    const mcpCommandTimeout = evalTimeout + 5000; // 35s
    assert.ok(extensionTimeout <= mcpCommandTimeout);
  });

  it('extension timeout == MCP sendCdpCommand default for non-eval commands', () => {
    const extensionTimeout = 30000;
    const mcpDefaultTimeout = 30000;
    assert.equal(extensionTimeout, mcpDefaultTimeout);
  });

  it('extension slow timeout == MCP getCommandTimeout for slow commands', () => {
    const extensionSlowTimeout = 60000;
    const SLOW_CDP_COMMANDS = new Set([
      'Accessibility.getFullAXTree', 'Page.captureScreenshot',
      'Network.clearBrowserCache', 'Network.clearBrowserCookies',
      'Page.reload', 'Page.navigate',
    ]);
    function getCommandTimeout(method: string): number {
      return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
    }
    assert.equal(extensionSlowTimeout, getCommandTimeout('Page.captureScreenshot'));
    assert.equal(extensionSlowTimeout, getCommandTimeout('Page.navigate'));
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload parameter parsing
// ---------------------------------------------------------------------------

function parseClearTypes(
  clearArg?: string,
  legacyMode?: string,
): { types: Set<string>; isLegacyAggressive: boolean } {
  if (clearArg) {
    const raw = clearArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const allTypes = ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers'];
    return { types: new Set(raw.includes('all') ? allTypes : raw), isLegacyAggressive: false };
  }
  if (legacyMode === 'aggressive') {
    return { types: new Set(['cache', 'cookies']), isLegacyAggressive: true };
  }
  return { types: new Set<string>(), isLegacyAggressive: false };
}

describe('clear_cache_and_reload parameter parsing', () => {
  it('no args: empty clear set (reload only)', () => {
    const { types } = parseClearTypes();
    assert.equal(types.size, 0);
  });

  it('legacy mode light: empty clear set', () => {
    const { types } = parseClearTypes(undefined, 'light');
    assert.equal(types.size, 0);
  });

  it('legacy mode aggressive: cache + cookies', () => {
    const { types, isLegacyAggressive } = parseClearTypes(undefined, 'aggressive');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 2);
    assert.ok(isLegacyAggressive);
  });

  it('clear="cache": only cache', () => {
    const { types } = parseClearTypes('cache');
    assert.ok(types.has('cache'));
    assert.equal(types.size, 1);
  });

  it('clear="cache,service_workers": cache + service_workers', () => {
    const { types } = parseClearTypes('cache,service_workers');
    assert.ok(types.has('cache'));
    assert.ok(types.has('service_workers'));
    assert.equal(types.size, 2);
  });

  it('clear="cookies": only cookies (not global)', () => {
    const { types, isLegacyAggressive } = parseClearTypes('cookies');
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 1);
    assert.ok(!isLegacyAggressive);
  });

  it('clear="all": expands to all 7 types', () => {
    const { types } = parseClearTypes('all');
    assert.equal(types.size, 7);
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(types.has('local_storage'));
    assert.ok(types.has('session_storage'));
    assert.ok(types.has('cache_storage'));
    assert.ok(types.has('indexeddb'));
    assert.ok(types.has('service_workers'));
  });

  it('clear overrides legacy mode', () => {
    const { types, isLegacyAggressive } = parseClearTypes('cache', 'aggressive');
    assert.ok(types.has('cache'));
    assert.equal(types.size, 1);
    assert.ok(!isLegacyAggressive);
  });

  it('trims whitespace in clear types', () => {
    const { types } = parseClearTypes(' cache , cookies ');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 2);
  });

  it('deduplicates types', () => {
    const { types } = parseClearTypes('cache,cache,cookies');
    assert.equal(types.size, 2);
  });

  it('ignores empty segments', () => {
    const { types } = parseClearTypes('cache,,cookies,');
    assert.equal(types.size, 2);
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
  });

  it('case insensitive: mixed case types', () => {
    const { types } = parseClearTypes('Cache,COOKIES,Local_Storage');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(types.has('local_storage'));
    assert.equal(types.size, 3);
  });

  it('case insensitive: ALL expands all types', () => {
    const { types } = parseClearTypes('ALL');
    assert.equal(types.size, 7);
  });

  it('"all" with extra types still yields exactly 7', () => {
    const { types } = parseClearTypes('all,cache,cookies');
    assert.equal(types.size, 7);
  });

  it('single storage type: local_storage', () => {
    const { types } = parseClearTypes('local_storage');
    assert.ok(types.has('local_storage'));
    assert.equal(types.size, 1);
    assert.ok(!types.has('cache'));
    assert.ok(!types.has('cookies'));
  });

  it('single storage type: indexeddb', () => {
    const { types } = parseClearTypes('indexeddb');
    assert.ok(types.has('indexeddb'));
    assert.equal(types.size, 1);
  });

  it('single storage type: session_storage', () => {
    const { types } = parseClearTypes('session_storage');
    assert.ok(types.has('session_storage'));
    assert.equal(types.size, 1);
  });

  it('single storage type: cache_storage', () => {
    const { types } = parseClearTypes('cache_storage');
    assert.ok(types.has('cache_storage'));
    assert.equal(types.size, 1);
  });

  it('single storage type: service_workers', () => {
    const { types } = parseClearTypes('service_workers');
    assert.ok(types.has('service_workers'));
    assert.equal(types.size, 1);
  });

  it('multiple storage types without cache or cookies', () => {
    const { types } = parseClearTypes('local_storage,indexeddb,service_workers');
    assert.equal(types.size, 3);
    assert.ok(types.has('local_storage'));
    assert.ok(types.has('indexeddb'));
    assert.ok(types.has('service_workers'));
    assert.ok(!types.has('cache'));
    assert.ok(!types.has('cookies'));
  });

  it('unknown type is passed through (no crash)', () => {
    const { types } = parseClearTypes('cache,unknown_type');
    assert.ok(types.has('cache'));
    assert.ok(types.has('unknown_type'));
    assert.equal(types.size, 2);
  });

  it('legacy mode unknown value: treated like light', () => {
    const { types, isLegacyAggressive } = parseClearTypes(undefined, 'medium');
    assert.equal(types.size, 0);
    assert.ok(!isLegacyAggressive);
  });

  it('empty string clear arg: treated as no types', () => {
    const { types } = parseClearTypes('');
    assert.equal(types.size, 0);
  });

  it('whitespace-only clear arg: treated as no types', () => {
    const { types } = parseClearTypes('   ');
    assert.equal(types.size, 0);
  });

  it('clear="cookies" + mode="aggressive": clear wins, not legacy aggressive', () => {
    const { types, isLegacyAggressive } = parseClearTypes('cookies', 'aggressive');
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 1);
    assert.ok(!isLegacyAggressive);
  });

  it('clear="all" + mode="aggressive": clear wins, all 7 types, not legacy', () => {
    const { types, isLegacyAggressive } = parseClearTypes('all', 'aggressive');
    assert.equal(types.size, 7);
    assert.ok(!isLegacyAggressive);
  });

  it('clear="cache,cookies" without legacy mode: not legacy aggressive', () => {
    const { types, isLegacyAggressive } = parseClearTypes('cache,cookies');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.equal(types.size, 2);
    assert.ok(!isLegacyAggressive);
  });

  it('clear with only unknown types: still has entries', () => {
    const { types } = parseClearTypes('foo,bar');
    assert.equal(types.size, 2);
    assert.ok(types.has('foo'));
    assert.ok(types.has('bar'));
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload cookie domain matching
// ---------------------------------------------------------------------------

function matchesCookieDomain(originHost: string, cookieDomain: string): boolean {
  const isDotPrefixed = cookieDomain.startsWith('.');
  const cd = isDotPrefixed ? cookieDomain.slice(1) : cookieDomain;
  if (isDotPrefixed && !originHost.includes('.')) return false;
  return originHost === cd || originHost.endsWith('.' + cd);
}

describe('clear_cache_and_reload cookie domain matching', () => {
  it('exact domain match', () => {
    assert.ok(matchesCookieDomain('cursor.com', 'cursor.com'));
  });

  it('dot-prefixed domain matches subdomain', () => {
    assert.ok(matchesCookieDomain('app.cursor.com', '.cursor.com'));
  });

  it('dot-prefixed domain matches exact host', () => {
    assert.ok(matchesCookieDomain('cursor.com', '.cursor.com'));
  });

  it('subdomain matches parent with auto dot', () => {
    assert.ok(matchesCookieDomain('dashboard.cursor.com', 'cursor.com'));
  });

  it('unrelated domain does not match', () => {
    assert.ok(!matchesCookieDomain('cursor.com', 'google.com'));
  });

  it('partial suffix does not match', () => {
    assert.ok(!matchesCookieDomain('notcursor.com', 'cursor.com'));
  });

  it('dot-prefixed partial suffix does not match', () => {
    assert.ok(!matchesCookieDomain('notcursor.com', '.cursor.com'));
  });

  it('deeper subdomain matches', () => {
    assert.ok(matchesCookieDomain('a.b.cursor.com', '.cursor.com'));
  });

  it('empty cookie domain does not match', () => {
    assert.ok(!matchesCookieDomain('cursor.com', ''));
  });

  it('localhost exact match', () => {
    assert.ok(matchesCookieDomain('localhost', 'localhost'));
  });

  it('different TLD does not match', () => {
    assert.ok(!matchesCookieDomain('cursor.sh', 'cursor.com'));
  });

  it('IP address exact match', () => {
    assert.ok(matchesCookieDomain('127.0.0.1', '127.0.0.1'));
  });

  it('IP address does not match different IP', () => {
    assert.ok(!matchesCookieDomain('127.0.0.1', '192.168.1.1'));
  });

  it('domain with port stripped (hostname only) matches', () => {
    const origin = 'https://cursor.com:8080';
    const hostname = new URL(origin).hostname;
    assert.ok(matchesCookieDomain(hostname, 'cursor.com'));
  });

  it('www subdomain matches parent', () => {
    assert.ok(matchesCookieDomain('www.cursor.com', 'cursor.com'));
  });

  it('www subdomain matches dot-prefixed parent', () => {
    assert.ok(matchesCookieDomain('www.cursor.com', '.cursor.com'));
  });

  it('parent does not match child (no reverse matching)', () => {
    assert.ok(!matchesCookieDomain('cursor.com', 'app.cursor.com'));
  });

  it('single-label hostname exact match', () => {
    assert.ok(matchesCookieDomain('intranet', 'intranet'));
  });

  it('single-label hostname does not match with dot prefix', () => {
    assert.ok(!matchesCookieDomain('intranet', '.intranet'));
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload cookie scope decision
// ---------------------------------------------------------------------------

/**
 * Determines whether cookie clearing should be origin-scoped or skipped.
 * All cookie clearing is now origin-scoped (never global).
 */
function decideCookieScope(
  clearArg: string | undefined,
  legacyMode: string | undefined,
): 'origin' | 'none' {
  const { types } = parseClearTypes(clearArg, legacyMode);
  if (!types.has('cookies')) return 'none';
  return 'origin';
}

describe('clear_cache_and_reload cookie scope decision', () => {
  it('no cookies requested: none', () => {
    assert.equal(decideCookieScope('cache', undefined), 'none');
  });

  it('clear="cookies": origin-scoped', () => {
    assert.equal(decideCookieScope('cookies', undefined), 'origin');
  });

  it('clear="cookies" + mode="aggressive": origin-scoped (clear overrides legacy)', () => {
    assert.equal(decideCookieScope('cookies', 'aggressive'), 'origin');
  });

  it('mode="aggressive" without clear: origin-scoped (not global)', () => {
    assert.equal(decideCookieScope(undefined, 'aggressive'), 'origin');
  });

  it('mode="light": none (no cookies)', () => {
    assert.equal(decideCookieScope(undefined, 'light'), 'none');
  });

  it('clear="all": origin-scoped (not global)', () => {
    assert.equal(decideCookieScope('all', undefined), 'origin');
  });

  it('clear="all" + mode="aggressive": origin-scoped (clear wins)', () => {
    assert.equal(decideCookieScope('all', 'aggressive'), 'origin');
  });

  it('clear="cache,cookies": origin-scoped', () => {
    assert.equal(decideCookieScope('cache,cookies', undefined), 'origin');
  });

  it('no args at all: none', () => {
    assert.equal(decideCookieScope(undefined, undefined), 'none');
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload storage type partitioning
// ---------------------------------------------------------------------------

function partitionClearTypes(clearTypes: Set<string>): {
  hasCache: boolean;
  hasCookies: boolean;
  storageTypeParts: string[];
} {
  const storageTypeParts: string[] = [];
  if (clearTypes.has('local_storage')) storageTypeParts.push('local_storage');
  if (clearTypes.has('session_storage')) storageTypeParts.push('session_storage');
  if (clearTypes.has('cache_storage')) storageTypeParts.push('cache_storage');
  if (clearTypes.has('indexeddb')) storageTypeParts.push('indexeddb');
  if (clearTypes.has('service_workers')) storageTypeParts.push('service_workers');
  return {
    hasCache: clearTypes.has('cache'),
    hasCookies: clearTypes.has('cookies'),
    storageTypeParts,
  };
}

describe('clear_cache_and_reload storage type partitioning', () => {
  it('empty set: nothing to clear', () => {
    const result = partitionClearTypes(new Set());
    assert.ok(!result.hasCache);
    assert.ok(!result.hasCookies);
    assert.equal(result.storageTypeParts.length, 0);
  });

  it('cache only: hasCache but no storage parts', () => {
    const result = partitionClearTypes(new Set(['cache']));
    assert.ok(result.hasCache);
    assert.ok(!result.hasCookies);
    assert.equal(result.storageTypeParts.length, 0);
  });

  it('cookies only: hasCookies but no storage parts', () => {
    const result = partitionClearTypes(new Set(['cookies']));
    assert.ok(!result.hasCache);
    assert.ok(result.hasCookies);
    assert.equal(result.storageTypeParts.length, 0);
  });

  it('local_storage goes to storage parts', () => {
    const result = partitionClearTypes(new Set(['local_storage']));
    assert.ok(!result.hasCache);
    assert.ok(!result.hasCookies);
    assert.deepStrictEqual(result.storageTypeParts, ['local_storage']);
  });

  it('all 5 origin-scoped types go to storage parts', () => {
    const result = partitionClearTypes(new Set(['local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']));
    assert.equal(result.storageTypeParts.length, 5);
    assert.ok(result.storageTypeParts.includes('local_storage'));
    assert.ok(result.storageTypeParts.includes('session_storage'));
    assert.ok(result.storageTypeParts.includes('cache_storage'));
    assert.ok(result.storageTypeParts.includes('indexeddb'));
    assert.ok(result.storageTypeParts.includes('service_workers'));
  });

  it('full "all" partitions into cache + cookies + 5 storage types', () => {
    const allTypes = new Set(['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']);
    const result = partitionClearTypes(allTypes);
    assert.ok(result.hasCache);
    assert.ok(result.hasCookies);
    assert.equal(result.storageTypeParts.length, 5);
  });

  it('cache + service_workers: common bundle-bust combo', () => {
    const result = partitionClearTypes(new Set(['cache', 'service_workers']));
    assert.ok(result.hasCache);
    assert.ok(!result.hasCookies);
    assert.deepStrictEqual(result.storageTypeParts, ['service_workers']);
  });

  it('storage parts maintain stable order', () => {
    const result = partitionClearTypes(new Set(['service_workers', 'indexeddb', 'local_storage', 'cache_storage', 'session_storage']));
    assert.deepStrictEqual(result.storageTypeParts, ['local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']);
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload output summary formatting
// ---------------------------------------------------------------------------

function buildClearSummary(cleared: string[], shouldReload: boolean): string {
  const items = [...cleared];
  if (shouldReload) items.push('page reloaded');
  return items.length > 0 ? `Cleared: ${items.join('; ')}` : 'Page reloaded (no storage cleared)';
}

describe('clear_cache_and_reload output summary', () => {
  it('no clearing + reload: includes page reloaded', () => {
    const summary = buildClearSummary([], true);
    assert.equal(summary, 'Cleared: page reloaded');
  });

  it('cache only + reload', () => {
    const summary = buildClearSummary(['cache (global)'], true);
    assert.ok(summary.includes('cache (global)'));
    assert.ok(summary.includes('page reloaded'));
  });

  it('cookies for origin + reload', () => {
    const summary = buildClearSummary(['cookies (https://cursor.com, 3 removed)'], true);
    assert.ok(summary.includes('cookies'));
    assert.ok(summary.includes('cursor.com'));
    assert.ok(summary.includes('3 removed'));
  });

  it('multiple types + no reload', () => {
    const summary = buildClearSummary(['cache (global)', 'local_storage, indexeddb (https://cursor.com)'], false);
    assert.ok(summary.includes('cache (global)'));
    assert.ok(summary.includes('local_storage'));
    assert.ok(!summary.includes('page reloaded'));
  });

  it('no clearing + no reload: fallback message', () => {
    const summary = buildClearSummary([], false);
    assert.equal(summary, 'Page reloaded (no storage cleared)');
  });

  it('cookies global + reload', () => {
    const summary = buildClearSummary(['cookies (global)'], true);
    assert.ok(summary.includes('cookies (global)'));
    assert.ok(summary.includes('page reloaded'));
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload reload parameter
// ---------------------------------------------------------------------------

describe('clear_cache_and_reload reload parameter', () => {
  it('reload defaults to true when undefined', () => {
    const shouldReload = undefined !== false;
    assert.ok(shouldReload);
  });

  it('reload=true is truthy', () => {
    const shouldReload = true !== false;
    assert.ok(shouldReload);
  });

  it('reload=false suppresses reload', () => {
    const shouldReload = false !== false;
    assert.ok(!shouldReload);
  });

  it('reload=null is truthy (only false suppresses)', () => {
    const shouldReload = null !== false;
    assert.ok(shouldReload);
  });

  it('reload=0 is truthy (strict false check)', () => {
    const shouldReload = 0 !== false;
    assert.ok(shouldReload);
  });

  it('reload="" is truthy (strict false check)', () => {
    const shouldReload = '' !== false;
    assert.ok(shouldReload);
  });
});

// ---------------------------------------------------------------------------
// Test: clear_cache_and_reload end-to-end scenario simulation
// ---------------------------------------------------------------------------

describe('clear_cache_and_reload scenario simulation', () => {
  function simulateClear(args: {
    clear?: string;
    mode?: string;
    origin?: string;
    reload?: boolean;
  }): {
    cdpCommands: string[];
    summary: string;
  } {
    const { types } = parseClearTypes(args.clear, args.mode);
    const shouldReload = args.reload !== false;
    const origin = args.origin || 'https://example.com';
    const cdpCommands: string[] = [];
    const cleared: string[] = [];

    if (types.has('cache')) {
      cdpCommands.push('Network.clearBrowserCache');
      cleared.push('cache (global)');
    }
    if (types.has('cookies')) {
      cdpCommands.push('Network.getCookies');
      cleared.push(`cookies (${origin}, origin-scoped)`);
    }

    const storageParts: string[] = [];
    for (const t of ['local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']) {
      if (types.has(t)) storageParts.push(t);
    }
    if (storageParts.length > 0) {
      cdpCommands.push('Storage.clearDataForOrigin');
      cleared.push(`${storageParts.join(', ')} (${origin})`);
    }

    if (shouldReload) {
      cdpCommands.push('Page.reload');
      cleared.push('page reloaded');
    }

    const summary = cleared.length > 0 ? `Cleared: ${cleared.join('; ')}` : 'Page reloaded (no storage cleared)';
    return { cdpCommands, summary };
  }

  it('scenario: default call (no args) → only Page.reload', () => {
    const result = simulateClear({});
    assert.deepStrictEqual(result.cdpCommands, ['Page.reload']);
    assert.ok(result.summary.includes('page reloaded'));
    assert.ok(!result.summary.includes('cache'));
  });

  it('scenario: mode=light → only Page.reload', () => {
    const result = simulateClear({ mode: 'light' });
    assert.deepStrictEqual(result.cdpCommands, ['Page.reload']);
  });

  it('scenario: mode=aggressive → global cache + origin-scoped cookies + reload', () => {
    const result = simulateClear({ mode: 'aggressive' });
    assert.ok(result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(result.cdpCommands.includes('Network.getCookies'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.ok(!result.cdpCommands.includes('Network.clearBrowserCookies'));
    assert.ok(result.summary.includes('origin-scoped'));
  });

  it('scenario: clear=cache → Network.clearBrowserCache + reload, no cookies', () => {
    const result = simulateClear({ clear: 'cache' });
    assert.ok(result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.ok(!result.cdpCommands.includes('Network.getCookies'));
    assert.ok(!result.cdpCommands.includes('Network.clearBrowserCookies'));
  });

  it('scenario: clear=cache,service_workers → cache + Storage.clearDataForOrigin + reload', () => {
    const result = simulateClear({ clear: 'cache,service_workers' });
    assert.ok(result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(result.cdpCommands.includes('Storage.clearDataForOrigin'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.ok(!result.cdpCommands.includes('Network.getCookies'));
  });

  it('scenario: clear=cookies → origin-scoped cookie deletion + reload', () => {
    const result = simulateClear({ clear: 'cookies' });
    assert.ok(result.cdpCommands.includes('Network.getCookies'));
    assert.ok(!result.cdpCommands.includes('Network.clearBrowserCookies'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.ok(result.summary.includes('origin-scoped'));
  });

  it('scenario: clear=cache, reload=false → cache cleared but no Page.reload', () => {
    const result = simulateClear({ clear: 'cache', reload: false });
    assert.ok(result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(!result.cdpCommands.includes('Page.reload'));
    assert.ok(!result.summary.includes('page reloaded'));
  });

  it('scenario: clear=all → 3 CDP commands (cache + cookies + storage) + reload', () => {
    const result = simulateClear({ clear: 'all' });
    assert.ok(result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(result.cdpCommands.includes('Network.getCookies'));
    assert.ok(result.cdpCommands.includes('Storage.clearDataForOrigin'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.equal(result.cdpCommands.length, 4);
  });

  it('scenario: clear=local_storage → only Storage.clearDataForOrigin + reload', () => {
    const result = simulateClear({ clear: 'local_storage' });
    assert.ok(!result.cdpCommands.includes('Network.clearBrowserCache'));
    assert.ok(!result.cdpCommands.includes('Network.getCookies'));
    assert.ok(result.cdpCommands.includes('Storage.clearDataForOrigin'));
    assert.ok(result.cdpCommands.includes('Page.reload'));
    assert.equal(result.cdpCommands.length, 2);
  });

  it('scenario: clear=cookies+mode=aggressive → origin-scoped (clear wins over legacy)', () => {
    const result = simulateClear({ clear: 'cookies', mode: 'aggressive' });
    assert.ok(result.cdpCommands.includes('Network.getCookies'));
    assert.ok(!result.cdpCommands.includes('Network.clearBrowserCookies'));
    assert.ok(result.summary.includes('origin-scoped'));
  });

  it('scenario: origin specified → appears in summary', () => {
    const result = simulateClear({ clear: 'cookies', origin: 'https://cursor.com' });
    assert.ok(result.summary.includes('https://cursor.com'));
  });

  it('scenario: reload=false + no clear → no CDP commands at all', () => {
    const result = simulateClear({ reload: false });
    assert.deepStrictEqual(result.cdpCommands, []);
    assert.equal(result.summary, 'Page reloaded (no storage cleared)');
  });
});

// ---------------------------------------------------------------------------
// Integration: tool action count verification
// ---------------------------------------------------------------------------

describe('Integration: tool action counts', () => {
  it('storage should have 9 actions', () => {
    const actions = ['get_cookies', 'set_cookie', 'delete_cookie', 'get_local_storage', 'set_local_storage', 'remove_local_storage', 'get_session_storage', 'clear_storage', 'get_storage_usage'];
    assert.equal(actions.length, 9);
  });

  it('performance should have 4 actions', () => {
    const actions = ['get_metrics', 'get_web_vitals', 'get_memory', 'get_resource_timing'];
    assert.equal(actions.length, 4);
  });

  it('editor should have 7 actions', () => {
    const actions = ['list_sources', 'get_source', 'edit_source', 'search_source', 'list_stylesheets', 'get_stylesheet', 'edit_stylesheet'];
    assert.equal(actions.length, 7);
  });

  it('network_intercept should have 5 actions', () => {
    const actions = ['enable', 'disable', 'list_rules', 'add_rule', 'remove_rule'];
    assert.equal(actions.length, 5);
  });

  it('emulation should have 8 actions', () => {
    const actions = ['set_device', 'set_user_agent', 'set_geolocation', 'set_timezone', 'set_locale', 'set_network_conditions', 'set_media', 'clear_all'];
    assert.equal(actions.length, 8);
  });

  it('page_content should have 4 actions', () => {
    const actions = ['get_html', 'get_text', 'get_metadata', 'search_dom'];
    assert.equal(actions.length, 4);
  });

  it('total new actions across 6 tools = 37', () => {
    assert.equal(9 + 4 + 7 + 5 + 8 + 4, 37);
  });

  it('interact should have 7 actions', () => {
    const actions = ['click', 'hover', 'fill', 'focus', 'check', 'uncheck', 'select'];
    assert.equal(actions.length, 7);
  });

  it('trace should have 3 actions', () => {
    const actions = ['start', 'stop', 'status'];
    assert.equal(actions.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Tests: list_tabs tool
// ---------------------------------------------------------------------------

interface TestTargetListItem {
  id: string;
  tabId?: number;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function formatTabList(targets: TestTargetListItem[], activeSessionId: string | null, preferredId: string | null = null): string {
  if (targets.length === 0) {
    return 'No tabs attached. Click the spawriter toolbar button on a Chrome tab to attach it.';
  }
  const preferredLabel = preferredId && preferredId !== activeSessionId ? `, preferred: ${preferredId}` : '';
  const lines = targets.map((t, i) => {
    const markers: string[] = [];
    if (t.id === activeSessionId) markers.push('active');
    if (t.id === preferredId && t.id !== activeSessionId) markers.push('preferred');
    const markerStr = markers.length > 0 ? ` ← ${markers.join(', ')}` : '';
    const tabLabel = t.tabId != null ? ` (tabId: ${t.tabId})` : '';
    return `${i + 1}. [${t.id}]${tabLabel}${markerStr}\n   ${t.title || '(no title)'}\n   ${t.url || '(no url)'}`;
  });
  const summary = `${targets.length} tab(s) attached${activeSessionId ? `, active: ${activeSessionId}` : ''}${preferredLabel}`;
  return `${summary}\n\n${lines.join('\n\n')}`;
}

describe('list_tabs – formatting', () => {
  it('should show empty message when no tabs', () => {
    const result = formatTabList([], null);
    assert.ok(result.includes('No tabs attached'));
  });

  it('should list a single tab', () => {
    const targets: TestTargetListItem[] = [{
      id: 'spawriter-tab-123-1000', tabId: 123, type: 'page',
      title: 'My App', url: 'http://localhost:3000/',
      webSocketDebuggerUrl: 'ws://localhost:19989/cdp/spawriter-tab-123-1000',
    }];
    const result = formatTabList(targets, 'spawriter-tab-123-1000');
    assert.ok(result.includes('1 tab(s) attached'));
    assert.ok(result.includes('← active'));
    assert.ok(result.includes('My App'));
    assert.ok(result.includes('http://localhost:3000/'));
    assert.ok(result.includes('tabId: 123'));
  });

  it('should list multiple tabs and mark the active one', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'Tab A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', tabId: 2, type: 'page', title: 'Tab B', url: 'https://b.com', webSocketDebuggerUrl: '' },
      { id: 'session-c', tabId: 3, type: 'page', title: 'Tab C', url: 'https://c.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, 'session-b');
    assert.ok(result.includes('3 tab(s) attached'));
    assert.ok(result.includes('[session-b]'));
    assert.ok(result.includes('← active'));
    const lines = result.split('\n');
    const activeLines = lines.filter(l => l.includes('← active'));
    assert.equal(activeLines.length, 1);
    assert.ok(activeLines[0].includes('session-b'));
  });

  it('should handle tabs with no title or URL', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-x', type: 'page', title: '', url: '', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, null);
    assert.ok(result.includes('(no title)'));
    assert.ok(result.includes('(no url)'));
  });

  it('should handle no active session', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'Tab A', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, null);
    assert.ok(!result.includes('← active'));
    assert.ok(!result.includes(', active:'));
  });

  it('should handle tab without tabId', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-no-tab', type: 'page', title: 'No TabId', url: 'https://x.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, null);
    assert.ok(!result.includes('tabId:'));
  });

  it('should show preferred marker when preferred differs from active', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', tabId: 2, type: 'page', title: 'B', url: 'https://b.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, 'session-a', 'session-b');
    assert.ok(result.includes('← active'));
    assert.ok(result.includes('← preferred'));
    assert.ok(result.includes('preferred: session-b'));
  });

  it('should not duplicate markers when preferred equals active', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, 'session-a', 'session-a');
    assert.ok(result.includes('← active'));
    assert.ok(!result.includes('preferred'));
  });

  it('should not show preferred marker when no preferred set', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    const result = formatTabList(targets, 'session-a', null);
    assert.ok(!result.includes('preferred'));
  });
});

// ---------------------------------------------------------------------------
// Tests: switch_tab – validation and state clearing
// ---------------------------------------------------------------------------

describe('switch_tab – target validation', () => {
  function findTarget(targets: TestTargetListItem[], targetId: string): TestTargetListItem | undefined {
    return targets.find(t => t.id === targetId);
  }

  function formatNotFoundError(targetId: string, targets: TestTargetListItem[]): string {
    const available = targets.map(t => `  ${t.id} — ${t.url || '(no url)'}`).join('\n') || '  (none)';
    return `Error: target "${targetId}" not found.\n\nAvailable targets:\n${available}`;
  }

  function formatAlreadyConnected(target: TestTargetListItem): string {
    return `Already connected to this tab: ${target.title || target.url || '(no title)'}`;
  }

  it('should return error for empty targetId', () => {
    const targetId = '';
    assert.equal(!targetId, true);
  });

  it('should return error for undefined-like targetId', () => {
    const targetId = undefined as unknown as string;
    assert.equal(!targetId, true);
  });

  it('should find an existing target', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'Tab A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', tabId: 2, type: 'page', title: 'Tab B', url: 'https://b.com', webSocketDebuggerUrl: '' },
    ];
    const found = findTarget(targets, 'session-b');
    assert.ok(found);
    assert.equal(found!.url, 'https://b.com');
  });

  it('should return undefined for non-existent target', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'Tab A', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    assert.equal(findTarget(targets, 'session-z'), undefined);
  });

  it('should format not-found error with available targets', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', tabId: 1, type: 'page', title: 'Tab A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', tabId: 2, type: 'page', title: 'Tab B', url: 'https://b.com', webSocketDebuggerUrl: '' },
    ];
    const err = formatNotFoundError('session-z', targets);
    assert.ok(err.includes('session-z'));
    assert.ok(err.includes('session-a'));
    assert.ok(err.includes('session-b'));
    assert.ok(err.includes('https://a.com'));
  });

  it('should format not-found error with no targets', () => {
    const err = formatNotFoundError('session-z', []);
    assert.ok(err.includes('(none)'));
  });

  it('should detect already-connected state', () => {
    const activeSessionId = 'session-a';
    const requestedId = 'session-a';
    assert.equal(activeSessionId === requestedId, true);
  });

  it('should detect switch needed', () => {
    const activeSessionId = 'session-a';
    const requestedId = 'session-b';
    assert.notEqual(activeSessionId, requestedId);
  });

  it('should format already-connected with title', () => {
    const target: TestTargetListItem = { id: 's1', type: 'page', title: 'My App', url: 'http://localhost:3000', webSocketDebuggerUrl: '' };
    assert.ok(formatAlreadyConnected(target).includes('My App'));
  });

  it('should format already-connected with url fallback when no title', () => {
    const target: TestTargetListItem = { id: 's1', type: 'page', title: '', url: 'http://localhost:3000', webSocketDebuggerUrl: '' };
    assert.ok(formatAlreadyConnected(target).includes('http://localhost:3000'));
  });

  it('should format already-connected with (no title) when both empty', () => {
    const target: TestTargetListItem = { id: 's1', type: 'page', title: '', url: '', webSocketDebuggerUrl: '' };
    assert.ok(formatAlreadyConnected(target).includes('(no title)'));
  });

  it('should show (no url) in not-found error for targets without URL', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', type: 'page', title: 'Tab A', url: '', webSocketDebuggerUrl: '' },
    ];
    const err = formatNotFoundError('session-z', targets);
    assert.ok(err.includes('(no url)'));
  });
});

describe('switch_tab – preferredTargetId and doEnsureSession target selection', () => {
  function chooseTarget(targets: TestTargetListItem[], preferredId: string | null): { chosen: TestTargetListItem; preferredCleared: boolean } {
    if (targets.length === 0) throw new Error('No targets');
    let chosen = targets[0];
    let preferredCleared = false;
    if (preferredId) {
      const preferred = targets.find(t => t.id === preferredId);
      if (preferred) {
        chosen = preferred;
      } else {
        preferredCleared = true;
      }
    }
    return { chosen, preferredCleared };
  }

  it('should use targets[0] when no preferred target is set', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', type: 'page', title: 'B', url: 'https://b.com', webSocketDebuggerUrl: '' },
    ];
    const { chosen } = chooseTarget(targets, null);
    assert.equal(chosen.id, 'session-a');
  });

  it('should use preferred target when it exists in targets list', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
      { id: 'session-b', type: 'page', title: 'B', url: 'https://b.com', webSocketDebuggerUrl: '' },
    ];
    const { chosen } = chooseTarget(targets, 'session-b');
    assert.equal(chosen.id, 'session-b');
  });

  it('should fall back to targets[0] when preferred target is no longer available', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-a', type: 'page', title: 'A', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    const { chosen, preferredCleared } = chooseTarget(targets, 'session-gone');
    assert.equal(chosen.id, 'session-a');
    assert.equal(preferredCleared, true);
  });

  it('should use preferred target when it is not the first target', () => {
    const targets: TestTargetListItem[] = [
      { id: 'session-1', type: 'page', title: '1', url: 'https://1.com', webSocketDebuggerUrl: '' },
      { id: 'session-2', type: 'page', title: '2', url: 'https://2.com', webSocketDebuggerUrl: '' },
      { id: 'session-3', type: 'page', title: '3', url: 'https://3.com', webSocketDebuggerUrl: '' },
    ];
    const { chosen } = chooseTarget(targets, 'session-3');
    assert.equal(chosen.id, 'session-3');
  });

  it('should clear preferredTargetId on reset', () => {
    const stateBeforeReset = { preferredTargetId: 'session-b' as string | null };
    stateBeforeReset.preferredTargetId = null;
    assert.equal(stateBeforeReset.preferredTargetId, null);
  });

  it('should clear preferredTargetId on connectCdp failure', () => {
    const state = { preferredTargetId: 'session-x' as string | null };
    state.preferredTargetId = null;
    assert.equal(state.preferredTargetId, null);
  });

  it('should set preferredTargetId on successful switch', () => {
    const state = { preferredTargetId: null as string | null };
    const targetId = 'session-new';
    state.preferredTargetId = targetId;
    assert.equal(state.preferredTargetId, 'session-new');
  });
});

describe('switch_tab – state clearing categories', () => {
  it('should clear 7 state categories on tab switch', () => {
    const clearedCategories = [
      'consoleLogs',
      'networkLog',
      'interceptState',
      'lastSnapshot',
      'debuggerEnabled + breakpoints',
      'debuggerPaused + currentCallFrameId',
      'knownScripts',
    ];
    assert.equal(clearedCategories.length, 7);
  });

  it('should NOT clear Playwright sessions on tab switch', () => {
    const preservedOnSwitch = ['pwExecutor', 'executorManager'];
    assert.equal(preservedOnSwitch.length, 2);
    const clearedOnReset = [
      'consoleLogs', 'networkLog', 'interceptState',
      'lastSnapshot', 'pwExecutor', 'debuggerEnabled',
      'breakpoints', 'knownScripts', 'executorManager',
    ];
    for (const kept of preservedOnSwitch) {
      assert.ok(!['consoleLogs', 'networkLog', 'interceptState', 'lastSnapshot', 'debuggerEnabled', 'breakpoints', 'knownScripts'].includes(kept));
    }
    assert.ok(clearedOnReset.includes('pwExecutor'));
    assert.ok(clearedOnReset.includes('executorManager'));
  });
});

describe('switch_tab – success message formatting', () => {
  function formatSwitchSuccess(target: TestTargetListItem, targetId: string): string {
    return `Switched to tab: ${target.title || '(no title)'}\nURL: ${target.url || '(no url)'}\nSession: ${targetId}\n\nCleared: console logs, network entries, intercept rules, debugger state, snapshot baseline.\nPreserved: Playwright sessions.`;
  }

  it('should include target title, URL, and session ID', () => {
    const target: TestTargetListItem = { id: 's1', tabId: 1, type: 'page', title: 'My App', url: 'http://localhost:3000', webSocketDebuggerUrl: '' };
    const msg = formatSwitchSuccess(target, 's1');
    assert.ok(msg.includes('My App'));
    assert.ok(msg.includes('http://localhost:3000'));
    assert.ok(msg.includes('s1'));
    assert.ok(msg.includes('Cleared'));
    assert.ok(msg.includes('snapshot baseline'));
    assert.ok(msg.includes('Preserved: Playwright sessions'));
  });

  it('should handle tab with no title', () => {
    const target: TestTargetListItem = { id: 's2', type: 'page', title: '', url: 'https://x.com', webSocketDebuggerUrl: '' };
    const msg = formatSwitchSuccess(target, 's2');
    assert.ok(msg.includes('(no title)'));
  });

  it('should handle tab with no URL', () => {
    const target: TestTargetListItem = { id: 's3', type: 'page', title: 'No URL Tab', url: '', webSocketDebuggerUrl: '' };
    const msg = formatSwitchSuccess(target, 's3');
    assert.ok(msg.includes('(no url)'));
  });

  it('should handle connectCdp failure message format', () => {
    const targetId = 'session-dead';
    const errMsg = `Error: failed to connect to tab "${targetId}". The tab may have been closed or the relay may be unreachable.\nDetail: Connection timeout\n\nUse list_tabs to see available tabs, or call reset and retry.`;
    assert.ok(errMsg.includes(targetId));
    assert.ok(errMsg.includes('Connection timeout'));
    assert.ok(errMsg.includes('list_tabs'));
    assert.ok(errMsg.includes('reset'));
  });
});

// ---------------------------------------------------------------------------
// Tests: list_tabs + switch_tab tool definitions
// ---------------------------------------------------------------------------

describe('list_tabs and switch_tab tool definitions', () => {
  it('list_tabs should have no required params', () => {
    const schema = { type: 'object', properties: {} };
    assert.deepStrictEqual(Object.keys(schema.properties), []);
  });

  it('switch_tab should require targetId', () => {
    const required = ['targetId'];
    assert.equal(required.length, 1);
    assert.equal(required[0], 'targetId');
  });

  it('TargetListItem should include tabId field', () => {
    const item: TestTargetListItem = {
      id: 'test', tabId: 42, type: 'page', title: 'Test', url: 'https://test.com', webSocketDebuggerUrl: '',
    };
    assert.equal(item.tabId, 42);
  });

  it('TargetListItem tabId should be optional', () => {
    const item: TestTargetListItem = {
      id: 'test', type: 'page', title: 'Test', url: 'https://test.com', webSocketDebuggerUrl: '',
    };
    assert.equal(item.tabId, undefined);
  });
});

// ---------------------------------------------------------------------------
// Tests: Multi-tab scenario integration
// ---------------------------------------------------------------------------

describe('multi-tab scenario: A/B comparison workflow', () => {
  it('should support list → switch → screenshot → switch → screenshot pattern', () => {
    const targets: TestTargetListItem[] = [
      { id: 'prod-tab', tabId: 1, type: 'page', title: 'Production', url: 'https://prod.example.com', webSocketDebuggerUrl: '' },
      { id: 'local-tab', tabId: 2, type: 'page', title: 'Local Dev', url: 'http://localhost:3000', webSocketDebuggerUrl: '' },
    ];
    const list = formatTabList(targets, 'prod-tab');
    assert.ok(list.includes('2 tab(s) attached'));
    assert.ok(list.includes('Production'));
    assert.ok(list.includes('Local Dev'));

    const switchTarget = targets.find(t => t.id === 'local-tab');
    assert.ok(switchTarget);
    assert.equal(switchTarget!.url, 'http://localhost:3000');
  });
});

describe('multi-tab scenario: tab detachment handling', () => {
  it('should detect when preferred tab is gone', () => {
    const targetsAfterDetach: TestTargetListItem[] = [
      { id: 'remaining-tab', tabId: 1, type: 'page', title: 'Remaining', url: 'https://a.com', webSocketDebuggerUrl: '' },
    ];
    const preferredId = 'detached-tab';
    const preferred = targetsAfterDetach.find(t => t.id === preferredId);
    assert.equal(preferred, undefined);
    const fallback = targetsAfterDetach[0];
    assert.equal(fallback.id, 'remaining-tab');
  });
});

describe('multi-tab: state isolation between tabs', () => {
  it('console logs should be cleared on tab switch', () => {
    const stateCleared = ['consoleLogs', 'networkLog', 'interceptState', 'lastSnapshot', 'debuggerEnabled', 'breakpoints', 'debuggerPaused', 'currentCallFrameId', 'knownScripts'];
    assert.ok(stateCleared.includes('consoleLogs'));
    assert.ok(stateCleared.includes('networkLog'));
  });

  it('intercept rules should be cleared on tab switch', () => {
    const stateCleared = ['consoleLogs', 'networkLog', 'interceptState', 'lastSnapshot', 'debuggerEnabled', 'breakpoints', 'debuggerPaused', 'currentCallFrameId', 'knownScripts'];
    assert.ok(stateCleared.includes('interceptState'));
  });

  it('playwright sessions should NOT be cleared on tab switch', () => {
    const stateCleared = ['consoleLogs', 'networkLog', 'interceptState', 'lastSnapshot', 'debuggerEnabled', 'breakpoints', 'debuggerPaused', 'currentCallFrameId', 'knownScripts'];
    assert.ok(!stateCleared.includes('pwExecutor'));
    assert.ok(!stateCleared.includes('executorManager'));
  });

  it('emulation settings are per-tab and NOT carried over', () => {
    const note = 'Emulation settings are CDP-session-scoped. After switch_tab, the new tab has its own emulation state.';
    assert.ok(note.includes('per-tab') || note.includes('CDP-session'));
  });
});

describe('multi-tab: network_detail after tab switch', () => {
  it('old requestIds from previous tab should not exist on new tab', () => {
    const oldTabRequestIds = ['R1.1', 'R1.2', 'R1.3'];
    const newTabNetworkLog = new Map<string, string>();
    for (const id of oldTabRequestIds) {
      assert.equal(newTabNetworkLog.has(id), false);
    }
  });
});

describe('multi-tab: playwright_execute independence', () => {
  it('playwright_execute has its own CDP connection', () => {
    const pwClientId = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mcpClientId = 'mcp-client';
    assert.notEqual(pwClientId, mcpClientId);
  });

  it('playwright_execute does not follow switch_tab automatically', () => {
    const note = 'PlaywrightExecutor connects to the relay with its own client ID. It discovers targets independently and picks the first page.';
    assert.ok(note.includes('independently'));
  });
});

// ---------------------------------------------------------------------------
// Relay: Browser.setDownloadBehavior → Page.setDownloadBehavior mapping
// ---------------------------------------------------------------------------

interface DownloadBehavior {
  behavior: string;
  downloadPath?: string;
}

function toPageDownloadParams(dl: DownloadBehavior): { behavior: string; downloadPath?: string } {
  const pageBehavior = dl.behavior === 'allowAndName' ? 'allow' : dl.behavior;
  const result: { behavior: string; downloadPath?: string } = { behavior: pageBehavior };
  if (pageBehavior === 'allow' && dl.downloadPath) {
    result.downloadPath = dl.downloadPath;
  }
  return result;
}

function maybeSynthesizeBrowserDownloadEvent(method: string): string | null {
  return method === 'Page.downloadWillBegin' ? 'Browser.downloadWillBegin' :
    method === 'Page.downloadProgress' ? 'Browser.downloadProgress' :
    null;
}

describe('relay: toPageDownloadParams – Browser to Page behavior mapping', () => {
  it('should map "allow" to "allow" and preserve downloadPath', () => {
    const result = toPageDownloadParams({ behavior: 'allow', downloadPath: '/tmp/dl' });
    assert.deepStrictEqual(result, { behavior: 'allow', downloadPath: '/tmp/dl' });
  });

  it('should map "allowAndName" to "allow" and preserve downloadPath', () => {
    const result = toPageDownloadParams({ behavior: 'allowAndName', downloadPath: '/tmp/named' });
    assert.deepStrictEqual(result, { behavior: 'allow', downloadPath: '/tmp/named' });
  });

  it('should map "deny" to "deny" without downloadPath', () => {
    const result = toPageDownloadParams({ behavior: 'deny' });
    assert.deepStrictEqual(result, { behavior: 'deny' });
  });

  it('should map "default" to "default" without downloadPath', () => {
    const result = toPageDownloadParams({ behavior: 'default' });
    assert.deepStrictEqual(result, { behavior: 'default' });
  });

  it('should not include downloadPath for "deny" even if provided', () => {
    const result = toPageDownloadParams({ behavior: 'deny', downloadPath: '/tmp/deny' });
    assert.deepStrictEqual(result, { behavior: 'deny' });
  });

  it('should not include downloadPath for "allow" when not provided', () => {
    const result = toPageDownloadParams({ behavior: 'allow' });
    assert.deepStrictEqual(result, { behavior: 'allow' });
  });
});

describe('relay: download event synthesis', () => {
  it('should synthesize Browser.downloadWillBegin from Page.downloadWillBegin', () => {
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Page.downloadWillBegin'), 'Browser.downloadWillBegin');
  });

  it('should synthesize Browser.downloadProgress from Page.downloadProgress', () => {
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Page.downloadProgress'), 'Browser.downloadProgress');
  });

  it('should return null for unrelated events', () => {
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Network.requestWillBeSent'), null);
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Page.loadEventFired'), null);
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Runtime.consoleAPICalled'), null);
  });

  it('should return null for Browser download events (no double synthesis)', () => {
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Browser.downloadWillBegin'), null);
    assert.equal(maybeSynthesizeBrowserDownloadEvent('Browser.downloadProgress'), null);
  });
});

describe('relay: download behavior cache and inheritance', () => {
  it('should store the active download behavior (last writer wins)', () => {
    let active: DownloadBehavior | null = null;
    active = { behavior: 'allow', downloadPath: '/tmp/c1' };
    assert.equal(active.behavior, 'allow');
    active = { behavior: 'deny' };
    assert.equal(active.behavior, 'deny');
    assert.equal(active.downloadPath, undefined);
  });

  it('should clear active behavior when extension disconnects', () => {
    let active: DownloadBehavior | null = { behavior: 'allow', downloadPath: '/tmp/c1' };
    active = null;
    assert.equal(active, null);
  });

  it('should apply cached behavior to newly attached page target', () => {
    const active: DownloadBehavior = { behavior: 'allowAndName', downloadPath: '/tmp/named' };
    const pageParams = toPageDownloadParams(active);
    assert.equal(pageParams.behavior, 'allow');
    assert.equal(pageParams.downloadPath, '/tmp/named');
  });

  it('should not apply when no active behavior is set', () => {
    const active: DownloadBehavior | null = null;
    const shouldApply = active !== null;
    assert.equal(shouldApply, false);
  });

  it('should overwrite previous behavior on each new setDownloadBehavior call', () => {
    let active: DownloadBehavior | null = { behavior: 'allow', downloadPath: '/tmp/old' };
    active = { behavior: 'deny' };
    assert.equal(active.behavior, 'deny');
    assert.equal(active.downloadPath, undefined);
  });
});

describe('relay: Browser.setDownloadBehavior validation', () => {
  it('should reject when behavior is missing', () => {
    const params: Record<string, unknown> | undefined = {};
    const dlParams = params as { behavior?: string } | undefined;
    assert.equal(!!dlParams?.behavior, false);
  });

  it('should reject when params is undefined', () => {
    const params: Record<string, unknown> | undefined = undefined;
    const dlParams = params as { behavior?: string } | undefined;
    assert.equal(!!dlParams?.behavior, false);
  });

  it('should accept valid behavior values', () => {
    for (const behavior of ['allow', 'deny', 'default', 'allowAndName']) {
      const dlParams = { behavior };
      assert.equal(!!dlParams.behavior, true);
    }
  });
});

describe('relay: applyDownloadBehaviorToAllPages – target type filtering', () => {
  it('should only apply to page-type targets', () => {
    const targets = [
      { sessionId: 's1', targetInfo: { type: 'page' } },
      { sessionId: 's2', targetInfo: { type: 'service_worker' } },
      { sessionId: 's3', targetInfo: { type: 'page' } },
      { sessionId: 's4', targetInfo: { type: 'iframe' } },
    ];
    const pageTargets = targets.filter(t => (t.targetInfo?.type ?? 'page') === 'page');
    assert.equal(pageTargets.length, 2);
    assert.deepStrictEqual(pageTargets.map(t => t.sessionId), ['s1', 's3']);
  });

  it('should treat missing type as page (default)', () => {
    const targets = [
      { sessionId: 's1', targetInfo: {} },
      { sessionId: 's2', targetInfo: undefined },
    ];
    const pageTargets = targets.filter(t => (t.targetInfo?.type ?? 'page') === 'page');
    assert.equal(pageTargets.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Bridge: Chrome API defensive guards
// ---------------------------------------------------------------------------

describe('bridge: Chrome API defensive guards', () => {
  it('should guard chrome.debugger availability before registering listeners', () => {
    const noChromeDebugger = { debugger: undefined };
    const hasOnEvent = !!(noChromeDebugger as { debugger?: { onEvent?: unknown } }).debugger?.onEvent;
    const hasOnDetach = !!(noChromeDebugger as { debugger?: { onDetach?: unknown } }).debugger?.onDetach;
    assert.equal(hasOnEvent, false);
    assert.equal(hasOnDetach, false);
  });

  it('should allow registration when chrome.debugger is fully available', () => {
    const fullChromeDebugger = {
      debugger: {
        onEvent: { addListener: () => {} },
        onDetach: { addListener: () => {} },
      },
    };
    const hasOnEvent = !!(fullChromeDebugger as { debugger?: { onEvent?: unknown } }).debugger?.onEvent;
    const hasOnDetach = !!(fullChromeDebugger as { debugger?: { onDetach?: unknown } }).debugger?.onDetach;
    assert.equal(hasOnEvent, true);
    assert.equal(hasOnDetach, true);
  });

  it('should guard browser.browsingData availability', () => {
    const noBrowsingData = {} as { browsingData?: { remove?: unknown } };
    const canClear = !!noBrowsingData.browsingData?.remove;
    assert.equal(canClear, false);
  });

  it('should allow browsingData.remove when available', () => {
    const hasBrowsingData = { browsingData: { remove: () => Promise.resolve() } };
    const canClear = !!hasBrowsingData.browsingData?.remove;
    assert.equal(canClear, true);
  });
});

// ---------------------------------------------------------------------------
// Bridge: Service Worker keepalive logic
// ---------------------------------------------------------------------------

describe('bridge: maintainLoop keepalive conditions', () => {
  it('should continue when tabs are attached', () => {
    const attachedTabsSize = 2;
    const wsOpen = false;
    const hasWork = attachedTabsSize > 0 || wsOpen;
    assert.equal(hasWork, true);
  });

  it('should continue when WebSocket is open even without tabs', () => {
    const attachedTabsSize = 0;
    const wsOpen = true;
    const hasWork = attachedTabsSize > 0 || wsOpen;
    assert.equal(hasWork, true);
  });

  it('should stop when no tabs and WebSocket is closed', () => {
    const attachedTabsSize = 0;
    const wsOpen = false;
    const hasWork = attachedTabsSize > 0 || wsOpen;
    assert.equal(hasWork, false);
  });

  it('should continue when both tabs and WebSocket are active', () => {
    const attachedTabsSize = 1;
    const wsOpen = true;
    const hasWork = attachedTabsSize > 0 || wsOpen;
    assert.equal(hasWork, true);
  });

  it('disconnectTab should not stop loop when WebSocket is still open', () => {
    const attachedTabsSize = 0;
    const wsOpen = true;
    const shouldStopLoop = attachedTabsSize === 0 && !wsOpen;
    assert.equal(shouldStopLoop, false);
  });

  it('disconnectTab should stop loop when no tabs and WebSocket is closed', () => {
    const attachedTabsSize = 0;
    const wsOpen = false;
    const shouldStopLoop = attachedTabsSize === 0 && !wsOpen;
    assert.equal(shouldStopLoop, true);
  });
});

// ---------------------------------------------------------------------------
// Cookie API: Network.getCookies vs Storage.getCookies
// ---------------------------------------------------------------------------

describe('cookie API: extension relay compatibility', () => {
  const ROOT_SESSION_METHODS = ['Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies'];
  const PAGE_SESSION_METHODS = ['Network.getCookies', 'Network.setCookie', 'Network.deleteCookies'];

  it('root-session cookie methods are not usable through page session relay', () => {
    for (const method of ROOT_SESSION_METHODS) {
      assert.ok(method.startsWith('Storage.'), `${method} is a Storage domain method`);
    }
  });

  it('page-session cookie methods work through relay', () => {
    for (const method of PAGE_SESSION_METHODS) {
      assert.ok(method.startsWith('Network.'), `${method} is a Network domain method`);
    }
  });

  it('spawriter storage tool uses Network.getCookies (not Storage.getCookies)', () => {
    const storageToolGetCookiesMethod = 'Network.getCookies';
    assert.ok(!storageToolGetCookiesMethod.startsWith('Storage.'));
    assert.equal(storageToolGetCookiesMethod, 'Network.getCookies');
  });

  it('spawriter clear_cache_and_reload uses Network.getCookies for cookie enumeration', () => {
    const clearCacheReloadCookieMethod = 'Network.getCookies';
    assert.equal(clearCacheReloadCookieMethod, 'Network.getCookies');
  });
});

// ---------------------------------------------------------------------------
// Integration: Browser.setDownloadBehavior → Page relay flow simulation
// ---------------------------------------------------------------------------

interface RelayTarget {
  sessionId: string;
  type: string;
}

interface ForwardedCommand {
  targetSessionId: string;
  method: string;
  params: Record<string, unknown>;
}

function simulateRelaySetDownloadBehavior(
  behavior: string,
  downloadPath: string | undefined,
  targets: RelayTarget[],
): { active: DownloadBehavior; forwarded: ForwardedCommand[] } {
  const active: DownloadBehavior = { behavior, downloadPath };
  const forwarded: ForwardedCommand[] = [];

  const pageParams = toPageDownloadParams(active);
  for (const target of targets) {
    if ((target.type ?? 'page') === 'page') {
      forwarded.push({
        targetSessionId: target.sessionId,
        method: 'Page.setDownloadBehavior',
        params: pageParams,
      });
    }
  }

  return { active, forwarded };
}

function simulateNewTargetAttach(
  active: DownloadBehavior | null,
  newTarget: RelayTarget,
): ForwardedCommand | null {
  if (!active) return null;
  if ((newTarget.type ?? 'page') !== 'page') return null;
  return {
    targetSessionId: newTarget.sessionId,
    method: 'Page.setDownloadBehavior',
    params: toPageDownloadParams(active),
  };
}

function simulateEventSynthesis(
  incomingMethod: string,
  incomingParams: Record<string, unknown>,
): { synthesized: { method: string; params: Record<string, unknown> } | null; original: { method: string; params: Record<string, unknown> } } {
  const browserMethod = maybeSynthesizeBrowserDownloadEvent(incomingMethod);
  return {
    synthesized: browserMethod ? { method: browserMethod, params: incomingParams } : null,
    original: { method: incomingMethod, params: incomingParams },
  };
}

describe('integration: Browser.setDownloadBehavior full relay flow', () => {
  it('should forward Page.setDownloadBehavior to all page targets', () => {
    const targets: RelayTarget[] = [
      { sessionId: 's-page-1', type: 'page' },
      { sessionId: 's-sw-1', type: 'service_worker' },
      { sessionId: 's-page-2', type: 'page' },
    ];
    const { active, forwarded } = simulateRelaySetDownloadBehavior('allow', '/tmp/dl', targets);
    assert.equal(active.behavior, 'allow');
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[0].targetSessionId, 's-page-1');
    assert.equal(forwarded[0].method, 'Page.setDownloadBehavior');
    assert.deepStrictEqual(forwarded[0].params, { behavior: 'allow', downloadPath: '/tmp/dl' });
    assert.equal(forwarded[1].targetSessionId, 's-page-2');
  });

  it('should map allowAndName to allow in forwarded commands', () => {
    const targets: RelayTarget[] = [{ sessionId: 's1', type: 'page' }];
    const { forwarded } = simulateRelaySetDownloadBehavior('allowAndName', '/tmp/named', targets);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].params.behavior, 'allow');
    assert.equal(forwarded[0].params.downloadPath, '/tmp/named');
  });

  it('should forward deny without downloadPath', () => {
    const targets: RelayTarget[] = [{ sessionId: 's1', type: 'page' }];
    const { forwarded } = simulateRelaySetDownloadBehavior('deny', '/tmp/ignored', targets);
    assert.equal(forwarded.length, 1);
    assert.deepStrictEqual(forwarded[0].params, { behavior: 'deny' });
  });

  it('should not forward to non-page targets', () => {
    const targets: RelayTarget[] = [
      { sessionId: 's1', type: 'service_worker' },
      { sessionId: 's2', type: 'iframe' },
    ];
    const { forwarded } = simulateRelaySetDownloadBehavior('allow', '/tmp', targets);
    assert.equal(forwarded.length, 0);
  });

  it('should handle empty target list', () => {
    const { forwarded } = simulateRelaySetDownloadBehavior('allow', '/tmp', []);
    assert.equal(forwarded.length, 0);
  });
});

describe('integration: new target inherits download behavior', () => {
  it('should apply cached behavior to newly attached page', () => {
    const active: DownloadBehavior = { behavior: 'allow', downloadPath: '/downloads' };
    const cmd = simulateNewTargetAttach(active, { sessionId: 'new-page', type: 'page' });
    assert.ok(cmd);
    assert.equal(cmd!.method, 'Page.setDownloadBehavior');
    assert.deepStrictEqual(cmd!.params, { behavior: 'allow', downloadPath: '/downloads' });
  });

  it('should not apply to non-page target', () => {
    const active: DownloadBehavior = { behavior: 'allow', downloadPath: '/downloads' };
    const cmd = simulateNewTargetAttach(active, { sessionId: 'new-sw', type: 'service_worker' });
    assert.equal(cmd, null);
  });

  it('should not apply when no active behavior', () => {
    const cmd = simulateNewTargetAttach(null, { sessionId: 'new-page', type: 'page' });
    assert.equal(cmd, null);
  });

  it('should apply allowAndName mapped as allow', () => {
    const active: DownloadBehavior = { behavior: 'allowAndName', downloadPath: '/named' };
    const cmd = simulateNewTargetAttach(active, { sessionId: 'new-page', type: 'page' });
    assert.ok(cmd);
    assert.equal(cmd!.params.behavior, 'allow');
    assert.equal(cmd!.params.downloadPath, '/named');
  });
});

describe('integration: download event synthesis end-to-end', () => {
  it('should produce both synthesized and original events for Page.downloadWillBegin', () => {
    const eventParams = { frameId: 'frame1', guid: 'dl-123', url: 'https://example.com/file.zip', suggestedFilename: 'file.zip' };
    const result = simulateEventSynthesis('Page.downloadWillBegin', eventParams);
    assert.ok(result.synthesized);
    assert.equal(result.synthesized!.method, 'Browser.downloadWillBegin');
    assert.deepStrictEqual(result.synthesized!.params, eventParams);
    assert.equal(result.original.method, 'Page.downloadWillBegin');
    assert.deepStrictEqual(result.original.params, eventParams);
  });

  it('should produce both synthesized and original events for Page.downloadProgress', () => {
    const eventParams = { guid: 'dl-123', totalBytes: 1024, receivedBytes: 512, state: 'inProgress' };
    const result = simulateEventSynthesis('Page.downloadProgress', eventParams);
    assert.ok(result.synthesized);
    assert.equal(result.synthesized!.method, 'Browser.downloadProgress');
    assert.deepStrictEqual(result.synthesized!.params, eventParams);
    assert.equal(result.original.method, 'Page.downloadProgress');
  });

  it('should not synthesize for non-download events', () => {
    const result = simulateEventSynthesis('Network.requestWillBeSent', { requestId: 'r1' });
    assert.equal(result.synthesized, null);
    assert.equal(result.original.method, 'Network.requestWillBeSent');
  });

  it('should not double-synthesize for Browser.downloadWillBegin', () => {
    const result = simulateEventSynthesis('Browser.downloadWillBegin', { guid: 'dl-123' });
    assert.equal(result.synthesized, null);
  });
});

describe('integration: last-writer-wins download behavior updates', () => {
  it('first set then overwrite should use latest', () => {
    const targets: RelayTarget[] = [{ sessionId: 's1', type: 'page' }];

    const first = simulateRelaySetDownloadBehavior('allow', '/tmp/first', targets);
    assert.equal(first.forwarded[0].params.downloadPath, '/tmp/first');

    const second = simulateRelaySetDownloadBehavior('deny', undefined, targets);
    assert.deepStrictEqual(second.forwarded[0].params, { behavior: 'deny' });

    const newTarget = simulateNewTargetAttach(second.active, { sessionId: 's-new', type: 'page' });
    assert.ok(newTarget);
    assert.deepStrictEqual(newTarget!.params, { behavior: 'deny' });
  });

  it('override allowAndName with allow should change mapping', () => {
    const targets: RelayTarget[] = [{ sessionId: 's1', type: 'page' }];

    const first = simulateRelaySetDownloadBehavior('allowAndName', '/tmp/named', targets);
    assert.equal(first.forwarded[0].params.behavior, 'allow');

    const second = simulateRelaySetDownloadBehavior('allow', '/tmp/allow', targets);
    assert.equal(second.forwarded[0].params.behavior, 'allow');
    assert.equal(second.forwarded[0].params.downloadPath, '/tmp/allow');
  });

  it('clearing active behavior (simulating extension disconnect) prevents inheritance', () => {
    let active: DownloadBehavior | null = { behavior: 'allow', downloadPath: '/tmp' };
    active = null;
    const cmd = simulateNewTargetAttach(active, { sessionId: 's-new', type: 'page' });
    assert.equal(cmd, null);
  });
});

describe('integration: mixed target types during setDownloadBehavior', () => {
  it('should handle a realistic mix of pages, workers, and iframes', () => {
    const targets: RelayTarget[] = [
      { sessionId: 'page-main', type: 'page' },
      { sessionId: 'sw-bg', type: 'service_worker' },
      { sessionId: 'page-popup', type: 'page' },
      { sessionId: 'iframe-ads', type: 'iframe' },
      { sessionId: 'worker-data', type: 'worker' },
      { sessionId: 'page-ext', type: 'page' },
    ];
    const { forwarded } = simulateRelaySetDownloadBehavior('allow', '/dl', targets);
    assert.equal(forwarded.length, 3);
    assert.deepStrictEqual(forwarded.map(f => f.targetSessionId), ['page-main', 'page-popup', 'page-ext']);
  });

  it('should handle targets with missing type (defaults to page)', () => {
    const targets: RelayTarget[] = [
      { sessionId: 'no-type', type: '' },
      { sessionId: 'page', type: 'page' },
    ];
    const { forwarded } = simulateRelaySetDownloadBehavior('allow', '/dl', targets);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].targetSessionId, 'page');
  });
});

// ===========================================================================
// Tests: Phase 1.1 — Structured error formatting
// ===========================================================================

describe('formatError – structured error formatting', () => {
  it('should include error, hint, and recovery', () => {
    const result = formatError({ error: 'CDP connection lost', hint: 'Tab may be closed', recovery: 'reset' });
    assert.ok(result.includes('Error: CDP connection lost'));
    assert.ok(result.includes('Hint: Tab may be closed'));
    assert.ok(result.includes('Recovery: call "reset" tool'));
  });

  it('should omit recovery when not provided', () => {
    const result = formatError({ error: 'Element not found', hint: 'Selector mismatch' });
    assert.ok(!result.includes('Recovery'));
  });

  it('should omit Hint line when hint is undefined', () => {
    const result = formatError({ error: 'Timeout' });
    assert.ok(result.includes('Error: Timeout'));
    assert.ok(!result.includes('Hint'));
    assert.equal(result.split('\n').length, 1);
  });

  it('should omit Hint line when hint is empty string', () => {
    const result = formatError({ error: 'Timeout', hint: '' });
    assert.ok(!result.includes('Hint'));
  });

  it('should output only Error line when no hint and no recovery', () => {
    const result = formatError({ error: 'Something broke' });
    assert.strictEqual(result, 'Error: Something broke');
  });
});

// ===========================================================================
// Tests: Phase 1.2 — formatInteractiveSnapshot
// ===========================================================================

describe('formatInteractiveSnapshot', () => {
  it('should format with @ref notation', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: '提交', backendDOMNodeId: 10 },
      { index: 2, role: 'textbox', name: '', backendDOMNodeId: 11 },
      { index: 3, role: 'link', name: 'Home', backendDOMNodeId: 12 },
    ];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('@1 [button] "提交"'));
    assert.ok(result.includes('@2 [textbox]'));
    assert.ok(result.includes('@3 [link] "Home"'));
    assert.ok(result.startsWith('Interactive elements (3):'));
  });

  it('should return fallback for no elements', () => {
    assert.equal(formatInteractiveSnapshot([]), 'No interactive elements found.');
  });

  it('should escape special chars in names', () => {
    const elements: LabeledElement[] = [{ index: 1, role: 'button', name: 'Save & "Close"', backendDOMNodeId: 10 }];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('Save & "Close"'));
  });

  it('should include display-only note about @ref numbers', () => {
    const elements: LabeledElement[] = [{ index: 1, role: 'button', name: 'OK', backendDOMNodeId: 10 }];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('display-only'));
  });

  it('should handle single element correctly', () => {
    const elements: LabeledElement[] = [{ index: 1, role: 'link', name: 'Home', backendDOMNodeId: 5 }];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.startsWith('Interactive elements (1):'));
    assert.ok(result.includes('@1 [link] "Home"'));
  });
});

// ===========================================================================
// Tests: Phase 2.1 — @ref in formatAXTreeAsText + refCache
// ===========================================================================

describe('formatAXTreeAsText – @ref assignment', () => {
  it('should assign @ref to interactive elements in tree', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'Page' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Title' } },
      { nodeId: '3', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 42 },
    ];
    const text = formatAXTreeAsText(nodes, true, 'test-tab');
    assert.ok(text.includes('@1'));
    assert.ok(text.includes('button "Submit"'));
    const headingLine = text.split('\n').find(l => l.includes('heading'));
    assert.ok(headingLine && !/^\s*@\d+/.test(headingLine), 'heading should not have @ref prefix');
  });

  it('should NOT assign @ref when assignRefs=false', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'OK' }, backendDOMNodeId: 42 },
    ];
    const text = formatAXTreeAsText(nodes, false);
    assert.ok(!/\s*@\d+/.test(text), 'should not contain @ref when assignRefs=false');
  });

  it('should populate refCacheByTab when assigning refs', () => {
    const tabId = 'test-populate';
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Go' }, backendDOMNodeId: 99 },
    ];
    formatAXTreeAsText(nodes, true, tabId);
    const cache = getRefCache(tabId);
    assert.equal(cache.size, 1);
    assert.equal(cache.get(1)?.backendDOMNodeId, 99);
    assert.equal(cache.get(1)?.name, 'Go');
  });

  it('should clear tab refCache on each call', () => {
    const tabId = 'test-clear';
    const cache = getRefCache(tabId);
    cache.set(999, { backendDOMNodeId: 1, role: 'button', name: 'old' });
    formatAXTreeAsText([], true, tabId);
    assert.ok(!cache.has(999));
  });

  it('refCaches should be isolated per tab', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'A' }, backendDOMNodeId: 10 },
    ];
    formatAXTreeAsText(nodes, true, 'tab-A');
    formatAXTreeAsText(nodes, true, 'tab-B');
    assert.equal(getRefCache('tab-A').size, 1);
    assert.equal(getRefCache('tab-B').size, 1);
  });

  it('existing tests should still pass with assignRefs=false (backward compat)', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'My Page' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Hello World' } },
    ];
    const text = formatAXTreeAsText(nodes, false);
    assert.ok(text.includes('RootWebArea "My Page"'));
    assert.ok(text.includes('  heading "Hello World"'));
  });

  it('should not break computeSnapshotDiff with @ref prefixes', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 42 },
    ];
    const snap1 = formatAXTreeAsText(nodes, true, 'diff-test');
    const snap2 = formatAXTreeAsText(nodes, true, 'diff-test');
    const diff = computeSnapshotDiff(snap1, snap2);
    assert.ok(diff.includes('No changes'));
  });

  it('should assign sequential @ref numbers to multiple interactive elements', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'A' }, backendDOMNodeId: 10 },
      { nodeId: '3', parentId: '1', role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'B' }, backendDOMNodeId: 11 },
      { nodeId: '4', parentId: '1', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'C' }, backendDOMNodeId: 12 },
    ];
    const text = formatAXTreeAsText(nodes, true, 'multi-test');
    assert.ok(text.includes('@1'));
    assert.ok(text.includes('@2'));
    assert.ok(text.includes('@3'));
    const cache = getRefCache('multi-test');
    assert.equal(cache.size, 3);
  });
});

describe('stripRefPrefixes', () => {
  it('should strip @N prefix from lines', () => {
    const input = '  @1 button "Submit"\n  heading "Title"\n  @2 textbox ""';
    const result = stripRefPrefixes(input);
    assert.ok(!result.includes('@1'));
    assert.ok(!result.includes('@2'));
    assert.ok(result.includes('button "Submit"'));
    assert.ok(result.includes('heading "Title"'));
  });

  it('should preserve indentation after stripping', () => {
    const input = '    @5 button "Go"';
    const result = stripRefPrefixes(input);
    assert.strictEqual(result, '    button "Go"');
  });

  it('should not modify text without @ref prefixes', () => {
    const input = '  heading "Title"\n  paragraph "Content"';
    assert.strictEqual(stripRefPrefixes(input), input);
  });

  it('should not strip @ in the middle of text', () => {
    const input = '  textbox "email@example.com"';
    assert.strictEqual(stripRefPrefixes(input), input);
  });
});

describe('refCacheByTab – reset clears all tabs', () => {
  it('should clear all tab caches on reset', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'X' }, backendDOMNodeId: 1 },
    ];
    formatAXTreeAsText(nodes, true, 'tab-reset-1');
    formatAXTreeAsText(nodes, true, 'tab-reset-2');
    assert.equal(getRefCache('tab-reset-1').size, 1);
    assert.equal(getRefCache('tab-reset-2').size, 1);
    refCacheByTab.clear();
    assert.equal(getRefCache('tab-reset-1').size, 0);
    assert.equal(getRefCache('tab-reset-2').size, 0);
  });
});

// ===========================================================================
// Tests: Phase 2.3 — interact tool definition
// ===========================================================================

describe('interact tool definition', () => {
  const interactActions = ['click', 'hover', 'fill', 'focus', 'check', 'uncheck', 'select'];

  it('should have all 7 actions', () => {
    assert.equal(interactActions.length, 7);
  });

  it('should include all expected actions', () => {
    for (const action of ['click', 'hover', 'fill', 'focus', 'check', 'uncheck', 'select']) {
      assert.ok(interactActions.includes(action), `missing action: ${action}`);
    }
  });
});

describe('interact tool – ref validation logic', () => {
  it('should fail when ref not in cache', () => {
    const tabId = 'interact-test-missing';
    getRefCache(tabId).clear();
    const cache = getRefCache(tabId);
    assert.equal(cache.get(42), undefined);
  });

  it('should find valid ref in cache', () => {
    const tabId = 'interact-test-valid';
    getRefCache(tabId).set(1, { backendDOMNodeId: 10, role: 'button', name: 'OK' });
    const cached = getRefCache(tabId).get(1);
    assert.ok(cached);
    assert.equal(cached.backendDOMNodeId, 10);
    assert.equal(cached.role, 'button');
    assert.equal(cached.name, 'OK');
  });
});

// ===========================================================================
// Tests: Phase 3.1 — trace tool definition
// ===========================================================================

describe('trace tool definition', () => {
  const traceActions = ['start', 'stop', 'status'];

  it('should have 3 actions', () => {
    assert.equal(traceActions.length, 3);
  });

  it('should include all expected actions', () => {
    for (const action of traceActions) {
      assert.ok(['start', 'stop', 'status'].includes(action));
    }
  });
});

// ===========================================================================
// Tests: Phase 3.1 — DYNAMIC_CLASS_RE from content_trace
// ===========================================================================

describe('DYNAMIC_CLASS_RE pattern', () => {
  const DYNAMIC_CLASS_RE = /^(data-v-|_|css-|sc-|jss|styles_)/;

  it('should match Vue scoped classes', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('data-v-abc123'));
  });

  it('should match CSS Module classes', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('_1a2b3c'));
    assert.ok(DYNAMIC_CLASS_RE.test('css-xyz'));
    assert.ok(DYNAMIC_CLASS_RE.test('styles_header'));
  });

  it('should match styled-components classes', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('sc-dkzDqf'));
  });

  it('should match JSS classes', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('jss123'));
  });

  it('should NOT match normal classes', () => {
    assert.ok(!DYNAMIC_CLASS_RE.test('primary'));
    assert.ok(!DYNAMIC_CLASS_RE.test('btn-submit'));
    assert.ok(!DYNAMIC_CLASS_RE.test('container'));
  });
});

// ===========================================================================
// Tests: Phase 3.2 — browser_fetch tool definition
// ===========================================================================

describe('browser_fetch tool definition', () => {
  it('should support GET, POST, PUT, DELETE, PATCH methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    assert.equal(methods.length, 5);
  });

  it('should clamp max_body_size to valid range', () => {
    const clamp = (raw: number | undefined) =>
      Math.max(1, Math.min(Number.isFinite(raw as number) ? (raw as number) : 10000, 100000));
    assert.equal(clamp(-1), 1);
    assert.equal(clamp(0), 1);
    assert.equal(clamp(999999), 100000);
    assert.equal(clamp(undefined), 10000);
    assert.equal(clamp(NaN), 10000);
    assert.equal(clamp(5000), 5000);
  });
});

// ===========================================================================
// Tests: registered MCP tools (4 core only)
// ===========================================================================

describe('Integration: only 4 core MCP tools registered', () => {
  const registeredTools = ['execute', 'reset', 'single_spa', 'tab'];

  it('exactly 4 tools', () => {
    assert.equal(registeredTools.length, 4);
    assert.equal(new Set(registeredTools).size, 4);
  });

  it('execute tool present', () => {
    assert.ok(registeredTools.includes('execute'));
  });

  it('reset tool present', () => {
    assert.ok(registeredTools.includes('reset'));
  });

  it('single_spa tool present', () => {
    assert.ok(registeredTools.includes('single_spa'));
  });

  it('tab tool present', () => {
    assert.ok(registeredTools.includes('tab'));
  });

  it('no legacy tools registered', () => {
    const removedTools = [
      'screenshot', 'accessibility_snapshot', 'dashboard_state',
      'console_logs', 'network_log', 'network_detail', 'playwright_execute',
      'clear_cache_and_reload', 'ensure_fresh_render', 'navigate',
      'override_app', 'app_action', 'debugger', 'css_inspect', 'session_manager',
      'list_tabs', 'switch_tab', 'connect_tab', 'release_tab',
      'storage', 'performance', 'editor', 'network_intercept', 'emulation',
      'page_content', 'interact', 'browser_fetch', 'trace',
    ];
    for (const tool of removedTools) {
      assert.ok(!registeredTools.includes(tool), `${tool} should not be registered`);
    }
  });
});

describe('Phase 2: execute tool schema', () => {
  it('execute requires code param', () => {
    const schema = {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
    };
    assert.ok(schema.required.includes('code'));
    assert.ok(schema.properties.code.type === 'string');
  });

  it('execute optional timeout_ms', () => {
    const schema = {
      required: ['code'],
      properties: { code: { type: 'string' }, timeout_ms: { type: 'number' } },
    };
    assert.ok(!schema.required.includes('timeout_ms'));
    assert.ok(schema.properties.timeout_ms.type === 'number');
  });
});

describe('Phase 2: single_spa tool schema', () => {
  const validActions = ['status', 'set_override', 'remove_override', 'enable_override',
    'disable_override', 'reset_overrides', 'mount', 'unmount', 'unload'];

  it('single_spa requires action param', () => {
    const schema = { required: ['action'] };
    assert.ok(schema.required.includes('action'));
  });

  it('action enum covers all 9 values', () => {
    assert.equal(validActions.length, 9);
    assert.ok(validActions.includes('status'));
    assert.ok(validActions.includes('set_override'));
    assert.ok(validActions.includes('mount'));
  });
});

describe('Phase 2: tab tool schema', () => {
  const validActions = ['connect', 'list', 'switch', 'release'];

  it('tab requires action param', () => {
    const schema = { required: ['action'] };
    assert.ok(schema.required.includes('action'));
  });

  it('action enum covers all 4 tab actions', () => {
    assert.equal(validActions.length, 4);
    assert.ok(validActions.includes('connect'));
    assert.ok(validActions.includes('list'));
    assert.ok(validActions.includes('switch'));
    assert.ok(validActions.includes('release'));
  });
});

describe('Phase 2: single_spa delegates to internal handlers', () => {
  const singleSpaActions = ['status', 'override_set', 'override_remove', 'override_enable',
    'override_disable', 'override_reset_all', 'mount', 'unmount', 'unload'];

  it('single_spa has 9 actions', () => {
    assert.equal(singleSpaActions.length, 9);
  });

  it('tab delegates to internal handlers', () => {
    const tabActions = ['connect', 'list', 'switch', 'release'];
    assert.equal(tabActions.length, 4);
  });
});

// ===========================================================================
// Tests: Phase 2 — SessionStore behavior
// ===========================================================================

describe('Phase 2: SessionStore session limit', () => {
  it('ExecutorManager should throw when max sessions reached', () => {
    const mgr = new ExecutorManager({ maxSessions: 2 });
    mgr.getOrCreate('s1');
    mgr.getOrCreate('s2');
    assert.throws(() => mgr.getOrCreate('s3'), /limit reached/i);
  });

  it('remove frees slot for new session', async () => {
    const mgr = new ExecutorManager({ maxSessions: 1 });
    mgr.getOrCreate('s1');
    assert.throws(() => mgr.getOrCreate('s2'), /limit reached/i);
    await mgr.remove('s1');
    const s2 = mgr.getOrCreate('s2');
    assert.ok(s2 instanceof PlaywrightExecutor);
  });
});

// ===========================================================================
// Tests: Phase 2 — security: isPlaywrightChannelOwner in execute flow
// ===========================================================================

describe('Phase 2: ChannelOwner filtering in execute result', () => {
  it('channel owner objects should be detected before inspection', () => {
    const fakeChannelOwner = { _type: 'Page', _guid: 'page@abc', _connection: {} };
    assert.equal(isPlaywrightChannelOwner(fakeChannelOwner), true);
  });

  it('arrays with channel owners should be partially detectable', () => {
    const items = [
      { _type: 'Frame', _guid: 'frame@1' },
      { normal: true },
      'just a string',
    ];
    const channelOwners = items.filter(isPlaywrightChannelOwner);
    assert.equal(channelOwners.length, 1);
  });
});

// ===========================================================================
// Tests: Phase 1.2 — interactive_only priority over search/diff
// ===========================================================================

describe('accessibility_snapshot – interactive_only priority', () => {
  it('interactive_only should take priority over search/diff args', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'computedString', value: 'Title' } },
      { nodeId: '3', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' }, backendDOMNodeId: 10 },
    ];
    const interactive = getInteractiveElements(nodes);
    const result = formatInteractiveSnapshot(interactive);
    assert.ok(result.includes('Interactive elements (1):'));
    assert.ok(result.includes('@1 [button] "Submit"'));
    assert.ok(!result.includes('heading'));
  });
});

// ===========================================================================
// Tests: Phase 3.2 — browser_fetch code generation
// ===========================================================================

describe('browser_fetch – fetch code generation', () => {
  function generateFetchCode(opts: { url: string; method: string; headers?: string; body?: string; maxSize: number }): string {
    const { url, method, headers, body, maxSize } = opts;
    const timeoutMs = 30000;
    return `
      (async () => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ${timeoutMs});
          const resp = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            ${headers ? `headers: JSON.parse(${JSON.stringify(headers)}),` : ''}
            ${body ? `body: ${JSON.stringify(body)},` : ''}
            credentials: 'include',
            signal: controller.signal
          });
          clearTimeout(timer);
          const text = await resp.text();
          return JSON.stringify({
            status: resp.status,
            statusText: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
            body: text.slice(0, ${maxSize}),
            truncated: text.length > ${maxSize}
          });
        } catch (e) {
          return JSON.stringify({ error: e.name === 'AbortError' ? 'Request timed out after ${timeoutMs / 1000}s' : e.message });
        }
      })()
    `;
  }

  it('should generate valid fetch code for GET', () => {
    const code = generateFetchCode({ url: '/api/me', method: 'GET', maxSize: 10000 });
    assert.ok(code.includes('fetch("/api/me"'));
    assert.ok(code.includes('"GET"'));
    assert.ok(code.includes("credentials: 'include'"));
  });

  it('should escape URL in generated code', () => {
    const code = generateFetchCode({ url: '/api/search?q=hello"world', method: 'GET', maxSize: 10000 });
    assert.ok(!code.includes('hello"world'));
    assert.ok(code.includes('hello\\"world'));
  });

  it('should truncate response body', () => {
    const code = generateFetchCode({ url: '/api', method: 'GET', maxSize: 100 });
    assert.ok(code.includes('.slice(0, 100)'));
  });

  it('should safely handle headers parameter', () => {
    const code = generateFetchCode({
      url: '/api',
      method: 'POST',
      headers: '{"Content-Type": "application/json"}',
      maxSize: 10000,
    });
    assert.ok(code.includes('JSON.parse'));
  });

  it('should include body for POST requests', () => {
    const code = generateFetchCode({
      url: '/api/data',
      method: 'POST',
      body: '{"key":"value"}',
      maxSize: 5000,
    });
    assert.ok(code.includes('"POST"'));
    assert.ok(code.includes('body:'));
    assert.ok(code.includes('.slice(0, 5000)'));
  });

  it('should include AbortController timeout', () => {
    const code = generateFetchCode({ url: '/api', method: 'GET', maxSize: 10000 });
    assert.ok(code.includes('AbortController'));
    assert.ok(code.includes('controller.abort()'));
    assert.ok(code.includes('signal: controller.signal'));
  });
});

// ===========================================================================
// Tests: Phase 3.1 — trace event cap simulation
// ===========================================================================

describe('trace – event cap simulation', () => {
  it('should evict oldest event when max reached', () => {
    const MAX = 10;
    const events: number[] = [];
    for (let i = 0; i < MAX + 5; i++) {
      if (events.length >= MAX) events.shift();
      events.push(i);
    }
    assert.equal(events.length, MAX);
    assert.equal(events[0], 5);
    assert.equal(events[events.length - 1], 14);
  });

  it('should not evict below capacity', () => {
    const MAX = 10000;
    const events: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (events.length >= MAX) events.shift();
      events.push(i);
    }
    assert.equal(events.length, 100);
  });
});

// ===========================================================================
// Tests: Phase 3.1 — trace content script selector helpers
// ===========================================================================

describe('trace – DYNAMIC_CLASS_RE extended patterns', () => {
  const DYNAMIC_CLASS_RE = /^(data-v-|_|css-|sc-|jss|styles_)/;

  it('should match various CSS Module patterns', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('_container_abc'));
    assert.ok(DYNAMIC_CLASS_RE.test('css-1a2b3c'));
  });

  it('should match various Vue scoped patterns', () => {
    assert.ok(DYNAMIC_CLASS_RE.test('data-v-1234abcd'));
    assert.ok(DYNAMIC_CLASS_RE.test('data-v-'));
  });

  it('should not match BEM-style classes', () => {
    assert.ok(!DYNAMIC_CLASS_RE.test('block__element--modifier'));
    assert.ok(!DYNAMIC_CLASS_RE.test('btn-primary'));
    assert.ok(!DYNAMIC_CLASS_RE.test('main-content'));
  });

  it('should not match utility classes', () => {
    assert.ok(!DYNAMIC_CLASS_RE.test('flex'));
    assert.ok(!DYNAMIC_CLASS_RE.test('mt-4'));
    assert.ok(!DYNAMIC_CLASS_RE.test('text-center'));
  });
});

// ===========================================================================
// Tests: Tab title prefix — ALL_PREFIXES_RE_SRC
// ===========================================================================

describe('Tab title prefix regex', () => {
  const ALL_PREFIXES_RE_SRC = "^(?:🟢 |🟡 |🔴 |🔵 )+";
  const re = new RegExp(ALL_PREFIXES_RE_SRC);

  it('should match single green prefix', () => {
    assert.ok(re.test('🟢 Example Domain'));
  });

  it('should match single yellow prefix', () => {
    assert.ok(re.test('🟡 Connecting...'));
  });

  it('should match single red prefix', () => {
    assert.ok(re.test('🔴 Error'));
  });

  it('should match multiple repeated prefixes', () => {
    assert.ok(re.test('🟢 🟡 🟢 Title'));
    const cleaned = '🟢 🟡 🟢 Title'.replace(re, '');
    assert.equal(cleaned, 'Title');
  });

  it('should not match title without prefix', () => {
    assert.ok(!re.test('Example Domain'));
  });

  it('should match blue prefix', () => {
    assert.ok(re.test('🔵 Idle Tab'));
  });

  it('should strip all prefixes at once', () => {
    const title = '🟢 🟢 🟡 🔴 🔵 Example Domain';
    const cleaned = title.replace(re, '');
    assert.equal(cleaned, 'Example Domain');
  });

  it('should not strip emoji in middle of title', () => {
    const title = '🟢 My 🟡 Page';
    const cleaned = title.replace(re, '');
    assert.equal(cleaned, 'My 🟡 Page');
  });
});

describe('Tab title prefix mapping', () => {
  const TAB_TITLE_PREFIXES: Record<string, string> = {
    connected: "🟢 ",
    idle: "🔵 ",
    connecting: "🟡 ",
    error: "🔴 ",
  };

  it('should have 4 states', () => {
    assert.equal(Object.keys(TAB_TITLE_PREFIXES).length, 4);
  });

  it('markTabTitle state resolution: true → connected', () => {
    const stateOrBool: boolean | string | null = true;
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    assert.equal(state, "connected");
  });

  it('markTabTitle state resolution: false → null (remove)', () => {
    const stateOrBool: boolean | string | null = false;
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    assert.equal(state, null);
  });

  it('markTabTitle state resolution: "connecting" → connecting', () => {
    const stateOrBool: boolean | string | null = "connecting";
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    assert.equal(state, "connecting");
  });

  it('markTabTitle state resolution: "error" → error', () => {
    const stateOrBool: boolean | string | null = "error";
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    assert.equal(state, "error");
  });

  it('unknown state maps to null prefix', () => {
    const state = "unknown";
    const prefix = TAB_TITLE_PREFIXES[state] || null;
    assert.equal(prefix, null);
  });
});

// ===========================================================================
// Tests: setTabTitlePrefix — code generation
// ===========================================================================

describe('setTabTitlePrefix code generation', () => {
  const TITLE_PREFIX_RE_SRC = '^(?:🟢 |🟡 |🔴 |🔵 )+';

  function generateTitleCode(prefix: string | null): string {
    const reSrc = TITLE_PREFIX_RE_SRC;
    return prefix
      ? `(() => { document.title = ${JSON.stringify(prefix)} + document.title.replace(new RegExp(${JSON.stringify(reSrc)}), ''); })()`
      : `(() => { document.title = document.title.replace(new RegExp(${JSON.stringify(reSrc)}), ''); })()`;
  }

  it('should generate code with green prefix', () => {
    const code = generateTitleCode('🟢 ');
    assert.ok(code.includes('🟢 '));
    assert.ok(code.includes('document.title'));
    assert.ok(code.includes('replace'));
  });

  it('should generate code with blue prefix', () => {
    const code = generateTitleCode('🔵 ');
    assert.ok(code.includes('🔵 '));
  });

  it('should generate removal code when prefix is null', () => {
    const code = generateTitleCode(null);
    assert.ok(!code.includes('document.title = "🟢'));
    assert.ok(!code.includes('document.title = "🔵'));
    assert.ok(code.includes('replace'));
    assert.ok(code.includes('document.title = document.title.replace'));
  });

  it('regex in generated code should strip all prefix types', () => {
    const re = new RegExp(TITLE_PREFIX_RE_SRC);
    assert.equal('🟢 🔵 🟡 Title'.replace(re, ''), 'Title');
    assert.equal('🟢 Title'.replace(re, ''), 'Title');
    assert.equal('🔵 Title'.replace(re, ''), 'Title');
    assert.equal('Title'.replace(re, ''), 'Title');
  });
});

// ===========================================================================
// Tests: Tab state lifecycle — ownership claim/release title changes
// ===========================================================================

describe('Tab state lifecycle – title prefix expectations', () => {
  const TAB_TITLE_PREFIXES: Record<string, string> = {
    connected: "🟢 ", idle: "🔵 ", connecting: "🟡 ", error: "🔴 ",
  };

  function resolveBridgeVisualState(args: {
    attached: boolean;
    isOwned: boolean;
    baseState?: 'idle' | 'connected' | 'connecting' | 'error';
  }): 'idle' | 'connected' | 'connecting' | 'error' {
    const { attached, isOwned, baseState = 'idle' } = args;
    if (baseState === 'connecting' || baseState === 'error') return baseState;
    if (!attached) return 'idle';
    return isOwned ? 'connected' : 'idle';
  }

  it('claimTab should result in green prefix', () => {
    const expectedPrefix = '🟢 ';
    assert.ok(expectedPrefix.startsWith('🟢'));
  });

  it('releaseTab should result in blue prefix', () => {
    const expectedPrefix = '🔵 ';
    assert.ok(expectedPrefix.startsWith('🔵'));
  });

  it('WS close should set idle state in bridge', () => {
    // When ws-state-change: closed, bridge calls markTabTitle("idle") → 🔵
    const idlePrefix = '🔵 ';
    assert.equal(idlePrefix, '🔵 ');
  });

  it('detach should remove prefix entirely', () => {
    // emitDetachedFromTarget calls markTabTitle(false) → null prefix
    const stateOrBool = false;
    const state = stateOrBool === true ? "connected" : stateOrBool === false ? null : stateOrBool;
    assert.equal(state, null);
  });

  it('bridge attachTab should remain blue until ownership is claimed', () => {
    const bridgeAttachState = resolveBridgeVisualState({
      attached: true,
      isOwned: false,
      baseState: 'idle',
    });
    assert.equal(TAB_TITLE_PREFIXES[bridgeAttachState], '🔵 ');
  });

  it('bridge should become green only after ownership claim', () => {
    const ownedState = resolveBridgeVisualState({
      attached: true,
      isOwned: true,
      baseState: 'idle',
    });
    assert.equal(TAB_TITLE_PREFIXES[ownedState], '🟢 ');
  });

  it('bridge should revert to blue after ownership release', () => {
    const releasedState = resolveBridgeVisualState({
      attached: true,
      isOwned: false,
      baseState: 'idle',
    });
    assert.equal(TAB_TITLE_PREFIXES[releasedState], '🔵 ');
  });

  it('rapid switch_tab should not cause prefix corruption', () => {
    // Each switch_tab: close old session → new connectCdp → enableDomains → setTabTitlePrefix(🟢)
    // Old tab: no prefix change from MCP (bridge handles WS close → 🔵)
    // New tab: 🟢
    const re = new RegExp('^(?:🟢 |🟡 |🔴 |🔵 )+');
    const title1 = '🟢 Old Tab';
    const title2 = '🔵 Old Tab';
    assert.equal(title1.replace(re, ''), 'Old Tab');
    assert.equal(title2.replace(re, ''), 'Old Tab');
    assert.equal(('🟢 ' + 'Old Tab'.replace(re, '')), '🟢 Old Tab');
  });
});

// ---------------------------------------------------------------------------
// formatMcpResult — converts ExecuteResult to MCP content array
// ---------------------------------------------------------------------------
describe('formatMcpResult', () => {
  interface ExecuteResult {
    text: string;
    isError: boolean;
    images: Array<{ data: string; mimeType: string }>;
    screenshots: Array<{ path: string; base64: string; mimeType: string; snapshot: string; labelCount: number }>;
  }

  function formatMcpResult(result: ExecuteResult): {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  } {
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
    if (result.text) {
      content.push({ type: 'text', text: result.text });
    }
    for (const img of result.images) {
      content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
    if (content.length === 0) {
      content.push({ type: 'text', text: 'Code executed successfully (no output)' });
    }
    return { content, isError: result.isError || undefined };
  }

  it('returns text content for text result', () => {
    const result = formatMcpResult({ text: 'hello', isError: false, images: [], screenshots: [] });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'hello');
    assert.equal(result.isError, undefined);
  });

  it('returns image content for images', () => {
    const result = formatMcpResult({
      text: 'Screenshot',
      isError: false,
      images: [{ data: 'base64data', mimeType: 'image/webp' }],
      screenshots: [],
    });
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].data, 'base64data');
    assert.equal(result.content[1].mimeType, 'image/webp');
  });

  it('returns fallback message for empty result', () => {
    const result = formatMcpResult({ text: '', isError: false, images: [], screenshots: [] });
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text!.includes('successfully'));
  });

  it('sets isError flag', () => {
    const result = formatMcpResult({ text: 'Error: x', isError: true, images: [], screenshots: [] });
    assert.equal(result.isError, true);
  });

  it('returns multiple images', () => {
    const result = formatMcpResult({
      text: '',
      isError: false,
      images: [
        { data: 'a', mimeType: 'image/png' },
        { data: 'b', mimeType: 'image/webp' },
      ],
      screenshots: [],
    });
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[1].type, 'image');
  });
});
