#!/usr/bin/env node
/* ==========================================================================
   Wicktor — indicator audit

   The scanner carries 15+ indicators, most of which were never measured
   individually — they were adopted because the method calls for them or
   because a strategy spec listed them. This asks the blunt question of each
   one: given only this indicator's own directional reading, what happens
   next?

   Method:
     - each indicator is reduced to a DIRECTION (+1/-1) it is claiming
     - outcome is the forward move in that claimed direction, in ATR units
     - reported DIRECTION-BALANCED: the bullish and bearish cases are
       averaged, so a window's drift cannot masquerade as skill. A large
       bull/bear gap means drift, not edge.
     - coverage is reported too: a signal that is true almost always cannot
       discriminate however good its average looks

   An indicator scoring ~0 balanced is not necessarily worthless — it may
   still be useful as a filter or as regime input (ADX earns its place that
   way). But it is not, on its own, predicting direction.

   Read-only.
   Usage: node tools/audit-indicators.js [timeframe=m5] [horizon=12] [stride=3]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const WIN = 200, WARMUP = 90;
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (a, e) => a.slice(Math.max(0, e - WIN + 1), e + 1);

// Each returns +1 / -1 for a directional claim, or 0 for "no opinion here".
const SIGNALS = {
  'alligator lineOrder':    s => s.lineOrder || 0,
  'alligator alignment':    s => s.alignment || 0,
  'EMA 9/21 stack':         s => (s.ema9 == null || s.ema21 == null) ? 0 : (s.ema9 > s.ema21 ? 1 : -1),
  'Ichimoku cloud side':    s => s.ichimokuAboveCloud ? 1 : (s.ichimokuBelowCloud ? -1 : 0),
  'fractal position':       s => s.aboveUpFractal ? 1 : (s.belowDownFractal ? -1 : 0),
  'AO sign':                s => s.ao == null ? 0 : (s.ao > 0 ? 1 : -1),
  'AO direction':           s => s.aoRising ? 1 : (s.aoFalling ? -1 : 0),
  'AC direction':           s => s.ac == null ? 0 : (s.acRising ? 1 : -1),
  'MACD histogram sign':    s => s.macdHistogram == null ? 0 : (s.macdHistogram > 0 ? 1 : -1),
  'MACD hist rising':       s => s.macdHistogram == null ? 0 : (s.macdHistogramRising ? 1 : -1),
  'RSI above/below 50':     s => s.rsi == null ? 0 : (s.rsi > 50 ? 1 : -1),
  'RSI extreme (fade)':     s => s.rsi == null ? 0 : (s.rsi >= 70 ? -1 : (s.rsi <= 30 ? 1 : 0)),
  'BB %B extreme (fade)':   s => s.bbPercentB == null ? 0 : (s.bbPercentB >= 0.95 ? -1 : (s.bbPercentB <= 0.05 ? 1 : 0)),
  'RSI divergence':         s => s.divergence === 'bull' ? 1 : (s.divergence === 'bear' ? -1 : 0),
  'MACD divergence':        s => s.macdDivergence === 'bull' ? 1 : (s.macdDivergence === 'bear' ? -1 : 0),
  'Stoch divergence':       s => s.stochDivergence === 'bull' ? 1 : (s.stochDivergence === 'bear' ? -1 : 0),
  'Divergent Bar':          s => s.divergentBarUp ? 1 : (s.divergentBarDown ? -1 : 0),
  'Wiseman AO':             s => s.wisemanBullish ? 1 : (s.wisemanBearish ? -1 : 0),
  'Crossing Lips':          s => s.crossingLipsUp ? 1 : (s.crossingLipsDown ? -1 : 0),
  'Liquidity sweep':        s => s.liquiditySweepUp ? 1 : (s.liquiditySweepDown ? -1 : 0),
  'MFI green (w/ order)':   s => s.mfiSignal === 'green' ? (s.lineOrder || 0) : 0,
  'MFI squat (fade order)': s => s.mfiSignal === 'squat' ? -(s.lineOrder || 0) : 0,
  'stoch cross fr extreme': s => s.stochBullishCrossFromOversold ? 1 : (s.stochBearishCrossFromOverbought ? -1 : 0)
};

function main() {
  const tfKey = process.argv[2] || 'm5';
  const H = parseInt(process.argv[3], 10) || 12;
  const STRIDE = parseInt(process.argv[4], 10) || 3;

  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-deep.json'), 'utf8'));
  const acc = {};
  for (const k of Object.keys(SIGNALS)) acc[k] = { 1: [], '-1': [] };
  let bars = 0;

  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const cs = hydrate(coin.candles[tfKey]);
      if (!cs || cs.length < WARMUP + H + 5) continue;
      for (let i = WARMUP; i < cs.length - H; i += STRIDE) {
        const s = I.analyzeTimeframe(windowed(cs, i));
        if (!s || !s.atr) continue;
        bars++;
        const fwd = (cs[i + H].c - cs[i].c) / s.atr;
        for (const [name, fn] of Object.entries(SIGNALS)) {
          const d = fn(s);
          if (!d) continue;
          acc[name][d].push(d * fwd);
        }
      }
    }
  }

  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(3);

  const rows = Object.entries(acc).map(([name, d]) => {
    const nb = d[1].length, ns = d['-1'].length, n = nb + ns;
    const mb = mean(d[1]), ms = mean(d['-1']);
    const bal = (mb != null && ms != null) ? (mb + ms) / 2 : null;
    // How lopsided the two halves are: large gap = the window's drift, not skill.
    const gap = (mb != null && ms != null) ? Math.abs(mb - ms) : null;
    return { name, n, cover: n / bars * 100, mb, ms, bal, gap };
  }).filter(r => r.n > 0).sort((a, b) => (b.bal ?? -9) - (a.bal ?? -9));

  console.log(`Indicator audit — ${tfKey}, ${H}-bar forward horizon, stride ${STRIDE}`);
  console.log(`${bars.toLocaleString()} evaluated bars across ${fx.windows.length} market windows\n`);
  console.log(`${'signal'.padEnd(26)}${'n'.padStart(8)}${'cover%'.padStart(8)}${'bull'.padStart(9)}${'bear'.padStart(9)}${'BALANCED'.padStart(10)}${'gap'.padStart(8)}`);
  console.log('-'.repeat(78));
  rows.forEach(r => console.log(
    r.name.padEnd(26) + String(r.n).padStart(8) + r.cover.toFixed(0).padStart(8) +
    sg(r.mb).padStart(9) + sg(r.ms).padStart(9) + sg(r.bal).padStart(10) +
    (r.gap == null ? '   --' : r.gap.toFixed(2)).padStart(8)));

  console.log('\nReading this:');
  console.log('  BALANCED is the drift-safe number. GAP is how far the bull and bear');
  console.log('  halves disagree — a big gap means the window\'s drift is showing');
  console.log('  through and the balanced figure rests on cancellation, not skill.');
  console.log('  COVER is how often the signal has an opinion; a signal that is');
  console.log('  almost always on cannot discriminate however good its average.');
}

main();
