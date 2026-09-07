#!/usr/bin/env node
/* ==========================================================================
   Wicktor — volume-at-price (VPVR / POC / Value Area) test

   Prompted by the owner spotting a vendor's TradingView chart using VPVR
   (Number Of Rows 200, Value Area 70%) and asking whether it helps pick
   bias on top of what we already have. Nothing in indicators.js does
   volume-AT-PRICE today (MFI is volume-over-TIME, a different axis
   entirely), so this is genuinely new information if it holds up.

   Two honesty constraints baked in from the start, not afterthoughts:

   1. "Visible Range" doesn't survive automation -- there's no chart zoom
      in a headless scan. This uses a FIXED lookback (LOOKBACK bars ending
      at the signal's entry bar), the same convention nearestLevels()
      already uses (its own lookback defaults to 100).

   2. Bybit's kline endpoint gives one volume number per BAR, not per
      PRICE. A true profile needs tick data. This distributes each bar's
      volume evenly across its own high-low range -- the standard
      approximation every retail VPVR implementation makes under the hood
      -- and it should be read as an approximation, not a precise reading.

   Value Area built with the real expanding algorithm (start at POC, add
   whichever adjacent row carries more volume, stop at VALUE_AREA_PCT),
   not a shortcut -- matches what the owner's screenshot actually showed
   (rows=200, VA%=70, TradingView's own default).

   THE HYPOTHESIS TESTED: "does this help pick bias" operationalized as
   directly as possible -- among EXCELLENT signals, does it matter whether
   the trade's own direction points TOWARD the POC (there's a volume
   magnet in the trade's favor) or AWAY from it (no such support)? Swept
   against a NEAR-POC exclusion band (trades too close to POC for the
   question to mean anything), chosen in-sample, validated out-of-sample.

   Read-only. Usage: node tools/test-volume-profile.js [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48;
const TAKER = 0.11;
const LOOKBACK = 100;          // bars of history the profile is built from -- matches nearestLevels()'s own default
const ROWS = 100;               // price-bucket resolution (owner's screenshot used 200 over a much wider visible range; 100 over a 100-bar window is comparable granularity)
const VALUE_AREA_PCT = 0.70;    // matches the owner's screenshot AND TradingView's own default

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

/**
 * Builds a fixed-range volume profile from the trailing `LOOKBACK` bars
 * ending at (and including) index `end`. Returns null if there isn't
 * enough history or the range is degenerate (all bars identical price).
 */
function buildProfile(candles, end) {
  const start = Math.max(0, end - LOOKBACK + 1);
  if (end - start + 1 < LOOKBACK) return null;
  const win = candles.slice(start, end + 1);

  let lo = Infinity, hi = -Infinity;
  for (const b of win) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (!(hi > lo)) return null;

  const rowH = (hi - lo) / ROWS;
  const vol = new Array(ROWS).fill(0);
  let totalVol = 0;

  for (const b of win) {
    const range = b.h - b.l;
    totalVol += b.v;
    if (range <= 0) {
      const r = Math.min(ROWS - 1, Math.max(0, Math.floor((b.c - lo) / rowH)));
      vol[r] += b.v;
      continue;
    }
    // Distribute this bar's volume across every row its [l,h] overlaps,
    // proportional to the overlap -- the standard "spread it evenly"
    // approximation (see file header: this is what real tick data would
    // refine, not what we have).
    const r0 = Math.max(0, Math.floor((b.l - lo) / rowH));
    const r1 = Math.min(ROWS - 1, Math.floor((b.h - lo) / rowH));
    for (let r = r0; r <= r1; r++) {
      const rowLo = lo + r * rowH, rowHi = rowLo + rowH;
      const overlap = Math.min(b.h, rowHi) - Math.max(b.l, rowLo);
      if (overlap > 0) vol[r] += b.v * (overlap / range);
    }
  }
  if (!(totalVol > 0)) return null;

  let pocRow = 0;
  for (let r = 1; r < ROWS; r++) if (vol[r] > vol[pocRow]) pocRow = r;
  const poc = lo + (pocRow + 0.5) * rowH;

  // Expanding Value Area: from POC, repeatedly add whichever untaken
  // neighbor (below the current low edge, or above the current high edge)
  // carries more volume, until VALUE_AREA_PCT of total volume is enclosed.
  // This is the real algorithm, not a percentile shortcut -- a percentile
  // cut on price would silently disagree with this whenever the profile
  // is multi-modal (two separate high-volume humps), which crypto ranges
  // often are.
  let loIdx = pocRow, hiIdx = pocRow, covered = vol[pocRow];
  const target = totalVol * VALUE_AREA_PCT;
  while (covered < target && (loIdx > 0 || hiIdx < ROWS - 1)) {
    const belowVol = loIdx > 0 ? vol[loIdx - 1] : -1;
    const aboveVol = hiIdx < ROWS - 1 ? vol[hiIdx + 1] : -1;
    if (aboveVol >= belowVol) { hiIdx++; covered += vol[hiIdx]; }
    else { loIdx--; covered += vol[loIdx]; }
  }
  const val = lo + loIdx * rowH, vah = lo + (hiIdx + 1) * rowH;

  return { poc, vah, val, lo, hi };
}

