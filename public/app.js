    "use strict";
    /* ===================== sources ===================== */
    const ANIKOTO_LOCAL = "https://www.anikotoapi.site";          // your instance: recent + series
    const ANIKOTO_VERCEL = "https://anikototvapi.vercel.app/api"; // search/episodes/servers/stream
    const ANILIST = "https://graphql.anilist.co";
    const KITSU_BASES = ["https://kitsu.io/api/edge", "https://kitsu.app/api/edge"];
    // Tries each Kitsu address in turn; moves on only when one is unreachable or returns a server error.
    async function kitsuFetch(path) {
      let lastErr = null;
      for (const base of KITSU_BASES) {
        try {
          const r = await fetch(base + path, { headers: { Accept: "application/vnd.api+json" } });
          if (r.status < 500) return r;
          lastErr = new Error("Kitsu returned HTTP " + r.status + ".");
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("Kitsu is unreachable.");
    }
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
    const GQL_TTL = 5 * 60 * 1000;
    let gqlFresh = false; // true while the user presses Refresh/Retry: skip the saved copy
    function gqlKey(query, variables) {
      const str = query + JSON.stringify(variables || {});
      let h = 5381;
      for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      return "sa.gql." + (h >>> 0).toString(36) + "." + str.length;
    }
    function gqlStore(key, data) {
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); }
      catch (e) {
        try { Object.keys(sessionStorage).filter(k => k.indexOf("sa.gql.") === 0).forEach(k => sessionStorage.removeItem(k)); } catch (e2) {}
      }
    }
    async function gql(query, variables) {
      const key = gqlKey(query, variables);
      if (!gqlFresh) {
        try {
          const raw = sessionStorage.getItem(key);
          if (raw) { const o = JSON.parse(raw); if (Date.now() - o.t < GQL_TTL) return o.d; }
        } catch (e) {}
      }
      const response = await fetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables })
      });
      if (response.status === 429) throw new Error("AniList rate limit reached — wait a moment and retry.");
      if (!response.ok) throw new Error("AniList returned HTTP " + response.status + ".");
      const body = await response.json();
      if (body.errors && body.errors.length) throw new Error(body.errors[0].message);
      gqlStore(key, body.data);
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
      const response = await kitsuFetch("/anime?" + q);
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
      const response = await kitsuFetch("/anime/" + encodeURIComponent(id) + "?include=genres");
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

    /* ===================== local player ===================== */
    let hlsLibPromise = null;
    let currentHls = null;
    function showUnmuteBtn(video) {
      const box = video.parentElement;
      if (!box || box.querySelector(".unmute-btn")) return;
      const b = document.createElement("button");
      b.className = "unmute-btn"; b.type = "button"; b.textContent = "\uD83D\uDD0A Tap to unmute";
      b.addEventListener("click", () => { video.muted = false; video.volume = 1; b.remove(); });
      video.addEventListener("volumechange", () => { if (!video.muted) b.remove(); });
      box.appendChild(b);
    }
    // Start with sound. If the browser blocks unmuted autoplay, start muted and offer a one-tap unmute.
    function tryPlayUnmuted(video) {
      if (!video) return;
      video.muted = false; video.volume = 1;
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => {
          video.muted = true;
          const q = video.play();
          const done = () => showUnmuteBtn(video);
          if (q && q.then) q.then(done).catch(() => {}); else done();
        });
      }
    }
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
        tryPlayUnmuted(box.querySelector("video"));
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
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => tryPlayUnmuted(video));
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = "/api/hls?url=" + encodeURIComponent(url);
        video.addEventListener("loadedmetadata", () => tryPlayUnmuted(video), { once: true });
      } else throw new Error("HLS not supported in this browser.");
      setupSkipButtons(video);
    }
    let directOff = false;
    try { directOff = sessionStorage.getItem("sa.direct.off") === "1"; } catch (e) {}
    function markDirectOff() { directOff = true; try { sessionStorage.setItem("sa.direct.off", "1"); } catch (e) {} }
    function showEmbed(embedUrl) {
      playerBox().innerHTML =
        '<iframe src="' + esc(embedUrl) + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen frameborder="0"></iframe>';
    }
    async function playEmbed(embedUrl) {
      watch.embedUrl = embedUrl;
      renderWatchBar();
      if (directOff) { showEmbed(embedUrl); return; }
      showPlayerLoading("Resolving direct stream…");
      try {
        const response = await fetch("/api/direct?url=" + encodeURIComponent(embedUrl));
        if (response.status === 404) { markDirectOff(); showEmbed(embedUrl); return; }
        if (!response.ok) throw new Error("Resolver HTTP " + response.status + ".");
        const direct = await response.json();
        if (direct.unavailable) { markDirectOff(); showEmbed(embedUrl); return; }
        if (!direct.url) throw new Error(direct.reason || "Could not resolve a direct stream.");
        watch.skip = { intro: direct.intro, outro: direct.outro };
        await playDirect(direct.url, direct.tracks || []);
      } catch (err) {
        showPlayerError(err.message + " — playing embed instead.", embedUrl);
        showEmbed(embedUrl);
      }
      renderWatchBar();
    }
    function renderWatchBar() {
      const bar = document.getElementById("watch-bar");
      const epLabel = watch.episode ? "Episode " + watch.episode + (watch.epCount ? " / " + watch.epCount : "") : "";
      const hasSub = watch.servers.some(s => s.type === "sub");
      const hasDub = watch.servers.some(s => s.type === "dub");
      const list = serversForMode();
      bar.innerHTML =
        '<div class="watch-meta"><strong>' + esc(epLabel || watch.title) + "</strong></div>" +
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
          : "");
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
        '<img class="poster" loading="lazy" decoding="async" src="' + esc(item.poster) + '" alt="' + esc(title) + ' poster" onerror="this.onerror=null;this.src=\'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22270%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23151b27%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 fill=%22%23aab3c4%22 font-size=%2214%22 text-anchor=%22middle%22%3ENo poster%3C/text%3E%3C/svg%3E\'">' +
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
        try { renderCards("top-cards", (await kitsuBrowse({ page: 1, search: "" })).items); }
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
      if (it.kind === "anikoto") openAnikotoSeries(it.id);
      else openMetadataDetail({ kind: it.kind, id: it.id });
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
    let lastFocus = null;
    function openModal() {
      lastFocus = document.activeElement;
      modal.classList.add("open"); document.body.style.overflow = "hidden";
      const closeBtn = document.getElementById("modal-close");
      if (closeBtn) closeBtn.focus({ preventScroll: true });
    }
    function trapFocus(e) {
      const nodes = Array.from(modal.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(n => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function hideModal() {
      routePushed = false;
      modal.classList.remove("open"); document.body.style.overflow = "";
      stopPlayer(); modalInner.innerHTML = "";
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === "function") { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
      lastFocus = null;
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
        '<div class="modal-actions">' +
          '<button type="button" class="act-btn' + (isInList(a.kind, a.id) ? " on" : "") + '" data-list-toggle>' + (isInList(a.kind, a.id) ? "\u2665 In My List" : "\u2661 Add to My List") + "</button>" +
          '<button type="button" class="act-btn" data-share>Share \u2197</button></div>' +
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
      const hist = modalState.item ? historyEntry(modalState.item.kind, modalState.item.id) : null;
      const seen = new Set(hist && Array.isArray(hist.watched) ? hist.watched.map(String) : []);
      let grid = '<div class="ep-list">';
      for (let i = from; i < to; i++) {
        const active = watch.episode != null && epNum(eps[i], i) === watch.episode;
        grid += '<button class="ep-btn ep-row' + (active ? " active" : "") + (seen.has(String(epNum(eps[i], i))) ? " seen" : "") + '" data-ep-index="' + i + '" aria-label="Play episode ' + esc(epNum(eps[i], i)) + '">' + esc(epNum(eps[i], i)) + "</button>";
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
      let resume = "";
      const hist = modalState.item ? historyEntry(modalState.item.kind, modalState.item.id) : null;
      if (hist) {
        const ri = episodes.findIndex((ep, i) => String(epNum(ep, i)) === String(hist.episode));
        if (ri >= 0) {
          modalState.epChunk = Math.floor(ri / EP_CHUNK);
          resume = '<button class="resume-btn" type="button" data-ep-index="' + ri + '">\u25b6 Continue Episode ' + esc(hist.episode) + "</button>";
        }
      }
      return '<h3 style="margin:18px 0 10px;font-size:15px">Episodes (' + episodes.length + ')</h3>' + resume + '<div id="ep-wrap">' + epListInner() + "</div>";
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
      const resumeBtn = document.querySelector(".resume-btn");
      if (resumeBtn) resumeBtn.remove(); // already continuing, so the button isn't needed any more
      openPlayer();
      watch.title = modalState.item.title;
      watch.episode = ep.n != null ? ep.n : index + 1;
      watch.epCount = modalState.episodes.length;
      recordHistory(modalState.item, watch.episode, watch.epCount);
      watch.mode = loadPrefs().mode === "dub" ? "dub" : "sub";
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
          if (watch.mode === "dub" && !watch.servers.some(s => s.type === "dub")) watch.mode = "sub";
          const list = serversForMode();
          watch.serverIdx = preferredServerIndex(list);
          renderWatchBar();
          const server = list[watch.serverIdx];
          if (!server) throw new Error("No servers available.");
          await playServer(server);
        } else {
          watch.servers = []; watch.serverIdx = 0;
          renderWatchBar();
          showPlayerLoading("Fetching server…");
          let embedUrl = await modalState.getEmbed(ep, watch.mode);
          if (!embedUrl && watch.mode !== "sub") { watch.mode = "sub"; renderWatchBar(); embedUrl = await modalState.getEmbed(ep, "sub"); }
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
      savePref("mode", mode);
      try {
        if (modalState.epData) {
          const list = serversForMode();
          renderWatchBar();
          if (!list.length) { showPlayerError("No " + mode.toUpperCase() + " servers for this episode."); return; }
          watch.serverIdx = preferredServerIndex(list);
          renderWatchBar();
          await playServer(list[watch.serverIdx]);
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
      if (server.name) savePref("server", server.name);
      renderWatchBar();
      try { await playServer(server); }
      catch (err) { showPlayerError(err.message, watch.embedUrl); }
    }

    /* path A: your catalog series (embed_url per episode) */
    async function openAnikotoSeries(id) {
      routePush("anikoto", id);
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
      routePush(item.kind, item.id);
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
      const listRm = event.target.closest("[data-list-remove]");
      if (listRm) { event.stopPropagation(); removeFromList(listRm.dataset.listRemove); return; }
      const listTg = event.target.closest("[data-list-toggle]");
      if (listTg && modalState.item) {
        const on = toggleList(modalState.item);
        listTg.classList.toggle("on", on);
        listTg.textContent = on ? "\u2665 In My List" : "\u2661 Add to My List";
        return;
      }
      const shareBtn = event.target.closest("[data-share]");
      if (shareBtn && modalState.item) { await shareItem(modalState.item, shareBtn); return; }
      const histRemove = event.target.closest("[data-hist-remove]");
      if (histRemove) { event.stopPropagation(); removeHistory(histRemove.dataset.histRemove); return; }
      if (event.target.closest("[data-hist-clear]")) { clearHistory(); return; }
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
      if (e.key === "Tab" && modal.classList.contains("open")) trapFocus(e);
      if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("anime-card")) { e.preventDefault(); e.target.click(); }
    });
    document.addEventListener("click", async e => {
      const button = e.target.closest("[data-refresh]");
      if (!button || button.dataset.busy) return;
      const key = button.dataset.refresh, label = button.textContent;
      button.dataset.busy = "1"; button.textContent = "Loading…"; gqlFresh = true;
      try {
        if (key === "top") await loadTop();
        else if (key === "season") await loadSeason();
        else if (key === "airing") await loadAiring();
        else { cache.clear(); await loadRecent(); }
      } finally {
        gqlFresh = false;
        if (button.isConnected) { delete button.dataset.busy; button.textContent = label === "Retry" ? "Retry" : "Refresh \u21bb"; }
      }
    });
    function closeMenu() { document.querySelector("nav").style.cssText = ""; }
    document.querySelectorAll('nav[aria-label="Main navigation"] a').forEach(a => a.addEventListener("click", closeMenu));
    document.getElementById("menu-btn").addEventListener("click", () => {
      const nav = document.querySelector("nav");
      const open = nav.style.display === "flex";
      nav.style.cssText = open ? "" : "display:flex;position:absolute;top:61px;left:0;right:0;background:#0b0e15;padding:18px;flex-direction:column;align-items:flex-start;border-bottom:1px solid #ffffff20";
    });

    /* ===================== watch history ===================== */
    const HISTORY_KEY = "syncanime.history.v1";
    const HISTORY_MAX = 40;
    function loadHistory() {
      try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    function saveHistoryList(list) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* storage full or blocked */ }
    }
    function historyEntry(kind, id) {
      if (!kind || id == null) return null;
      return loadHistory().find(h => h.kind === kind && String(h.id) === String(id)) || null;
    }
    function recordHistory(item, episode, epCount) {
      if (!item || !item.kind || item.id == null || episode == null) return;
      const list = loadHistory();
      const idx = list.findIndex(h => h.kind === item.kind && String(h.id) === String(item.id));
      const prev = idx >= 0 ? list.splice(idx, 1)[0] : null;
      const watched = new Set(prev && Array.isArray(prev.watched) ? prev.watched.map(String) : []);
      watched.add(String(episode));
      list.unshift({
        kind: item.kind, id: String(item.id), title: item.title || "Untitled", poster: item.poster || "",
        score: item.score != null ? item.score : null, episode, epCount: epCount || 0,
        watched: Array.from(watched).slice(-600), ts: Date.now(),
      });
      saveHistoryList(list);
      renderHistory();
    }
    function removeHistory(key) {
      const i = key.indexOf("|");
      const kind = key.slice(0, i), id = key.slice(i + 1);
      saveHistoryList(loadHistory().filter(h => !(h.kind === kind && String(h.id) === id)));
      renderHistory();
    }
    function clearHistory() {
      if (!window.confirm("Clear your watch history?")) return;
      try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
      renderHistory();
    }
    function historyCardHtml(h) {
      const label = "Ep " + h.episode + (h.epCount ? " / " + h.epCount : "");
      const html = cardHtml({ kind: h.kind, id: h.id, title: h.title, poster: h.poster, score: h.score, genres: [label], type: label });
      return html.replace("</article>", '<button class="hist-remove" type="button" aria-label="Remove from history" data-hist-remove="' + esc(h.kind + "|" + h.id) + '">\u00d7</button></article>');
    }
    let historyForce = false; // set when the menu's History link is tapped, so the section shows even if empty
    function renderHistory() {
      const sec = document.getElementById("history-section");
      if (!sec) return;
      const list = loadHistory().slice(0, 20);
      sec.hidden = list.length === 0 && !historyForce;
      const clearBtn = sec.querySelector("[data-hist-clear]");
      if (clearBtn) clearBtn.hidden = list.length === 0;
      document.getElementById("history-cards").innerHTML = list.length
        ? list.map(historyCardHtml).join("")
        : '<div class="empty">No watch history yet. Play an episode and it will show up here.</div>';
    }
    function showHistorySection() {
      historyForce = true;
      renderHistory();
      const sec = document.getElementById("history-section");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const navHistory = document.getElementById("nav-history");
    if (navHistory) navHistory.addEventListener("click", e => { e.preventDefault(); showHistorySection(); });

    /* ===================== preferences ===================== */
    const PREFS_KEY = "syncanime.prefs.v1";
    function loadPrefs() {
      try { const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
    }
    function savePref(key, value) {
      const p = loadPrefs(); p[key] = value;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
    }
    function preferredServerIndex(list) {
      const name = loadPrefs().server;
      const i = name ? list.findIndex(sv => sv.name === name) : -1;
      return i >= 0 ? i : 0;
    }

    /* ===================== my list (watchlist) ===================== */
    const LIST_KEY = "syncanime.list.v1";
    let listForce = false;
    function loadList() {
      try { const v = JSON.parse(localStorage.getItem(LIST_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    function saveList(list) {
      try { localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(0, 300))); } catch (e) {}
    }
    function isInList(kind, id) {
      return !!kind && id != null && loadList().some(x => x.kind === kind && String(x.id) === String(id));
    }
    function toggleList(item) {
      if (!item || !item.kind || item.id == null) return false;
      let list = loadList();
      const had = list.some(x => x.kind === item.kind && String(x.id) === String(item.id));
      if (had) list = list.filter(x => !(x.kind === item.kind && String(x.id) === String(item.id)));
      else list.unshift({ kind: item.kind, id: String(item.id), title: item.title || "Untitled", poster: item.poster || "", score: item.score != null ? item.score : null, type: item.type || "Anime", ts: Date.now() });
      saveList(list);
      renderMyList();
      return !had;
    }
    function removeFromList(key) {
      const i = key.indexOf("|");
      const kind = key.slice(0, i), id = key.slice(i + 1);
      saveList(loadList().filter(x => !(x.kind === kind && String(x.id) === id)));
      renderMyList();
    }
    function renderMyList() {
      const sec = document.getElementById("list-section");
      if (!sec) return;
      const list = loadList();
      sec.hidden = list.length === 0 && !listForce;
      document.getElementById("list-cards").innerHTML = list.length
        ? list.map(x => cardHtml({ kind: x.kind, id: x.id, title: x.title, poster: x.poster, score: x.score, genres: [], type: x.type })
            .replace("</article>", '<button class="hist-remove" type="button" aria-label="Remove from My List" data-list-remove="' + esc(x.kind + "|" + x.id) + '">\u00d7</button></article>')).join("")
        : '<div class="empty">Your list is empty. Open an anime and tap \u201cAdd to My List\u201d.</div>';
    }
    function showListSection() {
      listForce = true; renderMyList();
      const sec = document.getElementById("list-section");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    /* ===================== airing today ===================== */
    const AIRING_QUERY = `query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id title{romaji english} coverImage{large} format averageScore isAdult}}}}`;
    function fmtSpan(sec) {
      const m = Math.max(1, Math.round(Math.abs(sec) / 60));
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      return h < 24 ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : Math.floor(h / 24) + "d";
    }
    async function loadAiring() {
      const el = document.getElementById("airing-cards");
      if (!el) return;
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      try {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        const from = Math.floor(d.getTime() / 1000) - 1;
        const data = await gql(AIRING_QUERY, { from, to: from + 86402 });
        const now = Math.floor(Date.now() / 1000);
        const seen = new Set(), up = [], done = [];
        for (const row of data.Page.airingSchedules) {
          const m = row.media;
          if (!m || m.isAdult || seen.has(m.id)) continue;
          seen.add(m.id);
          const diff = row.airingAt - now;
          const label = "Ep " + row.episode + " \u00b7 " + (diff > 0 ? "in " + fmtSpan(diff) : fmtSpan(diff) + " ago");
          const item = { kind: "anilist", id: String(m.id), title: (m.title && (m.title.english || m.title.romaji)) || "Untitled", poster: m.coverImage ? m.coverImage.large : "", score: typeof m.averageScore === "number" && m.averageScore > 0 ? m.averageScore / 10 : null, genres: [label], type: label };
          (diff > 0 ? up : done).push({ at: row.airingAt, item });
        }
        up.sort((a, b) => a.at - b.at); done.sort((a, b) => b.at - a.at);
        const items = up.concat(done).slice(0, 24).map(x => x.item);
        if (!items.length) el.innerHTML = '<div class="empty">No episodes scheduled today.</div>';
        else el.innerHTML = items.map(cardHtml).join("");
      } catch (error) {
        el.innerHTML = '<div class="empty">' + esc(error.message) + ' <button class="btn" data-refresh="airing">Retry</button></div>';
      }
    }

    /* ===================== share + back-button routing ===================== */
    const PATH_RE = /^\/anime\/([a-z]+)\/([^/]+)\/?$/;
    const HASH_RE = /^#\/anime\/([a-z]+)\/(.+)$/; // old-style links
    let routePushed = false, routeSilent = false;
    function routePath(kind, id) { return "/anime/" + kind + "/" + encodeURIComponent(id); }
    function currentRoute() {
      let m = location.pathname.match(PATH_RE) || location.hash.match(HASH_RE);
      if (!m) return null;
      try { return { kind: m[1], id: decodeURIComponent(m[2]) }; } catch (e) { return null; }
    }
    function routePush(kind, id) {
      if (routeSilent || kind == null || id == null) return;
      try { history.pushState({ sa: 1 }, "", routePath(kind, id)); routePushed = true; } catch (e) { routePushed = false; }
    }
    function closeModal() {
      if (!modal.classList.contains("open")) return;
      if (routePushed) { history.back(); return; } // popstate hides the modal
      if (currentRoute()) { try { history.replaceState(null, "", "/"); } catch (e) {} }
      hideModal();
    }
    function openFromRoute(kind, id) {
      routeSilent = true; routePushed = false;
      try { return kind === "anikoto" ? openAnikotoSeries(id) : openMetadataDetail({ kind, id }); }
      finally { routeSilent = false; }
    }
    window.addEventListener("popstate", () => {
      const r = currentRoute();
      if (r) openFromRoute(r.kind, r.id);
      else if (modal.classList.contains("open")) hideModal();
    });
    async function shareItem(item, btn) {
      const url = location.origin + routePath(item.kind, item.id);
      const original = btn.textContent;
      try {
        if (navigator.share) { await navigator.share({ title: item.title, text: "Watch " + item.title + " on SyncAnime", url }); return; }
        await navigator.clipboard.writeText(url);
        btn.textContent = "Link copied \u2713";
      } catch (e) {
        if (e && e.name === "AbortError") return;
        window.prompt("Copy this link:", url);
      }
      setTimeout(() => { btn.textContent = original; }, 1600);
    }

    /* ===================== install prompt ===================== */
    let deferredInstall = null;
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault(); deferredInstall = e;
      const n = document.getElementById("nav-install"); if (n) n.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      const n = document.getElementById("nav-install"); if (n) n.hidden = true;
    });
    const navInstall = document.getElementById("nav-install");
    if (navInstall) navInstall.addEventListener("click", async e => {
      e.preventDefault(); closeMenu();
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (err) {}
      deferredInstall = null; navInstall.hidden = true;
    });
    const navList = document.getElementById("nav-list");
    if (navList) navList.addEventListener("click", e => { e.preventDefault(); showListSection(); });

    /* ===================== init ===================== */
    (async function init() {
      renderHistory();
      renderMyList();
      const startRoute = currentRoute();
      if (startRoute) openFromRoute(startRoute.kind, startRoute.id);
      setStatus("Loading catalog…");
      await loadRecent(); // the row at the top loads right away
      // Rows further down load when you scroll near them (saves requests and speeds up the first view)
      const lazyRows = [["top-rated", loadTop], ["season", loadSeason], ["airing", loadAiring]];
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(entries => entries.forEach(en => {
          if (en.isIntersecting) { io.unobserve(en.target); if (en.target._load) en.target._load(); }
        }), { rootMargin: "700px 0px" });
        lazyRows.forEach(([id, fn]) => { const el = document.getElementById(id); if (el) { el._load = fn; io.observe(el); } });
      } else {
        await Promise.all(lazyRows.map(([, fn]) => fn()));
      }
      setStatus("Ready · recently updated from catalog API · top/season from AniList · search works across AniList + Kitsu.");
    })();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

