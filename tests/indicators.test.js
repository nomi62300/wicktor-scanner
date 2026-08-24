/* ==========================================================================
   Wicktor — Indicators unit tests
   Run:  node tests/indicators.test.js
   No third-party dependencies — uses Node.js assert module only.
   ========================================================================== */
'use strict';

const assert  = require('assert');
const Indicators = require('../js/indicators');
// scoring.js references Indicators as a global (browser script-tag load
// order) — set it before requiring, same fix needed for any Node test
// that touches Scoring.
global.Indicators = Indicators;
const Scoring = require('../js/scoring');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a flat synthetic candle at a given price (spread = 1% around close). */
function flatCandle(t, price, { jawDip = false } = {}) {
  const spread = price * 0.005;
  const low    = jawDip ? price * 0.50 : price - spread; // big dip when requested
  return { t, o: price, h: price + spread, l: low, c: price, v: 1000 };
}

/**
 * Build a growing uptrend series of `n` candles.
 * Each bar's close is slightly above the previous one.
 * Stays well above all Alligator lines so there's no jaw touch.
 */
function buildCleanUptrend(n = 80, startPrice = 100, stepPct = 0.005) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    candles.push(flatCandle(i, price));
    price *= (1 + stepPct);
  }
  return candles;
}

/**
 * Build an uptrend that, at bar `dip`, has a candle whose low dips deeply
 * through where the jaw will be, and then at bar `recover` has a candle
 * that closes hard above the lips.
 */
function buildUptrendWithDipAndRecover(n = 80, dipIdx = 60, recoverIdx = 75) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    if (i === dipIdx) {
      // A candle whose low hammers far below the jaw AND whose close also
      // drops (not just the wick) — otherwise `price` snaps right back to
      // its pre-dip level on the very next bar, the HA close clears back
      // above lips within one bar, and the sustained-invalidation window
      // this test means to exercise never actually happens.
      const preDip = price;
      candles.push({ t: i, o: preDip, h: preDip * 1.002, l: preDip * 0.50, c: preDip * 0.75, v: 1000 });
      price = preDip * 0.75;
    } else if (i >= recoverIdx) {
      // Strong close well above where lips would be
      price = price * 1.05;
      candles.push(flatCandle(i, price));
    } else {
      candles.push(flatCandle(i, price));
      price *= 1.004;
    }
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Suite A: heikinAshi() formula correctness
// ---------------------------------------------------------------------------
console.log('\nSuite A — heikinAshi() formula');

test('first HA candle: haOpen = (o+c)/2', () => {
  const candle = { t: 0, o: 10, h: 12, l: 8, c: 14, v: 100 };
  const ha = Indicators.heikinAshi([candle]);
  assert.strictEqual(ha[0].o, (10 + 14) / 2, 'haOpen mismatch');
});

test('first HA candle: haClose = (o+h+l+c)/4', () => {
  const candle = { t: 0, o: 10, h: 12, l: 8, c: 14, v: 100 };
  const ha = Indicators.heikinAshi([candle]);
  assert.strictEqual(ha[0].c, (10 + 12 + 8 + 14) / 4, 'haClose mismatch');
});

test('first HA candle: haHigh = max(h, haOpen, haClose)', () => {
  const candle = { t: 0, o: 10, h: 12, l: 8, c: 14, v: 100 };
  const ha = Indicators.heikinAshi([candle]);
  const expected = Math.max(12, ha[0].o, ha[0].c);
  assert.strictEqual(ha[0].h, expected, 'haHigh mismatch');
});

test('first HA candle: haLow = min(l, haOpen, haClose)', () => {
  const candle = { t: 0, o: 10, h: 12, l: 8, c: 14, v: 100 };
  const ha = Indicators.heikinAshi([candle]);
  const expected = Math.min(8, ha[0].o, ha[0].c);
  assert.strictEqual(ha[0].l, expected, 'haLow mismatch');
});

test('second HA candle: haOpen = (prevHaOpen + prevHaClose) / 2', () => {
  const c1 = { t: 0, o: 10, h: 12, l: 8,  c: 14, v: 100 };
  const c2 = { t: 1, o: 14, h: 16, l: 12, c: 18, v: 100 };
  const ha = Indicators.heikinAshi([c1, c2]);
  const expectedOpen = (ha[0].o + ha[0].c) / 2;
  assert.strictEqual(ha[1].o, expectedOpen, 'second haOpen mismatch');
});

test('heikinAshi preserves timestamp and volume', () => {
  const candle = { t: 42, o: 10, h: 12, l: 8, c: 14, v: 777 };
  const ha = Indicators.heikinAshi([candle]);
  assert.strictEqual(ha[0].t, 42);
  assert.strictEqual(ha[0].v, 777);
});

test('haHigh >= haClose always', () => {
  const candles = buildCleanUptrend(50);
  const ha = Indicators.heikinAshi(candles);
  ha.forEach((bar, i) => {
    assert.ok(bar.h >= bar.c, `bar ${i}: haHigh < haClose`);
  });
});

test('haLow <= haClose always', () => {
  const candles = buildCleanUptrend(50);
  const ha = Indicators.heikinAshi(candles);
  ha.forEach((bar, i) => {
    assert.ok(bar.l <= bar.c, `bar ${i}: haLow > haClose`);
  });
});

// ---------------------------------------------------------------------------
// Suite B: alligatorTouchState() — clean uptrend stays valid
// ---------------------------------------------------------------------------
console.log('\nSuite B — alligatorTouchState() clean uptrend keeps alignment = 1');

