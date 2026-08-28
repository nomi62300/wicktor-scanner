#!/usr/bin/env node
/* ==========================================================================
   Wicktor — Maximum Adverse Excursion: how far did price actually go
   against a trade before the outcome was decided, and would a tighter
   stop have helped or hurt?

   MAE = the worst the trade ever looked, in R, before its final outcome.
   MFE = the best it ever looked. Standard technique for stop placement:
   if winners' MAE sits well inside the current stop, there is slack to
   tighten; if losers' MAE barely exceeds it, the stop is already tight
   and just needs to be smarter about WHERE (structure), not WIDTH.

   Then it directly tests tightening: re-walk every trade with the stop
   moved to a FRACTION of its own current distance (same structure, closer
   invalidation), target unchanged (still the ~4% price move), and reports
   NET of fees — a tighter stop pays a bigger R-multiple on a win but a
   higher fee tax and more early stop-outs, the same tension that picked
   the 1H stop source in the first place, now tested one level deeper.

   Direction-balanced, both fixture sets. Read-only.

   Usage: node tools/analyze-mae.js [fixture] [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;

const WIN = 200, WARMUP = 90, HOLD = 48;
const TAKER = 0.11;
const FRACTIONS = [1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);

function ctxAt(candles, ts) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function balanced(rows, key) {
  const b = mean(rows.filter(r => r.dir === 1).map(r => r[key]));
  const s = mean(rows.filter(r => r.dir === -1).map(r => r[key]));
  return (b != null && s != null) ? (b + s) / 2 : null;
}

/** Walks a full window once: MAE/MFE (against the ORIGINAL stop/target,
 *  uncapped by either — the true excursion) plus the outcome under a
 *  hypothetical stop at `fraction` of the original risk distance. */
function walk(bars, direction, entry, risk, targetDist, fraction) {
  const newRisk = risk * fraction;
  const stopPx = entry - direction * newRisk;
  const targetPx = entry + direction * targetDist;
  let worstR = 0, bestR = 0, reason = 'timeout', exitR = null;
  for (const b of bars) {
    const advPx = direction === 1 ? b.l : b.h;
    const favPx = direction === 1 ? b.h : b.l;
    const advR = (direction * (advPx - entry)) / risk;   // negative = against
    const favR = (direction * (favPx - entry)) / risk;
    if (advR < worstR) worstR = advR;
    if (favR > bestR) bestR = favR;

    const stopHit = direction === 1 ? b.l <= stopPx : b.h >= stopPx;
    if (stopHit) { reason = 'stop'; exitR = -newRisk / newRisk; break; } // -1 in NEW risk units
    const targetHit = direction === 1 ? b.h >= targetPx : b.l <= targetPx;
    if (targetHit) { reason = 'target'; exitR = targetDist / newRisk; break; }
  }
  if (exitR == null) {
    const last = bars[bars.length - 1];
    exitR = (direction * (last.c - entry)) / newRisk;
  }
  const riskPctNew = newRisk / entry * 100;
  return {
    maeR: -worstR, mfeR: bestR, reason, r: exitR,
    net: exitR - TAKER / riskPctNew
  };
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
        const ts = m5[i].t, c15 = ctxAt(m15, ts), c1h = ctxAt(h1, ts);
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
        const targetDist = Math.abs(rr.target - rr.entry);
        const end = Math.min(i + 1 + HOLD, m5.length - 1);
        const window = m5.slice(i + 2, end + 1);
        if (!window.length) continue;

        const byFraction = {};
        for (const f of FRACTIONS) byFraction[f] = walk(window, dir, entryPx, risk, targetDist, f);
        const base = byFraction[1.0];
        rows.push({
          dir, riskPct: risk / entryPx * 100, maeR: base.maeR, mfeR: base.mfeR,
          reason: base.reason, r: base.r, byFraction
        });
      }
    }
  }
  return rows;
}

function report(label, rows) {
  const n = rows.length;
  if (!n) { console.log(`${label.padEnd(14)} n=0`); return; }
  const win = rows.filter(r => r.r > 0).length / n * 100;
  console.log(
    `${label.padEnd(14)} n=${String(n).padStart(5)}  win ${win.toFixed(1).padStart(5)}%` +
    `  MAE ${sg(balanced(rows, 'maeR'))}R  MFE ${sg(balanced(rows, 'mfeR'))}R`
  );
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const full = path.join(__dirname, 'fixtures', file);
  console.log(`\n${file}  minScore=${minScore}  (direction-balanced)`);

  const rows = collect(full, minScore);
  console.log('-'.repeat(90));
  report('ALL', rows);

  const winners = rows.filter(r => r.r > 0), losers = rows.filter(r => r.r <= 0);
  console.log('\nMAE by final outcome (this answers "where could the SL actually sit"):');
  report('winners', winners);
  report('losers', losers);
  report('stopped', rows.filter(r => r.reason === 'stop'));
  report('targeted', rows.filter(r => r.reason === 'target'));
  report('timed out', rows.filter(r => r.reason === 'timeout'));

  const maeSorted = winners.map(r => r.maeR).sort((a, b) => a - b);
  const q = p => maeSorted[Math.floor(maeSorted.length * p)];
  console.log(`\nWinning trades' MAE distribution (in units of the CURRENT stop distance):`);
  console.log(`  p50=${q(0.5)?.toFixed(2)}R  p75=${q(0.75)?.toFixed(2)}R  p90=${q(0.9)?.toFixed(2)}R  p95=${q(0.95)?.toFixed(2)}R  (1.0R = current stop)`);
  console.log(`  Reading this: if p90 is well under 1.0R, most winners never got close to the`);
  console.log(`  current stop -- there is real slack. If p90 is near or over 1.0R, tightening`);
  console.log(`  would have stopped out a meaningful share of winners.`);

  console.log('\nTightening the stop to a FRACTION of its current distance (net of fees):');
  console.log(`  ${'fraction'.padEnd(10)} ${'n stopped early'.padStart(16)} ${'win%'.padStart(7)} ${'gross'.padStart(9)} ${'NET'.padStart(9)}`);
  for (const f of FRACTIONS) {
    const sub = rows.map(row => ({ dir: row.dir, r: row.byFraction[f].r, net: row.byFraction[f].net, reason: row.byFraction[f].reason }));
    const stoppedEarly = sub.filter((row, idx) => row.reason === 'stop' && rows[idx].reason !== 'stop').length;
    const win = sub.filter(r => r.r > 0).length / sub.length * 100;
    console.log(
      `  ${(f.toFixed(2) + 'x').padEnd(10)} ${String(stoppedEarly).padStart(16)} ${win.toFixed(1).padStart(6)}% ` +
      `${sg(balanced(sub, 'r')).padStart(9)} ${sg(balanced(sub, 'net')).padStart(9)}`
    );
  }
  console.log();
}

main();
