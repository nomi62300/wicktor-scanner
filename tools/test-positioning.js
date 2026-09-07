#!/usr/bin/env node
/* ==========================================================================
   Wicktor — C5: does positioning data (OI sign, funding) predict anything?

   PRE-REGISTERED BEFORE ANY RESULT WAS SEEN (see the session record):

   H1 — the OI SIGN carries information that scoring.js's Math.abs()
        discards. js/scoring.js:390 scores |dOI|, so +8% and -8% score
        identically, though they mean opposite things:
          price^ + OI^  = new longs entering        -> continuation
          price^ + OIv  = shorts covering           -> squeeze/exhaustion
          pricev + OI^  = new shorts entering       -> continuation down
          pricev + OIv  = longs capitulating        -> exhaustion of the drop
        TEST: compare forward returns WITHIN each price direction
        (^OI^ vs ^OIv, and vOI^ vs vOIv). Holding price direction constant
        isolates the OI-sign effect and cancels market drift -- strictly
        better than testing each quadrant against zero, which would just
        re-measure whatever the market did that month.
        PREDICTED: ^OI^ > ^OIv, and vOI^ < vOIv.

   H2 — funding extremes predict reversal. High positive funding = longs
        paying shorts = crowded long = vulnerable.
        PREDICTED: highest funding quintile underperforms the lowest.

   SUCCESS CRITERIA, fixed in advance: an effect counts only if (a) its 95%
   CI excludes zero, (b) its SIGN matches the prediction above -- a
   significant effect in the wrong direction is a failed prediction, not a
   discovery -- and (c) it replicates out-of-sample.

   TWO DESIGN DECISIONS THAT DECIDE WHETHER THIS MEANS ANYTHING:

   1. CROSS-SECTIONAL DEMEANING. Alts move together. Without removing the
      common factor at each timestamp, a market-wide pump shows up as
      "signal" in every symbol simultaneously and every bucket looks
      positive. All returns here are measured RELATIVE to the cross-
      sectional mean of that timestamp, so what is left is the part
      specific to the symbol's own positioning.

   2. STRICTLY-CLOSED-BAR ALIGNMENT. An OI reading stamped T may fall
      mid-bar. Using that bar's close would read a price that did not
      exist yet at T. Every price here is taken from the last bar to have
      FULLY CLOSED at or before T (openTime + 4h <= T) -- the same rule
      tools/lib/align.js enforces for context timeframes, for the same
      reason.

   Horizon note: H=1 (next 4h bar) is the primary read because consecutive
   forward windows do not overlap, so observations are not double-counted.
   Longer horizons are reported too but their overlap inflates effective n
   and their CIs are correspondingly too narrow -- flagged, not hidden.

   Read-only. Usage: node tools/test-positioning.js
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'positioning.json');
const BAR_MS = 4 * 3600 * 1000;
const HORIZONS = [1, 3, 6];      // in 4h bars: 4h, 12h, 24h
const PRIMARY_H = 1;

function loadFixture() {
  if (!fs.existsSync(FIX)) {
    console.error(`Missing ${FIX}\nCapture it first:\n  node tools/capture-positioning.js 200`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(FIX, 'utf8'));
}

/** Index of the last candle to have FULLY CLOSED at or before `ts`.
 *  candles are [t,o,h,l,c,v] ascending, t = bar OPEN time. */
function closedIdxAt(candles, ts) {
  let lo = 0, hi = candles.length - 1, best = -1;
  const cutoff = ts - BAR_MS;      // openTime + BAR_MS <= ts  <=>  openTime <= ts - BAR_MS
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid][0] <= cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

//--------------------------------------------------------------- observations
// One row per (symbol, timestamp) with everything needed for both tests.
function buildObservations(fx) {
  const rows = [];
  for (const coin of fx.coins) {
    const c = coin.candles4h;
    if (!c || c.length < 50) continue;

    // ---- H1: OI-change observations ----
    for (let k = 1; k < coin.oi4h.length; k++) {
      const [tPrev, oiPrev] = coin.oi4h[k - 1];
      const [t, oi] = coin.oi4h[k];
      if (!(oiPrev > 0) || !(oi > 0)) continue;

      const j = closedIdxAt(c, t), jPrev = closedIdxAt(c, tPrev);
      if (j < 0 || jPrev < 0 || j <= jPrev) continue;

      const pxPrev = c[jPrev][4], px = c[j][4];
      if (!(pxPrev > 0) || !(px > 0)) continue;

      const priceChange = (px - pxPrev) / pxPrev;
      const oiChange = (oi - oiPrev) / oiPrev;
      if (priceChange === 0 || oiChange === 0) continue;

      const fwd = {};
      for (const H of HORIZONS) {
        const jf = j + H;
        fwd[H] = (jf < c.length && c[jf][4] > 0) ? (c[jf][4] - px) / px : null;
      }
      rows.push({
        kind: 'oi', symbol: coin.symbol, t,
        priceUp: priceChange > 0, oiUp: oiChange > 0,
        oiChangeAbs: Math.abs(oiChange), fwd
      });
    }

    // ---- H2: funding observations ----
    for (const [t, rate] of coin.funding) {
      const j = closedIdxAt(c, t);
      if (j < 0) continue;
      const px = c[j][4];
      if (!(px > 0)) continue;
      const fwd = {};
      for (const H of HORIZONS) {
        const jf = j + H;
        fwd[H] = (jf < c.length && c[jf][4] > 0) ? (c[jf][4] - px) / px : null;
      }
      rows.push({ kind: 'funding', symbol: coin.symbol, t, rate, fwd });
    }
  }
  return rows;
}

