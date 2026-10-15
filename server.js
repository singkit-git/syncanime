'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

// Minimal .env loader (no dependency). Real env vars always win.
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (e) { /* no .env file, that's fine */ }
})();

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const UA = process.env.UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Secrets come from the environment only. No hardcoded fallbacks.
const SOURCE_ENC_KEY = process.env.SOURCE_ENC_KEY || '';
const SOURCE_ENC_IV = process.env.SOURCE_ENC_IV || '';
const CDN_TOKEN_SECRET = process.env.CDN_TOKEN_SECRET || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_REDIRECTS = 4;

// Allowlist of streaming hosts (SSRF protection)
const ALLOWED_HOSTS = new Set([
  'megaplay.buzz', 'nexabloom.top', 'broforgotsave.online',
  'stream.megaplay.buzz', 'cdn.megaplay.buzz',
]);
const STATIC_HOSTS = [
  /(^|\.)megaplay\.buzz$/i,
  /(^|\.)nexabloom\.top$/i,
  /(^|\.)broforgotsave\.online$/i,
];
const MAX_CACHE_ENTRIES = 500;
const dynamicHosts = new Map(); // hostname -> expiry timestamp
const HOST_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for API responses
const CACHE_TTL = 120 * 1000; // 2 minutes
const RESPONSE_CACHE = new Map();
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB max response body

// Rate limiting
const RATE_LIMIT = new Map(); // "bucket|ip" -> timestamps
const API_RATE_LIMIT_MAX = 120;
const API_RATE_LIMIT_WINDOW = 60 * 1000;
const DIRECT_RATE_LIMIT_MAX = 30;
const HLS_RATE_LIMIT_MAX = 600; // one stream needs a request every few seconds
const HLS_RATE_LIMIT_WINDOW = 60 * 1000;

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  if (dynamicHosts.has(host)) {
    if (dynamicHosts.get(host) > Date.now()) return true;
    dynamicHosts.delete(host);
    return false;
  }
  return STATIC_HOSTS.some((re) => re.test(host));
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [host, expiry] of dynamicHosts) {
    if (expiry < now) dynamicHosts.delete(host);
  }
  for (const [key, entry] of RESPONSE_CACHE) {
    if (now - entry.timestamp > CACHE_TTL) RESPONSE_CACHE.delete(key);
  }
  for (const [k, timestamps] of RATE_LIMIT) {
    const windowStart = now - 60 * 1000;
    while (timestamps.length && timestamps[0] < windowStart) timestamps.shift();
    if (timestamps.length === 0) RATE_LIMIT.delete(k);
  }
}, 60 * 1000);

function allowHost(hostname) {
  dynamicHosts.set(String(hostname || '').toLowerCase(), Date.now() + HOST_TTL);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function padKeyBytes(str, size) {
  const src = Buffer.from(String(str), 'utf8');
  const out = Buffer.alloc(size);
  src.copy(out, 0, 0, Math.min(size, src.length));
  return out;
}

function decryptSourcesEnc(enc) {
  let b64 = String(enc).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const decipher = crypto.createDecipheriv('aes-256-cbc', padKeyBytes(SOURCE_ENC_KEY, 32), padKeyBytes(SOURCE_ENC_IV, 16));
  const out = Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function extractCdnPathKey(fileUrl) {
  const m = String(fileUrl).match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i);
  return m ? m[1].toLowerCase() + '/' + m[2].toLowerCase() : null;
}

function createCdnToken(pathKey) {
  const ts = Math.floor(Date.now() / 1000) + 90;
  const payload = String(ts) + '|' + pathKey;
  const hmac = crypto.createHmac('sha256', CDN_TOKEN_SECRET).update(payload, 'utf8').digest();
  return b64url(Buffer.from(String(ts), 'utf8')) + '.' + b64url(hmac);
}

function attachCdnToken(fileUrl) {
  if (!fileUrl || /[?&]token=/.test(fileUrl)) return fileUrl;
  const key = extractCdnPathKey(fileUrl);
  if (!key) return fileUrl;
  const sep = fileUrl.includes('?') ? '&' : '?';
  return fileUrl + sep + 'token=' + encodeURIComponent(createCdnToken(key));
}

// Opens an upstream request and resolves with the raw response stream.
// Redirects are capped, and each hop must pass `validate(url)` if given.
function openUpstream(url, { headers = {}, method = 'GET', validate = null, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid upstream URL'));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error('Unsupported protocol: ' + parsed.protocol));
    }
    if (validate && !validate(parsed)) {
      return reject(new Error('Host not allowed: ' + parsed.hostname));
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(parsed, {
      method,
      headers: { 'User-Agent': UA, ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        let next;
        try { next = new URL(res.headers.location, parsed).toString(); } catch (e) { return reject(new Error('Bad redirect')); }
        resolve(openUpstream(next, { headers, method, validate, redirects: redirects + 1 }));
        return;
      }
      resolve({ res, req });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function fetchUpstream(url, opts = {}) {
  return openUpstream(url, opts).then(({ res, req }) => new Promise((resolve, reject) => {
    let totalSize = 0;
    const chunks = [];
    res.on('data', (c) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new Error('Upstream response too large (max ' + (MAX_BODY_SIZE / 1024 / 1024) + 'MB)'));
      }
      chunks.push(c);
    });
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks),
    }));
    res.on('error', reject);
  }));
}

