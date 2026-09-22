#!/usr/bin/env node
'use strict';
/* ==========================================================================
   Wicktor — opening-range breakout backtest (FTSE/UK100 and other indices).

   Measures the session-open box strategy: 15M opening range, chop filters A
   and B, 5M breakout, retest closing outside the box, stop beyond the
   opposite edge, 1.0-1.2R target, with an optional RSI-divergence reversal
   branch.

   METHODOLOGY, inherited deliberately from tools/mt5-backtest.js and
   tools/backtest-v2.js so these numbers stay comparable with every other
   claim in this repo:
     - strictly closed-bar decisions; tools/lib/no-lookahead.js proves it
     - a bar touching both stop and target counts as a STOP
     - timeouts marked to market
     - cost charged at the fill bar's OWN recorded spread
     - direction-balanced reporting; a large long/short gap is drift, not edge
     - 95% confidence intervals, because n here is small
     - parameters named in-sample BEFORE the out-of-sample slice is read

   WHAT THIS CANNOT ESTABLISH. One year of one index yields roughly 90-185
   trades. Per-trade sigma for a 1.2R/-1R binary near 50% is ~1.10R, so the
   95% CI half-width is about +/-0.20R. A genuinely good version of this
   strategy (+0.10R) is therefore indistinguishable from zero in twelve
   months. Read the CI, not the point estimate, and treat tools/orb-crossval
   across instruments as the real test.

   Read-only. Usage:
     node tools/orb-backtest.js --bars data/UK100.s_M5.csv --tz-in Europe/Helsinki \
          --point-size 0.1 --point-value 1 --min-box 12 --target-r 1.2
     node tools/orb-backtest.js --synthetic --seed 42        # mechanism test
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

const sg = x => x == null ? '     --' : (x >= 0 ? '+' : '') + x.toFixed(4);
const pct = x => x == null ? '  --' : (x * 100).toFixed(2) + '%';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

// ------------------------------------------------------------------- main
function main() {
  const a = SYNTH.parseArgs(process.argv);
  if (a.help) return usage();

  const cfg = { ...STRAT.DEFAULT_CFG };
  if (a.minBox != null && a.minBox !== 'auto') cfg.minBoxPts = +a.minBox;
  if (a.chopMins != null) cfg.chopMins = +a.chopMins;
  if (a.expiryMins != null) cfg.expiryMins = +a.expiryMins;
  if (a.slBuffer != null) cfg.slBufferPts = +a.slBuffer;
  if (a.targetR != null) cfg.targetR = +a.targetR;
  if (a.fill) cfg.fill = a.fill;
  if (a.retest) cfg.retest = a.retest;
  if (a.divergence) cfg.divergence = a.divergence;
  if (a.divLookback != null) cfg.divLookback = +a.divLookback;
  if (a.divTolerance != null) cfg.divTolerance = +a.divTolerance;
  if (a.reversalStop) cfg.reversalStop = a.reversalStop;
  if (a.assumedSpread != null) cfg.assumedSpreadPts = +a.assumedSpread;

  const synthetic = !!a.synthetic;
  let bars, meta, issues, specs;

  if (synthetic) {
    const g = SYNTH.generate({ seed: a.seed || 42, from: a.from || '2025-01-02',
                               to: a.to || '2025-12-31', mode: a.mode || 'flat' });
    bars = g.bars;
    meta = { file: '(synthetic)', sourceZone: 'UTC', rows: bars.length, tfMs: 300000,
             hasSpread: true, from: bars[0].t, to: bars[bars.length - 1].t, synthetic: true, seed: g.meta.seed, mode: g.meta.mode };
    issues = { errors: [], warnings: [], fatal: false };
    specs = { pointSize: a.pointSize != null ? +a.pointSize : 0.1,
              pointValue: a.pointValue != null ? +a.pointValue : 1,
              minLot: 0.1, lotStep: 0.1, source: 'synthetic default' };
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

  const windows = tz.parseWindows(a.windows).map(w => ({
    ...w,
    chopMin: cfg.chopMins, expiryMin: cfg.expiryMins
  }));
  for (const w of windows) tz.assertZoneSupport(w.zone);

  // ------------------------------------------------- header + data gate
  const L = [];
  if (synthetic) {
    L.push('='.repeat(78), SYNTH.BANNER, '='.repeat(78), '');
  }
  L.push('WICKTOR — OPENING-RANGE BREAKOUT BACKTEST', '='.repeat(78));
  L.push(`data            ${meta.file}${synthetic ? `  seed=${meta.seed}` : ''}`);
  L.push(`bars            ${meta.rows}   tf ${Math.round(meta.tfMs / 60000)}M   ` +
         `${new Date(meta.from).toISOString().slice(0, 10)} .. ${new Date(meta.to).toISOString().slice(0, 10)}`);
  L.push(`source zone     ${meta.sourceZone}`);
  for (const w of windows) {
    const z = tz.assertZoneSupport(w.zone);
    L.push(`window ${pad(w.name, 8)} ${tz.fmtHHMM(w.openMin)} ${w.zone}  [${z.note}]  ` +
           `box ${w.boxMin}M, chop ${cfg.chopMins}M, expiry ${cfg.expiryMins}M, flat ${tz.fmtHHMM(w.flatMin)}`);
  }
  L.push(`point size      ${specs.pointSize}  (${specs.source})   point value ${specs.pointValue ?? 'n/a'}` +
         `${specs.pointValueNote && specs.pointValueNote !== 'cli' ? ` [${specs.pointValueNote}]` : ''}` +
         `   minLot ${specs.minLot}  step ${specs.lotStep}`);

  // The timezone self-check. Two methods, because they suit different data:
  // firstBarHistogram pins a CASH series (its day starts at the open), while
  // a ~24h CFD needs the cash open's volume footprint instead.
  const primary = windows[0];
  const hist = CSV.firstBarHistogram(bars, primary.zone);
  const cashLike = hist.modal === tz.fmtHHMM(primary.openMin);
  L.push('', CSV.renderFirstBarHistogram(hist, primary.zone, tz.fmtHHMM(primary.openMin)));
  const prof = CSV.sessionActivityProfile(bars, primary.zone);
  if (!cashLike) {
    L.push('', `(This looks like a ~24h CFD rather than a cash series — its day starts at ${hist.modal},`,
           ' so the table above cannot verify the zone. Using the session-open volume footprint instead.)',
           '', CSV.renderActivityProfile(prof, primary.zone, Math.floor(primary.openMin / 60)));
  }
  const zoneOk = cashLike || prof.jumpHour === Math.floor(primary.openMin / 60);
  if (a.assertOpen === 'auto' && !zoneOk) {
    L.push('', 'FATAL: --assert-open auto — neither check locates the session open where the',
           '  declared zone says it should be. Refusing to produce numbers off a wrong clock.');
    console.log(L.join('\n')); process.exit(3);
  }
  if (a.assertOpen && a.assertOpen !== 'auto' && hist.modal !== a.assertOpen) {
    L.push('', `FATAL: --assert-open ${a.assertOpen} but the modal first bar is ${hist.modal}.`,
           '  The declared source zone is almost certainly wrong. Refusing to produce numbers.');
    console.log(L.join('\n')); process.exit(3);
  }

  if (issues.errors.length || issues.warnings.length) {
    L.push('', 'DATA VALIDATION');
    for (const e of issues.errors) L.push(`  ERROR   ${e.kind}  n=${e.n || 1}  ${e.msg || ''}`);
    for (const w of issues.warnings) L.push(`  warn    ${w.kind}  n=${w.n || ''}  ${w.msg || ''}`);
  }
  if (issues.fatal) {
    L.push('', 'Refusing to run: a truncated or corrupt CSV looks exactly like a strategy',
           'that stopped trading, and would produce a confident wrong answer.');
    console.log(L.join('\n')); process.exit(3);
  }
  if (a.validateOnly) { L.push('', '--validate-only: stopping here.'); console.log(L.join('\n')); return; }

  // ------------------------------------------------------------ indicators
  const ctx = {
    tfMin: Math.round(meta.tfMs / 60000),
    rsi: I.rsi(bars, 14),
    frac: I.fractals(bars),
    atr: I.atr(bars, 14),
    spreadPrice: medianSpreadPrice(bars, specs, cfg),
    minBoxPts: cfg.minBoxPts
  };
  if (a.minBox === 'auto') {
    ctx.minBoxPts = RES.autoMinBox(ctx.spreadPrice, cfg);
    L.push('', `--min-box auto: median spread ${ctx.spreadPrice.toFixed(2)} index pts, ` +
               `MAX_FEE_BURDEN_R ${cfg.maxFeeBurdenR} -> min box ${ctx.minBoxPts.toFixed(1)} pts ` +
               `(vs the specified ${cfg.minBoxPts})`);
  }

  // ------------------------------------------------------------- run
  const { signals, dispositions, tags } = STRAT.collectSignals(bars, windows, cfg, ctx);
  const trades = RES.resolve(signals, bars, tags, windows, { ...cfg, tfMs: meta.tfMs }, specs);

  // ------------------------------------------------------------- funnel
  L.push('', 'SESSION FUNNEL', '-'.repeat(78));
  const counts = {};
  for (const d of dispositions) counts[d.disposition] = (counts[d.disposition] || 0) + 1;
  const order = ['incomplete_box', 'box_too_small', 'chop_timeout', 'expired', 'no_retest',
                 'traversed', 'divergence_veto', 'session_end', 'no_data', 'entered'];
  const nonSession = counts['no_session'] || 0;
  const realSessions = dispositions.length - nonSession;
  if (nonSession) {
    L.push(`  ${pad('window-days with no open', 34)}${lpad(nonSession, 6)}   (instrument not trading at the open — excluded)`);
  }
  L.push(`  ${pad('tradeable session-windows', 34)}${lpad(realSessions, 6)}`);
  for (const k of order) {
    if (!counts[k]) continue;
    const label = k === 'entered' ? 'ENTERED' : `skipped: ${k}`;
    const share = realSessions ? `  ${(counts[k] / realSessions * 100).toFixed(0)}%` : '';
    L.push(`  ${pad(label, 34)}${lpad(counts[k], 6)}${lpad(share, 6)}${k === 'box_too_small' ? '  <- Option A' : k === 'chop_timeout' ? '  <- Option B' : ''}`);
  }
  const nStd = trades.filter(t => t.branch === 'standard').length;
  const nRev = trades.filter(t => t.branch === 'reversal').length;
  L.push(`  ${pad('', 34)}${lpad('', 6)}   (standard ${nStd}, reversal ${nRev})`);

  if (!trades.length) {
    L.push('', 'No trades. Nothing further to report.');
    console.log(L.join('\n')); return;
  }

  // ----------------------------------------------------- break-even table
  const meanCost = mean(trades.map(t => t.costR));
  L.push('', 'THE NUMBER THAT DECIDES THIS', '-'.repeat(78));
  L.push(`  mean cost           ${meanCost.toFixed(4)}R   ` +
         `(median spread ${ctx.spreadPrice.toFixed(2)} idx pts, mean risk ${mean(trades.map(t => t.riskPts)).toFixed(1)} pts)`);
  for (const tr of [1.0, cfg.targetR].filter((v, i, s) => s.indexOf(v) === i)) {
    L.push(`  break-even @${tr.toFixed(1)}R      ${(RES.breakEvenWinRate(tr, meanCost) * 100).toFixed(1)}%`);
  }
  const winRate = trades.filter(t => t.netR > 0).length / trades.length;
  L.push(`  ACHIEVED win rate   ${(winRate * 100).toFixed(1)}%   ` +
         `${winRate >= RES.breakEvenWinRate(cfg.targetR, meanCost) ? '<- clears break-even' : '<- BELOW break-even'}`);

  // ------------------------------------------------------------ R table
  L.push('', 'R-MULTIPLES  (contract-independent; BAL-NET is direction-balanced)', '-'.repeat(78));
  L.push(`  ${pad('group', 22)}${lpad('n', 5)}${lpad('L/S', 8)}${lpad('win%', 7)}` +
         `${lpad('boxPts', 8)}${lpad('riskPts', 9)}${lpad('costR', 8)}${lpad('NET R', 9)}${lpad('BAL-NET', 10)}   95% CI`);
  const groups = [];
  groups.push(['ALL', trades]);
  for (const b of ['standard', 'reversal']) {
    const g = trades.filter(t => t.branch === b);
    if (g.length) groups.push([`  ${b}`, g]);
  }
  for (const w of windows) {
    const g = trades.filter(t => t.window === w.name);
    if (g.length) groups.push([`  window ${w.name}`, g]);
  }
  for (const [name, g] of groups) L.push(rowFor(name, g));

  // ------------------------------------------------------ measurement notes
  const bothN = trades.filter(t => t.bothTouched).length;
  const adverseN = trades.filter(t => t.openAdverse).length;
  const flooredN = trades.filter(t => t.riskFloored).length;
  L.push('', 'MEASUREMENT CAVEATS', '-'.repeat(78));
  L.push(`  both-touched bars   ${bothN} (${(bothN / trades.length * 100).toFixed(1)}%) booked as STOPS.`);
  L.push(`                      That percentage IS the size of the pessimism in every number above.`);
  L.push(`  fill mode           ${cfg.fill} (${trades[0].fillNote})`);
  if (cfg.fill === 'edge') {
    L.push(`                      WARNING: --fill=edge is twice optimistic. It assumes the limit was`);
    L.push(`                      resting before the retest bar closed, and it still counts only bars that`);
    L.push(`                      closed outside the box — a real resting limit is also filled by touches`);
    L.push(`                      that close back inside, and those are the losers. Treat as an upper bound.`);
  }
  if (adverseN) L.push(`  adverse fills       ${adverseN} filled back inside the edge — the real cost of a close-based signal.`);
  if (flooredN) L.push(`  risk floored        ${flooredN} reversal stops were too tight and were widened to spread/${cfg.maxFeeBurdenR}.`);
  L.push(`  cost basis          ${meta.hasSpread ? 'MEASURED per-bar broker spread' : `ASSUMED constant ${cfg.assumedSpreadPts} pts — not measured`}`);
  if (cfg.divergence !== 'off') {
    const strictN = trades.filter(t => t.branch === 'reversal' && t.divergenceStrict === false).length;
    L.push(`  divergence          mode=${cfg.divergence}, lookback ${cfg.divLookback} bars, tolerance ${cfg.divTolerance}xATR`);
    if (strictN) L.push(`                      ${strictN} of ${nRev} reversals came ONLY from the tolerant rule (equal highs/lows),`);
    if (strictN) L.push(`                      which js/indicators.js divergence() would have returned 'none' for.`);
  }

  // --------------------------------------------------------- dollar block
  if (specs.pointValue != null) {
    L.push('', `DOLLARS ON $${(a.initial || 5000).toLocaleString()}  (compliance simulation)`, '-'.repeat(78));
    L.push(`  ${pad('granularity / risk', 26)}${lpad('net P&L', 12)}${lpad('return', 9)}` +
           `${lpad('maxDD', 8)}${lpad('worstDay', 10)}${lpad('trailDD', 9)}${lpad('streak', 8)}  verdict`);
    for (const mode of ['fractional', 'minlot', 'skip']) {
      for (const comp of [true, false]) {
        const e = EQ.runEquity(trades, {
          initial: a.initial || 5000, riskPct: (a.riskPct != null ? +a.riskPct : 0.5) / 100,
          pointValue: specs.pointValue, pointSize: specs.pointSize,
          minLot: specs.minLot, lotStep: specs.lotStep, mode, compounding: comp, tfMs: meta.tfMs
        });
        if (!e.records.length) continue;
        const dd = EQ.drawdownStats(e.floating);
        const daily = EQ.dailyDrawdown(e.floating, a.accountingZone || tz.DEFAULT_ACCOUNTING_ZONE, 0.04);
        const trail = EQ.trailingDrawdown(e.floating);
        const streak = EQ.maxLossStreak(e.records);
        const breach = dd.maxDrawdownPct > 0.10 || (daily.worst && daily.worst.ddPct > 0.04);
        L.push(`  ${pad(mode + (comp ? ' / compounding' : ' / fixed'), 26)}` +
               `${lpad('$' + e.netProfit.toFixed(0), 12)}${lpad(pct(e.returnPct), 9)}` +
               `${lpad(pct(dd.maxDrawdownPct), 8)}${lpad(pct(daily.worst ? daily.worst.ddPct : 0), 10)}` +
               `${lpad(pct(trail), 9)}${lpad(streak, 8)}  ${breach ? 'BREACH' : 'PASS'}`);
        if (mode === 'minlot' && comp) {
          L.push(`      ${e.unattainableCount} trades could not reach the 0.5% target size and were over-risked at minLot;` +
                 ` ${e.skippedCount} skipped under 'skip'.`);
          const bs = EQ.bootstrap(e.records, { seed: a.seed || 42, initial: a.initial || 5000,
                                               riskPct: (a.riskPct != null ? +a.riskPct : 0.5) / 100, compounding: comp });
          if (bs) {
            L.push('', '  BOOTSTRAP (10,000 resamples — one realised path is a single draw from this)');
            L.push(`      ${pad('max drawdown %', 20)}observed ${pct(dd.maxDrawdownPct)}   median ${pct(bs.maxDrawdown.median)}   ` +
                   `p95 ${pct(bs.maxDrawdown.p95)}   P(breach 10%) = ${bs.maxDrawdown.pBreach.toFixed(2)}`);
            L.push(`      ${pad('worst daily DD %', 20)}observed ${pct(daily.worst ? daily.worst.ddPct : 0)}   median ${pct(bs.dailyDrawdown.median)}   ` +
                   `p95 ${pct(bs.dailyDrawdown.p95)}   P(breach 4%)  = ${bs.dailyDrawdown.pBreach.toFixed(2)}`);
            L.push(`      ${pad('max loss streak', 20)}observed ${lpad(streak, 4)}       median ${lpad(bs.lossStreak.median, 4)}      ` +
                   `p95 ${lpad(bs.lossStreak.p95, 4)}`);
            L.push('');
          }
        }
      }
    }
  } else {
    L.push('', 'No --point-value given, so the dollar/compliance block is omitted.',
           'R-multiples above are complete and contract-independent.');
  }

  // ------------------------------------------------------------- closing
  L.push('', 'READ THIS BEFORE QUOTING ANY NUMBER ABOVE', '-'.repeat(78));
  const all = EQ.balancedCI(trades) || EQ.ci95(trades.map(t => t.netR));
  if (all) {
    const excludesZero = (all.lo > 0 || all.hi < 0);
    L.push(`  n=${trades.length}. Direction-balanced net expectancy ${sg(all.m)}R, 95% CI [${sg(all.lo)}, ${sg(all.hi)}].`);
    L.push(`  This interval ${excludesZero ? 'EXCLUDES' : 'INCLUDES'} zero` +
           `${excludesZero ? '.' : ' — the data does not establish an edge in either direction.'}`);
  }
  L.push(`  At this sample size the 95% half-width is ~${(1.96 * 1.10 / Math.sqrt(trades.length)).toFixed(3)}R, so any true edge`);
  L.push(`  smaller than that cannot be distinguished from zero by this dataset. Cross-instrument`);
  L.push(`  replication (tools/orb-crossval.js) is a stronger test than more bars of the same series.`);
  if (synthetic && meta.mode === 'flat') {
    L.push('', '  NEGATIVE CONTROL (mode=flat, driftless walk). Expected net expectancy is');
    L.push('  about -' + meanCost.toFixed(4) + 'R: you pay the spread and a driftless walk gives nothing back.');
    L.push('  A clearly POSITIVE result here means the HARNESS is broken, not that an edge exists.');
  } else if (synthetic) {
    L.push('', '  POSITIVE CONTROL (mode=' + meta.mode + '). This generator injects real drift on trend');
    L.push('  days, so a breakout strategy SHOULD measure positive here. That proves the machine can');
    L.push('  detect an edge when one exists; it says nothing about FTSE.');
  }
  console.log(L.join('\n'));
}

// ----------------------------------------------------------------- helpers
function rowFor(name, g) {
  const bal = EQ.balancedCI(g);
  const ci = EQ.ci95(g.map(t => t.netR));
  const use = bal || ci;
  const nL = g.filter(t => t.dir === 1).length, nS = g.length - nL;
  const few = g.length < 30 ? ' (too few)' : '';
  return `  ${pad(name, 22)}${lpad(g.length, 5)}${lpad(nL + '/' + nS, 8)}` +
         `${lpad((g.filter(t => t.netR > 0).length / g.length * 100).toFixed(0) + '%', 7)}` +
         `${lpad(mean(g.map(t => t.boxPts)).toFixed(1), 8)}` +
         `${lpad(mean(g.map(t => t.riskPts)).toFixed(1), 9)}` +
         `${lpad(mean(g.map(t => t.costR)).toFixed(3), 8)}` +
         `${lpad(sg(mean(g.map(t => t.netR))), 9)}` +
         `${lpad(bal ? sg(bal.m) : '     --', 10)}   ` +
         (use ? `[${sg(use.lo)}, ${sg(use.hi)}]${few}` : '--');
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function medianSpreadPrice(bars, specs, cfg) {
  const v = [];
  for (const b of bars) {
    const sp = b.spreadPts != null ? b.spreadPts : cfg.assumedSpreadPts;
    if (sp != null && sp > 0) v.push(sp * specs.pointSize);
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function usage(code = 0) {
  console.log(`
node tools/orb-backtest.js --bars <csv> [options]

  --bars <path>          5M bar CSV (MT5 time,o,h,l,c,v,spread or generic timestamp,open,...)
  --tz-in <zone>         REQUIRED for naive timestamps. IANA name preferred (Europe/Helsinki).
  --assert-open HH:MM    Fail unless the modal first-bar-of-day matches (timezone gate).
  --validate-only        Load, validate, print the zone check, stop.
  --specs <csv>          Broker specs file (point size, point value, min lot, lot step).
  --point-size / --point-value / --min-lot / --lot-step
  --symbol <name>        Row to read from the specs file.

  --min-box <pts|auto>   Option A floor (default 12). 'auto' derives it from measured spread.
  --chop-mins <n>        Option B: clean break required within n min of box close (default 60).
  --expiry-mins <n>      Box validity from box close (default 90).
  --sl-buffer <pts>      Stop distance beyond the opposite edge (default 2).
  --target-r <r>         Take profit in R (default 1.2).
  --fill close|nextopen|edge      Default nextopen (conservative).
  --retest strict|twobar          Default strict.
  --divergence off|filter|reverse Default off (the baseline).
  --reversal-stop divergence-pivot|boxedge|excursion
  --windows london=08:00@Europe/London,us=09:30@America/New_York

  --synthetic [--seed n] Mechanism test on a seeded random walk. NOT strategy evidence.
`);
  process.exit(code);
}

if (require.main === module) main();
module.exports = { main };
