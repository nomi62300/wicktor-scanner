// ==========================================================================
// Wicktor — headless scheduled scan + signal journalling (Edge Function)
//
// WHY THIS EXISTS. The scanner is a static site with no backend, so the
// journal only ever recorded signals while somebody had a signed-in tab
// open. Verified live (2026-08-29): an 11-hour gap with nobody browsing
// meant zero new signals AND zero resolutions in that window, regardless
// of what the market did. That's the wrong sampling for evidence meant to
// prove or disprove an edge. This runs the same scan on a schedule,
// independent of any browser, invoked by pg_cron (see the accompanying
// migration) rather than GitHub Actions.
//
// WHY AN EDGE FUNCTION AND NOT GITHUB ACTIONS. Measured directly: Bybit
// 403s GitHub's hosted-runner IPs on both api.bybit.com and api.bytick.com
// — a network block, not a bad request. Supabase's own Edge Runtime (this
// project is ap-northeast-1, Tokyo) was measured to reach Bybit fine
// (2026-08-29 probe: HTTP 200 from api.bybit.com/v5/market/time).
//
// THAT REGION IS NOT AUTOMATIC. Edge Functions route to whichever region
// is nearest the CALLER by default, not to the project's home region —
// measured directly: forcing an invocation to us-east-1 hit the same
// "no reachable Bybit host" failure GitHub's own runners get. Every
// caller of this function MUST send `x-region: ap-northeast-1`, or a
// US-based caller (GitHub Actions included) silently lands on a blocked
// region and this whole fix is undone.
//
// IT REUSES THE PRODUCTION SCORING PATH RATHER THAN RE-IMPLEMENTING IT.
// js/indicators.js, js/scoring.js and js/signals.js are imported directly
// (unmodified logic — only a `globalThis` bridge was added to each, since
// Deno gives every ES module its own scope and these files were written
// as classic-script IIFEs that lean on browser/Node's shared global
// lookup). Browser, Node tooling, and this function cannot drift apart,
// because there is only one copy of each.
//
// AUTH: verify_jwt is left at its default (true) at the platform level,
// but that only proves the caller holds SOME valid Supabase JWT — the
// public anon/publishable key satisfies that too. Real protection is the
// explicit service-role comparison below: only a caller presenting the
// actual service-role key (pg_cron, configured to send it; or the owner,
// manually) can trigger a scan. Everyone else gets 401 before any Bybit
// call or database write happens.
// ==========================================================================

// @ts-ignore - side-effect imports; each stamps a bare global via the
// globalThis bridge added to the end of the real file.
import '../../../js/indicators.js';
// @ts-ignore
import '../../../js/scoring.js';
// @ts-ignore
import '../../../js/signals.js';
// @ts-ignore
import '../../../js/coinview.js';

declare const Scoring: any;
declare const SignalJournal: any;
declare const CoinView: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://fpyfetynfobfrpunnnhv.supabase.co';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TABLE = 'signal_journal';
const SNAP_TABLE = 'scan_snapshot';
// The client only ever reads the newest two. A few spares absorb a slow
// reader mid-prune and make a bad run diagnosable after the fact.
const SNAP_KEEP = 6;

const HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
const BAR_MS = 5 * 60 * 1000;
const BATCH = 5;
const RESOLVE_LIMIT = 100;
const RESOLVE_BARS = 300;
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;
const INTERVAL: Record<string, string> = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Observed transient (2026-08-29): a cold-start probe failed once, then 3/3
// immediate retries succeeded — not the GitHub-runner-style hard IP block,
// just an occasional blip. Two passes over both hosts, not one, so a single
// bad moment doesn't fail an entire scheduled run.
async function pickHost(): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const host of HOSTS) {
      try {
        const res = await fetch(`${host}/v5/market/time`);
        if (res.ok) return host;
      } catch { /* try next host */ }
    }
    if (attempt === 0) await sleep(1000);
  }
  throw new Error('no reachable Bybit host');
}

async function bybit(host: string, path: string) {
  const res = await fetch(`${host}${path}`);
  if (!res.ok) throw new Error(`bybit ${res.status} ${path}`);
  const body = await res.json();
  if (body.retCode !== 0) throw new Error(`bybit retCode ${body.retCode}: ${body.retMsg}`);
  return body.result;
}

