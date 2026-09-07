#!/usr/bin/env node
/* ==========================================================================
   Wicktor — stop-and-reverse test

   Owner's idea: when an open position moves against us and reaches some
   fraction of its OWN stop distance, place a pending order in the OPPOSITE
   direction a little past the stop. If the stop is hit and price keeps
   going, that pending order fills and we ride the continuation with its
   own stop/target, instead of the move just being a loss.

   This tests a specific, falsifiable market behavior: does price that
   reaches a stop tend to CONTINUE (momentum -- the idea works), or tend to
   SNAP BACK shortly after (a stop-hunt/liquidity-grab pattern -- the idea
   compounds the original loss with a second one, at double the fees)?
   Both are real, well-documented behaviors; we don't know which is true
   for OUR setups without measuring it.

   Deliberately mechanical, matching how the idea was described: the
   reversal fires on PRICE ALONE (does it reach the pending entry level),
   with no scoring re-check. Two target variants, since the owner's own
   sketch showed a real support level, not an arbitrary R-multiple:
     - fixed R-multiples of the reversal's own risk
     - the nearest OPPOSING structural level (nearestLevels(), the exact
       function riskReward() itself uses for the original stop)

   Reversal risk = same PRICE distance as the original trade's risk, so R
   units are directly comparable and addable between the two legs. Entry
   buffer past the stop is fixed at 0.1R (not swept -- the grid is already
   trigger-fraction x target-variant; adding a third axis multiplies cells
   for little expected payoff before knowing the core idea has ANY legs).

   Net of TWO full round-trip fees when the reversal fires -- it is a
   second, independent trade, not a continuation of the first's cost.

   Uses the FIXED alignment (tools/lib/align.js) for generating the
   original signals -- see project memory on why the old alignment would
   have silently inflated everything downstream of it.

   Usage: node tools/test-stop-reversal.js [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48;
const TAKER = 0.11;               // % round trip, matches every other tool here
const BUFFER_R = 0.1;             // reversal entry sits this far past the stop
// The pending reversal order can fill any time up to HOLD bars after entry
// (see revExpired below), then gets its own HOLD bars to resolve: HOLD*2
// covers every case exactly. A signal too close to the fixture's end is
// dropped outright (see the loop bound below) rather than truncated, so a
// running-out-of-data signal can never silently look like "never fired".
const MAX_RUNWAY = HOLD * 2;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

function collect(fx, minScore, triggerFrac, targetR, targetVariant) {
  const rows = [];
  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + MAX_RUNWAY + 5) continue;
      const openUntil = { 1: -1, '-1': -1 };
      let cache15 = { idx: -1, snap: null }, cache1h = { idx: -1, snap: null };

      for (let i = WARMUP; i < m5.length - MAX_RUNWAY; i++) {
        const ts = m5[i].t;
        const ci15 = closedIndexAt(m15, ts, TF_MS.m15), ci1h = closedIndexAt(h1, ts, TF_MS.h1);
        if (ci15 < WARMUP || ci1h < 60) continue;
        if (ci15 !== cache15.idx) cache15 = { idx: ci15, snap: I.analyzeTimeframe(windowed(m15, ci15)) };
        if (ci1h !== cache1h.idx) cache1h = { idx: ci1h, snap: I.analyzeTimeframe(windowed(h1, ci1h)) };
        if (!cache1h.snap || !cache15.snap) continue;
        const snapM5 = I.analyzeTimeframe(windowed(m5, i));
        if (!snapM5) continue;

        const r = Scoring.evaluateSnapshots([cache1h.snap, cache15.snap, snapM5], { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < minScore) continue;
        if (i < openUntil[r.setupDirection]) continue;
        const rr = r.riskReward;
        if (!rr || !rr.entry || !rr.stop) continue;
        openUntil[r.setupDirection] = i + HOLD;

        const out = walkWithTrigger(m5, i, r.setupDirection, rr.entry, rr.stop, triggerFrac, targetR, targetVariant);
        if (!out) continue;
        rows.push({ dir: r.setupDirection, riskPct: rr.riskPct, ...out });
      }
    }
  }
  return rows;
}

/**
 * Walks ONE original signal forward: the original leg (fixed 3R target,
 * held constant across the sweep so only the REVERSAL side varies), the
 * trigger (adverse excursion vs the original stop reaches `triggerFrac`),
 * the reversal fill (price reaches the pending entry, buffered past the
 * stop), and the reversal's own leg if it fills.
 */
