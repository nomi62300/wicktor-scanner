'use strict';
/* ==========================================================================
   Wicktor — tests for the CWT London Alligator harness.

   Node `assert` only, same shape as tests/indicators.test.js. Run with:
     node tests/cwt.test.js

   The ones that catch classes of bug rather than single cases:
     Suite C  every indicator this strategy reads is proved causal by
              RECOMPUTING it on bars.slice(0, i+1) and demanding the same
              answer at i. The Alligator's displacement, the ATR and the
              pivot S/R all have to survive that.
     Suite G  a driftless random walk must measure zero gross expectancy.
              Any bug that manufactures R — a fill off the wrong bar, a
              level read before it existed — shows up here.
   ========================================================================== */

const assert = require('assert');
global.Indicators = require('../js/indicators.js');
const I = global.Indicators;

const AL = require('../tools/lib/alligator.js');
const CWT = require('../tools/lib/cwt-strategy.js');
const SYNTH = require('../tools/orb-synth.js');
const { sealed } = require('../tools/lib/no-lookahead.js');
const tz = require('../tools/lib/tz.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (err) { console.error(`  ✗  ${name}`); console.error(`     ${err.message}`); failed++; }
}

// ---------------------------------------------------------------- helpers
const OPEN = 8 * 60;
/** Lay a price path on the real London 5M grid, decision bar at +15 min. */
function layout(path, opts = {}) {
  const ymd = opts.ymd || '2025-07-15';
  const startOff = opts.startOff != null ? opts.startOff : -5 * (path.length - 20);
  const specs = path.map((p, k) => {
    const o = k === 0 ? p : path[k - 1];
    const hi = Math.max(o, p) + (opts.wick || 0.0002);
    const lo = Math.min(o, p) - (opts.wick || 0.0002);
    return [startOff + k * 5, +o.toFixed(5), +hi.toFixed(5), +lo.toFixed(5), +p.toFixed(5), opts.spreadPts || 15];
  });
  return SYNTH.scripted(ymd, OPEN, specs, { zone: 'Europe/London', spreadPts: opts.spreadPts || 15 });
}
/** A steadily trending path: `n` bars moving `step` each. */
const ramp = (n, start, step) => Array.from({ length: n }, (_, k) => start + k * step);
const flatPath = (n, start) => Array.from({ length: n }, () => start);

