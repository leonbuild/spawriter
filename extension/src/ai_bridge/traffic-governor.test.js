import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrafficGovernor,
  DROPPED_EVENTS,
  PROTOCOL_CRITICAL,
  _trimStack as trimStack,
  _consoleSignature as consoleSignature,
} from './traffic-governor.js';

describe('TrafficGovernor', () => {
  let gov;

  beforeEach(() => {
    gov = new TrafficGovernor({
      ratePerTab: 100,
      burstPerTab: 200,
      globalRate: 500,
      globalBurst: 1000,
    });
  });

  describe('event classification', () => {
    it('drops Network.dataReceived', () => {
      const result = gov.evaluate('Network.dataReceived', {}, 1);
      assert.equal(result.forward, false);
      assert.equal(result.reason, 'dropped_event');
    });

    it('drops Network.resourceChangedPriority', () => {
      const result = gov.evaluate('Network.resourceChangedPriority', {}, 1);
      assert.equal(result.forward, false);
    });

    it('always forwards protocol-critical events', () => {
      for (const method of [
        'Target.attachedToTarget',
        'Runtime.executionContextCreated',
        'Page.frameAttached',
        'Page.javascriptDialogOpening',
        'Fetch.requestPaused',
        'Debugger.paused',
      ]) {
        const result = gov.evaluate(method, {}, 1);
        assert.equal(result.forward, true, `${method} should be forwarded`);
      }
    });

    it('forwards non-console events', () => {
      const result = gov.evaluate('Network.requestWillBeSent', {}, 1);
      assert.equal(result.forward, true);
    });
  });

  describe('console rate limiting', () => {
    function makeConsole(type = 'warning', text = 'test') {
      return {
        type,
        args: [{ type: 'string', value: text }],
        stackTrace: {
          callFrames: [{ url: 'app.js', lineNumber: 1 }],
        },
        executionContextId: 1,
        timestamp: Date.now(),
      };
    }

    it('forwards first console events within rate', () => {
      const result = gov.evaluate('Runtime.consoleAPICalled', makeConsole(), 1);
      assert.equal(result.forward, true);
    });

    it('rate-limits after burst exhaustion', () => {
      const params = makeConsole('log', 'unique');
      let dropped = 0;
      // Send unique messages to avoid dedup, exhaust burst of 200
      for (let i = 0; i < 300; i++) {
        const p = { ...params, args: [{ type: 'string', value: `msg-${i}` }] };
        const result = gov.evaluate('Runtime.consoleAPICalled', p, 1);
        if (!result.forward) dropped++;
      }
      assert(dropped > 0, 'Some messages should be rate-limited');
      assert(dropped <= 150, 'Most of burst should get through');
    });

    it('deduplicates repeated warnings after 2 occurrences', () => {
      const params = makeConsole('warning', 'repeated msg');
      // First two should pass
      assert.equal(gov.evaluate('Runtime.consoleAPICalled', params, 1).forward, true);
      assert.equal(gov.evaluate('Runtime.consoleAPICalled', params, 1).forward, true);
      // Third should be deduplicated
      const third = gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(third.forward, false);
      assert.equal(third.reason, 'deduplicated');
    });

    it('does not deduplicate error type', () => {
      const params = makeConsole('error', 'error msg');
      for (let i = 0; i < 5; i++) {
        const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
        assert.equal(result.forward, true, `Error #${i + 1} should forward`);
      }
    });

    it('trims deep stacks for non-error messages', () => {
      const params = {
        type: 'warning',
        args: [{ type: 'string', value: 'test' }],
        stackTrace: {
          callFrames: Array.from({ length: 100 }, (_, i) => ({
            url: `file${i}.js`,
            lineNumber: i,
            columnNumber: 0,
            functionName: `fn${i}`,
            scriptId: String(i),
          })),
        },
        executionContextId: 1,
      };
      const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(result.forward, true);
      assert(result.params.stackTrace.callFrames.length <= 5);
      assert.equal(gov.getMetrics().stackTrimmed, 1);
    });

    it('keeps more frames for error type', () => {
      const params = {
        type: 'error',
        args: [{ type: 'string', value: 'err' }],
        stackTrace: {
          callFrames: Array.from({ length: 50 }, (_, i) => ({
            url: `file${i}.js`, lineNumber: i, columnNumber: 0,
            functionName: `fn${i}`, scriptId: String(i),
          })),
        },
        executionContextId: 1,
      };
      const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(result.forward, true);
      assert(result.params.stackTrace.callFrames.length <= 10);
    });

    it('does not mutate original params', () => {
      const originalFrames = Array.from({ length: 20 }, (_, i) => ({
        url: `file${i}.js`, lineNumber: i, columnNumber: 0,
        functionName: `fn${i}`, scriptId: String(i),
      }));
      const params = {
        type: 'log',
        args: [{ type: 'string', value: 'test' }],
        stackTrace: { callFrames: [...originalFrames] },
        executionContextId: 1,
      };
      gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(params.stackTrace.callFrames.length, 20);
    });
  });

  describe('byte limits', () => {
    it('rejects oversized events', () => {
      const params = {
        type: 'log',
        args: [{ type: 'string', value: 'x'.repeat(100_000) }],
        executionContextId: 1,
      };
      const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(result.forward, false);
      assert.equal(result.reason, 'event_too_large');
    });
  });

  describe('multi-tab isolation', () => {
    it('tracks per-tab state independently', () => {
      gov.evaluate('Runtime.consoleAPICalled', {
        type: 'log', args: [{ type: 'string', value: 'tab1' }],
        executionContextId: 1,
      }, 1);
      gov.evaluate('Runtime.consoleAPICalled', {
        type: 'log', args: [{ type: 'string', value: 'tab2' }],
        executionContextId: 2,
      }, 2);

      const tab1 = gov.getTabState(1);
      const tab2 = gov.getTabState(2);
      assert.equal(tab1.accepted, 1);
      assert.equal(tab2.accepted, 1);
    });

    it('cleans up tab state on remove', () => {
      gov.evaluate('Runtime.consoleAPICalled', {
        type: 'log', args: [{ type: 'string', value: 'test' }],
        executionContextId: 1,
      }, 42);
      assert(gov.tabs.has(42));
      gov.removeTab(42);
      assert(!gov.tabs.has(42));
    });
  });

  describe('T01: 3000 deep-stack console.warn in 2s', () => {
    it('accepts bounded events, drops/deduplicates the rest, counts correctly', () => {
      // Simulate deep-stack console flood
      const deepStack = {
        callFrames: Array.from({ length: 95 }, (_, i) => ({
          url: `app-${i}.js`, lineNumber: i * 10, columnNumber: 0,
          functionName: `recursiveCall${i}`, scriptId: String(i),
        })),
      };

      let forwarded = 0;
      let dropped = 0;

      for (let i = 0; i < 3000; i++) {
        const params = {
          type: 'warning',
          args: [{ type: 'string', value: `Deprecation warning #${i % 50}` }],
          stackTrace: deepStack,
          executionContextId: 1,
          timestamp: Date.now(),
        };
        const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
        if (result.forward) {
          forwarded++;
          // Verify stack was trimmed
          if (result.params.stackTrace) {
            assert(result.params.stackTrace.callFrames.length <= 5,
              'Stack should be trimmed to max 5 frames');
          }
        } else {
          dropped++;
        }
      }

      // Verify conservation: forwarded + dropped = 3000
      assert.equal(forwarded + dropped, 3000, 'Total must be conserved');

      // Verify bounded queue — burst should handle initial batch
      assert(forwarded > 0, 'Some messages should be forwarded');
      assert(forwarded <= 300, 'Most should be dropped due to dedup + rate');
      assert(dropped >= 2700, 'Most messages should be dropped');

      // Verify metrics consistency
      const metrics = gov.getMetrics();
      assert.equal(metrics.totalReceived, 3000);
      assert.equal(metrics.forwarded + metrics.rateLimited + metrics.deduplicated + metrics.byteLimited, 3000);
    });
  });

  describe('T02: normal console error/object not broken', () => {
    it('preserves args and stack for normal console.error', () => {
      const params = {
        type: 'error',
        args: [
          { type: 'string', value: 'Error: something broke' },
          { type: 'object', className: 'Error', description: 'Error: stack...', objectId: 'obj-123' },
        ],
        stackTrace: {
          callFrames: [
            { url: 'app.js', lineNumber: 42, columnNumber: 10, functionName: 'handleClick', scriptId: '1' },
            { url: 'app.js', lineNumber: 100, columnNumber: 5, functionName: 'main', scriptId: '1' },
          ],
        },
        executionContextId: 1,
      };
      const result = gov.evaluate('Runtime.consoleAPICalled', params, 1);
      assert.equal(result.forward, true);
      // Args must be preserved including objectId
      assert.equal(result.params.args.length, 2);
      assert.equal(result.params.args[1].objectId, 'obj-123');
      // Short stack should not be trimmed
      assert.equal(result.params.stackTrace.callFrames.length, 2);
    });
  });

  describe('T03: Network.dataReceived dropped, ExtraInfo preserved', () => {
    it('drops dataReceived but forwards ExtraInfo', () => {
      assert.equal(
        gov.evaluate('Network.dataReceived', {}, 1).forward,
        false,
      );
      assert.equal(
        gov.evaluate('Network.requestWillBeSentExtraInfo', {}, 1).forward,
        true,
      );
      assert.equal(
        gov.evaluate('Network.responseReceivedExtraInfo', {}, 1).forward,
        true,
      );
      assert.equal(
        gov.evaluate('Network.webSocketFrameSent', {}, 1).forward,
        true,
      );
    });
  });
});

