import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { chromium } from 'playwright-core';
import { PlaywrightExecutor } from './pw-executor.js';

it('keeps authenticated requests working across refresh and single-module removal', async t => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(error => {
    if (!/not found at|executable doesn't exist/i.test(error.message)) throw error;
    t.skip('Chrome is not installed');
    return null;
  });
  if (!browser) return;
  t.after(() => browser.close());

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/protected') {
      const authenticated = req.headers.cookie === 'sid=fixture'
        && req.headers.authorization === 'Bearer fixture-token'
        && req.headers['x-session'] === 'fixture-session';
      res.writeHead(authenticated ? 200 : 401).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Session fixture</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addCookies([{ url: origin, name: 'sid', value: 'fixture', httpOnly: true }]);
  // Supply the host library's removeOverride API. Seed storage just once so
  // a navigation cannot silently repair a session or restore a removed key.
  await page.addInitScript(() => {
    Object.assign(window, { importMapOverrides: {
      removeOverride(name: string) { localStorage.removeItem('import-map-override:' + name); },
    } });
  });
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem('token', 'fixture-token');
    sessionStorage.setItem('session', 'fixture-session');
    localStorage.setItem('import-map-override:@org/nav', '/nav.js');
    localStorage.setItem('import-map-override:@org/cart', '/cart.js');
  });
  const status = () => page.evaluate(async () => {
    const response = await fetch('/protected', { headers: {
      Authorization: 'Bearer ' + localStorage.getItem('token'),
      'X-Session': sessionStorage.getItem('session') ?? '',
    } });
    return response.status;
  });
  const overrides = () => page.evaluate(() => [
    localStorage.getItem('import-map-override:@org/nav'),
    localStorage.getItem('import-map-override:@org/cart'),
  ]);

  const executor = new PlaywrightExecutor();
  t.mock.method(executor, 'ensureConnection', async () => ({ browser, context, page }));
  const run = async (code: string) => {
    const result = await executor.execute(code);
    assert.equal(result.isError, false, result.text);
    return result.text;
  };
  assert.equal(await status(), 200);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const rejected = await executor.execute('await clearCacheAndReload({ clear: "cache,local_storage,session_storage" })');
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /Only clear/);
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  assert.equal(await status(), 200);

  for (const code of ['await clearCacheAndReload()', 'await clearCacheAndReload({ clear: "cache" })']) {
    const before = await page.evaluate(() => performance.timeOrigin);
    await run(code);
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), before);
    assert.equal(await status(), 200);
    assert.deepEqual(await overrides(), ['/nav.js', '/cart.js']);
  }
  await run('await singleSpa.override("remove", "@org/nav")');
  await run('await ensureFreshRender()');
  assert.deepEqual(await overrides(), [null, '/cart.js']);
  assert.equal(await status(), 200);

  await run('await storage("clear_storage", { storage_types: "session_storage" })');
  assert.equal(await status(), 401);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('session')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'fixture-token');
  assert.deepEqual(await overrides(), [null, '/cart.js']);
  assert.ok((await context.cookies(origin)).some(cookie => cookie.name === 'sid' && cookie.value === 'fixture'));
});
