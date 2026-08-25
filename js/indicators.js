/* ==========================================================================
   Wicktor — Indicator Engine
   All functions take arrays of candle objects: {t, o, h, l, c, v}
   Sorted oldest -> newest. Returns arrays aligned to the same index.
   ========================================================================== */

const Indicators = (() => {

  function medianPrice(candles) {
    return candles.map(c => (c.h + c.l) / 2);
  }

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // Smoothed moving average (Wilder-style), used for Alligator lines
  function smma(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
    }
    return out;
  }

  // Shifts a series forward by `offset` bars (Alligator lines are displaced).
  // shifted[i] = raw value that was computed `offset` bars ago,
  // i.e. what would visually be plotted at bar i.
  function shiftForward(values, offset) {
    const out = new Array(values.length).fill(null);
    for (let i = offset; i < values.length; i++) {
      out[i] = values[i - offset];
    }
    return out;
  }

  /**
   * Convert real OHLCV candles to Heikin Ashi candles using the standard
   * formula. Returns the same {t,o,h,l,c,v} shape so it is a drop-in
   * replacement for the alligator() function's input.
   *   haClose = (o + h + l + c) / 4
   *   haOpen  = (prevHaOpen + prevHaClose) / 2  (first: (o + c) / 2)
   *   haHigh  = max(h, haOpen, haClose)
   *   haLow   = min(l, haOpen, haClose)
   */
  function heikinAshi(candles) {
    const ha = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const { t, o, h, l, c, v } = candles[i];
      const haClose = (o + h + l + c) / 4;
      const haOpen  = i === 0
        ? (o + c) / 2
        : (ha[i - 1].o + ha[i - 1].c) / 2;
      const haHigh  = Math.max(h, haOpen, haClose);
      const haLow   = Math.min(l, haOpen, haClose);
      ha[i] = { t, o: haOpen, h: haHigh, l: haLow, c: haClose, v };
    }
    return ha;
  }

  /**
   * Williams Alligator on Heikin Ashi median price.
   * Jaw: SMMA(13) shifted +8, Teeth: SMMA(8) shifted +5, Lips: SMMA(5) shifted +3
   * Returns { jaw, teeth, lips, haCandles } arrays aligned to candle index.
   * haCandles is exposed so analyzeTimeframe() can pass it to alligatorTouchState()
   * without converting twice.
   */
  function alligator(candles) {
    const ha  = heikinAshi(candles);
    const med = medianPrice(ha);
    const jaw   = shiftForward(smma(med, 13), 8);
    const teeth = shiftForward(smma(med,  8), 5);
    const lips  = shiftForward(smma(med,  5), 3);
    return { jaw, teeth, lips, haCandles: ha };
  }

  /**
   * Walk the HA candle series forward and track whether the alligator's jaw
   * has been touched (invalidating the current move) and not yet cleared.
   *
   * Bullish context (lips > teeth > jaw at bar i):
   *   - Invalidate when haCandles[i].l <= jaw[i]
   *   - Clear when a later haCandles[k].c > lips[k]
   *
   * Bearish context (lips < teeth < jaw at bar i):
   *   - Invalidate when haCandles[i].h >= jaw[i]
   *   - Clear when a later haCandles[k].c < lips[k]
   *
   * Returns a boolean array aligned to candle index (true = invalidated).
   */
  function alligatorTouchState(haCandles, jaw, teeth, lips) {
    const n = haCandles.length;
    const invalidated = new Array(n).fill(false);
    let isInvalidated = false;
    // Which mouth the active invalidation was earned in. Without this the
    // flag leaked: a jaw touch during a BEARISH mouth stayed active after
    // the mouth flipped bullish, and since analyzeTimeframe() forces
    // alignment to 0 whenever the flag is set, a brand-new valid bullish
    // setup was suppressed by an event from the opposite trend. An
    // invalidation is a statement about one move, so it dies with it.
    let invalidatedIn = null; // 'bull' | 'bear' | null

    for (let i = 0; i < n; i++) {
      const jawV   = jaw[i];
      const teethV = teeth[i];
      const lipsV  = lips[i];

      // Need all three lines present to make a determination
      if (jawV == null || teethV == null || lipsV == null) {
        invalidated[i] = false;
        continue;
      }

      const bullish = lipsV > teethV && teethV > jawV;
      const bearish = lipsV < teethV && teethV < jawV;

      // A directional mouth that disagrees with where the invalidation came
      // from means the original move is over — retire the flag rather than
      // carrying it into an unrelated trend. Mixed/flat bars are NOT treated
      // as a context change; the mouth is simply undecided, and a temporary
      // flattening shouldn't clear a still-live invalidation.
      const ctx = bullish ? 'bull' : bearish ? 'bear' : null;
      if (isInvalidated && ctx && invalidatedIn && ctx !== invalidatedIn) {
        isInvalidated = false;
        invalidatedIn = null;
      }

      if (bullish) {
        if (isInvalidated) {
          // Clear condition: HA close back above lips
          if (haCandles[i].c > lipsV) { isInvalidated = false; invalidatedIn = null; }
        } else {
          // Invalidate condition: HA low dips into or through jaw
          if (haCandles[i].l <= jawV) { isInvalidated = true; invalidatedIn = 'bull'; }
        }
      } else if (bearish) {
        if (isInvalidated) {
          // Clear condition: HA close back below lips
          if (haCandles[i].c < lipsV) { isInvalidated = false; invalidatedIn = null; }
        } else {
          // Invalidate condition: HA high touches or exceeds jaw
          if (haCandles[i].h >= jawV) { isInvalidated = true; invalidatedIn = 'bear'; }
        }
      } else {
        // Mixed/flat: don't flip state, just carry forward
      }

      invalidated[i] = isInvalidated;
    }

    return invalidated;
  }

  /**
   * Divergent Bar (grigorykov's AFDSA) — a REVERSAL signal, not
   * continuation. Fires bullish specifically when the Alligator is in
   * BEARISH order (lips < teeth < jaw), catching the bar that dips
   * furthest below a bearish mouth and snaps back (mirror for bearish DB
   * in a bullish mouth). Runs on the same HA candles as the Alligator
   * lines. Uses only the strict tier (the reference script's simple/medium
   * tiers are intermediate steps toward it); the medium tier's "OR
   * downFractal" branch is dropped since fractals are computed on real
   * candles elsewhere in Wicktor and cross-referencing them here would mix
   * two different candle bases for one signal — the `low <= low[2]` check
   * alone still captures the core bar-shape condition.
   * Returns { up, down } booleans for bar `i`.
   */
  function divergentBar(haCandles, jaw, teeth, lips, i) {
    if (i < 2) return { up: false, down: false };
    const jawV = jaw[i], teethV = teeth[i], lipsV = lips[i];
    if (jawV == null || teethV == null || lipsV == null) return { up: false, down: false };

    const bar = haCandles[i], prev1 = haCandles[i - 1], prev2 = haCandles[i - 2];
    const hl2 = (bar.h + bar.l) / 2;

    const simpleUp = bar.h < jawV && bar.h < teethV && bar.h < lipsV &&
                      bar.l < prev1.l && bar.c > hl2;
    const mediumUp = simpleUp && bar.l <= prev2.l;
    const strictUp = mediumUp && lipsV < teethV && teethV < jawV;

    const simpleDown = bar.l > jawV && bar.l > teethV && bar.l > lipsV &&
                        bar.h > prev1.h && bar.c < hl2;
    const mediumDown = simpleDown && bar.h >= prev2.h;
    const strictDown = mediumDown && lipsV > teethV && teethV > jawV;

    return { up: strictUp, down: strictDown };
  }

  /**
   * Crossing Lips — an early, softer warning tier between "fully aligned"
   * and jaw-touch invalidation: the Alligator is STILL in the original
   * trend's order while price, having closed on the trend side of lips for
   * 2 straight bars, just closed back through it. Non-invalidating by
   * design — a UI-only warning flag, not wired into the alignment/
   * touch-state logic (kept separate deliberately: see backlog notes).
   * Returns { up, down } booleans for bar `i`.
   */
  function crossingLips(haCandles, jaw, teeth, lips, i) {
    if (i < 2) return { up: false, down: false };
    const teethV = teeth[i], jawV = jaw[i];
    const l0 = lips[i], l1 = lips[i - 1], l2 = lips[i - 2];
    if (l0 == null || l1 == null || l2 == null || teethV == null || jawV == null) {
      return { up: false, down: false };
    }
    const c0 = haCandles[i].c, c1 = haCandles[i - 1].c, c2 = haCandles[i - 2].c;

    const down = c0 < l0 && c1 > l1 && c2 > l2 && l0 > teethV && teethV > jawV;
    const up   = c0 > l0 && c1 < l1 && c2 < l2 && l0 < teethV && teethV < jawV;
    return { up, down };
  }

  /**
   * Awesome Oscillator: SMA(median,5) - SMA(median,34)
   * Operates on REAL candles — unchanged.
   */
  function awesomeOscillator(candles) {
    const med = medianPrice(candles);
    const fast = sma(med, 5);
    const slow = sma(med, 34);
    return med.map((_, i) => {
      if (fast[i] == null || slow[i] == null) return null;
      return fast[i] - slow[i];
    });
  }

  // SMA that treats a null anywhere in the window as "not enough data yet"
  // rather than propagating NaN — needed for accelerator(), whose input
  // (AO) itself starts with a run of nulls.
  function smaSkipNulls(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let k = i - period + 1; k <= i; k++) {
        if (values[k] == null) { ok = false; break; }
        sum += values[k];
      }
      if (ok) out[i] = sum / period;
    }
    return out;
  }

  /**
   * Accelerator Oscillator (Bill Williams): AO - SMA(AO, 5). Measures
   * whether AO's own momentum is accelerating/decelerating, catching a
   * shift before AO itself crosses zero. Operates on REAL candles.
   */
  function acceleratorOscillator(candles) {
    const aoSeries = awesomeOscillator(candles);
    const aoSma5 = smaSkipNulls(aoSeries, 5);
    return aoSeries.map((v, i) => (v == null || aoSma5[i] == null) ? null : v - aoSma5[i]);
  }

  /**
   * Market Facilitation Index (Bill Williams): (high - low) / volume.
   * Operates on REAL candles.
   */
  function mfi(candles) {
    return candles.map(c => (c.v > 0 ? (c.h - c.l) / c.v : null));
  }

  /**
   * Squat / Fake / Green bar classification (Bill Williams), from the
   * 1-bar rate of change of MFI and of volume:
   *   Squat = mfiDiff < 0 AND volumeDiff > 0   -> reversal warning
   *   Fake  = mfiDiff > 0 AND volumeDiff < 0   -> weak/unconvincing move
   *   Green = mfiDiff > 0 AND volumeDiff > 0   -> continuation confirmation
   * The 4th combination (both falling) is labeled 'fade' — informational
   * only, not fed into scoring.
   * Returns an array of 'squat'|'fake'|'green'|'fade'|null aligned to candle index.
   */
  function mfiClassification(candles) {
    const mfiSeries = mfi(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = 1; i < candles.length; i++) {
      if (mfiSeries[i] == null || mfiSeries[i - 1] == null) continue;
      const mfiDiff = mfiSeries[i] - mfiSeries[i - 1];
      const volumeDiff = candles[i].v - candles[i - 1].v;
      if (mfiDiff < 0 && volumeDiff > 0) out[i] = 'squat';
      else if (mfiDiff > 0 && volumeDiff < 0) out[i] = 'fake';
      else if (mfiDiff > 0 && volumeDiff > 0) out[i] = 'green';
      else out[i] = 'fade';
    }
    return out;
  }

  /**
   * "Wiseman" AO-shape reversal signals — two independent patterns, keyed
   * off AO's own shape alone (distinct from the Alligator-based Divergent
   * Bar). Wiseman1: price makes a fresh 2-bar low but closes in the upper
   * half of the bar while AO is still falling for 2 bars straight — a
   * momentum/price disagreement. Wiseman2: AO is in a "trough, rise, dip,
   * rise" shape below zero — a double-bottom in the histogram itself.
   * Mirror conditions (Wiseman1/2 short) for the bearish case.
   * Operates on REAL candles. Returns booleans for bar `i`.
   */
  function wisemanSignals(candles, aoSeries, i) {
    const none = { long1: false, long2: false, short1: false, short2: false };
    if (i < 4) return none;
    const ao0 = aoSeries[i], ao1 = aoSeries[i - 1], ao2 = aoSeries[i - 2],
          ao3 = aoSeries[i - 3], ao4 = aoSeries[i - 4];
    if ([ao0, ao1, ao2, ao3, ao4].some(v => v == null)) return none;

    const bar = candles[i], prev = candles[i - 1];
    const ohlc4 = (bar.o + bar.h + bar.l + bar.c) / 4;
    const lowest2 = Math.min(bar.l, prev.l);
    const highest2 = Math.max(bar.h, prev.h);

    return {
      long1:  bar.c > ohlc4 && bar.l === lowest2 && ao0 < 0 && ao0 < ao1 && ao1 < ao2,
      long2:  ao0 < 0 && ao0 > ao1 && ao1 > ao2 && ao2 > ao3 && ao3 < ao4,
      short1: bar.c < ohlc4 && bar.h === highest2 && ao0 > 0 && ao0 > ao1 && ao1 > ao2,
      short2: ao0 > 0 && ao0 < ao1 && ao1 < ao2 && ao2 < ao3 && ao3 > ao4
    };
  }

  /**
   * Williams Fractals (5-bar) with tie-tolerance. A run of equal
   * high (or low) values up to `tolerance` bars wide is treated as a
   * single peak/trough rather than blocking detection — ported from the
   * AFDSA/AlFReSco reference scripts, since the original strict-inequality
   * check could miss a real fractal on a tie. The plateau must still be
   * flanked by 2 strictly lower (or higher) bars on both sides just
   * outside the run, and is reported once, at the LAST bar of the tie
   * (so it's still only confirmed once 2 bars exist after it — same
   * confirmation-lag semantics as before). tolerance defaults to 5,
   * matching the reference scripts; a plateau of 1 bar (no tie) reduces
   * to the original classic strict 5-bar fractal test.
   * Returns { up: [indices], down: [indices] }
   * Operates on REAL candles — unchanged.
   */
  function fractals(candles, tolerance = 5) {
    const n = candles.length;
    const up = [];
    const down = [];
    for (let i = 2; i < n - 2; i++) {
      if (isFractalEdge(candles, i, 'h', tolerance, n, false)) up.push(i);
      if (isFractalEdge(candles, i, 'l', tolerance, n, true)) down.push(i);
    }
    return { up, down };
  }

  function isFractalEdge(candles, i, key, tolerance, n, isLow) {
    const v = candles[i][key];

    // Walk across bars tied with the center value (the plateau), capped
    // at `tolerance` bars from i on each side.
    let left = i;
    while (left > 0 && candles[left - 1][key] === v && (i - (left - 1)) <= tolerance) left--;
    let right = i;
    while (right < n - 1 && candles[right + 1][key] === v && ((right + 1) - i) <= tolerance) right++;

    // Only flag once, at the plateau's rightmost bar.
    if (i !== right) return false;
    if (left < 2 || right > n - 3) return false;

    const outer = [candles[left - 2][key], candles[left - 1][key], candles[right + 1][key], candles[right + 2][key]];
    return isLow ? outer.every(x => x > v) : outer.every(x => x < v);
  }

  function lastFractal(fractalIndices, beforeIndex) {
    for (let i = fractalIndices.length - 1; i >= 0; i--) {
      if (fractalIndices[i] <= beforeIndex) return fractalIndices[i];
    }
    return null;
  }

  /**
   * True Range and Wilder-smoothed ATR. Operates on REAL candles.
   */
  function trueRange(candles) {
    const out = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) { out[i] = candles[i].h - candles[i].l; continue; }
      const prevClose = candles[i - 1].c;
      out[i] = Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - prevClose),
        Math.abs(candles[i].l - prevClose)
      );
    }
    return out;
  }

  function atr(candles, period = 14) {
    return smma(trueRange(candles), period);
  }

  // ATR expressed as a fraction of price, bucketed into discrete steps
  // rather than used as a raw continuous value — reduces noise-driven
  // jitter in anything derived from it (Skyrexio pattern). Fractions, not
  // fixed dollar steps, so it scales across assets from micro-cap tokens
  // to BTC. Snaps UP to the nearest bucket at or above the raw ratio;
  // ratios beyond the largest bucket are left unbucketed (real
  // high-volatility conditions, not noise).
  //
  // The ladder is roughly geometric (~1.5x per step) so quantization error
  // is bounded at the same *relative* size everywhere. The original ladder
  // started at 0.1%, which meant a genuinely low-volatility pair reading
  // 0.01% ATR was snapped up 10x — that isn't quantizing noise, it's
  // inventing volatility, and every ATR-relative distance check downstream
  // inherited it. Below the smallest bucket values pass through unbucketed,
  // mirroring how the top of the ladder already behaves.
  const ATR_PCT_BUCKETS = [0.0005, 0.00075, 0.001, 0.0015, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015];

  function bucketedAtr(atrValue, price) {
    if (atrValue == null || !price) return atrValue;
    const ratio = atrValue / price;
    // Off BOTH ends of the ladder, pass the raw ratio through. Without the
    // low-end check, find() snaps anything under the smallest bucket up to
    // it — which is how a 0.01% ATR became 0.1%.
    if (ratio < ATR_PCT_BUCKETS[0]) return atrValue;
    const bucket = ATR_PCT_BUCKETS.find(b => ratio <= b);
    return (bucket != null ? bucket : ratio) * price;
  }

  /**
   * Nearest-fractal support/resistance around the current price — reuses the
   * same fractal set as the jaw-touch SL / "last opposing fractal" logic
   * elsewhere, rather than introducing a second unrelated notion of "level".
   * Resistance = nearest fractal high above price; Support = nearest
   * fractal low below price, both within `lookback` bars of the latest bar.
   * Falls back to a bucketed-ATR-scaled buffer when no fractal exists on
   * that side (e.g. price at a new high/low within the window).
   *
   * `lookback` defaulted to 150 against a 100-candle fetch, so it never
   * actually constrained anything — every fractal in the series qualified
   * regardless of age. Defaulted to the real window size now so the code
   * states what it does. Genuine recency/strength weighting (a level
   * touched four times matters more than one touched once) is a separate
   * piece of work, not something this parameter was ever doing.
   */
  function nearestLevels(candles, frac, price, atrValue, lookback = 100) {
    const minIdx = Math.max(0, candles.length - 1 - lookback);

    let resistance = null;
    frac.up.forEach(i => {
      if (i < minIdx) return;
      const h = candles[i].h;
      if (h > price && (resistance == null || h < resistance)) resistance = h;
    });

    let support = null;
    frac.down.forEach(i => {
      if (i < minIdx) return;
      const l = candles[i].l;
      if (l < price && (support == null || l > support)) support = l;
    });

    // Provenance matters downstream: the fallback below is a synthetic
    // buffer, not an observed level. Risk:reward built on two synthetic
    // levels is a fabricated ratio dressed up as a measurement, so callers
    // need to be able to tell the difference rather than trusting a number.
    const resistanceFromFractal = resistance != null;
    const supportFromFractal = support != null;

    const atrBucketed = bucketedAtr(atrValue, price) ?? price * 0.01;
    const atrBuffer = atrBucketed * 1.5;
    if (resistance == null) resistance = price + atrBuffer;
    if (support == null) support = price - atrBuffer;

    return { resistance, support, resistanceFromFractal, supportFromFractal };
  }

  /**
   * RSI, Wilder's smoothing, standard 14-period default.
   * Operates on REAL candles — unchanged.
   */
  function rsi(candles, period = 14) {
    const closes = candles.map(c => c.c);
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;

    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gainSum += diff; else lossSum -= diff;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  /**
   * Divergence check between price pivots (fractal highs/lows) and RSI
   * at those same pivots. Looks at the two most recent same-type
   * fractals within `lookback` bars of the latest closed bar.
   * Returns 'bull' | 'bear' | 'none'
   * Operates on REAL candles — unchanged.
   */
  function divergence(candles, rsiSeries, frac, lookback = 60) {
    const lastIdx = candles.length - 1;
    const minIdx = Math.max(0, lastIdx - lookback);

    const recentDown = frac.down.filter(i => i >= minIdx);
    if (recentDown.length >= 2) {
      const [i1, i2] = recentDown.slice(-2);
      const priceLower = candles[i2].l < candles[i1].l;
      const rsiHigher = rsiSeries[i2] != null && rsiSeries[i1] != null &&
                         rsiSeries[i2] > rsiSeries[i1];
      if (priceLower && rsiHigher) return 'bull';
    }

    const recentUp = frac.up.filter(i => i >= minIdx);
    if (recentUp.length >= 2) {
      const [i1, i2] = recentUp.slice(-2);
      const priceHigher = candles[i2].h > candles[i1].h;
      const rsiLower = rsiSeries[i2] != null && rsiSeries[i1] != null &&
                        rsiSeries[i2] < rsiSeries[i1];
      if (priceHigher && rsiLower) return 'bear';
    }

    return 'none';
  }

  /**
   * 5-tier per-TF alignment confidence (Profitunity multi-timeframe
   * screener), richer than the binary aligned/not-aligned `alignment`
   * value: grades HOW CLEAN the current alignment is by checking whether
   * any of the last 5 HA closes dipped back across lips against the
   * trend (a weakening/recovering tell that precedes an actual jaw-touch
   * invalidation). Only meaningful when `alignment` is already non-zero
   * (jaw-touch already resets alignment to 0, so "opposite trend" here
   * just falls out of alignment === -1 vs 1 — no separate case needed).
   * Returns 'strong_bull' | 'weak_bull' | 'neutral' | 'weak_bear' | 'strong_bear'.
   */
  function tfConfidenceTier(haCandles, lips, alignment, lastIdx) {
    if (alignment === 0) return 'neutral';
    const from = Math.max(0, lastIdx - 4);
    let wrongSideCount = 0;
    for (let k = from; k <= lastIdx; k++) {
      const lipsV = lips[k];
      if (lipsV == null) continue;
      if (alignment === 1 && haCandles[k].c < lipsV) wrongSideCount++;
      else if (alignment === -1 && haCandles[k].c > lipsV) wrongSideCount++;
    }
    if (wrongSideCount === 0) return alignment === 1 ? 'strong_bull' : 'strong_bear';
    return alignment === 1 ? 'weak_bull' : 'weak_bear';
  }

  /**
   * Entry triggers and how many bars ago each last fired.
   *
   * Everything else in the snapshot answers "what is true right now"; this
   * answers "what just happened". The distinction is the difference between
   * a STATE (EMA stacked, price above cloud, ADX high — an ongoing
   * condition) and an EVENT (a cross, a breakout, a sweep — something that
   * occurred on a specific bar). Continuation scoring is built almost
   * entirely from states, which is why it can say a setup looks good without
   * being able to say there is an entry here now.
   *
   * Age is the point. Every existing cross field (macdBullishCross,
   * stochBullishCrossFromOversold, ...) is evaluated only at the final bar,
   * so a cross that fired one bar earlier is invisible — the signal exists
   * for exactly one scan and then vanishes. On a 5M chart scanned every few
   * minutes that is far too brittle to build entries on, and it is part of
   * why freshness had to be faked with discovery timestamps. Reporting
   * barsAgo lets a caller decide what still counts as actionable instead of
   * silently losing anything older than the current bar.
   *
   * Returns triggers within `lookback` bars, freshest first:
   *   [{ name, direction, barsAgo }]   barsAgo 0 = the last CLOSED bar.
   *
   * Detection only — no grading. Which triggers matter, and how much a
   * 3-bar-old one is worth versus a fresh one, is a scoring decision.
   */
  const TRIGGER_LOOKBACK = 8;

  function detectTriggers(ctx, lookback = TRIGGER_LOOKBACK) {
    const { candles, macdRes, stochRes, bb, frac, atrSeries, lastIdx } = ctx;
    const out = [];
    const from = Math.max(1, lastIdx - lookback + 1);

    const crossedUp = (a, b, k) =>
      a[k] != null && b[k] != null && a[k - 1] != null && b[k - 1] != null &&
      a[k - 1] <= b[k - 1] && a[k] > b[k];
    const crossedDown = (a, b, k) =>
      a[k] != null && b[k] != null && a[k - 1] != null && b[k - 1] != null &&
      a[k - 1] >= b[k - 1] && a[k] < b[k];

    // Walk newest-first and keep only the most recent firing of each name,
    // so a trigger that repeated is reported at its freshest occurrence.
    const seen = new Set();
    const push = (name, direction, k) => {
      const key = `${name}:${direction}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, direction, barsAgo: lastIdx - k });
    };

    for (let k = lastIdx; k >= from; k--) {
      // MACD signal-line cross
      if (crossedUp(macdRes.macdLine, macdRes.signalLine, k)) push('macdCross', 1, k);
      if (crossedDown(macdRes.macdLine, macdRes.signalLine, k)) push('macdCross', -1, k);

      // Stochastic cross out of an extreme — the extreme is required, since
      // a %K/%D cross mid-range is noise rather than an entry.
      if (crossedUp(stochRes.k, stochRes.d, k) && stochRes.k[k - 1] != null && stochRes.k[k - 1] < 20) {
        push('stochCrossFromExtreme', 1, k);
      }
      if (crossedDown(stochRes.k, stochRes.d, k) && stochRes.k[k - 1] != null && stochRes.k[k - 1] > 80) {
        push('stochCrossFromExtreme', -1, k);
      }

      // Band breakout: the close moving from inside the band to outside it.
      // Requires the transition, not merely being outside, which would make
      // a multi-bar excursion re-fire every bar.
      if (bb.upper[k] != null && bb.upper[k - 1] != null &&
          candles[k].c > bb.upper[k] && candles[k - 1].c <= bb.upper[k - 1]) {
        push('bandBreakout', 1, k);
      }
      if (bb.lower[k] != null && bb.lower[k - 1] != null &&
          candles[k].c < bb.lower[k] && candles[k - 1].c >= bb.lower[k - 1]) {
        push('bandBreakout', -1, k);
      }

      // Band FADE — the mirror of the above, and the one the audit says
      // actually pays on a fast timeframe. Price was at or beyond a band
      // edge and has closed back inside: the stretch failed. Direction is
      // the reversion, so an upper-band rejection is bearish.
      //
      // Added because "%B at an extreme" scored +0.104 balanced on 5M, the
      // single best directional reading of any indicator on that timeframe,
      // while bandBreakout (price LEAVING the band, the trend-following
      // half) measured -0.183. The fast timeframe rewards fading stretch and
      // punishes chasing it, and only the chasing half was wired up.
      if (bb.upper[k] != null && bb.upper[k - 1] != null &&
          candles[k].c <= bb.upper[k] && candles[k - 1].c > bb.upper[k - 1]) {
        push('bandFade', -1, k);
      }
      if (bb.lower[k] != null && bb.lower[k - 1] != null &&
          candles[k].c >= bb.lower[k] && candles[k - 1].c < bb.lower[k - 1]) {
        push('bandFade', 1, k);
      }

      // Liquidity sweep — wick through a level, close back inside. Direction
      // follows liquiditySweep()'s own convention: `up` is a downside sweep
      // that got reclaimed (bullish), `down` is an upside rejection.
      const sweep = liquiditySweep(candles, frac, k, atrSeries[k]);
      if (sweep.up) push('liquiditySweep', 1, k);
      if (sweep.down) push('liquiditySweep', -1, k);

      // Structural break: close crossing the most recent confirmed fractal.
      // lastFractal(..., k - 2) keeps the same confirmation lag used
      // everywhere else, so this never reads a fractal that wasn't yet
      // confirmed at bar k.
      const upFrac = lastFractal(frac.up, k - 2);
      if (upFrac != null && candles[k].c > candles[upFrac].h && candles[k - 1].c <= candles[upFrac].h) {
        push('levelBreak', 1, k);
      }
      const downFrac = lastFractal(frac.down, k - 2);
      if (downFrac != null && candles[k].c < candles[downFrac].l && candles[k - 1].c >= candles[downFrac].l) {
        push('levelBreak', -1, k);
      }
    }

    return out.sort((a, b) => a.barsAgo - b.barsAgo);
  }

  /**
   * Risk:reward for a candidate trade on one timeframe.
   *
   * The arithmetic is trivial; the definitions are the whole problem, so
   * they were chosen by simulating candidates forward rather than by
   * plausibility (tools/compare-rr-definitions.js: enter at bar i's close,
   * walk i+1..i+24, stop or target first, both-touched counted as a stop,
   * timeouts marked to market, run in BOTH directions and averaged).
   *
   *  STOP = last opposing fractal, plus a 0.25 ATR buffer so an exact-level
   *  wick doesn't take you out, floored at 0.4 ATR. The floor matters: a
   *  swing low sitting 0.1 ATR under entry produces a spectacular ratio that
   *  noise removes instantly, i.e. manufactured R:R. Falls back to 1.0 ATR
   *  when no opposing structure exists.
   *
   *  TARGET = the SECOND structural level in the trade's direction, not the
   *  nearest. Measured, across both 15M and 5M and every stop variant, the
   *  nearest level yields a median ratio of 0.23-0.83 — you are risking more
   *  than the target pays — while the second yields 0.75-1.70. The nearest
   *  fractal is where price stalls, not a realistic objective; a real move
   *  trades through minor resistance. `firstObstacle` is returned separately
   *  so the UI can still show where that stall is likely.
   *
   * ---------------------------------------------------------------------
   * WHAT THIS NUMBER IS NOT: a quality score. Measured on ~1,500 simulated
   * trades per definition per timeframe, drift-neutral balanced expectancy
   * is indistinguishable from zero for EVERY stop/target pairing tested
   * (best +0.08R, and its long and short halves disagree by more than that).
   * There is no monotonic "higher R:R = better trade" relationship, because
   * the win-rate penalty of a wider target cancels the payoff gain — median
   * ratio 3.0 definitions won 20-34% of the time, ratio ~1.0 won ~50-59%.
   *
   * So R:R must not be weighted as "more is better" in scoring. Its honest
   * uses are: a VIABILITY GATE (below 1.0 you are risking more than the
   * setup can pay, regardless of how good it looks), a position-sizing input
   * for the bot, and the actionable entry/stop/target numbers a paying user
   * needs. Edge has to come from signal selection; geometry alone has none.
   * ---------------------------------------------------------------------
   *
   * `direction` is +1 long / -1 short. Returns null for direction 0.
   */
  const RR = {
    stopBufferAtr: 0.25,
    minStopAtr: 0.4,
    fallbackStopAtr: 1.0,
    targetPct: 4.0,       // objective as % of ENTRY PRICE — see the note below
    minRiskPct: 1.0,      // below this, fees are unwinnable
    maxRiskPct: 25.0      // above this the structure is pathological
  };

  /**
   * `stopFrom` is the snapshot whose structure the stop rides, and it
   * DEFAULTS TO A HIGHER TIMEFRAME than the entry. That is the fee fix, and
   * it is the single most consequential number in the model:
   *
   *   fees in R = (fee % of price) / (1R as % of price)
   *
   * Only the stop appears in that. A 5M structural stop is far too tight to
   * survive it; riding the 1H structure is what makes the model viable.
   *
   * CORRECTION (measured 2026-08-25, tools/analyze-riskpct.js). The "1R =
   * 0.952% of price" figure previously quoted here came from
   * sweep-stop-target.js, which was NOT computing what this function does:
   * it took levelsBelow[0] unfiltered — a 1H level can sit on the wrong side
   * of a 5M close, yielding a meaninglessly small distance — and buffered
   * with the 5M ATR. This function filters to levels genuinely against the
   * trade and buffers with the STOP source's ATR. Production 1R is therefore
   * a MEDIAN OF ~2.4%, ranging from under 1% to over 25%, not 0.952%.
   * The choice of 1H still stands; only the absolute figure was wrong.
   *
   * That correction is what motivates the floor and the cap below.
   *
   * The buffer and floor are measured in the STOP source's own ATR, since
   * that is the timeframe whose noise could wick you out of that level.
   *
   * TARGET IS A PRICE MOVE, NOT AN R-MULTIPLE. This replaces the fixed 3R,
   * and the reason is the correction above: when 1R ranges from 0.5% to 25%
   * of price, "3R" means a 1.5% move for one signal and a 75% move for
   * another. The market does not care how far away your invalidation level
   * sits. Measured, the fixed 3R hit its target on 4.7% of trades and timed
   * out on 74.8% — it was not a 3R strategy at all, it was a four-hour hold
   * scored at mark-to-market.
   *
   * Both fixture sets agree on a ~4% objective, which is why it was chosen:
   *
   *              1%      2%      3%      4%      5%      (target move)
   *   out-samp  +.057   +.067   +.076   +.086   +.097
   *   in-samp   +.051   +.068   +.087   +.094   +.085
   *
   * The R-multiple framing does NOT survive the same test — the two sets
   * disagree completely on the best multiple (0.75R out-of-sample, 2R
   * in-sample), which is what a fitted parameter looks like. Agreement
   * across independent periods is the whole reason to prefer this form.
   *
   * The floor is the other half. Below ~1% risk, the 0.11% taker round trip
   * costs more than 0.11R and the edge cannot cover it: that bucket loses
   * at EVERY target tested (-0.18R to -0.25R). Both the floor and the cap
   * report through `viable`, which scoring.js already uses to cap the score
   * at NO_RR_CAP — so an unwinnable-by-fees setup can no longer reach
   * EXCELLENT no matter how good its structure looks.
   */
  function riskReward(entrySnap, direction, opts = {}) {
    const t = Object.assign({}, RR, opts.params);
    if (!entrySnap || !direction) return null;
    const { close } = entrySnap;
    const entryAtr = entrySnap.atr;
    if (close == null || entryAtr == null || entryAtr <= 0) return null;

    const stopSrc = opts.stopFrom || entrySnap;
    const stopAtr = (stopSrc.atr != null && stopSrc.atr > 0) ? stopSrc.atr : entryAtr;
    const against = direction === 1 ? (stopSrc.levelsBelow || []) : (stopSrc.levelsAbove || []);
    const toward = direction === 1 ? (entrySnap.levelsAbove || []) : (entrySnap.levelsBelow || []);

    // --- stop -------------------------------------------------------------
    // The level must actually sit on the losing side of THIS entry: a 1H
    // swing low can be above a 5M close, which would put the stop in profit.
    const usable = against.filter(l => direction === 1 ? l < close : l > close);
    let riskDist, stopFromStructure;
    if (usable.length) {
      riskDist = Math.abs(close - usable[0]) + t.stopBufferAtr * stopAtr;
      stopFromStructure = true;
    } else {
      riskDist = t.fallbackStopAtr * stopAtr;
      stopFromStructure = false;
    }
    // Widen rather than reject: the setup is still real, its stop just can't
    // sit inside the noise band. Widening is the conservative direction —
    // it lowers the reported ratio rather than flattering it.
    const flooredStop = riskDist < t.minStopAtr * stopAtr;
    if (flooredStop) riskDist = t.minStopAtr * stopAtr;

    // --- target -----------------------------------------------------------
    // A fixed share of PRICE, so the objective stays a move the market can
    // actually deliver inside the hold window regardless of stop width.
    const rewardDist = close * (t.targetPct / 100);
    // The nearest real level in the trade's direction is still reported, so
    // the UI can show where price is likely to stall on the way.
    const structuralNext = toward.length ? toward[0] : null;

    const riskPct = (riskDist / close) * 100;
    // Fees are charged on price, not on R: at 1R under minRiskPct the round
    // trip costs more than the measured edge, whatever the target. Too wide
    // and the "stop" is no longer describing this trade's structure.
    const feeViable = riskPct >= t.minRiskPct && riskPct <= t.maxRiskPct;

    return {
      entry: close,
      stop: close - direction * riskDist,
      target: close + direction * rewardDist,
      firstObstacle: structuralNext,
      structuralTargetR: structuralNext != null ? Math.abs(structuralNext - close) / riskDist : null,
      riskAtr: riskDist / entryAtr,        // expressed in ENTRY-TF ATR, for display
      riskPct,                             // what actually determines fee burden
      rewardAtr: rewardDist / entryAtr,
      rewardPct: t.targetPct,
      ratio: rewardDist / riskDist,        // now VARIES — it is an output, not an input
      stopFromStructure,
      stopWidenedToFloor: flooredStop,
      feeViable,
      viable: stopFromStructure && feeViable
    };
  }

  /**
   * Market regime for one timeframe.
   *
   * Built on the Alligator's own geometry rather than bolting on a foreign
   * trend filter: Williams already describes the indicator as *sleeping*
   * (lines converged and intertwined) versus *eating* (lines fanned out and
   * ordered). alligatorSpreadAtr makes that measurable, so the regime stays
   * inside the taught method instead of running alongside it.
   *
   * Reads `lineOrder`, NOT `alignment`. alignment is forced to 0 by a jaw
   * touch, which conflates "this move got invalidated" with "there is no
   * trend here" — two different market states that need different handling.
   * Measured: lineOrder is non-zero for 78-87% of timeframes while alignment
   * is only 42-65%, and that gap is precisely the invalidated-trend cases.
   *
   * Thresholds are calibrated against frozen fixtures (see
   * tools/calibrate-regime.js), not taken from convention:
   *
   *  - spread >= 0.5 ATR sits in the measured gap between ordered mouths
   *    (p25 0.41-0.59) and closed ones (p75 0.35-0.40).
   *
   *  - adx >= 20 is Wilder's "a trend exists" line, deliberately not the 25
   *    "strong trend" line used elsewhere: on 5M only ~25% of coins clear 25,
   *    which is too strict for a scalping product. The gate is not redundant
   *    with spread despite r=0.73 — 22-38% of wide-spread coins have ADX
   *    below 20, and those are stale fans (lines still spread from a move
   *    whose momentum is gone), which must not read as TRENDING.
   *
   *  - squeeze at the 10th percentile of a bandwidth's own recent history,
   *    not the textbook 20th: 5M bandwidth percentile has a median of 18,
   *    so a 20 threshold labels a fifth of all 5M coins as squeezing and
   *    starves TRANSITION to zero. 10 holds at 10-18% across all three TFs.
   *
   * Deliberately a precedence chain rather than a weighted score of the
   * three inputs: they are strongly collinear (adx-spread 0.73,
   * adx-bandwidth 0.71), so combining them additively would triple-count one
   * underlying signal. Each input answers a distinct question instead —
   * spread/order: is the mouth open and directional; adx: is there real
   * movement behind it; bandwidth percentile: is volatility compressed.
   *
   * Returns 'trending' | 'squeeze' | 'transition' | 'ranging' | 'unknown'.
   * Direction is not returned — read `lineOrder` for that.
   *
   * ---------------------------------------------------------------------
   * VALIDITY BY TIMEFRAME — measured, and the most important caveat here.
   *
   * Forward-validated over 4,860 classifications (classify at bar i, measure
   * bars i+1..i+N, nothing from the future entering the classification; see
   * tools/validate-regime-forward.js). Median forward efficiency,
   * trending vs ranging:
   *
   *   1H    +0.10 at 12 bars, positive at every horizon 4-20   -> RELIABLE
   *   15M   +0.12 at 6-8 bars, positive 4-16                   -> RELIABLE
   *   5M    NEGATIVE at every horizon tested (3,4,6,8,12,16,20) -> DO NOT USE
   *
   * The 5M inversion is systematic, not sampling noise — it held at all
   * seven horizons with n>1000. The mechanism is that every input here is a
   * lagging description of a completed move: jaw is SMMA(13) displaced 8,
   * and ADX(14) is double-smoothed, so on 5M the mouth only finishes fanning
   * once the move is largely spent, and mean reversion follows. A
   * short-horizon momentum reading behaves as a contrarian indicator.
   *
   * Consequence for callers: take regime from 1H (and 15M), never from 5M.
   * 5M's role is entry triggering, not regime. The snapshot still carries a
   * 5M `regime` value because it is honest math on that timeframe's data and
   * is useful for display, but scoring must not treat it as predictive.
   * ---------------------------------------------------------------------
   */
  const REGIME = {
    spreadTrend: 0.5,   // ATR units of Alligator fan-out
    adxTrend: 20,       // Wilder's trend-exists line
    squeezePct: 10      // percentile of bandwidth's own trailing history
  };

  function classifyRegime({ lineOrder, alligatorSpreadAtr, adx, bbBandwidthPct }, t = REGIME) {
    if (alligatorSpreadAtr == null) return 'unknown';

    const mouthOpen = lineOrder !== 0 && alligatorSpreadAtr >= t.spreadTrend;
    const hasMovement = adx != null && adx >= t.adxTrend;
    if (mouthOpen && hasMovement) return 'trending';

    // Checked before TRANSITION so a trend that lost momentum AND compressed
    // reads as coiling rather than merely unclear — the more actionable call.
    if (bbBandwidthPct != null && bbBandwidthPct <= t.squeezePct) return 'squeeze';

    // Lines still ordered but not fanned, or fanned without movement behind
    // it: a trend forming or decaying, not a range with width to trade.
    if (lineOrder !== 0) return 'transition';

    return 'ranging';
  }

  /**
   * Convenience: compute everything for one timeframe's candles and
   * return a compact snapshot of the latest closed bar.
   *
   * Alligator + touch-state invalidation run on Heikin Ashi candles.
   * AO, RSI, Fractals, Divergence remain on real candles.
   */
  function analyzeTimeframe(candles) {
    if (!candles || candles.length < 40) return null;
    const lastIdx = candles.length - 1;

    // Alligator on HA candles
    const { jaw, teeth, lips, haCandles } = alligator(candles);

    // AO, Fractals, RSI, Divergence all on REAL candles — untouched
    const ao = awesomeOscillator(candles);
    const frac = fractals(candles);
    const rsiSeries = rsi(candles);
    const div = divergence(candles, rsiSeries, frac);

    // Raw line-ordering alignment from displaced HA-SMMA lines
    const jawV = jaw[lastIdx], teethV = teeth[lastIdx], lipsV = lips[lastIdx];
    let alignment = 0; // 1 bullish, -1 bearish, 0 mixed/flat
    if (jawV != null && teethV != null && lipsV != null) {
      if (lipsV > teethV && teethV > jawV) alignment = 1;
      else if (lipsV < teethV && teethV < jawV) alignment = -1;
    }
    // Line ordering BEFORE the invalidation override. Regime classification
    // needs the raw geometry: a jaw touch means "this move was invalidated",
    // which is a different statement from "the mouth is closed and there is
    // no trend". Collapsing both into alignment===0 is what made an
    // invalidated trend indistinguishable from a genuine range.
    const lineOrder = alignment;

    // Touch-state invalidation — walks HA candles, returns bool[] per bar
    const touchStates = alligatorTouchState(haCandles, jaw, teeth, lips);
    const alligatorInvalidated = touchStates[lastIdx];

    // If the jaw was touched and not yet cleared, override alignment to 0
    if (alligatorInvalidated) alignment = 0;

    const confidence = tfConfidenceTier(haCandles, lips, alignment, lastIdx);

    const aoV = ao[lastIdx];
    const aoPrev = ao[lastIdx - 1];
    // aoRising alone can't be negated to mean "falling": !aoRising is also
    // true when AO is exactly flat or not yet computable. Callers that used
    // !aoRising as bearish confirmation were silently crediting missing
    // data, so the falling case is now its own explicit reading.
    const aoRising = aoV != null && aoPrev != null && aoV > aoPrev;
    const aoFalling = aoV != null && aoPrev != null && aoV < aoPrev;

    const acSeries = acceleratorOscillator(candles);
    const acV = acSeries[lastIdx];
    const acPrev = acSeries[lastIdx - 1];
    const acRising = acV != null && acPrev != null && acV > acPrev;

    const mfiSignal = mfiClassification(candles)[lastIdx];

    const db = divergentBar(haCandles, jaw, teeth, lips, lastIdx);
    const crossLips = crossingLips(haCandles, jaw, teeth, lips, lastIdx);
    const wiseman = wisemanSignals(candles, ao, lastIdx);

    const lastUpFrac = lastFractal(frac.up, lastIdx - 2);
    const lastDownFrac = lastFractal(frac.down, lastIdx - 2);
    const price = candles[lastIdx].c;
    const aboveUpFractal = lastUpFrac != null && price > candles[lastUpFrac].h;
    const belowDownFractal = lastDownFrac != null && price < candles[lastDownFrac].l;

    // Series kept, not just the last value — detectTriggers() evaluates
    // liquiditySweep() across a window of bars and needs each bar's own ATR.
    const atrSeries = atr(candles);
    const atrV = atrSeries[lastIdx];

    // How far apart the three Alligator lines sit, in ATR units. This is the
    // measurable form of Williams' own sleeping/eating language: converged
    // lines = a sleeping alligator (no trend), lines fanned out = an eating
    // one. ATR-normalized so it's comparable across assets and across
    // volatility regimes, rather than a raw price distance that would mean
    // something different on BTC than on a micro-cap.
    //
    // Basis note: the lines are built on HA median price while ATR is on real
    // candles. Both are price-scale so the ratio is meaningful; using HA-
    // derived range instead would make the number harder to reason about
    // against every other ATR-relative check in the codebase.
    let alligatorSpreadAtr = null;
    if (jawV != null && teethV != null && lipsV != null && atrV != null && atrV > 0) {
      alligatorSpreadAtr = (Math.max(jawV, teethV, lipsV) - Math.min(jawV, teethV, lipsV)) / atrV;
    }

    const { resistance, support, resistanceFromFractal, supportFromFractal } =
      nearestLevels(candles, frac, price, atrV);

    // Structural levels either side of price, nearest first. riskReward()
    // needs the SECOND level, not just the nearest, so lastUpFractal /
    // lastDownFractal aren't enough. Capped at 5 a side: nothing reads past
    // the second today, and unbounded arrays in the snapshot are what the F5
    // cleanup removed for payload reasons.
    const LEVEL_CAP = 5;
    const levelsAbove = frac.up
      .map(i => candles[i].h).filter(h => h > price)
      .sort((a, b) => a - b).slice(0, LEVEL_CAP);
    const levelsBelow = frac.down
      .map(i => candles[i].l).filter(l => l < price)
      .sort((a, b) => b - a).slice(0, LEVEL_CAP);
    // v2 sloped-channel levels — additive, see regressionChannelLevels()'s
    // own doc comment for why this doesn't replace resistance/support above.
    const sloped = regressionChannelLevels(candles, frac, lastIdx);

    // ====================================================================
    // Strategy-enrichment Stage 1 — wire the 6 new indicators into the
    // snapshot as last-bar readings + simple derived state (same style as
    // the existing ao/aoRising, ac/acRising pattern above), still zero
    // effect on scoring.js — buildContinuation/buildExhaustion/
    // buildReversal don't read any of these fields yet. Strategy-specific
    // combinations (e.g. "pullback within 0.3x ATR of EMA21") are
    // deliberately NOT computed here — those belong in scoring.js in
    // Stage 2+, combining these raw readings with a strategy's own
    // threshold, not baked into the shared snapshot.
    // ====================================================================
    const closesReal = candles.map(c => c.c);
    const ema9Series = ema(closesReal, 9);
    const ema21Series = ema(closesReal, 21);
    const ema9V = ema9Series[lastIdx];
    const ema21V = ema21Series[lastIdx];
    const emaStackBullish = ema9V != null && ema21V != null && ema9V > ema21V;

    const macdResult = macd(candles);
    const macdLineV = macdResult.macdLine[lastIdx];
    const macdSignalV = macdResult.signalLine[lastIdx];
    const macdHistV = macdResult.histogram[lastIdx];
    const macdHistPrev = macdResult.histogram[lastIdx - 1];
    const macdLinePrev = macdResult.macdLine[lastIdx - 1];
    const macdSignalPrev = macdResult.signalLine[lastIdx - 1];
    const macdBullishCross = macdLineV != null && macdSignalV != null && macdLinePrev != null && macdSignalPrev != null &&
      macdLinePrev <= macdSignalPrev && macdLineV > macdSignalV;
    const macdBearishCross = macdLineV != null && macdSignalV != null && macdLinePrev != null && macdSignalPrev != null &&
      macdLinePrev >= macdSignalPrev && macdLineV < macdSignalV;
    const macdHistogramRising = macdHistV != null && macdHistPrev != null && macdHistV > macdHistPrev;

    const bb = bollingerBands(candles);
    const bbUpperV = bb.upper[lastIdx];
    const bbLowerV = bb.lower[lastIdx];
    const bbPercentBV = bb.percentB[lastIdx];
    const bbBandwidthV = bb.bandwidth[lastIdx];
    const bbExpanding = bbBandwidthV != null && bb.bandwidth[lastIdx - 1] != null && bbBandwidthV > bb.bandwidth[lastIdx - 1];
    // Bandwidth's rank against its own recent history — the squeeze measure.
    // (bbBandwidth was dropped in the F5 dead-field cleanup because nothing
    // read it; regime classification is the consumer that makes it live
    // again, now paired with the percentile that gives it meaning.)
    const bbBandwidthPct = percentileRank(bb.bandwidth, lastIdx);

    const adxResult = adx(candles);
    const adxV = adxResult.adx[lastIdx];

    const stochResult = stochastic(candles);
    const stochKV = stochResult.k[lastIdx];
    const stochDV = stochResult.d[lastIdx];
    const stochKPrev = stochResult.k[lastIdx - 1];
    const stochDPrev = stochResult.d[lastIdx - 1];
    // "Entry cross from oversold/overbought" per the strategy definitions
    // (section 4.3, items 5/6) — the cross itself, gated on having been
    // on the extreme side the bar before, not just any K/D cross anywhere.
    const stochBullishCrossFromOversold = stochKV != null && stochDV != null && stochKPrev != null && stochDPrev != null &&
      stochKPrev <= stochDPrev && stochKV > stochDV && stochKPrev < 20;
    const stochBearishCrossFromOverbought = stochKV != null && stochDV != null && stochKPrev != null && stochDPrev != null &&
      stochKPrev >= stochDPrev && stochKV < stochDV && stochKPrev > 80;

    const ich = ichimoku(candles);
    const ichimokuAboveCloud = ich.currentSpanA != null && ich.currentSpanB != null &&
      price > ich.currentSpanA && price > ich.currentSpanB;
    const ichimokuBelowCloud = ich.currentSpanA != null && ich.currentSpanB != null &&
      price < ich.currentSpanA && price < ich.currentSpanB;

    const sweep = liquiditySweep(candles, frac, lastIdx, atrV);

    const regime = classifyRegime({
      lineOrder, alligatorSpreadAtr, adx: adxV, bbBandwidthPct
    });

    const triggers = detectTriggers({
      candles, macdRes: macdResult, stochRes: stochResult, bb, frac, atrSeries, lastIdx
    });

    // MACD/Stochastic divergence (strategy-enrichment #9) — divergence()
    // is already fully generic (never RSI-specific internally), so this
    // reuses it directly against macdLine/stochK instead of a new
    // "macdDivergence()" function, per Stage 1's own note.
    const macdDivergenceV = divergence(candles, macdResult.macdLine, frac);
    const stochDivergenceV = divergence(candles, stochResult.k, frac);

    return {
      alignment,              // 1 / -1 / 0 (0 if jaw was touched and not cleared)
      lineOrder,              // raw line ordering, BEFORE the invalidation override
      alligatorSpreadAtr,     // line fan-out in ATR units (sleeping vs eating)
      regime,                 // trending / squeeze / transition / ranging / unknown
      triggers,               // [{name, direction, barsAgo}] freshest first, 0 = last closed bar
      confidence,             // 5-tier: strong_bull/weak_bull/neutral/weak_bear/strong_bear
      alligatorInvalidated,   // true if jaw-touch rule is currently active
      ao: aoV,
      aoRising,
      aoFalling,
      ac: acV,
      acRising,
      mfiSignal,
      divergentBarUp: db.up,
      divergentBarDown: db.down,
      crossingLipsUp: crossLips.up,
      crossingLipsDown: crossLips.down,
      wisemanBullish: wiseman.long1 || wiseman.long2,
      wisemanBearish: wiseman.short1 || wiseman.short2,
      rsi: rsiSeries[lastIdx],
      divergence: div,
      lastUpFractal: lastUpFrac != null ? candles[lastUpFrac].h : null,
      lastDownFractal: lastDownFrac != null ? candles[lastDownFrac].l : null,
      aboveUpFractal,
      belowDownFractal,
      atr: atrV,
      resistance,
      support,
      resistanceFromFractal, supportFromFractal, // false = synthetic ATR buffer, not an observed level
      levelsAbove, levelsBelow, // nearest-first structural levels, for riskReward()
      resistanceSloped: sloped.resistance, // null unless a good-fit (r2 >= 0.6) regression exists
      supportSloped: sloped.support,
      close: price,

      // Strategy-enrichment Stage 1 — see the batch comment above this
      // block for scope/rationale.
      ema9: ema9V, ema21: ema21V, emaStackBullish,
      macdHistogram: macdHistV,
      macdBullishCross, macdBearishCross, macdHistogramRising,
      bbUpper: bbUpperV, bbLower: bbLowerV,
      bbPercentB: bbPercentBV, bbExpanding, bbBandwidthPct,
      adx: adxV,
      stochBullishCrossFromOversold, stochBearishCrossFromOverbought,
      ichimokuAboveCloud, ichimokuBelowCloud,
      liquiditySweepUp: sweep.up, liquiditySweepDown: sweep.down,
      macdDivergence: macdDivergenceV, stochDivergence: stochDivergenceV
    };
  }

  /**
   * Breakout-proximity: how close price is to a key fractal-based level,
   * in ATR terms — 100% at the level itself, 0% at 3+ ATRs away. Pure
   * function so distance/atr can come from any timeframe's already-computed
   * resistance/support/atr/close (no new snapshot fields needed).
   */
  function breakoutProximityPct(distance, atrValue) {
    if (distance == null || atrValue == null || atrValue <= 0) return null;
    const distanceAtr = Math.abs(distance) / atrValue;
    return Math.max(0, 100 * (1 - distanceAtr / 3));
  }

  /**
   * Ordinary least-squares line through {x,y} points. Returns
   * {slope, intercept, r2} — r2 (coefficient of determination) is the fit
   * quality gate callers use to decide whether the line is trustworthy
   * enough to use, not just "a line that technically exists".
   */
  function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
      sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null; // all x identical, vertical line — undefined slope
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (const p of points) {
      const predicted = slope * p.x + intercept;
      ssRes += (p.y - predicted) ** 2;
      ssTot += (p.y - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { slope, intercept, r2 };
  }

  /**
   * Sloped-channel v2 of nearestLevels()'s flat single-fractal-point
   * resistance/support: fits a regression line through the last several
   * fractal pivot highs (resistance) / lows (support) instead of taking
   * just the nearest one, then projects that line to `currentIdx` for a
   * level that moves with the trend rather than sitting flat.
   *
   * Deliberately ADDITIVE, not a replacement for nearestLevels() — too
   * much already depends on the flat level (breakout-proximity scoring,
   * the modal's Key Levels display, both live on production) to swap the
   * underlying computation under them. Returns null per side when there
   * aren't enough pivots or the fit is too poor (r2 < minR2) to trust —
   * callers should treat null as "fall back to the flat level", not
   * render a bad line.
   */
  function regressionChannelLevels(candles, frac, currentIdx, { lookback = 100, minPivots = 3, maxPivots = 6, minR2 = 0.6 } = {}) {
    const minIdx = Math.max(0, currentIdx - lookback);

    function projected(indices, key) {
      const recent = indices.filter(i => i >= minIdx && i <= currentIdx).slice(-maxPivots);
      if (recent.length < minPivots) return null;
      const points = recent.map(i => ({ x: i, y: candles[i][key] }));
      const fit = linearRegression(points);
      if (!fit || fit.r2 < minR2) return null;
      return { value: fit.slope * currentIdx + fit.intercept, r2: fit.r2, slope: fit.slope, pivotCount: recent.length };
    }

    return {
      resistance: projected(frac.up, 'h'),
      support: projected(frac.down, 'l')
    };
  }

  // ======================================================================
  // Strategy-enrichment batch (Stage 0) — six new indicators, standard/
  // textbook formulas only (Appel MACD, Bollinger BBands, Wilder ADX,
  // Lane slow Stochastic, Hosoda Ichimoku, no proprietary variants), plus
  // liquiditySweep(). Pure math only here — NOT wired into
  // analyzeTimeframe()/scoring.js in this stage; app behavior is
  // byte-identical to before this batch. See the paused backlog plan
  // (~/.claude/plans/i-have-shifted-to-clever-hopcroft.md section 4) for
  // the full per-strategy scoring design these feed in later stages.
  // ======================================================================

  /**
   * Standard exponential moving average, seeded with an SMA over the
   * first `period` values. Skips a leading run of nulls when seeding
   * (same philosophy as smaSkipNulls) so it can operate on a series that
   * itself starts null, e.g. MACD's signal line over the MACD line.
   */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (prev == null) {
        if (i < period - 1) continue;
        let sum = 0, ok = true;
        for (let j = i - period + 1; j <= i; j++) {
          if (values[j] == null) { ok = false; break; }
          sum += values[j];
        }
        if (!ok) continue;
        prev = sum / period;
        out[i] = prev;
      } else if (values[i] == null) {
        prev = null; // gap in the input — re-seed once real data resumes
      } else {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  /**
   * MACD (Appel): EMA(close,12) - EMA(close,26), signal = EMA(MACD,9).
   * Operates on REAL candles.
   */
  function macd(candles) {
    const closes = candles.map(c => c.c);
    const emaFast = ema(closes, 12);
    const emaSlow = ema(closes, 26);
    const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
    const signalLine = ema(macdLine, 9);
    const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
    return { macdLine, signalLine, histogram };
  }

  /**
   * Bollinger Bands: SMA(period) +/- mult x population-stddev, plus
   * %B (where close sits within the bands, 0-1) and bandwidth (relative
   * band width, for squeeze detection). Operates on REAL candles.
   */
  function bollingerBands(candles, period = 20, mult = 2) {
    const closes = candles.map(c => c.c);
    const middle = sma(closes, period);
    const n = closes.length;
    const upper = new Array(n).fill(null);
    const lower = new Array(n).fill(null);
    const percentB = new Array(n).fill(null);
    const bandwidth = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      const mean = middle[i];
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - mean) ** 2;
      const stddev = Math.sqrt(sumSq / period);
      upper[i] = mean + mult * stddev;
      lower[i] = mean - mult * stddev;
      const width = upper[i] - lower[i];
      percentB[i] = width !== 0 ? (closes[i] - lower[i]) / width : null;
      bandwidth[i] = mean !== 0 ? width / mean : null;
    }
    return { middle, upper, lower, percentB, bandwidth };
  }

  /**
   * Where `series[idx]` ranks within its own trailing `lookback` values,
   * as 0-100. Self-normalizing by construction: "narrowest bandwidth in 50
   * bars" means the same thing on BTC and on a micro-cap, whereas any
   * absolute bandwidth threshold would need per-asset calibration.
   * Returns null when there isn't enough history to rank against.
   */
  function percentileRank(series, idx, lookback = 50, minSamples = 20) {
    if (!series || idx == null || series[idx] == null) return null;
    const from = Math.max(0, idx - lookback + 1);
    let n = 0, atOrBelow = 0;
    for (let k = from; k <= idx; k++) {
      if (series[k] == null) continue;
      n++;
      if (series[k] <= series[idx]) atOrBelow++;
    }
    if (n < minSamples) return null;
    return (atOrBelow / n) * 100;
  }

  /**
   * ADX (Wilder): +DI/-DI from directional movement, Wilder-smoothed via
   * the existing smma()/trueRange(), ADX = Wilder-smoothed DX. Reuses
   * trueRange()/smma() directly per the plan rather than reimplementing
   * Wilder's smoothing a second time. Operates on REAL candles.
   */
  function adx(candles, period = 14) {
    const n = candles.length;
    const plusDM = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const upMove = candles[i].h - candles[i - 1].h;
      const downMove = candles[i - 1].l - candles[i].l;
      plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
      minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    }
    const tr = trueRange(candles);
    const smoothedTR = smma(tr, period);
    const smoothedPlusDM = smma(plusDM, period);
    const smoothedMinusDM = smma(minusDM, period);

    const plusDI = new Array(n).fill(null);
    const minusDI = new Array(n).fill(null);
    const dx = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (smoothedTR[i] == null || smoothedTR[i] === 0) continue;
      plusDI[i] = 100 * smoothedPlusDM[i] / smoothedTR[i];
      minusDI[i] = 100 * smoothedMinusDM[i] / smoothedTR[i];
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum !== 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / sum : 0;
    }

    // ADX = Wilder-smoothed DX. smma() doesn't skip nulls, so smooth only
    // the valid tail of dx[] and place results back at the right offset.
    const firstDxIdx = dx.findIndex(v => v != null);
    const adxLine = new Array(n).fill(null);
    if (firstDxIdx !== -1) {
      const smoothed = smma(dx.slice(firstDxIdx), period);
      smoothed.forEach((v, i) => { if (v != null) adxLine[firstDxIdx + i] = v; });
    }

    return { plusDI, minusDI, adx: adxLine };
  }

  /**
   * Slow Stochastic (Lane): %K raw = 100 x (close - lowestLow) /
   * (highestHigh - lowestLow) over kPeriod, slow %K = SMA(raw%K,
   * kSmooth), %D = SMA(slow%K, dPeriod) — matches what the owner's
   * strategies assume for crossover signals. Operates on REAL candles.
   */
  function stochastic(candles, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
    const n = candles.length;
    const rawK = new Array(n).fill(null);
    for (let i = kPeriod - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        if (candles[j].h > hh) hh = candles[j].h;
        if (candles[j].l < ll) ll = candles[j].l;
      }
      rawK[i] = (hh - ll) !== 0 ? 100 * (candles[i].c - ll) / (hh - ll) : 50;
    }
    const k = smaSkipNulls(rawK, kSmooth);
    const d = smaSkipNulls(k, dPeriod);
    return { k, d };
  }

  /**
   * Ichimoku (Hosoda): Tenkan(9)/Kijun(26) midpoints, Span A/B, Chikou.
   * Snapshot-only design — no forward-plotting, since there's no future
   * price series and the ~100-candle fetch window only leaves ~48 bars
   * margin past Span B's 52-period lookback. `current*` fields are the
   * -26-shifted READ matching what a real chart overlays on today's
   * candle (the cloud boundary visible "now" was computed 26 bars ago),
   * same displacement discipline as the existing Alligator
   * shiftForward() — just read backward instead of plotted forward.
   * Operates on REAL candles.
   */
  function ichimoku(candles) {
    const n = candles.length;
    function midpoint(period, endIdx) {
      if (endIdx < period - 1) return null;
      let hh = -Infinity, ll = Infinity;
      for (let j = endIdx - period + 1; j <= endIdx; j++) {
        if (candles[j].h > hh) hh = candles[j].h;
        if (candles[j].l < ll) ll = candles[j].l;
      }
      return (hh + ll) / 2;
    }
    const tenkan = new Array(n).fill(null);
    const kijun = new Array(n).fill(null);
    const spanB = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      tenkan[i] = midpoint(9, i);
      kijun[i] = midpoint(26, i);
      spanB[i] = midpoint(52, i);
    }
    const spanA = tenkan.map((t, i) => (t != null && kijun[i] != null) ? (t + kijun[i]) / 2 : null);
    const chikou = candles.map(c => c.c);

    const lastIdx = n - 1;
    const displacedIdx = lastIdx - 26;
    const currentSpanA = displacedIdx >= 0 ? spanA[displacedIdx] : null;
    const currentSpanB = displacedIdx >= 0 ? spanB[displacedIdx] : null;

    return { tenkan, kijun, spanA, spanB, chikou, currentSpanA, currentSpanB };
  }

  /**
   * Liquidity Sweep — wick-rejection pattern modeled directly on the
   * existing divergentBar()'s shape: price wicks beyond a fractal-based
   * level but closes back inside it, wick sized at least 1.5x ATR (a
   * genuine sweep, not noise). Reuses fractals()/lastFractal() output —
   * no new S/R notion, same levels the rest of the app already uses.
   * `frac` is fractals(candles)'s output; `i` is the bar to test.
   * Returns { up, down } — up = bullish reclaim below support (a
   * downside sweep got rejected), down = bearish rejection above
   * resistance. Operates on REAL candles.
   */
  function liquiditySweep(candles, frac, i, atrValue) {
    if (i < 1 || atrValue == null || atrValue <= 0) return { up: false, down: false };
    const bar = candles[i];
    const lastUpFrac = lastFractal(frac.up, i - 1);
    const lastDownFrac = lastFractal(frac.down, i - 1);

    let down = false;
    if (lastUpFrac != null) {
      const level = candles[lastUpFrac].h;
      const wickSize = bar.h - Math.max(bar.o, bar.c);
      down = bar.h > level && bar.c < level && bar.o < level && wickSize >= 1.5 * atrValue;
    }

    let up = false;
    if (lastDownFrac != null) {
      const level = candles[lastDownFrac].l;
      const wickSize = Math.min(bar.o, bar.c) - bar.l;
      up = bar.l < level && bar.c > level && bar.o > level && wickSize >= 1.5 * atrValue;
    }

    return { up, down };
  }

  return {
    medianPrice, sma, smma, shiftForward,
    heikinAshi, alligator, alligatorTouchState,
    divergentBar, crossingLips,
    awesomeOscillator, acceleratorOscillator, wisemanSignals, mfi, mfiClassification,
    fractals, rsi, divergence, tfConfidenceTier,
    lastFractal, trueRange, atr, bucketedAtr, nearestLevels, analyzeTimeframe,
    percentileRank, classifyRegime, REGIME_THRESHOLDS: REGIME,
    riskReward, RR_PARAMS: RR,
    detectTriggers, TRIGGER_LOOKBACK,
    linearRegression, regressionChannelLevels,
    breakoutProximityPct,
    ema, macd, bollingerBands, adx, stochastic, ichimoku, liquiditySweep
  };
})();

if (typeof module !== 'undefined') module.exports = Indicators;