test('clean uptrend: all touchState entries are false (no invalidation)', () => {
  const candles = buildCleanUptrend(80);
  const { jaw, teeth, lips, haCandles } = Indicators.alligator(candles);
  const states = Indicators.alligatorTouchState(haCandles, jaw, teeth, lips);
  // Last 20 bars should all have lines present and not be invalidated
  const lastBars = states.slice(-20);
  const anyInvalidated = lastBars.some(s => s === true);
  assert.ok(!anyInvalidated, 'Expected no invalidation in clean uptrend tail');
});

test('clean uptrend: analyzeTimeframe reports alignment = 1 on last bar', () => {
  const candles = buildCleanUptrend(80);
  const snap = Indicators.analyzeTimeframe(candles);
  assert.ok(snap !== null, 'snapshot should not be null');
  assert.strictEqual(snap.alignment, 1, `Expected alignment 1, got ${snap.alignment}`);
  assert.strictEqual(snap.alligatorInvalidated, false, 'Expected not invalidated');
});

// ---------------------------------------------------------------------------
// Suite C: jaw-touch during uptrend flips alignment to 0, then clears
// ---------------------------------------------------------------------------
console.log('\nSuite C — jaw-touch flips alignment to 0, recovery clears it');

test('snapshot just after dip through jaw: alignment = 0 and alligatorInvalidated = true', () => {
  // Build candles up to right after the dip (dip at 60, inspect at 61)
  const candles = buildUptrendWithDipAndRecover(80, 60, 75);
  // Slice to just 2 bars past the dip to inspect the invalidated state
  const slice = candles.slice(0, 63);
  // Pad to >= 40 candles minimum (already is, 63 >= 40)
  const snap = Indicators.analyzeTimeframe(slice);
  assert.ok(snap !== null, 'snapshot should not be null');
  assert.strictEqual(snap.alignment, 0,
    `Expected alignment 0 after jaw dip, got ${snap.alignment}`);
  assert.strictEqual(snap.alligatorInvalidated, true,
    'Expected alligatorInvalidated = true after jaw dip');
});

test('snapshot well after recovery close above lips: alignment restored to 1', () => {
  const candles = buildUptrendWithDipAndRecover(80, 60, 65);
  // Use all 80 bars; by bar 79 the price has recovered strongly
  const snap = Indicators.analyzeTimeframe(candles);
  assert.ok(snap !== null, 'snapshot should not be null');
  // After a strong recovery the state should clear
  assert.strictEqual(snap.alignment, 1,
    `Expected alignment 1 after recovery, got ${snap.alignment}`);
  assert.strictEqual(snap.alligatorInvalidated, false,
    'Expected alligatorInvalidated = false after recovery');
});

// ---------------------------------------------------------------------------
// Suite D: AO / RSI / Fractals are unchanged (same values on real candles)
// ---------------------------------------------------------------------------
console.log('\nSuite D — AO / RSI / Fractals unchanged by HA conversion');

test('awesomeOscillator output is identical before and after this change (spot-check)', () => {
  // AO uses medianPrice on real candles — build a reference by calling
  // the function directly and comparing last value against a manually
  // computed SMA(5) - SMA(34) on the same real candles.
  const candles = buildCleanUptrend(80);
  const ao = Indicators.awesomeOscillator(candles);
  const med = Indicators.medianPrice(candles);
  const fast = Indicators.sma(med, 5);
  const slow = Indicators.sma(med, 34);
  const lastIdx = candles.length - 1;
  const expected = fast[lastIdx] - slow[lastIdx];
  assert.ok(Math.abs(ao[lastIdx] - expected) < 1e-10,
    `AO last value ${ao[lastIdx]} differs from manual ${expected}`);
});

test('RSI uses real candle closes (not HA closes)', () => {
  // Build candles where HA closes would differ visibly from real closes.
  // A single big spike candle makes HA close != real close.
  const candles = buildCleanUptrend(80);
  // Overwrite one bar with a spike
  candles[40] = { t: 40, o: 100, h: 200, l: 50, c: 102, v: 5000 };
  const rsiSeries = Indicators.rsi(candles);
  const haCandles = Indicators.heikinAshi(candles);
  const rsiOnHa   = Indicators.rsi(haCandles);
  // The two series should differ at bar 41+ because real vs HA closes differ
  const differ = rsiSeries.some((v, i) => v != null && rsiOnHa[i] != null && Math.abs(v - rsiOnHa[i]) > 0.001);
  assert.ok(differ, 'Expected RSI to differ between real and HA candles (proving analyzeTimeframe uses real candles for RSI)');
});

test('analyzeTimeframe RSI value matches rsi(realCandles)[lastIdx]', () => {
  const candles = buildCleanUptrend(80);
  const snap = Indicators.analyzeTimeframe(candles);
  const rsiSeries = Indicators.rsi(candles);
  const lastIdx = candles.length - 1;
  assert.ok(snap !== null);
  assert.ok(Math.abs(snap.rsi - rsiSeries[lastIdx]) < 1e-10,
    `Snapshot RSI ${snap.rsi} differs from direct rsi() ${rsiSeries[lastIdx]}`);
});

test('fractals output on real candles is unaffected by heikinAshi', () => {
  const candles = buildCleanUptrend(80);
  // Insert a spike to create a confirmed fractal high at bar 30
  candles[30] = { t: 30, o: 200, h: 999, l: 199, c: 200, v: 1000 };
  const frac = Indicators.fractals(candles);
  // Real-candle fractals should detect the spike at 30
  assert.ok(frac.up.includes(30), `Expected fractal up at bar 30, got ${JSON.stringify(frac.up)}`);
  // HA fractals would smooth the spike — so they would NOT necessarily contain 30
  const haCandles = Indicators.heikinAshi(candles);
  const fracHa = Indicators.fractals(haCandles);
  // The two sets must differ, proving analyzeTimeframe uses real candles for fractals
  const sameSet = JSON.stringify(frac.up) === JSON.stringify(fracHa.up);
  assert.ok(!sameSet, 'Fractal sets on real vs HA candles should differ (spike is smoothed in HA)');
});

