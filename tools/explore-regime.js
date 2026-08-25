#!/usr/bin/env node
/* ==========================================================================
   Wicktor — regime input exploration

   Prints the real distribution of every candidate regime input across the
   frozen fixtures, per timeframe. The point is to pick thresholds from what
   the market actually does rather than from convention: "ADX >= 25" is a
   textbook number, not necessarily the right boundary for 5M crypto.

   Read-only. Never mutates fixtures or snapshots.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function describe(label, values) {
  const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return console.log(`  ${label.padEnd(22)} (no data)`);
  const f = x => x == null ? '  --' : x.toFixed(2).padStart(7);
  console.log(`  ${label.padEnd(22)} n=${String(v.length).padStart(3)}  min${f(v[0])} p10${f(pct(v, 10))} p25${f(pct(v, 25))} med${f(pct(v, 50))} p75${f(pct(v, 75))} p90${f(pct(v, 90))} max${f(v[v.length - 1])}`);
}

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));
const TFS = [['h1', '1H'], ['m15', '15M'], ['m5', '5M']];

console.log(`Regime input distributions — ${fx.coins.length} coins, fixtures ${fx.capturedAt}\n`);

const all = {};
for (const [key, label] of TFS) {
  const snaps = [];
  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[key]);
    if (!cs || cs.length < 41) continue;
    const s = I.analyzeTimeframe(cs.slice(0, -1)); // closed bars only, per B1
    if (s) snaps.push(s);
  }
  all[key] = snaps;
  console.log(`${label}  (n=${snaps.length})`);
  describe('adx', snaps.map(s => s.adx));
  describe('alligatorSpreadAtr', snaps.map(s => s.alligatorSpreadAtr));
  describe('bbBandwidthPct', snaps.map(s => s.bbBandwidthPct));

  const ordered = snaps.filter(s => s.lineOrder !== 0).length;
  const invalidated = snaps.filter(s => s.alligatorInvalidated).length;
  const alignedAfter = snaps.filter(s => s.alignment !== 0).length;
  console.log(`  lineOrder != 0 (raw)   ${ordered}/${snaps.length}  (${(ordered / snaps.length * 100).toFixed(0)}%)`);
  console.log(`  invalidated            ${invalidated}/${snaps.length}  (${(invalidated / snaps.length * 100).toFixed(0)}%)`);
  console.log(`  alignment != 0 (used)  ${alignedAfter}/${snaps.length}  (${(alignedAfter / snaps.length * 100).toFixed(0)}%)`);
  console.log();
}

// Does spread actually separate ordered from unordered mouths? If Williams'
// sleeping/eating language is measurable, these two groups must differ.
console.log('Does spread separate an ordered mouth from a closed one?');
for (const [key, label] of TFS) {
  const s = all[key];
  const ord = s.filter(x => x.lineOrder !== 0 && x.alligatorSpreadAtr != null).map(x => x.alligatorSpreadAtr).sort((a, b) => a - b);
  const un = s.filter(x => x.lineOrder === 0 && x.alligatorSpreadAtr != null).map(x => x.alligatorSpreadAtr).sort((a, b) => a - b);
  console.log(`  ${label.padEnd(4)} ordered  med=${pct(ord, 50) != null ? pct(ord, 50).toFixed(2) : '--'}  p25=${pct(ord, 25) != null ? pct(ord, 25).toFixed(2) : '--'}   |   unordered med=${pct(un, 50) != null ? pct(un, 50).toFixed(2) : '--'}  p75=${pct(un, 75) != null ? pct(un, 75).toFixed(2) : '--'}`);
}

console.log('\nCorrelation of candidate inputs with each other (1H):');
function corr(a, b) {
  const p = a.map((v, i) => [v, b[i]]).filter(([x, y]) => x != null && y != null && isFinite(x) && isFinite(y));
  if (p.length < 5) return null;
  const n = p.length;
  const mx = p.reduce((s, [x]) => s + x, 0) / n, my = p.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  p.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const h = all.h1;
const show = (l, c) => console.log(`  ${l.padEnd(34)} ${c == null ? '--' : c.toFixed(3)}`);
show('adx vs alligatorSpreadAtr', corr(h.map(s => s.adx), h.map(s => s.alligatorSpreadAtr)));
show('adx vs bbBandwidthPct', corr(h.map(s => s.adx), h.map(s => s.bbBandwidthPct)));
show('alligatorSpreadAtr vs bbBandwidthPct', corr(h.map(s => s.alligatorSpreadAtr), h.map(s => s.bbBandwidthPct)));
console.log();
