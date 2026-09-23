'use strict';
/* ==========================================================================
   Wicktor — CWT London Alligator state machine (EUR/USD).

   THE RULES, as specified by their author:
     1. Clean fan at the decision bar (20 min after the London open) ->
        trade the fan direction, SL a little beyond the JAW, TP 1:1.
     2. Tangled, but the Alligator's PREVIOUS trend is clear -> trade that
        prior direction, SL a little beyond the support/resistance line.
     3. Tangled AND the previous trend is also unclear -> wait 15-45 minutes
        for the Alligator to re-adjust, then trade the direction it forms,
        SL beyond S/R.
     4. After a stop -> wait the same 15-45 minutes, re-confirm direction,
        re-enter with SL beyond the jaw (configurable).

   ONE STRUCTURAL DIFFERENCE FROM orb-strategy.js, and it is not cosmetic.
   The ORB engine generated every signal in one causal pass and resolved
   exits afterwards, because no ORB rule depended on how an earlier trade
   ended. Rule 4 here DOES: whether a second trade exists depends on whether
   the first one was stopped. So a day is walked as
   decide -> resolve -> maybe re-arm -> decide again, resolving inline.

   That does not weaken causality. The DECISION is still sealed:
   `evaluateAt(i, ...)` may read bars[0..i] and nothing else, and
   tests/cwt.test.js enforces it with the no-lookahead Proxy. The exit walk
   is allowed to see forward — that is what resolving an exit means — and
   the next decision never begins before the previous exit bar, so no future
   information reaches a decision.

   Read-only. No I/O.
   ========================================================================== */

const tz = require('./tz.js');
const AL = require('./alligator.js');
const RES = require('./orb-resolve.js');

const DEFAULT_CFG = {
  zone: 'Europe/London',
  openMin: 8 * 60,           // London open
  boxMin: 15,                // let the 15M candle form
  flatMin: 16 * 60 + 30,     // flat by 16:30 London
  waitMinMin: 15,            // the Alligator's re-adjust window, minimum
  waitMaxMin: 45,            // ... and maximum
  maxTrades: 3,              // initial + two re-entries
  tangleMult: 0.5,
  slopeLook: 3,
  priorLookback: 24,         // 2h of 5M bars
  leftBars: 15,
  rightBars: 15,
  slBufferPips: 3,
  pipSize: 0.0001,           // EUR/USD 5-digit: 1 pip = 10 ticks. Never inferred.
  targetR: 1.0,
  reentryStop: 'jaw',        // 'jaw' | 'sr' | 'wider'
  fill: 'nextopen'           // 'nextopen' (conservative) | 'close'
};

const SKIP = {
  NO_SESSION: 'no_session',        // the day had no bar at the decision minute
  NO_PRIOR: 'no_prior_trend',      // tangled, no prior fan, and the wait expired
  WAIT_EXPIRED: 'wait_expired',
  NO_STOP_SIDE: 'stop_wrong_side', // the S/R level sat on the wrong side of price
  SESSION_END: 'session_end'
};

/**
 * Pivot highs/lows exactly as Pine's `fixnan(ta.pivothigh(L,R)[1])` behaves.
 *
 * A pivot at index p is only CONFIRMED once R bars have printed to its
 * right, and the extra [1] in the indicator shifts one more bar. So the
 * newest pivot visible at bar i is the one at index <= i - R - 1. Using the
 * value at bar i is therefore perfectly causal.
 *
 * The indicator PLOTS these with offset=-(R+1), painting the level back to
 * where the pivot was, which makes a level look older on a chart than it
 * was in reality. That is a display artifact; the logic here never uses it.
 */