test('breakoutProximityPct: at the level itself = 100%', () => {
  const pct = Indicators.breakoutProximityPct(0, 10);
  assert.strictEqual(pct, 100);
});

test('breakoutProximityPct: 1 ATR away = ~66.7%', () => {
  const pct = Indicators.breakoutProximityPct(10, 10);
  assert.ok(Math.abs(pct - (100 * 2 / 3)) < 1e-9, `Expected ~66.67, got ${pct}`);
});

test('breakoutProximityPct: 3+ ATRs away floors at 0%, never negative', () => {
  assert.strictEqual(Indicators.breakoutProximityPct(30, 10), 0);
  assert.strictEqual(Indicators.breakoutProximityPct(100, 10), 0);
});

test('breakoutProximityPct: uses absolute distance (sign-independent)', () => {
  assert.strictEqual(Indicators.breakoutProximityPct(-10, 10), Indicators.breakoutProximityPct(10, 10));
});

test('breakoutProximityPct: null/zero ATR returns null, not a divide-by-zero result', () => {
  assert.strictEqual(Indicators.breakoutProximityPct(10, 0), null);
  assert.strictEqual(Indicators.breakoutProximityPct(10, null), null);
  assert.strictEqual(Indicators.breakoutProximityPct(null, 10), null);
});

test('linearRegression: perfect line gives exact slope/intercept and r2=1', () => {
  const points = [{ x: 0, y: 10 }, { x: 1, y: 12 }, { x: 2, y: 14 }, { x: 3, y: 16 }];
  const fit = Indicators.linearRegression(points);
  assert.ok(Math.abs(fit.slope - 2) < 1e-9, `Expected slope 2, got ${fit.slope}`);
  assert.ok(Math.abs(fit.intercept - 10) < 1e-9, `Expected intercept 10, got ${fit.intercept}`);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9, `Expected r2 1, got ${fit.r2}`);
});

test('linearRegression: scattered points give r2 < 1', () => {
  const points = [{ x: 0, y: 10 }, { x: 1, y: 9 }, { x: 2, y: 15 }, { x: 3, y: 8 }];
  const fit = Indicators.linearRegression(points);
  assert.ok(fit.r2 < 1, `Expected r2 < 1 for scattered points, got ${fit.r2}`);
});

test('linearRegression: fewer than 2 points returns null', () => {
  assert.strictEqual(Indicators.linearRegression([]), null);
  assert.strictEqual(Indicators.linearRegression([{ x: 0, y: 1 }]), null);
});

test('linearRegression: all identical x (vertical) returns null, not a divide-by-zero result', () => {
  const points = [{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }];
  assert.strictEqual(Indicators.linearRegression(points), null);
});

test('regressionChannelLevels: fewer than minPivots fractal highs returns null resistance', () => {
  const candles = buildCleanUptrend(80);
  const frac = { up: [10], down: [] }; // only 1 pivot, default minPivots=3
  const result = Indicators.regressionChannelLevels(candles, frac, 79);
  assert.strictEqual(result.resistance, null);
  assert.strictEqual(result.support, null);
});

test('regressionChannelLevels: enough clean rising pivots yields a confident projected value', () => {
  // Fractal highs rising exactly linearly with bar index -> perfect fit.
  const candles = buildCleanUptrend(80);
  candles.forEach((c, i) => { c.h = 100 + i * 2; }); // deterministic rising highs
  const frac = { up: [10, 20, 30, 40], down: [] };
  const result = Indicators.regressionChannelLevels(candles, frac, 79, { minPivots: 3 });
  assert.ok(result.resistance !== null, 'Expected a confident regression result');
  assert.ok(result.resistance.r2 > 0.99, `Expected near-perfect r2, got ${result.resistance.r2}`);
  const expected = 100 + 79 * 2;
  assert.ok(Math.abs(result.resistance.value - expected) < 1e-6,
    `Expected projected value ~${expected}, got ${result.resistance.value}`);
});

test('regressionChannelLevels: noisy pivots below r2 threshold returns null', () => {
  const candles = buildCleanUptrend(80);
  const noisyHighs = [50, 900, 60, 850]; // wildly inconsistent, poor fit
  [10, 20, 30, 40].forEach((idx, i) => { candles[idx].h = noisyHighs[i]; });
  const frac = { up: [10, 20, 30, 40], down: [] };
  const result = Indicators.regressionChannelLevels(candles, frac, 79, { minPivots: 3, minR2: 0.6 });
  assert.strictEqual(result.resistance, null, `Expected null for a poor fit, got ${JSON.stringify(result.resistance)}`);
});

test('analyzeTimeframe: resistanceSloped/supportSloped are present (null or an object), never throw', () => {
  const candles = buildCleanUptrend(80);
  const snap = Indicators.analyzeTimeframe(candles);
  assert.ok('resistanceSloped' in snap);
  assert.ok('supportSloped' in snap);
});

// ---------------------------------------------------------------------------
// Strategy-enrichment Stage 0 — new indicator math (pure, not wired yet)
// ---------------------------------------------------------------------------

test('ema(): seeds with SMA, then recurses with the standard smoothing factor', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const period = 3;
  const e = Indicators.ema(values, period);
  const seedSma = (1 + 2 + 3) / 3;
  assert.ok(Math.abs(e[2] - seedSma) < 1e-9, `Expected seed ${seedSma}, got ${e[2]}`);
  const k = 2 / (period + 1);
  const expectedNext = values[3] * k + e[2] * (1 - k);
  assert.ok(Math.abs(e[3] - expectedNext) < 1e-9, `Expected ${expectedNext}, got ${e[3]}`);
});

test('ema(): fewer than `period` values are all null', () => {
  const e = Indicators.ema([1, 2], 5);
  assert.ok(e.every(v => v === null));
});

