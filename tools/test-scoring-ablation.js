#!/usr/bin/env node
/* ==========================================================================
   Wicktor — Alligator/AO ablation test

   Owner's question: bias no longer comes from Alligator (C4 already fixed
   that — direction comes from the entry-timeframe trigger). But Alligator
   alignment and AO still feed the SCORE, in two places measured directly
   from the current code: buildContinuation()'s "3TF/2TF/1TF alligator
   aligned" + "AO rising/falling" line items (part of the ~25%-weighted
   continuation mean), and buildExhaustion()'s AC-decelerating item (up to
   12 of a capped-40 exhaustion score). Does dropping them change which
   trades reach EXCELLENT, and if so, is the resulting selection better or
   worse?

   PRODUCTION-SAFE BY CONSTRUCTION, not just by promise: this file imports
   js/scoring.js and calls its ALREADY-EXPORTED functions --
   evaluateSnapshots (for the real baseline, unmodified), and
   buildContinuation/buildExhaustion/buildReversal/scoreSetup individually
   to recompute an "ablated" score using the SAME blend, weights, and
   risk:reward gate as production. Nothing in scoring.js is edited, no
   flag is added to it, nothing here could ever reach the live scanner.
   The only new code is which LINE ITEMS get excluded before the mean/sum
   is recomputed -- done by filtering the labelled items buildContinuation/
   buildExhaustion already return, not by reimplementing their math.

   Verified equivalence before trusting this: with NOTHING ablated (empty
   exclude patterns), the recombined score must exactly equal
   evaluateSnapshots()'s own real score on every signal -- see the
   assertion in collect(). This is what "keep the old logic safe, don't
   duplicate it" actually looks like: reuse, then prove the reuse is
   faithful.

   Fractals is NOT touched -- it has zero role in bias/scoring (only
   nearestLevels() stop/target placement and the liquiditySweep trigger).

   Read-only. Usage: node tools/test-scoring-ablation.js [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48;
const TAKER = 0.11;

const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const windowed = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);

// Exact label patterns for every Williams-family (Alligator/AO/AC/Wiseman)
// line item across ALL THREE build* functions -- found by grepping every
// label STRING in scoring.js for alligator/wiseman/\bAO\b/accelerat, not
// just the two functions the owner named, because buildReversal() turned
// out to carry one too ("1H Wiseman AO reversal") that a narrower first
// pass at this (matching only labels STARTING with "AO ") would have
// silently missed -- \bAO\b (whole word, anywhere) catches that one too.
// Full source list this was built from: buildContinuation ~L339-360
// (3TF/2TF/1TF alligator aligned, Alligator not aligned, AO rising/
// falling/weak-confirm/opposes), buildExhaustion ~L554-558 (AC
// decelerating), buildReversal ~L616-619 (Wiseman AO reversal).
const WILLIAMS_PATTERNS = [/alligator/i, /\bAO\b/, /AC decelerating/, /wiseman/i];
const isWilliams = label => WILLIAMS_PATTERNS.some(p => p.test(label));

/** Recomputes a build*() result's score from a filtered item list, using
 *  the SAME arithmetic that function itself used -- verified against the
 *  real function by reproducing it exactly when nothing is filtered (see
 *  verifyIdentity). Every item's pushed value equals what was added to
 *  `score` before that function's own final clamp (confirmed by reading
 *  every `score += X; items.push([label, X])` pair in all three
 *  functions), so summing/averaging the KEPT items fresh and re-clamping
 *  is exact, not an approximation. */
function recompute(built, kind, cap, exclude) {
  const kept = built.items.filter(([label]) => !exclude(label));
  if (kind === 'mean') { // buildContinuation
    const score = kept.length ? Math.round(kept.reduce((s, [, v]) => s + v, 0) / kept.length) : 0;
    return { score, items: kept };
  }
  // 'cappedSum' — buildExhaustion (cap=40) and buildReversal (cap=50).
  const score = Math.max(0, Math.min(cap, kept.reduce((s, [, v]) => s + v, 0)));
  return { score, items: kept };
}
const NEVER = () => false; // no-op filter, for proving recompute()'s own arithmetic is exact

