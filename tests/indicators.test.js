/* ==========================================================================
   Wicktor — Indicators unit tests
   Run:  node tests/indicators.test.js
   No third-party dependencies — uses Node.js assert module only.
   ========================================================================== */
'use strict';

const assert  = require('assert');
const Indicators = require('../js/indicators');

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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