function causalPivots(bars, left, right) {
  const n = bars.length;
  const isPH = new Array(n).fill(false);
  const isPL = new Array(n).fill(false);
  for (let p = left; p < n - right; p++) {
    let ph = true, pl = true;
    for (let k = p - left; k <= p + right; k++) {
      if (k === p) continue;
      if (bars[k].h >= bars[p].h) ph = false;
      if (bars[k].l <= bars[p].l) pl = false;
      if (!ph && !pl) break;
    }
    isPH[p] = ph; isPL[p] = pl;
  }
  const res = new Array(n).fill(null);
  const sup = new Array(n).fill(null);
  let lastH = null, lastL = null;
  for (let i = 0; i < n; i++) {
    const p = i - right - 1;
    if (p >= 0) {
      if (isPH[p]) lastH = bars[p].h;
      if (isPL[p]) lastL = bars[p].l;
    }
    res[i] = lastH; sup[i] = lastL;
  }
  return { res, sup, isPH, isPL };
}

/** Everything the decision needs, precomputed causally. */
function buildContext(bars, cfg) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const I = global.Indicators || require('../../js/indicators.js');
  const A = AL.alligator(bars, c);
  const atr = I.atr(bars, 14);
  const piv = causalPivots(bars, c.leftBars, c.rightBars);
  return { A, atr, piv, cfg: c };
}

const buffer = c => c.slBufferPips * c.pipSize;

/**
 * THE SEALED DECISION. May read bars[0..i] and nothing beyond.
 * `mode` is 'decision' (the 08:20 bar) or 'wait' (inside a 15-45 min window).
 * Returns null, or { dir, stopPx, caseTag }.
 */
function evaluateAt(bars, i, ctx, mode, opts = {}) {
  const c = ctx.cfg;
  const b = bars[i];
  const state = AL.fanState(ctx.A, ctx.atr, i, c);
  const buf = buffer(c);
  const res = ctx.piv.res[i], sup = ctx.piv.sup[i];

  const sideOk = (dir, st) => dir > 0 ? st < b.c : st > b.c;
  const jawStop = dir => dir > 0 ? ctx.A.jaw[i] - buf : ctx.A.jaw[i] + buf;
  const srStop = dir => {
    const lvl = dir > 0 ? sup : res;
    return lvl == null ? null : (dir > 0 ? lvl - buf : lvl + buf);
  };

  if (mode === 'wait') {
    // Cases 3 and 4 both enter on the first clean fan inside the window.
    if (state !== 'bull' && state !== 'bear') return null;
    const dir = state === 'bull' ? 1 : -1;
    const useSr = opts.stopSource === 'sr';
    const sj = jawStop(dir), ss = srStop(dir);
    let st;
    if (useSr) st = ss != null ? ss : sj;
    else if (c.reentryStop === 'wider' && ss != null) st = dir > 0 ? Math.min(sj, ss) : Math.max(sj, ss);
    else st = sj;
    if (st == null || !sideOk(dir, st)) return null;
    return { dir, stopPx: st, caseTag: opts.caseTag };
  }

  // The decision bar.
  if (state === 'bull' || state === 'bear') {
    const dir = state === 'bull' ? 1 : -1;      // case 1: clean fan, stop beyond the jaw
    const st = jawStop(dir);
    if (st == null || !sideOk(dir, st)) return { skip: SKIP.NO_STOP_SIDE };
    return { dir, stopPx: st, caseTag: 'case1-fan' };
  }

  const prior = AL.priorFanDir(ctx.A, ctx.atr, i, c.priorLookback, c);
  if (prior !== 0) {                             // case 2: prior trend, stop beyond S/R
    const st = srStop(prior);
    if (st == null || !sideOk(prior, st)) return { skip: SKIP.NO_STOP_SIDE };
    return { dir: prior, stopPx: st, caseTag: 'case2-prior' };
  }
  return { wait: true };                         // case 3: arm the wait window
}

