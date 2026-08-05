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

  const BYBIT_BASE = 'https://api.bybit.com';
  const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
  const FNG_BASE = 'https://api.alternative.me/fng/';
  const DEFILLAMA_BASE = 'https://api.llama.fi';
  const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

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
   */
  async function topUniverse(category, count) {
    const tickers = await bybitTickers(category);
    return tickers
      .filter(t => isTradeableUsdtPair(t.symbol))
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

  let cgCache = { global: null, categories: null, ts: 0 };
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

  async function coingeckoTopSector() {
    const now = Date.now();
    if (cgCache.categories && now - cgCache.ts < CG_CACHE_MS) return cgCache.categories;
    const data = await safeFetch(`${COINGECKO_BASE}/coins/categories`);
    if (!data || !Array.isArray(data)) return null;
    const sorted = data
      .filter(c => c.market_cap_change_24h != null)
      .sort((a, b) => b.market_cap_change_24h - a.market_cap_change_24h);
    const top = sorted[0] ? { name: sorted[0].name, change: sorted[0].market_cap_change_24h } : null;
    cgCache.categories = top;
    return top;
  }

  /**
   * Best-effort symbol -> market cap map from CoinGecko's top 250 by
   * market cap. Matching by ticker symbol (not CoinGecko id) means a
   * rare collision is possible when two listed projects share a
   * ticker; in that case the larger-cap project wins since the list
   * is already sorted by market cap descending. Coins outside the
   * top 250 simply won't have a match, and callers should show "—"
   * rather than guess.
   */
  let mcapCache = { map: null, ts: 0 };
  const MCAP_CACHE_MS = 5 * 60 * 1000;

  async function coingeckoMarketCaps() {
    const now = Date.now();
    if (mcapCache.map && now - mcapCache.ts < MCAP_CACHE_MS) return mcapCache.map;
    const data = await safeFetch(`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`);
    if (!data || !Array.isArray(data)) return mcapCache.map || {};
    const map = {};
    data.forEach(c => {
      const sym = (c.symbol || '').toUpperCase();
      if (!(sym in map)) map[sym] = c.market_cap; // first hit = highest mcap for that symbol
    });
    mcapCache = { map, ts: now };
    return map;
  }

  function formatMcap(n) {
    if (n == null) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return String(Math.round(n));
  }

  // ------------------------------------------------------- Fear & Greed ---

  async function fearGreedIndex() {
    const data = await safeFetch(FNG_BASE + '?limit=1');
    if (!data || !data.data || !data.data[0]) return null;
    return { value: Number(data.data[0].value), label: data.data[0].value_classification };
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
   * News is lazy-loaded per coin (only called when a card's detail
   * view is opened). Fetches from a live GitHub Pages news feed.
   */
  async function coinNews(symbol, apiKey) {
    const cleanedSymbol = (symbol || '')
      .toUpperCase()
      .replace(/USDT$|USD$|PERP$|-PERP$/i, '')
      .replace(/^[$#]/, '');

    const now = Date.now();
    if (!_newsCache || (now - _newsCacheTime > NEWS_CACHE_TTL)) {
      const url = `https://nomi62300.github.io/crypto-news-bot/news.json?t=${now}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          return { error: 'fetch-failed' };
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.articles)) {
          return { error: 'unexpected-response' };
        }
        _newsCache = data;
        _newsCacheTime = now;
      } catch (err) {
        console.warn('[Api] news fetch failed', err);
        return { error: 'fetch-failed' };
      }
    }

    if (!_newsCache || !Array.isArray(_newsCache.articles)) {
      return { error: 'unexpected-response' };
    }

    const filtered = _newsCache.articles.filter(a => {
      return Array.isArray(a.tickers) && 
             a.tickers.some(t => (t || '').toUpperCase() === cleanedSymbol);
    });

    return {
      items: filtered.map(a => {
        const sentimentLower = (a.sentiment || '').toLowerCase();
        let mappedSentiment = 'neutral';
        if (sentimentLower === 'bullish') {
          mappedSentiment = 'bull';
        } else if (sentimentLower === 'bearish') {
          mappedSentiment = 'bear';
        } else if (sentimentLower === 'neutral') {
          mappedSentiment = 'neutral';
        }

        return {
          headline: a.title,
          source: a.source,
          time: a.published,
          sentiment: mappedSentiment,
          url: a.url
        };
      })
    };
  }

  return {
    bybitTickers, bybitInstruments, bybitKlines, topUniverse, fetchCandleSet,
    isTradeableUsdtPair, isXStock,
    coingeckoGlobal, coingeckoTopSector, coingeckoMarketCaps, formatMcap,
    fearGreedIndex, unlockInfo, coinNews
  };
})();

if (typeof module !== 'undefined') module.exports = Api;