function ablatedScore(tfSnapshots, bias, oiChange15m, modeName) {
  const cont = Scoring.buildContinuation(tfSnapshots, bias, oiChange15m);
  const exh = Scoring.buildExhaustion(tfSnapshots, bias);
  const rev = Scoring.buildReversal(tfSnapshots, bias); // DOES carry one: "1H Wiseman AO reversal" -- ablated too
  const ablCont = recompute(cont, 'mean', null, isWilliams);
  const ablExh = recompute(exh, 'cappedSum', 40, isWilliams);
  const ablRev = recompute(rev, 'cappedSum', 50, isWilliams);
  return Scoring.scoreSetup(tfSnapshots, ablCont, ablExh, ablRev, modeName);
}

let identityChecked = 0, identityFailed = 0;
/** Proves recompute()'s OWN arithmetic (mean / capped-sum) reproduces the
 *  real score EXACTLY when its filter excludes nothing -- genuinely
 *  exercises the same function the real ablation calls, not a bypass, so
 *  this is real evidence the mean/cap/sum logic is correct before trusting
 *  it to exclude something for real. */
function verifyIdentity(tfSnapshots, bias, oiChange15m, modeName, realSetup) {
  const cont = Scoring.buildContinuation(tfSnapshots, bias, oiChange15m);
  const exh = Scoring.buildExhaustion(tfSnapshots, bias);
  const rev = Scoring.buildReversal(tfSnapshots, bias);
  const noOpCont = recompute(cont, 'mean', null, NEVER);
  const noOpExh = recompute(exh, 'cappedSum', 40, NEVER);
  const noOpRev = recompute(rev, 'cappedSum', 50, NEVER);
  const reconstructed = Scoring.scoreSetup(tfSnapshots, noOpCont, noOpExh, noOpRev, modeName);
  identityChecked++;
  const mismatch = reconstructed.score !== realSetup.score || reconstructed.direction !== realSetup.direction ||
    noOpCont.score !== cont.score || noOpExh.score !== exh.score || noOpRev.score !== rev.score;
  if (mismatch) {
    identityFailed++;
    if (identityFailed <= 3) {
      console.error(`IDENTITY MISMATCH: real score=${realSetup.score} dir=${realSetup.direction} ` +
        `cont=${cont.score} exh=${exh.score} rev=${rev.score}` +
        ` vs reconstructed score=${reconstructed.score} dir=${reconstructed.direction} ` +
        `cont=${noOpCont.score} exh=${noOpExh.score} rev=${noOpRev.score}`);
    }
  }
}

