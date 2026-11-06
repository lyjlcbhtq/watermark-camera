const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://lyjlcbhtq.github.io/watermark-camera/';
let browser;
before(async () => {
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); });

const addressResponse = (address, pois = []) => ({ status: '1', regeocode: { formatted_address: address, addressComponent: {}, pois } });

async function setup(t, reply = () => addressResponse('浙江省杭州市西湖区测试路')) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const requests = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://restapi.amap.com') {
      // Deliberately retain only safe request details: never log or assert a key value.
      const request = { path: url.pathname, location: url.searchParams.get('location'),
        radius: url.searchParams.get('radius'), extensions: url.searchParams.get('extensions'),
        output: url.searchParams.get('output'), hasKey: Boolean(url.searchParams.get('key')) };
      requests.push(request);
      const data = await reply(requests.length, request);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
      return;
    }
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/watermark-camera/')) {
      await route.abort();
      return;
    }
    const relative = url.pathname.slice('/watermark-camera/'.length) || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { await route.fulfill({ status: 404, body: '' }); return; }
    try {
      const body = await fs.readFile(file);
      const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
      await route.fulfill({ status: 200, contentType, body });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await context.addInitScript(() => {
    window.testPosition = { latitude: 30.25, longitude: 120.15, accuracy: 12 };
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = success => success({ timestamp: Date.now(), coords: { ...window.testPosition } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught address errors'));
  await page.goto(origin);
  await cameraReady(page);
  return { context, page, requests };
}

async function cameraReady(page) {
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#camera-preview').srcObject?.getVideoTracks()[0]?.readyState === 'live' &&
    document.querySelector('#loading-overlay').classList.contains('hidden'));
}

async function refresh(page) {
  await page.click('#location-summary');
}

async function watermark(page) { return page.locator('#wm-location-tl').textContent(); }

test('Pages restores Chinese nearby addresses with converted coordinates, sorted distances and text-only names', async t => {
  const injected = '<img src=x onerror="window.nearbyInjected=true">';
  const { page, requests } = await setup(t, call => addressResponse('浙江省杭州市西湖区测试路8号', call === 1 ? [
    { name: '远处的书店', distance: '200' },
    { name: '距离缺失的地点' },
    { name: injected, distance: '25' },
    { name: '空距离地点', distance: '' },
    { name: '空白距离地点', distance: ' ' },
    { name: '布尔距离地点', distance: false },
    { name: '数组距离地点', distance: [] },
    null,
    { name: '', distance: '1' },
  ] : [...Array.from({ length: 21 }, (_, i) => ({ name: `较远地点${i}`, distance: String(100 + i) })),
    { name: '列表末尾的最近地点', distance: '5' }]));
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('浙江省杭州市西湖区测试路8号'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v3/geocode/regeo');
  assert.equal(requests[0].radius, '500');
  assert.equal(requests[0].extensions, 'all');
  assert.equal(requests[0].output, 'JSON');
  assert.equal(requests[0].hasKey, true);
  const [lng, lat] = requests[0].location.split(',').map(Number);
  assert.ok(lng > 120.15 && lng < 120.16, 'AMap receives converted GCJ-02 longitude');
  assert.ok(lat < 30.25 && lat > 30.24, 'AMap receives converted GCJ-02 latitude');
  const text = await watermark(page);
  assert.match(text, /地图估算：浙江省杭州市西湖区测试路8号/);
  assert.ok(text.includes(`附近：${injected}`));
  assert.match(text, /估计误差±12米/);
  assert.doesNotMatch(text, /WGS84|120\.15|30\.25/);
  await page.click('#btn-settings');
  assert.deepEqual(await page.locator('.poi-name').allTextContents(), [injected, '远处的书店', '距离缺失的地点', '空距离地点', '空白距离地点', '布尔距离地点', '数组距离地点']);
  assert.deepEqual(await page.locator('.poi-distance').allTextContents(), ['25米', '200米', '距离未知', '距离未知', '距离未知', '距离未知', '距离未知']);
  assert.equal(await page.locator('#poi-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.nearbyInjected), undefined);
  await page.click('[data-close-panel="watermark-panel"]');
  await refresh(page);
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('附近：列表末尾的最近地点'));
  await page.click('#btn-settings');
  assert.equal(await page.locator('.poi-name').count(), 20, 'limit is applied after selecting the nearest results');
  assert.equal(await page.locator('.poi-name').first().textContent(), '列表末尾的最近地点');
});

test('a selected nearby place appears in the photograph while original device coordinates remain in metadata', async t => {
  const { page } = await setup(t, () => addressResponse('浙江省杭州市西湖区测试路8号', [
    { name: '最近的公园', distance: '15' }, { name: '选定的停车场', distance: '80' },
  ]));
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('附近：最近的公园'));
  await page.click('#btn-settings');
  await page.getByRole('button', { name: /^选定的停车场\s*80米$/ }).click();
  assert.equal(await page.getByRole('button', { name: '手选附近地点', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.match(await watermark(page), /选定地点（未核验）：选定的停车场/);
  await page.click('[data-close-panel="watermark-panel"]');
  await page.click('[data-mode="photo"]');
  await page.evaluate(() => {
    window.capturedText = [];
    const drawText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.capturedText.push(String(text));
      return drawText.call(this, text, ...args);
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  const result = await page.evaluate(async () => {
    const [item] = await MediaStore.list();
    const record = await MediaStore.get(item.id);
    return { location: record.evidence.locationAtStart, text: window.capturedText.join('\n') };
  });
  assert.match(result.text, /选定的停车场/);
  assert.doesNotMatch(result.text, /WGS84|120\.15|30\.25/);
  assert.equal(result.location.lat, 30.25);
  assert.equal(result.location.lng, 120.15);
  assert.equal(result.location.coordinateSystem, 'WGS84');
  assert.equal(result.location.selectedPlace, '选定的停车场');
  assert.equal(result.location.address, '浙江省杭州市西湖区测试路8号');
  assert.deepEqual(result.location.nearbyPlace, { name: '最近的公园', distanceMeters: 15, source: 'map-nearby' });
  assert.equal(result.location.authenticated, false);
});

test('map errors and the address timeout clear the old address while camera capture stays usable', async t => {
  const { page } = await setup(t, call => call === 1 ? addressResponse('原来的中文地址', [{ name: '原地点', distance: '10' }]) : { status: '0' });
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('原来的中文地址'));
  await refresh(page);
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('中文地址暂不可用'));
  assert.doesNotMatch(await watermark(page), /原来的中文地址|原地点|WGS84|120\.15/);
  assert.equal(await page.locator('#poi-section').isVisible(), false);
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (new URL(url).origin !== 'https://restapi.amap.com') return nativeFetch(url, options);
      window.waitingAddress = true;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    };
  });
  await refresh(page);
  await page.waitForFunction(() => window.waitingAddress);
  assert.match(await watermark(page), /正在查询中文地址/);
  await cameraReady(page);
  await page.click('[data-mode="photo"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show img');
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('中文地址暂不可用'), null, { timeout: 8000 });
  assert.doesNotMatch(await watermark(page), /原来的中文地址|原地点|WGS84/);
});

test('a late address response cannot replace a newer position even if the provider ignores cancellation', async t => {
  const { page } = await setup(t, () => addressResponse('初始地址'));
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('初始地址'));
  await page.evaluate(() => {
    window.pendingAddresses = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (new URL(url).origin !== 'https://restapi.amap.com') return nativeFetch(url, options);
      return new Promise(resolve => window.pendingAddresses.push(address => resolve(new Response(JSON.stringify({ status: '1', regeocode: { formatted_address: address } }), { headers: { 'Content-Type': 'application/json' } }))));
    };
  });
  await refresh(page);
  await page.waitForFunction(() => window.pendingAddresses.length === 1);
  await page.evaluate(() => { window.testPosition.latitude = 30.3; window.testPosition.longitude = 120.2; });
  await refresh(page);
  await page.waitForFunction(() => window.pendingAddresses.length === 2);
  await page.evaluate(() => window.pendingAddresses[1]('新的中文地址'));
  await page.waitForFunction(() => document.querySelector('#wm-location-tl').textContent.includes('新的中文地址'));
  await page.evaluate(() => window.pendingAddresses[0]('迟到的旧地址'));
  assert.match(await watermark(page), /新的中文地址/);
  assert.doesNotMatch(await watermark(page), /初始地址|迟到的旧地址|WGS84/);
  await cameraReady(page);
});
