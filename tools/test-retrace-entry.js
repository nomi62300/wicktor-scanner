#!/usr/bin/env node
/* ==========================================================================
   Wicktor — does entering on a retracement beat entering at the signal?

   Prompted by the "2.6" write-ups. The 2.6 number itself carries no
   information: 1/2.6 = 0.3846 and the Fibonacci 0.382 retracement is
   0.381966, a difference of 0.26% of the leg — on a 48-point range, a tenth
   of a point. The articles say so themselves. Renaming a constant is not a
   method, and neither article offers a backtest.

   But one mechanic underneath it IS worth testing here, because it attacks
   our single largest measured problem. We take signals at market on the
   next open and pay the TAKER fee both ways; fees are what stand between
   this model and a real edge. A resting limit order at a retracement pays
   MAKER on entry and fills at a better price, which shrinks risk and
   therefore raises R. The cost is that some trades never come back and are
   simply missed.

   So: fill rate versus fill quality. Measured, direction-balanced, with
   unfilled signals counted as ZERO rather than quietly dropped — dropping
   them would be the same survivorship trick as only reporting A+ setups.

   Usage: node tools/test-retrace-entry.js [fixture] [minScore] [retrace] [waitBars]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;

const WIN = 200, WARMUP = 90, HOLD = 48;
const IMPULSE_LOOKBACK = 12;      // 5M bars (1h) — the leg that just moved
const FEE_TAKER = 0.055;          // % per side
const FEE_MAKER = 0.01;           // % per side
const TARGET_PCT = 4.0;           // matches RR.targetPct

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

/** Walk forward from a fill and return realised R. */
function runTrade(m5, from, dir, entry, stop, target, lastIdx) {
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  const end = Math.min(from + HOLD, lastIdx);
  for (let k = from + 1; k <= end; k++) {
    const b = m5[k];
    if (dir === 1 ? b.l <= stop : b.h >= stop) return { r: -1, reason: 'stop', risk };
    if (dir === 1 ? b.h >= target : b.l <= target) {
      return { r: Math.abs(target - entry) / risk, reason: 'target', risk };
    }
  }
  return { r: (dir * (m5[end].c - entry)) / risk, reason: 'timeout', risk };
}

function collect(file, minScore, retrace, waitBars) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const w of fx.windows) {
    for (const coin of w.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + waitBars + 6) continue;
      const open = { 1: -1, '-1': -1 };
      for (let i = WARMUP; i < m5.length - HOLD - waitBars - 1; i++) {
        const ts = m5[i].t, c15 = ctxAt(m15, ts), c1h = ctxAt(h1, ts);
        if (c15 < WARMUP || c1h < 60) continue;
        const sn = [I.analyzeTimeframe(wd(h1, c1h)), I.analyzeTimeframe(wd(m15, c15)), I.analyzeTimeframe(wd(m5, i))];
        if (!sn[0] || !sn[2]) continue;
        const r = Scoring.evaluateSnapshots(sn, { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < minScore || !r.riskReward) continue;
        if (i < open[r.setupDirection]) continue;
        open[r.setupDirection] = i + HOLD + waitBars;

        const rr = r.riskReward, dir = r.setupDirection;
        const stopPx = rr.stop;

        // ---- baseline: market entry at the next open, taker in and out ----
        const mktEntry = m5[i + 1].o;
        const mktTarget = mktEntry + dir * mktEntry * (TARGET_PCT / 100);
        const base = runTrade(m5, i + 1, dir, mktEntry, stopPx, mktTarget, m5.length - 1);
        if (!base) continue;
        const baseRiskPct = base.risk / mktEntry * 100;
        const baseNet = base.r - (2 * FEE_TAKER) / baseRiskPct;

        // ---- retracement limit: the impulse that produced the signal ------
        let hi = -Infinity, lo = Infinity;
        for (let k = Math.max(0, i - IMPULSE_LOOKBACK + 1); k <= i; k++) {
          if (m5[k].h > hi) hi = m5[k].h;
          if (m5[k].l < lo) lo = m5[k].l;
        }
        const range = hi - lo;
        const limitPx = dir === 1 ? hi - range * retrace : lo + range * retrace;

        // Only a fill that is genuinely better than the market price counts;
        // otherwise the "limit" would have been marketable and paid taker.
        const better = dir === 1 ? limitPx < mktEntry : limitPx > mktEntry;
        let fillIdx = -1;
        if (better && range > 0) {
          for (let k = i + 1; k <= Math.min(i + waitBars, m5.length - 1); k++) {
            const b = m5[k];
            // A bar that reaches the stop before the limit invalidates it.
            if (dir === 1 ? b.l <= stopPx : b.h >= stopPx) break;
            if (dir === 1 ? b.l <= limitPx : b.h >= limitPx) { fillIdx = k; break; }
          }
        }

        let limNet = 0, filled = false, limR = 0;
        if (fillIdx >= 0) {
          const limTarget = limitPx + dir * limitPx * (TARGET_PCT / 100);
          const lim = runTrade(m5, fillIdx, dir, limitPx, stopPx, limTarget, m5.length - 1);
          if (lim) {
            filled = true;
            limR = lim.r;
            const limRiskPct = lim.risk / limitPx * 100;
            // maker in, taker out — the conservative reading of a limit entry
            limNet = lim.r - (FEE_MAKER + FEE_TAKER) / limRiskPct;
          }
        }

        rows.push({
          dir, baseR: base.r, baseNet, baseRiskPct,
          filled, limR: filled ? limR : 0, limNet: filled ? limNet : 0,
          limRFilled: filled ? limR : null, limNetFilled: filled ? limNet : null
        });
      }
    }
  }
  return rows;
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const retrace = Number(process.argv[4] || (1 / 2.6));
  const waitBars = Number(process.argv[5] || 12);
  const full = path.join(__dirname, 'fixtures', file);

  console.log(`\n${file}  minScore=${minScore}  retrace=${retrace.toFixed(4)} (1/2.6=${(1 / 2.6).toFixed(4)}, fib=0.3820)  wait=${waitBars} bars`);
  const rows = collect(full, minScore, retrace, waitBars);
  const filled = rows.filter(r => r.filled);
  console.log('-'.repeat(88));
  console.log(`signals ${rows.length}   filled ${filled.length} (${(filled.length / rows.length * 100).toFixed(1)}%)   missed ${rows.length - filled.length}`);

  console.log(`\n${'strategy'.padEnd(34)} ${'n'.padStart(5)}  ${'win%'.padStart(6)}  ${'gross'.padStart(8)}  ${'NET'.padStart(8)}`);
  const line = (label, set, rKey, netKey) => {
    if (!set.length) return console.log(`${label.padEnd(34)} ${'0'.padStart(5)}`);
    const win = set.filter(r => r[rKey] > 0).length / set.length * 100;
    console.log(`${label.padEnd(34)} ${String(set.length).padStart(5)}  ${win.toFixed(1).padStart(6)}  ${sg(balanced(set, rKey)).padStart(8)}  ${sg(balanced(set, netKey)).padStart(8)}`);
  };

  line('market entry (current, taker)', rows, 'baseR', 'baseNet');
  line('retrace limit, missed = 0R', rows, 'limR', 'limNet');
  line('retrace limit, filled only', filled, 'limRFilled', 'limNetFilled');
  line('market entry, same filled subset', filled, 'baseR', 'baseNet');
  console.log('\n"filled only" flatters the limit by hiding the trades it never got into;');
  console.log('"missed = 0R" is the honest comparison. The last row is the like-for-like control.\n');
}

main();