// ===========================================================================
console.log('\nSuite A — Alligator maths matches Pine');
// ===========================================================================
test('SMMA seeds with the SMA of the first `len` values, then recurses', () => {
  const s = AL.smma([1, 2, 3, 4, 5, 6], 3);
  assert.strictEqual(s[0], null);
  assert.strictEqual(s[1], null);
  assert.strictEqual(s[2], 2);                              // SMA(1,2,3)
  assert.ok(Math.abs(s[3] - (2 * 2 + 4) / 3) < 1e-12);      // (prev*(n-1)+x)/n
});
test('displacement shifts FORWARD: out[i] is the value from i-off', () => {
  assert.deepStrictEqual(AL.displace([10, 20, 30, 40, 50], 2), [null, null, 10, 20, 30]);
});
test('the drawn jaw at bar i is the raw SMMA from 8 bars earlier', () => {
  const bars = ramp(60, 1.16, 0.0001).map((p, k) => ({ t: k, o: p, h: p + 0.0001, l: p - 0.0001, c: p }));
  const A = AL.alligator(bars, {});
  assert.ok(Math.abs(A.jaw[40] - A.jawRaw[32]) < 1e-15, 'jaw offset 8');
  assert.ok(Math.abs(A.teeth[40] - A.teethRaw[35]) < 1e-15, 'teeth offset 5');
  assert.ok(Math.abs(A.lips[40] - A.lipsRaw[37]) < 1e-15, 'lips offset 3');
});
test('a steady uptrend is a bull fan; a downtrend a bear fan', () => {
  const up = ramp(80, 1.16, 0.0004).map((p, k) => ({ t: k, o: p, h: p + 0.0001, l: p - 0.0001, c: p }));
  const dn = ramp(80, 1.20, -0.0004).map((p, k) => ({ t: k, o: p, h: p + 0.0001, l: p - 0.0001, c: p }));
  assert.strictEqual(AL.fanState(AL.alligator(up, {}), I.atr(up, 14), 70, {}), 'bull');
  assert.strictEqual(AL.fanState(AL.alligator(dn, {}), I.atr(dn, 14), 70, {}), 'bear');
});
test('a flat market is tangled, and the threshold is the ATR multiple', () => {
  const f = flatPath(80, 1.16).map((p, k) => ({ t: k, o: p, h: p + 0.0002, l: p - 0.0002, c: p }));
  const A = AL.alligator(f, {}), atr = I.atr(f, 14);
  assert.strictEqual(AL.fanState(A, atr, 70, { tangleMult: 0.5 }), 'tangled');
  // With the threshold driven to zero nothing can be "tangled" any more.
  assert.notStrictEqual(AL.fanState(A, atr, 70, { tangleMult: 0 }), 'tangled');
});
test('a separated fan sloping AGAINST its order is not a clean fan', () => {
  const up = ramp(80, 1.16, 0.0004).map((p, k) => ({ t: k, o: p, h: p + 0.0001, l: p - 0.0001, c: p }));
  const A = AL.alligator(up, {}), atr = I.atr(up, 14);
  assert.strictEqual(AL.fanState(A, atr, 70, {}), 'bull');
  // demand a rise over an impossible horizon -> slope test fails -> 'none'
  assert.strictEqual(AL.fanState(A, atr, 70, { slopeLook: 200 }), 'none');
});
test('priorFanDir looks strictly BEFORE bar i', () => {
  const up = ramp(90, 1.16, 0.0004).map((p, k) => ({ t: k, o: p, h: p + 0.0001, l: p - 0.0001, c: p }));
  const A = AL.alligator(up, {}), atr = I.atr(up, 14);
  assert.strictEqual(AL.priorFanDir(A, atr, 80, 24, {}), 1);
  assert.strictEqual(AL.priorFanDir(A, atr, 80, 0, {}), 0, 'zero lookback sees nothing');
});

// ===========================================================================
console.log('\nSuite B — support/resistance pivots are causal');
// ===========================================================================
function pivotBars() {
  const b = [];
  for (let i = 0; i < 40; i++) b.push({ t: i, o: 1.16, h: 1.1601, l: 1.1599, c: 1.16 });
  b[10] = { t: 10, o: 1.16, h: 1.1700, l: 1.1599, c: 1.16 };   // lone pivot high
  b[20] = { t: 20, o: 1.16, h: 1.1601, l: 1.1500, c: 1.16 };   // lone pivot low
  return b;
}
test('a pivot is detected at its own index', () => {
  const P = CWT.causalPivots(pivotBars(), 3, 3);
  assert.strictEqual(P.isPH[10], true);
  assert.strictEqual(P.isPL[20], true);
});
test('THE CAUSALITY RULE: a pivot is invisible until bar p + right + 1', () => {
  const P = CWT.causalPivots(pivotBars(), 3, 3);
  assert.strictEqual(P.res[13], null, 'not yet confirmed at p+right');
  assert.strictEqual(P.res[14], 1.17, 'visible from p+right+1');
  assert.strictEqual(P.sup[23], null);
  assert.strictEqual(P.sup[24], 1.15);
});
test('with the indicator default (15,15) the lag is 16 bars', () => {
  const b = [];
  for (let i = 0; i < 80; i++) b.push({ t: i, o: 1.16, h: 1.1601, l: 1.1599, c: 1.16 });
  b[30] = { t: 30, o: 1.16, h: 1.1700, l: 1.1599, c: 1.16 };
  const P = CWT.causalPivots(b, 15, 15);
  assert.strictEqual(P.res[45], null);
  assert.strictEqual(P.res[46], 1.17);
});
test('a tie is not a pivot (strict comparison, as Pine does)', () => {
  const b = [];
  for (let i = 0; i < 20; i++) b.push({ t: i, o: 1.16, h: 1.17, l: 1.1599, c: 1.16 });
  assert.strictEqual(CWT.causalPivots(b, 3, 3).isPH[10], false);
});

