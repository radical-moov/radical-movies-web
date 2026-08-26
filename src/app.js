const IMG = 'https://image.tmdb.org/t/p';
const POSTER = (p) => p ? `${IMG}/w342${p}` : '/no-poster.svg';
const BACKDROP = (b) => b ? `${IMG}/w1280${b}` : '';

// Button label for titles we don't hold yet — sets the expectation that a
// request isn't instant (it downloads + transcodes in the background).
const REQUEST_LABEL = '⬇ Request (10m–60m)';

// ── Shareable per-title URLs ─────────────────────────────────────────────────
// Opening a title reflects it in the address bar as /watch/{type}/{id}/{slug}
// (mirrors the server's SEO slug). We only replaceState — the history entry is
// still the one ensureAwayState() pushed, so Back closes the modal as before.
// Copy that URL / reload and the app re-opens the same title (see handleDeepLink).
function slugifyTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'title';
}
function setTitleUrl(type, id, title, year) {
  const y = year ? `-${year}` : '';
  try { history.replaceState(history.state, '', `/watch/${type}/${id}/${slugifyTitle(title)}${y}`); } catch {}
}
function clearTitleUrl() {
  if (/^\/watch\//.test(location.pathname)) {
    try { history.replaceState(history.state, '', '/'); } catch {}
  }
}

// TMDB direct browser calls (bypasses server IP restrictions)
const TMDB_KEY = '0330d4c885535dbcbfc3a1085e098571';
const TMDB = 'https://api.themoviedb.org/3';
const tmdbHeaders = {
  Authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIwMzMwZDRjODg1NTM1ZGJjYmZjM2ExMDg1ZTA5ODU3MSIsIm5iZiI6MTc4MjU3NzkzNC45MTgwMDAyLCJzdWIiOiI2YTNmZmIwZTg5YzkzZGQwNzY5ZjNmOWIiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.t2IbUYP_18EI_9IxzPLhVDP7jUCKTTBeRXbZmFFfOgQ`,
};

// TMDB response cache. The homepage fires ~40 TMDB calls on every load and the
// data barely changes day-to-day, so cache non-search reads in memory (instant
// in-session) and localStorage (instant across reloads) with a short TTL. Search
// is never cached so results stay fresh.
const _tmdbMem = new Map();
const TMDB_TTL = 3 * 60 * 60 * 1000; // 3h
function _tmdbSet(key, entry) {
  try { localStorage.setItem('tmdb:' + key, JSON.stringify(entry)); }
  catch {
    // Quota hit — drop all cached tmdb entries and retry once (self-healing).
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('tmdb:')) localStorage.removeItem(k);
      localStorage.setItem('tmdb:' + key, JSON.stringify(entry));
    } catch {}
  }
}
async function tmdb(path, params = {}) {
  const url = new URL(`${TMDB}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key       = url.pathname + url.search;
  const cacheable = !/\/search\//.test(path);
  const now       = Date.now();

  if (cacheable) {
    const mem = _tmdbMem.get(key);
    if (mem && now - mem.t < TMDB_TTL) return mem.v;
    try {
      const raw = localStorage.getItem('tmdb:' + key);
      if (raw) { const o = JSON.parse(raw); if (now - o.t < TMDB_TTL) { _tmdbMem.set(key, o); return o.v; } }
    } catch {}
  }

  const res = await fetch(url, { headers: tmdbHeaders });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const data = await res.json();

  if (cacheable) {
    const entry = { t: now, v: data };
    _tmdbMem.set(key, entry);
    _tmdbSet(key, entry);
  }
  return data;
}

// ── State ──────────────────────────────────────────────────────────────────
let heroMovies = [];
let heroIdx = 0;
let heroTimer = null;
let currentJobId = null;
let socket = null;
let currentSection = 'home'; // 'home' | 'tv' | 'library'
let loggedInUser = null;
let libraryPollTimer = null;
let libraryData = [];
let catalogData = [];
let _libraryFetchFailed = false; // avoids toast-spam on the 5s poll loop
let _watchProgress = {};
let _lastProgressSave = 0;
let _currentPosterPath = null;
let _nowPlaying = null;        // { type, showId, showName, season, episode } for TV
// Past this % we assume the title is finished: drop it from Continue Watching
// and stop offering to resume it.
const FINISH_PCT = 90;
let _autoNextTimer   = null;
let _autoNextPending = null; // { jobId, next } while waiting for episode to download

// Still-watching prompt removed — to be re-added later
let _partyRoomId = null;
let _partyIsHost = false;
let _partyEnabled = false;     // true once party panel is open
let _watchlist = [];
let _ratings = {};
let _watchedTmdbSet = new Set();

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const heroBg         = $('heroBg');
const heroTitle      = $('heroTitle');
const heroMeta       = $('heroMeta');
const heroDesc       = $('heroDesc');
const heroWatch      = $('heroWatch');
const heroInfo       = $('heroInfo');
const searchInput    = $('searchInput');
const searchClear    = $('searchClear');
const searchResults  = $('searchResults');
const searchGrid     = $('searchGrid');
// searchHeading removed — search now shows Movies + TV sections separately
const heroEl         = $('hero');
const rows           = $('rows');
const tvRows         = $('tvRows');
const librarySection = $('librarySection');
const libraryGrid    = $('libraryGrid');
const libBadge       = $('libBadge');
const bottomBadge    = $('bottomBadge');
const navUsername    = $('navUsername');
const logoutBtn      = $('logoutBtn');
const modalWrap      = $('modalWrap');
const modalBackdrop  = $('modalBackdrop');
const modalClose     = $('modalClose');
const modalHero      = $('modalHero');
const modalTitle     = $('modalTitle');
const modalMeta      = $('modalMeta');
const modalOverview  = $('modalOverview');
const modalRight     = $('modalRight');
const modalActions   = $('modalActions');
const modalWatch     = $('modalWatch');
const modalSimilar   = $('modalSimilar');
const tvModalWrap    = $('tvModalWrap');
const tvModalBackdrop = $('tvModalBackdrop');
const tvModalClose   = $('tvModalClose');
const tvModalHero    = $('tvModalHero');
const tvModalTitle   = $('tvModalTitle');
const tvModalMeta    = $('tvModalMeta');
const tvModalOverview = $('tvModalOverview');
const tvModalRight   = $('tvModalRight');
const tvSeasons      = $('tvSeasons');
const tvModalSimilar = $('tvModalSimilar');
const fetchOverlay   = $('fetchOverlay');
const fetchClose     = $('fetchClose');
const fetchTitle     = $('fetchTitle');
const fetchStatus    = $('fetchStatus');
const progressWrap   = $('progressWrap');
const progressFill   = $('progressFill');
const progressInfo   = $('progressInfo');
const playerOverlay  = $('playerOverlay');
const playerClose    = $('playerClose');
const playerTitle    = $('playerTitle');
const videoEl        = $('videoEl');

// ── Socket setup ───────────────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ['polling'] });

  socket.on('connect', () => {
    if (currentJobId) socket.emit('watch:join', currentJobId);
  });


  socket.on('job:update', (job) => {
    // Auto-next loading: episode finished downloading while we wait
    if (_autoNextPending && job.id === _autoNextPending.jobId) {
      if (job.status === 'ready' && job.streamUrl) {
        const { next } = _autoNextPending;
        _autoNextPending = null;
        $('autoNextLoadingRow').hidden = true;
        $('autoNextReadyRow').hidden   = false;
        fetchLibrary();
        showAutoNext({ ...next, streamUrl: job.streamUrl, jobId: job.id });
        return;
      }
      if (job.message) $('autoNextLoadingMsg').textContent = job.message;
      if (job.status === 'error') {
        cancelAutoNext();
        toast('Could not load next episode: ' + (job.error || 'unknown error'));
      }
      return;
    }
    if (job.id !== currentJobId) return;
    updateFetchUI(job);
    // No auto-play on ready — the dedicated job:ready handler shows a clear
    // "ready to watch" notification instead.
  });

  socket.on('job:ready', ({ jobId, streamUrl, title }) => {
    if (_autoNextPending && jobId === _autoNextPending.jobId) {
      const { next } = _autoNextPending;
      _autoNextPending = null;
      $('autoNextLoadingRow').hidden = true;
      $('autoNextReadyRow').hidden   = false;
      fetchLibrary();
      showAutoNext({ ...next, streamUrl, jobId });
      return;
    }
    // A title the user requested just finished downloading. Don't auto-play —
    // show a clear, tappable "ready to watch" notification (client only receives
    // job:ready for jobs it requested/joined).
    notifyReady(jobId, streamUrl, title);
  });

  socket.on('job:error', ({ jobId, error }) => {
    if (jobId !== currentJobId) return;
        fetchOverlay.hidden = true;
    toast(`Error: ${error}`);
  });
}

// ── API helpers ────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── Auth ───────────────────────────────────────────────────────────────────
let _profileData = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json();
    loggedInUser = data.username;
    navUsername.textContent = loggedInUser;
    const init = loggedInUser[0]?.toUpperCase() || '?';
    const ba = $('navAvatarInit'); if (ba) ba.textContent = init;
    const bb = $('bottomAvatar');  if (bb) bb.textContent = init;
    if (!data.paid) { location.href = '/upgrade'; return; }
    const expiresAt = data.inTrial ? data.trialEndsAt : data.accessExpiresAt;
    if (expiresAt && Date.now() < expiresAt) startExpiryBanner(expiresAt, data.inTrial ? 'trial' : 'access');
    // Load profile in background to set avatar and color
    loadProfileBackground();
  } catch {
    location.href = '/login';
  }
}

async function loadProfileBackground() {
  try {
    const res = await fetch('/api/profile');
    if (!res.ok) return;
    _profileData = await res.json();
    applyProfileToNav(_profileData);
  } catch {}
}

function applyProfileToNav(p) {
  if (!p) return;
  // Username color
  if (p.profileColor) navUsername.style.color = p.profileColor;
  const initial = (p.username || '?')[0].toUpperCase();
  // Avatar in top nav
  const img  = $('navAvatar');
  const init = $('navAvatarInit');
  if (p.avatar) {
    img.src = p.avatar;
    img.hidden = false;
    init.hidden = true;
  } else {
    init.textContent = initial;
    init.style.background = p.profileColor || '#333';
    init.hidden = false;
    img.hidden = true;
  }
  // Avatar in bottom nav
  const bottomAvatar = $('bottomAvatar');
  if (bottomAvatar) {
    if (p.avatar) {
      bottomAvatar.textContent = '';
      bottomAvatar.style.backgroundImage = `url(${p.avatar})`;
      bottomAvatar.style.backgroundSize = 'cover';
      bottomAvatar.style.backgroundPosition = 'center';
      bottomAvatar.style.background = '';
    } else {
      bottomAvatar.textContent = initial;
      bottomAvatar.style.backgroundImage = '';
      bottomAvatar.style.background = p.profileColor || '#333';
    }
  }
}

function startExpiryBanner(endsAt, type) {
  const banner = $('trialBanner');
  const text   = $('trialText');
  if (!banner || !text) return;

  function update() {
    const ms = endsAt - Date.now();
    if (ms <= 0) { location.href = '/upgrade'; return; }
    const days = Math.floor(ms / 86400000);
    const h    = Math.floor((ms % 86400000) / 3600000);
    const m    = Math.floor((ms % 3600000) / 60000);
    const timeStr = days > 1 ? `${days}d ${h}h` : days === 1 ? `1d ${h}h` : `${h}h ${m}m`;
    const label   = type === 'trial' ? 'Free trial' : 'Access';
    text.textContent = `⏳ ${label} expires in ${timeStr}`;
    banner.hidden = false;
    document.body.classList.add('has-trial-banner');
  }

  update();
  setInterval(update, 60000);
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  await checkAuth();
  initSocket();
  setupNav();
  setupSearch();
  setupMobileSearch();
  setupPlayerControls();
  setupSubtitles();
  setupEpisodesPanel();
  setupCast();
  setupParty();
  setupProfile();
  setupLists();
  setupFeedback();
  showRowSkeletons(rows);
  startLibraryPolling();
  loadAll();
  loadListsRow();
  restoreVideoState();
  handleDeepLink();
}

// On boot, if the URL is a shared per-title link (/watch/{type}/{id}/...), open
// that title's modal. We reset the address bar to "/" first so the underlying
// history entry is the homepage (Back / close leave you there, not on a dangling
// /watch URL). Wait for the catalog so the Play/Request button state is correct.
async function handleDeepLink() {
  const m = location.pathname.match(/^\/watch\/(movie|tv)\/(\d+)/);
  if (!m) return;
  const [, type, id] = m;
  try { history.replaceState(history.state, '', '/'); } catch {}
  if (!catalogData.length) await fetchCatalog().catch(() => {});
  type === 'tv' ? openTVModal(Number(id)) : openModal(Number(id));
}

// Newly-released movies usually only have CAM/telesync/scam torrents for the
// first few months, so a request just fails or fetches garbage. Hide any movie
// released within this window UNLESS we already hold a verified, non-CAM copy.
const RELEASE_DELAY_DAYS = 90;

// CAM / telesync / predvd / scam markers — matches the server-side download gate
// (server/index.js CAM_RE) exactly. Note: only DVD screeners (dvd-scr) are flagged,
// NOT high-def WEB-DL "SCREENER" releases, which are watchable quality.
const CAM_RE = /(cam[\s._-]?rip|hd[\s._-]?cam|hq[\s._-]?cam|\bcam\b|tele[\s._-]?sync|tele[\s._-]?cine|hd[\s._-]?ts|\bts[\s._-]?rip\b|dvd[\s._-]?scr|work[\s._-]?print|pre[\s._-]?dvd|\bpdvd\b|\bhdts\b|\bhdcam\b)/i;

// A ready catalog item counts as verified-good unless its quality/filename looks
// like a CAM/scam (the pipeline already gates these at download time; this is a
// client backstop). Missing info → treated as good (never hides legit content).
function isVerifiedGood(item) {
  return !CAM_RE.test(`${item?.quality || ''} ${item?.file || ''} ${item?.title || ''}`);
}
function hasVerifiedGoodCopy(tmdbId) {
  return catalogData.some(c => c.type === 'movie' && c.tmdbId === tmdbId && c.streamUrl && isVerifiedGood(c));
}

function filterRecent(movies) {
  const cutoff = Date.now() - RELEASE_DELAY_DAYS * 24 * 60 * 60 * 1000;
  return movies.filter(m => {
    if (!m.release_date) return true;                                 // unknown date — leave as-is
    if (new Date(m.release_date).getTime() <= cutoff) return true;    // old enough — good torrents exist
    return hasVerifiedGoodCopy(m.id);                                 // recent — only if we have a verified copy
  });
}

async function loadAll() {
  // Load our verified catalog first so filterRecent can surface recent releases
  // we already hold a good copy of (and hide the rest).
  await fetchCatalog();
  const [
    trending, popular, topRated, nowPlaying,
    action, scifi, drama, comedy,
    horror, thriller, crime, animation, romance, documentary, western,
    eighties, nineties, twoThousands,
    hiddenGems, criticallyAcclaimed, boxOffice, epicWatches, quickFlicks,
    crimeThriller, actionComedy, scifiThriller, darkComedy,
    korean, japanese, french, spanish,
    heist, survival, timeTravel, revenge,
  ] = await Promise.allSettled([
    tmdb('/trending/movie/week'),
    tmdb('/movie/popular'),
    tmdb('/movie/top_rated'),
    tmdb('/movie/now_playing'),
    // single genres
    tmdb('/discover/movie', { with_genres: 28,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 878,   sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 18,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 35,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 27,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 53,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 80,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 16,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 10749, sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 99,    sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: 37,    sort_by: 'popularity.desc' }),
    // decades
    tmdb('/discover/movie', { 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1989-12-31', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { 'primary_release_date.gte': '2000-01-01', 'primary_release_date.lte': '2009-12-31', sort_by: 'popularity.desc' }),
    // curated mood
    tmdb('/discover/movie', { sort_by: 'vote_average.desc', 'vote_average.gte': 7.5, 'vote_count.gte': 200, 'vote_count.lte': 2000 }),
    tmdb('/discover/movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 5000, 'vote_average.gte': 8.0 }),
    tmdb('/discover/movie', { sort_by: 'revenue.desc', 'vote_count.gte': 500 }),
    tmdb('/discover/movie', { 'with_runtime.gte': 150, sort_by: 'vote_average.desc', 'vote_count.gte': 500 }),
    tmdb('/discover/movie', { 'with_runtime.lte': 90,  sort_by: 'popularity.desc',   'vote_count.gte': 200 }),
    // genre combos
    tmdb('/discover/movie', { with_genres: '80,53',  sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: '28,35',  sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: '878,53', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_genres: '35,80',  sort_by: 'popularity.desc' }),
    // language
    tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_original_language: 'ja', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_original_language: 'fr', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_original_language: 'es', sort_by: 'popularity.desc' }),
    // keywords
    tmdb('/discover/movie', { with_keywords: '10291', sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_keywords: '4565',  sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_keywords: '4379',  sort_by: 'popularity.desc' }),
    tmdb('/discover/movie', { with_keywords: '9748',  sort_by: 'popularity.desc' }),
  ]);

  const get = (r) => filterRecent(r.status === 'fulfilled' ? r.value.results ?? [] : []);

  // Surface a total catalog failure instead of leaving empty shimmer rows
  if ([trending, popular, topRated, nowPlaying].every(r => r.status === 'rejected')) {
    document.querySelectorAll('#rows .row-track .card-skeleton').forEach(el => el.remove());
    toast("Couldn't load the catalog — check your connection and refresh");
  }

  const trendingMovies = get(trending);
  heroMovies = trendingMovies.slice(0, 8);
  renderHero(heroMovies[0]);
  startHeroRotation();

  // Render rows in priority order, dropping any title already shown above so the
  // same movie never repeats across genres. Trending is first, so it keeps all.
  const seenIds = new Set();
  const browseRows = [
    ['rowTrending',            trendingMovies],
    ['rowPopular',             get(popular)],
    ['rowCriticallyAcclaimed', get(criticallyAcclaimed)],
    ['rowHiddenGems',          get(hiddenGems)],
    ['rowBoxOffice',           get(boxOffice)],
    ['row90s',                 get(nineties)],
    ['rowAction',              get(action)],
    ['rowHorror',              get(horror)],
    ['rowCrimeThriller',       get(crimeThriller)],
    ['row80s',                 get(eighties)],
    ['rowScifi',               get(scifi)],
    ['rowScifiThriller',       get(scifiThriller)],
    ['rowHeist',               get(heist)],
    ['rowThriller',            get(thriller)],
    ['row2000s',               get(twoThousands)],
    ['rowCrime',               get(crime)],
    ['rowKorean',              get(korean)],
    ['rowComedy',              get(comedy)],
    ['rowActionComedy',        get(actionComedy)],
    ['rowJapanese',            get(japanese)],
    ['rowDrama',               get(drama)],
    ['rowDarkComedy',          get(darkComedy)],
    ['rowFrench',              get(french)],
    ['rowAnimation',           get(animation)],
    ['rowRomance',             get(romance)],
    ['rowSpanish',             get(spanish)],
    ['rowDocumentary',         get(documentary)],
    ['rowEpicWatches',         get(epicWatches)],
    ['rowWestern',             get(western)],
    ['rowSurvival',            get(survival)],
    ['rowTimeTravel',          get(timeTravel)],
    ['rowRevenge',             get(revenge)],
    ['rowQuickFlicks',         get(quickFlicks)],
    ['rowTopRated',            get(topRated)],
    ['rowNowPlaying',          get(nowPlaying)],
  ];
  for (const [rowId, items] of browseRows) {
    renderRow(rowId, dedupeAcrossRows(items, seenIds), 'movie');
  }
}

async function loadTVRows() {
  if (tvRows.dataset.loaded) return;
  const [trending, popular, topRated] = await Promise.allSettled([
    tmdb('/trending/tv/week'),
    tmdb('/tv/popular'),
    tmdb('/tv/top_rated'),
  ]);
  const get = (r) => r.status === 'fulfilled' ? r.value.results ?? [] : [];
  const seenTv = new Set();
  renderRow('rowTVTrending', dedupeAcrossRows(get(trending), seenTv), 'tv');
  renderRow('rowTVPopular',  dedupeAcrossRows(get(popular),  seenTv), 'tv');
  renderRow('rowTVTopRated', dedupeAcrossRows(get(topRated), seenTv), 'tv');
  tvRows.dataset.loaded = '1';
}

// ── Hero ───────────────────────────────────────────────────────────────────
function renderHero(m) {
  if (!m) return;
  heroBg.style.backgroundImage = BACKDROP(m.backdrop_path) ? `url(${BACKDROP(m.backdrop_path)})` : '';
  heroTitle.textContent = m.title || m.name || '';
  heroMeta.innerHTML = [
    m.release_date ? `<span>${m.release_date.slice(0, 4)}</span>` : '',
    m.vote_average ? `<span>&#9733; ${m.vote_average.toFixed(1)}</span>` : '',
    m.original_language ? `<span>${m.original_language.toUpperCase()}</span>` : '',
  ].filter(Boolean).join('');
  heroDesc.textContent = m.overview || '';
  const heroCatalog = catalogData.find(c => c.tmdbId === m.id && c.type === 'movie');
  const heroLib     = libraryData.find(j => j.tmdbId === m.id && j.type === 'movie' && j.status !== 'error');
  const heroReady   = heroCatalog?.streamUrl || (heroLib?.status === 'ready' && heroLib?.streamUrl);
  const heroStream  = heroCatalog?.streamUrl || heroLib?.streamUrl;
  const heroTitle2  = m.title || m.name || '';

  if (heroReady) {
    heroWatch.textContent = '▶  Watch Now';
    heroWatch.disabled    = false;
    heroWatch.onclick     = () => openPlayer(heroStream, heroTitle2, m.poster_path);
  } else if (heroLib) {
    heroWatch.textContent = '✓ Requested';
    heroWatch.disabled    = true;
    heroWatch.onclick     = null;
  } else {
    heroWatch.textContent = REQUEST_LABEL;
    heroWatch.disabled    = false;
    heroWatch.onclick     = () => queueWatch(m);
  }
  heroInfo.onclick = () => openModal(m.id);
}

function startHeroRotation() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    heroIdx = (heroIdx + 1) % heroMovies.length;
    renderHero(heroMovies[heroIdx]);
  }, 8000);
}

// ── Row rendering ──────────────────────────────────────────────────────────
// A title is "ready" when we already hold a streamable copy — either in the
// public catalog or in this user's library. These jump to the front of a row so
// one-click-to-play titles lead, and slower Request-only titles follow.
function titleIsReady(m, type = 'movie') {
  const id = m?.id;
  if (id == null) return false;
  if (catalogData.some(c => c.tmdbId === id && c.type === type && c.streamUrl)) return true;
  return libraryData.some(j => j.tmdbId === id && j.type === type && j.status === 'ready' && j.streamUrl);
}

