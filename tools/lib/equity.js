'use strict';
/* ==========================================================================
   Wicktor — risk sizing, equity curves, drawdown and bootstrap.

   TWO LAYERS, deliberately separated because they answer different questions.

   Layer 1, R-multiples: contract-independent and the statistically
   meaningful number. Nothing here about dollars, lots or brokers.

   Layer 2, dollars on a $5,000 account: a COMPLIANCE simulation, driven by
   layer 1. It exists to answer one question — does this breach a 4% daily
   or 10% trailing drawdown cap — and it depends on broker facts (point
   value, minimum lot, lot step) that a backtest cannot invent. So all three
   lot-granularity readings are reported side by side rather than one being
   chosen silently.

   FLOATING, NOT CLOSED-TRADE. Prop-firm rules are enforced on floating
   equity: an open position that goes 3% against you has breached a 4% daily
   rule whether or not it later recovers. A closed-trade curve cannot see
   that, so it UNDERSTATES drawdown. The floating curve is the headline here
   and the closed one is reported beside it.

   THE BOOTSTRAP IS THE POINT. A single realised path's max drawdown and max
   losing streak are extreme-value statistics with enormous sampling error.
   "Observed 6.1%, so I am under the 10% limit" is not a conclusion the data
   supports; "P(breach) = 0.19" is. Resampling is seeded, so the number is
   reproducible.

   Read-only. No I/O.
   ========================================================================== */

const tz = require('./tz.js');

// ----------------------------------------------------------- CI (shared)
// Lifted from tools/mt5-crossval.js:44 so there is one copy, not two.
function ci95(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  const se = Math.sqrt(v / n);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n };
}

/**
 * Direction-balanced: longs and shorts averaged separately, then combined.
 * Per this repo's convention, a large gap between the two arms is the
 * window's drift, not an edge.
 */
function balancedCI(list, key = 'netR') {
  const b = list.filter(x => x.dir === 1).map(x => x[key]);
  const s = list.filter(x => x.dir === -1).map(x => x[key]);
  if (b.length < 2 || s.length < 2) return null;
  const cb = ci95(b), cs = ci95(s);
  const m = (cb.m + cs.m) / 2;
  const se = Math.sqrt(cb.se * cb.se + cs.se * cs.se) / 2;
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n: list.length, nb: b.length, ns: s.length };
}

// ------------------------------------------------------------------ sizing
/**
 * mode: 'fractional' | 'minlot' | 'skip'
 *   fractional — ignore lot granularity. The idealised curve.
 *   minlot     — take the minimum when the target size rounds below it, and
 *                RECORD that the trade is over-risked. What a real trader does.
 *   skip       — refuse the trade. Report how many that drops.
 */
function sizeTrade({ equity, riskPct, riskPoints, pointValue, minLot, lotStep, mode = 'minlot' }) {
  const targetCash = equity * riskPct;
  const cashPerLot = riskPoints * pointValue;
  if (!(cashPerLot > 0)) return { lots: 0, riskCash: 0, realisedRiskPct: 0, unattainable: true, skipped: true };

  const raw = targetCash / cashPerLot;
  if (mode === 'fractional') {
    return { lots: raw, riskCash: targetCash, realisedRiskPct: riskPct, unattainable: false, skipped: false };
  }
  let lots = Math.floor(raw / lotStep) * lotStep;
  lots = +lots.toFixed(8);
  if (lots < minLot) {
    if (mode === 'skip') return { lots: 0, riskCash: 0, realisedRiskPct: 0, unattainable: true, skipped: true };
    lots = minLot;
  }
  const riskCash = lots * cashPerLot;
  return { lots, riskCash, realisedRiskPct: equity > 0 ? riskCash / equity : 0,
           unattainable: raw < minLot, skipped: false };
}

// ------------------------------------------------------------ equity curve
/**
 * Walks trades in entry order, marking to market on every bar a position is
 * open. Returns both curves plus the per-trade record.
 *
 * compounding: risk 0.5% of CURRENT equity (what the spec says and what a
 * trailing drawdown rule measures) vs fixed 0.5% of the INITIAL balance
 * (the control — compounding makes profit and drawdown depend on trade
 * ORDER, and order is not an edge).
 */
function runEquity(trades, opts = {}) {
  const {
    initial = 5000, riskPct = 0.005, pointValue = 1, pointSize = 0.1,
    minLot = 0.1, lotStep = 0.1, mode = 'minlot', compounding = true
  } = opts;

  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  let equity = initial;
  const floating = [{ t: sorted.length ? sorted[0].entryTs - 1 : 0, equity }];
  const closed = [{ t: sorted.length ? sorted[0].entryTs - 1 : 0, equity }];
  const records = [];
  let unattainableCount = 0, skippedCount = 0;

  for (const t of sorted) {
    const base = compounding ? equity : initial;
    const size = sizeTrade({ equity: base, riskPct, riskPoints: t.riskPts,
                             pointValue, minLot, lotStep, mode });
    if (size.skipped) { skippedCount++; continue; }
    if (size.unattainable) unattainableCount++;

    const entryEquity = equity;
    // Floating: mark to each bar's close while open. cost is charged on exit.
    for (let k = 0; k < t.mtm.length; k++) {
      floating.push({ t: t.entryTs + k * (opts.tfMs || 300000),
                      equity: entryEquity + size.riskCash * t.mtm[k] });
    }
    const pnl = size.riskCash * t.netR;
    equity = entryEquity + pnl;
    floating.push({ t: t.entryTs + t.holdBars * (opts.tfMs || 300000), equity });
    closed.push({ t: t.entryTs, equity });
    records.push({ ...t, lots: size.lots, riskCash: size.riskCash,
                   realisedRiskPct: size.realisedRiskPct, unattainable: size.unattainable,
                   pnl, equityAfter: equity });
  }

  return { floating, closed, records, finalEquity: equity, initial,
           netProfit: equity - initial, returnPct: (equity - initial) / initial,
           unattainableCount, skippedCount, mode, compounding };
}

