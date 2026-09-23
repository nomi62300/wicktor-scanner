# CWT London Alligator — EUR/USD

Two implementations of one strategy: a **Pine v5 strategy** to watch signals fire on your own
chart, and a **Node backtest** to get numbers worth acting on. They implement the same rules;
where they differ, the backtest is the authority, because TradingView's free plan cannot hold
enough history to measure anything.

## The rules, as you specified them

Monday–Friday, EUR/USD. At the London open let the 15M candle form, then drop to 5M and read
the Alligator (13/8/5, displaced 8/5/3) plus the pivot support/resistance lines.

| # | Situation | Entry | Stop | Target |
|---|---|---|---|---|
| 1 | Clean fan at the decision bar | Fan direction, on the close 20 min after the open | Just beyond the **jaw** | 1:1 |
| 2 | Tangled, previous trend clear | The **previous** fan direction | Just beyond the **S/R line** | 1:1 |
| 3 | Tangled, previous trend also unclear | Wait **15–45 min**, take the direction it forms | Just beyond the **S/R line** | 1:1 |
| 4 | After a stop | Wait **15–45 min**, re-confirm, re-enter | Beyond the **jaw** (configurable) | 1:1 |

## Why the free plan can't answer this

TradingView Basic caps history at **5,000 bars**. On EUR/USD 5M that is about **17 trading
days** — roughly 17 London sessions. A 17-trade sample has a 95% confidence interval near
**±0.5R**, far wider than any edge worth having. Use the Pine version to confirm the signals
land where your screenshots say they should, and the Node version for statistics.

## The number that decides this strategy

At a 1:1 target the break-even win rate is `(1 + costR) / 2` — **always above 50%**, before
anything else happens. Your OANDA quote widget shows a **1.5 pip** spread:

| Stop distance | costR | Break-even win rate |
|---|---|---|
| 10 pips | 0.150 | **57.5%** |
| 15 pips | 0.100 | **55.0%** |
| 20 pips | 0.075 | 53.8% |
| 25 pips | 0.060 | 53.0% |
| 40 pips | 0.037 | 51.9% |

The tighter the stop, the higher the bar. Read this line in the report before the P&L.

## Interpretations I had to pin down

Your rules are visual; code needs numbers. Each of these is a judgement, so each is a
parameter and each is swept in `--sensitivity` rather than fixed by fiat.

| Rule as written | As implemented | Default |
|---|---|---|
| "Alligator pointing downwards" | `lips < teeth < jaw` **and** the jaw falling over `slopeLook` bars | 3 bars |
| "Tangled" | line spread `< tangleMult × ATR(14)` | 0.5 |
| "Previous trend" | most recent clean fan within `priorLookback` bars | 24 (2h) |
| "A little above/below" | `slBufferPips` beyond the level | 3 pips |
| "Wait for the alligator" | first clean fan in the 15–45 min window | 15 / 45 |
| Re-entry stop, "jaw **or** S/R" | jaw, matching case 1's geometry | `--reentry-stop=jaw\|sr\|wider` |
| Max trades per day | initial + re-entries | 3 |
| Session end | flat, London | 16:30 |

## Three things about the indicator worth knowing

**The Alligator is read as drawn.** `plot(x, offset=8)` paints the value computed at bar `t`
over bar `t+8`, so what your eye reads at bar `t` was computed 8 bars earlier. Since your
rules are visual, the logic uses those displaced values. They are *older* data, so this can
never be lookahead — it is strictly more conservative than using the raw averages.

**The S/R lines look older on a chart than they were.** A `pivot(15,15)` needs 15 bars to its
right to confirm, and the indicator plots it back at the pivot with `offset=-(rightBars+1)`.
So a level visible at 09:00 did not exist until 80 minutes after the point it appears to start
from. The strategy reads it causally — the value is genuinely known when used — but do not
judge a missed setup by where the line seems to begin.

**ZigZag is deliberately absent.** No entry rule uses it, and its `repaint` input defaults to
`true`. A repainting component inside a strategy produces backtest results that cannot be
reproduced live, so including it would add risk for no signal.

## Running it

### TradingView

Pine Editor → paste `tools/pine/cwt-london-alligator.pine` → Add to chart. Set the chart to
**EUR/USD, 5 minute**. Check the info table top-right reads **pip size 0.0001** before
trusting any stop, and watch the bottom row — it turns red when you are against the 5,000-bar
cap, which is the point at which the Strategy Tester numbers stop being evidence.

### The backtest

Export `EURUSDm` from Exness with `tools/mt5/ExportBars.mq5` (drag onto a EURUSDm chart; it
takes the symbol from the chart, nothing to edit). Copy the CSVs into `data/`, then:

```bash
# 1. Prove the timezone first. Exness servers are usually UTC.
node tools/cwt-backtest.js --bars data/EURUSDm_M5.csv --specs data/EURUSDm_specs.csv \
     --symbol EURUSDm --tz-in UTC --assert-open auto --validate-only

# 2. The run
node tools/cwt-backtest.js --bars data/EURUSDm_M5.csv --specs data/EURUSDm_specs.csv \
     --symbol EURUSDm --tz-in UTC --sl-buffer-pips 3 --tangle-mult 0.5

# 3. One variation at a time
node tools/cwt-backtest.js ... --sl-buffer-pips 5
node tools/cwt-backtest.js ... --tangle-mult 0.8
node tools/cwt-backtest.js ... --max-trades 1      # no re-entries: is the core signal any good?
node tools/cwt-backtest.js ... --reentry-stop sr
```

The validator prints a volume-by-hour profile in London time. EUR/USD trades ~24h, so the
"first bar of the day" check is useless here; what identifies the zone is the **London open's
volume footprint**. If the step-up is not at 08:00, the declared zone is wrong and every
session would be read off the wrong bars.

### Controls

```bash
node tools/cwt-backtest.js --synthetic --seed 42               # negative: must land at ~ -costR
node tools/cwt-backtest.js --synthetic --mode trend --seed 42  # positive: must be clearly > 0
```

`flat` is a driftless random walk, which has no edge by construction — the harness must
measure zero gross expectancy there, and a ~50% win rate, because 1:1 barriers are symmetric.
A clearly positive result means the harness is broken, not that an edge was found. Verified
over 6 seeds: gross **+0.016R, t = 0.94**.

## What one year can and cannot establish

One London session a day, ~250 a year, plus re-entries — call it 250–400 trades. Per-trade σ
for a 1R/−1R binary is ≈1.0, so a year gives a 95% half-width near **±0.06R**. That is
genuinely useful, better than the FTSE box test, because there is a setup nearly every day.

But the four cases are **four different strategies sharing a session**. Split 300 trades
across clean-fan / prior-trend / waited / re-entry and each cell has n in the tens, with a CI
several times wider. The report marks anything under 30 `(too few)`. Do not pick a winner from
one small cell — that is how a backtest gets fitted to noise.
