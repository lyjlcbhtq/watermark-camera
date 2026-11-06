const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let server, browser, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('outside root');
      const body = await fs.readFile(file);
      const type = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (_, error) => error({ code: 1 });
    navigator.mediaDevices.getUserMedia = async options => {
      if (options.audio) throw new DOMException('No audio', 'NotAllowedError');
      const source = document.createElement('canvas');
      source.width = 720; source.height = 1280;
      const ctx = source.getContext('2d');
      ctx.fillStyle = '#80958b'; ctx.fillRect(0, 0, 720, 1280);
      ctx.fillStyle = '#f00000'; ctx.fillRect(0, 0, 720, 30);
      ctx.fillStyle = '#0000f0'; ctx.fillRect(0, 1250, 720, 30);
      ctx.fillStyle = '#00d000'; ctx.fillRect(0, 0, 30, 1280);
      ctx.fillStyle = '#e0e000'; ctx.fillRect(690, 0, 30, 1280);
      return source.captureStream(24);
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    window.visibleWatermarkLines = [];
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.id === 'watermark-preview') window.visibleWatermarkLines = [];
      return clearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (this.canvas.id === 'watermark-preview') window.visibleWatermarkLines.push({
        text, x, y, width: this.measureText(text).width,
        fontSize: Number(this.font.match(/[\d.]+(?=px)/)[0]), align: this.textAlign,
      });
      return fillText.call(this, text, x, y, ...args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 && document.querySelector('#loading-overlay').classList.contains('hidden'));
  return page;
}

async function changePreviewFraming(page) {
  await page.click('#btn-settings');
  await page.click('#btn-camera-fit');
  await page.click('[data-close-panel="watermark-panel"]');
}

