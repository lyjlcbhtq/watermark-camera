const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

let server, browser, origin;
before(async () => {
  const script = await fs.readFile(path.resolve(__dirname, '../media-store.js'));
  server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname.endsWith('/media-store.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(script);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><script src="./media-store.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.TEST_WEBKIT ? webkit : chromium).launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught page errors'));
  await page.goto(origin + '/camera/');
  return { page, context };
}

test('media store persists blobs across reload and lists only metadata in newest-first order', async t => {
  const { page } = await setup(t);
  await page.evaluate(async () => {
    await MediaStore.put({ id: 'old', type: 'photo', timestamp: 1, blob: new Blob(['old photo'], { type: 'image/jpeg' }) });
    await MediaStore.put({ id: 'new', type: 'video', timestamp: 2, blob: new Blob(['video bytes'], { type: 'video/mp4' }), thumbnail: new Blob(['tiny thumbnail'], { type: 'image/jpeg' }) });
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const items = await MediaStore.list();
    const record = await MediaStore.get('new');
    return {
      ids: items.map(item => item.id),
      hasBlob: items.some(item => 'blob' in item),
      size: items[0].size,
      thumbnail: await items[0].thumbnail.text(),
      bytes: await record.blob.text(),
      type: record.blob.type,
    };
  });
  assert.deepEqual(result, { ids: ['new', 'old'], hasBlob: false, size: 11, thumbnail: 'tiny thumbnail', bytes: 'video bytes', type: 'video/mp4' });
});

test('album scope matches directory and index.html while separating other apps', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => MediaStore.put({ id: 'photo', type: 'photo', timestamp: 1, blob: new Blob(['photo']) }));
  await page.goto(origin + '/camera/index.html?from=homescreen');
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 1);
  await page.goto(origin + '/another-camera/');
  assert.deepEqual(await page.evaluate(() => MediaStore.list()), []);
  await page.goto(origin + '/camera/');
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 1);
});

test('capture details survive reload beside the media without entering album pages', async t => {
  const { page } = await setup(t);
  const evidence = {
    id: 'capture-1', source: 'browser-capture', processing: 'canvas-burned-watermark',
    deviceTime: '2026-10-22T10:00:00.000Z', elapsedMs: 1200,
    location: { lat: 30.2, lng: 120.1, accuracy: 17, source: 'browser-geolocation' },
    attestation: 'local-unattested',
  };
  await page.evaluate(async evidence => {
    await MediaStore.put({ id: 'legacy', type: 'photo', timestamp: 1, blob: new Blob(['old']) });
    await MediaStore.put({ id: 'new', type: 'video', timestamp: 2, blob: new Blob(['video']), evidence });
  }, evidence);
  await page.reload();
  const result = await page.evaluate(async () => ({
    evidence: (await MediaStore.get('new')).evidence,
    bytes: await (await MediaStore.get('new')).blob.text(),
    legacyHasNoEvidence: (await MediaStore.get('legacy')).evidence === undefined,
    listHasEvidence: (await MediaStore.list()).some(item => 'evidence' in item),
    pageHasEvidence: (await MediaStore.listPage({ limit: 1 })).items.some(item => 'evidence' in item),
  }));
  assert.deepEqual(result, { evidence, bytes: 'video', legacyHasNoEvidence: true, listHasEvidence: false, pageHasEvidence: false });
});

test('overwrite and deletion update both stores atomically; missing records are undefined', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    await MediaStore.put({ id: 'same', type: 'photo', timestamp: 1, blob: new Blob(['old']), thumbnail: new Blob(['old thumb']) });
    await MediaStore.put({ id: 'same', type: 'video', timestamp: 2, blob: new Blob(['replacement']) });
    const [metadata] = await MediaStore.list();
    const record = await MediaStore.get('same');
    const bytes = await record.blob.text();
    await MediaStore.remove('same');
    await MediaStore.remove('missing');
    return { metadata, bytes, list: await MediaStore.list(), missing: (await MediaStore.get('same')) === undefined };
  });
  assert.deepEqual(result, { metadata: { id: 'same', type: 'video', timestamp: 2, size: 11 }, bytes: 'replacement', list: [], missing: true });
});

test('an abort after a successful write request rejects put and retains the previous record', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    await MediaStore.put({ id: 'same', type: 'photo', timestamp: 1, blob: new Blob(['original']), evidence: { id: 'original-capture' } });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (this.name === 'media') request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    };
    let rejected = false;
    try { await MediaStore.put({ id: 'same', type: 'video', timestamp: 2, blob: new Blob(['replacement']), evidence: { id: 'replacement-capture' } }); }
    catch (error) { rejected = error.name === 'AbortError'; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const record = await MediaStore.get('same');
    return { rejected, bytes: await record.blob.text(), evidence: record.evidence, metadata: await MediaStore.list() };
  });
  assert.deepEqual(result, { rejected: true, bytes: 'original', evidence: { id: 'original-capture' }, metadata: [{ id: 'same', type: 'photo', timestamp: 1, size: 8 }] });
});

