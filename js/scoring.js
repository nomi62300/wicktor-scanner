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

  // ======================================================================
  // Phase C4 — setup scoring
  //
  // Replaces tradeQualityScore()'s alignment-dominated blend. The problem it
  // solves: bias came from 1H alone and `if (bias === 0) return 15` short-
  // circuited everything, so 38% of the top-40 perps were unscoreable —
  // hardcoded AVOID no matter what 5M and 15M showed. A ranging 1H is prime
  // scalping territory, so the scanner went blind exactly where a scalping
  // product needs to see. Strategy 11 (Range Bound), written for that case,
  // was dead code for the same reason.
  //
  // The structural fix is that DIRECTION NOW COMES FROM THE TRIGGER, not
  // from 1H's Alligator. 1H becomes context that agrees or disagrees, never
  // a veto. A coin with no 1H alignment but a clean 5M entry is now scored
  // on its merits.
  //
  // Design discipline: structure from principle, direction-of-effect from
  // measurement, weights kept round. The measurements below rest on one
  // 100-bar window across 60 coins with overlapping forward windows, so they
  // are strong enough to say "do not reward breakouts" and far too thin to
  // justify a fitted coefficient. Fitting weights to n=63 would be
  // overfitting dressed as rigour.
  //
  // What the measurements established (all direction-balanced, since the
  // fixture window carries heavy drift):
  //   - 5M stochCrossFromExtreme in a trending 15M context: +0.571 ATR over
  //     12 bars, the strongest cell found. In a transition context: +0.359.
  //   - levelBreak is negative in every regime tested (5M trending -0.141,
  //     5M ranging -0.429, 15M/1H squeeze -0.605 with near-perfect
  //     bull/bear symmetry). bandBreakout likewise (15M trending -0.492).
  //     Breakout-chasing is not rewarded anywhere in this data.
  //   - Squeeze breakouts specifically are the worst cell measured, which
  //     settles whether "coiled, about to release" deserves credit: no.
  //   - Regime must come from 1H/15M and never 5M (C1: 5M regime is
  //     anti-predictive at all seven horizons tested).
  //   - R:R has no monotonic relationship with outcome (C2), so it gates
  //     rather than grades.
  //   - Freshness decays on 1H (+0.519 at <=0 bars vs +0.245 at <=7) but is
  //     flat on 5M, so decay is applied per-timeframe rather than uniformly.
  // ======================================================================

  // Mode = which timeframe plays which role. Indices into the [1H, 15M, 5M]
  // snapshot array. Phase D adds a swing mode; the shape is already here so
  // that stays a config change rather than a rewrite.
  const MODES = {
    scalp: { entry: 2, confirm: 1, context: 0, entryDecayPerBar: 0 },
    swing: { entry: 1, confirm: 0, context: 0, entryDecayPerBar: 8 }
  };

  // How much credit a trigger type earns given the CONFIRM timeframe's
  // regime, 0-100. Encodes direction-of-effect only — the ordering is
  // measured, the exact numbers are round and deliberately coarse.
  // TRIGGER FITNESS DEPENDS ON THE TRADE STRUCTURE, and this table was
  // twice built against the wrong one. Recording that, because the mistake
  // is easy to repeat.
  //
  // C1/C3 and the indicator audit all measured raw directional prediction
  // over ~12 bars with no stop or target, and all agreed that 5M is
  // mean-reverting: "%B at an extreme" was the best 5M reading (+0.104),
  // breakouts the worst (levelBreak -0.217). So the table favoured fades.
  //
  // Then the stop moved to 1H structure and the target to 3R, to survive
  // fees. That change is not neutral to trigger choice: 1R is now ~1.38% of
  // price, so a 3R target needs roughly a 4% move. That is a trend
  // continuation, not a mean-reversion bounce. Fade signals correctly
  // predict small reversions which this structure cannot harvest.
  //
  // Re-measured in the structure that actually ships, with TRIGGER_FIT
  // NEUTRALISED first so the table could not bias which signals cleared the
  // score threshold (it had: bandFade drew 1,636 signals purely because it
  // was rated 90). Balanced forward outcome, net of taker fees:
  //
  //     levelBreak            +0.095   (+0.015 net)   n=1351
  //     macdCross             +0.088   (+0.008 net)   n=2101
  //     bandBreakout          +0.049   (-0.031 net)   n= 805
  //     bandFade              +0.006   (-0.074 net)   n=1197
  //     stochCrossFromExtreme +0.005   (-0.075 net)   n=3144
  //
  // Exactly inverted from the audit, for a coherent reason. The ordering is
  // measured; the numbers are round because fitting them to three windows
  // would be overfitting.
  //
  // The regime dimension is deliberately FLAT here apart from squeeze. At
  // this sample size the per-regime cells are not distinguishable in this
  // structure, and inventing variation would be dressing up a guess.
  const TRIGGER_FIT = {
    trending:   { levelBreak: 100, macdCross: 95, bandBreakout: 65, liquiditySweep: 50, bandFade: 35, stochCrossFromExtreme: 35 },
    transition: { levelBreak: 95,  macdCross: 90, bandBreakout: 60, liquiditySweep: 50, bandFade: 35, stochCrossFromExtreme: 35 },
    ranging:    { levelBreak: 85,  macdCross: 85, bandBreakout: 55, liquiditySweep: 50, bandFade: 40, stochCrossFromExtreme: 40 },
    // Squeeze breakouts were the worst-measured cell of the earlier study
    // and nothing since has rehabilitated them.
    squeeze:    { levelBreak: 40,  macdCross: 50, bandBreakout: 30, liquiditySweep: 35, bandFade: 30, stochCrossFromExtreme: 30 },
    unknown:    { levelBreak: 50,  macdCross: 50, bandBreakout: 40, liquiditySweep: 35, bandFade: 30, stochCrossFromExtreme: 30 }
  };

  /**
   * The actionable half of the score: is there an entry here, right now?
   *
   * Continuation and friends are built from STATES, which is why the old
   * model could call a setup excellent without being able to say where the
   * entry was. This reads the entry timeframe's discrete EVENTS instead.
   *
   * Freshness decay is per-mode and zero for scalping on purpose: measured,
   * a 5M trigger is no worse at 3 bars old than at 0 (flat from 0 to 7),
   * while a 1H one halves over the same span. A uniform decay would have
   * felt obviously right and been wrong on the primary scalping timeframe.
   */
  function entryQuality(entrySnap, confirmRegime, mode) {
    if (!entrySnap || !entrySnap.triggers || !entrySnap.triggers.length) {
      return { score: 0, trigger: null, direction: 0 };
    }
    const fitTable = TRIGGER_FIT[confirmRegime] || TRIGGER_FIT.unknown;
    let best = null;
    for (const t of entrySnap.triggers) {
      const fit = fitTable[t.name] != null ? fitTable[t.name] : 30;
      const decayed = Math.max(0, fit - t.barsAgo * mode.entryDecayPerBar);
      if (!best || decayed > best.score) best = { score: decayed, trigger: t, direction: t.direction };
    }
    return best || { score: 0, trigger: null, direction: 0 };
  }

  /**
   * Does the wider market agree with the direction the trigger proposes?
   *
   * Deliberately NOT a veto — that veto is exactly what blanked 38% of the
   * universe. Disagreement costs points and can still leave a tradeable
   * setup, which is what makes counter-trend scalps at range extremes
   * scoreable at all.
   *
   * Reads `lineOrder`, not `alignment`: alignment is zeroed by a jaw touch,
   * which conflates "that move was invalidated" with "there is no trend
   * here". Regime quality is taken from the confirm timeframe because C1
   * measured 1H and 15M as reliable and 5M as anti-predictive.
   */
  const REGIME_QUALITY = { trending: 100, transition: 70, ranging: 55, squeeze: 35, unknown: 25 };

  function contextQuality(tfSnapshots, direction, mode) {
    const confirm = tfSnapshots[mode.confirm];
    const context = tfSnapshots[mode.context];
    if (!confirm) return 0;

    const regimeScore = REGIME_QUALITY[confirm.regime] != null ? REGIME_QUALITY[confirm.regime] : 25;

    // Agreement is scored on both higher timeframes, each contributing half.
    // A flat mouth is genuinely neutral, not a soft negative — an undecided
    // higher timeframe is much better news than an opposing one.
    const agreeOne = snap => {
      if (!snap || !direction || snap.lineOrder == null) return 50;
      if (snap.lineOrder === 0) return 50;
      return snap.lineOrder === direction ? 100 : 15;
    };
    const agreement = (agreeOne(confirm) + agreeOne(context)) / 2;

    return 0.5 * regimeScore + 0.5 * agreement;
  }

  /**
   * Combines the three components and applies the risk gate.
   *
   * The components are chosen to be genuinely distinct rather than three
   * views of one signal — discrete entry events, higher-timeframe regime
   * state, and the taught method's own confirmation states. That matters
   * because the audit found the old model double-counting RSI across four
   * places, and C1 found ADX/spread/bandwidth collinear at r>0.7.
   *
   * R:R is a GATE, not a term: C2 measured no monotonic relationship between
   * ratio and outcome, so scoring "higher is better" would actively select
   * worse trades. Below the viability threshold the setup is capped rather
   * than scaled, because the objection is categorical — you are risking more
   * than the setup can pay — not a matter of degree.
   */
  const WEIGHTS = { entry: 0.40, context: 0.35, method: 0.25 };
  const NO_RR_CAP = 45; // ceiling applied when risk:reward is not viable

  function scoreSetup(tfSnapshots, continuation, exhaustion, reversal, modeName = 'scalp') {
    const mode = MODES[modeName] || MODES.scalp;
    const entrySnap = tfSnapshots[mode.entry];
    const confirmSnap = tfSnapshots[mode.confirm];
    const confirmRegime = confirmSnap ? confirmSnap.regime : 'unknown';

    const entry = entryQuality(entrySnap, confirmRegime, mode);
    const direction = entry.direction;

    // No entry event means no trade to score, however good the backdrop
    // looks. This is the distinction the old model could not make.
    if (!direction) {
      return {
        score: 0, direction: 0, trigger: null, regime: confirmRegime,
        components: { entry: 0, context: 0, method: continuation.score },
        riskReward: null, gated: false, reason: 'no entry trigger'
      };
    }

    const context = contextQuality(tfSnapshots, direction, mode);
    const method = continuation.score; // already a 0-100 mean (Audit F3)

    let raw = WEIGHTS.entry * entry.score + WEIGHTS.context * context + WEIGHTS.method * method;

    // Exhaustion and reversal are bias-aware since B2, so they can be read
    // against the trigger's direction rather than a 1H-derived bias.
    raw -= reversal.score * 0.25;
    raw -= Math.max(0, exhaustion.score - 25) * 0.2;

    // Stop rides the CONTEXT timeframe's structure, not the entry's. On 5M
    // entries a 5M stop is ~0.255% of price against a 0.110% taker round
    // trip, so fees alone cost 0.43R and erase a +0.082R gross edge; a 1H
    // stop puts 1R at 0.952%, cutting fees to 0.115R while raising gross to
    // +0.127R. See riskReward()'s own note for the full measurement.
    const rr = Indicators.riskReward(entrySnap, direction, {
      stopFrom: tfSnapshots[mode.context] || entrySnap
    });
    let gated = false;
    if (rr && !rr.viable) { raw = Math.min(raw, NO_RR_CAP); gated = true; }

    return {
      score: Math.max(0, Math.min(100, Math.round(raw))),
      direction,
      trigger: entry.trigger,
      regime: confirmRegime,
      components: {
        entry: Math.round(entry.score),
        context: Math.round(context),
        method: Math.round(method)
      },
      riskReward: rr,
      gated,
      reason: gated ? 'no structural level to stop against' : null
    };
  }

  // tfSnapshots is always ordered [1H, 15M, 5M] — same order everywhere else.
  const TF_LABELS = ['1H', '15M', '5M'];

  // Audit F3: previously an additive point-sum capped at 65, which
  // saturated (many items firing at once, clipped to a flat number) for
  // an increasing share of the best coins as Phase 5 added more items —
  // 0/40 on main, 13/40 after Phase 5. Continuation is display-only (Q1:
  // wiring it into tradeQualityScore() would double-count alignment,
  // which TQS already weights), so a maxed diagnostic that can't tell two
  // EXCELLENT coins apart is a real loss of information, not cosmetic.
  //
  // Redesigned as an unweighted mean of 0-100 sub-scores, one per signal.
  // Each signal is either:
  //  - naturally continuous (breakout proximity, ADX strength, OI
  //    magnitude) — graded, not just thresholded;
  //  - a binary event (a cross happened or it didn't) — 100 if fired, 0
  //    if not, still counted in the mean either way, since "no cross this
  //    bar" is real information about this specific signal;
  //  - structurally inapplicable for this coin/bar (OI 15m% only exists
  //    for perps; a signal needing data this snapshot doesn't have) —
  //    EXCLUDED from the mean entirely, never scored 0. Scoring a missing
  //    signal as 0 would unfairly drag down every spot coin for lacking a
  //    perp-only signal it was never going to have.
  // add() below encodes exactly that: skip when inapplicable, otherwise
  // always contribute to the mean, only show a line item when > 0 (kept
  // from the old behavior — the card lists what's confirming, not a full
  // audit of every indicator that currently reads zero).
  function buildContinuation(tfSnapshots, bias, oiChange15m) {
    const items = [];
    const applicable = [];
    const { count } = computeBias(tfSnapshots);

    // Every applicable signal is pushed to items now (Audit F3 follow-up),
    // zero-value ones included — render.js shows those dimmed rather than
    // omitting them, so the visible breakdown actually accounts for the
    // full mean instead of implying a higher score than what's shown.
    function add(label, pct, isApplicable) {
      if (!isApplicable) return;
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      applicable.push(clamped);
      items.push([label, clamped]);
    }

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
      add(weakCount === 0 ? '3TF alligator aligned (clean)' : `3TF alligator aligned (${weakLabels.join('/')} weakening)`,
        weakCount === 0 ? 100 : 80, true);
    } else if (count === 2) {
      add(weakCount === 0 ? '2TF alligator aligned (clean)' : `2TF alligator aligned (${weakLabels.join('/')} weakening)`,
        weakCount === 0 ? 65 : 50, true);
    } else if (count === 1) {
      add('1TF alligator aligned', 30, true);
    } else {
      add('Alligator not aligned', 0, true);
    }

    const primary = tfSnapshots[0]; // 1H
    if (primary) {
      if (primary.ao != null) {
        // Same !aoRising correction as tradeQualityScore(): direction now
        // has to be explicitly falling to confirm a bearish bias.
        const strongConfirm = (bias === 1 && primary.aoRising && primary.ao > 0) ||
          (bias === -1 && primary.aoFalling && primary.ao < 0);
        const weakConfirm = (bias === 1 && primary.aoRising) || (bias === -1 && primary.aoFalling);
        if (strongConfirm) add(bias === 1 ? 'AO rising, bullish' : 'AO falling, bearish', 100, true);
        else if (weakConfirm) add('AO direction weak confirm', 45, true);
        else add('AO direction opposes bias', 0, true);
      }

      const aligned = (bias === 1 && primary.aboveUpFractal) || (bias === -1 && primary.belowDownFractal);
      add(bias === 1 ? 'Above last up fractal' : 'Below last down fractal', aligned ? 100 : 0, true);

      add('MFI Green (volume + range confirm)', primary.mfiSignal === 'green' ? 100 : 0, true);
    }

    // Breakout-proximity (Phase 6): evaluated on 15M specifically — how
    // close price sits to its own fractal-based key level, in ATR terms.
    // Continuous now (Audit F3) — a confirmed breakout is a flat 100,
    // everything else uses breakoutProximityPct() directly instead of a
    // fixed >=66% threshold gating a flat 10.
    const m15 = tfSnapshots[1];
    if (m15) {
      if (bias === 1 && m15.resistance != null && m15.atr != null) {
        const pct = m15.close > m15.resistance ? 100 : Indicators.breakoutProximityPct(m15.resistance - m15.close, m15.atr);
        add(m15.close > m15.resistance ? '15M Confirmed breakout above key level' : '15M Approaching key level (breakout setup)', pct, pct != null);
      } else if (bias === -1 && m15.support != null && m15.atr != null) {
        const pct = m15.close < m15.support ? 100 : Indicators.breakoutProximityPct(m15.close - m15.support, m15.atr);
        add(m15.close < m15.support ? '15M Confirmed breakout below key level' : '15M Approaching key level (breakout setup)', pct, pct != null);
      }
    }

    // OI 15m% (perpetuals only — null for spot). Structurally inapplicable
    // on spot, so excluded from the mean rather than scored 0. Magnitude
    // scaled against 15% as a "very active" reference point, continuous
    // rather than the old flat +8 past a 5% threshold.
    if (oiChange15m != null) {
      const pct = Math.min(100, Math.abs(oiChange15m) / 15 * 100);
      add(`Perp OI ${oiChange15m > 0 ? '+' : ''}${oiChange15m.toFixed(1)}% (15m, fresh capital)`, pct, true);
    }

    // ====================================================================
    // Phase 5 Stage 2 — scalping-tier strategies 1-5 (see the paused
    // backlog plan section 4.3 for the full owner-provided definitions).
    // computeBias()/alignmentCeiling() are never touched by this batch —
    // everything below only contributes 0-100 sub-scores toward the
    // Continuation mean, same as every existing signal in this function.
    // ====================================================================

    // Strategy 1 (Scalping EMA).
    if (primary && primary.ema9 != null && primary.ema21 != null) {
      const bullish = bias === 1 && primary.emaStackBullish;
      const bearish = bias === -1 && primary.ema9 < primary.ema21;
      add(bias === 1 ? '1H EMA 9/21 bullish trend' : '1H EMA 9/21 bearish trend', (bullish || bearish) ? 100 : 0, true);
    }
    if (m15 && m15.ema21 != null && m15.close != null && m15.atr != null) {
      // "Pullback to EMA21" = close within 0.5x ATR of EMA21 — same
      // distance-in-ATR language used elsewhere in this file (breakout-
      // proximity, OI significance), kept consistent across the batch.
      const pulledBackToEma21 = Math.abs(m15.close - m15.ema21) <= 0.5 * m15.atr;
      const fired = (bias === 1 && m15.macdBullishCross && pulledBackToEma21) ||
        (bias === -1 && m15.macdBearishCross && pulledBackToEma21);
      add(bias === 1 ? '15M MACD bullish cross on EMA21 pullback' : '15M MACD bearish cross on EMA21 pullback', fired ? 100 : 0, true);
    }

    // Strategy 2 (Volatility Breakout), 15M. "Squeeze -> expansion,
    // breaks outside band" is approximated as expanding bandwidth + a
    // close genuinely outside the band on the bias side — the snapshot
    // only carries the current bar's squeeze state (is bandwidth the
    // trailing-20 minimum right now), not a multi-bar "was squeezed a
    // few bars ago" history, so this reads the live breakout moment
    // rather than reconstructing the squeeze's own start.
    if (m15 && m15.bbUpper != null && m15.bbLower != null) {
      const breakoutUp = m15.close > m15.bbUpper;
      const breakoutDown = m15.close < m15.bbLower;
      const brokeOut = (bias === 1 && breakoutUp) || (bias === -1 && breakoutDown);
      add('15M BB squeeze breakout', (m15.bbExpanding && brokeOut) ? 100 : 0, true);
    }
    // ADX trend strength (Audit F2/F3) — standalone and continuous now,
    // no longer nested inside the squeeze-breakout block: trend strength
    // is informative on its own, not only alongside a live breakout.
    if (m15 && m15.adx != null) {
      add(`15M ADX trend strength (${m15.adx.toFixed(1)})`, Math.min(100, (m15.adx / 50) * 100), true);
    }

    // Strategy 3 (Breakout Retest), 1H. Full spec ("broke out within 8
    // bars, retested, closed back above") needs multi-bar candle history
    // the scoring layer doesn't have — approximated using what the
    // snapshot does carry: already above/below the fractal level, graded
    // by proximity to it (continuous, Audit F3) rather than a flat
    // within-0.5x-ATR threshold.
    if (primary && primary.atr != null) {
      if (bias === 1 && primary.lastUpFractal != null) {
        const pct = primary.aboveUpFractal ? Indicators.breakoutProximityPct(primary.close - primary.lastUpFractal, primary.atr) : 0;
        add('1H Breakout retest held', pct, true);
      } else if (bias === -1 && primary.lastDownFractal != null) {
        const pct = primary.belowDownFractal ? Indicators.breakoutProximityPct(primary.lastDownFractal - primary.close, primary.atr) : 0;
        add('1H Breakout retest held', pct, true);
      }
    }

    // Strategy 4 (Squeeze Momentum), 15M — distinct from Strategy 2:
    // oscillator-driven (MACD histogram direction+momentum) rather than
    // price-driven (an actual close outside the bands).
    if (m15 && m15.macdHistogram != null) {
      const histMatchesBias = (bias === 1 && m15.macdHistogram > 0) || (bias === -1 && m15.macdHistogram < 0);
      const fired = m15.bbExpanding && histMatchesBias && m15.macdHistogramRising;
      add('15M Squeeze momentum expansion (MACD confirm)', fired ? 100 : 0, true);
    }

    // Strategy 6 (Momentum Swing).
    if (primary) {
      const aligned = (bias === 1 && primary.ichimokuAboveCloud) || (bias === -1 && primary.ichimokuBelowCloud);
      add(bias === 1 ? '1H Price above Ichimoku cloud' : '1H Price below Ichimoku cloud', aligned ? 100 : 0, true);
    }
    if (m15) {
      const fired = (bias === 1 && m15.stochBullishCrossFromOversold) || (bias === -1 && m15.stochBearishCrossFromOverbought);
      add(bias === 1 ? '15M Stochastic bullish entry (oversold cross)' : '15M Stochastic bearish entry (overbought cross)', fired ? 100 : 0, true);
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
      const fired = (bias === 1 && primary.macdBullishCross) || (bias === -1 && primary.macdBearishCross);
      add('1H MACD trend-following cross', fired ? 100 : 0, true);
    }

    // Strategy 12 (Pullback Retracements), 15M. Tighter pullback
    // tolerance (0.3x ATR) than Strategy 1's 0.5x — this is a precision
    // entry-timing strategy, not just "was there a MACD cross nearby."
    // RSI 40-60 = healthy pullback, not already reversal-territory.
    if (m15 && m15.ema21 != null && m15.close != null && m15.atr != null && m15.rsi != null) {
      const emaTrendMatch = (bias === 1 && m15.emaStackBullish) ||
        (bias === -1 && m15.ema9 != null && m15.ema21 != null && m15.ema9 < m15.ema21);
      const pulledBackTight = Math.abs(m15.close - m15.ema21) <= 0.3 * m15.atr;
      const rsiHealthy = m15.rsi >= 40 && m15.rsi <= 60;
      add('15M Pullback to EMA21 (RSI healthy)', (emaTrendMatch && pulledBackTight && rsiHealthy) ? 100 : 0, true);
    }

    const score = applicable.length ? Math.round(applicable.reduce((a, b) => a + b, 0) / applicable.length) : 0;
    return { score, items };
  }

  /**
   * Exhaustion = "the move behind the CURRENT bias is running out of road".
   * That makes it inherently directional, but it used to be computed with
   * no `bias` argument at all, so it fired on both extremes regardless:
   * a short was penalised for the market being overbought, which is the
   * condition that supports the short. Half of every exhaustion reading
   * was pointing the wrong way.
   *
   * Now every threshold is evaluated against the bias it actually
   * threatens. The mirror is done by folding RSI/%B for bearish bias
   * (`100 - rsi`, `1 - percentB`) rather than by writing a second set of
   * hand-tuned bearish thresholds — that guarantees exact symmetry instead
   * of hoping two constants stay in sync.
   *
   * bias === 0 (no 1H alignment) keeps the old bias-agnostic behaviour and
   * fires on both sides: with no directional trade to exhaust, extremes at
   * either end are genuine mean-reversion information. Today TQS short-
   * circuits before reading this, but the range-bound case is exactly what
   * the regime work needs to keep.
   */
  function buildExhaustion(tfSnapshots, bias) {
    const items = [];
    let score = 0;
    const both = bias === 0 || bias == null;
    // Fold the reading so "high = exhausting the current bias" always holds.
    const foldRsi = v => (v == null ? null : (bias === -1 ? 100 - v : v));
    const foldPctB = v => (v == null ? null : (bias === -1 ? 1 - v : v));

    // fastest timeframe (5M) reaching RSI extremes is an exhaustion signal
    const fast = tfSnapshots[2]; // 5M
    if (fast && fast.rsi != null) {
      const r = foldRsi(fast.rsi);
      const overLabel = bias === -1 ? '5M RSI approaching oversold' : '5M RSI approaching overbought';
      const underLabel = bias === -1 ? '5M RSI approaching overbought' : '5M RSI approaching oversold';
      if (r >= 68) { const p = Math.round(r - 60); items.push([overLabel, p]); score += p; }
      else if (both && r <= 32) { const p = Math.round(40 - r); items.push([underLabel, p]); score += p; }
    }
    const primary = tfSnapshots[0];
    if (primary && primary.rsi != null) {
      const r = foldRsi(primary.rsi);
      // Previously long-only (rsi >= 75 with no bearish mirror), so a short
      // could never be warned it was already overextended.
      if (r >= 75) { items.push(['1H RSI extreme', 15]); score += 15; }
      else if (both && r <= 25) { items.push(['1H RSI extreme', 15]); score += 15; }
    }

    // Accelerator Oscillator: momentum-of-momentum decelerating ahead of
    // AO's own zero-cross — catches exhaustion earlier than AO alone.
    // Already symmetric: keyed off AO's own sign, not off bias.
    if (primary && primary.ac != null && primary.ao != null) {
      if (primary.ao > 0 && !primary.acRising) {
        items.push(['1H AC decelerating (bullish momentum fading)', 12]); score += 12;
      } else if (primary.ao < 0 && primary.acRising) {
        items.push(['1H AC decelerating (bearish momentum fading)', 12]); score += 12;
      }
    }

    // Strategy 5 (Mean Reversion), 5M. Two separate lines so a partial
    // confirm still shows partial pressure.
    if (fast) {
      const pb = foldPctB(fast.bbPercentB);
      if (pb != null && (pb >= 1 || (both && pb <= 0))) {
        items.push(['5M Price at BB extreme', 8]); score += 8;
      }
      // Only the crossover that turns AGAINST the bias is exhaustion: a
      // bearish cross from overbought threatens a long, a bullish cross
      // from oversold threatens a short.
      const againstBias = bias === 1 ? fast.stochBearishCrossFromOverbought
        : bias === -1 ? fast.stochBullishCrossFromOversold
        : (fast.stochBullishCrossFromOversold || fast.stochBearishCrossFromOverbought);
      if (againstBias) {
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
      // Three-way, not two-way: !aoRising used to lump "AO falling" together
      // with "AO flat or unavailable", handing bearish setups a confirmation
      // they hadn't earned (measured at 12 free TQS points). Unknown momentum
      // is now neutral rather than scored as agreement or disagreement.
      const aoGood = (bias === 1 && primary.aoRising) || (bias === -1 && primary.aoFalling);
      const aoOpposes = (bias === 1 && primary.aoFalling) || (bias === -1 && primary.aoRising);
      momentumScore = aoGood ? 75 : aoOpposes ? 35 : 50;
      if (primary.rsi != null) {
        // The 40-75 "healthy" band is written from a long's point of view.
        // Folding RSI for bearish bias applies the same band to the mirrored
        // reading, so a short at RSI 30 (trending, not yet exhausted) scores
        // like a long at RSI 70 instead of being penalised as if oversold.
        const effRsi = bias === -1 ? 100 - primary.rsi : primary.rsi;
        const healthy = effRsi > 40 && effRsi < 75;
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

    // WATCH raised from 50 to 60 on measurement, not taste. With the C5
    // structure the score finally ranks monotonically, and the bottom bucket
    // is the one that does not pay: scores 50-59 returned +0.022 gross and
    // -0.055 NET of taker fees across 2,639 signals in three market windows,
    // while every bucket from 60 up is net positive (+0.015 / +0.024 /
    // +0.030). Surfacing 50-59 as WATCH would be advertising setups measured
    // to lose money after costs.
    const scoreBand = score >= 80 ? 'excellent' : score >= 60 ? 'watch' : 'avoid';
    const cap = ceiling || 'excellent';
    const finalBand = BAND_RANK[scoreBand] <= BAND_RANK[cap] ? scoreBand : cap;

    if (finalBand === 'excellent') return { text: 'EXCELLENT', tone: 'green' };
    if (finalBand === 'watch') return { text: 'WATCH', tone: 'gold' };
    return { text: 'AVOID', tone: 'grey' };
  }

  /**
   * Bybit's kline endpoint returns the CURRENT, still-forming candle as the
   * newest element. Scoring that bar means every reading changes as the bar
   * fills, so the same coin scores differently depending purely on when in
   * the candle a scan happens to fire — measured at 4.5 points mean drift,
   * 21 points worst case, and one band flip in ten across a live sample.
   *
   * This is also a methodology point, not just noise: the Alligator / AO /
   * fractal method is a bar-CLOSE method. An unclosed bar's HA close, SMMA
   * lines and oscillator values are provisional, so a signal read from them
   * isn't the signal the method actually defines.
   *
   * Done here rather than in Api.fetchCandleSet() on purpose: scoring owns
   * its own input contract, the bot shares this file but not the fetch
   * layer, and the fixture harness bypasses the API entirely. Live price
   * for display/P&L still comes from tickers, unaffected by this.
   */
  function dropUnclosed(candles) {
    return (candles && candles.length > 1) ? candles.slice(0, -1) : candles;
  }

  /**
   * Full pipeline: pass in { h1, m15, m5 } raw candle arrays (already
   * fetched, newest last, INCLUDING the in-progress bar — this drops it).
   * Returns everything the UI needs for one coin/market.
   */
  function evaluate(candlesByTf, extras) {
    const tfSnapshots = [
      Indicators.analyzeTimeframe(dropUnclosed(candlesByTf.h1)),
      Indicators.analyzeTimeframe(dropUnclosed(candlesByTf.m15)),
      Indicators.analyzeTimeframe(dropUnclosed(candlesByTf.m5))
    ];
    if (!tfSnapshots[0]) return null; // need at least 1H data
    return evaluateSnapshots(tfSnapshots, extras);
  }

  /**
   * The scoring half of evaluate(), split out so callers that have already
   * built snapshots can reuse it. Backtesting is the reason: a validator
   * walking thousands of historical bars needs to control slicing and
   * timestamp-align the context timeframes itself, and re-implementing this
   * logic there would mean measuring a copy that can silently drift from
   * what production actually does.
   */
  function evaluateSnapshots(tfSnapshots, extras) {
    if (!tfSnapshots || !tfSnapshots[0]) return null;

    const modeName = (extras && extras.mode) || 'scalp';

    // computeBias/alignmentCeiling still run, but their role has changed.
    // They no longer decide whether a coin is tradeable — the C4 setup model
    // does that, using the trigger for direction. They stay because the
    // breakdown builders and the UI's per-TF display are written against
    // them, and because the alignment story is still worth showing even when
    // it isn't what gates the score.
    const { bias, count } = computeBias(tfSnapshots);
    // alignmentCeiling is deliberately NOT applied any more. It was the
    // 1H->15M->5M veto: no 1H alignment meant ceiling 'avoid', which capped
    // the band no matter how good the setup was. Removing the veto from
    // scoring while leaving it here would have preserved the exact blindness
    // C4 exists to fix through a second path — measured, XMR scored 80 on
    // the new model and was still forced to AVOID by it.
    //
    // Nothing replaces it, because higher-timeframe agreement is now a
    // scored component (35% of the blend) rather than a gate. bandLabel
    // treats a null ceiling as "no cap", so callers need no change. The
    // function stays exported: it is still the honest answer to "does the
    // classic confirmation chain hold", which the UI may want to show.
    const alignmentChain = alignmentCeiling(tfSnapshots, bias);
    const ceiling = null;

    // Provisional pass to get the trigger's direction, then rebuild the
    // breakdowns against it. Exhaustion and reversal are direction-aware
    // (B2), and scoring them against a 1H bias the setup may not share would
    // penalise the wrong side — a counter-trend scalp would be charged for
    // exhaustion of a trend it is not taking.
    const probe = scoreSetup(
      tfSnapshots,
      buildContinuation(tfSnapshots, bias, extras && extras.oiChange15m),
      buildExhaustion(tfSnapshots, bias),
      buildReversal(tfSnapshots, bias),
      modeName
    );
    const scoringBias = probe.direction || bias;

    const continuation = buildContinuation(tfSnapshots, scoringBias, extras && extras.oiChange15m);
    const exhaustion = buildExhaustion(tfSnapshots, scoringBias);
    const reversal = buildReversal(tfSnapshots, scoringBias);
    const setup = scoreSetup(tfSnapshots, continuation, exhaustion, reversal, modeName);
    const score = setup.score;

    const dir = directionValue(tfSnapshots);
    const regime = regimeLabel(dir, count);

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
      bias, alignCount: count, ceiling, alignmentChain, tfSnapshots,
      direction: dir, regime, score,
      continuation, exhaustion, reversal,
      // C4: the setup model's own output. `setup.direction` is the tradeable
      // direction (from the trigger) and can legitimately differ from
      // `bias`, which is still the 1H Alligator's opinion.
      setup,
      setupDirection: setup.direction,
      trigger: setup.trigger,
      contextRegime: setup.regime,
      riskReward: setup.riskReward,
      crossingLipsWarning,
      // Math.round(null) is 0, not null — a missing RSI used to render as a
      // confident "RSI 0" instead of "--".
      rsiByTf: tfSnapshots.map(s => (s && s.rsi != null) ? Math.round(s.rsi) : null),
      tfAlignment: tfSnapshots.map(s => s ? s.alignment : 0),
      tfConfidence: tfSnapshots.map(s => s ? s.confidence : 'neutral'),
      divergenceOverall: tfSnapshots[0] && tfSnapshots[0].divergence !== 'none'
        ? tfSnapshots[0].divergence
        : (tfSnapshots[1] && tfSnapshots[1].divergence !== 'none' ? tfSnapshots[1].divergence : 'none')
    };
  }

  return { computeBias, alignmentCeiling, buildContinuation, buildExhaustion, buildReversal,
           directionValue, regimeLabel, tradeQualityScore, bandLabel, evaluate,
           evaluateSnapshots, scoreSetup, entryQuality, contextQuality,
           MODES, TRIGGER_FIT, WEIGHTS };
})();

if (typeof module !== 'undefined') module.exports = Scoring;
// See the matching note in js/indicators.js — bridges Deno's per-file
// module scoping so js/signals.js can reference bare `Scoring` too.
if (typeof globalThis !== 'undefined') globalThis.Scoring = Scoring;
