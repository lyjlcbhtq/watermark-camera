(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let controller = null;
  let generation = 0;

  function setStatus(message, state = '') {
    $('status').textContent = message;
    $('status').dataset.state = state;
  }

  $('cancel-button').addEventListener('click', () => controller?.abort());
  $('verify-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (controller) return;
    const media = $('media-file').files[0];
    const recordFile = $('record-file').files[0];
    if (!media || !recordFile) { setStatus('请选择媒体文件和对应的 JSON 校验记录。', 'error'); return; }
    if (recordFile.size > Evidence.maxManifestBytes) { setStatus('校验记录超过 256 KiB，无法读取。', 'error'); return; }
    const token = ++generation;
    const current = new AbortController();
    controller = current;
    $('file-fields').disabled = true;
    $('verify-button').disabled = true;
    $('cancel-button').hidden = false;
    $('verify-progress').hidden = false;
    $('verify-progress').value = 0;
    $('details').hidden = true;
    $('metadata').textContent = '';
    setStatus('正在读取校验记录…');
    try {
      let data;
      try { data = JSON.parse(await recordFile.text()); }
      catch (_) { throw new Error('文件不是有效的 JSON 校验记录。'); }
      const manifest = Evidence.validateManifest(data);
      if (current.signal.aborted) throw new DOMException('校验已取消', 'AbortError');
      $('metadata').textContent = JSON.stringify({ media: manifest.media ?? null, captureMetadata: manifest.captureMetadata ?? null,
        providedAttestation: manifest.attestation ?? null }, null, 2);
      $('details').hidden = false;
      setStatus('正在分块计算文件校验值…');
      const result = await Evidence.verifyFile(media, manifest, {
        signal: current.signal,
        onProgress: ({ progress }) => {
          if (token !== generation) return;
          $('verify-progress').value = progress;
          setStatus(`正在核对文件… ${Math.floor(progress * 100)}%`);
        },
      });
      if (token !== generation) return;
      setStatus(result.matches ? '文件与所选记录一致。时间、地点及来源仍未经认证。'
        : '文件与所选记录不一致。请检查是否选错文件，或文件/记录是否发生变化。', result.matches ? 'match' : 'mismatch');
    } catch (error) {
      if (token === generation) setStatus(error.name === 'AbortError' ? '已取消核对。' : (error.message || '无法核对，请重试。'), error.name === 'AbortError' ? '' : 'error');
    } finally {
      if (token === generation) {
        controller = null;
        $('file-fields').disabled = false;
        $('verify-button').disabled = false;
        $('cancel-button').hidden = true;
        $('verify-progress').hidden = true;
      }
    }
  });
  window.addEventListener('pagehide', () => controller?.abort());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