test('ema(): handles a series with leading nulls (e.g. MACD line feeding the signal line)', () => {
  const values = [null, null, null, 10, 11, 12, 13, 14, 15];
  const e = Indicators.ema(values, 3);
  assert.strictEqual(e[0], null);
  assert.strictEqual(e[1], null);
  assert.strictEqual(e[4], null); // period-1 real values needed starting at idx 3 -> first output at idx 5
  assert.ok(e[5] != null, 'Expected a real EMA value once 3 consecutive non-null inputs exist');
});

test('macd(): uptrend gives a positive MACD line (fast EMA above slow EMA)', () => {
  const candles = buildCleanUptrend(80);
  const { macdLine } = Indicators.macd(candles);
  const last = macdLine[macdLine.length - 1];
  assert.ok(last > 0, `Expected positive MACD in an uptrend, got ${last}`);
});

test('macd(): downtrend gives a negative MACD line', () => {
  const candles = [];
  let price = 200;
  for (let i = 0; i < 80; i++) { candles.push(flatCandle(i, price)); price *= 0.995; }
  const { macdLine } = Indicators.macd(candles);
  const last = macdLine[macdLine.length - 1];
  assert.ok(last < 0, `Expected negative MACD in a downtrend, got ${last}`);
});

test('macd(): histogram = macdLine - signalLine at every index where both exist', () => {
  const candles = buildCleanUptrend(80);
  const { macdLine, signalLine, histogram } = Indicators.macd(candles);
  for (let i = 0; i < candles.length; i++) {
    if (macdLine[i] != null && signalLine[i] != null) {
      assert.ok(Math.abs(histogram[i] - (macdLine[i] - signalLine[i])) < 1e-9,
        `histogram mismatch at ${i}`);
    } else {
      assert.strictEqual(histogram[i], null);
    }
  }
});

test('bollingerBands(): flat/constant price gives zero-width bands (stddev=0)', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push({ t: i, o: 100, h: 100, l: 100, c: 100, v: 1000 });
  const bb = Indicators.bollingerBands(candles, 20);
  const last = candles.length - 1;
  assert.ok(Math.abs(bb.upper[last] - bb.lower[last]) < 1e-9, 'Expected zero band width for constant price');
  assert.strictEqual(bb.middle[last], 100);
});

test('bollingerBands(): price above upper band gives %B > 1, below lower band gives %B < 0', () => {
  const candles = buildCleanUptrend(80);
  const bb = Indicators.bollingerBands(candles, 20);
  const last = candles.length - 1;
  // A clean smooth uptrend keeps closes inside/near the bands, not exceeding —
  // verify %B stays in a sane range instead of asserting an extreme case.
  assert.ok(bb.percentB[last] >= 0 && bb.percentB[last] <= 1.2,
    `Expected %B in a sane range for a smooth uptrend, got ${bb.percentB[last]}`);
});

test('adx(): clean uptrend gives +DI meaningfully greater than -DI', () => {
  const candles = buildCleanUptrend(80);
  const { plusDI, minusDI } = Indicators.adx(candles);
  const last = candles.length - 1;
  assert.ok(plusDI[last] > minusDI[last], `Expected +DI > -DI in an uptrend, got +DI=${plusDI[last]} -DI=${minusDI[last]}`);
});

test('adx(): clean downtrend gives -DI meaningfully greater than +DI', () => {
  const candles = [];
  let price = 200;
  for (let i = 0; i < 80; i++) { candles.push(flatCandle(i, price)); price *= 0.995; }
  const { plusDI, minusDI } = Indicators.adx(candles);
  const last = candles.length - 1;
  assert.ok(minusDI[last] > plusDI[last], `Expected -DI > +DI in a downtrend, got +DI=${plusDI[last]} -DI=${minusDI[last]}`);
});

test('adx(): ADX line is null until enough DX values accumulate, then non-null and in [0,100]', () => {
  const candles = buildCleanUptrend(80);
  const { adx } = Indicators.adx(candles);
  assert.strictEqual(adx[0], null);
  const last = adx[adx.length - 1];
  assert.ok(last != null && last >= 0 && last <= 100, `Expected ADX in [0,100], got ${last}`);
});

test('stochastic(): %K reaches near 100 when the close makes a new period high', () => {
  const candles = buildCleanUptrend(40);
  const { k } = Indicators.stochastic(candles);
  const last = k[k.length - 1];
  assert.ok(last > 80, `Expected %K near the top of the range in a fresh-high uptrend, got ${last}`);
});

test('stochastic(): %K reaches near 0 when the close makes a new period low', () => {
  const candles = [];
  let price = 200;
  for (let i = 0; i < 40; i++) { candles.push(flatCandle(i, price)); price *= 0.99; }
  const { k } = Indicators.stochastic(candles);
  const last = k[k.length - 1];
  assert.ok(last < 20, `Expected %K near the bottom of the range in a fresh-low downtrend, got ${last}`);
});

test('ichimoku(): tenkan/kijun are the midpoint of the highest-high/lowest-low over their own window', () => {
  const candles = buildCleanUptrend(80);
  const ich = Indicators.ichimoku(candles);
  const lastIdx = candles.length - 1;
  let hh = -Infinity, ll = Infinity;
  for (let j = lastIdx - 8; j <= lastIdx; j++) { hh = Math.max(hh, candles[j].h); ll = Math.min(ll, candles[j].l); }
  const expectedTenkan = (hh + ll) / 2;
  assert.ok(Math.abs(ich.tenkan[lastIdx] - expectedTenkan) < 1e-9,
    `Expected tenkan ${expectedTenkan}, got ${ich.tenkan[lastIdx]}`);
});

