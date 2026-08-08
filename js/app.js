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
    includeCryptoSpot: true,
    includeStocks: false,
    includePerps: true,
    maxAgeMinutes: 20,
    spotCardsPerSide: 5,
    perpCardsPerSide: 5,
    includeNarrativeSectors: true
  };

  let state = {
    // Merge stored settings on top of defaults so new keys always have a value
    settings: { ...DEFAULT_SETTINGS, ...loadJson(STORAGE_KEYS.settings, {}) },
    watchlist: new Set(loadJson(STORAGE_KEYS.watchlist, [])),
    discovered: loadJson(STORAGE_KEYS.discovered, {}),
    coins: [],           // last computed, unfiltered
    renderedCoins: [],   // final capped+ordered list actually rendered
    narrativePerf: null, // top-4 sector objects [{name, weightedChange7d}] from last scan
    activeFilters: {
      market:  new Set(), // 'spot' | 'perp' — ANDed with quality, OR'd within itself
      quality: new Set(), // '3tf' | 'divergence' — ANDed with market, OR'd within itself
      band:    new Set(), // 'excellent' | 'watch' | 'avoid'
      side:    new Set(), // 'buy' | 'sell'
      mcap:    new Set()  // 'micro' | 'small' | 'mid' | 'large'
    },
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
    cryptoSpotToggle: document.getElementById('setting-crypto-spot'),
    stocksToggle: document.getElementById('setting-stocks'),
    perpToggle: document.getElementById('setting-perps'),
    narrativeToggle: document.getElementById('setting-narratives'),
    maxAgeInput: document.getElementById('setting-maxage'),
    spotCapInput: document.getElementById('setting-spot-cap'),
    perpCapInput: document.getElementById('setting-perp-cap'),
    scanProgress: document.getElementById('scan-progress'),
    scanProgressFill: document.getElementById('scan-progress-fill'),
    scanProgressLabel: document.getElementById('scan-progress-label')
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
  async function computeCoin(base, category, mcapMap, newsData) {
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

    // Compute news metadata eagerly from the pre-fetched feed
    const articles = newsData ? newsData.articles : null;
    const newsItems = articles ? Api.newsForSymbol(articles, base.symbol) : [];
    const newsResult = { items: newsItems };
    state.newsCache[base.symbol] = newsResult;
    const newsMeta = {
      count: newsItems.length,
      dominantSentiment: newsItems.length > 0 ? newsItems[0].sentiment : null
    };

    return {
      symbol: displaySymbol,
      rawSymbol: base.symbol,
      sector: base.narrativeSector || (base.isStock ? 'Tokenized Stock' : 'Crypto'),
      price: formatPrice(priceNum),
      market,
      side: result.bias === 1 ? (market === 'PERP' ? 'Long' : 'Buy') : (market === 'PERP' ? 'Short' : 'Sell'),
      discoveredAgo: discoveredAgoLabel(key),
      mcap: Api.formatMcap(rawMcap),
      mcapRaw: rawMcap,
      volatility,
      unlock,
      newsMeta,
      watchlisted: state.watchlist.has(key),
      resistance: formatPrice(result.tfSnapshots[0].resistance),
      support: formatPrice(result.tfSnapshots[0].support),
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
    console.time('[Scan] total');
    setLoading(true);
    try {
      // 1. Fetch market data, news, sector rankings, global stats, FNG in parallel!
      console.time('[Scan] parallel-fetches');
      const [mcapMap, newsData, sectorPerf, globalData, fngData] = await Promise.all([
        Api.coingeckoMarketCaps().catch(e => { console.warn('[App] mcap map fetch failed', e); return {}; }),
        Api.fetchAllNews().catch(e => { console.warn('[App] news fetch failed', e); return null; }),
        Api.sectorPerformance7d().catch(e => { console.warn('[App] sector performance fetch failed', e); return []; }),
        Api.coingeckoGlobal().catch(e => { console.warn('[App] coingecko global fetch failed', e); return null; }),
        Api.fearGreedIndex().catch(e => { console.warn('[App] fear greed fetch failed', e); return null; })
      ]);
      console.timeEnd('[Scan] parallel-fetches');

      // Compute sector ranking and save it in state.narrativePerf
      state.narrativePerf = null;
      if (sectorPerf && sectorPerf.length) {
        state.narrativePerf = [...sectorPerf]
          .sort((a, b) => b.weightedChange7d - a.weightedChange7d)
          .slice(0, 4);
      }

      // 2. Fetch Bybit universes in parallel (needed for movers and initial render)
      console.time('[Scan] universe-building');
      // assetFilter is applied before ranking by volume — crypto volume dwarfs
      // stock volume, so filtering after a shared top-N ranking would mean
      // stocks almost never appear even with the toggle on.
      const scanTargets = [];
      if (state.settings.includeCryptoSpot) scanTargets.push({ category: 'spot', assetFilter: 'crypto' });
      if (state.settings.includeStocks) scanTargets.push({ category: 'spot', assetFilter: 'stock' });
      if (state.settings.includePerps) scanTargets.push({ category: 'linear', assetFilter: 'crypto' }); // stocks are spot-only, no leverage on Bybit

      const movers = [];
      const universes = [];
      await Promise.all(scanTargets.map(async ({ category, assetFilter }) => {
        const universe = await Api.topUniverse(category, state.settings.universeSize, assetFilter);
        universes.push({ category, assetFilter, universe });
        // Top Gainers/Losers strip stays crypto-only for a consistent meaning
        // regardless of which toggles are enabled.
        if (category === 'spot' && assetFilter === 'crypto') {
          universe.forEach(u => {
            movers.push({ symbol: u.symbol.replace(/USDT$/, ''), change: u.change24h });
          });
        }
      }));
      state.rawMovers = movers;
      console.timeEnd('[Scan] universe-building');

      // 3. Render the top strip early using pre-existing coins (for pulse) + new movers + new cg/fng/sector stats!
      console.time('[Scan] top-strip-rendering');
      refreshTopStrip(globalData, fngData);
      el.topStrip.innerHTML = Render.topStripHtml(state.topStripData);
      console.timeEnd('[Scan] top-strip-rendering');

      // 4. Narrative coin sourcing (gated by includeNarrativeSectors, and only
      // meaningful when the crypto spot pool it injects into is itself enabled)
      console.time('[Scan] narrative-sourcing');
      const narrativeEnabled = state.settings.includeNarrativeSectors !== false;
      if (narrativeEnabled && state.settings.includeCryptoSpot && sectorPerf && sectorPerf.length) {
        const volumeSymbols = new Set(
          universes.flatMap(u => u.universe.map(b => b.symbol))
        );
        const narrativeCandidates = Api.topNarrativeCandidates(sectorPerf);
        const newCandidates = narrativeCandidates.filter(c => !volumeSymbols.has(c.symbol));
        if (newCandidates.length > 0) {
          const cryptoSpotEntry = universes.find(u => u.category === 'spot' && u.assetFilter === 'crypto');
          if (cryptoSpotEntry) cryptoSpotEntry.universe.push(...newCandidates);
        }
      }
      console.timeEnd('[Scan] narrative-sourcing');

      // 5. Run sequential batch analysis of all coins (Bybit klines + indicator scoring)
      console.time('[Scan] coin-analysis');
      const batchSize = 5;
      const totalBatches = universes.reduce(
        (sum, { universe }) => sum + Math.ceil(universe.length / batchSize), 0
      );
      const totalCoins = universes.reduce((sum, { universe }) => sum + universe.length, 0);
      let batchesDone = 0;
      let coinsDone = 0;

      const maxAgeMs = state.settings.maxAgeMinutes * 60 * 1000;
      const now = Date.now();
      const allCoins = [];
      const activeKeys = new Set();

      for (const { category, universe } of universes) {
        for (let i = 0; i < universe.length; i += batchSize) {
          const batch = universe.slice(i, i + batchSize);
          const results = await Promise.all(batch.map(b => computeCoin(b, category, mcapMap, newsData)));
          results.forEach(r => {
            if (r) {
              const key = `${r.rawSymbol}:${r.market}`;
              const ts = state.discovered[key];
              // Exclude coins whose first-seen timestamp is older than maxAgeMinutes.
              if (ts && (now - ts) > maxAgeMs) return;
              allCoins.push(r);
              activeKeys.add(key);
            }
          });
          batchesDone++;
          coinsDone += batch.length;
          setScanProgress(coinsDone, totalCoins, batchesDone, totalBatches);
        }
      }

      clearDiscoveredIfMissing(activeKeys);
      state.coins = allCoins.sort((a, b) => b.score - a.score);
      console.timeEnd('[Scan] coin-analysis');

      // 6. Refresh the top strip with updated scan results (pulse level) and render the cards
      console.time('[Scan] final-rendering');
      refreshTopStrip(globalData, fngData);
      renderAll();
      console.timeEnd('[Scan] final-rendering');
    } catch (err) {
      console.error('[App] scan failed', err);
    } finally {
      setLoading(false);
      console.timeEnd('[Scan] total');
    }
  }

  function setScanProgress(coinsDone, totalCoins, batchesDone, totalBatches) {
    const pct = totalBatches > 0 ? Math.round((batchesDone / totalBatches) * 100) : 0;
    el.scanProgressFill.style.width = pct + '%';
    el.scanProgressLabel.textContent = `Scanning ${coinsDone} of ${totalCoins}…`;
  }

  function setLoading(isLoading) {
    if (isLoading && state.coins.length === 0) {
      el.cardGrid.innerHTML = '<div class="loading-state">Scanning the market...</div>';
    }
    el.scanBtn.style.opacity = isLoading ? '0.6' : '1';
    el.scanBtn.disabled = isLoading;
    if (isLoading) {
      // Reset bar to zero and reveal it
      el.scanProgressFill.style.width = '0%';
      el.scanProgressLabel.textContent = 'Scanning…';
      el.scanProgress.classList.add('scanning');
    } else {
      el.scanProgress.classList.remove('scanning');
    }
  }

  // ------------------------------------------------------------- Top strip
  function refreshTopStrip(global, fng) {
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
      topSector: state.narrativePerf && state.narrativePerf[0]
        ? { name: state.narrativePerf[0].name, change: state.narrativePerf[0].weightedChange7d }
        : null,
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
    Render.renderCardGrid(el.cardGrid, state.renderedCoins);
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
    const coin = state.renderedCoins[idx];
    if (!coin) return;
    const key = `${coin.rawSymbol}:${coin.market}`;
    if (state.watchlist.has(key)) state.watchlist.delete(key);
    else state.watchlist.add(key);
    saveJson(STORAGE_KEYS.watchlist, [...state.watchlist]);
    renderAll();
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
    el.cryptoSpotToggle.checked = state.settings.includeCryptoSpot;
    el.stocksToggle.checked = state.settings.includeStocks;
    el.perpToggle.checked = state.settings.includePerps;
    el.narrativeToggle.checked = state.settings.includeNarrativeSectors !== false;
    el.maxAgeInput.value = state.settings.maxAgeMinutes;
    el.spotCapInput.value = state.settings.spotCardsPerSide;
    el.perpCapInput.value = state.settings.perpCardsPerSide;
    el.settingsBackdrop.classList.add('open');
    el.settingsPanel.classList.add('open');
  }
  function closeSettings() {
    state.settings.universeSize = Math.max(10, Math.min(80, parseInt(el.universeInput.value) || 30));
    state.settings.refreshIntervalSec = Math.max(20, parseInt(el.refreshInput.value) || 60);
    state.settings.includeCryptoSpot = el.cryptoSpotToggle.checked;
    state.settings.includeStocks = el.stocksToggle.checked;
    state.settings.includePerps = el.perpToggle.checked;
    state.settings.includeNarrativeSectors = el.narrativeToggle.checked;
    state.settings.maxAgeMinutes = Math.max(1, parseInt(el.maxAgeInput.value) || 20);
    state.settings.spotCardsPerSide = Math.max(1, Math.min(20, parseInt(el.spotCapInput.value) || 5));
    state.settings.perpCardsPerSide = Math.max(1, Math.min(20, parseInt(el.perpCapInput.value) || 5));
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
