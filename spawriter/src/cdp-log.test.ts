import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCdpLogger, DROPPED_CDP_EVENTS, NOISY_LOG_EVENTS, type CdpLogEntry } from './cdp-log.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawriter-cdplog-'));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function entry(overrides?: Partial<CdpLogEntry>): CdpLogEntry {
  return {
    timestamp: new Date().toISOString(),
    direction: 'from-extension',
    message: { method: 'Page.frameNavigated', params: { url: 'https://example.com' } },
    ...overrides,
  };
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.length > 0);
}

describe('createCdpLogger', () => {
  it('writes JSONL entries after flush', async () => {
    const file = path.join(tmpRoot, 'a.jsonl');
    const logger = createCdpLogger({ logFilePath: file });
    logger.log(entry());
    logger.log(entry({ direction: 'to-playwright', clientId: 'pw-1' }));
    await logger.flush();
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.direction, 'from-extension');
    assert.equal((first.message as { method: string }).method, 'Page.frameNavigated');
    assert.equal(JSON.parse(lines[1]).clientId, 'pw-1');
  });

  it('truncates long strings inside messages', async () => {
    const file = path.join(tmpRoot, 'b.jsonl');
    const logger = createCdpLogger({ logFilePath: file, maxStringLength: 100 });
    logger.log(entry({ message: { method: 'Page.captureScreenshot', data: 'x'.repeat(500) } }));
    await logger.flush();
    const parsed = JSON.parse(readLines(file)[0]);
    assert.ok((parsed.message.data as string).includes('…[truncated 400 chars]'));
    assert.ok((parsed.message.data as string).length < 200);
  });

  it('handles circular references without throwing', async () => {
    const file = path.join(tmpRoot, 'c.jsonl');
    const logger = createCdpLogger({ logFilePath: file });
    const circular: Record<string, unknown> = { method: 'X' };
    circular.self = circular;
    logger.log(entry({ message: circular }));
    await logger.flush();
    assert.ok(readLines(file)[0].includes('[Circular]'));
  });

  it('rotates the file down to half maxEntries', async () => {
    const file = path.join(tmpRoot, 'd.jsonl');
    const logger = createCdpLogger({ logFilePath: file, maxEntries: 10 });
    for (let i = 0; i < 25; i++) logger.log(entry({ message: { method: `M${i}` } }));
    await logger.flush();
    const lines = readLines(file);
    assert.ok(lines.length <= 10, `expected <=10 lines after rotation, got ${lines.length}`);
    // The newest entries survive rotation.
    assert.ok(lines[lines.length - 1].includes('M24'));
  });

  it('truncates any existing file on creation', async () => {
    const file = path.join(tmpRoot, 'e.jsonl');
    fs.writeFileSync(file, 'stale\n');
    createCdpLogger({ logFilePath: file });
    assert.equal(fs.readFileSync(file, 'utf-8'), '');
  });
});

describe('CDP event filter sets', () => {
  it('drops only events no Playwright API depends on', () => {
    assert.deepEqual([...DROPPED_CDP_EVENTS].sort(), ['Network.dataReceived', 'Network.resourceChangedPriority']);
  });

  it('log-noise set is a superset of the dropped set and keeps forwarded-but-noisy events', () => {
    for (const dropped of DROPPED_CDP_EVENTS) assert.ok(NOISY_LOG_EVENTS.has(dropped));
    // ExtraInfo feeds allHeaders(); webSocketFrame* feeds page.on('websocket') —
    // they must be log-filtered (present here) yet still forwarded (not dropped).
    for (const forwarded of ['Network.requestWillBeSentExtraInfo', 'Network.webSocketFrameReceived']) {
      assert.ok(NOISY_LOG_EVENTS.has(forwarded));
      assert.ok(!DROPPED_CDP_EVENTS.has(forwarded));
    }
  });
});