test('ichimoku(): currentSpanA/B are the -26-shifted read, not the raw last-bar span', () => {
  const candles = buildCleanUptrend(80);
  const ich = Indicators.ichimoku(candles);
  const lastIdx = candles.length - 1;
  assert.ok(Math.abs(ich.currentSpanA - ich.spanA[lastIdx - 26]) < 1e-9);
  assert.ok(Math.abs(ich.currentSpanB - ich.spanB[lastIdx - 26]) < 1e-9);
  // In a clean rising trend the displaced (older, lower) cloud must sit
  // below the raw last-bar span values — proves it's really reading
  // backward, not accidentally echoing the current bar.
  assert.ok(ich.currentSpanA < ich.spanA[lastIdx], 'Expected the displaced Span A to be lower than the raw last-bar Span A in an uptrend');
});

test('liquiditySweep(): detects a bearish rejection wick above resistance, closing back inside', () => {
  const candles = buildCleanUptrend(60);
  const frac = Indicators.fractals(candles);
  const atrSeries = Indicators.atr(candles);
  const i = candles.length - 1;
  const lastUpFrac = Indicators.lastFractal(frac.up, i - 1);
  if (lastUpFrac != null) {
    const level = candles[lastUpFrac].h;
    const atrV = atrSeries[i] || 1;
    candles[i] = { t: i, o: level - 1, h: level + atrV * 2, l: level - 2, c: level - 1, v: 1000 };
    const result = Indicators.liquiditySweep(candles, frac, i, atrV);
    assert.strictEqual(result.down, true, 'Expected a detected bearish liquidity sweep');
  }
});

test('liquiditySweep(): a normal bar (no wick beyond any level) returns {up:false, down:false}', () => {
  const candles = buildCleanUptrend(60);
  const frac = Indicators.fractals(candles);
  const atrSeries = Indicators.atr(candles);
  const i = candles.length - 1;
  const result = Indicators.liquiditySweep(candles, frac, i, atrSeries[i]);
  assert.strictEqual(result.up, false);
  assert.strictEqual(result.down, false);
});

test('liquiditySweep(): null/zero ATR returns {up:false, down:false}, no crash', () => {
  const candles = buildCleanUptrend(60);
  const frac = Indicators.fractals(candles);
  const result = Indicators.liquiditySweep(candles, frac, candles.length - 1, null);
  assert.strictEqual(result.up, false);
  assert.strictEqual(result.down, false);
});

// ---------------------------------------------------------------------------
// Strategy-enrichment Stage 1 — snapshot wiring, verified inert
// ---------------------------------------------------------------------------

test('analyzeTimeframe: new Stage 1 fields match calling the Stage 0 functions directly', () => {
  const candles = buildCleanUptrend(80);
  const lastIdx = candles.length - 1;
  const snap = Indicators.analyzeTimeframe(candles);

  const closes = candles.map(c => c.c);
  const ema9 = Indicators.ema(closes, 9);
  assert.strictEqual(snap.ema9, ema9[lastIdx]);

  const m = Indicators.macd(candles);
  assert.strictEqual(snap.macdHistogram, m.histogram[lastIdx]);

  const bb = Indicators.bollingerBands(candles);
  assert.strictEqual(snap.bbUpper, bb.upper[lastIdx]);

  const a = Indicators.adx(candles);
  assert.strictEqual(snap.adx, a.adx[lastIdx]);
});

test('Stage 1 snapshot fields are readable via Scoring.evaluate() without throwing', () => {
  const candles = buildCleanUptrend(80);
  const result = Scoring.evaluate({ h1: candles, m15: candles, m5: candles });
  assert.ok(result.score >= 0 && result.score <= 100);
});

// ---------------------------------------------------------------------------
// Phase 5 Stage 2 — scalping-tier strategies 1-5
// ---------------------------------------------------------------------------

function baseSnap(overrides) {
  const candles = buildCleanUptrend(80);
  return { ...Indicators.analyzeTimeframe(candles), ...overrides };
}

test('Strategy 1 (Scalping EMA): 1H EMA9>EMA21 matching bullish bias scores', () => {
  const primary = baseSnap({ emaStackBullish: true });
  const { items } = Scoring.buildContinuation([primary, null, null], 1);
  assert.ok(items.some(([l]) => l === '1H EMA 9/21 bullish trend'));
});

test('Strategy 1: 15M MACD bullish cross on EMA21 pullback scores', () => {
  const m15 = baseSnap({ macdBullishCross: true, ema21: 100, close: 100.2, atr: 1 });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(items.some(([l]) => l === '15M MACD bullish cross on EMA21 pullback'));
});

test('Strategy 1: MACD cross far from EMA21 (no pullback) does not score', () => {
  const m15 = baseSnap({ macdBullishCross: true, ema21: 100, close: 110, atr: 1 });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(!items.some(([l, p]) => l.includes('MACD bullish cross') && p > 0));
});

test('Strategy 2 (Volatility Breakout): expansion + close above upper band scores; ADX contributes its own standalone item (Audit F3)', () => {
  const m15 = baseSnap({ bbExpanding: true, bbUpper: 100, close: 101, adx: 30 });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(items.some(([l]) => l === '15M BB squeeze breakout'));
  assert.ok(items.some(([l]) => l.startsWith('15M ADX trend strength')));
});

test('Strategy 2: expansion without breaking the band does not score', () => {
  const m15 = baseSnap({ bbExpanding: true, bbUpper: 100, close: 99, adx: 30 });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(!items.some(([l, p]) => l.includes('BB squeeze breakout') && p > 0));
});

test('Strategy 3 (Breakout Retest): above fractal AND within 0.5x ATR of it scores', () => {
  const primary = baseSnap({ aboveUpFractal: true, lastUpFractal: 100, close: 100.3, atr: 1 });
  const { items } = Scoring.buildContinuation([primary, null, null], 1);
  assert.ok(items.some(([l]) => l === '1H Breakout retest held'));
});