function walkWithTrigger(m5, i, dir, entry, stop, triggerFrac, targetR, targetVariant) {
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  const revDir = -dir;
  const revEntryPx = stop - dir * BUFFER_R * risk;

  let origDone = false, origR = null, origReason = null;
  let armed = false, revFilled = false, revEntryBar = -1, revEntryActual = null;
  let revDone = false, revR = null, revRisk = null, revTargetDist = 0;

  const lastAvail = Math.min(i + MAX_RUNWAY, m5.length - 1);

  for (let k = i + 1; k <= lastAvail; k++) {
    const bar = m5[k];

    if (!origDone) {
      const origTargetPx = entry + dir * risk * 3.0;
      const hitStop = dir === 1 ? bar.l <= stop : bar.h >= stop;
      const hitTarget = dir === 1 ? bar.h >= origTargetPx : bar.l <= origTargetPx;
      if (hitStop) { origDone = true; origR = -1; origReason = 'stop'; }
      else if (hitTarget) { origDone = true; origR = 3.0; origReason = 'target'; }
      else if (k - i >= HOLD) { origDone = true; origR = (dir * (bar.c - entry)) / risk; origReason = 'timeout'; }
    }

    if (!armed) {
      const advPx = dir === 1 ? bar.l : bar.h;
      const advR = (dir * (entry - advPx)) / risk;
      if (advR >= triggerFrac) armed = true;
    }

    if (armed && !revFilled) {
      const reached = dir === 1 ? bar.l <= revEntryPx : bar.h >= revEntryPx;
      if (reached) {
        revFilled = true; revEntryBar = k; revEntryActual = revEntryPx; revRisk = risk;
        if (targetVariant === 'structural') {
          const ctx = windowed(m5, k);
          const frac = I.fractals(ctx);
          const atrSeries = I.atr(ctx);
          const atrV = atrSeries[atrSeries.length - 1];
          const lv = I.nearestLevels(ctx, frac, revEntryActual, atrV);
          revTargetDist = revDir === 1 ? Math.abs(lv.resistance - revEntryActual) : Math.abs(revEntryActual - lv.support);
        } else {
          revTargetDist = targetR * revRisk;
        }
      }
    }

    if (revFilled && !revDone) {
      const revStopPx = revEntryActual - revDir * revRisk;
      const revTargetPx = revEntryActual + revDir * revTargetDist;
      const hitStop = revDir === 1 ? bar.l <= revStopPx : bar.h >= revStopPx;
      const hitTarget = revDir === 1 ? bar.h >= revTargetPx : bar.l <= revTargetPx;
      if (hitStop) { revDone = true; revR = -1; }
      else if (hitTarget) { revDone = true; revR = revTargetDist / revRisk; }
      else if (k - revEntryBar >= HOLD) { revDone = true; revR = (revDir * (bar.c - revEntryActual)) / revRisk; }
    }

    // The pending reversal order stands only as long as the original setup
    // would still be "live" -- i.e. through the original's own HOLD window.
    // Past that, an unfilled order would realistically be cancelled, so
    // stop counting toward `!revFilled` and let the loop settle: nothing
    // left that can still change once the original is done AND the
    // reversal has either resolved, never armed, or given up waiting.
    const revExpired = armed && !revFilled && k - i >= HOLD;
    if (origDone && (revDone || !armed || revExpired)) break;
  }

  return {
    origR, origReason, triggered: armed, revFilled,
    revR: revFilled ? revR : null,
    revRiskPct: revFilled ? (revRisk / revEntryActual * 100) : null
  };
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);

function netRow(row) {
  const feeOrig = TAKER / row.riskPct;
  const netOrig = row.origR - feeOrig;
  if (!row.revFilled) return { netOrig, netCombined: netOrig, revNet: null };
  const feeRev = TAKER / row.revRiskPct;
  const revNet = row.revR - feeRev;
  return { netOrig, netCombined: netOrig + revNet, revNet };
}

function balancedMeanCI(list, key) {
  const arm = d => list.filter(x => x.dir === d).map(key);
  const b = arm(1), s = arm(-1);
  if (b.length < 5 || s.length < 5) return null;
  const se = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
  const m = (mean(b) + mean(s)) / 2, e = Math.sqrt(se(b) ** 2 + se(s) ** 2) / 2;
  return { m, lo: m - 1.96 * e, hi: m + 1.96 * e, n: list.length };
}

