'use strict';
/* ==========================================================================
   Wicktor — opening-range breakout state machine.

   THE STRATEGY, as specified by its author:
     1. At session open let the 15M candle close; box its high and low,
        extending right 90 minutes.
     2. On 5M, wait for a breakout/sweep of either edge.
     3. Wait for a retest of the broken edge. The retest candle must CLOSE
        OUTSIDE the box. Enter in the breakout direction.
     4. SL slightly beyond the OPPOSITE edge ("a tad", explicitly no tight
        stops), so risk is box height + buffer, not box height.
     5. TP at least 1R, 1.2R maximum.
     6. If RSI diverges at the breakout, CANCEL the retest setup; wait for
        the divergence to play out, break the box on the other side, and
        enter on the third candle with SL at the divergence extreme.
     7. Chop filters, both applied: box height below a floor skips the
        session (A), and no clean break within 45-60 minutes abandons it (B).

   THE ONE RULE THAT MATTERS FOR CORRECTNESS: at bar i the decision point is
   bar i's CLOSE, and step() may read bars[0..i] and nothing else. Every
   action it takes fills at bar i+1's open (or, for --fill=edge, at a resting
   limit inside bar i). tests/orb.test.js enforces this mechanically with
   tools/lib/no-lookahead.js rather than trusting the reading. Exit walking
   is deliberately OUTSIDE that rule — resolving a trade is allowed to see
   the future, that is what resolving means — which is why signal generation
   and exit resolution are two separate passes here.

   Read-only. No I/O, no CLI.
   ========================================================================== */

const tz = require('./tz.js');

const DEFAULT_CFG = {
  minBoxPts: 12.0,        // Option A floor. 'auto' -> derived from measured spread.
  chopMins: 60,           // Option B: clean break must occur within this of box close.
  expiryMins: 90,         // box "extends right" this long; no entry after.
  slBufferPts: 2.0,       // "a tad" beyond the opposite edge.
  targetR: 1.2,
  fill: 'nextopen',       // 'nextopen' | 'close' | 'edge'
  retest: 'strict',       // 'strict' (one bar touches AND closes outside) | 'twobar'
  reclaimRequired: true,
  divergence: 'off',      // 'off' | 'filter' | 'reverse'
  divLookback: 18,        // bars (90 min) — the box's own lifetime, not 4h
  divTolerance: 0.25,     // x ATR, so a double top still counts as a higher high
  reversalStop: 'divergence-pivot',  // | 'boxedge' | 'excursion'
  reversalTargetR: 1.2,
  maxFeeBurdenR: 0.11,    // from tools/mt5-backtest.js
  assumedSpreadPts: null  // used only when the CSV has no spread column
};

const SKIP = {
  INCOMPLETE_BOX: 'incomplete_box',
  BOX_TOO_SMALL: 'box_too_small',
  CHOP_TIMEOUT: 'chop_timeout',
  EXPIRED: 'expired',
  TRAVERSED: 'traversed',
  SESSION_END: 'session_end',
  NO_RETEST: 'no_retest',
  NO_DATA: 'no_data'
};

// ----------------------------------------------------------------- helpers
const barMin = tfMs => Math.round(tfMs / 60000);

/**
 * Tolerant divergence.
 *
 * js/indicators.js:511 requires a STRICTLY higher high (`candles[i2].h >
 * candles[i1].h`). The author's own chart shows the pattern they trade as a
 * double top — two roughly EQUAL highs with RSI dropping hard — which the
 * strict rule returns 'none' for. So this is a local variant with an
 * absolute tolerance, leaving the shared indicator untouched so nothing
 * else in the repo shifts.
 *
 * CAUSALITY: a fractal at index p is only knowable once bars p+1 and p+2
 * have closed (js/indicators.js:342 rejects `right > n-3`). Calling
 * divergence() on full-series fractals therefore reads pivots from the
 * trade's own future. Pivots are filtered to p <= i-2 here, and
 * tests/orb.test.js asserts that filtering equals recomputing fractals() on
 * bars.slice(0, i+1).
 */
