const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

let server, browser, origin, clipBytes;
before(async () => {
  const { createAppServer } = await import('../server.mjs');
  server = createAppServer({ apiKey: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  // A real encoded fixture, rather than a media-looking byte string, exercises
  // decoding older stored works without changing their original bytes.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + 'verify.html');
  clipBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const ctx = canvas.getContext('2d');
    const paint = () => { ctx.fillStyle = '#497c8f'; ctx.fillRect(0, 0, 480, 270); ctx.fillStyle = '#ece4c4'; ctx.fillRect(Date.now() % 300, 80, 100, 80); };
    paint();
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    const blob = await new Promise((resolve, reject) => {
      const painting = setInterval(paint, 60);
      const stop = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 750);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = reject;
      recorder.onstop = () => {
        clearInterval(painting); clearTimeout(stop); stream.getTracks().forEach(track => track.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start(100);
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await context.close();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (_success, error) => error({ code: 1 });
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (...args) {
      const state = { chunks: 0 }; window.testEncoding = state;
      this.addEventListener('dataavailable', event => { if (event.data.size) state.chunks++; });
      return start.apply(this, args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught album errors'));
  await page.goto(origin);
  await ready(page);
  return { page, context };
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#loading-overlay').classList.contains('hidden'));
}
async function poll(fn, check, label) {
  const deadline = Date.now() + 10000;
  while (true) {
    const value = await fn();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function seed(page, count = 1, corrupt = false) {
  await page.evaluate(async ({ bytes, count, corrupt }) => {
    const blob = new Blob([corrupt ? 'damaged video' : new Uint8Array(bytes)], { type: 'video/webm' });
    for (let i = 0; i < count; i++) await MediaStore.put({ id: `legacy-${i}`, type: 'video',
      timestamp: Date.now() - (count - i) * 60000, blob, evidence: { legacy: true, marker: i } });
  }, { bytes: clipBytes, count, corrupt });
}
async function snapshot(page, id) {
  return page.evaluate(async id => {
    const record = await MediaStore.get(id);
    if (!record) return null;
    return { id, timestamp: record.timestamp, type: record.type, size: record.blob.size,
      evidence: record.evidence, hash: await Evidence.hashBlob(record.blob) };
  }, id);
}
async function thumbnailInfo(page, id) {
  return page.evaluate(async id => {
    const record = await MediaStore.get(id);
    return record ? { bytes: record.thumbnail?.size || 0, duration: record.durationSeconds } : null;
  }, id);
}
async function recordVideo(page) {
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => window.testEncoding?.chunks > 0);
  await page.click('#shutter-btn');
  await page.waitForFunction(() => document.querySelector('#preview-modal video')?.readyState >= 2);
}
async function deferCanvasCover(page) {
  await page.evaluate(() => {
    const original = VideoThumbnails;
    window.coverDecoderCalls = 0;
    window.VideoThumbnails = { ...original,
      fromCanvas: canvas => {
        const cover = original.fromCanvas(canvas);
        return new Promise(resolve => { window.finishTestCover = async () => resolve(await cover); });
      },
      fromBlob: (...args) => { window.coverDecoderCalls++; return original.fromBlob(...args); },
    };
  });
}

test('new recordings save before optional cover encoding, then retain covers and real duration after reload', async t => {
  const { page } = await setup(t);
  await deferCanvasCover(page);
  await recordVideo(page);
  const id = await page.evaluate(async () => (await MediaStore.list())[0].id);
  const original = await snapshot(page, id);
  assert.ok(original.size > 0);
  assert.equal((await thumbnailInfo(page, id)).bytes, 0, 'original is saved while the cover is still pending');
  await page.evaluate(() => window.finishTestCover());
  const info = await poll(() => thumbnailInfo(page, id), result => result?.bytes > 0, 'cover is persisted');
  assert.ok(info.bytes <= 128 * 1024);
  assert.ok(info.duration > 0, 'preview decoder supplies an actual duration');
  assert.deepEqual(await snapshot(page, id), original);
  assert.equal(await page.evaluate(() => window.coverDecoderCalls), 0, 'new cover reuses the recording canvas');
  await page.reload();
  await ready(page);
  await page.evaluate(() => { window.VideoThumbnails = { ...VideoThumbnails, fromBlob: () => { throw new Error('existing cover must not decode again'); } }; });
  await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelector('.gallery-item img')?.naturalWidth > 0);
  assert.match(await page.locator('.media-type-badge').innerText(), /视频 · \d+:\d\d/);
  assert.match(await page.locator('.gallery-caption').innerText(), /\d.*\d:\d\d/);
  assert.deepEqual(await snapshot(page, id), original);
});

test('older videos gain local covers offline without rewriting originals; mobile cards and fallback stay usable', async t => {
  const { page, context } = await setup(t);
  await seed(page);
  const original = await snapshot(page, 'legacy-0');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await ready(page);
  await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelector('.gallery-item img')?.naturalWidth > 0);
  await poll(() => thumbnailInfo(page, 'legacy-0'), result => result?.bytes > 0, 'old cover persisted offline');
  assert.deepEqual(await snapshot(page, 'legacy-0'), original);
  for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const card = page.locator('.gallery-item');
    await card.scrollIntoViewIfNeeded();
    const bounds = await card.evaluate(node => ({ box: node.getBoundingClientRect().toJSON(),
      captionFits: node.querySelector('.gallery-caption').scrollWidth <= node.querySelector('.gallery-caption').clientWidth }));
    assert.ok(bounds.box.x >= 0 && bounds.box.right <= viewport.width && bounds.box.width >= 44);
    assert.equal(bounds.captionFits, true);
  }
  await page.locator('.gallery-item').click();
  await page.waitForFunction(() => document.querySelector('#preview-modal video')?.readyState >= 2);
  assert.deepEqual(await snapshot(page, 'legacy-0'), original);
  await page.reload(); await ready(page); await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelector('.gallery-item img')?.naturalWidth > 0);
});

test('legacy cover decoding is serial and visible-only, cancels for preview/background and resumes after cancellation', async t => {
  const { page } = await setup(t);
  await seed(page, 40);
  await page.evaluate(() => {
    const real = MediaStore;
    window.albumReads = [];
    window.MediaStore = { ...real, get: id => { window.albumReads.push(id); return real.get(id); } };
    window.coverJobs = []; window.activeDecoders = 0; window.peakDecoders = 0;
    window.VideoThumbnails = { ...VideoThumbnails, fromBlob: (_blob, { signal }) => {
      window.activeDecoders++; window.peakDecoders = Math.max(window.peakDecoders, window.activeDecoders);
      return new Promise(resolve => {
        let finished = false;
        const finish = () => { if (finished) return; finished = true; window.activeDecoders--; resolve({ thumbnail: null, durationSeconds: null }); };
        window.coverJobs.push({ signal, finish });
        signal.addEventListener('abort', finish, { once: true });
      });
    } };
  });
  await page.click('#btn-gallery');
  await page.waitForFunction(() => window.activeDecoders === 1);
  assert.equal(await page.evaluate(() => window.albumReads.length), 1);
  assert.equal(await page.locator('.gallery-item').count(), 30);
  await page.locator('.gallery-item').first().click();
  await page.waitForFunction(() => window.activeDecoders === 0);
  assert.equal(await page.evaluate(() => window.coverJobs[0].signal.aborted), true);
  await page.click('#preview-close');
  await page.waitForFunction(() => window.activeDecoders === 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.activeDecoders === 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.activeDecoders === 1);
  await page.locator('#gallery-panel').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  await page.waitForFunction(() => window.coverJobs.length >= 4);
  assert.ok(await page.evaluate(() => window.albumReads.length < 12), 'offscreen originals were not all loaded');
  assert.equal(await page.evaluate(() => window.peakDecoders), 1);
  await page.click('[data-close-panel="gallery-panel"]');
  await page.waitForFunction(() => window.activeDecoders === 0);
  await ready(page);
});

test('corrupt legacy videos fall back once per page session and can still be downloaded', async t => {
  const { page } = await setup(t);
  await seed(page, 2, true);
  await page.evaluate(() => {
    const original = VideoThumbnails;
    window.failedDecodes = 0;
    window.VideoThumbnails = { ...original, fromBlob: (...args) => { window.failedDecodes++; return original.fromBlob(...args); } };
  });
  await page.click('#btn-gallery');
  await page.waitForFunction(() => window.failedDecodes === 2);
  await page.click('[data-close-panel="gallery-panel"]');
  await ready(page);
  await page.click('#btn-gallery');
  assert.equal(await page.locator('.gallery-placeholder').count(), 2);
  assert.equal(await page.evaluate(() => window.failedDecodes), 2);
  assert.equal(await page.locator('.gallery-item img').count(), 0);
  await page.locator('.gallery-item').first().click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载原文件', exact: true }).click();
  const download = await pending;
  const fs = require('node:fs/promises');
  assert.equal(await fs.readFile(await download.path(), 'utf8'), 'damaged video');
});

test('older browsers without IntersectionObserver begin covers after the album opens', async t => {
  const { page } = await setup(t);
  await seed(page);
  await page.evaluate(() => { window.IntersectionObserver = undefined; });
  await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelector('.gallery-item img')?.naturalWidth > 0);
  await poll(() => thumbnailInfo(page, 'legacy-0'), value => value?.bytes > 0, 'fallback cover is persisted');
});

test('a late canvas cover survives a pending save retry without changing capture bytes or metadata', async t => {
  const { page } = await setup(t);
  await deferCanvasCover(page);
  await page.evaluate(() => {
    const real = MediaStore;
    window.saveMode = 'fail';
    window.MediaStore = { ...real, put: async record => {
      if (window.saveMode === 'fail') throw new DOMException('Full', 'QuotaExceededError');
      const writing = real.put({ ...record });
      await new Promise(resolve => { window.releaseSave = resolve; });
      return writing;
    } };
  });
  await recordVideo(page);
  await page.evaluate(() => { window.saveMode = 'defer'; });
  await page.getByRole('button', { name: '重试存入本机', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseSave === 'function');
  const id = await poll(() => page.evaluate(async () => (await MediaStore.list())[0]?.id), Boolean, 'retry is committed');
  const original = await snapshot(page, id);
  await page.evaluate(() => window.finishTestCover());
  assert.equal((await thumbnailInfo(page, id)).bytes, 0, 'cover patch waits for the in-flight save');
  await page.evaluate(() => window.releaseSave());
  await poll(() => thumbnailInfo(page, id), value => value?.bytes > 0, 'cover survives retry');
  assert.deepEqual(await snapshot(page, id), original);
  await page.reload(); await ready(page); await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelector('.gallery-item img')?.naturalWidth > 0);
  assert.equal(await page.locator('.gallery-pending').count(), 0);
  assert.deepEqual(await snapshot(page, id), original);
});

test('cover completion after a video is deleted cannot recreate its album entry or file', async t => {
  const { page } = await setup(t);
  await deferCanvasCover(page);
  await recordVideo(page);
  const id = await page.evaluate(async () => (await MediaStore.list())[0].id);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除此作品', exact: true }).click();
  await poll(() => snapshot(page, id), value => value === null, 'original is deleted');
  await page.evaluate(() => window.finishTestCover());
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-empty');
  assert.equal(await page.locator('.gallery-item').count(), 0);
  assert.equal(await snapshot(page, id), null);
});
