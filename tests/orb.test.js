'use strict';
/* ==========================================================================
   Wicktor — tests for the opening-range breakout harness.

   Node `assert` only, same shape as tests/indicators.test.js. Run with:
     node tests/orb.test.js

   The two that matter most, because they catch whole CLASSES of bug rather
   than single cases:
     Suite G  a Proxy that throws if the state machine reads any bar beyond
              the decision bar, run over a synthetic year.
     Suite H  a driftless random walk must measure at -costR. Any harness
              bug that manufactures edge — an off-by-one in the exit walk, a
              leaked future pivot, a retest reading the next bar — shows up
              here as a positive expectancy on data that has none.
   ========================================================================== */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const tz = require('../tools/lib/tz.js');
const CSV = require('../tools/lib/csv-bars.js');
const STRAT = require('../tools/lib/orb-strategy.js');
const RES = require('../tools/lib/orb-resolve.js');
const EQ = require('../tools/lib/equity.js');
const SYNTH = require('../tools/orb-synth.js');
const { sealed } = require('../tools/lib/no-lookahead.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (err) { console.error(`  ✗  ${name}`); console.error(`     ${err.message}`); failed++; }
}

// ---------------------------------------------------------------- helpers
const LDN = { name: 'london', zone: 'Europe/London', openMin: 480, boxMin: 15, flatMin: 16 * 60 + 25 };
const US = { name: 'us', zone: 'America/New_York', openMin: 570, boxMin: 15, flatMin: 15 * 60 + 55 };

function ctxFor(bars, cfg, extra = {}) {
  return {
    tfMin: 5, rsi: I.rsi(bars, 14), frac: I.fractals(bars), atr: I.atr(bars, 14),
    spreadPrice: extra.spreadPrice != null ? extra.spreadPrice : 0,
    minBoxPts: cfg.minBoxPts, ...extra
  };
}
/** Run scripted bars through the machine for one window. */
function run(bars, cfgOv = {}, win = LDN) {
  const cfg = { ...STRAT.DEFAULT_CFG, ...cfgOv };
  const w = { ...win, chopMin: cfg.chopMins, expiryMin: cfg.expiryMins };
  const ctx = ctxFor(bars, cfg);
  const r = STRAT.collectSignals(bars, [w], cfg, ctx);
  return { ...r, cfg, w, ctx };
}
/** A standard box: high 10630, low 10600, 30 pts. */
const BOX = [
  [0,  10610, 10620, 10600, 10615],
  [5,  10615, 10630, 10610, 10620],
  [10, 10620, 10625, 10605, 10618]
];
const mk = (specs, ymd = '2025-07-15', openMin = 480, opts = {}) => SYNTH.scripted(ymd, openMin, specs, opts);
const dispOf = r => r.dispositions[0] ? r.dispositions[0].disposition : null;

// ===========================================================================
console.log('\nSuite A — tz.js: wall clock, DST, and the NY/London gap');
// ===========================================================================
test('Europe/London reports different offsets in January and July', () => {
  const s = tz.assertZoneSupport('Europe/London');
  assert.strictEqual(s.dst, true);
  assert.strictEqual(s.janOffset, 0);
  assert.strictEqual(s.julOffset, 60);
});
test('07:00Z is 08:00 London in July (BST) and 07:00 in January (GMT)', () => {
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-07-15T07:00:00Z'), 'Europe/London').minutes), '08:00');
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-01-15T07:00:00Z'), 'Europe/London').minutes), '07:00');
});
test('exact DST transition instants resolve correctly', () => {
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-03-30T00:30:00Z'), 'Europe/London').minutes), '00:30');
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-03-30T01:30:00Z'), 'Europe/London').minutes), '02:30');
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-10-26T00:30:00Z'), 'Europe/London').minutes), '01:30');
});
test('THE BUG THIS PREVENTS: on 2025-03-20, 09:30 New York is 13:30 London, not 14:30', () => {
  const t = Date.parse('2025-03-20T13:30:00Z');
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(t, 'America/New_York').minutes), '09:30');
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(t, 'Europe/London').minutes), '13:30');
});
test('fixed offset zones work and report no DST', () => {
  assert.strictEqual(tz.fmtHHMM(tz.zonedFields(Date.parse('2025-07-15T05:00:00Z'), 'UTC+3').minutes), '08:00');
  assert.strictEqual(tz.assertZoneSupport('UTC+3').dst, false);
});
test('an unknown zone name is rejected, not silently treated as UTC', () => {
  assert.throws(() => tz.resolveZone('Nowhere'), /neither an IANA zone name/);
});
test('parseWindows honours a per-window zone', () => {
  const w = tz.parseWindows('us=09:30@America/New_York');
  assert.strictEqual(w[0].openMin, 570);
  assert.strictEqual(w[0].zone, 'America/New_York');
});