function tolerantDivergence(bars, rsiSeries, frac, i, opts = {}) {
  const lookback = opts.lookback || 18;
  const tol = opts.tolAbs || 0;
  const floorIdx = Math.max(opts.minIdx != null ? opts.minIdx : 0, i - lookback);
  const visible = arr => arr.filter(p => p <= i - 2 && p >= floorIdx);

  const ups = visible(frac.up);
  if (ups.length >= 2) {
    const [p1, p2] = ups.slice(-2);
    const r1 = rsiSeries[p1], r2 = rsiSeries[p2];
    if (r1 != null && r2 != null && bars[p2].h >= bars[p1].h - tol && r2 < r1) {
      return { dir: 'bear', p1, p2, pivotPx: Math.max(bars[p1].h, bars[p2].h),
               strict: bars[p2].h > bars[p1].h, rsi1: r1, rsi2: r2 };
    }
  }
  const downs = visible(frac.down);
  if (downs.length >= 2) {
    const [p1, p2] = downs.slice(-2);
    const r1 = rsiSeries[p1], r2 = rsiSeries[p2];
    if (r1 != null && r2 != null && bars[p2].l <= bars[p1].l + tol && r2 > r1) {
      return { dir: 'bull', p1, p2, pivotPx: Math.min(bars[p1].l, bars[p2].l),
               strict: bars[p2].l < bars[p1].l, rsi1: r1, rsi2: r2 };
    }
  }
  return { dir: 'none' };
}

// --------------------------------------------------------------- the machine
/**
 * Re-checked on EVERY bar from the breakout until entry, not once at the
 * breakout. This matters and was wrong in the first version.
 *
 * The author's rule is "before entering the trade I look at the RSI", and
 * their chart shows the divergence forming INSIDE the breakout leg: two
 * highs above the box with RSI rolling over between them. The second of
 * those pivots does not exist yet when the box is first broken — a fractal
 * needs two bars of right flank — so a single check at the breakout bar
 * finds 'none' essentially always and the branch would be dead code. On the
 * scripted fixture the break is at bar 33 and the divergence only becomes
 * knowable at bar 39.
 *
 * Returns true if the session was diverted (vetoed or flipped to reversal).
 */
function checkDivergence(st, bars, i, cfg, ctx) {
  if (cfg.divergence === 'off' || !ctx.rsi) return false;
  const tolAbs = cfg.divTolerance * (ctx.atr[i] || 0);
  const d = tolerantDivergence(bars, ctx.rsi, ctx.frac, i,
    { lookback: cfg.divLookback, tolAbs, minIdx: st.startIdx });
  const conflict = (st.dir === 1 && d.dir === 'bear') || (st.dir === -1 && d.dir === 'bull');
  if (!conflict) return false;

  st.divergence = d;
  st.divergenceIdx = i;
  if (cfg.divergence === 'filter') {                 // cancel, take nothing
    st.phase = 'SKIPPED'; st.disposition = 'divergence_veto'; return true;
  }
  st.phase = 'REVERSAL_WATCH';                       // cancel, trade the other way
  st.reversal = { revDir: -st.dir, pivotPx: d.pivotPx, pivotIdx: d.p2, strict: d.strict,
                  excursion: st.excursion != null ? st.excursion : (st.dir === 1 ? bars[i].h : bars[i].l) };
  return true;
}

function newSession(key, w, tag, i) {
  return {
    key, window: w.name, zone: w.zone, ymd: tag.ymd,
    phase: 'PRE', startIdx: i,
    boxHigh: -Infinity, boxLow: Infinity, boxBars: 0, boxSealedIdx: null,
    boxCloseMin: w.openMin + w.boxMin,
    dir: 0, breakoutIdx: null, brokeOutEver: false, excursion: null,
    reversal: null, revDownCount: 0,
    disposition: null, signal: null
  };
}

/**
 * One bar of one window's session. Returns a signal object or null.
 * Reads bars[0..i] only.
 */
