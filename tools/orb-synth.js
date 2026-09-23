#!/usr/bin/env node
'use strict';
/* ==========================================================================
   Wicktor — deterministic synthetic 5M bars for the ORB harness.

   TWO JOBS, and the second is the important one.

   1. MECHANISM TEST. Until real UK100 bars exist, this is the only way to
      run the state machine end to end: does a box form, does a breakout
      register, does a retest fire, does an exit resolve. It says NOTHING
      about whether the strategy makes money, and every report built on it
      is stamped accordingly.

   2. NEGATIVE CONTROL. A driftless random walk has no edge by construction.
      Run enough synthetic sessions and the harness MUST come back at
      -meanCostR: you pay the spread and receive nothing. If it prints a
      positive expectancy, the harness is broken — an off-by-one in the exit
      walk, a leaked future fractal, a retest reading the bar after itself.
      This is the automated version of the bug tools/lib/align.js was
      written about, and it runs on every test invocation.

   The bar grid is built THROUGH tools/lib/tz.js rather than on a fixed UTC
   offset, so the generator exercises the same DST logic the strategy does —
   including runs that straddle 2025-03-30 and 2025-10-26.

   Read-only (writes only to the path you name). Usage:
     node tools/orb-synth.js --seed 42 --from 2025-01-01 --to 2025-12-31 \
          --mode mixed --out data/synth-m5.csv
     node tools/orb-synth.js --seed 42 --sessions 2000 --self-check
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const tz = require('./lib/tz.js');

const BANNER =
  'MECHANISM TEST — synthetic bars. Never quote these numbers as strategy evidence.\n' +
  '  mode=flat  NEGATIVE control: driftless walk, expectancy must come back at -costR.\n' +
  '  mode=trend POSITIVE control: real drift injected, a breakout system should profit.';

// ------------------------------------------------------------------- PRNG
/** mulberry32: 4 lines, deterministic across Node versions, good enough. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box-Muller on top of the same stream, so one seed drives everything. */
function gaussFrom(rnd) {
  let spare = null;
  return function () {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
}

// ------------------------------------------------------------------- grid
const M5 = 5 * 60 * 1000;

/**
 * Every 5M slot whose London wall clock falls in [fromMin,toMin) on a
 * weekday. Built by walking UTC and asking tz.js what the local time is —
 * never by assuming an offset — so BST and GMT are both handled and the
 * transition weekends are genuinely exercised.
 */
function sessionGrid(fromYmd, toYmd, opts = {}) {
  const gridZone = opts.gridZone || 'Europe/London';
  const fromMin = opts.fromMin != null ? opts.fromMin : 7 * 60;
  const toMin = opts.toMin != null ? opts.toMin : 22 * 60;
  const start = Date.parse(`${fromYmd}T00:00:00Z`);
  const end = Date.parse(`${toYmd}T23:55:00Z`);
  const out = [];
  for (let t = start; t <= end; t += M5) {
    const f = tz.zonedFields(t, gridZone);
    if (f.dow === 0 || f.dow === 6) continue;
    if (f.minutes < fromMin || f.minutes >= toMin) continue;
    out.push({ t, ymd: f.ymd, minutes: f.minutes });
  }
  return out;
}

// ------------------------------------------------------------------- bars
const MODES = ['flat', 'trend', 'chop', 'mixed'];

/**
 * sigma is per-5M-bar in index points. Calibrated so the 15-minute opening
 * range (three bars) averages ~20 points, which is FTSE-like: the London
 * open typically spans 15-30. Verified by --self-check.
 *
 * EVERY BAR IS BUILT FROM A REAL SUB-PATH, and that is not cosmetic. The
 * first version of this generator drew each bar's high and low as
 * independent noise around a close-only random walk. That quietly broke the
 * negative control: a barrier test reads h and l, so independent wick noise
 * triggers whichever barrier is NEARER more often than the further one,
 * without the close process ever compensating. With a 1R stop and a 1.2R
 * target the stop is always the nearer one, so the harness measured a
 * systematic -0.046R on data that by construction has no edge — and that is
 * the same order as the spread cost it is supposed to detect.
 *
 * Simulating SUBS_PER_MIN sub-steps per minute and taking o/h/l/c from the
 * path the walk actually visited restores the martingale relation between
 * barrier hits and price, so E[R] on a driftless walk is zero up to
 * overshoot. It also yields a genuine 1M series for --resolve-tf m1.
 */
const SUBS_PER_MIN = 12;

function generate(opts = {}) {
  const {
    seed = 42, from = '2025-01-02', to = '2025-12-31',
    mode = 'mixed', start = 10700, sigma = 8.2,
    spreadPts = 15, pointSize = 0.1, gridZone = 'Europe/London',
    emitM1 = false,
    // Price rounding. 1 decimal suits an index at 10,700; an FX pair at 1.16
    // needs 5, and rounding it to 0.1 would flatten every bar to the same
    // value. Default keeps ORB output bit-identical.
    digits = 1
  } = opts;
  const round = x => { const m = Math.pow(10, digits); return Math.round(x * m) / m; };

  const rnd = mulberry32(seed);
  const gauss = gaussFrom(rnd);
  const grid = sessionGrid(from, to, { gridZone });
  const bars = [];
  const m1 = [];
  let px = start;
  let curDay = null, dayMode = 'flat', drift = 0;

  const subsPerBar = 5 * SUBS_PER_MIN;

  for (const g of grid) {
    if (g.ymd !== curDay) {
      curDay = g.ymd;
      dayMode = mode === 'mixed' ? ['flat', 'trend', 'chop'][Math.floor(rnd() * 3)] : dayMode0(mode);
      px += gauss() * sigma * 2;                       // overnight gap
      drift = dayMode === 'trend' ? (rnd() < 0.5 ? -1 : 1) * sigma * 0.22 : 0;
    }
    const sBar = dayMode === 'chop' ? sigma * 0.55 : sigma;
    const sSub = sBar / Math.sqrt(subsPerBar);
    const dSub = drift / subsPerBar;

    const o = px;
    let hi = px, lo = px;
    for (let mi = 0; mi < 5; mi++) {
      const mo = px;
      let mh = px, ml = px;
      for (let k = 0; k < SUBS_PER_MIN; k++) {
        px += gauss() * sSub + dSub;
        if (px > mh) mh = px;
        if (px < ml) ml = px;
      }
      if (mh > hi) hi = mh;
      if (ml < lo) lo = ml;
      if (emitM1) m1.push({ t: g.t + mi * 60000, o: round(mo), h: round(mh), l: round(ml), c: round(px), v: 20, spreadPts });
    }
    bars.push({
      t: g.t, o: round(o), h: round(hi), l: round(lo), c: round(px),
      v: Math.round(50 + rnd() * 200), spreadPts
    });
  }
  return { bars, m1: emitM1 ? m1 : null,
           meta: { seed, from, to, mode, sigma, spreadPts, pointSize, synthetic: true, bars: bars.length } };
}
const dayMode0 = m => (m === 'mixed' ? 'flat' : m);

const round1 = x => Math.round(x * 10) / 10;

/**
 * Hand-authored bars for unit tests. Each spec is
 * [minutesFromSessionOpen, o, h, l, c]; timestamps are laid on the real
 * grid for `ymd` at the window's local open, so DST is exercised even here.
 */
function scripted(ymd, openMin, specs, opts = {}) {
  const zone = opts.zone || 'Europe/London';
  const spreadPts = opts.spreadPts != null ? opts.spreadPts : 0;
  // Find the UTC instant whose local time is ymd @ openMin, by scanning the
  // day's grid — no local->UTC conversion, per the tz.js contract.
  const dayStart = Date.parse(`${ymd}T00:00:00Z`) - 24 * 3600 * 1000;
  let anchor = null;
  for (let t = dayStart; t < dayStart + 72 * 3600 * 1000; t += M5) {
    const f = tz.zonedFields(t, zone);
    if (f.ymd === ymd && f.minutes === openMin) { anchor = t; break; }
  }
  if (anchor == null) throw new Error(`scripted: no 5M slot at ${ymd} ${tz.fmtHHMM(openMin)} ${zone}`);
  return specs.map(([offMin, o, h, l, c, sp]) => ({
    t: anchor + offMin * 60000,
    o, h, l, c, v: 100,
    spreadPts: sp != null ? sp : spreadPts
  }));
}

// -------------------------------------------------------------- self-check
function selfCheck(opts = {}) {
  const { bars } = generate({ ...opts, mode: opts.mode || 'mixed' });
  const tags = tz.tagBars(bars, 'Europe/London');
  const ranges = [];
  const perDay = new Map();
  for (let i = 0; i < bars.length; i++) {
    const d = tags[i].ymd;
    if (!perDay.has(d)) perDay.set(d, []);
    perDay.get(d).push({ b: bars[i], m: tags[i].minutes });
  }
  let dstDays = 0;
  for (const [ymd, rows] of perDay) {
    const box = rows.filter(r => r.m >= 480 && r.m < 495);
    if (box.length === 3) ranges.push(Math.max(...box.map(r => r.b.h)) - Math.min(...box.map(r => r.b.l)));
    if (ymd === '2025-03-31' || ymd === '2025-10-27') dstDays++;
  }
  ranges.sort((a, b) => a - b);
  const mean = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return {
    bars: bars.length, days: perDay.size, boxDays: ranges.length,
    meanBoxPts: +mean.toFixed(2),
    medianBoxPts: +ranges[Math.floor(ranges.length / 2)].toFixed(2),
    p10: +ranges[Math.floor(ranges.length * 0.1)].toFixed(2),
    p90: +ranges[Math.floor(ranges.length * 0.9)].toFixed(2),
    dstAdjacentDaysPresent: dstDays
  };
}

function toCsv(bars) {
  const out = ['time,o,h,l,c,v,spread'];
  for (const b of bars) {
    const d = new Date(b.t);
    const p2 = n => (n < 10 ? '0' : '') + n;
    out.push(`${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())} ` +
             `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00,${b.o},${b.h},${b.l},${b.c},${b.v},${b.spreadPts}`);
  }
  return out.join('\n') + '\n';
}

// -------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let val = m[2];
    if (val == null) {
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith('--')) { val = nxt; i++; } else val = true;
    }
    a[key] = val === true ? true : (/^-?\d+(\.\d+)?$/.test(val) ? +val : val);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (a.mode && !MODES.includes(a.mode)) { console.error(`--mode must be one of ${MODES.join('|')}`); process.exit(2); }
  console.log('='.repeat(72));
  console.log(BANNER);
  console.log('='.repeat(72));
  if (a.selfCheck) {
    const r = selfCheck({ seed: a.seed || 42, from: a.from, to: a.to, mode: a.mode, sigma: a.sigma });
    console.log('\nself-check (grid + calibration):');
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log('\n  15M opening range should average ~20 pts to be FTSE-like.');
    console.log('  dstAdjacentDaysPresent should be 2 (the Mondays after both 2025 transitions).');
    return;
  }
  const { bars, meta } = generate({
    seed: a.seed || 42, from: a.from || '2025-01-02', to: a.to || '2025-12-31',
    mode: a.mode || 'mixed', sigma: a.sigma, spreadPts: a.spreadPts
  });
  const out = a.out || 'data/synth-m5.csv';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(bars));
  console.log(`\nwrote ${bars.length} bars -> ${out}`);
  console.log(`  ${JSON.stringify(meta)}`);
  console.log(`  NOTE: these bars are in UTC. Load with --tz-in UTC.`);
}

if (require.main === module) main();
module.exports = { mulberry32, gaussFrom, sessionGrid, generate, scripted, selfCheck, toCsv, parseArgs, BANNER, MODES };