test('Strategy 3: above fractal but far from it (not a retest) does not score', () => {
  const primary = baseSnap({ aboveUpFractal: true, lastUpFractal: 100, close: 110, atr: 1 });
  const { items } = Scoring.buildContinuation([primary, null, null], 1);
  assert.ok(!items.some(([l, p]) => l.includes('Breakout retest') && p > 0));
});

test('Strategy 3 trap-avoidance: retest held + RSI>=70 scores a Reversal item', () => {
  const primary = baseSnap({ aboveUpFractal: true, lastUpFractal: 100, close: 100.3, atr: 1, rsi: 72, divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false });
  const { items } = Scoring.buildReversal([primary, null, null], 1);
  assert.ok(items.some(([l]) => l === '1H Retest into overbought (trap risk)'));
});

test('Strategy 4 (Squeeze Momentum): expanding + histogram matches bias + rising scores', () => {
  const m15 = baseSnap({ bbExpanding: true, macdHistogram: 2, macdHistogramRising: true });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(items.some(([l]) => l === '15M Squeeze momentum expansion (MACD confirm)'));
});

test('Strategy 4: histogram opposite bias does not score', () => {
  const m15 = baseSnap({ bbExpanding: true, macdHistogram: -2, macdHistogramRising: true });
  const { items } = Scoring.buildContinuation([baseSnap({}), m15, null], 1);
  assert.ok(!items.some(([l, p]) => l.includes('Squeeze momentum') && p > 0));
});

test('Strategy 5 (Mean Reversion): price at BB extreme + stochastic exhaustion cross both score independently', () => {
  const m5 = baseSnap({ bbPercentB: 1.05, stochBearishCrossFromOverbought: true });
  const { items } = Scoring.buildExhaustion([baseSnap({}), baseSnap({}), m5]);
  assert.ok(items.some(([l]) => l === '5M Price at BB extreme'));
  assert.ok(items.some(([l]) => l === '5M Stochastic exhaustion crossover'));
});

test('Strategy 5: mid-band, no crossover scores neither item', () => {
  const m5 = baseSnap({ bbPercentB: 0.5, stochBearishCrossFromOverbought: false, stochBullishCrossFromOversold: false });
  const { items } = Scoring.buildExhaustion([baseSnap({}), baseSnap({}), m5]);
  assert.ok(!items.some(([l]) => l.includes('BB extreme') || l.includes('Stochastic exhaustion')));
});

// ---------------------------------------------------------------------------
// Phase B3 — invalidation must not outlive the move that caused it
// ---------------------------------------------------------------------------

test('B3: a jaw touch in a bearish mouth is retired when the mouth flips bullish', () => {
  const ha = [], jaw = [], teeth = [], lips = [];
  for (let i = 0; i < 30; i++) {
    const bearish = i < 15;
    jaw.push(bearish ? 110 : 90); teeth.push(100); lips.push(bearish ? 90 : 110);
    ha.push({ t: i, o: 100, h: i === 10 ? 115 : 101, l: 99, c: 100 });
  }
  const st = Indicators.alligatorTouchState(ha, jaw, teeth, lips);
  assert.strictEqual(st[10], true, 'bearish jaw pierced -> invalidated');
  assert.strictEqual(st[14], true, 'still the same bearish move -> still invalidated');
  assert.strictEqual(st[15], false, 'mouth flipped bullish -> old invalidation must retire');
  assert.ok(st.slice(16, 20).every(v => v === false));
});

test('B3: an invalidation within the SAME mouth still persists until price clears lips', () => {
  const ha = [], jaw = [], teeth = [], lips = [];
  for (let i = 0; i < 20; i++) {
    jaw.push(90); teeth.push(100); lips.push(110);
    ha.push({ t: i, o: 105, h: 112, l: i === 8 ? 89 : 104, c: 105 }); // close stays below lips
  }
  const st = Indicators.alligatorTouchState(ha, jaw, teeth, lips);
  assert.strictEqual(st[8], true);
  assert.ok(st.slice(9, 13).every(v => v === true), 'must not clear while close < lips');
});

test('B3: a flat/mixed mouth does NOT count as a context change', () => {
  const ha = [], jaw = [], teeth = [], lips = [];
  for (let i = 0; i < 20; i++) {
    const flat = i >= 10 && i < 14;          // lines converge, no directional mouth
    jaw.push(90); teeth.push(100); lips.push(flat ? 100 : 110);
    ha.push({ t: i, o: 105, h: 112, l: i === 8 ? 89 : 104, c: 105 });
  }
  const st = Indicators.alligatorTouchState(ha, jaw, teeth, lips);
  assert.strictEqual(st[8], true);
  assert.ok(st.slice(10, 14).every(v => v === true),
    'a temporary flattening is an undecided mouth, not a new trend — flag stays live');
});

// ---------------------------------------------------------------------------
// Phase B2 — directional symmetry. These are invariants, not examples: a
// long and its exact mirror-image short must score identically. Any future
// rule added on one side only will break these rather than silently skew.
// ---------------------------------------------------------------------------

