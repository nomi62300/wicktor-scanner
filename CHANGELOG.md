# Changelog

All notable changes to Wicktor are documented in this file, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This
project uses [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-08-23

### Added
- Maintenance-mode overlay: a hard, full-screen gate shown to every
  visitor, checked before and independent of the access-code gate — even
  someone with a currently-valid code sees this, not the app. Controlled
  by a single `MAINTENANCE_MODE` flag in `js/app.js`. Currently **on**,
  as part of a planned lockdown ahead of a larger update — no scan, no
  access gate, nothing reachable while it's active.

### Changed
- Rotated the beta access code as part of the same lockdown. The new code
  is deliberately not distributed yet. Re-verified live (per standing
  process, since this exact rotation had regressed silently once before):
  the old code is rejected, a browser previously granted access under the
  old code is correctly re-locked, and the new code grants access
  correctly.

## [1.2.3] - 2026-08-17

### Fixed
- "Top Sectors · 7D" and "Narratives · 7d" were two separate top-strip
  tiles built from the exact same underlying sector-ranking data, just
  sliced to different lengths (top 3 vs top 4) — genuinely redundant,
  most visible when only 1-2 sectors resolve and both tiles show the
  identical single entry. Consolidated into one "Top Sectors · 7D" tile.

## [1.2.2] - 2026-08-17

### Fixed
- Scans were still taking 30-40+ seconds even after v1.1.2's circuit
  breaker/time-budget fix — that fix correctly *bounded* the sector-fetch
  loop instead of letting it stall forever, but it was still sitting
  inside the scan's initial blocking `Promise.all`, so every scan paid up
  to its full ~20s budget before the actual card-grid work (universe
  building + coin analysis, which only takes ~5-8s on its own) even
  started. Decoupled sector/narrative fetching from the scan's critical
  path entirely — it now resolves independently and updates the top strip
  whenever it's ready, without blocking anything else. Narrative coin-
  sourcing becomes best-effort (only fires if sector data already resolved
  by the time universe-building finishes; picked up on the next scan
  otherwise). Verified live: scans now complete in ~13-19s total even
  while CoinGecko's sector endpoint was independently confirmed fully down
  (0/16 categories succeeding) in the same test — the core scan no longer
  waits on it at all.

## [1.2.1] - 2026-08-16

### Added
- Keep-warm safeguard for the Supabase project backing the CMC proxy:
  a scheduled GitHub Actions workflow (every 3 days) pings a new `ping`
  path on the Edge Function, which returns immediately without calling
  CMC or spending credits. The CMC fallback only fires when CoinGecko
  fails, which is irregular — this keeps comfortable margin under
  Supabase free tier's 7-day inactivity auto-pause so the fallback isn't
  asleep exactly when an extended CoinGecko outage needs it.

## [1.2.0] - 2026-08-16

### Added
- CoinMarketCap fallback for global mcap/dominance and per-coin market
  caps, used only when CoinGecko fails outright. Proxied through a
  Supabase Edge Function (`supabase/functions/cmc-proxy`) so the real CMC
  key never reaches client-side code — the function itself whitelists the
  two allowed CMC endpoints and restricts CORS to Wicktor's real deployed
  origins, so a leaked function URL can't be used to hit arbitrary CMC
  endpoints or drain quota from an unrelated site. Verified live under
  real, still-degraded CoinGecko conditions: both `coingeckoGlobal()` and
  `coingeckoMarketCaps()` failed on every CoinGecko call and correctly
  fell back to CMC, returning valid data (987 coins mapped, correct BTC
  dominance and total market cap).
- First backend component for Wicktor (a Supabase project) — the CMC
  proxy is step one; the same project is intended to carry future auth/
  paid-tier work rather than being single-purpose.

## [1.1.2] - 2026-08-16

### Fixed
- Scans could feel "stuck" for 60+ seconds and climbing — a real regression
  from v1.1.1's own retry logic. That fix assumed CoinGecko failures were
  transient, but live testing showed a *sustained* bad stretch makes an
  unbounded retry loop the problem: every one of the 16 sector categories
  paying its own multi-attempt backoff compounds into minutes with zero
  cards rendered. Added a circuit breaker (3 consecutive category failures
  → stop retrying for the rest of that scan) and a hard 20s time budget on
  the whole sector-fetch loop, so a bad CoinGecko day now degrades to
  "fewer sectors this scan" instead of blocking the scan outright.
  Verified live: a scan that previously exceeded 60s and hadn't finished
  now completes in 38s total, with the breaker/budget logging exactly when
  it engages.

### Changed
- Pulse Spot/Perp and Top Gainers/Losers (sourced from raw Bybit tickers,
  previously refetched on every single scan with no caching) and global
  mcap/dominance (previously a 5-min cache) now both follow a 30-min
  refresh cadence instead — this data doesn't meaningfully move minute-to-
  minute, and refetching it every scan was needless load with no benefit.

## [1.1.1] - 2026-08-15

### Fixed
- Top Sectors · 7D recurring "not loading" bug — root-caused via live
  diagnosis (curl succeeded on the exact same CoinGecko request that had
  just failed in-browser, confirming a transient rate-limit/CORS drop, not
  a hard outage). Two compounding gaps: `cgCategoryList()` — a single
  request every narrative keyword match depends on — had no retry, so one
  transient failure zeroed out all matches at once; and
  `sectorPerformance7d()` cached that empty result unconditionally for its
  full 4h TTL, turning a one-off blip into a 4-hour outage instead of a
  retry on the next scan a minute later. Added retry-with-backoff to both,
  and stopped caching empty/failed results.

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
