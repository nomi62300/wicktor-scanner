#!/usr/bin/env node
'use strict';
/* ==========================================================================
   Wicktor — cross-instrument validation of a FROZEN opening-range config.

   WHY THIS IS THE REAL TEST. One year of UK100 yields roughly 90-185 trades.
   Per-trade sigma for a 1.2R/-1R binary near 50% is ~1.10R, so the 95% CI
   half-width is about +/-0.20R: a genuinely good version of this strategy
   (+0.10R) cannot be distinguished from zero. More bars of the SAME series
   help only slowly, because FTSE's future is correlated with FTSE's past.

   The DAX's opening range is not. So this takes ONE config — chosen on one
   instrument, in-sample, and then never touched — and runs it unchanged on
   instruments it was never fitted to. That is a genuinely new out-of-sample
   dimension, and it is the argument tools/mt5-crossval.js was built to make.
   The question is not "is any instrument positive" (with eight, one will be);
   it is whether the POOLED estimate excludes zero and the sign is consistent.

   Read-only. Usage:
     node tools/orb-crossval.js --data data/ --tz-in Europe/Helsinki \
          --symbols UK100m,GER40m,US500m,USTECm --specs data/UK100m_specs.csv

   Broker decorations (UK100m on Exness, UK100.s elsewhere, GER40#) all
   resolve to the same session open — see baseName() below.
   ========================================================================== */

const path = require('path');
const fs = require('fs');
global.Indicators = require(path.join(__dirname, '..', 'js', 'indicators.js'));
const I = global.Indicators;

const tz = require('./lib/tz.js');
const CSV = require('./lib/csv-bars.js');
const STRAT = require('./lib/orb-strategy.js');
const RES = require('./lib/orb-resolve.js');
const EQ = require('./lib/equity.js');
const SYNTH = require('./orb-synth.js');

