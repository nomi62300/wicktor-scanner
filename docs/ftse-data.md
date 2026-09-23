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

## Route 1 — MT5 export from your own broker (best quality)

This is the route the repo already assumes: `tools/mt5-crossval.js:36` lists `'UK100.s'`
and `tools/mt5-squeeze.js:70` already reads a broker specs file.

It is the best route **because of the spread column**. Break-even win rate at a 1.2R
target moves from 45.5% at zero cost to 53.0% at a 2-point spread — so a guessed constant
spread does not produce a weaker answer, it produces a different one. MT5 records the real
spread on every bar.

**Use `tools/mt5/ExportBars.mq5`.** Open it in MetaEditor, press F7 to compile, then drag
"ExportBars" from the Navigator onto a chart of your index. It takes the symbol from the chart
it is attached to, so it needs no editing.

It writes `<SYMBOL>_M5.csv`, `<SYMBOL>_M1.csv`, `<SYMBOL>_M15.csv` (each
`time,o,h,l,c,v,spread`) plus `<SYMBOL>_specs.csv` carrying point size, tick value, min lot,
lot step and the server name. It waits for the terminal to finish syncing history first —
without that a fresh chart returns a few hundred bars and the export looks exactly like a
market that stopped trading.

### You do NOT need to change brokers

Nothing in the ORB harness is broker-specific. `tools/orb-backtest.js` takes `--bars <any
path>` and `--specs <any path>`; the loader sniffs the header rather than matching a filename.

The `Bybit-Live-4_` prefix you may have seen is hardcoded only in the OLDER tools
(`tools/mt5-squeeze.js:53`, `tools/mt5-backtest.js:76`), where it was just the MT5 account
name baked into a filename during the gold/crypto work. It is not a requirement and the new
harness ignores it.

**Stay on the account you actually trade.** If your ORB script runs on an Exness demo, export
from Exness: the spread column is then *your* spread, on *your* feed, and the backtest answers
the question you care about. Moving the terminal to a different broker would point it at a
different symbol set with its own separately-downloaded history, and would stop anything
already running on the old account — for no gain, since a different broker's feed answers a
different question.

Symbol names differ between brokers (`UK100`, `UK100m`, `FTSE100`, `UK100.s`). The script uses
whatever the chart says, so just pass the same name through:

```bash
node tools/orb-backtest.js --bars data/UK100m_M5.csv --specs data/UK100m_specs.csv \
     --symbol UK100m --tz-in <your server zone>
```

If `--symbol` is omitted it is inferred from the filename up to the first underscore, which is
why the script names files that way.

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