test('home keeps common capture controls and settings retain framing, quality and location', async t => {
  const page = await setup(t);
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator('#top-bar button:visible').count(), 1);
    assert.equal(await page.locator('#bottom-bar button:visible').count(), 3);
    assert.equal(await page.locator('#bottom-bar #btn-switch-camera').isVisible(), true);
    assert.equal(await page.locator('#btn-camera-fit').isVisible(), false);
    assert.equal(await page.locator('#location-summary').isVisible(), false);
    await page.click('#btn-settings');
    for (const selector of ['#btn-camera-fit', '#camera-quality', '#location-summary', '#quality-options', '#toggle-location']) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} remains available in settings`);
    }
    await page.click('[data-close-panel="watermark-panel"]');
    assert.equal(await page.locator('#btn-settings').evaluate(button => document.activeElement === button), true);
    const controls = await page.locator('#top-bar button, #bottom-bar button, #mode-bar button').evaluateAll(elements => elements.map(element => {
      const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
    }));
    assert.ok(controls.every(b => b.x >= 0 && b.y >= 0 && b.right <= viewport.width && b.bottom <= viewport.height));
  }
  const oldStream = await page.locator('#camera-preview').evaluate(video => {
    window.previousViewTrack = video.srcObject.getVideoTracks()[0]; return video.srcObject.id;
  });
  await page.click('#btn-switch-camera');
  await page.waitForFunction(previous => document.querySelector('#camera-preview').srcObject?.id !== previous &&
    document.querySelector('#camera-preview').readyState >= 2, oldStream);
  assert.equal(await page.evaluate(() => window.previousViewTrack.readyState), 'ended');
});

test('camera uses the whole viewport; crop preview keeps watermark visible and preserves every captured edge', async t => {
  const page = await setup(t);
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const box = document.querySelector('#camera-preview').getBoundingClientRect();
      return Math.abs(box.height - innerHeight) < 1 || Math.abs(box.width - innerWidth) < 1;
    });
    const frame = await page.locator('#camera-preview').boundingBox();
    assert.ok(frame.x >= -1 && frame.y >= -1);
    assert.ok(Math.abs(frame.width - viewport.width) < 1 || Math.abs(frame.height - viewport.height) < 1);
    await changePreviewFraming(page);
    assert.equal(await page.locator('#btn-camera-fit').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#camera-view-hint').textContent(), /铺满预览.*裁.*原文件.*完整画面/);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const layer = document.querySelector('#watermark-preview');
      const box = layer.getBoundingClientRect();
      const scale = box.width / layer.width;
      return { video: rect('#camera-preview'), top: rect('#top-bar'), mode: rect('#mode-bar'), bottom: rect('#bottom-bar'),
        lines: window.visibleWatermarkLines.map(line => ({
          text: line.text, left: box.left + (line.x - (line.align === 'right' ? line.width : 0)) * scale,
          right: box.left + (line.x + (line.align === 'right' ? 0 : line.width)) * scale,
          top: box.top + line.y * scale, bottom: box.top + (line.y + line.fontSize) * scale,
        })) };
    });
    assert.ok(layout.video.left <= 1 && layout.video.top <= 1 && layout.video.right >= viewport.width - 1 && layout.video.bottom >= viewport.height - 1);
    assert.ok(layout.lines.length > 0);
    for (const line of layout.lines) {
      assert.ok(line.left >= 0 && line.right <= viewport.width + 1 && line.top >= layout.top.bottom && line.bottom <= viewport.height, JSON.stringify(line));
      if (viewport.width > viewport.height) assert.ok(line.right < layout.bottom.left);
      else assert.ok(line.bottom < layout.mode.top);
    }
    const buttons = await page.locator('#top-bar button, #bottom-bar button').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }));
    assert.ok(buttons.every(box => box.left >= 0 && box.top >= 0 && box.right <= viewport.width && box.bottom <= viewport.height));
    if (process.env.FULLSCREEN_SCREENSHOTS) await page.screenshot({ path: `${process.env.FULLSCREEN_SCREENSHOTS}/fill-${viewport.width}x${viewport.height}.png` });
    await changePreviewFraming(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await changePreviewFraming(page);
  await page.click('[data-mode="photo"]');
  await page.click('#shutter-btn');
  await page.waitForFunction(() => document.querySelector('#preview-modal img')?.naturalWidth > 0);
  const exported = await page.locator('#preview-modal img').evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const sample = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { width: canvas.width, height: canvas.height, top: sample(360, 10), bottom: sample(360, 1270), left: sample(10, 640), right: sample(710, 640) };
  });
  assert.deepEqual([exported.width, exported.height], [720, 1280]);
  for (const [edge, expected] of Object.entries({ top: [240, 0, 0], bottom: [0, 0, 240], left: [0, 208, 0], right: [224, 224, 0] })) {
    assert.ok(exported[edge].every((value, index) => Math.abs(value - expected[index]) < 12), `${edge} preserved`);
  }
  assert.equal(await page.locator('#preview-fullscreen').isVisible(), false, 'video fullscreen is hidden for photos');
});

async function openStoredVideo(page) {
  await page.evaluate(() => MediaStore.put({ id: 'fullscreen-fixture', type: 'video', timestamp: Date.now(), blob: new Blob(['video fixture'], { type: 'video/mp4' }) }));
  await page.reload();
  await page.click('#btn-gallery');
  await page.click('.gallery-item');
  await page.waitForSelector('#preview-modal.show video');
}

test('video fullscreen fills portrait and landscape when native APIs are unavailable, and Escape returns to actions', async t => {
  const page = await setup(t);
  await openStoredVideo(page);
  await page.evaluate(() => {
    document.querySelector('#preview-modal').requestFullscreen = async () => { throw new Error('Not supported in standalone mode'); };
    document.querySelector('#preview-modal video').webkitEnterFullscreen = undefined;
  });
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '全屏观看', exact: true }).click();
    const box = await page.locator('#preview-media-container').boundingBox();
    assert.deepEqual(box, { x: 0, y: 0, ...viewport });
    assert.equal(await page.locator('#preview-actions').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '退出全屏' }).isVisible(), true);
    assert.equal(await page.locator('#preview-modal video').evaluate(video => getComputedStyle(video).objectFit), 'contain');
    if (process.env.FULLSCREEN_SCREENSHOTS) await page.screenshot({ path: `${process.env.FULLSCREEN_SCREENSHOTS}/playback-${viewport.width}x${viewport.height}.png` });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#preview-modal').isVisible(), true);
    assert.equal(await page.locator('#preview-actions').isVisible(), true);
    assert.equal(await page.locator('#preview-fullscreen').evaluate(button => document.activeElement === button), true);
  }
});

test('iPhone video fullscreen uses the native user-gesture API and returning restores the preview', async t => {
  const page = await setup(t);
  await openStoredVideo(page);
  await page.evaluate(() => {
    window.nativeFullscreenCalls = 0;
    document.querySelector('#preview-modal video').webkitEnterFullscreen = function() { window.nativeFullscreenCalls++; };
    document.querySelector('#preview-modal').requestFullscreen = () => { throw new Error('Native video API should take priority'); };
  });
  await page.click('#preview-fullscreen');
  assert.equal(await page.evaluate(() => window.nativeFullscreenCalls), 1);
  await page.locator('#preview-modal video').evaluate(video => video.dispatchEvent(new Event('webkitendfullscreen')));
  assert.equal(await page.locator('#preview-actions').isVisible(), true);
  assert.equal(await page.locator('#preview-fullscreen').evaluate(button => document.activeElement === button), true);
});