// Each index opens on its OWN exchange clock. Expressing them all in one
// zone would silently shift several of them for the weeks when regional
// daylight-saving transitions disagree.
const OPENS = {
  'UK100':     { openMin: 8 * 60,      zone: 'Europe/London',     flatMin: 16 * 60 + 25 },
  'FTSE100':   { openMin: 8 * 60,      zone: 'Europe/London',     flatMin: 16 * 60 + 25 },
  'GER40':     { openMin: 9 * 60,      zone: 'Europe/Berlin',     flatMin: 17 * 60 + 25 },
  'DE40':      { openMin: 9 * 60,      zone: 'Europe/Berlin',     flatMin: 17 * 60 + 25 },
  'DE30':      { openMin: 9 * 60,      zone: 'Europe/Berlin',     flatMin: 17 * 60 + 25 },
  'SP500':     { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'US500':     { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'NAS100':    { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'USTEC':     { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'US100':     { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'DJ30':      { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'US30':      { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'US2000':    { openMin: 9 * 60 + 30, zone: 'America/New_York',  flatMin: 15 * 60 + 55 },
  'NIKKEI225': { openMin: 9 * 60,      zone: 'Asia/Tokyo',        flatMin: 14 * 60 + 55 },
  'HK50':      { openMin: 9 * 60 + 30, zone: 'Asia/Hong_Kong',    flatMin: 15 * 60 + 55 }
};

/**
 * Brokers decorate the same instrument differently — UK100.s (one broker),
 * UK100m (Exness), USTECm, US500.a, GER40#. Stripping a dotted suffix alone
 * handles UK100.s and silently fails on UK100m, which uppercases to UK100M
 * and matches nothing. So match on the LONGEST key the symbol starts with,
 * which covers every decoration without needing to enumerate them, and keeps
 * US30 from swallowing US300-style names by preferring the longer key.
 */
const OPEN_KEYS = Object.keys(OPENS).sort((a, b) => b.length - a.length);
function baseName(sym) {
  const u = String(sym).toUpperCase();
  return OPEN_KEYS.find(k => u.startsWith(k)) || u.replace(/[.\-_#+].*$/, '');
}

function main() {
  const a = SYNTH.parseArgs(process.argv);
  const dir = a.data || 'data';
  const symbols = String(a.symbols || 'UK100m,GER40m,US500m,USTECm').split(',').map(s => s.trim());

  // FROZEN. Whatever was selected in-sample goes here once and is not touched.
  const CONFIG = {
    ...STRAT.DEFAULT_CFG,
    minBoxPts: a.minBox != null ? +a.minBox : 12,
    chopMins: a.chopMins != null ? +a.chopMins : 60,
    slBufferPts: a.slBuffer != null ? +a.slBuffer : 2,
    targetR: a.targetR != null ? +a.targetR : 1.2,
    divergence: a.divergence || 'off'
  };

  console.log('WICKTOR — ORB CROSS-INSTRUMENT VALIDATION');
  console.log('='.repeat(78));
  console.log('frozen config: ' + JSON.stringify({
    minBoxPts: CONFIG.minBoxPts, chopMins: CONFIG.chopMins,
    slBufferPts: CONFIG.slBufferPts, targetR: CONFIG.targetR, divergence: CONFIG.divergence
  }));
  console.log('This config is NOT re-fitted per instrument. That is the entire point.\n');
  console.log(`  ${'instrument'.padEnd(12)}${'n'.padStart(6)}${'win%'.padStart(7)}${'boxPts'.padStart(8)}` +
              `${'costR'.padStart(8)}${'NET R'.padStart(9)}${'BAL-NET'.padStart(10)}   95% CI`);

  const pooled = [];
  for (const sym of symbols) {
    const file = findFile(dir, sym);
    if (!file) { console.log(`  ${sym.padEnd(12)}  -- no M5 CSV found in ${dir}`); continue; }
    let r;
    try { r = runOne(file, sym, CONFIG, a); }
    catch (e) { console.log(`  ${sym.padEnd(12)}  -- ${e.message.split('\n')[0]}`); continue; }
    if (!r.trades.length) { console.log(`  ${sym.padEnd(12)}  -- no trades`); continue; }
    pooled.push(...r.trades);
    console.log(row(sym, r.trades));
  }

  if (pooled.length) {
    console.log('  ' + '-'.repeat(74));
    console.log(row('POOLED', pooled));
    const b = EQ.balancedCI(pooled) || EQ.ci95(pooled.map(t => t.netR));
    const excl = b && (b.lo > 0 || b.hi < 0);
    console.log('');
    console.log(`  Pooled direction-balanced expectancy ${fmt(b.m)}R, 95% CI [${fmt(b.lo)}, ${fmt(b.hi)}].`);
    console.log(`  This ${excl ? 'EXCLUDES' : 'INCLUDES'} zero.` +
      (excl ? '' : ' With several instruments one will look good by chance;'));
    if (!excl) console.log('  the pooled interval is the number that matters, and it does not establish an edge.');
  }
}

function findFile(dir, sym) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const hit = files.find(f => f.includes(sym) && /m5/i.test(f) && /\.csv$/i.test(f))
           || files.find(f => f.includes(sym) && /\.csv$/i.test(f));
  return hit ? path.join(dir, hit) : null;
}

function runOne(file, sym, cfg, a) {
  const { bars, meta, issues } = CSV.loadBars(file, { tzIn: a.tzIn || null });
  if (issues.fatal) throw new Error(`data validation failed: ${issues.errors.map(e => e.kind).join(', ')}`);
  const specs = CSV.resolveSpecs({
    specsFile: a.specs, symbol: sym,
    pointSize: a.pointSize != null ? +a.pointSize : undefined,
    pointValue: a.pointValue != null ? +a.pointValue : undefined
  });
  const o = OPENS[baseName(sym)];
  if (!o) throw new Error(`no session open known for ${sym}`);
  tz.assertZoneSupport(o.zone);
  const w = { name: baseName(sym), zone: o.zone, openMin: o.openMin, boxMin: 15,
              flatMin: o.flatMin, chopMin: cfg.chopMins, expiryMin: cfg.expiryMins };
  const ctx = { tfMin: Math.round(meta.tfMs / 60000), rsi: I.rsi(bars, 14),
                frac: I.fractals(bars), atr: I.atr(bars, 14),
                spreadPrice: 0, minBoxPts: cfg.minBoxPts };
  const { signals, tags } = STRAT.collectSignals(bars, [w], cfg, ctx);
  return { trades: RES.resolve(signals, bars, tags, [w], { ...cfg, tfMs: meta.tfMs }, specs) };
}

const fmt = x => x == null ? '   --' : (x >= 0 ? '+' : '') + x.toFixed(4);
const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
function row(name, g) {
  const bal = EQ.balancedCI(g), ci = EQ.ci95(g.map(t => t.netR)), use = bal || ci;
  return `  ${name.padEnd(12)}${String(g.length).padStart(6)}` +
    `${(g.filter(t => t.netR > 0).length / g.length * 100).toFixed(0).padStart(6)}%` +
    `${mean(g.map(t => t.boxPts)).toFixed(1).padStart(8)}` +
    `${mean(g.map(t => t.costR)).toFixed(3).padStart(8)}` +
    `${fmt(mean(g.map(t => t.netR))).padStart(9)}` +
    `${(bal ? fmt(bal.m) : '   --').padStart(10)}   ` +
    (use ? `[${fmt(use.lo)}, ${fmt(use.hi)}]${g.length < 30 ? ' (too few)' : ''}` : '--');
}

if (require.main === module) main();
module.exports = { main, OPENS };