// ------------------------------------------------------------------ driver
function collectTrades(bars, cfg = {}, ctxIn = null) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const ctx = ctxIn || buildContext(bars, c);
  const tags = tz.tagBars(bars, c.zone);
  const decisionMin = c.openMin + c.boxMin;

  // Index every London day once.
  const dayStart = new Map();
  for (let i = 0; i < bars.length; i++) {
    if (!dayStart.has(tags[i].ymd)) dayStart.set(tags[i].ymd, i);
  }

  const trades = [], dispositions = [];

  for (const [ymd, start] of dayStart) {
    if (tags[start].dow === 0 || tags[start].dow === 6) continue;   // Mon-Fri only

    let decisionIdx = -1, endIdx = -1;
    for (let i = start; i < bars.length && tags[i].ymd === ymd; i++) {
      if (decisionIdx < 0 && tags[i].minutes === decisionMin) decisionIdx = i;
      if (tags[i].minutes < c.flatMin) endIdx = i;
    }
    if (decisionIdx < 0) { dispositions.push({ ymd, disposition: SKIP.NO_SESSION }); continue; }

    let taken = 0, disposition = null;
    let ev = evaluateAt(bars, decisionIdx, ctx, 'decision');
    let signalIdx = decisionIdx;
    let waitFrom = null, waitCase = null, waitStopSrc = null;

    if (ev && ev.skip) { dispositions.push({ ymd, disposition: ev.skip }); continue; }
    if (ev && ev.wait) {
      waitFrom = decisionIdx; waitCase = 'case3-waited'; waitStopSrc = 'sr'; ev = null;
    }

    while (taken < c.maxTrades) {
      // --- if we are waiting, scan the 15..45 minute window for a clean fan
      if (!ev) {
        if (waitFrom == null) { disposition = disposition || SKIP.WAIT_EXPIRED; break; }
        const fromMin = tags[waitFrom].minutes;
        let found = null;
        for (let k = waitFrom + 1; k <= endIdx; k++) {
          const d = tags[k].minutes - fromMin;
          if (d < c.waitMinMin) continue;
          if (d > c.waitMaxMin) break;
          const r = evaluateAt(bars, k, ctx, 'wait', { caseTag: waitCase, stopSource: waitStopSrc });
          if (r) { found = r; signalIdx = k; break; }
        }
        if (!found) { disposition = disposition || SKIP.WAIT_EXPIRED; break; }
        ev = found;
      }

      // --- fill
      const entryIdx = c.fill === 'close' ? signalIdx : signalIdx + 1;
      if (entryIdx > endIdx) { disposition = disposition || SKIP.SESSION_END; break; }
      const entryPx = c.fill === 'close' ? bars[signalIdx].c : bars[entryIdx].o;
      const risk = Math.abs(entryPx - ev.stopPx);
      if (!(risk > 0)) { disposition = disposition || SKIP.NO_STOP_SIDE; break; }

      // --- resolve inline (this is allowed to look forward; the next
      //     decision never starts before the exit bar)
      const walk = bars.slice(entryIdx, endIdx + 1);
      const ep = RES.exitPath(walk, ev.dir, entryPx, risk, c.targetR);
      const exitIdx = entryIdx + ep.exitOffset;

      trades.push({
        ymd, window: 'london', branch: ev.caseTag, dir: ev.dir,
        signalIdx, entryIdx, entryPx, stopPx: ev.stopPx,
        riskPts: risk, riskPips: risk / c.pipSize, targetR: c.targetR,
        entryTs: bars[entryIdx].t, exitIdx, holdBars: ep.exitOffset + 1,
        grossR: ep.r, reason: ep.reason, mtm: ep.mtm,
        fanSpread: AL.fanSpread(ctx.A, signalIdx),
        tradeNo: taken + 1
      });
      taken++;
      disposition = 'entered';

      // --- rule 4: a stop re-arms the same 15-45 minute window
      if (ep.reason !== 'stop' || taken >= c.maxTrades || exitIdx >= endIdx) break;
      waitFrom = exitIdx; waitCase = 'case4-reentry';
      waitStopSrc = c.reentryStop === 'sr' ? 'sr' : null;
      ev = null;
    }
    dispositions.push({ ymd, disposition: disposition || SKIP.WAIT_EXPIRED, trades: taken });
  }
  return { trades, dispositions, ctx, tags };
}

module.exports = {
  DEFAULT_CFG, SKIP, causalPivots, buildContext, evaluateAt, collectTrades, buffer
};
