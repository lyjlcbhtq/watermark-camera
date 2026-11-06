(function () {
  'use strict';

  const maxEdge = 240;
  const maxBytes = 128 * 1024;
  const timeoutMs = 5000;

  function validThumbnail(blob) {
    return blob instanceof Blob && blob.size > 0 && blob.size <= maxBytes && blob.type === 'image/jpeg';
  }

  function snapshot(source, width, height, signal) {
    if (signal?.aborted || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return Promise.resolve(null);
    }
    // Copy synchronously before the caller clears or reuses the recording canvas.
    // Only this small copy remains alive while JPEG encoding is asynchronous.
    return new Promise(resolve => {
      let canvas = null;
      let settled = false;
      let timer;
      const finish = blob => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (canvas) canvas.width = canvas.height = 0;
        resolve(validThumbnail(blob) ? blob : null);
      };
      const abort = () => finish(null);
      try {
        canvas = document.createElement('canvas');
        const scale = Math.min(1, maxEdge / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) { finish(null); return; }
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(null), timeoutMs);
        if (signal?.aborted) { finish(null); return; }
        canvas.toBlob(finish, 'image/jpeg', 0.65);
      } catch (_) { finish(null); }
    });
  }

  function fromCanvas(canvas, { signal } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return Promise.resolve(null);
    return snapshot(canvas, canvas.width, canvas.height, signal);
  }

  function fromBlob(blob, { signal } = {}) {
    const empty = () => ({ thumbnail: null, durationSeconds: null });
    if (!(blob instanceof Blob) || !blob.size || signal?.aborted) return Promise.resolve(empty());
    return new Promise(resolve => {
      let video = null;
      let url = null;
      let settled = false;
      let encoding = false;
      let seekRequested = false;
      let awaitingSeek = false;
      let retriedBlackFrame = false;
      let durationSeconds = null;
      let timer;
      let playTimer;
      const encodingController = new AbortController();
      const listeners = [];
      const readDuration = () => {
        const duration = video?.duration;
        if (Number.isFinite(duration) && duration > 0 && duration <= 24 * 60 * 60) durationSeconds = duration;
      };
      const finish = thumbnail => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(playTimer);
        signal?.removeEventListener('abort', abort);
        encodingController.abort();
        if (video) {
          readDuration();
          listeners.forEach(([name, listener]) => video.removeEventListener(name, listener));
          try { video.pause(); } catch (_) { /* A failed decoder still needs cleanup. */ }
          video.removeAttribute('src');
          try { video.load(); } catch (_) { /* Already detached or unavailable. */ }
          video.remove();
        }
        if (url) URL.revokeObjectURL(url);
        resolve({ thumbnail: validThumbnail(thumbnail) ? thumbnail : null, durationSeconds });
      };
      const abort = () => finish(null);
      const blackFrame = () => {
        // Some encoders begin with a blank frame. Probe only a tiny copy and
        // allow one later frame, never a scan through the original recording.
        const probe = document.createElement('canvas');
        probe.width = probe.height = 16;
        try {
          const ctx = probe.getContext('2d', { willReadFrequently: true });
          if (!ctx) return false;
          ctx.drawImage(video, 0, 0, 16, 16);
          const pixels = ctx.getImageData(0, 0, 16, 16).data;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) return false;
          }
          return true;
        } catch (_) { return false; }
        finally { probe.width = probe.height = 0; }
      };
      const capture = () => {
        if (settled || encoding || awaitingSeek || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        readDuration();
        if (!retriedBlackFrame && blackFrame()) {
          retriedBlackFrame = true;
          const target = durationSeconds === null ? 0.2 : Math.min(0.5, durationSeconds * 0.7);
          if (target > video.currentTime + 0.01) {
            awaitingSeek = true;
            try { video.currentTime = target; return; }
            catch (_) { awaitingSeek = false; }
          }
        }
        encoding = true;
        clearTimeout(playTimer);
        snapshot(video, video.videoWidth, video.videoHeight, encodingController.signal).then(finish);
      };
      const metadata = () => {
        if (settled) return;
        readDuration();
        if (!seekRequested) {
          seekRequested = true;
          // Stay inside even a very short clip, and avoid a blank opening frame.
          const target = Math.min(0.1, durationSeconds === null ? 0.1 : durationSeconds / 2);
          awaitingSeek = true;
          try { video.currentTime = target; }
          catch (_) { awaitingSeek = false; }
        }
        capture();
      };
      try {
        video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
        video.playsInline = true;
        video.preload = 'auto';
        video.loop = false;
        video.controls = false;
        video.disablePictureInPicture = true;
        video.disableRemotePlayback = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        video.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:0;opacity:0;pointer-events:none';
        const listen = (name, listener) => { video.addEventListener(name, listener); listeners.push([name, listener]); };
        listen('loadedmetadata', metadata);
        listen('durationchange', readDuration);
        listen('loadeddata', capture);
        listen('seeked', () => { awaitingSeek = false; capture(); });
        listen('error', () => finish(null));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(null), timeoutMs);
        // Most browsers can seek a local Blob without playback. Some mobile
        // decoders need a muted play attempt to deliver a frame; denial is harmless.
        playTimer = setTimeout(() => {
          if (settled || encoding) return;
          try { Promise.resolve(video.play()).catch(() => {}); } catch (_) { /* Fall back to the bounded deadline. */ }
        }, 750);
        if (signal?.aborted) { finish(null); return; }
        document.body?.appendChild(video);
        url = URL.createObjectURL(blob);
        video.src = url;
        video.load();
      } catch (_) { finish(null); }
    });
  }

  window.VideoThumbnails = Object.freeze({ fromCanvas, fromBlob });
})();