// ===========================================================================
console.log('\nSuite B — csv-bars.js: formats, refusals, validation');
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-'));
const wtmp = (name, body) => { const p = path.join(TMP, name); fs.writeFileSync(p, body); return p; };

test('MT5 dotted format parses, with server zone applied', () => {
  const f = wtmp('a.csv', 'time,o,h,l,c,v,spread\n2025.07.15 09:00:00,1,2,0.5,1.5,10,15\n2025.07.15 09:05:00,1.5,2,1,1.8,10,15\n');
  const r = CSV.loadBars(f, { tzIn: 'Europe/Helsinki' });
  assert.strictEqual(r.bars.length, 2);
  assert.strictEqual(new Date(r.bars[0].t).toISOString(), '2025-07-15T06:00:00.000Z');
  assert.strictEqual(r.bars[0].spreadPts, 15);
});
test('generic ISO-with-Z and epoch seconds/millis all parse as absolute', () => {
  assert.strictEqual(CSV.parseTimestamp('2025-07-15T07:00:00Z', null).ms, Date.parse('2025-07-15T07:00:00Z'));
  assert.strictEqual(CSV.parseTimestamp('1752562800', null).ms, 1752562800000);
  assert.strictEqual(CSV.parseTimestamp('1752562800000', null).ms, 1752562800000);
});
test('REFUSAL: a naive timestamp with no --tz-in throws rather than assuming UTC', () => {
  const f = wtmp('b.csv', 'timestamp,open,high,low,close,volume\n2025-07-15 07:00:00,1,2,0.5,1.5,10\n');
  assert.throws(() => CSV.loadBars(f), /carries no timezone/);
});
test('duplicate timestamps are a fatal error', () => {
  const b = [{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5 }, { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5 }];
  const v = CSV.validateBars(b, { tfMs: 1000 });
  assert.ok(v.fatal);
  assert.ok(v.errors.some(e => e.kind === 'duplicate_timestamps'));
});
test('high below low is a fatal error', () => {
  const v = CSV.validateBars([{ t: 0, o: 1, h: 0.5, l: 2, c: 1.5 }], { tfMs: 1000 });
  assert.ok(v.errors.some(e => e.kind === 'ohlc_integrity'));
});
test('an intraday gap is flagged separately from an overnight gap', () => {
  const tf = 300000;
  const intra = CSV.validateBars([{ t: 0, o: 1, h: 2, l: 0.5, c: 1 }, { t: tf * 3, o: 1, h: 2, l: 0.5, c: 1 }], { tfMs: tf });
  assert.ok(intra.warnings.some(w => w.kind === 'intraday_gaps'));
  const night = CSV.validateBars([{ t: 0, o: 1, h: 2, l: 0.5, c: 1 }, { t: tf * 200, o: 1, h: 2, l: 0.5, c: 1 }], { tfMs: tf });
  assert.ok(night.warnings.some(w => w.kind === 'session_gaps'));
});
test('the first-bar histogram exposes a mis-declared source zone', () => {
  const bars = mk([[0, 1, 2, 0.5, 1.5], [5, 1, 2, 0.5, 1.5]]);
  assert.strictEqual(CSV.firstBarHistogram(bars, 'Europe/London').modal, '08:00');
  assert.notStrictEqual(CSV.firstBarHistogram(bars, 'America/New_York').modal, '08:00');
});
test('point size is never inferred — it must be supplied', () => {
  assert.throws(() => CSV.resolveSpecs({ symbol: 'UK100.s' }), /point size unknown/);
  assert.strictEqual(CSV.resolveSpecs({ symbol: 'x', pointSize: 0.1 }).pointSize, 0.1);
});
test('M15 box high/low equals the aggregate of its three M5 bars', () => {
  const m5 = mk(BOX);
  const m15 = [{ t: m5[0].t, o: 10610, h: 10630, l: 10600, c: 10618 }];
  const x = CSV.crossCheckBox(m5, m15);
  assert.strictEqual(x.checked, 1);
  assert.strictEqual(x.mismatchCount, 0);
  const bad = [{ t: m5[0].t, o: 10610, h: 10999, l: 10600, c: 10618 }];
  assert.strictEqual(CSV.crossCheckBox(m5, bad).mismatchCount, 1);
});

