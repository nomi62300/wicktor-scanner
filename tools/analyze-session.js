#!/usr/bin/env node
/* ==========================================================================
   Wicktor — does time-of-day / session predict outcome?

   The second "2.6" article claimed the setup "performs within appropriate
   market session," specifically London open interacting with the Asia
   range. We have never checked whether session or hour-of-day affects our
   own signals at all. Cheap to test — the fixtures already carry UTC
   timestamps — so it is tested rather than taken on faith.

   Sessions (UTC, the conventional FX definitions):
     Asia    00:00–08:00
     London  07:00–16:00
     NY      12:00–21:00
     (hours outside all three: the dead Pacific stretch, 21:00–24:00)
   London/Asia overlap (07:00–08:00) is the specific "London open meets the
   Asia range" window the article calls out, tested on its own too.

   Crypto trades 24/7 with no session close, so there is a real chance none
   of this holds — measured, not assumed either way.

   Direction-balanced, both fixture sets, minScore=80 (EXCELLENT — the only
   band shown tradeable). Read-only.

   Usage: node tools/analyze-session.js [fixture] [minScore]
   ========================================================================== */

const fs = require('fs');
const path = require('path');
global.Indicators = require('../js/indicators.js');
const Scoring = require('../js/scoring.js');
const I = global.Indicators;
const { closedIndexAt, TF_MS } = require('./lib/align.js');

const WIN = 200, WARMUP = 90, HOLD = 48;
const TAKER = 0.11;
const hydrate = t => t ? t.map(([a, o, h, l, c, v]) => ({ t: a, o, h, l, c, v })) : null;
const wd = (arr, end) => arr.slice(Math.max(0, end - WIN + 1), end + 1);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sg = x => x == null ? '    --' : (x >= 0 ? '+' : '') + x.toFixed(4);


function balanced(rows, key) {
  const b = mean(rows.filter(r => r.dir === 1).map(r => r[key]));
  const s = mean(rows.filter(r => r.dir === -1).map(r => r[key]));
  return (b != null && s != null) ? (b + s) / 2 : null;
}

function sessionOf(hourUtc) {
  const asia = hourUtc >= 0 && hourUtc < 8;
  const london = hourUtc >= 7 && hourUtc < 16;
  const ny = hourUtc >= 12 && hourUtc < 21;
  if (london && asia) return 'london/asia overlap';
  if (london && ny) return 'london/ny overlap';
  if (london) return 'london only';
  if (ny) return 'ny only';
  if (asia) return 'asia only';
  return 'dead (21-24 UTC)';
}

function collect(file, minScore) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const w of fx.windows) {
    for (const coin of w.coins) {
      const m5 = hydrate(coin.candles.m5), m15 = hydrate(coin.candles.m15), h1 = hydrate(coin.candles.h1);
      if (!m5 || !m15 || !h1 || m5.length < WARMUP + HOLD + 6) continue;
      const open = { 1: -1, '-1': -1 };
      for (let i = WARMUP; i < m5.length - HOLD - 1; i++) {
        const ts = m5[i].t, c15 = closedIndexAt(m15, ts, TF_MS.m15), c1h = closedIndexAt(h1, ts, TF_MS.h1);
        if (c15 < WARMUP || c1h < 60) continue;
        const sn = [I.analyzeTimeframe(wd(h1, c1h)), I.analyzeTimeframe(wd(m15, c15)), I.analyzeTimeframe(wd(m5, i))];
        if (!sn[0] || !sn[2]) continue;
        const r = Scoring.evaluateSnapshots(sn, { mode: 'scalp' });
        if (!r || !r.setupDirection || r.score < minScore || !r.riskReward) continue;
        if (i < open[r.setupDirection]) continue;
        open[r.setupDirection] = i + HOLD;

        const rr = r.riskReward, dir = r.setupDirection, entryPx = m5[i + 1].o;
        const risk = Math.abs(rr.entry - rr.stop);
        if (!risk) continue;
        const stop = entryPx - dir * risk, target = entryPx + dir * risk * rr.ratio;
        const end = Math.min(i + 1 + HOLD, m5.length - 1);
        let out = (dir * (m5[end].c - entryPx)) / risk;
        for (let k = i + 2; k <= end; k++) {
          const b = m5[k];
          if (dir === 1 ? b.l <= stop : b.h >= stop) { out = -1; break; }
          if (dir === 1 ? b.h >= target : b.l <= target) { out = rr.ratio; break; }
        }
        const hourUtc = new Date(m5[i + 1].t).getUTCHours();
        rows.push({
          dir, r: out, net: out - TAKER / (risk / entryPx * 100),
          hourUtc, session: sessionOf(hourUtc)
        });
      }
    }
  }
  return rows;
}

function report(label, rows) {
  const n = rows.length;
  if (!n) { console.log(`${label.padEnd(22)} n=0`); return; }
  const win = rows.filter(r => r.r > 0).length / n * 100;
  console.log(
    `${label.padEnd(22)} n=${String(n).padStart(5)}  win ${win.toFixed(1).padStart(5)}%` +
    `  gross ${sg(balanced(rows, 'r'))}  NET ${sg(balanced(rows, 'net'))}`
  );
}

function main() {
  const file = process.argv[2] || 'market-oos.json';
  const minScore = Number(process.argv[3] || 80);
  const full = path.join(__dirname, 'fixtures', file);
  console.log(`\n${file}  minScore=${minScore}  (direction-balanced, NET of ${TAKER}% taker)`);

  const rows = collect(full, minScore);
  console.log('-'.repeat(80));
  report('ALL', rows);

  console.log('\nby session:');
  for (const s of ['asia only', 'london only', 'london/asia overlap', 'london/ny overlap', 'ny only', 'dead (21-24 UTC)']) {
    report(s, rows.filter(r => r.session === s));
  }

  console.log('\nby UTC hour of entry:');
  for (let h = 0; h < 24; h++) {
    report(`${String(h).padStart(2, '0')}:00 UTC`, rows.filter(r => r.hourUtc === h));
  }

  console.log('\n"London open meets Asia range" specifically (07:00-08:00 UTC) vs rest:');
  report('07:00-08:00 UTC', rows.filter(r => r.hourUtc === 7));
  report('everything else', rows.filter(r => r.hourUtc !== 7));
  console.log();
}

main();
