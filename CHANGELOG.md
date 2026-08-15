# Changelog

All notable changes to Wicktor are documented in this file, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This
project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-15

### Added
- Top Sectors · 7D strip tile now shows the top 3 performing sectors
  instead of just the single top-ranked one.
- Tweet-sourced news items (CryptoFlash articles whose source is an X/
  Twitter status link) now show a small X badge next to the source, so
  they read visibly differently from articles.

### Fixed
- `isXStock()` never actually matched real tokenized-stock symbols —
  Bybit uses uppercase `X` (`AAPLXUSDT`), not the lowercase `x` the old
  regex checked for, so the Include Stocks toggle silently returned
  nothing and stock tickers leaked into crypto-only calculations. Replaced
  with a cached lookup against Bybit's own authoritative `symbolType`
  field.
- News feed was silently failing on every scan: the feed's GitHub Pages
  now sits behind a custom domain with a valid cert but HTTPS enforcement
  off, so the old fetch URL 301-redirected to `http://`, which browsers
  block as mixed content on Wicktor's HTTPS-served page. Fixed by fetching
  the working HTTPS URL directly.
- Rotating the beta access code didn't revoke previously-granted access —
  anyone who'd unlocked the gate once kept access forever regardless of
  later code changes. The granted flag now stores the hash of the code
  that granted it, checked against the current code on every load, so
  rotating the code now revokes everyone, not just new visitors.

### Changed
- Detail modal's news section now always shows exactly 2 items at full
  height; anything beyond that sits behind a "See more" toggle in a fixed
  160px scrollable area, so the card's height no longer grows with how
  much news a coin has.
- The "2TF/3TF alligator aligned (N weakening)" score breakdown line now
  names which timeframe is weakening (e.g. "15M weakening") instead of
  just a count.

## [1.0.0] - 2026-08-10

First versioned release — versioning starts here going forward, covering
the app as it stands after the beta-prep round of fixes and additions.

### Added
- First-visit onboarding tour (via driver.js) walking new testers through
  the main screen, re-triggerable anytime from Settings → Take the tour.
- Feedback link in Settings, pointing to the beta feedback form.
- Visible app version number in Settings.
- Beta access-code gate so the live URL isn't open to random visitors.

### Fixed
- Watchlist star button wasn't visually updating on click — the toggle
  itself worked, but the star's state was a stale scan-time snapshot.
- Top strip (Pulse Spot/Perp, Top Gainers/Losers) went empty whenever a
  scan-category toggle (Crypto Spot/Stocks/Perps) was switched off — now
  sourced independently from Bybit's ticker data regardless of toggle state.
- Top Sector · 7D was always empty due to a CoinGecko API field-name
  mismatch (`category_id`, not `id`) silently 404ing every request.
- News matching missed comma-joined ticker entries (e.g. `"ADA,XRP"`) and
  tokenized-stock symbols (e.g. `AAPLxUSDT`).

### Changed
- TF-direction indicators now use small SVG icons instead of Unicode
  arrow glyphs, which rendered thin/illegible at small sizes on some
  devices.
