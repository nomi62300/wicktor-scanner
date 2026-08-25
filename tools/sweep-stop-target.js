#!/usr/bin/env node
/* ==========================================================================
   Wicktor — stop/target sweep, reported NET of fees

   The backtest showed a real gross edge (+0.082R) that fees erase on 5M:
   median 1R there is 0.255% of price against a 0.110% taker round trip, so
   fees cost 0.43R per trade.

   The arithmetic that matters:

       fees in R  =  (fee % of price) / (1R as % of price)

   Only the STOP appears in that. Moving the target does nothing to fee
   burden — it only trades win-rate against payoff. So this sweeps both
   axes and reports NET, to separate "does this pay more" from "does this
   survive costs", which are different questions that a gross-only table
   silently conflates.

   Stops can be sourced from a HIGHER timeframe than the entry: enter with
   5M precision, risk to 15M or 1H structure. That widens 1R in percentage
   terms without abandoning fast entries, which is the only lever that
   actually moves the fee ratio.

   Direction-balanced, both-touched counts as a stop, timeouts marked to
   market — same conventions as every other measurement here.
   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;

const WIN = 200, WARMUP = 90, HOLD = 24;
const TAKER = 0.055 * 2;   // % of notional, round trip
const MAKER = 0.020 * 2;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (a, e) => a.slice(Math.max(0, e - WIN + 1), e + 1);

/** Exact OHLC roll-up of `n` consecutive bars — used to synthesise 30M. */
function aggregate(candles, n) {
  const out = [];
  for (let i = 0; i + n <= candles.length; i += n) {
    const g = candles.slice(i, i + n);
    out.push({
      t: g[0].t, o: g[0].o,
      h: Math.max(...g.map(c => c.h)), l: Math.min(...g.map(c => c.l)),
      c: g[g.length - 1].c, v: g.reduce((s, c) => s + c.v, 0)
    });
  }
  return out;
}
function ctxIndexAt(c, ts) {
  let lo = 0, hi = c.length - 1, b = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].t <= ts) { b = m; lo = m + 1; } else hi = m - 1; }
  return b;
}

// riskDist from a chosen source, in PRICE units
function stopDistance(kind, snaps, entry, atr5) {
  if (kind.startsWith('atr')) return parseFloat(kind.slice(3)) * atr5;
  const s = snaps[{ s5: 2, s15: 1, s30: 3, s1h: 0, s4h: 4 }[kind]];
  if (!s) return null;
  return { belowFirst: s.levelsBelow, aboveFirst: s.levelsAbove };
}