// ===========================================================================
console.log('\nSuite C — the box, Option A and Option B');
// ===========================================================================
test('the box is exactly the three bars inside the 15M window', () => {
  const bars = mk([...BOX, [15, 10618, 10622, 10612, 10620]]);
  const r = run(bars);
  assert.strictEqual(r.dispositions[0].boxPts, 30);
});
test('a bar at openMin+15 is NOT part of the box', () => {
  const bars = mk([...BOX, [15, 10618, 10900, 10100, 10620]]);
  const r = run(bars);
  assert.strictEqual(r.dispositions[0].boxPts, 30, 'the 4th bar must not widen the box');
});
test('a box missing a bar is skipped, not silently narrowed', () => {
  const bars = mk([BOX[0], BOX[2], [15, 10618, 10622, 10612, 10620]]);
  assert.strictEqual(dispOf(run(bars)), STRAT.SKIP.INCOMPLETE_BOX);
});
test('Option A: box below the floor skips the session', () => {
  assert.strictEqual(dispOf(run(mk([...BOX, [15, 10618, 10622, 10612, 10620]]), { minBoxPts: 31 })),
                     STRAT.SKIP.BOX_TOO_SMALL);
});
test('Option A boundary: a box exactly at the floor is ACCEPTED', () => {
  const r = run(mk([...BOX, [15, 10618, 10622, 10612, 10620]]), { minBoxPts: 30 });
  assert.notStrictEqual(dispOf(r), STRAT.SKIP.BOX_TOO_SMALL);
});
test('Option B: no clean break by chopMins abandons the session', () => {
  const inside = [];
  for (let m = 15; m <= 90; m += 5) inside.push([m, 10615, 10625, 10605, 10615]);
  assert.strictEqual(dispOf(run(mk([...BOX, ...inside]), { chopMins: 60 })), STRAT.SKIP.CHOP_TIMEOUT);
});
test('Option B does not fire one bar early', () => {
  const inside = [];
  for (let m = 15; m < 70; m += 5) inside.push([m, 10615, 10625, 10605, 10615]);
  inside.push([70, 10615, 10640, 10605, 10635]);          // breaks out at T+55
  assert.notStrictEqual(dispOf(run(mk([...BOX, ...inside]), { chopMins: 60 })), STRAT.SKIP.CHOP_TIMEOUT);
});

// ===========================================================================
console.log('\nSuite D — breakout and retest');
// ===========================================================================
const upBreak = [15, 10618, 10640, 10617, 10635];
test('a HIGH piercing the edge with a close below is NOT a breakout', () => {
  const bars = mk([...BOX, [15, 10618, 10645, 10617, 10625], [20, 10625, 10628, 10620, 10622]]);
  assert.strictEqual(run(bars).signals.length, 0);
});
test('a close exactly ON the edge is NOT a breakout ("cleanly out")', () => {
  const bars = mk([...BOX, [15, 10618, 10640, 10617, 10630], [20, 10630, 10632, 10628, 10630]]);
  assert.strictEqual(run(bars).signals.length, 0);
});
test('retest: a bar that touches the edge AND closes outside gives an entry', () => {
  const bars = mk([...BOX, upBreak,
    [20, 10635, 10640, 10628, 10634],                     // touches 10630, closes above
    [25, 10634, 10640, 10630, 10638]]);
  const r = run(bars);
  assert.strictEqual(r.signals.length, 1);
  assert.strictEqual(r.signals[0].dir, 1);
  assert.strictEqual(r.signals[0].retestIdx, 4);
});
test('a bar that touches the edge but closes back INSIDE gives no entry', () => {
  const bars = mk([...BOX, upBreak,
    [20, 10635, 10640, 10628, 10629],
    [25, 10629, 10631, 10625, 10628]]);
  assert.strictEqual(run(bars).signals.length, 0);
});
test('the breakout bar can never be its own retest', () => {
  // The breakout bar's own low dips to the edge and it closes outside.
  const bars = mk([...BOX, [15, 10618, 10640, 10629, 10635]]);
  const r = run(bars);
  assert.strictEqual(r.signals.length, 0, 'bar i must not satisfy a retest it created');
});
test('reclaimRequired: after a close back inside, a stale retest shape does not fire', () => {
  const bars = mk([...BOX, upBreak,
    [20, 10635, 10636, 10620, 10625],                     // closed back inside -> re-ARMED
    [25, 10625, 10634, 10628, 10633]]);                   // touch+close outside, but no fresh break
  assert.strictEqual(run(bars, { reclaimRequired: true }).signals.length, 0);
});
test('a close through the far edge kills the session', () => {
  const bars = mk([...BOX, upBreak, [20, 10635, 10636, 10590, 10595]]);
  assert.strictEqual(dispOf(run(bars)), STRAT.SKIP.TRAVERSED);
});
test('entry before box expiry is valid; after it is not', () => {
  const ok = mk([...BOX, [85, 10618, 10640, 10617, 10635], [90, 10635, 10640, 10628, 10634], [95, 10634, 10640, 10630, 10638]]);
  assert.strictEqual(run(ok, { chopMins: 200, expiryMins: 90 }).signals.length, 1);
  const late = mk([...BOX, [100, 10618, 10640, 10617, 10635], [105, 10635, 10640, 10628, 10634]]);
  assert.strictEqual(run(late, { chopMins: 200, expiryMins: 90 }).signals.length, 0);
});
test('one trade per session: a second setup after the first is ignored', () => {
  const bars = mk([...BOX, upBreak,
    [20, 10635, 10640, 10628, 10634], [25, 10634, 10640, 10630, 10638],
    [30, 10638, 10642, 10600, 10605], [35, 10605, 10645, 10604, 10640],
    [40, 10640, 10645, 10629, 10639]]);
  assert.strictEqual(run(bars).signals.length, 1);
});