function step(st, bars, i, tag, w, cfg, ctx) {
  const b = bars[i];
  const tfMin = ctx.tfMin;
  const m = tag.minutes;
  const sinceBoxClose = m - st.boxCloseMin;

  // ---------------- PRE / BOX -------------------------------------------
  if (st.phase === 'PRE') {
    if (m < w.openMin) return null;
    if (m >= st.boxCloseMin) {           // session opened without us seeing the box
      st.phase = 'SKIPPED'; st.disposition = SKIP.INCOMPLETE_BOX; return null;
    }
    st.phase = 'BOX';
  }

  if (st.phase === 'BOX') {
    if (m >= w.openMin && m < st.boxCloseMin) {
      st.boxHigh = Math.max(st.boxHigh, b.h);
      st.boxLow = Math.min(st.boxLow, b.l);
      st.boxBars++;
    }
    // Sealed only once the LAST box bar has closed.
    if (m + tfMin >= st.boxCloseMin) {
      const want = w.boxMin / tfMin;
      if (st.boxBars !== want) {
        st.phase = 'SKIPPED'; st.disposition = SKIP.INCOMPLETE_BOX; return null;
      }
      st.boxPts = st.boxHigh - st.boxLow;
      st.boxSealedIdx = i;
      if (st.boxPts < ctx.minBoxPts) {
        st.phase = 'SKIPPED'; st.disposition = SKIP.BOX_TOO_SMALL; return null;
      }
      st.phase = 'ARMED';
    }
    return null;
  }

  if (st.phase === 'SKIPPED' || st.phase === 'DONE') return null;

  // ---------------- shared deadlines -------------------------------------
  if (m >= w.flatMin) { st.phase = 'SKIPPED'; st.disposition = st.disposition || SKIP.SESSION_END; return null; }
  if (sinceBoxClose >= cfg.expiryMins) {
    st.phase = 'SKIPPED';
    st.disposition = st.brokeOutEver ? SKIP.NO_RETEST : SKIP.EXPIRED;
    return null;
  }

  // ---------------- ARMED: waiting for a clean break ----------------------
  if (st.phase === 'ARMED') {
    // Option B — structural chop. Only applies until the FIRST clean break.
    if (!st.brokeOutEver && sinceBoxClose >= cfg.chopMins) {
      st.phase = 'SKIPPED'; st.disposition = SKIP.CHOP_TIMEOUT; return null;
    }
    // "breaks cleanly out" — the CLOSE, not the high; a close exactly on the
    // edge is not a break.
    let dir = 0;
    if (b.c > st.boxHigh) dir = 1;
    else if (b.c < st.boxLow) dir = -1;
    if (dir === 0) return null;

    st.dir = dir; st.breakoutIdx = i; st.brokeOutEver = true;

    st.excursion = dir === 1 ? b.h : b.l;
    if (checkDivergence(st, bars, i, cfg, ctx)) return null;
    st.phase = 'AWAIT_RETEST';
    return null;
  }

  // ---------------- AWAIT_RETEST -----------------------------------------
  if (st.phase === 'AWAIT_RETEST') {
    if (i <= st.breakoutIdx) return null;              // never its own retest
    const up = st.dir === 1;
    // Track how far the break ran, for --reversal-stop=excursion.
    st.excursion = up ? Math.max(st.excursion, b.h) : Math.min(st.excursion, b.l);
    // "before entering the trade I look at the RSI" — so this is re-evaluated
    // every bar, not frozen at the breakout. See checkDivergence().
    if (checkDivergence(st, bars, i, cfg, ctx)) return null;
    const edge = up ? st.boxHigh : st.boxLow;
    const farEdge = up ? st.boxLow : st.boxHigh;

    if (up ? b.c < farEdge : b.c > farEdge) {
      st.phase = 'SKIPPED'; st.disposition = SKIP.TRAVERSED; return null;
    }
    // Closed back inside: the break is no longer live.
    const backInside = up ? b.c <= edge : b.c >= edge;
    if (backInside) {
      if (cfg.reclaimRequired) { st.phase = 'ARMED'; st.pendingTwoBar = null; }
      return null;
    }

    const touched = up ? b.l <= edge : b.h >= edge;
    let isRetest = false;
    if (cfg.retest === 'strict') {
      isRetest = touched;                                   // touch AND close outside (close checked above)
    } else {                                                // 'twobar'
      if (touched) isRetest = true;
      else if (st.pendingTwoBar != null && st.pendingTwoBar === i - 1) isRetest = true;
      if (up ? bars[i].l <= edge : bars[i].h >= edge) st.pendingTwoBar = i;
    }
    if (!isRetest) return null;

    return openStandard(st, bars, i, w, cfg, ctx, edge);
  }

  // ---------------- REVERSAL_WATCH ---------------------------------------
  if (st.phase === 'REVERSAL_WATCH') {
    const revUp = st.reversal.revDir === 1;
    // Track the excursion extreme in the ORIGINAL direction, for --reversal-stop=excursion.
    st.reversal.excursion = revUp ? Math.min(st.reversal.excursion, b.l)
                                  : Math.max(st.reversal.excursion, b.h);

    // "break the box on the other side" — a close beyond the OPPOSITE edge.
    const target = revUp ? st.boxHigh : st.boxLow;
    const broke = revUp ? b.c > target : b.c < target;
    if (!broke) return null;

    // "two candles formed in the reversal direction" — two consecutive bars
    // closing with the trend change, the second beyond the edge.
    if (i < 1) return null;
    const dirBar = k => revUp ? bars[k].c > bars[k].o : bars[k].c < bars[k].o;
    if (!(dirBar(i) && dirBar(i - 1))) return null;

    return openReversal(st, bars, i, w, cfg, ctx);
  }

  return null;
}