// -------------------------------------------------------------- drawdown
function drawdownStats(series) {
  let peak = -Infinity, maxDd = 0, troughT = null, peakT = null, curPeakT = null;
  for (const p of series) {
    if (p.equity > peak) { peak = p.equity; curPeakT = p.t; }
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) { maxDd = dd; troughT = p.t; peakT = curPeakT; }
  }
  return { maxDrawdownPct: maxDd, peakT, troughT };
}

/**
 * Daily drawdown, grouped by the PROP FIRM's accounting day, not UTC. A UTC
 * grouping splits a US session across two "days" and can hide a breach.
 */
function dailyDrawdown(series, accountingZone, limitPct = 0.04) {
  const byDay = new Map();
  for (const p of series) {
    const d = tz.zonedFields(p.t, accountingZone).ymd;
    if (!byDay.has(d)) byDay.set(d, { ymd: d, start: p.equity, min: p.equity, max: p.equity, end: p.equity });
    const e = byDay.get(d);
    e.min = Math.min(e.min, p.equity);
    e.max = Math.max(e.max, p.equity);
    e.end = p.equity;
  }
  const days = [...byDay.values()].sort((a, b) => a.ymd < b.ymd ? -1 : 1);
  for (const d of days) d.ddPct = d.start > 0 ? (d.start - d.min) / d.start : 0;
  const worst = days.reduce((a, b) => (b.ddPct > (a ? a.ddPct : -1) ? b : a), null);
  return { days, worst, breachCount: days.filter(d => d.ddPct > limitPct).length, limitPct };
}

/** Trailing high-water-mark drawdown, for the 10% "max trailing" rule. */
function trailingDrawdown(series) {
  let hwm = -Infinity, worst = 0;
  for (const p of series) {
    if (p.equity > hwm) hwm = p.equity;
    const dd = hwm > 0 ? (hwm - p.equity) / hwm : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

function maxLossStreak(records) {
  let cur = 0, best = 0;
  for (const r of records) { if (r.netR < 0) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return best;
}

// -------------------------------------------------------------- bootstrap
/**
 * Resample the observed netR values with replacement, replay the equity
 * engine on each path, and report the DISTRIBUTION of max drawdown, worst
 * day and longest losing streak. The single realised path is one draw from
 * this; quoting it alone overstates what the data establishes.
 */
function bootstrap(records, opts = {}) {
  const { iterations = 10000, seed = 42, initial = 5000, riskPct = 0.005,
          compounding = true, ddLimit = 0.10, dailyLimit = 0.04 } = opts;
  if (!records.length) return null;

  const rs = records.map(r => r.netR);
  const perDay = groupCountsPerDay(records);
  let a = seed >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
                      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const maxDds = [], streaks = [], dailyDds = [];
  for (let it = 0; it < iterations; it++) {
    let eq = initial, peak = initial, dd = 0, cur = 0, streak = 0;
    let dayStart = initial, dayLeft = perDay[Math.floor(rnd() * perDay.length)], worstDay = 0;
    for (let k = 0; k < rs.length; k++) {
      const r = rs[Math.floor(rnd() * rs.length)];
      eq += (compounding ? eq : initial) * riskPct * r;
      if (eq > peak) peak = eq;
      dd = Math.max(dd, (peak - eq) / peak);
      if (r < 0) { cur++; streak = Math.max(streak, cur); } else cur = 0;
      if (--dayLeft <= 0) {
        worstDay = Math.max(worstDay, (dayStart - eq) / dayStart);
        dayStart = eq; dayLeft = perDay[Math.floor(rnd() * perDay.length)];
      }
    }
    worstDay = Math.max(worstDay, (dayStart - eq) / dayStart);
    maxDds.push(dd); streaks.push(streak); dailyDds.push(worstDay);
  }
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const pr = (arr, lim) => arr.filter(x => x > lim).length / arr.length;
  return {
    iterations,
    maxDrawdown: { median: q(maxDds, 0.5), p95: q(maxDds, 0.95), pBreach: pr(maxDds, ddLimit), limit: ddLimit },
    dailyDrawdown: { median: q(dailyDds, 0.5), p95: q(dailyDds, 0.95), pBreach: pr(dailyDds, dailyLimit), limit: dailyLimit },
    lossStreak: { median: q(streaks, 0.5), p95: q(streaks, 0.95) }
  };
}

/** Trades per calendar day, so the bootstrap's "days" are realistically sized. */
function groupCountsPerDay(records) {
  const m = new Map();
  for (const r of records) { const k = r.ymd; m.set(k, (m.get(k) || 0) + 1); }
  return m.size ? [...m.values()] : [1];
}

module.exports = {
  ci95, balancedCI, sizeTrade, runEquity,
  drawdownStats, dailyDrawdown, trailingDrawdown, maxLossStreak, bootstrap
};
