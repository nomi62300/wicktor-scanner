#!/usr/bin/env node
/* ==========================================================================
   Wicktor — does breaking a SLOPED 1H trendline beat breaking a flat level?

   Prompted by a trading course's method: draw a trendline on 1H, enter on
   the 5M close that breaks it. We already compute that line —
   `regressionChannelLevels()` fits a regression through the last 3-6
   fractal pivots and keeps it only at r2 >= 0.6 — and `analyzeTimeframe()`
   returns it as `resistanceSloped`/`supportSloped`. It is rendered on the
   coin card and then **never used in scoring**. Meanwhile our best trigger,
   `levelBreak`, breaks a FLAT fractal level. So the course's core setup is
   a thing we measure, display, and discard.

   Three questions, in order of what would actually change the model:
     1. Standalone — does a 5M close through the 1H sloped line predict
        anything at all, direction-balanced?
     2. Additive — among signals we ALREADY score EXCELLENT, do the ones
        that also broke the sloped line do better than the ones that didn't?
        (This is the one that matters: we would ADD it as a trigger/context
        input, not replace the model with it.)
     3. Versus flat — head to head against the `levelBreak` trigger we
        already have, on the same trade structure.

   Trade structure is production's, unchanged: 1H-structure stop via
   riskReward(), ~4% price-move target, next-bar-open fill, HOLD=48. Net of
   taker fees. Direction-balanced. Read-only.

   Usage: node tools/test-sloped-break.js [fixture] [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48, TAKER = 0.11;
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);


function balanced(rows, key) {
  const b = mean(rows.filter(r => r.dir === 1).map(r => r[key]));
  const s = mean(rows.filter(r => r.dir === -1).map(r => r[key]));
  return (b != null && s != null) ? (b + s) / 2 : null;
}

/** Production trade structure, so results sit on the same scale as every
 *  other measurement in tools/. */
function outcome(m5, i, dir, rr) {
  const entryPx = m5[i + 1].o;
  const risk = Math.abs(rr.entry - rr.stop);
  if (!risk) return null;
  const stop = entryPx - dir * risk;
  const target = entryPx + dir * risk * rr.ratio;
  const end = Math.min(i + 1 + HOLD, m5.length - 1);
  let r = (dir * (m5[end].c - entryPx)) / risk;
  for (let k = i + 2; k <= end; k++) {
    const b = m5[k];
    if (dir === 1 ? b.l <= stop : b.h >= stop) { r = -1; break; }
    if (dir === 1 ? b.h >= target : b.l <= target) { r = rr.ratio; break; }
  }
  const riskPct = risk / entryPx * 100;
  return { r, net: r - TAKER / riskPct };
}

function collect(file, minScore) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const w of fx.windows) {
    for (const coin of w.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + 6) continue;
      const open = { 1: -1, '-1': -1 };
      for (let i = WARMUP; i < m5.length - HOLD - 1; i++) {
        const ts = m5[i].t, c15 = closedIndexAt(m15, ts, TF_MS.m15), c1h = closedIndexAt(h1, ts, TF_MS.h1);
        if (c15 < WARMUP || c1h < 60) continue;
        const sn = [I.analyzeTimeframe(wd(h1, c1h)), I.analyzeTimeframe(wd(m15, c15)), I.analyzeTimeframe(wd(m5, i))];
        if (!sn[0] || !sn[2]) continue;

        // --- the course's setup: a 5M close through the 1H sloped line ---
        // The 1H line moves ~nothing across one 5M bar, so comparing this
        // bar's close and the previous one against the same line value is a
        // valid cross test.
        const up = sn[0].resistanceSloped, dn = sn[0].supportSloped;
        let slopedDir = 0, slopedR2 = null;
        if (up && m5[i].c > up.value && m5[i - 1].c <= up.value) { slopedDir = 1; slopedR2 = up.r2; }
        else if (dn && m5[i].c < dn.value && m5[i - 1].c >= dn.value) { slopedDir = -1; slopedR2 = dn.r2; }

        const r = Scoring.evaluateSnapshots(sn, { mode: 'scalp' });
        const scored = !!(r && r.setupDirection && r.riskReward);
        const excellent = scored && r.score >= minScore;
        // Our own flat-level trigger, for the head-to-head.
        const flatBreak = scored && r.setup && r.setup.trigger &&
          r.setup.trigger.name === 'levelBreak' && r.setup.trigger.barsAgo === 0;

        if (!slopedDir && !excellent) continue;

        // A standalone sloped break still needs a trade spec to be scored on
        // the same footing; borrow production's for the sloped direction.
        let dir = null, rr = null;
        if (excellent) { dir = r.setupDirection; rr = r.riskReward; }
        else if (slopedDir) {
          rr = I.riskReward(sn[2], slopedDir, { stopFrom: sn[0] });
          dir = slopedDir;
        }
        if (!dir || !rr || !rr.stop || !rr.target) continue;
        if (i < open[dir]) continue;
        open[dir] = i + HOLD;

        const o = outcome(m5, i, dir, rr);
        if (!o) continue;
        rows.push({
          dir, r: o.r, net: o.net,
          sloped: slopedDir === dir, slopedR2,
          excellent, flatBreak,
          score: scored ? r.score : null
        });
      }
    }
  }
  return rows;
}

function report(label, rows) {
  const n = rows.length;
  if (!n) { console.log(`  ${label.padEnd(34)} n=0`); return; }
  const win = rows.filter(r => r.r > 0).length / n * 100;
  console.log(
    `  ${label.padEnd(34)} n=${String(n).padStart(5)}  win ${win.toFixed(1).padStart(5)}%` +
    `  gross ${sg(balanced(rows, 'r'))}  NET ${sg(balanced(rows, 'net'))}`
  );
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const full = path.join(__dirname, 'fixtures', file);
  console.log(`\n${file}  minScore=${minScore}  (direction-balanced, NET of ${TAKER}% taker)`);
  const rows = collect(full, minScore);
  console.log('-'.repeat(86));

  console.log('\n1. STANDALONE — is a 1H sloped-trendline break predictive on its own?');
  report('sloped break (any score)', rows.filter(r => r.sloped));
  report('EXCELLENT (our model, baseline)', rows.filter(r => r.excellent));

  console.log('\n2. ADDITIVE — within EXCELLENT, does also breaking the sloped line help?');
  const exc = rows.filter(r => r.excellent);
  report('EXCELLENT + sloped break', exc.filter(r => r.sloped));
  report('EXCELLENT, no sloped break', exc.filter(r => !r.sloped));

  console.log('\n3. VERSUS FLAT — the trigger we already use, same structure:');
  report('flat levelBreak (fresh)', rows.filter(r => r.flatBreak));
  report('sloped break', rows.filter(r => r.sloped));
  report('both together', rows.filter(r => r.sloped && r.flatBreak));

  console.log('\n4. Does trendline FIT QUALITY matter? (r2 of the regression)');
  for (const [lo, hi] of [[0.6, 0.75], [0.75, 0.9], [0.9, 1.01]]) {
    report(`sloped, r2 ${lo}-${hi}`, rows.filter(r => r.sloped && r.slopedR2 >= lo && r.slopedR2 < hi));
  }
  console.log();
}

main();
