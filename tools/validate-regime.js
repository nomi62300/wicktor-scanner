#!/usr/bin/env node
/* ==========================================================================
   Wicktor — regime label validation

   A plausible distribution is not evidence the labels are RIGHT. This scores
   each labelled coin against independent price-action measures the
   classifier never sees, so the labels can be checked against what price
   actually did rather than against the inputs used to derive them.

   Measures (all on the last 20 closed bars, none used by classifyRegime):
     netMoveAtr      |close[-1] - close[-20]| / atr   -> directional travel
     efficiency      netMove / sum(|bar-to-bar move|) -> trend "straightness"
     rangeAtr        (max high - min low) / atr       -> total room
     realizedVolPct  stdev of bar returns, %          -> volatility level

   Expectations if the classifier is sound:
     trending    -> high netMoveAtr, high efficiency
     ranging     -> low efficiency, meaningful rangeAtr
     squeeze     -> lowest realizedVol and lowest rangeAtr
     transition  -> between trending and ranging

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));
const TFS = [['h1', '1H'], ['m15', '15M'], ['m5', '5M']];
const N = 20;

function priceStats(candles, atrV) {
  const w = candles.slice(-N);
  if (w.length < N || !atrV) return null;
  const net = Math.abs(w[w.length - 1].c - w[0].c);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i].c - w[i - 1].c);
  const hi = Math.max(...w.map(c => c.h));
  const lo = Math.min(...w.map(c => c.l));
  const rets = [];
  for (let i = 1; i < w.length; i++) if (w[i - 1].c) rets.push((w[i].c - w[i - 1].c) / w[i - 1].c);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length);
  return {
    netMoveAtr: net / atrV,
    efficiency: path ? net / path : 0,
    rangeAtr: (hi - lo) / atrV,
    realizedVolPct: sd * 100
  };
}

const buckets = {};
for (const [key, label] of TFS) {
  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[key]);
    if (!cs || cs.length < 41) continue;
    const closed = cs.slice(0, -1);
    const s = I.analyzeTimeframe(closed);
    if (!s || s.regime === 'unknown') continue;
    const st = priceStats(closed, s.atr);
    if (!st) continue;
    const k = `${label}|${s.regime}`;
    (buckets[k] = buckets[k] || []).push({ sym: coin.symbol, ...st });
  }
}

const med = (arr, f) => {
  const v = arr.map(f).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const fmt = x => x == null ? '   --' : x.toFixed(2).padStart(6);

console.log(`Regime validation against independent price action — last ${N} closed bars\n`);
console.log(`${'TF/regime'.padEnd(20)}${'n'.padStart(4)}${'netMoveATR'.padStart(12)}${'efficiency'.padStart(12)}${'rangeATR'.padStart(10)}${'realVol%'.padStart(10)}`);
console.log('-'.repeat(68));
for (const [, label] of TFS) {
  ['trending', 'transition', 'ranging', 'squeeze'].forEach(r => {
    const b = buckets[`${label}|${r}`];
    if (!b || !b.length) return;
    console.log(
      `${(label + '/' + r).padEnd(20)}${String(b.length).padStart(4)}` +
      fmt(med(b, x => x.netMoveAtr)).padStart(12) +
      fmt(med(b, x => x.efficiency)).padStart(12) +
      fmt(med(b, x => x.rangeAtr)).padStart(10) +
      fmt(med(b, x => x.realizedVolPct)).padStart(10)
    );
  });
  console.log('-'.repeat(68));
}

// The two checks that would actually falsify the design.
console.log('\nFalsification checks (must hold for the labels to mean anything):');
let pass = 0, fail = 0;
for (const [, label] of TFS) {
  const tr = buckets[`${label}|trending`], ra = buckets[`${label}|ranging`], sq = buckets[`${label}|squeeze`];
  if (tr && ra) {
    const a = med(tr, x => x.efficiency), b = med(ra, x => x.efficiency);
    const ok = a > b;
    console.log(`  ${label.padEnd(4)} trending efficiency (${a.toFixed(2)}) > ranging (${b.toFixed(2)})   ${ok ? 'PASS' : 'FAIL'}`);
    ok ? pass++ : fail++;
  }
  if (sq && ra) {
    const a = med(sq, x => x.rangeAtr), b = med(ra, x => x.rangeAtr);
    const ok = a < b;
    console.log(`  ${label.padEnd(4)} squeeze rangeATR (${a.toFixed(2)}) < ranging (${b.toFixed(2)})       ${ok ? 'PASS' : 'FAIL'}`);
    ok ? pass++ : fail++;
  }
}
console.log(`\n  ${pass} passed, ${fail} failed`);
