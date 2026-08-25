#!/usr/bin/env node
/* ==========================================================================
   Wicktor — headless scheduled scan + signal journalling

   WHY THIS EXISTS. The scanner is a static site with no backend, so until
   now the journal only recorded signals while somebody happened to have a
   signed-in tab open. That makes coverage a function of the owner's
   browsing habits rather than of the market, which is exactly the wrong
   sampling for evidence meant to prove or disprove an edge: quiet hours,
   sleep and closed laptops silently delete whole regimes from the record.
   This runs the same scan on a schedule, independent of any browser.

   IT REUSES THE PRODUCTION PATH RATHER THAN RE-IMPLEMENTING IT.
   Scoring.evaluate() is the same function the app calls, and the exit
   arithmetic is imported from js/signals.js — the browser and this runner
   cannot drift apart, because there is only one copy of each. The bar_time
   bucket is computed identically too, so a browser scan and a cron scan in
   the same 5-minute window collapse onto one row via the table's unique
   key instead of double-counting.

   It writes with the service-role key, which bypasses RLS. That is the
   point: this process is trusted infrastructure, not a public client, so
   journalling no longer depends on anyone being signed in. The key must
   only ever arrive via the environment.

   Usage:  SUPABASE_SERVICE_KEY=... node tools/cron-scan.js
   Env:    UNIVERSE_SIZE (default 120), DRY_RUN=1 to score without writing
   ========================================================================== */

global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const Journal = require('../js/signals.js');

const SUPABASE_URL = 'https://fpyfetynfobfrpunnnhv.supabase.co';
const TABLE = 'signal_journal';

// api.bybit.com 403s from US cloud IPs, which is exactly where GitHub's
// hosted runners live — the first scheduled run failed on the very first
// request. api.bytick.com is Bybit's own alternate domain serving the
// identical v5 API for this reason. Probed once per process and cached, so
// a browser-equivalent host is still preferred when it is reachable.
const HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
let BYBIT = null;

async function pickHost() {
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/v5/market/time`);
      if (res.ok) { console.log(`bybit host: ${host}`); return host; }
      console.warn(`  host ${host} -> HTTP ${res.status}`);
    } catch (e) {
      console.warn(`  host ${host} -> ${e.message}`);
    }
  }
  throw new Error('no reachable Bybit host');
}
const BAR_MS = 5 * 60 * 1000;
const BATCH = 5;                       // matches the app's own scan batching
const RESOLVE_LIMIT = 100;             // open signals examined per run
const RESOLVE_BARS = 300;              // 5M bars fetched when resolving (~25h)
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;

const KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE || 120);

if (!KEY && !DRY_RUN) {
  console.error('SUPABASE_SERVICE_KEY is not set. Refusing to run.');
  process.exit(1);
}

// --------------------------------------------------------------- Bybit ---
const INTERVAL = { '5m': '5', '15m': '15', '1h': '60' };

async function bybit(path) {
  const res = await fetch(`${BYBIT}${path}`);
  if (!res.ok) throw new Error(`bybit ${res.status} ${path}`);
  const body = await res.json();
  if (body.retCode !== 0) throw new Error(`bybit retCode ${body.retCode}: ${body.retMsg}`);
  return body.result;
}

async function klines(category, symbol, tf, limit = 100) {
  try {
    const r = await bybit(`/v5/market/kline?category=${category}&symbol=${symbol}&interval=${INTERVAL[tf]}&limit=${limit}`);
    return r.list
      .map(x => ({ t: Number(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }))
      .reverse();
  } catch (e) {
    console.warn(`  klines failed ${symbol} ${tf}: ${e.message}`);
    return null;
  }
}

// Mirrors js/api.js's isTradeableUsdtPair — stablecoin pairs and leveraged
// tokens are not instruments this method is meant to trade.
const EXCLUDE_QUOTE = /^(USDC|FDUSD|DAI|TUSD|EUR|USDE)USDT$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;
const tradeable = s => s.endsWith('USDT') && !EXCLUDE_QUOTE.test(s) && !LEVERAGED.test(s);

async function universe(category, count) {
  const r = await bybit(`/v5/market/tickers?category=${category}`);
  return r.list
    .filter(t => tradeable(t.symbol))
    .map(t => ({ symbol: t.symbol, volume24h: +(t.turnover24h || 0) }))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, count);
}

async function oiChange15m(symbol) {
  try {
    const r = await bybit(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`);
    if (!r.list || r.list.length < 2) return null;
    const [now, prev] = [+r.list[0].openInterest, +r.list[1].openInterest];
    return prev ? ((now - prev) / prev) * 100 : null;
  } catch { return null; }
}