// ===========================================================================
console.log('\nSuite E — fills, stop geometry and the exit off-by-one');
// ===========================================================================
const entryBars = mk([...BOX, upBreak, [20, 10635, 10640, 10628, 10634], [25, 10634, 10640, 10630, 10638]]);
test('default fill is the NEXT bar open, not the signal bar close', () => {
  const s = run(entryBars).signals[0];
  assert.strictEqual(s.entryIdx, 5);
  assert.strictEqual(s.entryPx, 10634);
  assert.strictEqual(s.entryIdeal, 10634);
});
test('--fill=close fills on the signal bar itself', () => {
  const s = run(entryBars, { fill: 'close' }).signals[0];
  assert.strictEqual(s.entryIdx, 4);
  assert.strictEqual(s.entryPx, 10634);
});
test('--fill=edge fills at the broken edge', () => {
  const s = run(entryBars, { fill: 'edge' }).signals[0];
  assert.strictEqual(s.entryPx, 10630);
});
test('the stop sits BEYOND the opposite edge by the buffer, so risk > box height', () => {
  const s = run(entryBars, { slBufferPts: 2 }).signals[0];
  assert.strictEqual(s.stopPx, 10598);                        // boxLow 10600 - 2
  assert.strictEqual(s.riskPts, 10634 - 10598);               // 36 > box 30
  assert.ok(s.riskPts > s.boxPts);
});
test('a wider buffer widens risk one-for-one', () => {
  assert.strictEqual(run(entryBars, { slBufferPts: 5 }).signals[0].riskPts,
                     run(entryBars, { slBufferPts: 2 }).signals[0].riskPts + 3);
});
test('short setups mirror exactly', () => {
  const dn = mk([...BOX, [15, 10618, 10619, 10590, 10595], [20, 10595, 10602, 10590, 10596], [25, 10596, 10600, 10590, 10594]]);
  const s = run(dn).signals[0];
  assert.strictEqual(s.dir, -1);
  assert.strictEqual(s.stopPx, 10632);                        // boxHigh 10630 + 2
});
test('THE OFF-BY-ONE: the exit walk INCLUDES the fill bar, so its own low can stop the trade', () => {
  // Fill at bar 5's open (10634); bar 5's own low reaches the stop at 10598.
  const bars = mk([...BOX, upBreak, [20, 10635, 10640, 10628, 10634], [25, 10634, 10640, 10590, 10600]]);
  const r = run(bars);
  const t = RES.resolve(r.signals, bars, r.tags, [r.w], { ...r.cfg, tfMs: 300000 }, { pointSize: 0.1 });
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].reason, 'stop', 'starting the walk at entryIdx+1 would have missed this and flattered the result');
  assert.strictEqual(t[0].holdBars, 1);
});
test('exitPath agrees with js/signals.js realisedR (the cross-check resolve() enforces)', () => {
  const walk = [{ o: 100, h: 105, l: 98, c: 104 }, { o: 104, h: 113, l: 103, c: 112 }];
  const ep = RES.exitPath(walk, 1, 100, 10, 1.2);
  const rr = RES.SignalJournal.realisedR(walk, 1, 100, 10, RES.SignalJournal.PLAN_B, 1.2);
  assert.strictEqual(ep.r, rr.r);
  assert.strictEqual(ep.reason, rr.reason);
  assert.strictEqual(ep.exitOffset, 1);
});
test('a bar touching BOTH stop and target books a STOP (the pessimistic convention)', () => {
  const ep = RES.exitPath([{ o: 100, h: 113, l: 89, c: 95 }], 1, 100, 10, 1.2);
  assert.strictEqual(ep.reason, 'stop');
  assert.strictEqual(ep.r, -1);
  assert.strictEqual(RES.countBothTouched([{ o: 100, h: 113, l: 89, c: 95 }], 1, 100, 10, 1.2), true);
});
test('an unresolved trade is marked to market at the last tradeable bar', () => {
  const ep = RES.exitPath([{ o: 100, h: 105, l: 98, c: 104 }], 1, 100, 10, 1.2);
  assert.strictEqual(ep.reason, 'timeout');
  assert.ok(Math.abs(ep.r - 0.4) < 1e-9);
});
test('cost is charged at the FILL bar spread: costR = spreadPts*pointSize/risk', () => {
  const bars = entryBars.map((b, i) => ({ ...b, spreadPts: i === 5 ? 20 : 2 }));
  const r = run(bars);
  const t = RES.resolve(r.signals, bars, r.tags, [r.w], { ...r.cfg, tfMs: 300000 }, { pointSize: 0.1 });
  assert.ok(Math.abs(t[0].costR - (20 * 0.1) / t[0].riskPts) < 1e-5, 'costR is stored rounded to 5dp');
});