function renderRow(trackId, movies, type = 'movie') {
  const track = $(trackId);
  if (!track) return;
  track.innerHTML = '';
  // Hide the whole row (heading + track) when there's nothing to show — e.g. after
  // cross-row de-duplication leaves a genre row empty.
  const section = track.closest('.row');
  if (!movies || !movies.length) { if (section) section.hidden = true; return; }
  if (section) section.hidden = false;
  // Stable ready-first ordering: sort() is stable, so titles keep their original
  // relative order within the ready and not-ready groups (we sort before slicing
  // so a ready title past position 20 still surfaces).
  const ordered = [...movies].sort((a, b) => (titleIsReady(b, type) ? 1 : 0) - (titleIsReady(a, type) ? 1 : 0));
  for (const m of ordered.slice(0, 20)) {
    track.appendChild(createCard(m, type));
  }
}

// Filter out movies already shown in an earlier row (keeps first occurrence),
// so the same title doesn't repeat across Trending / Popular / genre rows.
function dedupeAcrossRows(items, seen) {
  const out = [];
  for (const m of items || []) {
    if (!m || m.id == null || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// Fill browse row tracks with shimmer skeletons while the catalog loads.
// renderRow() overwrites innerHTML, so real cards replace these automatically.
function showRowSkeletons(container, count = 8) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!el) return;
  el.querySelectorAll('.row-track').forEach(track => {
    if (track.children.length) return; // already has content
    track.innerHTML = Array.from({ length: count },
      () => '<div class="card-skeleton skeleton"></div>').join('');
  });
}

function createCard(m, type = 'movie', opts = {}) {
  const card = document.createElement('div');
  card.className = 'card' + (opts.caption ? ' card-captioned' : '');
  card.dataset.tmdbId = m.id;
  card.dataset.mediaType = type;
  const displayTitle = m.title || m.name || '';
  const year = m.release_date?.slice(0, 4) || m.first_air_date?.slice(0, 4) || '';
  const altText = displayTitle ? `${displayTitle} poster` : 'Poster';
  // opts.caption: a persistent title + year label under the poster (not the
  // hover overlay), so same-name titles are distinguishable on touch devices
  // — e.g. two "Will & Grace" shows show 1998 vs 2017.
  card.innerHTML = `
    <img class="card-img" src="${POSTER(m.poster_path)}" alt="${escHtml(altText)}" loading="lazy">
    <div class="card-info${opts.caption ? ' card-info-static' : ''}">
      <div class="card-title">${escHtml(displayTitle)}</div>
      <div class="card-meta">
        ${year ? `<span>${year}</span>` : (opts.caption && type === 'tv' ? '<span>TV series</span>' : '')}
        ${m.vote_average ? `<span class="card-rating">&#9733; ${m.vote_average.toFixed(1)}</span>` : ''}
      </div>
    </div>
  `;
  const open = () => { if (type === 'tv') openTVModal(m.id); else openModal(m.id); };
  makeCardActivatable(card, open, `${displayTitle}${year ? ', ' + year : ''} — view details`);
  return card;
}

// Make a card element keyboard-operable: click + Enter/Space, role & label.
function makeCardActivatable(card, handler, label) {
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  if (label) card.setAttribute('aria-label', label);
  card.addEventListener('click', handler);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
}

function updateCardBadges() {
  document.querySelectorAll('.card[data-tmdb-id]').forEach(card => {
    // Skip catalog cards — they always show their own badge
    if (card.classList.contains('catalog-card')) return;

    const id   = parseInt(card.dataset.tmdbId);
    const type = card.dataset.mediaType || 'movie';
    const job  = libraryData.find(j => j.tmdbId === id && j.type === type && j.status !== 'error');
    const cat  = !job && catalogData.find(c => c.tmdbId === id && c.type === type);

    let badge = card.querySelector('.card-lib-tag');
    if (!job && !cat) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'card-lib-tag';
      card.appendChild(badge);
    }
    if (cat) {
      badge.textContent = '▶ Ready'; badge.dataset.state = 'ready';
    } else if (job.status === 'ready') {
      badge.textContent = '▶ Ready'; badge.dataset.state = 'ready';
    } else if (job.status === 'downloading') {
      badge.textContent = `↓ ${job.progress ?? 0}%`; badge.dataset.state = 'active';
    } else if (job.status === 'uploading') {
      badge.textContent = `↑ ${job.progress ?? 0}%`; badge.dataset.state = 'active';
    } else if (job.status === 'queued') {
      badge.textContent = job.queuePosition ? `⌛ #${job.queuePosition}` : '⌛ Queued'; badge.dataset.state = 'active';
    } else {
      badge.textContent = '⌛'; badge.dataset.state = 'active';
    }
  });
}

// ── Movie Modal ────────────────────────────────────────────────────────────
let currentMovie = null;

async function openModal(tmdbId) {
  ensureAwayState();
  try {
    const m = await tmdb(`/movie/${tmdbId}`, { append_to_response: 'credits,videos,similar' });
    currentMovie = m;

    modalHero.style.backgroundImage = BACKDROP(m.backdrop_path)
      ? `url(${BACKDROP(m.backdrop_path)})`
      : '';

    modalTitle.textContent = m.title || '';

    const year    = m.release_date?.slice(0, 4) ?? '';
    const runtime = m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : '';
    _currentTrackGenres = (m.genres ?? []).map(g => g.name);
    const genres  = _currentTrackGenres.map(n => `<span class="meta-tag">${escHtml(n)}</span>`).join('');
    const rating  = m.vote_average ? `<span class="meta-tag meta-rating">&#9733; ${m.vote_average.toFixed(1)}</span>` : '';

    modalMeta.innerHTML = [
      year    ? `<span>${year}</span>`    : '',
      runtime ? `<span>${runtime}</span>` : '',
      rating,
      '<span class="meta-tag meta-quality">720p / 1080p</span>',
      genres,
    ].filter(Boolean).join('');

    modalOverview.textContent = m.overview || '';

    const director = m.credits?.crew?.find(c => c.job === 'Director');
    const castHtml = castLinksHtml(m.credits?.cast);

    modalRight.innerHTML = [
      director ? `<div><strong>Director:</strong> ${escHtml(director.name)}</div>` : '',
      castHtml ? `<div><strong>Cast:</strong> ${castHtml}</div>`                   : '',
      m.original_language ? `<div><strong>Language:</strong> ${m.original_language.toUpperCase()}</div>` : '',
      m.status ? `<div><strong>Status:</strong> ${escHtml(m.status)}</div>`        : '',
    ].filter(Boolean).join('');

    const similar = (m.similar?.results ?? []).slice(0, 12);
    if (similar.length) {
      const simRow = document.createElement('div');
      simRow.className = 'similar-row';
      similar.forEach(s => simRow.appendChild(createCard(s, 'movie')));
      modalSimilar.innerHTML = '<h3>More Like This</h3>';
      modalSimilar.appendChild(simRow);
    } else {
      modalSimilar.innerHTML = '';
    }

    // Show correct button state — check catalog first, then personal library
    const catalogItem = catalogData.find(c => c.tmdbId === m.id && c.type === 'movie');
    const inLibrary   = libraryData.find(j => j.tmdbId === m.id && j.type === 'movie' && j.status !== 'error');

    if (catalogItem?.streamUrl) {
      modalWatch.textContent = '▶  Play Now';
      modalWatch.disabled = false;
      modalWatch.onclick = () => { closeModal(); openPlayer(catalogItem.streamUrl, m.title, m.poster_path); };
    } else if (inLibrary?.status === 'ready') {
      modalWatch.textContent = '▶  Play';
      modalWatch.disabled = false;
      modalWatch.onclick = () => { closeModal(); openPlayer(inLibrary.streamUrl, m.title, m.poster_path); };
    } else if (inLibrary) {
      modalWatch.textContent = '✓ Requested';
      modalWatch.disabled = true;
    } else {
      modalWatch.textContent = REQUEST_LABEL;
      modalWatch.disabled = false;
      modalWatch.onclick = () => queueWatch(m);
    }
    // Clean up previous dynamic additions
    document.getElementById('modalWlBtn')?.remove();
    document.getElementById('modalListBtn')?.remove();
    document.getElementById('modalRatingWrap')?.remove();
    document.getElementById('modalWhyBox')?.remove();

    // Watchlist button
    const inWl = _watchlist.some(i => i.tmdbId === m.id && i.type === 'movie');
    const wlBtn = document.createElement('button');
    wlBtn.id = 'modalWlBtn';
    wlBtn.className = `btn btn-wl${inWl ? ' active' : ''}`;
    wlBtn.textContent = inWl ? '♥ Saved' : '♡ Save';
    wlBtn.addEventListener('click', () => toggleWatchlist(m.id, 'movie', m.title, m.poster_path, m.release_date?.slice(0, 4)));
    modalActions.appendChild(wlBtn);

    // Add to List button
    const listBtn = document.createElement('button');
    listBtn.id = 'modalListBtn';
    listBtn.className = 'btn btn-wl';
    listBtn.textContent = '+ List';
    listBtn.addEventListener('click', () => openAddToListModal(m.id, 'movie', m.title, m.poster_path, m.release_date?.slice(0, 4)));
    modalActions.appendChild(listBtn);

    // ▶ Trailer (self-hosted when available, else YouTube fallback)
    addTrailerButton(modalActions, 'modalTrailerBtn', 'movie', m.id, m.videos);

    // Star rating
    const ratingWrap = document.createElement('div');
    ratingWrap.id = 'modalRatingWrap';
    ratingWrap.className = 'modal-rating-wrap';
    modalSimilar.before(ratingWrap);
    renderStarRating('modalRatingWrap', 'movie', m.id);

    // Why you'll like this — async, non-blocking
    const openedId = m.id;
    buildWhyLikeThis(m, 'movie').then(reasons => {
      if (!reasons.length || modalWrap.hidden || currentMovie?.id !== openedId) return;
      document.getElementById('modalWhyBox')?.remove();
      const box = document.createElement('div');
      box.id = 'modalWhyBox';
      box.className = 'why-like-box';
      box.innerHTML = `<div class="why-like-title">Why you'll like this</div><ul class="why-like-list">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
      (document.getElementById('modalRatingWrap') || modalSimilar).before(box);
    }).catch(() => {});

    modalWrap.hidden = false;
    document.body.style.overflow = 'hidden';
    setTitleUrl('movie', m.id, m.title, m.release_date?.slice(0, 4));
  } catch (e) {
    toast('Failed to load movie details');
  }
}

function closeModal() {
  modalWrap.hidden = true;
  document.body.style.overflow = '';
  currentMovie = null;
  clearTitleUrl();
}

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', closeModal);

// ── Trailers ─────────────────────────────────────────────────────────────────
// Prefer our self-hosted copy (/api/trailer); fall back to a YouTube embed until
// the backfill has downloaded it. Deliberately NOT the main player, so watching a
// trailer never records watch progress or continue-watching state.
function pickTrailerKey(videos) {
  const list = (videos?.results || (Array.isArray(videos) ? videos : [])).filter(v => v && v.site === 'YouTube' && v.key);
  if (!list.length) return null;
  const score = v => (v.type === 'Trailer' ? 100 : v.type === 'Teaser' ? 50 : 10)
    + (v.official ? 20 : 0) + (/^en/i.test(v.iso_639_1 || '') ? 10 : 0) + Math.min(8, (v.size || 0) / 240);
  return list.map(v => ({ v, s: score(v) })).sort((a, b) => b.s - a.s)[0].v.key;
}

async function playTrailer(type, tmdbId, videos) {
  ensureAwayState();
  let data = { source: 'none' };
  try { data = await fetch(`/api/trailer/${type}/${tmdbId}`).then(r => r.ok ? r.json() : { source: 'none' }); } catch {}
  const inner = $('trailerInner');
  const ytKey = data.ytKey || pickTrailerKey(videos);
  if (data.source === 'self' && data.url) {
    inner.innerHTML = `<video src="${data.url}" controls autoplay playsinline x-webkit-airplay="allow"></video>`;
  } else if (ytKey) {
    inner.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytKey}?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  } else {
    toast('No trailer available'); return;
  }
  $('trailerOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeTrailer() {
  const inner = $('trailerInner');
  if (inner) inner.innerHTML = ''; // stops the <video>/<iframe> playing
  $('trailerOverlay').hidden = true;
  if (modalWrap.hidden && tvModalWrap.hidden && playerOverlay.hidden) document.body.style.overflow = '';
}
$('trailerClose').addEventListener('click', closeTrailer);
$('trailerOverlay').addEventListener('click', (e) => { if (e.target === $('trailerOverlay')) closeTrailer(); });

// Build the "▶ Trailer" modal button when a title actually has a trailer.
function addTrailerButton(container, btnId, type, tmdbId, videos) {
  document.getElementById(btnId)?.remove();
  if (!pickTrailerKey(videos)) return;
  const btn = document.createElement('button');
  btn.id = btnId;
  btn.className = 'btn btn-wl';
  btn.textContent = '▶ Trailer';
  btn.addEventListener('click', () => playTrailer(type, tmdbId, videos));
  container.appendChild(btn);
}

// Render a comma-separated list of cast members as clickable links (top 5).
// Clicking one opens that person's filmography (their movies/TV).
function castLinksHtml(castArr) {
  return (castArr ?? [])
    .filter(a => a && a.name && a.id)
    .slice(0, 5)
    .map(a => `<a href="#" class="cast-link" data-person-id="${a.id}" data-person-name="${escHtml(a.name)}">${escHtml(a.name)}</a>`)
    .join(', ');
}

// Close any open detail modal and show the given person's filmography, reusing
// the existing search/filmography view.
function openCastFilmography(personId, personName) {
  if (!personId) return;
  closeModal();
  closeTVModal();
  searchResults.hidden = false;
  heroEl.hidden = true;
  rows.hidden = true; tvRows.hidden = true; librarySection.hidden = true;
  searchInput.value = personName || '';
  searchClear.hidden = !searchInput.value;
  window.scrollTo(0, 0);
  openFilmography(personId, personName);
}

// Delegated: any .cast-link (in the movie or TV modal) → that actor's movies.
document.addEventListener('click', (e) => {
  const link = e.target.closest('.cast-link');
  if (!link) return;
  e.preventDefault();
  openCastFilmography(Number(link.dataset.personId), link.dataset.personName);
});

// ── TV Show Modal ──────────────────────────────────────────────────────────
let currentShow = null;
let currentTVSeason = 1;

// Per-show watch state for the episode list: which episodes are finished
// ("watched") and which one the user is mid-way through ("continue"). Populated
// when the TV modal opens (see loadTvWatchState) and read by loadEpisodes.
let _tvWatchedFrac = {};   // stored jobId  -> furthest-reached fraction (0..1)
let _tvProgressByEp = {};  // "season-episode" -> { pct, position } for THIS show
const EP_WATCHED_FRAC = 0.85;  // ≥ this of the runtime reached ⇒ treat as watched

async function loadTvWatchState(showId) {
  _tvWatchedFrac = {};
  _tvProgressByEp = {};
  try {
    const [prog, watched] = await Promise.all([
      fetch('/api/progress').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/watched').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    _tvWatchedFrac = watched || {};
    for (const rec of Object.values(prog || {})) {
      if (rec && rec.type === 'tv' && Number(rec.showId) === Number(showId)
          && rec.season != null && rec.episode != null) {
        _tvProgressByEp[`${rec.season}-${rec.episode}`] = { pct: rec.pct || 0, position: rec.position || 0 };
      }
    }
  } catch { /* highlighting is best-effort — never block the modal */ }
}

// Resolve the stored jobId for an episode (catalog copy first, then the user's
// library), so we can look up its watched fraction from history.
function episodeJobId(showId, season, episode) {
  const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == season && c.episode == episode);
  if (cat?.id) return cat.id;
  const job = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' && j.season == season && j.episode == episode && j.status !== 'error');
  return job?.id || null;
}

async function openTVModal(showId) {
  ensureAwayState();
  try {
    const show = await tmdb(`/tv/${showId}`, { append_to_response: 'credits,videos,similar' });
    currentShow = show;
    currentTVSeason = 1;

    tvModalHero.style.backgroundImage = BACKDROP(show.backdrop_path)
      ? `url(${BACKDROP(show.backdrop_path)})`
      : '';

    tvModalTitle.textContent = show.name || '';

    const year    = show.first_air_date?.slice(0, 4) ?? '';
    const seasons = show.number_of_seasons ? `${show.number_of_seasons} Season${show.number_of_seasons > 1 ? 's' : ''}` : '';
    _currentTrackGenres = (show.genres ?? []).map(g => g.name);
    const genres  = _currentTrackGenres.map(n => `<span class="meta-tag">${escHtml(n)}</span>`).join('');
    const rating  = show.vote_average ? `<span class="meta-tag meta-rating">&#9733; ${show.vote_average.toFixed(1)}</span>` : '';

    tvModalMeta.innerHTML = [
      year    ? `<span>${year}</span>`    : '',
      seasons ? `<span>${seasons}</span>` : '',
      rating,
      tvStatusLabel(show.status, show.last_air_date),
      genres,
    ].filter(Boolean).join('');

    tvModalOverview.textContent = show.overview || '';

    const creator = show.created_by?.[0];
    const castHtml = castLinksHtml(show.credits?.cast);
    tvModalRight.innerHTML = [
      creator  ? `<div><strong>Creator:</strong> ${escHtml(creator.name)}</div>` : '',
      castHtml ? `<div><strong>Cast:</strong> ${castHtml}</div>`                 : '',
      show.status   ? `<div><strong>Status:</strong> ${escHtml(show.status)}</div>` : '',
      show.networks?.length ? `<div><strong>Network:</strong> ${escHtml(show.networks[0].name)}</div>` : '',
    ].filter(Boolean).join('');

    // Similar shows
    const similar = (show.similar?.results ?? []).slice(0, 12);
    if (similar.length) {
      const simRow = document.createElement('div');
      simRow.className = 'similar-row';
      similar.forEach(s => simRow.appendChild(createCard(s, 'tv')));
      tvModalSimilar.innerHTML = '<h3>More Like This</h3>';
      tvModalSimilar.appendChild(simRow);
    } else {
      tvModalSimilar.innerHTML = '';
    }

    // Clean up previous dynamic additions
    document.getElementById('tvModalWlBtn')?.remove();
    document.getElementById('tvModalListBtn')?.remove();
    document.getElementById('tvModalRatingWrap')?.remove();
    document.getElementById('tvModalWhyBox')?.remove();

    // Watchlist button
    const tvModalActionsEl = $('tvModalActions');
    if (tvModalActionsEl) {
      const inWlTV = _watchlist.some(i => i.tmdbId === show.id && i.type === 'tv');
      const tvWlBtn = document.createElement('button');
      tvWlBtn.id = 'tvModalWlBtn';
      tvWlBtn.className = `btn btn-wl btn-lg${inWlTV ? ' active' : ''}`;
      tvWlBtn.textContent = inWlTV ? '♥ Saved' : '♡ Save';
      tvWlBtn.addEventListener('click', () => toggleWatchlist(show.id, 'tv', show.name, show.poster_path, show.first_air_date?.slice(0, 4)));
      tvModalActionsEl.appendChild(tvWlBtn);

      // Add to List button
      const tvListBtn = document.createElement('button');
      tvListBtn.id = 'tvModalListBtn';
      tvListBtn.className = 'btn btn-wl';
      tvListBtn.textContent = '+ List';
      tvListBtn.addEventListener('click', () => openAddToListModal(show.id, 'tv', show.name, show.poster_path, show.first_air_date?.slice(0, 4)));
      tvModalActionsEl.appendChild(tvListBtn);

      // ▶ Trailer (self-hosted when available, else YouTube fallback)
      addTrailerButton(tvModalActionsEl, 'tvModalTrailerBtn', 'tv', show.id, show.videos);
    }

    // Star rating
    const tvRatingWrap = document.createElement('div');
    tvRatingWrap.id = 'tvModalRatingWrap';
    tvRatingWrap.className = 'modal-rating-wrap';
    tvModalSimilar.before(tvRatingWrap);
    renderStarRating('tvModalRatingWrap', 'tv', show.id);

    // Why you'll like this — async, non-blocking
    const openedShowId = show.id;
    buildWhyLikeThis(show, 'tv').then(reasons => {
      if (!reasons.length || tvModalWrap.hidden || currentShow?.id !== openedShowId) return;
      document.getElementById('tvModalWhyBox')?.remove();
      const box = document.createElement('div');
      box.id = 'tvModalWhyBox';
      box.className = 'why-like-box';
      box.innerHTML = `<div class="why-like-title">Why you'll like this</div><ul class="why-like-list">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
      (document.getElementById('tvModalRatingWrap') || tvModalSimilar).before(box);
    }).catch(() => {});

    await loadTvWatchState(show.id);
    await renderSeasonTabs(show);

    tvModalWrap.hidden = false;
    document.body.style.overflow = 'hidden';
    setTitleUrl('tv', show.id, show.name, show.first_air_date?.slice(0, 4));
  } catch (e) {
    toast('Failed to load show details');
    console.error(e);
  }
}

async function renderSeasonTabs(show) {
  const regularSeasons = (show.seasons || []).filter(s => s.season_number > 0);
  if (!regularSeasons.length) { tvSeasons.innerHTML = ''; return; }

  let html = '<div class="season-tabs">';
  for (const s of regularSeasons) {
    html += `<button class="season-tab${s.season_number === currentTVSeason ? ' active' : ''}" data-season="${s.season_number}">Season ${s.season_number}</button>`;
  }
  html += '</div><div class="episode-list" id="episodeList"><div style="color:#777;padding:20px 0">Loading episodes…</div></div>';
  tvSeasons.innerHTML = html;

  tvSeasons.querySelectorAll('.season-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentTVSeason = parseInt(btn.dataset.season);
      tvSeasons.querySelectorAll('.season-tab').forEach(b => b.classList.toggle('active', b === btn));
      await loadEpisodes(show.id, show.name, show.first_air_date?.slice(0, 4), currentTVSeason);
    });
  });

  await loadEpisodes(show.id, show.name, show.first_air_date?.slice(0, 4), currentTVSeason);
}

async function loadEpisodes(showId, showTitle, showYear, season) {
  const list = $('episodeList');
  if (!list) return;
  list.innerHTML = '<div style="color:#777;padding:20px 0">Loading…</div>';
  try {
    const data = await tmdb(`/tv/${showId}/season/${season}`);
    const episodes = data.episodes || [];
    if (!episodes.length) {
      list.innerHTML = '<div style="color:#777;padding:20px 0">No episodes found.</div>';
      return;
    }

    list.innerHTML = '';
    for (const ep of episodes) {
      const s0 = String(season).padStart(2, '0');
      const e0 = String(ep.episode_number).padStart(2, '0');

      // Check if this episode is already in the catalog (ready to play)
      const catEp = catalogData.find(c =>
        c.tmdbId === showId && c.type === 'tv' &&
        c.season == season && c.episode == ep.episode_number
      );
      const btnLabel = catEp?.streamUrl ? '&#9654;' : '+';

      // Watch state → highlight what's been watched and where the user is up to.
      const prog       = _tvProgressByEp[`${season}-${ep.episode_number}`];
      const inProgress = !!(prog && prog.pct >= 5 && prog.pct < 90);
      const jid        = episodeJobId(showId, season, ep.episode_number);
      const watched    = !inProgress && jid != null && (_tvWatchedFrac[jid] || 0) >= EP_WATCHED_FRAC;
      const pct        = inProgress ? Math.min(98, Math.max(4, Math.round(prog.pct))) : 0;

      const epEl = document.createElement('div');
      epEl.className = 'episode-item'
        + (watched ? ' episode-watched' : '')
        + (inProgress ? ' episode-inprogress' : '');
      epEl.innerHTML = `
        <div class="episode-num">E${e0}${watched ? '<span class="episode-check" title="Watched">✓</span>' : ''}</div>
        <div class="episode-info">
          <div class="episode-title">${escHtml(ep.name || '')}</div>
          <div class="episode-meta">${ep.air_date ? ep.air_date.slice(0, 4) : ''}${ep.runtime ? ' &middot; ' + ep.runtime + 'm' : ''}${watched ? ' &middot; <span class="episode-tag">Watched</span>' : ''}</div>
          ${ep.overview ? `<div class="episode-overview">${escHtml(ep.overview)}</div>` : ''}
          ${inProgress ? `<div class="episode-continue">Continue watching · ${pct}%</div><div class="episode-progress"><div class="episode-progress-fill" style="width:${pct}%"></div></div>` : ''}
        </div>
        <button class="episode-add-btn${catEp ? ' episode-ready-btn' : ''}" title="${catEp ? (inProgress ? 'Resume' : 'Play') : 'Request — ready in ~5–60 min'}">${btnLabel}</button>
      `;
      epEl.querySelector('.episode-add-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        // Catalog item — play immediately
        const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == season && c.episode == ep.episode_number);
        const epMeta = { type: 'tv', showId, showName: showTitle, season, episode: ep.episode_number, posterPath: currentShow?.poster_path };
        if (cat?.streamUrl) { openPlayer(cat.streamUrl, `${showTitle} S${s0}E${e0}`, currentShow?.poster_path, epMeta); return; }
        // Personal library check
        const alreadyIn = libraryData.find(j => j.tmdbId === showId && j.season == season && j.episode == ep.episode_number && j.status !== 'error');
        if (alreadyIn) {
          if (alreadyIn.status === 'ready' && alreadyIn.streamUrl) { openPlayer(alreadyIn.streamUrl, `${showTitle} S${s0}E${e0}`, currentShow?.poster_path, epMeta); }
          return;
        }
        queueEpisode(showTitle, showYear, showId, season, ep.episode_number, ep.name, btn);
      });
      list.appendChild(epEl);
    }
  } catch (e) {
    list.innerHTML = '<div style="color:#777;padding:20px 0">Failed to load episodes.</div>';
  }
}

function closeTVModal() {
  tvModalWrap.hidden = true;
  document.body.style.overflow = '';
  currentShow = null;
  clearTitleUrl();
}

tvModalClose.addEventListener('click', closeTVModal);
tvModalBackdrop.addEventListener('click', closeTVModal);

// ── Watch / Queue ──────────────────────────────────────────────────────────
// Hero "Watch Now" — shows the blocking overlay and plays immediately if ready
async function startWatch(movie) {
  closeModal();
  const title = movie.title || movie.name || '';
  const year  = movie.release_date?.slice(0, 4) ?? '';

  fetchTitle.textContent = title;
  fetchOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  setFetchStatus('Initialising…');
  progressWrap.hidden = true;
  progressFill.style.width = '0%';

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tmdbId: movie.id, title, year, type: 'movie' }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Failed to queue');
      fetchOverlay.hidden = true;
      document.body.style.overflow = '';
      return;
    }
    const { jobId, streamUrl, ready, queued, queuePosition } = data;
    currentJobId = jobId;
    if (ready && streamUrl) { openPlayer(streamUrl, title); return; }
    socket.emit('watch:join', jobId);
    // Reflect a queued start immediately — the room-join above can race the
    // server's first position emit, so seed the UI from the response.
    if (queued) updateFetchUI({ id: jobId, status: 'queued', queuePosition });
  } catch {
    fetchOverlay.hidden = true;
    document.body.style.overflow = '';
    toast('Failed to start download');
  }
}

// Request a movie. Fire-and-forget: the download/transcode runs in the background
// and the title appears in the user's Library when ready — no in-between page.
async function queueWatch(movie) {
  const title = movie.title || movie.name || '';
  const year  = movie.release_date?.slice(0, 4) ?? '';

  // Optimistically update the button; keep the modal open so the user stays on
  // the title (the button reflects ⏳ Requesting… → ✓ Requested in place).
  modalWatch.textContent = '⏳ Requesting…';
  modalWatch.disabled = true;

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tmdbId: movie.id, title, year, type: 'movie' }),
    });
    const data = await res.json();
    if (!res.ok) {
      modalWatch.textContent = REQUEST_LABEL;
      modalWatch.disabled = false;
      toast(data.error || 'Failed to queue');
      return;
    }

    const { streamUrl, ready, queued, queuePosition } = data;
    // Already available (cached) — close the modal and play it straight away.
    if (ready && streamUrl) {
      closeModal();
      openPlayer(streamUrl, title, movie.poster_path);
      return;
    }

    // Otherwise it processes in the background and shows up in the Library.
    modalWatch.textContent = '✓ Requested';
    modalWatch.disabled = true;
    toast(queued
      ? `🕒 ${title} is #${queuePosition} in the queue — it'll download automatically when a slot frees.`
      : `📥 Requested ${title} — ready in 5 min–1 hour. It'll show up in your Library.`);
    fetchLibrary();
  } catch (err) {
    modalWatch.textContent = REQUEST_LABEL;
    modalWatch.disabled = false;
    console.error('[queueWatch] error:', err);
    toast('Failed to queue: ' + (err?.message || err));
  }
}

async function queueEpisode(showTitle, showYear, showId, season, episode, epTitle, btn) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const jobTitle = `${showTitle} S${s}E${e}${epTitle ? ' — ' + epTitle : ''}`;

  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'tv', title: jobTitle, showTitle, year: showYear, tmdbId: showId, season, episode }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (btn) { btn.textContent = '+'; btn.disabled = false; }
      toast(data.error || 'Failed to queue');
      return;
    }

    const { jobId, streamUrl, ready } = data;
    if (ready && streamUrl) { openPlayer(streamUrl, jobTitle, null, { type: 'tv', showId, showName: showTitle, season, episode }); return; }

    currentJobId = jobId;
    socket.emit('watch:join', jobId);
    if (btn) { btn.textContent = '✓'; btn.title = 'Requested'; }
    toast(`📥 Requested ${jobTitle} — usually ready in 5–60 min.`);
    fetchLibrary();
  } catch {
    if (btn) { btn.textContent = '+'; btn.disabled = false; }
    toast('Failed to queue episode');
  }
}

