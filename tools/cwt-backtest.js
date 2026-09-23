#!/usr/bin/env node
'use strict';
/* ==========================================================================
   Wicktor — CWT London Alligator backtest (EUR/USD and other FX).

   The statistical twin of tools/pine/cwt-london-alligator.pine. The Pine
   version exists so signals can be SEEN on a chart; this one exists because
   TradingView's free plan caps history at 5,000 bars — about 17 London
   sessions on 5M, a sample whose 95% interval is near +/-0.5R and which
   therefore cannot answer whether the strategy makes money.

   Methodology inherited from tools/orb-backtest.js so the numbers stay
   comparable with every other measurement in this repo: strictly closed-bar
   decisions, a bar touching both stop and target counts as a STOP, timeouts
   marked to market, cost charged at the fill bar's own recorded spread,
   direction-balanced reporting, and 95% confidence intervals because n is
   small.

   THE NUMBER THAT DECIDES THIS STRATEGY. At a 1:1 target the break-even win
   rate is (1 + costR) / 2 — already above 50% before anything else. On
   EUR/USD at a 1.5 pip spread a 15-pip stop needs 55.0%, a 10-pip stop
   57.5%. Read that line before the P&L.

   Read-only. Usage:
     node tools/cwt-backtest.js --bars data/EURUSDm_M5.csv --specs data/EURUSDm_specs.csv \
          --symbol EURUSDm --tz-in UTC --sl-buffer-pips 3
     node tools/cwt-backtest.js --synthetic --seed 42     # negative control
   ========================================================================== */

const path = require('path');
global.Indicators = require(path.join(__dirname, '..', 'js', 'indicators.js'));

const tz = require('./lib/tz.js');
const CSV = require('./lib/csv-bars.js');
const CWT = require('./lib/cwt-strategy.js');
const EQ = require('./lib/equity.js');
const RES = require('./lib/orb-resolve.js');
const SYNTH = require('./orb-synth.js');

