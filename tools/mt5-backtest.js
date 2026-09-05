#!/usr/bin/env node
/* ==========================================================================
   Wicktor — MT5 (gold / indices / FX) backtest

   Answers one question: does the Wicktor engine, unchanged, have an edge on
   an instrument whose transaction cost is ~1/50th of a crypto perp's?

   Methodology is deliberately copied from tools/backtest-v2.js so numbers
   stay comparable with every crypto claim already measured — same 200-bar
   rolling window, same WARMUP, same one-open-signal-per-direction rule,
   same direction-balanced reporting. Three deliberate DIFFERENCES, each
   because the instrument changed and a crypto-calibrated constant would
   otherwise decide the result silently:

   1. STRICT CLOSED-BAR CONTEXT. backtest-v2 aligns context timeframes with
      `t <= ts`, which selects the context bar currently FORMING and then
      reads its finished OHLC — data that did not exist at the entry bar.
      Here a context bar is visible only once `t + duration <= ts`. This is
      stricter than the existing harness; --loose reproduces the old
      behaviour so the two can be compared rather than argued about.

   2. COST IS REAL, PER BAR, FROM THE BROKER. MT5 stores the spread of each
      bar in its history. Gold's spread is bimodal (7-9 points in liquid
      hours, 22-23 off-session), so a single constant would flatter or
      punish depending which one you picked. Cost is charged at the entry
      bar's own recorded spread: `cost_R = spread_price / risk`. One
      crossing per round trip (buy the ask, sell the bid), commission zero
      as measured from 244 real Bybit CFD deals.

   3. FEE-VIABILITY FLOOR IS RESCALED, NOT REMOVED. RR.minRiskPct = 1.0%
      exists because below it crypto's 0.11% round trip eats the edge — it
      encodes a MAX FEE BURDEN of 0.11/1.0 = 0.11R, not a law about price.
      Deleting it for gold would be fitting; keeping it would gate every
      gold setup to AVOID (gold M5 ATR is 0.12% of price). So the same
      0.11R burden ceiling is re-derived from THIS instrument's measured
      spread. targetPct is likewise crypto-shaped (4% ≈ 33 gold ATR) and is
      chosen in-sample, then validated out-of-sample, never both.

   Read-only. Usage:
     node tools/mt5-backtest.js [SYMBOL] [minScore] [holdBars] [--loose]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const SignalJournal = require('../js/signals.js');
const I = global.Indicators;

const MT5_FILES = path.join(
  process.env.HOME,
  'Library/Application Support/net.metaquotes.wine.metatrader5',
  'drive_c/Program Files/MetaTrader 5/MQL5/Files/wicktor'
);

const WIN = 200;
const WARMUP = 90;
const TF_MS = { M5: 300000, M15: 900000, H1: 3600000, H4: 14400000 };

// Crypto's implied ceiling: 0.11% round trip / 1.0% minimum stop. Reused as
// an invariant rather than a number, so each instrument gets the floor its
// own costs justify instead of one inherited from Bybit's taker fee.
const MAX_FEE_BURDEN_R = 0.11;

//--------------------------------------------------------------- data load
// MT5 writes "YYYY.MM.DD HH:MM:SS" in server time. Absolute zone is
// irrelevant — only ordering and cross-timeframe alignment matter, and all
// series come from the same terminal — but it must parse consistently.
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
    out[i - 1] = {
      t: parseTime(p[0]),
      o: +p[1], h: +p[2], l: +p[3], c: +p[4],
      v: +p[5],
      spreadPts: +p[6]
    };
  }
  return out;
}

//------------------------------------------------------- context alignment
// Last context bar that had already CLOSED at `ts`. `graceMs = tfMs` is the
// honest setting; graceMs = 0 reproduces backtest-v2's looser behaviour.
function ctxIndexClosedAt(candles, ts, tfMs, loose) {
  const cutoff = loose ? ts : ts - tfMs;
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
const windowed = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

//------------------------------------------------------------------- walk
// Produces SIGNALS only (entry/stop/spread/bar index). Outcomes are
// simulated separately because riskReward()'s viability gate keys on stop
// width alone — target never touches the score — so every target variant
// can reuse one expensive scoring pass instead of forcing a rewalk.
function collectSignals({ m5, m15, h1, minScore, hold, loose }) {
  const signals = [];
  const openUntil = { 1: -1, '-1': -1 };
  // Context snapshots change only when a context bar closes; recomputing
  // them per 5M bar would triple the cost of the walk for identical values.
  let cache15 = { idx: -1, snap: null }, cache1h = { idx: -1, snap: null };

  for (let i = WARMUP; i < m5.length - hold; i++) {
    const ts = m5[i].t;
    const ci15 = ctxIndexClosedAt(m15, ts, TF_MS.M15, loose);
    const ci1h = ctxIndexClosedAt(h1, ts, TF_MS.H1, loose);
    if (ci15 < WARMUP || ci1h < 60) continue;

    if (ci15 !== cache15.idx) cache15 = { idx: ci15, snap: I.analyzeTimeframe(windowed(m15, ci15)) };
    if (ci1h !== cache1h.idx) cache1h = { idx: ci1h, snap: I.analyzeTimeframe(windowed(h1, ci1h)) };
    if (!cache1h.snap || !cache15.snap) continue;

    const snapM5 = I.analyzeTimeframe(windowed(m5, i));
    if (!snapM5) continue;

    const r = Scoring.evaluateSnapshots([cache1h.snap, cache15.snap, snapM5], { mode: 'scalp' });
    if (!r || !r.setupDirection || r.score < minScore) continue;
    if (i < openUntil[r.setupDirection]) continue;
    const rr = r.riskReward;
    if (!rr || !rr.entry || !rr.stop) continue;

    openUntil[r.setupDirection] = i + hold;
    signals.push({
      i, ts, dir: r.setupDirection, score: r.score,
      band: Scoring.bandLabel(r.score, null, r.ceiling).text,
      regime: r.contextRegime,
      trigger: r.trigger ? r.trigger.name : 'none',
      gated: r.gated,
      entry: rr.entry, stop: rr.stop, riskPct: rr.riskPct,
      // Spread of the bar the trade is entered on, in price.
      spread: m5[i].spreadPts * pointSize
    });
  }
  return signals;
}

let pointSize = 0.01;

//---------------------------------------------------------------- outcomes
// Reuses the production exit walk (js/signals.js realisedR) so the exit
// logic is identical to what the live journal records for crypto.
function outcomesFor(signals, m5, hold, targetR, plan) {
  return signals.map(s => {
    const risk = Math.abs(s.entry - s.stop);
    if (!risk) return null;
    const bars = m5.slice(s.i + 1, Math.min(s.i + 1 + hold, m5.length));
    if (bars.length < 5) return null;
    const res = SignalJournal.realisedR(bars, s.dir, s.entry, risk, plan, targetR);
    const costR = s.spread / risk;           // one crossing, commission = 0
    return { ...s, gross: res.r, net: res.r - costR, costR, reason: res.reason };
  }).filter(Boolean);
}

//--------------------------------------------------------------- reporting
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);

function balanced(list, key) {
  const b = list.filter(x => x.dir === 1).map(x => x[key]);
  const s = list.filter(x => x.dir === -1).map(x => x[key]);
  if (!b.length || !s.length) return null;
  return (mean(b) + mean(s)) / 2;
}
function report(label, list) {
  if (!list.length) { console.log(`  ${label.padEnd(24)}${'0'.padStart(6)}`); return; }
  const win = list.filter(x => x.net > 0).length / list.length * 100;
  console.log(`  ${label.padEnd(24)}${String(list.length).padStart(6)}${win.toFixed(1).padStart(8)}` +
    `${sg(mean(list.map(x => x.gross))).padStart(11)}${sg(mean(list.map(x => x.net))).padStart(11)}` +
    `${sg(balanced(list, 'net')).padStart(11)}${(mean(list.map(x => x.costR))).toFixed(4).padStart(9)}`);
}
const HEAD = t => {
  console.log(`\n${t}`);
  console.log(`  ${'group'.padEnd(24)}${'n'.padStart(6)}${'win%'.padStart(8)}${'gross'.padStart(11)}${'NET'.padStart(11)}${'BAL-NET'.padStart(11)}${'cost'.padStart(9)}`);
};

//------------------------------------------------------------------- main
function main() {
  const symbol = process.argv[2] || 'XAUUSD.s';
  const minScore = parseFloat(process.argv[3]) || 60;
  const hold = parseInt(process.argv[4], 10) || 48;
  const loose = process.argv.includes('--loose');

  const m5 = loadCsv(symbol, 'M5'), m15 = loadCsv(symbol, 'M15'), h1 = loadCsv(symbol, 'H1');
  if (!m5 || !m15 || !h1) { console.error(`Missing CSVs for ${symbol} in ${MT5_FILES}`); process.exit(1); }

  // Point size from the broker's spec sheet, never inferred from a close
  // price's decimals — a round-numbered close reads as 0 decimals and makes
  // the point (and therefore every spread cost) orders of magnitude wrong.
  pointSize = require('./mt5-squeeze.js').pointFor(symbol);

  const px = m5[Math.floor(m5.length / 2)].c;
  const medSpreadPct = (() => {
    const v = m5.map(b => b.spreadPts * pointSize / b.c * 100).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  })();
  // Same fee-burden ceiling crypto's 1.0% floor implies, re-derived here.
  const minRiskPct = +(medSpreadPct / MAX_FEE_BURDEN_R).toFixed(4);
  I.RR_PARAMS.minRiskPct = minRiskPct;
  I.RR_PARAMS.maxRiskPct = 25.0;

  console.log(`MT5 backtest — ${symbol}  score>=${minScore}  hold=${hold} bars  ` +
    `context=${loose ? 'LOOSE (backtest-v2 parity)' : 'STRICT closed-bar'}`);
  console.log(`M5 bars ${m5.length.toLocaleString()}  ${new Date(m5[0].t).toISOString().slice(0, 10)} -> ${new Date(m5[m5.length - 1].t).toISOString().slice(0, 10)}`);
  console.log(`median price ${px}  median spread ${medSpreadPct.toFixed(4)}% of price`);
  console.log(`fee-viability floor rescaled: minRiskPct ${I.RR_PARAMS.minRiskPct}%  (crypto default was 1.0%)`);

  const t0 = Date.now();
  const signals = collectSignals({ m5, m15, h1, minScore, hold, loose });
  console.log(`\n${signals.length.toLocaleString()} signals in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!signals.length) { console.log('No signals — check the viability floor.'); return; }

  // Time split. Chosen once, on bar index, before any parameter is looked at.
  const cut = m5[Math.floor(m5.length * 0.7)].t;
  const IS = s => s.ts < cut, OOS = s => s.ts >= cut;
  console.log(`IS/OOS boundary ${new Date(cut).toISOString().slice(0, 10)}  ` +
    `(IS ${signals.filter(IS).length}, OOS ${signals.filter(OOS).length})`);

  // Target expressed as an R-multiple so it is instrument-agnostic; the
  // vendor's own ladder (0.5/1/1.5/2R) lives in this same unit.
  const PLAN_SINGLE = [[1, 1, null]];
  const PLAN_LADDER = [[0.25, 0.25, null], [0.5, 0.25, 0], [0.75, 0.25, 0], [1, 0.25, null]];
  const targets = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

  for (const [planName, plan] of [['single exit', PLAN_SINGLE], ['4-rung ladder +BE', PLAN_LADDER]]) {
    HEAD(`IN-SAMPLE — ${planName} (target sweep; choose here, never validate here)`);
    for (const tR of targets) {
      const o = outcomesFor(signals.filter(IS), m5, hold, tR, plan);
      report(`target ${tR}R`, o);
    }
    HEAD(`OUT-OF-SAMPLE — ${planName}`);
    for (const tR of targets) {
      const o = outcomesFor(signals.filter(OOS), m5, hold, tR, plan);
      report(`target ${tR}R`, o);
    }
  }

  // Band monotonicity at a mid target — the structural check that matters
  // more than any single number (see backtest-v2's closing note).
  const all = outcomesFor(signals, m5, hold, 1.0, PLAN_SINGLE);
  HEAD('By band (target 1R, whole sample)');
  ['EXCELLENT', 'WATCH', 'AVOID'].forEach(b => report(b, all.filter(x => x.band === b)));
  HEAD('By score bucket (target 1R, whole sample)');
  [[50, 60], [60, 70], [70, 80], [80, 101]].forEach(([lo, hi]) =>
    report(`${lo}-${hi - 1}`, all.filter(x => x.score >= lo && x.score < hi)));
  HEAD('By trigger');
  [...new Set(all.map(x => x.trigger))].forEach(t => report(t, all.filter(x => x.trigger === t)));
  HEAD('By exit reason');
  [...new Set(all.map(x => x.reason))].forEach(t => report(t, all.filter(x => x.reason === t)));

  console.log('\nBAL-NET is the only drift-safe column: longs and shorts averaged');
  console.log('separately, net of the bar\'s own recorded spread. A large gap');
  console.log('between gross and NET means the instrument is eating the edge.');
}

main();
