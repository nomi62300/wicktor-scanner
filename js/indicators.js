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
   * Williams Alligator on median price.
   * Jaw: SMMA(13) shifted +8, Teeth: SMMA(8) shifted +5, Lips: SMMA(5) shifted +3
   * Returns { jaw, teeth, lips } arrays aligned to candle index.
   */
  function alligator(candles) {
    const med = medianPrice(candles);
    const jaw = shiftForward(smma(med, 13), 8);
    const teeth = shiftForward(smma(med, 8), 5);
    const lips = shiftForward(smma(med, 5), 3);
    return { jaw, teeth, lips };
  }

  /**
   * Awesome Oscillator: SMA(median,5) - SMA(median,34)
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

  /**
   * Williams Fractals (classic 5-bar). A fractal at index i is only
   * confirmed once bars i+1 and i+2 exist, so the last 2 bars can
   * never have a confirmed fractal yet.
   * Returns { up: [indices], down: [indices] }
   */
  function fractals(candles) {
    const up = [];
    const down = [];
    for (let i = 2; i < candles.length - 2; i++) {
      const h = candles[i].h, l = candles[i].l;
      const isUp = h > candles[i-2].h && h > candles[i-1].h &&
                   h > candles[i+1].h && h > candles[i+2].h;
      const isDown = l < candles[i-2].l && l < candles[i-1].l &&
                     l < candles[i+1].l && l < candles[i+2].l;
      if (isUp) up.push(i);
      if (isDown) down.push(i);
    }
    return { up, down };
  }

  function lastFractal(fractalIndices, beforeIndex) {
    for (let i = fractalIndices.length - 1; i >= 0; i--) {
      if (fractalIndices[i] <= beforeIndex) return fractalIndices[i];
    }
    return null;
  }

  /**
   * RSI, Wilder's smoothing, standard 14-period default.
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
   * Convenience: compute everything for one timeframe's candles and
   * return a compact snapshot of the latest closed bar.
   */
  function analyzeTimeframe(candles) {
    if (!candles || candles.length < 40) return null;
    const lastIdx = candles.length - 1;
    const { jaw, teeth, lips } = alligator(candles);
    const ao = awesomeOscillator(candles);
    const frac = fractals(candles);
    const rsiSeries = rsi(candles);
    const div = divergence(candles, rsiSeries, frac);

    const jawV = jaw[lastIdx], teethV = teeth[lastIdx], lipsV = lips[lastIdx];
    let alignment = 0; // 1 bullish, -1 bearish, 0 mixed/flat
    if (jawV != null && teethV != null && lipsV != null) {
      if (lipsV > teethV && teethV > jawV) alignment = 1;
      else if (lipsV < teethV && teethV < jawV) alignment = -1;
    }

    const aoV = ao[lastIdx];
    const aoPrev = ao[lastIdx - 1];
    const aoRising = aoV != null && aoPrev != null && aoV > aoPrev;

    const lastUpFrac = lastFractal(frac.up, lastIdx - 2);
    const lastDownFrac = lastFractal(frac.down, lastIdx - 2);
    const price = candles[lastIdx].c;
    const aboveUpFractal = lastUpFrac != null && price > candles[lastUpFrac].h;
    const belowDownFractal = lastDownFrac != null && price < candles[lastDownFrac].l;

    return {
      alignment,          // 1 / -1 / 0
      ao: aoV,
      aoRising,
      rsi: rsiSeries[lastIdx],
      divergence: div,
      lastUpFractal: lastUpFrac != null ? candles[lastUpFrac].h : null,
      lastDownFractal: lastDownFrac != null ? candles[lastDownFrac].l : null,
      aboveUpFractal,
      belowDownFractal,
      close: price
    };
  }

  return {
    medianPrice, sma, smma, shiftForward,
    alligator, awesomeOscillator, fractals, rsi, divergence,
    lastFractal, analyzeTimeframe
  };
})();

if (typeof module !== 'undefined') module.exports = Indicators;
