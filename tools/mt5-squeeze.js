#!/usr/bin/env node
/* ==========================================================================
   Wicktor — ARM B: the vendor's recipe, rebuilt and measured

   Reconstructed from the GROWTHCLUBPK "Trend Sniper" screenshots, not from
   its source (invite-only Pine is closed; buying it would not expose code).
   Everything below was READ OFF the charts and panels:

     - "EMA ribbon, MACD, Stoch-RSI and Bollinger squeeze, filtered by ADX
       and volatility" (vendor's own description)
     - BUY/SELL SQUEEZE markers = the classic Bollinger-inside-Keltner
       compression fire (TTM squeeze), which is what the boxes drawn round
       consolidations are
     - MARKET CONTEXT panel = 15M/1H/4H/1D trend states + an ALIGN count and
       an ADX bucket (their labels: <20 RANGING, ~20 BUILDING, >25 TRENDING)
     - stop ~2x ATR: gold panel showed "risk 12.88" against ATR 6.4 (2.01x)
     - TP1-TP4 are FIXED R-MULTIPLES, proven arithmetically from the gold
       chart: EP 4342.17, SL 4329.29 -> risk 12.88; TP1 4348.60 = 0.4996R,
       TP2 4355.04 = 0.9996R, TP3 4361.48 = 1.4996R, TP4 4367.92 = 1.9996R.
       Even 0.5R spacing, a quarter booked at each — which is also why an
       "85% win rate" claim measured at TP1-touch says almost nothing about
       expectancy.

   Selection discipline: the knob grid is deliberately small (3 stop widths
   x 2 ADX floors x 2 MTF settings). The grid is swept IN-SAMPLE, the best
   cell is named BEFORE looking at out-of-sample, and only that cell's OOS
   number counts. The full OOS grid is printed for transparency, NOT to be
   picked from after the fact — with 12 cells, the best OOS cell will look
   good by chance alone.

   Read-only. Usage: node tools/mt5-squeeze.js [SYMBOL] [holdBars]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const I = require('../js/indicators.js');
global.Indicators = I;
const SignalJournal = require('../js/signals.js');

const MT5_FILES = path.join(
  process.env.HOME,
  'Library/Application Support/net.metaquotes.wine.metatrader5',
  'drive_c/Program Files/MetaTrader 5/MQL5/Files/wicktor'
);
const TF_MS = { M15: 900000, H1: 3600000 };

function parseTime(s) {
  const [d, t] = s.split(' ');
  const [Y, M, D] = d.split('.');
  return Date.parse(`${Y}-${M}-${D}T${t}Z`);
}
function loadCsv(symbol, tf) {
  const file = path.join(MT5_FILES, `Bybit-Live-4_${symbol}_${tf}.csv`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const out = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    out[i - 1] = { t: parseTime(p[0]), o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5], spreadPts: +p[6] };
  }
  return out;
}
// Point size MUST come from the broker's own spec sheet. Inferring it from
// the decimals in a close price silently fails whenever that close lands on
// a round number — an index printing "42000" reads as 0 decimals and yields
// a point 100x too large, which then inflates every spread cost by 100x and
// buries the result. This bit the first crossval run; the specs file is
// authoritative, so use it.
let SPECS = null;
function pointFor(symbol) {
  if (!SPECS) {
    SPECS = {};
    const f = path.join(MT5_FILES, 'Bybit-Live-4_specs.csv');
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
      const cols = lines[0].split(',');
      const iSym = cols.indexOf('symbol'), iPt = cols.indexOf('point');
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(',');
        SPECS[p[iSym]] = parseFloat(p[iPt]);
      }
    }
  }
  const v = SPECS[symbol];
  if (!v || !isFinite(v) || v <= 0) throw new Error(`no point size in specs for ${symbol}`);
  return v;
}

// Strictly-closed context bar, same rule as mt5-backtest.js.
function ctxClosedAt(candles, ts, tfMs) {
  let lo = 0, hi = candles.length - 1, best = -1;
  const cutoff = ts - tfMs;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

//------------------------------------------------------------- indicators
// All causal (EMA/ATR/BB/ADX only look backwards), so computing them over
// the whole series introduces no lookahead — unlike a windowed re-fit.
function buildIndicators(c) {
  const closes = c.map(x => x.c);
  const bb = I.bollingerBands(c, 20, 2);
  const atr20 = I.atr(c, 20);
  const atr14 = I.atr(c, 14);
  const mid = I.ema(closes, 20);
  const adxOut = I.adx(c, 14);
  const ribbon = [8, 13, 21, 34, 55].map(p => I.ema(closes, p));

  const n = c.length;
  const squeezeOn = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    // Keltner(20, 1.5xATR20) — the standard TTM pairing.
    if (bb.upper[i] == null || mid[i] == null || atr20[i] == null) continue;
    const kcU = mid[i] + 1.5 * atr20[i], kcL = mid[i] - 1.5 * atr20[i];
    squeezeOn[i] = bb.upper[i] < kcU && bb.lower[i] > kcL;
  }
  // Ribbon stack: +1 fully bullish order, -1 fully bearish, 0 mixed.
  const stack = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const v = ribbon.map(r => r[i]);
    if (v.some(x => x == null)) continue;
    let up = true, dn = true;
    for (let k = 1; k < v.length; k++) { if (!(v[k - 1] > v[k])) up = false; if (!(v[k - 1] < v[k])) dn = false; }
    stack[i] = up ? 1 : dn ? -1 : 0;
  }
  return { squeezeOn, stack, adx: adxOut.adx, atr14, ribbon };
}

//------------------------------------------------------------------- walk
function collect(m5, ind, h1, h1ind, cfg, hold) {
  const out = [];
  let openUntil = -1;
  for (let i = 60; i < m5.length - hold; i++) {
    // Fire = compression released on this bar.
    if (!(ind.squeezeOn[i - 1] && !ind.squeezeOn[i])) continue;
    if (i < openUntil) continue;
    const dir = ind.stack[i];
    if (dir === 0) continue;
    if (ind.adx[i] == null || ind.adx[i] < cfg.adxMin) continue;
    const a = ind.atr14[i];
    if (a == null || a <= 0) continue;

    if (cfg.requireH1) {
      const ci = ctxClosedAt(h1, m5[i].t, TF_MS.H1);
      if (ci < 60 || h1ind.stack[ci] !== dir) continue;
    }

    const entry = m5[i].c;
    const stop = entry - dir * cfg.stopAtr * a;
    openUntil = i + hold;
    out.push({ i, ts: m5[i].t, dir, entry, stop, spread: m5[i].spreadPts * pointSize, adx: ind.adx[i] });
  }
  return out;
}

let pointSize = 0.01;

function simulate(sigs, m5, hold, targetR, plan) {
  return sigs.map(s => {
    const risk = Math.abs(s.entry - s.stop);
    if (!risk) return null;
    const bars = m5.slice(s.i + 1, Math.min(s.i + 1 + hold, m5.length));
    if (bars.length < 5) return null;
    const r = SignalJournal.realisedR(bars, s.dir, s.entry, risk, plan, targetR);
    const costR = s.spread / risk;
    return { ...s, gross: r.r, net: r.r - costR, costR, reason: r.reason };
  }).filter(Boolean);
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);
function balNet(list) {
  const b = list.filter(x => x.dir === 1).map(x => x.net);
  const s = list.filter(x => x.dir === -1).map(x => x.net);
  if (!b.length || !s.length) return null;
  return (mean(b) + mean(s)) / 2;
}

function main() {
  const symbol = process.argv[2] || 'XAUUSD.s';
  const hold = parseInt(process.argv[3], 10) || 48;

  const m5 = loadCsv(symbol, 'M5'), h1 = loadCsv(symbol, 'H1');
  if (!m5 || !h1) { console.error('missing CSVs for ' + symbol); process.exit(1); }
  pointSize = pointFor(symbol);

  console.log(`ARM B — vendor recipe (squeeze fire + ribbon + ADX, ${hold}-bar hold) on ${symbol}`);
  console.log(`M5 bars ${m5.length.toLocaleString()}  ${new Date(m5[0].t).toISOString().slice(0, 10)} -> ${new Date(m5[m5.length - 1].t).toISOString().slice(0, 10)}`);

  const ind = buildIndicators(m5);
  const h1ind = buildIndicators(h1);
  const cut = m5[Math.floor(m5.length * 0.7)].t;

  // The vendor's own ladder: quarter off at 0.5R/1R/1.5R/2R, stop to
  // breakeven once the first rung is banked.
  const LADDER = [[0.25, 0.25, null], [0.5, 0.25, 0], [0.75, 0.25, 0], [1, 0.25, null]];
  const SINGLE = [[1, 1, null]];
  const TARGET_R = 2.0;             // TP4, fixed by the vendor's geometry

  const grid = [];
  for (const stopAtr of [1.5, 2.0, 3.0])
    for (const adxMin of [20, 25])
      for (const requireH1 of [false, true])
        grid.push({ stopAtr, adxMin, requireH1 });

  const head = t => {
    console.log(`\n${t}`);
    console.log(`  ${'config'.padEnd(30)}${'n'.padStart(6)}${'win%'.padStart(8)}${'gross'.padStart(11)}${'NET'.padStart(11)}${'BAL-NET'.padStart(11)}`);
  };
  const label = c => `stop ${c.stopAtr}xATR adx>=${c.adxMin}${c.requireH1 ? ' +H1' : ''}`;
  const row = (name, list) => {
    if (list.length < 30) { console.log(`  ${name.padEnd(30)}${String(list.length).padStart(6)}   (too few)`); return null; }
    const bn = balNet(list);
    console.log(`  ${name.padEnd(30)}${String(list.length).padStart(6)}` +
      `${(list.filter(x => x.net > 0).length / list.length * 100).toFixed(1).padStart(8)}` +
      `${sg(mean(list.map(x => x.gross))).padStart(11)}${sg(mean(list.map(x => x.net))).padStart(11)}${sg(bn).padStart(11)}`);
    return bn;
  };

  for (const [planName, plan] of [['4-rung ladder (vendor)', LADDER], ['single exit at 2R', SINGLE]]) {
    const sigsByCfg = grid.map(cfg => ({ cfg, sigs: collect(m5, ind, h1, h1ind, cfg, hold) }));

    head(`IN-SAMPLE — ${planName}`);
    let best = null;
    for (const { cfg, sigs } of sigsByCfg) {
      const o = simulate(sigs.filter(s => s.ts < cut), m5, hold, TARGET_R, plan);
      const bn = row(label(cfg), o);
      if (bn != null && (!best || bn > best.bn)) best = { cfg, bn };
    }
    if (!best) { console.log('  no viable IS cell'); continue; }
    console.log(`  -> IS-BEST (selected before looking at OOS): ${label(best.cfg)}  ${sg(best.bn)}`);

    head(`OUT-OF-SAMPLE — ${planName}  (only the IS-selected row is a real result)`);
    for (const { cfg, sigs } of sigsByCfg) {
      const o = simulate(sigs.filter(s => s.ts >= cut), m5, hold, TARGET_R, plan);
      const mark = (cfg === best.cfg) ? ' <== SELECTED' : '';
      const bn = row(label(cfg) + mark, o);
    }
  }

  // What the vendor's headline actually measures, on the same trades.
  const sigs = collect(m5, ind, h1, h1ind, { stopAtr: 2.0, adxMin: 20, requireH1: false }, hold);
  const o = simulate(sigs, m5, hold, TARGET_R, LADDER);
  const tp1 = o.filter(x => x.gross > 0).length / o.length * 100;
  console.log(`\n"Win rate" as a TP1-touch statistic (stop 2xATR, adx>=20, whole sample):`);
  console.log(`  trades ${o.length}  any-profit rate ${tp1.toFixed(1)}%  ` +
    `but BAL-NET expectancy ${sg(balNet(o))}R`);
  console.log('  ^ this gap is the point: a high hit rate at a 0.5R first rung');
  console.log('    is compatible with negative expectancy.');
}

// Exported so tools/mt5-crossval.js can reuse the EXACT signal and costing
// logic rather than keeping a second copy that could silently drift from
// this one — the cross-instrument test is only meaningful if it is running
// the identical rules.
module.exports = {
  loadCsv, buildIndicators, collect, simulate, balNet, mean, ctxClosedAt, pointFor,
  setPointSize: v => { pointSize = v; },
  LADDER: [[0.25, 0.25, null], [0.5, 0.25, 0], [0.75, 0.25, 0], [1, 0.25, null]],
  SINGLE: [[1, 1, null]]
};

if (require.main === module) main();