// ===========================================================================
console.log('\nSuite C — every series is causal under recomputation');
// ===========================================================================
test('recomputing the whole context on bars.slice(0,i+1) gives the same state at i', () => {
  const { bars } = SYNTH.generate({ seed: 5, from: '2025-01-02', to: '2025-02-28',
    mode: 'flat', start: 1.16, sigma: 0.00025, digits: 5, gridZone: 'Europe/London' });
  const full = CWT.buildContext(bars, {});
  for (const i of [300, 900, 1500, 2100]) {
    const part = CWT.buildContext(bars.slice(0, i + 1), {});
    assert.ok(Math.abs(full.A.jaw[i] - part.A.jaw[i]) < 1e-12, `jaw at ${i}`);
    assert.ok(Math.abs(full.A.lips[i] - part.A.lips[i]) < 1e-12, `lips at ${i}`);
    assert.ok(Math.abs(full.atr[i] - part.atr[i]) < 1e-12, `atr at ${i}`);
    assert.strictEqual(full.piv.res[i], part.piv.res[i], `resistance at ${i}`);
    assert.strictEqual(full.piv.sup[i], part.piv.sup[i], `support at ${i}`);
  }
});
test('the decision never reads a bar beyond itself (no-lookahead Proxy)', () => {
  const { bars } = SYNTH.generate({ seed: 11, from: '2025-01-02', to: '2025-06-30',
    mode: 'flat', start: 1.16, sigma: 0.00025, digits: 5, gridZone: 'Europe/London' });
  const ctx = CWT.buildContext(bars, {});
  const tags = tz.tagBars(bars, 'Europe/London');
  let checked = 0;
  for (let i = 100; i < bars.length; i++) {
    if (tags[i].minutes !== OPEN + 15) continue;
    CWT.evaluateAt(sealed(bars, i), i, ctx, 'decision');
    CWT.evaluateAt(sealed(bars, i), i, ctx, 'wait', { caseTag: 'x' });
    checked++;
  }
  assert.ok(checked > 100, `expected many decision bars, saw ${checked}`);
});

// ===========================================================================
console.log('\nSuite D — the four cases');
// ===========================================================================
function ctxFor(bars, cfg = {}) { return CWT.buildContext(bars, cfg); }
function decisionIdx(bars) {
  const tags = tz.tagBars(bars, 'Europe/London');
  for (let i = 0; i < bars.length; i++) if (tags[i].minutes === OPEN + 15) return i;
  return -1;
}
test('CASE 1: a clean bear fan sells with the stop ABOVE the jaw', () => {
  const bars = layout(ramp(90, 1.1900, -0.00035));
  const i = decisionIdx(bars), ctx = ctxFor(bars);
  const r = CWT.evaluateAt(bars, i, ctx, 'decision');
  assert.strictEqual(r.caseTag, 'case1-fan');
  assert.strictEqual(r.dir, -1);
  assert.ok(r.stopPx > ctx.A.jaw[i], 'stop sits beyond the jaw');
  assert.ok(Math.abs((r.stopPx - ctx.A.jaw[i]) - 3 * 0.0001) < 1e-9, '3 pip buffer');
});
test('CASE 1 mirrored: a clean bull fan buys with the stop BELOW the jaw', () => {
  const bars = layout(ramp(90, 1.1500, 0.00035));
  const i = decisionIdx(bars), ctx = ctxFor(bars);
  const r = CWT.evaluateAt(bars, i, ctx, 'decision');
  assert.strictEqual(r.dir, 1);
  assert.ok(r.stopPx < ctx.A.jaw[i]);
});
test('CASE 3: tangled with no prior trend arms a wait, it does not trade', () => {
  const bars = layout(flatPath(90, 1.16), { wick: 0.00015 });
  const i = decisionIdx(bars);
  const r = CWT.evaluateAt(bars, i, ctxFor(bars), 'decision');
  assert.ok(r.wait === true, 'must arm the wait window, not enter');
});
test('the buffer scales: 5 pips is 2 pips further out than 3', () => {
  const bars = layout(ramp(90, 1.1900, -0.00035));
  const i = decisionIdx(bars);
  const a = CWT.evaluateAt(bars, i, ctxFor(bars, { slBufferPips: 3 }), 'decision');
  const b = CWT.evaluateAt(bars, i, ctxFor(bars, { slBufferPips: 5 }), 'decision');
  assert.ok(Math.abs((b.stopPx - a.stopPx) - 2 * 0.0001) < 1e-9);
});
test('PIP vs POINT: a 3-pip buffer is 0.0003 in price, not 0.00003', () => {
  const c = { ...CWT.DEFAULT_CFG, slBufferPips: 3, pipSize: 0.0001 };
  assert.ok(Math.abs(CWT.buffer(c) - 0.0003) < 1e-12);
  const wrong = { ...c, pipSize: 0.00001 };
  assert.ok(Math.abs(CWT.buffer(wrong) - 0.0003) > 1e-9, 'a 10x pip error must be visible');
});
test('a stop on the wrong side of price is refused, never inverted', () => {
  const bars = layout(ramp(90, 1.1900, -0.00035));
  const i = decisionIdx(bars), ctx = ctxFor(bars);
  const r = CWT.evaluateAt(bars, i, ctx, 'wait', { caseTag: 'x', stopSource: 'sr' });
  if (r) assert.ok(r.dir > 0 ? r.stopPx < bars[i].c : r.stopPx > bars[i].c);
});