fetchClose.addEventListener('click', () => {
    fetchOverlay.hidden = true;
  document.body.style.overflow = '';
  currentJobId = null;
});

function setFetchStatus(msg) { fetchStatus.textContent = msg; }

function updateFetchUI(job) {
  if (job.status === 'queued') {
    const pos = job.queuePosition ? ` (position ${job.queuePosition})` : '';
    setFetchStatus(`In queue${pos} — it'll start automatically when a slot opens.`);
    progressWrap.hidden = true;
    return;
  }
  setFetchStatus(job.message || job.status);
  if (job.status === 'downloading' && job.progress > 0) {
    progressWrap.hidden = false;
    progressFill.style.width = `${job.progress}%`;
    const dlMB  = job.downloaded ? (job.downloaded / 1e6).toFixed(0) : 0;
    const totMB = job.total ? (job.total / 1e6).toFixed(0) : 0;
    const etaStr = job.eta ? fmtEta(job.eta) : '';
    progressInfo.innerHTML = `
      <span>${job.progress}% &middot; ${job.speed ?? ''}</span>
      <span>${dlMB} / ${totMB} MB ${etaStr ? '&middot; ' + etaStr : ''}</span>
    `;
  }
}

function fmtEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ── Player ─────────────────────────────────────────────────────────────────
const PLAY_ICON    = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const VOL_ICON     = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const MUTED_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
const FS_ICON      = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
const EXIT_FS_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;
// Replay-30 / Forward-30 — Material arc glyphs with a "30" label baked in.
const RWD30_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/><text x="12" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" font-family="Roboto Mono,monospace">30</text></svg>`;
const FWD30_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/><text x="12" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" font-family="Roboto Mono,monospace">30</text></svg>`;
// Watch Party — a "group of people" glyph, matching the other monochrome controls
// (replaces a raw 🎉 emoji that looked out of place and was easy to mis-tap for CC).
const PARTY_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;

let _currentStreamId  = null;
let _playerTogglePlay = null;
let _playerToggleFs   = null;
let _playerToggleMute = null;
let _remotePlayer = null;
let _remotePlayerController = null;
let _isCastSeeking = false;
let _prefetchTimer  = null;
let _prefetchDone   = false;

// True when the player is already open and showing this exact stream — used to
// avoid re-opening (which auto-plays) on a socket reconnect, e.g. after a VM restart.
function isWatchingStream(streamUrl) {
  return !playerOverlay.hidden && !!streamUrl &&
    (videoEl.currentSrc === streamUrl || videoEl.src === streamUrl);
}

// A requested title finished downloading — show a clear, tappable "ready to
// watch" notification instead of auto-playing. Tap it (or Watch now) to play.
function notifyReady(jobId, streamUrl, title) {
  if (!streamUrl || isWatchingStream(streamUrl)) return;
  if (fetchOverlay && !fetchOverlay.hidden) { fetchOverlay.hidden = true; document.body.style.overflow = ''; }
  fetchLibrary(); // refresh so it shows under "Ready" in the Library
  document.querySelector('.toast-ready')?.remove(); // one at a time
  const el = document.createElement('div');
  el.className = 'toast-ready';
  el.innerHTML =
    `<span class="toast-ready-msg">✅ <strong>${escHtml(title || 'Your title')}</strong> is ready to watch</span>` +
    `<span class="toast-ready-btn">▶ Watch now</span>` +
    `<button class="toast-ready-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector('.toast-ready-close').addEventListener('click', (e) => { e.stopPropagation(); el.remove(); });
  el.addEventListener('click', () => { el.remove(); openPlayer(streamUrl, title); });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 20000);
}

// True while closePlayer() is intentionally detaching the video source, so the
// resulting `error` event (empty src) isn't shown as an "unsupported format" toast.
let _playerTearingDown = false;

// Label the stream on AirPlay / external displays as "Title — RADICAL". AirPlay
// reads the <video title> attribute; MediaSession drives the iOS Control Center /
// lock-screen "Now Playing" card (with poster art) — set both so every surface
// shows the brand alongside the title.
function setAirplayTitle(title, posterPath) {
  const label = title ? `${title} — RADICAL` : 'RADICAL';
  try { videoEl.title = label; } catch {}
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: label,
        artist: 'RADICAL',
        artwork: posterPath ? [{ src: POSTER(posterPath), sizes: '342x513', type: 'image/jpeg' }] : [],
      });
    }
  } catch {}
}

function openPlayer(streamUrl, title, posterPath = null, meta = null) {
  ensureAwayState();
  cancelAutoNext();
  // Resolve jobId from library — most call sites don't set currentJobId explicitly
  if (streamUrl) {
    const job = libraryData.find(j => j.streamUrl === streamUrl);
    if (job) currentJobId = job.id;
    else {
      const cat = catalogData.find(c => c.streamUrl === streamUrl);
      if (cat) currentJobId = cat.id;
    }
  }
  // Resolve poster: caller may not have it — check catalogData first, then TMDB async
  if (!posterPath && streamUrl) {
    const cat = catalogData.find(c => c.streamUrl === streamUrl);
    if (cat?.posterPath) posterPath = cat.posterPath;
  }
  if (!posterPath && currentJobId) {
    const job = libraryData.find(j => j.id === currentJobId);
    if (job?.tmdbId) {
      const path = job.type === 'tv' ? `/tv/${job.tmdbId}` : `/movie/${job.tmdbId}`;
      tmdb(path).then(d => { if (d?.poster_path) _currentPosterPath = d.poster_path; }).catch(() => {});
    }
  }
  fetchOverlay.hidden = true;
  document.body.style.overflow = 'hidden';
  playerTitle.textContent = title || '';
  _currentPosterPath = posterPath;
  setAirplayTitle(title, posterPath);
  // Derive TV context if the caller didn't pass it (Library/Continue Watching/
  // auto-next/resume all call openPlayer without meta), so the Episodes button
  // works no matter how playback started.
  if ((!meta || meta.type !== 'tv') && streamUrl) {
    const src = catalogData.find(c => c.streamUrl === streamUrl)
             || libraryData.find(j => j.streamUrl === streamUrl);
    if (src && src.type === 'tv' && src.tmdbId) {
      meta = { type: 'tv', showId: src.tmdbId, showName: src.showTitle || src.title || title,
               season: Number(src.season), episode: Number(src.episode),
               posterPath: src.posterPath || posterPath };
    }
  }
  _nowPlaying   = meta;
  _prefetchDone = false;
  clearTimeout(_prefetchTimer);
  // Show the Netflix-style Episodes button only for TV; reset the panel so it
  // re-opens on the season of the episode now playing.
  const _epBtn = $('playerEpisodesBtn'), _epMenu = $('episodesMenu');
  if (_epBtn)  _epBtn.hidden = meta?.type !== 'tv';
  if (_epMenu) _epMenu.hidden = true;
  _epPanelShowId = null;
  if (meta?.type === 'tv') {
    _prefetchTimer = setTimeout(prefetchNextEpisodes, 2 * 60 * 1000);
  }
  _playerTearingDown = false;
  // Set src + play synchronously within the user gesture — an await here breaks
  // iOS autoplay/AirPlay handoff. Any temp-URL minting must happen BEFORE this
  // (see the download-token flow), never in the play path.
  videoEl.src = streamUrl;
  recordWatchStat(_currentTrackGenres);
  playerOverlay.hidden = false;
  $('playerUi').classList.add('visible');
  // Restore saved position — server is the source of truth (resume across devices);
  // fall back to the fast localStorage cache only if the server has nothing.
  applyResumePosition(currentJobId);
  videoEl.play().catch(() => {});
  if (currentJobId) loadSubtitlesForJob(currentJobId);
  updateCastBtn();
  _currentStreamId = Math.random().toString(36).slice(2);
  socket.emit('stream:start', { streamId: _currentStreamId, title, streamUrl, jobId: currentJobId });
  if (window._streamProgressTimer) clearInterval(window._streamProgressTimer);
  window._streamProgressTimer = setInterval(() => {
    if (_currentStreamId && videoEl.duration > 0) {
      socket.emit('stream:progress', { streamId: _currentStreamId, currentTime: videoEl.currentTime, duration: videoEl.duration });
    }
  }, 10000);
  // Hide overlapping UI
  document.querySelector('.resume-bar')?.remove();
  $('trialBanner').hidden = true;
  // Hide the floating feedback button while watching (via body.player-open in CSS).
  document.body.classList.add('player-open');
}

// Resume position resolution — the server wins so playback resumes across devices.
// We seek immediately from the local cache (instant), then reconcile with the
// authoritative server position once it arrives (unless the user already seeked).
function applyResumePosition(jobId) {
  if (!jobId) return;
  let userSeeked = false;
  const markSeek = () => { userSeeked = true; };
  videoEl.addEventListener('seeking', markSeek, { once: true });

  const seekTo = (pos) => {
    if (userSeeked) return;
    const doSeek = () => { if (!userSeeked && pos > 5) videoEl.currentTime = pos; };
    if (videoEl.readyState >= 1) doSeek();
    else videoEl.addEventListener('loadedmetadata', doSeek, { once: true });
  };

  // 1. Fast local cache first (from /api/progress at boot or a prior save)
  const cached = _watchProgress[jobId];
  if (cached?.position > 5 && cached?.pct < FINISH_PCT) seekTo(cached.position);

  // 2. Authoritative server position — overrides the cache if present & fresher
  fetch(`/api/progress`)
    .then(r => r.ok ? r.json() : null)
    .then(all => {
      if (!all || jobId !== currentJobId) return;
      const srv = all[jobId];
      if (srv && srv.position > 5 && srv.pct < FINISH_PCT) {
        _watchProgress[jobId] = srv; // keep local cache in sync with server
        seekTo(srv.position);
      }
    })
    .catch(() => {});
}

function saveVideoStateNow() {
  if (!videoEl.src || videoEl.currentTime < 5 || videoEl.duration < 60) return;
  const pct = Math.round(videoEl.currentTime / videoEl.duration * 100);
  if (pct < 5) return;
  const finished = pct >= FINISH_PCT;
  const meta = _nowPlaying || {};
  const record = {
    jobId: currentJobId, streamUrl: videoEl.src, title: playerTitle.textContent,
    posterPath: _currentPosterPath, position: videoEl.currentTime,
    duration: videoEl.duration, pct, savedAt: Date.now(),
    // Show identity so TV episodes collapse to one Continue Watching entry.
    type: meta.type, showId: meta.showId, showName: meta.showName,
    season: meta.season, episode: meta.episode,
  };
  try {
    if (finished) localStorage.removeItem('rmVideoState');
    else localStorage.setItem('rmVideoState', JSON.stringify(record));
  } catch {}
  if (currentJobId) {
    if (finished) delete _watchProgress[currentJobId];
    else _watchProgress[currentJobId] = record;
    // Always POST — the server drops progress once pct crosses FINISH_PCT, so we
    // must send the crossing save (an early return here would leave it stuck near
    // the end forever).
    fetch(`/api/progress/${currentJobId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record),
    }).catch(() => {});
    renderContinueWatching();
  }
}

function closePlayer() {
  saveVideoStateNow();
  cancelAutoNext();
  clearTimeout(_prefetchTimer);
  _prefetchDone = false;
  leaveParty();
  if (window._streamProgressTimer) { clearInterval(window._streamProgressTimer); window._streamProgressTimer = null; }
  if (document.fullscreenElement) document.exitFullscreen();
  videoEl.pause();
  // Detach cleanly: `src = ''` resolves to the page URL and fires a bogus
  // MEDIA_ERR_SRC_NOT_SUPPORTED. Flag the teardown and use removeAttribute+load.
  _playerTearingDown = true;
  videoEl.removeAttribute('src');
  videoEl.load();
  playerOverlay.hidden = true;
  document.body.style.overflow = '';
  if (_currentStreamId) { socket.emit('stream:end', { streamId: _currentStreamId }); _currentStreamId = null; }
  currentJobId = null;
  _nowPlaying = null;
  clearSubtitleTracks();
  const ccBtn = $('playerCcBtn'); if (ccBtn) { ccBtn.hidden = true; ccBtn.classList.remove('active'); }
  const subMenu = $('subMenu'); if (subMenu) subMenu.hidden = true;
  const epBtn = $('playerEpisodesBtn'); if (epBtn) epBtn.hidden = true;
  const epMenu = $('episodesMenu'); if (epMenu) epMenu.hidden = true;
  const castBtn = $('playerCastBtn'); if (castBtn) castBtn.hidden = true;
  // Restore overlapping UI
  const banner = $('trialBanner');
  if (banner && document.body.classList.contains('has-trial-banner')) banner.hidden = false;
  document.body.classList.remove('player-open');
}

// ── Subtitles ──────────────────────────────────────────────────────────────
// Fully clear subtitles. Removing the <track> element alone leaves its TextTrack
// in videoEl.textTracks with mode 'showing', so its last cue stays painted (the
// "stuck remnant") and a newly-loaded track overlaps it (the "double subtitle").
// Setting every text track to 'disabled' stops rendering AND clears the cues.
let _subLoadToken = 0;
let _subBlobUrls  = [];
function clearSubtitleTracks() {
  _subLoadToken++; // invalidate any pending loadedmetadata handler from a prior load
  for (const tt of videoEl.textTracks) tt.mode = 'disabled';
  videoEl.querySelectorAll('track').forEach(t => t.remove());
  _subBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  _subBlobUrls = [];
}

function loadSubtitlesForJob(jobId, tracks) {
  if (!tracks) {
    const job = libraryData.find(j => j.id === jobId) || catalogData.find(c => c.id === jobId);
    tracks = job?.subtitleTracks || [];
  }
  const ccBtn  = $('playerCcBtn');
  const menu   = $('subMenu');

  clearSubtitleTracks();
  ccBtn.hidden = !tracks.length;
  menu.hidden  = true;
  if (!tracks.length) { menu.innerHTML = ''; return; }

  const token = _subLoadToken;
  const trackEls = tracks.map((t) => {
    const el = document.createElement('track');
    el.kind    = 'subtitles';
    el.srclang = t.lang;
    el.label   = t.label;
    videoEl.appendChild(el);
    // Fetch the cross-origin VTT (CDN sends ACAO:*) and attach it as a
    // same-origin blob: URL. This lets us drop crossorigin="anonymous" from
    // <video> — that attribute breaks AirPlay on some Apple TV / tvOS versions
    // (the tvOS side re-fetches with a CORS handshake that fails → code 4).
    fetch(t.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((vtt) => {
        if (token !== _subLoadToken) return; // superseded by a newer load
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        _subBlobUrls.push(blobUrl);
        el.src = blobUrl;
      })
      .catch(() => { el.src = t.url; }); // last-resort fallback to direct URL
    return el;
  });

  // Auto-select an English track when one exists (lang code or label match)
  const enIdx = tracks.findIndex(t =>
    /^en/i.test(t.lang || '') || /english/i.test(t.label || ''));

  menu.innerHTML = `<div class="sub-menu-item${enIdx < 0 ? ' active' : ''}" data-idx="-1">Off</div>`
    + tracks.map((t, i) => `<div class="sub-menu-item${i === enIdx ? ' active' : ''}" data-idx="${i}">${escHtml(t.label)}</div>`).join('');

  const selectTrack = (idx) => {
    trackEls.forEach((el, i) => {
      el.track.mode = (i === idx) ? 'showing' : 'hidden';
    });
    menu.querySelectorAll('.sub-menu-item').forEach(el =>
      el.classList.toggle('active', parseInt(el.dataset.idx) === idx));
    ccBtn.classList.toggle('active', idx >= 0);
  };

  menu.querySelectorAll('.sub-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      selectTrack(parseInt(item.dataset.idx));
      menu.hidden = true;
    });
  });

  // Enable the English track by default. Track objects may not be ready
  // synchronously, so apply once the video metadata has loaded too.
  if (enIdx >= 0) {
    const token = _subLoadToken;                 // this load's generation
    const applyEn = () => { if (token === _subLoadToken) selectTrack(enIdx); };
    applyEn();
    videoEl.addEventListener('loadedmetadata', applyEn, { once: true });
  }
}

function setupSubtitles() {
  const ccBtn = $('playerCcBtn');
  const menu  = $('subMenu');
  ccBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    // Ensure controls are visible — on mobile the button stays tappable even when
    // the player UI is opacity:0, so the menu would open invisibly without this
    if (!menu.hidden) {
      const playerUi = $('playerUi');
      playerUi.classList.add('visible');
    }
  });
  document.addEventListener('click', (e) => {
    if (!ccBtn.contains(e.target) && !menu.contains(e.target)) menu.hidden = true;
  });
  // Re-check when job updates arrive (subtitle extraction is async, ~2s after ready)
  socket.on('job:update', (job) => {
    if (job.id === currentJobId && job.subtitleTracks?.length) {
      loadSubtitlesForJob(currentJobId, job.subtitleTracks);
    }
  });
}

