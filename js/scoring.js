/* ==========================================================================
   Wicktor — Scoring Engine
   Takes the per-timeframe indicator snapshots (1H, 15M, 5M) and produces:
   - direction (-100..100 gauge value)
   - alignment count (0-3) and dominant bias
   - continuation / exhaustion / reversal sub-scores + line-item breakdowns
   - overall Trade Quality Score (0-100)
   - regime label + band label
   ========================================================================== */

const Scoring = (() => {

  // timeframes ordered as used everywhere: [1H, 15M, 5M]
  function computeBias(tfSnapshots) {
    const aligns = tfSnapshots.map(s => s ? s.alignment : 0);
    const bullCount = aligns.filter(a => a === 1).length;
    const bearCount = aligns.filter(a => a === -1).length;
    if (bullCount >= bearCount && bullCount > 0) return { bias: 1, count: bullCount };
    if (bearCount > bullCount) return { bias: -1, count: bearCount };
    return { bias: 0, count: 0 };
  }

  function buildContinuation(tfSnapshots, bias) {
    const items = [];
    let score = 0;
    const { count } = computeBias(tfSnapshots);

    if (count === 3) { items.push(['3TF alligator aligned', 30]); score += 30; }
    else if (count === 2) { items.push(['2TF alligator aligned', 18]); score += 18; }
    else if (count === 1) { items.push(['1TF alligator aligned', 8]); score += 8; }

    const primary = tfSnapshots[0]; // 1H
    if (primary) {
      if (bias === 1 && primary.aoRising && primary.ao > 0) {
        items.push(['AO rising, bullish', 16]); score += 16;
      } else if (bias === -1 && !primary.aoRising && primary.ao < 0) {
        items.push(['AO falling, bearish', 16]); score += 16;
      } else if (primary.aoRising === (bias === 1)) {
        items.push(['AO direction weak confirm', 6]); score += 6;
      }

      if (bias === 1 && primary.aboveUpFractal) {
        items.push(['Above last up fractal', 15]); score += 15;
      } else if (bias === -1 && primary.belowDownFractal) {
        items.push(['Below last down fractal', 15]); score += 15;
      }
    }

    return { score: Math.min(65, score), items };
  }

  function buildExhaustion(tfSnapshots) {
    const items = [];
    let score = 0;
    // fastest timeframe (5M) reaching RSI extremes is an exhaustion signal
    const fast = tfSnapshots[2]; // 5M
    if (fast && fast.rsi != null) {
      if (fast.rsi >= 68) { items.push(['5M RSI approaching overbought', Math.round((fast.rsi - 60))]); score += Math.round(fast.rsi - 60); }
      else if (fast.rsi <= 32) { items.push(['5M RSI approaching oversold', Math.round(40 - fast.rsi)]); score += Math.round(40 - fast.rsi); }
    }
    const primary = tfSnapshots[0];
    if (primary && primary.rsi != null && primary.rsi >= 75) {
      items.push(['1H RSI extreme', 15]); score += 15;
    }
    return { score: Math.min(40, Math.max(0, score)), items };
  }

  function buildReversal(tfSnapshots, bias) {
    const items = [];
    let score = 0;
    const relevant = [tfSnapshots[0], tfSnapshots[1]]; // divergence only tracked on 1H/15M
    const labels = ['1H', '15M'];
    relevant.forEach((tf, idx) => {
      if (!tf) return;
      if (bias === 1 && tf.divergence === 'bear') {
        items.push([`Bearish RSI divergence ${labels[idx]}`, 20]); score += 20;
      } else if (bias === -1 && tf.divergence === 'bull') {
        items.push([`Bullish RSI divergence ${labels[idx]}`, 20]); score += 20;
      }
    });
    return { score: Math.min(50, score), items };
  }

  function directionValue(tfSnapshots) {
    // Weighted blend: 1H counts most, 5M least
    const weights = [0.5, 0.3, 0.2];
    let total = 0, weightSum = 0;
    tfSnapshots.forEach((s, i) => {
      if (!s) return;
      let contribution = s.alignment * 60; // base swing
      if (s.rsi != null) contribution += (s.rsi - 50) * 0.6;
      total += contribution * weights[i];
      weightSum += weights[i];
    });
    if (weightSum === 0) return 0;
    const val = total / weightSum;
    return Math.max(-100, Math.min(100, Math.round(val)));
  }

  function regimeLabel(dirValue, alignCount) {
    const strong = alignCount >= 3;
    if (dirValue >= 40) return strong ? 'Strong trend up' : 'Trend up';
    if (dirValue <= -40) return strong ? 'Strong trend down' : 'Trend down';
    if (dirValue > 10) return 'Leaning bullish';
    if (dirValue < -10) return 'Leaning bearish';
    return 'Neutral';
  }

  /**
   * Overall Trade Quality Score. NOT a direct sum of the CONT/EXH/REV
   * breakdown bars (those are diagnostic) - this is its own weighted
   * blend of alignment strength, momentum health, and structure,
   * minus a penalty for divergence against the dominant bias.
   */
  function tradeQualityScore({ bias, count, continuation, exhaustion, reversal, tfSnapshots }) {
    if (bias === 0) return 15; // no clear alignment at all

    const alignmentScore = count === 3 ? 100 : count === 2 ? 60 : count === 1 ? 25 : 0;

    const primary = tfSnapshots[0];
    let momentumScore = 50;
    if (primary) {
      const aoGood = (bias === 1 && primary.aoRising) || (bias === -1 && !primary.aoRising);
      momentumScore = aoGood ? 75 : 35;
      if (primary.rsi != null) {
        const healthy = primary.rsi > 40 && primary.rsi < 75;
        momentumScore += healthy ? 15 : -10;
      }
    }
    momentumScore = Math.max(0, Math.min(100, momentumScore));

    let structureScore = 40;
    if (primary) {
      if (bias === 1 && primary.aboveUpFractal) structureScore = 90;
      else if (bias === -1 && primary.belowDownFractal) structureScore = 90;
    }

    let raw = 0.5 * alignmentScore + 0.3 * momentumScore + 0.2 * structureScore;
    raw -= reversal.score * 0.4;
    raw -= Math.max(0, exhaustion.score - 25) * 0.2;

    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  function bandLabel(score, unlock) {
    if (unlock && unlock.severity === 'red') return { text: '\u26A0 UNLOCK RISK', tone: 'red' };
    if (score >= 80) return { text: 'EXCELLENT', tone: 'green' };
    if (score >= 50) return { text: 'WATCH', tone: 'gold' };
    return { text: 'AVOID', tone: 'grey' };
  }

  /**
   * Full pipeline: pass in { h1, m15, m5 } raw candle arrays (already
   * fetched), returns everything the UI needs for one coin/market.
   */
  function evaluate(candlesByTf) {
    const tfSnapshots = [
      Indicators.analyzeTimeframe(candlesByTf.h1),
      Indicators.analyzeTimeframe(candlesByTf.m15),
      Indicators.analyzeTimeframe(candlesByTf.m5)
    ];
    if (!tfSnapshots[0]) return null; // need at least 1H data

    const { bias, count } = computeBias(tfSnapshots);
    const continuation = buildContinuation(tfSnapshots, bias);
    const exhaustion = buildExhaustion(tfSnapshots);
    const reversal = buildReversal(tfSnapshots, bias);
    const dir = directionValue(tfSnapshots);
    const regime = regimeLabel(dir, count);
    const score = tradeQualityScore({ bias, count, continuation, exhaustion, reversal, tfSnapshots });

    return {
      bias, alignCount: count, tfSnapshots,
      direction: dir, regime, score,
      continuation, exhaustion, reversal,
      rsiByTf: tfSnapshots.map(s => s ? Math.round(s.rsi) : null),
      tfAlignment: tfSnapshots.map(s => s ? s.alignment : 0),
      divergenceOverall: tfSnapshots[0] && tfSnapshots[0].divergence !== 'none'
        ? tfSnapshots[0].divergence
        : (tfSnapshots[1] && tfSnapshots[1].divergence !== 'none' ? tfSnapshots[1].divergence : 'none')
    };
  }

  return { computeBias, buildContinuation, buildExhaustion, buildReversal,
           directionValue, regimeLabel, tradeQualityScore, bandLabel, evaluate };
})();

if (typeof module !== 'undefined') module.exports = Scoring;
