import { sha256 } from './vendor/noble-hashes/sha2.js';
import { bytesToHex } from './vendor/noble-hashes/utils.js';

// Each worker handles one file and is terminated by its owner after completion.
// Blob is structured-cloned without converting the complete video to an ArrayBuffer.
self.onmessage = async event => {
  let hash;
  try {
    const blob = event.data?.blob;
    if (!(blob instanceof Blob)) throw new TypeError('无效的媒体文件');
    const chunkSize = 2 * 1024 * 1024;
    hash = sha256.create();
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const end = Math.min(blob.size, offset + chunkSize);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      hash.update(chunk);
      self.postMessage({ kind: 'progress', loaded: end, total: blob.size });
    }
    const digest = bytesToHex(hash.digest());
    self.postMessage({ kind: 'complete', sha256: digest, size: blob.size });
  } catch (_) {
    self.postMessage({ kind: 'error', message: '文件校验计算失败，请重试' });
  } finally {
    hash?.destroy();
  }
};
