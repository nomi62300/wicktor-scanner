#!/usr/bin/env node
/* ==========================================================================
   Wicktor — v2 model backtest

   Runs the PRODUCTION scoring path (Scoring.evaluateSnapshots, the same
   function evaluate() calls) over the deep fixtures and measures what its
   signals would actually have paid.

   Method, matching how every other claim in this rebuild was measured:
     - walk the entry timeframe bar by bar; at each bar build snapshots from
       a 200-bar rolling window (verified to reproduce full-prefix indicator
       values EXACTLY, while keeping the walk O(1) per bar instead of O(n))
     - context timeframes are timestamp-aligned, never index-assumed, and
       only bars that had already CLOSED at the entry bar's time are visible
     - take the model's own entry/stop/target from C2 and simulate forward:
       stop or target first, a bar touching both counts as a STOP, timeouts
       are marked to market rather than discarded
     - DIRECTION-BALANCED reporting throughout. Long and short are shown
       separately and averaged; a large gap between them is the window's
       drift, not an edge.

   Nothing from the future enters scoring. Read-only.

   Usage: node tools/backtest-v2.js [minScore] [holdBars]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200;       // rolling window; verified exact against full prefix
const WARMUP = 90;     // bars before a snapshot is trustworthy
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

function simulate(candles, from, dir, entry, stop, target, hold) {
  const end = Math.min(from + hold, candles.length - 1);
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  for (let k = from + 1; k <= end; k++) {
    const bar = candles[k];
    const hitStop = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTarget = dir === 1 ? bar.h >= target : bar.l <= target;
    if (hitStop) return -1;                       // both-touched lands here too
    if (hitTarget) return Math.abs(target - entry) / risk;
  }
  return (dir * (candles[end].c - entry)) / risk;  // timed out
}

function main() {
  const minScore = parseFloat(process.argv[2]) || 50;
  const hold = parseInt(process.argv[3], 10) || 24;
  const modeName = process.argv[4] || 'scalp';
  // Which fixture series drives the walk depends on the mode's entry TF:
  // scalp enters on 5M, swing on 15M. Fee burden differs sharply between
  // them (a 5M stop is ~0.26% of price against a 0.11% round trip), so the
  // comparison is a product question, not just a parameter sweep.
  const ENTRY_KEY = { scalp: 'm5', swing: 'm15' }[modeName] || 'm5';
  const file = path.join(__dirname, 'fixtures', 'market-deep.json');
  if (!fs.existsSync(file)) {
    console.error('Missing tools/fixtures/market-deep.json — run capture-deep-fixtures.js first.');
    process.exit(1);
  }
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));

  const rows = [];
  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const entrySeries = hydrate(coin.candles[ENTRY_KEY]);
      const m15 = hydrate(coin.candles.m15);
      const h1 = hydrate(coin.candles.h1);
      if (!entrySeries || !m15 || !h1 || entrySeries.length < WARMUP + hold + 5) continue;

      // one open signal per symbol+direction at a time, so a 5-minute
      // cadence doesn't log the same setup dozens of times
      const openUntil = { 1: -1, '-1': -1 };

      for (let i = WARMUP; i < entrySeries.length - hold; i++) {
        const ts = entrySeries[i].t;
        const ci15 = closedIndexAt(m15, ts, TF_MS.m15), ci1h = closedIndexAt(h1, ts, TF_MS.h1);
        if (ci15 < WARMUP || ci1h < 60) continue;

        // [1H, 15M, 5M]. In swing mode the entry timeframe IS 15M, so the
        // walked series occupies index 1 rather than index 2.
        const snaps = modeName === 'swing'
          ? [I.analyzeTimeframe(windowed(h1, ci1h)),
             I.analyzeTimeframe(windowed(entrySeries, i)),
             null]
          : [I.analyzeTimeframe(windowed(h1, ci1h)),
             I.analyzeTimeframe(windowed(m15, ci15)),
             I.analyzeTimeframe(windowed(entrySeries, i))];
        const entryIdx = Scoring.MODES[modeName].entry;
        if (!snaps[0] || !snaps[entryIdx]) continue;

        const r = Scoring.evaluateSnapshots(snaps, { mode: modeName });
        if (!r || !r.setupDirection || r.score < minScore) continue;
        if (i < openUntil[r.setupDirection]) continue;

        const rr = r.riskReward;
        if (!rr) continue;
        const outcome = simulate(entrySeries, i, r.setupDirection, rr.entry, rr.stop, rr.target, hold);
        if (outcome == null) continue;
        openUntil[r.setupDirection] = i + hold;

        rows.push({
          window: win.label, dir: r.setupDirection, score: r.score,
          band: Scoring.bandLabel(r.score, null, r.ceiling).text,
          regime: r.contextRegime,
          trigger: r.trigger ? r.trigger.name : 'none',
          gated: r.gated, ratio: rr.ratio, r: outcome
        });
      }
    }
  }

  if (!rows.length) { console.log('No signals produced.'); return; }

  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const sg = x => x == null ? '   --' : (x >= 0 ? '+' : '') + x.toFixed(3);
  const balanced = list => {
    const b = list.filter(x => x.dir === 1).map(x => x.r);
    const s = list.filter(x => x.dir === -1).map(x => x.r);
    if (!b.length || !s.length) return { bal: null, b: mean(b), s: mean(s), n: list.length };
    return { bal: (mean(b) + mean(s)) / 2, b: mean(b), s: mean(s), n: list.length };
  };
  const winPct = list => list.filter(x => x.r > 0).length / list.length * 100;

  const line = (label, list) => {
    if (!list.length) return;
    const st = balanced(list);
    console.log(`  ${label.padEnd(26)}${String(st.n).padStart(6)}${winPct(list).toFixed(1).padStart(8)}${sg(st.b).padStart(10)}${sg(st.s).padStart(10)}${sg(st.bal).padStart(11)}`);
  };
  const header = t => {
    console.log(`\n${t}`);
    console.log(`  ${'group'.padEnd(26)}${'n'.padStart(6)}${'win%'.padStart(8)}${'long'.padStart(10)}${'short'.padStart(10)}${'BALANCED'.padStart(11)}`);
  };

  console.log(`v2 backtest — production scoring path, mode=${modeName} (entry ${ENTRY_KEY}), score>=${minScore}, ${hold}-bar hold`);
  console.log(`fixtures captured ${fx.capturedAt}, ${fx.daysPerWindow}d per window`);
  console.log(`${rows.length.toLocaleString()} deduped signals\n${'='.repeat(72)}`);

  header('Overall');
  line('all signals', rows);

  header('By window (drift diversity check)');
  fx.windows.forEach(w => {
    const sub = rows.filter(x => x.window === w.label);
    line(`${w.label} (drift ${w.meanDrift}%)`, sub);
  });

  header('By band');
  ['EXCELLENT', 'WATCH', 'AVOID'].forEach(b => line(b, rows.filter(x => x.band === b)));

  header('By score bucket');
  [[50, 60], [60, 70], [70, 80], [80, 101]].forEach(([lo, hi]) =>
    line(`${lo}-${hi - 1}`, rows.filter(x => x.score >= lo && x.score < hi)));

  header('By context regime');
  ['trending', 'transition', 'ranging', 'squeeze'].forEach(r => line(r, rows.filter(x => x.regime === r)));

  header('By trigger');
  [...new Set(rows.map(x => x.trigger))].forEach(t => line(t, rows.filter(x => x.trigger === t)));

  console.log(`\n${'='.repeat(72)}`);
  console.log('Reading this: BALANCED is the only drift-safe column. A large');
  console.log('long/short gap is the window\'s drift showing through. And for the');
  console.log('model to be worth anything, higher score buckets must pay better —');
  console.log('that monotonicity matters more than any single number here.');
}

main();
