// Cloudflare Worker for SyncAnime (free plan friendly).
// Static files in ./public are served by Workers Static Assets (free, unlimited requests).
// This Worker only handles /api/* routes, which keeps it far below the free 100k requests/day.

const CATALOG_BASE = 'https://www.anikotoapi.site';
const CATALOG_TTL = 300; // seconds

// Rate limit per visitor (Workers Rate Limiting binding, see wrangler.jsonc). Fails open: if the
// binding is missing or errors, requests are allowed so the site never breaks because of it.
async function rateLimited(request, env, bucket) {
  if (!env || !env.API_LIMITER) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await env.API_LIMITER.limit({ key: bucket + ':' + ip });
    return !success;
  } catch (e) {
    return false;
  }
}

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
  if (await rateLimited(request, env, 'catalog')) {
    return json(429, { error: 'Too many requests. Please slow down.' }, { 'Retry-After': '30' });
  }

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


// ---------- Share-link previews: /anime/<kind>/<id> ----------
const ANILIST_Q = 'query($id:Int){Media(id:$id,type:ANIME){title{romaji english} description(asHtml:false) bannerImage coverImage{extraLarge large} format episodes averageScore isAdult}}';
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (v, n) => {
  const t = String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '\u2026' : t;
};

async function lookupAnime(kind, id, env) {
  if (kind === 'anilist') {
    if (!/^\d+$/.test(id)) return null;
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_Q, variables: { id: parseInt(id, 10) } }),
    });
    if (!r.ok) return null;
    const m = ((await r.json()).data || {}).Media;
    if (!m || m.isAdult) return null;
    const title = (m.title && (m.title.english || m.title.romaji)) || '';
    const bits = [m.format, m.episodes ? m.episodes + ' eps' : '', m.averageScore ? '\u2605 ' + (m.averageScore / 10).toFixed(1) : ''].filter(Boolean).join(' \u2022 ');
    return {
      title,
      description: [bits, clip(m.description, 180)].filter(Boolean).join(' \u2014 '),
      image: m.bannerImage || (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
      wide: !!m.bannerImage,
    };
  }
  if (kind === 'kitsu') {
    if (!/^\d+$/.test(id)) return null;
    let r = null;
    for (const base of ['https://kitsu.io/api/edge', 'https://kitsu.app/api/edge']) {
      try { r = await fetch(base + '/anime/' + id, { headers: { Accept: 'application/vnd.api+json' } }); if (r.status < 500) break; } catch (e) { r = null; }
    }
    if (!r || !r.ok) return null;
    const a = (((await r.json()).data) || {}).attributes;
    if (!a || a.nsfw) return null;
    const cover = a.coverImage && (a.coverImage.large || a.coverImage.original);
    const poster = a.posterImage && (a.posterImage.large || a.posterImage.original);
    return {
      title: a.canonicalTitle || (a.titles && a.titles.en) || '',
      description: clip(a.synopsis, 200),
      image: cover || poster || '',
      wide: !!cover,
    };
  }
  if (kind === 'anikoto') { // best effort: the catalog's field names may differ
    const base = (env && env.CATALOG_BASE) || CATALOG_BASE;
    const r = await fetch(base + '/series/' + encodeURIComponent(id), { headers: { Accept: 'application/json', 'User-Agent': UPSTREAM_UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = (j && j.data && (j.data.anime || j.data)) || (j && j.anime) || {};
    const title = raw.title || raw.name || '';
    if (!title) return null;
    return { title, description: clip(raw.synopsis || raw.description, 200), image: raw.poster || raw.image || raw.cover || raw.thumbnail || '', wide: false };
  }
  return null;
}

function setMeta(html, key, content) {
  const re = new RegExp('(<meta\\s+(?:property|name)="' + key.replace(/[.:]/g, '\\$&') + '"\\s+content=")[^"]*(")');
  return re.test(html) ? html.replace(re, (_, a, b) => a + escAttr(content) + b) : html;
}

async function handleAnimePage(request, url, env) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', url).toString(), { headers: { Accept: 'text/html' } }));
  if (!page.ok) return page;
  let html = await page.text();
  const m = url.pathname.match(/^\/anime\/([a-z]+)\/([^/]+)\/?$/);
  let info = null;
  // Over the limit: still serve the app, just skip the AniList/Kitsu lookup used for link previews.
  const limited = m ? await rateLimited(request, env, 'page') : false;
  if (m && !limited) { try { info = await lookupAnime(m[1], decodeURIComponent(m[2]), env); } catch (e) { info = null; } }

  const fallbackImg = url.origin + '/icon-512.png';
  let image = fallbackImg, wide = false;
  if (info && info.title) {
    const title = info.title + ' \u2014 SyncAnime';
    const desc = info.description || 'Watch ' + info.title + ' on SyncAnime.';
    if (/^https?:\/\//i.test(info.image || '')) { image = info.image; wide = !!info.wide; }
    html = html.replace(/<title>[^<]*<\/title>/, '<title>' + escAttr(title) + '</title>');
    html = setMeta(html, 'og:title', title);
    html = setMeta(html, 'og:description', desc);
    html = setMeta(html, 'description', desc);
    html = html.replace('</head>', '<meta name="twitter:title" content="' + escAttr(title) + '"><meta name="twitter:description" content="' + escAttr(desc) + '"></head>');
  }
  html = setMeta(html, 'og:image', image);
  html = setMeta(html, 'twitter:card', wide ? 'summary_large_image' : 'summary');
  html = html.replace('</head>', '<meta property="og:url" content="' + escAttr(url.origin + url.pathname) + '"><meta name="twitter:image" content="' + escAttr(image) + '"></head>');

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': info ? 'public, max-age=300' : 'no-cache' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json(200, { ok: true });

    if (url.pathname.startsWith('/anime/')) return handleAnimePage(request, url, env);

    if (url.pathname.startsWith('/api/catalog/')) return handleCatalog(request, url, env);

    // The frontend calls this first. On this deployment there is no stream resolver,
    // so answer "no direct stream" and the app plays the normal embed instead.
    if (url.pathname === '/api/direct') {
      return json(200, { url: null, unavailable: true, reason: 'Direct playback is not available on this deployment' });
    }

    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });

    // Anything else that isn't a static file.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