// ── In-player episode picker (Netflix-style) ────────────────────────────────
let _epPanelShowId = null;   // show currently rendered in the panel
let _epPanelSeason = null;   // season currently shown in the panel
const _epShowCache = {};     // showId → TMDB show object (for the season list)

function closeEpisodesPanel() {
  const menu = $('episodesMenu');
  if (menu) menu.hidden = true;
}

function setupEpisodesPanel() {
  const btn  = $('playerEpisodesBtn');
  const menu = $('episodesMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openEpisodesPanel(); else closeEpisodesPanel();
  });
  // Close on any click outside the button/panel (capture phase so it fires even
  // if inner handlers stop propagation).
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (!btn.contains(e.target) && !menu.contains(e.target)) closeEpisodesPanel();
  }, true);
}

async function openEpisodesPanel() {
  const np = _nowPlaying;
  if (!np || np.type !== 'tv' || !np.showId) return;
  const menu = $('episodesMenu');
  menu.hidden = false;
  $('playerUi').classList.add('visible');
  // Default to the season of the episode currently playing when opening a new show.
  if (_epPanelShowId !== np.showId || _epPanelSeason == null) {
    _epPanelShowId = np.showId;
    _epPanelSeason = np.season;
  }
  await renderEpisodesPanel(np.showId, _epPanelSeason ?? np.season);
}

async function renderEpisodesPanel(showId, season) {
  const menu = $('episodesMenu');
  menu.innerHTML = '<div class="episodes-loading">Loading…</div>';
  let show = _epShowCache[showId];
  if (!show) { try { show = await tmdb(`/tv/${showId}`); _epShowCache[showId] = show; } catch { show = {}; } }
  const seasons   = (show.seasons || []).filter(s => s.season_number > 0);
  const showTitle = show.name || _nowPlaying?.showName || '';
  const showYear  = show.first_air_date?.slice(0, 4);

  const seasonPicker = seasons.length > 1
    ? `<select class="episodes-season-select" id="episodesSeasonSelect">${seasons.map(s =>
        `<option value="${s.season_number}"${s.season_number === season ? ' selected' : ''}>Season ${s.season_number}</option>`).join('')}</select>`
    : `<span class="episodes-season-label">Season ${season}</span>`;

  menu.innerHTML = `
    <div class="episodes-header">
      <span class="episodes-heading">Episodes</span>
      ${seasonPicker}
    </div>
    <div class="episodes-list" id="episodesList"><div class="episodes-loading">Loading episodes…</div></div>`;

  const sel = $('episodesSeasonSelect');
  if (sel) sel.addEventListener('change', () => {
    _epPanelSeason = parseInt(sel.value);
    renderEpisodesList(showId, _epPanelSeason, showTitle, showYear);
  });
  await renderEpisodesList(showId, season, showTitle, showYear);
}

async function renderEpisodesList(showId, season, showTitle, showYear) {
  const list = $('episodesList');
  if (!list) return;
  list.innerHTML = '<div class="episodes-loading">Loading…</div>';
  let episodes = [];
  try { episodes = (await tmdb(`/tv/${showId}/season/${season}`)).episodes || []; }
  catch { list.innerHTML = '<div class="episodes-loading">Failed to load episodes.</div>'; return; }
  if (!episodes.length) { list.innerHTML = '<div class="episodes-loading">No episodes found.</div>'; return; }

  list.innerHTML = '';
  for (const ep of episodes) {
    const epNum = ep.episode_number;
    const s0 = String(season).padStart(2, '0'), e0 = String(epNum).padStart(2, '0');
    const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == season && c.episode == epNum && c.streamUrl);
    const lib = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' && j.season == season && j.episode == epNum && j.status !== 'error');
    const ready       = cat?.streamUrl || (lib?.status === 'ready' && lib?.streamUrl);
    const downloading = lib && lib.status !== 'ready';
    const isCurrent   = _nowPlaying && _nowPlaying.showId === showId && _nowPlaying.season == season && _nowPlaying.episode == epNum;
    const action = isCurrent ? '▶ Playing' : ready ? '▶ Play' : downloading ? `⏳ ${lib.progress || 0}%` : '＋ Request';

    const item = document.createElement('div');
    item.className = 'episodes-item' + (isCurrent ? ' current' : '');
    item.innerHTML = `
      <div class="episodes-item-num">${e0}</div>
      <div class="episodes-item-info">
        <div class="episodes-item-title">${escHtml(ep.name || ('Episode ' + epNum))}</div>
        <div class="episodes-item-meta">${ep.runtime ? ep.runtime + 'm' : ''}${ep.air_date ? (ep.runtime ? ' · ' : '') + ep.air_date.slice(0, 4) : ''}</div>
      </div>
      <div class="episodes-item-action">${action}</div>`;

    item.addEventListener('click', () => {
      const menu = $('episodesMenu');
      const title  = `${showTitle} S${s0}E${e0}`;
      const epMeta = { type: 'tv', showId, showName: showTitle, season, episode: epNum, posterPath: _nowPlaying?.posterPath };
      if (isCurrent) { menu.hidden = true; return; }
      const catNow = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == season && c.episode == epNum && c.streamUrl);
      if (catNow?.streamUrl) { menu.hidden = true; openPlayer(catNow.streamUrl, title, _nowPlaying?.posterPath, epMeta); return; }
      const libNow = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' && j.season == season && j.episode == epNum && j.status !== 'error');
      if (libNow) {
        if (libNow.status === 'ready' && libNow.streamUrl) { menu.hidden = true; openPlayer(libNow.streamUrl, title, _nowPlaying?.posterPath, epMeta); }
        else toast(`S${s0}E${e0} is downloading — it'll be ready soon`);
        return;
      }
      // Not in catalog/library → request it, with immediate in-panel feedback.
      if (item.dataset.requested) return;           // guard double-requests
      item.dataset.requested = '1';
      item.classList.add('requested');
      const actionEl = item.querySelector('.episodes-item-action');
      if (actionEl) actionEl.textContent = '✓ Requested';
      queueEpisode(showTitle, showYear, showId, season, epNum, ep.name, null); // also toasts
    });
    list.appendChild(item);
  }
}

// ── Auto-next episode ──────────────────────────────────────────────────────
function cancelAutoNext() {
  clearInterval(_autoNextTimer);
  _autoNextTimer   = null;
  _autoNextPending = null;
  const el = $('autoNextOverlay');
  if (el) el.hidden = true;
  const loadRow = $('autoNextLoadingRow');
  const readyRow = $('autoNextReadyRow');
  if (loadRow)  loadRow.hidden  = true;
  if (readyRow) readyRow.hidden = false;
}

function showAutoNext(next) {
  const overlay = $('autoNextOverlay');
  const countEl = $('autoNextCount');
  $('autoNextTitle').textContent = next.title;
  $('autoNextPoster').src = next.posterPath ? POSTER(next.posterPath) : '/no-poster.svg';
  overlay.hidden = false;

  let secs = 10;
  countEl.textContent = secs;
  _autoNextTimer = setInterval(() => {
    secs--;
    countEl.textContent = secs;
    if (secs <= 0) { cancelAutoNext(); playNext(next); }
  }, 1000);

  $('autoNextPlay').onclick   = () => { cancelAutoNext(); playNext(next); };
  $('autoNextCancel').onclick = () => cancelAutoNext();
}

function playNext(next) {
  currentJobId = next.jobId;
  openPlayer(next.streamUrl, next.title, next.posterPath, { type: 'tv', showId: next.showId, showName: next.showName, season: next.season, episode: next.episode, posterPath: next.posterPath });
}

async function checkAutoNext() {
  if (!_nowPlaying || _nowPlaying.type !== 'tv') return;
  const { showId, showName, season, episode, posterPath } = _nowPlaying;

  for (const [s, e] of [[season, episode + 1], [season + 1, 1]]) {
    const ss = String(s).padStart(2, '0'), ee = String(e).padStart(2, '0');

    // Fetch episode title from TMDB — also validates the episode exists
    let epName = '';
    try {
      const eps = await tmdb(`/tv/${showId}/season/${s}`);
      const ep  = (eps.episodes || []).find(x => x.episode_number === e);
      if (ep) epName = ep.name;
      else continue; // episode doesn't exist (e.g. S01E11 when S01 has 10 eps)
    } catch { continue; } // TMDB blip — don't try a potentially non-existent episode

    const displayTitle = `${showName} S${ss}E${ee}${epName ? ' — ' + epName : ''}`;

    // Case 1: already in library/catalog and ready — show countdown
    const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == s && c.episode == e && c.streamUrl);
    const lib = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' && j.season == s && j.episode == e && j.status === 'ready' && j.streamUrl);
    if (cat || lib) {
      showAutoNext({ showId, showName, season: s, episode: e,
        streamUrl: cat?.streamUrl || lib?.streamUrl,
        jobId: lib?.id || null, posterPath, title: displayTitle });
      return;
    }

    // Case 2: already downloading — show loading state and wait
    const inProgress = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' &&
      j.season == s && j.episode == e && ['queued','searching','downloading','uploading'].includes(j.status));
    if (inProgress) {
      _showAutoNextLoading({ showId, showName, season: s, episode: e, posterPath,
        title: displayTitle, jobId: inProgress.id });
      return;
    }

    // Case 3: not started — kick off download, then show loading state
    try {
      const res = await fetch('/api/watch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tv', title: displayTitle, showTitle: showName,
          tmdbId: showId, season: s, episode: e }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.ready && data.streamUrl) {
        // Prefetch already finished while we were asking
        showAutoNext({ showId, showName, season: s, episode: e,
          streamUrl: data.streamUrl, jobId: data.jobId, posterPath, title: displayTitle });
      } else {
        _showAutoNextLoading({ showId, showName, season: s, episode: e, posterPath,
          title: displayTitle, jobId: data.jobId });
      }
    } catch { continue; }
    return;
  }
}

function _showAutoNextLoading({ showId, showName, season, episode, posterPath, title, jobId }) {
  _autoNextPending = { jobId, next: { showId, showName, season, episode, posterPath, title } };
  socket.emit('watch:join', jobId);

  $('autoNextTitle').textContent = title;
  $('autoNextPoster').src = posterPath ? POSTER(posterPath) : '/no-poster.svg';
  $('autoNextLabel').textContent = 'Next Episode';
  $('autoNextReadyRow').hidden  = true;
  $('autoNextLoadingRow').hidden = false;
  $('autoNextLoadingMsg').textContent = 'Finding episode…';
  $('autoNextOverlay').hidden = false;

  $('autoNextLoadingCancel').onclick = () => cancelAutoNext();
}

async function prefetchNextEpisodes() {
  if (_prefetchDone || !_nowPlaying || _nowPlaying.type !== 'tv') return;
  _prefetchDone = true;

  const { showId, showName, season, episode } = _nowPlaying;
  let candidates = [];

  try {
    const seasonData = await tmdb(`/tv/${showId}/season/${season}`);
    const totalEps   = (seasonData.episodes || []).length;

    if (episode + 1 <= totalEps) candidates.push({ season, episode: episode + 1 });
    if (episode + 2 <= totalEps) candidates.push({ season, episode: episode + 2 });

    // Season boundary — need episodes from next season
    if (candidates.length < 2) {
      try {
        const next = await tmdb(`/tv/${showId}/season/${season + 1}`);
        const nextTotal = (next.episodes || []).length;
        if (nextTotal > 0) {
          candidates.push({ season: season + 1, episode: 1 });
          if (candidates.length < 2 && nextTotal >= 2) candidates.push({ season: season + 1, episode: 2 });
        }
      } catch {}
    }
  } catch {
    // TMDB unavailable — fall back to same-season +1/+2 without validation
    candidates = [{ season, episode: episode + 1 }, { season, episode: episode + 2 }];
  }

  let queued = 0;
  for (const next of candidates.slice(0, 2)) {
    const alreadyHave =
      libraryData.some(j => j.tmdbId === showId && j.type === 'tv' &&
        j.season == next.season && j.episode == next.episode && j.status !== 'error') ||
      catalogData.some(c => c.tmdbId === showId && c.type === 'tv' &&
        c.season == next.season && c.episode == next.episode);
    if (alreadyHave) continue;

    const s0 = String(next.season).padStart(2, '0');
    const e0 = String(next.episode).padStart(2, '0');
    const title = `${showName} S${s0}E${e0}`;

    try {
      const res = await fetch('/api/watch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tv', title, showTitle: showName, tmdbId: showId, season: next.season, episode: next.episode }),
      });
      if (res.ok) { queued++; fetchLibrary(); }
    } catch {}
  }

  if (queued > 0) toast(`Pre-loading next ${queued === 1 ? 'episode' : '2 episodes'} in the background`);
}

// ── Watch Party ────────────────────────────────────────────────────────────
function leaveParty() {
  if (_partyRoomId) { socket.emit('party:leave', _partyRoomId); _partyRoomId = null; }
  _partyIsHost = false;
  _partyEnabled = false;
  const panel = $('partyPanel');
  if (panel) panel.hidden = true;
  $('playerPartyBtn')?.classList.remove('active');
}

function setupParty() {
  const partyBtn  = $('playerPartyBtn');
  if (partyBtn) partyBtn.innerHTML = PARTY_ICON;
  const panel     = $('partyPanel');
  const closeBtn  = $('partyClose');
  const copyBtn   = $('partyCopyBtn');
  const linkInput = $('partyLinkInput');
  const statusEl  = $('partyStatus');
  const membersEl = $('partyMembers');
  const linkRow   = $('partyLinkRow');

  partyBtn.addEventListener('click', () => {
    if (panel.hidden) {
      panel.hidden = false;
      partyBtn.classList.add('active');
      if (!_partyRoomId) {
        statusEl.textContent = 'Creating room…';
        linkRow.hidden = true;
        socket.emit('party:create', { streamUrl: videoEl.src, title: playerTitle.textContent });
      }
    } else {
      leaveParty();
    }
  });

  closeBtn.addEventListener('click', leaveParty);

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(linkInput.value).catch(() => {});
    const orig = copyBtn.textContent;
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  });

  socket.on('party:joined', ({ roomId, isHost, memberCount, streamUrl, title }) => {
    _partyRoomId = roomId;
    _partyIsHost = isHost;
    _partyEnabled = true;
    panel.hidden = false;
    partyBtn.classList.add('active');
    membersEl.textContent = `${memberCount} watching`;
    const url = `${location.origin}/?party=${roomId}`;
    linkInput.value = url;
    linkRow.hidden  = false;
    statusEl.textContent = isHost ? 'You are the host — share the link!' : 'Joined! Host controls playback.';
    if (!isHost && streamUrl && videoEl.src !== streamUrl) {
      openPlayer(streamUrl, title || playerTitle.textContent);
    }
  });

  socket.on('party:sync', ({ currentTime, playing }) => {
    if (_partyIsHost) return;
    if (Math.abs(videoEl.currentTime - currentTime) > 2) videoEl.currentTime = currentTime;
    if (playing && videoEl.paused)  videoEl.play().catch(() => {});
    if (!playing && !videoEl.paused) videoEl.pause();
    statusEl.textContent = playing ? '▶ In sync' : '⏸ Paused by host';
    statusEl.className = 'party-status syncing';
    setTimeout(() => { statusEl.className = 'party-status'; statusEl.textContent = 'Synced'; }, 1500);
  });

  socket.on('party:members', (count) => {
    membersEl.textContent = `${count} watching`;
  });

  socket.on('party:error', (msg) => {
    statusEl.textContent = `Error: ${msg}`;
    panel.hidden = false;
  });

  // Auto-join from URL ?party=ROOMID
  const partyParam = new URLSearchParams(location.search).get('party');
  if (partyParam) {
    socket.emit('party:join', partyParam);
    history.replaceState({}, '', location.pathname);
  }
}

// Emit party sync when host plays/pauses (called from player event handlers)
function emitPartySync() {
  if (!_partyEnabled || !_partyIsHost || !_partyRoomId) return;
  socket.emit('party:update', { roomId: _partyRoomId, currentTime: videoEl.currentTime, playing: !videoEl.paused });
}

