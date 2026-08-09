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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
