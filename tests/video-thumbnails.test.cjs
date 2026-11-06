const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

let server, browser, origin;
before(async () => {
  const script = await fs.readFile(path.resolve(__dirname, '../video-thumbnails.js'));
  server = http.createServer((req, res) => {
    if (req.url === '/video-thumbnails.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(script);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><body><script src="/video-thumbnails.js"></script></body>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.thumbnailVideos = [];
    window.thumbnailCanvases = [];
    window.thumbnailURLs = [];
    window.revokedThumbnailURLs = [];
    const create = document.createElement.bind(document);
    document.createElement = function (name, ...args) {
      const element = create(name, ...args);
      if (name === 'video') window.thumbnailVideos.push(element);
      if (name === 'canvas') window.thumbnailCanvases.push(element);
      return element;
    };
    const createURL = URL.createObjectURL.bind(URL);
    const revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); window.thumbnailURLs.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedThumbnailURLs.push(url); revokeURL(url); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught thumbnail errors'));
  await page.goto(origin);
  return { page, context };
}

async function assertVideoCleanup(page, count = 1) {
  const result = await page.evaluate(() => ({
    count: window.thumbnailVideos.length,
    released: window.thumbnailVideos.every(video => !video.isConnected && !video.hasAttribute('src') && video.paused),
    urls: window.thumbnailURLs,
    revoked: window.revokedThumbnailURLs,
    silent: window.thumbnailVideos.every(video => video.muted && video.volume === 0 && video.playsInline),
  }));
  assert.equal(result.count, count);
  assert.equal(result.released, true);
  assert.equal(result.silent, true);
  assert.deepEqual(result.revoked, result.urls);
}

test('canvas covers snapshot immediately, preserve aspect ratio and leave the original untouched', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const source = document.createElement('canvas'); source.width = 1200; source.height = 800;
    const ctx = source.getContext('2d'); ctx.fillStyle = '#e35b31'; ctx.fillRect(0, 0, 1200, 800);
    const pending = VideoThumbnails.fromCanvas(source);
    // This mirrors the recording cleanup immediately after requesting a cover.
    source.width = source.height = 0;
    const blob = await pending;
    const bitmap = await createImageBitmap(blob);
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    probe.getContext('2d').drawImage(bitmap, 0, 0, 1, 1);
    const pixel = [...probe.getContext('2d').getImageData(0, 0, 1, 1).data];
    const info = { width: bitmap.width, height: bitmap.height, type: blob.type, size: blob.size, pixel,
      snapshotReleased: window.thumbnailCanvases[1].width === 0 && window.thumbnailCanvases[1].height === 0 };
    bitmap.close(); return info;
  });
  assert.equal(result.width, 240); assert.equal(result.height, 160);
  assert.equal(result.type, 'image/jpeg'); assert.ok(result.size > 0 && result.size <= 128 * 1024);
  assert.ok(result.pixel[0] > 200 && result.pixel[1] < 120 && result.pixel[2] < 80);
  assert.equal(result.snapshotReleased, true);
});

test('aborted or stalled canvas encoding releases its small canvas and ignores late callbacks', async t => {
  const { page } = await setup(t);
  await page.clock.install();
  const started = await page.evaluate(() => {
    window.encodingCallbacks = [];
    HTMLCanvasElement.prototype.toBlob = function (callback) { window.encodingCallbacks.push(callback); };
    const source = document.createElement('canvas'); source.width = 240; source.height = 320;
    window.encodingAbort = new AbortController();
    window.abortedCover = VideoThumbnails.fromCanvas(source, { signal: window.encodingAbort.signal });
    window.stalledCover = VideoThumbnails.fromCanvas(source);
    window.encodingAbort.abort();
    return window.encodingCallbacks.length;
  });
  assert.equal(started, 2);
  assert.equal(await page.evaluate(() => window.abortedCover), null);
  await page.clock.fastForward(5000);
  assert.equal(await page.evaluate(() => window.stalledCover), null);
  const released = await page.evaluate(() => {
    window.encodingCallbacks.forEach(callback => callback(new Blob(['late data'], { type: 'image/jpeg' })));
    return window.thumbnailCanvases.slice(1).every(canvas => canvas.width === 0 && canvas.height === 0);
  });
  assert.equal(released, true);
});

test('canvas errors, absent pixels and oversized JPEGs fall back without rejecting', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const blank = document.createElement('canvas'); blank.width = blank.height = 0;
    const source = document.createElement('canvas'); source.width = source.height = 10;
    const empty = await VideoThumbnails.fromCanvas(blank);
    HTMLCanvasElement.prototype.toBlob = () => { throw new DOMException('Unavailable', 'SecurityError'); };
    const denied = await VideoThumbnails.fromCanvas(source);
    HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob([new Uint8Array(128 * 1024 + 1)], { type: 'image/jpeg' }));
    const tooLarge = await VideoThumbnails.fromCanvas(source);
    return { empty, denied, tooLarge };
  });
  assert.deepEqual(result, { empty: null, denied: null, tooLarge: null });
});

