const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

let browser, server, origin;
const root = path.resolve(__dirname, '..');
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
      const body = await fs.readFile(file);
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function recordingPage(t, init) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => error({ code: 1 });
    const nativeStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function(...args) {
      const state = { chunks: 0 };
      window.nativeRecordingState = state;
      this.addEventListener('dataavailable', event => {
        if (event.data.size) state.chunks++;
      });
      return nativeStart.apply(this, args);
    };
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught recording errors'));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden') &&
    document.querySelector('#camera-preview').readyState >= 2);
  await page.click('[data-mode="video"]');
  return page;
}

// Stopping before the native encoder has produced a frame may yield a valid empty
// result. Tests expecting a saved clip wait for data, not a guessed delay.
async function encodedClip(page) {
  await page.waitForFunction(() => window.nativeRecordingState?.chunks > 0);
}

test('unsupported codec construction and start fall back to browser defaults without stale callbacks', async t => {
  const page = await recordingPage(t, () => {
    window.codecAttempts = [];
    window.codecRecorders = [];
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type.startsWith('video/mp4'); }
      constructor(stream, options) {
        window.codecAttempts.push(options.mimeType || 'default');
        if (options.mimeType?.includes('codecs=')) throw new DOMException('Codec unavailable', 'NotSupportedError');
        this.stream = stream;
        this.mimeType = options.mimeType || 'video/webm';
        this.state = 'inactive';
        window.codecRecorders.push(this);
      }
      start() {
        this.state = 'recording';
        if (this.mimeType === 'video/mp4') {
          window.failedCodecCallbacks = { data: this.ondataavailable, stop: this.onstop, error: this.onerror };
          throw new TypeError('Codec rejected at startup');
        }
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['complete clip'], { type: this.mimeType }) });
        this.onstop?.();
      }
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  assert.deepEqual(await page.evaluate(() => window.codecAttempts), [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'default',
  ]);
  assert.equal(await page.evaluate(() => window.codecRecorders[1].stream.getTracks().every(track => track.readyState === 'live')), true);
  await page.evaluate(() => {
    window.failedCodecCallbacks.data({ data: new Blob(['stale clip'], { type: 'video/mp4' }) });
    window.failedCodecCallbacks.stop();
    window.failedCodecCallbacks.error();
  });
  assert.equal(await page.locator('#shutter-btn').evaluate(button => button.classList.contains('recording')), true);
  assert.equal(await page.locator('#preview-modal').evaluate(modal => modal.classList.contains('show')), false);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  assert.equal(await page.evaluate(() => window.codecRecorders[1].stream.getTracks().every(track => track.readyState === 'ended')), true);
  const stored = await page.evaluate(async () => {
    const items = await MediaStore.list();
    const record = await MediaStore.get(items[0].id);
    return { type: record.blob.type, text: await record.blob.text() };
  });
  assert.deepEqual(stored, { type: 'video/webm', text: 'complete clip' });
});

test('failure of every recording format releases the microphone and allows a later retry', async t => {
  const page = await recordingPage(t, () => {
    const NativeRecorder = window.MediaRecorder;
    window.rejectFormats = true;
    window.recordingAudioTracks = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const media = await getMedia(constraints);
      window.recordingAudioTracks.push(...media.getAudioTracks());
      return media;
    };
    window.MediaRecorder = class {
      static isTypeSupported(type) { return NativeRecorder.isTypeSupported(type); }
      constructor(stream, options) {
        if (window.rejectFormats) throw new DOMException('Unavailable', 'NotSupportedError');
        return new NativeRecorder(stream, options);
      }
    };
  });
  await page.click('#shutter-btn');
  await page.waitForFunction(() => window.recordingAudioTracks.length > 0 &&
    window.recordingAudioTracks.every(track => track.readyState === 'ended'));
  assert.equal(await page.locator('#shutter-btn').evaluate(button => button.classList.contains('recording')), false);
  assert.match(await page.locator('#toast').textContent(), /录像启动失败/);
  await page.evaluate(() => { window.rejectFormats = false; });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await encodedClip(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
});