// ===========================================================================
console.log('\nSuite F — RSI divergence and the reversal branch');
// ===========================================================================
test('CAUSALITY: pivots filtered to p <= i-2 equal fractals() recomputed on the slice', () => {
  let rnd = 12345;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  for (let trial = 0; trial < 200; trial++) {
    const bars = []; let p = 100;
    for (let k = 0; k < 80; k++) { const o = p; p += (rand() - 0.5) * 4; bars.push({ o, h: Math.max(o, p) + rand(), l: Math.min(o, p) - rand(), c: p, t: k }); }
    const full = I.fractals(bars);
    const i = 40 + Math.floor(rand() * 30);
    const slice = I.fractals(bars.slice(0, i + 1));
    assert.deepStrictEqual(full.up.filter(x => x <= i - 2), slice.up.filter(x => x <= i - 2));
    assert.deepStrictEqual(full.down.filter(x => x <= i - 2), slice.down.filter(x => x <= i - 2));
  }
});
test('RSI is a pure forward recursion: rsi(all)[i] === rsi(slice)[i]', () => {
  const bars = []; let p = 100;
  for (let k = 0; k < 60; k++) { p += Math.sin(k) * 2; bars.push({ o: p, h: p + 1, l: p - 1, c: p, t: k }); }
  const full = I.rsi(bars, 14);
  for (const i of [20, 35, 50]) {
    const s = I.rsi(bars.slice(0, i + 1), 14);
    assert.ok(Math.abs(full[i] - s[i]) < 1e-9);
  }
});
test('the tolerant rule catches a DOUBLE TOP that indicators.divergence() calls none', () => {
  const bars = [], rsi = [];
  for (let k = 0; k < 30; k++) { bars.push({ o: 100, h: 100, l: 99, c: 100, t: k }); rsi.push(50); }
  // two equal pivot highs, RSI lower on the second
  const setPivot = (i, h, r) => { bars[i] = { o: h - 1, h, l: h - 2, c: h - 1, t: i }; rsi[i] = r; };
  setPivot(10, 120, 80); setPivot(18, 120, 65);
  const frac = { up: [10, 18], down: [] };
  const strict = I.divergence(bars, rsi, frac, 60);
  const tol = STRAT.tolerantDivergence(bars, rsi, frac, 24, { lookback: 30, tolAbs: 1 });
  assert.strictEqual(strict, 'none', 'the shared indicator requires a strictly higher high');
  assert.strictEqual(tol.dir, 'bear');
  assert.strictEqual(tol.strict, false);
  assert.strictEqual(tol.pivotPx, 120);
});
test('a strictly higher high with lower RSI is still bearish, and marked strict', () => {
  const bars = [], rsi = [];
  for (let k = 0; k < 30; k++) { bars.push({ o: 100, h: 100, l: 99, c: 100, t: k }); rsi.push(50); }
  bars[10] = { o: 119, h: 120, l: 118, c: 119, t: 10 }; rsi[10] = 80;
  bars[18] = { o: 124, h: 125, l: 123, c: 124, t: 18 }; rsi[18] = 65;
  const d = STRAT.tolerantDivergence(bars, rsi, { up: [10, 18], down: [] }, 24, { lookback: 30, tolAbs: 1 });
  assert.strictEqual(d.dir, 'bear');
  assert.strictEqual(d.strict, true);
});
test('pivots beyond i-2 are invisible (no reading the trade’s own future)', () => {
  const bars = [], rsi = [];
  for (let k = 0; k < 30; k++) { bars.push({ o: 100, h: 100, l: 99, c: 100, t: k }); rsi.push(50); }
  bars[10] = { o: 119, h: 120, l: 118, c: 119, t: 10 }; rsi[10] = 80;
  bars[18] = { o: 124, h: 125, l: 123, c: 124, t: 18 }; rsi[18] = 65;
  const d = STRAT.tolerantDivergence(bars, rsi, { up: [10, 18], down: [] }, 19, { lookback: 30, tolAbs: 1 });
  assert.strictEqual(d.dir, 'none', 'pivot at 18 is not knowable at bar 19');
});
test('--divergence=filter vetoes the session instead of trading it', () => {
  const r = runDivergent({ divergence: 'filter' });
  assert.strictEqual(r.signals.length, 0);
  assert.strictEqual(dispOf(r), 'divergence_veto');
});
test('--divergence=reverse cancels the long and arms the short side', () => {
  const r = runDivergent({ divergence: 'reverse' });
  assert.ok(r.signals.length === 1, 'expected one reversal entry');
  const s = r.signals[0];
  assert.strictEqual(s.branch, 'reversal');
  assert.strictEqual(s.dir, -1, 'the standard long is cancelled and the short taken');
});
test('the reversal needs a close beyond the OPPOSITE edge, not merely back inside the box', () => {
  const r = runDivergent({ divergence: 'reverse' }, /* stopShortOfFarEdge */ true);
  assert.strictEqual(r.signals.length, 0);
});
test('the reversal enters at the THIRD candle’s open, with the stop at the divergence pivot', () => {
  const r = runDivergent({ divergence: 'reverse', slBufferPts: 2 });
  const s = r.signals[0];
  const bars = r._bars;
  assert.strictEqual(s.entryPx, bars[s.confirmIdx + 1].o, 'entry is the open of the bar after the two confirming candles');
  assert.ok(s.stopPx > s.entryPx, 'a short stops above entry');
});