async function klines(host: string, category: string, symbol: string, tf: string, limit = 100) {
  try {
    const r = await bybit(host, `/v5/market/kline?category=${category}&symbol=${symbol}&interval=${INTERVAL[tf]}&limit=${limit}`);
    return r.list
      .map((x: string[]) => ({ t: Number(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }))
      .reverse();
  } catch {
    return null;
  }
}

// Mirrors js/api.js's isTradeableUsdtPair.
const EXCLUDE_QUOTE = /^(USDC|FDUSD|DAI|TUSD|EUR|USDE)USDT$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;
const tradeable = (s: string) => s.endsWith('USDT') && !EXCLUDE_QUOTE.test(s) && !LEVERAGED.test(s);

async function universe(host: string, category: string, count: number) {
  const r = await bybit(host, `/v5/market/tickers?category=${category}`);
  return r.list
    .filter((t: any) => tradeable(t.symbol))
    .map((t: any) => ({ symbol: t.symbol, volume24h: +(t.turnover24h || 0), price: +(t.lastPrice || 0) }))
    .sort((a: any, b: any) => b.volume24h - a.volume24h)
    .slice(0, count);
}

async function oiChange15m(host: string, symbol: string) {
  try {
    const r = await bybit(host, `/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`);
    if (!r.list || r.list.length < 2) return null;
    const now = +r.list[0].openInterest, prev = +r.list[1].openInterest;
    return prev ? ((now - prev) / prev) * 100 : null;
  } catch { return null; }
}

async function pg(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`postgrest ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// One CoinPaprika request gives market caps for the whole universe. Mirrors
// js/api.js marketCapMap()'s tier-1 path and its keying (uppercase symbol,
// first entry wins) so the MCap line and the micro/small/mid/large filters
// keep reading the same numbers they always have. No CoinGecko fallback
// here: a missing mcap degrades to an em-dash on the card, which is not
// worth four extra paginated requests inside a scheduled function.
async function mcapMap(): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD');
    if (!res.ok) return map;
    for (const c of await res.json()) {
      const sym = String(c.symbol || '').toUpperCase();
      const mc = c.quotes && c.quotes.USD ? c.quotes.USD.market_cap : null;
      if (sym && mc != null && !(sym in map)) map[sym] = mc;
    }
  } catch { /* card shows an em-dash; not worth failing a scan over */ }
  return map;
}

// Bybit runs two separate, differently-classified stock-perpetual products
// (full story in js/api.js's refreshXStockSet, which mirrors this):
//  - category=spot,   symbolType === 'xstocks' (AAPLXUSDT, ~11 symbols)
//  - category=linear, symbolType === 'stock' or 'ETF' (AAPLUSDT, TQQQUSDT,
//    ~220+ symbols, no "X" in the ticker) — leveraged perpetuals on real US
//    equities/ETFs. This function had NO stock detection at all before
//    2026-09-04, so every one of the linear symbols was scored and labeled
//    sector "Crypto" exactly like ordinary crypto, with no way to tell them
//    apart on a card. Naming isn't reliable for either list (some linear
//    symbols end in literal "STOCK", most don't) — symbolType from the live
//    API is the only authoritative source, fetched once per run.
async function stockSymbolSet(host: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const [spot, linear] = await Promise.all([
      bybit(host, `/v5/market/instruments-info?category=spot&limit=1000`),
      bybit(host, `/v5/market/instruments-info?category=linear&limit=1000`)
    ]);
    for (const i of spot.list || []) if (i.symbolType === 'xstocks') set.add(i.symbol);
    for (const i of linear.list || []) if (i.symbolType === 'stock' || i.symbolType === 'ETF') set.add(i.symbol);
  } catch { /* worst case sector reads "Crypto" for stocks this run, same as before this fix */ }
  return set;
}

async function scoreCoin(
  host: string,
  base: { symbol: string; price: number },
  category: string,
  mcaps: Record<string, number>,
  stocks: Set<string>
) {
  const [h4, h1, m15, m5, oi] = await Promise.all([
    klines(host, category, base.symbol, '4h', 100),
    klines(host, category, base.symbol, '1h', 100),
    klines(host, category, base.symbol, '15m', 100),
    klines(host, category, base.symbol, '5m', 100),
    category === 'linear' ? oiChange15m(host, base.symbol) : Promise.resolve(null)
  ]);
  // 4H is display-only (the Active TF chip row), so a missing 4H must not
  // drop a coin the way a missing scoring timeframe does.
  if (!h1 || !m15 || !m5) return null;

  const result = Scoring.evaluate({ h1, m15, m5 }, { oiChange15m: oi });
  if (!result) return null;

  const market = category === 'linear' ? 'PERP' : 'SPOT';
  const cleanSym = base.symbol.replace(/USDT$/, '').replace(/x$/i, '').toUpperCase();
  const view = CoinView.build(result, base, { h4, h1, m15, m5 }, {
    market,
    mcapRaw: mcaps[cleanSym] ?? null,
    sector: stocks.has(base.symbol) ? 'Tokenized Stock' : null
  });
  if (!view) return null;

  // `setup` is small and the journal needs it. `m5` is NOT returned: at a
  // 500-coin universe, retaining 100 candles per coin was the difference
  // between running and WORKER_RESOURCE_LIMIT (measured — 400 died at ~19s
  // with an empty body). resolveOpen() already fetches 5M candles for any
  // open signal it wasn't handed, and open signals are a handful, not the
  // whole universe, so nothing is lost but the memory.
  return { ...view, setup: result.setup };
}

async function scanCategory(
  host: string, category: string, size: number, out: any[], mcaps: Record<string, number>, stocks: Set<string>
) {
  const list = await universe(host, category, size);
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = await Promise.all(
      list.slice(i, i + BATCH).map((b: any) => scoreCoin(host, b, category, mcaps, stocks).catch(() => null))
    );
    chunk.forEach(c => { if (c) out.push(c); });
  }
}

// Stores the whole scored universe for browsers to read, then prunes.
// `setup` and `m5` are dropped: m5 is 100 candles per coin (the single
// largest thing in memory here) and setup duplicates fields the view
// already carries. Only what render.js and app.js actually read is stored.
async function writeSnapshot(coins: any[], log: string[]) {
  const scores: Record<string, number> = {};
  const views = coins.map(({ setup, ...view }) => {
    scores[`${view.rawSymbol}:${view.market}`] = view.score;
    return view;
  });

  await pg(SNAP_TABLE, {
    method: 'POST',
    body: JSON.stringify({ coin_count: views.length, scores, coins: views }),
    headers: { Prefer: 'return=minimal' }
  });

  // Prune anything past the newest SNAP_KEEP. Done after the insert so a
  // failed write never leaves the table emptier than it started.
  try {
    const keep = await pg(`${SNAP_TABLE}?select=id&order=captured_at.desc&limit=${SNAP_KEEP}`);
    if (Array.isArray(keep) && keep.length === SNAP_KEEP) {
      const oldest = keep[keep.length - 1].id;
      await pg(`${SNAP_TABLE}?id=lt.${oldest}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
    }
  } catch (e) {
    log.push(`snapshot prune failed (non-fatal): ${String(e).slice(0, 120)}`);
  }

  log.push(`snapshot stored: ${views.length} coins`);
  return views.length;
}

