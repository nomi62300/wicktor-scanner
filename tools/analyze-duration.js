#!/usr/bin/env node
/* ==========================================================================
   Wicktor — how long does an EXCELLENT signal actually take to resolve?

   HOLD_BARS=48 (4h) is the CEILING, not a typical duration — it is only
   hit by trades that time out. This measures the real distribution: bars
   elapsed until stop or target is touched, using the exact production
   entry/stop/target from Scoring.evaluate() (mode: scalp — entry TF is 5M,
   confirm 15M, context/stop source 1H).

   Direction-balanced is not needed here (duration, not P&L), but both
   fixture sets are still checked for agreement. Read-only.

   Usage: node tools/analyze-duration.js [fixture] [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48;
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);


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
        const r = Scoring.evaluateSnapshots(sn, { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < minScore || !r.riskReward) continue;
        if (i < open[r.setupDirection]) continue;
        open[r.setupDirection] = i + HOLD;

        const rr = r.riskReward, dir = r.setupDirection, entryPx = m5[i + 1].o;
        const risk = Math.abs(rr.entry - rr.stop);
        if (!risk) continue;
        const stop = entryPx - dir * risk, target = entryPx + dir * risk * rr.ratio;
        const end = Math.min(i + 1 + HOLD, m5.length - 1);
        let reason = 'timeout', bars = end - (i + 1);
        for (let k = i + 2; k <= end; k++) {
          const b = m5[k];
          if (dir === 1 ? b.l <= stop : b.h >= stop) { reason = 'stop'; bars = k - (i + 1); break; }
          if (dir === 1 ? b.h >= target : b.l <= target) { reason = 'target'; bars = k - (i + 1); break; }
        }
        rows.push({ reason, bars, minutes: bars * 5 });
      }
    }
  }
  return rows;
}

function stats(rows) {
  if (!rows.length) return null;
  const sorted = [...rows].map(r => r.minutes).sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: rows.length, mean, median: q(0.5), p25: q(0.25), p75: q(0.75), p90: q(0.9) };
}

function fmt(mins) {
  if (mins == null) return '--';
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h > 0 ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`;
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const full = path.join(__dirname, 'fixtures', file);
  const rows = collect(full, minScore);

  console.log(`\n${file}  minScore=${minScore}  n=${rows.length}`);
  console.log('-'.repeat(70));

  for (const reason of ['target', 'stop', 'timeout']) {
    const sub = rows.filter(r => r.reason === reason);
    const s = stats(sub);
    const pct = (sub.length / rows.length * 100).toFixed(1);
    if (!s) { console.log(`${reason.padEnd(10)} 0 (0%)`); continue; }
    console.log(
      `${reason.padEnd(10)} n=${String(s.n).padStart(4)} (${pct}%)  ` +
      `mean ${fmt(s.mean).padStart(6)}  median ${fmt(s.median).padStart(6)}  ` +
      `p25 ${fmt(s.p25).padStart(6)}  p75 ${fmt(s.p75).padStart(6)}  p90 ${fmt(s.p90).padStart(6)}`
    );
  }

  const all = stats(rows);
  console.log('-'.repeat(70));
  console.log(
    `${'ALL'.padEnd(10)} n=${String(all.n).padStart(4)}          ` +
    `mean ${fmt(all.mean).padStart(6)}  median ${fmt(all.median).padStart(6)}  ` +
    `p25 ${fmt(all.p25).padStart(6)}  p75 ${fmt(all.p75).padStart(6)}  p90 ${fmt(all.p90).padStart(6)}`
  );
  console.log(`\nceiling (HOLD_BARS): ${fmt(HOLD * 5)}\n`);
}

main();
