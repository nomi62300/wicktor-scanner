#!/usr/bin/env node
/* ==========================================================================
   Wicktor — regime threshold calibration

   Sweeps candidate thresholds and prints the resulting regime mix per
   timeframe, so the constants are chosen from measured behaviour rather
   than convention. A classifier that labels 55% of coins SQUEEZE is not
   informative regardless of how textbook its threshold looks.

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));
const TFS = [['h1', '1H'], ['m15', '15M'], ['m5', '5M']];

const snaps = {};
for (const [key] of TFS) {
  snaps[key] = fx.coins.map(c => {
    const cs = hydrate(c.candles[key]);
    if (!cs || cs.length < 41) return null;
    return I.analyzeTimeframe(cs.slice(0, -1));
  }).filter(Boolean);
}

function classify(s, SPREAD, SQUEEZE, ADX_MIN) {
  const spread = s.alligatorSpreadAtr;
  const bwPct = s.bbBandwidthPct;
  if (spread == null) return 'UNKNOWN';
  const trendy = s.lineOrder !== 0 && spread >= SPREAD && (ADX_MIN == null || (s.adx != null && s.adx >= ADX_MIN));
  if (trendy) return 'TRENDING';
  if (bwPct != null && bwPct <= SQUEEZE) return 'SQUEEZE';
  if (s.lineOrder !== 0) return 'TRANSITION';
  return 'RANGING';
}

function mix(list, ...args) {
  const m = { TRENDING: 0, SQUEEZE: 0, RANGING: 0, TRANSITION: 0, UNKNOWN: 0 };
  list.forEach(s => m[classify(s, ...args)]++);
  const n = list.length;
  const p = k => `${String(m[k]).padStart(2)} (${String(Math.round(m[k] / n * 100)).padStart(2)}%)`;
  return `TREND ${p('TRENDING')}  SQZ ${p('SQUEEZE')}  RANGE ${p('RANGING')}  TRANS ${p('TRANSITION')}`;
}

console.log(`Regime mix by threshold — ${fx.coins.length} coins per TF\n`);

console.log('=== sweep SPREAD (squeeze=10, no ADX gate) ===');
[0.3, 0.4, 0.5, 0.6, 0.75].forEach(sp => {
  console.log(`  spread>=${sp}`);
  TFS.forEach(([k, l]) => console.log(`    ${l.padEnd(4)} ${mix(snaps[k], sp, 10, null)}`));
});

console.log('\n=== sweep SQUEEZE percentile (spread=0.5, no ADX gate) ===');
[5, 10, 15, 20].forEach(sq => {
  console.log(`  bwPct<=${sq}`);
  TFS.forEach(([k, l]) => console.log(`    ${l.padEnd(4)} ${mix(snaps[k], 0.5, sq, null)}`));
});

console.log('\n=== does an ADX gate on TRENDING add or just subtract? (spread=0.5, sqz=10) ===');
[null, 18, 20, 25].forEach(ax => {
  console.log(`  adx>=${ax == null ? 'none' : ax}`);
  TFS.forEach(([k, l]) => console.log(`    ${l.padEnd(4)} ${mix(snaps[k], 0.5, 10, ax)}`));
});

// How much does the ADX gate actually change? If spread already implies
// strong ADX (r=0.73), the gate is mostly redundant and only costs recall.
console.log('\n=== ADX of coins that spread alone calls TRENDING (spread>=0.5) ===');
TFS.forEach(([k, l]) => {
  const t = snaps[k].filter(s => s.lineOrder !== 0 && s.alligatorSpreadAtr != null && s.alligatorSpreadAtr >= 0.5 && s.adx != null)
    .map(s => s.adx).sort((a, b) => a - b);
  if (!t.length) return console.log(`  ${l} none`);
  const q = p => t[Math.round(p / 100 * (t.length - 1))].toFixed(1);
  const below20 = t.filter(x => x < 20).length;
  console.log(`  ${l.padEnd(4)} n=${t.length}  min ${q(0)}  p25 ${q(25)}  med ${q(50)}  p75 ${q(75)}  |  adx<20: ${below20} (${Math.round(below20 / t.length * 100)}%)`);
});
console.log();