function rowFor(coin: any, barTime: number) {
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
    risk_pct: rr.riskPct != null ? +rr.riskPct.toFixed(4) : null,
    // @ts-ignore - Indicators is the bridged global
    model_version: (typeof Indicators !== 'undefined' && Indicators.MODEL_VERSION) || 'unknown-client'
  };
}

async function logSignals(coins: any[], log: string[]) {
  const barTime = Math.floor(Date.now() / BAR_MS) * BAR_MS;

  // Skip a symbol that already has an open row for the same
  // market+direction — one position per symbol until it resolves or
  // times out. See the matching note in js/signals.js's logFromScan().
  const open = await pg(`${TABLE}?select=symbol,market,direction&status=eq.open&limit=500`);
  const alreadyOpen = new Set((open || []).map((r: any) => `${r.symbol}:${r.market}:${r.direction}`));

  const rows = coins
    .filter(c => c.score >= SignalJournal.MIN_SCORE)
    .filter(c => !c.setup || !c.setup.direction ||
      !alreadyOpen.has(`${c.rawSymbol}:${c.market}:${c.setup.direction}`))
    .map(c => rowFor(c, barTime))
    .filter(Boolean);

  if (!rows.length) { log.push('no EXCELLENT signals this run'); return 0; }
  rows.forEach(r => log.push(`+ ${r!.symbol} ${r!.market} ${r!.direction === 1 ? 'LONG' : 'SHORT'} score=${r!.score}`));

  await pg(`${TABLE}?on_conflict=symbol,market,direction,bar_time`, {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }
  });
  return rows.length;
}

