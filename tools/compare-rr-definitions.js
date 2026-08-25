#!/usr/bin/env node
/* ==========================================================================
   Wicktor — which stop/target definition is actually right?

   Simulates each candidate stop/target pairing forward and measures what it
   would have paid: enter at the close of bar i, walk bars i+1..i+H, see
   whether stop or target is touched first.

   RUNS BOTH DIRECTIONS AND AVERAGES. The first version of this script was
   long-only, and the fixture window carries +11.6% mean drift on 1H with 80%
   of coins up — which produced a fake +0.79R "expectancy" on random entries
   and ranked wide ATR targets best purely because they harvested that drift.
   Drift helps longs and hurts shorts symmetrically, so the mean of the two
   sides is drift-neutral. Long and short are also reported separately, so if
   they disagree wildly you can see the bias rather than average it away.

   Conventions, deliberately pessimistic:
     - a bar touching BOTH levels counts as a STOP (intrabar order is
       unknowable from OHLC)
     - unresolved trades are marked to market at the horizon, not discarded;
       discarding them would quietly drop every slow-bleed loser
     - entry is the close of a CLOSED bar, consistent with Phase B1
     - no fees or slippage, so real expectancy is worse than shown

   Nothing from the future enters level construction; only candles[0..i].
   Read-only.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market-sample.json'), 'utf8'));

const H = 24;
const MIN_BARS = 60;
const MIN_STOP_ATR = 0.4;

// `against` = levels on the losing side, nearest first (stop candidates)
// `toward`  = levels on the winning side, nearest first (target candidates)
// distances are unsigned; direction is applied by the caller.
const STOPS = {
  'structure':     ({ against }) => against[0] ?? null,
  'structure-buf': ({ against, atr }) => against.length ? against[0] + 0.25 * atr : null,
  'jaw':           ({ jawDist }) => jawDist ?? null,
  'atr1.0':        ({ atr }) => 1.0 * atr,
  'atr1.5':        ({ atr }) => 1.5 * atr
};
const TARGETS = {
  'structure-1': ({ toward }) => toward[0] ?? null,
  'structure-2': ({ toward }) => toward[1] ?? null,
  'atr2.0':      ({ atr }) => 2.0 * atr,
  'atr3.0':      ({ atr }) => 3.0 * atr,
  '2R':          ({ riskDist }) => riskDist != null ? 2 * riskDist : null,
  '3R':          ({ riskDist }) => riskDist != null ? 3 * riskDist : null
};

function simulate(candles, i, dir, entry, stopPrice, targetPrice, riskDist) {
  const end = Math.min(i + H, candles.length - 1);
  for (let k = i + 1; k <= end; k++) {
    const bar = candles[k];
    const hitStop = dir === 1 ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = dir === 1 ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return -1;
    if (hitTarget) return Math.abs(targetPrice - entry) / riskDist;
  }
  return (dir * (candles[end].c - entry)) / riskDist;
}

function run(tfKey, stopName, targetName) {
  const bySide = { 1: [], '-1': [] };

  for (const coin of fx.coins) {
    const cs = hydrate(coin.candles[tfKey]);
    if (!cs || cs.length < MIN_BARS + H + 2) continue;
    const closed = cs.slice(0, -1);
    const frac = I.fractals(closed);
    const atrSeries = I.atr(closed);
    const { jaw } = I.alligator(closed);

    for (let i = MIN_BARS; i < closed.length - H; i++) {
      const entry = closed[i].c;
      const atr = atrSeries[i];
      if (!atr || atr <= 0) continue;

      const upsAbove = frac.up.filter(x => x <= i - 2).map(x => closed[x].h)
        .filter(h => h > entry).sort((a, b) => a - b).map(h => h - entry);
      const downsBelow = frac.down.filter(x => x <= i - 2).map(x => closed[x].l)
        .filter(l => l < entry).sort((a, b) => b - a).map(l => entry - l);

      for (const dir of [1, -1]) {
        const against = dir === 1 ? downsBelow : upsAbove;
        const toward = dir === 1 ? upsAbove : downsBelow;
        const jawV = jaw[i];
        const jawDist = jawV != null && (dir === 1 ? jawV < entry : jawV > entry)
          ? Math.abs(entry - jawV) : null;

        const ctx = { against, toward, atr, jawDist, riskDist: null };
        const riskDist = STOPS[stopName](ctx);
        if (riskDist == null || riskDist <= 0 || riskDist < MIN_STOP_ATR * atr) continue;
        ctx.riskDist = riskDist;

        const rewardDist = TARGETS[targetName](ctx);
        if (rewardDist == null || rewardDist <= 0) continue;

        const stopPrice = entry - dir * riskDist;
        const targetPrice = entry + dir * rewardDist;
        bySide[dir].push({
          r: simulate(closed, i, dir, entry, stopPrice, targetPrice, riskDist),
          rr: rewardDist / riskDist
        });
      }
    }
  }

  const stat = arr => {
    if (!arr.length) return null;
    const rs = arr.map(o => o.r);
    return {
      n: arr.length,
      exp: rs.reduce((s, v) => s + v, 0) / rs.length,
      win: rs.filter(r => r > 0).length / rs.length * 100,
      medRR: arr.map(o => o.rr).sort((a, b) => a - b)[Math.floor(arr.length / 2)]
    };
  };
  const L = stat(bySide[1]), S = stat(bySide['-1']);
  if (!L || !S) return null;
  return {
    n: L.n + S.n,
    expLong: L.exp, expShort: S.exp,
    expBalanced: (L.exp + S.exp) / 2,
    win: (L.win + S.win) / 2,
    medRR: (L.medRR + S.medRR) / 2
  };
}

const TF = process.argv[2] || 'm15';
console.log(`Stop/target comparison on ${TF} — BOTH directions, ${H}-bar horizon, ${fx.coins.length} coins`);
console.log(`ranked by drift-neutral balanced expectancy\n`);
console.log(`${'stop'.padEnd(15)}${'target'.padEnd(13)}${'n'.padStart(7)}${'medR:R'.padStart(9)}${'win%'.padStart(7)}${'long'.padStart(9)}${'short'.padStart(9)}${'BALANCED'.padStart(11)}`);
console.log('-'.repeat(80));

const rows = [];
for (const s of Object.keys(STOPS)) for (const t of Object.keys(TARGETS)) {
  const r = run(TF, s, t);
  if (r) rows.push({ s, t, ...r });
}
rows.sort((a, b) => b.expBalanced - a.expBalanced);
const sg = x => (x >= 0 ? '+' : '') + x.toFixed(3);
rows.forEach(r => console.log(
  r.s.padEnd(15) + r.t.padEnd(13) + String(r.n).padStart(7) +
  r.medRR.toFixed(2).padStart(9) + r.win.toFixed(1).padStart(7) +
  sg(r.expLong).padStart(9) + sg(r.expShort).padStart(9) + sg(r.expBalanced).padStart(11)
));
console.log();
console.log('A large long/short gap is the drift in the sample window, not an edge.');