describe('trimStack', () => {
  it('returns unchanged for short stacks', () => {
    const stack = { callFrames: [{ url: 'a.js', lineNumber: 1 }] };
    assert.equal(trimStack(stack, 5), stack);
  });

  it('trims and removes parent', () => {
    const stack = {
      callFrames: Array.from({ length: 20 }, (_, i) => ({ url: `f${i}.js`, lineNumber: i })),
      parent: { callFrames: [{ url: 'parent.js', lineNumber: 1 }] },
      parentId: { id: 'pid' },
    };
    const trimmed = trimStack(stack, 3);
    assert.equal(trimmed.callFrames.length, 3);
    assert.equal(trimmed.parent, undefined);
    assert.equal(trimmed.parentId, undefined);
    // Original unchanged
    assert.equal(stack.callFrames.length, 20);
  });

  it('handles undefined/null', () => {
    assert.equal(trimStack(undefined, 5), undefined);
    assert.equal(trimStack(null, 5), null);
  });
});

describe('consoleSignature', () => {
  it('builds consistent signatures', () => {
    const args = [{ type: 'string', value: 'hello' }];
    const frame = { url: 'app.js', lineNumber: 10 };
    const sig1 = consoleSignature('warning', args, frame, 1);
    const sig2 = consoleSignature('warning', args, frame, 1);
    assert.equal(sig1, sig2);
  });

  it('distinguishes different messages', () => {
    const frame = { url: 'app.js', lineNumber: 10 };
    const sig1 = consoleSignature('warning', [{ type: 'string', value: 'a' }], frame, 1);
    const sig2 = consoleSignature('warning', [{ type: 'string', value: 'b' }], frame, 1);
    assert.notEqual(sig1, sig2);
  });
});
