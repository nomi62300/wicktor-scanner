#!/usr/bin/env node
/* ==========================================================================
   Wicktor — FORWARD regime validation

   Replaces the first validation attempt, which had two flaws:
     1. it only classified the final bar, giving n=6-13 per regime bucket —
        far too small for a stable median, and the "5M is inverted" result
        it produced flipped sign depending on the window, i.e. it was noise;
     2. it measured backward (what price had already done), which describes
        the label rather than testing it.

   This classifies EVERY historical bar and measures what happens AFTER, so
   the question becomes the one that actually matters for a trading signal:
   when the classifier says "trending", does price subsequently trend?

   Nothing from the future enters classification — analyzeTimeframe() only
   ever sees candles[0..i], and the outcome window is strictly i+1 onward.

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));
const TFS = [['h1', '1H'], ['m15', '15M'], ['m5', '5M']];

const FWD = 12;      // bars of outcome to measure
const MIN_BARS = 60; // history needed before a classification is trustworthy
const STRIDE = 1;

function forwardStats(future, atrV) {
  if (future.length < FWD || !atrV) return null;
  const w = future.slice(0, FWD);
  const net = w[w.length - 1].c - w[0].c;
  let travelled = 0;
  for (let i = 1; i < w.length; i++) travelled += Math.abs(w[i].c - w[i - 1].c);
  const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
  return {
    efficiency: travelled ? Math.abs(net) / travelled : 0,  // straightness of travel
    netAbsAtr: Math.abs(net) / atrV,                        // distance covered
    rangeAtr: (hi - lo) / atrV,                             // room available
    signedAtr: net / atrV
  };
}

const buckets = {};
let classified = 0;

for (const [key, label] of TFS) {
  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[key]);
    if (!cs || cs.length < MIN_BARS + FWD + 2) continue;
    // -1 everywhere: the newest fixture bar is the in-progress one (Phase B1)
    const closed = cs.slice(0, -1);
    for (let i = MIN_BARS; i < closed.length - FWD; i += STRIDE) {
      const s = I.analyzeTimeframe(closed.slice(0, i + 1));
      if (!s || s.regime === 'unknown') continue;
      const st = forwardStats(closed.slice(i + 1), s.atr);
      if (!st) continue;
      classified++;
      const k = `${label}|${s.regime}`;
      (buckets[k] = buckets[k] || []).push(st);
    }
  }
}

const med = (arr, f) => {
  const v = arr.map(f).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const fmt = x => x == null ? '   --' : x.toFixed(3);

console.log(`FORWARD validation — classify at bar i, measure bars i+1..i+${FWD}`);
console.log(`${classified.toLocaleString()} classifications across ${fx.coins.length} coins\n`);
console.log(`${'TF/regime'.padEnd(20)}${'n'.padStart(7)}${'fwd efficiency'.padStart(16)}${'fwd netATR'.padStart(12)}${'fwd rangeATR'.padStart(14)}`);
console.log('-'.repeat(69));
for (const [, label] of TFS) {
  ['trending', 'transition', 'ranging', 'squeeze'].forEach(r => {
    const b = buckets[`${label}|${r}`];
    if (!b || !b.length) return;
    console.log(
      `${(label + '/' + r).padEnd(20)}${String(b.length).padStart(7)}` +
      fmt(med(b, x => x.efficiency)).padStart(16) +
      fmt(med(b, x => x.netAbsAtr)).padStart(12) +
      fmt(med(b, x => x.rangeAtr)).padStart(14)
    );
  });
  console.log('-'.repeat(69));
}

console.log('\nFalsification checks — these decide whether the labels predict anything:');
let pass = 0, fail = 0;
const check = (desc, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}`); ok ? pass++ : fail++; };
for (const [, label] of TFS) {
  const tr = buckets[`${label}|trending`], ra = buckets[`${label}|ranging`], sq = buckets[`${label}|squeeze`];
  if (tr && ra) {
    const a = med(tr, x => x.efficiency), b = med(ra, x => x.efficiency);
    check(`${label.padEnd(4)} trending moves straighter than ranging  (${a.toFixed(3)} vs ${b.toFixed(3)})`, a > b);
    const c = med(tr, x => x.netAbsAtr), d = med(ra, x => x.netAbsAtr);
    check(`${label.padEnd(4)} trending covers more ground than ranging (${c.toFixed(2)} vs ${d.toFixed(2)})`, c > d);
  }
  if (sq && tr) {
    const a = med(sq, x => x.rangeAtr), b = med(tr, x => x.rangeAtr);
    check(`${label.padEnd(4)} squeeze has less room than trending      (${a.toFixed(2)} vs ${b.toFixed(2)})`, a < b);
  }
}
console.log(`\n  ${pass} passed, ${fail} failed`);