const sg = x => x == null ? '     --' : (x >= 0 ? '+' : '') + x.toFixed(4);
const pct = x => x == null ? '  --' : (x * 100).toFixed(2) + '%';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function main() {
  const a = SYNTH.parseArgs(process.argv);
  if (a.help) return usage();

  const cfg = { ...CWT.DEFAULT_CFG };
  if (a.openHour != null) cfg.openMin = +a.openHour * 60 + (+a.openMinute || 0);
  if (a.boxMin != null) cfg.boxMin = +a.boxMin;
  if (a.waitMin != null) cfg.waitMinMin = +a.waitMin;
  if (a.waitMax != null) cfg.waitMaxMin = +a.waitMax;
  if (a.maxTrades != null) cfg.maxTrades = +a.maxTrades;
  if (a.tangleMult != null) cfg.tangleMult = +a.tangleMult;
  if (a.priorLookback != null) cfg.priorLookback = +a.priorLookback;
  if (a.slBufferPips != null) cfg.slBufferPips = +a.slBufferPips;
  if (a.targetR != null) cfg.targetR = +a.targetR;
  if (a.reentryStop) cfg.reentryStop = a.reentryStop;
  if (a.fill) cfg.fill = a.fill;
  if (a.zone) cfg.zone = a.zone;

  const synthetic = !!a.synthetic;
  let bars, meta, issues, specs;

  if (synthetic) {
    const g = SYNTH.generate({
      seed: a.seed || 42, from: a.from || '2025-01-02', to: a.to || '2025-12-31',
      mode: a.mode || 'flat', start: 1.16, sigma: a.sigma != null ? +a.sigma : 0.00025,
      spreadPts: 15, digits: 5, gridZone: 'Europe/London'
    });
    bars = g.bars;
    meta = { file: '(synthetic)', sourceZone: 'UTC', rows: bars.length, tfMs: 300000,
             hasSpread: true, from: bars[0].t, to: bars[bars.length - 1].t,
             synthetic: true, seed: g.meta.seed, mode: g.meta.mode };
    issues = { errors: [], warnings: [], fatal: false };
    specs = { pointSize: 0.00001, pointValue: a.pointValue != null ? +a.pointValue : 1,
              minLot: 0.01, lotStep: 0.01, source: 'synthetic default' };
  } else {
    if (!a.bars) { console.error('need --bars <file.csv> (or --synthetic)\n'); return usage(1); }
    const loaded = CSV.loadBars(a.bars, { tzIn: a.tzIn || null });
    bars = loaded.bars; meta = loaded.meta; issues = loaded.issues;
    specs = CSV.resolveSpecs({
      specsFile: a.specs, symbol: a.symbol || path.basename(a.bars).split('_')[0],
      pointSize: a.pointSize != null ? +a.pointSize : undefined,
      pointValue: a.pointValue != null ? +a.pointValue : undefined,
      minLot: a.minLot != null ? +a.minLot : undefined,
      lotStep: a.lotStep != null ? +a.lotStep : undefined
    });
  }

  // PIP SIZE, DERIVED ONCE AND SHOWN. A 5-digit FX feed has point 0.00001,
  // so one pip is 10 points. Getting this backwards is a 10x error in every
  // stop distance — the same class of mistake that made UK100m's point value
  // 100x wrong — so it is printed in the header for audit, never assumed.
  cfg.pipSize = a.pipSize != null ? +a.pipSize
              : (specs.pointSize <= 0.00001 ? specs.pointSize * 10 : specs.pointSize);

  const L = [];
  if (synthetic) {
    L.push('='.repeat(78), SYNTH.BANNER, '='.repeat(78), '');
  }
  L.push('WICKTOR — CWT LONDON ALLIGATOR BACKTEST', '='.repeat(78));
  L.push(`data            ${meta.file}${synthetic ? `  seed=${meta.seed} mode=${meta.mode}` : ''}`);
  L.push(`bars            ${meta.rows}   tf ${Math.round(meta.tfMs / 60000)}M   ` +
         `${new Date(meta.from).toISOString().slice(0, 10)} .. ${new Date(meta.to).toISOString().slice(0, 10)}`);
  L.push(`source zone     ${meta.sourceZone}`);
  const zi = tz.assertZoneSupport(cfg.zone);
  L.push(`session         ${tz.fmtHHMM(cfg.openMin)} ${cfg.zone} [${zi.note}]  ` +
         `decision ${tz.fmtHHMM(cfg.openMin + cfg.boxMin)}  flat ${tz.fmtHHMM(cfg.flatMin)}`);
  L.push(`point size      ${specs.pointSize}   pip size ${cfg.pipSize}   ` +
         `(1 pip = ${Math.round(cfg.pipSize / specs.pointSize)} points)`);
  L.push(`stop buffer     ${cfg.slBufferPips} pips = ${(cfg.slBufferPips * cfg.pipSize).toFixed(6)} in price`);
  L.push(`alligator       ${cfg.jawLen || 13}/${cfg.teethLen || 8}/${cfg.lipsLen || 5} ` +
         `displaced 8/5/3 (as drawn)   tangle < ${cfg.tangleMult} x ATR14`);
  L.push(`rules           wait ${cfg.waitMinMin}-${cfg.waitMaxMin} min, max ${cfg.maxTrades} trades/day, ` +
         `target ${cfg.targetR}R, fill ${cfg.fill}, re-entry stop ${cfg.reentryStop}`);

  // Timezone self-check. FX trades ~24h, so the first-bar-of-day test is
  // uninformative; the London open's volume footprint is the usable signal.
  const prof = CSV.sessionActivityProfile(bars, cfg.zone);
  const wantHour = Math.floor(cfg.openMin / 60);
  if (!synthetic) {
    L.push('', CSV.renderActivityProfile(prof, cfg.zone, wantHour));
    if (a.assertOpen === 'auto' && prof.jumpHour !== wantHour) {
      L.push('', `FATAL: --assert-open auto — the morning volume step-up is at ` +
             `${String(prof.jumpHour).padStart(2, '0')}:00, not ${String(wantHour).padStart(2, '0')}:00.`,
             '  The declared source zone is wrong; every session would be read off the wrong bars.');
      console.log(L.join('\n')); process.exit(3);
    }
  }

  if (issues.errors.length || issues.warnings.length) {
    L.push('', 'DATA VALIDATION');
    for (const e of issues.errors) L.push(`  ERROR   ${e.kind}  n=${e.n || 1}  ${e.msg || ''}`);
    for (const w of issues.warnings) L.push(`  warn    ${w.kind}  n=${w.n || ''}  ${w.msg || ''}`);
  }
  if (issues.fatal) {
    L.push('', 'Refusing to run on a corrupt CSV: it looks exactly like a strategy that stopped trading.');
    console.log(L.join('\n')); process.exit(3);
  }
  if (a.validateOnly) { L.push('', '--validate-only: stopping here.'); console.log(L.join('\n')); return; }

  // ------------------------------------------------------------------ run
  const { trades, dispositions } = CWT.collectTrades(bars, cfg);

  // Cost: one crossing, at the FILL bar's own recorded spread.
  for (const t of trades) {
    const sp = bars[t.entryIdx].spreadPts != null ? bars[t.entryIdx].spreadPts : (a.assumedSpread || 0);
    const spreadPrice = sp * specs.pointSize;
    t.spreadPips = spreadPrice / cfg.pipSize;
    t.costR = t.riskPts > 0 ? +(spreadPrice / t.riskPts).toFixed(5) : 0;
    t.netR = +(t.grossR - t.costR).toFixed(5);
    t.boxPts = t.riskPips;
  }

  // -------------------------------------------------------------- funnel
  L.push('', 'SESSION FUNNEL', '-'.repeat(78));
  const counts = {};
  for (const d of dispositions) counts[d.disposition] = (counts[d.disposition] || 0) + 1;
  const nonSession = counts[CWT.SKIP.NO_SESSION] || 0;
  const real = dispositions.length - nonSession;
  if (nonSession) L.push(`  ${pad('days with no bar at the open', 34)}${lpad(nonSession, 6)}   (excluded)`);
  L.push(`  ${pad('tradeable London sessions', 34)}${lpad(real, 6)}`);
  for (const k of ['stop_wrong_side', 'wait_expired', 'no_prior_trend', 'session_end', 'entered']) {
    if (!counts[k]) continue;
    const label = k === 'entered' ? 'ENTERED (>=1 trade)' : `skipped: ${k}`;
    L.push(`  ${pad(label, 34)}${lpad(counts[k], 6)}${lpad(real ? (counts[k] / real * 100).toFixed(0) + '%' : '', 6)}`);
  }
  L.push(`  ${pad('trades total', 34)}${lpad(trades.length, 6)}`);

  if (!trades.length) { L.push('', 'No trades.'); console.log(L.join('\n')); return; }

  // ------------------------------------------------- the deciding number
  const meanCost = mean(trades.map(t => t.costR));
  const winRate = trades.filter(t => t.netR > 0).length / trades.length;
  const be = RES.breakEvenWinRate(cfg.targetR, meanCost);
  L.push('', 'THE NUMBER THAT DECIDES THIS', '-'.repeat(78));
  L.push(`  mean cost           ${meanCost.toFixed(4)}R   ` +
         `(mean spread ${mean(trades.map(t => t.spreadPips)).toFixed(2)} pips, mean stop ${mean(trades.map(t => t.riskPips)).toFixed(1)} pips)`);
  L.push(`  break-even @${cfg.targetR.toFixed(1)}R      ${(be * 100).toFixed(1)}%   ` +
         `(at 1:1 this is (1+cost)/2, so always above 50%)`);
  L.push(`  ACHIEVED win rate   ${(winRate * 100).toFixed(1)}%   ` +
         `${winRate >= be ? '<- clears break-even' : '<- BELOW break-even'}`);

  // ------------------------------------------------------------ R table
  L.push('', 'R-MULTIPLES  (BAL-NET is direction-balanced: longs and shorts averaged apart)', '-'.repeat(78));
  L.push(`  ${pad('group', 20)}${lpad('n', 5)}${lpad('L/S', 8)}${lpad('win%', 7)}` +
         `${lpad('stopPips', 10)}${lpad('costR', 8)}${lpad('NET R', 9)}${lpad('BAL-NET', 10)}   95% CI`);
  const groups = [['ALL', trades]];
  for (const b of ['case1-fan', 'case2-prior', 'case3-waited', 'case4-reentry']) {
    const g = trades.filter(t => t.branch === b);
    if (g.length) groups.push([`  ${b}`, g]);
  }
  for (const [name, g] of groups) L.push(rowFor(name, g));
  L.push('');
  L.push('  Those four cases are four different strategies sharing a session. Judge them');
  L.push('  separately, and do not select one on the strength of a single small cell.');

  // ---------------------------------------------------------- caveats
  L.push('', 'MEASUREMENT CAVEATS', '-'.repeat(78));
  const both = trades.filter(t => RES.countBothTouched(
    bars.slice(t.entryIdx, t.exitIdx + 1), t.dir, t.entryPx, t.riskPts, t.targetR)).length;
  L.push(`  both-touched bars   ${both} (${(both / trades.length * 100).toFixed(1)}%) booked as STOPS — the size of the pessimism.`);
  L.push(`  fill                ${cfg.fill === 'close' ? 'signal bar close (optimistic: the bar fills itself)' : 'next bar open (conservative)'}`);
  L.push(`  cost basis          ${meta.hasSpread ? 'MEASURED per-bar broker spread' : 'ASSUMED constant — not measured'}`);
  L.push(`  alligator           read AS DRAWN (displaced 8/5/3), i.e. older data than the raw averages — never lookahead`);
  L.push(`  S/R levels          pivot(${cfg.leftBars},${cfg.rightBars}) confirmed, visible only from bar p+${cfg.rightBars + 1};`);
  L.push(`                      the indicator PLOTS them back at p, which makes levels look older on a chart than they were`);

  // ---------------------------------------------------------- dollars
  if (specs.pointValue != null) {
    const init = a.initial || 5000;
    L.push('', `DOLLARS ON $${init.toLocaleString()}  (compliance simulation)`, '-'.repeat(78));
    L.push(`  ${pad('granularity / risk', 26)}${lpad('net P&L', 12)}${lpad('return', 9)}` +
           `${lpad('maxDD', 8)}${lpad('worstDay', 10)}${lpad('trailDD', 9)}${lpad('streak', 8)}`);
    for (const mode of ['fractional', 'minlot']) {
      for (const comp of [true, false]) {
        const e = EQ.runEquity(trades, {
          initial: init, riskPct: (a.riskPct != null ? +a.riskPct : 0.5) / 100,
          pointValue: specs.pointValue, pointSize: specs.pointSize,
          minLot: specs.minLot, lotStep: specs.lotStep, mode, compounding: comp, tfMs: meta.tfMs
        });
        if (!e.records.length) continue;
        const dd = EQ.drawdownStats(e.floating);
        const daily = EQ.dailyDrawdown(e.floating, a.accountingZone || tz.DEFAULT_ACCOUNTING_ZONE, 0.04);
        L.push(`  ${pad(mode + (comp ? ' / compounding' : ' / fixed'), 26)}` +
               `${lpad('$' + e.netProfit.toFixed(0), 12)}${lpad(pct(e.returnPct), 9)}` +
               `${lpad(pct(dd.maxDrawdownPct), 8)}${lpad(pct(daily.worst ? daily.worst.ddPct : 0), 10)}` +
               `${lpad(pct(EQ.trailingDrawdown(e.floating)), 9)}${lpad(EQ.maxLossStreak(e.records), 8)}`);
        if (mode === 'minlot' && comp) {
          const bs = EQ.bootstrap(e.records, { seed: a.seed || 42, initial: init,
            riskPct: (a.riskPct != null ? +a.riskPct : 0.5) / 100, compounding: comp });
          if (bs) {
            L.push('', '  BOOTSTRAP (10,000 resamples — the realised path is one draw from this)');
            L.push(`      max drawdown %   observed ${pct(dd.maxDrawdownPct)}  median ${pct(bs.maxDrawdown.median)}  p95 ${pct(bs.maxDrawdown.p95)}  P(breach 10%) = ${bs.maxDrawdown.pBreach.toFixed(2)}`);
            L.push(`      worst daily DD   observed ${pct(daily.worst ? daily.worst.ddPct : 0)}  median ${pct(bs.dailyDrawdown.median)}  p95 ${pct(bs.dailyDrawdown.p95)}  P(breach 4%)  = ${bs.dailyDrawdown.pBreach.toFixed(2)}`);
            L.push(`      max loss streak  observed ${lpad(EQ.maxLossStreak(e.records), 3)}      median ${lpad(bs.lossStreak.median, 3)}     p95 ${lpad(bs.lossStreak.p95, 3)}`, '');
          }
        }
      }
    }
  }

  // ---------------------------------------------------------- closing
  L.push('', 'READ THIS BEFORE QUOTING ANY NUMBER ABOVE', '-'.repeat(78));
  const all = EQ.balancedCI(trades) || EQ.ci95(trades.map(t => t.netR));
  if (all) {
    const excl = all.lo > 0 || all.hi < 0;
    L.push(`  n=${trades.length}. Direction-balanced net expectancy ${sg(all.m)}R, 95% CI [${sg(all.lo)}, ${sg(all.hi)}].`);
    L.push(`  This interval ${excl ? 'EXCLUDES' : 'INCLUDES'} zero${excl ? '.' : ' — no edge is established in either direction.'}`);
  }
  L.push(`  95% half-width at this n is ~${(1.96 * 1.0 / Math.sqrt(trades.length)).toFixed(3)}R; a smaller true edge is`);
  L.push(`  indistinguishable from zero here. Cross-instrument replication beats more bars of the same pair.`);
  if (synthetic && meta.mode === 'flat') {
    L.push('', `  NEGATIVE CONTROL (driftless walk). Expected net expectancy ~ -${meanCost.toFixed(4)}R:`);
    L.push('  you pay the spread and a driftless walk returns nothing. A clearly POSITIVE');
    L.push('  result here means the HARNESS is broken, not that an edge was found.');
  } else if (synthetic) {
    L.push('', `  POSITIVE CONTROL (mode=${meta.mode}): drift is injected, so a trend-following`);
    L.push('  entry SHOULD measure positive. It proves the machine can see an edge; it says nothing about EUR/USD.');
  }
  console.log(L.join('\n'));
}

