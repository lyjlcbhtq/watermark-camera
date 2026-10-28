const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../sw.js'), 'utf8');
const scope = 'https://example.test/watermark-camera/';
const shell = ['index.html', 'media-store.js', 'location-service.js', 'evidence.js', 'evidence-worker.js', 'verify.html', 'verify.js', 'vendor/noble-hashes/sha2.js', 'vendor/noble-hashes/_md.js', 'vendor/noble-hashes/_u64.js', 'vendor/noble-hashes/utils.js', 'manifest.json', 'icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const cacheName = (base = scope, version = 'v6') => `watermark-camera-shell-${encodeURIComponent(base)}-${version}`;

function storage() {
  const entries = new Map();
  const state = { failOpen: false, failKeys: false, failDelete: false, entries, downloads: [] };
  const network = { offline: false, missing: null, version: 'new', calls: [] };
  const fetch = async request => {
    const url = typeof request === 'string' ? request : request.url;
    network.calls.push(url);
    if (network.offline) throw new TypeError('Network unavailable');
    return new Response(network.version + ':' + new URL(url).pathname, {
      status: network.missing === url ? 404 : 200
    });
  };
  const caches = {
    async open(name) {
      if (state.failOpen) throw new Error('CacheStorage unavailable');
      if (!entries.has(name)) entries.set(name, new Map());
      const values = entries.get(name);
      return {
        async addAll(requests) {
          state.downloads.push(...requests);
          // Cache.addAll is atomic by contract. Model it without committing partial fetches.
          const responses = await Promise.all(requests.map(fetch));
          if (responses.some(response => !response.ok)) throw new TypeError('Incomplete app shell');
          requests.forEach((request, i) => values.set(request.url, responses[i]));
        },
        async match(request) {
          return values.get(typeof request === 'string' ? request : request.url)?.clone();
        }
      };
    },
    async keys() {
      if (state.failKeys) throw new Error('CacheStorage unavailable');
      return [...entries.keys()];
    },
    async delete(name) {
      if (state.failDelete) throw new Error('Cannot delete cache');
      return entries.delete(name);
    }
  };
  return { state, network, caches, fetch };
}

function worker(store, base = scope, version = 'v6') {
  const handlers = new Map();
  const lifecycle = { skipWaiting: 0, claim: 0 };
  vm.runInNewContext(source.replace("+ 'v6'", `+ '${version}'`), {
    URL, Request,
    caches: store.caches,
    fetch: store.fetch,
    self: {
      registration: { scope: base },
      addEventListener: (name, fn) => handlers.set(name, fn),
      skipWaiting: async () => { lifecycle.skipWaiting++; },
      clients: { claim: async () => { lifecycle.claim++; } }
    }
  });
  return {
    lifecycle,
    async dispatch(name) {
      let pending;
      handlers.get(name)({ waitUntil: promise => { pending = promise; } });
      await pending;
    },
    request(url, options = {}) {
      let response;
      handlers.get('fetch')({
        request: { url, method: 'GET', mode: 'cors', ...options },
        respondWith: promise => { response = promise; }
      });
      return response;
    }
  };
}

test('installation caches the complete shell and defers replacement of open pages', async () => {
  const store = storage();
  const app = worker(store);
  await app.dispatch('install');
  assert.deepEqual([...store.state.entries.get(cacheName()).keys()], shell.map(name => scope + name));
  assert.ok(store.state.downloads.every(request => request.cache === 'reload'));
  assert.equal(app.lifecycle.skipWaiting, 0);
  assert.equal(app.lifecycle.claim, 0);
});

test('a missing dependency rejects installation and preserves the working cache', async () => {
  const store = storage();
  const oldName = cacheName(scope, 'v2');
  store.state.entries.set(oldName, new Map([[scope + 'index.html', new Response('working page')]]));
  store.network.missing = scope + 'media-store.js';
  const app = worker(store);
  await assert.rejects(app.dispatch('install'), /Incomplete app shell/);
  assert.equal(store.state.entries.has(cacheName()), false);
  assert.equal(await store.state.entries.get(oldName).get(scope + 'index.html').text(), 'working page');
  assert.equal(app.lifecycle.skipWaiting, 0);
});

test('failed installation cleanup preserves the original error', async () => {
  const store = storage();
  store.network.offline = true;
  store.state.failDelete = true;
  await assert.rejects(worker(store).dispatch('install'), /Network unavailable/);
});

test('a waiting update leaves the previous worker and all open pages usable offline', async () => {
  const store = storage();
  store.network.version = 'old';
  const oldWorker = worker(store, scope, 'v2');
  await oldWorker.dispatch('install');
  store.network.version = 'new';
  const update = worker(store);
  await update.dispatch('install');
  store.network.offline = true;
  assert.equal(update.lifecycle.skipWaiting, 0);
  for (const url of [scope, scope + 'index.html?window=2', scope + 'media-store.js']) {
    const response = await oldWorker.request(url, { mode: 'navigate' });
    assert.match(await response.text(), /^old:/);
  }
  await update.dispatch('activate');
  assert.equal(store.state.entries.has(cacheName(scope, 'v2')), false);
  assert.match(await (await update.request(scope, { mode: 'navigate' })).text(), /^new:/);
});

test('activation deletes only prior versions belonging to its own deployment path', async () => {
  const store = storage();
  const ownOld = cacheName(scope, 'v2');
  const sibling = cacheName('https://example.test/another-camera/', 'v2');
  const legacy = 'watermark-camera-shell-v2';
  for (const name of [ownOld, sibling, legacy, 'another-app-cache']) store.state.entries.set(name, new Map());
  const app = worker(store);
  await app.dispatch('install');
  await app.dispatch('activate');
  assert.equal(store.state.entries.has(ownOld), false);
  for (const name of [cacheName(), sibling, legacy, 'another-app-cache']) assert.equal(store.state.entries.has(name), true);
  assert.equal(app.lifecycle.claim, 1);
});

test('cleanup errors do not prevent activation', async () => {
  const store = storage();
  const app = worker(store);
  await app.dispatch('install');
  store.state.failKeys = true;
  await app.dispatch('activate');
  assert.equal(app.lifecycle.claim, 1);
  assert.equal((await app.request(scope, { mode: 'navigate' })).status, 200);
});

test('offline launches and asset queries use the installed version without network requests', async () => {
  const store = storage();
  const app = worker(store);
  await app.dispatch('install');
  store.network.calls.length = 0;
  store.network.offline = true;
  for (const url of [scope, scope + '?source=homescreen', scope + 'index.html?from=bookmark']) {
    const response = await app.request(url, { mode: 'navigate' });
    assert.equal(await response.text(), 'new:/watermark-camera/index.html');
  }
  for (const name of shell) {
    assert.equal((await app.request(scope + name + '?v=3')).status, 200);
  }
  assert.deepEqual(store.network.calls, []);
});

test('requests outside the app shell remain normal network requests', () => {
  const app = worker(storage());
  for (const [url, options] of [
    ['https://maps.example.test/location', {}],
    ['https://example.test/watermark-camera-other/index.html', { mode: 'navigate' }],
    [scope + 'reverse-geocode', {}],
    [scope + 'other.html', { mode: 'navigate' }],
    [scope + 'index.html', { method: 'POST' }]
  ]) assert.equal(app.request(url, options), undefined);
});

test('an unavailable or evicted cache falls back to the network for online launches', async () => {
  const store = storage();
  const app = worker(store);
  store.state.failOpen = true;
  assert.equal(await (await app.request(scope, { mode: 'navigate' })).text(), 'new:/watermark-camera/');
  store.state.failOpen = false;
  assert.equal(await (await app.request(scope + 'media-store.js')).text(), 'new:/watermark-camera/media-store.js');
});

test('two installations on the same origin retain separate offline shells', async () => {
  const store = storage();
  const siblingScope = 'https://example.test/camera-preview/';
  const first = worker(store);
  const second = worker(store, siblingScope);
  store.network.version = 'production';
  await first.dispatch('install');
  store.network.version = 'preview';
  await second.dispatch('install');
  await second.dispatch('activate');
  store.network.offline = true;
  assert.match(await (await first.request(scope, { mode: 'navigate' })).text(), /^production:/);
  assert.match(await (await second.request(siblingScope, { mode: 'navigate' })).text(), /^preview:/);
});
