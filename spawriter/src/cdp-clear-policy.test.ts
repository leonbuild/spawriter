// Tests for the global-clear denial policy: browser-wide data clearing must be
// functionally unsupported at every layer (relay ingress, executor helpers,
// extension bridge). Guards against the incident class where an agent's
// context.clearCookies() / Network.clearBrowserCookies wiped the user's logins
// for every site in the real Chrome profile.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  GLOBAL_CLEAR_CDP_METHODS,
  getCdpClearDenial,
  isExactHttpOrigin,
} from './cdp-clear-policy.js';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The extension workspace is CommonJS to Node (webpack consumes the ESM
// syntax), so the shared policy module is evaluated in a vm instead of
// imported directly.
function loadExtensionClearPolicy(): Record<string, any> {
  const source = src('../../extension/src/ai_bridge/clear-policy.js').replace(/^export /gm, '');
  const exported: Record<string, unknown> = {};
  vm.runInNewContext(
    source +
      '\n;__exports.GLOBAL_CLEAR_CDP_METHODS = GLOBAL_CLEAR_CDP_METHODS;' +
      '__exports.getGlobalClearDenial = getGlobalClearDenial;' +
      '__exports.getClearDataForOriginDenial = getClearDataForOriginDenial;' +
      '__exports.buildScopedBrowsingDataArgs = buildScopedBrowsingDataArgs;',
    { URL, __exports: exported },
  );
  return exported;
}

const {
  GLOBAL_CLEAR_CDP_METHODS: extGlobalClearMethods,
  getGlobalClearDenial,
  getClearDataForOriginDenial,
  buildScopedBrowsingDataArgs,
} = loadExtensionClearPolicy();

// ---------------------------------------------------------------------------
// Node-side policy (relay / executor)
// ---------------------------------------------------------------------------

describe('cdp-clear-policy: getCdpClearDenial', () => {
  it('denies every browser-wide clear method', () => {
    for (const method of ['Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Storage.clearCookies']) {
      const denial = getCdpClearDenial(method);
      assert.ok(denial, `${method} must be denied`);
      assert.match(denial!, /blocked/);
      assert.match(denial!, /origin-scoped alternatives/i);
    }
  });

  it('keeps the deny set in sync with the test expectations', () => {
    assert.deepEqual(
      [...GLOBAL_CLEAR_CDP_METHODS].sort(),
      ['Network.clearBrowserCache', 'Network.clearBrowserCookies', 'Storage.clearCookies'],
    );
  });

  it('allows scoped and unrelated commands', () => {
    assert.equal(getCdpClearDenial('Network.deleteCookies', { name: 'a', domain: 'x.com' }), null);
    assert.equal(getCdpClearDenial('Network.getCookies'), null);
    assert.equal(getCdpClearDenial('Page.reload', { ignoreCache: true }), null);
    assert.equal(getCdpClearDenial('Storage.getUsageAndQuota', { origin: 'https://x.com' }), null);
    assert.equal(getCdpClearDenial('Runtime.evaluate', { expression: '1' }), null);
  });

  it('allows Storage.clearDataForOrigin only for a single exact http(s) origin', () => {
    assert.equal(getCdpClearDenial('Storage.clearDataForOrigin', { origin: 'https://x.com', storageTypes: 'local_storage' }), null);
    assert.equal(getCdpClearDenial('Storage.clearDataForOrigin', { origin: 'http://localhost:9150', storageTypes: 'cookies' }), null);

    for (const badOrigin of [undefined, '', '*', 'https://x.com/path', 'https://x.com/', 'file:///etc', 'chrome://settings', 'null', 'x.com']) {
      const denial = getCdpClearDenial('Storage.clearDataForOrigin', { origin: badOrigin as never, storageTypes: 'cookies' });
      assert.ok(denial, `origin "${badOrigin}" must be denied`);
      assert.match(denial!, /not supported/);
    }
  });
});

describe('cdp-clear-policy: isExactHttpOrigin', () => {
  it('accepts exact origins, rejects everything else', () => {
    assert.equal(isExactHttpOrigin('https://a.example.com'), true);
    assert.equal(isExactHttpOrigin('http://localhost:8080'), true);
    assert.equal(isExactHttpOrigin('https://a.example.com/'), false);
    assert.equal(isExactHttpOrigin('https://a.example.com/x'), false);
    assert.equal(isExactHttpOrigin('ws://a.example.com'), false);
    assert.equal(isExactHttpOrigin('*'), false);
    assert.equal(isExactHttpOrigin(''), false);
  });
});

// ---------------------------------------------------------------------------
// Extension-side policy (bridge / background)
// ---------------------------------------------------------------------------

describe('extension clear-policy: getGlobalClearDenial', () => {
  it('mirrors the Node-side deny set exactly', () => {
    assert.deepEqual([...extGlobalClearMethods].sort(), [...GLOBAL_CLEAR_CDP_METHODS].sort());
  });

  it('denies global clears and allows scoped commands', () => {
    assert.ok(getGlobalClearDenial('Network.clearBrowserCookies'));
    assert.ok(getGlobalClearDenial('Network.clearBrowserCache'));
    assert.ok(getGlobalClearDenial('Storage.clearCookies'));
    assert.equal(getGlobalClearDenial('Network.deleteCookies'), null);
    assert.equal(getGlobalClearDenial('Storage.clearDataForOrigin'), null);
  });
});

describe('extension clear-policy: getClearDataForOriginDenial', () => {
  it('allows clearing exactly the tab origin', () => {
    assert.equal(getClearDataForOriginDenial('https://x.com', 'https://x.com/some/page?q=1'), null);
    assert.equal(getClearDataForOriginDenial('http://localhost:9150', 'http://localhost:9150/'), null);
  });

  it('denies any other origin (cross-site clearing)', () => {
    assert.ok(getClearDataForOriginDenial('https://zhihu.com', 'https://x.com/page'));
    assert.ok(getClearDataForOriginDenial('https://sub.x.com', 'https://x.com/page'));
    assert.ok(getClearDataForOriginDenial('*', 'https://x.com/page'));
    assert.ok(getClearDataForOriginDenial(undefined, 'https://x.com/page'));
  });

  it('denies when the tab has no http(s) origin', () => {
    assert.ok(getClearDataForOriginDenial('https://x.com', 'about:blank'));
    assert.ok(getClearDataForOriginDenial('https://x.com', 'chrome://newtab'));
    assert.ok(getClearDataForOriginDenial('https://x.com', ''));
  });
});

describe('extension clear-policy: buildScopedBrowsingDataArgs', () => {
  // vm-created objects live in another realm; JSON-normalize before deepEqual.
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  it('scopes to the tab origin on Chrome', () => {
    const result = buildScopedBrowsingDataArgs('https://x.com/feed', { cache: true, serviceWorkers: true }, false);
    assert.deepEqual(plain(result), {
      removalOptions: { since: 0, origins: ['https://x.com'] },
      dataTypes: { cache: true, serviceWorkers: true },
    });
  });

  it('never emits unscoped removal options', () => {
    const result = buildScopedBrowsingDataArgs('https://x.com/feed', { cache: true, serviceWorkers: true }, false);
    assert.ok('removalOptions' in result && (result.removalOptions.origins?.length === 1 || result.removalOptions.hostnames?.length === 1));
  });

  it('strips cookie/history wipes whatever the caller asked for', () => {
    const result = buildScopedBrowsingDataArgs(
      'https://x.com/feed',
      { cache: true, cookies: true, history: true, passwords: true, localStorage: true },
      false,
    );
    assert.deepEqual(plain(result.dataTypes), { cache: true });
  });

  it('uses hostnames on Firefox and drops the unscopable HTTP cache', () => {
    const result = buildScopedBrowsingDataArgs('https://x.com/feed', { cache: true, serviceWorkers: true }, true);
    assert.deepEqual(plain(result), {
      removalOptions: { since: 0, hostnames: ['x.com'] },
      dataTypes: { serviceWorkers: true },
    });
  });

  it('errors instead of clearing when nothing can be scoped', () => {
    assert.ok('error' in buildScopedBrowsingDataArgs('https://x.com', { cache: true }, true));
    assert.ok('error' in buildScopedBrowsingDataArgs('https://x.com', { cookies: true }, false));
    assert.ok('error' in buildScopedBrowsingDataArgs('about:blank', { cache: true }, false));
    assert.ok('error' in buildScopedBrowsingDataArgs('chrome://newtab', { cache: true }, false));
    assert.ok('error' in buildScopedBrowsingDataArgs('', { cache: true }, false));
  });
});

// ---------------------------------------------------------------------------
// Runtime enforcement: relaySendCdp rejects before touching any session state
// ---------------------------------------------------------------------------

describe('relaySendCdp enforcement', () => {
  it('rejects browser-wide clears with the policy error', async () => {
    const { relaySendCdp } = await import('./relay.js');
    await assert.rejects(relaySendCdp('Network.clearBrowserCookies'), /blocked/);
    await assert.rejects(relaySendCdp('Network.clearBrowserCache'), /blocked/);
    await assert.rejects(relaySendCdp('Storage.clearCookies'), /blocked/);
    await assert.rejects(
      relaySendCdp('Storage.clearDataForOrigin', { origin: 'https://another-site.com/', storageTypes: 'cookies' }),
      /not supported/,
    );
  });
});

// ---------------------------------------------------------------------------
// Wiring: every ingress/exit point must consult the policy
// ---------------------------------------------------------------------------

describe('clear-policy wiring', () => {
  it('relay consults the policy on both CDP ingress paths and relaySendCdp', () => {
    const relaySrc = src('./relay.ts');
    const calls = relaySrc.match(/getCdpClearDenial\(/g) || [];
    assert.ok(calls.length >= 3, `expected >=3 getCdpClearDenial call sites in relay.ts, found ${calls.length}`);
  });

  it('executor never uses Playwright clearCookies (globally destructive under the hood)', () => {
    const executorSrc = src('./pw-executor.ts');
    assert.ok(!/\.clearCookies\(/.test(executorSrc), 'pw-executor.ts must not call clearCookies()');
  });

  it('executor helpers reject origin overrides', () => {
    const executorSrc = src('./pw-executor.ts');
    const rejects = executorSrc.match(/origin override is not supported/g) || [];
    assert.ok(rejects.length >= 2, 'clear_storage and clearCacheAndReload must reject explicit origins');
  });

  it('bridge enforces the policy at the last hop and keeps no global clears in its slow set', () => {
    const bridgeSrc = src('../../extension/src/ai_bridge/bridge.js');
    assert.ok(bridgeSrc.includes('getGlobalClearDenial('), 'bridge must deny global clear CDP methods');
    assert.ok(bridgeSrc.includes('getClearDataForOriginDenial('), 'bridge must origin-check clearDataForOrigin');
    assert.ok(bridgeSrc.includes('buildScopedBrowsingDataArgs('), 'bridge clearCacheAndReload must use scoped browsingData');
    const slowSet = bridgeSrc.match(/SLOW_CDP_METHODS = new Set\(\[([^\]]*)\]/)?.[1] ?? '';
    assert.ok(!slowSet.includes('clearBrowser'), 'global clears must not be first-class citizens of SLOW_CDP_METHODS');
  });

  it('background clear-cache handler uses scoped browsingData', () => {
    const backgroundSrc = src('../../extension/src/background_script.js');
    assert.ok(backgroundSrc.includes('buildScopedBrowsingDataArgs('));
    assert.ok(!/browsingData\.remove\(\s*\{\s*since:\s*0\s*\}/.test(backgroundSrc), 'no unscoped browsingData.remove');
  });
});