// ===========================================================================
console.log('\nSuite E — day mechanics');
// ===========================================================================
function runYear(cfg = {}, seed = 3, mode = 'flat') {
  const { bars } = SYNTH.generate({ seed, from: '2025-01-02', to: '2025-12-31',
    mode, start: 1.16, sigma: 0.00025, digits: 5, gridZone: 'Europe/London' });
  return { bars, ...CWT.collectTrades(bars, cfg) };
}
test('entries fill at the NEXT bar open, never the signal bar close', () => {
  const r = runYear();
  for (const t of r.trades.slice(0, 40)) {
    assert.strictEqual(t.entryIdx, t.signalIdx + 1);
    assert.strictEqual(t.entryPx, r.bars[t.entryIdx].o);
  }
});
test('--fill close moves the entry onto the signal bar', () => {
  const r = runYear({ fill: 'close' });
  const t = r.trades[0];
  assert.strictEqual(t.entryIdx, t.signalIdx);
  assert.strictEqual(t.entryPx, r.bars[t.signalIdx].c);
});
test('max trades per day is respected', () => {
  for (const cap of [1, 2, 3]) {
    const r = runYear({ maxTrades: cap });
    const perDay = {};
    for (const t of r.trades) perDay[t.ymd] = (perDay[t.ymd] || 0) + 1;
    assert.ok(Math.max(...Object.values(perDay)) <= cap, `cap ${cap}`);
  }
});
test('RULE 4: a second trade in a day only ever follows a STOP', () => {
  const r = runYear();
  const byDay = {};
  for (const t of r.trades) (byDay[t.ymd] = byDay[t.ymd] || []).push(t);
  let checked = 0;
  for (const list of Object.values(byDay)) {
    list.sort((x, y) => x.tradeNo - y.tradeNo);
    for (let k = 1; k < list.length; k++) {
      assert.strictEqual(list[k - 1].reason, 'stop', 'a re-entry must follow a stop');
      assert.strictEqual(list[k].branch, 'case4-reentry');
      checked++;
    }
  }
  assert.ok(checked > 20, `expected re-entries to occur, saw ${checked}`);
});
test('a re-entry starts strictly after the previous trade exited', () => {
  const r = runYear();
  const byDay = {};
  for (const t of r.trades) (byDay[t.ymd] = byDay[t.ymd] || []).push(t);
  for (const list of Object.values(byDay)) {
    list.sort((x, y) => x.tradeNo - y.tradeNo);
    for (let k = 1; k < list.length; k++) {
      assert.ok(list[k].signalIdx > list[k - 1].exitIdx,
        'the next decision must not begin before the previous exit');
    }
  }
});
test('the re-entry wait respects the 15-45 minute window', () => {
  const r = runYear();
  const tags = tz.tagBars(r.bars, 'Europe/London');
  const byDay = {};
  for (const t of r.trades) (byDay[t.ymd] = byDay[t.ymd] || []).push(t);
  let checked = 0;
  for (const list of Object.values(byDay)) {
    list.sort((x, y) => x.tradeNo - y.tradeNo);
    for (let k = 1; k < list.length; k++) {
      const d = tags[list[k].signalIdx].minutes - tags[list[k - 1].exitIdx].minutes;
      assert.ok(d >= 15 && d <= 45, `gap ${d} min outside 15-45`);
      checked++;
    }
  }
  assert.ok(checked > 20);
});
test('no trade is opened after the flatten time', () => {
  const r = runYear();
  const tags = tz.tagBars(r.bars, 'Europe/London');
  for (const t of r.trades) assert.ok(tags[t.entryIdx].minutes < CWT.DEFAULT_CFG.flatMin);
});
test('only Monday-Friday sessions trade', () => {
  const r = runYear();
  const tags = tz.tagBars(r.bars, 'Europe/London');
  for (const t of r.trades) {
    const d = tags[t.entryIdx].dow;
    assert.ok(d >= 1 && d <= 5, `weekend trade on dow ${d}`);
  }
});
test('risk is always positive and the target is 1:1 by default', () => {
  const r = runYear();
  for (const t of r.trades) {
    assert.ok(t.riskPts > 0);
    assert.strictEqual(t.targetR, 1);
    assert.ok(Math.abs(Math.abs(t.entryPx - t.stopPx) - t.riskPts) < 1e-12);
  }
});

