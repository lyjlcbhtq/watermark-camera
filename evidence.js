(function () {
  'use strict';

  const scriptBase = new URL('./', document.currentScript?.src || location.href);
  const schema = 'watermark-camera-local-record';
  const schemaVersion = 1;
  const limitation = '本机记录未经过第三方认证。文件与记录匹配只能说明两者一致，不能证明拍摄时间、地点、来源真实，也不能证明记录未被重写。';
  const maxManifestBytes = 256 * 1024;

  function fail(message, name = 'DataError') {
    return new DOMException(message, name);
  }

  function hashBlob(blob, { onProgress, signal, timeoutMs = 120000 } = {}) {
    if (!(blob instanceof Blob)) return Promise.reject(new TypeError('请选择媒体文件'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new TypeError('无效的校验超时设置'));
    if (signal?.aborted) return Promise.reject(fail('校验已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let settled = false;
      const abort = () => finish(fail('校验已取消', 'AbortError'));
      const progress = loaded => {
        if (settled) return;
        try { onProgress?.({ loaded, total: blob.size, progress: blob.size ? loaded / blob.size : 1 }); }
        catch (_) { /* A display callback must not discard an otherwise valid file hash. */ }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
        }
        error ? reject(error) : resolve(result);
      };
      try {
        worker = new Worker(new URL('evidence-worker.js', scriptBase), { type: 'module' });
        worker.onmessage = ({ data }) => {
          if (data?.kind === 'progress') {
            if (Number.isFinite(data.loaded) && data.loaded >= 0 && data.loaded <= blob.size) progress(data.loaded);
          } else if (data?.kind === 'complete') {
            if (!/^[a-f0-9]{64}$/.test(data.sha256) || data.size !== blob.size) {
              finish(fail('校验返回的数据无效'));
              return;
            }
            progress(blob.size);
            finish(null, data.sha256);
          } else if (data?.kind === 'error') finish(fail('文件校验计算失败，请重试'));
        };
        worker.onerror = event => {
          event.preventDefault();
          finish(fail('校验组件无法加载，请联网打开一次后重试', 'NotSupportedError'));
        };
        worker.onmessageerror = () => finish(fail('无法读取校验结果'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(fail('校验超时，可重新选择文件后重试', 'TimeoutError')), timeoutMs);
        progress(0);
        if (signal?.aborted) { abort(); return; }
        worker.postMessage({ blob });
      } catch (_) { finish(fail('当前浏览器无法生成校验记录，请更新浏览器后重试', 'NotSupportedError')); }
    });
  }

  function jsonCopy(value) {
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch (_) { throw fail('拍摄记录无法序列化'); }
    if (typeof serialized !== 'string' || new Blob([serialized]).size > maxManifestBytes) {
      throw fail('拍摄记录为空或超出大小限制');
    }
    return JSON.parse(serialized);
  }

  async function createManifest(record, options = {}) {
    if (!record || !(record.blob instanceof Blob) || typeof record.id !== 'string' || !record.id ||
        !['photo', 'video'].includes(record.type) || !Number.isFinite(record.timestamp)) {
      throw new TypeError('无效的作品记录');
    }
    // Snapshot before awaiting hashing so subsequent UI changes cannot rewrite the capture context.
    const captureMetadata = jsonCopy(record.evidence ?? null);
    const file = { size: record.blob.size, mimeType: record.blob.type || 'application/octet-stream' };
    const media = { id: record.id, type: record.type, recordTimestampDeviceMs: record.timestamp };
    const digest = await hashBlob(record.blob, options);
    const manifest = {
      schema,
      schemaVersion,
      toolVersion: '1.5.0',
      generatedAtDeviceMs: Date.now(),
      media,
      file: { algorithm: 'SHA-256', sha256: digest, ...file },
      captureMetadata,
      attestation: {
        status: 'local-unattested',
        trustedTimestamp: null,
        thirdPartyReceipt: null,
        limitation,
      },
    };
    // Account for the complete exported document, not just its capture metadata.
    // Anything we export must fit the verifier's input limit as well.
    return jsonCopy(manifest);
  }

  function validateManifest(value) {
    const record = jsonCopy(value);
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema !== schema ||
        record.schemaVersion !== schemaVersion || record.file?.algorithm !== 'SHA-256' ||
        !/^[a-f0-9]{64}$/.test(record.file?.sha256) || !Number.isSafeInteger(record.file?.size) || record.file.size < 0) {
      throw fail('校验记录格式无效或版本不受支持');
    }
    // This verifier never promotes an arbitrary JSON assertion to trusted status.
    // Keep the supplied metadata visible for inspection, but do not trust attestation fields.
    return record;
  }

  async function verifyFile(blob, manifest, options = {}) {
    if (!(blob instanceof Blob)) throw new TypeError('请选择媒体文件');
    const record = validateManifest(manifest);
    if (blob.size !== record.file.size) return { matches: false, reason: 'size', authenticated: false, limitation };
    const digest = await hashBlob(blob, options);
    return { matches: digest === record.file.sha256, reason: digest === record.file.sha256 ? 'match' : 'sha256',
      sha256: digest, authenticated: false, limitation };
  }

  window.Evidence = Object.freeze({ createManifest, verifyFile, hashBlob, validateManifest, limitation, maxManifestBytes });
})();
