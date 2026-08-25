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
  // crypto-news-bot's Pages custom domain (snitch.wicktor.top) has a valid,
  // approved HTTPS cert but "Enforce HTTPS" is off in that repo's Pages
  // settings, so the old nomi62300.github.io/crypto-news-bot/ URL 301s to
  // http:// (not https://) — a browser on this HTTPS-served page blocks
  // that redirect as mixed content, silently failing every news fetch.
  // Hitting the working HTTPS URL directly sidesteps the broken redirect.
  const NEWS_JSON_URL = 'https://snitch.wicktor.top/news.json';

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

  const INTERVAL_MAP = {
    '1m': '1', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '4h': '240', '1d': 'D'
  };

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
   * % change in open interest over the trailing 15 minutes, perpetuals
   * only (`category` is always 'linear' here — spot has no OI concept).
   * `limit=2` gives exactly [current, ~15min-ago] since intervalTime=15min
   * spaces snapshots 15 min apart; list is newest-first per Bybit's
   * convention (same as bybitKlines before its own reverse()).
   */
  async function openInterestChange15m(symbol) {
    const data = await safeFetch(
      `${BYBIT_BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`
    );
    if (!data || data.retCode !== 0) return null;
    const list = data.result && data.result.list;
    if (!list || list.length < 2) return null;
    const current = parseFloat(list[0].openInterest);
    const prior = parseFloat(list[1].openInterest);
    if (!prior) return null;
    return ((current - prior) / prior) * 100;
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

  // A "symbol ends in X" regex can't reliably distinguish tokenized stocks
  // (AAPLXUSDT) from ordinary crypto tickers that happen to end in X
  // (AVAXUSDT, GMXUSDT, SNXUSDT, STXUSDT, TRXUSDT, ZRXUSDT, IMXUSDT,
  // DYDXUSDT, FRAXUSDT, MPLXUSDT, ...). Bybit's own instruments-info
  // response has an authoritative `symbolType: "xstocks"` field — use that
  // instead. Seeded with the confirmed live list so isXStock() is correct
  // even before the async refresh below completes or if it ever fails.
  const KNOWN_XSTOCK_SYMBOLS = new Set([
    'AAPLXUSDT', 'AMZNXUSDT', 'COINXUSDT', 'CRCLXUSDT', 'GOOGLXUSDT',
    'HOODXUSDT', 'MCDXUSDT', 'METAXUSDT', 'NVDAXUSDT', 'SPCXXUSDT', 'TSLAXUSDT'
  ]);
  let _xstockSet = KNOWN_XSTOCK_SYMBOLS;
  let _xstockSetTs = 0;
  // Full Bybit spot symbol set, harvested from the SAME instruments-info
  // response refreshXStockSet() already fetches — zero extra requests.
  // Used to validate narrative-sourced candidates before they're injected
  // into the scan universe.
  let _spotSymbolSet = new Set();
  const XSTOCK_SET_TTL = 24 * 60 * 60 * 1000; // 24 hours — new listings are rare

  /**
   * Refreshes the live xStock symbol set from Bybit's instruments-info
   * (symbolType === 'xstocks'). Call once near the start of a scan; safe to
   * call repeatedly since it no-ops within XSTOCK_SET_TTL. Falls back to
   * (and never shrinks below) KNOWN_XSTOCK_SYMBOLS on fetch failure.
   */
  async function refreshXStockSet() {
    const now = Date.now();
    if (now - _xstockSetTs < XSTOCK_SET_TTL) return _xstockSet;
    const instruments = await bybitInstruments('spot');
    if (instruments && instruments.length) {
      _spotSymbolSet = new Set(instruments.map(i => i.symbol));
      const live = new Set(
        instruments.filter(i => i.symbolType === 'xstocks').map(i => i.symbol)
      );
      if (live.size > 0) {
        _xstockSet = live;
        _xstockSetTs = now;
      }
    }
    return _xstockSet;
  }

  /**
   * Every symbol Bybit lists on spot. Empty until refreshXStockSet() has
   * run at least once — callers must treat an empty set as "unknown, do
   * not filter" rather than "nothing is tradeable".
   */
  function spotSymbolSet() {
    return _spotSymbolSet;
  }

  function isXStock(symbol) {
    return _xstockSet.has(symbol);
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

  // h4 is display-only (card's Active TF row, last-candle trend + %change)
  // — never fed to Scoring.evaluate(), so a small limit is enough; no
  // indicator math needs the full history. Replaces the old modal-only
  // lazy-fetched 7-TF panel: fetched for every scanned coin now instead of
  // just the one whose modal is open, a deliberate cost tradeoff (~1 extra
  // request/coin/scan) in exchange for 4H being visible on every card.
  async function fetchCandleSet(category, symbol) {
    const [h1, m15, m5, h4] = await Promise.all([
      bybitKlines(category, symbol, '1h', 100),
      bybitKlines(category, symbol, '15m', 100),
      bybitKlines(category, symbol, '5m', 100),
      bybitKlines(category, symbol, '4h', 30)
    ]);
    return { h1, m15, m5, h4 };
  }

  // ----------------------------------------------------------- CoinGecko --

  // CoinMarketCap fallback, reached only when CoinGecko itself fails —
  // proxied through a Supabase Edge Function so the real CMC key never
  // reaches client-side code. The function whitelists exactly these two
  // paths itself; nothing else is forwarded even if requested.
  const CMC_PROXY_URL = 'https://fpyfetynfobfrpunnnhv.supabase.co/functions/v1/cmc-proxy';

  async function cmcProxyFetch(path, params) {
    const url = new URL(CMC_PROXY_URL);
    url.searchParams.set('path', path);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    return safeFetch(url.toString());
  }

  // CoinPaprika: genuinely keyless and CORS-open (verified live —
  // access-control-allow-origin: * is present when a request carries an
  // Origin header), no shared quota to protect unlike CMC's metered
  // 15k/month key. Sits BEFORE the CMC proxy in every fallback chain
  // below — free and unlimited beats metered-and-last-resort.
  const COINPAPRIKA_BASE = 'https://api.coinpaprika.com/v1';

  // Shared CoinPaprika bulk payload. ONE /tickers call (~818KB) serves
  // three consumers — the symbol->mcap map, the Dashboard's Top-5 tile,
  // and the fast sector builder — so none of them pays for its own
  // request. Sorted market-cap descending on arrival because CoinPaprika
  // returns *rank* order, which is not strictly market-cap order (182
  // inversions measured live); the "first hit wins" logic below depends
  // on largest-cap-first.
  let paprikaTickersCache = { list: null, ts: 0 };
  const PAPRIKA_TICKERS_TTL = 10 * 60 * 1000; // matches MCAP_CACHE_MS

  async function paprikaTickers() {
    const now = Date.now();
    if (paprikaTickersCache.list && now - paprikaTickersCache.ts < PAPRIKA_TICKERS_TTL) {
      return paprikaTickersCache.list;
    }
    const data = await safeFetch(`${COINPAPRIKA_BASE}/tickers?limit=1000`);
    if (Array.isArray(data) && data.length) {
      const sorted = data.slice().sort((a, b) => {
        const am = (a.quotes && a.quotes.USD && a.quotes.USD.market_cap) || 0;
        const bm = (b.quotes && b.quotes.USD && b.quotes.USD.market_cap) || 0;
        return bm - am;
      });
      paprikaTickersCache = { list: sorted, ts: now };
      return sorted;
    }
    return paprikaTickersCache.list || []; // fail soft: stale beats empty
  }

  // A symbol reaching the scan universe must look like a real ticker.
  // CoinPaprika tag lists contain entries such as "\u5e01\u5b89\u4eba\u751f", which would
  // otherwise become "...USDT", pass isTradeableUsdtPair(), and burn three
  // Bybit kline round-trips per scan before failing soft.
  const PLAUSIBLE_SYMBOL = /^[A-Z0-9]{2,15}$/;

  /**
   * Reshapes one CoinPaprika ticker into CoinGecko's field names — the
   * same principle coingeckoGlobal()'s fallback already uses, so every
   * caller works unchanged regardless of which provider answered.
   *
   * 30d/1y map to null, NOT to CoinPaprika's raw value: the free tier
   * returns a literal 0 for every coin, and Render.pctCellHtml only
   * renders "--" for null — passing 0 through would make every sector
   * silently claim it was flat over those windows.
   *
   * Returns null for entries that fail the symbol guard or carry no
   * market cap, so callers can filter them out in one step.
   */
  function normalizePaprikaCoin(t) {
    const q = t && t.quotes && t.quotes.USD;
    if (!q || q.market_cap == null) return null;
    const sym = (t.symbol || '').toUpperCase();
    if (!PLAUSIBLE_SYMBOL.test(sym)) return null;
    return {
      id: t.id,
      symbol: (t.symbol || '').toLowerCase(), // CoinGecko convention; callers uppercase
      name: t.name,
      market_cap: q.market_cap,
      current_price: q.price,
      total_volume: q.volume_24h,
      price_change_percentage_24h: q.percent_change_24h,
      price_change_percentage_24h_in_currency: q.percent_change_24h,
      price_change_percentage_7d_in_currency: q.percent_change_7d,
      price_change_percentage_30d_in_currency: null,
      price_change_percentage_1y_in_currency: null
    };
  }

  let cgCache = { global: null, ts: 0 };
  // Global mcap/dominance doesn't meaningfully move minute-to-minute —
  // matches the 30-min cadence applied to the rest of the top strip.
  const CG_CACHE_MS = 30 * 60 * 1000;

  async function coingeckoGlobal() {
    const now = Date.now();
    if (cgCache.global && now - cgCache.ts < CG_CACHE_MS) return cgCache.global;

    // Tier 1 — CoinPaprika. Promoted ahead of CoinGecko because it does
    // not rate-limit; the reshape into CoinGecko's field names means
    // every caller (topStripData etc.) is unaffected by which provider
    // actually answered.
    const cpData = await safeFetch(`${COINPAPRIKA_BASE}/global`);
    if (cpData && cpData.market_cap_usd != null) {
      cgCache.global = {
        market_cap_percentage: { btc: cpData.bitcoin_dominance_percentage },
        total_market_cap: { usd: cpData.market_cap_usd },
        market_cap_change_percentage_24h_usd: cpData.market_cap_change_24h
      };
      cgCache.ts = now;
      return cgCache.global;
    }

    // Tier 2 — CoinGecko.
    console.warn('[Api] global: CoinPaprika failed, falling back to CoinGecko');
    const data = await safeFetch(`${COINGECKO_BASE}/global`);
    if (data && data.data) {
      cgCache.global = data.data;
      cgCache.ts = now;
      return cgCache.global;
    }

    // Tier 3 — CMC via the proxy, metered, genuine last resort.
    console.warn('[Api] global: CoinGecko also failed, falling back to CMC proxy');
    const cmcData = await cmcProxyFetch('/v1/global-metrics/quotes/latest');
    if (cmcData && cmcData.data && cmcData.data.quote && cmcData.data.quote.USD) {
      const usd = cmcData.data.quote.USD;
      cgCache.global = {
        market_cap_percentage: { btc: cmcData.data.btc_dominance },
        total_market_cap: { usd: usd.total_market_cap },
        market_cap_change_percentage_24h_usd: usd.total_market_cap_yesterday_percentage_change
      };
      cgCache.ts = now;
    }
    return cgCache.global;
  }

  /**
   * Best-effort symbol -> market cap map. Tier order is CoinPaprika ->
   * CoinGecko -> CMC proxy: CoinPaprika answers in ONE request where
   * CoinGecko needs four paginated ones with delays, and it does not
   * rate-limit (a 12-request burst returned all 200s in testing).
   *
   * KNOWN GAP: CoinPaprika has no tokenized-stock (xStock) coverage, so
   * with the "Include tokenized stocks" setting on, those cards show "—"
   * for MCap unless CoinPaprika is down and the CoinGecko tier runs.
   * That setting is off by default, and "—" for an unmatched coin is
   * already this function's documented behaviour rather than a new
   * failure mode.
   *
   * Matching by ticker symbol means a rare collision is possible when two
   * projects share a ticker; the larger-cap one wins because every source
   * is market-cap-sorted before insertion. Coins outside the top 1000
   * simply won't match, and callers should show "—" rather than guess.
   */
  let mcapCache = { map: null, ts: 0 };
  const MCAP_CACHE_MS = 10 * 60 * 1000; // 10 minutes

  async function marketCapMap() {
    const now = Date.now();
    if (mcapCache.map && now - mcapCache.ts < MCAP_CACHE_MS) return mcapCache.map;

    const map = {};
    const put = (sym, mcap) => {
      if (mcap != null && sym && !(sym in map)) map[sym] = mcap;
    };

    // Tier 1 — CoinPaprika: one request, already market-cap sorted.
    (await paprikaTickers()).forEach(c => {
      put((c.symbol || '').toUpperCase(), c.quotes && c.quotes.USD ? c.quotes.USD.market_cap : null);
    });

    // Tier 2 — CoinGecko: four paginated requests, only when Tier 1 gave
    // us nothing at all (down / blocked), not merely to fill gaps.
    if (Object.keys(map).length === 0) {
      console.warn('[Api] marketCapMap: CoinPaprika empty, falling back to CoinGecko');
      for (let page = 1; page <= 4; page++) {
        const data = await safeFetch(`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`);
        if (data && Array.isArray(data)) {
          data.forEach(c => put((c.symbol || '').toUpperCase(), c.market_cap));
        }
        if (page < 4) await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Tier 3 — CMC via the proxy, metered, genuine last resort.
    if (Object.keys(map).length === 0) {
      console.warn('[Api] marketCapMap: CoinGecko also failed, falling back to CMC proxy');
      const cmcData = await cmcProxyFetch('/v1/cryptocurrency/listings/latest', { limit: 1000 });
      if (cmcData && Array.isArray(cmcData.data)) {
        cmcData.data.forEach(c => {
          put((c.symbol || '').toUpperCase(), c.quote && c.quote.USD ? c.quote.USD.market_cap : null);
        });
      }
    }

    if (Object.keys(map).length > 0) mcapCache = { map, ts: now };
    return mcapCache.map || map;
  }

  // Top-N coins by market cap with price + 24h% — a single lightweight
  // /coins/markets call (per_page=N), separate from coingeckoMarketCaps()'s
  // 4-page/1000-coin symbol->mcap lookup above, which doesn't carry price or
  // 24h change. Used by the Dashboard's "Top 5 by Market Cap" tile.
  let top5Cache = { list: null, ts: 0 };
  const TOP5_CACHE_MS = 10 * 60 * 1000; // 10 minutes

  async function topByMarketCap(n) {
    const now = Date.now();
    if (top5Cache.list && now - top5Cache.ts < TOP5_CACHE_MS) return top5Cache.list;

    // Derived from the shared CoinPaprika payload — zero extra requests,
    // since paprikaTickers() is already sorted market-cap descending.
    const cp = await paprikaTickers();
    if (cp.length) {
      const list = cp.slice(0, n).map(t => {
        const q = t.quotes.USD;
        return {
          symbol: (t.symbol || '').toUpperCase(),
          name: t.name,
          price: q.price,
          change24h: q.percent_change_24h
        };
      });
      top5Cache = { list, ts: now };
      return list;
    }

    const data = await safeFetch(`${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h`);
    if (Array.isArray(data)) {
      const list = data.map(c => ({
        symbol: (c.symbol || '').toUpperCase(),
        name: c.name,
        price: c.current_price,
        change24h: c.price_change_percentage_24h_in_currency != null
          ? c.price_change_percentage_24h_in_currency
          : c.price_change_percentage_24h
      }));
      top5Cache = { list, ts: now };
      return list;
    }
    return top5Cache.list || [];
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
   *
   * `symbol` may still be a raw Bybit symbol (e.g. "AAPLxUSDT") rather than
   * an already-stripped plain ticker — strip the tokenized-stock `x` marker
   * (case-sensitive, before uppercasing, same convention as isXStock()) in
   * addition to the USDT/USD/PERP suffixes, or stock tickers never match.
   *
   * CryptoFlash's `tickers` field occasionally comma-joins two tickers into
   * one array element (e.g. "ADA,XRP") — split on commas so both still match.
   */
  function newsForSymbol(articles, symbol) {
    const clean = (symbol || '')
      .replace(/USDT$|USD$|PERP$|-PERP$/i, '')
      .replace(/x$/i, '')
      .replace(/^[$#]/, '')
      .toUpperCase();

    return (articles || [])
      .filter(a => Array.isArray(a.tickers) &&
                   a.tickers.some(t => String(t || '').split(',')
                     .some(part => part.trim().toUpperCase() === clean)))
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
   * Phase 8 News tab: every article, newest-first, same normalized shape
   * as newsForSymbol() (reuses its exact sentiment-mapping logic) but
   * without the per-symbol ticker filter. Pure — no async, no side
   * effects, same as newsForSymbol().
   */
  function allNews(articles, limit = 100) {
    return (articles || [])
      .slice()
      .sort((a, b) => new Date(b.published) - new Date(a.published))
      .slice(0, limit)
      .map(a => {
        const s = (a.sentiment || '').toLowerCase();
        return {
          headline: a.title,
          source:   a.source,
          time:     a.published,
          sentiment: s === 'bullish' ? 'bull' : s === 'bearish' ? 'bear' : 'neutral',
          url:      a.url,
          tickers:  a.tickers || []
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
  /**
   * Market-cap-weighted average % change for one window across a
   * category's coins — same weighting method for every window so
   * 24h/7d/30d stay comparable. Hoisted out of sectorPerformance7d()'s
   * closure so the CoinPaprika builder below shares the exact same math.
   *
   * Returns 0 (not null) when nothing weighs in, matching its original
   * behaviour — callers that need "no data" semantics must pass null
   * explicitly rather than relying on this.
   */
  function weightedChangeFor(coins, field) {
    let totalMcap = 0, weightedSum = 0;
    for (const coin of coins) {
      const chg = coin[field];
      if (chg == null || coin.market_cap == null) continue;
      totalMcap += coin.market_cap;
      weightedSum += coin.market_cap * chg;
    }
    return totalMcap > 0 ? weightedSum / totalMcap : 0;
  }

  // ---------------------------------------- Fast sectors (CoinPaprika) ---

  // Whole sector->coin membership map in ONE request (~550KB). 24h TTL
  // mirrors CG_CATEGORY_LIST_TTL — taxonomy changes are rare.
  let _paprikaTagCache = { data: null, ts: 0 };
  const PAPRIKA_TAG_TTL = 24 * 60 * 60 * 1000;

  async function paprikaTagMap() {
    const now = Date.now();
    if (_paprikaTagCache.data && now - _paprikaTagCache.ts < PAPRIKA_TAG_TTL) {
      return _paprikaTagCache.data;
    }
    const data = await safeFetch(`${COINPAPRIKA_BASE}/tags?additional_fields=coins`);
    if (Array.isArray(data) && data.length) {
      _paprikaTagCache = { data, ts: now };
      return data;
    }
    return _paprikaTagCache.data || [];
  }

  /**
   * Keywords deliberately skipped on the CoinPaprika path because its
   * taxonomy has no clean equivalent, so including them would distort
   * the top-4 sector rotation that feeds the scan universe.
   *
   * 'Privacy': CoinPaprika's only substantive match is 'privacy-security',
   * which conflates privacy with security — its largest holdings are
   * ZEC, XMR, LTC, WLD, FIL, DASH, VET, so LTC/WLD/FIL/VET (not privacy
   * coins) drag a whole sector into the rotation on their own momentum.
   * The strict 'privacy' tag is the opposite failure: only 3 coins, as
   * thin and noisy as the 1-coin result CoinGecko was returning.
   * Privacy still works normally on the CoinGecko/Flows path.
   */
  const FAST_SECTOR_EXCLUDED = new Set(['Privacy']);

  /**
   * Maps each NARRATIVE_KEYWORDS entry onto a CoinPaprika tag.
   *
   * Five keywords match more than one tag, so the tiebreak matters:
   * picking by array order (what the CoinGecko path's .find() does)
   * would select the 21-coin "Computing & Cloud Infrastructure" over the
   * 71-coin "Infrastructure". Ranking by coins.length descending picks
   * the substantive tag every time. Array order is not a contract.
   *
   * Unmatched keywords warn and are skipped — the same degradation
   * contract as the CoinGecko path. 'Modular Blockchain' and
   * 'Data Availability' have no CoinPaprika tag and will always land here.
   */
  function resolveNarrativeTags(tags) {
    const resolved = [];
    for (const kw of NARRATIVE_KEYWORDS) {
      if (FAST_SECTOR_EXCLUDED.has(kw)) continue;
      const kwLower = kw.toLowerCase();
      const matches = (tags || []).filter(t => (t.name || '').toLowerCase().includes(kwLower));
      if (!matches.length) {
        console.warn(`[Api] narrative: no CoinPaprika tag match for keyword "${kw}"`);
        continue;
      }
      const best = matches.reduce((a, b) =>
        ((b.coins || []).length > (a.coins || []).length ? b : a));
      resolved.push({ keyword: kw, tag: best });
    }
    console.log('[Api] narrative tags resolved:',
      resolved.map(r => `${r.keyword}->${r.tag.id}`).join(', '));
    return resolved;
  }

  /**
   * Sector performance built from two CoinPaprika requests instead of
   * CoinGecko's 17 (one per category, 2s apart, under a 20s deadline and
   * a circuit breaker that routinely truncates the run).
   *
   * Emits the exact same shape sectorPerformance7d() does, so
   * topNarrativeCandidates() and the render layer are unchanged.
   *
   * 30d/1y are hard-set to null rather than computed: CoinPaprika's free
   * tier returns a literal 0 for those windows on every coin, and
   * weightedChangeFor() would turn that into a confident-looking 0.0%.
   */
  let _fastSectorCache = { data: null, ts: 0 };

  async function fastSectorPerformance() {
    const now = Date.now();
    if (_fastSectorCache.data && now - _fastSectorCache.ts < SECTOR_PERF_TTL) {
      return _fastSectorCache.data;
    }

    const [tags, tickers] = await Promise.all([paprikaTagMap(), paprikaTickers()]);
    if (!tags.length || !tickers.length) return _fastSectorCache.data || [];

    const byId = new Map();
    for (const t of tickers) {
      const n = normalizePaprikaCoin(t);
      if (n) byId.set(t.id, n);
    }

    const results = [];
    for (const { keyword, tag } of resolveNarrativeTags(tags)) {
      const coins = (tag.coins || [])
        .map(id => byId.get(id))
        .filter(Boolean)
        .sort((a, b) => b.market_cap - a.market_cap)
        // Reproduces CoinGecko's per_page=50. Without it the >=350M
        // top-8 in topNarrativeCandidates() would draw from a much wider
        // pool and silently change which coins enter the scan universe.
        .slice(0, 50);
      if (!coins.length) continue;
      results.push({
        categoryId: tag.id,
        name: keyword,
        mcap: coins.reduce((s, c) => s + (c.market_cap || 0), 0),
        weightedChange24h: weightedChangeFor(coins, 'price_change_percentage_24h_in_currency'),
        weightedChange7d: weightedChangeFor(coins, 'price_change_percentage_7d_in_currency'),
        weightedChange30d: null,
        weightedChange1y: null,
        coins
      });
    }

    // Only cache a genuine result, same guard sectorPerformance7d() uses.
    if (results.length) _fastSectorCache = { data: results, ts: now };
    return results;
  }

  async function cgCategoryList() {
    const now = Date.now();
    if (_cgCategoryListCache.data && now - _cgCategoryListCache.ts < CG_CATEGORY_LIST_TTL) {
      return _cgCategoryListCache.data;
    }
    // This single request gates every downstream category lookup in
    // sectorPerformance7d() — a transient failure here silently zeroes out
    // every narrative keyword match at once (confirmed live: CoinGecko's
    // free tier drops this intermittently). One retry is enough to recover
    // a genuine transient blip without adding much worst-case latency —
    // see the circuit breaker below for why this stays cheap even when
    // CoinGecko is having a sustained bad stretch, not just a blip.
    let data = null;
    for (let attempt = 0; attempt <= 1 && !data; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
      const result = await safeFetch(`${COINGECKO_BASE}/coins/categories/list`);
      if (result && Array.isArray(result) && result.length > 0) data = result;
    }
    if (data) {
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
        // CoinGecko's /coins/categories/list returns `category_id`, not
        // `id` — using the wrong field silently resolved every match to
        // `id: undefined`, so every category request 404'd (`category=
        // undefined`) with no warning, since the name match itself succeeded.
        resolvedCategories.push({ id: match.category_id, name: kw });
      } else {
        console.warn(`[Api] narrative: no CoinGecko category match for keyword "${kw}"`);
      }
    }

    // A failed category fetch used to be dropped permanently for the whole
    // 4h cache window with no retry — but live testing showed CoinGecko's
    // free-tier rate limit gets tripped intermittently (curl succeeded
    // seconds later on the exact same request that had just failed
    // in-browser). A single retry recovers that case cheaply.
    //
    // What a naive "always retry" loop gets wrong: when CoinGecko is having
    // a genuinely SUSTAINED bad stretch (not a blip), retrying every one of
    // 16 categories individually stops being a recovery mechanism and
    // becomes the problem — confirmed live, a full scan sat unresponsive
    // for 60+ seconds with zero cards rendered, entirely inside this loop.
    // Two guards fix that without giving up the retry's real benefit:
    //  - a circuit breaker: after 3 categories fail outright in a row,
    //    stop retrying for the rest of this pass (single-shot only) —
    //    that many consecutive failures is itself strong evidence this is
    //    a sustained outage, not isolated blips worth waiting out;
    //  - a hard overall deadline on the whole loop, so a bad CoinGecko day
    //    degrades to "fewer sectors this scan" instead of "scan doesn't
    //    finish." Sector/narrative data is a top-strip nice-to-have, not
    //    the core scan result — it should never be able to block that.
    const LOOP_DEADLINE_MS = 20000;
    const loopStart = Date.now();
    let consecutiveFailures = 0;
    let circuitOpen = false;

    // 24h/30d added alongside the original 7d for the Market Flows tab —
    // CoinGecko accepts multiple comma-separated windows in one request at
    // no extra cost (verified live), so this stays a single fetch per
    // category rather than needing a second pass or a snapshot job.
    // 1y added alongside 24h/7d/30d as the MTD/YTD stand-in — true
    // calendar-anchored MTD/YTD would need per-coin historical lookups
    // (CoinGecko has no "since a specific date" rolling window), a real
    // new cost/complexity the owner decided wasn't worth it. 30d/1y cover
    // the same "medium/long term" intent without it.
    const CATEGORY_WINDOWS = '24h,7d,30d,1y';
    async function fetchCategoryWithRetry(catId) {
      const data = await safeFetch(
        `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=${catId}&order=market_cap_desc&per_page=50&page=1&price_change_percentage=${CATEGORY_WINDOWS}`
      );
      if (data && Array.isArray(data) && data.length > 0) return data;
      if (circuitOpen) return null; // sustained failure already detected — don't wait out a retry
      await new Promise(r => setTimeout(r, 2500));
      const retryData = await safeFetch(
        `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=${catId}&order=market_cap_desc&per_page=50&page=1&price_change_percentage=${CATEGORY_WINDOWS}`
      );
      return (retryData && Array.isArray(retryData) && retryData.length > 0) ? retryData : null;
    }

    const results = [];
    for (const cat of resolvedCategories) {
      if (Date.now() - loopStart > LOOP_DEADLINE_MS) {
        console.warn(`[Api] sectorPerformance7d hit its time budget — stopping with ${results.length}/${resolvedCategories.length} sectors`);
        break;
      }

      const data = await fetchCategoryWithRetry(cat.id);
      if (data) {
        consecutiveFailures = 0;
        const weightedChange24h = weightedChangeFor(data, 'price_change_percentage_24h_in_currency');
        const weightedChange7d = weightedChangeFor(data, 'price_change_percentage_7d_in_currency');
        const weightedChange30d = weightedChangeFor(data, 'price_change_percentage_30d_in_currency');
        const weightedChange1y = weightedChangeFor(data, 'price_change_percentage_1y_in_currency');
        // Sum of the top-50-by-mktcap coins actually fetched — a proxy for
        // the category's true total market cap (which could include coins
        // beyond the top 50), not a claim of exhaustive coverage.
        const mcap = data.reduce((sum, c) => sum + (c.market_cap || 0), 0);
        results.push({
          categoryId: cat.id, name: cat.name, mcap,
          weightedChange24h, weightedChange7d, weightedChange30d, weightedChange1y,
          coins: data
        });
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 3 && !circuitOpen) {
          circuitOpen = true;
          console.warn('[Api] sectorPerformance7d: 3 consecutive category failures — treating as a sustained outage, skipping retries for the rest of this scan');
        }
      }
      // 2 s delay between calls — stays comfortably under CoinGecko's
      // free-tier rate limit once the circuit breaker is open; a still-
      // healthy run pays this once per category same as before.
      await new Promise(r => setTimeout(r, 2000));
    }

    console.timeEnd('sectorPerformance7d');
    // Only cache a genuine result. Caching an empty array unconditionally
    // meant one transient upstream failure (e.g. cgCategoryList() dropping
    // once) got locked in as "no sectors found" for the full 4h TTL,
    // instead of just retrying fresh on the next scan a minute later.
    if (results.length > 0) {
      _sectorPerfCache = { data: results, ts: now };
    }
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
    openInterestChange15m,
    isTradeableUsdtPair, isXStock, refreshXStockSet, spotSymbolSet,
    coingeckoGlobal, marketCapMap, coingeckoMarketCaps: marketCapMap,
    paprikaTickers, normalizePaprikaCoin,
    topByMarketCap, formatMcap,
    fearGreedIndex, unlockInfo,
    fetchAllNews, newsForSymbol, allNews, coinNews,
    cgCategoryList, sectorPerformance7d, topNarrativeCandidates,
    paprikaTagMap, resolveNarrativeTags, fastSectorPerformance, weightedChangeFor
  };
})();

if (typeof module !== 'undefined') module.exports = Api;