function setupPlayerControls() {
  const playerUi    = $('playerUi');
  const playBtn     = $('playerPlayBtn');
  const muteBtn     = $('playerMuteBtn');
  const volSlider   = $('playerVolSlider');
  const timeDisplay = $('playerTimeDisplay');
  const scrubber    = $('playerScrubber');
  const bufferedBar = $('playerBufferedBar');
  const seekLeft    = $('playerSeekLeft');
  const handle      = $('playerHandle');
  const tooltip     = $('playerTooltip');
  const fsBtn       = $('playerFsBtn');
  const spinner     = $('playerSpinner');
  const centerIcon  = $('playerCenterIcon');

  let hideTimer  = null;
  let isSeeking  = false;
  let wasPlaying = false;

  playBtn.innerHTML = PLAY_ICON;
  muteBtn.innerHTML = VOL_ICON;
  fsBtn.innerHTML   = FS_ICON;
  const rwd30Btn = $('playerRwd30'); if (rwd30Btn) rwd30Btn.innerHTML = RWD30_ICON;
  const fwd30Btn = $('playerFwd30'); if (fwd30Btn) fwd30Btn.innerHTML = FWD30_ICON;

  // ── Auto-hide controls ───────────────────────────────────────────────────
  function showControls() {
    playerUi.classList.add('visible');
    playerOverlay.style.cursor = '';
    clearTimeout(hideTimer);
    if (!videoEl.paused) {
      hideTimer = setTimeout(() => {
        if (!$('subMenu').hidden || !$('episodesMenu').hidden) return; // keep visible while a menu is open
        playerUi.classList.remove('visible');
        playerOverlay.style.cursor = 'none';
      }, 3000);
    }
  }

  playerOverlay.addEventListener('mousemove', showControls);
  playerOverlay.addEventListener('mouseleave', () => {
    if (!videoEl.paused && $('subMenu').hidden && $('episodesMenu').hidden) {
      clearTimeout(hideTimer);
      playerUi.classList.remove('visible');
      playerOverlay.style.cursor = 'none';
    }
  });

  // Click video area to toggle play/pause (mouse only — touch is handled by the
  // touchend tap logic below, which suppresses this synthetic click).
  playerOverlay.addEventListener('click', (e) => {
    if (e.target.closest('.player-top') || e.target.closest('.player-bottom')) return;
    if (performance.now() - _lastTouchTapAt < 600) return;
    showControls();
    _playerTogglePlay();
  });

  // ── Play / Pause ─────────────────────────────────────────────────────────
  _playerTogglePlay = () => {
    if (isCasting()) {
      _remotePlayerController.playOrPause();
      showControls();
      return;
    }
    if (videoEl.paused) { videoEl.play().catch(() => {}); flashCenter(PLAY_ICON); }
    else                { videoEl.pause();                flashCenter(PAUSE_ICON); }
    showControls();
  };
  playBtn.addEventListener('click', _playerTogglePlay);
  playerClose.addEventListener('click', closePlayer);

  videoEl.addEventListener('play',  () => { playBtn.innerHTML = PAUSE_ICON; showControls(); emitPartySync(); });
  videoEl.addEventListener('pause', () => {
    playBtn.innerHTML = PLAY_ICON;
    clearTimeout(hideTimer);
    playerUi.classList.add('visible');
    playerOverlay.style.cursor = '';
    emitPartySync();
    saveVideoStateNow();
  });
  videoEl.addEventListener('ended', () => {
    cancelAutoNext();
    checkAutoNext();
  });

  // ── Center flash icon ─────────────────────────────────────────────────────
  function flashCenter(svg) {
    centerIcon.innerHTML = svg;
    centerIcon.classList.remove('flash');
    void centerIcon.offsetWidth;
    centerIcon.classList.add('flash');
  }

  // Seek relative to the current position (works for local playback and Chromecast).
  function seekBy(delta) {
    if (isCasting()) {
      const dur = _remotePlayer?.duration || 0;
      if (dur) {
        _remotePlayer.currentTime = Math.max(0, Math.min(dur, (_remotePlayer.currentTime || 0) + delta));
        _remotePlayerController.seek();
      }
    } else {
      const dur = videoEl.duration || 0;
      const next = (videoEl.currentTime || 0) + delta;
      videoEl.currentTime = dur ? Math.max(0, Math.min(dur, next)) : Math.max(0, next);
    }
    showControls();
  }

  // Flash the left/right "« 30s" / "30s »" ripple after a double-tap seek.
  function flashSkip(side) {
    const el = side === 'left' ? $('playerSkipLeft') : $('playerSkipRight');
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  if (rwd30Btn) rwd30Btn.addEventListener('click', (e) => { e.stopPropagation(); seekBy(-30); flashSkip('left'); });
  if (fwd30Btn) fwd30Btn.addEventListener('click', (e) => { e.stopPropagation(); seekBy(30);  flashSkip('right'); });

  // ── Mobile: double-tap left / right half to jump ∓30s (YouTube-style) ──────
  // A single tap still toggles play/pause, but we defer it briefly so a second
  // tap on the same side can override it with a seek. Keep tapping to keep
  // skipping (double-tap = 30s, triple = 60s, …).
  let _lastTapTime = 0;
  let _lastTapSide = null;
  let _pendingSingleTap = null;
  const DOUBLE_TAP_MS = 300;

  function handlePlayerTap(clientX) {
    const r    = videoEl.getBoundingClientRect();
    const x    = clientX - r.left;
    const side = x < r.width * 0.35 ? 'left' : x > r.width * 0.65 ? 'right' : 'center';
    const now  = performance.now();
    const isDouble = (now - _lastTapTime) < DOUBLE_TAP_MS && side === _lastTapSide;
    _lastTapTime = now;
    _lastTapSide = side;

    if (isDouble && side !== 'center') {
      clearTimeout(_pendingSingleTap); _pendingSingleTap = null;
      seekBy(side === 'left' ? -30 : 30);
      flashSkip(side);
      return;
    }
    clearTimeout(_pendingSingleTap);
    _pendingSingleTap = setTimeout(() => {
      _pendingSingleTap = null;
      showControls();
      _playerTogglePlay();
    }, DOUBLE_TAP_MS);
  }

  // Touch drives the tap logic; we suppress the synthetic click it produces so
  // the mouse `click` handler below doesn't double-fire on phones.
  let _lastTouchTapAt = 0;
  playerOverlay.addEventListener('touchend', (e) => {
    if (e.target.closest('.player-top') || e.target.closest('.player-bottom')) return;
    if (e.changedTouches.length !== 1) return;
    _lastTouchTapAt = performance.now();
    handlePlayerTap(e.changedTouches[0].clientX);
    e.preventDefault();
  }, { passive: false });

  // ── Volume / Mute ─────────────────────────────────────────────────────────
  function syncVolIcon() {
    muteBtn.innerHTML = (videoEl.muted || videoEl.volume === 0) ? MUTED_ICON : VOL_ICON;
  }
  _playerToggleMute = () => {
    if (isCasting()) { _remotePlayerController.muteOrUnmute(); return; }
    videoEl.muted = !videoEl.muted;
    syncVolIcon();
  };
  muteBtn.addEventListener('click', _playerToggleMute);
  volSlider.addEventListener('input', () => {
    videoEl.volume = parseFloat(volSlider.value);
    videoEl.muted  = videoEl.volume === 0;
    syncVolIcon();
  });
  videoEl.addEventListener('volumechange', () => { volSlider.value = videoEl.volume; syncVolIcon(); });

  // ── Time & scrubber ───────────────────────────────────────────────────────
  function fmt(s) {
    if (!isFinite(s)) return '0:00';
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`
      : `${m}:${String(sc).padStart(2,'0')}`;
  }

  videoEl.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      const pct = videoEl.duration ? (videoEl.currentTime / videoEl.duration) * 100 : 0;
      seekLeft.style.width    = `${pct}%`;
      handle.style.left       = `${pct}%`;
      timeDisplay.textContent = `${fmt(videoEl.currentTime)} / ${fmt(videoEl.duration)}`;
    }
    syncBuffered();
    // Save progress every 10s
    if (Date.now() - _lastProgressSave > 10000) {
      _lastProgressSave = Date.now();
      saveVideoStateNow();
    }
  });
  videoEl.addEventListener('progress', syncBuffered);

  function syncBuffered() {
    if (!videoEl.duration) return;
    let end = 0;
    for (let i = 0; i < videoEl.buffered.length; i++) {
      if (videoEl.buffered.start(i) <= videoEl.currentTime + 1)
        end = Math.max(end, videoEl.buffered.end(i));
    }
    bufferedBar.style.width = `${(end / videoEl.duration) * 100}%`;
  }

  // ── Scrubber drag ─────────────────────────────────────────────────────────
  function getSeekPct(e) {
    const r = scrubber.getBoundingClientRect();
    const clientX = e.touches?.[0]?.clientX ?? e.changedTouches?.[0]?.clientX ?? e.clientX;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  scrubber.addEventListener('mousemove', (e) => {
    const r   = scrubber.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const dur = isCasting() ? (_remotePlayer?.duration || 0) : (videoEl.duration || 0);
    tooltip.textContent = fmt(pct * dur);
    tooltip.style.left  = `${pct * r.width}px`;
    tooltip.classList.add('visible');
  });
  scrubber.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));

  scrubber.addEventListener('mousedown', (e) => {
    isSeeking = true;
    if (isCasting()) {
      wasPlaying     = !_remotePlayer?.isPaused;
      _isCastSeeking = true;
    } else {
      wasPlaying = !videoEl.paused;
      videoEl.pause();
    }
    applySeek(e);
    document.addEventListener('mousemove', applySeek);
    document.addEventListener('mouseup', endSeek, { once: true });
  });

  // Touch dragging — mirror the mouse flow, show the tooltip, and block page
  // scroll while the finger is on the bar so scrubbing feels precise.
  function showScrubTooltip(e) {
    const pct = getSeekPct(e);
    const dur = isCasting() ? (_remotePlayer?.duration || 0) : (videoEl.duration || 0);
    tooltip.textContent = fmt(pct * dur);
    tooltip.style.left  = `${pct * scrubber.getBoundingClientRect().width}px`;
    tooltip.classList.add('visible');
  }
  function onTouchSeek(e) { applySeek(e); showScrubTooltip(e); e.preventDefault(); }
  function endTouchSeek() {
    document.removeEventListener('touchmove', onTouchSeek);
    tooltip.classList.remove('visible');
    endSeek();
  }
  scrubber.addEventListener('touchstart', (e) => {
    isSeeking = true;
    if (isCasting()) { wasPlaying = !_remotePlayer?.isPaused; _isCastSeeking = true; }
    else            { wasPlaying = !videoEl.paused; videoEl.pause(); }
    applySeek(e);
    showScrubTooltip(e);
    document.addEventListener('touchmove', onTouchSeek, { passive: false });
    document.addEventListener('touchend', endTouchSeek, { once: true });
    showControls();
    e.preventDefault();
  }, { passive: false });

  function applySeek(e) {
    const pct = getSeekPct(e);
    seekLeft.style.width = `${pct * 100}%`;
    handle.style.left    = `${pct * 100}%`;
    if (isCasting()) {
      const dur = _remotePlayer?.duration || 0;
      if (dur) timeDisplay.textContent = `${fmt(pct * dur)} / ${fmt(dur)}`;
    } else {
      if (videoEl.duration) videoEl.currentTime = pct * videoEl.duration;
    }
  }

  function endSeek() {
    isSeeking      = false;
    _isCastSeeking = false;
    document.removeEventListener('mousemove', applySeek);
    if (isCasting()) {
      const pct = parseFloat(seekLeft.style.width) / 100;
      const dur = _remotePlayer?.duration || 0;
      if (dur) {
        _remotePlayer.currentTime = pct * dur;
        _remotePlayerController.seek();
      }
    } else if (wasPlaying) {
      videoEl.play().catch(() => {});
    }
    emitPartySync();
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  _playerToggleFs = () => {
    if (!document.fullscreenElement) playerOverlay.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  fsBtn.addEventListener('click', _playerToggleFs);
  document.addEventListener('fullscreenchange', () => {
    fsBtn.innerHTML = document.fullscreenElement ? EXIT_FS_ICON : FS_ICON;
  });

  // ── Playback speed ─────────────────────────────────────────────────────────
  const speedBtn  = $('playerSpeedBtn');
  const speedMenu = $('speedMenu');
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const renderSpeedMenu = () => {
    speedMenu.innerHTML = SPEEDS.map(r =>
      `<div class="speed-menu-item${videoEl.playbackRate === r ? ' active' : ''}" data-rate="${r}">${r}&times;</div>`).join('');
    speedMenu.querySelectorAll('.speed-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const rate = parseFloat(item.dataset.rate);
        videoEl.playbackRate = rate;
        speedBtn.innerHTML = `${rate}&times;`;
        renderSpeedMenu();
        speedMenu.hidden = true;
      });
    });
  };
  renderSpeedMenu();
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderSpeedMenu();
    speedMenu.hidden = !speedMenu.hidden;
    showControls();
  });
  document.addEventListener('click', (e) => {
    if (!speedBtn.contains(e.target) && !speedMenu.contains(e.target)) speedMenu.hidden = true;
  });
  // Reset speed to 1× each time a new stream opens
  videoEl.addEventListener('loadstart', () => { videoEl.playbackRate = 1; speedBtn.innerHTML = '1&times;'; });

  // ── Spinner ───────────────────────────────────────────────────────────────
  videoEl.addEventListener('waiting', () => { spinner.hidden = false; });
  videoEl.addEventListener('canplay', () => { spinner.hidden = true; });
  videoEl.addEventListener('playing', () => { spinner.hidden = true; });
  videoEl.addEventListener('error', () => {
    spinner.hidden = true;
    // Ignore errors from intentional teardown or an already-detached source —
    // clearing src on close otherwise surfaces a false "unsupported format" toast.
    if (_playerTearingDown || !videoEl.getAttribute('src')) return;
    const code = videoEl.error?.code;
    // MEDIA_ERR_NETWORK=2, MEDIA_ERR_SRC_NOT_SUPPORTED=4
    const msg = code === 4 ? 'Unsupported format — try re-downloading'
              : code === 2 ? 'Network error loading video — check connection or try again'
              : 'Video failed to load — try re-downloading or refreshing';
    toast(msg);
    logClient('error', `video error (code ${code})`, {
      title: playerTitle?.textContent || '',
      detail: videoEl.error?.message || '',
      airplay: !!videoEl.webkitCurrentPlaybackTargetIsWireless, // was it casting when it failed?
      net: videoEl.networkState, ready: videoEl.readyState,
      t: Math.round(videoEl.currentTime || 0),
      file: (() => { try { return new URL(videoEl.currentSrc || videoEl.src).pathname.split('/').pop(); } catch { return ''; } })(),
    });
  });

  // ── AirPlay diagnostics ──────────────────────────────────────────────────
  // Turns "I think AirPlay is broken" into hard data: logs engage/disengage and
  // a genuine stall (still buffering >8s while casting and not paused). Normal
  // startup buffering is ignored so healthy sessions stay quiet.
  videoEl.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    const wireless = videoEl.webkitCurrentPlaybackTargetIsWireless;
    logClient('info', `airplay ${wireless ? 'engaged' : 'disengaged'}`,
      { title: playerTitle?.textContent || '' });
    // AirPlaying video to an Apple TV delegates volume to the TV/receiver: iOS
    // ignores <video>.volume and only honors mute, and there is no web API for
    // the AirPlay target's volume (unlike Chromecast's Cast SDK). So the slider
    // is a dead control while casting — disable it and point the user at the
    // real control. Mute still works. Re-enabled on disengage.
    if (volSlider) {
      volSlider.disabled = wireless;
      volSlider.title = wireless ? 'Volume is controlled by your TV / Apple TV remote' : '';
    }
    if (wireless) toast('🔊 Adjust volume with your TV or Apple TV remote');
  });
  let _apStallTimer = null;
  const clearApStall = () => { if (_apStallTimer) { clearTimeout(_apStallTimer); _apStallTimer = null; } };
  videoEl.addEventListener('waiting', () => {
    if (!videoEl.webkitCurrentPlaybackTargetIsWireless || _apStallTimer) return;
    _apStallTimer = setTimeout(() => {
      _apStallTimer = null;
      if (videoEl.paused) return;
      logClient('error', 'airplay stall (>8s buffering)', {
        title: playerTitle?.textContent || '', t: Math.round(videoEl.currentTime || 0),
        ready: videoEl.readyState, net: videoEl.networkState,
      });
    }, 8000);
  });
  videoEl.addEventListener('playing', clearApStall);
  videoEl.addEventListener('canplay', clearApStall);
}

function fmtTime(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${m}:${String(sc).padStart(2,'0')}`;
}

function restoreVideoState() {
  try {
    const saved = JSON.parse(localStorage.getItem('rmVideoState') || 'null');
    if (!saved || !saved.streamUrl) return;
    if (saved.pct < 5 || saved.pct >= FINISH_PCT) return;
    if (Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return;
    const timeLeft = saved.duration ? fmtTime(saved.duration - saved.position) : '';
    const bar = document.createElement('div');
    bar.className = 'resume-bar';
    bar.innerHTML = `
      <span class="resume-bar-title">${escHtml(saved.title)}</span>
      ${timeLeft ? `<span class="resume-bar-time">${timeLeft} left</span>` : ''}
      <button class="resume-bar-btn" id="resumePlayBtn">▶ Resume</button>
      <button class="resume-bar-dismiss" id="resumeDismiss">✕</button>`;
    document.body.appendChild(bar);
    document.getElementById('resumePlayBtn').addEventListener('click', () => {
      bar.remove();
      currentJobId = saved.jobId || null;
      openPlayer(saved.streamUrl, saved.title, saved.posterPath);
    });
    document.getElementById('resumeDismiss').addEventListener('click', () => {
      bar.remove();
      localStorage.removeItem('rmVideoState');
    });
  } catch {}
}

// ── Continue Watching ──────────────────────────────────────────────────────
async function loadProgress() {
  try {
    _watchProgress = await fetch('/api/progress').then(r => r.json());
    renderContinueWatching();
  } catch {}
}

// Group key for collapsing a show's episodes into a single Continue Watching
// tile. New records carry showId/type; for records saved before that, fall back
// to stripping a trailing "S01E05" from the title. Returns null for movies /
// standalone items so they never collapse together.
function continueShowKey(v) {
  if (v.type === 'tv' && (v.showId || v.showName)) return 'show:' + (v.showId || v.showName);
  const m = (v.title || '').match(/^(.*?)\s+S\d{1,2}\s*E\d{1,3}\b/i);
  return m ? 'show:' + m[1].trim().toLowerCase() : null;
}

function renderContinueWatching() {
  const sorted = Object.entries(_watchProgress)
    .filter(([, v]) => v.pct > 3 && v.pct < FINISH_PCT)
    .sort(([, a], [, b]) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));

  // Keep only the most-recently-watched episode per show (list is already sorted
  // newest-first, so the first one we see for a show wins).
  const seenShows = new Set();
  const items = sorted.filter(([, v]) => {
    const key = continueShowKey(v);
    if (!key) return true;
    if (seenShows.has(key)) return false;
    seenShows.add(key);
    return true;
  });

  const row   = $('rowContinue');
  const track = $('rowContinueTrack');
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;

  track.innerHTML = items.map(([jobId, v]) => `
    <div class="card" data-continue-id="${jobId}" style="cursor:pointer" role="button" tabindex="0" aria-label="Resume ${escHtml(v.title || '')}">
      <div style="position:relative">
        <img class="card-img" src="${v.posterPath ? POSTER(v.posterPath) : '/no-poster.svg'}" alt="${escHtml((v.title || 'Video') + ' poster')}" loading="lazy" onerror="this.src='/no-poster.svg'">
        <div class="continue-progress-wrap">
          <div class="continue-progress-fill" style="width:${v.pct}%"></div>
        </div>
        <div class="continue-play-icon">▶</div>
      </div>
      <div class="card-info" style="opacity:1;position:relative;background:none;padding:8px 4px 4px">
        <div class="card-title">${escHtml(v.title || '')}</div>
        <div class="card-meta" style="color:#888">${v.duration ? fmtTime(v.position) + ' / ' + fmtTime(v.duration) : ''}</div>
      </div>
    </div>`).join('');

  track.querySelectorAll('[data-continue-id]').forEach(card => {
    const resume = () => {
      const v = _watchProgress[card.dataset.continueId];
      if (!v?.streamUrl) return;
      currentJobId = card.dataset.continueId;
      openPlayer(v.streamUrl, v.title, v.posterPath);
    };
    card.addEventListener('click', resume);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resume(); }
    });
  });
}

// ── Library polling ────────────────────────────────────────────────────────
function startLibraryPolling() {
  fetchLibrary();
  fetchCatalog();
  loadProgress();
  loadWatchlistAndRatings();
  libraryPollTimer = setInterval(fetchLibrary, 5000);
  setInterval(fetchCatalog, 30_000);
}

async function fetchLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error(`API ${res.status}`);
    libraryData = await res.json();
    _libraryFetchFailed = false;
    updateWatchedSet();
    updateLibraryBadge();
    updateCardBadges();
    if (currentSection === 'library') renderLibraryGrid();
    // Re-render hero so Watch Now / Request stays in sync with library state
    if (heroMovies.length) renderHero(heroMovies[heroIdx]);
  } catch {
    // Only surface the first failure — the poll retries every 5s
    if (!_libraryFetchFailed) {
      _libraryFetchFailed = true;
      toast("Couldn't reach your library — retrying…");
    }
  }
}

async function fetchCatalog() {
  try {
    const data = await fetch('/api/catalog').then(r => r.json());
    catalogData = Array.isArray(data) ? data : [];
    renderReadyNowRows();
    updateCardBadges();
  } catch {}
}

function renderReadyNowRows() {
  // Only surface verified, non-CAM copies (defence-in-depth over the download gate).
  const movies = catalogData.filter(c => c.type === 'movie' && isVerifiedGood(c));
  // Collapse TV episodes into one card per show (not one per episode).
  const shows  = groupByShow(catalogData.filter(c => c.type === 'tv' && isVerifiedGood(c))).shows;

  const rowNow   = $('rowReadyNow');
  const trackNow = $('rowReadyNowTrack');
  if (rowNow && trackNow) {
    trackNow.innerHTML = '';
    if (movies.length) {
      movies.forEach(item => trackNow.appendChild(createCatalogCard(item)));
      rowNow.hidden = false;
    } else {
      rowNow.hidden = true;
    }
  }

  const rowTV   = $('rowReadyTV');
  const trackTV = $('rowReadyTVTrack');
  if (rowTV && trackTV) {
    trackTV.innerHTML = '';
    if (shows.length) {
      shows.forEach(item => trackTV.appendChild(createCatalogCard(item)));
      rowTV.hidden = false;
    } else {
      rowTV.hidden = true;
    }
  }
}

function createCatalogCard(item) {
  const card = document.createElement('div');
  card.className = 'card catalog-card';
  card.dataset.tmdbId = item.tmdbId;
  card.dataset.mediaType = item.type;

  const displayTitle = item.showTitle || item.title || '';
  const year = item.year || '';
  const epCount = item.episodes?.length || 0;
  const subLabel = item.type === 'tv' ? (epCount ? `${epCount} episode${epCount !== 1 ? 's' : ''}` : 'TV') : '';

  const altText = displayTitle ? `${displayTitle} poster` : 'Poster';
  card.innerHTML = `
    <img class="card-img" src="${POSTER(item.posterPath)}" alt="${escHtml(altText)}" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">
    <div class="card-play-btn">&#9654;</div>
    <div class="card-info">
      <div class="card-title">${escHtml(displayTitle)}</div>
      <div class="card-meta">
        ${year ? `<span>${year}</span>` : ''}
        ${subLabel ? `<span class="card-rating">${subLabel}</span>` : ''}
      </div>
    </div>
    <div class="card-lib-tag" data-state="ready">&#9654; Ready</div>
  `;

  // Many catalog/season-pack jobs have no stored posterPath — fetch it from TMDB
  // by tmdbId so the card shows a real poster instead of the ♪ placeholder.
  if (!item.posterPath && item.tmdbId) {
    loadPosterForCard(card.querySelector('.card-img'), item.tmdbId, item.type);
  }

  const open = () => { if (item.type === 'tv') openTVModal(item.tmdbId); else openModal(item.tmdbId); };
  makeCardActivatable(card, open, `${displayTitle} — ready to play`);

  return card;
}

function updateLibraryBadge() {
  const inProgress = libraryData.filter(j => ['queued','searching','downloading','uploading'].includes(j.status)).length;
  if (inProgress > 0) {
    libBadge.textContent = inProgress;
    libBadge.hidden = false;
    if (bottomBadge) { bottomBadge.textContent = inProgress; bottomBadge.hidden = false; }
  } else {
    libBadge.hidden = true;
    if (bottomBadge) bottomBadge.hidden = true;
  }
}

function statusPillHtml(status, progress) {
  const map = {
    searching:   ['gray',   'Searching'],
    downloading: ['yellow', `Downloading${progress ? ' ' + progress + '%' : ''}`],
    uploading:   ['blue',   `Uploading${progress ? ' ' + progress + '%' : ''}`],
    processing:  ['blue',   'Processing'],
    ready:       ['green',  'Ready'],
    error:       ['red',    'Error'],
  };
  const [color, label] = map[status] || ['gray', status];
  return `<span class="status-pill status-${color}">${label}</span>`;
}

// Group library/catalog items so a multi-episode show is ONE card, not one per
// episode (avoids e.g. 10 identical posters for a 10-episode season). Movies
// stay individual; TV episodes collapse by show (tmdbId).
function groupByShow(items) {
  const movies = [];
  const showMap = new Map();
  for (const it of items) {
    if (it.type === 'tv') {
      const key = it.tmdbId || it.showTitle || it.title;
      if (!showMap.has(key)) showMap.set(key, { tmdbId: it.tmdbId, type: 'tv', showTitle: it.showTitle || it.title, posterPath: it.posterPath || null, episodes: [] });
      const g = showMap.get(key);
      g.episodes.push(it);
      if (!g.posterPath && it.posterPath) g.posterPath = it.posterPath;
    } else {
      movies.push(it);
    }
  }
  return { movies, shows: [...showMap.values()] };
}

// One Library card representing a whole show (aggregates its episodes' statuses).
function createLibShowCard(group) {
  const card = document.createElement('div');
  card.className = 'lib-card lib-card-show';
  const eps = group.episodes;
  const ready       = eps.filter(e => e.status === 'ready' && e.streamUrl);
  const downloading = eps.filter(e => ['queued','searching','downloading','uploading','processing'].includes(e.status));
  const errored     = eps.filter(e => e.status === 'error');
  const title = group.showTitle || '';
  const firstReady = ready.slice().sort((a,b) => (a.season - b.season) || (a.episode - b.episode))[0];
  const bits = [];
  if (ready.length)       bits.push(`${ready.length} ready`);
  if (downloading.length) bits.push(`${downloading.length} downloading`);
  if (errored.length)     bits.push(`${errored.length} failed`);
  const pillColor = downloading.length ? 'yellow' : (errored.length && !ready.length) ? 'red' : 'green';
  const playBtn = firstReady ? `<button class="lib-play-btn">&#9654; Play</button>` : '';

  card.innerHTML = `
    <div class="lib-card-inner">
      <img class="lib-poster" src="/no-poster.svg" alt="${escHtml(title + ' poster')}" loading="lazy">
      <div class="lib-card-body">
        <div class="lib-title">${escHtml(title)}</div>
        <div class="lib-episode">${eps.length} episode${eps.length !== 1 ? 's' : ''}</div>
        <span class="status-pill status-${pillColor}">${bits.join(' · ') || 'Ready'}</span>
      </div>
      <div class="lib-card-actions">
        ${playBtn}
        <button class="lib-del-btn lib-del-show" title="Remove show">&#10005;</button>
      </div>
    </div>`;

  if (group.tmdbId) loadPosterForCard(card.querySelector('.lib-poster'), group.tmdbId, 'tv');
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => { if (group.tmdbId) openTVModal(group.tmdbId); });

  card.querySelector('.lib-play-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const meta = { type: 'tv', showId: group.tmdbId, showName: title, season: firstReady.season, episode: firstReady.episode, posterPath: group.posterPath };
    openPlayer(firstReady.streamUrl, firstReady.title || `${title} S${firstReady.season}E${firstReady.episode}`, group.posterPath, meta);
  });
  card.querySelector('.lib-del-show').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove all ${eps.length} episode${eps.length !== 1 ? 's' : ''} of "${title}" from your library?`)) return;
    for (const ep of eps) await fetch(`/api/admin/job/${ep.id}`, { method: 'DELETE' }).catch(() => {});
    libraryData = libraryData.filter(j => !eps.some(ep => ep.id === j.id));
    updateLibraryBadge();
    renderLibraryGrid();
  });
  return card;
}

// ── Unified Library (state-grouped: Ready → Getting Ready → Saved → Failed) ──
const LIB_GETTING = ['queued','searching','downloading','uploading','processing'];
let _libEntryByKey = new Map();

// Turn a raw job status into friendly, non-technical copy for the user.
function friendlyStage(job) {
  const pct = job.progress ? ` ${job.progress}%` : '';
  switch (job.status) {
    case 'queued':      return job.queuePosition ? `In queue · #${job.queuePosition}` : 'In queue';
    case 'searching':   return 'Finding a copy…';
    case 'downloading': return `Downloading${pct}${job.eta ? ' · ' + fmtEta(job.eta) : ''}`;
    case 'uploading':
    case 'processing':  return `Preparing your video${pct}`;
    default:            return 'Working…';
  }
}

function movieState(job) {
  if (job.status === 'ready' && job.streamUrl) return 'ready';
  if (job.status === 'error') return 'failed';
  return 'getting';
}

