#!/usr/bin/env node
/* ==========================================================================
   Wicktor — risk:reward geometry exploration

   R:R arithmetic is trivial; the semantics are not. Before choosing a stop
   buffer or a minimum-stop floor, this measures the geometry that actually
   exists: how far the structural stop sits from entry, how far the target
   sits, how often either is a synthetic ATR fallback rather than an observed
   level, and what raw R:R those produce.

   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));
const TFS = [['h1', '1H'], ['m15', '15M'], ['m5', '5M']];

const q = (v, p) => v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(p / 100 * (v.length - 1))))] : null;
const f = x => x == null ? '    --' : x.toFixed(2).padStart(7);
function describe(label, vals) {
  const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return console.log(`    ${label.padEnd(26)} (none)`);
  console.log(`    ${label.padEnd(26)} n=${String(v.length).padStart(4)} p05${f(q(v, 5))} p25${f(q(v, 25))} med${f(q(v, 50))} p75${f(q(v, 75))} p95${f(q(v, 95))}`);
}

console.log(`R:R geometry — ${fx.coins.length} coins, closed bars only\n`);

for (const [key, label] of TFS) {
  const stopDist = [], targetDist = [], rawRR = [];
  let n = 0, synthStop = 0, synthTarget = 0, bothSynth = 0, brokenStructure = 0;

  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[key]);
    if (!cs || cs.length < 41) continue;
    const s = I.analyzeTimeframe(cs.slice(0, -1));
    if (!s || s.atr == null || s.atr <= 0) continue;
    // Measure the long case; the short side is the exact mirror.
    n++;

    const entry = s.close;
    const structuralStop = s.lastDownFractal;   // most recent confirmed swing low
    const target = s.resistance;

    if (structuralStop == null) synthStop++;
    if (!s.resistanceFromFractal) synthTarget++;
    if (structuralStop == null && !s.resistanceFromFractal) bothSynth++;

    if (structuralStop != null) {
      const risk = (entry - structuralStop) / s.atr;
      if (risk <= 0) { brokenStructure++; }      // price already below the swing low
      else {
        stopDist.push(risk);
        const reward = (target - entry) / s.atr;
        targetDist.push(reward);
        if (reward > 0) rawRR.push(reward / risk);
      }
    }
  }

  console.log(`  ${label}  (n=${n})`);
  describe('stop distance (ATR)', stopDist);
  describe('target distance (ATR)', targetDist);
  describe('raw R:R (no buffer/floor)', rawRR);
  console.log(`    no structural stop available : ${synthStop}/${n} (${Math.round(synthStop / n * 100)}%)`);
  console.log(`    target is synthetic fallback : ${synthTarget}/${n} (${Math.round(synthTarget / n * 100)}%)`);
  console.log(`    BOTH synthetic               : ${bothSynth}/${n} (${Math.round(bothSynth / n * 100)}%)`);
  console.log(`    structure already broken     : ${brokenStructure}/${n} (${Math.round(brokenStructure / n * 100)}%)`);
  console.log();
}

// A stop that sits a hair below entry produces a spectacular R:R that noise
// would take out instantly. How much of the sample is in that trap?
console.log('Share of setups whose structural stop is dangerously tight:');
for (const [key, label] of TFS) {
  const d = [];
  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[key]);
    if (!cs || cs.length < 41) continue;
    const s = I.analyzeTimeframe(cs.slice(0, -1));
    if (!s || !s.atr || s.lastDownFractal == null) continue;
    const r = (s.close - s.lastDownFractal) / s.atr;
    if (r > 0) d.push(r);
  }
  const under = t => `${Math.round(d.filter(x => x < t).length / d.length * 100)}%`;
  console.log(`  ${label.padEnd(4)} n=${String(d.length).padStart(3)}  <0.25ATR ${under(0.25).padStart(4)}   <0.5ATR ${under(0.5).padStart(4)}   <1.0ATR ${under(1.0).padStart(4)}`);
}
console.log();