test('open failures reject promptly and the next operation retries instead of caching failure', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const originalOpen = indexedDB.open;
    indexedDB.open = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
    let name;
    try { await MediaStore.list(); } catch (error) { name = error.name; }
    finally { indexedDB.open = originalOpen; }
    await MediaStore.put({ id: 'recovered', type: 'photo', timestamp: 1, blob: new Blob(['saved']) });
    return { name, ids: (await MediaStore.list()).map(item => item.id) };
  });
  assert.deepEqual(result, { name: 'SecurityError', ids: ['recovered'] });
});

test('connections close on versionchange so album deletion from another tab does not block', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    await MediaStore.put({ id: 'old', type: 'photo', timestamp: 1, blob: new Blob(['old']) });
    const databases = await indexedDB.databases();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databases[0].name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Deletion was blocked'));
    });
    return MediaStore.list();
  });
  assert.deepEqual(result, []);
});

test('a stalled open times out, closes a late connection, and permits retry', async t => {
  const { page } = await setup(t);
  await page.clock.install();
  await page.evaluate(() => {
    window.originalOpen = indexedDB.open;
    indexedDB.open = function (...args) {
      const actual = window.originalOpen.apply(this, args);
      const delayed = {
        get result() { return actual.result; },
        get transaction() { return actual.transaction; },
        get error() { return actual.error; },
      };
      actual.onupgradeneeded = event => delayed.onupgradeneeded?.(event);
      actual.onerror = event => delayed.onerror?.(event);
      actual.onblocked = event => delayed.onblocked?.(event);
      actual.onsuccess = event => { window.deliverOpen = () => delayed.onsuccess?.(event); };
      return delayed;
    };
    window.openOutcome = 'pending';
    MediaStore.list().then(() => { window.openOutcome = 'resolved'; }, error => { window.openOutcome = error.name; });
  });
  await page.waitForFunction(() => typeof window.deliverOpen === 'function');
  await page.clock.fastForward(5001);
  assert.equal(await page.evaluate(() => window.openOutcome), 'TimeoutError');
  const list = await page.evaluate(async () => {
    indexedDB.open = window.originalOpen;
    window.deliverOpen();
    const databases = await indexedDB.databases();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databases[0].name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Late connection was not closed'));
    });
    return MediaStore.list();
  });
  assert.deepEqual(list, []);
});

test('a transaction that never commits is aborted at the deadline and a later operation succeeds', async t => {
  const { page } = await setup(t);
  await page.clock.install();
  await page.evaluate(async () => {
    await MediaStore.put({ id: 'kept', type: 'photo', timestamp: 1, blob: new Blob(['safe']) });
    window.originalGetAll = IDBObjectStore.prototype.getAll;
    window.keepAliveRequests = 0;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = window.originalGetAll.apply(this, args);
      const keepAlive = () => {
        const pending = this.get('__keep_alive__');
        window.keepAliveRequests++;
        pending.onsuccess = keepAlive;
      };
      keepAlive();
      return request;
    };
    window.transactionOutcome = 'pending';
    MediaStore.list().then(() => { window.transactionOutcome = 'resolved'; }, error => { window.transactionOutcome = error.name; });
  });
  await page.waitForFunction(() => window.keepAliveRequests > 0);
  await page.clock.fastForward(5001);
  assert.equal(await page.evaluate(() => window.transactionOutcome), 'TimeoutError');
  const list = await page.evaluate(async () => {
    IDBObjectStore.prototype.getAll = window.originalGetAll;
    return MediaStore.list();
  });
  assert.deepEqual(list, [{ id: 'kept', type: 'photo', timestamp: 1, size: 4 }]);
});

async function seedLegacyDatabase(page, keepOpen = false) {
  await page.evaluate(async keepOpen => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('watermark-camera-media:/camera/', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('media', { keyPath: 'id' });
        request.result.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['media', 'metadata'], 'readwrite');
    for (const [id, type, timestamp, bytes] of [['legacy-photo', 'photo', 1, 'original photo'], ['legacy-video', 'video', 2, 'original video']]) {
      const blob = new Blob([bytes], { type: type === 'photo' ? 'image/jpeg' : 'video/mp4' });
      transaction.objectStore('media').put({ id, blob });
      transaction.objectStore('metadata').put({ id, type, timestamp, size: blob.size, thumbnail: new Blob([`${id} thumbnail`], { type: 'image/jpeg' }) });
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    if (keepOpen) window.legacyDatabase = db;
    else db.close();
  }, keepOpen);
}