test('silent capture remains labelled and microphone interruptions stay visible through recording', async t => {
  const page = await recordingPage(t, () => {
    window.denyRecordingMic = true;
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.audio && window.denyRecordingMic) throw new DOMException('Denied', 'NotAllowedError');
      const media = await getMedia(constraints);
      if (constraints.audio) window.recordingAudioTrack = media.getAudioTracks()[0];
      return media;
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  assert.equal(await page.locator('#recording-audio-status').textContent(), '无声');
  await encodedClip(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await page.click('#preview-close');
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.evaluate(() => { window.denyRecordingMic = false; });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  assert.equal(await page.locator('#recording-audio-status').textContent(), '麦克风开');
  await page.evaluate(() => {
    Object.defineProperty(window.recordingAudioTrack, 'muted', { configurable: true, value: true });
    window.recordingAudioTrack.dispatchEvent(new Event('mute'));
  });
  assert.equal(await page.locator('#recording-audio-status').textContent(), '音频中断');
  assert.equal(await page.locator('#shutter-btn').evaluate(button => button.classList.contains('recording')), true);
  await page.evaluate(() => {
    Object.defineProperty(window.recordingAudioTrack, 'muted', { configurable: true, value: false });
    window.recordingAudioTrack.dispatchEvent(new Event('unmute'));
  });
  assert.equal(await page.locator('#recording-audio-status').textContent(), '麦克风开');
  await encodedClip(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('期间声音曾中断'));
  assert.equal(await page.locator('#recording-audio-status').textContent(), '');
});

test('an empty native clip reports failure, releases tracks, and permits the next recording', async t => {
  const page = await recordingPage(t, () => {
    window.emptyClipRecorders = [];
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'video/mp4'; }
      constructor(stream, options) {
        this.stream = stream;
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        this.empty = window.emptyClipRecorders.length === 0;
        window.emptyClipRecorders.push(this);
      }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(this.empty ? [] : ['next clip'], { type: this.mimeType }) });
        this.onstop?.();
      }
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.click('#shutter-btn');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '录制未完成，请重试');
  assert.equal(await page.locator('#preview-modal').evaluate(modal => modal.classList.contains('show')), false);
  assert.equal(await page.evaluate(async () => (await MediaStore.list()).length), 0);
  assert.equal(await page.evaluate(() => window.emptyClipRecorders[0].stream.getTracks().every(track => track.readyState === 'ended')), true);
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  assert.equal(await page.evaluate(async () => {
    const records = await MediaStore.list();
    return records.length === 1 && await (await MediaStore.get(records[0].id)).blob.text() === 'next clip';
  }), true);
});

test('late wake locks are released and cannot attach to a newer recording', async t => {
  const page = await recordingPage(t, () => {
    window.pendingWakeLocks = [];
    window.fakeWakeLocks = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request(type) {
        if (type !== 'screen') throw new TypeError('Unexpected lock type');
        return new Promise(resolve => window.pendingWakeLocks.push(resolve));
      },
    } });
    window.resolveWakeLock = index => {
      const lock = { released: false, release() { this.released = true; return Promise.resolve(); } };
      window.fakeWakeLocks[index] = lock;
      window.pendingWakeLocks[index](lock);
    };
  });
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await encodedClip(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  await page.click('#preview-close');
  await page.waitForFunction(() => document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.evaluate(() => { window.resolveWakeLock(0); window.resolveWakeLock(1); });
  assert.equal(await page.evaluate(() => window.fakeWakeLocks[0].released), true);
  assert.equal(await page.evaluate(() => window.fakeWakeLocks[1].released), false);
  await encodedClip(page);
  await page.click('#shutter-btn');
  await page.waitForSelector('#preview-modal.show video');
  assert.equal(await page.evaluate(() => window.fakeWakeLocks[1].released), true);
});