// renderLibraryGrid name kept so existing callers work; renders the whole thing.
function renderLibraryGrid() {
  const sec = $('librarySection');
  if (!sec) return;

  // 1. Build one entry per title, merging requested jobs + saved (watchlist).
  const { movies, shows } = groupByShow(libraryData);
  const entries = [];
  for (const job of movies) {
    entries.push({ key: `movie:${job.tmdbId || job.id}`, state: movieState(job),
      type: 'movie', tmdbId: job.tmdbId, title: job.title, year: job.year,
      posterPath: job.posterPath, job });
  }
  for (const g of shows) {
    const eps = g.episodes;
    const ready   = eps.filter(e => e.status === 'ready' && e.streamUrl);
    const getting = eps.filter(e => LIB_GETTING.includes(e.status));
    const failed  = eps.filter(e => e.status === 'error');
    const state = ready.length ? 'ready' : getting.length ? 'getting' : 'failed';
    entries.push({ key: `tv:${g.tmdbId}`, state, type: 'tv', tmdbId: g.tmdbId,
      title: g.showTitle, posterPath: g.posterPath, group: g, ready, getting, failed });
  }
  const have = new Set(entries.map(e => e.key));
  for (const item of _watchlist) {
    const key = `${item.type}:${item.tmdbId}`;
    if (have.has(key)) continue;
    entries.push({ key, state: 'saved', type: item.type, tmdbId: item.tmdbId,
      title: item.title, year: item.year, posterPath: item.posterPath, watchItem: item });
  }

  _libEntryByKey = new Map(entries.map(e => [e.key, e]));

  if (!entries.length) {
    sec.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎬</div>
        <div class="empty-state-title">Your library is empty</div>
        <div class="empty-state-sub">Find a movie or show and hit <strong>Download</strong> — it'll appear here and start streaming when ready. Titles you're not ready to watch yet can be Saved for later with ♡.</div>
      </div>`;
    return;
  }

  // 2. Bucket by state and render priority shelves (each hidden when empty).
  const buckets = { ready: [], getting: [], saved: [], failed: [] };
  for (const e of entries) (buckets[e.state] || buckets.saved).push(e);

  const shelf = (icon, label, list) => list.length ? `
    <div class="lib-shelf">
      <h2 class="row-title">${icon} ${label} <span class="lib-shelf-count">${list.length}</span></h2>
      <div class="grid lib-grid">${list.map(libTileHtml).join('')}</div>
    </div>` : '';

  sec.innerHTML =
    shelf('&#9654;', 'Ready to Watch', buckets.ready) +
    shelf('&#9203;', 'Getting Ready',  buckets.getting) +
    shelf('&#9733;', 'Saved',          buckets.saved) +
    shelf('&#9888;', 'Needs attention', buckets.failed);

  wireLibTiles(sec);
}

function libTileHtml(e) {
  const badge = { ready: '▶', getting: '◐', saved: '♡', failed: '⚠' }[e.state] || '';
  // Progress bar (getting only)
  let bar = '';
  if (e.state === 'getting') {
    const p = e.type === 'tv'
      ? Math.max(0, ...(e.getting || []).map(x => x.progress || 0))
      : (e.job?.progress || 0);
    bar = `<div class="lib-tile-bar"><div class="lib-tile-bar-fill" style="width:${p}%"></div></div>`;
  }
  // Sub line
  let sub = '';
  if (e.type === 'tv') {
    if (e.state === 'ready')   sub = `${e.ready.length} ready${e.getting?.length ? ' · ' + e.getting.length + ' downloading' : ''}`;
    else if (e.state === 'getting') sub = `${e.getting.length} downloading`;
    else if (e.state === 'failed')  sub = `${e.failed.length} failed`;
    else sub = 'Series';
  } else {
    if (e.state === 'getting')      sub = friendlyStage(e.job);
    else if (e.state === 'failed')  sub = 'Download failed';
    else sub = e.year ? String(e.year) : '';
  }
  // Primary action
  const action = {
    ready:  '<button class="lib-primary" data-act="play">&#9654; Play</button>',
    saved:  '<button class="lib-primary" data-act="download">&#8595; Download</button>',
    failed: '<button class="lib-primary" data-act="retry">&#8635; Retry</button>',
    getting: '',
  }[e.state] || '';
  const poster = e.posterPath ? POSTER(e.posterPath) : '/no-poster.svg';
  return `
    <div class="lib-tile lib-state-${e.state}" data-key="${escHtml(e.key)}" role="button" tabindex="0">
      <div class="lib-tile-poster">
        <img class="lib-tile-img" src="${poster}" alt="${escHtml((e.title || 'Title') + ' poster')}" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">
        <span class="lib-tile-badge lib-badge-${e.state}">${badge}</span>
        <button class="lib-tile-dismiss" data-act="dismiss" title="Remove from library" aria-label="Remove">&#10005;</button>
        ${bar}
      </div>
      <div class="lib-tile-title">${escHtml(e.title || '')}</div>
      <div class="lib-tile-sub">${escHtml(sub)}</div>
      ${action}
    </div>`;
}

function wireLibTiles(root) {
  root.querySelectorAll('.lib-tile').forEach(tile => {
    const e = _libEntryByKey.get(tile.dataset.key);
    if (!e) return;
    // Lazy-load poster by tmdbId when we didn't have a stored path.
    if (!e.posterPath && e.tmdbId) loadPosterForCard(tile.querySelector('.lib-tile-img'), e.tmdbId, e.type);

    const openDetails = () => { if (!e.tmdbId) return; e.type === 'tv' ? openTVModal(e.tmdbId) : openModal(e.tmdbId); };

    tile.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) { openDetails(); return; }
      ev.stopPropagation();
      if (act === 'play')     libPlay(e);
      else if (act === 'download') libDownload(e);
      else if (act === 'retry')    libRetry(e, ev.target.closest('[data-act]'));
      else if (act === 'dismiss')  libDismiss(e);
    });
    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetails(); }
    });
  });
}

function libPlay(e) {
  if (e.type === 'tv') {
    const first = (e.ready || []).slice().sort((a,b) => (a.season-b.season)||(a.episode-b.episode))[0];
    if (!first) return;
    const meta = { type: 'tv', showId: e.tmdbId, showName: e.title, season: first.season, episode: first.episode, posterPath: e.posterPath };
    openPlayer(first.streamUrl, first.title || `${e.title} S${first.season}E${first.episode}`, e.posterPath, meta);
  } else if (e.job?.streamUrl) {
    openPlayer(e.job.streamUrl, e.job.title);
  }
}

async function libDownload(e) {
  if (e.type === 'tv') { openTVModal(e.tmdbId); return; } // pick an episode
  toast(`📥 Requesting ${e.title}…`);
  try {
    const res = await fetch('/api/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: e.tmdbId, title: e.title, year: e.year, type: 'movie', posterPath: e.posterPath }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Request failed'); return; }
    if (data.ready && data.streamUrl) { openPlayer(data.streamUrl, e.title, e.posterPath); return; }
    await fetchLibrary();
  } catch { toast('Request failed'); }
}

async function libRetry(e, btn) {
  const ids = e.type === 'tv' ? (e.failed || []).map(x => x.id) : (e.job ? [e.job.id] : []);
  if (!ids.length) return;
  if (btn) { btn.textContent = '↺ Retrying…'; btn.disabled = true; }
  for (const id of ids) {
    try {
      const res = await fetch(`/api/job/${id}/retry`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.jobId) socket.emit('watch:join', data.jobId);
    } catch {}
  }
  await fetchLibrary();
}

async function libDismiss(e) {
  const ids = e.type === 'tv'
    ? [...(e.ready||[]), ...(e.getting||[]), ...(e.failed||[])].map(x => x.id)
    : (e.job ? [e.job.id] : []);
  const label = e.type === 'tv' && ids.length > 1
    ? `Remove all ${ids.length} episodes of "${e.title}" from your library?`
    : `Remove "${e.title}" from your library?`;
  if (ids.length && !confirm(label)) return;
  for (const id of ids) await fetch(`/api/admin/job/${id}`, { method: 'DELETE' }).catch(() => {});
  // Also drop it from the saved list so it doesn't reappear as a Saved tile.
  if (e.tmdbId) {
    _watchlist = _watchlist.filter(i => !(i.tmdbId === e.tmdbId && i.type === e.type));
    fetch(`/api/watchlist/${e.type}/${e.tmdbId}`, { method: 'DELETE' }).catch(() => {});
  }
  libraryData = libraryData.filter(j => !ids.includes(j.id));
  updateLibraryBadge();
  renderLibraryGrid();
}

// Poster cache: tmdbId → poster_path
const posterCache = new Map();

async function loadPosterForCard(imgEl, tmdbId, type) {
  if (!tmdbId) return;
  const cached = posterCache.get(String(tmdbId));
  if (cached) { imgEl.src = `${IMG}/w342${cached}`; return; }
  try {
    const path = type === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const data = await tmdb(path);
    if (data.poster_path) {
      posterCache.set(String(tmdbId), data.poster_path);
      imgEl.src = `${IMG}/w342${data.poster_path}`;
    }
  } catch {}
}

// ── Profile ────────────────────────────────────────────────────────────────
const TIER_DEFS = [
  { id: 'extra',         name: 'Extra',         min: 1  },
  { id: 'scene-stealer', name: 'Scene Stealer', min: 3  },
  { id: 'a-lister',      name: 'A-Lister',      min: 5  },
  { id: 'mogul',         name: 'Mogul',         min: 10 },
];
const PROFILE_COLORS = ['#ff0099','#3498db','#2ecc71','#e74c3c','#9b59b6','#f39c12','#1abc9c','#e67e22'];
const BADGE_CLASSES   = { 'Night Owl': 'night-owl', 'Morning Lark': 'morning-lark' };

// ── Scrollbar preference (off by default) ───────────────────────────────────
const SCROLLBAR_PREF_KEY = 'rmShowScrollbars';
function applyScrollbarPref() {
  // Off by default: only add the class when the user has explicitly opted in.
  document.documentElement.classList.toggle('show-scrollbars',
    localStorage.getItem(SCROLLBAR_PREF_KEY) === '1');
}
applyScrollbarPref();

// ── Client telemetry → admin (device + JS/playback errors) ──────────────────
let _lastClientLog = { msg: '', t: 0 };
function logClient(level, message, context) {
  try {
    const now = Date.now();
    const m = String(message || '').slice(0, 500);
    if (!m) return;
    if (m === _lastClientLog.msg && now - _lastClientLog.t < 30000) return; // dedup bursts
    _lastClientLog = { msg: m, t: now };
    fetch('/api/client-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message: m, context }), keepalive: true,
    }).catch(() => {});
  } catch {}
}
// One "session" ping per tab so the admin sees which devices are in use.
try {
  if (!sessionStorage.getItem('rmSessionLogged')) {
    sessionStorage.setItem('rmSessionLogged', '1');
    logClient('session', 'session', { screen: `${screen.width}x${screen.height}`, dpr: window.devicePixelRatio, lang: navigator.language });
  }
} catch {}
window.addEventListener('error', (e) => logClient('error', e.message || 'script error', { src: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => logClient('error', 'unhandledrejection: ' + (e.reason?.message || String(e.reason || '')).slice(0, 200)));

// ── PWA install / Add to Home Screen ────────────────────────────────────────
let _deferredInstall = null;
function _pwaIsInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
// Capture the Android/Chrome install event early (it can fire before setup runs).
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); _deferredInstall = e; _pwaMaybeShow(); });
window.addEventListener('appinstalled', () => {
  const bar = document.getElementById('pwaInstall');
  if (bar) bar.hidden = true;
  try { localStorage.setItem('pwaInstallDismissed', '1'); } catch {}
});

function _pwaMaybeShow() {
  const bar = document.getElementById('pwaInstall');
  if (!bar || _pwaIsInstalled()) return;
  if (localStorage.getItem('pwaInstallDismissed') === '1') return;
  const btn = document.getElementById('pwaInstallBtn');
  if (_deferredInstall && btn) {
    document.getElementById('pwaInstallHint').textContent = 'Add it to your home screen for a full-screen, app-like experience.';
    btn.hidden = false;
    bar.hidden = false;
  }
}

function setupPwaInstall() {
  const bar = document.getElementById('pwaInstall');
  if (!bar || _pwaIsInstalled()) return;
  if (localStorage.getItem('pwaInstallDismissed') === '1') return;

  const btn   = document.getElementById('pwaInstallBtn');
  const hint  = document.getElementById('pwaInstallHint');
  const close = document.getElementById('pwaInstallClose');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS

  close.addEventListener('click', () => { bar.hidden = true; try { localStorage.setItem('pwaInstallDismissed', '1'); } catch {} });

  if (isIOS) {
    // iOS has no install prompt API — show the Share → Add to Home Screen steps.
    hint.innerHTML = 'Tap the Share button, then <strong>Add to Home Screen</strong>.';
    btn.hidden = true;
    bar.hidden = false;
  } else {
    // Android/desktop Chrome: wire the deferred prompt (may already be captured).
    btn.addEventListener('click', async () => {
      if (!_deferredInstall) return;
      _deferredInstall.prompt();
      const { outcome } = await _deferredInstall.userChoice.catch(() => ({ outcome: 'dismissed' }));
      _deferredInstall = null;
      bar.hidden = true;
      if (outcome === 'accepted') { try { localStorage.setItem('pwaInstallDismissed', '1'); } catch {} }
    });
    _pwaMaybeShow();
  }
}
setupPwaInstall();

function setupProfile() {
  const btn      = $('navAvatarBtn');
  const wrap     = $('profileModalWrap');
  const closeBtn = $('profileClose');

  // Scrollbar preference toggle
  const scrollToggle = $('prefScrollbars');
  if (scrollToggle) {
    scrollToggle.checked = localStorage.getItem(SCROLLBAR_PREF_KEY) === '1';
    scrollToggle.addEventListener('change', () => {
      localStorage.setItem(SCROLLBAR_PREF_KEY, scrollToggle.checked ? '1' : '0');
      applyScrollbarPref();
    });
  }

  // Install App — always reachable here (even after dismissing the auto banner).
  const installBtn  = $('profileInstallBtn');
  const installHint = $('profileInstallHint');
  if (installBtn) {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (_pwaIsInstalled()) {
      installBtn.textContent = '✓ Already installed';
      installBtn.disabled = true;
    } else if (isIOS) {
      installBtn.addEventListener('click', () => {
        installHint.innerHTML = 'Tap the <strong>Share</strong> button in your browser, then <strong>Add to Home Screen</strong>.';
        installHint.hidden = false;
      });
    } else {
      installBtn.addEventListener('click', async () => {
        if (_deferredInstall) {
          _deferredInstall.prompt();
          const { outcome } = await _deferredInstall.userChoice.catch(() => ({ outcome: 'dismissed' }));
          _deferredInstall = null;
          if (outcome === 'accepted') { installBtn.textContent = '✓ Installed'; installBtn.disabled = true; }
        } else {
          installHint.innerHTML = 'Open your browser menu (⋮) and choose <strong>Install app</strong> / <strong>Add to Home screen</strong>.';
          installHint.hidden = false;
        }
      });
    }
  }
  const backdrop = $('profileModalBackdrop');
  if (!btn) return;

  btn.addEventListener('click', openProfile);
  $('bottomProfileBtn')?.addEventListener('click', openProfile);
  closeBtn.addEventListener('click', closeProfile);
  backdrop.addEventListener('click', closeProfile);

  $('profileSignOut')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  });

  // Email edit
  $('profileEmailEdit').addEventListener('click', () => {
    $('profileEmailInput').value = _profileData?.email || '';
    $('profileEmailRow').hidden = true;
    $('profileEmailEditRow').hidden = false;
    $('profileEmailInput').focus();
  });
  $('profileEmailCancel').addEventListener('click', () => {
    $('profileEmailRow').hidden = false;
    $('profileEmailEditRow').hidden = true;
  });
  $('profileEmailSave').addEventListener('click', async () => {
    const email = $('profileEmailInput').value.trim();
    try {
      const res = await fetch('/api/profile/email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        if (_profileData) _profileData.email = email || null;
        $('profileEmailVal').textContent = email || 'Not set';
        $('profileEmailRow').hidden = false;
        $('profileEmailEditRow').hidden = true;
        toast('Email saved');
      } else {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Failed to save email');
      }
    } catch { toast('Network error saving email'); }
  });
  $('profileEmailInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('profileEmailSave').click(); });

  // Avatar upload
  const avatarWrap  = $('profileAvatarWrap');
  const avatarInput = $('profileAvatarInput');
  avatarWrap.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    const dataUrl = await resizeAvatar(file, 150);
    if (!dataUrl) { toast('Could not read image — try a different file'); return; }
    try {
      const res  = await fetch('/api/profile/avatar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: dataUrl }),
      });
      if (res.ok) {
        if (_profileData) _profileData.avatar = dataUrl;
        renderProfileAvatar(dataUrl, loggedInUser, _profileData?.profileColor);
        applyProfileToNav({ ..._profileData, avatar: dataUrl });
        toast('Profile picture updated');
      } else {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Failed to save profile picture');
      }
    } catch { toast('Network error saving profile picture'); }
    avatarInput.value = '';
  });
}

async function openProfile() {
  const wrap = $('profileModalWrap');
  wrap.hidden = false;
  // Refresh profile data
  try {
    const res = await fetch('/api/profile');
    if (res.ok) { _profileData = await res.json(); applyProfileToNav(_profileData); }
  } catch {}
  renderProfileModal(_profileData);
}

function closeProfile() { $('profileModalWrap').hidden = true; }

function renderProfileModal(p) {
  if (!p) return;

  // Username + color
  const usernameEl = $('profileModalUsername');
  usernameEl.textContent = p.username || '';
  usernameEl.style.color = p.profileColor || '';

  // Rank
  $('profileRank').textContent = `${p.cinephileRank || 'Newcomer'} · ${p.watchTotal || 0} films watched`;

  // Tier badge
  const tierEl = $('profileTier');
  if (p.tierName) {
    tierEl.textContent = p.tierName;
    tierEl.style.color = p.tierColor || '#fff';
    tierEl.style.borderColor = p.tierColor ? `${p.tierColor}44` : '#333';
    tierEl.hidden = false;
  } else {
    tierEl.hidden = true;
  }

  // Email
  $('profileEmailVal').textContent = p.email || 'Not set';
  $('profileEmailRow').hidden = false;
  $('profileEmailEditRow').hidden = true;

  // Avatar
  renderProfileAvatar(p.avatar, p.username, p.profileColor);

  // Badges
  const badgesEl = $('profileBadges');
  badgesEl.innerHTML = '';
  for (const b of (p.badges || [])) {
    const span = document.createElement('span');
    span.className = `profile-badge${BADGE_CLASSES[b] ? ' ' + BADGE_CLASSES[b] : ''}`;
    span.textContent = b;
    badgesEl.appendChild(span);
  }

  // Referral code
  const code = p.referralCode || '—';
  $('profileReferralCode').textContent = code;

  $('profileCopyCode').onclick = () => {
    navigator.clipboard.writeText(code).then(() => toast('Invite code copied!'));
  };
  $('profileShareCode').onclick = () => {
    const url = `${location.origin}/login?ref=${code}`;
    navigator.clipboard.writeText(url).then(() => toast('Share link copied!'));
  };

  // Referral summary
  const count      = p.referralCount || 0;
  const bonusMs    = p.referralBonusMs || 0;
  const pendingMs  = p.pendingBonusMs  || 0;
  const DAY_MS     = 24 * 60 * 60 * 1000;
  const bonusDays   = Math.round(bonusMs   / DAY_MS);
  const pendingDays = Math.round(pendingMs / DAY_MS);
  const statsEl = $('profileReferralStats');
  if (count === 0) {
    statsEl.textContent = 'Share your code to earn free access.';
  } else {
    let html = `<strong>${count}</strong> ${count === 1 ? 'person' : 'people'} joined with your code`;
    if (bonusDays > 0)   html += ` · <span class="profile-bonus-time">+${bonusDays}d earned</span>`;
    if (pendingDays > 0) html += ` · <span style="color:#f39c12">+${pendingDays}d pending</span>`;
    statsEl.innerHTML = html;
  }

  // Referral list — one row per referred user
  const listEl = $('profileReferralList');
  const referrals = p.referrals || [];
  if (!referrals.length) { listEl.innerHTML = ''; }
  else {
    listEl.innerHTML = referrals.map(r => {
      let dot, label;
      if (r.pendingDueAt) {
        const days = Math.max(1, Math.round((r.pendingDueAt - Date.now()) / DAY_MS));
        const date = new Date(r.pendingDueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const bonus = r.pendingPlan === 'annual' ? '6 months' : '14 days';
        dot   = 'referral-dot-pending';
        label = `<span class="referral-label-pending">+${bonus} unlocks ${date} · ${days}d left</span>`;
      } else if (r.paidAt) {
        dot   = 'referral-dot-credited';
        label = `<span class="referral-label-credited">Subscribed · credit applied ✓</span>`;
      } else {
        dot   = 'referral-dot-none';
        label = `<span class="referral-label-none">Joined · hasn't subscribed yet</span>`;
      }
      return `<div class="referral-row">
        <span class="referral-dot ${dot}"></span>
        <span class="referral-name">${escHtml(r.username)}</span>
        ${label}
      </div>`;
    }).join('');
  }

  // Tier progress
  const tiersEl = $('profileTiers');
  tiersEl.innerHTML = '';
  for (const tier of TIER_DEFS) {
    const reached = count >= tier.min;
    const current = p.tier === tier.id;
    const step = document.createElement('div');
    step.className = `profile-tier-step${reached || current ? ' reached' : ''}${current ? ' current' : ''}`;
    step.innerHTML = `
      <div class="profile-tier-dot">${reached || current ? '✓' : tier.min}</div>
      <div class="profile-tier-label">${tier.name}</div>
      <div class="profile-tier-count">${tier.min} ref${tier.min > 1 ? 's' : ''}</div>
    `;
    tiersEl.appendChild(step);
  }

  // Color picker (unlocked at 3 referrals)
  const colorSection = $('profileColorSection');
  if (count >= 3) {
    colorSection.hidden = false;
    const colorsEl = $('profileColors');
    colorsEl.innerHTML = '';
    for (const color of PROFILE_COLORS) {
      const swatch = document.createElement('div');
      swatch.className = `profile-color-swatch${p.profileColor === color ? ' active' : ''}`;
      swatch.style.background = color;
      swatch.addEventListener('click', async () => {
        const res = await fetch('/api/profile/color', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color }),
        });
        if (res.ok) {
          colorsEl.querySelectorAll('.profile-color-swatch').forEach(s => s.classList.remove('active'));
          swatch.classList.add('active');
          if (_profileData) _profileData.profileColor = color;
          navUsername.style.color = color;
          $('profileModalUsername').style.color = color;
        }
      });
      colorsEl.appendChild(swatch);
    }
  } else {
    colorSection.hidden = true;
  }
}

function renderProfileAvatar(avatar, username, color) {
  const img  = $('profileAvatarImg');
  const init = $('profileAvatarInit');
  if (avatar) {
    img.src = avatar;
    img.hidden = false;
    init.hidden = true;
  } else {
    init.textContent = (username || '?')[0].toUpperCase();
    init.style.background = color || '#333';
    init.hidden = false;
    img.hidden = true;
  }
}

async function resizeAvatar(file, size) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
    img.src = objectUrl;
  });
}

