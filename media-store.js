(function () {
  'use strict';

  // A Pages project and another app on the same origin must not share an album.
  // ./ and ./index.html (including query strings) resolve to the same directory.
  const scope = new URL('./', location.href).pathname;
  const databaseName = `watermark-camera-media:${scope}`;
  const deadlineMs = 5000;
  let database = null;
  let opening = null;

  function storageError(message, name = 'InvalidStateError') {
    return new DOMException(message, name);
  }

  function openDatabase() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const pending = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(storageError('打开作品存储超时', 'TimeoutError')), deadlineMs);
      try {
        if (!window.indexedDB) throw storageError('浏览器不支持作品存储', 'NotSupportedError');
        request = indexedDB.open(databaseName, 2);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (settled) { request.transaction.abort(); return; }
        const db = request.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        const metadata = db.objectStoreNames.contains('metadata')
          ? request.transaction.objectStore('metadata')
          : db.createObjectStore('metadata', { keyPath: 'id' });
        // Adding an index backfills existing metadata without copying media blobs.
        if (!metadata.indexNames.contains('byTimestampId')) {
          metadata.createIndex('byTimestampId', ['timestamp', 'id']);
        }
      };
      request.onerror = () => fail(request.error || storageError('无法打开作品存储'));
      request.onblocked = () => fail(storageError('作品存储正在被其他窗口使用'));
      request.onsuccess = () => {
        const db = request.result;
        // An open request cannot be cancelled. Close a connection arriving late.
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        database = db;
        db.onversionchange = () => {
          db.close();
          if (database === db) database = null;
        };
        db.onclose = () => { if (database === db) database = null; };
        resolve(db);
      };
    });
    opening = pending;
    const clearOpening = () => { if (opening === pending) opening = null; };
    pending.then(clearOpening, clearOpening);
    return pending;
  }

  async function transact(stores, mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let transactionError;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        const error = storageError('作品存储操作超时', 'TimeoutError');
        try { transaction?.abort(); } catch (_) { /* Already finished. */ }
        finish(error);
      }, deadlineMs);
      try {
        transaction = db.transaction(stores, mode);
        transaction.onerror = event => { transactionError = event.target.error || transaction.error; };
        transaction.onabort = () => finish(transaction.error || transactionError || storageError('作品存储操作已取消', 'AbortError'));
        // A successful individual request is not proof that the transaction committed.
        transaction.oncomplete = () => finish(null, result?.());
        result = operation(transaction);
      } catch (error) {
        try { transaction?.abort(); } catch (_) { /* Already finished. */ }
        finish(error);
      }
    });
  }

  async function put(record) {
    if (!record || typeof record.id !== 'string' || !record.id ||
        !['photo', 'video'].includes(record.type) || !Number.isFinite(record.timestamp) ||
        !(record.blob instanceof Blob) || (record.thumbnail != null && !(record.thumbnail instanceof Blob))) {
      throw new TypeError('无效的作品记录');
    }
    const metadata = {
      id: record.id,
      type: record.type,
      timestamp: record.timestamp,
      size: record.blob.size,
    };
    if (record.thumbnail != null) metadata.thumbnail = record.thumbnail;
    return transact(['media', 'metadata'], 'readwrite', transaction => {
      // Capture details belong with the original app-generated file, not album pages.
      const media = { id: record.id, blob: record.blob };
      if (record.evidence !== undefined) media.evidence = record.evidence;
      transaction.objectStore('media').put(media);
      transaction.objectStore('metadata').put(metadata);
      return () => metadata;
    });
  }

  async function list() {
    return transact(['metadata'], 'readonly', transaction => {
      const request = transaction.objectStore('metadata').getAll();
      return () => request.result.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    });
  }

  async function listPage({ before = null, limit = 30 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('每页作品数量必须在 1 到 100 之间');
    }
    if (before !== null && (typeof before !== 'object' ||
        !Number.isFinite(before.timestamp) || typeof before.id !== 'string' || !before.id)) {
      throw new TypeError('无效的相册分页位置');
    }
    return transact(['metadata'], 'readonly', transaction => {
      const metadata = transaction.objectStore('metadata');
      const range = before ? IDBKeyRange.upperBound([before.timestamp, before.id], true) : null;
      const request = metadata.index('byTimestampId').openKeyCursor(range, 'prev');
      const items = [];
      let count = 0;
      let lastKey = null;
      let hasMore = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        // Inspect one extra key without loading its thumbnail to detect the last page.
        if (count === limit) { hasMore = true; return; }
        const position = count++;
        lastKey = { timestamp: cursor.key[0], id: cursor.key[1] };
        const record = metadata.get(cursor.primaryKey);
        record.onsuccess = () => { items[position] = record.result; };
        cursor.continue();
      };
      return () => ({ items, nextCursor: hasMore ? lastKey : null });
    });
  }

  async function get(id) {
    return transact(['media', 'metadata'], 'readonly', transaction => {
      const metadata = transaction.objectStore('metadata').get(id);
      const media = transaction.objectStore('media').get(id);
      return () => metadata.result && media.result
        ? { ...metadata.result, blob: media.result.blob,
          ...(media.result.evidence === undefined ? {} : { evidence: media.result.evidence }) }
        : undefined;
    });
  }

  async function remove(id) {
    return transact(['media', 'metadata'], 'readwrite', transaction => {
      transaction.objectStore('media').delete(id);
      transaction.objectStore('metadata').delete(id);
    });
  }

  window.MediaStore = Object.freeze({ put, list, listPage, get, remove });
})();
