#!/usr/bin/env node
/* ==========================================================================
   Wicktor — does stop WIDTH predict whether a signal pays?

   The journal surfaced EXCELLENT signals carrying 1R of 4-20% of price,
   against the ~0.95% the stop/target sweep reported. The sweep was not
   measuring what production computes: it took levelsBelow[0] unfiltered
   (a level can sit on the wrong side of a 5M close, giving a meaninglessly
   small distance) and buffered with the 5M ATR, while riskReward() filters
   to levels genuinely against the trade and buffers/floors with the STOP
   timeframe's ATR — on 1H, several times larger.

   Both backtests read r.riskReward, so the validated numbers do describe
   production. What was never checked is whether the WIDE tail pays: a 3R
   target on a 20% stop needs a 60% move inside the hold window, which is
   not a scalp. This buckets the same measurement by risk width to find out.

   Direction-balanced throughout. Read-only.

   Usage: node tools/analyze-riskpct.js [fixture] [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;

const WIN = 200, WARMUP = 90, HOLD = 48;
const TARGET_MULTS = [0.5, 0.75, 1, 1.5, 2, 3];
const FEE_TAKER = 0.11;   // % of notional, round trip
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

function ctxAt(candles, ts) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
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
        const stop = entryPx - dir * risk;
        const end = Math.min(i + 1 + HOLD, m5.length - 1);
        const riskPct = risk / entryPx * 100;

        // The stop is production's; only the TARGET varies. 3R was chosen
        // against the sweep's much narrower stops, and was never re-tested
        // once the stop moved to 1H structure — with 1R at 2-20% of price a
        // 3R objective is a 6-60% move inside four hours.
        const byTarget = {};
        for (const mult of TARGET_MULTS) {
          const target = entryPx + dir * risk * mult;
          let out = (dir * (m5[end].c - entryPx)) / risk, reason = 'timeout';
          for (let k = i + 2; k <= end; k++) {
            const b = m5[k];
            if (dir === 1 ? b.l <= stop : b.h >= stop) { out = -1; reason = 'stop'; break; }
            if (dir === 1 ? b.h >= target : b.l <= target) { out = mult; reason = 'target'; break; }
          }
          byTarget[mult] = { r: out, reason, net: out - FEE_TAKER / riskPct };
        }

        const base = byTarget[rr.ratio] || byTarget[3];
        rows.push({
          dir, r: base.r, reason: base.reason, riskPct,
          // Fees scale INVERSELY with stop width: a wide stop is cheap in R.
          net: base.net, byTarget,
          floored: !!rr.stopWidenedToFloor, structural: !!rr.stopFromStructure
        });
      }
    }
  }
  return rows;
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);

// Long and short averaged separately: in a trending window a long-heavy
// bucket otherwise reads as edge.
function balanced(rows, key) {
  const b = mean(rows.filter(r => r.dir === 1).map(r => r[key]));
  const s = mean(rows.filter(r => r.dir === -1).map(r => r[key]));
  return (b != null && s != null) ? (b + s) / 2 : null;
}

function report(label, rows) {
  const n = rows.length;
  if (!n) { console.log(`${label.padEnd(14)} n=0`); return; }
  const winPct = rows.filter(r => r.r > 0).length / n * 100;
  const tgt = rows.filter(r => r.reason === 'target').length / n * 100;
  const to = rows.filter(r => r.reason === 'timeout').length / n * 100;
  console.log(
    `${label.padEnd(14)} n=${String(n).padStart(5)}  win ${winPct.toFixed(1).padStart(5)}%` +
    `  tgt ${tgt.toFixed(1).padStart(5)}%  timeout ${to.toFixed(1).padStart(5)}%` +
    `  gross ${sg(balanced(rows, 'r'))}  NET ${sg(balanced(rows, 'net'))}`
  );
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const full = path.join(__dirname, 'fixtures', file);
  console.log(`\n${file}  minScore=${minScore}  (direction-balanced, NET of ${FEE_TAKER}% taker)`);

  const rows = collect(full, minScore);
  console.log(`${'-'.repeat(96)}`);
  report('ALL', rows);

  const sorted = [...rows].map(r => r.riskPct).sort((a, b) => a - b);
  const q = p => sorted[Math.floor(sorted.length * p)];
  console.log(`\nriskPct distribution: p10 ${q(0.1)?.toFixed(2)}%  median ${q(0.5)?.toFixed(2)}%  p90 ${q(0.9)?.toFixed(2)}%  max ${sorted[sorted.length - 1]?.toFixed(2)}%`);

  console.log('\nby 1R width (this is the question — does the wide tail pay?):');
  const BUCKETS = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 8], [8, 100]];
  for (const [lo, hi] of BUCKETS) {
    report(`${lo}-${hi}%`, rows.filter(r => r.riskPct >= lo && r.riskPct < hi));
  }

  console.log('\nby stop origin:');
  report('structural', rows.filter(r => r.structural && !r.floored));
  report('floored', rows.filter(r => r.floored));
  report('fallback', rows.filter(r => !r.structural));

  console.log('\ntarget multiple, holding production stops fixed:');
  for (const m of TARGET_MULTS) {
    const sub = rows.filter(r => r.byTarget[m]).map(r => ({
      dir: r.dir, riskPct: r.riskPct,
      r: r.byTarget[m].r, net: r.byTarget[m].net, reason: r.byTarget[m].reason
    }));
    report(`${m}R`, sub);
  }

  console.log('\nbest target WITHIN each risk bucket (NET, balanced):');
  for (const [lo, hi] of BUCKETS) {
    const inb = rows.filter(r => r.riskPct >= lo && r.riskPct < hi);
    if (!inb.length) continue;
    const line = TARGET_MULTS.map(m => {
      const sub = inb.map(r => ({ dir: r.dir, net: r.byTarget[m].net }));
      const v = balanced(sub, 'net');
      return `${m}R ${v == null ? '  --' : sg(v)}`;
    }).join('  ');
    console.log(`  ${(lo + '-' + hi + '%').padEnd(9)} ${line}`);
  }

  console.log('\nMINIMUM risk floor x target (net, balanced) -- fees make tiny stops unwinnable:');
  console.log('  floor     ' + TARGET_MULTS.map(m => (m + 'R').padStart(8)).join(''));
  for (const floor of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5]) {
    const inb = rows.filter(r => r.riskPct >= floor);
    const line = TARGET_MULTS.map(m => {
      const v = balanced(inb.map(r => ({ dir: r.dir, net: r.byTarget[m].net })), 'net');
      return (v == null ? '--' : sg(v)).padStart(8);
    }).join('');
    console.log(`  >=${String(floor).padEnd(5)} n=${String(inb.length).padStart(4)}${line}`);
  }

  console.log('\nCONSTANT PRICE-MOVE target (target% of entry), floor >=1%:');
  console.log('  move      ' + ['n', 'win', 'tgt', 'gross', 'NET'].map(h => h.padStart(9)).join(''));
  for (const movePct of [1, 1.5, 2, 3, 4, 5]) {
    const sub = rows.filter(r => r.riskPct >= 1).map(r => {
      const mult = movePct / r.riskPct;            // same price move, expressed in R
      const near = TARGET_MULTS.reduce((a, b) => Math.abs(b - mult) < Math.abs(a - mult) ? b : a);
      return { dir: r.dir, r: r.byTarget[near].r, net: r.byTarget[near].net, reason: r.byTarget[near].reason };
    });
    const n = sub.length;
    const win = sub.filter(x => x.r > 0).length / n * 100;
    const tgt = sub.filter(x => x.reason === 'target').length / n * 100;
    console.log(`  ${(movePct + '%').padEnd(9)} ${String(n).padStart(8)} ${win.toFixed(1).padStart(8)}% ${tgt.toFixed(1).padStart(8)}% ${sg(balanced(sub, 'r')).padStart(8)} ${sg(balanced(sub, 'net')).padStart(8)}`);
  }

  console.log();
}

main();