function summarize(rows) {
  const nets = rows.map(r => ({ ...r, ...netRow(r) }));
  const baseline = balancedMeanCI(nets, x => x.netOrig);
  const withRule = balancedMeanCI(nets, x => x.netCombined);
  const fired = nets.filter(x => x.revFilled);
  const revAlone = fired.length >= 10 ? balancedMeanCI(fired, x => x.revNet) : null;
  return { n: rows.length, fireRate: rows.length ? fired.length / rows.length * 100 : 0, baseline, withRule, revAlone, firedN: fired.length };
}

function line(label, s) {
  if (!s || !s.baseline) { console.log(`  ${label.padEnd(28)}(too few)`); return; }
  const delta = s.withRule.m - s.baseline.m;
  console.log(`  ${label.padEnd(28)}${String(s.n).padStart(6)}${s.fireRate.toFixed(1).padStart(7)}%` +
    `${sg(s.baseline.m).padStart(10)}${sg(s.withRule.m).padStart(10)}${sg(delta).padStart(9)}` +
    `  revAlone:${s.revAlone ? sg(s.revAlone.m) + ` [${sg(s.revAlone.lo)},${sg(s.revAlone.hi)}] n=${s.firedN}` : '(too few, n=' + s.firedN + ')'}`);
}

function main() {
  const minScore = parseFloat(process.argv[2]) || 80;
  const isFile = path.join(__dirname, 'fixtures', 'market-deep.json');
  const oosFile = path.join(__dirname, 'fixtures', 'market-oos.json');
  const fxIS = JSON.parse(fs.readFileSync(isFile, 'utf8'));
  const fxOOS = fs.existsSync(oosFile) ? JSON.parse(fs.readFileSync(oosFile, 'utf8')) : null;

  console.log(`Stop-and-reverse test — score>=${minScore}, original target fixed at 3R, reversal risk = original risk`);
  console.log(`Reversal entry = stop ${BUFFER_R}R past the original stop. Net of TWO round-trip fees when it fires.\n`);

  const triggerFracs = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const variants = [['fixed 1.5R', 1.5, 'fixed'], ['fixed 2R', 2, 'fixed'], ['fixed 3R', 3, 'fixed'], ['structural', null, 'structural']];

  console.log('IN-SAMPLE sweep (choose here, never validate here)');
  console.log(`  ${'config'.padEnd(28)}${'n'.padStart(6)}${'fire%'.padStart(8)}${'base'.padStart(10)}${'+rule'.padStart(10)}${'delta'.padStart(9)}`);
  let best = null;
  for (const frac of triggerFracs) {
    for (const [name, tR, variant] of variants) {
      const rows = collect(fxIS, minScore, frac, tR, variant);
      const s = summarize(rows);
      const label = `trig ${frac} / ${name}`;
      line(label, s);
      if (s.baseline && s.withRule) {
        const delta = s.withRule.m - s.baseline.m;
        if (!best || delta > best.delta) best = { frac, tR, variant, name, delta };
      }
    }
  }

  if (!best) { console.log('\nNo config produced enough data to compare.'); return; }
  console.log(`\n-> IS-BEST (selected before looking at OOS): trig ${best.frac} / ${best.name}  delta ${sg(best.delta)}`);

  if (fxOOS) {
    console.log('\nOUT-OF-SAMPLE — only this ONE config, run unchanged');
    console.log(`  ${'config'.padEnd(28)}${'n'.padStart(6)}${'fire%'.padStart(8)}${'base'.padStart(10)}${'+rule'.padStart(10)}${'delta'.padStart(9)}`);
    const rowsOOS = collect(fxOOS, minScore, best.frac, best.tR, best.variant);
    const sOOS = summarize(rowsOOS);
    line(`trig ${best.frac} / ${best.name}`, sOOS);
    if (sOOS.baseline && sOOS.withRule) {
      const deltaLo = sOOS.withRule.lo - sOOS.baseline.hi, deltaHi = sOOS.withRule.hi - sOOS.baseline.lo;
      console.log(`\n  Rough delta CI (conservative, treats both arms as independent): [${sg(deltaLo)}, ${sg(deltaHi)}]`);
    }
  } else {
    console.log('\nNo market-oos.json found — IS-only result, not validated.');
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('revAlone is the number that answers the actual question: net of its own');
  console.log('fee, does the reversal trade make money BY ITSELF once it fires? Negative');
  console.log('means price tends to snap back after touching the stop (stop-hunt); only');
  console.log('a positive, CI-excludes-zero revAlone at real n means continuation is real.');
}

module.exports = { walkWithTrigger, netRow, HOLD, BUFFER_R };
if (require.main === module) main();
