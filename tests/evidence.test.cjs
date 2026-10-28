const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'evidence.js'), 'utf8');
const digest = data => createHash('sha256').update(data).digest('hex');
const fixture = (body = Buffer.from('original recording')) => ({
  schema: 'watermark-camera-local-record', schemaVersion: 1,
  file: { algorithm: 'SHA-256', sha256: digest(body), size: body.length, mimeType: 'video/mp4' },
  media: { id: 'record-1', type: 'video' }, captureMetadata: null,
});

function fakeRuntime(postMessage, { failConstruction = false } = {}) {
  const workers = [];
  class Worker {
    constructor(url, options) {
      if (failConstruction) throw new Error('Workers unavailable');
      this.url = String(url); this.options = options; this.terminations = 0;
      workers.push(this);
    }
    postMessage(data) { postMessage?.(this, data); }
    terminate() { this.terminations++; }
  }
  const context = { window: {}, document: { currentScript: { src: 'https://example.test/app/evidence.js' } },
    location: { href: 'https://example.test/app/verify.html' },
    Worker, Blob, URL, DOMException, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return { api: context.window.Evidence, workers };
}

function emitDigest(worker, data) {
  queueMicrotask(async () => {
    const sha256 = digest(Buffer.from(await data.blob.arrayBuffer()));
    worker.onmessage?.({ data: { kind: 'complete', sha256, size: data.blob.size } });
  });
}

test('cancel, deadline and worker failures always terminate their worker and reject once', async t => {
  await t.test('cancellation before starting avoids constructing a worker', async () => {
    const { api, workers } = fakeRuntime();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.hashBlob(new Blob(['a']), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(workers.length, 0);
  });
  await t.test('cancellation during hashing clears worker handlers and ignores late replies', async () => {
    const { api, workers } = fakeRuntime();
    const controller = new AbortController();
    const result = api.hashBlob(new Blob(['a']), { signal: controller.signal });
    const staleReply = workers[0].onmessage;
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    staleReply({ data: { kind: 'complete', sha256: digest('a'), size: 1 } });
    assert.equal(workers[0].terminations, 1);
    assert.equal(workers[0].onmessage, null);
    assert.equal(workers[0].onerror, null);
  });
  await t.test('a stalled worker times out and is released', async () => {
    const { api, workers } = fakeRuntime();
    await assert.rejects(api.hashBlob(new Blob(['a']), { timeoutMs: 10 }), { name: 'TimeoutError' });
    assert.equal(workers[0].terminations, 1);
  });
  for (const [name, report, errorName] of [
    ['module load failure', w => w.onerror({ preventDefault() {} }), 'NotSupportedError'],
    ['message decode failure', w => w.onmessageerror(), 'DataError'],
    ['malformed result', w => w.onmessage({ data: { kind: 'complete', sha256: 'wrong', size: 1 } }), 'DataError'],
    ['reported hash failure', w => w.onmessage({ data: { kind: 'error' } }), 'DataError'],
  ]) {
    await t.test(name, async () => {
      const { api, workers } = fakeRuntime(w => queueMicrotask(() => report(w)));
      await assert.rejects(api.hashBlob(new Blob(['a'])), { name: errorName });
      assert.equal(workers[0].terminations, 1);
    });
  }
  await t.test('constructor failure rejects without a stuck promise', async () => {
    const { api } = fakeRuntime(null, { failConstruction: true });
    await assert.rejects(api.hashBlob(new Blob(['a'])), { name: 'NotSupportedError' });
  });
});

test('capture metadata is snapshotted before hashing and old records remain explicitly unattested', async () => {
  const { api, workers } = fakeRuntime(emitDigest);
  const metadata = { vehicle: 'test car', location: { accuracy: 18 } };
  const record = { id: '1', type: 'video', timestamp: 123, blob: new Blob(['original']), evidence: metadata };
  const pending = api.createManifest(record, { onProgress() { throw new Error('display failed'); } });
  metadata.location.accuracy = 999; metadata.vehicle = 'changed';
  const manifest = await pending;
  assert.equal(manifest.captureMetadata.vehicle, 'test car');
  assert.equal(manifest.captureMetadata.location.accuracy, 18);
  assert.equal(manifest.file.sha256, digest('original'));
  assert.equal(manifest.attestation.status, 'local-unattested');
  assert.equal(manifest.attestation.trustedTimestamp, null);
  assert.equal(manifest.attestation.thirdPartyReceipt, null);
  assert.match(manifest.attestation.limitation, /不能证明拍摄时间、地点、来源真实/);
  assert.equal(workers[0].url, 'https://example.test/app/evidence-worker.js');
  assert.equal(workers[0].terminations, 1);
  const legacy = await api.createManifest({ ...record, evidence: undefined });
  assert.equal(legacy.captureMetadata, null);
});

test('the whole exported manifest must fit the verifier limit, including its wrapper', async () => {
  const { api } = fakeRuntime(emitDigest);
  const record = { id: '1', type: 'video', timestamp: 123, blob: new Blob(['a']),
    evidence: { note: 'x'.repeat(api.maxManifestBytes - 20) } };
  await assert.rejects(api.createManifest(record), { name: 'DataError' });
  record.evidence.note = 'x'.repeat(api.maxManifestBytes - 4096);
  const exported = await api.createManifest(record);
  assert.equal(api.validateManifest(exported).file.sha256, digest('a'));
});

test('malformed records are rejected and altered files or metadata never gain authentication', async () => {
  const { api, workers } = fakeRuntime(emitDigest);
  const media = Buffer.from('original recording');
  for (const record of [null, [], {}, { ...fixture(media), schemaVersion: 99 },
    { ...fixture(media), file: { ...fixture(media).file, size: -1 } },
    { ...fixture(media), file: { ...fixture(media).file, sha256: 'not-a-hash' } },
    { ...fixture(media), file: { ...fixture(media).file, algorithm: 'MD5' } }]) {
    await assert.rejects(api.verifyFile(new Blob([media]), record), { name: 'DataError' });
  }
  assert.equal(workers.length, 0);
  const shorter = await api.verifyFile(new Blob(['short']), fixture(media));
  assert.equal(shorter.reason, 'size');
  assert.equal(workers.length, 0);
  const changed = Buffer.from(media); changed[0] ^= 1;
  const mismatch = await api.verifyFile(new Blob([changed]), fixture(media));
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.reason, 'sha256');
  const forged = { ...fixture(media), attestation: { status: 'official', authenticated: true },
    captureMetadata: { time: '1900-01-01', location: 'a claimed location' } };
  const matching = await api.verifyFile(new Blob([media]), forged);
  assert.equal(matching.matches, true);
  assert.equal(matching.authenticated, false);
  assert.match(matching.limitation, /记录未被重写/);
});

let server, browser, origin;
before(async () => {
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/watermark-camera/harness.html') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><meta charset="utf-8"><script src="./evidence.js"></script>');
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/watermark-camera\//, '');
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
      const body = await fsp.readFile(file);
      response.writeHead(200, { 'Content-Type': { '.js': 'application/javascript', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/watermark-camera/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function browserPage(t, verify = false) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.hashWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.terminations = 0; window.hashWorkers.push(this); }
      terminate() { this.terminations++; return super.terminate(); }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin + (verify ? 'verify.html' : 'harness.html'));
  return page;
}

test('real browser Worker SHA-256 matches Node crypto for empty, exact-chunk and multi-chunk files', async t => {
  const page = await browserPage(t);
  for (const size of [0, 2 * 1024 * 1024, 5 * 1024 * 1024 + 17]) {
    const expectedBytes = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) expectedBytes[i] = i % 251;
    const result = await page.evaluate(async size => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 251;
      const progress = [];
      const sha256 = await Evidence.hashBlob(new Blob([bytes]), { onProgress: value => progress.push(value.loaded) });
      return { sha256, progress, terminations: window.hashWorkers.at(-1).terminations };
    }, size);
    assert.equal(result.sha256, digest(expectedBytes));
    assert.equal(result.terminations, 1);
    assert.equal(result.progress.at(-1), size);
    for (let i = 1; i < result.progress.length; i++) {
      assert.ok(result.progress[i] >= result.progress[i - 1]);
      assert.ok(result.progress[i] - result.progress[i - 1] <= 2 * 1024 * 1024);
    }
  }
});