/** A session that breaks up, diverges bearishly, then reverses through the low. */
function runDivergent(cfgOv, stopShort = false) {
  // 30 bars of warmup BEFORE the session open: rsi(14) returns null for the
  // first 14 bars, so a fixture that starts at the box would have no RSI at
  // all and the branch would silently never fire.
  const warm = [];
  for (let k = 30; k >= 1; k--) { const p = 10600 + (k % 2 ? 3 : 0); warm.push([-5 * k, p, p + 2, p - 2, p]); }
  const specs = [...warm, ...BOX];
  // Push up, make two equal highs with weakening momentum, then collapse.
  specs.push([15, 10618, 10660, 10617, 10655]);
  specs.push([20, 10655, 10672, 10650, 10668]);
  specs.push([25, 10668, 10670, 10640, 10645]);
  specs.push([30, 10645, 10650, 10635, 10640]);
  specs.push([35, 10640, 10672, 10638, 10666]);
  specs.push([40, 10666, 10668, 10650, 10652]);
  specs.push([45, 10652, 10655, 10630, 10634]);
  specs.push([50, 10634, 10636, 10610, 10612]);
  if (stopShort) {
    specs.push([55, 10612, 10614, 10602, 10604]);   // stays inside the box
    specs.push([60, 10604, 10606, 10601, 10603]);
  } else {
    specs.push([55, 10612, 10614, 10592, 10594]);   // closes below boxLow, bearish
    specs.push([60, 10594, 10596, 10580, 10582]);   // second bearish close beyond the edge
    specs.push([65, 10582, 10584, 10570, 10572]);   // the third candle: entry at its open
  }
  const bars = mk(specs);
  const cfg = { ...STRAT.DEFAULT_CFG, chopMins: 200, divLookback: 30, divTolerance: 1.5, ...cfgOv };
  const w = { ...LDN, chopMin: cfg.chopMins, expiryMin: cfg.expiryMins };
  const ctx = ctxFor(bars, cfg, { spreadPrice: 0.5 });
  const out = STRAT.collectSignals(bars, [w], cfg, ctx);
  return { ...out, cfg, w, ctx, _bars: bars };
}

