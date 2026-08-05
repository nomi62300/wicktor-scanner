/* ==========================================================================
   Wicktor — App Orchestration
   ========================================================================== */

(() => {
  const STORAGE_KEYS = {
    theme: 'wicktor:theme',
    watchlist: 'wicktor:watchlist',
    settings: 'wicktor:settings',
    discovered: 'wicktor:discovered' // { "SYMBOL:MARKET": timestampMs }
  };

  const DEFAULT_SETTINGS = {
    universeSize: 30,
    refreshIntervalSec: 60,
    showPerps: false,
    fmpApiKey: ''
  };

  let state = {
    settings: loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
    watchlist: new Set(loadJson(STORAGE_KEYS.watchlist, [])),
    discovered: loadJson(STORAGE_KEYS.discovered, {}),
    coins: [],           // last computed, unfiltered
    activeFilter: 'all',
    searchQuery: '',
    topStripData: {},
    rawMovers: [],
    refreshTimer: null,
    modalCoin: null,
    newsCache: {}         // symbol -> news result
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
    search: document.getElementById('search-input'),
    scanBtn: document.getElementById('scan-btn'),
    themeBtn: document.getElementById('theme-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    modalContent: document.getElementById('modal-content'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsClose: document.getElementById('settings-close'),
    universeInput: document.getElementById('setting-universe'),
    refreshInput: document.getElementById('setting-refresh'),
    perpToggle: document.getElementById('setting-perps'),
    fmpKeyInput: document.getElementById('setting-fmpkey')
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
  async function computeCoin(base, category, mcapMap) {
    const candles = await Api.fetchCandleSet(category, base.symbol);
    if (!candles.h1) return null;
    const result = Scoring.evaluate(candles);
    if (!result) return null;

    const market = category === 'linear' ? 'PERP' : 'SPOT';
    const key = `${base.symbol}:${market}`;
    markDiscovered(key);

    const closes1h = candles.h1.map(c => c.c);
    const priceNum = base.price;
    const volatility = classifyVolatility(candles.h1);

    // display symbol without USDT suffix, and without trailing x for stocks (kept as-is with x for clarity)
    const displaySymbol = base.symbol.replace(/USDT$/, '');

    const cleanSym = displaySymbol.replace(/x$/, '');
    const rawMcap = mcapMap[cleanSym.toUpperCase()];

    let unlock = null; // populated lazily/best-effort in a later pass if desired

    return {
      symbol: displaySymbol,
      rawSymbol: base.symbol,
      sector: base.isStock ? 'Tokenized Stock' : 'Crypto',
      price: formatPrice(priceNum),
      market,
      side: result.bias === 1 ? (market === 'PERP' ? 'Long' : 'Buy') : (market === 'PERP' ? 'Short' : 'Sell'),
      discoveredAgo: discoveredAgoLabel(key),
      mcap: Api.formatMcap(rawMcap),
      volatility,
      unlock,
      newsMeta: state.newsCache[base.symbol]
        ? { count: state.newsCache[base.symbol].items ? state.newsCache[base.symbol].items.length : 0,
            dominantSentiment: state.newsCache[base.symbol].items && state.newsCache[base.symbol].items[0]
              ? state.newsCache[base.symbol].items[0].sentiment : null }
        : { count: 0 },
      watchlisted: state.watchlist.has(key),
      resistance: formatPrice(priceNum * 1.015),
      support: formatPrice(priceNum * 0.987),
      ...result
    };
  }

  function classifyVolatility(h1candles) {
    const last20 = h1candles.slice(-20);
    if (last20.length < 5) return 'Low';
    const ranges = last20.map(c => (c.h - c.l) / c.c);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    if (avgRange > 0.05) return 'Extreme';
    if (avgRange > 0.03) return 'High';
    if (avgRange > 0.015) return 'Moderate';
    return 'Low';
  }

  function formatPrice(n) {
    if (n == null || isNaN(n)) return '--';
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
  }

  async function runScan() {
    setLoading(true);
    try {
      const mcapMap = await Api.coingeckoMarketCaps();

      const categories = ['spot'];
      if (state.settings.showPerps) categories.push('linear');

      let allCoins = [];
      const activeKeys = new Set();
      const movers = [];

      for (const category of categories) {
        const universe = await Api.topUniverse(category, state.settings.universeSize);
        universe.forEach(u => {
          if (category === 'spot') {
            movers.push({ symbol: u.symbol.replace(/USDT$/, ''), change: u.change24h });
          }
        });
        // fetch sequentially in small batches to be gentle on rate limits
        const batchSize = 5;
        for (let i = 0; i < universe.length; i += batchSize) {
          const batch = universe.slice(i, i + batchSize);
          const results = await Promise.all(batch.map(b => computeCoin(b, category, mcapMap)));
          results.forEach(r => {
            if (r) {
              allCoins.push(r);
              activeKeys.add(`${r.rawSymbol}:${r.market}`);
            }
          });
        }
      }

      clearDiscoveredIfMissing(activeKeys);
      state.coins = allCoins.sort((a, b) => b.score - a.score);
      state.rawMovers = movers;
      await refreshTopStrip();
      renderAll();
    } catch (err) {
      console.error('[App] scan failed', err);
    } finally {
      setLoading(false);
    }
  }

  function setLoading(isLoading) {
    if (isLoading && state.coins.length === 0) {
      el.cardGrid.innerHTML = '<div class="loading-state">Scanning the market...</div>';
    }
    el.scanBtn.style.opacity = isLoading ? '0.6' : '1';
    el.scanBtn.disabled = isLoading;
  }

  // ------------------------------------------------------------- Top strip
  async function refreshTopStrip() {
    const [global, sector, fng] = await Promise.all([
      Api.coingeckoGlobal(), Api.coingeckoTopSector(), Api.fearGreedIndex()
    ]);

    const spotCoins = state.coins.filter(c => c.market === 'SPOT');
    const perpCoins = state.coins.filter(c => c.market === 'PERP');
    const pulse = (list) => {
      if (!list.length) return null;
      const avg = list.reduce((sum, c) => sum + c.direction, 0) / list.length;
      return Math.round(avg);
    };

    state.topStripData = {
      pulseSpot: pulse(spotCoins),
      pulsePerp: pulse(perpCoins),
      fearGreed: fng,
      btcDominance: global ? global.market_cap_percentage.btc : null,
      mcap: global ? Api.formatMcap(global.total_market_cap.usd) : null,
      mcapChange24h: global ? global.market_cap_change_percentage_24h_usd : 0,
      topSector: sector,
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
    if (state.activeFilter === '3tf') list = list.filter(c => c.alignCount === 3);
    else if (state.activeFilter === 'spot') list = list.filter(c => c.market === 'SPOT');
    else if (state.activeFilter === 'perp') list = list.filter(c => c.market === 'PERP');
    else if (state.activeFilter === 'divergence') list = list.filter(c => c.divergenceOverall !== 'none');

    if (state.searchQuery) {
      const q = state.searchQuery.toUpperCase();
      list = list.filter(c => c.symbol.toUpperCase().includes(q));
    }
    return list;
  }

  // ---------------------------------------------------------------- Render
  function renderAll() {
    el.topStrip.innerHTML = Render.topStripHtml(state.topStripData);
    Render.renderCardGrid(el.cardGrid, getFilteredCoins());
    bindCardEvents();
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
    const coin = getFilteredCoins()[idx];
    if (!coin) return;
    const key = `${coin.rawSymbol}:${coin.market}`;
    if (state.watchlist.has(key)) state.watchlist.delete(key);
    else state.watchlist.add(key);
    saveJson(STORAGE_KEYS.watchlist, [...state.watchlist]);
    renderAll();
  }

  function openTradingView(idx) {
    const coin = getFilteredCoins()[idx];
    if (!coin) return;
    const tvSymbol = coin.market === 'PERP' ? `BYBIT:${coin.rawSymbol}.P` : `BYBIT:${coin.rawSymbol}`;
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`, '_blank', 'noopener');
  }

  // ----------------------------------------------------------------- Modal
  async function openModal(idx) {
    const coin = getFilteredCoins()[idx];
    if (!coin) return;
    state.modalCoin = coin;
    el.modalContent.innerHTML = Render.detailModalHtml(coin, state.newsCache[coin.rawSymbol]);
    el.modalBackdrop.classList.add('open');
    bindModalCloseEvents();

    if (!state.newsCache[coin.rawSymbol]) {
      const news = await Api.coinNews(coin.symbol, state.settings.fmpApiKey);
      state.newsCache[coin.rawSymbol] = news;
      if (state.modalCoin === coin) {
        el.modalContent.innerHTML = Render.detailModalHtml(coin, news);
        bindModalCloseEvents();
      }
    }
  }
  function bindModalCloseEvents() {
    const closeBtn = el.modalContent.querySelector('[data-action="close-modal"]');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
  }
  function closeModal() {
    el.modalBackdrop.classList.remove('open');
    state.modalCoin = null;
  }

  // -------------------------------------------------------------- Settings
  function openSettings() {
    el.universeInput.value = state.settings.universeSize;
    el.refreshInput.value = state.settings.refreshIntervalSec;
    el.perpToggle.checked = state.settings.showPerps;
    el.fmpKeyInput.value = state.settings.fmpApiKey;
    el.settingsBackdrop.classList.add('open');
    el.settingsPanel.classList.add('open');
  }
  function closeSettings() {
    state.settings.universeSize = Math.max(10, Math.min(80, parseInt(el.universeInput.value) || 30));
    state.settings.refreshIntervalSec = Math.max(20, parseInt(el.refreshInput.value) || 60);
    state.settings.showPerps = el.perpToggle.checked;
    state.settings.fmpApiKey = el.fmpKeyInput.value.trim();
    saveJson(STORAGE_KEYS.settings, state.settings);
    el.settingsBackdrop.classList.remove('open');
    el.settingsPanel.classList.remove('open');
    scheduleRefresh();
    runScan();
  }

  // ------------------------------------------------------------ Scheduling
  function scheduleRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(runScan, state.settings.refreshIntervalSec * 1000);
  }

  // --------------------------------------------------------------- Wiring
  function bindStaticEvents() {
    el.themeBtn.addEventListener('click', toggleTheme);
    el.scanBtn.addEventListener('click', runScan);
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
        el.filterBar.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeFilter = chip.dataset.filter;
        renderAll();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closeSettings(); }
    });
  }

  // ------------------------------------------------------------------ Init
  function init() {
    initTheme();
    bindStaticEvents();
    scheduleRefresh();
    runScan();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
