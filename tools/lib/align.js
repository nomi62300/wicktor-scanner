'use strict';
/* ==========================================================================
   Shared, CORRECT context-timeframe alignment for every fixture-backtest
   tool in tools/. Do not reimplement this locally — this file exists
   because ten separate copy-pasted versions of a subtly WRONG alignment
   function were found across tools/analyze-*.js, tools/validate-*.js,
   tools/test-*.js, tools/backtest-v2.js and tools/sweep-stop-target.js,
   2026-09-05.

   THE BUG: every copy selected the context bar with `candles[mid].t <= ts`
   — the context bar that had already STARTED by the entry bar's timestamp,
   then read that bar's FINISHED ohlc (high/low/close). That bar had not
   closed yet at `ts`; its high/low/close describe what happened for the
   REST of its duration, some of which is still in the entry bar's future.
   Measured directly on MT5 gold data by running the identical walk both
   ways: the loose (buggy) alignment scored +0.033 to +0.070R better than
   the strict one on the SAME trades — lookahead worth roughly the entire
   size of the crypto edge every one of these tools has ever reported. See
   memory: project-wicktor-mt5-gold-measurement.

   THE FIX: a context bar is visible at `ts` only once it has CLOSED — i.e.
   once its own open time plus its own duration has passed.
   ========================================================================== */

const TF_MS = { m5: 300000, m15: 900000, m30: 1800000, h1: 3600000, h4: 14400000 };

/**
 * Index of the last context-timeframe bar that had fully CLOSED by `ts`.
 * `tfMs` is that bar's own duration (use TF_MS[key], or a literal for an
 * aggregated series like sweep-stop-target.js's 30M).
 */
function closedIndexAt(candles, ts, tfMs) {
  const cutoff = ts - tfMs;
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

module.exports = { closedIndexAt, TF_MS };
