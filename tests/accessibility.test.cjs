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
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/watermark-camera/')) { res.writeHead(404).end(); return; }
      const relative = url.pathname.slice('/watermark-camera/'.length);
      const file = path.resolve(root, relative || 'index.html');
      if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
      const body = await fs.readFile(file);
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/watermark-camera/`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup(t, { pois, mode = 'photo' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(hasPois => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => {
      if (hasPois) success({ timestamp: Date.now(), coords: { latitude: 30, longitude: 120, accuracy: 15 } });
      else error({ code: 1 });
    };
    window.photoEncodes = 0;
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.photoEncodes++;
      return original.apply(this, args);
    };
  }, Boolean(pois));
  if (pois) {
    await context.route('**/api/reverse-geocode?**', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: '1', regeocode: {
        formatted_address: '测试地址', addressComponent: {}, pois,
      } }),
    }));
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught page errors'));
  await page.goto(origin);
  await ready(page);
  if (mode === 'photo') await page.locator('[data-mode="photo"]').click();
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('#camera-preview');
    return video.srcObject?.getVideoTracks()[0]?.readyState === 'live' && video.readyState >= 2 &&
      document.querySelector('#loading-overlay').classList.contains('hidden');
  });
}

async function assertPressedMatchesClass(page) {
  const mismatches = await page.locator('.toggle, .color-dot, .mode-btn, .option-btn').evaluateAll(buttons =>
    buttons.filter(button => button.tagName !== 'BUTTON' || button.getAttribute('aria-pressed') !==
      String(button.classList.contains(button.classList.contains('toggle') ? 'on' : 'active')))
      .map(button => button.id || button.outerHTML));
  assert.deepEqual(mismatches, [], 'pressed state must match the visible selection on every control');
}

test('shutter accessible name follows photo, video and active recording', async t => {
  const page = await setup(t, { mode: 'default' });
  assert.equal(await page.getByRole('button', { name: '开始录像', exact: true }).getAttribute('id'), 'shutter-btn');
  await page.locator('[data-mode="photo"]').click();
  assert.equal(await page.getByRole('button', { name: '拍照', exact: true }).getAttribute('id'), 'shutter-btn');
  await page.locator('[data-mode="video"]').click();
  await page.getByRole('button', { name: '开始录像', exact: true }).click();
  await page.getByRole('button', { name: '停止录像', exact: true }).waitFor();
  await assertPressedMatchesClass(page);
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent === '00:01');
  await page.getByRole('button', { name: '停止录像', exact: true }).click();
  await page.waitForSelector('#preview-modal.show video');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await ready(page);
  assert.equal(await page.getByRole('button', { name: '开始录像', exact: true }).getAttribute('id'), 'shutter-btn');
  await page.locator('[data-mode="photo"]').click();
  assert.equal(await page.getByRole('button', { name: '拍照', exact: true }).getAttribute('id'), 'shutter-btn');
  await assertPressedMatchesClass(page);
});

test('toggle and color buttons announce the same state that is displayed', async t => {
  const page = await setup(t);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await assertPressedMatchesClass(page);
  for (const id of ['time', 'date', 'location', 'custom', 'manual-addr']) {
    const toggle = page.locator(`#toggle-${id}`);
    const initial = await toggle.getAttribute('aria-pressed');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), String(initial !== 'true'));
    await assertPressedMatchesClass(page);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), initial);
  }
  for (const name of ['黄色', '红色', '蓝色', '绿色', '橙色', '白色']) {
    const color = page.getByRole('button', { name, exact: true });
    await color.click();
    assert.equal(await color.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.color-dot[aria-pressed="true"]').count(), 1);
    await assertPressedMatchesClass(page);
  }
});

test('Enter and Space operate settings without triggering the camera shortcut', async t => {
  const page = await setup(t);
  await page.getByRole('button', { name: '设置', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#watermark-panel.show');
  await page.getByRole('button', { name: '显示时间', exact: true }).press('Space');
  assert.equal(await page.locator('#toggle-time').getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '显示日期', exact: true }).press('Enter');
  assert.equal(await page.locator('#toggle-date').getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '红色', exact: true }).press('Space');
  assert.equal(await page.getByRole('button', { name: '红色', exact: true }).getAttribute('aria-pressed'), 'true');
  const input = page.getByRole('textbox', { name: '自定义内容', exact: true });
  await input.fill('键盘');
  await input.press('End');
  await input.press('Space');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '键盘 ');
  await page.getByRole('button', { name: '完成水印设置', exact: true }).press('Enter');
  await page.waitForFunction(() => !document.querySelector('#watermark-panel').classList.contains('show'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-settings');
  assert.equal(await page.evaluate(() => window.photoEncodes), 0);
  assert.equal(await page.locator('#preview-modal').evaluate(modal => modal.classList.contains('show')), false);
  await ready(page);
});

test('panel completion controls close dialogs and return focus to their opener', async t => {
  const page = await setup(t);
  for (const [opener, panel, closeName] of [
    ['水印', 'watermark-panel', '完成水印设置'],
    ['相册', 'gallery-panel', '关闭相册'],
  ]) {
    const openButton = page.getByRole('button', { name: opener, exact: true });
    const openerId = await openButton.getAttribute('id');
    await openButton.focus();
    await page.keyboard.press('Space');
    await page.waitForSelector(`#${panel}.show`);
    const close = page.getByRole('button', { name: closeName, exact: true });
    assert.equal(await close.evaluate(button => button === document.activeElement), true);
    await close.press('Space');
    await page.waitForFunction(id => !document.getElementById(id).classList.contains('show'), panel);
    assert.equal(await page.locator(`#${panel}-overlay`).evaluate(overlay => overlay.classList.contains('show')), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), openerId);
    await ready(page);
  }
  assert.equal(await page.evaluate(() => window.photoEncodes), 0);
});

test('settings keyboard focus stays in the dialog and Escape restores the opener', async t => {
  const page = await setup(t);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('#watermark-panel').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
  await page.waitForFunction(() => document.activeElement.dataset.closePanel === 'watermark-panel');
  await page.keyboard.press('Shift+Tab');
  await page.waitForFunction(() => document.activeElement.dataset.size === 'xl');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement.dataset.closePanel === 'watermark-panel');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#watermark-panel').evaluate(panel => panel.classList.contains('show')), false);
  await page.waitForFunction(() => document.activeElement.id === 'btn-settings');
});

test('enabling nearest place selects the first result and updates announced state', async t => {
  const page = await setup(t, { pois: [
    { name: '最近的公园', distance: '25' },
    { name: '远处的书店', distance: '100' },
  ] });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForSelector('#poi-section:visible');
  const toggle = page.getByRole('button', { name: '使用最近地点', exact: true });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.poi-item.active').count(), 0);
  await toggle.press('Space');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.poi-item.active span').first().textContent(), '最近的公园');
  assert.match(await page.locator('#location-status-hint').textContent(), /选定地点（未核验）：最近的公园/);
  assert.match(await page.locator('#location-status-hint').textContent(), /估计误差±15m/);
  assert.match(await page.locator('#wm-location-tl').textContent(), /最近的公园/);
  await assertPressedMatchesClass(page);
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.poi-item.active').count(), 0);
  assert.doesNotMatch(await page.locator('#location-status-hint').textContent(), /选定地点（未核验）/);
  await page.getByRole('button', { name: /^远处的书店\s*100m$/ }).click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#location-status-hint').textContent(), /选定地点（未核验）：远处的书店/);
  await assertPressedMatchesClass(page);
});