test('a native short recording yields a decoded local cover without changing original bytes', async t => {
  const { page, context } = await setup(t);
  // The page and helper are already loaded. Extraction must also work offline.
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const ctx = canvas.getContext('2d');
    const paint = () => { ctx.fillStyle = '#297bb7'; ctx.fillRect(0, 0, 480, 270); ctx.fillStyle = '#fff'; ctx.fillRect(Math.floor(performance.now()) % 400, 0, 10, 10); };
    paint();
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    const blob = await new Promise((resolve, reject) => {
      const started = performance.now();
      const repaint = setInterval(paint, 60);
      const timeout = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 1500);
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
        if (chunks.length && performance.now() - started >= 400 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onerror = reject;
      recorder.onstop = () => {
        clearInterval(repaint); clearTimeout(timeout); stream.getTracks().forEach(track => track.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start(100);
    });
    const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()))].join(',');
    const before = await hash(blob);
    const cover = await VideoThumbnails.fromBlob(blob);
    const bitmap = await createImageBitmap(cover.thumbnail);
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    probe.getContext('2d').drawImage(bitmap, 0, 0, 1, 1);
    const info = { width: bitmap.width, height: bitmap.height, bytes: cover.thumbnail.size, type: cover.thumbnail.type,
      originalSame: before === await hash(blob), sourceSize: blob.size, duration: cover.durationSeconds,
      pixel: [...probe.getContext('2d').getImageData(0, 0, 1, 1).data] };
    bitmap.close(); return info;
  });
  assert.equal(result.width, 240); assert.equal(result.height, 135);
  assert.ok(result.bytes > 0 && result.bytes <= 128 * 1024);
  assert.equal(result.type, 'image/jpeg'); assert.equal(result.originalSame, true); assert.ok(result.sourceSize > 0);
  assert.ok(result.duration === null || result.duration > 0 && result.duration < 3);
  assert.ok(result.pixel[0] < 90 && result.pixel[1] > 90 && result.pixel[2] > 140);
  await assertVideoCleanup(page);
});

test('corrupt clips, empty files and pre-aborted work retain the placeholder and release resources', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const controller = new AbortController(); controller.abort();
    return [await VideoThumbnails.fromBlob(new Blob()),
      await VideoThumbnails.fromBlob(new Blob(['ignored']), { signal: controller.signal }),
      await VideoThumbnails.fromBlob(new Blob(['not a video'], { type: 'video/mp4' }))];
  });
  assert.deepEqual(result, Array.from({ length: 3 }, () => ({ thumbnail: null, durationSeconds: null })));
  await assertVideoCleanup(page);
});

test('a black opening frame gets one bounded later-frame attempt', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 180);
    const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    const blob = await new Promise(resolve => {
      const started = performance.now();
      const painting = setInterval(() => {
        ctx.fillStyle = performance.now() - started < 130 ? '#000' : '#3c986c';
        ctx.fillRect(0, 0, 320, 180);
      }, 40);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => { clearInterval(painting); stream.getTracks().forEach(track => track.stop()); resolve(new Blob(chunks, { type: recorder.mimeType })); };
      recorder.start(100); setTimeout(() => recorder.stop(), 900);
    });
    let seeks = 0;
    const create = document.createElement.bind(document);
    document.createElement = function (name, ...args) {
      const element = create(name, ...args);
      if (name === 'video') element.addEventListener('seeking', () => seeks++);
      return element;
    };
    const cover = await VideoThumbnails.fromBlob(blob);
    const bitmap = await createImageBitmap(cover.thumbnail);
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    probe.getContext('2d').drawImage(bitmap, 0, 0, 1, 1);
    const pixel = [...probe.getContext('2d').getImageData(0, 0, 1, 1).data]; bitmap.close();
    return { pixel, seeks };
  });
  assert.ok(result.pixel[1] > 100, 'the later colored frame supplies the cover');
  assert.ok(result.seeks >= 1 && result.seeks <= 2, 'no unbounded search through the recording');
  await assertVideoCleanup(page);
});

test('a stalled decoder times out, stays silent and preserves any known duration', async t => {
  const { page } = await setup(t);
  await page.clock.install();
  await page.evaluate(() => {
    HTMLMediaElement.prototype.load = function () {};
    // Assigning src normally starts loading even when load() is replaced. Hold
    // that step as well to model a genuinely stalled decoder, not a corrupt file.
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true,
      get() { return ''; }, set(_) {} });
    HTMLMediaElement.prototype.play = function () { window.fallbackPlayCalled = true; return Promise.reject(new DOMException('No gesture', 'NotAllowedError')); };
    window.pendingCover = VideoThumbnails.fromBlob(new Blob(['stalled'], { type: 'video/mp4' }));
    const video = window.thumbnailVideos[0];
    Object.defineProperty(video, 'duration', { configurable: true, value: 0.05 });
    video.dispatchEvent(new Event('loadedmetadata'));
  });
  await page.clock.fastForward(750);
  assert.equal(await page.evaluate(() => window.fallbackPlayCalled), true);
  await page.clock.fastForward(4250);
  assert.deepEqual(await page.evaluate(() => window.pendingCover), { thumbnail: null, durationSeconds: 0.05 });
  await assertVideoCleanup(page);
});

test('cancelling a pending decoder removes its local source immediately and ignores late events', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    HTMLMediaElement.prototype.load = function () {};
    const controller = new AbortController();
    const pending = VideoThumbnails.fromBlob(new Blob(['pending']), { signal: controller.signal });
    controller.abort();
    const video = window.thumbnailVideos[0];
    video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('seeked')); video.dispatchEvent(new Event('error'));
    return pending;
  });
  assert.deepEqual(result, { thumbnail: null, durationSeconds: null });
  await assertVideoCleanup(page);
});