async function resolveOpen(host: string, scannedCandles: Record<string, any>, log: string[]) {
  const open = await pg(`${TABLE}?status=eq.open&order=created_at.asc&limit=${RESOLVE_LIMIT}`);
  if (!open || !open.length) { log.push('no open signals to resolve'); return 0; }

  const cache: Record<string, any> = { ...scannedCandles };
  const missing = [...new Set(
    open.filter((s: any) => !cache[`${s.symbol}:${s.market}`])
        .map((s: any) => `${s.symbol}:${s.market}`)
  )] as string[];
  for (const key of missing) {
    const [symbol, market] = key.split(':');
    cache[key] = await klines(host, market === 'PERP' ? 'linear' : 'spot', symbol, '5m', RESOLVE_BARS);
  }

  let resolved = 0, expired = 0;
  for (const sig of open) {
    const candles = cache[`${sig.symbol}:${sig.market}`];
    const age = Date.now() - new Date(sig.created_at).getTime();

    if (!candles || !candles.length) {
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

    const after = candles.filter((c: any) => c.t > sig.bar_time);
    if (!after.length) continue;

    const risk = Math.abs(sig.entry - sig.stop);
    if (!risk) continue;

    const window = after.slice(0, SignalJournal.HOLD_BARS);
    const complete = after.length >= SignalJournal.HOLD_BARS;
    const targetR = Math.abs(+sig.target - +sig.entry) / risk;
    const a = SignalJournal.realisedR(window, sig.direction, +sig.entry, risk, SignalJournal.PLAN_A, targetR);
    const b = SignalJournal.realisedR(window, sig.direction, +sig.entry, risk, SignalJournal.PLAN_B, targetR);

    if (!complete && a.reason === 'timeout') continue;

    const tp = SignalJournal.tpTouches(window, sig.direction, +sig.entry, risk, targetR);
    const targetDist = Math.abs(+sig.target - +sig.entry);
    const mae = SignalJournal.maeMfe(window, sig.direction, +sig.entry, risk, targetDist);
    const pathData = window.map((bar: any) => [bar.t, bar.o, bar.h, bar.l, bar.c]);

    await pg(`${TABLE}?id=eq.${sig.id}&status=eq.open`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_bar_time: window[window.length - 1].t,
        outcome_a: +a.r.toFixed(4),
        outcome_b: +b.r.toFixed(4),
        exit_reason: a.reason,
        tp1_hit: tp.tp1, tp2_hit: tp.tp2, tp3_hit: tp.tp3,
        mae_r: +mae.maeR.toFixed(4), mfe_r: +mae.mfeR.toFixed(4),
        path: pathData
      }),
      headers: { Prefer: 'return=minimal' }
    });
    log.push(`= ${sig.symbol} ${sig.market} ${a.reason} A=${a.r.toFixed(3)}R B=${b.r.toFixed(3)}R`);
    resolved++;
  }
  return resolved + expired;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') || '';
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const universeSize = Number(url.searchParams.get('universe_size') || 120);

  const started = Date.now();
  const log: string[] = [];
  try {
    const host = await pickHost();
    const [mcaps, stocks] = await Promise.all([mcapMap(), stockSymbolSet(host)]);
    const coins: any[] = [];
    await scanCategory(host, 'spot', universeSize, coins, mcaps, stocks);
    await scanCategory(host, 'linear', universeSize, coins, mcaps, stocks);
    log.push(`scored ${coins.length} coins (mcaps ${Object.keys(mcaps).length})`);

    // Deliberately empty: resolveOpen() fetches 5M candles per OPEN signal
    // instead of the scan carrying them for every coin. See scoreCoin().
    const candlesBySymbol: Record<string, any> = {};

    let logged = 0, touched = 0, snapshot = 0;
    if (dryRun) {
      const barTime = Math.floor(Date.now() / BAR_MS) * BAR_MS;
      logged = coins.filter(c => c.score >= SignalJournal.MIN_SCORE).map(c => rowFor(c, barTime)).filter(Boolean).length;
      log.push(`DRY_RUN: would log ${logged} and snapshot ${coins.length}, skipping writes`);
    } else {
      logged = await logSignals(coins, log);
      touched = await resolveOpen(host, candlesBySymbol, log);
      // Last: the journal is the record that must not be missed, the
      // snapshot is a display cache. If this throws, the run has already
      // done its irreplaceable work.
      snapshot = await writeSnapshot(coins, log);
    }

    return new Response(JSON.stringify({
      ok: true, logged, touched, snapshot, seconds: (Date.now() - started) / 1000, log
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e), log }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