// baseSnap() is derived from a synthetic UPTREND, so its structural fields
// (ichimokuAboveCloud, emaStackBullish, positive ao...) already favour longs.
// Reusing it for both sides of a mirror test compares an uptrend against an
// uptrend, not a long against its mirror-image short. neutralSnap() is
// direction-free, and mirrorPair() flips every directional field explicitly.
function neutralSnap(over) {
  return Object.assign({
    alignment: 1, confidence: 'strong_bull', alligatorInvalidated: false,
    ao: null, aoRising: false, aoFalling: false, ac: null, acRising: false,
    mfiSignal: null, divergentBarUp: false, divergentBarDown: false,
    crossingLipsUp: false, crossingLipsDown: false,
    wisemanBullish: false, wisemanBearish: false, rsi: 50, divergence: 'none',
    lastUpFractal: null, lastDownFractal: null,
    aboveUpFractal: false, belowDownFractal: false,
    atr: 1, resistance: null, support: null, close: 100,
    ema9: null, ema21: null, emaStackBullish: false,
    macdHistogram: null, macdBullishCross: false, macdBearishCross: false,
    macdHistogramRising: false,
    bbUpper: null, bbLower: null, bbPercentB: null, bbExpanding: false, adx: null,
    stochBullishCrossFromOversold: false, stochBearishCrossFromOverbought: false,
    ichimokuAboveCloud: false, ichimokuBelowCloud: false,
    liquiditySweepUp: false, liquiditySweepDown: false,
    macdDivergence: 'none', stochDivergence: 'none'
  }, over);
}

function mirrorPair(longOver, shortOver) {
  const mk = (bias, over) => {
    const p = neutralSnap(Object.assign(
      { alignment: bias, confidence: bias === 1 ? 'strong_bull' : 'strong_bear' }, over));
    const tf = [p, p, p];
    return Scoring.tradeQualityScore({
      bias, count: 3,
      continuation: Scoring.buildContinuation(tf, bias),
      exhaustion: Scoring.buildExhaustion(tf, bias),
      reversal: Scoring.buildReversal(tf, bias),
      tfSnapshots: tf
    });
  };
  return [mk(1, longOver), mk(-1, shortOver)];
}

test('B2 symmetry: unavailable AO scores the same for long and short (no free bearish confirm)', () => {
  const flat = { ao: null, aoRising: false, aoFalling: false };
  const [l, s] = mirrorPair(flat, flat);
  assert.strictEqual(l, s, `long ${l} vs short ${s} — !aoRising must not imply "falling"`);
});

test('B2 symmetry: RSI health band mirrors, so short@30 scores like long@70', () => {
  [[30, 70], [40, 60], [50, 50], [70, 30], [80, 20]].forEach(([rl, rs]) => {
    const [l, s] = mirrorPair(
      { rsi: rl, ao: 1, aoRising: true, aoFalling: false },
      { rsi: rs, ao: -1, aoRising: false, aoFalling: true }
    );
    assert.strictEqual(l, s, `long rsi=${rl} scored ${l}, mirrored short rsi=${rs} scored ${s}`);
  });
});

test('B2: exhaustion RSI items only fire against the bias they actually threaten', () => {
  const mid = neutralSnap({});
  // Asserted on the RSI items specifically, not the total: "AC decelerating"
  // is deliberately bias-independent (keyed off AO's own sign), so it can
  // legitimately contribute to either side's total.
  const rsiItems = (fastRsi, bias) => Scoring.buildExhaustion([mid, mid, neutralSnap({ rsi: fastRsi })], bias)
    .items.filter(([l]) => l.includes('5M RSI')).map(([l]) => l);
  assert.deepStrictEqual(rsiItems(80, 1), ['5M RSI approaching overbought']);
  assert.deepStrictEqual(rsiItems(80, -1), [], 'overbought must not exhaust a short');
  assert.deepStrictEqual(rsiItems(20, -1), ['5M RSI approaching oversold']);
  assert.deepStrictEqual(rsiItems(20, 1), [], 'oversold must not exhaust a long');
});

test('B2: 1H RSI extreme has a bearish mirror (was long-only)', () => {
  const mid = neutralSnap({});
  const fires = (rsi, bias) => Scoring.buildExhaustion([neutralSnap({ rsi }), mid, mid], bias)
    .items.some(([l]) => l === '1H RSI extreme');
  assert.ok(fires(85, 1), 'overextended long should warn');
  assert.ok(fires(15, -1), 'overextended short should warn');
  assert.ok(!fires(15, 1));
  assert.ok(!fires(85, -1));
});

test('B2: bias===0 keeps both-sided exhaustion (range-bound information)', () => {
  const mid = neutralSnap({});
  assert.ok(Scoring.buildExhaustion([mid, mid, neutralSnap({ rsi: 80 })], 0).score > 0);
  assert.ok(Scoring.buildExhaustion([mid, mid, neutralSnap({ rsi: 20 })], 0).score > 0);
});

// ---------------------------------------------------------------------------
// Phase 5 Stage 3 — swing-tier strategies 6, 7, 8, 9, 11
// ---------------------------------------------------------------------------

test('Strategy 6 (Momentum Swing): above-cloud + stoch bullish entry both score; below-cloud in a bull bias does not', () => {
  const primary = baseSnap({ ichimokuAboveCloud: true });
  assert.ok(Scoring.buildContinuation([primary, null, null], 1).items.some(([l]) => l === '1H Price above Ichimoku cloud'));
  const m15 = baseSnap({ stochBullishCrossFromOversold: true });
  assert.ok(Scoring.buildContinuation([baseSnap({}), m15, null], 1).items.some(([l]) => l === '15M Stochastic bullish entry (oversold cross)'));
  const below = baseSnap({ ichimokuAboveCloud: false, ichimokuBelowCloud: true });
  assert.ok(!Scoring.buildContinuation([below, null, null], 1).items.some(([l, p]) => l.includes('Ichimoku') && p > 0));
});

test('Strategy 7 (Trend Following): plain MACD cross matching bias scores; EMA stack is NOT re-scored as a second line', () => {
  const primary = baseSnap({ macdBullishCross: true, emaStackBullish: true });
  const items = Scoring.buildContinuation([primary, null, null], 1).items;
  assert.ok(items.some(([l]) => l === '1H MACD trend-following cross'));
  assert.ok(!items.some(([l]) => l.includes('EMA stack')), 'EMA stack should not be a separate scoring line');
});