test('a recorder that never finishes cannot block capture forever or corrupt the next recording', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => error({ code: 1 });
    window.recorders = [];
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'video/mp4'; }
      constructor(stream, options) {
        this.stream = stream;
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        window.recorders.push(this);
      }
      start() { this.state = 'recording'; }
      // Simulate a native encoder that accepts stop but never emits its final event.
      stop() { this.state = 'inactive'; }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.evaluate(() => {
    window.oldRecorderCallbacks = { data: window.recorders[0].ondataavailable, stop: window.recorders[0].onstop };
  });
  await page.click('#shutter-btn');
  // Recovery must release the microphone and generated video track even when
  // the browser encoder fails to send onstop (seen after native interruptions).
  await page.waitForFunction(() => window.recorders[0].stream.getTracks().every(track => track.readyState === 'ended'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden') &&
    document.querySelector('#camera-preview').readyState >= 2 &&
    document.querySelector('#camera-preview').srcObject?.getVideoTracks()[0]?.readyState === 'live');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  assert.equal(await page.evaluate(() => window.recorders.length), 2);
  // A late completion belongs to the abandoned session, never the current one.
  await page.evaluate(() => {
    window.oldRecorderCallbacks.data({ data: new Blob(['old recording'], { type: 'video/mp4' }) });
    window.oldRecorderCallbacks.stop();
  });
  assert.equal(await page.locator('#shutter-btn').evaluate(el => el.classList.contains('recording')), true);
  assert.equal(await page.locator('#preview-modal').evaluate(el => el.classList.contains('show')), false);
  assert.equal(await page.evaluate(() => window.recorders[1].stream.getTracks().every(track => track.readyState === 'live')), true);
  assert.deepEqual(errors, []);
});

test('a transient camera mute can recover; a persistent mute releases the camera and exposes retry', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => error({ code: 1 });
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.evaluate(() => {
    window.originalTrack = document.querySelector('#camera-preview').srcObject.getVideoTracks()[0];
    Object.defineProperty(window.originalTrack, 'muted', { configurable: true, value: true });
    window.originalTrack.dispatchEvent(new Event('mute'));
    Object.defineProperty(window.originalTrack, 'muted', { configurable: true, value: false });
    window.originalTrack.dispatchEvent(new Event('unmute'));
  });
  assert.equal(await page.evaluate(() => window.originalTrack.readyState), 'live');
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject.getVideoTracks()[0] === window.originalTrack), true);
  await page.evaluate(() => {
    Object.defineProperty(window.originalTrack, 'muted', { configurable: true, value: true });
    window.originalTrack.dispatchEvent(new Event('mute'));
  });
  await page.waitForSelector('#camera-retry:visible');
  assert.equal(await page.evaluate(() => window.originalTrack.readyState), 'ended');
  await page.click('#camera-retry');
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
});

test('recording stops at three minutes even when no periodic data event arrives', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => error({ code: 1 });
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'video/mp4'; }
      constructor(stream, options) {
        this.stream = stream;
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        window.durationRecorder = this;
      }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['final encoded data'], { type: 'video/mp4' }) });
        this.onstop?.();
      }
    };
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForSelector('#shutter-btn.recording');
  await page.clock.fastForward(3 * 60 * 1000);
  await page.waitForSelector('#preview-modal.show video');
  assert.equal(await page.evaluate(() => window.durationRecorder.state), 'inactive');
  assert.equal(await page.evaluate(() => window.durationRecorder.stream.getTracks().every(track => track.readyState === 'ended')), true);
});

test('an initial recording frame failure clears the timer and microphone without leaving the shutter busy', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'watchPosition', { configurable: true, value: undefined });
    navigator.geolocation.getCurrentPosition = (success, error) => error({ code: 1 });
    window.activeRecordingTimers = new Set();
    window.audioTracks = [];
    const interval = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const id = interval(callback, delay, ...args);
      if (window.inspectRecordingTimers) window.activeRecordingTimers.add(id);
      return id;
    };
    window.clearInterval = id => {
      window.activeRecordingTimers.delete(id);
      clear(id);
    };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await getMedia(options);
      window.audioTracks.push(...stream.getAudioTracks());
      return stream;
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    let videoDraws = 0;
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      if (source instanceof HTMLVideoElement && ++videoDraws === 2) {
        window.injectedFrameFailure = true;
        throw new DOMException('Interrupted video frame', 'InvalidStateError');
      }
      return draw.call(this, source, ...args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
  await page.evaluate(() => { window.inspectRecordingTimers = true; });
  await page.click('[data-mode="video"]');
  await page.click('#shutter-btn');
  await page.waitForFunction(() => window.injectedFrameFailure &&
    window.audioTracks.every(track => track.readyState === 'ended') &&
    !document.querySelector('#shutter-btn').classList.contains('recording'));
  assert.equal(await page.evaluate(() => window.activeRecordingTimers.size), 0);
  assert.equal(await page.locator('#recording-timer').evaluate(el => el.classList.contains('show')), false);
  assert.deepEqual(errors, []);
});
