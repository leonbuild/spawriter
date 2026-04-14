/**
 * Tests for runtime/network-monitor.ts — console/network log management
 * and network interception rule engine. Imports directly from production code.
 *
 * Run: npx tsx --test spawriter/src/runtime/network-monitor.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NetworkMonitor,
  formatConsoleLogs,
  formatNetworkEntries,
  type ConsoleLogEntry,
  type NetworkEntry,
} from './network-monitor.js';

// ---------------------------------------------------------------------------
// NetworkMonitor — console logs
// ---------------------------------------------------------------------------
describe('NetworkMonitor — console logs', () => {
  it('adds and retrieves logs', () => {
    const m = new NetworkMonitor();
    m.addConsoleLog({ level: 'log', text: 'hello', timestamp: Date.now() });
    const logs = m.getConsoleLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].text, 'hello');
  });

  it('caps at 1000 entries', () => {
    const m = new NetworkMonitor();
    for (let i = 0; i < 1100; i++) {
      m.addConsoleLog({ level: 'log', text: `msg-${i}`, timestamp: i });
    }
    assert.equal(m.consoleLogCount, 1000);
    const logs = m.getConsoleLogs({ count: 1 });
    assert.equal(logs[0].text, 'msg-1099');
  });

  it('filters by level', () => {
    const m = new NetworkMonitor();
    m.addConsoleLog({ level: 'log', text: 'info msg', timestamp: 1 });
    m.addConsoleLog({ level: 'error', text: 'err msg', timestamp: 2 });
    const errors = m.getConsoleLogs({ level: 'error' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].text, 'err msg');
  });

  it('filters by search text', () => {
    const m = new NetworkMonitor();
    m.addConsoleLog({ level: 'log', text: 'alpha', timestamp: 1 });
    m.addConsoleLog({ level: 'log', text: 'beta', timestamp: 2 });
    assert.equal(m.getConsoleLogs({ search: 'alpha' }).length, 1);
  });

  it('clears logs', () => {
    const m = new NetworkMonitor();
    m.addConsoleLog({ level: 'log', text: 'x', timestamp: 1 });
    m.clearConsoleLogs();
    assert.equal(m.consoleLogCount, 0);
  });

  it('returns last N logs', () => {
    const m = new NetworkMonitor();
    for (let i = 0; i < 10; i++) {
      m.addConsoleLog({ level: 'log', text: `msg-${i}`, timestamp: i });
    }
    const logs = m.getConsoleLogs({ count: 3 });
    assert.equal(logs.length, 3);
    assert.equal(logs[0].text, 'msg-7');
  });

  it('defaults count to 50 when unspecified', () => {
    const m = new NetworkMonitor();
    for (let i = 0; i < 100; i++) {
      m.addConsoleLog({ level: 'log', text: `msg-${i}`, timestamp: i });
    }
    assert.equal(m.getConsoleLogs().length, 50);
  });
});

// ---------------------------------------------------------------------------
// NetworkMonitor — network requests
// ---------------------------------------------------------------------------
describe('NetworkMonitor — network requests', () => {
  it('adds and retrieves network requests', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({
      requestId: 'req-1',
      request: { url: 'https://api.test/data', method: 'GET', headers: {} },
      type: 'Fetch',
    });
    const entries = m.getNetworkEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].url, 'https://api.test/data');
    assert.equal(entries[0].method, 'GET');
  });

  it('sets response data', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.setNetworkResponse({ requestId: 'r1', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} } });
    const e = m.getNetworkEntries()[0];
    assert.equal(e.status, 200);
    assert.equal(e.mimeType, 'application/json');
  });

  it('sets finished data', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.setNetworkFinished({ requestId: 'r1', encodedDataLength: 1234 });
    const e = m.getNetworkEntries()[0];
    assert.equal(e.size, 1234);
    assert.ok(e.endTime);
  });

  it('sets failed data', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.setNetworkFailed({ requestId: 'r1', errorText: 'net::ERR_FAILED' });
    const e = m.getNetworkEntries()[0];
    assert.equal(e.error, 'net::ERR_FAILED');
  });

  it('caps at 500 entries', () => {
    const m = new NetworkMonitor();
    for (let i = 0; i < 550; i++) {
      m.addNetworkRequest({ requestId: `r-${i}`, request: { url: `http://x/${i}`, method: 'GET', headers: {} } });
    }
    assert.equal(m.networkEntryCount, 500);
  });

  it('filters by URL', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://api.test/users', method: 'GET', headers: {} } });
    m.addNetworkRequest({ requestId: 'r2', request: { url: 'http://cdn.test/image.png', method: 'GET', headers: {} } });
    assert.equal(m.getNetworkEntries({ urlFilter: 'api.test' }).length, 1);
  });

  it('filters by status ok', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.setNetworkResponse({ requestId: 'r1', response: { status: 200 } });
    m.addNetworkRequest({ requestId: 'r2', request: { url: 'http://y', method: 'GET', headers: {} } });
    m.setNetworkResponse({ requestId: 'r2', response: { status: 500 } });
    assert.equal(m.getNetworkEntries({ statusFilter: 'ok' }).length, 1);
  });

  it('filters by status error', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.setNetworkFailed({ requestId: 'r1', errorText: 'timeout' });
    m.addNetworkRequest({ requestId: 'r2', request: { url: 'http://y', method: 'GET', headers: {} } });
    m.setNetworkResponse({ requestId: 'r2', response: { status: 200 } });
    assert.equal(m.getNetworkEntries({ statusFilter: 'error' }).length, 1);
  });

  it('gets network detail by requestId', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'POST', headers: {}, postData: '{"a":1}', hasPostData: true } });
    const detail = m.getNetworkDetail('r1');
    assert.ok(detail);
    assert.equal(detail!.postData, '{"a":1}');
  });

  it('returns undefined for unknown requestId', () => {
    const m = new NetworkMonitor();
    assert.equal(m.getNetworkDetail('nope'), undefined);
  });

  it('clears network log', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.clearNetworkLog();
    assert.equal(m.networkEntryCount, 0);
  });

  it('ignores request without request object', () => {
    const m = new NetworkMonitor();
    m.addNetworkRequest({ requestId: 'r1' });
    assert.equal(m.networkEntryCount, 0);
  });
});

// ---------------------------------------------------------------------------
// NetworkMonitor — interception
// ---------------------------------------------------------------------------
describe('NetworkMonitor — interception rules', () => {
  it('adds rules with auto-generated ids', () => {
    const m = new NetworkMonitor();
    const rule = m.addInterceptRule({ urlPattern: '/api/*', mockStatus: 200, mockBody: '{}' });
    assert.ok(rule.id.startsWith('rule-'));
    assert.equal(m.listInterceptRules().length, 1);
  });

  it('removes rules', () => {
    const m = new NetworkMonitor();
    const rule = m.addInterceptRule({ urlPattern: '/test' });
    assert.ok(m.removeInterceptRule(rule.id));
    assert.equal(m.listInterceptRules().length, 0);
  });

  it('returns false for removing non-existent rule', () => {
    const m = new NetworkMonitor();
    assert.ok(!m.removeInterceptRule('bogus'));
  });

  it('enable/disable toggles intercept state', () => {
    const m = new NetworkMonitor();
    assert.ok(!m.isInterceptEnabled);
    m.enableIntercept();
    assert.ok(m.isInterceptEnabled);
    m.disableIntercept();
    assert.ok(!m.isInterceptEnabled);
  });

  it('findMatchingRule returns null when disabled', () => {
    const m = new NetworkMonitor();
    m.addInterceptRule({ urlPattern: '/api' });
    assert.equal(m.findMatchingRule('/api/test', 'Fetch'), null);
  });

  it('findMatchingRule matches by URL substring', () => {
    const m = new NetworkMonitor();
    m.enableIntercept();
    m.addInterceptRule({ urlPattern: '/api', mockStatus: 200 });
    const rule = m.findMatchingRule('https://example.com/api/users', 'Fetch');
    assert.ok(rule);
    assert.equal(rule!.mockStatus, 200);
  });

  it('findMatchingRule matches glob patterns', () => {
    const m = new NetworkMonitor();
    m.enableIntercept();
    m.addInterceptRule({ urlPattern: '/api/*/data', mockStatus: 200 });
    const rule = m.findMatchingRule('https://x.com/api/users/data', 'Fetch');
    assert.ok(rule);
  });

  it('findMatchingRule filters by resource type', () => {
    const m = new NetworkMonitor();
    m.enableIntercept();
    m.addInterceptRule({ urlPattern: '/api', resourceType: 'XHR' });
    assert.ok(m.findMatchingRule('/api/x', 'XHR'));
    assert.ok(!m.findMatchingRule('/api/x', 'Image'));
  });

  it('clearInterceptState resets everything', () => {
    const m = new NetworkMonitor();
    m.enableIntercept();
    m.addInterceptRule({ urlPattern: '/x' });
    m.clearInterceptState();
    assert.ok(!m.isInterceptEnabled);
    assert.equal(m.listInterceptRules().length, 0);
  });
});