/** Subtracts, for each horizon, the cross-sectional mean of that timestamp.
 *  Timestamps are bucketed to the 4h grid so symbols whose OI/funding
 *  stamps differ by minutes still net against the same market move. */
function crossSectionallyDemean(rows) {
  const byBucket = new Map();
  for (const r of rows) {
    const b = Math.floor(r.t / BAR_MS) * BAR_MS;
    r._bucket = b;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(r);
  }
  for (const [, group] of byBucket) {
    for (const H of HORIZONS) {
      const vals = group.map(r => r.fwd[H]).filter(v => v != null);
      // A single-symbol bucket demeans to exactly zero and carries no
      // information; require a real cross-section before trusting it.
      if (vals.length < 5) {
        for (const r of group) r.fwd[H] = null;
        continue;
      }
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      for (const r of group) if (r.fwd[H] != null) r.fwd[H] -= m;
    }
  }
  return rows;
}

//--------------------------------------------------------------------- stats
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function ci95(vals) {
  const n = vals.length;
  if (n < 30) return null;
  const m = mean(vals);
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(v / n);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n };
}
/** Difference of two independent means, with a CI. Returns basis points. */
function diffCI(a, b) {
  const ca = ci95(a), cb = ci95(b);
  if (!ca || !cb) return null;
  const m = ca.m - cb.m;
  const se = Math.sqrt(ca.se ** 2 + cb.se ** 2);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, na: ca.n, nb: cb.n };
}
const bp = x => x == null ? '   --' : (x >= 0 ? '+' : '') + (x * 10000).toFixed(2);

function splitByTime(rows, frac = 0.7) {
  const ts = rows.map(r => r.t).sort((a, b) => a - b);
  const cut = ts[Math.floor(ts.length * frac)];
  return { is: rows.filter(r => r.t < cut), oos: rows.filter(r => r.t >= cut), cut };
}

//------------------------------------------------------------------ H1 report
function reportH1(rows, label, H) {
  const oi = rows.filter(r => r.kind === 'oi' && r.fwd[H] != null);
  const upUp = oi.filter(r => r.priceUp && r.oiUp).map(r => r.fwd[H]);
  const upDn = oi.filter(r => r.priceUp && !r.oiUp).map(r => r.fwd[H]);
  const dnUp = oi.filter(r => !r.priceUp && r.oiUp).map(r => r.fwd[H]);
  const dnDn = oi.filter(r => !r.priceUp && !r.oiUp).map(r => r.fwd[H]);

  console.log(`\n  ${label} — H1 (OI sign), horizon ${H} bar(s) = ${H * 4}h`);
  console.log(`    quadrant                     n        mean(bp)`);
  const show = (name, arr) => {
    const c = ci95(arr);
    console.log(`    ${name.padEnd(28)}${String(arr.length).padStart(6)}` +
      (c ? `${bp(c.m).padStart(12)}  [${bp(c.lo)}, ${bp(c.hi)}]` : '     (too few)'));
  };
  show('price^ OI^ (new longs)', upUp);
  show('price^ OIv (short cover)', upDn);
  show('pricev OI^ (new shorts)', dnUp);
  show('pricev OIv (capitulation)', dnDn);

  const dUp = diffCI(upUp, upDn);   // predicted POSITIVE
  const dDn = diffCI(dnUp, dnDn);   // predicted NEGATIVE
  const verdict = (d, wantPositive) => {
    if (!d) return '(too few)';
    const excludesZero = d.lo > 0 || d.hi < 0;
    const rightSign = wantPositive ? d.m > 0 : d.m < 0;
    if (!excludesZero) return 'not significant';
    return rightSign ? '*** SIGNIFICANT, PREDICTED SIGN' : '*** significant but WRONG SIGN (fails H1)';
  };
  console.log(`    diff ^OI^ - ^OIv  = ${bp(dUp && dUp.m)} bp  [${bp(dUp && dUp.lo)}, ${bp(dUp && dUp.hi)}]  predicted >0  -> ${verdict(dUp, true)}`);
  console.log(`    diff vOI^ - vOIv  = ${bp(dDn && dDn.m)} bp  [${bp(dDn && dDn.lo)}, ${bp(dDn && dDn.hi)}]  predicted <0  -> ${verdict(dDn, false)}`);
  return { dUp, dDn };
}

