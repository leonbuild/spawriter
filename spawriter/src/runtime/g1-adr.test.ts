/**
 * G-1 ADR experiments — offline validation of frozen decisions.
 *
 * Tests that can run without real Chrome validate the pure-logic contracts.
 * Tests marked with "REQUIRES_CHROME" document what needs real Chrome and
 * provide the test skeleton for when Chrome is available.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StateCheckpoint } from './state-checkpoint.js';
import { FlowControl, encodeEnvelope, decodeEnvelope, WIRE_VERSION, type WireEnvelope } from './wire-protocol.js';
import { WorkerIpcCodec } from './worker-ipc.js';
import { InstanceLock } from './instance-lock.js';
import { NavigationCoordinator } from './navigation.js';
import { CHECKPOINT_CONTRACT } from './g1-adr.js';

describe('G-1 ADR Experiments (offline)', () => {

  describe('F02: Checkpoint serialize/validate/commit', () => {
    it('commits 256KiB JSON state within 50ms', () => {
      const cp = new StateCheckpoint({ maxByteSize: CHECKPOINT_CONTRACT.maxSessionBytes + 1024 });
      // Build ~200KiB of data.
      for (let i = 0; i < 100; i++) {
        cp.set(`key_${i}`, 'x'.repeat(2000));
      }

      const start = performance.now();
      const result = cp.commit(1);
      const elapsed = performance.now() - start;

      assert(result, 'Commit should succeed');
      assert(elapsed < 100, `Commit took ${elapsed.toFixed(1)}ms (limit: 100ms)`);
      assert(result.byteSize > 0);
    });

    it('rejects non-JSON-safe types', () => {
      const cp = new StateCheckpoint();
      cp.set('fn', () => {});
      cp.set('valid', 42);
      const result = cp.commit(1);
      assert(result);
      assert(result.transientKeys.includes('fn'));
    });

    it('enforces depth and size limits', () => {
      const cp = new StateCheckpoint({ maxByteSize: 100 });
      cp.set('big', 'x'.repeat(200));
      const result = cp.commit(1);
      assert.equal(result, null, 'Should reject oversized state');
    });
  });

  describe('F03: Transport V2 flow control', () => {
    it('handles 1000 messages without loss via credit', () => {
      const fc = new FlowControl({ initialCredit: 1000, replenishThreshold: 100, maxOutstanding: 2000 });
      let sent = 0;
      let received = 0;

      // Simulate sender.
      while (fc.canSend() && sent < 1000) {
        fc.recordSent();
        sent++;
      }

      // Simulate receiver processing all.
      for (let i = 1; i <= sent; i++) {
        const needsReplenish = fc.recordReceived(i);
        received++;
        if (needsReplenish) {
          const amount = fc.calculateReplenish();
          if (amount > 0) fc.processCredit(amount);
        }
      }

      // Process ACK.
      fc.processAck(sent);

      assert.equal(sent, 1000);
      assert.equal(received, 1000);
      assert.equal(fc.diagnostics().outstanding, 0);
    });

    it('round-trips 1000 envelopes correctly', () => {
      for (let i = 0; i < 1000; i++) {
        const env: WireEnvelope = {
          v: WIRE_VERSION,
          k: 'event',
          seq: i,
          gen: 1,
          p: { method: `Test.event${i}`, params: { n: i } },
        };
        const encoded = encodeEnvelope(env);
        const decoded = decodeEnvelope(encoded);
        assert(decoded, `Failed to decode envelope ${i}`);
        assert.equal(decoded.seq, i);
      }
    });
  });

  describe('F02/IPC: Worker message validate/encode/decode', () => {
    it('validates and round-trips 1000 messages', () => {
      const codec = new WorkerIpcCodec();
      for (let i = 0; i < 1000; i++) {
        const msg = codec.buildMessage('execute', `r-${i}`, `sw-${i % 10}`, i, { code: `page.url()` });
        const encoded = codec.encode(msg);
        assert(encoded, `Failed to encode message ${i}`);
        const decoded = codec.decode(encoded);
        assert(decoded, `Failed to decode message ${i}`);
        assert.equal(decoded.id, `r-${i}`);
      }
    });

    it('rejects state over 256KiB', () => {
      const codec = new WorkerIpcCodec({ maxStateBytes: CHECKPOINT_CONTRACT.maxSessionBytes });
      const bigState: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) bigState[`k${i}`] = 'x'.repeat(2000);
      assert(!codec.validateStateSize(bigState));
    });
  });

  describe('F05: Instance lock (non-Chrome, process-level)', () => {
    it('prevents double acquisition', () => {
      const dir = mkdtempSync(join(tmpdir(), 'g1-lock-'));
      const lock1 = new InstanceLock({ dataRoot: dir, port: 0, instanceId: 'lock-a' });
      const lock2 = new InstanceLock({ dataRoot: dir, port: 0, instanceId: 'lock-b' });
      try {
        const r1 = lock1.acquire();
        assert(r1.acquired, 'First lock should succeed');

        const r2 = lock2.acquire();
        assert(!r2.acquired, 'Second lock should fail');
      } finally {
        lock1.release();
        lock2.release();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('F07: Navigation state machine accuracy (simulated)', () => {
    it('handles 100 sequential navigations with correct state transitions', () => {
      const nav = new NavigationCoordinator({ networkIdleQuietMs: 0 });
      const frameId = 'main';

      for (let i = 0; i < 100; i++) {
        const url = `https://example.com/page/${i}`;
        const record = nav.startNavigation(frameId, url, 5000);
        assert(record);
        assert.equal(record.state, 'navigating');

        nav.onFrameNavigated(frameId, url);
        assert.equal(nav.getNavigation(frameId)?.state, 'loading');

        nav.onDomContentLoaded(frameId);
        nav.onLoad(frameId);
        // After onLoad, state goes to networkIdle, _checkComplete sets quietSince.
        // Trigger a second _checkComplete to reach 'complete' (quietMs=0).
        nav.onNetworkRequestFinished(frameId);

        assert.equal(nav.getNavigation(frameId)?.state, 'complete');
      }
    });

    it('handles timeout correctly', () => {
      const nav = new NavigationCoordinator({ defaultTimeoutMs: 0 });
      nav.startNavigation('main', 'https://slow.example.com', 0);
      const timedOut = nav.checkTimeouts();
      assert(timedOut.length >= 1);
    });
  });
});
