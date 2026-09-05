#!/usr/bin/env node
/* ==========================================================================
   Wicktor — which trigger works in which regime?

   This is the empirical core of the new scoring model. C3 measured triggers
   in aggregate and found breakouts fade at 5M; but "breakout" in a squeeze
   (coiled, about to release) is not obviously the same event as "breakout"
   mid-range, and the difference decides whether squeeze setups are tradeable
   at all.

   Regime is taken from the CONTEXT timeframe, never from the entry
   timeframe — 5M regime was measured anti-predictive in C1. So for a 5M
   entry the regime comes from 15M, and for a 15M entry it comes from 1H.
   Aligning the two series by timestamp avoids assuming a fixed bar ratio.

   Direction-balanced throughout (the C2 drift lesson): bullish and bearish
   are reported separately and averaged, since the fixture window carries
   strong directional drift.

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));

const H = 12;
const MIN = 60;
const PAIRS = [
  { entry: 'm5', context: 'm15', label: '5M entry / 15M regime' },
  { entry: 'm15', context: 'h1', label: '15M entry / 1H regime' }
];

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '   --' : (x >= 0 ? '+' : '') + x.toFixed(3);

for (const pair of PAIRS) {
  const acc = {};   // regime -> trigger -> direction -> []
  const regimeOnly = {};

  for (const coin of fx.coins) {
    const ec = hydrate(coin.candles[pair.entry]);
    const cc = hydrate(coin.candles[pair.context]);
    if (!ec || !cc || ec.length < MIN + H + 4 || cc.length < 60) continue;
    const entry = ec.slice(0, -1), ctx = cc.slice(0, -1);

    const frac = I.fractals(entry), atrS = I.atr(entry);
    const macdRes = I.macd(entry), stochRes = I.stochastic(entry), bb = I.bollingerBands(entry);

    // Context regime per context-bar, computed once.
    const ctxRegime = new Array(ctx.length).fill(null);
    for (let j = MIN; j < ctx.length; j++) {
      const s = I.analyzeTimeframe(ctx.slice(0, j + 1));
      ctxRegime[j] = s ? s.regime : null;
    }

    for (let i = MIN; i < entry.length - H; i++) {
      const cIdx = closedIndexAt(ctx, entry[i].t, TF_MS[pair.context]);
      if (cIdx < MIN) continue;
      const regime = ctxRegime[cIdx];
      if (!regime || regime === 'unknown') continue;
      const atr = atrS[i];
      if (!atr || atr <= 0) continue;

      const fired = I.detectTriggers(
        { candles: entry, macdRes, stochRes, bb, frac, atrSeries: atrS, lastIdx: i }, 1
      ).filter(t => t.barsAgo === 0);
      if (!fired.length) continue;

      for (const t of fired) {
        const mv = t.direction * (entry[i + H].c - entry[i].c) / atr;
        acc[regime] = acc[regime] || {};
        acc[regime][t.name] = acc[regime][t.name] || { 1: [], '-1': [] };
        acc[regime][t.name][t.direction].push(mv);
        regimeOnly[regime] = regimeOnly[regime] || { 1: [], '-1': [] };
        regimeOnly[regime][t.direction].push(mv);
      }
    }
  }

  console.log(`\n${'='.repeat(72)}\n${pair.label}  —  forward move in trigger direction (ATR), ${H} bars\n${'='.repeat(72)}`);
  console.log('\nAny trigger, by context regime:');
  console.log(`  ${'regime'.padEnd(13)}${'nBull'.padStart(7)}${'nBear'.padStart(7)}${'bull'.padStart(9)}${'bear'.padStart(9)}${'BALANCED'.padStart(11)}`);
  Object.entries(regimeOnly).sort((a, b) => (b[1][1].length + b[1]['-1'].length) - (a[1][1].length + a[1]['-1'].length))
    .forEach(([r, d]) => {
      const mb = mean(d[1]), ms = mean(d['-1']);
      console.log(`  ${r.padEnd(13)}${String(d[1].length).padStart(7)}${String(d['-1'].length).padStart(7)}${sg(mb).padStart(9)}${sg(ms).padStart(9)}${sg(mb != null && ms != null ? (mb + ms) / 2 : null).padStart(11)}`);
    });

  console.log('\nBy regime x trigger (only cells with >=15 samples a side):');
  console.log(`  ${'regime'.padEnd(13)}${'trigger'.padEnd(24)}${'n'.padStart(6)}${'bull'.padStart(9)}${'bear'.padStart(9)}${'BALANCED'.padStart(11)}`);
  for (const [r, byT] of Object.entries(acc)) {
    for (const [tn, d] of Object.entries(byT)) {
      if (d[1].length < 15 || d['-1'].length < 15) continue;
      const mb = mean(d[1]), ms = mean(d['-1']);
      console.log(`  ${r.padEnd(13)}${tn.padEnd(24)}${String(d[1].length + d['-1'].length).padStart(6)}${sg(mb).padStart(9)}${sg(ms).padStart(9)}${sg((mb + ms) / 2).padStart(11)}`);
    }
  }
}
console.log();