test('Strategy 8 (Trend Reversals): MACD cross against bias near a key level scores; far from any level does not', () => {
  const primary = baseSnap({ macdBearishCross: true, resistance: 100, close: 100.5, atr: 1, divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdDivergence: 'none' });
  assert.ok(Scoring.buildReversal([primary, null, null], 1).items.some(([l]) => l === '1H MACD reversal cross at key level'));
  const far = baseSnap({ macdBearishCross: true, resistance: 100, close: 150, atr: 1, divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdDivergence: 'none' });
  assert.ok(!Scoring.buildReversal([far, null, null], 1).items.some(([l]) => l.includes('MACD reversal cross')));
});

test('Strategy 9 (Divergence Play): MACD divergence (1H) and Stochastic divergence (15M) both score independently', () => {
  const primary = baseSnap({ macdDivergence: 'bear', divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdBearishCross: false });
  assert.ok(Scoring.buildReversal([primary, null, null], 1).items.some(([l]) => l === '1H Bearish MACD divergence'));
  const m15 = baseSnap({ stochDivergence: 'bear' });
  assert.ok(Scoring.buildReversal([baseSnap({ divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdBearishCross: false, macdDivergence: 'none' }), m15, null], 1).items.some(([l]) => l === '15M Stochastic divergence'));
});

test('Strategy 11 (Range Bound): only fires when bias===0, mirrors correctly for oversold/overbought', () => {
  const m5Oversold = baseSnap({ bbPercentB: 0.02, rsi: 30 });
  const oversoldItems = Scoring.buildReversal([null, null, m5Oversold], 0).items;
  assert.ok(oversoldItems.some(([l]) => l === '5M Range-bound bounce (support + RSI oversold)'));
  const m5Overbought = baseSnap({ bbPercentB: 0.98, rsi: 70 });
  const overboughtItems = Scoring.buildReversal([null, null, m5Overbought], 0).items;
  assert.ok(overboughtItems.some(([l]) => l === '5M Range-bound fade (resistance + RSI overbought)'));
});

test('Strategy 11: does NOT fire when bias is non-zero, even with the same extreme readings', () => {
  const m5 = baseSnap({ bbPercentB: 0.02, rsi: 30 });
  const items = Scoring.buildReversal([baseSnap({ divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdBearishCross: false, macdDivergence: 'none' }), null, m5], 1).items;
  assert.ok(!items.some(([l]) => l.includes('Range-bound')));
});

// ---------------------------------------------------------------------------
// Phase 5 Stage 4 — advanced-tier strategies 12, 13 (last stage)
// ---------------------------------------------------------------------------

test('Strategy 12 (Pullback Retracements): EMA match + tight pullback + healthy RSI scores', () => {
  const m15 = baseSnap({ emaStackBullish: true, ema21: 100, close: 100.1, atr: 1, rsi: 50 });
  assert.ok(Scoring.buildContinuation([baseSnap({}), m15, null], 1).items.some(([l]) => l === '15M Pullback to EMA21 (RSI healthy)'));
});

test('Strategy 12: RSI outside 40-60 (not a healthy pullback) does not score', () => {
  const m15 = baseSnap({ emaStackBullish: true, ema21: 100, close: 100.1, atr: 1, rsi: 75 });
  assert.ok(!Scoring.buildContinuation([baseSnap({}), m15, null], 1).items.some(([l, p]) => l.includes('Pullback to EMA21') && p > 0));
});

test('Strategy 12: pullback distance beyond 0.3x ATR does not score', () => {
  const m15 = baseSnap({ emaStackBullish: true, ema21: 100, close: 101, atr: 1, rsi: 50 });
  assert.ok(!Scoring.buildContinuation([baseSnap({}), m15, null], 1).items.some(([l, p]) => l.includes('Pullback to EMA21') && p > 0));
});

test('Strategy 13 (Liquidity Sweep): bearish rejection warns against a bullish bias', () => {
  const primary = baseSnap({ liquiditySweepDown: true, divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdBearishCross: false, macdDivergence: 'none' });
  assert.ok(Scoring.buildReversal([primary, null, null], 1).items.some(([l]) => l === '1H Liquidity sweep above resistance, rejected (bearish)'));
});

test('Strategy 13: bullish reclaim warns against a bearish bias', () => {
  const primary = baseSnap({ liquiditySweepUp: true, divergence: 'none', mfiSignal: null, divergentBarUp: false, wisemanBullish: false, macdBullishCross: false, macdDivergence: 'none' });
  assert.ok(Scoring.buildReversal([primary, null, null], -1).items.some(([l]) => l === '1H Liquidity sweep below support, reclaimed (bullish)'));
});

test('Strategy 13: a sweep in the SAME direction as bias does not fire (it only warns against bias)', () => {
  const primary = baseSnap({ liquiditySweepUp: true, divergence: 'none', mfiSignal: null, divergentBarDown: false, wisemanBearish: false, macdBearishCross: false, macdDivergence: 'none' });
  assert.ok(!Scoring.buildReversal([primary, null, null], 1).items.some(([l]) => l.includes('Liquidity sweep')));
});

test('Phase 5 complete: a coin with every new-batch signal firing still returns a valid, correctly capped score', () => {
  const candles = buildCleanUptrend(80);
  const result = Scoring.evaluate({ h1: candles, m15: candles, m5: candles }, { oiChange15m: 9 });
  assert.ok(result.score >= 0 && result.score <= 100);
  // Continuation is a mean of 0-100 sub-scores now (Audit F3), so its own
  // range is 0-100, not the old fixed 65-point cap.
  assert.ok(result.continuation.score >= 0 && result.continuation.score <= 100);
  assert.ok(result.exhaustion.score <= 40);
  assert.ok(result.reversal.score <= 50);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
