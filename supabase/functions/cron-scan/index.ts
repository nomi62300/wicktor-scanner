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

declare const Scoring: any;
declare const SignalJournal: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://fpyfetynfobfrpunnnhv.supabase.co';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TABLE = 'signal_journal';

const HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
const BAR_MS = 5 * 60 * 1000;
const BATCH = 5;
const RESOLVE_LIMIT = 100;
const RESOLVE_BARS = 300;
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;
const INTERVAL: Record<string, string> = { '5m': '5', '15m': '15', '1h': '60' };

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
    .map((t: any) => ({ symbol: t.symbol, volume24h: +(t.turnover24h || 0) }))
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

async function scoreCoin(host: string, base: { symbol: string }, category: string) {
  const [h1, m15, m5, oi] = await Promise.all([
    klines(host, category, base.symbol, '1h', 100),
    klines(host, category, base.symbol, '15m', 100),
    klines(host, category, base.symbol, '5m', 100),
    category === 'linear' ? oiChange15m(host, base.symbol) : Promise.resolve(null)
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

async function scanCategory(host: string, category: string, size: number, out: any[]) {
  const list = await universe(host, category, size);
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = await Promise.all(
      list.slice(i, i + BATCH).map((b: any) => scoreCoin(host, b, category).catch(() => null))
    );
    chunk.forEach(c => { if (c) out.push(c); });
  }
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
  // Deliberately logs every qualifying run, even for a symbol already
  // open — a calibration record of the score, not a simulated trading
  // account. See js/signals.js's logFromScan() for the full reasoning.
  const rows = coins
    .filter(c => c.score >= SignalJournal.MIN_SCORE)
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
    const coins: any[] = [];
    await scanCategory(host, 'spot', universeSize, coins);
    await scanCategory(host, 'linear', universeSize, coins);
    log.push(`scored ${coins.length} coins`);

    const candlesBySymbol: Record<string, any> = {};
    coins.forEach(c => { candlesBySymbol[`${c.rawSymbol}:${c.market}`] = c.m5; });

    let logged = 0, touched = 0;
    if (dryRun) {
      const barTime = Math.floor(Date.now() / BAR_MS) * BAR_MS;
      logged = coins.filter(c => c.score >= SignalJournal.MIN_SCORE).map(c => rowFor(c, barTime)).filter(Boolean).length;
      log.push(`DRY_RUN: would log ${logged}, skipping writes and resolution`);
    } else {
      logged = await logSignals(coins, log);
      touched = await resolveOpen(host, candlesBySymbol, log);
    }

    return new Response(JSON.stringify({
      ok: true, logged, touched, seconds: (Date.now() - started) / 1000, log
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e), log }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
