'use strict';
/* ==========================================================================
   Wicktor — wall-clock zone handling for session-anchored strategies.

   WHY THIS EXISTS. An opening-range box is anchored to an exchange's LOCAL
   open: 08:00 London, 09:30 New York. The UK runs BST (UTC+1) from late
   March to late October, so a hardcoded UTC hour puts the box an hour off
   the open for roughly seven months of any twelve-month backtest — and
   silently, because the code still produces boxes, trades and a plausible
   report. That is worse than crashing.

   THE CORE RULE: conversion is ONE-DIRECTIONAL. UTC instant -> local
   fields, never local wall clock -> UTC. Session boundaries are expressed
   as MINUTES SINCE LOCAL MIDNIGHT and compared against each bar's tagged
   local minutes. DST then handles itself: the 08:00 London box is 07:00Z in
   July and 08:00Z in January, and neither number appears anywhere in the
   code. It also means the reverse direction's two pathologies — local times
   that do not exist (spring forward) and local times that happen twice
   (autumn back) — can never arise, because no local time is ever converted
   back to an instant.

   PERFORMANCE. One cached Intl.DateTimeFormat per zone, locale 'sv-SE',
   which emits "2025-07-15 08:00:00" directly so the result is parsed by
   splitting on three separators rather than walking formatToParts.
   Measured in this container: ~33ms per 30k timestamps (formatToParts:
   ~91ms). That is fast enough to tag every bar in one linear pass at load,
   so the hot loops read plain integers. DO NOT "optimise" this into a
   hand-rolled DST transition table — that is precisely where an off-by-one
   at the boundary hides, and the measurement above says there is nothing
   to win.

   Read-only. No I/O, no CLI.
   ========================================================================== */

const MIN_MS = 60000;
const DAY_MIN = 1440;

// ---------------------------------------------------------------- zone spec
/**
 * Accepts an IANA name ('Europe/London') or a fixed offset ('UTC+3',
 * 'UTC-04:30', '+02:00'). Fixed offsets are honest about what they are: a
 * constant, which for an MT5 server running EET/EEST is WRONG for half the
 * year. Prefer the IANA name wherever the true zone is known.
 */
function resolveZone(spec) {
  if (spec == null || spec === '') throw new Error('resolveZone: no zone given');
  if (typeof spec === 'object' && spec.kind) return spec;
  const s = String(spec).trim();

  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const h = parseInt(m[2], 10);
    const mi = m[3] ? parseInt(m[3], 10) : 0;
    if (h > 14 || mi > 59) throw new Error(`resolveZone: implausible offset "${s}"`);
    return { kind: 'fixed', minutes: sign * (h * 60 + mi), label: s };
  }
  if (/^(UTC|GMT|Z)$/i.test(s)) return { kind: 'fixed', minutes: 0, label: 'UTC' };
  if (!s.includes('/')) throw new Error(`resolveZone: "${s}" is neither an IANA zone name nor a UTC offset`);
  return { kind: 'iana', name: s, label: s };
}

const zoneKey = z => z.kind === 'fixed' ? `fixed:${z.minutes}` : `iana:${z.name}`;

// ------------------------------------------------------------- Intl caching
const FMT = new Map();
function formatterFor(name) {
  let f = FMT.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone: name,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    FMT.set(name, f);
  }
  return f;
}

/**
 * Guard against a small-ICU Node, where an unknown timeZone either throws
 * or — worse, on some builds — silently resolves to UTC. Silent UTC is the
 * dangerous case: every box would sit an hour off all summer and nothing
 * would look wrong. So we check two things, and ABORT rather than degrade.
 */
function assertZoneSupport(zone) {
  const z = resolveZone(zone);
  if (z.kind === 'fixed') return { ok: true, zone: z, dst: false, note: 'fixed offset, no DST' };

  let f;
  try { f = formatterFor(z.name); }
  catch (e) { throw new Error(`Timezone "${z.name}" is not supported by this Node build (${e.message}). A full-ICU Node is required.`); }

  const got = f.resolvedOptions().timeZone;
  if (got !== z.name) {
    throw new Error(`Timezone "${z.name}" silently resolved to "${got}" — this Node has a reduced ICU dataset. Refusing to run: every session boundary would be wrong.`);
  }
  const jan = offsetMinutes(Date.UTC(2025, 0, 15, 12), z);
  const jul = offsetMinutes(Date.UTC(2025, 6, 15, 12), z);
  return { ok: true, zone: z, dst: jan !== jul, janOffset: jan, julOffset: jul,
           note: jan === jul ? 'no DST observed' : `DST: ${jan / 60}h winter, ${jul / 60}h summer` };
}

/**
 * Assert that a zone the caller BELIEVES observes DST actually does. Used
 * for Europe/London and America/New_York, where a no-DST answer means the
 * ICU data is broken rather than that the zone changed.
 */
