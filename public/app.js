    "use strict";
    /* ===================== sources ===================== */
    const ANIKOTO_LOCAL = "https://www.anikotoapi.site";          // your instance: recent + series
    const ANIKOTO_VERCEL = "https://anikototvapi.vercel.app/api"; // search/episodes/servers/stream
    const ANILIST = "https://graphql.anilist.co";
    const KITSU = "https://kitsu.io/api/edge";
    const cache = new Map();
    const statusEl = document.getElementById("status");
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const first = (...values) => values.find(v => v !== undefined && v !== null && v !== "");

    const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

    /* ===================== your instance (recent + series) ===================== */
    async function localApi(path) {
      if (cache.has(path)) {
        const entry = cache.get(path);
        if (Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
        cache.delete(path);
      }
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetch("/api/catalog" + path, { headers: { Accept: "application/json" } });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < 2) {
          const ra = Number(response.headers.get("Retry-After"));
          await new Promise(r => setTimeout(r, Math.min((Number.isFinite(ra) && ra > 0 ? ra : 1.5 * (attempt + 1)) * 1000, 5000)));
        }
      }
      if (response.status === 429) throw new Error("The catalog is busy right now (HTTP 429). Please wait a few seconds and tap Retry.");
      if (!response.ok) throw new Error("Catalog API returned HTTP " + response.status + ".");
      const json = await response.json();
      if (json && json.ok === false) throw new Error(json.error || json.message || "Catalog request failed.");
      cache.set(path, { data: json, timestamp: Date.now() });
      return json;
    }

    /* ===================== AniList ===================== */
    const ANILIST_QUERY = `query($page:Int,$perPage:Int,$search:String,$genre:String,$format:MediaFormat,$status:MediaStatus,$sort:[MediaSort],$season:MediaSeason,$seasonYear:Int){
      Page(page:$page,perPage:$perPage){
        pageInfo{total currentPage lastPage hasNextPage}
        media(type:ANIME,search:$search,genre:$genre,format:$format,status:$status,sort:$sort,season:$season,seasonYear:$seasonYear,isAdult:false){
          id title{romaji english} coverImage{large} format episodes status averageScore genres
          description(asHtml:false) startDate{year}
        }
      }
    }`;
    const ANILIST_DETAIL_QUERY = `query($id:Int){
      Media(id:$id,type:ANIME){
        id title{romaji english native} bannerImage coverImage{large} description(asHtml:false)
        averageScore popularity episodes status format duration season seasonYear genres
        siteUrl studios(isMain:true){nodes{name}}
        characters(perPage:8){edges{role node{name{full} image{medium}}}}
      }
    }`;
    async function gql(query, variables) {
      const response = await fetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables })
      });
      if (response.status === 429) throw new Error("AniList rate limit reached — wait a moment and retry.");
      if (!response.ok) throw new Error("AniList returned HTTP " + response.status + ".");
      const body = await response.json();
      if (body.errors && body.errors.length) throw new Error(body.errors[0].message);
      return body.data;
    }
    const cleanDesc = t => String(t || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
    function mapAnilist(m) {
      return {
        kind: "anilist", id: String(m.id),
        title: (m.title && (m.title.english || m.title.romaji)) || "Untitled",
        alt: m.title && m.title.english ? (m.title.romaji || "") : "",
        poster: m.coverImage ? m.coverImage.large : "",
        score: typeof m.averageScore === "number" && m.averageScore > 0 ? m.averageScore / 10 : null,
        synopsis: cleanDesc(m.description),
        genres: m.genres || [], type: m.format || "Anime",
        year: m.startDate ? m.startDate.year : null,
        episodes: m.episodes || null, status: m.status || "", raw: m
      };
    }
    async function anilistBrowse(params) {
      const variables = { page: params.page, perPage: params.perPage || 24, sort: [params.sort || "TRENDING_DESC"] };
      if (params.search) variables.search = params.search;
      if (params.genre) variables.genre = params.genre;
      if (params.format) variables.format = params.format;
      if (params.status) variables.status = params.status;
      const data = await gql(ANILIST_QUERY, variables);
      const page = data.Page;
      return {
        source: "anilist",
        items: page.media.map(mapAnilist),
        pageInfo: {
          total: page.pageInfo.total,
          currentPage: page.pageInfo.currentPage,
          lastPage: page.pageInfo.lastPage,
          hasNextPage: page.pageInfo.hasNextPage
        }
      };
    }
    async function anilistTop() {
      const data = await gql(ANILIST_QUERY, { page: 1, perPage: 18, sort: ["SCORE_DESC"] });
      return data.Page.media.map(mapAnilist);
    }
    function currentSeason() {
      const now = new Date();
      const m = now.getMonth() + 1;
      return { season: m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL", seasonYear: now.getFullYear() };
    }
    async function anilistSeason() {
      const { season, seasonYear } = currentSeason();
      const data = await gql(ANILIST_QUERY, { page: 1, perPage: 18, sort: ["TRENDING_DESC"], season, seasonYear });
      return data.Page.media.map(mapAnilist);
    }
    async function anilistDetail(id) {
      const data = await gql(ANILIST_DETAIL_QUERY, { id: parseInt(id, 10) });
      const m = data.Media;
      if (!m) throw new Error("Not found on AniList.");
      return Object.assign(mapAnilist(m), {
        alt: m.title.native || mapAnilist(m).alt,
        native: m.title.native || "",
        studios: (m.studios && m.studios.nodes ? m.studios.nodes : []).map(s => s.name),
        characters: (m.characters && m.characters.edges ? m.characters.edges : []).map(e => ({
          name: e.node.name.full, image: e.node.image ? e.node.image.medium : ""
        })),
        siteUrl: m.siteUrl || ""
      });
    }

    /* ===================== Kitsu fallback (search only) ===================== */
    const KITSU_PER_PAGE = 20;
    function mapKitsuItem(el) {
      const a = el.attributes || {};
      const rating = a.averageRating ? parseFloat(a.averageRating) : NaN;
      return {
        kind: "kitsu", id: String(el.id),
        title: (a.titles && (a.titles.en || a.titles.en_jp || a.titles.ja_jp)) || a.canonicalTitle || "Untitled",
        alt: a.canonicalTitle || "", poster: (a.posterImage && (a.posterImage.large || a.posterImage.medium)) || "",
        score: Number.isFinite(rating) ? Math.round(rating) / 10 : null,
        synopsis: cleanDesc(a.synopsis), genres: [], type: a.showType || "Anime",
        year: a.startDate ? parseInt(a.startDate.slice(0, 4), 10) : null,
        episodes: a.episodeCount || null, status: a.status || "", raw: a
      };
    }
    async function kitsuBrowse(params) {
      const q = new URLSearchParams();
      q.set("page[limit]", String(KITSU_PER_PAGE));
      q.set("page[offset]", String((params.page - 1) * KITSU_PER_PAGE));
      if (params.search) q.set("filter[text]", params.search);
      if (params.format) {
        const subtype = { TV: "TV", MOVIE: "Movie", OVA: "OVA", ONA: "ONA", SPECIAL: "Special", TV_SHORT: "TV", MUSIC: "Music" }[params.format];
        if (subtype) q.set("filter[subtype]", subtype);
      }
      if (params.status) {
        const st = { RELEASING: "current", NOT_YET_RELEASED: "upcoming", HIATUS: "tba" }[params.status];
        if (st) q.set("filter[status]", st);
      }
      if (params.genre) {
        const cat = params.genre.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        if (cat) q.set("filter[categories]", cat);
      }
      if (!params.search) q.set("sort", "-popularityRank");
      const response = await fetch(KITSU + "/anime?" + q, { headers: { Accept: "application/vnd.api+json" } });
      if (!response.ok) throw new Error("Kitsu returned HTTP " + response.status + ".");
      const body = await response.json();
      const count = body.meta && typeof body.meta.count === "number"
        ? body.meta.count
        : (params.page - 1) * KITSU_PER_PAGE + ((body.data && body.data.length) || 0);
      const lastPage = Math.max(1, Math.ceil(count / KITSU_PER_PAGE));
      return {
        source: "kitsu",
        items: (body.data || []).map(mapKitsuItem),
        pageInfo: { currentPage: params.page, lastPage, hasNextPage: params.page < lastPage, total: count }
      };
    }
    const BROWSE_DEFAULTS = { page: 1, search: "", genre: "", format: "", status: "", sort: "TRENDING_DESC" };
    const browse = Object.assign({}, BROWSE_DEFAULTS, { items: [], pageInfo: null, source: null, token: 0 });
    async function browseAnime(params) {
      try { return await anilistBrowse(params); }
      catch (anilistError) {
        if (anilistError && anilistError.name === "AbortError") throw anilistError;
        const result = await kitsuBrowse(params);
        result.fallbackReason = anilistError.message;
        return result;
      }
    }
    async function kitsuDetail(id) {
      const response = await fetch(KITSU + "/anime/" + encodeURIComponent(id) + "?include=genres", { headers: { Accept: "application/vnd.api+json" } });
      if (!response.ok) throw new Error("Kitsu returned HTTP " + response.status + ".");
      const body = await response.json();
      const a = body.data.attributes;
      const included = Array.isArray(body.included) ? body.included : [];
      const rating = a.averageRating ? parseFloat(a.averageRating) : NaN;
      return {
        kind: "kitsu", id: String(body.data.id),
        title: (a.titles && (a.titles.en || a.titles.en_jp)) || a.canonicalTitle || "Untitled",
        alt: a.canonicalTitle || "", poster: (a.posterImage && (a.posterImage.large || a.posterImage.medium)) || "",
        score: Number.isFinite(rating) ? Math.round(rating) / 10 : null,
        synopsis: cleanDesc(a.synopsis), genres: included.filter(i => i.type === "genres").map(i => i.attributes.name),
        type: a.showType || "Anime", year: a.startDate ? parseInt(a.startDate.slice(0, 4), 10) : null,
        episodes: a.episodeCount || null, status: a.status || "", studios: [], characters: [],
        siteUrl: "https://kitsu.io/anime/" + a.slug, native: (a.titles && a.titles.ja_jp) || "", raw: a
      };
    }

    /* ===================== AniKoto streaming (vercel) ===================== */
    async function vercelApi(path) {
      const response = await fetch(ANIKOTO_VERCEL + path, { headers: { Accept: "application/json" } });
      let body = null;
      try { body = await response.json(); } catch (e) { throw new Error("Streaming API invalid response."); }
      if (!response.ok || body.success === false) throw new Error(body && body.message ? body.message : "Streaming API error.");
      return body.results;
    }
    const normTitle = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    function titleScore(a, b) {
      const na = normTitle(a), nb = normTitle(b);
      if (!na || !nb) return 0;
      if (na === nb) return 100;
      if (na.includes(nb) || nb.includes(na)) return 75;
      const wa = na.split(" ").filter(w => w.length > 1);
      const wb = new Set(nb.split(" ").filter(w => w.length > 1));
      if (!wa.length || !wb.size) return 0;
      let inter = 0;
      for (const w of wa) if (wb.has(w)) inter++;
      return Math.round((70 * inter) / Math.max(wa.length, wb.size));
    }
    async function findStreamCandidates(titles) {
      const byId = new Map();
      for (const query of titles) {
        if (!query) continue;
        let list = [];
        try { const r = await vercelApi("/search?keyword=" + encodeURIComponent(query)); list = (r && r.data) || []; }
        catch (e) { continue; }
        for (const item of list) {
          if (!item || !item.animeId) continue;
          const id = String(item.animeId);
          const score = Math.max(titleScore(query, item.title), titleScore(query, item.japaneseTitle));
          const prev = byId.get(id);
          if (!prev || score > prev.score) {
            byId.set(id, { score, animeId: id, slug: String(item.slug || "").replace(/\/ep-\d+.*$/, ""), title: item.title || "Unknown", poster: item.poster || "", sub: item.sub || 0, dub: item.dub || 0 });
          }
        }
        const best = [...byId.values()].sort((a, b) => b.score - a.score)[0];
        if (best && best.score >= 95) break;
      }
      return [...byId.values()].sort((a, b) => b.score - a.score);
    }
    async function fetchVercelEpisodes(animeId) {
      const r = await vercelApi("/episodes/" + encodeURIComponent(animeId));
      return { slug: r.slug || "", totalEpisodes: r.totalEpisodes || 0, episodes: r.episodes || [] };
    }
    async function fetchVercelServers(serverIds) {
      const r = await vercelApi("/servers?ids=" + encodeURIComponent(serverIds));
      return Array.isArray(r) ? r : [];
    }
    async function fetchVercelStream(linkId) {
      const r = await vercelApi("/stream?id=" + encodeURIComponent(linkId));
      return r.url || r.embedUrl || null;
    }

    /* ===================== local ad-free player ===================== */
    let hlsLibPromise = null;
    let currentHls = null;
    function destroyHls() { if (currentHls) { try { currentHls.destroy(); } catch (e) {} currentHls = null; } }
    function loadHlsLib() {
      if (window.Hls) return Promise.resolve(window.Hls);
      if (!hlsLibPromise) {
        hlsLibPromise = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
          s.onload = () => resolve(window.Hls);
          s.onerror = () => { hlsLibPromise = null; reject(new Error("Failed to load player library.")); };
          document.head.appendChild(s);
        });
      }
      return hlsLibPromise;
    }
    const watch = { mode: "sub", title: "", episode: null, embedUrl: null, skip: null, epCount: 0, servers: [], serverIdx: 0 };
    function serversForMode() {
      const ofMode = watch.servers.filter(s => s.type === watch.mode);
      return ofMode.length ? ofMode : watch.servers;
    }
    function playerBox() { return document.getElementById("player-box"); }
    function showPlayerLoading(label) {
      playerBox().innerHTML = '<div class="player-loading"><div class="spinner"></div>' + esc(label || "Loading player…") + "</div>";
    }
    function showPlayerError(message, embedUrl) {
      playerBox().innerHTML = '<div class="player-error"><div>' + esc(message) + "</div>" +
        (embedUrl ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(embedUrl) + '">Open embed fallback ↗</a>' : "") +
        "</div>";
    }
    function setupSkipButtons(video) {
      if (!video || !watch.skip) return;
      const windows = [];
      if (watch.skip.intro && watch.skip.intro.end > watch.skip.intro.start) windows.push({ label: "Skip intro", start: watch.skip.intro.start, end: watch.skip.intro.end });
      if (watch.skip.outro && watch.skip.outro.end > watch.skip.outro.start) windows.push({ label: "Skip outro", start: watch.skip.outro.start, end: watch.skip.outro.end });
      if (!windows.length) return;
      const btn = document.createElement("button");
      btn.className = "skip-btn"; btn.hidden = true;
      video.parentElement.appendChild(btn);
      let active = null;
      video.addEventListener("timeupdate", () => {
        const t = video.currentTime;
        const w = windows.find(win => t >= win.start && t <= win.end);
        if (w) { btn.hidden = false; btn.textContent = w.label; active = w; }
        else { btn.hidden = true; active = null; }
      });
      btn.addEventListener("click", () => { if (active) video.currentTime = active.end + 0.5; });
    }
    async function playDirect(url, tracks) {
      destroyHls();
      const box = playerBox();
      const isHls = /\.m3u8(\?|$)/i.test(url);
      if (!isHls) {
        box.innerHTML = '<video controls autoplay playsinline src="' + esc(url) + '"></video>';
        setupSkipButtons(box.querySelector("video"));
        return;
      }
      box.innerHTML = '<video id="sync-video" controls autoplay playsinline crossorigin="anonymous"></video>';
      const video = document.getElementById("sync-video");
      (tracks || []).forEach(t => {
        if (!t || !t.file) return;
        const track = document.createElement("track");
        track.kind = t.kind || "captions"; track.label = t.label || "Subtitles";
        track.src = "/api/hls?url=" + encodeURIComponent(t.file);
        if (t.default) track.default = true;
        video.appendChild(track);
      });
      const HlsLib = await loadHlsLib();
      if (HlsLib && HlsLib.isSupported()) {
        destroyHls();
        const hls = new HlsLib();
        currentHls = hls;
        hls.loadSource("/api/hls?url=" + encodeURIComponent(url));
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = "/api/hls?url=" + encodeURIComponent(url);
      } else throw new Error("HLS not supported in this browser.");
      setupSkipButtons(video);
    }
    async function playEmbed(embedUrl) {
      watch.embedUrl = embedUrl;
      renderWatchBar();
      showPlayerLoading("Resolving direct stream…");
      try {
        const response = await fetch("/api/direct?url=" + encodeURIComponent(embedUrl));
        if (!response.ok) throw new Error("Resolver HTTP " + response.status + ".");
        const direct = await response.json();
        if (!direct.url) throw new Error(direct.reason || "Could not resolve a direct stream.");
        watch.skip = { intro: direct.intro, outro: direct.outro };
        await playDirect(direct.url, direct.tracks || []);
      } catch (err) {
        showPlayerError(err.message + " — playing embed instead.", embedUrl);
        playerBox().innerHTML =
          '<iframe src="' + esc(embedUrl) + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen frameborder="0"></iframe>';
      }
      renderWatchBar();
    }
    function renderWatchBar() {
      const bar = document.getElementById("watch-bar");
      const epLabel = watch.episode ? " · Ep " + watch.episode + (watch.epCount ? " / " + watch.epCount : "") : "";
      const hasSub = watch.servers.some(s => s.type === "sub");
      const hasDub = watch.servers.some(s => s.type === "dub");
      const list = serversForMode();
      bar.innerHTML =
        '<div class="watch-meta"><strong>' + esc(watch.title) + "</strong>" + esc(epLabel) + "</div>" +
        (watch.episode != null && modalState.episodes.length > 1
          ? '<div class="ep-step"><button class="step-btn" data-ep-step="-1" aria-label="Previous episode">‹ Prev</button><button class="step-btn" data-ep-step="1" aria-label="Next episode">Next ›</button></div>'
          : "") +
        '<div class="mode-toggle">' +
          '<button class="mode-btn' + (watch.mode === "sub" ? " active" : "") + '" data-watch-mode="sub"' + (watch.servers.length && !hasSub ? " disabled" : "") + '>Sub</button>' +
          '<button class="mode-btn' + (watch.mode === "dub" ? " active" : "") + '" data-watch-mode="dub"' + (watch.servers.length && !hasDub ? " disabled" : "") + '>Dub</button>' +
        "</div>" +
        (watch.servers.length
          ? '<div class="server-chips">' + list.map((s, i) =>
              '<button class="server-chip' + (i === watch.serverIdx ? " active" : "") + '" data-server-index="' + i + '">' + esc(s.name || ("Server " + (i + 1))) + "</button>"
            ).join("") + "</div>"
          : "") +
        (watch.embedUrl ? '<a class="tiny-link" target="_blank" rel="noopener noreferrer" href="' + esc(watch.embedUrl) + '">Open embed ↗</a>' : "");
    }
    function openPlayer() {
      document.getElementById("player-wrap").hidden = false;
    }
    function stopPlayer() {
      destroyHls();
      document.getElementById("player-wrap").hidden = true;
      playerBox().innerHTML = "";
      document.getElementById("watch-bar").innerHTML = "";
      watch.mode = "sub"; watch.episode = null; watch.embedUrl = null; watch.skip = null;
      watch.servers = []; watch.serverIdx = 0;
    }

    /* ===================== UI: cards & sections ===================== */
    function cardHtml(item) {
      const title = item.title;
      const score = item.score != null ? "★ " + (Math.round(item.score * 10) / 10) : "NEW";
      const genres = (item.genres || []).slice(0, 3).map(g => typeof g === "string" ? g : g.name || "").filter(Boolean).join(" · ") || item.type || "Anime";
      return '<article class="anime-card" tabindex="0" role="button" aria-label="Details for ' + esc(title) + '" data-kind="' + esc(item.kind) + '" data-id="' + esc(item.id) + '">' +
        '<img class="poster" loading="lazy" src="' + esc(item.poster) + '" alt="' + esc(title) + ' poster" onerror="this.onerror=null;this.src=\'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22270%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23151b27%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 fill=%22%23aab3c4%22 font-size=%2214%22 text-anchor=%22middle%22%3ENo poster%3C/text%3E%3C/svg%3E\'">' +
        '<div class="card-info"><div class="card-title-line"><div class="card-title">' + esc(title) + '</div><div class="score">' + esc(score) + '</div></div>' +
        '<div class="genres">' + esc(genres) + "</div></div></article>";
    }
    function renderCards(targetId, items) {
      const el = document.getElementById(targetId);
      if (!items || !items.length) { el.innerHTML = '<div class="empty">Nothing here right now.</div>'; return; }
      el.innerHTML = items.map(cardHtml).join("");
    }
    function setStatus(text) { statusEl.textContent = text; }

    /* your instance: recent list */
    function normalizeLocal(item) {
      const a = item?.anime || item || {};
      return {
        kind: "anikoto", id: String(first(a.id, a.series_id, item?.id)),
        title: first(a.title, a.name, "Untitled Anime"),
        alt: first(a.alternative, a.native, ""),
        poster: first(a.poster, a.image, ""),
        score: null, synopsis: first(a.synopsis, a.description, ""),
        genres: Array.isArray(a.genres) ? a.genres : [],
        type: first(a.type, "Anime"), year: null,
        episodes: first(a.episodes_count, a.total, null), status: "", raw: a
      };
    }
    async function loadRecent() {
      const el = document.getElementById("popular-cards");
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      try {
        const json = await localApi("/recent-anime?page=1&per_page=24");
        const rows = Array.isArray(json.data) ? json.data : [];
        const items = rows.map(normalizeLocal).filter(a => a.id && a.id !== "undefined");
        renderCards("popular-cards", items);
        setStatus("Recently updated loaded from catalog API · " + items.length + " titles.");
        return items;
      } catch (error) {
        el.innerHTML = '<div class="empty">' + esc(error.message) + ' <button class="btn" data-refresh="recent">Retry</button></div>';
        setStatus(error.message);
        return [];
      }
    }
    async function loadTop() {
      const el = document.getElementById("top-cards");
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      try {
        renderCards("top-cards", await anilistTop());
      } catch (error) {
        try { renderCards("top-cards", await kitsuSearch("")); }
        catch (e) { el.innerHTML = '<div class="empty">' + esc(error.message) + "</div>"; }
      }
    }
    async function loadSeason() {
      const el = document.getElementById("season-cards");
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      try {
        renderCards("season-cards", await anilistSeason());
      } catch (error) {
        el.innerHTML = '<div class="empty">' + esc(error.message) + "</div>";
      }
    }

    /* ===================== browse: search + filters + pagination ===================== */
    let searchTimer = null;
    function browseActive() {
      return !!(browse.search || browse.genre || browse.format || browse.status || browse.sort !== "TRENDING_DESC");
    }
    function renderBrowseMeta() {
      const info = browse.pageInfo;
      const meta = document.getElementById("result-meta");
      const pag = document.getElementById("browse-pagination");
      if (info && info.total > 0) {
        meta.textContent = (info.total > 5000 ? "5000+" : info.total.toLocaleString()) + " results · " + browse.items.length + " shown";
        meta.hidden = false;
      } else meta.hidden = true;
      if (info && (info.lastPage > 1 || info.hasNextPage)) {
        document.getElementById("page-info").textContent = "Page " + info.currentPage + " / " + (info.lastPage > 5000 ? "5000+" : info.lastPage.toLocaleString());
        pag.hidden = false;
        document.getElementById("prev-page").disabled = info.currentPage <= 1;
        document.getElementById("next-page").disabled = !info.hasNextPage;
      } else pag.hidden = true;
    }
    async function runBrowse({ scroll = false } = {}) {
      const section = document.getElementById("search-section");
      const el = document.getElementById("search-cards");
      const clearOn = browseActive();
      section.classList.toggle("show", clearOn);
      document.getElementById("clear-search").hidden = !clearOn;
      document.getElementById("filters-clear").hidden = !clearOn;
      if (!clearOn) return;
      document.getElementById("browse-title").textContent = browse.search ? "Search Results" : "Browse Anime";
      const token = ++browse.token;
      el.innerHTML = '<div class="empty">Searching…</div>';
      document.getElementById("browse-pagination").hidden = true;
      setStatus(browse.search ? 'Searching for "' + browse.search + '"…' : "Loading…");
      try {
        const result = await browseAnime({ page: browse.page, search: browse.search, genre: browse.genre, format: browse.format, status: browse.status, sort: browse.sort });
        if (token !== browse.token) return;
        browse.items = result.items;
        browse.pageInfo = result.pageInfo;
        browse.source = result.source;
        renderCards("search-cards", browse.items);
        renderBrowseMeta();
        const via = result.source === "kitsu" ? " (AniList down — Kitsu fallback)" : "";
        setStatus(browse.items.length
          ? browse.items.length + " result(s) on page " + browse.page + via + "."
          : "No results." + via);
        if (scroll) window.scrollTo({ top: Math.max(0, section.offsetTop - 90), behavior: "smooth" });
      } catch (error) {
        if (token !== browse.token) return;
        el.innerHTML = '<div class="empty">' + esc(error.message) + "</div>";
        document.getElementById("browse-pagination").hidden = true;
        document.getElementById("result-meta").hidden = true;
        setStatus("Search failed.");
      }
    }
    function resetBrowse() {
      Object.assign(browse, BROWSE_DEFAULTS);
      document.getElementById("search-input").value = "";
      document.getElementById("genre-select").value = "";
      document.getElementById("format-select").value = "";
      document.getElementById("status-select").value = "";
      document.getElementById("sort-select").value = "TRENDING_DESC";
      runBrowse({ scroll: true });
    }
    function onBrowseInput(immediate) {
      clearTimeout(searchTimer);
      const apply = () => {
        browse.search = document.getElementById("search-input").value.trim();
        browse.page = 1;
        runBrowse({ scroll: !!immediate && !!browse.search });
      };
      if (immediate) apply();
      else searchTimer = setTimeout(apply, 400);
    }
    function bindFilter(id, key) {
      document.getElementById(id).addEventListener("change", event => {
        browse[key] = event.target.value;
        browse.page = 1;
        runBrowse();
      });
    }
    bindFilter("genre-select", "genre");
    bindFilter("format-select", "format");
    bindFilter("status-select", "status");
    bindFilter("sort-select", "sort");
    /* ===================== live search dropdown ===================== */
    const sgBox = document.getElementById("suggest");
    const sgInput = document.getElementById("search-input");
    const sgForm = document.getElementById("search-form");
    const sgCache = new Map();
    let sgToken = 0, sgTimer = null, sgItems = [], sgActive = -1;
    function sgPosition() {
      const r = sgForm.getBoundingClientRect();
      sgBox.style.top = (r.bottom + 8) + "px";
      if (window.innerWidth <= 700) {
        sgBox.style.left = "8px"; sgBox.style.right = "8px"; sgBox.style.width = "auto";
      } else {
        const w = Math.min(420, window.innerWidth - 16);
        sgBox.style.width = w + "px"; sgBox.style.right = "auto";
        sgBox.style.left = Math.max(8, r.right - w) + "px";
      }
    }
    function sgOpen(html) {
      sgBox.innerHTML = html; sgBox.hidden = false; sgActive = -1;
      sgPosition(); sgInput.setAttribute("aria-expanded", "true");
    }
    function sgClose() {
      sgBox.hidden = true; sgActive = -1; sgInput.setAttribute("aria-expanded", "false");
    }
    function sgRender(q, items) {
      sgItems = items;
      if (!items.length) { sgOpen('<div class="sg-empty">No results for \u201c' + esc(q) + "\u201d</div>"); return; }
      const rows = items.map((it, i) => {
        const meta = [it.type, it.year, it.score != null ? "\u2605 " + (Math.round(it.score * 10) / 10) : ""].filter(Boolean).join(" \u2022 ");
        return '<div class="sg-item" role="option" data-sg-index="' + i + '">' +
          (it.poster ? '<img src="' + esc(it.poster) + '" alt="" loading="lazy">' : '<div class="sg-noimg"></div>') +
          '<div class="sg-text"><div class="sg-title">' + esc(it.title) + '</div><div class="sg-meta">' + esc(meta) + "</div></div></div>";
      }).join("");
      sgOpen(rows + '<div class="sg-all" data-sg-all>See all results for \u201c' + esc(q) + "\u201d \u2192</div>");
    }
    async function sgSearch(q) {
      const token = ++sgToken;
      const key = q.toLowerCase();
      if (sgCache.has(key)) { sgRender(q, sgCache.get(key)); return; }
      sgOpen('<div class="sg-empty">Searching\u2026</div>');
      try {
        const result = await browseAnime({ page: 1, search: q, perPage: 8 });
        if (token !== sgToken) return;
        const items = result.items.slice(0, 8);
        if (sgCache.size >= 40) sgCache.delete(sgCache.keys().next().value);
        sgCache.set(key, items);
        sgRender(q, items);
      } catch (err) {
        if (token !== sgToken) return;
        sgOpen('<div class="sg-empty">' + esc(err.message || "Search failed") + "</div>");
      }
    }
    function sgPick(i) {
      const it = sgItems[i];
      if (!it) return;
      sgClose(); sgInput.blur();
      openMetadataDetail({ kind: it.kind, id: it.id });
    }
    function sgSeeAll() { sgToken++; sgClose(); sgInput.blur(); onBrowseInput(true); }
    function sgHighlight(next) {
      const rows = sgBox.querySelectorAll(".sg-item");
      if (!rows.length) return;
      sgActive = (next + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle("active", i === sgActive));
      rows[sgActive].scrollIntoView({ block: "nearest" });
    }
    sgInput.addEventListener("input", () => {
      clearTimeout(sgTimer);
      const q = sgInput.value.trim();
      if (q.length < 2) {
        sgToken++; sgClose();
        if (!q && browse.search) onBrowseInput(true); // cleared: reset the page results
        return;
      }
      sgTimer = setTimeout(() => sgSearch(q), 350);
    });
    sgInput.addEventListener("focus", () => {
      const q = sgInput.value.trim().toLowerCase();
      if (q.length >= 2 && sgCache.has(q)) sgRender(sgInput.value.trim(), sgCache.get(q));
    });
    sgInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { sgClose(); e.stopPropagation(); }
      else if (e.key === "ArrowDown" && !sgBox.hidden) { e.preventDefault(); sgHighlight(sgActive + 1); }
      else if (e.key === "ArrowUp" && !sgBox.hidden) { e.preventDefault(); sgHighlight(sgActive - 1); }
    });
    sgForm.addEventListener("submit", event => {
      event.preventDefault();
      clearTimeout(sgTimer);
      if (sgActive >= 0 && !sgBox.hidden) { sgPick(sgActive); return; }
      sgSeeAll();
    });
    sgBox.addEventListener("click", e => {
      const item = e.target.closest("[data-sg-index]");
      if (item) { sgPick(Number(item.dataset.sgIndex)); return; }
      if (e.target.closest("[data-sg-all]")) sgSeeAll();
    });
    document.addEventListener("click", e => { if (!sgBox.hidden && !e.target.closest("#search-form")) sgClose(); });
    window.addEventListener("resize", () => { if (!sgBox.hidden) sgPosition(); });
    window.addEventListener("scroll", () => { if (!sgBox.hidden) sgPosition(); }, { passive: true });
    document.getElementById("clear-search").addEventListener("click", resetBrowse);
    document.getElementById("filters-clear").addEventListener("click", resetBrowse);
    document.getElementById("prev-page").addEventListener("click", () => {
      if (browse.page > 1) { browse.page -= 1; runBrowse({ scroll: true }); }
    });
    document.getElementById("next-page").addEventListener("click", () => {
      if (browse.pageInfo && browse.pageInfo.hasNextPage) { browse.page += 1; runBrowse({ scroll: true }); }
    });

    /* ===================== detail modal + episodes ===================== */
    let modalState = { item: null, match: null, episodes: [], epData: null, source: null, getEmbed: null, serversByEp: new Map() };
    const modal = document.getElementById("anime-modal");
    const modalInner = document.getElementById("modal-inner");
    function openModal() { modal.classList.add("open"); document.body.style.overflow = "hidden"; }
    function closeModal() {
      modal.classList.remove("open"); document.body.style.overflow = "";
      stopPlayer(); modalInner.innerHTML = "";
      modalState = { item: null, match: null, episodes: [], epData: null, source: null, getEmbed: null, serversByEp: new Map() };
    }
    function modalInfoHtml(a, extraHtml) {
      const genres = (a.genres || []).map(g => '<span class="pill">' + esc(typeof g === "string" ? g : g.name || g.title || "") + "</span>").join("");
      return '<img src="' + esc(a.poster) + '" alt="' + esc(a.title) + ' poster" onerror="this.style.display=\'none\'">' +
        '<div><div class="eyebrow">Details</div><h2 id="modal-title">' + esc(a.title) + "</h2>" +
        '<div class="meta">' + esc(a.type || "Anime") + (a.year ? " • " + esc(a.year) : "") + (a.episodes ? " • " + esc(a.episodes) + " eps" : "") + (a.score != null ? " • ★ " + esc(a.score) : "") + "</div>" +
        '<div class="pills">' + genres + "</div>" +
        '<p class="synopsis">' + esc(a.synopsis || "No synopsis is available for this title.") + "</p>" +
        (a.studios && a.studios.length ? '<p class="sub-note">Studio: ' + esc(a.studios.join(", ")) + "</p>" : "") +
        (a.siteUrl ? '<a class="external" target="_blank" rel="noopener noreferrer" href="' + esc(a.siteUrl) + '">Open in ' + (a.kind === "kitsu" ? "Kitsu" : a.kind === "anikoto" ? "Catalog" : "AniList") + " ↗</a>" : "") +
        '</div><div id="episode-zone" style="grid-column:1/-1"><p class="sub-note">Finding streams…</p></div>';
    }
    function renderEpisodeZone(html) {
      const zone = document.getElementById("episode-zone");
      if (zone) zone.innerHTML = html;
    }
    const EP_CHUNK = 25;
    const epNum = (ep, i) => (ep.n != null ? ep.n : i + 1);
    function epListInner() {
      const eps = modalState.episodes;
      const chunks = Math.ceil(eps.length / EP_CHUNK);
      const cur = Math.min(modalState.epChunk || 0, chunks - 1);
      const from = cur * EP_CHUNK, to = Math.min(from + EP_CHUNK, eps.length);
      let chips = "";
      if (chunks > 1) {
        chips = '<div class="ep-chunks">';
        for (let c = 0; c < chunks; c++) {
          const f = c * EP_CHUNK, t = Math.min(f + EP_CHUNK, eps.length) - 1;
          chips += '<button class="ep-chunk' + (c === cur ? " active" : "") + '" data-ep-chunk="' + c + '">' + esc(epNum(eps[f], f) + "–" + epNum(eps[t], t)) + "</button>";
        }
        chips += "</div>";
      }
      let grid = '<div class="ep-list">';
      for (let i = from; i < to; i++) {
        const active = watch.episode != null && epNum(eps[i], i) === watch.episode;
        grid += '<button class="ep-btn ep-row' + (active ? " active" : "") + '" data-ep-index="' + i + '" aria-label="Play episode ' + esc(epNum(eps[i], i)) + '">' + esc(epNum(eps[i], i)) + "</button>";
      }
      return chips + grid + "</div>";
    }
    function renderEpList() {
      const w = document.getElementById("ep-wrap");
      if (w) w.innerHTML = epListInner();
    }
    function episodeRowsHtml(episodes, kind) {
      if (!episodes.length) return '<p class="sub-note">No episodes found on the streaming source.</p>';
      modalState.epChunk = 0;
      return '<h3 style="margin:18px 0 10px;font-size:15px">Episodes (' + episodes.length + ')</h3><div id="ep-wrap">' + epListInner() + "</div>";
    }
    async function loadEpisodeServers(epIndex) {
      const ep = modalState.episodes[epIndex];
      let servers = modalState.serversByEp.get(epIndex);
      if (!servers) {
        servers = await fetchVercelServers(ep.server_ids);
        modalState.serversByEp.set(epIndex, servers);
      }
      watch.servers = servers;
      watch.serverIdx = 0;
      return servers;
    }
    async function playServer(server) {
      showPlayerLoading("Loading stream…");
      const embedUrl = await fetchVercelStream(server.link_id);
      if (!embedUrl) throw new Error("No stream URL from this server.");
      await playEmbed(embedUrl);
    }
    async function playEpisodeByIndex(index) {
      const ep = modalState.episodes[index];
      if (!ep) return;
      openPlayer();
      watch.title = modalState.item.title;
      watch.episode = ep.n != null ? ep.n : index + 1;
      watch.epCount = modalState.episodes.length;
      watch.mode = "sub";
      watch.embedUrl = null; watch.skip = null;
      modalState.epChunk = Math.floor(index / EP_CHUNK);
      renderEpList();
      if (!window.matchMedia("(max-width:700px)").matches) {
        const box = modal.querySelector(".modal-box");
        if (box) box.scrollTo({ top: 0, behavior: "smooth" });
      }
      try {
        if (modalState.epData) {
          showPlayerLoading("Fetching servers…");
          await loadEpisodeServers(index);
          renderWatchBar();
          const list = serversForMode();
          const server = list[0];
          if (!server) throw new Error("No servers available.");
          await playServer(server);
        } else {
          watch.servers = []; watch.serverIdx = 0;
          renderWatchBar();
          showPlayerLoading("Fetching server…");
          const embedUrl = await modalState.getEmbed(ep, "sub");
          if (!embedUrl) throw new Error("No stream available for this episode.");
          await playEmbed(embedUrl);
        }
      } catch (err) {
        showPlayerError(err.message);
      }
    }
    async function switchWatchMode(mode) {
      if (watch.episode == null) return;
      const index = modalState.episodes.findIndex((ep, i) => (ep.n != null ? ep.n : i + 1) === watch.episode);
      const ep = modalState.episodes[index >= 0 ? index : 0];
      if (!ep) return;
      watch.mode = mode;
      try {
        if (modalState.epData) {
          const list = serversForMode();
          renderWatchBar();
          if (!list.length) { showPlayerError("No " + mode.toUpperCase() + " servers for this episode."); return; }
          watch.serverIdx = 0;
          renderWatchBar();
          await playServer(list[0]);
        } else {
          renderWatchBar();
          showPlayerLoading("Switching to " + mode.toUpperCase() + "…");
          const embedUrl = await modalState.getEmbed(ep, mode);
          if (!embedUrl) throw new Error("No " + mode.toUpperCase() + " stream for this episode.");
          await playEmbed(embedUrl);
        }
      } catch (err) {
        showPlayerError(err.message, watch.embedUrl);
      }
    }
    async function switchServer(index) {
      const list = serversForMode();
      const server = list[index];
      if (!server) return;
      watch.serverIdx = index;
      renderWatchBar();
      try { await playServer(server); }
      catch (err) { showPlayerError(err.message, watch.embedUrl); }
    }

    /* path A: your catalog series (embed_url per episode) */
    async function openAnikotoSeries(id) {
      openModal();
      modalInner.innerHTML = '<div class="empty" style="grid-column:1/-1">Loading series and episodes…</div>';
      try {
        const json = await localApi("/series/" + encodeURIComponent(id));
        const raw = json?.data?.anime || json?.anime || json?.data || {};
        const episodes = json?.data?.episodes || json?.episodes || raw?.episodes || [];
        const a = normalizeLocal({ anime: raw });
        modalState.item = a;
        modalState.source = "anikoto";
        modalState.episodes = episodes.map((ep, i) => ({
          n: first(ep.number, ep.episode, i + 1),
          sub: first(ep.embed_url && ep.embed_url.sub, ""),
          dub: first(ep.embed_url && ep.embed_url.dub, "")
        }));
        modalState.getEmbed = (ep, mode) => mode === "dub" ? (ep.dub || ep.sub) : (ep.sub || ep.dub);
        modalInner.innerHTML = modalInfoHtml(a, true);
        renderEpisodeZone(episodeRowsHtml(modalState.episodes));
      } catch (error) {
        modalInner.innerHTML = '<div class="empty" style="grid-column:1/-1">' + esc(error.message) + "</div>";
      }
    }

    /* path B: AniList/Kitsu detail + AniKoto stream match */
    async function openMetadataDetail(item) {
      openModal();
      modalInner.innerHTML = '<div class="empty" style="grid-column:1/-1">Loading details…</div>';
      let a;
      try {
        a = item.kind === "anilist" ? await anilistDetail(item.id) : await kitsuDetail(item.id);
      } catch (error) {
        modalInner.innerHTML = '<div class="empty" style="grid-column:1/-1">' + esc(error.message) + "</div>";
        return;
      }
      modalState.item = a;
      modalState.source = a.kind;
      modalInner.innerHTML = modalInfoHtml(a, true);
      renderEpisodeZone('<p class="sub-note">Matching streaming catalog…</p>');
      let candidates = [];
      try { candidates = await findStreamCandidates([a.title, a.alt, a.native].filter(Boolean)); }
      catch (error) { renderEpisodeZone('<p class="sub-note">' + esc(error.message) + "</p>"); return; }
      if (!candidates.length) {
        renderEpisodeZone('<p class="sub-note">Not available on the streaming source yet.</p>');
        return;
      }
      const best = candidates[0];
      if (best.score < 70 && candidates.length > 1) {
        renderEpisodeZone('<p class="sub-note">Multiple matches — pick the right one:</p><div class="match-list">' +
          candidates.slice(0, 8).map((c, i) =>
            '<button class="match-item" data-match-index="' + i + '">' +
              (c.poster ? '<img src="' + esc(c.poster) + '" alt="">' : "") +
              "<span><strong>" + esc(c.title) + "</strong><br><small style=\"color:#8792a6\">" + esc(c.sub + " sub / " + c.dub + " dub") + "</small></span>" +
            "</button>").join("") + "</div>");
        modalState.matchCandidates = candidates;
        return;
      }
      await loadMatchedEpisodes(best);
    }
    async function loadMatchedEpisodes(match) {
      modalState.match = match;
      renderEpisodeZone('<p class="sub-note">Loading episodes for ' + esc(match.title) + "…</p>");
      try {
        const epData = await fetchVercelEpisodes(match.animeId);
        modalState.epData = epData;
        modalState.episodes = epData.episodes.map(ep => ({
          n: Number(ep.episode_no) || 0,
          server_ids: ep.server_ids
        })).filter(ep => ep.server_ids);
        modalState.getEmbed = async (ep, mode) => {
          const servers = await fetchVercelServers(ep.server_ids);
          const list = servers.filter(s => s.type === mode);
          const pick = (list.length ? list : servers)[0];
          if (!pick) return null;
          return await fetchVercelStream(pick.link_id);
        };
        if (!modalState.episodes.length) {
          renderEpisodeZone('<p class="sub-note">No episodes on the streaming source.</p>');
          return;
        }
        renderEpisodeZone(episodeRowsHtml(modalState.episodes));
      } catch (error) {
        renderEpisodeZone('<p class="sub-note">' + esc(error.message) + "</p>");
      }
    }

    /* ===================== events ===================== */
    document.addEventListener("click", async event => {
      const matchBtn = event.target.closest("[data-match-index]");
      if (matchBtn && modalState.matchCandidates) {
        const match = modalState.matchCandidates[Number(matchBtn.dataset.matchIndex)];
        if (match) await loadMatchedEpisodes(match);
        return;
      }
      const chunkBtn = event.target.closest("[data-ep-chunk]");
      if (chunkBtn) { modalState.epChunk = Number(chunkBtn.dataset.epChunk); renderEpList(); return; }
      const stepBtn = event.target.closest("[data-ep-step]");
      if (stepBtn && modalState.episodes.length) {
        const cur = modalState.episodes.findIndex((ep, i) => epNum(ep, i) === watch.episode);
        const next = cur + Number(stepBtn.dataset.epStep);
        if (cur >= 0 && next >= 0 && next < modalState.episodes.length) await playEpisodeByIndex(next);
        return;
      }
      const syn = event.target.closest(".synopsis");
      if (syn) { syn.classList.toggle("open"); return; }
      const epBtn = event.target.closest("[data-ep-index]");
      if (epBtn && modalState.episodes.length) {
        await playEpisodeByIndex(Number(epBtn.dataset.epIndex));
        return;
      }
      const modeBtn = event.target.closest("[data-watch-mode]");
      if (modeBtn) {
        await switchWatchMode(modeBtn.dataset.watchMode);
        return;
      }
      const serverBtn = event.target.closest("[data-server-index]");
      if (serverBtn) {
        await switchServer(Number(serverBtn.dataset.serverIndex));
        return;
      }
      const article = event.target.closest(".anime-card");
      if (!article) return;
      const kind = article.dataset.kind, id = article.dataset.id;
      if (kind === "anikoto") await openAnikotoSeries(id);
      else await openMetadataDetail({ kind, id });
    });
    document.getElementById("modal-close").addEventListener("click", closeModal);
    modal.addEventListener("click", e => { if (e.target.id === "anime-modal") closeModal(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeModal();
      if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("anime-card")) { e.preventDefault(); e.target.click(); }
    });
    document.querySelectorAll("[data-refresh]").forEach(button => button.addEventListener("click", async () => {
      const key = button.dataset.refresh;
      button.textContent = "Loading…";
      if (key === "top") await loadTop();
      else if (key === "season") await loadSeason();
      else { cache.clear(); await loadRecent(); }
      button.textContent = "Refresh ↻";
    }));
    document.getElementById("menu-btn").addEventListener("click", () => {
      const nav = document.querySelector("nav");
      const open = nav.style.display === "flex";
      nav.style.cssText = open ? "" : "display:flex;position:absolute;top:61px;left:0;right:0;background:#0b0e15;padding:18px;flex-direction:column;align-items:flex-start;border-bottom:1px solid #ffffff20";
    });

    /* ===================== init ===================== */
    (async function init() {
      setStatus("Loading catalog…");
      await Promise.all([loadRecent(), loadTop(), loadSeason()]);
      setStatus("Ready · recently updated from catalog API · top/season from AniList · search works across AniList + Kitsu.");
    })();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