// ── Watch stats tracking ────────────────────────────────────────────────────
let _currentTrackGenres = [];

function recordWatchStat(genres) {
  if (!genres?.length) return;
  const hour = new Date().getHours();
  fetch('/api/stats/watch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genres, hour }),
  }).catch(() => {});
}

// ── Mobile search sheet ────────────────────────────────────────────────────
function setupMobileSearch() {
  const sheet     = $('mobileSearchSheet');
  const panel     = $('mobileSearchPanel');
  const backdrop  = $('mobileSearchBackdrop');
  const mInput    = $('mobileSearchInput');
  const cancelBtn = $('mobileSearchCancel');
  const openBtn   = $('bottomSearchBtn');
  const mResults  = $('mobileSearchResults');
  if (!sheet || !openBtn) return;

  // Placeholder to re-insert searchResults back into main when sheet closes
  const placeholder = document.createComment('search-results-slot');

  function openSheet() {
    sheet.hidden = false;
    // Move the real #searchResults into the panel so doSearch renders inside the sheet
    mResults.appendChild(searchResults);
    searchResults.style.paddingTop = '0';
    document.body.style.overflow = 'hidden';
    mInput.focus(); // must be synchronous — rAF breaks iOS keyboard gesture context
  }

  function closeSheet() {
    // Move searchResults back to main before placeholder
    if (placeholder.parentNode) placeholder.parentNode.insertBefore(searchResults, placeholder);
    searchResults.style.paddingTop = '';
    searchResults.hidden = true;
    sheet.hidden = true;
    mInput.value = '';
    searchInput.value = '';
    searchClear.hidden = true;
    showCurrentRows();
    document.body.style.overflow = '';
  }

  // Insert placeholder where searchResults currently lives so we can restore it
  searchResults.parentNode.insertBefore(placeholder, searchResults);

  openBtn.addEventListener('click', openSheet);
  backdrop.addEventListener('click', closeSheet);
  cancelBtn.addEventListener('click', closeSheet);

  // Sync mobile input → existing search logic
  let debounceM;
  mInput.addEventListener('input', () => {
    const q = mInput.value.trim();
    searchInput.value = q;
    clearTimeout(debounceM);
    if (!q) { searchResults.hidden = true; return; }
    debounceM = setTimeout(() => doSearch(q), 400);
  });
}

// ── Search ─────────────────────────────────────────────────────────────────
function setupSearch() {
  let debounce;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.hidden = !q;
    clearTimeout(debounce);
    if (!q) { showCurrentRows(); return; }
    // Hide the hero carousel immediately on first keystroke — don't wait for debounce
    heroEl.hidden = true;
    rows.hidden = true; tvRows.hidden = true; librarySection.hidden = true;
    debounce = setTimeout(() => doSearch(q), 400);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    showCurrentRows();
  });

  $('filmographyBack').addEventListener('click', () => {
    $('searchFilmography').hidden = true;
    $('searchNormal').hidden = false;
  });

  document.addEventListener('keydown', (e) => {
    if (!playerOverlay.hidden) {
      switch (e.key) {
        case 'Escape':   if (!$('episodesMenu').hidden) closeEpisodesPanel(); else closePlayer(); break;
        case ' ': case 'k': e.preventDefault(); _playerTogglePlay?.(); break;
        case 'f': case 'F': _playerToggleFs?.(); break;
        case 'm': case 'M': _playerToggleMute?.(); break;
        case 'ArrowLeft':  e.preventDefault(); videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); break;
        case 'ArrowRight': e.preventDefault(); if (videoEl.duration) videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + 10); break;
        case 'ArrowUp':    e.preventDefault(); videoEl.volume = Math.min(1, videoEl.volume + 0.1); break;
        case 'ArrowDown':  e.preventDefault(); videoEl.volume = Math.max(0, videoEl.volume - 0.1); break;
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!fetchOverlay.hidden) {
        stopCountdown(); fetchOverlay.hidden = true;
        document.body.style.overflow = ''; return;
      }
      if (!tvModalWrap.hidden) { closeTVModal(); return; }
      if (!modalWrap.hidden)   { closeModal();   return; }
    }
  });
}

// One TMDB multi-search (movies + TV + people in a single call), short-cached so
// re-typing the same query doesn't re-fetch. tmdb() deliberately skips search.
const _searchCache = new Map();
async function searchMulti(q) {
  const key = q.toLowerCase().trim();
  const c = _searchCache.get(key);
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.v;
  const v = await tmdb('/search/multi', { query: q });
  _searchCache.set(key, { t: Date.now(), v });
  return v;
}

async function doSearch(q) {
  searchResults.hidden = false;
  heroEl.hidden = true;
  rows.hidden = true; tvRows.hidden = true; librarySection.hidden = true;

  // Show normal results, hide filmography drilldown
  $('searchNormal').hidden = false;
  $('searchFilmography').hidden = true;

  searchGrid.innerHTML = '<p style="color:#555;padding:8px 0">Searching…</p>';
  const tvGrid      = $('searchTVGrid');
  const peopleGrid  = $('searchPeopleGrid');
  const peopleSection = $('searchPeopleSection');
  tvGrid.innerHTML  = '';
  peopleGrid.innerHTML = '';
  peopleSection.hidden = true;

  const moviesSection = $('searchMoviesSection');
  const tvSection     = $('searchTVSection');

  let results;
  try { results = (await searchMulti(q)).results ?? []; }
  catch { searchGrid.innerHTML = ''; toast('Search failed — check your connection and try again'); return; }

  // Rank: exact title match first, then prefix match, then popularity.
  const ql = q.toLowerCase().trim();
  const titleOf = (x) => (x.title || x.name || '').toLowerCase();
  const rank = (a, b) => {
    const sa = titleOf(a) === ql ? 2 : titleOf(a).startsWith(ql) ? 1 : 0;
    const sb = titleOf(b) === ql ? 2 : titleOf(b).startsWith(ql) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return (b.popularity || 0) - (a.popularity || 0);
  };
  const movies = results.filter(r => r.media_type === 'movie' && r.title).sort(rank);
  const shows  = results.filter(r => r.media_type === 'tv'    && r.name).sort(rank);
  const people = results.filter(r => r.media_type === 'person' && (r.profile_path || (r.known_for || []).length))
                        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

  // ── Available now: titles from the results we already hold (verified) ──
  renderAvailableNow(movies, shows);

  // Movies
  searchGrid.innerHTML = '';
  if (movies.length) {
    for (const m of movies.slice(0, 20)) searchGrid.appendChild(createCard(m, 'movie', { caption: true }));
  } else {
    searchGrid.innerHTML = '<p style="color:#555;padding:8px 0">No movies found.</p>';
  }

  // TV
  if (shows.length) {
    for (const s of shows.slice(0, 20)) tvGrid.appendChild(createCard(s, 'tv', { caption: true }));
  } else {
    tvGrid.innerHTML = '<p style="color:#555;padding:8px 0">No TV shows found.</p>';
  }

  // People
  if (people.length) {
    for (const p of people.slice(0, 12)) peopleGrid.appendChild(createActorCard(p));
    peopleSection.hidden = false;
  }

  updateCardBadges();

  // Nothing at all — show one friendly empty state instead of "not found"s
  document.getElementById('searchEmptyState')?.remove();
  const anyResults = movies.length || shows.length || people.length;
  if (!anyResults) {
    moviesSection.hidden = true;
    tvSection.hidden = true;
    const empty = document.createElement('div');
    empty.id = 'searchEmptyState';
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-state-icon">🔍</div>
      <div class="empty-state-title">No results for “${escHtml(q)}”</div>
      <div class="empty-state-sub">Check the spelling, or try a different title, actor, or director.</div>`;
    $('searchNormal').appendChild(empty);
  } else {
    moviesSection.hidden = false;
    tvSection.hidden = false;
  }
}

// Surface search results we already have downloaded (verified) as an "Available
// now" shelf at the top, so users instantly see what's watchable vs requestable.
function renderAvailableNow(movies, shows) {
  const sec = $('searchAvailableSection'), grid = $('searchAvailableGrid');
  if (!sec || !grid) return;
  const has = (id, type) => catalogData.some(c => c.type === type && c.tmdbId === id && c.streamUrl && isVerifiedGood(c));
  const avail = [
    ...movies.filter(m => has(m.id, 'movie')).map(m => ({ m, t: 'movie' })),
    ...shows.filter(s => has(s.id, 'tv')).map(s => ({ m: s, t: 'tv' })),
  ];
  grid.innerHTML = '';
  if (!avail.length) { sec.hidden = true; return; }
  for (const { m, t } of avail.slice(0, 20)) grid.appendChild(createCard(m, t, { caption: true }));
  sec.hidden = false;
}

function createActorCard(person) {
  const card = document.createElement('div');
  card.className = 'actor-card';
  const photo = person.profile_path
    ? `${IMG}/w185${person.profile_path}`
    : `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' rx='40' fill='%231a1a1a'/%3E%3Ctext x='40' y='48' text-anchor='middle' font-size='32' fill='%23444'%3E👤%3C/text%3E%3C/svg%3E`;
  const knownFor = (person.known_for ?? [])
    .map(k => k.title || k.name).filter(Boolean).slice(0, 2).join(', ');
  card.innerHTML = `
    <img class="actor-photo" src="${photo}" alt="${escHtml((person.name || 'Person') + ' headshot')}">
    <div class="actor-name">${escHtml(person.name)}</div>
    <div class="actor-dept">${escHtml(person.known_for_department || '')}</div>
    ${knownFor ? `<div class="actor-known">${escHtml(knownFor)}</div>` : ''}
  `;
  makeCardActivatable(card, () => openFilmography(person.id, person.name),
    `${person.name || 'Person'} — view filmography`);
  return card;
}

async function openFilmography(personId, personName) {
  $('searchNormal').hidden = true;
  $('searchFilmography').hidden = false;
  $('filmographyName').textContent = personName;
  $('filmographyMoviesGrid').innerHTML = '<p style="color:#555;padding:8px 0">Loading…</p>';
  $('filmographyTVGrid').innerHTML = '';

  const data = await fetch(`/api/people/${personId}/credits`).then(r => r.json()).catch(() => ({}));
  const cast = data.cast ?? [];

  const movies = cast
    .filter(c => c.media_type === 'movie' && c.poster_path)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i) // dedupe
    .slice(0, 40);

  const shows = cast
    .filter(c => c.media_type === 'tv' && c.poster_path)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
    .slice(0, 20);

  $('filmographyMoviesGrid').innerHTML = '';
  if (movies.length) {
    for (const m of movies) $('filmographyMoviesGrid').appendChild(createCard(m, 'movie', { caption: true }));
  } else {
    $('filmographyMoviesGrid').innerHTML = '<p style="color:#555;padding:8px 0">No movies found.</p>';
  }

  $('filmographyTVGrid').innerHTML = '';
  if (shows.length) {
    for (const s of shows) $('filmographyTVGrid').appendChild(createCard(s, 'tv', { caption: true }));
  } else {
    $('filmographyTVGrid').innerHTML = '<p style="color:#555;padding:8px 0">No TV shows found.</p>';
  }

  updateCardBadges();
}

function showCurrentRows() {
  searchResults.hidden  = true;
  heroEl.hidden         = currentSection !== 'home';
  rows.hidden           = currentSection !== 'home';
  tvRows.hidden         = currentSection !== 'tv';
  librarySection.hidden = currentSection !== 'library';
  const listsSec = document.getElementById('listsSection');
  if (listsSec) listsSec.hidden = currentSection !== 'lists';
}

// ── Nav ────────────────────────────────────────────────────────────────────
function syncBottomTabs(section) {
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.section === section);
  });
}

// ── Feedback / feature-request modal (replaces the old live chat) ────────────
let _fbType = 'feature';
let _fbImage = null; // resized screenshot as a base64 data URL

// Downscale + JPEG-compress an image file so the payload stays small.
function _fbResizeImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height);
        width = Math.round(width * s); height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}
function _fbClearImage() {
  _fbImage = null;
  const inp = $('fbImage'), prev = $('fbPreview');
  if (inp) inp.value = '';
  if (prev) prev.hidden = true;
}

function openFeedback() {
  const ov = $('fbOverlay'); if (!ov) return;
  $('fbForm').hidden = false;
  $('fbThanks').hidden = true;
  _fbClearImage();
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('fbMessage')?.focus(), 50);
}
function closeFeedback() {
  const ov = $('fbOverlay'); if (!ov) return;
  ov.hidden = true;
  document.body.style.overflow = '';
}
function setupFeedback() {
  const ov = $('fbOverlay'); if (!ov) return;
  $('fbFab')?.addEventListener('click', openFeedback);
  $('bottomFeedbackBtn')?.addEventListener('click', openFeedback);
  $('fbClose')?.addEventListener('click', closeFeedback);
  $('fbBackdrop')?.addEventListener('click', closeFeedback);
  $('fbDone')?.addEventListener('click', closeFeedback);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) closeFeedback(); });

  $('fbTypes')?.querySelectorAll('.fb-type').forEach(btn => {
    btn.addEventListener('click', () => {
      _fbType = btn.dataset.type;
      $('fbTypes').querySelectorAll('.fb-type').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  const msg = $('fbMessage'), count = $('fbCount');
  msg?.addEventListener('input', () => { if (count) count.textContent = `${msg.value.length}/2000`; });

  // Screenshot attachment
  $('fbImage')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      _fbImage = await _fbResizeImage(file);
      const prevImg = $('fbPreviewImg'), prev = $('fbPreview');
      if (prevImg) prevImg.src = _fbImage;
      if (prev) prev.hidden = false;
    } catch { toast("Couldn't read that image"); _fbClearImage(); }
  });
  $('fbRemoveImg')?.addEventListener('click', _fbClearImage);

  $('fbSubmit')?.addEventListener('click', async () => {
    const message = (msg?.value || '').trim();
    if (!message) { msg?.focus(); return; }
    const btn = $('fbSubmit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: _fbType, message, page: location.pathname, image: _fbImage }),
      });
      if (!res.ok) throw new Error('failed');
      $('fbForm').hidden = true;
      $('fbThanks').hidden = false;
      msg.value = '';
      if (count) count.textContent = '';
      _fbClearImage();
    } catch {
      toast('Could not send — please try again');
    } finally {
      btn.disabled = false; btn.textContent = 'Send';
    }
  });
}

function setupNav() {
  window.addEventListener('scroll', () => {
    document.querySelector('.nav').classList.toggle('scrolled', window.scrollY > 20);
  });

  // Bottom tab bar (mobile)
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.section;
      if (section) switchSection(section);
    });
  });

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      const section = link.dataset.section;
      if (!section) return;
      switchSection(section);
    });
  });
}

// ── Browser back button ─────────────────────────────────────────────────────
// The app is a single page, so by default the browser Back button would leave
// the site. Instead, once the user navigates anywhere off the homepage (a
// section, a modal, the player, or an inline list), we push ONE history entry so
// Back returns them to the homepage / closes the open overlay.
let _navAway = false;
let _handlingPop = false;
function ensureAwayState() {
  if (_navAway || _handlingPop) return;
  _navAway = true;
  try { history.pushState({ rmAway: 1 }, ''); } catch {}
}
function returnHome() {
  if (!$('trailerOverlay').hidden) closeTrailer();
  if (!playerOverlay.hidden) closePlayer();
  if (!modalWrap.hidden)     closeModal();
  if (!tvModalWrap.hidden)   closeTVModal();
  if (!fetchOverlay.hidden)  { fetchOverlay.hidden = true; document.body.style.overflow = ''; }
  collapseInlineList();
  if (currentSection !== 'home') switchSection('home');
}
window.addEventListener('popstate', () => {
  _handlingPop = true;   // suppress re-pushing while we tear down
  _navAway = false;
  returnHome();
  _handlingPop = false;
});

function switchSection(section) {
  if (section !== 'home') ensureAwayState();
  currentSection = section;
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.section === section);
  });
  syncBottomTabs(section);
  searchInput.value = '';
  searchClear.hidden = true;
  searchResults.hidden = true;

  heroEl.hidden         = section !== 'home';
  rows.hidden           = section !== 'home';
  tvRows.hidden         = section !== 'tv';
  librarySection.hidden = section !== 'library';
  const listsSec = document.getElementById('listsSection');
  if (listsSec) listsSec.hidden = section !== 'lists';
  window.scrollTo(0, 0);

  searchInput.placeholder = 'Search movies & TV shows…';
  if (section === 'tv') {
    if (!tvRows.dataset.loaded) showRowSkeletons(tvRows);
    loadTVRows();
  } else if (section === 'library') {
    renderSaved();
    renderLibraryGrid();
    fetchLibrary();
  } else if (section === 'lists') {
    loadListsTab();
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── Util ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ── Watchlist & Ratings ────────────────────────────────────────────────────
async function loadWatchlistAndRatings() {
  try {
    const [wl, rt] = await Promise.all([
      fetch('/api/watchlist').then(r => r.json()),
      fetch('/api/ratings').then(r => r.json()),
    ]);
    _watchlist = Array.isArray(wl) ? wl : [];
    _ratings   = rt || {};
    renderSaved();
  } catch {}
}

function updateWatchedSet() {
  _watchedTmdbSet = new Set(libraryData.filter(j => j.tmdbId).map(j => j.tmdbId));
}

// Render the unified Library (state-grouped). renderLibraryGrid() builds it.
// Saved is now just one state inside the unified Library. Kept as a thin alias
// so existing callers still work; also refreshes homepage card badges.
function renderSaved() {
  renderLibraryGrid();
  updateCardBadges();
}

async function toggleWatchlist(tmdbId, type, title, posterPath, year) {
  const inWl = _watchlist.some(i => i.tmdbId === tmdbId && i.type === type);
  if (inWl) {
    _watchlist = _watchlist.filter(i => !(i.tmdbId === tmdbId && i.type === type));
    await fetch(`/api/watchlist/${type}/${tmdbId}`, { method: 'DELETE' }).catch(() => {});
    toast('Removed from Saved');
  } else {
    _watchlist.unshift({ tmdbId, type, title, posterPath, year, addedAt: Date.now() });
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId, type, title, posterPath, year }),
    }).catch(() => {});
    toast('Saved');
  }
  const nowIn = !inWl;
  for (const id of ['modalWlBtn', 'tvModalWlBtn']) {
    const btn = $(id);
    if (btn) { btn.textContent = nowIn ? '♥ Saved' : '♡ Save'; btn.classList.toggle('active', nowIn); }
  }
  renderSaved();
}

