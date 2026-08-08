/* ==========================================================================
   Wicktor — API Layer
   All external data fetching lives here. Every function fails soft:
   on error it logs to console and returns null / [] rather than throwing,
   so one flaky data source never breaks the whole screener.
   ========================================================================== */

const Api = (() => {

  let _newsCache = null;
  let _newsCacheTime = 0;
  const NEWS_CACHE_TTL = 5 * 60 * 1000;

  // -------------------------------------------------- Narrative sector cache
  let _cgCategoryListCache = { data: null, ts: 0 };
  const CG_CATEGORY_LIST_TTL = 24 * 60 * 60 * 1000; // 24 hours

  let _sectorPerfCache = { data: null, ts: 0 };
  const SECTOR_PERF_TTL = 4 * 60 * 60 * 1000; // 4 hours

  /**
   * Narrative name-fragments matched case-insensitively against the live
   * CoinGecko category list. A console.warn fires for any that find no match,
   * making taxonomy drift visible without silently dropping a sector.
   */
  const NARRATIVE_KEYWORDS = [
    'Artificial Intelligence', 'DePIN', 'Real World Assets', 'Gaming',
    'Layer 1', 'Layer 2', 'Meme', 'Privacy', 'Oracle', 'Metaverse',
    'Liquid Staking', 'Restaking', 'Modular Blockchain', 'Data Availability',
    'Infrastructure', 'DeFi'
  ];

  const BYBIT_BASE = 'https://api.bybit.com';
  const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
  const FNG_BASE = 'https://api.alternative.me/fng/';
  const DEFILLAMA_BASE = 'https://api.llama.fi';
  const NEWS_JSON_URL = 'https://nomi62300.github.io/crypto-news-bot/news.json';

  async function safeFetch(url, opts) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        console.warn('[Api] non-OK response', res.status, url);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn('[Api] fetch failed', url, err.message);
      return null;
    }
  }

  // -------------------------------------------------------------- Bybit ---

  const INTERVAL_MAP = { '1h': '60', '15m': '15', '5m': '5' };

  /**
   * category: 'spot' | 'linear'
   */
  async function bybitTickers(category) {
    const data = await safeFetch(`${BYBIT_BASE}/v5/market/tickers?category=${category}`);
    if (!data || data.retCode !== 0) return [];
    return data.result.list;
  }

  async function bybitInstruments(category) {
    const data = await safeFetch(`${BYBIT_BASE}/v5/market/instruments-info?category=${category}&limit=1000`);
    if (!data || data.retCode !== 0) return [];
    return data.result.list;
  }

  /**
   * Returns candles oldest->newest as {t,o,h,l,c,v}
   */
  async function bybitKlines(category, symbol, tf, limit = 100) {
    const interval = INTERVAL_MAP[tf];
    const data = await safeFetch(
      `${BYBIT_BASE}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!data || data.retCode !== 0) return null;
    // Bybit returns newest-first: [start,open,high,low,close,volume,turnover]
    return data.result.list
      .map(r => ({
        t: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
        l: Number(r[3]), c: Number(r[4]), v: Number(r[5])
      }))
      .reverse();
  }

  const EXCLUDE_QUOTE_PATTERN = /^(USDC|FDUSD|DAI|TUSD|EUR|USDE)USDT$/;
  const LEVERAGED_PATTERN = /(UP|DOWN|BULL|BEAR)USDT$/;

  function isTradeableUsdtPair(symbol) {
    if (!symbol.endsWith('USDT')) return false;
    if (EXCLUDE_QUOTE_PATTERN.test(symbol)) return false;
    if (LEVERAGED_PATTERN.test(symbol)) return false;
    return true;
  }

  function isXStock(symbol) {
    return /[A-Z]+xUSDT$/.test(symbol);
  }

  /**
   * Picks the top N USDT pairs by 24h quote volume from a given category.
   * `assetFilter` ('crypto' | 'stock' | 'all', default 'all') is applied
   * BEFORE ranking by volume — crypto volume dwarfs stock volume, so
   * filtering after a shared top-N ranking would mean stocks almost never
   * appear even when explicitly requested.
   */
  async function topUniverse(category, count, assetFilter = 'all') {
    const tickers = await bybitTickers(category);
    return tickers
      .filter(t => isTradeableUsdtPair(t.symbol))
      .filter(t => {
        if (assetFilter === 'crypto') return !isXStock(t.symbol);
        if (assetFilter === 'stock') return isXStock(t.symbol);
        return true;
      })
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.price24hPcnt) * 100,
        volume24h: parseFloat(t.turnover24h || t.volume24h || 0),
        isStock: isXStock(t.symbol)
      }))
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, count);
  }

  async function fetchCandleSet(category, symbol) {
    const [h1, m15, m5] = await Promise.all([
      bybitKlines(category, symbol, '1h', 100),
      bybitKlines(category, symbol, '15m', 100),
      bybitKlines(category, symbol, '5m', 100)
    ]);
    return { h1, m15, m5 };
  }

  // ----------------------------------------------------------- CoinGecko --

  let cgCache = { global: null, ts: 0 };
  const CG_CACHE_MS = 5 * 60 * 1000;

  async function coingeckoGlobal() {
    const now = Date.now();
    if (cgCache.global && now - cgCache.ts < CG_CACHE_MS) return cgCache.global;
    const data = await safeFetch(`${COINGECKO_BASE}/global`);
    if (data && data.data) {
      cgCache.global = data.data;
      cgCache.ts = now;
    }
    return cgCache.global;
  }

  /**
   * Best-effort symbol -> market cap map from CoinGecko's top 250 by
   * market cap. Matching by ticker symbol (not CoinGecko id) means a
   * rare collision is possible when two listed projects share a
   * ticker; in that case the larger-cap project wins since the list
   * is already sorted by market cap descending. Coins outside the
   * top 1000 simply won't have a match, and callers should show "—"
   * rather than guess.
   */
  let mcapCache = { map: null, ts: 0 };
  const MCAP_CACHE_MS = 10 * 60 * 1000; // 10 minutes

  async function coingeckoMarketCaps() {
    const now = Date.now();
    if (mcapCache.map && now - mcapCache.ts < MCAP_CACHE_MS) return mcapCache.map;

    const map = {};
    for (let page = 1; page <= 4; page++) {
      const data = await safeFetch(`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`);
      if (data && Array.isArray(data)) {
        data.forEach(c => {
          const sym = (c.symbol || '').toUpperCase();
          if (!(sym in map)) map[sym] = c.market_cap; // first hit = highest mcap for that symbol
        });
      }
      if (page < 4) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    if (Object.keys(map).length > 0) {
      mcapCache = { map, ts: now };
    }
    return mcapCache.map || map;
  }

  function formatMcap(n) {
    if (n == null) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return String(Math.round(n));
  }

  // ------------------------------------------------------- Fear & Greed ---

  let fngCache = { data: null, ts: 0 };
  const FNG_CACHE_MS = 4 * 60 * 60 * 1000; // 4 hours

  async function fearGreedIndex() {
    const now = Date.now();
    if (fngCache.data && now - fngCache.ts < FNG_CACHE_MS) return fngCache.data;
    const data = await safeFetch(FNG_BASE + '?limit=1');
    if (data && data.data && data.data[0]) {
      const res = { value: Number(data.data[0].value), label: data.data[0].value_classification };
      fngCache = { data: res, ts: now };
    }
    return fngCache.data;
  }

  // ------------------------------------------------------- DefiLlama -----

  /**
   * Best-effort token unlock lookup. DefiLlama's coverage is partial;
   * a miss here just means the card shows no unlock chip, which is
   * the correct silent fallback, not an error.
   */
  async function unlockInfo(protocolSlug) {
    const data = await safeFetch(`${DEFILLAMA_BASE}/emissions/${protocolSlug}`);
    if (!data || !data.events) return null;

    const now = Date.now() / 1000;
    const upcoming = data.events
      .filter(e => e.timestamp > now)
      .sort((a, b) => a.timestamp - b.timestamp)[0];
    if (!upcoming) return null;

    const secondsAway = upcoming.timestamp - now;
    const days = Math.floor(secondsAway / 86400);
    const hours = Math.floor((secondsAway % 86400) / 3600);
    if (days > 7) return null; // outside our display window

    const pct = upcoming.percentOfMaxSupply || upcoming.percentOfCirculatingSupply || 0;
    let severity = 'grey';
    if (pct >= 5 || days < 1) severity = 'red';
    else if (pct >= 1) severity = 'amber';

    return {
      days, hours,
      amount: upcoming.noOfTokens ? formatTokenAmount(upcoming.noOfTokens) : '—',
      pct: Math.round(pct * 10) / 10,
      severity
    };
  }

  function formatTokenAmount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' Mn';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
    return String(Math.round(n));
  }

  // -------------------------------------------------------- News Feed ----

  /**
   * Fetches and caches the full news JSON from the self-hosted GitHub Pages
   * feed. Returns the parsed data object (with .articles array) or null on
   * failure. If a previous cache entry exists it is returned on failure
   * rather than null, so a transient network blip doesn't wipe the news UI.
   */
  async function fetchAllNews() {
    const now = Date.now();
    if (_newsCache && (now - _newsCacheTime < NEWS_CACHE_TTL)) return _newsCache;
    const data = await safeFetch(`${NEWS_JSON_URL}?t=${now}`);
    if (data && Array.isArray(data.articles)) {
      _newsCache = data;
      _newsCacheTime = now;
    }
    // Return existing cache on failure rather than null (fail-soft)
    return _newsCache || null;
  }

  /**
   * Filters a raw articles array to those mentioning `symbol` (uppercase
   * ticker match), sorts newest-first, maps sentiment, caps to 5 items.
   * Pure — no async, no side effects.
   */
  function newsForSymbol(articles, symbol) {
    const clean = (symbol || '')
      .toUpperCase()
      .replace(/USDT$|USD$|PERP$|-PERP$/i, '')
      .replace(/^[$#]/, '');

    return (articles || [])
      .filter(a => Array.isArray(a.tickers) &&
                   a.tickers.some(t => (t || '').toUpperCase() === clean))
      .sort((a, b) => new Date(b.published) - new Date(a.published))
      .slice(0, 5)
      .map(a => {
        const s = (a.sentiment || '').toLowerCase();
        return {
          headline: a.title,
          source:   a.source,
          time:     a.published,
          sentiment: s === 'bullish' ? 'bull' : s === 'bearish' ? 'bear' : 'neutral',
          url:      a.url
        };
      });
  }

  /**
   * Returns { items } for the given symbol using the cached feed.
   * No apiKey parameter — feed is open CORS, no key required.
   */
  async function coinNews(symbol) {
    const data = await fetchAllNews();
    if (!data) return { error: 'fetch-failed' };
    return { items: newsForSymbol(data.articles, symbol) };
  }

  // ------------------------------------------------- Narrative / Sectors ---

  /**
   * Lightweight list of every CoinGecko category {id, name}.
   * Cached 24h — taxonomy changes are rare.
   */
  async function cgCategoryList() {
    const now = Date.now();
    if (_cgCategoryListCache.data && now - _cgCategoryListCache.ts < CG_CATEGORY_LIST_TTL) {
      return _cgCategoryListCache.data;
    }
    const data = await safeFetch(`${COINGECKO_BASE}/coins/categories/list`);
    if (data && Array.isArray(data)) {
      _cgCategoryListCache = { data, ts: now };
    }
    return _cgCategoryListCache.data || [];
  }

  /**
   * For each NARRATIVE_KEYWORDS entry, resolves the matching CoinGecko
   * category ID (dynamic lookup — never hardcodes slugs), then fetches the
   * top-50 coins for that category with 7d price change data. Computes a
   * market-cap-weighted 7d performance per sector.
   *
   * Sequential fetches with a 1.5 s delay to stay under the free-tier limit.
   * Cached 4 hours — sector rotation over a 7d window doesn't meaningfully
   * change minute-to-minute.
   *
   * Returns [{categoryId, name, weightedChange7d, coins}]
   */
  async function sectorPerformance7d() {
    const now = Date.now();
    if (_sectorPerfCache.data && now - _sectorPerfCache.ts < SECTOR_PERF_TTL) {
      const ageSec = Math.round((now - _sectorPerfCache.ts) / 1000);
      console.log(`[Api] sectorPerformance7d cache HIT (age: ${ageSec}s)`);
      return _sectorPerfCache.data;
    }

    console.log('[Api] sectorPerformance7d cache MISS');
    console.time('sectorPerformance7d');

    // Resolve keyword → category ID dynamically from the live category list
    const categoryList = await cgCategoryList();
    const resolvedCategories = [];
    for (const kw of NARRATIVE_KEYWORDS) {
      const kwLower = kw.toLowerCase();
      const match = categoryList.find(c => c.name.toLowerCase().includes(kwLower));
      if (match) {
        resolvedCategories.push({ id: match.id, name: kw });
      } else {
        console.warn(`[Api] narrative: no CoinGecko category match for keyword "${kw}"`);
      }
    }

    const results = [];
    for (const cat of resolvedCategories) {
      const data = await safeFetch(
        `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=${cat.id}&order=market_cap_desc&per_page=50&page=1&price_change_percentage=7d`
      );
      if (data && Array.isArray(data) && data.length > 0) {
        let totalMcap = 0, weightedSum = 0;
        for (const coin of data) {
          const chg = coin.price_change_percentage_7d_in_currency;
          if (chg == null || coin.market_cap == null) continue;
          totalMcap += coin.market_cap;
          weightedSum += coin.market_cap * chg;
        }
        const weightedChange7d = totalMcap > 0 ? weightedSum / totalMcap : 0;
        results.push({ categoryId: cat.id, name: cat.name, weightedChange7d, coins: data });
      }
      // 1.5 s delay between calls — stays comfortably under CoinGecko free-tier rate limit
      await new Promise(r => setTimeout(r, 1500));
    }

    console.timeEnd('sectorPerformance7d');
    _sectorPerfCache = { data: results, ts: now };
    return results;
  }

  /**
   * Pure synchronous function. Given the full sectorPerf array, returns
   * [{symbol, price, change24h, volume24h, isStock, narrativeSector, sectorRank}]
   * ready to merge into the scan universe.
   *
   * Rules:
   *  - Top 4 sectors by weightedChange7d
   *  - Per sector: mcap >= $350M, sorted by 7d % desc, top 8
   *  - isTradeableUsdtPair() check (computeCoin handles further failsoft)
   *  - Deduped within narrative candidates (higher-ranked sector wins)
   *
   * Caller dedupes against the volume-based universe.
   */
  function topNarrativeCandidates(sectorPerf) {
    if (!sectorPerf || !sectorPerf.length) return [];

    const top4 = [...sectorPerf]
      .sort((a, b) => b.weightedChange7d - a.weightedChange7d)
      .slice(0, 4);

    const seen = new Set(); // deduplicate across sectors
    const candidates = [];

    top4.forEach((sector, sectorRank) => {
      const qualifying = (sector.coins || [])
        .filter(c => c.market_cap != null && c.market_cap >= 350_000_000)
        .sort((a, b) =>
          (b.price_change_percentage_7d_in_currency || 0) -
          (a.price_change_percentage_7d_in_currency || 0)
        )
        .slice(0, 8);

      for (const coin of qualifying) {
        const bybitSymbol = (coin.symbol || '').toUpperCase() + 'USDT';
        if (!isTradeableUsdtPair(bybitSymbol)) continue;
        if (seen.has(bybitSymbol)) continue; // higher-ranked sector already claimed it
        seen.add(bybitSymbol);
        candidates.push({
          symbol:          bybitSymbol,
          price:           coin.current_price    || 0,
          change24h:       coin.price_change_percentage_24h || 0,
          volume24h:       coin.total_volume      || 0,
          isStock:         false,
          narrativeSector: sector.name,
          sectorRank:      sectorRank + 1
        });
      }
    });

    return candidates;
  }

  return {
    bybitTickers, bybitInstruments, bybitKlines, topUniverse, fetchCandleSet,
    isTradeableUsdtPair, isXStock,
    coingeckoGlobal, coingeckoMarketCaps, formatMcap,
    fearGreedIndex, unlockInfo,
    fetchAllNews, newsForSymbol, coinNews,
    cgCategoryList, sectorPerformance7d, topNarrativeCandidates
  };
})();

if (typeof module !== 'undefined') module.exports = Api;