function main() {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-deep.json'), 'utf8'));
  const STOPS = ['s5', 's15', 's30', 's1h', 's4h', 'atr2', 'atr4', 'atr6'];
  const TARGETS = ['struct2', '1R', '1.25R', '1.5R', '2R', '3R'];
  const acc = {};

  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15),
            h1 = hydrate(coin.candles.h1), h4 = hydrate(coin.candles.h4);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + 5) continue;
      // 30M isn't captured; rolling two 15M bars into one is an exact OHLC
      // aggregation, not an approximation, so it costs nothing to add.
      const m30 = aggregate(m15, 2);
      const open = {};

      for (let i = WARMUP; i < m5.length - HOLD; i++) {
        const ts = m5[i].t;
        const c15 = ctxIndexAt(m15, ts), c1h = ctxIndexAt(h1, ts);
        if (c15 < WARMUP || c1h < 60) continue;
        const c30 = ctxIndexAt(m30, ts), c4h = h4 ? ctxIndexAt(h4, ts) : -1;
        // indices 3/4 are extra stop sources only — evaluateSnapshots reads
        // 0..2, so appending cannot change what the model scores.
        const snaps = [
          I.analyzeTimeframe(windowed(h1, c1h)),
          I.analyzeTimeframe(windowed(m15, c15)),
          I.analyzeTimeframe(windowed(m5, i)),
          c30 >= 40 ? I.analyzeTimeframe(windowed(m30, c30)) : null,
          (h4 && c4h >= 40) ? I.analyzeTimeframe(windowed(h4, c4h)) : null
        ];
        if (!snaps[0] || !snaps[2]) continue;
        const r = Scoring.evaluateSnapshots(snaps, { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < 50) continue;
        const dir = r.setupDirection, entry = snaps[2].close, atr5 = snaps[2].atr;
        if (!atr5) continue;

        for (const sk of STOPS) {
          const src = stopDistance(sk, snaps, entry, atr5);
          let riskDist = null;
          if (typeof src === 'number') riskDist = src;
          else if (src) {
            const lv = dir === 1 ? src.belowFirst : src.aboveFirst;
            if (lv && lv.length) riskDist = Math.abs(entry - lv[0]) + 0.25 * atr5;
          }
          if (!riskDist || riskDist <= 0) continue;

          for (const tk of TARGETS) {
            let rewardDist;
            if (tk === 'struct2') {
              const lv = dir === 1 ? snaps[2].levelsAbove : snaps[2].levelsBelow;
              if (!lv || lv.length < 2) continue;
              rewardDist = Math.abs(lv[1] - entry);
            } else rewardDist = parseFloat(tk) * riskDist;
            if (!rewardDist || rewardDist <= 0) continue;

            const key = `${sk}|${tk}`;
            open[key] = open[key] || { 1: -1, '-1': -1 };
            if (i < open[key][dir]) continue;
            open[key][dir] = i + HOLD;

            const stop = entry - dir * riskDist, target = entry + dir * rewardDist;
            const end = Math.min(i + HOLD, m5.length - 1);
            let out = (dir * (m5[end].c - entry)) / riskDist;
            for (let k = i + 1; k <= end; k++) {
              const b = m5[k];
              if (dir === 1 ? b.l <= stop : b.h >= stop) { out = -1; break; }
              if (dir === 1 ? b.h >= target : b.l <= target) { out = rewardDist / riskDist; break; }
            }
            acc[key] = acc[key] || { 1: [], '-1': [], riskPct: [] };
            acc[key][dir].push(out);
            acc[key].riskPct.push(riskDist / entry * 100);
          }
        }
      }
    }
  }

  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const med = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const rows = [];
  for (const [key, d] of Object.entries(acc)) {
    if (d[1].length < 40 || d['-1'].length < 40) continue;
    const gross = (mean(d[1]) + mean(d['-1'])) / 2;
    const riskPct = med(d.riskPct);
    const all = d[1].concat(d['-1']);
    rows.push({
      key, n: all.length, win: all.filter(x => x > 0).length / all.length * 100,
      riskPct, gross, feeT: TAKER / riskPct, feeM: MAKER / riskPct,
      netT: gross - TAKER / riskPct, netM: gross - MAKER / riskPct
    });
  }
  rows.sort((a, b) => b.netM - a.netM);

  const sg = x => (x >= 0 ? '+' : '') + x.toFixed(3);
  console.log('Stop/target sweep on 5M entries — NET of fees, direction-balanced');
  console.log(`taker round trip ${TAKER}% | maker ${MAKER}% of notional\n`);
  console.log(`${'stop|target'.padEnd(16)}${'n'.padStart(6)}${'win%'.padStart(7)}${'1R%'.padStart(8)}${'gross'.padStart(9)}${'feeT'.padStart(8)}${'NET taker'.padStart(11)}${'NET maker'.padStart(11)}`);
  console.log('-'.repeat(76));
  rows.slice(0, 22).forEach(r => console.log(
    r.key.padEnd(16) + String(r.n).padStart(6) + r.win.toFixed(1).padStart(7) +
    r.riskPct.toFixed(3).padStart(8) + sg(r.gross).padStart(9) +
    r.feeT.toFixed(2).padStart(8) + sg(r.netT).padStart(11) + sg(r.netM).padStart(11)));
  console.log('\ns5/s15/s1h = stop at that timeframe\'s structure; atrN = N x 5M ATR.');
  console.log('Entries are always 5M. Only the STOP moves the fee ratio.');
}

main();
