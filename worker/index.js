// Cloudflare Worker for SyncAnime (free plan friendly).
// Static files in ./public are served by Workers Static Assets (free, unlimited requests).
// This Worker only handles /api/* routes, which keeps it far below the free 100k requests/day.

const CATALOG_BASE = 'https://www.anikotoapi.site';
const CATALOG_TTL = 120; // seconds

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...extra },
  });
}

async function handleCatalog(request, url) {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const rest = url.pathname.slice('/api/catalog/'.length).replace(/^\/+/, '');
  // Only simple path segments; blocks "..", encoded tricks and absolute URLs.
  if (!rest || !/^[A-Za-z0-9._~\-\/]+$/.test(rest) || rest.split('/').includes('..')) {
    return json(400, { error: 'Bad catalog path' });
  }

  const target = CATALOG_BASE + '/' + rest + url.search;
  try {
    const upstream = await fetch(target, {
      headers: { Accept: 'application/json', Referer: CATALOG_BASE + '/' },
      // Cloudflare edge cache: cache successes only, never errors.
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': CATALOG_TTL, '300-599': 0 } },
    });
    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', upstream.ok ? 'public, max-age=' + CATALOG_TTL : 'no-cache');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return json(502, { error: 'Catalog upstream error' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json(200, { ok: true });

    if (url.pathname.startsWith('/api/catalog/')) return handleCatalog(request, url);

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
