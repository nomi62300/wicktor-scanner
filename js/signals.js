/* ==========================================================================
   Wicktor — signal journal (auto-resolving)

   Records what the model predicted and what the market then did, so the
   backtest's claims can be checked rather than trusted.

   Distinct from js/outcomes.js, which stays as-is: that is a MANUAL journal
   (you open a coin, you later mark it a win) and is useless as evidence —
   it only captures coins you happened to click, "win" has no defined size,
   and marking is subjective. This one logs every qualifying signal whether
   or not anyone looks at it, and resolves outcomes arithmetically from the
   price path using the entry/stop/target the model itself specified.

   TWO EXIT PLANS ARE SCORED FROM THE SAME PATH, because they differ only in
   how a shared path is harvested:
     plan B  straight to 3R, one exit
     plan A  1/3 out at 1R, stop to breakeven, remainder at 2R and 3R
   Out-of-sample backtest put plan A at +0.0556R net of taker fees against
   plan B's +0.0464R, with ~18% lower variance. A backtest cannot model
   partial-fill slippage or how a breakeven stop behaves against real wicks,
   so both are logged live and the record decides.

   Only EXCELLENT signals are journalled. Out-of-sample, scores 60-79 rank
   correctly but do not clear taker fees, so logging them would pad the
   sample with trades nobody should take.
   ========================================================================== */