// Cache-aware fetch
async function cachedFetch(key, url, options = {}) {
  const now = Date.now();
  const cached = RESPONSE_CACHE.get(key);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  const data = await fetchUpstream(url, options);
  if (data.status < 500) {
    if (RESPONSE_CACHE.size >= MAX_CACHE_ENTRIES) {
      RESPONSE_CACHE.delete(RESPONSE_CACHE.keys().next().value); // evict oldest
    }
    RESPONSE_CACHE.set(key, { data, timestamp: now });
  }
  return data;
}

// Rate limiting check
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}
function checkRateLimit(req, bucket, maxRequests, windowMs) {
  const key = bucket + '|' + clientIp(req);
  const now = Date.now();
  const windowStart = now - windowMs;
  if (!RATE_LIMIT.has(key)) {
    RATE_LIMIT.set(key, []);
  }
  const timestamps = RATE_LIMIT.get(key);
  while (timestamps.length && timestamps[0] < windowStart) timestamps.shift();
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  return true;
}

// Gzip compression helper
function sendCompressed(res, status, headers = {}, bodyBuffer) {
  const acceptEncoding = (headers['accept-encoding'] || '').toString();
  // Remove accept-encoding from outgoing headers (it's a request header, not response)
  const outHeaders = { ...headers };
  delete outHeaders['accept-encoding'];
  if (acceptEncoding.includes('gzip')) {
    zlib.gzip(bodyBuffer, (err, compressed) => {
      if (err) {
        res.writeHead(status, outHeaders);
        res.end(bodyBuffer);
        return;
      }
      res.writeHead(status, {
        ...outHeaders,
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
      });
      res.end(compressed);
    });
  } else if (acceptEncoding.includes('deflate')) {
    zlib.deflate(bodyBuffer, (err, compressed) => {
      if (err) {
        res.writeHead(status, outHeaders);
        res.end(bodyBuffer);
        return;
      }
      res.writeHead(status, {
        ...outHeaders,
        'Content-Encoding': 'deflate',
        'Content-Length': compressed.length,
      });
      res.end(compressed);
    });
  } else {
    res.writeHead(status, outHeaders);
    res.end(bodyBuffer);
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function rewriteM3u8(text, baseUrl) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        let abs;
        try { abs = new URL(uriMatch[1], baseUrl).toString(); } catch (e) { return line; }
        abs = attachCdnToken(abs);
        try { allowHost(new URL(abs).hostname); } catch (e) { /* ignore */ }
        return trimmed.replace(uriMatch[1], '/api/hls?url=' + encodeURIComponent(abs));
      }
      return line;
    }
    let abs;
    try { abs = new URL(trimmed, baseUrl).toString(); } catch (e) { return line; }
    abs = attachCdnToken(abs);
    try { allowHost(new URL(abs).hostname); } catch (e) { /* ignore */ }
    return '/api/hls?url=' + encodeURIComponent(abs);
  }).join('\n');
}