// ---------------------------------------------------------------------------
// NetworkMonitor — clearAll
// ---------------------------------------------------------------------------
describe('NetworkMonitor — clearAll', () => {
  it('clears console, network, and intercept state', () => {
    const m = new NetworkMonitor();
    m.addConsoleLog({ level: 'log', text: 'x', timestamp: 1 });
    m.addNetworkRequest({ requestId: 'r1', request: { url: 'http://x', method: 'GET', headers: {} } });
    m.enableIntercept();
    m.addInterceptRule({ urlPattern: '/x' });

    m.clearAll();

    assert.equal(m.consoleLogCount, 0);
    assert.equal(m.networkEntryCount, 0);
    assert.ok(!m.isInterceptEnabled);
    assert.equal(m.listInterceptRules().length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatConsoleLogs
// ---------------------------------------------------------------------------
describe('formatConsoleLogs', () => {
  it('formats log entries', () => {
    const logs: ConsoleLogEntry[] = [
      { level: 'log', text: 'hello world', timestamp: new Date('2026-01-01T12:00:00Z').getTime() },
    ];
    const result = formatConsoleLogs(logs, 1);
    assert.ok(result.includes('12:00:00.000'));
    assert.ok(result.includes('LOG'));
    assert.ok(result.includes('hello world'));
    assert.ok(result.includes('1/1 total'));
  });

  it('returns no-logs message for empty array', () => {
    const result = formatConsoleLogs([], 5);
    assert.ok(result.includes('No console logs'));
    assert.ok(result.includes('5 total'));
  });

  it('includes URL and line number when available', () => {
    const logs: ConsoleLogEntry[] = [
      { level: 'error', text: 'oops', timestamp: 0, url: 'app.js', lineNumber: 42 },
    ];
    const result = formatConsoleLogs(logs, 1);
    assert.ok(result.includes('(app.js:42)'));
  });
});

// ---------------------------------------------------------------------------
// formatNetworkEntries
// ---------------------------------------------------------------------------
describe('formatNetworkEntries', () => {
  it('formats network entries', () => {
    const entries: NetworkEntry[] = [
      { requestId: 'r1', url: 'https://api.test/data', method: 'GET', status: 200, startTime: 1000, endTime: 1050, size: 2048 },
    ];
    const result = formatNetworkEntries(entries, 1);
    assert.ok(result.includes('GET'));
    assert.ok(result.includes('200'));
    assert.ok(result.includes('50ms'));
    assert.ok(result.includes('2.0KB'));
    assert.ok(result.includes('api.test/data'));
  });

  it('returns no-entries message for empty array', () => {
    const result = formatNetworkEntries([], 10);
    assert.ok(result.includes('No network entries'));
    assert.ok(result.includes('10 total'));
  });

  it('shows error status', () => {
    const entries: NetworkEntry[] = [
      { requestId: 'r1', url: 'http://x', method: 'GET', startTime: 0, error: 'timeout' },
    ];
    const result = formatNetworkEntries(entries, 1);
    assert.ok(result.includes('ERR:timeout'));
  });

  it('shows pending status', () => {
    const entries: NetworkEntry[] = [
      { requestId: 'r1', url: 'http://x', method: 'GET', startTime: 0 },
    ];
    const result = formatNetworkEntries(entries, 1);
    assert.ok(result.includes('...'));
  });
});