function renderStarRating(containerId, type, tmdbId) {
  const container = $(containerId);
  if (!container) return;
  const key     = `${type}:${tmdbId}`;
  const current = _ratings[key]?.rating || 0;
  container.innerHTML = `
    <div class="star-rating-wrap">
      <span class="star-label">Your rating</span>
      <div class="stars">
        ${[1,2,3,4,5].map(v => `<span class="star${current >= v ? ' active' : ''}" data-v="${v}">&#9733;</span>`).join('')}
      </div>
    </div>
  `;
  const starsEl = container.querySelector('.stars');
  starsEl?.addEventListener('mouseleave', () => {
    container.querySelectorAll('.star').forEach(s => s.classList.remove('hover'));
  });
  container.querySelectorAll('.star').forEach(star => {
    star.addEventListener('mouseenter', () => {
      const v = parseInt(star.dataset.v);
      container.querySelectorAll('.star').forEach(s => s.classList.toggle('hover', parseInt(s.dataset.v) <= v));
    });
    star.addEventListener('click', async () => {
      const v   = parseInt(star.dataset.v);
      const cur = _ratings[key]?.rating;
      if (cur === v) {
        delete _ratings[key];
        await fetch(`/api/ratings/${type}/${tmdbId}`, { method: 'DELETE' }).catch(() => {});
      } else {
        _ratings[key] = { rating: v, ratedAt: Date.now() };
        await fetch('/api/ratings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbId, type, rating: v }),
        }).catch(() => {});
      }
      renderStarRating(containerId, type, tmdbId);
    });
  });
}

async function buildWhyLikeThis(item, mediaType) {
  if (!_watchedTmdbSet.size) return [];
  const reasons = [];

  // Similar overlap
  const similar = item.similar?.results ?? [];
  for (const s of similar.slice(0, 15)) {
    if (_watchedTmdbSet.has(s.id) && s.id !== item.id) {
      reasons.push(`Similar to <em>${escHtml(s.title || s.name || '')}</em> in your library`);
      break;
    }
  }

  // Director's other films (movies only)
  if (mediaType === 'movie') {
    const director = item.credits?.crew?.find(c => c.job === 'Director');
    if (director?.id) {
      try {
        const data = await fetch(`/api/people/${director.id}/credits`).then(r => r.json());
        const directed = (data.crew ?? [])
          .filter(c => c.job === 'Director' && c.media_type === 'movie' && _watchedTmdbSet.has(c.id) && c.id !== item.id)
          .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
          .slice(0, 2);
        if (directed.length) {
          const titles = directed.map(c => `<em>${escHtml(c.title || '')}</em>`).join(' and ');
          reasons.push(`You have ${titles} in your library — also directed by ${escHtml(director.name)}`);
        }
      } catch {}
    }
  }

  // Creator's other works (TV only)
  if (mediaType === 'tv') {
    const creator = item.created_by?.[0];
    if (creator?.id) {
      try {
        const data = await fetch(`/api/people/${creator.id}/credits`).then(r => r.json());
        const works = [...(data.cast ?? []), ...(data.crew ?? [])]
          .filter(c => _watchedTmdbSet.has(c.id) && c.id !== item.id)
          .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
          .slice(0, 2);
        if (works.length) {
          const titles = works.map(c => `<em>${escHtml(c.title || c.name || '')}</em>`).join(' and ');
          reasons.push(`You have ${titles} in your library — also by ${escHtml(creator.name)}`);
        }
      } catch {}
    }
  }

  return reasons;
}

function tvStatusLabel(status, lastAirDate) {
  if (!status) return '';
  const endYear = lastAirDate ? lastAirDate.slice(0, 4) : '';
  const map = {
    'Returning Series': ['status-green', 'Returning'],
    'Ended':            ['status-gray',  endYear ? `Ended ${endYear}` : 'Ended'],
    'Canceled':         ['status-red',   'Cancelled'],
    'In Production':    ['status-blue',  'In Production'],
    'Planned':          ['status-blue',  'Planned'],
    'Pilot':            ['status-gray',  'Pilot'],
  };
  const entry = map[status];
  if (!entry) return '';
  const [cls, label] = entry;
  return `<span class="status-pill ${cls}">${escHtml(label)}</span>`;
}

// ── Cast (Chromecast + AirPlay) ─────────────────────────────────────────────
const CAST_ICON    = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3C1.9 3 1 3.9 1 5v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/></svg>`;
const AIRPLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 22h12l-6-6-6 6zM21 3H3C1.9 3 1 3.9 1 5v12c0 1.1.9 2 2 2h3v-2H3V5h18v12h-3v2h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`;

// AirPlay is available on Safari (iOS + macOS) — detected by webkitShowPlaybackTargetPicker
const _hasAirPlay = typeof videoEl?.webkitShowPlaybackTargetPicker === 'function'
  || /iPhone|iPad|iPod/i.test(navigator.userAgent);

function isCasting() {
  return !!(window.cast?.framework &&
    cast.framework.CastContext.getInstance().getCastState() === cast.framework.CastState.CONNECTED);
}

function syncCastPlayBtn() {
  const playBtn = $('playerPlayBtn');
  if (playBtn) playBtn.innerHTML = _remotePlayer?.isPaused ? PLAY_ICON : PAUSE_ICON;
}

function syncCastProgress() {
  if (_isCastSeeking) return;
  const cur = _remotePlayer?.currentTime || 0;
  const dur = _remotePlayer?.duration   || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  const seekLeft = $('playerSeekLeft');
  const handle   = $('playerHandle');
  const timeDisplay = $('playerTimeDisplay');
  if (seekLeft)     seekLeft.style.width    = `${pct}%`;
  if (handle)       handle.style.left       = `${pct}%`;
  if (timeDisplay)  timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
}

function syncCastMuteBtn() {
  const muteBtn = $('playerMuteBtn');
  if (muteBtn) muteBtn.innerHTML = _remotePlayer?.isMuted ? MUTED_ICON : VOL_ICON;
}

function setupCast() {
  const btn = $('playerCastBtn');
  if (!btn) return;

  // ── AirPlay (Safari / iOS) ──────────────────────────────────────────────
  if (_hasAirPlay) {
    btn.innerHTML = AIRPLAY_ICON;
    btn.title     = 'AirPlay';
    btn.hidden    = true; // shown by updateCastBtn when player is open

    btn.addEventListener('click', () => {
      if (typeof videoEl.webkitShowPlaybackTargetPicker === 'function') {
        videoEl.webkitShowPlaybackTargetPicker();
      }
    });

    // Show/hide based on AirPlay availability if the browser fires the event
    videoEl.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      const available = e.availability === 'available';
      btn.hidden = !available || playerOverlay.hidden;
    });

    // Always show the button when player is open on iOS — the picker will
    // tell the user if no AirPlay devices are found
    updateCastBtn();
    return;
  }

  // ── Chromecast (Chrome / Android) ────────────────────────────────────────
  const onReady = () => {
    if (!window.cast?.framework) return;
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, updateCastBtn);
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, updateCastBtn);

    _remotePlayer = new cast.framework.RemotePlayer();
    _remotePlayerController = new cast.framework.RemotePlayerController(_remotePlayer);

    const RPC = cast.framework.RemotePlayerEventType;
    _remotePlayerController.addEventListener(RPC.IS_PAUSED_CHANGED,     syncCastPlayBtn);
    _remotePlayerController.addEventListener(RPC.CURRENT_TIME_CHANGED,  syncCastProgress);
    _remotePlayerController.addEventListener(RPC.DURATION_CHANGED,      syncCastProgress);
    _remotePlayerController.addEventListener(RPC.IS_MUTED_CHANGED,      syncCastMuteBtn);
    _remotePlayerController.addEventListener(RPC.IS_CONNECTED_CHANGED, () => {
      if (!_remotePlayer.isConnected) {
        const lastTime = _remotePlayer.currentTime || 0;
        if (lastTime > 0) videoEl.currentTime = lastTime;
        videoEl.play().catch(() => {});
      }
    });

    btn.innerHTML = CAST_ICON;
    btn.addEventListener('click', toggleCast);
    updateCastBtn();
  };

  window.__onCastReady = onReady;
  if (window.__castAvailable) onReady();
}

function updateCastBtn() {
  const btn = $('playerCastBtn');
  if (!btn) return;

  // AirPlay path — show whenever the player is open
  if (_hasAirPlay) {
    btn.hidden = playerOverlay.hidden;
    return;
  }

  // Chromecast path
  if (!window.cast?.framework) return;
  const state     = cast.framework.CastContext.getInstance().getCastState();
  const CastState = cast.framework.CastState;
  const available = state !== CastState.NO_DEVICES_AVAILABLE;
  btn.hidden = !available || playerOverlay.hidden;
  const casting = state === CastState.CONNECTED;
  btn.classList.toggle('casting', casting);
  btn.title = casting ? 'Stop casting' : 'Cast to TV';
}

async function toggleCast() {
  if (!window.cast?.framework) return;
  const ctx = cast.framework.CastContext.getInstance();
  if (ctx.getCastState() === cast.framework.CastState.CONNECTED) {
    ctx.endCurrentSession(true);
    return;
  }
  try {
    await ctx.requestSession();
    loadMediaOnCast();
  } catch (e) {
    if (e !== chrome.cast.ErrorCode.CANCEL) toast('Could not connect to Chromecast');
  }
}

function loadMediaOnCast() {
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session || !videoEl.src) return;

  const mediaInfo = new chrome.cast.media.MediaInfo(videoEl.src, 'video/mp4');
  mediaInfo.metadata = new chrome.cast.media.MovieMediaMetadata();
  mediaInfo.metadata.title = playerTitle.textContent || '';

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = Math.floor(videoEl.currentTime || 0);
  request.autoplay = true;

  session.loadMedia(request).then(() => {
    videoEl.pause();
  }).catch(() => toast('Failed to load video on Chromecast'));
}

// ── Lists ──────────────────────────────────────────────────────────────────
let _myLists          = [];
let _listsCurrentTab  = 'community'; // 'community' | 'mine'
let _listsPage        = 1;
let _listsSort        = 'popular';
let _listsTotal       = 0;
let _listDetailId     = null;

const listsSection   = $('listsSection');
const listsGrid      = $('listsGrid');
const listDetail     = $('listDetail');
const listDetailGrid = $('listDetailGrid');

function setupLists() {
  // Tab switching
  document.querySelectorAll('.lists-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _listsCurrentTab = tab.dataset.ltab;
      document.querySelectorAll('.lists-tab').forEach(t => t.classList.toggle('active', t === tab));
      listDetail.hidden = true;
      listsGrid.parentElement.querySelector('.lists-load-more').hidden = true;
      loadListsTab();
    });
  });

  $('listsSort').addEventListener('change', (e) => {
    _listsSort = e.target.value;
    _listsPage = 1;
    listsGrid.innerHTML = '';
    loadListsTab();
  });

  $('createListBtn').addEventListener('click', () => openCreateListModal());
  $('listDetailBack').addEventListener('click', () => {
    listDetail.hidden = true;
    listsGrid.hidden  = false;
    document.querySelector('.lists-load-more').hidden = _listsTotal <= listsGrid.children.length;
  });

  $('listsLoadMoreBtn').addEventListener('click', () => {
    _listsPage++;
    loadCommunityLists(false);
  });

  // See all link on homepage row
  $('rowListsSeeAll').addEventListener('click', () => switchSection('lists'));

  // Import button in Library
  $('importBtn').addEventListener('click', openImportModal);
}

async function loadListsTab() {
  listDetail.hidden = true;
  listsGrid.hidden  = false;
  if (_listsCurrentTab === 'community') {
    _listsPage = 1;
    listsGrid.innerHTML = '';
    await loadCommunityLists(true);
  } else {
    await loadMyLists();
  }
}

async function loadCommunityLists(replace = true) {
  try {
    const data = await fetch(`/api/lists/public?sort=${_listsSort}&page=${_listsPage}`).then(r => r.json());
    _listsTotal = data.total;
    if (replace) listsGrid.innerHTML = '';
    data.items.forEach(l => listsGrid.appendChild(createListCard(l)));
    const loadMore = $('listsLoadMore');
    loadMore.hidden = _listsPage >= data.pages;
  } catch { toast('Could not load lists'); }
}

async function loadMyLists() {
  try {
    _myLists = await fetch('/api/lists/mine').then(r => r.json());
    listsGrid.innerHTML = '';
    if (!_myLists.length) {
      listsGrid.innerHTML = '<p style="color:#777;padding:24px 0">You have no lists yet. Create one!</p>';
      return;
    }
    _myLists.forEach(l => listsGrid.appendChild(createListCard(l, true)));
    $('listsLoadMore').hidden = true;
  } catch { toast('Could not load your lists'); }
}

function createListCard(list, showEdit = false) {
  const card = document.createElement('div');
  card.className = 'list-card';
  const posters = list.preview || [];
  card.innerHTML = `
    <div class="list-card-mosaic">
      ${posters.slice(0, 4).map(p => `<img src="${p ? `https://image.tmdb.org/t/p/w185${p}` : '/no-poster.svg'}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">`).join('')}
      ${posters.length === 0 ? '<div class="list-card-empty-poster"></div>' : ''}
    </div>
    <div class="list-card-info">
      <div class="list-card-title">${escHtml(list.title)}</div>
      <div class="list-card-meta">
        <span>by ${escHtml(list.username)}</span>
        <span>${list.itemCount || list.items?.length || 0} titles</span>
        <span class="list-card-likes ${list.liked ? 'liked' : ''}" data-lid="${list.id}">♥ ${list.likeCount || 0}</span>
      </div>
    </div>
  `;
  if (showEdit) {
    const editBtn = document.createElement('button');
    editBtn.className = 'list-card-edit';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditListModal(list); });
    card.appendChild(editBtn);
  }
  card.querySelector('.list-card-likes').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleListLike(list.id, card);
  });
  card.addEventListener('click', () => openListDetail(list.id));
  return card;
}

async function toggleListLike(listId, card) {
  try {
    const data = await fetch(`/api/lists/${listId}/like`, { method: 'POST' }).then(r => r.json());
    const likeEl = card.querySelector('.list-card-likes');
    if (likeEl) {
      likeEl.textContent = `♥ ${data.likeCount}`;
      likeEl.classList.toggle('liked', data.liked);
    }
  } catch { toast('Could not update like'); }
}

async function openListDetail(listId) {
  try {
    const list = await fetch(`/api/lists/${listId}`).then(r => r.json());
    _listDetailId = listId;
    $('listDetailTitle').textContent = list.title;
    $('listDetailDesc').textContent  = list.description || '';

    const isOwner = list.username === loggedInUser;
    $('listDetailMeta').innerHTML = `
      <span>by <strong>${escHtml(list.username)}</strong></span>
      <span>${list.items.length} titles</span>
    `;

    const actions = $('listDetailActions');
    actions.innerHTML = '';

    // Like button (only for other people's lists)
    if (!isOwner && list.isPublic) {
      const likeBtn = document.createElement('button');
      likeBtn.className = `btn btn-wl${list.liked ? ' active' : ''}`;
      likeBtn.textContent = `♥ ${list.likeCount}`;
      likeBtn.addEventListener('click', async () => {
        const data = await fetch(`/api/lists/${listId}/like`, { method: 'POST' }).then(r => r.json());
        likeBtn.textContent = `♥ ${data.likeCount}`;
        likeBtn.classList.toggle('active', data.liked);
      });
      actions.appendChild(likeBtn);
    }

    if (isOwner) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-info';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openEditListModal(list));
      actions.appendChild(editBtn);

      const visBtn = document.createElement('button');
      visBtn.className = 'btn btn-info';
      visBtn.textContent = list.isPublic ? '🔓 Public' : '🔒 Private';
      visBtn.addEventListener('click', async () => {
        const updated = await fetch(`/api/lists/${listId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPublic: !list.isPublic }),
        }).then(r => r.json());
        list.isPublic = updated.isPublic;
        visBtn.textContent = list.isPublic ? '🔓 Public' : '🔒 Private';
        toast(list.isPublic ? 'List is now public' : 'List is now private');
      });
      actions.appendChild(visBtn);
    }

    listDetailGrid.innerHTML = '';
    for (const item of list.items) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.tmdbId    = item.tmdbId;
      card.dataset.mediaType = item.type;
      card.innerHTML = `
        <img class="card-img" src="${item.posterPath ? `https://image.tmdb.org/t/p/w342${item.posterPath}` : '/no-poster.svg'}" alt="${escHtml(item.title || '')}" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">
        <div class="card-info">
          <div class="card-title">${escHtml(item.title || '')}</div>
          <div class="card-meta">${item.year ? `<span>${item.year}</span>` : ''}</div>
        </div>
      `;
      if (isOwner) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'list-item-remove';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/lists/${listId}/items/${item.type}/${item.tmdbId}`, { method: 'DELETE' });
          card.remove();
          toast('Removed from list');
        });
        card.appendChild(removeBtn);
      }
      card.addEventListener('click', () => {
        if (item.type === 'tv') openTVModal(item.tmdbId);
        else openModal(item.tmdbId);
      });
      listDetailGrid.appendChild(card);
    }

    listsGrid.hidden  = true;
    $('listsLoadMore').hidden = true;
    listDetail.hidden = false;
  } catch { toast('Could not load list'); }
}

function openCreateListModal(prefill = null) {
  const modal = $('createListModalWrap');
  $('createListModalHeading').textContent = 'New List';
  $('createListTitle').value  = prefill?.title || '';
  $('createListDesc').value   = prefill?.description || '';
  $('createListPublic').checked = prefill?.isPublic || false;
  $('createListSave').textContent = 'Create';
  $('createListSave').onclick = async () => {
    const title = $('createListTitle').value.trim();
    if (!title) { toast('Give your list a title'); return; }
    try {
      const list = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: $('createListDesc').value.trim(), isPublic: $('createListPublic').checked }),
      }).then(r => r.json());
      modal.hidden = true;
      _myLists.unshift(list);
      toast('List created');
      if (currentSection === 'lists') {
        _listsCurrentTab = 'mine';
        document.querySelectorAll('.lists-tab').forEach(t => t.classList.toggle('active', t.dataset.ltab === 'mine'));
        await loadMyLists();
      }
    } catch { toast('Could not create list'); }
  };
  modal.hidden = false;
}

function openEditListModal(list) {
  const modal = $('createListModalWrap');
  $('createListModalHeading').textContent = 'Edit List';
  $('createListTitle').value    = list.title;
  $('createListDesc').value     = list.description || '';
  $('createListPublic').checked = list.isPublic;
  $('createListSave').textContent = 'Save';
  $('createListSave').onclick = async () => {
    const title = $('createListTitle').value.trim();
    if (!title) { toast('Title required'); return; }
    try {
      await fetch(`/api/lists/${list.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: $('createListDesc').value.trim(), isPublic: $('createListPublic').checked }),
      });
      modal.hidden = true;
      toast('List updated');
      if (currentSection === 'lists') loadListsTab();
      if (_listDetailId === list.id) openListDetail(list.id);
    } catch { toast('Could not update list'); }
  };
  modal.hidden = false;

  // Add delete button for edit mode
  const btns = modal.querySelector('.simple-modal-btns');
  let delBtn = modal.querySelector('.list-delete-btn');
  if (!delBtn) {
    delBtn = document.createElement('button');
    delBtn.className = 'btn list-delete-btn';
    delBtn.textContent = 'Delete List';
    delBtn.style.cssText = 'background:#c00;color:#fff;margin-left:auto';
    btns.appendChild(delBtn);
  }
  delBtn.onclick = async () => {
    if (!confirm(`Delete "${list.title}"? This cannot be undone.`)) return;
    await fetch(`/api/lists/${list.id}`, { method: 'DELETE' });
    modal.hidden = true;
    toast('List deleted');
    if (currentSection === 'lists') {
      listDetail.hidden = true;
      listsGrid.hidden  = false;
      loadListsTab();
    }
  };
}

// Wire up create list modal close buttons
$('createListModalClose').addEventListener('click', () => { $('createListModalWrap').hidden = true; });
$('createListCancel').addEventListener('click',     () => { $('createListModalWrap').hidden = true; });
$('createListModalBackdrop').addEventListener('click', () => { $('createListModalWrap').hidden = true; });

// Add to List modal
let _addToListItem = null;

async function openAddToListModal(tmdbId, type, title, posterPath, year) {
  _addToListItem = { tmdbId, type, title, posterPath, year };
  if (!_myLists.length) {
    _myLists = await fetch('/api/lists/mine').then(r => r.json()).catch(() => []);
  }
  const container = $('addToListItems');
  container.innerHTML = '';
  for (const list of _myLists) {
    const row = document.createElement('div');
    row.className = 'add-to-list-row';
    const alreadyIn = list.items?.some(i => i.tmdbId === tmdbId && i.type === type);
    row.innerHTML = `<span class="add-to-list-name">${escHtml(list.title)}</span><span class="add-to-list-count">${list.items?.length || 0} titles</span>`;
    if (alreadyIn) {
      row.innerHTML += `<span class="add-to-list-check">✓</span>`;
    } else {
      row.style.cursor = 'pointer';
      row.addEventListener('click', async () => {
        await fetch(`/api/lists/${list.id}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbId, type, title, posterPath, year }),
        });
        list.items = list.items || [];
        list.items.unshift({ tmdbId, type, title, posterPath, year });
        toast(`Added to "${list.title}"`);
        $('addToListModalWrap').hidden = true;
      });
    }
    container.appendChild(row);
  }
  if (!_myLists.length) {
    container.innerHTML = '<p style="color:#777;font-size:14px">No lists yet — create one below.</p>';
  }
  $('addToListModalWrap').hidden = false;
}

$('addToListNewBtn').addEventListener('click', () => {
  $('addToListModalWrap').hidden = true;
  openCreateListModal();
});
$('addToListModalClose').addEventListener('click',    () => { $('addToListModalWrap').hidden = true; });
$('addToListModalBackdrop').addEventListener('click', () => { $('addToListModalWrap').hidden = true; });

async function loadListsRow() {
  try {
    const data = await fetch('/api/lists/public?sort=popular&page=1').then(r => r.json());
    if (!data.items.length) return;
    const track = $('rowListsTrack');
    track.innerHTML = '';
    for (const list of data.items.slice(0, 12)) {
      const card = createListRowCard(list);
      track.appendChild(card);
    }
    $('rowLists').hidden = false;
  } catch {}
}

function createListRowCard(list) {
  const card = document.createElement('div');
  card.className = 'list-row-card';
  const posters = list.preview || [];
  card.innerHTML = `
    <div class="list-row-mosaic">
      ${posters.slice(0, 4).map(p => `<img src="${p ? `https://image.tmdb.org/t/p/w185${p}` : '/no-poster.svg'}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">`).join('')}
    </div>
    <div class="list-row-title">${escHtml(list.title)}</div>
    <div class="list-row-meta">${list.itemCount} titles · ♥ ${list.likeCount}</div>
  `;
  card.addEventListener('click', () => toggleInlineList(list, card));
  return card;
}

// Clicking a community list on the homepage pops it open inline below the row
// (instead of navigating to the Lists page). Clicking the same list again — or
// the ✕ — collapses it.
let _inlineListId = null;
function collapseInlineList() {
  const sec = $('rowListsExpand');
  if (sec) sec.hidden = true;
  _inlineListId = null;
  document.querySelectorAll('.list-row-card.active').forEach(c => c.classList.remove('active'));
}
async function toggleInlineList(list, cardEl) {
  const sec = $('rowListsExpand');
  if (!sec) return;
  if (_inlineListId === list.id) { collapseInlineList(); return; } // toggle off

  document.querySelectorAll('.list-row-card.active').forEach(c => c.classList.remove('active'));
  cardEl?.classList.add('active');
  _inlineListId = list.id;

  $('rowListsExpandTitle').textContent = list.title;
  $('rowListsExpandBy').textContent = list.username ? `by ${list.username}` : '';
  const track = $('rowListsExpandTrack');
  track.innerHTML = '<p style="color:#555;padding:8px 4px">Loading…</p>';
  sec.hidden = false;
  ensureAwayState(); // browser Back should collapse/return home
  sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const full = await fetch(`/api/lists/${list.id}`).then(r => r.json());
    if (_inlineListId !== list.id) return; // user changed selection while loading
    track.innerHTML = '';
    if (!full.items?.length) {
      track.innerHTML = '<p style="color:#555;padding:8px 4px">This list is empty.</p>';
      return;
    }
    for (const item of full.items) {
      const c = document.createElement('div');
      c.className = 'card';
      c.dataset.tmdbId = item.tmdbId;
      c.dataset.mediaType = item.type;
      c.innerHTML = `
        <img class="card-img" src="${item.posterPath ? `https://image.tmdb.org/t/p/w342${item.posterPath}` : '/no-poster.svg'}" alt="${escHtml(item.title || '')}" loading="lazy" onerror="this.onerror=null;this.src='/no-poster.svg'">
        <div class="card-info">
          <div class="card-title">${escHtml(item.title || '')}</div>
          <div class="card-meta">${item.year ? `<span>${item.year}</span>` : ''}</div>
        </div>`;
      c.addEventListener('click', () => {
        if (item.type === 'tv') openTVModal(item.tmdbId);
        else openModal(item.tmdbId);
      });
      track.appendChild(c);
    }
  } catch {
    if (_inlineListId === list.id) track.innerHTML = '<p style="color:#a55;padding:8px 4px">Could not load this list.</p>';
  }
}
$('rowListsExpandClose')?.addEventListener('click', collapseInlineList);

// ── Import (Pump & Dump) ───────────────────────────────────────────────────
let _importBookmarklets = null;

function openImportModal() {
  $('importBookmarklets').hidden = true;
  $('importTokenArea').hidden    = false;
  $('importModalWrap').hidden    = false;
  if (_importBookmarklets) showBookmarklets(_importBookmarklets);
}

function showBookmarklets(data) {
  _importBookmarklets = data;
  $('importNetflixLink').href = data.netflix;
  $('importNetflixLink').textContent = 'Radical Netflix Import';
  $('importDisneyLink').href  = data.disney;
  $('importDisneyLink').textContent = 'Radical Disney+ Import';
  $('importPrimeLink').href   = data.prime;
  $('importPrimeLink').textContent = 'Radical Prime Import';
  $('importTokenArea').hidden    = true;
  $('importBookmarklets').hidden = false;
}

$('importGetBookmarkletBtn').addEventListener('click', async () => {
  try {
    $('importGetBookmarkletBtn').textContent = 'Generating…';
    const data = await fetch('/api/import/token', { method: 'POST' }).then(r => r.json());
    showBookmarklets(data);
  } catch {
    toast('Could not generate bookmarklets');
    $('importGetBookmarkletBtn').textContent = 'Generate Bookmarklets';
  }
});

$('importRefreshBtn').addEventListener('click', async () => {
  _importBookmarklets = null;
  try {
    const data = await fetch('/api/import/token', { method: 'POST' }).then(r => r.json());
    showBookmarklets(data);
    toast('Bookmarklets refreshed');
  } catch { toast('Could not refresh'); }
});

$('importCsvBtn').addEventListener('click', async () => {
  const file = $('importCsvInput').files?.[0];
  if (!file) { toast('Select a CSV file first'); return; }
  const csv = await file.text();
  $('importCsvBtn').textContent = 'Importing…';
  try {
    const data = await fetch('/api/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    }).then(r => r.json());
    toast(`Imported ${data.matched} of ${data.total} titles from Netflix`);
    $('importModalWrap').hidden = true;
    loadWatchlistAndRatings();
  } catch { toast('CSV import failed'); }
  $('importCsvBtn').textContent = 'Import CSV';
});

$('importModalClose').addEventListener('click',    () => { $('importModalWrap').hidden = true; });
$('importModalBackdrop').addEventListener('click', () => { $('importModalWrap').hidden = true; });

// ── Go ─────────────────────────────────────────────────────────────────────
init();