async function handleDirect(res, req, embedUrl) {
  // Check rate limit
  if (!checkRateLimit(req, 'direct', DIRECT_RATE_LIMIT_MAX, HLS_RATE_LIMIT_WINDOW)) {
    return json(res, 429, { error: 'Rate limit exceeded. Try again later.' });
  }

  let url;
  try {
    url = new URL(embedUrl);
  } catch (e) {
    return json(res, 400, { error: 'Invalid embed URL' });
  }
  if (!/(^|\.)megaplay\.buzz$/i.test(url.hostname)) {
    return json(res, 200, { url: null, reason: 'Unsupported embed host' });
  }
  url.search = '';
  if (!url.pathname.startsWith('/videojs/')) {
    url.pathname = '/videojs' + url.pathname;
  }

  let page;
  try {
    page = await fetchUpstream(url.toString(), {
      headers: { Referer: 'https://megaplay.buzz/', Accept: 'text/html' },
    });
  } catch (err) {
    return json(res, 502, { error: 'Failed to fetch embed page: ' + err.message });
  }
  const html = page.body.toString('utf8');
  const idMatch = html.match(/data-id="(\d+)"/);
  if (!idMatch) {
    return json(res, 200, { url: null, reason: 'Episode id not found on embed page' });
  }
  const episodeId = idMatch[1];
  const sourcesUrl = url.origin + '/videojs/stream/getSources?id=' + encodeURIComponent(episodeId);

  let sourcesRes;
  try {
    sourcesRes = await fetchUpstream(sourcesUrl, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: url.toString(),
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
  } catch (err) {
    return json(res, 502, { error: 'Failed to fetch sources: ' + err.message });
  }

  let data;
  try {
    data = JSON.parse(sourcesRes.body.toString('utf8'));
  } catch (e) {
    return json(res, 200, { url: null, reason: 'Sources response was not JSON' });
  }
  if (data.error) {
    return json(res, 200, { url: null, reason: String(data.error) });
  }

  let sources = data.sources;
  if (data.enc && !sources) {
    if (!SOURCE_ENC_KEY || !SOURCE_ENC_IV) {
      return json(res, 500, { error: 'Server is missing SOURCE_ENC_KEY / SOURCE_ENC_IV' });
    }
    try {
      sources = decryptSourcesEnc(data.enc);
    } catch (err) {
      return json(res, 500, { error: 'Decrypt failed: ' + err.message });
    }
  }
  const first = Array.isArray(sources) ? sources[0] : sources;
  const fileUrl = first && first.file ? first.file : typeof first === 'string' ? first : null;
  if (!fileUrl) {
    return json(res, 200, { url: null, reason: 'No media URL in sources' });
  }

  try {
    allowHost(new URL(fileUrl).hostname);
  } catch (e) {
    return json(res, 200, { url: null, reason: 'Invalid media URL in sources' });
  }
  for (const track of data.tracks || []) {
    if (track && track.file) {
      try { allowHost(new URL(track.file).hostname); } catch (e) { /* ignore */ }
    }
  }

  json(res, 200, {
    url: attachCdnToken(fileUrl),
    tracks: data.tracks || [],
    intro: data.intro || null,
    outro: data.outro || null,
  });
}

const CATALOG_BASE = 'https://www.anikotoapi.site';

async function handleCatalog(res, req, pathname) {
  // Check rate limit
  if (!checkRateLimit(req, 'catalog', API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW)) {
    return json(res, 429, { error: 'Rate limit exceeded. Try again later.' });
  }

  const rest = pathname.slice('/api/catalog/'.length);
  if (!rest || rest.startsWith('//')) return json(res, 400, { error: 'Bad catalog path' });
  const target = CATALOG_BASE + '/' + rest.replace(/^\/+/, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');

  try {
    const upstream = await cachedFetch('catalog:' + target, target, {
      headers: { Accept: 'application/json', Referer: CATALOG_BASE + '/' },
    });

    const ct = upstream.headers['content-type'] || 'application/json';
    const outHeaders = {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=120',
      'accept-encoding': req.headers['accept-encoding'],
    };
    sendCompressed(res, upstream.status, outHeaders, upstream.body);
  } catch (err) {
    return json(res, 502, { error: 'Catalog upstream error: ' + err.message });
  }
}

async function handleHls(res, req, targetUrl) {
  // Check rate limit
  if (!checkRateLimit(req, 'hls', HLS_RATE_LIMIT_MAX, HLS_RATE_LIMIT_WINDOW)) {
    return json(res, 429, { error: 'Rate limit exceeded. Try again later.' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return json(res, 400, { error: 'Invalid url' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json(res, 400, { error: 'Protocol not allowed' });
  }
  if (!hostAllowed(parsed.hostname)) {
    return json(res, 403, { error: 'Host not allowed: ' + parsed.hostname });
  }

  const headers = { Referer: 'https://megaplay.buzz/', 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await openUpstream(targetUrl, { headers, validate: (u) => hostAllowed(u.hostname) });
  } catch (err) {
    return json(res, 502, { error: 'Upstream error: ' + err.message });
  }
  const { res: up, req: upReq } = upstream;
  res.on('close', () => upReq.destroy()); // stop downloading if the viewer leaves

  const ct = up.headers['content-type'] || '';
  const isM3u8 = /mpegurl|x-m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(targetUrl);

  if (isM3u8) {
    // Playlists are small: buffer, rewrite, send.
    const chunks = [];
    let size = 0;
    up.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) up.destroy(); else chunks.push(c); });
    up.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Upstream error' }); });
    up.on('end', () => {
      if (res.headersSent) return;
      const text = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewriteM3u8(text, targetUrl));
    });
    return;
  }

  // Segments / subtitles: stream straight through, no memory buffering.
  const outHeaders = { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' };
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    if (up.headers[h]) outHeaders[h] = up.headers[h];
  }
  res.writeHead(up.statusCode, outHeaders);
  up.on('error', () => res.destroy());
  up.pipe(res);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Only these files are public. server.js, .env, package.json etc. are never served.
const PUBLIC_DIR = path.join(ROOT, 'public');
const PUBLIC_FILES = new Set([
  '/index.html', '/styles.css', '/app.js', '/sw.js', '/manifest.json',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
  '/apple-touch-icon.png', '/favicon-64.png',
]);
const NO_STORE_FILES = new Set(['/index.html', '/sw.js', '/manifest.json']);
const STATIC_CACHE = new Map(); // pathname -> { mtimeMs, etag, raw, gzip }

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (!PUBLIC_FILES.has(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, pathname);
  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let entry = STATIC_CACHE.get(pathname);
    const send = () => {
      const ext = path.extname(pathname).toLowerCase();
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'ETag': entry.etag,
        'Cache-Control': NO_STORE_FILES.has(pathname) ? 'no-cache' : 'public, max-age=86400',
        'Vary': 'Accept-Encoding',
      };
      if (req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304, headers); res.end(); return;
      }
      const wantsGzip = entry.gzip && String(req.headers['accept-encoding'] || '').includes('gzip');
      const body = wantsGzip ? entry.gzip : entry.raw;
      if (wantsGzip) headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(body);
    };
    if (entry && entry.mtimeMs === st.mtimeMs) return send();
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      const compressible = /\.(html|css|js|json|svg)$/.test(pathname);
      entry = {
        mtimeMs: st.mtimeMs,
        etag: '"' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 20) + '"',
        raw: data,
        gzip: compressible ? zlib.gzipSync(data, { level: 9 }) : null,
      };
      STATIC_CACHE.set(pathname, entry);
      send();
    });
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, uptime: process.uptime() });
    if (url.pathname === '/api/direct') {
      return await handleDirect(res, req, url.searchParams.get('url') || '');
    }
    if (url.pathname === '/api/hls') {
      return await handleHls(res, req, url.searchParams.get('url') || '');
    }
    if (url.pathname.startsWith('/api/catalog/')) {
      return await handleCatalog(res, req, url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'Not found' });
    }
    return serveStatic(req, res);
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  console.log('SyncAnime running at http://localhost:' + PORT);
  if (!SOURCE_ENC_KEY || !SOURCE_ENC_IV || !CDN_TOKEN_SECRET) {
    console.warn('Warning: SOURCE_ENC_KEY / SOURCE_ENC_IV / CDN_TOKEN_SECRET are not set (see .env.example).');
  }
});

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
