const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../location-service.js'), 'utf8');

function setup(options = {}) {
  let time = 1750000000000;
  let nextTimer = 0;
  const timers = new Map();
  const watches = [], cleared = [], updates = [];
  const geolocation = options.geolocation || {
    getCurrentPosition(success, failure, constraints) { watches.push({ success, failure, constraints }); },
    ...(options.oneShot ? {} : {
      watchPosition(success, failure, constraints) {
        const id = watches.length;
        watches.push({ success, failure, constraints });
        return id;
      },
      clearWatch(id) { cleared.push(id); },
    }),
  };
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  const service = sandbox.LocationService.create({
    geolocation,
    now: () => time,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    onUpdate(snapshot) { updates.push(snapshot); options.onUpdate?.(snapshot); },
    ...options.config,
  });
  function tick(amount) {
    const target = time + amount;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      time = next[1].at;
      next[1].fn();
    }
    time = target;
  }
  function fix(accuracy = 40, age = 0, extra = {}) {
    return { coords: { latitude: 30.25, longitude: 120.16, accuracy, ...extra }, timestamp: time - age };
  }
  return { service, watches, cleared, updates, tick, fix, timers, now: () => time, setTime: value => { time = value; } };
}

test('precision acquisition stops early on a fresh accurate fix and reports its source honestly', async () => {
  const h = setup();
  const done = h.service.start();
  assert.equal(h.service.getSnapshot().pending, true);
  assert.equal(h.watches[0].constraints.enableHighAccuracy, true);
  assert.equal(h.watches[0].constraints.maximumAge, 0);
  h.watches[0].success(h.fix(18));
  const result = await done;
  assert.equal(result.status, 'ready');
  assert.equal(result.accuracy, 18);
  assert.equal(result.source, 'browser-geolocation');
  assert.equal(result.coordinateSystem, 'WGS84');
  assert.equal(result.timestamp, h.now());
  assert.equal(result.receivedAt, h.now());
  assert.equal(result.stale, false);
  assert.equal(result.completionReason, 'precision-reached');
  assert.deepEqual(h.cleared, [0]);
  assert.equal(h.timers.size, 0);
});

test('bounded sampling keeps the best accuracy and never replaces it with a worse fix', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].success(h.fix(140));
  h.tick(1000); h.watches[0].success(h.fix(45, 0, { latitude: 30.26 }));
  h.tick(1000); h.watches[0].success(h.fix(90, 0, { latitude: 30.27 }));
  assert.equal(h.service.getSnapshot().lat, 30.26);
  h.tick(10000);
  const result = await done;
  assert.equal(result.status, 'ready');
  assert.equal(result.accuracy, 45);
  assert.equal(result.lat, 30.26);
  assert.equal(result.completionReason, 'window-ended');
  assert.equal(result.ageMs, 11000);
  assert.deepEqual(h.cleared, [0]);
});

test('stale, future-dated and invalid coordinates cannot become current positions', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].success(h.fix(3, 30001));
  h.watches[0].success(h.fix(3, -5001));
  h.watches[0].success(h.fix(3, 0, { latitude: 91 }));
  h.watches[0].success(h.fix(3, 0, { longitude: -181 }));
  h.watches[0].success(h.fix(3, 0, { latitude: NaN }));
  h.watches[0].success({ coords: h.fix().coords });
  assert.equal(h.service.getSnapshot().lat, null);
  h.tick(12000);
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'invalid-position');
  assert.equal(result.stale, true);
  assert.equal(result.timestamp, null);
});

test('a fix that expires during sampling is cleared rather than completed as fresh', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].success(h.fix(50, 29000));
  h.tick(12000);
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'stale-position');
  assert.equal(result.lat, null);
});

test('missing or invalid accuracy is explicitly unknown and cannot trigger early completion', async () => {
  for (const accuracy of [undefined, -1, NaN, Infinity]) {
    const h = setup();
    const done = h.service.start();
    const position = h.fix();
    position.coords.accuracy = accuracy;
    h.watches[0].success(position);
    assert.equal(h.service.getSnapshot().accuracy, null);
    assert.equal(h.service.getSnapshot().pending, true);
    h.tick(12000);
    const result = await done;
    assert.equal(result.status, 'ready');
    assert.equal(result.accuracy, null);
    assert.equal(result.completionReason, 'window-ended');
  }
});

test('known accuracy takes precedence over an unknown estimate', async () => {
  const h = setup();
  const done = h.service.start();
  const unknown = h.fix(); delete unknown.coords.accuracy;
  h.watches[0].success(unknown);
  h.watches[0].success(h.fix(65));
  h.watches[0].success(unknown);
  h.tick(12000);
  assert.equal((await done).accuracy, 65);
});