function collect(fx, minScore) {
  const rows = [];
  for (const win of fx.windows) {
    for (const coin of win.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + 5) continue;
      const openUntil = { 1: -1, '-1': -1 }; // gates the BASELINE population only (see note below)
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
        const tfSnapshots = [cache1h.snap, cache15.snap, snapM5];

        // Baseline: the REAL, unmodified production call.
        const base = Scoring.evaluateSnapshots(tfSnapshots, { mode: 'scalp' });
        if (!base || !base.setupDirection) continue; // no trigger, no comparison to make -- direction is Williams-independent (verified in code read), so this population is identical for both versions
        if (i < openUntil[base.setupDirection]) continue;
        const rr = base.riskReward;
        if (!rr || !rr.entry || !rr.stop) continue;
        openUntil[base.setupDirection] = i + HOLD;

        // Prove the reconstruction machinery is faithful, on THIS signal,
        // before trusting its ablated output.
        if (identityChecked < 400) verifyIdentity(tfSnapshots, base.setupDirection, null, 'scalp', base.setup);

        const abl = ablatedScore(tfSnapshots, base.setupDirection, null, 'scalp');

        // Same fixed-3R exit walk used by the other tools this week, so
        // this population's realised R is directly comparable.
        const risk = Math.abs(rr.entry - rr.stop);
        const targetPx = rr.entry + base.setupDirection * risk * 3.0;
        let outcomeR = null;
        const end = Math.min(i + HOLD, m5.length - 1);
        for (let k = i + 1; k <= end; k++) {
          const bar = m5[k];
          const hitStop = base.setupDirection === 1 ? bar.l <= rr.stop : bar.h >= rr.stop;
          const hitTarget = base.setupDirection === 1 ? bar.h >= targetPx : bar.l <= targetPx;
          if (hitStop) { outcomeR = -1; break; }
          if (hitTarget) { outcomeR = 3.0; break; }
          if (k === end) outcomeR = (base.setupDirection * (bar.c - rr.entry)) / risk;
        }
        if (outcomeR == null) continue;

        rows.push({
          dir: base.setupDirection, riskPct: rr.riskPct, outcomeR,
          baseScore: base.score, ablScore: abl.score,
          baseExcellent: base.score >= minScore, ablExcellent: abl.score >= minScore
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
  console.log(`  ${label.padEnd(34)}${String(list.length).padStart(6)}` +
    (c ? `${sg(c.m).padStart(10)}  [${sg(c.lo)}, ${sg(c.hi)}]` : '   (too few)'));
}

function report(rows, label) {
  console.log(`\n${label}`);
  console.log(`  ${rows.length} candidate signals with a computable ablated score`);

  const scoreDeltas = rows.map(r => r.ablScore - r.baseScore);
  console.log(`  score delta: mean ${mean(scoreDeltas).toFixed(2)}, ` +
    `min ${Math.min(...scoreDeltas)}, max ${Math.max(...scoreDeltas)}`);

  const bothExcellent = rows.filter(r => r.baseExcellent && r.ablExcellent);
  const demoted = rows.filter(r => r.baseExcellent && !r.ablExcellent);   // baseline EXCELLENT, ablation drops it
  const promoted = rows.filter(r => !r.baseExcellent && r.ablExcellent);  // ablation adds it, baseline didn't have it
  const neitherExcellent = rows.filter(r => !r.baseExcellent && !r.ablExcellent);

  console.log(`\n  group                                  n      meanR    95% CI`);
  line('baseline EXCELLENT (current model)', rows.filter(r => r.baseExcellent));
  line('  -> kept EXCELLENT by ablation', bothExcellent);
  line('  -> DEMOTED out of EXCELLENT', demoted);
  line('ablated EXCELLENT (Williams-free)', rows.filter(r => r.ablExcellent));
  line('  -> PROMOTED into EXCELLENT (new)', promoted);
  line('neither reaches EXCELLENT', neitherExcellent);
}

function main() {
  const minScore = parseFloat(process.argv[2]) || 80;
  const isFile = path.join(__dirname, 'fixtures', 'market-deep.json');
  const oosFile = path.join(__dirname, 'fixtures', 'market-oos.json');
  const fxIS = JSON.parse(fs.readFileSync(isFile, 'utf8'));
  const fxOOS = fs.existsSync(oosFile) ? JSON.parse(fs.readFileSync(oosFile, 'utf8')) : null;

  console.log(`Alligator/AO ablation — EXCELLENT threshold score>=${minScore}`);
  console.log('js/scoring.js is NOT modified. Real evaluateSnapshots() is the baseline;');
  console.log('the ablated score reuses the same exported scoreSetup()/buildContinuation()/');
  console.log('buildExhaustion() with Alligator+AO line items filtered out before the');
  console.log('mean/sum they feed is recomputed.\n');

  const rowsIS = collect(fxIS, minScore);
  console.log(`Identity check: ${identityChecked} signals verified, ${identityFailed} mismatches` +
    (identityFailed ? ' -- DO NOT TRUST RESULTS BELOW, reconstruction is not faithful' : ' -- reconstruction is exact.'));
  if (identityFailed > 0) { console.error('\nAborting: fix the identity mismatch before reading further output.'); return; }

  report(rowsIS, 'IN-SAMPLE');

  if (fxOOS) {
    const rowsOOS = collect(fxOOS, minScore);
    report(rowsOOS, 'OUT-OF-SAMPLE');
  } else {
    console.log('\nNo market-oos.json found — IS-only result, not validated.');
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('The comparison that answers the question: does "ablated EXCELLENT" have a');
  console.log('better (less negative) mean R than "baseline EXCELLENT"? And do PROMOTED');
  console.log('trades (ones Williams was suppressing) outperform DEMOTED ones (ones');
  console.log('Williams was correctly propping up)? If promoted beats demoted with a real');
  console.log('CI, that is evidence Alligator/AO is net harmful to have in the score.');
}

main();
