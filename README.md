# Wicktor — Multi-timeframe crypto & xStock screener

## Running it
Open `index.html` directly in a browser. No build step, no server required.
(If your browser blocks local script loading for any reason, run `python3 -m http.server`
from this folder and visit `http://localhost:8000` instead.)

## Data sources (all free, no key required except FMP news)
- **Bybit v5 API** — spot + perpetual candles/tickers, covers both coins and xStocks (symbols ending in "x")
- **CoinGecko** — global market cap/dominance, top sector, per-coin market cap (best-effort symbol match)
- **alternative.me** — Fear & Greed Index
- **FMP (Financial Modeling Prep)** — news, lazy-loaded per coin. Add your free API key in Settings
  (gear icon, top right). 250 requests/day free tier.

## What's real vs. stubbed
- Indicator engine (Alligator/AO/Fractals/RSI/divergence), scoring, UI, filters, watchlist,
  theme, settings, and news are all fully wired and tested (synthetic data + headless browser).
- **Token unlock detection is stubbed** (`unlock: null` in `js/app.js`). The DefiLlama unlocks
  API needs a coin-symbol → protocol-slug mapping I couldn't verify without live network access.
  Wiring this up for real is the natural next step — the UI, coloring, and band-label override
  logic are already built and waiting for real data (see `Api.unlockInfo()` in `js/api.js`).
- I have no live network access in the environment this was built in, so while every endpoint
  is implemented against documented API shapes and passed a full mocked-response test, the
  *live* calls need verifying in your actual browser. Open the browser console on first run
  and watch for any `[Api]` warnings — those point at exactly which call needs adjusting.

## Structure
- `index.html` — page shell
- `css/style.css` — full design system (dark/light)
- `js/indicators.js` — raw indicator math (unit-tested)
- `js/scoring.js` — Trade Quality Score + Continuation/Exhaustion/Reversal breakdown (unit-tested)
- `js/api.js` — all external data fetching, fails soft on any single source
- `js/render.js` — DOM rendering (cards, top strip, modal)
- `js/app.js` — orchestration, filters, watchlist, settings, refresh loop