test('verify page rejects invalid JSON and displays matching user metadata as untrusted text without upload', async t => {
  const page = await browserPage(t, true);
  const network = [];
  page.on('request', request => network.push({ method: request.method(), url: request.url() }));
  const media = Buffer.from('original recording');
  await page.locator('#media-file').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: media });
  await page.locator('#record-file').setInputFiles({ name: 'record.json', mimeType: 'application/json', buffer: Buffer.from('{bad json') });
  await page.click('#verify-button');
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error');
  assert.match(await page.locator('#status').textContent(), /不是有效的 JSON/);
  assert.equal(await page.locator('#verify-button').isEnabled(), true);
  const malicious = '<img src=x onerror="window.metadataExecuted=true">';
  const record = { ...fixture(media), captureMetadata: { vehicle: malicious }, attestation: { status: 'official', authenticated: true } };
  await page.locator('#record-file').setInputFiles({ name: 'record.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(record)) });
  await page.click('#verify-button');
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'match');
  assert.match(await page.locator('#status').textContent(), /时间、地点及来源仍未经认证/);
  assert.equal(JSON.parse(await page.locator('#metadata').textContent()).captureMetadata.vehicle, malicious);
  assert.equal(await page.locator('#metadata img').count(), 0);
  assert.equal(await page.evaluate(() => window.metadataExecuted), undefined);
  assert.equal(await page.locator('#cancel-button').isVisible(), false);
  assert.equal(await page.locator('#verify-progress').isVisible(), false);
  assert.ok(network.every(request => request.method === 'GET' && request.url.startsWith(origin)), 'no media or location upload');
  const changed = Buffer.from(media); changed[0] ^= 1;
  await page.locator('#media-file').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: changed });
  await page.click('#verify-button');
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'mismatch');
  assert.match(await page.locator('#status').textContent(), /不一致/);
});
