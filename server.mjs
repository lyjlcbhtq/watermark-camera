import http from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isIP } from 'node:net';

// Only public application assets belong here. Never expose the repository root.
export const PUBLIC_FILES = new Set([
  'index.html', 'sw.js', 'manifest.json', 'icon.svg', 'media-store.js',
  'location-service.js', 'evidence.js', 'evidence-worker.js', 'verify.html', 'verify.js',
  'vendor/noble-hashes/sha2.js', 'vendor/noble-hashes/_md.js', 'vendor/noble-hashes/_u64.js',
  'vendor/noble-hashes/utils.js', 'vendor/noble-hashes/LICENSE',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function acceptsGzip(header = '') {
  const values = new Map(header.toLowerCase().split(',').map(item => {
    const [name, ...parameters] = item.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return [name, quality ? Number(quality.trim().slice(2)) : 1];
  }));
  return (values.get('gzip') ?? values.get('*') ?? 0) > 0;
}

function basePath(value) {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value)) {
    throw new TypeError('CAMERA_BASE_PATH must be / or a path such as /watermark-camera/');
  }
  return value;
}

async function limitedJSON(response, maxBytes = 256 * 1024) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    throw new Error('Invalid upstream response');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createAppServer(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot);
  const prefix = basePath(options.basePath ?? process.env.CAMERA_BASE_PATH ?? '/');
  const apiKey = options.apiKey ?? process.env.AMAP_WEB_SERVICE_KEY ?? '';
  const requestUpstream = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const maxGlobalPerMinute = options.maxGlobalPerMinute ?? 120;
  const maxClients = options.maxClients ?? 2048;
  const maxCacheEntries = options.maxCacheEntries ?? 512;
  const cacheMs = options.cacheMs ?? 120000;
  const trustProxy = options.trustProxy ?? process.env.CAMERA_TRUST_PROXY === '1';
  const clients = new Map(), cache = new Map(), inflight = new Map(), assets = new Map();
  let globalWindow = { until: 0, count: 0 };
  let activeRequests = 0;

  function json(res, status, value, extraHeaders = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  }
  const failure = (res, status, code, message, headers) => json(res, status, { status: '0', code, message }, headers);

  function checkLimit(req) {
    const time = now();
    let client = req.socket.remoteAddress || 'unknown';
    const forwarded = req.headers['x-real-ip'];
    // The bundled reverse proxy overwrites X-Real-IP; never trust arbitrary public peers.
    if (trustProxy && loopback(client) && typeof forwarded === 'string' && isIP(forwarded)) client = forwarded;
    for (const [key, value] of clients) if (value.until <= time) clients.delete(key);
    if (globalWindow.until <= time) globalWindow = { until: time + 60000, count: 0 };
    if (globalWindow.count >= maxGlobalPerMinute) return false;
    if (!clients.has(client)) {
      if (clients.size >= maxClients) return false;
      clients.set(client, { until: time + 60000, count: 0 });
    }
    const entry = clients.get(client);
    if (entry.count >= maxPerMinute) return false;
    entry.count++; globalWindow.count++;
    return true;
  }

  async function geocode(coordinates) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    activeRequests++;
    try {
      const work = (async () => {
        const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
        url.search = new URLSearchParams({ output: 'JSON', location: coordinates, key: apiKey, radius: '100', extensions: 'all' }).toString();
        const response = await requestUpstream(url, { signal: controller.signal, redirect: 'error' });
        const data = await limitedJSON(response);
        if (data?.status !== '1' || !data.regeocode || typeof data.regeocode !== 'object' || Array.isArray(data.regeocode)) {
          throw new Error('Upstream service unavailable');
        }
        // Do not forward upstream debug fields, errors, request URLs or credentials.
        return { status: '1', regeocode: data.regeocode };
      })();
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      activeRequests--;
    }
  }

  async function handleGeocode(req, res, query) {
    if (req.method !== 'GET') return failure(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求', { Allow: 'GET' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return failure(res, 403, 'CROSS_SITE_REQUEST', '请从相机页面发起请求');
    const keys = [...query.keys()];
    const longitude = query.get('longitude'), latitude = query.get('latitude');
    const decimal = /^-?(?:\d+\.?\d*|\.\d+)$/;
    if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.every(key => ['longitude', 'latitude'].includes(key)) ||
        !decimal.test(longitude ?? '') || !decimal.test(latitude ?? '') ||
        Math.abs(Number(longitude)) > 180 || Math.abs(Number(latitude)) > 90) {
      return failure(res, 400, 'INVALID_COORDINATES', '经纬度参数无效');
    }
    if (!apiKey) return failure(res, 503, 'SERVICE_NOT_CONFIGURED', '地址服务尚未配置，仍可使用设备坐标');
    if (!checkLimit(req)) return failure(res, 429, 'RATE_LIMITED', '请求较多，请稍后重试', { 'Retry-After': '60' });
    const coordinates = `${Number(longitude).toFixed(6)},${Number(latitude).toFixed(6)}`;
    const time = now();
    for (const [key, value] of cache) if (value.until <= time) cache.delete(key);
    const cached = cache.get(coordinates);
    if (cached) return json(res, 200, cached.value);
    let task = inflight.get(coordinates);
    if (!task) {
      if (activeRequests >= maxConcurrent) return failure(res, 503, 'SERVICE_BUSY', '地址服务繁忙，请稍后重试', { 'Retry-After': '5' });
      task = geocode(coordinates).then(value => {
        if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(coordinates, { value, until: now() + cacheMs });
        return value;
      }).finally(() => inflight.delete(coordinates));
      inflight.set(coordinates, task);
    }
    try {
      json(res, 200, await task);
    } catch (error) {
      const timedOut = error.message === 'timeout' || error.name === 'AbortError';
      failure(res, timedOut ? 504 : 502, timedOut ? 'UPSTREAM_TIMEOUT' : 'GEOCODE_UNAVAILABLE', '地址查询暂不可用，仍可使用设备坐标');
    }
  }

  async function handleStatic(req, res, name) {
    if (!PUBLIC_FILES.has(name)) return failure(res, 404, 'NOT_FOUND', '页面不存在');
    if (!['GET', 'HEAD'].includes(req.method)) return failure(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 或 HEAD 请求', { Allow: 'GET, HEAD' });
    try {
      const file = path.join(root, name);
      const relative = path.relative(await realpath(root), await realpath(file));
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        return failure(res, 404, 'NOT_FOUND', '页面不存在');
      }
      const info = await lstat(file);
      if (!info.isFile()) return failure(res, 404, 'NOT_FOUND', '页面不存在');
      let entry = assets.get(name);
      if (!entry || entry.mtime !== info.mtimeMs || entry.size !== info.size) {
        const plain = await readFile(file);
        const compressed = plain.length > 1024 && /\.(?:html|js|json|svg)$/.test(name) ? gzipSync(plain) : null;
        const etag = body => `"${createHash('sha256').update(body).digest('hex')}"`;
        entry = { mtime: info.mtimeMs, size: info.size, plain, compressed, etag: etag(plain), gzipEtag: compressed && etag(compressed) };
        assets.set(name, entry);
      }
      const gzip = entry.compressed && acceptsGzip(req.headers['accept-encoding']);
      const body = gzip ? entry.compressed : entry.plain;
      const etag = gzip ? entry.gzipEtag : entry.etag;
      res.setHeader('Content-Type', MIME[path.extname(name)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', name === 'index.html' || name === 'sw.js' ? 'no-cache' : 'public, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);
      res.setHeader('Vary', 'Accept-Encoding');
      if (gzip) res.setHeader('Content-Encoding', 'gzip');
      if (name === 'sw.js') res.setHeader('Service-Worker-Allowed', prefix);
      const candidates = (req.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
      if (candidates.includes(etag) || candidates.includes('*')) { res.writeHead(304); res.end(); return; }
      res.setHeader('Content-Length', body.length);
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      failure(res, 404, 'NOT_FOUND', '页面不存在');
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'");
    try {
      const raw = req.url || '/';
      const pathname = decodeURIComponent(raw.split('?')[0]);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
        return failure(res, 400, 'INVALID_PATH', '请求路径无效');
      }
      if (prefix !== '/' && pathname === prefix.slice(0, -1)) {
        res.writeHead(308, { Location: prefix + (raw.includes('?') ? '?' + raw.split('?').slice(1).join('?') : ''), 'Cache-Control': 'no-cache' });
        res.end(); return;
      }
      if (!pathname.startsWith(prefix)) return failure(res, 404, 'NOT_FOUND', '页面不存在');
      const name = pathname.slice(prefix.length) || 'index.html';
      if (name === 'api/reverse-geocode') return await handleGeocode(req, res, new URL(raw, 'http://localhost').searchParams);
      return await handleStatic(req, res, name);
    } catch {
      if (!res.headersSent) failure(res, 400, 'BAD_REQUEST', '请求无效');
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.CAMERA_HOST ?? '127.0.0.1';
  const port = Number(process.env.CAMERA_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid CAMERA_PORT');
  const server = createAppServer();
  server.listen(port, host, () => console.log(`Watermark camera listening on ${host}:${port}${process.env.CAMERA_BASE_PATH ?? '/'}`));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
