#!/usr/bin/env node
/* ==========================================================================
   Wicktor — C5 data capture: open interest + funding rate

   The existing fixtures carry candles only (m5/m15/h1/h4), so the C5
   hypotheses cannot be tested against them at all. This captures the two
   positioning series Bybit exposes for free and that the scanner has
   never used:

     open interest   /v5/market/open-interest   4h x 200  = 33 days
     funding rate    /v5/market/funding/history      x 200 = 66 days
     price           /v5/market/kline           4h x 1000 = 166 days

   WHY 4h OI RATHER THAN 15min: the finest OI interval Bybit offers only
   reaches 200 x 15min = 49.8 hours -- a single market regime, where every
   symbol's observations are one correlated blob. 4h x 200 spans 33 days
   and multiple regimes instead. Positioning shifts are slow by nature and
   4h also matches the model's own hold, so nothing meaningful is lost by
   the coarser step. (1h x 200 = 8.3 days is available as a middle option
   if a finer robustness check is ever wanted.)

   Klines are pulled at limit=1000 (166 days) deliberately: funding
   history reaches back 66 days, further than the 33 days of OI, so a
   shorter kline pull would silently truncate the funding test to the OI
   window. One request either way.

   Read-only against Bybit's public market endpoints. Writes
   tools/fixtures/positioning.json (gitignored, like the other large
   fixtures).

   Usage: node tools/capture-positioning.js [symbolCount]
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const BASE = 'https://api.bybit.com';
const CONCURRENCY = 8;          // conservative; public market data, but no reason to hammer it
const OUT = path.join(__dirname, 'fixtures', 'positioning.json');

// Mirrors js/api.js isTradeableUsdtPair -- exclude stable/stable pairs and
// leveraged tokens, which have no meaningful OI/funding story.
const EXCLUDE_QUOTE = /^(USDC|FDUSD|DAI|TUSD|EUR|USDE)USDT$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;
const tradeable = s => s.endsWith('USDT') && !EXCLUDE_QUOTE.test(s) && !LEVERAGED.test(s);

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.retCode !== 0) throw new Error(`retCode ${body.retCode}: ${body.retMsg}`);
      return body.result;
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  return null;
}

async function universe(count) {
  const r = await get(`${BASE}/v5/market/tickers?category=linear`);
  if (!r) throw new Error('could not fetch tickers');
  return r.list
    .filter(t => tradeable(t.symbol))
    .map(t => ({ symbol: t.symbol, turnover: +(t.turnover24h || 0) }))
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, count)
    .map(t => t.symbol);
}

async function captureSymbol(symbol) {
  const [kl, oi, fund] = await Promise.all([
    get(`${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=240&limit=1000`),
    get(`${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=4h&limit=200`),
    get(`${BASE}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200`)
  ]);
  if (!kl || !oi || !fund) return null;
  if (!kl.list || kl.list.length < 100) return null;

  return {
    symbol,
    // [t, o, h, l, c, v] ascending, same shape the other fixtures use
    candles4h: kl.list
      .map(x => [Number(x[0]), +x[1], +x[2], +x[3], +x[4], +x[5]])
      .sort((a, b) => a[0] - b[0]),
    // [t, openInterest] ascending
    oi4h: (oi.list || [])
      .map(x => [Number(x.timestamp), +x.openInterest])
      .sort((a, b) => a[0] - b[0]),
    // [t, fundingRate] ascending
    funding: (fund.list || [])
      .map(x => [Number(x.fundingRateTimestamp), +x.fundingRate])
      .sort((a, b) => a[0] - b[0])
  };
}

async function main() {
  const count = parseInt(process.argv[2], 10) || 200;
  console.log(`Capturing positioning data for top ${count} linear perps by 24h turnover...`);
  const symbols = await universe(count);
  console.log(`universe: ${symbols.length} symbols`);

  const out = [];
  let done = 0, failed = 0;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(s => captureSymbol(s).catch(() => null)));
    results.forEach((r, j) => {
      if (r) out.push(r); else { failed++; console.warn(`  skip ${chunk[j]}`); }
    });
    done += chunk.length;
    if (done % 40 === 0 || done >= symbols.length) {
      process.stdout.write(`  ${done}/${symbols.length} (${out.length} captured, ${failed} skipped)\n`);
    }
    await new Promise(r => setTimeout(r, 120));
  }

  // Span report, so the analysis step can state honestly what window it saw.
  const spans = out.map(c => {
    const oi = c.oi4h, f = c.funding;
    return {
      oiDays: oi.length > 1 ? (oi[oi.length - 1][0] - oi[0][0]) / 86400000 : 0,
      fundDays: f.length > 1 ? (f[f.length - 1][0] - f[0][0]) / 86400000 : 0
    };
  });
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  const payload = {
    capturedAt: new Date().toISOString(),
    symbolCount: out.length,
    medianOiDays: +med(spans.map(s => s.oiDays)).toFixed(1),
    medianFundingDays: +med(spans.map(s => s.fundDays)).toFixed(1),
    coins: out
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`\nwrote ${OUT} (${mb} MB)`);
  console.log(`${out.length} symbols; median OI span ${payload.medianOiDays}d, median funding span ${payload.medianFundingDays}d`);
}

main();
