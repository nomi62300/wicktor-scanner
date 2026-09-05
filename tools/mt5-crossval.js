#!/usr/bin/env node
/* ==========================================================================
   Wicktor — cross-instrument validation of the Arm B config

   The gold run selected `stop 3xATR, adx>=20, +H1 agreement` in-sample and
   it then held out-of-sample. That is encouraging and nowhere near
   sufficient: the OOS slice was 44 trades, drawn from a 12-cell grid. With
   that many cells, the best one looking good is close to expected under
   pure noise, and 44 trades cannot separate +0.26R from zero.

   So this does not re-fit anything. It takes that ONE frozen config and
   runs it, unchanged, across instruments it was never chosen on. That is a
   genuinely new out-of-sample dimension and a far stronger test than more
   bars of the same series: gold's own future is correlated with gold's
   past, but the German index is not.

   Reported per instrument AND pooled, with 95% confidence intervals,
   direction-balanced. The question is not "is any instrument positive" —
   with 12 instruments one will be. It is whether the POOLED estimate
   excludes zero and whether the sign is consistent across venues.

   Read-only. Usage: node tools/mt5-crossval.js [holdBars]
   ========================================================================== */

const S = require('./mt5-squeeze.js');

// Frozen. Selected on XAUUSD in-sample only, never touched again.
const CONFIG = { stopAtr: 3.0, adxMin: 20, requireH1: true };
const TARGET_R = 2.0;

// Liquid instruments across asset classes. XAGUSD is deliberately included
// as a COST CONTROL: its spread is ~0.11% of price (18x gold's), so if the
// cost model is working, silver should underperform on NET even where its
// gross is comparable.
const SYMBOLS = [
  'XAUUSD.s', 'XAGUSD.s',
  'NAS100.s', 'SP500.s', 'DJ30.s', 'GER40.s', 'UK100.s', 'HK50.s', 'Nikkei225.s', 'US2000.s',
  'EURUSD.s', 'GBPUSD.s', 'USDJPY.s', 'AUDUSD.s', 'USDCAD.s', 'EURJPY.s'
];

function ci95(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  const se = Math.sqrt(v / n);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n };
}
// Direction-balanced point estimate, and its SE from the two arms.
function balancedCI(list) {
  const b = list.filter(x => x.dir === 1).map(x => x.net);
  const s = list.filter(x => x.dir === -1).map(x => x.net);
  if (b.length < 2 || s.length < 2) return null;
  const cb = ci95(b), cs = ci95(s);
  const m = (cb.m + cs.m) / 2;
  const se = Math.sqrt(cb.se * cb.se + cs.se * cs.se) / 2;
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n: list.length, nb: b.length, ns: s.length };
}
const sg = x => x == null ? '   --' : (x >= 0 ? '+' : '') + x.toFixed(4);

function run(symbol, hold, plan) {
  const m5 = S.loadCsv(symbol, 'M5'), h1 = S.loadCsv(symbol, 'H1');
  if (!m5 || !h1 || m5.length < 5000) return null;
  S.setPointSize(S.pointFor(symbol));
  const ind = S.buildIndicators(m5), h1ind = S.buildIndicators(h1);
  const sigs = S.collect(m5, ind, h1, h1ind, CONFIG, hold);
  return S.simulate(sigs, m5, hold, TARGET_R, plan);
}

function main() {
  const hold = parseInt(process.argv[2], 10) || 48;
  console.log(`CROSS-INSTRUMENT VALIDATION — frozen config: stop ${CONFIG.stopAtr}xATR, ` +
    `adx>=${CONFIG.adxMin}, H1 agreement required, target ${TARGET_R}R, ${hold}-bar hold`);
  console.log('Config was selected on XAUUSD in-sample ONLY. Nothing is re-fitted here.\n');

  for (const [planName, plan] of [['4-rung ladder (vendor)', S.LADDER], ['single exit at 2R', S.SINGLE]]) {
    console.log(`\n${'='.repeat(78)}\n${planName}`);
    console.log(`  ${'symbol'.padEnd(14)}${'n'.padStart(6)}${'L/S'.padStart(9)}${'win%'.padStart(7)}` +
      `${'cost'.padStart(8)}${'BAL-NET'.padStart(10)}${'95% CI'.padStart(22)}`);
    const pooled = [];
    for (const sym of SYMBOLS) {
      let o;
      try { o = run(sym, hold, plan); } catch (e) { continue; }
      if (!o || o.length < 20) {
        console.log(`  ${sym.padEnd(14)}${String(o ? o.length : 0).padStart(6)}   (too few)`);
        continue;
      }
      pooled.push(...o.map(x => ({ ...x, sym })));
      const c = balancedCI(o);
      const win = o.filter(x => x.net > 0).length / o.length * 100;
      const cost = o.reduce((a, b) => a + b.costR, 0) / o.length;
      console.log(`  ${sym.padEnd(14)}${String(o.length).padStart(6)}` +
        `${(c ? c.nb + '/' + c.ns : '-').padStart(9)}${win.toFixed(1).padStart(7)}` +
        `${cost.toFixed(4).padStart(8)}${sg(c && c.m).padStart(10)}` +
        `${(c ? `[${sg(c.lo)},${sg(c.hi)}]` : '').padStart(22)}`);
    }

    const pc = balancedCI(pooled);
    console.log(`  ${'-'.repeat(66)}`);
    if (pc) {
      console.log(`  ${'POOLED'.padEnd(14)}${String(pooled.length).padStart(6)}` +
        `${(pc.nb + '/' + pc.ns).padStart(9)}${''.padStart(7)}${''.padStart(8)}` +
        `${sg(pc.m).padStart(10)}${`[${sg(pc.lo)},${sg(pc.hi)}]`.padStart(22)}`);
      console.log(`  excludes zero: ${pc.lo > 0 ? 'YES (positive)' : pc.hi < 0 ? 'YES (negative)' : 'NO — indistinguishable from noise'}`);
      const pos = new Set(pooled.filter(x => x.net > 0).map(x => x.sym));
      const bySym = {};
      pooled.forEach(x => { (bySym[x.sym] = bySym[x.sym] || []).push(x.net); });
      const signs = Object.entries(bySym).map(([s, v]) => v.reduce((a, b) => a + b, 0) / v.length > 0 ? 1 : -1);
      console.log(`  instruments with positive mean: ${signs.filter(x => x > 0).length}/${signs.length}` +
        ` (coin-flip expectation ${(signs.length / 2).toFixed(1)})`);
    }
  }
  console.log(`\n${'='.repeat(78)}`);
  console.log('A single positive instrument proves nothing — with 16 venues, some will');
  console.log('be positive by chance. What matters is the POOLED interval and whether');
  console.log('the sign is consistent. Silver is the cost control: high spread should');
  console.log('visibly punish its NET relative to its gross.');
}

main();