function rowFor(name, g) {
  const bal = EQ.balancedCI(g), ci = EQ.ci95(g.map(t => t.netR)), use = bal || ci;
  const nL = g.filter(t => t.dir === 1).length;
  return `  ${pad(name, 20)}${lpad(g.length, 5)}${lpad(nL + '/' + (g.length - nL), 8)}` +
    `${lpad((g.filter(t => t.netR > 0).length / g.length * 100).toFixed(0) + '%', 7)}` +
    `${lpad(mean(g.map(t => t.riskPips)).toFixed(1), 10)}` +
    `${lpad(mean(g.map(t => t.costR)).toFixed(3), 8)}` +
    `${lpad(sg(mean(g.map(t => t.netR))), 9)}` +
    `${lpad(bal ? sg(bal.m) : '     --', 10)}   ` +
    (use ? `[${sg(use.lo)}, ${sg(use.hi)}]${g.length < 30 ? ' (too few)' : ''}` : '--');
}

function usage(code = 0) {
  console.log(`
node tools/cwt-backtest.js --bars <csv> [options]

  --bars <path>          5M bar CSV (MT5 time,o,h,l,c,v,spread or generic)
  --tz-in <zone>         REQUIRED for naive timestamps (Exness servers are usually UTC)
  --assert-open auto     Fail unless the London volume step-up lands on the open hour
  --validate-only        Load, validate, print the zone check, stop
  --specs <csv>          Broker specs (point size, point value, min lot, lot step)
  --symbol <name>        Row to read from the specs file
  --pip-size <n>         Override the derived pip size (5-digit FX: 0.0001)

  --sl-buffer-pips <n>   Stop beyond the jaw / S/R level (default 3)
  --target-r <r>         Reward:risk (default 1.0)
  --tangle-mult <n>      Tangled when line spread < n x ATR14 (default 0.5)
  --prior-lookback <n>   Bars back for the previous trend (default 24)
  --wait-min / --wait-max   Alligator re-adjust window in minutes (default 15 / 45)
  --max-trades <n>       Per day, initial + re-entries (default 3)
  --reentry-stop jaw|sr|wider
  --fill nextopen|close  Default nextopen (conservative)

  --synthetic [--seed n] [--mode flat|trend]   controls; NOT strategy evidence
`);
  process.exit(code);
}

if (require.main === module) main();
module.exports = { main };