function collect(fx, minScore) {
  const rows = [];
  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + LOOKBACK + 5) continue;
      const openUntil = { 1: -1, '-1': -1 };
      let cache15 = { idx: -1, snap: null }, cache1h = { idx: -1, snap: null };

      for (let i = WARMUP; i < m5.length - HOLD; i++) {
        const ts = m5[i].t;
        const ci15 = closedIndexAt(m15, ts, TF_MS.m15), ci1h = closedIndexAt(h1, ts, TF_MS.h1);
        if (ci15 < WARMUP || ci1h < 60) continue;
        if (ci15 !== cache15.idx) cache15 = { idx: ci15, snap: I.analyzeTimeframe(windowed(m15, ci15)) };
        if (ci1h !== cache1h.idx) cache1h = { idx: ci1h, snap: I.analyzeTimeframe(windowed(h1, ci1h)) };
        if (!cache1h.snap || !cache15.snap) continue;
        const snapM5 = I.analyzeTimeframe(windowed(m5, i));
        if (!snapM5) continue;

        const r = Scoring.evaluateSnapshots([cache1h.snap, cache15.snap, snapM5], { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < minScore) continue;
        if (i < openUntil[r.setupDirection]) continue;
        const rr = r.riskReward;
        if (!rr || !rr.entry || !rr.stop) continue;

        const profile = buildProfile(m5, i);
        if (!profile) continue;
        openUntil[r.setupDirection] = i + HOLD;

        // Original exit walk: fixed 3R target, same convention as the
        // stop-reversal test, so this population is directly comparable.
        const risk = Math.abs(rr.entry - rr.stop);
        const targetPx = rr.entry + r.setupDirection * risk * 3.0;
        let outcomeR = null;
        const end = Math.min(i + HOLD, m5.length - 1);
        for (let k = i + 1; k <= end; k++) {
          const bar = m5[k];
          const hitStop = r.setupDirection === 1 ? bar.l <= rr.stop : bar.h >= rr.stop;
          const hitTarget = r.setupDirection === 1 ? bar.h >= targetPx : bar.l <= targetPx;
          if (hitStop) { outcomeR = -1; break; }
          if (hitTarget) { outcomeR = 3.0; break; }
          if (k === end) outcomeR = (r.setupDirection * (bar.c - rr.entry)) / risk;
        }
        if (outcomeR == null) continue;

        const pocDistPct = (rr.entry - profile.poc) / rr.entry * 100;
        // "Toward POC" = the trade's own direction points at the volume
        // magnet: long with POC above entry, short with POC below.
        const towardPOC = r.setupDirection === 1 ? profile.poc > rr.entry : profile.poc < rr.entry;
        const inValueArea = rr.entry >= profile.val && rr.entry <= profile.vah;

        rows.push({
          dir: r.setupDirection, riskPct: rr.riskPct, outcomeR,
          pocDistPct: Math.abs(pocDistPct), towardPOC, inValueArea
        });
      }
    }
  }
  return rows;
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);

