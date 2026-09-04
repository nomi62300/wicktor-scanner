/* ==========================================================================
   Wicktor — App Orchestration
   ========================================================================== */

(() => {
  // Bump on every deployed change — PATCH for fixes, MINOR for new
  // features/priorities, MAJOR for breaking/fundamental behavior changes.
  // Keep in sync with package.json's version and the git tag on this
  // commit. See CHANGELOG.md for what changed at each version.
  const APP_VERSION = '1.3.0';

  const STORAGE_KEYS = {
    theme: 'wicktor:theme',
    watchlist: 'wicktor:watchlist',
    settings: 'wicktor:settings',
    discovered: 'wicktor:discovered', // { "SYMBOL:MARKET": timestampMs }
    access: 'wicktor:access-granted',
    tourSeen: 'wicktor:tour-seen',
    topStripFetchedAt: 'wicktor:top-strip-fetched-at'
  };

  // Pulse Spot/Perp and Top Gainers/Losers come from raw Bybit ticker
  // fetches with no caching of their own (unlike fastSectorPerformance/
  // fearGreedIndex, which already cache more conservatively than this) —
  // they don't meaningfully change minute-to-minute, so gate them to a
  // 30-min cadence instead of refetching on every scan. Persisted so a
  // page reload within the window doesn't immediately refetch either.
  const TOP_STRIP_REFRESH_MS = 30 * 60 * 1000;

  // Read-only access to the stored scan. The publishable key is meant to be
  // public (same key js/auth.js already ships); scan_snapshot is
  // select-only for anon and written solely by the scheduled function.
  const SUPABASE_REST = 'https://fpyfetynfobfrpunnnhv.supabase.co/rest/v1';
  const SUPABASE_ANON = 'sb_publishable_95VI9mw_oHduFoqUlToCmg_CpfPucLC';

  // Beta-tester access gate — narrow and explicit: keep the live URL from
  // casual/random visitors, NOT real per-user accounts (no identities, no
  // backend). Comparing a SHA-256 hash instead of a plaintext string only
  // stops a casual glance at page source, nothing more — anyone opening dev
  // tools can already read this file. That's an accepted limitation for
  // this specific goal, not a gap to fix later; real access control would
  // need a separate managed-auth-service path.
  //
  // To rotate the code: compute the new code's SHA-256 hex digest (e.g. in
  // a console: crypto.subtle.digest('SHA-256', new TextEncoder().encode(
  // 'new-code')).then(b => console.log(Array.from(new Uint8Array(b))
  // .map(x => x.toString(16).padStart(2,'0')).join(''))) ), paste it below,
  // and tell testers the new plaintext code.
  //
  // Rotated 2026-08-24 as part of the maintenance-lockdown update — the
  // new code is deliberately NOT distributed to testers yet (see
  // MAINTENANCE_MODE below); this rotation exists to invalidate everyone
  // previously granted access under the old code while maintenance is on.
  const ACCESS_CODE_HASH = 'f226665e607a385afb535cd340ab5f756f9dccd4c3c21f3fa1fc2e01fa130c44';

  // Hard gate shown to literally every visitor, checked before the access
  // gate and before anything else in init() — even someone who already has
  // the current valid code sees this, not the app.
  //
  // Committed as false ONLY on this branch, ONLY so the Vercel preview
  // deploy (terminal-build/phase-0-1) is testable without the access code.
  // This branch never deploys to beta.wicktor.top (that's main, still
  // locked at true) — but flip this back to true before this branch is
  // ever merged into main, or the live site reopens unintentionally.
  const MAINTENANCE_MODE = false;

  const DEFAULT_SETTINGS = {
    universeSize: 350,
    refreshIntervalSec: 300,
    includeCryptoSpot: true,
    includeStocks: false,
    includePerps: true,
    spotCardsPerSide: 5,
    perpCardsPerSide: 5,
    includeNarrativeSectors: true,
    accountSize: 1000,
    riskPerTradePct: 1
  };

  let state = {
    // Merge stored settings on top of defaults so new keys always have a value
    settings: { ...DEFAULT_SETTINGS, ...loadJson(STORAGE_KEYS.settings, {}) },
    watchlist: new Set(loadJson(STORAGE_KEYS.watchlist, [])),
    discovered: loadJson(STORAGE_KEYS.discovered, {}),
    coins: [],           // last computed, unfiltered
    renderedCoins: [],   // final capped+ordered list actually rendered
    narrativePerf: null, // top-4 sector objects [{name, weightedChange7d}] from last scan
    marketBreadth: null, // { spot, perp } — top-strip Pulse, independent of scan toggles
    topStripFetchedAt: loadJson(STORAGE_KEYS.topStripFetchedAt, 0),
    activeFilters: {
      market:  new Set(), // 'spot' | 'perp' — ANDed with quality, OR'd within itself
      quality: new Set(), // '3tf' | 'divergence' — ANDed with market, OR'd within itself
      band:    new Set(), // 'excellent' | 'watch' | 'avoid'
      side:    new Set(), // 'buy' | 'sell'
      mcap:    new Set()  // 'micro' | 'small' | 'mid' | 'large'
    },
    searchQuery: '',
    topStripData: {},
    flowsData: [],   // CoinGecko-backed, Flows tab only (lazy)
    fastSectors: [], // CoinPaprika-backed, shared by scan + strip + Heatmap
    rawMovers: [],
    refreshTimer: null,
    modalCoin: null,
    newsCache: {},        // symbol -> news result
    newsData: null,       // shared feed, re-fetched with market context
    snapshotAt: null      // captured_at (ms) of the loaded scan snapshot
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  // ---------------------------------------------------------------- DOM refs
  const el = {
    cardGrid: document.getElementById('card-grid'),
    topStrip: document.getElementById('top-strip'),
    filterBar: document.getElementById('filter-bar'),
    navScanner: document.getElementById('nav-scanner'),
    navDashboard: document.getElementById('nav-dashboard'),
    navFlows: document.getElementById('nav-flows'),
    navHeatmap: document.getElementById('nav-heatmap'),
    navNews: document.getElementById('nav-news'),
    navWatchlist: document.getElementById('nav-watchlist'),
    viewScanner: document.getElementById('view-scanner'),
    viewDashboard: document.getElementById('view-dashboard'),
    viewFlows: document.getElementById('view-flows'),
    viewHeatmap: document.getElementById('view-heatmap'),
    viewNews: document.getElementById('view-news'),
    viewWatchlist: document.getElementById('view-watchlist'),
    dashboardGrid: document.getElementById('dashboard-grid'),
    flowsGrid: document.getElementById('flows-grid'),
    heatmapGridContainer: document.getElementById('heatmap-grid-container'),
    newsFeedContainer: document.getElementById('news-feed-container'),
    watchlistContainer: document.getElementById('watchlist-container'),
    accountBtn: document.getElementById('account-btn'),
    accountBackdrop: document.getElementById('account-backdrop'),
    accountPanel: document.getElementById('account-panel'),
    accountClose: document.getElementById('account-close'),
    accountSignedOut: document.getElementById('account-signed-out'),
    accountSignedIn: document.getElementById('account-signed-in'),
    accountEmail: document.getElementById('account-email'),
    accountPassword: document.getElementById('account-password'),
    accountError: document.getElementById('account-error'),
    accountSigninBtn: document.getElementById('account-signin-btn'),
    accountSignupBtn: document.getElementById('account-signup-btn'),
    accountSignoutBtn: document.getElementById('account-signout-btn'),
    accountEmailDisplay: document.getElementById('account-email-display'),
    signalJournalBtn: document.getElementById('signal-journal-btn'),
    signalJournalBackdrop: document.getElementById('signal-journal-backdrop'),
    signalJournalPanel: document.getElementById('signal-journal-panel'),
    signalJournalClose: document.getElementById('signal-journal-close'),
    signalJournalBody: document.getElementById('signal-journal-body'),
    search: document.getElementById('search-input'),
    nextScan: document.getElementById('next-scan'),
    themeBtn: document.getElementById('theme-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    modalContent: document.getElementById('modal-content'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsClose: document.getElementById('settings-close'),
    universeInput: document.getElementById('setting-universe'),
    refreshInput: document.getElementById('setting-refresh'),
    cryptoSpotToggle: document.getElementById('setting-crypto-spot'),
    stocksToggle: document.getElementById('setting-stocks'),
    perpToggle: document.getElementById('setting-perps'),
    narrativeToggle: document.getElementById('setting-narratives'),
    spotCapInput: document.getElementById('setting-spot-cap'),
    perpCapInput: document.getElementById('setting-perp-cap'),
    accountSizeInput: document.getElementById('setting-account-size'),
    riskPctInput: document.getElementById('setting-risk-pct'),
    maintenanceOverlay: document.getElementById('maintenance-overlay'),
    accessGate: document.getElementById('access-gate'),
    accessCodeInput: document.getElementById('access-code-input'),
    accessCodeSubmit: document.getElementById('access-code-submit'),
    accessCodeError: document.getElementById('access-code-error'),
    takeTourBtn: document.getElementById('take-tour-btn'),
    appVersion: document.getElementById('app-version')
  };

  // ---------------------------------------------------------------- Theme
  function initTheme() {
    const saved = localStorage.getItem(STORAGE_KEYS.theme) || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEYS.theme, next);
    updateThemeIcon(next);
  }
  function updateThemeIcon(theme) {
    el.themeBtn.innerHTML = theme === 'light'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }

  // ------------------------------------------------------------ Discovery
  function markDiscovered(key) {
    if (!(key in state.discovered)) {
      state.discovered[key] = Date.now();
      saveJson(STORAGE_KEYS.discovered, state.discovered);
    }
  }
  function clearDiscoveredIfMissing(activeKeys) {
    let changed = false;
    Object.keys(state.discovered).forEach(k => {
      if (!activeKeys.has(k)) { delete state.discovered[k]; changed = true; }
    });
    if (changed) saveJson(STORAGE_KEYS.discovered, state.discovered);
  }
  function discoveredAgoLabel(key) {
    const ts = state.discovered[key];
    if (!ts) return 'just now';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  // -------------------------------------------------------- Core pipeline
  //
  // THE SCAN NO LONGER RUNS HERE. Until 2026-09-04 every browser fetched
  // Bybit klines for the whole universe and scored them locally, on a timer,
  // per open tab. That made universe size a per-viewer cost (240 coins was
  // already ~12s of coin-analysis), multiplied Bybit rate-limit exposure by
  // the number of tabs, and let two people looking at the scanner at the
  // same moment see different results.
  //
  // supabase/functions/cron-scan now scores the whole universe every 5
  // minutes and stores it (see the scan_snapshot migration). This file just
  // reads the newest snapshot, layers on the three per-browser fields the
  // server cannot know, and renders. Nothing here calls Bybit for coins, and
  // nothing here writes to the signal journal — the same scheduled function
  // already owns both, so doing it from a browser would only duplicate or
  // race it.

  const SNAPSHOT_POLL_MS = 60 * 1000;   // how often to look for a newer one
  const SCAN_PERIOD_MS = 5 * 60 * 1000; // the cron's cadence, for the countdown

  async function sb(pathAndQuery) {
    const res = await fetch(`${SUPABASE_REST}/${pathAndQuery}`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }
    });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    return res.json();
  }

  /**
   * Market context that is NOT the coin scan: top-strip stats, sector
   * performance, and the news feed the cards' news badge reads. A handful of
   * requests, unrelated to universe size.
   */
  async function refreshMarketContext() {
    const [newsData, globalRes, fngRes, , sectorRes] = await Promise.all([
      Api.fetchAllNews().catch(e => { console.warn('[App] news fetch failed', e); return null; }),
      Api.coingeckoGlobal().catch(e => { console.warn('[App] coingecko global fetch failed', e); return null; }),
      Api.fearGreedIndex().catch(e => { console.warn('[App] fear greed fetch failed', e); return null; }),
      Api.refreshXStockSet().catch(e => { console.warn('[App] xStock set refresh failed', e); }),
      Api.fastSectorPerformance().catch(e => { console.warn('[App] fast sector fetch failed', e); return []; })
    ]);

    state.newsData = newsData;
    const sectorPerf = sectorRes || [];
    state.fastSectors = sectorPerf;
    state.narrativePerf = sectorPerf.length
      ? [...sectorPerf].sort((a, b) => b.weightedChange7d - a.weightedChange7d).slice(0, 4)
      : null;

    // Pulse/movers move slowly and are a market overview rather than a
    // reflection of scan config, so they keep their own 30-minute gate.
    const topStripStale = (Date.now() - state.topStripFetchedAt) >= TOP_STRIP_REFRESH_MS;
    if (topStripStale || !state.marketBreadth) {
      try {
        const [spotTickers, linearTickers] = await Promise.all([
          Api.bybitTickers('spot'), Api.bybitTickers('linear')
        ]);
        state.marketBreadth = {
          spot: computeMarketBreadth(spotTickers),
          perp: computeMarketBreadth(linearTickers)
        };
        state.rawMovers = buildMoversFromTickers(spotTickers, linearTickers);
        state.topStripFetchedAt = Date.now();
        saveJson(STORAGE_KEYS.topStripFetchedAt, state.topStripFetchedAt);
      } catch (e) {
        console.warn('[App] top strip ticker fetch failed', e);
      }
    }

    refreshTopStrip(globalRes, fngRes);
    el.topStrip.innerHTML = Render.topStripHtml(state.topStripData);
    if (dashboardLoaded) refreshDashboard();
  }

  /**
   * Reads the newest stored scan, and the one before it purely for its score
   * map, so each card can say whether it is newly qualifying and how its
   * score moved. Only the newest row's full `coins` payload is fetched —
   * pulling two whole universes every poll would be wasteful on mobile.
   */
  async function loadSnapshot({ force = false } = {}) {
    try {
      const head = await sb('scan_snapshot?select=captured_at&order=captured_at.desc&limit=1');
      if (!head.length) {
        if (!state.coins.length) {
          el.cardGrid.innerHTML = '<div class="empty-state">No scan has been stored yet. The scheduled scan runs every 5 minutes.</div>';
        }
        return;
      }
      const newestAt = new Date(head[0].captured_at).getTime();
      // Unchanged since last poll: nothing to re-render, and re-fetching the
      // payload would be pure waste.
      if (!force && newestAt === state.snapshotAt) { updateNextScanLabel(); return; }

      const [current, prior] = await Promise.all([
        sb('scan_snapshot?select=captured_at,coins&order=captured_at.desc&limit=1'),
        sb('scan_snapshot?select=scores&order=captured_at.desc&limit=1&offset=1')
      ]);
      if (!current.length) return;

      const prevScores = prior.length ? (prior[0].scores || {}) : null;
      const coins = (current[0].coins || []).map(c => decorateCoin(c, prevScores));

      clearDiscoveredIfMissing(new Set(coins.map(c =>
        `${c.rawSymbol}:${c.market}:${Scoring.bandLabel(c.score, c.unlock, c.ceiling).text}`)));
      state.coins = coins.sort((a, b) => b.score - a.score);
      state.snapshotAt = new Date(current[0].captured_at).getTime();
      renderAll();
      updateNextScanLabel();
    } catch (e) {
      console.warn('[App] snapshot load failed', e);
      if (!state.coins.length) {
        el.cardGrid.innerHTML = '<div class="empty-state">Could not reach the scan server. Retrying shortly.</div>';
      }
    }
  }

  /**
   * The three things a stored snapshot cannot carry, because they are facts
   * about THIS browser rather than about the market: whether the coin is
   * starred, when this browser first saw it, and its news badge. Plus the
   * diff against the previous snapshot.
   */
  function decorateCoin(c, prevScores) {
    const key = `${c.rawSymbol}:${c.market}`;
    // Discovery is tracked per (symbol, market, BAND), not just symbol —
    // otherwise "X ago" measures how long this coin has sat anywhere in the
    // scanned top-350-by-volume universe, which barely relates to how long
    // it's actually been EXCELLENT. A coin that was AVOID yesterday and
    // flipped EXCELLENT five minutes ago must read as freshly discovered.
    const band = Scoring.bandLabel(c.score, c.unlock, c.ceiling).text;
    const bandKey = `${key}:${band}`;
    markDiscovered(bandKey);

    const items = state.newsData ? Api.newsForSymbol(state.newsData.articles, c.rawSymbol) : [];
    if (state.newsData) state.newsCache[c.rawSymbol] = { items };

    // A null prevScores means there IS no previous snapshot (first ever run,
    // or the table was just pruned) — everything would otherwise be flagged
    // as new, which is noise rather than information.
    const prev = prevScores ? prevScores[key] : undefined;
    return {
      ...c,
      watchlisted: state.watchlist.has(key),
      discoveredAgo: discoveredAgoLabel(bandKey),
      newsMeta: { count: items.length, dominantSentiment: items.length ? items[0].sentiment : null },
      isNew: prevScores ? !(key in prevScores) : false,
      scoreDelta: (prevScores && typeof prev === 'number' && prev !== c.score) ? c.score - prev : null
    };
  }

  // Counts down to the next expected scan, derived from the loaded
  // snapshot's own timestamp rather than a stopwatch started at page load —
  // otherwise opening the page mid-cycle would show a full 5:00 that is
  // simply wrong. Also the place a stalled cron becomes visible.
  function updateNextScanLabel() {
    if (!el.nextScan) return;
    if (!state.snapshotAt) { el.nextScan.textContent = 'Waiting for first scan'; return; }
    const age = Date.now() - state.snapshotAt;
    const remaining = SCAN_PERIOD_MS - age;
    if (remaining <= 0) {
      // Past due. GitHub/pg_cron scheduling is best-effort, so a little late
      // is normal; a lot late means something is wrong and should say so
      // rather than showing a stale grid as though it were live.
      const lateMin = Math.floor(-remaining / 60000);
      el.nextScan.textContent = lateMin >= 10 ? `Scan delayed ${lateMin}m` : 'Scan due now';
      el.nextScan.classList.toggle('stale', lateMin >= 10);
      return;
    }
    el.nextScan.classList.remove('stale');
    const secs = Math.ceil(remaining / 1000);
    el.nextScan.textContent = `Next scan ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }

  function setLoading(isLoading) {
    if (isLoading && state.coins.length === 0) {
      el.cardGrid.innerHTML = '<div class="loading-state">Loading latest scan...</div>';
    }
  }

  // ------------------------------------------------------------- Top strip
  /**
   * 24h market breadth (average % change across tradeable crypto USDT pairs
   * in this category) computed directly from Bybit's tickers endpoint —
   * cheap (no indicator computation) and always populated regardless of
   * scan toggles, unlike deriving it from state.coins.
   */
  function computeMarketBreadth(tickers) {
    const crypto = (tickers || []).filter(t =>
      Api.isTradeableUsdtPair(t.symbol) && !Api.isXStock(t.symbol));
    if (!crypto.length) return null;
    const avg = crypto.reduce((sum, t) => sum + parseFloat(t.price24hPcnt) * 100, 0) / crypto.length;
    return Math.round(avg);
  }

  /**
   * Top Gainers/Losers source data — crypto-only tradeable pairs from both
   * spot and linear (perp) tickers, independent of scan toggle state. A
   * symbol can appear in both categories; keep whichever move is larger in
   * magnitude, since this is a market-overview tile, not a scan reflection.
   */
  function buildMoversFromTickers(spotTickers, linearTickers) {
    const combined = new Map();
    [...(spotTickers || []), ...(linearTickers || [])].forEach(t => {
      if (!Api.isTradeableUsdtPair(t.symbol) || Api.isXStock(t.symbol)) return;
      const change = parseFloat(t.price24hPcnt) * 100;
      const symbol = t.symbol.replace(/USDT$/, '');
      const existing = combined.get(symbol);
      if (!existing || Math.abs(change) > Math.abs(existing.change)) {
        combined.set(symbol, { symbol, change });
      }
    });
    return [...combined.values()];
  }

  function refreshTopStrip(global, fng) {
    state.topStripData = {
      pulseSpot: state.marketBreadth ? state.marketBreadth.spot : null,
      pulsePerp: state.marketBreadth ? state.marketBreadth.perp : null,
      fearGreed: fng,
      btcDominance: global ? global.market_cap_percentage.btc : null,
      mcap: global ? Api.formatMcap(global.total_market_cap.usd) : null,
      mcapChange24h: global ? global.market_cap_change_percentage_24h_usd : 0,
      narrativeSectors: state.narrativePerf,
      gainers: buildMovers(true),
      losers: buildMovers(false)
    };
  }

  function buildMovers(gainers) {
    // Uses the underlying 24h % change captured at fetch time via state.rawMovers
    const list = state.rawMovers || [];
    const signed = gainers ? list.filter(x => x.change > 0) : list.filter(x => x.change < 0);
    const sorted = signed.sort((a, b) => gainers ? b.change - a.change : a.change - b.change);
    return sorted.slice(0, 3);
  }

  // ---------------------------------------------------------------- Filters
  function getFilteredCoins() {
    let list = state.coins;

    // SETTINGS GATE — applied before the filter chips.
    //
    // These used to decide what got SCANNED (they built scanTargets, and
    // universeSize was passed to Api.topUniverse). The server now scans
    // everything regardless, so they became dead settings for one commit:
    // toggling Perps off changed nothing. They are display gates now, which
    // is what they were always for from the user's side — "which setups do I
    // want to see, and how many" — and is the shape tiering needs later,
    // since a tier limits what a user may see rather than what the shared
    // scan computes.
    const s = state.settings;
    list = list.filter(c => {
      // Tokenized stocks are their own toggle regardless of market — a stock
      // PERP is still a stock. This used to only be checked on the SPOT
      // branch, so an xStock PERP (e.g. NVDA, SMCI) always passed through
      // the plain Perps gate no matter what "Include tokenized stocks" said.
      const isStock = typeof Api !== 'undefined' && Api.isXStock
        ? Api.isXStock(c.rawSymbol) : false;
      if (isStock) return s.includeStocks === true;
      if (c.market === 'PERP') return s.includePerps !== false;
      return s.includeCryptoSpot !== false;
    });

    // universeSize caps how deep into the ranked universe this viewer sees.
    // Ranked by score, not by volume: the server already picked the top-N by
    // volume, so re-cutting by volume here would be a second copy of a
    // decision already made, while score is what this list is ordered by.
    if (s.universeSize > 0) {
      const spot = list.filter(c => c.market === 'SPOT').slice(0, s.universeSize);
      const perp = list.filter(c => c.market === 'PERP').slice(0, s.universeSize);
      list = spot.concat(perp);
    }

    // market group — OR within (a coin can only be one), AND across groups.
    // Split out from quality so "Spot" + "3TF aligned" means their
    // INTERSECTION, not the union the old combined "primary" group gave.
    const market = state.activeFilters.market;
    if (market.size > 0) {
      list = list.filter(c =>
        (market.has('spot') && c.market === 'SPOT') ||
        (market.has('perp') && c.market === 'PERP')
      );
    }

    // quality group — OR within, AND across groups
    const quality = state.activeFilters.quality;
    if (quality.size > 0) {
      list = list.filter(c =>
        (quality.has('3tf')        && c.alignCount === 3) ||
        (quality.has('divergence') && c.divergenceOverall !== 'none')
      );
    }

    // band group — OR within, AND with above
    const band = state.activeFilters.band;
    if (band.size > 0) {
      list = list.filter(c => {
        const lbl = Scoring.bandLabel(c.score, c.unlock, c.ceiling).text.toLowerCase();
        return (band.has('excellent') && lbl === 'excellent') ||
               (band.has('watch')     && lbl === 'watch') ||
               (band.has('avoid')     && lbl === 'avoid');
      });
    }

    // side group — OR within, AND with above
    const side = state.activeFilters.side;
    if (side.size > 0) {
      list = list.filter(c => {
        const isBuy  = c.side === 'Buy'  || c.side === 'Long';
        const isSell = c.side === 'Sell' || c.side === 'Short';
        return (side.has('buy') && isBuy) || (side.has('sell') && isSell);
      });
    }

    // mcap group — OR within, AND with above
    const mcap = state.activeFilters.mcap;
    if (mcap && mcap.size > 0) {
      list = list.filter(c => {
        const cap = c.mcapRaw;
        if (cap == null) return false;
        return (mcap.has('micro') && cap < 150_000_000) ||
               (mcap.has('small') && cap >= 150_000_000 && cap < 500_000_000) ||
               (mcap.has('mid')   && cap >= 500_000_000 && cap < 1_000_000_000) ||
               (mcap.has('large') && cap >= 1_000_000_000);
      });
    }

    // search — always AND
    if (state.searchQuery) {
      const q = state.searchQuery.toUpperCase();
      list = list.filter(c => c.symbol.toUpperCase().includes(q));
    }
    return list;
  }

  // ---------------------------------------------------------------- Render
  /**
   * Apply per-side card caps after filtering.
   * Splits coins into four score-sorted buckets (spot-buy, spot-sell,
   * perp-buy, perp-sell), slices each to its cap, then concatenates.
   */
  function applyCardCaps(coins) {
    const spotCap = state.settings.spotCardsPerSide;
    const perpCap = state.settings.perpCardsPerSide;

    const spotBuy  = [];
    const spotSell = [];
    const perpBuy  = [];
    const perpSell = [];

    coins.forEach(c => {
      const isBuy = c.side === 'Buy' || c.side === 'Long';
      if (c.market === 'SPOT') {
        (isBuy ? spotBuy : spotSell).push(c);
      } else {
        (isBuy ? perpBuy : perpSell).push(c);
      }
    });

    const byScore = (a, b) => b.score - a.score;
    return [
      ...spotBuy.sort(byScore).slice(0, spotCap),
      ...spotSell.sort(byScore).slice(0, spotCap),
      ...perpBuy.sort(byScore).slice(0, perpCap),
      ...perpSell.sort(byScore).slice(0, perpCap)
    ];
  }

  function renderAll() {
    el.topStrip.innerHTML = Render.topStripHtml(state.topStripData);
    state.renderedCoins = applyCardCaps(getFilteredCoins());
    Render.renderCardGrid(el.cardGrid, state.renderedCoins, state.settings);
    bindCardEvents();
    maybeAutoStartTour();
  }

  function bindCardEvents() {
    el.cardGrid.querySelectorAll('.coin-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        openModal(parseInt(card.dataset.idx));
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(parseInt(card.dataset.idx)); }
      });
    });
    el.cardGrid.querySelectorAll('[data-action="star"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWatchlist(parseInt(btn.dataset.idx));
      });
    });
    el.cardGrid.querySelectorAll('[data-action="chart"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTradingView(parseInt(btn.dataset.idx));
      });
    });
  }

  function toggleWatchlist(idx) {
    const coin = state.renderedCoins[idx];
    if (!coin) return;
    const key = `${coin.rawSymbol}:${coin.market}`;
    const nowStarred = !state.watchlist.has(key);
    if (state.watchlist.has(key)) state.watchlist.delete(key);
    else state.watchlist.add(key);
    // coin.watchlisted is baked in once per scan (computeCoin) and this
    // same object is shared by reference between state.coins and
    // state.renderedCoins — without updating it here, the star's visual
    // state stays stuck at its scan-time snapshot until the next rescan,
    // even though state.watchlist itself is already correctly toggled.
    coin.watchlisted = state.watchlist.has(key);
    saveJson(STORAGE_KEYS.watchlist, [...state.watchlist]);
    renderAll();

    // Logged-in users additionally sync to the account-scoped Supabase
    // watchlist (the Watchlist tab's data source) — localStorage stays
    // the source of truth for the star's own visual state either way,
    // per the owner's explicit "keep it local for now" call. Fire-and-
    // forget: a sync failure shouldn't block the star from working.
    const user = Auth.getUser();
    if (user) {
      const action = nowStarred
        ? Auth.watchlist.add(coin.rawSymbol, coin.market)
        : Auth.watchlist.remove(coin.rawSymbol, coin.market);
      action.catch(e => console.warn('[App] watchlist sync failed', e));
    }
  }

  function openTradingView(idx) {
    const coin = state.renderedCoins[idx];
    if (!coin) return;
    const tvSymbol = coin.market === 'PERP' ? `BYBIT:${coin.rawSymbol}.P` : `BYBIT:${coin.rawSymbol}`;
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}&interval=5`, '_blank', 'noopener');
  }

  // ----------------------------------------------------------------- Modal
  async function openModal(idx) {
    const coin = state.renderedCoins[idx];
    if (!coin) return;
    state.modalCoin = coin;
    // News is pre-fetched at scan time and stored in state.newsCache — read directly
    el.modalContent.innerHTML = Render.detailModalHtml(coin, state.newsCache[coin.rawSymbol]);
    el.modalBackdrop.classList.add('open');
    bindModalCloseEvents();

    const band = Scoring.bandLabel(coin.score, coin.unlock, coin.ceiling).text;
    Outcomes.logIfNew({
      key: `${coin.rawSymbol}:${coin.market}`,
      band, score: coin.score, side: coin.side, entryPrice: coin.priceRaw
    });
  }

  function bindModalCloseEvents() {
    const closeBtn = el.modalContent.querySelector('[data-action="close-modal"]');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const newsMoreBtn = el.modalContent.querySelector('[data-action="toggle-news-more"]');
    if (newsMoreBtn) {
      newsMoreBtn.addEventListener('click', () => {
        const moreBlock = el.modalContent.querySelector('.news-more');
        if (!moreBlock) return;
        const collapsed = moreBlock.hasAttribute('hidden');
        if (collapsed) {
          moreBlock.removeAttribute('hidden');
          newsMoreBtn.textContent = newsMoreBtn.dataset.lessLabel;
        } else {
          moreBlock.setAttribute('hidden', '');
          newsMoreBtn.textContent = newsMoreBtn.dataset.moreLabel;
        }
      });
    }
  }
  function closeModal() {
    el.modalBackdrop.classList.remove('open');
    state.modalCoin = null;
  }

  // -------------------------------------------------------------- Settings
  function openSettings() {
    el.universeInput.value = state.settings.universeSize;
    el.refreshInput.value = Math.round(state.settings.refreshIntervalSec / 60);
    el.cryptoSpotToggle.checked = state.settings.includeCryptoSpot;
    el.stocksToggle.checked = state.settings.includeStocks;
    el.perpToggle.checked = state.settings.includePerps;
    el.narrativeToggle.checked = state.settings.includeNarrativeSectors !== false;
    el.spotCapInput.value = state.settings.spotCardsPerSide;
    el.perpCapInput.value = state.settings.perpCardsPerSide;
    el.accountSizeInput.value = state.settings.accountSize;
    el.riskPctInput.value = state.settings.riskPerTradePct;
    el.settingsBackdrop.classList.add('open');
    el.settingsPanel.classList.add('open');
  }
  function closeSettings() {
    state.settings.universeSize = Math.max(10, Math.min(350, parseInt(el.universeInput.value) || 350));
    state.settings.refreshIntervalSec = Math.max(1, Math.min(10, parseInt(el.refreshInput.value) || 5)) * 60;
    state.settings.includeCryptoSpot = el.cryptoSpotToggle.checked;
    state.settings.includeStocks = el.stocksToggle.checked;
    state.settings.includePerps = el.perpToggle.checked;
    state.settings.includeNarrativeSectors = el.narrativeToggle.checked;
    state.settings.spotCardsPerSide = Math.max(1, Math.min(20, parseInt(el.spotCapInput.value) || 5));
    state.settings.perpCardsPerSide = Math.max(1, Math.min(20, parseInt(el.perpCapInput.value) || 5));
    state.settings.accountSize = Math.max(0, parseFloat(el.accountSizeInput.value) || 0);
    state.settings.riskPerTradePct = Math.max(0.1, Math.min(10, parseFloat(el.riskPctInput.value) || 1));
    saveJson(STORAGE_KEYS.settings, state.settings);
    el.settingsBackdrop.classList.remove('open');
    el.settingsPanel.classList.remove('open');
    scheduleRefresh();
    refreshMarketContext().then(() => loadSnapshot({ force: true }));
  }

  // ------------------------------------------------------------- Account
  function openAccountPanel() {
    el.accountError.textContent = '';
    el.accountBackdrop.classList.add('open');
    el.accountPanel.classList.add('open');
  }
  function closeAccountPanel() {
    el.accountBackdrop.classList.remove('open');
    el.accountPanel.classList.remove('open');
  }

  async function submitAccountForm(mode) {
    const email = el.accountEmail.value.trim();
    const password = el.accountPassword.value;
    el.accountError.textContent = '';
    if (!email || !password) {
      el.accountError.textContent = 'Enter both email and password.';
      return;
    }
    try {
      if (mode === 'signUp') await Auth.signUp(email, password);
      else await Auth.signIn(email, password);
      el.accountPassword.value = '';
      closeAccountPanel();
    } catch (e) {
      el.accountError.textContent = e.message || 'Something went wrong.';
    }
  }

  // Reflects the current auth state into the account panel + the topbar
  // avatar button. Called once at startup and on every Auth.onChange fire
  // (sign-in/sign-up/sign-out all route through the same listener).
  function renderAccountState(user) {
    el.accountSignedOut.hidden = !!user;
    el.accountSignedIn.hidden = !user;
    el.accountBtn.classList.toggle('logged-in', !!user);
    if (user) el.accountEmailDisplay.textContent = user.email;
  }

  // ------------------------------------------------------- Signal journal
  function fmtR(v) {
    return v == null ? '--' : (v >= 0 ? '+' : '') + v.toFixed(3) + 'R';
  }
  function rColor(v) {
    return v == null ? null : (v >= 0 ? 'var(--green-text)' : 'var(--red-text)');
  }

  function renderPlanTiles(label, hint, stat) {
    const tile = (l, v, color) => `
      <div class="strip-tile">
        <div class="strip-label">${l}</div>
        <div class="strip-value"${color ? ` style="color:${color}"` : ''}>${v}</div>
      </div>`;
    return `
      <div style="margin-bottom:14px;">
        <div style="font-size:13px;font-weight:500;margin-bottom:2px;">${label}</div>
        <div class="settings-hint" style="margin-bottom:8px;">${hint}</div>
        <div class="top-strip" style="margin-bottom:0;">
          ${tile('Resolved', stat.n)}
          ${tile('Win Rate', stat.winPct != null ? stat.winPct.toFixed(0) + '%' : '--', stat.winPct != null ? (stat.winPct >= 50 ? 'var(--green-text)' : 'var(--red-text)') : null)}
          ${tile('Mean R', fmtR(stat.mean), rColor(stat.mean))}
          ${tile('Balanced R', fmtR(stat.balanced), rColor(stat.balanced))}
        </div>
      </div>`;
  }

  async function openSignalJournalPanel() {
    el.signalJournalBackdrop.classList.add('open');
    el.signalJournalPanel.classList.add('open');
    el.signalJournalBody.innerHTML = '<div class="loading-state">Loading...</div>';
    if (typeof SignalJournal === 'undefined') {
      el.signalJournalBody.innerHTML = '<div class="loading-state">Signal journal is unavailable right now.</div>';
      return;
    }
    const summary = await SignalJournal.summary();
    if (!summary || !summary.planA || !summary.planA.n) {
      el.signalJournalBody.innerHTML = '<div class="loading-state">No resolved signals yet. Signals are logged when a signed-in scan finds an EXCELLENT (score ≥ 80) setup, and take up to ~4h to resolve — check back once a few scans have run.</div>';
      return;
    }
    el.signalJournalBody.innerHTML =
      renderPlanTiles('Plan A — partial TP + breakeven', '1/3 off at 1R, stop to breakeven, rest to 2R/3R', summary.planA) +
      renderPlanTiles('Plan B — straight 3R', 'Full size held to a single 3R target', summary.planB) +
      (summary.medianRiskPct != null
        // riskPct arrives already in percent units (indicators.js multiplies
        // by 100), so it must not be scaled again here.
        ? `<div class="settings-hint">Median 1R = ${summary.medianRiskPct.toFixed(2)}% of entry price.</div>`
        : '');
  }
  function closeSignalJournalPanel() {
    el.signalJournalBackdrop.classList.remove('open');
    el.signalJournalPanel.classList.remove('open');
  }

  // ------------------------------------------------------------ Scheduling
  function scheduleRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    // Two independent cadences: poll for a newer stored scan every minute,
    // and tick the countdown every second. The old refreshIntervalSec (a
    // client scan cadence) no longer has anything to drive — the server's
    // schedule is what decides when new data exists.
    state.refreshTimer = setInterval(() => loadSnapshot(), SNAPSHOT_POLL_MS);
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(updateNextScanLabel, 1000);
    setInterval(() => refreshMarketContext().catch(() => {}), 5 * 60 * 1000);
  }

  // --------------------------------------------------------------- Wiring
  function bindStaticEvents() {
    el.themeBtn.addEventListener('click', toggleTheme);
    el.settingsBtn.addEventListener('click', openSettings);
    el.settingsClose.addEventListener('click', closeSettings);
    el.settingsBackdrop.addEventListener('click', (e) => {
      if (e.target === el.settingsBackdrop) closeSettings();
    });
    el.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === el.modalBackdrop) closeModal();
    });
    el.search.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderAll();
    });
    el.filterBar.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const group  = chip.dataset.group;
        const filter = chip.dataset.filter;
        const set    = state.activeFilters[group];
        if (!set) return;
        if (set.has(filter)) {
          set.delete(filter);
          chip.classList.remove('active');
        } else {
          set.add(filter);
          chip.classList.add('active');
        }
        renderAll();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closeSettings(); closeSignalJournalPanel(); }
    });
    el.navScanner.addEventListener('click', () => switchTab('scanner'));
    el.navDashboard.addEventListener('click', () => switchTab('dashboard'));
    el.navFlows.addEventListener('click', () => switchTab('flows'));
    el.navHeatmap.addEventListener('click', () => switchTab('heatmap'));
    el.navNews.addEventListener('click', () => switchTab('news'));
    el.navWatchlist.addEventListener('click', () => switchTab('watchlist'));
    el.accountBtn.addEventListener('click', openAccountPanel);
    el.accountClose.addEventListener('click', closeAccountPanel);
    el.accountBackdrop.addEventListener('click', closeAccountPanel);
    el.signalJournalBtn.addEventListener('click', () => { closeSettings(); openSignalJournalPanel(); });
    el.signalJournalClose.addEventListener('click', closeSignalJournalPanel);
    el.signalJournalBackdrop.addEventListener('click', closeSignalJournalPanel);
    el.accountSigninBtn.addEventListener('click', () => submitAccountForm('signIn'));
    el.accountSignupBtn.addEventListener('click', () => submitAccountForm('signUp'));
    el.accountSignoutBtn.addEventListener('click', async () => {
      await Auth.signOut();
      closeAccountPanel();
    });
    el.flowsGrid.addEventListener('click', (e) => {
      const row = e.target.closest('.flows-row');
      if (row) toggleFlowsRow(row.dataset.categoryId);
    });
    el.flowsGrid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.flows-row');
      if (row) { e.preventDefault(); toggleFlowsRow(row.dataset.categoryId); }
    });
  }

  // --------------------------------------------------------------- Tab nav
  // Dashboard/Flows data is fetched lazily on first visit, not on every
  // scan — it's supporting market context, not part of the scan cycle.
  // Cached at the Api layer so revisiting a tab within the cache window
  // doesn't refetch.
  const TABS = ['scanner', 'dashboard', 'flows', 'heatmap', 'news', 'watchlist'];
  let dashboardLoaded = false;
  let flowsLoaded = false;
  let newsLoaded = false;
  const flowsExpanded = new Set();

  function switchTab(tab) {
    TABS.forEach(t => {
      const active = t === tab;
      el[`nav${capitalize(t)}`].classList.toggle('active', active);
      el[`nav${capitalize(t)}`].setAttribute('aria-selected', String(active));
      el[`view${capitalize(t)}`].hidden = !active;
    });
    if (tab === 'dashboard' && !dashboardLoaded) {
      dashboardLoaded = true;
      refreshDashboard();
    }
    if (tab === 'flows' && !flowsLoaded) {
      flowsLoaded = true;
      refreshFlows();
    }
    if (tab === 'heatmap') {
      // Reads the CoinPaprika-backed fast sectors the scan already
      // populated. Previously this piggybacked on the Flows tab, so
      // simply opening Heatmap fired CoinGecko's whole 17-request
      // category sequence.
      if (state.fastSectors && state.fastSectors.length) {
        refreshHeatmap();
      } else {
        Api.fastSectorPerformance()
          .catch(e => { console.warn('[App] fast sector fetch failed (Heatmap)', e); return []; })
          .then(s => { state.fastSectors = s; refreshHeatmap(); });
      }
    }
    if (tab === 'news' && !newsLoaded) {
      newsLoaded = true;
      refreshNews();
    }
    if (tab === 'watchlist') {
      refreshWatchlistTab();
    }
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  async function refreshDashboard() {
    const top5 = await Api.topByMarketCap(5).catch(e => {
      console.warn('[App] top5 market cap fetch failed', e);
      return [];
    });
    const dashboardData = {
      ...state.topStripData,
      top5MarketCap: top5,
      gainers10: (state.rawMovers || [])
        .filter(x => x.change > 0).sort((a, b) => b.change - a.change).slice(0, 10),
      losers10: (state.rawMovers || [])
        .filter(x => x.change < 0).sort((a, b) => a.change - b.change).slice(0, 10)
    };
    el.dashboardGrid.innerHTML = Render.dashboardHtml(dashboardData);
  }

  /**
   * Two-phase, so a CoinGecko rate-limit can never leave this tab nearly
   * empty the way it used to:
   *   1. render the CoinPaprika sectors immediately (always available,
   *      already fetched by the scan) with 30D/1Y showing "--";
   *   2. merge in CoinGecko's extended windows when they arrive.
   *
   * The merge is per-sector keyed on `name`, which is the shared
   * NARRATIVE_KEYWORDS string and therefore a real join key across both
   * providers. A CoinGecko row wins where present (it carries all four
   * windows); CoinPaprika fills every gap. So Flows always shows a full
   * sector list, and a "--" means "the extended-window source didn't
   * return this one", never "broken".
   *
   * narrativePerf (the Top Sectors strip tile) is deliberately NOT set
   * here — the scan's fast path owns it, or the strip would flip between
   * two providers' numbers depending on whether this tab was opened.
   */
  async function refreshFlows() {
    let fast = state.fastSectors;
    if (!fast || !fast.length) {
      fast = await Api.fastSectorPerformance().catch(e => {
        console.warn('[App] fast sector fetch failed (Flows tab)', e);
        return [];
      });
      state.fastSectors = fast;
    }
    if (fast.length) {
      state.flowsData = fast;
      el.flowsGrid.innerHTML = Render.marketFlowsHtml(fast, flowsExpanded);
    }

    const cg = await Api.sectorPerformance7d().catch(e => {
      console.warn('[App] sectorPerformance7d fetch failed (Flows tab)', e);
      return [];
    });
    if (!cg.length) return; // keep the fast render; nothing to merge

    const byName = new Map(fast.map(s => [s.name, s]));
    cg.forEach(s => byName.set(s.name, s)); // CoinGecko wins where present
    const merged = [...byName.values()];
    state.flowsData = merged;
    el.flowsGrid.innerHTML = Render.marketFlowsHtml(merged, flowsExpanded);
  }

  function refreshHeatmap() {
    el.heatmapGridContainer.innerHTML = Render.heatmapHtml(state.fastSectors);
  }

  // News tab reuses the same fetchAllNews() cache already populated by
  // the per-card news badges/detail-modal (5-min TTL) — no new fetch
  // path, just a different render of the same feed.
  async function refreshNews() {
    const data = await Api.fetchAllNews().catch(e => {
      console.warn('[App] fetchAllNews failed (News tab)', e);
      return null;
    });
    const articles = data ? Api.allNews(data.articles) : [];
    el.newsFeedContainer.innerHTML = Render.newsFeedHtml(articles);
  }

  // Account-scoped Watchlist tab (Phase 3). v1 scope: price + 24h% only,
  // no sparkline yet — kept out for now rather than half-built, same as
  // other "not urgent" scope calls this session; a real sparkline needs
  // per-symbol historical candles this tab doesn't otherwise fetch.
  async function refreshWatchlistTab() {
    const user = Auth.getUser();
    if (!user) {
      el.watchlistContainer.innerHTML = Render.watchlistHtml(null, []);
      return;
    }
    const entries = await Auth.watchlist.list();
    if (!entries.length) {
      el.watchlistContainer.innerHTML = Render.watchlistHtml(user, []);
      return;
    }
    const [spotTickers, linearTickers] = await Promise.all([
      Api.bybitTickers('spot').catch(() => []),
      Api.bybitTickers('linear').catch(() => [])
    ]);
    const bySymbol = new Map();
    spotTickers.forEach(t => bySymbol.set(`${t.symbol}:SPOT`, t));
    linearTickers.forEach(t => bySymbol.set(`${t.symbol}:PERP`, t));
    const rows = entries.map(e => {
      const t = bySymbol.get(`${e.symbol}:${e.market}`);
      return {
        symbol: e.symbol,
        market: e.market,
        price: t ? parseFloat(t.lastPrice) : null,
        change24h: t ? parseFloat(t.price24hPcnt) * 100 : null
      };
    });
    el.watchlistContainer.innerHTML = Render.watchlistHtml(user, rows);
  }

  function toggleFlowsRow(categoryId) {
    if (!categoryId) return;
    if (flowsExpanded.has(categoryId)) flowsExpanded.delete(categoryId);
    else flowsExpanded.add(categoryId);
    el.flowsGrid.innerHTML = Render.marketFlowsHtml(state.flowsData, flowsExpanded);
  }

  // ------------------------------------------------------------- Access gate
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Stores the hash of the code that granted access, not just a flat "1" —
  // checked against the CURRENT ACCESS_CODE_HASH on every load, so rotating
  // the code automatically revokes everyone granted under the old one and
  // forces re-entry, rather than only gating new visitors.
  function hasAccess() {
    return localStorage.getItem(STORAGE_KEYS.access) === ACCESS_CODE_HASH;
  }

  // Gates actual app rendering/scanning, not just a dismissible overlay —
  // startApp() (the real init work) only runs once access is confirmed, so
  // a visitor without the code never triggers a scan or sees rendered data.
  function initAccessGate(startApp) {
    if (hasAccess()) { startApp(); return; }

    el.accessGate.classList.add('open');
    el.accessCodeInput.focus();

    async function attempt() {
      const code = el.accessCodeInput.value.trim();
      if (!code) return;
      const hash = await sha256Hex(code);
      if (hash === ACCESS_CODE_HASH) {
        localStorage.setItem(STORAGE_KEYS.access, ACCESS_CODE_HASH);
        el.accessGate.classList.remove('open');
        startApp();
      } else {
        el.accessCodeError.textContent = 'Incorrect code. Try again.';
        el.accessCodeInput.value = '';
        el.accessCodeInput.focus();
      }
    }

    el.accessCodeSubmit.addEventListener('click', attempt);
    el.accessCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attempt();
    });
  }

  // ------------------------------------------------------------------ Tour
  // First-visit walkthrough via driver.js — vanilla JS, no build tooling,
  // matches this project's "no framework" constraint. Card-referencing
  // steps are dropped if no card exists yet (e.g. re-triggered from
  // Settings before any scan has completed), so the tour never breaks on
  // a missing element.
  //
  // Temporarily disabled — TOUR_STEPS is stale against this build's new
  // tabs/features (Dashboard, Flows, Heatmap, News, Watchlist, etc.).
  // Flip back to true once the steps are updated to match.
  const TOUR_ENABLED = false;
  const TOUR_STEPS = [
    { element: '.brand', popover: {
      title: 'Welcome to Wicktor', description: 'A multi-timeframe crypto & tokenized-stock screener, built around one taught trading method. Quick tour of the main screen.' } },
    { element: '.search-box', popover: {
      title: 'Search', description: 'Filter the cards below by symbol at any time.' } },
    { element: '#scan-btn', popover: {
      title: 'Scan', description: 'Pulls fresh market data and re-scores every coin. Also runs automatically on your refresh interval.' } },
    { element: '#top-strip', popover: {
      title: 'Market overview', description: 'Always live regardless of what you’re scanning below — market pulse, Fear & Greed, dominance, and top movers.' } },
    { element: '#filter-bar', popover: {
      title: 'Filters', description: 'Combine Market, Quality, Band, Side, and MCap chips to narrow the grid to what you care about.' } },
    { element: '.coin-card .card-head', popover: {
      title: 'Score & band', description: 'The score ring and the EXCELLENT / WATCH / AVOID label just below it are the single most important thing to check first.' } },
    { element: '.coin-card .cer-row', popover: {
      title: 'The details', description: 'Active TF shows each timeframe’s trend, RSI shows momentum, and CONT/EXH/REV break down why the score is what it is.' } },
    { element: '.coin-card .foot-actions', popover: {
      title: 'Chart & watchlist', description: 'Open the coin on TradingView, or star it to save it to your watchlist.' } },
    { element: '#settings-btn', popover: {
      title: 'Settings', description: 'Spot/Stocks/Perps toggles and everything technical live here, out of your way on the main screen.' } },
    { popover: {
      title: 'That’s it', description: 'Found a bug or have feedback? There’s a Feedback link right here in Settings — we’d love to hear from you.' } }
  ];

  function hasSeenTour() {
    return localStorage.getItem(STORAGE_KEYS.tourSeen) === '1';
  }

  function startTour() {
    if (!TOUR_ENABLED) return;
    if (typeof window.driver === 'undefined' || !window.driver.js) return; // CDN unavailable — fail soft
    const hasCards = !!document.querySelector('.coin-card');
    const steps = hasCards ? TOUR_STEPS : TOUR_STEPS.filter(s => !s.element || !s.element.startsWith('.coin-card'));
    const { driver } = window.driver.js;
    driver({ showProgress: true, steps }).drive();
  }

  // Auto-trigger once per browser, only once at least one card exists so
  // the card-detail steps have something to point at — called after every
  // renderAll(), but hasSeenTour() makes every call after the first a no-op.
  function maybeAutoStartTour() {
    if (!TOUR_ENABLED) return; // don't mark tourSeen while disabled, so re-enabling still auto-triggers for these visitors
    if (hasSeenTour()) return;
    if (!document.querySelector('.coin-card')) return;
    localStorage.setItem(STORAGE_KEYS.tourSeen, '1');
    startTour();
  }

  // ------------------------------------------------------------------ Init
  function init() {
    initTheme();
    if (MAINTENANCE_MODE) {
      el.maintenanceOverlay.classList.add('open');
      return; // nothing else runs — no access gate, no scan, nothing reachable
    }
    el.appVersion.textContent = `Wicktor v${APP_VERSION}`;
    el.takeTourBtn.addEventListener('click', () => {
      el.settingsBackdrop.classList.remove('open');
      el.settingsPanel.classList.remove('open');
      startTour();
    });
    initAccessGate(() => {
      bindStaticEvents();
      scheduleRefresh();
      refreshMarketContext().then(() => loadSnapshot({ force: true }));
      // Additive to the access gate above, not gated behind it in either
      // direction — Auth has its own independent session, unrelated to
      // the beta access-code check.
      Auth.onChange(renderAccountState);
      Auth.init().then(renderAccountState);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
