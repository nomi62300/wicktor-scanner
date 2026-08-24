#!/usr/bin/env node
/* ==========================================================================
   Wicktor — score frozen fixtures

   Runs the CURRENT js/scoring.js + js/indicators.js against the frozen
   candle fixtures and writes a flat, diffable score snapshot.

   Deterministic by construction: same fixtures + same code = byte-identical
   output. So any diff between two snapshots is caused by a code change and
   nothing else.

   Usage: node tools/score-fixtures.js [label] [fixtures] [outdir]
     label  short tag for the snapshot file, e.g. "baseline", "phase-b"
   ========================================================================== */

const fs = require('fs');
const path = require('path');

global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');

function hydrate(tuples) {
  if (!tuples) return null;
  return tuples.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

function main() {
  const label = process.argv[2] || 'snapshot';
  const fixturesPath = process.argv[3] || path.join(__dirname, 'fixtures', 'market-sample.json');
  const outdir = process.argv[4] || path.join(__dirname, 'snapshots');

  const fx = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const rows = [];

  for (const coin of fx.coins) {
    const candles = {
      h1: hydrate(coin.candles.h1),
      m15: hydrate(coin.candles.m15),
      m5: hydrate(coin.candles.m5),
      h4: hydrate(coin.candles.h4)
    };
    // oiChange15m is a live-only input with no candle equivalent, so it is
    // deliberately held at null here. Fixtures measure candle-derived
    // scoring only; OI's contribution is verified separately.
    const r = Scoring.evaluate(candles, { oiChange15m: null });
    if (!r) { rows.push({ symbol: coin.symbol, evaluated: false }); continue; }

    const band = Scoring.bandLabel(r.score, null, r.ceiling);
    rows.push({
      symbol: coin.symbol,
      evaluated: true,
      score: r.score,
      band: band.text,
      bias: r.bias,
      alignCount: r.alignCount,
      ceiling: r.ceiling,
      direction: r.direction,
      regime: r.regime,
      cont: r.continuation.score,
      exh: r.exhaustion.score,
      rev: r.reversal.score,
      contItems: r.continuation.items.length,
      tfAlignment: r.tfAlignment,
      tfConfidence: r.tfConfidence,
      rsiByTf: r.rsiByTf,
      adx1h: r.tfSnapshots[0] && r.tfSnapshots[0].adx != null
        ? +r.tfSnapshots[0].adx.toFixed(2) : null,
      // C1 regime, per TF [1H, 15M, 5M]. 5M's is recorded for completeness
      // but is measurably anti-predictive — see classifyRegime()'s validity
      // note. Scoring should read 1H/15M only.
      regimeByTf: r.tfSnapshots.map(s => s ? s.regime : null),
      spreadByTf: r.tfSnapshots.map(s => (s && s.alligatorSpreadAtr != null)
        ? +s.alligatorSpreadAtr.toFixed(2) : null)
    });
  }

  fs.mkdirSync(outdir, { recursive: true });
  const outfile = path.join(outdir, `${label}.json`);
  fs.writeFileSync(outfile, JSON.stringify({
    label,
    scoredAt: new Date().toISOString(),
    fixturesCapturedAt: fx.capturedAt,
    rows
  }, null, 1));

  const ok = rows.filter(r => r.evaluated);
  const bands = {};
  ok.forEach(r => { bands[r.band] = (bands[r.band] || 0) + 1; });
  const dead = ok.filter(r => r.bias === 0).length;

  console.log(`Scored ${ok.length}/${rows.length} coins -> ${outfile}`);
  console.log(`bands:`, bands);
  console.log(`bias===0 (unscoreable under current model): ${dead} (${(dead / ok.length * 100).toFixed(0)}%)`);
  console.log(`mean score: ${(ok.reduce((s, r) => s + r.score, 0) / ok.length).toFixed(1)}`);
}

main();
