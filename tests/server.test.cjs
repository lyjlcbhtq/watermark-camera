const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');

async function setup(t, options = {}) {
  const { createAppServer } = await import('../server.mjs');
  const server = createAppServer({ apiKey: '', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, request: (pathname, init) => fetch(origin + pathname, init) };
}
const result = (address = '测试地址') => new Response(JSON.stringify({ status: '1', info: 'OK', regeocode: { formatted_address: address, addressComponent: {}, pois: [] } }), { headers: { 'Content-Type': 'application/json' } });
const query = '/api/reverse-geocode?longitude=120.1&latitude=30.2';

test('server only serves explicit public assets and rejects traversal and source files', async t => {
  const { request, server } = await setup(t);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /水印相机/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  for (const name of ['/server.mjs', '/package.json', '/tests/server.test.cjs', '/.env', '/.git/config', '/deploy/camera.env.example', '/not-a-page']) {
    assert.equal((await request(name)).status, 404, name);
  }
  for (const rawPath of ['/%2e%2e/server.mjs', '/icons/../index.html', '/%00index.html', '/icons%5c..%5c.env', '/%zz']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: rawPath }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(status, 400, rawPath);
  }
  const method = await request('/index.html', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, HEAD');
});

test('subpath deployment retains correct redirects, same-origin API path and worker scope', async t => {
  const { request } = await setup(t, { basePath: '/watermark-camera/' });
  const redirect = await request('/watermark-camera?from=home', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/watermark-camera/?from=home');
  assert.equal((await request('/')).status, 404);
  assert.equal((await request('/watermark-camera/')).status, 200);
  const worker = await request('/watermark-camera/sw.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('service-worker-allowed'), '/watermark-camera/');
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.equal((await request('/watermark-camera' + query)).status, 503);
  const { createAppServer } = await import('../server.mjs');
  for (const invalid of ['camera/', '/camera', '/../', '//', '/%2e%2e/']) assert.throws(() => createAppServer({ basePath: invalid }), TypeError);
});

test('public assets have gzip, representation-specific ETags and body-free HEAD/304 responses', async t => {
  const { origin, request } = await setup(t);
  const plain = await request('/index.html', { headers: { 'Accept-Encoding': 'identity' } });
  const bytes = await plain.text();
  const compressed = await new Promise((resolve, reject) => {
    const req = http.get(origin + '/index.html', { headers: { 'Accept-Encoding': 'gzip' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject);
  });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(compressed.body).toString(), bytes);
  assert.notEqual(compressed.headers.etag, plain.headers.get('etag'));
  assert.ok(compressed.body.length < Buffer.byteLength(bytes) / 2);
  const unchanged = await request('/index.html', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': plain.headers.get('etag') } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  const head = await request('/index.html', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip;q=0, identity' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-encoding'), null); assert.equal(await head.text(), '');
});

test('whitelisted paths cannot escape the public root through a symlinked directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-server-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-outside-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.writeFile(path.join(outside, 'icon-192.png'), 'private');
  await fs.symlink(outside, path.join(root, 'icons'));
  const { request } = await setup(t, { root });
  assert.equal((await request('/icons/icon-192.png')).status, 404);
});

test('geocoding validates coordinates and refuses missing credentials without an upstream call', async t => {
  let calls = 0;
  const { request } = await setup(t, { fetchImpl: async () => { calls++; return result(); } });
  const unavailable = await request(query);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'SERVICE_NOT_CONFIGURED');
  for (const params of ['longitude=181&latitude=30', 'longitude=1&latitude=-91', 'longitude=&latitude=1', 'longitude=NaN&latitude=1', 'longitude=120&longitude=121&latitude=30', 'longitude=1&latitude=1&key=other', 'latitude=30']) {
    assert.equal((await request('/api/reverse-geocode?' + params)).status, 400, params);
  }
  assert.equal((await request(query, { method: 'POST' })).status, 405);
  assert.equal((await request(query, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(calls, 0);
});

test('proxy keeps keys server-side, caches exact coordinates briefly, and bounds the cache', async t => {
  const secret = 'server-only-test-key';
  let calls = 0, clock = 0;
  const { request } = await setup(t, { apiKey: secret, now: () => clock, cacheMs: 100, maxCacheEntries: 1,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://restapi.amap.com');
      assert.equal(url.searchParams.get('key'), secret);
      assert.equal(url.searchParams.get('location'), '120.100000,30.200000');
      assert.equal(options.redirect, 'error');
      return result();
    } });
  const first = await request(query);
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), { status: '1', regeocode: { formatted_address: '测试地址', addressComponent: {}, pois: [] } });
  assert.equal((await request(query)).status, 200); assert.equal(calls, 1);
  clock = 101; assert.equal((await request(query)).status, 200); assert.equal(calls, 2);
});

test('upstream failures and oversized data expose no credential or provider error details', async t => {
  const { request } = await setup(t, { apiKey: 'secret-value', fetchImpl: async url => new Response(JSON.stringify({ status: '0', info: url.href, infocode: 'INVALID_KEY' })) });
  const response = await request(query);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /secret-value|INVALID_KEY|restapi/);
  const oversized = await setup(t, { apiKey: 'secret-value', fetchImpl: async () => new Response('x'.repeat(300 * 1024)) });
  assert.equal((await oversized.request(query)).status, 502);
});

test('upstream requests time out and free a concurrency slot even when fetch ignores abort', async t => {
  let calls = 0;
  const { request } = await setup(t, { apiKey: 'test', timeoutMs: 25, maxConcurrent: 1,
    fetchImpl: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(result()) });
  const timeout = await request(query);
  assert.equal(timeout.status, 504);
  assert.equal((await request(query)).status, 200);
  assert.equal(calls, 2);
});

test('duplicate requests share upstream work; different coordinates respect the concurrency bound', async t => {
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const { request } = await setup(t, { apiKey: 'test', maxConcurrent: 1, fetchImpl: () => {
    calls++; started(); return new Promise(resolve => { release = () => resolve(result()); });
  } });
  const first = request(query); await begun;
  const duplicate = request(query);
  const busy = await request('/api/reverse-geocode?longitude=121&latitude=31');
  assert.equal(busy.status, 503);
  release();
  assert.deepEqual((await Promise.all([first, duplicate])).map(response => response.status), [200, 200]);
  assert.equal(calls, 1);
});

test('request quotas expire and an untrusted forwarded address cannot bypass them', async t => {
  let clock = 0;
  const { request } = await setup(t, { apiKey: 'test', now: () => clock, maxPerMinute: 2, fetchImpl: async () => result() });
  assert.equal((await request(query)).status, 200);
  assert.equal((await request(query, { headers: { 'X-Real-IP': '203.0.113.1' } })).status, 200);
  const limited = await request(query, { headers: { 'X-Real-IP': '203.0.113.2' } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  clock = 60001;
  assert.equal((await request(query)).status, 200);
});

test('cache capacity evicts old coordinates without confusing different locations', async t => {
  const queries = [query, '/api/reverse-geocode?longitude=121&latitude=31'];
  const locations = [];
  const { request } = await setup(t, { apiKey: 'test', maxCacheEntries: 1, fetchImpl: async url => {
    const coordinates = url.searchParams.get('location');
    locations.push(coordinates);
    return result(coordinates);
  } });
  for (const next of [queries[0], queries[1], queries[1], queries[0]]) {
    const response = await request(next);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.regeocode.formatted_address, next === query ? '120.100000,30.200000' : '121.000000,31.000000');
  }
  assert.deepEqual(locations, ['120.100000,30.200000', '121.000000,31.000000', '120.100000,30.200000']);
});

test('a stalled upstream response body also respects the deadline and releases its slot', async t => {
  let cancelled = false, calls = 0;
  const { request } = await setup(t, { apiKey: 'test', timeoutMs: 25, maxConcurrent: 1, fetchImpl: async (_url, { signal }) => {
    if (++calls > 1) return result();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"1","regeocode":'));
        signal.addEventListener('abort', () => { cancelled = true; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
      },
    });
    return new Response(body);
  } });
  assert.equal((await request(query)).status, 504);
  assert.equal(cancelled, true);
  assert.equal((await request(query)).status, 200);
});

test('trusted loopback proxy separates clients while the global quota still limits total work', async t => {
  const { request } = await setup(t, { apiKey: 'test', trustProxy: true, maxPerMinute: 1, maxGlobalPerMinute: 2,
    fetchImpl: async () => result() });
  const from = ip => request(query, { headers: { 'X-Real-IP': ip } });
  assert.equal((await from('203.0.113.1')).status, 200);
  assert.equal((await from('203.0.113.1')).status, 429);
  assert.equal((await from('203.0.113.2')).status, 200);
  assert.equal((await from('203.0.113.3')).status, 429);
});

test('production headers permit the local verification module worker and its vendored imports', async t => {
  const { request, origin } = await setup(t);
  for (const name of ['evidence.js', 'evidence-worker.js', 'verify.html', 'verify.js', 'location-service.js',
    'vendor/noble-hashes/sha2.js', 'vendor/noble-hashes/_md.js', 'vendor/noble-hashes/_u64.js', 'vendor/noble-hashes/utils.js']) {
    const response = await request('/' + name);
    assert.equal(response.status, 200, name);
    if (name.endsWith('.js')) assert.match(response.headers.get('content-type'), /^application\/javascript/);
  }
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/verify.html');
  const digest = await page.evaluate(() => Evidence.hashBlob(new Blob(['production-csp-check'])));
  assert.equal(digest, createHash('sha256').update('production-csp-check').digest('hex'));
  assert.deepEqual(errors, []);
});
