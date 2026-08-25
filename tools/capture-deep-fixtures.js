#!/usr/bin/env node
/* ==========================================================================
   Wicktor — deep fixture capture

   The regression fixture (market-sample.json) is one 100-bar window taken at
   one instant. That is right for "did this code change move any scores", and
   wrong for "is this model any good": every coin in it was sampled from the
   same hour of the same market, which carried +11.6% drift on 1H with 80% of
   coins up. Conclusions drawn from it inherit that.

   Two things are scaled here, and the order matters:

     DEPTH and DIVERSITY, not breadth. Crypto is heavily correlated, so 200
     coins at one instant is nowhere near 3x the information of 60 — largely
     the same market moving together. What actually adds independent
     observations is more bars, and what actually removes drift bias is
     sampling calendar windows that behaved differently. A window 60 days
     back showed BTC at -25.3% against the current +11.6%; those are
     different worlds and a model should be tested in both.

   Windows are defined in calendar time and each timeframe gets however many
   bars that implies, so 5M and 1H cover the SAME period and can be aligned
   by timestamp for context lookups. Bybit caps a request at 1000 bars, so
   the 5M leg is paginated backwards via `end`.

   Output is deliberately NOT committed (see .gitignore) — it is tens of MB
   and its purpose is one-off statistical validation, not regression diffing.
   Regenerate with this script; the exact bars will differ, which is fine
   because nothing diffs against it.

   Usage: node tools/capture-deep-fixtures.js [coins] [daysPerWindow]
   ========================================================================== */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BYBIT = 'https://api.bybit.com';
const MAXLIM = 1000;
const DAY = 24 * 3600 * 1000;

// Deliberately spread so the set spans different market behaviour rather
// than three samples of the same conditions. Reported drift per window makes
// the diversity visible instead of assumed.
const WINDOW_ENDS_DAYS_AGO = [0, 30, 60];

const TFS = { m5: { iv: '5', ms: 5 * 60e3 }, m15: { iv: '15', ms: 15 * 60e3 },
              h1: { iv: '60', ms: 3600e3 }, h4: { iv: '240', ms: 4 * 3600e3 } };

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fetches `barsWanted` bars ending at `endMs`, paginating backwards. */
async function klines(symbol, interval, endMs, barsWanted) {
  const out = [];
  let end = endMs;
  while (out.length < barsWanted) {
    const want = Math.min(MAXLIM, barsWanted - out.length);
    const j = await get(`${BYBIT}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${want}&end=${end}`);
    if (!j || j.retCode !== 0 || !j.result.list.length) break;
    const rows = j.result.list; // newest-first
    out.push(...rows);
    const oldest = Number(rows[rows.length - 1][0]);
    if (!Number.isFinite(oldest) || oldest >= end) break; // no progress, stop
    end = oldest - 1;
    if (rows.length < want) break;
    await sleep(60);
  }
  // oldest-first, deduped on timestamp
  const seen = new Set();
  return out
    .map(r => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]])
    .filter(t => (seen.has(t[0]) ? false : (seen.add(t[0]), true)))
    .sort((a, b) => a[0] - b[0]);
}

async function main() {
  const coinCount = parseInt(process.argv[2], 10) || 60;
  const days = parseInt(process.argv[3], 10) || 7;
  const outfile = path.join(__dirname, 'fixtures', 'market-deep.json');

  console.log(`Deep capture: ${coinCount} coins x ${WINDOW_ENDS_DAYS_AGO.length} windows x ${days}d`);
  const tick = await get(`${BYBIT}/v5/market/tickers?category=linear`);
  const symbols = tick.result.list
    .filter(t => /USDT$/.test(t.symbol))
    .sort((a, b) => (+b.turnover24h) - (+a.turnover24h))
    .slice(0, coinCount).map(t => t.symbol);

  const windows = [];
  const now = Date.now();

  for (const daysAgo of WINDOW_ENDS_DAYS_AGO) {
    const endMs = now - daysAgo * DAY;
    const label = new Date(endMs).toISOString().slice(0, 10);
    console.log(`\nWindow ending ${label} (${daysAgo}d ago)`);
    const coins = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const candles = {};
        for (const [key, cfg] of Object.entries(TFS)) {
          const bars = Math.ceil((days * DAY) / cfg.ms);
          candles[key] = await klines(sym, cfg.iv, endMs, bars);
        }
        if (!candles.h1 || candles.h1.length < 80) { continue; }
        coins.push({ symbol: sym, category: 'linear', candles });
        process.stdout.write(`\r  ${i + 1}/${symbols.length} ${sym.padEnd(14)}`);
      } catch (e) { /* skip this symbol in this window */ }
    }

    // Drift of the window, so bias is visible rather than assumed.
    const drifts = coins.map(c => {
      const h = c.candles.h1;
      return h.length > 1 ? (h[h.length - 1][4] - h[0][4]) / h[0][4] * 100 : 0;
    }).sort((a, b) => a - b);
    const meanDrift = drifts.reduce((s, v) => s + v, 0) / (drifts.length || 1);
    const upShare = drifts.filter(d => d > 0).length / (drifts.length || 1) * 100;
    console.log(`\n  ${coins.length} coins | mean 1H drift ${meanDrift.toFixed(1)}% | coins up ${upShare.toFixed(0)}%`);
    windows.push({ label, endMs, daysAgo, meanDrift: +meanDrift.toFixed(2), upSharePct: +upShare.toFixed(0), coins });
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, JSON.stringify({
    capturedAt: new Date().toISOString(),
    daysPerWindow: days,
    timeframes: Object.keys(TFS),
    windows
  }));
  const mb = (fs.statSync(outfile).size / 1048576).toFixed(1);

  console.log(`\n${'='.repeat(58)}`);
  console.log(`Wrote ${outfile} (${mb} MB)`);
  windows.forEach(w => console.log(`  ${w.label}  ${String(w.coins.length).padStart(3)} coins  drift ${String(w.meanDrift).padStart(7)}%  up ${w.upSharePct}%`));
  const spread = Math.max(...windows.map(w => w.meanDrift)) - Math.min(...windows.map(w => w.meanDrift));
  console.log(`  drift spread across windows: ${spread.toFixed(1)} points`);
  console.log(spread < 10
    ? '  WARNING: windows behaved similarly — limited regime diversity.'
    : '  Good: the windows span materially different market conditions.');
}

main().catch(e => { console.error(e); process.exit(1); });