test('pagination upgrades an existing version-one album without losing originals or thumbnails', async t => {
  const { page } = await setup(t);
  await seedLegacyDatabase(page);
  const result = await page.evaluate(async () => {
    const first = await MediaStore.listPage({ limit: 1 });
    const second = await MediaStore.listPage({ before: first.nextCursor, limit: 1 });
    const video = await MediaStore.get('legacy-video');
    const photo = await MediaStore.get('legacy-photo');
    return {
      ids: [...first.items, ...second.items].map(item => item.id),
      cursor: first.nextCursor,
      end: second.nextCursor,
      video: await video.blob.text(),
      photo: await photo.blob.text(),
      thumbnails: await Promise.all([...first.items, ...second.items].map(item => item.thumbnail.text())),
      version: (await indexedDB.databases())[0].version,
    };
  });
  assert.deepEqual(result, {
    ids: ['legacy-video', 'legacy-photo'], cursor: { timestamp: 2, id: 'legacy-video' }, end: null,
    video: 'original video', photo: 'original photo',
    thumbnails: ['legacy-video thumbnail', 'legacy-photo thumbnail'], version: 2,
  });
});

test('same-timestamp pagination is stable across deletion of the boundary and insertion of newer work', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const ids = ['a', 'A', '10', '2', '中文', ...Array.from({ length: 60 }, (_, i) => `photo-${i}`)];
    await Promise.all(ids.map(id => MediaStore.put({ id, type: 'photo', timestamp: 10, blob: new Blob([id]) })));
    const expected = [...ids].sort((a, b) => -indexedDB.cmp([10, a], [10, b]));
    let next = await MediaStore.listPage();
    const seen = next.items.map(item => item.id);
    const lengths = [next.items.length];
    await MediaStore.remove(next.nextCursor.id);
    await MediaStore.put({ id: 'newer', type: 'photo', timestamp: 11, blob: new Blob(['new']) });
    while (next.nextCursor) {
      next = await MediaStore.listPage({ before: next.nextCursor });
      seen.push(...next.items.map(item => item.id));
      lengths.push(next.items.length);
    }
    return { expected, seen, lengths, end: next.nextCursor };
  });
  assert.deepEqual(result.seen, result.expected);
  assert.deepEqual(result.lengths, [30, 30, 5]);
  assert.equal(result.end, null);
  assert.equal(new Set(result.seen).size, 65);
});

test('a page reads only its requested thumbnails and does not deserialize media or the rest of the album', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    await Promise.all(Array.from({ length: 105 }, (_, i) => MediaStore.put({
      id: `photo-${i}`, type: 'photo', timestamp: i, blob: new Blob(['original']),
      thumbnail: new Blob([new Uint8Array(16384)], { type: 'image/jpeg' }),
    })));
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const reads = { metadata: 0, media: 0 };
    IDBObjectStore.prototype.get = function (...args) {
      reads[this.name]++;
      return originalGet.apply(this, args);
    };
    IDBObjectStore.prototype.getAll = () => { throw new Error('Pagination must not load the whole album'); };
    try {
      const page = await MediaStore.listPage({ limit: 100 });
      return { reads, count: page.items.length, next: page.nextCursor, hasBlob: page.items.some(item => 'blob' in item), thumbnails: page.items.every(item => item.thumbnail.size === 16384) };
    } finally {
      IDBObjectStore.prototype.get = originalGet;
      IDBObjectStore.prototype.getAll = originalGetAll;
    }
  });
  assert.deepEqual(result, { reads: { metadata: 100, media: 0 }, count: 100, next: { timestamp: 5, id: 'photo-5' }, hasBlob: false, thumbnails: true });
});

test('pagination ends on empty albums and exact page boundaries and rejects invalid bounds', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const empty = await MediaStore.listPage();
    await Promise.all(Array.from({ length: 60 }, (_, i) => MediaStore.put({ id: `photo-${i}`, type: 'photo', timestamp: i, blob: new Blob(['photo']) })));
    const first = await MediaStore.listPage();
    const last = await MediaStore.listPage({ before: first.nextCursor });
    const pastEnd = await MediaStore.listPage({ before: { timestamp: 0, id: 'photo-0' } });
    const errors = [];
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { before: { timestamp: NaN, id: 'bad' } }, { before: { timestamp: 1 } }]) {
      try { await MediaStore.listPage(options); errors.push('resolved'); }
      catch (error) { errors.push(error.name); }
    }
    return { empty, count: [first.items.length, last.items.length], end: last.nextCursor, pastEnd, errors };
  });
  assert.deepEqual(result, {
    empty: { items: [], nextCursor: null }, count: [30, 30], end: null,
    pastEnd: { items: [], nextCursor: null }, errors: ['RangeError', 'RangeError', 'RangeError', 'TypeError', 'TypeError'],
  });
});

test('a blocked pagination upgrade rejects and can retry after the old tab closes', async t => {
  const { page } = await setup(t);
  await seedLegacyDatabase(page, true);
  const result = await page.evaluate(async () => {
    let errorName;
    try { await MediaStore.listPage(); } catch (error) { errorName = error.name; }
    window.legacyDatabase.close();
    const result = await MediaStore.listPage();
    return { errorName, ids: result.items.map(item => item.id), bytes: await (await MediaStore.get('legacy-photo')).blob.text() };
  });
  assert.deepEqual(result, { errorName: 'InvalidStateError', ids: ['legacy-video', 'legacy-photo'], bytes: 'original photo' });
});