function assertObservesDst(zone) {
  const r = assertZoneSupport(zone);
  if (r.zone.kind === 'iana' && !r.dst) {
    throw new Error(`Timezone "${r.zone.name}" reports the same UTC offset in January and July. Expected DST. Refusing to run.`);
  }
  return r;
}

// ------------------------------------------------------------ core conversion
/** Local fields for an instant. { ymd:'2025-07-15', minutes:480, dow:0-6 } */
function zonedFields(tsMs, zone) {
  const z = resolveZone(zone);
  if (z.kind === 'fixed') {
    const shifted = tsMs + z.minutes * MIN_MS;
    const d = new Date(shifted);
    return {
      ymd: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      seconds: d.getUTCSeconds(),
      dow: d.getUTCDay()
    };
  }
  const s = formatterFor(z.name).format(new Date(tsMs)); // "2025-07-15 08:00:00"
  const sp = s.indexOf(' ');
  const date = s.slice(0, sp);
  const time = s.slice(sp + 1);
  const hh = +time.slice(0, 2), mm = +time.slice(3, 5), ss = +time.slice(6, 8);
  // dow from the LOCAL calendar date, not the instant — a bar at 23:30 local
  // on a Friday is Friday even when the UTC instant has rolled to Saturday.
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { ymd: date, minutes: hh * 60 + mm, seconds: ss, dow };
}

/** Zone's UTC offset in minutes at a given instant (+60 = one hour ahead). */
function offsetMinutes(tsMs, zone) {
  const z = resolveZone(zone);
  if (z.kind === 'fixed') return z.minutes;
  const f = zonedFields(tsMs, z);
  const asUtc = Date.parse(`${f.ymd}T${p2(Math.floor(f.minutes / 60))}:${p2(f.minutes % 60)}:${p2(f.seconds)}Z`);
  return Math.round((asUtc - tsMs) / MIN_MS);
}

/**
 * One linear pass, one Intl call per bar. Returns an array PARALLEL to
 * `bars` rather than mutating them, so the same bar array can carry tags
 * for several zones at once (London and New York windows share one series)
 * without property-name collisions.
 */
function tagBars(bars, zone) {
  const z = resolveZone(zone);
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = zonedFields(bars[i].t, z);
  return out;
}

const p2 = n => (n < 10 ? '0' : '') + n;

/** "08:00" / "9:30" -> minutes since local midnight. */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`parseHHMM: expected HH:MM, got "${s}"`);
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) throw new Error(`parseHHMM: out of range "${s}"`);
  return h * 60 + mi;
}
const fmtHHMM = mins => `${p2(Math.floor(mins / 60) % 24)}:${p2(mins % 60)}`;

// ------------------------------------------------------------------- windows
/**
 * Each window carries its OWN zone. This is not redundancy: UK and US
 * daylight-saving transitions are one to three weeks apart, so for about
 * three weeks a year 09:30 New York is NOT 14:30 London. Expressing the US
 * box as a London time would silently shift it across those weeks — the
 * same class of bug as hardcoding a UTC hour, just rarer and therefore
 * harder to notice.
 *
 * boxMin   length of the opening-range candle (15M).
 * chopMin  Option B: a clean break must occur within this many minutes of
 *          box close, else the session is abandoned as structural chop.
 * expiryMin the box "extends right" this long from box close; no entry after.
 * flatMin  local time an open position is marked to market and closed.
 */
const DEFAULT_WINDOWS = [
  { name: 'london', zone: 'Europe/London',    openMin: 8 * 60,      boxMin: 15, chopMin: 60, expiryMin: 90, flatMin: 16 * 60 + 25 },
  { name: 'us',     zone: 'America/New_York', openMin: 9 * 60 + 30, boxMin: 15, chopMin: 60, expiryMin: 90, flatMin: 15 * 60 + 55 }
];

/** `--windows london=08:00@Europe/London,us=09:30@America/New_York` */
function parseWindows(spec, base = DEFAULT_WINDOWS) {
  if (!spec) return base.map(w => ({ ...w }));
  return String(spec).split(',').map(part => {
    const m = /^([A-Za-z0-9_-]+)=(\d{1,2}:\d{2})(?:@(\S+))?$/.exec(part.trim());
    if (!m) throw new Error(`--windows: cannot parse "${part}" (expected name=HH:MM[@Zone])`);
    const known = base.find(w => w.name === m[1]);
    return {
      ...(known || base[0]),
      name: m[1],
      openMin: parseHHMM(m[2]),
      zone: m[3] || (known ? known.zone : base[0].zone)
    };
  });
}

/** The accounting day a prop firm's daily drawdown resets on. */
const DEFAULT_ACCOUNTING_ZONE = 'America/New_York';

module.exports = {
  resolveZone, zoneKey, assertZoneSupport, assertObservesDst,
  zonedFields, offsetMinutes, tagBars,
  parseHHMM, fmtHHMM,
  DEFAULT_WINDOWS, parseWindows, DEFAULT_ACCOUNTING_ZONE,
  DAY_MIN, MIN_MS
};