// ------------------------------------------------------------ Supabase ---
// PostgREST directly rather than supabase-js: this repo has no build step
// and no dependencies, and adding one for three HTTP calls would be the
// only thing standing between a clean checkout and a working cron.
async function pg(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`postgrest ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// --------------------------------------------------------------- Scan ----
async function scoreCoin(base, category) {
  const [h1, m15, m5, oi] = await Promise.all([
    klines(category, base.symbol, '1h', 100),
    klines(category, base.symbol, '15m', 100),
    klines(category, base.symbol, '5m', 100),
    category === 'linear' ? oiChange15m(base.symbol) : Promise.resolve(null)
  ]);
  if (!h1 || !m15 || !m5) return null;

  const result = Scoring.evaluate({ h1, m15, m5 }, { oiChange15m: oi });
  if (!result) return null;

  return {
    rawSymbol: base.symbol,
    market: category === 'linear' ? 'PERP' : 'SPOT',
    score: result.score,
    setup: result.setup,
    m5
  };
}

async function scanCategory(category, size, out) {
  const list = await universe(category, size);
  console.log(`${category}: scoring ${list.length} symbols`);
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = await Promise.all(
      list.slice(i, i + BATCH).map(b => scoreCoin(b, category).catch(() => null))
    );
    chunk.forEach(c => { if (c) out.push(c); });
  }
}

// ------------------------------------------------------------- Logging ---
function rowFor(coin, barTime) {
  const s = coin.setup;
  const rr = s && s.riskReward;
  if (!s || !s.direction || !rr || !rr.stop || !rr.target) return null;
  return {
    symbol: coin.rawSymbol,
    market: coin.market,
    direction: s.direction,
    bar_time: barTime,
    score: coin.score,
    band: 'EXCELLENT',
    context_regime: s.regime || null,
    trigger_name: s.trigger ? s.trigger.name : null,
    trigger_bars_ago: s.trigger ? s.trigger.barsAgo : null,
    component_entry: s.components ? s.components.entry : null,
    component_context: s.components ? s.components.context : null,
    component_method: s.components ? s.components.method : null,
    entry: rr.entry,
    stop: rr.stop,
    target: rr.target,
    risk_pct: rr.riskPct != null ? +rr.riskPct.toFixed(4) : null
  };
}

async function logSignals(coins) {
  // Identical bucketing to js/signals.js, so a concurrent browser scan
  // dedupes against these rows rather than racing them.
  const barTime = Math.floor(Date.now() / BAR_MS) * BAR_MS;
  const rows = coins
    .filter(c => c.score >= Journal.MIN_SCORE)
    .map(c => rowFor(c, barTime))
    .filter(Boolean);

  if (!rows.length) { console.log('no EXCELLENT signals this run'); return 0; }
  rows.forEach(r => console.log(`  + ${r.symbol} ${r.market} ${r.direction === 1 ? 'LONG' : 'SHORT'} score=${r.score} trigger=${r.trigger_name}`));
  if (DRY_RUN) { console.log(`DRY_RUN: would insert ${rows.length}`); return 0; }

  await pg(`${TABLE}?on_conflict=symbol,market,direction,bar_time`, {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }
  });
  return rows.length;
}

// ---------------------------------------------------------- Resolution ---
async function resolveOpen(scannedCandles) {
  if (DRY_RUN) { console.log('DRY_RUN: skipping resolution'); return 0; }

  const open = await pg(`${TABLE}?status=eq.open&order=created_at.asc&limit=${RESOLVE_LIMIT}`);
  if (!open || !open.length) { console.log('no open signals to resolve'); return 0; }
  console.log(`resolving: ${open.length} open signals`);

  // A signal whose coin has since dropped out of the top-N would otherwise
  // stay open forever, quietly biasing the record toward coins that stayed
  // liquid. Fetch what this scan didn't cover, once per symbol.
  const cache = { ...scannedCandles };
  const missing = [...new Set(
    open.filter(s => !cache[`${s.symbol}:${s.market}`])
        .map(s => `${s.symbol}:${s.market}`)
  )];
  for (const key of missing) {
    const [symbol, market] = key.split(':');
    cache[key] = await klines(market === 'PERP' ? 'linear' : 'spot', symbol, '5m', RESOLVE_BARS);
  }

  let resolved = 0, expired = 0;
  for (const sig of open) {
    const candles = cache[`${sig.symbol}:${sig.market}`];
    const age = Date.now() - new Date(sig.created_at).getTime();

    if (!candles || !candles.length) {
      // Unresolvable and old enough that it never will be — most likely a
      // delisted or halted symbol. Marked expired rather than deleted: the
      // fact that it could not be resolved is itself part of the record.
      if (age > EXPIRE_AFTER_MS) {
        await pg(`${TABLE}?id=eq.${sig.id}&status=eq.open`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'expired', resolved_at: new Date().toISOString() }),
          headers: { Prefer: 'return=minimal' }
        });
        expired++;
      }
      continue;
    }

    const after = candles.filter(c => c.t > sig.bar_time);
    if (!after.length) continue;

    const risk = Math.abs(sig.entry - sig.stop);
    if (!risk) continue;

    const window = after.slice(0, Journal.HOLD_BARS);
    const complete = after.length >= Journal.HOLD_BARS;
    const a = Journal.realisedR(window, sig.direction, +sig.entry, risk, Journal.PLAN_A);
    const b = Journal.realisedR(window, sig.direction, +sig.entry, risk, Journal.PLAN_B);

    // Half-walked paths are left open: banking a mark-to-market number as
    // though it were a finished result is how a journal starts flattering
    // itself.
    if (!complete && a.reason === 'timeout') continue;

    await pg(`${TABLE}?id=eq.${sig.id}&status=eq.open`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_bar_time: window[window.length - 1].t,
        outcome_a: +a.r.toFixed(4),
        outcome_b: +b.r.toFixed(4),
        exit_reason: a.reason
      }),
      headers: { Prefer: 'return=minimal' }
    });
    console.log(`  = ${sig.symbol} ${sig.market} ${a.reason} A=${a.r.toFixed(3)}R B=${b.r.toFixed(3)}R`);
    resolved++;
  }
  return resolved + expired;
}

// ---------------------------------------------------------------- Main ---
(async () => {
  const started = Date.now();
  const coins = [];

  BYBIT = await pickHost();
  await scanCategory('spot', UNIVERSE_SIZE, coins);
  await scanCategory('linear', UNIVERSE_SIZE, coins);
  console.log(`scored ${coins.length} coins in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const candlesBySymbol = {};
  coins.forEach(c => { candlesBySymbol[`${c.rawSymbol}:${c.market}`] = c.m5; });

  const logged = await logSignals(coins);
  const touched = await resolveOpen(candlesBySymbol);

  console.log(`done: ${logged} logged, ${touched} resolved/expired, ${((Date.now() - started) / 1000).toFixed(1)}s total`);
})().catch(err => {
  // Fail loudly. A silently-failing journal is worse than no journal: it
  // looks like a market with no signals in it.
  console.error('cron-scan failed:', err.message);
  process.exit(1);
});
