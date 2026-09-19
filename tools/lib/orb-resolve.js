'use strict';
/* ==========================================================================
   Wicktor — exit resolution and cost for ORB signals.

   NO NEW EXIT WALKER. js/signals.js:59 realisedR() already implements this
   repo's convention and every other number in the repo was measured with
   it: a bar that touches both the stop and the target counts as the STOP
   ("intrabar order is unknowable from OHLC, so the pessimistic reading is
   the only honest one"), and an unresolved trade is marked to market at the
   last bar's close with reason 'timeout'. PLAN_B = [[1,1,null]] is the
   single-target plan, which is what a flat 1.2R objective is.

   THE OFF-BY-ONE. tools/mt5-backtest.js enters at bar i's CLOSE and so
   walks slice(i+1, ...). Here the default fill is bar entryIdx's OPEN, so
   the walk must INCLUDE bars[entryIdx] — that bar's own high and low are
   reachable after the fill. Starting at entryIdx+1 silently discards them
   and flatters every result. tests/orb.test.js pins this.

   COST. cost_R = spreadPrice / riskPrice, one crossing per round trip,
   charged at the FILL BAR's own recorded spread — the model in
   tools/mt5-backtest.js, which exists because a single constant flatters or
   punishes depending which half of a bimodal spread you picked.

   Read-only. No I/O.
   ========================================================================== */

const path = require('path');
global.Indicators = global.Indicators || require(path.join(__dirname, '..', '..', 'js', 'indicators.js'));
const SignalJournal = require(path.join(__dirname, '..', '..', 'js', 'signals.js'));

/**
 * The last bar of this signal's window-day that is still tradeable, i.e.
 * local time before flatMin. An open position is marked to market there.
 */
function sessionEndIdx(bars, tags, entryIdx, ymd, flatMin) {
  let last = entryIdx;
  for (let k = entryIdx; k < bars.length; k++) {
    if (tags[k].ymd !== ymd) break;
    if (tags[k].minutes >= flatMin) break;
    last = k;
  }
  return last;
}

/**
 * resolve(signals, bars, tagsByWindow, windows, cfg, specs) -> trades[]
 * Each trade carries grossR, costR, netR plus enough provenance to trace it
 * back to specific bars in the CSV by hand.
 */
function resolve(signals, bars, tagsByWindow, windows, cfg, specs) {
  const byName = new Map(windows.map((w, i) => [w.name, { w, tags: tagsByWindow[i] }]));
  const trades = [];

  for (const s of signals) {
    const { w, tags } = byName.get(s.window);
    const endIdx = sessionEndIdx(bars, tags, s.entryIdx, s.ymd, w.flatMin);

    // INCLUSIVE of the fill bar. See header.
    const walk = bars.slice(s.entryIdx, endIdx + 1);
    if (!walk.length) continue;

    const out = SignalJournal.realisedR(walk, s.dir, s.entryPx, s.riskPts,
                                        SignalJournal.PLAN_B, s.targetR);
    const ep = exitPath(walk, s.dir, s.entryPx, s.riskPts, s.targetR);
    if (Math.abs(ep.r - out.r) > 1e-9 || ep.reason !== out.reason) {
      throw new Error(`orb-resolve: exitPath disagrees with realisedR on ${s.window} ${s.ymd} ` +
        `(${ep.r}/${ep.reason} vs ${out.r}/${out.reason}). One of them is wrong; do not trust either.`);
    }

    const spreadPts = bars[s.entryIdx].spreadPts != null
      ? bars[s.entryIdx].spreadPts
      : (cfg.assumedSpreadPts != null ? cfg.assumedSpreadPts : 0);
    const spreadPrice = spreadPts * specs.pointSize;
    const costR = s.riskPts > 0 ? spreadPrice / s.riskPts : 0;

    // How often the pessimistic convention actually bound: a bar that
    // reached both levels. This number IS the size of the bias.
    const bothTouched = countBothTouched(walk, s.dir, s.entryPx, s.riskPts, s.targetR);

    trades.push({
      ...s,
      entryTs: bars[s.entryIdx].t, exitIdxMax: endIdx,
      grossR: out.r, reason: out.reason,
      exitIdx: s.entryIdx + ep.exitOffset, mtm: ep.mtm,
      spreadPts, spreadPrice: +spreadPrice.toFixed(4),
      costR: +costR.toFixed(5),
      netR: +(out.r - costR).toFixed(5),
      bothTouched,
      holdBars: ep.exitOffset + 1, maxHoldBars: endIdx - s.entryIdx + 1
    });
  }
  return trades;
}


