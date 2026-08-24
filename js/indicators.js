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

      if (bullish) {
        if (isInvalidated) {
          // Clear condition: HA close back above lips
          if (haCandles[i].c > lipsV) isInvalidated = false;
        } else {
          // Invalidate condition: HA low dips into or through jaw
          if (haCandles[i].l <= jawV) isInvalidated = true;
        }
      } else if (bearish) {
        if (isInvalidated) {
          // Clear condition: HA close back below lips
          if (haCandles[i].c < lipsV) isInvalidated = false;
        } else {
          // Invalidate condition: HA high touches or exceeds jaw
          if (haCandles[i].h >= jawV) isInvalidated = true;
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
  // (0.1% / 0.2% / 0.3% / 0.5% / 0.75% / 1%) rather than used as a raw
  // continuous value — reduces noise-driven jitter in anything derived
  // from it (Skyrexio pattern). Fractions, not fixed dollar steps, so it
  // scales across assets from micro-cap tokens to BTC. Snaps UP to the
  // nearest bucket at or above the raw ratio; ratios beyond the largest
  // bucket are left unbucketed (real high-volatility conditions, not noise).
  const ATR_PCT_BUCKETS = [0.001, 0.002, 0.003, 0.005, 0.0075, 0.01];

  function bucketedAtr(atrValue, price) {
    if (atrValue == null || !price) return atrValue;
    const ratio = atrValue / price;
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
   */
  function nearestLevels(candles, frac, price, atrValue, lookback = 150) {
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

    const atrBucketed = bucketedAtr(atrValue, price) ?? price * 0.01;
    const atrBuffer = atrBucketed * 1.5;
    if (resistance == null) resistance = price + atrBuffer;
    if (support == null) support = price - atrBuffer;

    return { resistance, support };
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

    // Touch-state invalidation — walks HA candles, returns bool[] per bar
    const touchStates = alligatorTouchState(haCandles, jaw, teeth, lips);
    const alligatorInvalidated = touchStates[lastIdx];

    // If the jaw was touched and not yet cleared, override alignment to 0
    if (alligatorInvalidated) alignment = 0;

    const confidence = tfConfidenceTier(haCandles, lips, alignment, lastIdx);

    const aoV = ao[lastIdx];
    const aoPrev = ao[lastIdx - 1];
    const aoRising = aoV != null && aoPrev != null && aoV > aoPrev;

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

    const atrV = atr(candles)[lastIdx];
    const { resistance, support } = nearestLevels(candles, frac, price, atrV);
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
    const bbMiddleV = bb.middle[lastIdx];
    const bbPercentBV = bb.percentB[lastIdx];
    const bbBandwidthV = bb.bandwidth[lastIdx];
    // Squeeze = current bandwidth is the lowest of the trailing 20 bars —
    // a relative, self-normalizing "tight" rather than a fixed threshold
    // that would need per-symbol calibration.
    let bbSqueeze = false;
    {
      const from = Math.max(0, lastIdx - 19);
      let minBw = Infinity;
      for (let k = from; k <= lastIdx; k++) {
        if (bb.bandwidth[k] != null && bb.bandwidth[k] < minBw) minBw = bb.bandwidth[k];
      }
      bbSqueeze = bbBandwidthV != null && bbBandwidthV === minBw;
    }
    const bbExpanding = bbBandwidthV != null && bb.bandwidth[lastIdx - 1] != null && bbBandwidthV > bb.bandwidth[lastIdx - 1];

    const adxResult = adx(candles);
    const adxV = adxResult.adx[lastIdx];
    const adxPrev = adxResult.adx[lastIdx - 1];
    const plusDIV = adxResult.plusDI[lastIdx];
    const minusDIV = adxResult.minusDI[lastIdx];

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
    const tenkanV = ich.tenkan[lastIdx];
    const kijunV = ich.kijun[lastIdx];
    const tenkanPrev = ich.tenkan[lastIdx - 1];
    const kijunPrev = ich.kijun[lastIdx - 1];
    const tenkanKijunBullishCross = tenkanV != null && kijunV != null && tenkanPrev != null && kijunPrev != null &&
      tenkanPrev <= kijunPrev && tenkanV > kijunV;

    const sweep = liquiditySweep(candles, frac, lastIdx, atrV);

    return {
      alignment,              // 1 / -1 / 0 (0 if jaw was touched and not cleared)
      confidence,             // 5-tier: strong_bull/weak_bull/neutral/weak_bear/strong_bear
      alligatorInvalidated,   // true if jaw-touch rule is currently active
      ao: aoV,
      aoRising,
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
      resistanceSloped: sloped.resistance, // null unless a good-fit (r2 >= 0.6) regression exists
      supportSloped: sloped.support,
      close: price,

      // Strategy-enrichment Stage 1 — see the batch comment above this
      // block for scope/rationale.
      ema9: ema9V, ema21: ema21V, emaStackBullish,
      macdLine: macdLineV, macdSignal: macdSignalV, macdHistogram: macdHistV,
      macdSeries: macdResult.macdLine, // full series — Stage 2+ MACD-divergence reuses divergence()'s pivot-pairing, which needs the whole series, not just the last value
      macdBullishCross, macdBearishCross, macdHistogramRising,
      bbUpper: bbUpperV, bbLower: bbLowerV, bbMiddle: bbMiddleV,
      bbPercentB: bbPercentBV, bbBandwidth: bbBandwidthV, bbSqueeze, bbExpanding,
      adx: adxV, adxPrev, plusDI: plusDIV, minusDI: minusDIV,
      stochK: stochKV, stochD: stochDV,
      stochSeries: stochResult.k, // full series, same reason as macdSeries
      stochBullishCrossFromOversold, stochBearishCrossFromOverbought,
      ichimokuAboveCloud, ichimokuBelowCloud, tenkan: tenkanV, kijun: kijunV,
      tenkanKijunBullishCross,
      liquiditySweepUp: sweep.up, liquiditySweepDown: sweep.down
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
    linearRegression, regressionChannelLevels,
    breakoutProximityPct,
    ema, macd, bollingerBands, adx, stochastic, ichimoku, liquiditySweep
  };
})();

if (typeof module !== 'undefined') module.exports = Indicators;

