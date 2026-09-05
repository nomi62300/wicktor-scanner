#!/usr/bin/env node
/* ==========================================================================
   Wicktor — out-of-sample validation

   Every headline number so far is IN-SAMPLE. The stop source, the target
   multiple, the trigger ordering and the band threshold were all chosen by
   looking at market-deep.json. A model tuned on data will flatter itself on
   that same data; the only honest question is what it does on periods it has
   never seen.

   This runs the model UNCHANGED against a second fixture set captured from
   different months and prints the two side by side. A large drop is the
   normal signature of in-sample fitting, not a bug.

   It also measures something per-trade expectancy hides: signals in crypto
   are not independent. If everything open at a given moment wins or loses
   together, then taking 20 positions is closer to taking one large one, and
   portfolio risk is far higher than the trade count suggests.

   Usage: node tools/validate-oos.js [inSample.json] [outOfSample.json]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48, MIN_SCORE = 60;
const TAKER = 0.11, MAKER = 0.04;
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (a, e) => a.slice(Math.max(0, e - WIN + 1), e + 1);

function run(file) {
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
        if (!r || !r.setupDirection || r.score < MIN_SCORE || !r.riskReward) continue;
        if (i < open[r.setupDirection]) continue;
        open[r.setupDirection] = i + HOLD;

        // realistic fill: the evaluated bar has closed, so enter at the next open
        const rr = r.riskReward, dir = r.setupDirection, entryPx = m5[i + 1].o;
        const risk = Math.abs(rr.entry - rr.stop);
        const stop = entryPx - dir * risk, target = entryPx + dir * risk * rr.ratio;
        const end = Math.min(i + 1 + HOLD, m5.length - 1);
        let out = (dir * (m5[end].c - entryPx)) / risk;
        for (let k = i + 2; k <= end; k++) {
          const b = m5[k];
          if (dir === 1 ? b.l <= stop : b.h >= stop) { out = -1; break; }
          if (dir === 1 ? b.h >= target : b.l <= target) { out = rr.ratio; break; }
        }
        rows.push({
          win: w.label, dir, score: r.score, r: out,
          band: Scoring.bandLabel(r.score, null, r.ceiling).text,
          riskPct: risk / entryPx * 100, day: Math.floor(m5[i].t / 86400000)
        });
      }
    }
  }
  return { fx, rows };
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);
function stats(rows) {
  if (rows.length < 60) return null;
  const b = rows.filter(x => x.dir === 1).map(x => x.r), s = rows.filter(x => x.dir === -1).map(x => x.r);
  if (b.length < 25 || s.length < 25) return null;
  const gross = (mean(b) + mean(s)) / 2;
  const rp = rows.map(x => x.riskPct).sort((x, y) => x - y)[Math.floor(rows.length / 2)];
  return {
    n: rows.length, win: rows.filter(x => x.r > 0).length / rows.length * 100,
    gross, riskPct: rp, netT: gross - TAKER / rp, netM: gross - MAKER / rp
  };
}

function main() {
  const inFile = process.argv[2] || path.join(__dirname, 'fixtures', 'market-deep.json');
  const oosFile = process.argv[3] || path.join(__dirname, 'fixtures', 'market-oos.json');
  if (!fs.existsSync(oosFile)) {
    console.error(`Missing ${oosFile}\nCapture it with:\n  WINDOWS=120,160,200 OUTFILE=market-oos.json node tools/capture-deep-fixtures.js 60 7`);
    process.exit(1);
  }

  const A = run(inFile), B = run(oosFile);
  const hdr = () => console.log(`  ${'set'.padEnd(22)}${'n'.padStart(7)}${'win%'.padStart(7)}${'gross'.padStart(10)}${'NETtaker'.padStart(11)}${'NETmaker'.padStart(11)}`);
  const line = (label, st) => st && console.log(
    `  ${label.padEnd(22)}${String(st.n).padStart(7)}${st.win.toFixed(1).padStart(7)}${sg(st.gross).padStart(10)}${sg(st.netT).padStart(11)}${sg(st.netM).padStart(11)}`);

  console.log(`Out-of-sample validation — model unchanged, score>=${MIN_SCORE}, realistic next-open fills\n`);
  console.log(`in-sample     windows: ${A.fx.windows.map(w => w.label + ' (' + w.meanDrift + '%)').join(', ')}`);
  console.log(`out-of-sample windows: ${B.fx.windows.map(w => w.label + ' (' + w.meanDrift + '%)').join(', ')}\n`);

  hdr();
  console.log('  ' + '-'.repeat(66));
  line('IN-SAMPLE all', stats(A.rows));
  line('OUT-OF-SAMPLE all', stats(B.rows));
  console.log();
  line('IN-SAMPLE excellent', stats(A.rows.filter(x => x.band === 'EXCELLENT')));
  line('OUT-OF-SAMPLE excellent', stats(B.rows.filter(x => x.band === 'EXCELLENT')));

  // A pooled point estimate can look real and still be noise. Per-trade net
  // (each row netted against its OWN riskPct, not the group's median), 95%
  // CI, direction-balanced the same way every other number here is.
  function ci95Net(rows, fee) {
    const netOf = x => x.r - fee / x.riskPct;
    const arm = dir => rows.filter(x => x.dir === dir).map(netOf);
    const b = arm(1), s = arm(-1);
    if (b.length < 2 || s.length < 2) return null;
    const se = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2)) * a.length / (a.length - 1) / a.length); };
    const m = (mean(b) + mean(s)) / 2, e = Math.sqrt(se(b) ** 2 + se(s) ** 2) / 2;
    return { m, lo: m - 1.96 * e, hi: m + 1.96 * e, n: rows.length };
  }
  const oosExcellent = B.rows.filter(x => x.band === 'EXCELLENT');
  const ci = ci95Net(oosExcellent, TAKER);
  if (ci) console.log(`  OOS excellent 95% CI (net taker, per-trade, balanced): ` +
    `${sg(ci.m)}  [${sg(ci.lo)}, ${sg(ci.hi)}]  n=${ci.n}  ` +
    `excludes zero: ${ci.lo > 0 ? 'YES (positive)' : ci.hi < 0 ? 'YES (negative)' : 'NO'}`);

  console.log('\nDoes the score still rank out of sample?');
  hdr();
  console.log('  ' + '-'.repeat(66));
  [[60, 70], [70, 80], [80, 101]].forEach(([lo, hi]) =>
    line(`OOS score ${lo}-${hi - 1}`, stats(B.rows.filter(x => x.score >= lo && x.score < hi))));

  // Portfolio reality: per-trade expectancy assumes independence. Crypto
  // signals cluster, so measure how much of a day's outcome is shared.
  console.log('\nAre signals independent? (they are priced as if they were)');
  [['in-sample', A.rows], ['out-of-sample', B.rows]].forEach(([label, rows]) => {
    const byDay = {};
    rows.forEach(r => { (byDay[r.day] = byDay[r.day] || []).push(r.r); });
    const days = Object.values(byDay).filter(d => d.length >= 5);
    if (!days.length) return;
    const dayMeans = days.map(d => mean(d));
    const overall = mean(rows.map(r => r.r));
    const between = mean(dayMeans.map(m => (m - overall) ** 2));
    const within = mean(days.map(d => mean(d.map(v => (v - mean(d)) ** 2))));
    // share of variance explained by "which day it was" rather than by the
    // individual trade — high means outcomes move together
    const shared = between / (between + within);
    const avgPerDay = mean(days.map(d => d.length));
    console.log(`  ${label.padEnd(15)} ${days.length} days, ${avgPerDay.toFixed(1)} signals/day, ` +
      `${(shared * 100).toFixed(1)}% of outcome variance is shared across a day`);
    console.log(`  ${''.padEnd(15)} -> ${avgPerDay.toFixed(0)} same-day signals behave like ` +
      `~${Math.max(1, (avgPerDay * (1 - shared))).toFixed(1)} independent bets`);
  });
}

main();
