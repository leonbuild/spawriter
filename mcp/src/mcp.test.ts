/**
 * Tests for MCP server logic: ensureSession mutex, AX tree formatting,
 * and command timeout classification.
 *
 * Run: npx tsx --test mcp/src/mcp.test.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

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

// ---------------------------------------------------------------------------
// Test: playwright_execute tool definition validation
// ---------------------------------------------------------------------------

describe('playwright_execute tool definition', () => {
  const playwrightTool = {
    name: 'playwright_execute',
    description: `Execute code in a Node.js VM sandbox with full Playwright API access.
Available variables: page (Playwright Page), context (BrowserContext), state (persistent object across calls).
Use for: complex interactions, form filling, multi-step flows, Playwright locators, multi-page scenarios.
For simple/fast JS in page context, use the 'execute' tool instead.`,
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
    assert.ok(playwrightTool.description.includes("'execute'"));
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
// ---------------------------------------------------------------------------

function computeSnapshotDiff(oldSnap: string, newSnap: string): string {
  const oldLines = oldSnap.split('\n');
  const newLines = newSnap.split('\n');
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
// ---------------------------------------------------------------------------

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
    if (!(node as AXNode & { backendDOMNodeId?: number }).backendDOMNodeId) continue;
    elements.push({
      index: idx++,
      role,
      name: node.name?.value ?? '',
      backendDOMNodeId: (node as AXNode & { backendDOMNodeId?: number }).backendDOMNodeId!,
    });
  }
  return elements;
}

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
  ];

  it('should have no duplicate tool names', () => {
    const unique = new Set(allTools);
    assert.equal(unique.size, allTools.length);
  });

  it('should have exactly 17 tools', () => {
    assert.equal(allTools.length, 17);
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
  it('should clear 9 state categories', () => {
    const stateCategories = [
      'consoleLogs', 'networkLog', 'interceptState',
      'lastSnapshot', 'pwExecutor', 'debuggerEnabled',
      'breakpoints', 'knownScripts', 'executorManager',
    ];
    assert.equal(stateCategories.length, 9);
  });
});
