#!/usr/bin/env node
/* ==========================================================================
   Wicktor — does trigger freshness actually matter?

   Tracking barsAgo is only worth doing if a stale trigger is measurably
   worse than a fresh one. If entering 5 bars late performed the same as
   entering immediately, age would be bookkeeping rather than signal.

   Method: find every bar where a trigger fires, then measure the outcome of
   entering `delay` bars later, for delay = 0..7. Outcome is the forward move
   in the trigger's own direction, in ATR units, so bullish and bearish
   triggers are directly comparable.

   Drift control (the C2 lesson): the fixture window carries strong
   directional drift, which flatters bullish triggers and punishes bearish
   ones. Both are reported separately and averaged; only the balanced column
   is safe to draw conclusions from.

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));

const H = 12;          // outcome horizon after entry
const MAX_DELAY = 7;
const MIN_BARS = 60;

function analyse(tfKey) {
  // delay -> direction -> outcomes
  const acc = {};
  for (let d = 0; d <= MAX_DELAY; d++) acc[d] = { 1: [], '-1': [] };
  const byName = {};

  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[tfKey]);
    if (!cs || cs.length < MIN_BARS + MAX_DELAY + H + 4) continue;
    const closed = cs.slice(0, -1);

    const frac = I.fractals(closed);
    const atrSeries = I.atr(closed);
    const macdRes = I.macd(closed);
    const stochRes = I.stochastic(closed);
    const bb = I.bollingerBands(closed);

    for (let i = MIN_BARS; i < closed.length - MAX_DELAY - H; i++) {
      // lookback 1 => only triggers firing exactly at bar i
      const fired = I.detectTriggers(
        { candles: closed, macdRes, stochRes, bb, frac, atrSeries, lastIdx: i }, 1
      ).filter(t => t.barsAgo === 0);
      if (!fired.length) continue;

      for (const t of fired) {
        for (let d = 0; d <= MAX_DELAY; d++) {
          const entryIdx = i + d, exitIdx = entryIdx + H;
          if (exitIdx >= closed.length) break;
          const atr = atrSeries[entryIdx];
          if (!atr || atr <= 0) continue;
          const move = t.direction * (closed[exitIdx].c - closed[entryIdx].c) / atr;
          acc[d][t.direction].push(move);
          if (d === 0) (byName[t.name] = byName[t.name] || []).push(move);
        }
      }
    }
  }
  return { acc, byName };
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '   --' : (x >= 0 ? '+' : '') + x.toFixed(3);

for (const [key, label] of [['m5', '5M'], ['m15', '15M'], ['h1', '1H']]) {
  const { acc, byName } = analyse(key);
  console.log(`${label} — mean forward move in the trigger's direction (ATR), ${H}-bar horizon`);
  console.log(`  ${'delay'.padEnd(7)}${'n'.padStart(7)}${'bullish'.padStart(10)}${'bearish'.padStart(10)}${'BALANCED'.padStart(11)}`);
  let first = null;
  for (let d = 0; d <= MAX_DELAY; d++) {
    const b = acc[d][1], s = acc[d]['-1'];
    if (!b.length || !s.length) continue;
    const mb = mean(b), ms = mean(s), bal = (mb + ms) / 2;
    if (first == null) first = bal;
    console.log(`  ${String(d).padEnd(7)}${String(b.length + s.length).padStart(7)}${sg(mb).padStart(10)}${sg(ms).padStart(10)}${sg(bal).padStart(11)}`);
  }
  console.log(`  by trigger type at delay 0 (balanced not applied — direction mixed):`);
  Object.entries(byName).sort((a, b) => b[1].length - a[1].length).forEach(([n, v]) => {
    console.log(`    ${n.padEnd(24)} n=${String(v.length).padStart(5)}  ${sg(mean(v))}`);
  });
  console.log();
}
