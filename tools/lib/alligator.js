'use strict';
/* ==========================================================================
   Wicktor — Williams Alligator, matching the Pine implementation exactly.

   THE DISPLACEMENT IS THE WHOLE POINT. The Alligator is drawn shifted
   FORWARD (jaw +8, teeth +5, lips +3). In Pine, `plot(x, offset=8)` paints
   the value computed at bar t over bar t+8 — so the value a trader's eye
   reads at bar t is the one computed 8 bars EARLIER. Every rule in this
   strategy is visual ("pointing downwards", "tangled"), so the logic must
   read the same values the chart shows, which means the displaced series.

   That direction matters: displaced values are OLDER, never newer, so this
   can never be lookahead. Using the raw undisplaced averages would be more
   responsive but would fire at different bars than the chart the rules were
   written from.

   SMMA matches Pine's:
       s := na(s[1]) ? ta.sma(src, len) : (s[1]*(len-1) + src) / len
   i.e. seeded with a simple average over the first `len` values, then a
   recursive Wilder-style smoothing. Reproduced here rather than reused from
   js/indicators.js because that file's smma is not exposed and the seeding
   convention has to match Pine bar-for-bar or the lines diverge.

   Read-only. No I/O.
   ========================================================================== */

const DEFAULTS = {
  jawLen: 13, teethLen: 8, lipsLen: 5,
  jawOff: 8, teethOff: 5, lipsOff: 3,
  tangleMult: 0.5,   // tangled when the line spread < this x ATR(14)
  slopeLook: 3       // bars back used to call the jaw rising or falling
};

/** Pine-compatible SMMA. Returns nulls until `len` values exist. */
function smma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len || len < 1) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i++) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

/** Shift a series forward by `off` bars: out[i] is the value from i-off. */
function displace(series, off) {
  const out = new Array(series.length).fill(null);
  for (let i = off; i < series.length; i++) out[i] = series[i - off];
  return out;
}

/**
 * alligator(bars, cfg) -> { jaw, teeth, lips, jawRaw, teethRaw, lipsRaw }
 * jaw/teeth/lips are the DISPLACED series — what the chart draws.
 */
function alligator(bars, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const hl2 = bars.map(b => (b.h + b.l) / 2);
  const jawRaw = smma(hl2, c.jawLen);
  const teethRaw = smma(hl2, c.teethLen);
  const lipsRaw = smma(hl2, c.lipsLen);
  return {
    jawRaw, teethRaw, lipsRaw,
    jaw: displace(jawRaw, c.jawOff),
    teeth: displace(teethRaw, c.teethOff),
    lips: displace(lipsRaw, c.lipsOff)
  };
}

/**
 * fanState -> 'bull' | 'bear' | 'tangled' | 'none'
 *
 * 'tangled' and 'none' are kept distinct for diagnostics but both mean
 * "no clean fan" to the strategy: 'tangled' is the lines bunched inside the
 * ATR threshold, 'none' is separated but not in a clean order (or the jaw
 * sloping against the fan). Reporting them apart shows whether a session
 * was skipped because the market was quiet or because it was conflicted.
 */
function fanState(A, atr, i, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const j = A.jaw[i], t = A.teeth[i], l = A.lips[i];
  if (j == null || t == null || l == null) return 'none';
  const a = atr[i];
  if (a == null || !(a > 0)) return 'none';

  const spread = Math.max(j, t, l) - Math.min(j, t, l);
  if (spread < c.tangleMult * a) return 'tangled';

  const jPrev = A.jaw[i - c.slopeLook];
  if (jPrev == null) return 'none';
  if (l > t && t > j && j > jPrev) return 'bull';
  if (l < t && t < j && j < jPrev) return 'bear';
  return 'none';
}

/** The line spread in price, for reporting. */
function fanSpread(A, i) {
  const j = A.jaw[i], t = A.teeth[i], l = A.lips[i];
  if (j == null || t == null || l == null) return null;
  return Math.max(j, t, l) - Math.min(j, t, l);
}

/**
 * The most recent clean fan direction strictly BEFORE bar i, within
 * `lookback` bars. This is the "previous trend" case 2 asks for when the
 * Alligator is tangled at the decision bar. Returns 1 | -1 | 0.
 */
function priorFanDir(A, atr, i, lookback, cfg = {}) {
  for (let k = 1; k <= lookback; k++) {
    const idx = i - k;
    if (idx < 0) break;
    const s = fanState(A, atr, idx, cfg);
    if (s === 'bull') return 1;
    if (s === 'bear') return -1;
  }
  return 0;
}

module.exports = { DEFAULTS, smma, displace, alligator, fanState, fanSpread, priorFanDir };
