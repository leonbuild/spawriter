import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveElementObjectId, getReactSource, getReactComponentInfo } from './react-source.js';

type CdpCall = { method: string; params?: Record<string, unknown> };

/** Fake CDP sender with bippy pre-loaded and scripted per-method responses. */
function fakeCdp(calls: CdpCall[], handlers: Record<string, (params?: Record<string, unknown>) => unknown>) {
  return async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate' && params?.expression === '!!globalThis.__bippy') {
      return { result: { value: true } };
    }
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected CDP method: ${method}`);
    return handler(params);
  };
}

describe('resolveElementObjectId', () => {
  it('resolves a numeric ref via DOM.resolveNode', async () => {
    const calls: CdpCall[] = [];
    const cdp = fakeCdp(calls, {
      'DOM.resolveNode': (params) => {
        assert.equal(params?.backendNodeId, 42);
        return { object: { objectId: 'obj-42' } };
      },
    });
    const objectId = await resolveElementObjectId(cdp, 7, (ref) => (ref === 7 ? 42 : undefined));
    assert.equal(objectId, 'obj-42');
  });

  it('rejects unknown refs with guidance to run snapshot()', async () => {
    const cdp = fakeCdp([], {});
    await assert.rejects(() => resolveElementObjectId(cdp, 99, () => undefined), /snapshot\(\)/);
  });

  it('rejects refs without a CDP node id (aria fallback snapshot)', async () => {
    const cdp = fakeCdp([], {});
    await assert.rejects(() => resolveElementObjectId(cdp, 1, () => -1), /CSS selector/);
  });

  it('resolves a CSS selector via Runtime.evaluate', async () => {
    const calls: CdpCall[] = [];
    const cdp = fakeCdp(calls, {
      'Runtime.evaluate': (params) => {
        assert.ok(String(params?.expression).includes('document.querySelector(".btn")'));
        return { result: { objectId: 'obj-sel' } };
      },
    });
    assert.equal(await resolveElementObjectId(cdp, '.btn', () => undefined), 'obj-sel');
  });

  it('rejects selectors that match nothing', async () => {
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { subtype: 'null' } }),
    });
    await assert.rejects(() => resolveElementObjectId(cdp, '.missing', () => undefined), /No element matches/);
  });
});

describe('getReactSource', () => {
  it('injects bippy when missing, then calls the page function on the element', async () => {
    const calls: CdpCall[] = [];
    let bippyPresent = false;
    const cdp = async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && params?.expression === '!!globalThis.__bippy') {
        return { result: { value: bippyPresent } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('globalThis.__bippy = ')) {
        bippyPresent = true;
        return { result: {} };
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params?.objectId, 'obj-1');
        assert.ok(String(params?.functionDeclaration).includes('getFiberFromHostInstance'));
        assert.equal(params?.awaitPromise, true);
        return { result: { value: { fileName: 'src/App.tsx', lineNumber: 12, columnNumber: 4, componentName: 'App' } } };
      }
      throw new Error(`Unexpected: ${method}`);
    };

    const result = await getReactSource(cdp, '#root', () => undefined);
    assert.deepEqual(result, { fileName: 'src/App.tsx', lineNumber: 12, columnNumber: 4, componentName: 'App' });
    assert.ok(calls.some((c) => String(c.params?.expression ?? '').includes('globalThis.__bippy = ')));
  });

  it('maps fiber-not-found to a friendly error', async () => {
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { _notFound: 'fiber' } } }),
    });
    const result = await getReactSource(cdp, '.x', () => undefined);
    assert.ok('error' in result && result.error.includes('React fiber'));
  });

  it('maps source-not-found to a dev-build hint', async () => {
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { _notFound: 'source' } } }),
    });
    const result = await getReactSource(cdp, '.x', () => undefined);
    assert.ok('error' in result && result.error.includes('dev build'));
  });

  it('surfaces in-page exceptions', async () => {
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ exceptionDetails: { text: 'boom' } }),
    });
    await assert.rejects(() => getReactSource(cdp, '.x', () => undefined), /boom/);
  });
});

describe('getReactComponentInfo', () => {
  it('returns the component hierarchy payload', async () => {
    const payload = {
      componentName: 'Button',
      source: { fileName: 'src/Button.tsx', lineNumber: 3, columnNumber: 1 },
      hierarchy: [{ componentName: 'Button', source: null, props: { label: 'Go' } }],
      props: { label: 'Go' },
    };
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: payload } }),
    });
    assert.deepEqual(await getReactComponentInfo(cdp, '.btn', () => undefined), payload);
  });

  it('maps null to a friendly error', async () => {
    const cdp = fakeCdp([], {
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: null } }),
    });
    const result = await getReactComponentInfo(cdp, '.btn', () => undefined);
    assert.ok('error' in result && result.error.includes('React component'));
  });
});