// ===========================================================================
console.log('\nSuite F2 — broker symbol decorations resolve to the right session');
// ===========================================================================
const CROSSVAL = require('../tools/orb-crossval.js');
test('UK100m (Exness), UK100.s, GER40# etc all map to the correct cash open', () => {
  const OPENS = CROSSVAL.OPENS;
  const keys = Object.keys(OPENS).sort((a, b) => b.length - a.length);
  const base = sym => { const u = String(sym).toUpperCase();
                        return keys.find(k => u.startsWith(k)) || u.replace(/[.\-_#+].*$/, ''); };
  // The bug this pins: stripping only a dotted suffix turns UK100m into
  // UK100M, which matches nothing, so an Exness export would be skipped.
  assert.strictEqual(base('UK100m'), 'UK100');
  assert.strictEqual(base('UK100.s'), 'UK100');
  assert.strictEqual(base('GER40#'), 'GER40');
  assert.strictEqual(base('USTECm'), 'USTEC');
  assert.strictEqual(base('US500m'), 'US500');
  assert.strictEqual(OPENS[base('UK100m')].openMin, 8 * 60);
  assert.strictEqual(OPENS[base('UK100m')].zone, 'Europe/London');
  assert.strictEqual(OPENS[base('USTECm')].zone, 'America/New_York');
  assert.strictEqual(OPENS[base('GER40#')].zone, 'Europe/Berlin');
});
test('longest-key matching stops a short key swallowing a longer one', () => {
  const keys = Object.keys(CROSSVAL.OPENS).sort((a, b) => b.length - a.length);
  const base = sym => keys.find(k => String(sym).toUpperCase().startsWith(k));
  assert.strictEqual(base('US2000.s'), 'US2000', 'must not resolve as US200/US30');
});

// ===========================================================================
console.log('\nSuite G — the lookahead tripwire (mechanical, not a promise)');
// ===========================================================================
test('the state machine never reads a bar beyond the decision bar, over a full year', () => {
  const { bars } = SYNTH.generate({ seed: 7, from: '2025-01-02', to: '2025-12-31', mode: 'flat' });
  const cfg = { ...STRAT.DEFAULT_CFG, divergence: 'reverse' };
  const windows = [{ ...LDN, chopMin: cfg.chopMins, expiryMin: cfg.expiryMins }];
  const ctx = ctxFor(bars, cfg);
  const tags = tz.tagBars(bars, LDN.zone);
  let st = null, checked = 0;
  for (let i = 0; i < bars.length; i++) {
    const key = `london|${tags[i].ymd}`;
    if (!st || st.key !== key) st = STRAT.newSession(key, windows[0], tags[i], i);
    // Any read of bars[k] for k > i throws.
    STRAT.step(st, sealed(bars, i), i, tags[i], windows[0], cfg, ctx);
    checked++;
  }
  assert.ok(checked > 40000, 'expected a full year of bars');
});
test('the tripwire itself actually fires', () => {
  const b = [{ c: 1 }, { c: 2 }, { c: 3 }];
  assert.throws(() => sealed(b, 1)[2], /LOOKAHEAD/);
  assert.strictEqual(sealed(b, 1).length, 2);
});

// ===========================================================================
console.log('\nSuite H — equity, drawdown and the bootstrap');
// ===========================================================================
test('0.5% of $5,000 over a 15pt stop at $1/pt is 1.6 lots', () => {
  const s = EQ.sizeTrade({ equity: 5000, riskPct: 0.005, riskPoints: 15, pointValue: 1, minLot: 0.1, lotStep: 0.1 });
  assert.strictEqual(s.lots, 1.6);
  assert.ok(Math.abs(s.riskCash - 24) < 1e-9);
});
test('when the target size is below minLot, minlot over-risks and skip refuses', () => {
  const args = { equity: 1000, riskPct: 0.005, riskPoints: 15, pointValue: 1, minLot: 1, lotStep: 1 };
  const m = EQ.sizeTrade({ ...args, mode: 'minlot' });
  assert.strictEqual(m.lots, 1);
  assert.ok(m.unattainable);
  assert.ok(m.realisedRiskPct > 0.005, 'the trade is knowingly over-risked, and says so');
  assert.ok(EQ.sizeTrade({ ...args, mode: 'skip' }).skipped);
});
test('max consecutive losses', () => {
  assert.strictEqual(EQ.maxLossStreak([-1, -1, 1, -1, -1, -1, 1].map(netR => ({ netR }))), 3);
});
test('peak-to-trough drawdown', () => {
  const d = EQ.drawdownStats([{ t: 1, equity: 100 }, { t: 2, equity: 120 }, { t: 3, equity: 90 }, { t: 4, equity: 110 }]);
  assert.ok(Math.abs(d.maxDrawdownPct - 0.25) < 1e-9);
});
test('daily drawdown groups by the ACCOUNTING zone, not UTC', () => {
  // 23:00 and 23:30 UTC are the same NY day (18:00/18:30) but different UTC days.
  const s = [{ t: Date.parse('2025-07-15T23:00:00Z'), equity: 100 },
             { t: Date.parse('2025-07-15T23:30:00Z'), equity: 90 }];
  assert.strictEqual(EQ.dailyDrawdown(s, 'America/New_York').days.length, 1);
  assert.ok(Math.abs(EQ.dailyDrawdown(s, 'America/New_York').worst.ddPct - 0.10) < 1e-9);
});
test('the bootstrap reports a breach PROBABILITY, not just the realised path', () => {
  const recs = Array.from({ length: 120 }, (_, i) => ({ netR: i % 3 === 0 ? 1.2 : -1, ymd: `2025-01-${(i % 28) + 1}` }));
  const b = EQ.bootstrap(recs, { iterations: 500, seed: 1 });
  assert.ok(b.maxDrawdown.pBreach >= 0 && b.maxDrawdown.pBreach <= 1);
  assert.ok(b.maxDrawdown.p95 >= b.maxDrawdown.median);
});

// ===========================================================================
console.log('\nSuite I — controls: the harness must measure zero where there is nothing');
// ===========================================================================
function controlRun(seed, mode) {
  const { bars } = SYNTH.generate({ seed, from: '2025-01-02', to: '2025-12-31', mode });
  const cfg = { ...STRAT.DEFAULT_CFG };
  const windows = tz.parseWindows(null).map(w => ({ ...w, chopMin: cfg.chopMins, expiryMin: cfg.expiryMins }));
  const ctx = ctxFor(bars, cfg, { spreadPrice: 1.5 });
  const { signals, tags } = STRAT.collectSignals(bars, windows, cfg, ctx);
  const trades = RES.resolve(signals, bars, tags, windows, { ...cfg, tfMs: 300000 }, { pointSize: 0.1 });
  const m = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: trades.length, grossR: m(trades.map(t => t.grossR)), netR: m(trades.map(t => t.netR)),
           costR: m(trades.map(t => t.costR)), winRate: trades.filter(t => t.grossR > 0).length / trades.length };
}
test('NEGATIVE CONTROL: a driftless walk yields zero GROSS expectancy across 6 seeds', () => {
  const gs = [1, 7, 42, 99, 123, 777].map(s => controlRun(s, 'flat').grossR);
  const m = gs.reduce((a, b) => a + b, 0) / gs.length;
  const sd = Math.sqrt(gs.reduce((a, b) => a + (b - m) ** 2, 0) / (gs.length - 1));
  const se = sd / Math.sqrt(gs.length);
  assert.ok(Math.abs(m / se) < 2.5,
    `gross expectancy ${m.toFixed(4)}R is ${(m / se).toFixed(1)} SE from zero on data with no edge — the harness is manufacturing or destroying R`);
});
test('NEGATIVE CONTROL: net expectancy lands at roughly -costR', () => {
  const r = controlRun(42, 'flat');
  assert.ok(Math.abs(r.netR + r.costR) < 0.12, `net ${r.netR.toFixed(4)} vs -cost ${(-r.costR).toFixed(4)}`);
});
test('NEGATIVE CONTROL: win rate sits at the 1/(1+R) theoretical, not above it', () => {
  const r = controlRun(42, 'flat');
  assert.ok(Math.abs(r.winRate - 1 / 2.2) < 0.06, `win rate ${(r.winRate * 100).toFixed(1)}% vs theoretical 45.5%`);
});
test('POSITIVE CONTROL: with real drift injected, the machine DOES find the edge', () => {
  const r = controlRun(42, 'trend');
  assert.ok(r.grossR > 0.15, `trend-day drift should be detectable, got ${r.grossR.toFixed(4)}R`);
});

// ===========================================================================
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
