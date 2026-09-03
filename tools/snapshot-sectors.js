#!/usr/bin/env node
/* ==========================================================================
   Wicktor — snapshot sector performance and the coin→sector map.

   Records the one part of the taught sector-rotation method we could not
   backtest (see project memory: trendline-break test). Fixtures carry no
   sector metadata and CoinPaprika will not serve historical category
   performance, so the only way to ever answer "does sector strength predict
   our signals' outcomes" is to start writing it down.

   Reuses js/api.js's OWN fastSectorPerformance() rather than reimplementing
   it — that file requires cleanly in Node and the browser scan computes
   sector performance the same way, so the recorded ranking is by
   construction the ranking the scanner itself acts on. One source of truth.

   Unlike tools/cron-scan.js this CAN run on a GitHub hosted runner: the
   Bybit IP block that forced that job into an Edge Function is Bybit's,
   and CoinPaprika does not do the same thing. If that ever changes it will
   show up here as a fetch failure, not as silently stale data.

   Env: SUPABASE_URL (optional, defaults to the project),
        SUPABASE_SERVICE_KEY (required unless DRY_RUN=1)

   Usage: node tools/snapshot-sectors.js
          DRY_RUN=1 node tools/snapshot-sectors.js
   ========================================================================== */

const Api = require('../js/api.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fpyfetynfobfrpunnnhv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';

async function pg(pathAndQuery, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function main() {
  if (!SERVICE_KEY && !DRY_RUN) {
    console.error('SUPABASE_SERVICE_KEY is required (or set DRY_RUN=1)');
    process.exit(1);
  }

  const sectors = await Api.fastSectorPerformance();
  if (!sectors.length) {
    // Deliberately a non-zero exit: an empty result means CoinPaprika failed
    // or changed shape, and a silent success would leave a gap in the series
    // that looks identical to "no sectors moved".
    console.error('no sectors resolved — CoinPaprika unreachable or changed shape');
    process.exit(1);
  }

  const capturedAt = new Date().toISOString();
  const ranked = [...sectors].sort((a, b) => b.weightedChange7d - a.weightedChange7d);

  const snapshotRows = ranked.map((s, i) => ({
    captured_at: capturedAt,
    sector: s.name,
    weighted_change_7d: +s.weightedChange7d.toFixed(4),
    weighted_change_24h: s.weightedChange24h != null ? +s.weightedChange24h.toFixed(4) : null,
    mcap: s.mcap != null ? Math.round(s.mcap) : null,
    rank: i + 1,
    sector_count: ranked.length
  }));

  // The coin→sector map is built from FULL tag membership, not from the
  // ranked sector objects above. fastSectorPerformance() truncates each
  // sector to its top 50 by market cap — deliberate CoinGecko parity, since
  // that slice decides which coins enter the scan universe — but the map
  // must not inherit that cap. Measured: building it from the truncated
  // list attributed only 33% of journal coins to any sector (AAVE, APT and
  // most mid-caps fell outside their sector's top 50), which would have
  // left two thirds of the eventual analysis unanswerable.
  //
  // Sector PERFORMANCE keeps the cap (it should mirror what the scanner
  // acts on); sector MEMBERSHIP does not.
  const [tags, tickers] = await Promise.all([Api.paprikaTagMap(), Api.paprikaTickers()]);
  const symById = new Map();
  const mcapById = new Map();
  for (const t of tickers) {
    const sym = (t.symbol || '').toUpperCase();
    if (sym) symById.set(t.id, sym);
    const mc = t.quotes && t.quotes.USD && t.quotes.USD.market_cap;
    if (mc != null) mcapById.set(t.id, mc);
  }

  // Base asset uppercase, to join against signal_journal's Bybit pairs with
  // the quote currency stripped. Deduped because a coin in two sectors would
  // otherwise appear twice with the same primary key in one payload, which
  // PostgREST rejects outright.
  const seen = new Set();
  const coinRows = [];
  for (const { keyword, tag } of Api.resolveNarrativeTags(tags)) {
    for (const id of tag.coins || []) {
      const symbol = symById.get(id);
      if (!symbol) continue;
      const key = `${symbol}:${keyword}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mc = mcapById.get(id);
      coinRows.push({
        symbol,
        sector: keyword,
        market_cap: mc != null ? Math.round(mc) : null,
        updated_at: capturedAt
      });
    }
  }

  console.log(`sectors ${snapshotRows.length}, coin-sector pairs ${coinRows.length}`);
  ranked.slice(0, 5).forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.name.padEnd(24)} ${s.weightedChange7d.toFixed(2)}%`));

  if (DRY_RUN) { console.log('DRY_RUN: nothing written'); return; }

  await pg('sector_snapshot', {
    method: 'POST',
    body: JSON.stringify(snapshotRows),
    headers: { Prefer: 'return=minimal' }
  });

  // Upsert: the map barely changes, so most runs rewrite the same rows.
  await pg('coin_sector?on_conflict=symbol,sector', {
    method: 'POST',
    body: JSON.stringify(coinRows),
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });

  console.log(`written at ${capturedAt}`);
}

main().catch(e => { console.error('failed:', e.message); process.exit(1); });
