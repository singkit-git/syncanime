# SyncAnime

Single-page anime catalog + player.

## Files

- `public/` — the site: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.json`, icons (only files listed in `PUBLIC_FILES` in `server.js` are served)
- `server.js` — Node server: serves the site and proxies streams

## Run

```bash
node server.js          # http://localhost:8080
PORT=3000 node server.js  # custom port
```

No npm dependencies — uses only Node built-ins (`http`, `https`, `fs`, `path`, `crypto`, `zlib`).

## Environment Variables (optional)

These have no defaults; set them in `.env` (loaded automatically) or your host's env settings. Copy `.env.example` to `.env`. Never commit it:

```bash
SOURCE_ENC_KEY="your-source-encryption-key"
SOURCE_ENC_IV="your-source-encryption-iv"
CDN_TOKEN_SECRET="your-cdn-token-secret"
PORT=8080
```

## Endpoints (server)

| Route | Purpose |
|---|---|
| `/` | Serves `index.html` |
| `/api/catalog/*` | Proxies `https://www.anikotoapi.site` (avoids CORS; recent + series) |
| `/api/direct?url=<embed>` | Resolves a megaplay embed URL to a direct m3u8 (+ subtitle tracks, intro/outro skip times) |
| `/api/hls?url=<m3u8>` | Fetches HLS playlists/segments with the correct Referer + CDN token; rewrites playlist URLs through itself |

The `/api/direct` and `/api/hls` endpoints are only available on the Node server. On the Cloudflare deployment the player uses the normal embed.

## Data sources

| Source | Used for | Notes |
|---|---|---|
| AniList (`graphql.anilist.co`) | Search, browse, filters, pagination, details | Primary metadata source, CORS `*` |
| Kitsu (`kitsu.io/api/edge`) | Search fallback | Used when AniList is down/rate-limited |
| AniKoto catalog (`www.anikotoapi.site`) | Recently updated, series + episode embeds | Your instance; proxied via `/api/catalog` |
| AniKoto API (`anikototvapi.vercel.app`) | Title matching, episodes, servers, stream links | Used to find streams for AniList/Kitsu titles |

## Features

- Search with debounce; genre / type / status / sort filters
- Pagination (AniList pageInfo, Kitsu offset)
- Sections: Recently Updated, Top Rated, This Season
- Detail modal: poster, synopsis, genres, studio, episodes
- Player: Sub/Dub toggle, server picker (when multiple servers exist), skip intro/outro buttons, subtitle tracks, hls.js playback
- Match picker when a title has several possible stream matches
- Embed fallback if direct resolution fails

## Deploy

Any Node.js host (v18+ recommended):

```bash
unzip syncanime.zip && cd syncanime
node server.js
```

Client requests are same-origin, so no CORS config is needed in production. Keep `server.js`, the `public/` folder, and `.env` together. Set `TRUST_PROXY=1` when behind a platform proxy so rate limiting sees real client IPs.

### Deploy to Railway (recommended - free tier available)

1. Push this repo to GitHub (or use Railway's GitHub integration)
2. Create a new project on [Railway.app](https://railway.app)
3. Select "Deploy from GitHub Repo" → choose your repo
4. Add environment variables:
   - `PORT` (Railway auto-sets this)
5. Deploy!

### Deploy to Render

1. Create a new Web Service on [Render.com](https://render.com)
2. Connect your GitHub repo
3. Set Build Command: `echo "no build needed"`
4. Set Start Command: `node server.js`
5. Add a web service with port `8080` (or use `PORT` env var)
6. Deploy!

### Deploy to Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Create app
flyctl launch --name syncanime --port 8080 --no-deploy

# Deploy
flyctl deploy
```

### Deploy to any VPS

```bash
# On your server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
unzip syncanime.zip
cd syncanime
node server.js &

# Or use PM2 for process management
npm install -g pm2
pm2 start server.js --name syncanime
```

### Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

```bash
docker build -t syncanime .
docker run -d -p 8080:8080 --name syncanime syncanime
```

### Deploy to Cloudflare

Cloudflare can be used in several ways. Choose the option that fits your needs:

#### Option 1: Cloudflare Container (Recommended - Full Node.js Support)

Cloudflare Containers support Node.js applications natively.

1. Install Wrangler CLI:
 ```bash
 npm install -g wrangler
 ```

2. Create `wrangler.jsonc`:
 ```json
 {
   "name": "syncanime",
   "compatibility_date": "2024-01-01",
   "container": {
     "image": "Dockerfile",
     "port": 8080
   }
 }
 ```

3. Deploy:
 ```bash
 wrangler login
 wrangler deploy
 ```

#### Option 2: Cloudflare Workers (Requires code adaptation)

Cloudflare Workers use V8 isolates (no Node.js built-ins like `fs`, `path`). You would need to rewrite `server.js` to use Workers API.

1. Create `wrangler.toml`:
 ```toml
 name = "syncanime"
 main = "worker.js"
 compatibility_date = "2024-01-01"
 ```

2. Create `worker.js` (adapt server.js to Workers API)
3. Deploy:
 ```bash
 wrangler deploy
 ```

#### Option 3: Cloudflare Pages (Static frontend only)

Cloudflare Pages can host the static `index.html`, but you'll need a backend service for the proxy APIs. Deploy the frontend to Pages and keep the proxy server on Railway/Render/VPS.

1. Push to GitHub
2. Create a Pages project at [dash.cloudflare.com](https://dash.cloudflare.com)
3. Build command: (leave empty), Publish directory: `.`
4. For API proxying, use a separate backend or adapt the frontend to call APIs directly

#### Option 4: Cloudflare with External Backend

1. Deploy `server.js` to Railway/Render (see above)
2. Point your custom domain through Cloudflare for:
   - SSL/TLS encryption
   - CDN caching
   - DDoS protection
   - DNS management

### Deploy Summary Table

| Platform | Full Server | Node.js | Notes |
|---|---|---|---|
| Railway | ✅ | ✅ | Recommended for simplicity |
| Render | ✅ | ✅ | Good free tier |
| Fly.io | ✅ | ✅ | Global deployment |
| Cloudflare Container | ✅ | ✅ | Global edge |
| Cloudflare Workers | ❌ | ⚠️ | Requires code adaptation |
| Cloudflare Pages | ❌ | ❌ | Static frontend only |
| VPS | ✅ | ✅ | Full control |

## Limits

- AniList caps catalog totals at ~5000 entries per query (pagination shows "5000+")
- Only titles present on AniKoto are watchable; others show "not available"
- HLS segments are proxied through `/api/hls` — this server must stay up for playback

## Security Features

- Secrets loaded from environment variables (not hardcoded)
- SSRF protection: host allowlist for all streaming/CDN domains
- Rate limiting: 120 req/min for API endpoints, 60 req/min for HLS streams
- Response caching: 2-minute TTL for catalog API responses (reduces upstream load)
- Gzip/deflate compression for all responses
- Max response body size limit (50MB) to prevent DoS
- Request timeouts (30s) on upstream calls

## Deploy to Cloudflare (free plan)

Uses Workers Static Assets for `public/` plus `worker/index.js` for `/api/*`. No secrets needed.

```bash
npm i -g wrangler    # or use npx
npx wrangler login
npx wrangler deploy  # prints https://syncanime.<your-subdomain>.workers.dev
```

Or from the dashboard: Workers & Pages → Create → Import a repository → build command empty,
deploy command `npx wrangler deploy`.

Notes:
- Catalog requests are proxied and edge-cached for 2 minutes.
- There is no stream resolver on this deployment: `/api/direct` reports "not available" and the
  player uses the normal embed. `/api/hls` is not provided.
- Local test: `npx wrangler dev`.