//------------------------------------------------------------------ H2 report
function reportH2(rows, label, H) {
  const f = rows.filter(r => r.kind === 'funding' && r.fwd[H] != null);
  if (f.length < 200) { console.log(`\n  ${label} — H2: too few funding observations (${f.length})`); return null; }

  // CROSS-SECTIONAL RANK, not value thresholds. Funding clusters hard on
  // Bybit's base rate (0.01%), so value-threshold quintiles collapse on
  // ties -- the first version of this printed Q3=0 and Q4=0, i.e. whole
  // empty buckets, because everything at or below a tied edge fell into
  // the earlier bucket. Ranking WITHIN each timestamp also removes the
  // market-wide funding regime (base rate drifts over time), leaving
  // "how crowded is THIS symbol relative to the rest right now" -- which
  // is the actual hypothesis.
  const byBucket = new Map();
  for (const r of f) {
    const b = r._bucket;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(r);
  }
  for (const [, group] of byBucket) {
    if (group.length < 5) { group.forEach(r => { r._pct = null; }); continue; }
    const ordered = group.slice().sort((a, b) => a.rate - b.rate);
    // Average rank for ties, so identical funding rates share a percentile
    // instead of being ordered arbitrarily by array position.
    let i = 0;
    while (i < ordered.length) {
      let j = i;
      while (j + 1 < ordered.length && ordered[j + 1].rate === ordered[i].rate) j++;
      const avgRank = (i + j) / 2;
      for (let k = i; k <= j; k++) ordered[k]._pct = avgRank / (ordered.length - 1 || 1);
      i = j + 1;
    }
  }
  const ranked = f.filter(r => r._pct != null);
  if (ranked.length < 200) { console.log(`\n  ${label} — H2: too few ranked funding observations (${ranked.length})`); return null; }
  const bucket = r => Math.min(4, Math.floor(r._pct * 5));

  console.log(`\n  ${label} — H2 (funding), horizon ${H} bar(s) = ${H * 4}h`);
  console.log(`    quintile (low->high funding)  n        mean(bp)`);
  const groups = [[], [], [], [], []];
  for (const r of ranked) groups[bucket(r)].push(r.fwd[H]);
  groups.forEach((g, i) => {
    const c = ci95(g);
    console.log(`    Q${i + 1}${i === 0 ? ' (least crowded long)' : i === 4 ? ' (most crowded long)' : '                    '}`.padEnd(34) +
      `${String(g.length).padStart(6)}` + (c ? `${bp(c.m).padStart(12)}  [${bp(c.lo)}, ${bp(c.hi)}]` : '     (too few)'));
  });
  const d = diffCI(groups[4], groups[0]);   // predicted NEGATIVE (crowded longs underperform)
  const excludesZero = d && (d.lo > 0 || d.hi < 0);
  const verdict = !d ? '(too few)' : !excludesZero ? 'not significant'
    : (d.m < 0 ? '*** SIGNIFICANT, PREDICTED SIGN' : '*** significant but WRONG SIGN (fails H2)');
  console.log(`    diff Q5 - Q1 = ${bp(d && d.m)} bp  [${bp(d && d.lo)}, ${bp(d && d.hi)}]  predicted <0  -> ${verdict}`);
  return d;
}

//-------------------------------------------------------------------- main
function main() {
  const fx = loadFixture();
  console.log(`C5 positioning test — ${fx.symbolCount} symbols, captured ${fx.capturedAt.slice(0, 10)}`);
  console.log(`median OI span ${fx.medianOiDays}d, median funding span ${fx.medianFundingDays}d`);
  console.log('All returns cross-sectionally demeaned; prices from strictly-closed bars only.');

  let rows = buildObservations(fx);
  rows = crossSectionallyDemean(rows);
  const oiN = rows.filter(r => r.kind === 'oi').length;
  const fN = rows.filter(r => r.kind === 'funding').length;
  console.log(`\nobservations: ${oiN.toLocaleString()} OI-change, ${fN.toLocaleString()} funding`);

  const { is, oos, cut } = splitByTime(rows);
  console.log(`IS/OOS boundary ${new Date(cut).toISOString().slice(0, 10)} — IS ${is.length.toLocaleString()}, OOS ${oos.length.toLocaleString()}`);

  console.log(`\n${'='.repeat(78)}\nPRIMARY READ — horizon ${PRIMARY_H} bar (${PRIMARY_H * 4}h), non-overlapping windows`);
  reportH1(is, 'IN-SAMPLE', PRIMARY_H);
  reportH1(oos, 'OUT-OF-SAMPLE', PRIMARY_H);
  reportH2(is, 'IN-SAMPLE', PRIMARY_H);
  reportH2(oos, 'OUT-OF-SAMPLE', PRIMARY_H);

  console.log(`\n${'='.repeat(78)}\nSECONDARY — longer horizons. Forward windows OVERLAP at H>1, so`);
  console.log('effective n is inflated and these CIs are too narrow. Directional check only.');
  for (const H of HORIZONS.filter(h => h !== PRIMARY_H)) {
    reportH1(oos, 'OOS', H);
    reportH2(oos, 'OOS', H);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('Pre-registered success bar: CI excludes zero AND sign matches prediction');
  console.log('AND it replicates out-of-sample. A significant effect with the wrong sign');
  console.log('is a failed prediction, not a discovery.');
}

module.exports = { closedIdxAt, crossSectionallyDemean, BAR_MS, HORIZONS };
if (require.main === module) main();