function balancedCI(list) {
  const net = x => x.outcomeR - TAKER / x.riskPct;
  const arm = d => list.filter(x => x.dir === d).map(net);
  const b = arm(1), s = arm(-1);
  if (b.length < 10 || s.length < 10) return null;
  const se = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
  const m = (mean(b) + mean(s)) / 2, e = Math.sqrt(se(b) ** 2 + se(s) ** 2) / 2;
  return { m, lo: m - 1.96 * e, hi: m + 1.96 * e, n: list.length };
}

function line(label, list) {
  const c = balancedCI(list);
  console.log(`  ${label.padEnd(30)}${String(list.length).padStart(6)}` +
    (c ? `${sg(c.m).padStart(10)}  [${sg(c.lo)}, ${sg(c.hi)}]` : '   (too few)'));
}

function main() {
  const minScore = parseFloat(process.argv[2]) || 80;
  const isFile = path.join(__dirname, 'fixtures', 'market-deep.json');
  const oosFile = path.join(__dirname, 'fixtures', 'market-oos.json');
  const fxIS = JSON.parse(fs.readFileSync(isFile, 'utf8'));
  const fxOOS = fs.existsSync(oosFile) ? JSON.parse(fs.readFileSync(oosFile, 'utf8')) : null;

  console.log(`Volume profile test — score>=${minScore}, ${LOOKBACK}-bar fixed-range profile, ${ROWS} rows, ${(VALUE_AREA_PCT * 100)}% value area`);
  console.log('Net of taker fee. Direction-balanced throughout.\n');

  console.log('IN-SAMPLE (choose the exclusion band here, never validate here)');
  const rowsIS = collect(fxIS, minScore);
  console.log(`  ${rowsIS.length} EXCELLENT signals with a computable profile\n`);

  console.log('  group                              n      meanR   95% CI');
  line('all', rowsIS);
  line('toward POC', rowsIS.filter(x => x.towardPOC));
  line('away from POC', rowsIS.filter(x => !x.towardPOC));
  line('inside value area', rowsIS.filter(x => x.inValueArea));
  line('outside value area', rowsIS.filter(x => !x.inValueArea));

  console.log('\n  toward vs away, swept by a near-POC exclusion band (dist as % of price):');
  const bands = [0, 0.1, 0.25, 0.5, 1.0];
  let best = null;
  for (const band of bands) {
    const pool = rowsIS.filter(x => x.pocDistPct >= band);
    const toward = pool.filter(x => x.towardPOC), away = pool.filter(x => !x.towardPOC);
    const ct = balancedCI(toward), ca = balancedCI(away);
    const delta = (ct && ca) ? ct.m - ca.m : null;
    console.log(`  exclude <${band}%      toward n=${toward.length} ${sg(ct && ct.m)}   away n=${away.length} ${sg(ca && ca.m)}   delta ${sg(delta)}`);
    if (delta != null && (!best || delta > best.delta)) best = { band, delta };
  }

  if (!best) { console.log('\nNo band produced enough data to compare.'); return; }
  console.log(`\n-> IS-BEST exclusion band (selected before looking at OOS): <${best.band}%  delta ${sg(best.delta)}`);

  if (fxOOS) {
    console.log('\nOUT-OF-SAMPLE — only this ONE band, run unchanged');
    const rowsOOS = collect(fxOOS, minScore);
    const pool = rowsOOS.filter(x => x.pocDistPct >= best.band);
    const toward = pool.filter(x => x.towardPOC), away = pool.filter(x => !x.towardPOC);
    line('toward POC', toward);
    line('away from POC', away);
    const ct = balancedCI(toward), ca = balancedCI(away);
    if (ct && ca) {
      const deltaLo = ct.lo - ca.hi, deltaHi = ct.hi - ca.lo;
      console.log(`  Rough delta CI (conservative, treats both arms as independent): [${sg(deltaLo)}, ${sg(deltaHi)}]`);
    }
  } else {
    console.log('\nNo market-oos.json found — IS-only result, not validated.');
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('If "toward POC" beats "away from POC" out-of-sample with a CI excluding');
  console.log('zero, that is real support for using volume-at-price as a bias filter.');
  console.log('Remember this is built on bar-level volume spread across each bar\'s');
  console.log('range, not tick data -- an approximation, same as any retail VPVR.');
}

module.exports = { buildProfile, LOOKBACK, ROWS, VALUE_AREA_PCT };
if (require.main === module) main();
