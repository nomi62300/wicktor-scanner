# Getting FTSE/UK100 bars into the ORB harness

The engine is finished and tested. **Real numbers are gated on bars**, and nothing
else. This is how to supply them.

The backtest was built in a cloud container whose egress policy blocks every market-data
host (Dukascopy, Yahoo, Stooq, TwelveData, AlphaVantage, Finnhub, EODHD, HistData,
Nasdaq Data Link, HuggingFace) **and** `pypi.org` / `registry.npmjs.org`. `git clone` of
public GitHub repos works, but no public repo carries FTSE intraday bars —
`philipperemy/FX-1-Minute-Data` lists UKX but is a 296 KB *downloader* pointed at the
blocked histdata.com. So the data has to come from you, or from an environment with a
wider network policy.

---

## Route 1 — MT5 export of `UK100.s` (best quality)

This is the route the repo already assumes: `tools/mt5-crossval.js:36` lists `'UK100.s'`
and `tools/mt5-squeeze.js:70` already reads a broker specs file.

It is the best route **because of the spread column**. Break-even win rate at a 1.2R
target moves from 45.5% at zero cost to 53.0% at a 2-point spread — so a guessed constant
spread does not produce a weaker answer, it produces a different one. MT5 records the real
spread on every bar.

Run this as a script in MetaEditor (`MQL5/Scripts/`), attach it to a UK100 chart:

```mql5
void OnStart() {
   string sym = "UK100.s";                       // your broker's exact symbol
   ENUM_TIMEFRAMES tfs[] = {PERIOD_M1, PERIOD_M5, PERIOD_M15};
   string names[] = {"M1", "M5", "M15"};

   for (int k = 0; k < ArraySize(tfs); k++) {
      MqlRates r[];
      int n = CopyRates(sym, tfs[k], 0, 200000, r);      // ~2 years of M5
      if (n <= 0) { Print("CopyRates failed for ", names[k], " err=", GetLastError()); continue; }

      int h = FileOpen(sym + "_" + names[k] + ".csv", FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
      if (h == INVALID_HANDLE) { Print("FileOpen failed"); continue; }
      FileWrite(h, "time", "o", "h", "l", "c", "v", "spread");
      for (int i = 0; i < n; i++)
         FileWrite(h, TimeToString(r[i].time, TIME_DATE|TIME_MINUTES|TIME_SECONDS),
                   r[i].open, r[i].high, r[i].low, r[i].close,
                   (long)r[i].tick_volume, (int)r[i].spread);
      FileClose(h);
      Print("wrote ", n, " ", names[k], " bars");
   }

   // The specs file. Point size is NOT inferable from price decimals — an index
   // printing "10734" reads as 0 decimals and yields a point 100x too large.
   int s = FileOpen(sym + "_specs.csv", FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
   FileWrite(s, "symbol", "point", "point_value", "volume_min", "volume_step");
   FileWrite(s, sym,
             SymbolInfoDouble(sym, SYMBOL_POINT),
             SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE),
             SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN),
             SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP));
   FileClose(s);
}
```

Files land in `MQL5/Files/`. Copy them into `data/` in this repo and commit them — they
are the evidence, so `data/` is deliberately **not** gitignored.

**You must also tell the harness the server timezone.** MT5 writes *server* time, usually
EET/EEST, which is itself DST-shifting — so `UTC+2` is wrong for half the year and `UTC+3`
for the other half. Use the IANA name:

```bash
node tools/orb-backtest.js --bars data/UK100.s_M5.csv \
     --tz-in Europe/Helsinki --assert-open 08:00 --validate-only
```

`--validate-only` prints a histogram of each day's first bar in London wall clock. If your
zone is right it piles up on `08:00`. If it is wrong the table is visibly wrong, and
`--assert-open` turns that into a non-zero exit code. Check `Tools → Options → Server` or
just try `Europe/Helsinki`, `Europe/Athens`, `Europe/Riga` — the histogram settles it in
seconds.

Then the real run:

```bash
node tools/orb-backtest.js --bars data/UK100.s_M5.csv --tz-in Europe/Helsinki \
     --specs data/UK100.s_specs.csv --symbol UK100.s \
     --min-box 12 --chop-mins 60 --sl-buffer 2 --target-r 1.2 --divergence off
```

---

## Route 2 — widen the environment's network policy (no laptop needed)

Egress is chosen per *environment* when it is created
([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). An environment that
permits `datafeed.dukascopy.com` lets a future session fetch UK100 bars directly, with no
export step and no laptop. **This is the only route that unblocks automation while you are
away from your machine**, and it is worth setting up regardless of which route supplies
the first dataset.

---

## Route 3 — Dukascopy from your laptop

`crypto-news-bot` already depends on `dukascopy-python`, and maps index instruments at
`fetch_news.py:1378` (no UK100 entry yet — that is the hook). Free and long history, but
it is Dukascopy's CFD feed rather than your broker's, so spreads and fills will not match
where you would actually trade. Export OHLC — the existing helper returns daily closes
only — write it as `timestamp,open,high,low,close,volume`, and pass `--tz-in UTC` plus an
explicit `--assumed-spread`, which the report will label as assumed rather than measured.

---

## Until then

```bash
node tools/orb-synth.js --seed 42 --self-check      # grid + volatility calibration
node tools/orb-backtest.js --synthetic --seed 42    # negative control
node tools/orb-backtest.js --synthetic --mode trend # positive control
```

`--synthetic` defaults to `mode=flat`, a driftless random walk, which is the **negative
control**: expectancy must come back at roughly `-costR`, because you pay the spread and a
driftless walk gives nothing back. A clearly positive result there means the harness is
broken, not that an edge was found. `--mode trend` injects real drift and is the
**positive control**: a breakout system should profit, which proves the machine can detect
an edge when one exists.

Neither says anything about FTSE. They are tests of the instrument, not of the market.
