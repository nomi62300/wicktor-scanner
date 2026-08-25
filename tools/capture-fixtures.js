#!/usr/bin/env node
/* ==========================================================================
   Wicktor — fixture capture

   Freezes raw Bybit candles for a sample of the live universe to a single
   JSON file. Everything downstream (score-fixtures.js, diff-scores.js) runs
   against these frozen candles, NOT the live API.

   Why frozen: a scoring change and a market move are indistinguishable if
   you re-fetch between runs. The audit's own before/after numbers were only
   trustworthy because both sides scored the same candle arrays. Capture
   once, then every code change is measured against an unmoving market.

   Re-capture only when you deliberately want a fresh market sample (e.g. to
   check a change holds across different regimes) — never mid-comparison.

   Usage: node tools/capture-fixtures.js [count] [outfile]
   ========================================================================== */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BYBIT = 'https://api.bybit.com';
// 4H is included even though today it's display-only — the regime/context
// work needs real 4H indicator history, and re-capturing later would break
// comparability with baselines taken now.
const TFS = { m5: '5', m15: '15', h1: '60', h4: '240' };
const LIMIT = 100;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function klines(category, symbol, interval) {
  const j = await get(`${BYBIT}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${LIMIT}`);
  if (!j || j.retCode !== 0 || !j.result || !j.result.list.length) return null;
  // Bybit returns newest-first; store oldest-first as compact tuples
  // [t,o,h,l,c,v] — ~60% smaller than objects, reconstituted on load.
  return j.result.list.slice().reverse().map(r => [ +r[0], +r[1], +r[2], +r[3], +r[4], +r[5] ]);
}

async function main() {
  const count = parseInt(process.argv[2], 10) || 60;
  const outfile = process.argv[3] || path.join(__dirname, 'fixtures', 'market-sample.json');

  console.log(`Capturing top ${count} perps by 24h turnover...`);
  const tick = await get(`${BYBIT}/v5/market/tickers?category=linear`);
  const symbols = tick.result.list
    .filter(t => /USDT$/.test(t.symbol))
    .sort((a, b) => (+b.turnover24h) - (+a.turnover24h))
    .slice(0, count)
    .map(t => t.symbol);

  const coins = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const entries = await Promise.all(
        Object.values(TFS).map(iv => klines('linear', sym, iv))
      );
      const candles = {};
      Object.keys(TFS).forEach((k, idx) => { candles[k] = entries[idx]; });
      // 1H drives every current code path; without it the row is unusable.
      if (!candles.h1) { console.log(`  skip ${sym} (no 1H data)`); continue; }
      coins.push({ symbol: sym, category: 'linear', candles });
      process.stdout.write(`\r  ${i + 1}/${symbols.length} ${sym.padEnd(14)}`);
    } catch (e) {
      console.log(`\n  skip ${sym}: ${e.message}`);
    }
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const payload = {
    capturedAt: new Date().toISOString(),
    source: 'bybit linear',
    limit: LIMIT,
    timeframes: Object.keys(TFS),
    coins
  };
  fs.writeFileSync(outfile, JSON.stringify(payload));
  const mb = (fs.statSync(outfile).size / 1048576).toFixed(2);
  console.log(`\n\nWrote ${coins.length} coins to ${outfile} (${mb} MB)`);
  console.log(`capturedAt: ${payload.capturedAt}`);
}

main().catch(e => { console.error(e); process.exit(1); });