test('stop clears the watch, cancels deadlines and discards every late callback', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].success(h.fix(55));
  h.service.stop();
  const stopped = await done;
  const count = h.updates.length;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.lat, null);
  h.watches[0].success(h.fix(1));
  h.watches[0].failure({ code: 1 });
  h.tick(20000);
  assert.equal(h.updates.length, count);
  assert.deepEqual(h.cleared, [0]);
  assert.equal(h.timers.size, 0);
});

test('a new request supersedes the old one without accepting its late result', async () => {
  const h = setup();
  const old = h.service.start();
  const current = h.service.start();
  assert.equal((await old).completionReason, 'superseded');
  assert.deepEqual(h.cleared, [0]);
  h.watches[0].success(h.fix(1, 0, { latitude: 12 }));
  assert.equal(h.service.getSnapshot().lat, null);
  h.watches[1].success(h.fix(8, 0, { latitude: 31 }));
  const result = await current;
  assert.equal(result.lat, 31);
  assert.equal(result.requestId, 2);
  assert.deepEqual(h.cleared, [0, 1]);
});

test('a silent provider is bounded by the deadline and allows a new attempt', async () => {
  const h = setup();
  const first = h.service.start();
  h.tick(12000);
  assert.equal((await first).error.code, 'timeout');
  assert.equal(h.service.getSnapshot().pending, false);
  const second = h.service.start();
  h.watches[1].success(h.fix(20));
  assert.equal((await second).status, 'ready');
  assert.deepEqual(h.cleared, [0, 1]);
});

test('permission denial clears any current candidate and does not preserve a previous request', async () => {
  const h = setup();
  const first = h.service.start();
  h.watches[0].success(h.fix(20)); await first;
  const second = h.service.start();
  assert.equal(h.service.getSnapshot().lat, null);
  h.watches[1].success(h.fix(50));
  h.watches[1].failure({ code: 1 });
  const result = await second;
  assert.equal(result.error.code, 'permission-denied');
  assert.equal(result.lat, null);
  assert.equal(result.accuracy, null);
  assert.deepEqual(h.cleared, [0, 1]);
});

test('temporary provider failure can recover while its deadline remains active', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].failure({ code: 2 });
  h.tick(3000);
  h.watches[0].success(h.fix(25));
  assert.equal((await done).status, 'ready');
});

test('one-shot fallback reports its actual quality and rejects old cache results', async () => {
  const h = setup({ oneShot: true });
  const first = h.service.start();
  h.watches[0].success(h.fix(120));
  const result = await first;
  assert.equal(result.accuracy, 120);
  assert.equal(result.completionReason, 'one-shot');
  assert.equal(h.timers.size, 0);
  const second = h.service.start();
  h.watches[1].success(h.fix(5, 60000));
  assert.equal((await second).status, 'error');
  assert.equal(h.service.getSnapshot().lat, null);
});

test('snapshots expire with age and clock rollback without mutating stored position data', async () => {
  const h = setup();
  const done = h.service.start();
  h.watches[0].success(h.fix(20));
  const result = await done;
  result.lat = 0;
  assert.equal(h.service.getSnapshot().lat, 30.25);
  h.tick(30001);
  assert.equal(h.service.getSnapshot().stale, true);
  h.setTime(result.receivedAt - 5001);
  assert.equal(h.service.getSnapshot().stale, true);
});

test('synchronous callbacks and a throwing observer still release the returned watch handle', async () => {
  const cleared = [];
  const timestamp = 1750000000000;
  const h = setup({
    onUpdate() { throw new Error('broken UI'); },
    geolocation: {
      watchPosition(success) {
        success({ coords: { latitude: 0, longitude: 0, accuracy: 0 }, timestamp });
        return 7;
      },
      clearWatch(id) { cleared.push(id); },
    },
  });
  assert.equal((await h.service.start()).status, 'ready');
  assert.deepEqual(cleared, [7]);
  assert.equal(h.timers.size, 0);
});

test('a provider that cannot start fails immediately instead of waiting for a nonexistent watch', async () => {
  const h = setup({ geolocation: { watchPosition() { throw new Error('provider gone'); } } });
  const result = await h.service.start();
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'unavailable');
  assert.equal(h.timers.size, 0);
});

test('quick acquisition reports first-fix completion without claiming precision was reached', async () => {
  const h = setup();
  const done = h.service.start({ precise: false });
  h.watches[0].success(h.fix(500));
  const result = await done;
  assert.equal(result.accuracy, 500);
  assert.equal(result.completionReason, 'first-fix');
  assert.equal(h.watches[0].constraints.enableHighAccuracy, false);
  assert.deepEqual(h.cleared, [0]);
});
