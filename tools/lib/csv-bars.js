'use strict';
/* ==========================================================================
   Wicktor — bar CSV loader, validator and timezone self-check.

   One loader, two accepted layouts, and a hard refusal to guess.

   THE SILENT FAILURE THIS IS BUILT AGAINST: a CSV of naive local timestamps
   ("2025.07.15 09:00:00") read as UTC. Nothing errors. Every bar is simply
   filed under the wrong wall-clock minute, every opening-range box is
   measured off the wrong candle, and the backtest reports a confident
   number for a strategy that was never tested. So a naive timestamp with no
   declared source zone is an ERROR here, never a default to UTC. MT5 in
   particular writes SERVER time — commonly EET/EEST, itself DST-shifting,
   so "UTC+2" is wrong half the year and "UTC+3" the other half. Note that
   tools/mt5-backtest.js deliberately ignores absolute zone ("only ordering
   and cross-timeframe alignment matter"); that was true there and is false
   here, because this strategy is anchored to an exchange's local clock.

   THE SELF-CHECK: firstBarHistogram() renders the first bar of each trading
   day in the TARGET session's wall clock. For a cash index that table should
   pile up on the open. If the declared source zone is wrong the table is
   visibly wrong — everything on 07:00, or the summer and winter halves
   splitting in two. That turns an unverifiable assumption into a five-second
   eyeball check with no network access required.

   Read-only. No CLI.
   ========================================================================== */

const fs = require('fs');
const tz = require('./tz.js');

// ------------------------------------------------------------------ header
const ALIASES = {
  t:        ['t', 'time', 'timestamp', 'date', 'datetime', '<date>', 'date_time', 'opentime', 'open_time'],
  o:        ['o', 'open', '<open>'],
  h:        ['h', 'high', '<high>'],
  l:        ['l', 'low', '<low>'],
  c:        ['c', 'close', '<close>'],
  v:        ['v', 'vol', 'volume', 'tickvol', '<vol>', '<tickvol>'],
  spreadPts:['spread', 'spread_points', 'spreadpts', 'spreadpoints', '<spread>']
};

function sniffHeader(line) {
  const cols = splitCsv(line).map(s => s.trim().toLowerCase().replace(/^"|"$/g, ''));
  const idx = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const at = cols.findIndex(c => names.includes(c));
    if (at >= 0) idx[field] = at;
  }
  for (const req of ['t', 'o', 'h', 'l', 'c']) {
    if (idx[req] == null) {
      throw new Error(`csv-bars: header has no column for "${req}". Saw: ${cols.join(', ')}\n` +
        `Accepted names for ${req}: ${ALIASES[req].join(', ')}`);
    }
  }
  return { idx, cols };
}

