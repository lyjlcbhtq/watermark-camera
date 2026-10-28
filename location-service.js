(function (root) {
  'use strict';

  // Browser geolocation is an unverified device report, not proof of presence.
  // A short acquisition window improves a fix without keeping GPS active forever.
  function create(options = {}) {
    const geolocation = options.geolocation === undefined
      ? (options.navigator || root.navigator)?.geolocation : options.geolocation;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    const windowMs = options.windowMs ?? 12000;
    const freshMs = options.freshMs ?? 30000;
    const targetAccuracy = options.targetAccuracy ?? 30;
    if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 30000 ||
        !Number.isFinite(freshMs) || freshMs <= 0 ||
        !Number.isFinite(targetAccuracy) || targetAccuracy < 0) {
      throw new RangeError('无效的定位采样配置');
    }

    let requestId = 0;
    let active = null;
    let state = empty('idle');

    function empty(status, error = null) {
      return {
        requestId, status, pending: status === 'acquiring',
        lat: null, lng: null, accuracy: null, timestamp: null, receivedAt: null,
        source: 'browser-geolocation', coordinateSystem: 'WGS84',
        completionReason: null, error,
      };
    }

    function fresh(fix, time = now()) {
      return fix && Number.isFinite(fix.timestamp) &&
        fix.timestamp <= time + 5000 && time - fix.timestamp <= freshMs &&
        time >= fix.receivedAt - 5000;
    }

    function getSnapshot() {
      const time = now();
      return {
        ...state,
        error: state.error ? { ...state.error } : null,
        stale: state.lat === null || !fresh(state, time),
        ageMs: state.timestamp === null ? null : Math.max(0, time - state.timestamp),
      };
    }

    function emit() {
      // UI callbacks must not prevent releasing a hardware watch or its deadline.
      try { onUpdate(getSnapshot()); } catch (_) { /* Observer owns its errors. */ }
    }

    function release(run) {
      if (run.timer !== null) { cancel(run.timer); run.timer = null; }
      if (run.watchId !== null) {
        try { geolocation?.clearWatch?.(run.watchId); } catch (_) { /* Already gone. */ }
        run.watchId = null;
      }
    }

    function finish(run, status, reason, error = null, notify = true) {
      if (active !== run || run.done) return;
      run.done = true;
      release(run);
      active = null;
      if (status === 'ready' && fresh(run.best)) {
        state = { ...empty('ready'), ...run.best, completionReason: reason };
      } else {
        state = empty(status === 'ready' ? 'error' : status, error ||
          (status === 'ready' ? { code: 'stale-position', message: '定位已过期，请重新定位' } : null));
        state.completionReason = reason;
      }
      const result = getSnapshot();
      if (notify) emit();
      run.resolve(result);
    }

    function stop() {
      if (active) finish(active, 'stopped', 'cancelled');
      else {
        state = empty('stopped');
        state.completionReason = 'cancelled';
        emit();
      }
    }

    function decode(position) {
      const coords = position?.coords;
      const time = now();
      if (!Number.isFinite(coords?.latitude) || Math.abs(coords.latitude) > 90 ||
          !Number.isFinite(coords?.longitude) || Math.abs(coords.longitude) > 180 ||
          !Number.isFinite(position.timestamp) || position.timestamp < 0 ||
          position.timestamp > time + 5000) return null;
      const fix = {
        lat: coords.latitude, lng: coords.longitude,
        accuracy: Number.isFinite(coords.accuracy) && coords.accuracy >= 0 ? coords.accuracy : null,
        timestamp: position.timestamp, receivedAt: time,
      };
      return fresh(fix, time) ? fix : null;
    }

    function better(candidate, best) {
      if (!best || !fresh(best)) return true;
      if (candidate.accuracy === null && best.accuracy !== null) return false;
      if (candidate.accuracy !== null && best.accuracy === null) return true;
      if (candidate.accuracy !== best.accuracy) return candidate.accuracy < best.accuracy;
      return candidate.timestamp >= best.timestamp;
    }

    function start({ precise = true } = {}) {
      if (active) finish(active, 'stopped', 'superseded', null, false);
      requestId++;
      state = empty('acquiring');
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const run = { requestId, resolve, best: null, lastError: null, timer: null, watchId: null, done: false };
      active = run;
      emit();
      if (active !== run) return promise;
      if (!geolocation || typeof geolocation.getCurrentPosition !== 'function' && typeof geolocation.watchPosition !== 'function') {
        finish(run, 'error', 'unavailable', { code: 'unsupported', message: '浏览器不支持定位' });
        return promise;
      }
      const watching = typeof geolocation.watchPosition === 'function';
      const success = position => {
        if (active !== run || run.done) return;
        const candidate = decode(position);
        if (!candidate) {
          run.lastError = { code: 'invalid-position', message: '未收到有效的新鲜定位，请重试' };
          if (!watching) finish(run, 'error', 'invalid-position', run.lastError);
          return;
        }
        if (better(candidate, run.best)) {
          run.best = candidate;
          state = { ...empty('acquiring'), ...candidate };
          emit();
        }
        if (active !== run || run.done) return;
        if (!watching || !precise || run.best?.accuracy !== null && run.best?.accuracy <= targetAccuracy) {
          finish(run, 'ready', !watching ? 'one-shot' : precise ? 'precision-reached' : 'first-fix');
        }
      };
      const failure = error => {
        if (active !== run || run.done) return;
        const code = error?.code;
        run.lastError = code === 1
          ? { code: 'permission-denied', message: '定位被拒绝，请在系统设置中允许精确位置' }
          : code === 3
            ? { code: 'timeout', message: '定位超时，请到开阔处重试' }
            : { code: 'unavailable', message: '定位暂不可用，请重试' };
        if (code === 1 || !watching) finish(run, 'error', run.lastError.code, run.lastError);
        // A watch can recover from a transient error within the bounded window.
      };
      run.timer = schedule(() => {
        if (active !== run || run.done) return;
        if (run.best) finish(run, 'ready', 'window-ended');
        else finish(run, 'error', 'window-ended', run.lastError || { code: 'timeout', message: '定位超时，请到开阔处重试' });
      }, windowMs);
      const constraints = { enableHighAccuracy: Boolean(precise), maximumAge: 0, timeout: windowMs };
      try {
        if (watching) {
          run.watchId = geolocation.watchPosition(success, failure, constraints);
          // Test doubles and some wrappers can invoke callbacks synchronously.
          if (run.done || active !== run) release(run);
        } else geolocation.getCurrentPosition(success, failure, constraints);
      } catch (_) {
        finish(run, 'error', 'unavailable', { code: 'unavailable', message: '定位暂不可用，请重试' });
      }
      return promise;
    }

    return Object.freeze({ start, stop, getSnapshot });
  }

  root.LocationService = Object.freeze({ create });
})(typeof window === 'undefined' ? globalThis : window);
