#!/usr/bin/env node
/* Replays the REAL terminal engine over 17-21 Aug 2026 — a period in
 * which BTC rose 23.9%, ETH 34.5%, SOL 25.9% — to settle the one
 * question the live journal cannot answer.
 *
 * WHY THIS IS LEGITIMATE AND NOT A BACKTEST FANTASY: Scoring.evaluate()
 * is a pure function of candles. The same code the scanner and the bot
 * run is imported here unmodified, so the signals it produces for a past
 * bar are exactly the signals it would have produced live at that bar.
 * Nothing is re-implemented or approximated.
 *
 * THE THING THAT WOULD INVALIDATE IT — LOOKAHEAD. Handled explicitly:
 * at simulated time T, each timeframe is sliced to bars with
 * openTime <= T, so the newest included bar is the one IN PROGRESS at T.
 * scoring.js's own dropUnclosed() then discards it, leaving only fully
 * closed bars — identical to what the live scanner sees when it fetches
 * "the latest N bars" mid-bar. The entry price is the close of the last
 * CLOSED bar, and the forward path is measured strictly from the next
 * bar onward. This project has been burned by lookahead before (see the
 * tools/lib/align.js episode), hence the care.
 *
 * THE TEST: longs currently show ~2x the adverse excursion of shorts
 * while reaching identical favourable excursion. If that is STRUCTURAL,
 * it persists here in a violent uptrend. If it is just beta from a
 * falling sample, it inverts.
 */
const path = require('path');
const BOT = path.join(process.env.HOME, 'Downloads', 'wicktor-bot-terminal', 'src', 'engine');
const { Scoring, MIN_SCORE } = require(BOT);

const FROM = Date.parse('2026-08-17T00:00:00Z');
const TO   = Date.parse('2026-08-21T23:55:00Z');
const HOLD_BARS = 144;                       // 12h forward window, as in the live study
const M5 = 5 * 60 * 1000, H1 = 60 * 60 * 1000;
const WARMUP = 120;                          // bars of history the indicators need
const UNIVERSE = Number(process.env.UNIVERSE || 60);
const STEP = Number(process.env.STEP || 1);  // evaluate every Nth 5m bar

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const j = await (await fetch(url)).json();
      if (j.retCode === 0) return j.result;
    } catch {}
    await sleep(300 * (i + 1));
  }
  return null;
}

/**
 * Bybit returns the NEWEST bars within [start, end], capped at `limit` —
 * not the oldest. So history is walked by moving `end` BACKWARDS; moving
 * `start` forwards just re-requests the same final window forever and
 * silently returns one page (which is why the first run produced zero
 * signals for every symbol).
 */
async function klines(symbol, interval, from, to) {
  const out = new Map();
  const step = interval * 60 * 1000;
  let cursor = to;
  for (let page = 0; page < 40 && cursor > from; page++) {
    const r = await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}` +
                        `&interval=${interval}&start=${from}&end=${cursor}&limit=1000`);
    if (!r || !r.list || !r.list.length) break;
    for (const x of r.list) {
      out.set(Number(x[0]), { t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] });
    }
    const oldest = Math.min(...r.list.map(x => Number(x[0])));
    if (r.list.length < 1000 || oldest <= from) break;
    cursor = oldest - step;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Bars whose OPEN is at or before T — the newest is the in-progress one,
 *  which scoring.js drops itself. Mirrors the live fetch exactly. */
function upto(bars, T, n) {
  let hi = bars.length - 1;
  while (hi >= 0 && bars[hi].t > T) hi--;
  if (hi < 0) return [];
  return bars.slice(Math.max(0, hi - n + 1), hi + 1);
}

(async () => {
  const tick = await get('https://api.bybit.com/v5/market/tickers?category=linear');
  const EXCLUDE = /^(USDC|FDUSD|DAI|TUSD|EUR|USDE)USDT$/, LEV = /(UP|DOWN|BULL|BEAR)USDT$/;
  const universe = tick.list
    .filter(t => t.symbol.endsWith('USDT') && !EXCLUDE.test(t.symbol) && !LEV.test(t.symbol))
    .map(t => ({ symbol: t.symbol, turnover: +(t.turnover24h || 0) }))
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, UNIVERSE);

  console.log(`replaying ${universe.length} symbols over 2026-08-17 -> 2026-08-21, step ${STEP} bar(s)`);

  const fetchFrom = FROM - WARMUP * H1;      // enough history for the 1H indicators
  const fetchTo = TO + (HOLD_BARS + 5) * M5;
  const signals = [];
  let done = 0, skipped = 0;

  for (const u of universe) {
    const [m5, m15, h1] = await Promise.all([
      klines(u.symbol, 5, fetchFrom, fetchTo),
      klines(u.symbol, 15, fetchFrom, fetchTo),
      klines(u.symbol, 60, fetchFrom, fetchTo),
    ]);
    done++;
    // Needs real history on every timeframe AND coverage of the window.
    if (m5.length < 300 || m15.length < 120 || h1.length < 120 || m5[0].t > FROM) { skipped++; continue; }

    const idx = new Map(m5.map((b, i) => [b.t, i]));
    let openUntil = 0;   // one position per symbol at a time, as the journal enforces

    for (let T = FROM; T <= TO; T += M5 * STEP) {
      if (T < openUntil) continue;
      const w5 = upto(m5, T, 100), w15 = upto(m15, T, 100), w1 = upto(h1, T, 100);
      if (w5.length < 60 || w15.length < 60 || w1.length < 60) continue;

      let res;
      try { res = Scoring.evaluate({ h1: w1, m15: w15, m5: w5 }, {}); } catch { continue; }
      if (!res || res.score < MIN_SCORE) continue;
      const s = res.setup;
      if (!s || !s.direction) continue;
      const rr = s.riskReward;
      if (!rr || !rr.stop || !rr.target || !rr.entry) continue;

      const entry = rr.entry;
      const risk = Math.abs(entry - rr.stop);
      if (!(risk > 0) || !(entry > 0)) continue;

      // Forward path starts at the bar AFTER the decision bar.
      const i = idx.get(T);
      if (i == null) continue;
      const fwd = m5.slice(i, i + HOLD_BARS + 1);
      if (fwd.length < HOLD_BARS + 1) continue;

      const dir = s.direction;
      const bars = fwd.map(b => {
        const fav = dir === 1 ? b.h : b.l;
        const adv = dir === 1 ? b.l : b.h;
        return [
          +(((dir * (fav - entry)) / risk).toFixed(4)),
          +(((dir * (entry - adv)) / risk).toFixed(4)),
          +(((dir * (b.c - entry)) / risk).toFixed(4)),
        ];
      });

      signals.push({
        symbol: u.symbol, dir, bar_time: T, score: res.score,
        riskPct: (risk / entry) * 100,
        origTargetR: Math.abs(rr.target - entry) / risk,
        triggerName: s.trigger ? s.trigger.name : null,
        bars,
      });
      openUntil = T + HOLD_BARS * M5;        // no re-entry while "open"
    }

    if (done % 10 === 0) {
      console.log(`  ${done}/${universe.length} symbols, ${signals.length} signals (skipped ${skipped})`);
    }
  }

  const L = signals.filter(s => s.dir === 1).length;
  console.log(`\nDone. ${signals.length} signals — longs ${L}, shorts ${signals.length - L}, skipped ${skipped} symbols.`);
  require('fs').writeFileSync('./uptrend_signals.json', JSON.stringify(signals));
})();