// MT5 exports occasionally use tab or semicolon. Detect on the header row.
function detectDelimiter(line) {
  const counts = [[',', (line.match(/,/g) || []).length],
                  ['\t', (line.match(/\t/g) || []).length],
                  [';', (line.match(/;/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}
let DELIM = ',';
const splitCsv = line => line.split(DELIM);

// --------------------------------------------------------------- timestamps
/**
 * Returns { ms, naive } — `naive` true when the literal carried no zone and
 * the caller's declared source zone had to be applied.
 */
function parseTimestamp(raw, zone) {
  const s = String(raw).trim().replace(/^"|"$/g, '');

  if (/^\d{13}$/.test(s)) return { ms: +s, naive: false };
  if (/^\d{10}$/.test(s)) return { ms: +s * 1000, naive: false };

  // Absolute: trailing Z or an explicit +HH:MM / -HH:MM offset.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) && /[T ]/.test(s)) {
    const ms = Date.parse(s.replace(' ', 'T'));
    if (!Number.isFinite(ms)) throw new Error(`csv-bars: unparseable timestamp "${s}"`);
    return { ms, naive: false };
  }

  // Naive. MT5 dotted "2025.07.15 09:00:00" or ISO-ish "2025-07-15 09:00".
  let m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(s);
  if (!m) throw new Error(`csv-bars: unrecognised timestamp format "${s}"`);

  const [Y, M, D, H = '00', Mi = '00', S = '00'] = m.slice(1).map(x => x == null ? undefined : x);
  if (zone == null) {
    throw new Error(
      `csv-bars: timestamp "${s}" carries no timezone.\n` +
      `  Declare the file's source zone with --tz-in (IANA name preferred, e.g. --tz-in Europe/Helsinki,\n` +
      `  or a fixed offset such as --tz-in UTC+3). Refusing to assume UTC: guessing wrong here shifts\n` +
      `  every session box without producing any visible error.`);
  }
  return { ms: naiveToUtc(+Y, +M, +D, +H, +Mi, +S, zone), naive: true };
}

/**
 * Naive local fields -> UTC instant. The one place this module converts in
 * the "forbidden" direction, and it is deliberately paranoid about it.
 *
 * Guess by subtracting the offset in effect at the naive instant read as
 * UTC, then re-read the offset AT THE GUESS and correct once. Verify by
 * round-tripping. A mismatch means the local time is inside a DST fold (it
 * either does not exist or happens twice) — for a cash-session bar that
 * should be impossible, so it is reported rather than silently resolved.
 */
function naiveToUtc(Y, M, D, H, Mi, S, zone) {
  const z = tz.resolveZone(zone);
  const asIfUtc = Date.UTC(Y, M - 1, D, H, Mi, S);
  if (z.kind === 'fixed') return asIfUtc - z.minutes * tz.MIN_MS;

  let guess = asIfUtc - tz.offsetMinutes(asIfUtc, z) * tz.MIN_MS;
  guess = asIfUtc - tz.offsetMinutes(guess, z) * tz.MIN_MS;

  const back = tz.zonedFields(guess, z);
  const want = `${Y}-${p2(M)}-${p2(D)}`;
  const wantMin = H * 60 + Mi;
  if (back.ymd !== want || back.minutes !== wantMin) {
    const e = new Error(
      `csv-bars: local time ${want} ${p2(H)}:${p2(Mi)} does not round-trip in zone ${z.label} ` +
      `(got ${back.ymd} ${tz.fmtHHMM(back.minutes)}). This timestamp falls in a daylight-saving ` +
      `fold. Check --tz-in.`);
    e.dstFold = true;
    throw e;
  }
  return guess;
}
const p2 = n => (n < 10 ? '0' : '') + n;

// -------------------------------------------------------------------- load
/**
 * loadBars(path, { tzIn, tfMs }) -> { bars, meta, issues }
 * bar = { t (epoch ms UTC), o, h, l, c, v, spreadPts }
 */
function loadBars(filePath, opts = {}) {
  const { tzIn = null } = opts;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) throw new Error(`csv-bars: ${filePath} has no data rows`);

  DELIM = detectDelimiter(lines[0]);
  const { idx, cols } = sniffHeader(lines[0]);
  const zone = tzIn == null ? null : tz.resolveZone(tzIn);

  const bars = [];
  let naiveCount = 0;
  const parseErrors = [];
  for (let i = 1; i < lines.length; i++) {
    const p = splitCsv(lines[i]);
    let ts;
    try { ts = parseTimestamp(p[idx.t], zone); }
    catch (e) {
      if (parseErrors.length < 5) parseErrors.push(`line ${i + 1}: ${e.message.split('\n')[0]}`);
      if (e.dstFold || parseErrors.length >= 5) { if (!e.dstFold) continue; }
      if (/no timezone/.test(e.message)) throw e;   // fatal, not a bad row
      continue;
    }
    if (ts.naive) naiveCount++;
    const num = k => { const v = parseFloat(p[idx[k]]); return Number.isFinite(v) ? v : NaN; };
    bars.push({
      t: ts.ms,
      o: num('o'), h: num('h'), l: num('l'), c: num('c'),
      v: idx.v != null ? (parseFloat(p[idx.v]) || 0) : 0,
      spreadPts: idx.spreadPts != null ? (parseFloat(p[idx.spreadPts]) || 0) : null
    });
  }

  bars.sort((a, b) => a.t - b.t);
  const meta = {
    file: filePath, columns: cols, delimiter: DELIM,
    hasSpread: idx.spreadPts != null,
    sourceZone: zone ? zone.label : 'absolute (epoch/offset in file)',
    naiveRows: naiveCount, rows: bars.length,
    from: bars.length ? bars[0].t : null,
    to: bars.length ? bars[bars.length - 1].t : null,
    tfMs: opts.tfMs || inferTfMs(bars),
    parseErrors
  };
  return { bars, meta, issues: validateBars(bars, meta) };
}

/** Modal positive gap — robust to weekends and holidays, unlike a mean. */
function inferTfMs(bars) {
  const counts = new Map();
  for (let i = 1; i < bars.length && i < 5000; i++) {
    const d = bars[i].t - bars[i - 1].t;
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return best;
}

// ---------------------------------------------------------------- validate
function validateBars(bars, meta) {
  const errors = [], warnings = [];
  const sample = (arr, n = 5) => arr.slice(0, n);
  const tfMs = meta.tfMs;

  if (!bars.length) { errors.push({ kind: 'empty', msg: 'no bars parsed' }); return { errors, warnings, fatal: true }; }

  const dupes = [], nonMono = [], offGrid = [], ohlcBad = [], jumps = [], gapsInDay = [], gapsBenign = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!Number.isFinite(b.o) || !Number.isFinite(b.h) || !Number.isFinite(b.l) || !Number.isFinite(b.c) ||
        b.h < Math.max(b.o, b.c) - 1e-9 || b.l > Math.min(b.o, b.c) + 1e-9 || b.h < b.l ||
        b.o <= 0 || b.c <= 0) {
      ohlcBad.push({ i, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    if (i > 0) {
      const d = b.t - bars[i - 1].t;
      if (d === 0) dupes.push({ i, t: b.t });
      else if (d < 0) nonMono.push({ i, t: b.t });
      else if (tfMs && d > tfMs) {
        // A gap spanning a weekend or an overnight close is expected; a gap
        // of a few bars inside one local day is a hole in the data and will
        // silently shrink a box or hide a breakout.
        (d <= tfMs * 6 ? gapsInDay : gapsBenign).push({ i, t: b.t, missing: Math.round(d / tfMs) - 1 });
      }
      if (Number.isFinite(b.c) && Number.isFinite(bars[i - 1].c) && bars[i - 1].c > 0) {
        const jump = Math.abs(b.c - bars[i - 1].c) / bars[i - 1].c;
        if (jump > 0.05 && d === tfMs) jumps.push({ i, t: b.t, pct: +(jump * 100).toFixed(2) });
      }
    }
    if (tfMs && b.t % tfMs !== 0) offGrid.push({ i, t: b.t });
  }

  if (dupes.length)   errors.push({ kind: 'duplicate_timestamps', n: dupes.length, sample: sample(dupes) });
  if (nonMono.length) errors.push({ kind: 'non_monotonic', n: nonMono.length, sample: sample(nonMono) });
  if (ohlcBad.length) errors.push({ kind: 'ohlc_integrity', n: ohlcBad.length, sample: sample(ohlcBad) });
  if (offGrid.length) warnings.push({ kind: 'off_grid_timestamps', n: offGrid.length, sample: sample(offGrid) });
  if (gapsInDay.length) warnings.push({ kind: 'intraday_gaps', n: gapsInDay.length, sample: sample(gapsInDay),
    msg: 'missing bars inside a trading day — boxes spanning these will be wrong' });
  if (gapsBenign.length) warnings.push({ kind: 'session_gaps', n: gapsBenign.length, msg: 'overnight/weekend gaps (expected)' });
  if (jumps.length) warnings.push({ kind: 'price_jumps', n: jumps.length, sample: sample(jumps),
    msg: '>5% move on a single bar — bad tick, wrong instrument, or an unadjusted splice' });
  if (meta.parseErrors && meta.parseErrors.length) warnings.push({ kind: 'parse_errors', sample: meta.parseErrors });

  return { errors, warnings, fatal: errors.length > 0 };
}

/**
 * Bars per local trading day. Days materially short of the median are
 * SUSPECT: a half-session or a partial export looks exactly like a quiet
 * market, and both shrink boxes.
 */
function dayHistogram(bars, zone, minCompleteness = 0.8) {
  const tags = tz.tagBars(bars, zone);
  const perDay = new Map();
  for (let i = 0; i < bars.length; i++) {
    const d = tags[i].ymd;
    if (!perDay.has(d)) perDay.set(d, { ymd: d, n: 0, firstMin: tags[i].minutes, dow: tags[i].dow });
    const e = perDay.get(d);
    e.n++;
    if (tags[i].minutes < e.firstMin) e.firstMin = tags[i].minutes;
  }
  const days = [...perDay.values()].sort((a, b) => a.ymd < b.ymd ? -1 : 1);
  const counts = days.map(d => d.n).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const floor = median * minCompleteness;
  for (const d of days) d.suspect = d.n < floor;
  return { days, median, floor, suspectCount: days.filter(d => d.suspect).length, tags };
}

/**
 * The timezone self-check. Histogram of each day's FIRST bar, in the target
 * session's wall clock. A correct --tz-in piles up on the cash open.
 */
function firstBarHistogram(bars, targetZone, opts = {}) {
  const { days } = dayHistogram(bars, targetZone, opts.minCompleteness || 0.8);
  const hist = new Map();
  for (const d of days) {
    const k = tz.fmtHHMM(d.firstMin);
    if (!hist.has(k)) hist.set(k, { hhmm: k, n: 0, examples: [] });
    const e = hist.get(k);
    e.n++;
    if (e.examples.length < 3) e.examples.push(d.ymd);
  }
  const rows = [...hist.values()].sort((a, b) => b.n - a.n);
  return { rows, totalDays: days.length, modal: rows.length ? rows[0].hhmm : null };
}

function renderFirstBarHistogram(h, targetZoneLabel, expectHHMM) {
  const out = [`First bar per day, in ${targetZoneLabel} wall clock (${h.totalDays} days):`];
  for (const r of h.rows.slice(0, 8)) {
    const mark = expectHHMM && r.hhmm === expectHHMM ? '  <-- expected open' : '';
    out.push(`  ${r.hhmm}  ${String(r.n).padStart(4)} days   ${r.examples.join(', ')}${mark}`);
  }
  if (h.rows.length > 8) out.push(`  ... ${h.rows.length - 8} more distinct start times`);
  return out.join('\n');
}

/**
 * The box is one 15M candle; its high/low is also the max/min of its three
 * 5M bars. When both series are supplied they MUST agree — a disagreement
 * means the exports have different session boundaries or one has a hole,
 * which shifts every box without erroring anywhere.
 */
function crossCheckBox(m5, m15, tolerance = 1e-6) {
  const by15 = new Map();
  for (const b of m15) by15.set(b.t, b);
  const mismatches = [];
  let checked = 0;
  for (const [t, b15] of by15) {
    const kids = m5.filter(x => x.t >= t && x.t < t + 15 * 60000);
    if (kids.length !== 3) continue;
    checked++;
    const hi = Math.max(...kids.map(k => k.h)), lo = Math.min(...kids.map(k => k.l));
    if (Math.abs(hi - b15.h) > tolerance || Math.abs(lo - b15.l) > tolerance) {
      if (mismatches.length < 5) mismatches.push({ t, m15: { h: b15.h, l: b15.l }, m5agg: { h: hi, l: lo } });
    }
  }
  return { checked, mismatchCount: mismatches.length, sample: mismatches };
}

// ------------------------------------------------------------- point sizing
/**
 * spreadPts and pointSize are DIFFERENT quantities and mixing them is a 10x
 * cost error. A recorded spread of 15 on UK100 (pointSize 0.1) is 1.5 INDEX
 * points, not 15. pointValue (currency per index point per lot) is a third,
 * separate broker fact. Per the warning in tools/mt5-squeeze.js:70, never
 * infer point size from the decimals in a close price: an index printing
 * "10734" reads as 0 decimals and yields a point 100x too large.
 */
function resolveSpecs({ specsFile, symbol, pointSize, pointValue, minLot, lotStep }) {
  let fromFile = {};
  if (specsFile && fs.existsSync(specsFile)) {
    const lines = fs.readFileSync(specsFile, 'utf8').trim().split(/\r?\n/);
    const cols = lines[0].split(',').map(s => s.trim().toLowerCase());
    const col = n => cols.indexOf(n);
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      if (p[col('symbol')] !== symbol) continue;
      const pick = (...names) => { for (const n of names) { const c = col(n); if (c >= 0 && p[c] != null && p[c] !== '') return parseFloat(p[c]); } return undefined; };
      fromFile = {
        pointSize: pick('point', 'pointsize', 'tick_size'),
        pointValue: pick('point_value', 'tick_value', 'contract_value'),
        minLot: pick('volume_min', 'min_lot', 'minlot'),
        lotStep: pick('volume_step', 'lot_step', 'lotstep')
      };
      break;
    }
  }
  const out = {
    pointSize: pointSize ?? fromFile.pointSize,
    pointValue: pointValue ?? fromFile.pointValue,
    minLot: minLot ?? fromFile.minLot ?? 0.1,
    lotStep: lotStep ?? fromFile.lotStep ?? 0.1,
    source: (pointSize != null ? 'cli' : (fromFile.pointSize != null ? 'specs file' : 'MISSING'))
  };
  if (out.pointSize == null || !(out.pointSize > 0)) {
    throw new Error(
      'csv-bars: point size unknown.\n' +
      '  Supply --specs <Bybit-Live-4_specs.csv> or --point-size <n> (UK100 is typically 0.1).\n' +
      '  Refusing to infer it from close-price decimals: an index printing "10734" reads as\n' +
      '  0 decimals and yields a point 100x too large, inflating every spread cost by 100x.');
  }
  return out;
}

module.exports = {
  loadBars, sniffHeader, parseTimestamp, naiveToUtc, validateBars,
  dayHistogram, firstBarHistogram, renderFirstBarHistogram,
  crossCheckBox, resolveSpecs, inferTfMs
};
