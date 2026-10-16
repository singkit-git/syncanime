// Cloudflare Worker for SyncAnime (free plan friendly).
// Static files in ./public are served by Workers Static Assets (free, unlimited requests).
// This Worker only handles /api/* routes, which keeps it far below the free 100k requests/day.

const CATALOG_BASE = 'https://www.anikotoapi.site';
const CATALOG_TTL = 300; // seconds

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...extra },
  });
}

// Best-effort in-memory copy per Worker instance, used when the upstream rate-limits us.
const MEM = new Map(); // target -> { body, type, ts }
const MEM_MAX = 150;
const MEM_FRESH = CATALOG_TTL * 1000;
const MEM_STALE_OK = 6 * 60 * 60 * 1000; // serve stale copies up to 6h during upstream errors
const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCatalog(target, base) {
  return fetch(target, {
    headers: { Accept: 'application/json', Referer: base + '/', 'User-Agent': UPSTREAM_UA },
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': CATALOG_TTL, '300-599': 0 } },
  });
}

function fromMem(entry, stale) {
  return new Response(entry.body, {
    status: 200,
    headers: {
      'Content-Type': entry.type,
      'Cache-Control': stale ? 'no-cache' : 'public, max-age=' + CATALOG_TTL,
      'X-Catalog-Cache': stale ? 'stale' : 'hit',
    },
  });
}

async function handleCatalog(request, url, env) {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const rest = url.pathname.slice('/api/catalog/'.length).replace(/^\/+/, '');
  // Only simple path segments; blocks "..", encoded tricks and absolute URLs.
  if (!rest || !/^[A-Za-z0-9._~\-\/]+$/.test(rest) || rest.split('/').includes('..')) {
    return json(400, { error: 'Bad catalog path' });
  }

  const base = (env && env.CATALOG_BASE) || CATALOG_BASE;
  const target = base + '/' + rest + url.search;
  const now = Date.now();
  const mem = MEM.get(target);
  if (mem && now - mem.ts < MEM_FRESH) return fromMem(mem, false);

  try {
    let upstream = await fetchCatalog(target, base);

    // One polite retry on rate limit / transient errors.
    if (upstream.status === 429 || upstream.status >= 500) {
      const ra = Number(upstream.headers.get('Retry-After'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800, 2000));
      upstream = await fetchCatalog(target, base);
    }

    if (upstream.ok) {
      const body = await upstream.text();
      const type = upstream.headers.get('Content-Type') || 'application/json';
      if (MEM.size >= MEM_MAX) MEM.delete(MEM.keys().next().value);
      MEM.set(target, { body, type, ts: now });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=' + CATALOG_TTL, 'X-Catalog-Cache': 'miss' },
      });
    }

    // Upstream failed: prefer an older copy over showing an error.
    if (mem && now - mem.ts < MEM_STALE_OK) return fromMem(mem, true);

    const extra = { 'Cache-Control': 'no-cache' };
    const ra = upstream.headers.get('Retry-After');
    if (ra) extra['Retry-After'] = ra;
    return json(upstream.status, { error: 'Catalog upstream returned HTTP ' + upstream.status }, extra);
  } catch (err) {
    if (mem && now - mem.ts < MEM_STALE_OK) return fromMem(mem, true);
    return json(502, { error: 'Catalog upstream error' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json(200, { ok: true });

    if (url.pathname.startsWith('/api/catalog/')) return handleCatalog(request, url, env);

    // The frontend calls this first. On this deployment there is no stream resolver,
    // so answer "no direct stream" and the app plays the normal embed instead.
    if (url.pathname === '/api/direct') {
      return json(200, { url: null, reason: 'Direct playback is not available on this deployment' });
    }

    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });

    // Anything else that isn't a static file.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
