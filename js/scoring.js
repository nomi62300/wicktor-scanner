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
  //
  // 1H alone sets the bias — NOT a majority vote across the three TFs.
  // If 15M/5M happen to agree with each other but oppose 1H, that is still
  // not a valid bias in their direction; 1H wins regardless. If 1H is
  // sleeping (alignment 0), there is no bias at all, full stop — 15M/5M
  // are not consulted. `count` is how many of the three TFs match the
  // 1H-derived bias direction (1H always counts once it has a bias; 15M/5M
  // add one each only if they "confirm", i.e. same alignment sign as 1H).
  function computeBias(tfSnapshots) {
    const h1 = tfSnapshots[0];
    const bias = h1 ? h1.alignment : 0;
    if (bias === 0) return { bias: 0, count: 0 };

    let count = 1;
    const m15 = tfSnapshots[1];
    const m5 = tfSnapshots[2];
    if (m15 && m15.alignment === bias) count++;
    if (m5 && m5.alignment === bias) count++;
    return { bias, count };
  }

  // Hard ceiling on band, derived from the 1H→15M→5M confirmation chain
  // (see computeBias). 15M is a gate on 5M, not an independent vote: if 15M
  // doesn't confirm 1H's bias, the result is 'avoid' regardless of what 5M
  // shows — 5M only gets to choose between 'excellent' and 'watch' once 15M
  // has already confirmed. "Confirms" means same alignment sign as 1H;
  // opposite and sleeping (alignment 0) are treated identically as
  // "does not confirm".
  function alignmentCeiling(tfSnapshots, bias) {
    if (bias === 0) return 'avoid';
    const m15 = tfSnapshots[1];
    if (!(m15 && m15.alignment === bias)) return 'avoid';
    const m5 = tfSnapshots[2];
    return (m5 && m5.alignment === bias) ? 'excellent' : 'watch';
  }

  const BAND_RANK = { avoid: 0, watch: 1, excellent: 2 };

  // tfSnapshots is always ordered [1H, 15M, 5M] — same order everywhere else.
  const TF_LABELS = ['1H', '15M', '5M'];

  function buildContinuation(tfSnapshots, bias, oiChange15m) {
    const items = [];
    let score = 0;
    const { count } = computeBias(tfSnapshots);

    // 5-tier confidence grades HOW CLEAN each aligned TF is (no recent
    // lips dips vs 1-2 weakening dips) — a TF counted in `count` can still
    // be "weak_bull"/"weak_bear", so clean-3TF and weakening-3TF are no
    // longer scored identically. Named explicitly (not just a count) so the
    // line item says which TF(s) to actually watch.
    const weakLabels = tfSnapshots
      .map((s, i) => (s && (
        (bias === 1 && s.confidence === 'weak_bull') ||
        (bias === -1 && s.confidence === 'weak_bear')
      )) ? TF_LABELS[i] : null)
      .filter(Boolean);
    const weakCount = weakLabels.length;

    if (count === 3) {
      if (weakCount === 0) { items.push(['3TF alligator aligned (clean)', 30]); score += 30; }
      else { items.push([`3TF alligator aligned (${weakLabels.join('/')} weakening)`, 24]); score += 24; }
    } else if (count === 2) {
      if (weakCount === 0) { items.push(['2TF alligator aligned (clean)', 18]); score += 18; }
      else { items.push([`2TF alligator aligned (${weakLabels.join('/')} weakening)`, 14]); score += 14; }
    } else if (count === 1) {
      items.push(['1TF alligator aligned', 8]); score += 8;
    }

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

      if (primary.mfiSignal === 'green') {
        items.push(['MFI Green (volume + range confirm)', 8]); score += 8;
      }
    }

    // Breakout-proximity (Phase 6): evaluated on 15M specifically — how
    // close price sits to its own fractal-based key level, in ATR terms.
    // Close-confirmed breakout (price already past the level) scores
    // higher than merely approaching it, since a close beyond the level
    // is the actual taught confirmation, not just proximity.
    const m15 = tfSnapshots[1];
    if (m15) {
      if (bias === 1 && m15.resistance != null) {
        if (m15.close > m15.resistance) {
          items.push(['15M Confirmed breakout above key level', 14]); score += 14;
        } else {
          const prox = Indicators.breakoutProximityPct(m15.resistance - m15.close, m15.atr);
          if (prox != null && prox >= 66) {
            items.push(['15M Approaching key level (breakout setup)', 10]); score += 10;
          }
        }
      } else if (bias === -1 && m15.support != null) {
        if (m15.close < m15.support) {
          items.push(['15M Confirmed breakout below key level', 14]); score += 14;
        } else {
          const prox = Indicators.breakoutProximityPct(m15.close - m15.support, m15.atr);
          if (prox != null && prox >= 66) {
            items.push(['15M Approaching key level (breakout setup)', 10]); score += 10;
          }
        }
      }
    }

    // OI 15m% (perpetuals only — null for spot, checked via presence not
    // market type, since buildContinuation doesn't otherwise know market).
    // Significance threshold 5%: a large swing in open interest either way
    // means fresh capital is actively committing to the current move, not
    // just existing positions drifting — a soft confirmation, not a gate.
    if (oiChange15m != null && Math.abs(oiChange15m) >= 5) {
      items.push([`Perp OI ${oiChange15m > 0 ? '+' : ''}${oiChange15m.toFixed(1)}% (15m, fresh capital)`, 8]);
      score += 8;
    }

    // ====================================================================
    // Phase 5 Stage 2 — scalping-tier strategies 1-5 (see the paused
    // backlog plan section 4.3 for the full owner-provided definitions).
    // computeBias()/alignmentCeiling() are never touched by this batch —
    // everything below only adds/subtracts Continuation/Exhaustion/
    // Reversal points, same as every existing item in this function.
    // ====================================================================

    // Strategy 1 (Scalping EMA).
    if (primary) {
      if (bias === 1 && primary.emaStackBullish) {
        items.push(['1H EMA 9/21 bullish trend', 10]); score += 10;
      } else if (bias === -1 && primary.ema9 != null && primary.ema21 != null && primary.ema9 < primary.ema21) {
        items.push(['1H EMA 9/21 bearish trend', 10]); score += 10;
      }
    }
    if (m15) {
      // "Pullback to EMA21" = close within 0.5x ATR of EMA21 — same
      // distance-in-ATR language used elsewhere in this file (breakout-
      // proximity, OI significance), kept consistent across the batch.
      const pulledBackToEma21 = m15.ema21 != null && m15.close != null && m15.atr != null &&
        Math.abs(m15.close - m15.ema21) <= 0.5 * m15.atr;
      if (bias === 1 && m15.macdBullishCross && pulledBackToEma21) {
        items.push(['15M MACD bullish cross on EMA21 pullback', 14]); score += 14;
      } else if (bias === -1 && m15.macdBearishCross && pulledBackToEma21) {
        items.push(['15M MACD bearish cross on EMA21 pullback', 14]); score += 14;
      }
    }

    // Strategy 2 (Volatility Breakout), 15M. "Squeeze -> expansion,
    // breaks outside band" is approximated as expanding bandwidth + a
    // close genuinely outside the band on the bias side — the snapshot
    // only carries the current bar's squeeze state (is bandwidth the
    // trailing-20 minimum right now), not a multi-bar "was squeezed a
    // few bars ago" history, so this reads the live breakout moment
    // rather than reconstructing the squeeze's own start.
    if (m15) {
      const breakoutUp = m15.bbUpper != null && m15.close > m15.bbUpper;
      const breakoutDown = m15.bbLower != null && m15.close < m15.bbLower;
      const brokeOut = (bias === 1 && breakoutUp) || (bias === -1 && breakoutDown);
      if (m15.bbExpanding && brokeOut) {
        items.push(['15M BB squeeze breakout', 12]); score += 12;
        // Distinct specific-event confirmation, additive to the general
        // ADX-as-trend-strength term in tradeQualityScore() (Audit F2) —
        // this strategy's own ADX check, not the global term.
        if (m15.adx != null && m15.adx >= 25) {
          items.push(['ADX confirms breakout strength', 8]); score += 8;
        }
      }
    }

    // Strategy 3 (Breakout Retest), 1H. Full spec ("broke out within 8
    // bars, retested, closed back above") needs multi-bar candle history
    // the scoring layer doesn't have — approximated using what the
    // snapshot does carry: already above/below the fractal level AND
    // sitting close to it (within 0.5x ATR), i.e. a live retest zone.
    if (primary) {
      const nearUpRetest = primary.lastUpFractal != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.lastUpFractal) <= 0.5 * primary.atr;
      const nearDownRetest = primary.lastDownFractal != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.lastDownFractal) <= 0.5 * primary.atr;
      if (bias === 1 && primary.aboveUpFractal && nearUpRetest) {
        items.push(['1H Breakout retest held', 15]); score += 15;
      } else if (bias === -1 && primary.belowDownFractal && nearDownRetest) {
        items.push(['1H Breakout retest held', 15]); score += 15;
      }
    }

    // Strategy 4 (Squeeze Momentum), 15M — distinct from Strategy 2:
    // oscillator-driven (MACD histogram direction+momentum) rather than
    // price-driven (an actual close outside the bands).
    if (m15 && m15.macdHistogram != null) {
      const histMatchesBias = (bias === 1 && m15.macdHistogram > 0) || (bias === -1 && m15.macdHistogram < 0);
      if (m15.bbExpanding && histMatchesBias && m15.macdHistogramRising) {
        items.push(['15M Squeeze momentum expansion (MACD confirm)', 14]); score += 14;
      }
    }

    // Strategy 6 (Momentum Swing).
    if (primary) {
      if (bias === 1 && primary.ichimokuAboveCloud) {
        items.push(['1H Price above Ichimoku cloud', 12]); score += 12;
      } else if (bias === -1 && primary.ichimokuBelowCloud) {
        items.push(['1H Price below Ichimoku cloud', 12]); score += 12;
      }
    }
    if (m15) {
      if (bias === 1 && m15.stochBullishCrossFromOversold) {
        items.push(['15M Stochastic bullish entry (oversold cross)', 10]); score += 10;
      } else if (bias === -1 && m15.stochBearishCrossFromOverbought) {
        items.push(['15M Stochastic bearish entry (overbought cross)', 10]); score += 10;
      }
    }

    // Strategy 7 (Trend Following). "EMA stack aligned with bias" is the
    // same underlying EMA9/21 condition as Strategy 1's "1H EMA 9/21
    // bullish trend" (only two EMAs exist — 9/21 — nothing to form a
    // genuinely distinct 3+-EMA "stack" from), so it is deliberately NOT
    // re-scored as a second line here — same reuse-not-duplicate
    // principle already used for RSI divergence (Strategy 9) elsewhere
    // in this plan. Only the genuinely distinct condition (a plain
    // directional MACD cross, no EMA21-pullback requirement — unlike
    // Strategy 1) is scored. ADX is handled globally, as a trend-strength
    // term in tradeQualityScore() (Audit F2), not a redundant line here.
    if (primary) {
      if (bias === 1 && primary.macdBullishCross) {
        items.push(['1H MACD trend-following cross', 12]); score += 12;
      } else if (bias === -1 && primary.macdBearishCross) {
        items.push(['1H MACD trend-following cross', 12]); score += 12;
      }
    }

    // Strategy 12 (Pullback Retracements), 15M. Tighter pullback
    // tolerance (0.3x ATR) than Strategy 1's 0.5x — this is a precision
    // entry-timing strategy, not just "was there a MACD cross nearby."
    // RSI 40-60 = healthy pullback, not already reversal-territory.
    if (m15) {
      const emaTrendMatch = (bias === 1 && m15.emaStackBullish) ||
        (bias === -1 && m15.ema9 != null && m15.ema21 != null && m15.ema9 < m15.ema21);
      const pulledBackTight = m15.ema21 != null && m15.close != null && m15.atr != null &&
        Math.abs(m15.close - m15.ema21) <= 0.3 * m15.atr;
      const rsiHealthy = m15.rsi != null && m15.rsi >= 40 && m15.rsi <= 60;
      if (emaTrendMatch && pulledBackTight && rsiHealthy) {
        items.push(['15M Pullback to EMA21 (RSI healthy)', 12]); score += 12;
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

    // Accelerator Oscillator: momentum-of-momentum decelerating ahead of
    // AO's own zero-cross — catches exhaustion earlier than AO alone.
    if (primary && primary.ac != null && primary.ao != null) {
      if (primary.ao > 0 && !primary.acRising) {
        items.push(['1H AC decelerating (bullish momentum fading)', 12]); score += 12;
      } else if (primary.ao < 0 && primary.acRising) {
        items.push(['1H AC decelerating (bearish momentum fading)', 12]); score += 12;
      }
    }

    // Strategy 5 (Mean Reversion), 5M — explicitly a reversal/exhaustion
    // play, bias-independent like every other item in this function. Two
    // separate lines so a partial confirm still shows partial pressure.
    if (fast) {
      if (fast.bbPercentB != null && (fast.bbPercentB >= 1 || fast.bbPercentB <= 0)) {
        items.push(['5M Price at BB extreme', 8]); score += 8;
      }
      if (fast.stochBullishCrossFromOversold || fast.stochBearishCrossFromOverbought) {
        items.push(['5M Stochastic exhaustion crossover', 10]); score += 10;
      }
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

    // MFI Squat: falling range-per-volume with rising volume — a generic
    // reversal warning, independent of which way the current bias points.
    const primary = tfSnapshots[0];
    if (primary && primary.mfiSignal === 'squat') {
      items.push(['1H MFI Squat (reversal warning)', 10]); score += 10;
    }

    // Divergent Bar: fires when the Alligator is in the OPPOSITE order to
    // the current bias — i.e. it's a warning that bias may be about to
    // reverse, not a continuation signal. divergentBarUp needs a bearish
    // mouth (warns against bias === -1); divergentBarDown needs a bullish
    // mouth (warns against bias === 1).
    if (primary) {
      if (bias === -1 && primary.divergentBarUp) {
        items.push(['1H Divergent Bar (bullish reversal)', 15]); score += 15;
      } else if (bias === 1 && primary.divergentBarDown) {
        items.push(['1H Divergent Bar (bearish reversal)', 15]); score += 15;
      }

      // Wiseman AO-shape signals: same "warns against current bias" logic.
      if (bias === -1 && primary.wisemanBullish) {
        items.push(['1H Wiseman AO reversal (bullish)', 12]); score += 12;
      } else if (bias === 1 && primary.wisemanBearish) {
        items.push(['1H Wiseman AO reversal (bearish)', 12]); score += 12;
      }

      // Strategy 3 (Breakout Retest) trap-avoidance: a retest holding
      // while RSI is already extended is a specific, riskier variant of
      // "retest held" (scored in Continuation) — distinct from the plain
      // RSI>=75 Exhaustion check above (different threshold, different
      // arm, different condition, not a duplicate).
      const nearUpRetest = primary.lastUpFractal != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.lastUpFractal) <= 0.5 * primary.atr;
      const nearDownRetest = primary.lastDownFractal != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.lastDownFractal) <= 0.5 * primary.atr;
      if (bias === 1 && primary.aboveUpFractal && nearUpRetest && primary.rsi != null && primary.rsi >= 70) {
        items.push(['1H Retest into overbought (trap risk)', 10]); score += 10;
      } else if (bias === -1 && primary.belowDownFractal && nearDownRetest && primary.rsi != null && primary.rsi <= 30) {
        items.push(['1H Retest into oversold (trap risk)', 10]); score += 10;
      }

      // Strategy 8 (Trend Reversals): MACD turning against the current
      // bias while price sits within 1x ATR of an existing fractal-based
      // key level — a reversal at a level that actually matters, not
      // just any MACD flip. RSI-divergence items above already cover
      // this strategy's other listed signal; not duplicated here.
      const nearResistance = primary.resistance != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.resistance) <= 1 * primary.atr;
      const nearSupport = primary.support != null && primary.close != null && primary.atr != null &&
        Math.abs(primary.close - primary.support) <= 1 * primary.atr;
      if (bias === 1 && primary.macdBearishCross && nearResistance) {
        items.push(['1H MACD reversal cross at key level', 15]); score += 15;
      } else if (bias === -1 && primary.macdBullishCross && nearSupport) {
        items.push(['1H MACD reversal cross at key level', 15]); score += 15;
      }

      // Strategy 9 (Divergence Play): MACD/Stochastic divergence, same
      // pivot-pairing pattern as the existing RSI divergence above —
      // both reuse the same generic divergence() function (see Stage 1),
      // just fed a different oscillator series. Scored slightly below
      // RSI's 20 since RSI is the primary taught signal.
      if (bias === 1 && primary.macdDivergence === 'bear') {
        items.push(['1H Bearish MACD divergence', 15]); score += 15;
      } else if (bias === -1 && primary.macdDivergence === 'bull') {
        items.push(['1H Bullish MACD divergence', 15]); score += 15;
      }

      // Strategy 13 (Liquidity Sweep): same "warns against current bias"
      // shape as Divergent Bar/Wiseman above, same 15-pt tier as
      // Divergent Bar (same wick-rejection family). A rejection above
      // resistance warns against an active uptrend; a reclaim below
      // support warns against an active downtrend.
      if (bias === 1 && primary.liquiditySweepDown) {
        items.push(['1H Liquidity sweep above resistance, rejected (bearish)', 15]); score += 15;
      } else if (bias === -1 && primary.liquiditySweepUp) {
        items.push(['1H Liquidity sweep below support, reclaimed (bullish)', 15]); score += 15;
      }
    }
    const m15 = tfSnapshots[1];
    if (m15) {
      if (bias === 1 && m15.stochDivergence === 'bear') {
        items.push(['15M Stochastic divergence', 10]); score += 10;
      } else if (bias === -1 && m15.stochDivergence === 'bull') {
        items.push(['15M Stochastic divergence', 10]); score += 10;
      }
    }

    // Strategy 11 (Range Bound): explicitly a non-trending strategy —
    // only fires when bias===0 (1H sleeping), and only in Reversal, never
    // Continuation. Confirmed safe: buildReversal already computes
    // unconditionally regardless of bias (only alignmentCeiling/
    // tradeQualityScore treat bias===0 specially), so this doesn't touch
    // computeBias()'s own bias===0 handling.
    const m5 = tfSnapshots[2];
    if (bias === 0 && m5 && m5.bbPercentB != null && m5.rsi != null) {
      if (m5.bbPercentB <= 0.05 && m5.rsi <= 35) {
        items.push(['5M Range-bound bounce (support + RSI oversold)', 12]); score += 12;
      } else if (m5.bbPercentB >= 0.95 && m5.rsi >= 65) {
        items.push(['5M Range-bound fade (resistance + RSI overbought)', 12]); score += 12;
      }
    }

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
      // Audit F2: ADX is trend STRENGTH, not direction — it can't confirm
      // which way the market is moving (that's alignment's job), only
      // whether there's a real trend underneath the current bias at all.
      // Tiers per Wilder's own convention, matching Strategy 2's existing
      // adx>=25 "strong" threshold: below 20 is a weak/ranging read (the
      // bias is more likely noise), 20-25 is developing (no adjustment),
      // 25+ is an established trend.
      if (primary.adx != null) {
        if (primary.adx < 20) momentumScore -= 10;
        else if (primary.adx >= 25) momentumScore += 15;
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

  /**
   * `ceiling` ('excellent' | 'watch' | 'avoid', from alignmentCeiling()) is
   * a hard cap on the score-derived band, never a floor \u2014 a numeric score
   * of 90 with ceiling 'watch' is capped down to WATCH, but a numeric score
   * of 40 with ceiling 'excellent' still shows AVOID/WATCH per the normal
   * thresholds (the ceiling doesn't force the band up). Callers that omit
   * `ceiling` get the old unrestricted score-only behavior.
   */
  function bandLabel(score, unlock, ceiling) {
    if (unlock && unlock.severity === 'red') return { text: '\u26A0 UNLOCK RISK', tone: 'red' };

    const scoreBand = score >= 80 ? 'excellent' : score >= 50 ? 'watch' : 'avoid';
    const cap = ceiling || 'excellent';
    const finalBand = BAND_RANK[scoreBand] <= BAND_RANK[cap] ? scoreBand : cap;

    if (finalBand === 'excellent') return { text: 'EXCELLENT', tone: 'green' };
    if (finalBand === 'watch') return { text: 'WATCH', tone: 'gold' };
    return { text: 'AVOID', tone: 'grey' };
  }

  /**
   * Full pipeline: pass in { h1, m15, m5 } raw candle arrays (already
   * fetched), returns everything the UI needs for one coin/market.
   */
  function evaluate(candlesByTf, extras) {
    const tfSnapshots = [
      Indicators.analyzeTimeframe(candlesByTf.h1),
      Indicators.analyzeTimeframe(candlesByTf.m15),
      Indicators.analyzeTimeframe(candlesByTf.m5)
    ];
    if (!tfSnapshots[0]) return null; // need at least 1H data

    const { bias, count } = computeBias(tfSnapshots);
    const ceiling = alignmentCeiling(tfSnapshots, bias);
    const continuation = buildContinuation(tfSnapshots, bias, extras && extras.oiChange15m);
    const exhaustion = buildExhaustion(tfSnapshots);
    const reversal = buildReversal(tfSnapshots, bias);
    const dir = directionValue(tfSnapshots);
    const regime = regimeLabel(dir, count);
    const score = tradeQualityScore({ bias, count, continuation, exhaustion, reversal, tfSnapshots });

    // Crossing Lips: a non-invalidating, UI-only early-warning flag — the
    // Alligator is still in the current trend's order but price just
    // closed back through lips after 2 bars on the trend side. Deliberately
    // NOT wired into alignment/touch-state (see backlog notes).
    const primary = tfSnapshots[0];
    const crossingLipsWarning = !!(primary && (
      (bias === 1 && primary.crossingLipsDown) ||
      (bias === -1 && primary.crossingLipsUp)
    ));

    return {
      bias, alignCount: count, ceiling, tfSnapshots,
      direction: dir, regime, score,
      continuation, exhaustion, reversal,
      crossingLipsWarning,
      rsiByTf: tfSnapshots.map(s => s ? Math.round(s.rsi) : null),
      tfAlignment: tfSnapshots.map(s => s ? s.alignment : 0),
      tfConfidence: tfSnapshots.map(s => s ? s.confidence : 'neutral'),
      divergenceOverall: tfSnapshots[0] && tfSnapshots[0].divergence !== 'none'
        ? tfSnapshots[0].divergence
        : (tfSnapshots[1] && tfSnapshots[1].divergence !== 'none' ? tfSnapshots[1].divergence : 'none')
    };
  }

  return { computeBias, alignmentCeiling, buildContinuation, buildExhaustion, buildReversal,
           directionValue, regimeLabel, tradeQualityScore, bandLabel, evaluate };
})();

if (typeof module !== 'undefined') module.exports = Scoring;