// -------------------------------------------------------------- open trades
function resolveFill(st, bars, i, cfg, edge) {
  // 'close'    — the author's literal spec; the signal bar fills itself, so
  //              it is the most optimistic of the three.
  // 'nextopen' — conservative default; matches tools/analyze-session.js:118.
  // 'edge'     — a limit resting at the broken edge, which is what the
  //              author's position-tool screenshots show. TWICE optimistic,
  //              and measurably so (+0.22R vs nextopen on synthetic data):
  //              it presumes the order was resting before the retest bar
  //              closed, AND it still only counts bars that went on to close
  //              outside the box — a real resting limit would also have been
  //              filled by every touch that closed back inside, and those
  //              are the bad ones. Reported, never the default.
  if (cfg.fill === 'close') return { entryIdx: i, entryPx: bars[i].c, note: 'signal-bar close' };
  if (cfg.fill === 'edge')  return { entryIdx: i, entryPx: edge, note: 'limit at broken edge' };
  if (i + 1 >= bars.length) return null;
  return { entryIdx: i + 1, entryPx: bars[i + 1].o, note: 'next bar open' };
}

function openStandard(st, bars, i, w, cfg, ctx, edge) {
  const f = resolveFill(st, bars, i, cfg, edge);
  if (!f) { st.phase = 'SKIPPED'; st.disposition = SKIP.NO_DATA; return null; }

  const up = st.dir === 1;
  const stopPx = up ? st.boxLow - cfg.slBufferPts : st.boxHigh + cfg.slBufferPts;
  const risk = Math.abs(f.entryPx - stopPx);
  if (!(risk > 0)) { st.phase = 'SKIPPED'; st.disposition = SKIP.NO_DATA; return null; }

  st.phase = 'DONE'; st.disposition = 'entered';
  return {
    branch: 'standard', window: st.window, ymd: st.ymd, dir: st.dir,
    boxHigh: st.boxHigh, boxLow: st.boxLow, boxPts: st.boxPts,
    breakoutIdx: st.breakoutIdx, retestIdx: i,
    entryIdx: f.entryIdx, entryPx: f.entryPx, fillNote: f.note,
    entryIdeal: bars[i].c, edge,
    stopPx, riskPts: risk, targetR: cfg.targetR,
    // The real cost of a close-based signal: the fill gapped back inside.
    openAdverse: up ? f.entryPx < edge : f.entryPx > edge,
    divergence: st.divergence ? st.divergence.dir : 'none',
    riskFloored: false
  };
}

