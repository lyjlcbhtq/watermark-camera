const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium, webkit } = require('playwright');

let server, browser, origin;
const root = path.resolve(__dirname, '..');
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const relative = url.pathname.replace(/^\/watermark-camera\//, '');
      const file = path.resolve(root, relative === '' ? 'index.html' : relative);
      if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
      const body = await fs.readFile(file);
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/watermark-camera/`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t, options = {}, engine = browser) {
  const context = await engine.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(options => {
    window.mediaRequests = [];
    window.mediaStreams = [];
    window.pendingCamera = [];
    window.pendingMic = [];
    window.cameraBehavior = options.camera || 'normal';
    window.micBehavior = options.mic || 'normal';
    window.geoRequests = [];
    if (window.MediaRecorder) {
      const startRecorder = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        const state = { chunks: 0 };
        window.nativeRecordingState = state;
        this.addEventListener('dataavailable', event => {
          if (event.data.size) state.chunks++;
        });
        return startRecorder.apply(this, args);
      };
    }
    if (options.initiallyHidden) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => {
      if (options.geo === 'defer') window.geoRequests.push({ success, error });
      else error({ code: 1 });
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.mediaRequests.push(constraints);
      const behavior = constraints.video ? window.cameraBehavior : window.micBehavior;
      if (behavior === 'deny') throw new DOMException('Denied', 'NotAllowedError');
      if (behavior === 'defer') {
        await new Promise(resolve => (constraints.video ? window.pendingCamera : window.pendingMic).push(resolve));
      }
      let stream;
      if (constraints.video && options.portraitCamera) {
        const canvas = document.createElement('canvas');
        canvas.width = 720; canvas.height = 1280;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#345e98'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        stream = canvas.captureStream(24);
        window.syntheticCameraCanvas = canvas;
      } else stream = await original(constraints);
      window.mediaStreams.push(stream);
      return stream;
    };
  }, options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught page errors'));
  await page.goto(origin);
  if (options.mode !== 'default') await page.locator('[data-mode="photo"]').click();
  return { context, page };
}
async function ready(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('#camera-preview');
    return video.srcObject?.getVideoTracks()[0]?.readyState === 'live' && video.readyState >= 2 && document.querySelector('#loading-overlay').classList.contains('hidden');
  });
}
async function hide(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function show(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function allStopped(page) {
  await page.waitForFunction(() => window.mediaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
}
async function encodedClipReady(page) {
  // Native encoders may return an empty clip if stopped before their first frame.
  await page.waitForFunction(() => window.nativeRecordingState?.chunks > 0);
}

test('the app opens in video mode without microphone access until recording begins', async t => {
  const { page } = await setup(t, { mode: 'default' });
  await ready(page);
  assert.equal(await page.locator('[data-mode="video"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#shutter-btn').getAttribute('aria-label'), '开始录像');
  assert.equal(await page.evaluate(() => window.mediaRequests.some(request => request.audio)), false);
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  assert.equal(await page.locator('#shutter-btn').getAttribute('aria-label'), '停止录像');
  await encodedClipReady(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await allStopped(page);
});

test('photo preview uses video only; capturing suspends camera, closing resumes', async t => {
  const { page } = await setup(t);
  await ready(page);
  const settings = await page.evaluate(() => {
    const stream = document.querySelector('#camera-preview').srcObject;
    return { audio: stream.getAudioTracks().length, fps: stream.getVideoTracks()[0].getSettings().frameRate, requests: window.mediaRequests.length };
  });
  assert.equal(settings.audio, 0);
  assert.ok(settings.fps <= 24);
  assert.equal(settings.requests, 1);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  await allStopped(page);
  const dimensions = await page.locator('#preview-modal img').evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }));
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  await page.click('#preview-close');
  await ready(page);
  assert.equal(await page.evaluate(() => window.mediaRequests.length), 2);
});

test('background/pagehide releases tracks; foreground/pageshow recovers once', async t => {
  const { page } = await setup(t);
  await ready(page);
  await hide(page);
  await allStopped(page);
  await show(page);
  await ready(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await allStopped(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await ready(page);
  assert.equal(await page.evaluate(() => window.mediaRequests.length), 3);
});

test('denied camera offers a working retry, without microphone permission', async t => {
  const { page } = await setup(t, { camera: 'deny' });
  await page.waitForSelector('#camera-retry:visible');
  assert.match(await page.locator('.loading-text').textContent(), /权限/);
  await page.evaluate(() => { window.cameraBehavior = 'normal'; });
  await page.click('#camera-retry');
  await ready(page);
  assert.ok(await page.evaluate(() => window.mediaRequests.every(request => request.audio === false)));
});

test('late permission response after backgrounding is discarded and stopped', async t => {
  const { page } = await setup(t, { camera: 'defer' });
  await page.waitForFunction(() => window.pendingCamera.length === 1);
  await hide(page);
  await page.evaluate(() => window.pendingCamera.shift()());
  await page.waitForFunction(() => window.mediaStreams.length === 1);
  await allStopped(page);
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject), null);
  await page.evaluate(() => { window.cameraBehavior = 'normal'; });
  await show(page);
  await ready(page);
});

test('startup timeout recovers; stale stream cannot replace the new camera', async t => {
  const { page } = await setup(t, { camera: 'defer' });
  await page.waitForSelector('#camera-retry:visible', { timeout: 20000 });
  assert.match(await page.locator('.loading-text').textContent(), /超时/);
  await page.evaluate(() => { window.cameraBehavior = 'normal'; });
  await page.click('#camera-retry');
  await ready(page);
  const activeId = await page.locator('#camera-preview').evaluate(video => video.srcObject.id);
  await page.evaluate(() => window.pendingCamera.shift()());
  await page.waitForFunction(() => window.mediaStreams.length === 2 && window.mediaStreams[1].getTracks().every(track => track.readyState === 'ended'));
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject.id), activeId);
});

test('recording captures a playable clip and stops microphone, including on background', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await hide(page);
  await page.waitForSelector('#preview-modal.show video');
  await allStopped(page);
  await show(page);
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject), null);
  await page.locator('#preview-modal video').evaluate(async video => {
    await video.play();
    video.pause();
  });
  assert.ok(await page.locator('#preview-modal video').evaluate(video => video.videoWidth > 0));
  await page.click('#preview-close');
  await ready(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await allStopped(page);
});

test('microphone rejection allows silent recording', async t => {
  const { page } = await setup(t, { mic: 'deny' });
  await ready(page);
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await allStopped(page);
});

test('pending microphone permission cannot start recording after backgrounding', async t => {
  const { page } = await setup(t, { mic: 'defer' });
  await ready(page);
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForFunction(() => window.pendingMic.length === 1);
  await hide(page);
  await page.evaluate(() => window.pendingMic.shift()());
  await page.waitForFunction(() => window.mediaStreams.length === 2);
  await allStopped(page);
  assert.equal(await page.locator('#shutter-btn').evaluate(btn => btn.classList.contains('recording')), false);
});

test('app shell, manifest and icons load offline under a GitHub Pages subpath', async t => {
  const { context, page } = await setup(t);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const keys = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const name = `watermark-camera-shell-${encodeURIComponent(registration.scope)}-v6`;
    return (await (await caches.open(name)).keys()).map(request => request.url);
  });
  const expectedShell = ['index.html', 'media-store.js', 'manifest.json', 'icon.svg',
    'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
    'location-service.js', 'evidence.js', 'evidence-worker.js', 'verify.html', 'verify.js',
    'vendor/noble-hashes/sha2.js', 'vendor/noble-hashes/_md.js',
    'vendor/noble-hashes/_u64.js', 'vendor/noble-hashes/utils.js'];
  assert.deepEqual(keys.sort(), expectedShell.map(file => origin + file).sort());
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#shutter-btn');
  await ready(page);
  assert.equal(await page.evaluate(async () => (await fetch('manifest.json')).status), 200);
  assert.equal(await page.evaluate(async () => (await fetch('icons/apple-touch-icon.png')).status), 200);
  const offlineHash = await page.evaluate(() => Evidence.hashBlob(new Blob(['offline'])));
  assert.equal(offlineHash, createHash('sha256').update('offline').digest('hex'));
  await page.goto(origin + 'index.html?from=homescreen');
  await page.waitForSelector('#shutter-btn');
});

test('WebKit renders the retry UI and can reopen the installed app shell offline', { skip: !process.env.TEST_WEBKIT && 'Set TEST_WEBKIT=1 after installing WebKit system dependencies' }, async t => {
  const safariEngine = await webkit.launch();
  t.after(() => safariEngine.close());
  const { context, page } = await setup(t, { camera: 'deny' }, safariEngine);
  await page.waitForSelector('#camera-retry:visible');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#camera-retry:visible');
  assert.match(await page.title(), /水印相机/);
});

test('gallery suspends camera and restores it only when the gallery is closed', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.click('#btn-gallery');
  await allStopped(page);
  await hide(page);
  await show(page);
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject), null);
  await page.locator('#gallery-panel-overlay').click({ position: { x: 10, y: 10 } });
  await ready(page);
});

test('camera interruption exposes retry and releases the interrupted stream', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => document.querySelector('#camera-preview').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await allStopped(page);
  await page.waitForSelector('#camera-retry:visible');
  await page.click('#camera-retry');
  await ready(page);
});

test('recorder construction failure releases microphone and allows another attempt', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => {
    window.RealRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends window.RealRecorder {
      constructor() { throw new Error('Simulated encoder failure'); }
    };
  });
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForFunction(() => window.mediaStreams.length === 2 && window.mediaStreams[1].getTracks().every(track => track.readyState === 'ended'));
  assert.equal(await page.locator('#shutter-btn').evaluate(btn => btn.classList.contains('recording')), false);
  await page.evaluate(() => { window.MediaRecorder = window.RealRecorder; });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await allStopped(page);
});

test('captured photos survive reload; preview and thumbnail URLs are released', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => {
    window.createdURLs = []; window.revokedURLs = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.createdURLs.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedURLs.push(url); return revoke(url); };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 1);
  await page.click('#preview-close');
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-item img');
  await page.locator('#gallery-panel-overlay').click({ position: { x: 10, y: 10 } });
  assert.equal(await page.evaluate(() => window.createdURLs.every(url => window.revokedURLs.includes(url))), true);
  await page.reload();
  await ready(page);
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-item');
  await page.click('.gallery-item');
  await page.waitForSelector('#preview-modal.show img');
  await page.waitForFunction(() => document.querySelector('#preview-modal img')?.naturalWidth > 0);
});

test('in-flight photo save cannot be deleted through the gallery; camera is off while saving', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => {
    const real = MediaStore;
    window.MediaStore = { ...real, put: async record => {
      await new Promise(resolve => { window.finishSave = resolve; });
      return real.put(record);
    } };
  });
  await page.click('#shutter-btn');
  await page.waitForFunction(() => typeof window.finishSave === 'function');
  await allStopped(page);
  await page.click('#btn-gallery');
  assert.equal(await page.locator('#gallery-panel').evaluate(panel => panel.classList.contains('show')), false);
  await page.evaluate(() => window.finishSave());
  await page.waitForSelector('#preview-modal.show img');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除此作品' }).click();
  await page.waitForFunction(async () => (await MediaStore.list()).length === 0);
  await page.reload();
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-empty');
  assert.equal(await page.locator('.gallery-item').count(), 0);
});

test('storage failure keeps a usable photo and warns it has not been persisted', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => {
    window.MediaStore = { ...MediaStore, put: async () => { throw new DOMException('Full', 'QuotaExceededError'); } };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  assert.match(await page.locator('.preview-save-hint').textContent(), /尚未存入本机/);
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 0);
  await page.click('#preview-close');
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-item');
  await page.click('.gallery-item');
  await page.waitForSelector('#preview-modal.show img');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载原文件', exact: true }).click();
  assert.match((await download).suggestedFilename(), /\.jpg$/);
});

test('closing a slow preview prevents a late database result reopening it', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  await page.click('#preview-close');
  await page.click('#btn-gallery');
  await page.waitForSelector('.gallery-item');
  await page.evaluate(() => {
    const real = MediaStore;
    window.MediaStore = { ...real, get: async id => {
      await new Promise(resolve => { window.finishRead = resolve; });
      const result = await real.get(id); window.readCompleted = true; return result;
    } };
  });
  await page.click('.gallery-item');
  await page.waitForFunction(() => typeof window.finishRead === 'function');
  await page.click('#preview-close');
  await page.evaluate(() => window.finishRead());
  await page.waitForFunction(() => window.readCompleted);
  assert.equal(await page.locator('#preview-modal').evaluate(modal => modal.classList.contains('show')), false);
  assert.equal(await page.locator('#preview-media-container img').count(), 0);
});

test('failed system sharing is attempted once, with an explicit download option', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  await page.evaluate(() => {
    window.shareCalls = 0;
    navigator.canShare = () => true;
    navigator.share = async () => { window.shareCalls++; throw new DOMException('Cannot share', 'NotAllowedError'); };
  });
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('分享未完成'));
  assert.equal(await page.evaluate(() => window.shareCalls), 1);
  assert.equal(await page.getByRole('button', { name: '下载原文件', exact: true }).isEnabled(), true);
});

test('location resumes after interruption, treats place names as text, and discards stale addresses on failure', async t => {
  const { page } = await setup(t, { geo: 'defer' });
  await ready(page);
  const place = '<img src=x onerror="window.poiInjected=true">';
  await page.route('**/api/reverse-geocode?**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ status: '1', regeocode: {
      formatted_address: '新位置', addressComponent: { city: '新城市', district: '新区' },
      pois: [{ name: place, distance: '100' }],
    } }),
  }));
  await hide(page);
  await show(page);
  await page.waitForFunction(() => window.geoRequests.length === 2);
  await page.evaluate(() => window.geoRequests[0].success({ timestamp: Date.now(), coords: { latitude: 10, longitude: 10, accuracy: 15 } }));
  await page.evaluate(() => window.geoRequests[1].success({ timestamp: Date.now(), coords: { latitude: 30, longitude: 120, accuracy: 15 } }));
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('地图估算：新位置'));
  assert.equal(await page.locator('.poi-item span').first().textContent(), place);
  assert.equal(await page.locator('#poi-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.poiInjected), undefined);
  await page.click('#btn-settings');
  await page.click('#btn-refresh-location');
  await page.waitForFunction(() => window.geoRequests.length === 3);
  await page.evaluate(() => window.geoRequests[2].error({ code: 3 }));
  assert.equal(await page.locator('#wm-location-tl').textContent(), '定位暂不可用');
  assert.equal(await page.locator('#location-status-hint').textContent(), '定位暂不可用');
});

test('watermark preferences survive reload and long text fits inside the captured canvas', async t => {
  const { page } = await setup(t);
  await ready(page);
  const address = '北京市朝阳区长地址测试'.repeat(5).slice(0, 60);
  const custom = '这是需要完整保留的自定义文字'.repeat(3).slice(0, 40);
  await page.click('#btn-settings');
  await page.click('#toggle-manual-addr');
  await page.fill('#manual-addr-input', address);
  await page.click('#toggle-custom');
  await page.fill('#custom-text-input', custom);
  await page.click('[data-size="xl"]');
  await page.click('[data-pos="br"]');
  await page.reload();
  await ready(page);
  await page.locator('[data-mode="photo"]').click();
  assert.equal(await page.locator('#manual-addr-input').inputValue(), address);
  assert.equal(await page.locator('#custom-text-input').inputValue(), custom);
  assert.equal(await page.locator('[data-size="xl"]').evaluate(button => button.classList.contains('active')), true);
  await page.evaluate(() => {
    window.drawnText = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      window.drawnText.push({ text, x, y, textWidth: this.measureText(text).width, width: this.canvas.width, height: this.canvas.height, fontSize: Number(this.font.match(/[\d.]+(?=px)/)[0]) });
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  const lines = await page.evaluate(() => window.drawnText);
  assert.ok(lines.map(line => line.text).join('').includes(address));
  assert.ok(lines.map(line => line.text).join('').includes(custom));
  assert.ok(lines.every(line => line.x - line.textWidth >= 0 && line.x <= line.width && line.y >= 0 && line.y + line.fontSize <= line.height));
});

test('preview controls fit on a narrow iPhone viewport', async t => {
  const { page } = await setup(t);
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  const layout = await page.locator('#preview-actions button').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }));
  assert.equal(layout.length, 5);
  assert.ok(layout.every(rect => rect.left >= 0 && rect.right <= 320 && rect.top >= 0 && rect.bottom <= 568));
});

test('small-screen recording keeps mode buttons, timer and the whole image separate', async t => {
  const { page } = await setup(t, { portraitCamera: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#recording-timer.show');
  const layout = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { top: rect('#top-bar'), mode: rect('#mode-bar'), timer: rect('#recording-timer'),
      video: rect('#camera-preview'), bottom: rect('#bottom-bar') };
  });
  assert.ok(layout.mode.height < 50, 'mode buttons stay on one line');
  assert.ok(layout.mode.left >= 0 && layout.mode.right <= 320);
  assert.ok(layout.top.bottom <= layout.timer.top);
  assert.ok(layout.timer.bottom < layout.video.top);
  assert.ok(layout.video.bottom < layout.mode.top);
  assert.ok(layout.mode.bottom <= layout.bottom.top);
  assert.ok(layout.video.height >= 290, 'compact controls leave useful space for portrait framing');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
});

test('a page first opened in the background requests its first location on return', async t => {
  const { page } = await setup(t, { geo: 'defer', initiallyHidden: true });
  assert.equal(await page.evaluate(() => window.geoRequests.length), 0);
  await show(page);
  await ready(page);
  assert.equal(await page.evaluate(() => window.geoRequests.length), 1);
});

test('stalled photo encoding times out and late callbacks cannot replace a later shot', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.clock.install();
  await page.evaluate(() => {
    window.delayedEncodes = [];
    const original = HTMLCanvasElement.prototype.toBlob;
    window.holdEncoding = true;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      if (window.holdEncoding) window.delayedEncodes.push(callback);
      else original.call(this, callback, ...args);
    };
  });
  await page.click('#shutter-btn');
  await page.waitForFunction(() => window.delayedEncodes.length === 2);
  await allStopped(page);
  await page.clock.fastForward(15001);
  await ready(page);
  await page.evaluate(() => {
    window.holdEncoding = false;
    window.delayedEncodes.forEach(callback => callback(new Blob(['late JPEG'], { type: 'image/jpeg' })));
  });
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 0);
  assert.equal(await page.locator('#preview-modal').evaluate(modal => modal.classList.contains('show')), false);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 1);
});

test('quality selection restarts the camera cleanly, persists, and controls photo resolution', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => { window.ecoTrack = document.querySelector('#camera-preview').srcObject.getVideoTracks()[0]; });
  await page.click('#btn-settings');
  await page.click('[data-quality="hd"]');
  await ready(page);
  assert.equal(await page.evaluate(() => window.ecoTrack.readyState), 'ended');
  assert.equal(await page.evaluate(() => window.mediaRequests.filter(request => request.video).at(-1).video.width.ideal), 1920);
  await page.click('[data-close-panel="watermark-panel"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  await page.waitForFunction(() => document.querySelector('#preview-modal img')?.naturalWidth > 0);
  const dimensions = await page.locator('#preview-modal img').evaluate(img => [img.naturalWidth, img.naturalHeight]);
  assert.ok(Math.max(...dimensions) <= 1920);
  assert.ok(Math.max(...dimensions) > 1280, 'fake camera supports 1080p output');
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('[data-quality="hd"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.mediaRequests[0].video.width.ideal), 1920);
  await page.evaluate(() => { window.hdTrack = document.querySelector('#camera-preview').srcObject.getVideoTracks()[0]; });
  await page.click('#btn-settings');
  await page.click('[data-quality="eco"]');
  await ready(page);
  assert.equal(await page.evaluate(() => window.hdTrack.readyState), 'ended');
  assert.equal(await page.evaluate(() => window.mediaRequests.filter(request => request.video).at(-1).video.width.ideal), 1280);
});

test('watermark preview matches all four exported corners and avoids controls in both orientations', async t => {
  const { page } = await setup(t, { portraitCamera: true });
  await ready(page);
  await page.click('#btn-settings');
  await page.click('#toggle-time');
  await page.click('#toggle-date');
  await page.click('#toggle-manual-addr');
  await page.fill('#manual-addr-input', '一致的水印位置');
  await page.evaluate(() => {
    window.previewText = []; window.photoText = [];
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.id === 'watermark-preview') window.previewText = [];
      return clear.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      const line = { text, x, y, font: this.font, alignment: this.textAlign, color: this.fillStyle };
      (this.canvas.id === 'watermark-preview' ? window.previewText : window.photoText).push(line);
      return fill.call(this, text, x, y, ...args);
    };
  });
  for (const [index, position] of ['tr', 'br', 'bl', 'tl'].entries()) {
    if (index) await page.click('#btn-settings');
    await page.click(`[data-pos="${position}"]`);
    await page.click('[data-close-panel="watermark-panel"]');
    await page.setViewportSize(index % 2 ? { width: 844, height: 390 } : { width: 390, height: 844 });
    await page.waitForFunction(() => {
      const video = document.querySelector('#camera-preview').getBoundingClientRect();
      const top = document.querySelector('#top-bar').getBoundingClientRect();
      const mode = document.querySelector('#mode-bar').getBoundingClientRect();
      return innerWidth > innerHeight
        ? video.top >= Math.max(top.bottom, mode.bottom)
        : video.top >= top.bottom && video.bottom <= mode.top;
    });
    const layout = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { video: rect('camera-preview'), watermark: rect('watermark-preview'), controls: rect('bottom-bar'), mode: rect('mode-bar'), text: window.previewText, size: [document.querySelector('#watermark-preview').width, document.querySelector('#watermark-preview').height] };
    });
    for (const property of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(layout.video[property] - layout.watermark[property]) < 1);
    if (index % 2) assert.ok(layout.video.right <= layout.controls.x);
    else {
      assert.ok(layout.video.bottom <= layout.mode.y);
      assert.ok(layout.mode.bottom <= layout.controls.y);
    }
    assert.ok(layout.text.length > 0);
    await page.evaluate(() => { window.photoText = []; });
    await page.click('#shutter-btn');
    await page.waitForSelector('#preview-modal.show img');
    assert.deepEqual(await page.evaluate(() => window.photoText), layout.text);
    await page.waitForFunction(() => document.querySelector('#preview-modal img')?.naturalWidth > 0);
    assert.deepEqual(await page.locator('#preview-modal img').evaluate(img => [img.naturalWidth, img.naturalHeight]), layout.size);
    await page.click('#preview-close');
    await ready(page);
  }
});

test('recording retains its output dimensions through rotation and pauses playback in background', async t => {
  const { page } = await setup(t, { portraitCamera: true });
  await ready(page);
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.evaluate(() => {
    window.drawnFrames = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      if (source instanceof HTMLVideoElement) window.drawnFrames.push({ output: [this.canvas.width, this.canvas.height], image: args });
      return draw.call(this, source, ...args);
    };
    const source = window.syntheticCameraCanvas;
    source.width = 1280; source.height = 720;
    const ctx = source.getContext('2d'); ctx.fillStyle = 'green'; ctx.fillRect(0, 0, source.width, source.height);
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => document.querySelector('#camera-preview').videoWidth === 1280 && window.drawnFrames.some(frame => frame.image[3] < frame.output[1]));
  const frame = await page.evaluate(() => window.drawnFrames.at(-1));
  assert.deepEqual(frame.output, [720, 1280]);
  assert.ok(Math.abs(frame.image[2] / frame.image[3] - 1280 / 720) < 0.01);
  await page.click('#btn-settings');
  assert.equal(await page.locator('[data-quality="hd"]').isDisabled(), true);
  assert.equal(await page.locator('[data-quality="eco"]').getAttribute('aria-pressed'), 'true');
  await page.click('[data-close-panel="watermark-panel"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await page.locator('#preview-modal video').evaluate(video => video.play());
  assert.equal(await page.locator('#preview-modal video').evaluate(video => video.paused), false);
  await hide(page);
  assert.equal(await page.locator('#preview-modal video').evaluate(video => video.paused), true);
});

test('recording uses media timestamps and preserves source frames despite callback jitter', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(() => {
    const video = document.querySelector('#camera-preview');
    video.requestVideoFrameCallback = callback => { window.nextVideoFrame = callback; return 1; };
    video.cancelVideoFrameCallback = () => { window.nextVideoFrame = null; };
    window.drawnVideoFrames = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      if (source instanceof HTMLVideoElement) window.drawnVideoFrames++;
      return draw.call(this, source, ...args);
    };
  });
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  const rendered = await page.evaluate(() => {
    const before = window.drawnVideoFrames;
    let now = 0;
    for (let frame = 0; frame < 24; frame++) {
      now += frame % 2 ? 50 : 1000 / 30;
      window.nextVideoFrame(now, { mediaTime: frame / 24 });
    }
    return window.drawnVideoFrames - before;
  });
  assert.equal(rendered, 24);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
});

test('album reads only the requested page and can retry a failed next-page read', async t => {
  const { page } = await setup(t);
  await ready(page);
  await page.evaluate(async () => {
    for (let i = 0; i < 65; i++) await MediaStore.put({ id: `item-${String(i).padStart(2, '0')}`, type: 'photo', timestamp: i, blob: new Blob(['image'], { type: 'image/jpeg' }) });
    const original = MediaStore;
    window.pageReads = [];
    window.MediaStore = { ...original,
      list: () => { throw new Error('Full album reads are not allowed'); },
      listPage: async options => {
        window.pageReads.push(options);
        if (window.rejectPage) { window.rejectPage = false; throw new Error('Temporary storage failure'); }
        return original.listPage(options);
      },
    };
  });
  await page.click('#btn-gallery');
  await page.waitForFunction(() => document.querySelectorAll('.gallery-item').length === 30);
  await page.evaluate(() => { window.rejectPage = true; });
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gallery-item').length === 60);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gallery-item').length === 65);
  assert.equal(await page.getByRole('button', { name: '加载更多', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('.gallery-item')].map(item => item.dataset.id)).size), 65);
  assert.ok(await page.evaluate(() => window.pageReads.every(options => options.limit === 30)));
});

test('vehicle inspection details survive reload and export a locally verifiable recording record', async t => {
  const { page } = await setup(t, { mode: 'default', geo: 'defer' });
  await ready(page);
  await page.evaluate(() => window.geoRequests[0].success({ timestamp: Date.now(), coords: { latitude: 30.25, longitude: 120.15, accuracy: 17 } }));
  await page.waitForFunction(() => document.querySelector('#location-summary').textContent.includes('17m'));
  await page.click('#btn-settings');
  await page.click('[data-stage="after"]');
  await page.fill('#vehicle-label', '浙A·TEST');
  await page.fill('#order-label', '1026');
  await page.click('[data-close-panel="watermark-panel"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  const captured = await page.evaluate(async () => {
    const [item] = await MediaStore.list();
    const record = await MediaStore.get(item.id);
    return { id: record.id, type: record.type, evidence: record.evidence, bytes: [...new Uint8Array(await record.blob.arrayBuffer())] };
  });
  assert.equal(captured.type, 'video');
  assert.equal(captured.evidence.id, captured.id);
  assert.deepEqual(captured.evidence.inspection, { stage: 'after', vehicle: '浙A·TEST', order: '1026', source: 'user-entered-unverified' });
  assert.equal(captured.evidence.processing, 'canvas-burned-watermark');
  assert.equal(captured.evidence.timeSource, 'device-clock-unverified');
  assert.equal(captured.evidence.locationAtStart.accuracy, 17);
  assert.equal(captured.evidence.locationAtStart.authenticated, false);
  assert.equal(captured.evidence.clockShiftDetected, false);
  assert.ok(captured.evidence.elapsedMs >= 1000);
  assert.ok(captured.evidence.endedAtDeviceMs >= captured.evidence.startedAtDeviceMs);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('#vehicle-label').inputValue(), '', 'new page must not carry over another vehicle');
  assert.equal(await page.locator('#order-label').inputValue(), '', 'new page must not carry over another order');
  await page.click('#btn-gallery');
  await page.locator('.gallery-item').click();
  await page.waitForSelector('#preview-modal.show video');
  await page.getByRole('button', { name: '导出校验记录', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载校验记录', exact: true }).click();
  const download = await downloading;
  const manifest = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(manifest.schema, 'watermark-camera-local-record');
  assert.equal(manifest.file.sha256, createHash('sha256').update(Buffer.from(captured.bytes)).digest('hex'));
  assert.equal(manifest.file.size, captured.bytes.length);
  assert.deepEqual(manifest.captureMetadata, captured.evidence);
  assert.equal(manifest.attestation.status, 'local-unattested');
});

test('a device clock jump during recording is retained without authenticating its time or location', async t => {
  const { page } = await setup(t, { mode: 'default' });
  await ready(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.evaluate(() => {
    const originalNow = Date.now;
    Date.now = () => originalNow() + 60000;
  });
  await encodedClipReady(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  const evidence = await page.evaluate(async () => (await MediaStore.get((await MediaStore.list())[0].id)).evidence);
  assert.equal(evidence.clockShiftDetected, true);
  assert.equal(evidence.timeSource, 'device-clock-unverified');
  assert.equal(evidence.locationAtStart.authenticated, false);
  assert.equal(evidence.locationAtStart.lat, null);
  assert.ok(evidence.endedAtDeviceMs - evidence.startedAtDeviceMs - evidence.elapsedMs >= 59000);
});