// ===========================================================================
console.log('\nSuite F — exits use the repo convention');
// ===========================================================================
const RES = require('../tools/lib/orb-resolve.js');
test('a bar touching both stop and target books a STOP', () => {
  const ep = RES.exitPath([{ o: 1.16, h: 1.1615, l: 1.1585, c: 1.1590 }], 1, 1.16, 0.0010, 1.0);
  assert.strictEqual(ep.reason, 'stop');
  assert.strictEqual(ep.r, -1);
});
test('a 1:1 target resolves at exactly +1R', () => {
  const ep = RES.exitPath([{ o: 1.16, h: 1.1612, l: 1.1598, c: 1.1611 }], 1, 1.16, 0.0010, 1.0);
  assert.strictEqual(ep.reason, 'target');
  assert.strictEqual(ep.r, 1);
});
test('an unresolved trade is marked to market at the session end', () => {
  const ep = RES.exitPath([{ o: 1.16, h: 1.1605, l: 1.1596, c: 1.1604 }], 1, 1.16, 0.0010, 1.0);
  assert.strictEqual(ep.reason, 'timeout');
  assert.ok(Math.abs(ep.r - 0.4) < 1e-9);
});
test('break-even at 1:1 is (1+cost)/2 and is always above 50%', () => {
  assert.ok(Math.abs(RES.breakEvenWinRate(1.0, 0) - 0.5) < 1e-12);
  assert.ok(Math.abs(RES.breakEvenWinRate(1.0, 0.10) - 0.55) < 1e-12);
  assert.ok(RES.breakEvenWinRate(1.0, 0.0001) > 0.5);
});

// ===========================================================================
console.log('\nSuite G — controls');
// ===========================================================================
function control(seed, mode) {
  const { trades } = runYear({}, seed, mode);
  const m = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: trades.length, gross: m(trades.map(t => t.grossR)),
           win: trades.filter(t => t.grossR > 0).length / trades.length };
}
test('NEGATIVE CONTROL: a driftless walk yields zero gross expectancy over 6 seeds', () => {
  const gs = [1, 7, 42, 99, 123, 777].map(s => control(s, 'flat').gross);
  const m = gs.reduce((a, b) => a + b, 0) / gs.length;
  const sd = Math.sqrt(gs.reduce((a, b) => a + (b - m) ** 2, 0) / (gs.length - 1));
  const se = sd / Math.sqrt(gs.length);
  assert.ok(Math.abs(m / se) < 2.5,
    `gross ${m.toFixed(4)}R is ${(m / se).toFixed(1)} SE from zero on data with no edge`);
});
test('NEGATIVE CONTROL: at 1:1 with symmetric barriers the win rate sits near 50%', () => {
  const r = control(42, 'flat');
  assert.ok(Math.abs(r.win - 0.5) < 0.06, `win ${(r.win * 100).toFixed(1)}%`);
});
test('POSITIVE CONTROL: with drift injected the machine finds the edge', () => {
  const r = control(42, 'trend');
  assert.ok(r.gross > 0.15, `got ${r.gross.toFixed(4)}R`);
});

console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