function openReversal(st, bars, i, w, cfg, ctx) {
  const r = st.reversal;
  const up = r.revDir === 1;
  // "enter at the third candle when it's still forming" -> that bar's OPEN,
  // the only price knowable as it starts. Anything later reads its future.
  if (i + 1 >= bars.length) { st.phase = 'SKIPPED'; st.disposition = SKIP.NO_DATA; return null; }
  const entryIdx = i + 1, entryPx = bars[i + 1].o;

  let stopPx;
  if (cfg.reversalStop === 'boxedge')        stopPx = up ? st.boxLow - cfg.slBufferPts : st.boxHigh + cfg.slBufferPts;
  else if (cfg.reversalStop === 'excursion') stopPx = up ? r.excursion - cfg.slBufferPts : r.excursion + cfg.slBufferPts;
  else                                       stopPx = up ? r.pivotPx - cfg.slBufferPts : r.pivotPx + cfg.slBufferPts;

  let risk = Math.abs(entryPx - stopPx);
  // A stop a couple of points away makes a 1.2R target meaningless once
  // spread is charged. MAX_FEE_BURDEN_R (tools/mt5-backtest.js) is the
  // repo's own ceiling on how much of a trade's risk cost may eat.
  const minRisk = ctx.spreadPrice > 0 ? ctx.spreadPrice / cfg.maxFeeBurdenR : 0;
  let floored = false;
  if (risk < minRisk) { risk = minRisk; floored = true; }
  if (!(risk > 0)) { st.phase = 'SKIPPED'; st.disposition = SKIP.NO_DATA; return null; }

  st.phase = 'DONE'; st.disposition = 'entered';
  return {
    branch: 'reversal', window: st.window, ymd: st.ymd, dir: r.revDir,
    boxHigh: st.boxHigh, boxLow: st.boxLow, boxPts: st.boxPts,
    breakoutIdx: st.breakoutIdx, confirmIdx: i,
    entryIdx, entryPx, fillNote: 'third candle open',
    entryIdeal: bars[i].c, edge: up ? st.boxHigh : st.boxLow,
    stopPx: up ? entryPx - risk : entryPx + risk,
    riskPts: risk, targetR: cfg.reversalTargetR,
    openAdverse: false,
    divergence: st.divergence ? st.divergence.dir : 'none',
    divergenceStrict: r.strict, riskFloored: floored
  };
}

// ------------------------------------------------------------------- driver
/**
 * collectSignals(bars, windows, cfg, ctx) -> { signals, dispositions }
 * `ctx` carries the precomputed indicator series and tfMin. Nothing in here
 * looks past bar i.
 */
function collectSignals(bars, windows, cfg, ctx) {
  const tags = windows.map(w => tz.tagBars(bars, w.zone));
  const states = new Array(windows.length).fill(null);
  const signals = [], dispositions = [];

  const close = st => {
    if (!st) return;
    if (st.phase === 'PRE') return;                      // never reached its open
    dispositions.push({ window: st.window, ymd: st.ymd,
      disposition: st.disposition || (st.phase === 'DONE' ? 'entered' : SKIP.EXPIRED),
      boxPts: st.boxPts != null ? +st.boxPts.toFixed(2) : null, brokeOut: st.brokeOutEver });
  };

  for (let i = 0; i < bars.length; i++) {
    for (let wi = 0; wi < windows.length; wi++) {
      const w = windows[wi], tag = tags[wi][i];
      let st = states[wi];
      const key = `${w.name}|${tag.ymd}`;
      if (!st || st.key !== key) { close(st); st = states[wi] = newSession(key, w, tag, i); }
      const sig = step(st, bars, i, tag, w, cfg, ctx);
      if (sig) signals.push(sig);
    }
  }
  for (const st of states) close(st);
  return { signals, dispositions, tags };
}

module.exports = {
  DEFAULT_CFG, SKIP, collectSignals, step, newSession, checkDivergence,
  tolerantDivergence, barMin
};