/**
 * The same walk realisedR performs, but reporting WHERE it ended and the
 * mark-to-market R at every bar along the way — both of which the equity
 * engine needs to build a FLOATING equity curve (prop-firm drawdown rules
 * are enforced on floating equity, so a closed-trade-only curve understates
 * them).
 *
 * Duplicated logic is a liability, so resolve() asserts this agrees with
 * realisedR on every trade and throws if they ever diverge. Order inside a
 * bar is stop-then-target, matching js/signals.js:59.
 */
function exitPath(walk, dir, entry, risk, targetR) {
  const stopPx = entry - dir * risk;
  const tpPx = entry + dir * targetR * risk;
  const mtm = new Array(walk.length);
  for (let k = 0; k < walk.length; k++) {
    const b = walk[k];
    mtm[k] = (dir * (b.c - entry)) / risk;
    const hitStop = dir === 1 ? b.l <= stopPx : b.h >= stopPx;
    if (hitStop) { mtm[k] = -1; return { r: -1, reason: 'stop', exitOffset: k, mtm: mtm.slice(0, k + 1) }; }
    const hitTp = dir === 1 ? b.h >= tpPx : b.l <= tpPx;
    if (hitTp) { mtm[k] = targetR; return { r: targetR, reason: 'target', exitOffset: k, mtm: mtm.slice(0, k + 1) }; }
  }
  const last = walk.length - 1;
  return { r: mtm[last], reason: 'timeout', exitOffset: last, mtm };
}

/** A bar whose range spans both the stop and the target, before either resolved. */
function countBothTouched(walk, dir, entry, risk, targetR) {
  const stopPx = entry - dir * risk;
  const tpPx = entry + dir * targetR * risk;
  for (const b of walk) {
    const hitStop = dir === 1 ? b.l <= stopPx : b.h >= stopPx;
    const hitTp = dir === 1 ? b.h >= tpPx : b.l <= tpPx;
    if (hitStop && hitTp) return true;
    if (hitStop || hitTp) return false;
  }
  return false;
}

/**
 * Optional higher-resolution pass. 5M OHLC cannot say whether the stop or
 * the target came first inside a bar; 1M has the same problem five times
 * smaller. This does not eliminate the ambiguity, it BOUNDS it — run both
 * and the gap between them is an honest uncertainty band. If that band is
 * wider than the measured expectancy, the sign is not established.
 */
function resolveWith(trades, fineBars, cfg) {
  if (!fineBars || !fineBars.length) return null;
  const out = [];
  for (const t of trades) {
    const from = t.entryTs;
    const to = t.entryTs + t.holdBars * cfg.tfMs;
    const slice = [];
    for (const b of fineBars) { if (b.t >= from && b.t < to) slice.push(b); }
    if (!slice.length) { out.push(t); continue; }
    const r = SignalJournal.realisedR(slice, t.dir, t.entryPx, t.riskPts,
                                      SignalJournal.PLAN_B, t.targetR);
    out.push({ ...t, grossR: r.r, reason: r.reason, netR: +(r.r - t.costR).toFixed(5), resolvedAt: '1m' });
  }
  return out;
}

/**
 * The repo's own viability floor, re-derived from THIS instrument's measured
 * spread rather than inherited. MAX_FEE_BURDEN_R = 0.11 says cost may eat at
 * most 11% of a trade's risk; risk here is box + buffer + entry offset, so
 * the implied minimum BOX is that minus the buffer.
 */
function autoMinBox(medianSpreadPrice, cfg) {
  const minRisk = medianSpreadPrice / cfg.maxFeeBurdenR;
  return Math.max(0, minRisk - cfg.slBufferPts);
}

/** Break-even win rate for a target R at a given cost: (1+cost)/(1+R). */
const breakEvenWinRate = (targetR, costR) => (1 + costR) / (1 + targetR);

module.exports = { resolve, resolveWith, sessionEndIdx, exitPath, countBothTouched, autoMinBox, breakEvenWinRate, SignalJournal };