const SignalJournal = (() => {
  const TABLE = 'signal_journal';
  const MIN_SCORE = 80;        // EXCELLENT only — see note above
  const HOLD_BARS = 48;        // 5M bars before a signal times out (~4h)
  const BAR_MS = 5 * 60 * 1000;

  // [fractionOfTarget, fractionClosed, stopMovesToRmultipleOfTarget]
  //
  // Expressed as fractions of the TARGET rather than fixed R multiples.
  // The target is now a ~4% price move, so its size in R varies per signal
  // (1R ranges from 1% to 25% of price); hardcoded 1R/2R/3R rungs would sit
  // far beyond the objective on wide-stop setups and never fill.
  const PLAN_A = [[1 / 3, 1 / 3, 0], [2 / 3, 1 / 3, 1 / 3], [1, 1 / 3, null]];
  const PLAN_B = [[1, 1, null]];

  function client() {
    // Auth owns the Supabase client and already degrades gracefully when the
    // CDN is unavailable (audit F4), so this inherits that rather than
    // creating a second client.
    return (typeof Auth !== 'undefined' && Auth.client) ? Auth.client : null;
  }
  function canWrite() {
    return !!(client() && typeof Auth !== 'undefined' && Auth.getUser());
  }

  /**
   * Walks a price path once and returns realised R for a plan.
   * A bar that touches both the stop and a target counts as the STOP —
   * intrabar order is unknowable from OHLC, so the pessimistic reading is
   * the only honest one, and it matches how the backtest measured.
   */
  function realisedR(bars, direction, entry, risk, plan, targetR) {
    // targetR is the objective expressed in R for THIS signal. Defaults to 3
    // only so older rows, logged while the target was a fixed 3R multiple,
    // still resolve against the geometry they were created with.
    const tR = targetR || 3;
    let stopR = -1, remaining = 1, realised = 0, rung = 0, reason = 'timeout';
    for (const b of bars) {
      const stopPx = entry + direction * stopR * risk;
      const stopHit = direction === 1 ? b.l <= stopPx : b.h >= stopPx;
      if (stopHit) {
        realised += remaining * stopR;
        return { r: realised, reason: stopR >= 0 ? 'breakeven' : 'stop' };
      }
      while (rung < plan.length) {
        const [frac0fTarget, frac, newStop] = plan[rung];
        const mult = frac0fTarget * tR;
        const tp = entry + direction * mult * risk;
        const hit = direction === 1 ? b.h >= tp : b.l <= tp;
        if (!hit) break;
        const take = Math.min(frac, remaining);
        realised += take * mult;
        remaining -= take;
        rung++;
        if (newStop != null) stopR = newStop * tR;
        if (remaining <= 1e-9) return { r: realised, reason: 'target' };
      }
    }
    const last = bars[bars.length - 1];
    return {
      r: realised + remaining * ((direction * (last.c - entry)) / risk),
      reason
    };
  }

  /**
   * Did price ever reach TP1/TP2/TP3 (1/3, 2/3, and the full price-move
   * target), as a plain fact about the market — independent of which exit
   * plan would have banked it. The ORIGINAL stop is held fixed for the
   * whole walk (never moved to breakeven the way Plan A does), so this
   * answers "did the market get there," not "would Plan A's management
   * have gotten there." Same stop-wins-ties rule as realisedR: a bar that
   * touches the stop and a TP together counts as the stop, so nothing
   * after that bar is recorded.
   */
  function tpTouches(bars, direction, entry, risk, targetR) {
    const tR = targetR || 3;
    const stopPx = entry - direction * risk;
    const levels = [1 / 3, 2 / 3, 1].map(f => entry + direction * f * tR * risk);
    const hit = [false, false, false];
    for (const b of bars) {
      const stopHit = direction === 1 ? b.l <= stopPx : b.h >= stopPx;
      if (stopHit) break;
      for (let i = 0; i < 3; i++) {
        if (direction === 1 ? b.h >= levels[i] : b.l <= levels[i]) hit[i] = true;
      }
    }
    return { tp1: hit[0], tp2: hit[1], tp3: hit[2] };
  }

  /**
   * Logs qualifying signals from a finished scan. Idempotent by design: the
   * table's unique key is (symbol, market, direction, bar_time), so every
   * client watching the same bar writes the same row and the database keeps
   * one. Failures are swallowed — journalling must never break a scan.
   *
   * THAT KEY ONLY DEDUPES WITHIN ONE 5M CANDLE. It does NOT stop a setup
   * that stays EXCELLENT across consecutive scans from being logged again
   * every time a new candle closes — bar_time legitimately advances each
   * cycle, so the unique constraint sees a "new" row every time. One
   * symbol was observed logging 2 rows 5 minutes apart from a single
   * ongoing move (2026-08-26). The backtests this model was validated
   * against never had this problem: they explicitly hold one position per
   * symbol+direction until it resolves (`open[dir] = i + HOLD`) before
   * scoring anything else on that symbol. Mirrored here — skip a symbol if
   * it already has an OPEN unresolved row for the same market+direction,
   * so the live journal actually measures what the backtest measured.
   */
  async function logFromScan(coins) {
    if (!canWrite() || !coins || !coins.length) return 0;

    let alreadyOpen;
    try {
      const { data, error } = await client().from(TABLE)
        .select('symbol,market,direction').eq('status', 'open').limit(500);
      if (error) { console.warn('[SignalJournal] open-check failed', error); return 0; }
      alreadyOpen = new Set((data || []).map(r => `${r.symbol}:${r.market}:${r.direction}`));
    } catch (e) { console.warn('[SignalJournal] open-check threw', e); return 0; }

    const rows = [];
    for (const c of coins) {
      const s = c.setup;
      if (!s || !s.direction || c.score < MIN_SCORE) continue;
      const rr = s.riskReward;
      if (!rr || !rr.stop || !rr.target) continue;
      if (alreadyOpen.has(`${c.rawSymbol}:${c.market}:${s.direction}`)) continue;
      rows.push({
        symbol: c.rawSymbol, market: c.market, direction: s.direction,
        // Bucketed to the 5M grid so every client agrees on the key even if
        // their scans fire seconds apart.
        bar_time: Math.floor(Date.now() / BAR_MS) * BAR_MS,
        score: c.score, band: 'EXCELLENT',
        context_regime: s.regime || null,
        trigger_name: s.trigger ? s.trigger.name : null,
        trigger_bars_ago: s.trigger ? s.trigger.barsAgo : null,
        component_entry: s.components ? s.components.entry : null,
        component_context: s.components ? s.components.context : null,
        component_method: s.components ? s.components.method : null,
        entry: rr.entry, stop: rr.stop, target: rr.target,
        risk_pct: rr.riskPct != null ? +rr.riskPct.toFixed(4) : null,
        // Sent explicitly, never left to the column default: a stale cached
        // build would otherwise have its old-geometry rows stamped with
        // whatever version the database currently believes is current.
        model_version: (typeof Indicators !== 'undefined' && Indicators.MODEL_VERSION) || 'unknown-client'
      });
    }
    if (!rows.length) return 0;
    try {
      const { error } = await client().from(TABLE)
        .upsert(rows, { onConflict: 'symbol,market,direction,bar_time', ignoreDuplicates: true });
      if (error) { console.warn('[SignalJournal] log failed', error); return 0; }
      return rows.length;
    } catch (e) { console.warn('[SignalJournal] log threw', e); return 0; }
  }

  /**
   * Resolves open signals against candles this scan already fetched.
   *
   * Deliberately walks the CANDLE PATH rather than comparing current price:
   * the scanner only runs while a browser is open, so a signal may have hit
   * its stop hours ago and recovered since. Comparing spot would score that
   * as a winner. `candlesBySymbol` is keyed "SYMBOL:MARKET" and holds the
   * 5M array the scan already has, so this normally costs no extra requests.
   */
  async function resolveOpen(candlesBySymbol) {
    if (!canWrite()) return 0;
    let open;
    try {
      const { data, error } = await client().from(TABLE)
        .select('*').eq('status', 'open').order('created_at', { ascending: true }).limit(200);
      if (error) { console.warn('[SignalJournal] fetch open failed', error); return 0; }
      open = data || [];
    } catch (e) { console.warn('[SignalJournal] fetch threw', e); return 0; }

    let resolved = 0;
    for (const sig of open) {
      const candles = candlesBySymbol[`${sig.symbol}:${sig.market}`];
      if (!candles || !candles.length) continue;
      const after = candles.filter(c => c.t > sig.bar_time);
      if (!after.length) continue;

      const risk = Math.abs(sig.entry - sig.stop);
      if (!risk) continue;
      const window = after.slice(0, HOLD_BARS);
      const complete = after.length >= HOLD_BARS;

      // Recovered from the stored trade spec rather than assumed, so rows
      // logged under the old fixed-3R geometry still resolve correctly.
      const targetR = Math.abs(sig.target - sig.entry) / risk;
      const a = realisedR(window, sig.direction, sig.entry, risk, PLAN_A, targetR);
      const b = realisedR(window, sig.direction, sig.entry, risk, PLAN_B, targetR);
      // Leave it open unless the trade actually finished or the horizon
      // elapsed — a half-walked path would bank a mark-to-market number as
      // though it were a result.
      if (!complete && a.reason === 'timeout') continue;

      const tp = tpTouches(window, sig.direction, sig.entry, risk, targetR);
      try {
        await client().from(TABLE).update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_bar_time: window[window.length - 1].t,
          outcome_a: +a.r.toFixed(4),
          outcome_b: +b.r.toFixed(4),
          exit_reason: a.reason,
          tp1_hit: tp.tp1, tp2_hit: tp.tp2, tp3_hit: tp.tp3
        }).eq('id', sig.id).eq('status', 'open');
        resolved++;
      } catch (e) { console.warn('[SignalJournal] resolve threw', e); }
    }
    return resolved;
  }

  /** Aggregate performance so far, for the journal page. */
  async function summary() {
    if (!client()) return null;
    try {
      const { data, error } = await client().from(TABLE)
        .select('outcome_a,outcome_b,score,context_regime,trigger_name,risk_pct,direction')
        .eq('status', 'resolved').limit(2000);
      if (error || !data || !data.length) return null;
      const mean = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
      const stat = key => {
        const all = data.map(d => d[key]).filter(v => v != null);
        const bull = data.filter(d => d.direction === 1).map(d => d[key]).filter(v => v != null);
        const bear = data.filter(d => d.direction === -1).map(d => d[key]).filter(v => v != null);
        return {
          n: all.length,
          winPct: all.length ? all.filter(v => v > 0).length / all.length * 100 : null,
          mean: mean(all),
          // Direction-balanced, for the same reason every backtest here is:
          // a trending market otherwise reads as skill.
          balanced: (bull.length && bear.length) ? (mean(bull) + mean(bear)) / 2 : null
        };
      };
      return {
        planA: stat('outcome_a'),
        planB: stat('outcome_b'),
        medianRiskPct: (() => {
          const v = data.map(d => d.risk_pct).filter(x => x != null).sort((x, y) => x - y);
          return v.length ? v[Math.floor(v.length / 2)] : null;
        })()
      };
    } catch (e) { console.warn('[SignalJournal] summary threw', e); return null; }
  }

  return { logFromScan, resolveOpen, summary, realisedR, tpTouches, MIN_SCORE, HOLD_BARS, PLAN_A, PLAN_B };
})();

if (typeof module !== 'undefined') module.exports = SignalJournal;
