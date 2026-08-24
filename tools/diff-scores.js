#!/usr/bin/env node
/* ==========================================================================
   Wicktor — diff two score snapshots

   Both snapshots must come from the SAME fixture capture, or the diff is
   measuring market movement rather than the code change. That's checked and
   refused rather than silently reported.

   Usage: node tools/diff-scores.js <before.json> <after.json>
   ========================================================================== */

const fs = require('fs');
const path = require('path');

function load(p) {
  const full = p.endsWith('.json') ? p : path.join(__dirname, 'snapshots', `${p}.json`);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function main() {
  const [aArg, bArg] = process.argv.slice(2);
  if (!aArg || !bArg) {
    console.error('usage: node tools/diff-scores.js <before> <after>');
    process.exit(1);
  }
  const A = load(aArg), B = load(bArg);

  if (A.fixturesCapturedAt !== B.fixturesCapturedAt) {
    console.error('REFUSED: snapshots came from different fixture captures.');
    console.error(`  ${A.label}: ${A.fixturesCapturedAt}`);
    console.error(`  ${B.label}: ${B.fixturesCapturedAt}`);
    console.error('A diff across captures measures the market moving, not your code.');
    process.exit(1);
  }

  const bySym = new Map(B.rows.map(r => [r.symbol, r]));
  const changed = [];
  let flips = 0, sumAbs = 0, scored = 0;
  const bandsA = {}, bandsB = {};

  for (const a of A.rows) {
    const b = bySym.get(a.symbol);
    if (!b) continue;
    if (a.evaluated) bandsA[a.band] = (bandsA[a.band] || 0) + 1;
    if (b.evaluated) bandsB[b.band] = (bandsB[b.band] || 0) + 1;
    if (!a.evaluated || !b.evaluated) continue;
    scored++;
    const d = b.score - a.score;
    sumAbs += Math.abs(d);
    const flip = a.band !== b.band;
    if (flip) flips++;
    if (d !== 0 || flip) changed.push({ sym: a.symbol, d, from: a.band, to: b.band, sa: a.score, sb: b.score, flip });
  }

  changed.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));

  console.log(`\n${A.label}  ->  ${B.label}`);
  console.log(`fixtures captured ${A.fixturesCapturedAt}`);
  console.log(`${'-'.repeat(62)}`);
  console.log(`coins compared      : ${scored}`);
  console.log(`scores changed      : ${changed.length}`);
  console.log(`band flips          : ${flips}`);
  console.log(`mean |score delta|  : ${(sumAbs / scored).toFixed(2)}`);
  console.log(`band mix before     :`, bandsA);
  console.log(`band mix after      :`, bandsB);

  if (changed.length) {
    console.log(`\n${'sym'.padEnd(14)}${'before'.padStart(7)}${'after'.padStart(7)}${'delta'.padStart(7)}   band`);
    changed.slice(0, 40).forEach(c => {
      console.log(
        c.sym.padEnd(14) +
        String(c.sa).padStart(7) +
        String(c.sb).padStart(7) +
        String(c.d > 0 ? '+' + c.d : c.d).padStart(7) +
        '   ' + (c.flip ? `${c.from} -> ${c.to}` : c.from)
      );
    });
    if (changed.length > 40) console.log(`... and ${changed.length - 40} more`);
  }
  console.log();
}

main();
