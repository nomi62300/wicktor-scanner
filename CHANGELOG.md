# Changelog

All notable changes to Wicktor are documented in this file, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This
project uses [Semantic Versioning](https://semver.org/).

## [Unreleased] - on branch `terminal-build/phase-0-1`

Phase 0 + Phase 1 done unsupervised overnight; Phase 2, Phase 6, Phase 7,
Phase 8, outcome-logging, OI 15m%, the extended 7-TF panel, the
CoinPaprika fallback tier, sloped regression-channel levels, all of
Phase 5 Stages 0-4 (strategy-enrichment indicator math through
advanced-tier scoring — the full 12-strategy batch), Phase 3 (real
Supabase Auth + account-scoped watchlist), and a Flows 1Y column added
in follow-up sessions with the owner present. Deliberately left
unmerged on a branch pending review, per standing branch discipline
(`main` auto-deploys live). Not version-bumped or tagged; that happens
at merge time.

### Removed (Audit F5 — dead snapshot fields)
`analyzeTimeframe()` was returning 15 fields no caller ever read:
`macdSeries`/`stochSeries` (full 100-element series × 3 TF × 120 coins —
the worst offenders), `bbSqueeze` (a 20-bar loop computed and discarded),
`adxPrev`, `plusDI`, `minusDI`, `tenkanKijunBullishCross`, `macdLine`,
`macdSignal`, `bbMiddle`, `bbBandwidth`, `stochK`, `stochD`, `tenkan`,
`kijun`. Stage 3's MACD/Stochastic divergence ended up reusing
`macdResult.macdLine`/`stochResult.k` locally instead of the exposed
series fields, and the two Stage-1 assertion tests that pinned
`snap.macdLine`/`snap.stochK`/`snap.tenkan` were the only remaining
readers — updated to assert against the underlying indicator functions
directly instead. Confirmed via `git grep` across every non-indicators.js
source file before removal. Zero scoring/UI behavior change — verified
112/112 browser tests and 73/74 Node tests (the 1 failure is the
pre-existing, unrelated `fractals`/`heikinAshi` case). Cuts ~563 KB/scan
of retained-but-unused payload.

### Fixed (Audit F4 — Auth hard-fails if the Supabase CDN is unavailable)
`js/auth.js` called `window.supabase.createClient()` at module-load time
with no guard. Verified: with `window.supabase` undefined (CDN blocked,
offline, outage) it threw a `TypeError` that aborted the whole IIFE,
leaving the global `Auth` unassigned — every later call site (star
clicks, the Watchlist tab, the Account panel) then threw `ReferenceError`
instead of degrading. The scanner itself only survived because the
star-click throw happened to land after the localStorage write — luck of
statement ordering, not design. Now wrapped in try/catch; on failure
`Auth` still exists with a null client, `getUser()`/`init()` resolve to
signed-out state, `signUp`/`signIn` reject with a catchable message the
Account panel's existing error display already renders, and `signOut` is
a no-op. Re-verified by re-running `js/auth.js` standalone under a
`window` with no `supabase` global: `Auth` defines, no throw anywhere in
the call chain.

### Changed (branch-only — preview deploy unlocked)
`MAINTENANCE_MODE` is committed `false` on this branch only, so the new
Vercel preview deploy (`wicktor-terminal-preview`, tracking
`terminal-build/phase-0-1`) is testable without the access code. `main`
is untouched and still locked at `true` — `beta.wicktor.top` never reads
this branch. **Must flip back to `true` before this branch is ever
merged into `main`.**

### Added (Audit F2 — ADX actually wired in)
The original plan specified an ADX Continuation multiplier; it was never
built, and two comments in `scoring.js` incorrectly asserted it existed
(used to justify not re-scoring ADX in Strategy 7). Post-audit measurement
against 38 live coins showed why the Continuation multiplier was the
wrong home for it anyway: `count=3` coins vary across only 1 distinct
Continuation value but 6 distinct ADX bands — ADX is the thing that
actually separates otherwise-identical top candidates, but Continuation
doesn't feed the Trade Quality Score at all (see F1/F3 below), so it
would have had zero effect on ranking regardless.

Wired instead into `tradeQualityScore()`'s `momentumScore`, since ADX
measures trend *strength* (not direction — that's alignment's job):
1H ADX < 20 (weak/ranging, per Wilder's own convention and Strategy 2's
existing `adx>=25` "strong" threshold) subtracts 10, ADX >= 25
(established trend) adds 15, 20-25 (developing) is neutral. At
momentumScore's 0.3 TQS weight that's a ±3 to +4.5 point nudge — present
but not dominant. Both stale comments corrected to point at the real
mechanism. Live-verified against 10 real Bybit symbols (BTC/ETH/SOL/XRP/
DOGE/ADA/LINK/AVAX/INJ/UNI): scores stay bounded 0-100, no crashes,
directionally sane (INJ's 42.8 ADX pushes it up, weak-trend coins get
pulled down). 112/112 browser tests, 73/74 Node tests unchanged.

### Changed (Provider split — CoinPaprika becomes the primary bulk source)
CoinGecko's free tier rate-limits constantly, and that was **not
cosmetic**: sector data feeds `topNarrativeCandidates()` into the scan
universe, so a throttled run silently shrank which coins got scanned. A
live run was observed logging `stopping with 1/16 sectors`, and a patient
out-of-band capture with 4s delays and 4 retries still only completed
10/16. This is a signal-correctness fix.

Split by **capability**, not by feature:
- **CoinPaprika** — primary bulk source: symbol→mcap map, global metrics,
  Dashboard Top-5, and a new fast sector engine feeding the scan
  universe, Top Sectors strip tile, and Heatmap.
- **CoinGecko** — specialist only: the Flows tab's 30D/1Y windows, now
  fetched lazily on tab open instead of during every scan.
- **CMC** — untouched emergency reserve. Its Edge Function was **not**
  modified; it remains metered with a 2-path whitelist.

**Measured result: a full cold scan now issues ZERO CoinGecko requests**
(previously up to 23), replaced by 3 CoinPaprika calls. `marketCapMap()`
cold: 1 request / ~600ms / 961 symbols, versus 4 paginated requests plus
4.5s of inter-page delays. `fastSectorPerformance()`: 2 requests / ~1.1s
for 13 sectors, versus 17 requests under a 20s deadline.

Correctness cross-checks before switching:
- Market-cap-weighted sector math agrees closely where both providers
  returned data — 6 of 8 comparable sectors within 2.8pp (AI +1.7,
  DePIN −0.3, Layer 1 −0.3, Layer 2 −2.0, Meme −2.8, Oracle +1.5).
- Bybit top-120 symbols resolving to a market cap: CoinPaprika 107/120 in
  one request vs CoinGecko 111/120 in four. Live, 18 of 20 rendered cards
  resolve MCap.

Deliberate behaviour changes, each verified rather than assumed:
- **`Privacy` is excluded from the CoinPaprika path.** Its only
  substantive tag, `privacy-security`, conflates privacy with security —
  ZEC/XMR/DASH sit alongside LTC, WLD, FIL and VET, which inflated the
  sector to #2 in the top-4 rotation on non-privacy coins' momentum. The
  strict `privacy` tag is the opposite failure at 3 coins. Privacy still
  works normally on the CoinGecko/Flows path.
- **`Modular Blockchain` and `Data Availability` have no CoinPaprika
  tag** and warn-and-skip, the same contract the CoinGecko path uses.
- **Narrative candidates are now validated against Bybit's live spot
  symbol set** before injection, using the instruments-info response
  `refreshXStockSet()` already fetches (zero extra requests). A sector
  tag is a claim about a token, not about where it trades: `BNSOLUSDT`
  was caught live, and liquid-staking entries (METH/RSETH/CBETH/STETH/
  MSOL) would otherwise pass `isTradeableUsdtPair()` purely because
  "<SYMBOL>USDT" ends in USDT, then burn three Bybit round-trips each.
- **Narrative injection now fires deterministically.** It was previously
  best-effort and, on a cold cache, essentially never ran. The scan
  universe therefore grows more reliably than before — intended, but it
  does mean scans do more work.
- **The candidate set changes materially.** Against the captured
  CoinGecko baseline there was zero overlap, partly because CoinGecko
  failed to fetch six sectors (RWA, Gaming, Metaverse, Liquid Staking,
  Restaking, DeFi) that CoinPaprika returns reliably.
- **Displayed global figures step** (BTC.D 57.0% vs 59.1%, total mcap
  $2.80T vs $2.70T) — different coin coverage, both legitimate.

Flows is now two-phase and merges rather than replaces: CoinPaprika rows
render immediately, then CoinGecko's extended windows merge in per-sector
keyed on name. Verified with CoinGecko fully blocked — Flows still
rendered all 13 rows with `--` in 30D/1Y instead of collapsing to one
row, and the scanner was unaffected. Its note copy now explains that a
`--` means "window unavailable", not "flat".

Known gap: CoinPaprika has no tokenized-stock coverage, so with the
xStocks setting on those cards show `—` for MCap unless the CoinGecko
tier runs. That setting is off by default and `—` is already documented
behaviour for unmatched coins.

Guards added: 30d/1y normalize to `null`, never CoinPaprika's literal
`0`, since `pctCellHtml` only renders `--` for null and a raw 0 would
claim every sector was flat. Implausible symbols (28 in the top 1000,
e.g. `USDC.e`, `BTC.B`, `ZBCN ` with a trailing space) are rejected.
Tag resolution ranks by coin-count rather than array order, which array
order would have gotten wrong for `Infrastructure` (21-coin
"Computing & Cloud Infrastructure" over the 71-coin "Infrastructure").

`tests/runner.html` now loads `js/api.js` and covers all of the above:
112 tests pass, up from 103.

### Added (Phase 3 — real Supabase Auth + account-scoped Watchlist)
Scope explicitly excludes tiering (Phase 4) per the owner's call — no
`tier` column, no gating logic, nothing tiering-shaped. This phase is
Auth + Watchlist only.

- **Real email/password accounts**, additive alongside the existing
  `ACCESS_CODE_HASH` gate (coexist, confirmed with the owner — not a
  replacement). Email confirmation disabled on signup, matching the
  reason password was chosen over magic link in the first place (no
  dependency on Supabase's default email deliverability). New
  `supabase/config.toml` `[auth]`/`[auth.email]` sections, pushed via
  `supabase config push` — confirmed live the previous
  `enable_confirmations` default was actually `true`, which would have
  silently reintroduced the exact email-dependency risk being avoided.
- New `js/auth.js`: Supabase JS client (via CDN, no build step) +
  session management + `watchlist.{list,add,remove}`. New Account panel
  (topbar avatar button, previously decorative/unwired) reusing the
  existing settings-panel visual pattern — sign in / create account /
  sign out.
- New `watchlist` table + RLS policies
  (`supabase/migrations/*_watchlist.sql`), first real database schema
  for this project (Supabase was previously proxy-only). **Found and
  fixed a real bug during live verification**: RLS policies alone don't
  grant access — creating a table via raw SQL (not the Studio table
  editor) leaves `authenticated`/`anon` with zero base SQL-level GRANTs,
  so the first live star-toggle attempt failed with "permission denied
  for table watchlist" (Postgres 42501) despite correct RLS policies.
  Fixed with a second migration adding the missing `GRANT`s.
- New Watchlist tab (6th nav tab): account-scoped, price + 24h% per
  starred symbol (Bybit tickers, same pattern as the rest of the app).
  No sparkline in this pass — scoped down deliberately rather than
  half-built, needs per-symbol historical candles this tab doesn't
  otherwise fetch.
- Existing star-toggle now dual-writes to Supabase when logged in
  (Watchlist tab's data source), while continuing to work exactly as
  before via localStorage when logged out — owner's explicit call,
  with an explicitly flagged future intent to eventually require login
  for starring (not done now, not scope creep if asked for later).
  Clean-slate migration, also owner-confirmed: no import path from the
  pre-existing localStorage watchlist into the new account-scoped table.
- **Security-sensitive — cross-account RLS isolation verified live, not
  skipped**: created two real test accounts. A completely unfiltered
  `select *` on the watchlist table (no `.eq('user_id', ...)` at all)
  while authenticated as account 2 returned zero rows despite account
  1's real starred coin existing in the same table — proof RLS is
  enforced at the database level, not just by client-side query
  filtering. Both test accounts and their test rows deleted after
  verification via the Admin API.
- No new tests added (this phase is UI/infrastructure, not
  scoring/indicator logic) — verified entirely through live signup,
  sign-in, sign-out, star-sync, and the cross-account RLS check above.
  All 103 existing tests still pass, confirming no regression to
  anything scoring-related.

### Added (Phase 8 — News tab, roadmap complete)
- New "News" tab: a plain dense list of the existing Snitch feed
  (`snitch.wicktor.top/news.json`, already integrated for per-card
  badges and the detail-modal's news section) as its own top-level
  surface — confirmed scope with the owner: additional, not a
  replacement. The existing per-card treatment is completely unchanged
  and unaffected (verified live: badges and modal news section both
  still render exactly as before).
- New `Api.allNews(articles, limit=100)`: every article newest-first,
  same normalized shape and sentiment-mapping as the existing
  `newsForSymbol()`, just without the per-symbol ticker filter. New
  `Render.newsFeedHtml()` reuses the exact same `tweetBadgeHtml()`/
  `sentTagHtml()`/`timeAgo()` helpers the modal's news section already
  uses, so both surfaces render news identically. No new fetch path —
  reuses the same `fetchAllNews()` 5-min cache both surfaces already
  share.
- Live-verified: a real scan populated the News tab with real live
  headlines, sources, timestamps, sentiment tags, and ticker tags; the
  Scanner tab's per-card badges and detail-modal news section confirmed
  unaffected; no console errors.

**This completes the full priority list for tonight's session**:
CoinPaprika fallback, sloped regression-channel levels, all of Phase 5
(strategy-enrichment), and Phase 8 (News tab). Wyckoff tagging was
explicitly deferred (parked alongside SMC, needs real research first —
see memory).

### Added (Phase 5 Stage 4 — advanced-tier scoring, strategies 12/13 — batch complete)
- **Strategy 12 (Pullback Retracements)**: 15M EMA trend match + a
  tight pullback to EMA21 (within 0.3x ATR — tighter than Strategy 1's
  0.5x, since this is a precision entry-timing strategy) + RSI 40-60
  (healthy, not already reversal-territory) (+12).
- **Strategy 13 (Liquidity Sweep)**: reuses `liquiditySweepUp`/
  `liquiditySweepDown` from Stage 1. Same "warns against current bias"
  shape as the existing Divergent Bar/Wiseman items, same 15-pt tier as
  Divergent Bar (same wick-rejection family) — a rejection above
  resistance warns against an active uptrend, a reclaim below support
  warns against an active downtrend.
- 7 new targeted tests. Live smoke-tested against real Bybit data, no
  console errors, existing behavior unaffected. All 103 tests pass.

**Phase 5 (strategy-enrichment) is now complete — all 5 stages, all 12
of the owner's original strategies, shipped.** `computeBias()`/
`alignmentCeiling()` were never touched at any stage; every change is
additional Continuation/Exhaustion/Reversal point items, exactly as
scoped.

### Stage 5 review pass (required by the plan, not skipped)
With this many items now able to fire on the same coin, the existing
65/40/50 caps are being hit regularly, not just in edge cases — observed
live tonight (e.g. one real coin's Continuation total reached 85 points
across 5 simultaneously-firing items before the 65 cap trimmed it).
This means some lower-priority signals are effectively getting silently
truncated on strongly-confirming coins. **Flagged for the owner's
review, not rebalanced unilaterally** — deciding which items should
"make room" for others on a maxed-out coin is a product judgment call,
not something to guess at. The caps themselves (`Math.min(65/40/50,
score)`) were already confirmed as intentional hard backstops, not
budgets, per the original plan — this finding is about whether the
*point values* underneath them need rebalancing now that so many items
compete for the same capped total, not about the cap mechanism itself.

### Added (Phase 5 Stage 3 — swing-tier scoring, strategies 6/7/8/9/11)
- **Strategy 6 (Momentum Swing)**: 1H price above/below the Ichimoku
  cloud matching bias (+12); 15M Stochastic entry cross from oversold/
  overbought matching bias (+10).
- **Strategy 7 (Trend Following)**: 1H plain directional MACD cross
  (+12) — no EMA21-pullback requirement, unlike Strategy 1's 15M cross,
  and a different timeframe entirely, so the two don't overlap. The
  strategy's other listed condition, "EMA stack aligned with bias," is
  deliberately NOT re-scored as a second line — only two EMAs exist
  (9/21), so it's the identical underlying signal already scored by
  Strategy 1's "1H EMA 9/21 bullish trend," not a genuinely distinct
  3+-EMA stack. ADX handled via the existing Q1 multiplier design, no
  redundant line here either.
- **Strategy 8 (Trend Reversals)**: MACD turning against the current
  bias while price sits within 1x ATR of an existing fractal-based key
  level (+15, Reversal) — a reversal at a level that matters, not any
  MACD flip. The strategy's RSI-divergence condition reuses the existing
  item unchanged.
- **Strategy 9 (Divergence Play)**: MACD divergence on 1H (+15) and
  Stochastic divergence on 15M (+10), both reusing the existing generic
  `divergence()` function against `macdSeries`/`stochSeries` (added to
  the snapshot in Stage 1 for exactly this) — confirmed no new
  "macdDivergence()" function was needed, since `divergence()` was
  never RSI-specific internally. New `macdDivergence`/`stochDivergence`
  snapshot fields computed once in `analyzeTimeframe()`.
- **Strategy 11 (Range Bound)**: explicitly a non-trending strategy —
  only fires when `bias===0` (1H sleeping), Reversal arm only, never
  Continuation. 5M price at a BB extreme + RSI confirming oversold/
  overbought (+12, mirrored for both directions). Confirmed safe:
  `buildReversal` already computes unconditionally regardless of bias
  (only `alignmentCeiling`/`tradeQualityScore` treat `bias===0`
  specially), so `computeBias()`'s own handling is untouched.
- 18 new targeted tests. Live smoke-tested against real Bybit data:
  a real coin's modal showed "1H Price above Ichimoku cloud" firing
  correctly alongside every earlier-stage item, no console errors, score
  correctly capped. All 100 tests pass.

### Added (Phase 5 Stage 2 — scalping-tier scoring, strategies 1-5)
**This is the first stage in this batch that changes live signal
output** — Stage 0/1 were purely additive/inert; from here on,
`buildContinuation`/`buildExhaustion`/`buildReversal` read the new
Stage 1 fields and can change a coin's Continuation/Exhaustion/Reversal
score and band. `computeBias()`/`alignmentCeiling()` are untouched.
- **Strategy 1 (Scalping EMA)**: 1H EMA9/21 stack matching bias (+10);
  15M MACD cross on a genuine EMA21 pullback, within 0.5x ATR (+14).
- **Strategy 2 (Volatility Breakout)**: 15M BB bandwidth expanding with
  a close outside the band on the bias side (+12), ADX>=25 adds a
  separate confirmation (+8). Approximated: the snapshot only carries
  the current bar's squeeze state, not multi-bar squeeze history, so
  this reads the live expansion+breakout moment rather than
  reconstructing exactly when the squeeze itself started.
  Noted honestly in code comments, not silently overclaimed.
- **Strategy 3 (Breakout Retest)**: 1H price above/below its fractal
  level AND within 0.5x ATR of it (+15, Continuation); the same
  condition with RSI>=70/<=30 scores a separate Reversal trap-risk item
  (+10) — distinct from the existing plain RSI-extreme Exhaustion check
  (different threshold/arm/condition, not a duplicate). Approximated:
  full spec ("broke out within 8 bars, retested, closed back above")
  needs multi-bar candle history the scoring layer doesn't have: this
  reads the live near-level state instead.
- **Strategy 4 (Squeeze Momentum)**: 15M BB expanding + MACD histogram
  matching bias and rising (+14) — oscillator-driven, deliberately
  distinct from Strategy 2's price-driven condition.
- **Strategy 5 (Mean Reversion)**: 5M price at a BB extreme (+8) and a
  Stochastic exhaustion crossover from overbought/oversold (+10),
  Exhaustion arm, bias-independent — two separate lines so a partial
  confirm still shows partial pressure.
- 24 new targeted tests (12 conditions x pass/fail case) verify each
  strategy in isolation. Live smoke-tested against real Bybit data per
  the plan's own requirement for this stage: multiple real coins showed
  the new items firing correctly alongside every existing item, scores
  still correctly capped at 65/40/50, no console errors.

### Added (Phase 5 Stage 1 — strategy-enrichment snapshot wiring)
- Wired the 6 new indicators into `analyzeTimeframe()`'s per-timeframe
  snapshot: last-bar readings (`ema9`/`ema21`, `macdLine`/`macdSignal`/
  `macdHistogram`, `bbUpper`/`bbLower`/`bbMiddle`/`bbPercentB`/
  `bbBandwidth`, `adx`/`plusDI`/`minusDI`, `stochK`/`stochD`,
  `tenkan`/`kijun`/`ichimokuAboveCloud`/`ichimokuBelowCloud`) plus simple
  derived state in the same style as the existing `aoRising`/`acRising`
  pattern (`emaStackBullish`, `macdBullishCross`/`macdBearishCross`/
  `macdHistogramRising`, `bbSqueeze`/`bbExpanding`,
  `stochBullishCrossFromOversold`/`stochBearishCrossFromOverbought`,
  `tenkanKijunBullishCross`, `liquiditySweepUp`/`liquiditySweepDown`).
  Full `macdSeries`/`stochSeries` also carried for Stage 2+'s MACD/
  Stochastic divergence, which reuses the existing `divergence()`
  function directly — it was already fully generic (never RSI-specific
  internally), no new divergence function needed.
- **Still deliberately inert** — nothing in `scoring.js` reads any of
  these fields yet; `Scoring.evaluate()` output is unchanged. Strategy-
  specific combinations (e.g. "pullback within 0.3x ATR of EMA21")
  deliberately NOT computed here — those belong in `scoring.js` in
  Stage 2+, combining these raw readings with a strategy's own
  threshold, not baked into the shared snapshot.
- Verified: new fields match calling the Stage 0 functions directly at
  the same index; `Scoring.evaluate()`'s continuation items contain no
  Stage-1-indicator-derived labels yet. Live-verified: a full scan
  completes normally with cards rendering correctly, no new console
  errors, no visible performance regression despite six new indicators
  now computing per timeframe per coin.

### Added (Flows: 1Y column, MTD/YTD stand-in)
- Added `1y` to `sectorPerformance7d()`'s existing `price_change_percentage`
  request (verified live, same one-request-per-category cost as before)
  and a matching 1Y column in the Flows table and its expanded coin list.
  True calendar-anchored MTD/YTD would need per-coin historical lookups
  (CoinGecko's rolling-window param has no "since a specific date"
  option) — real new cost and complexity across ~a few hundred unique
  coins. Owner's call: 30D (already shipped) + 1Y cover the same
  medium/long-term intent without it. Fully additive — 24h/7d/30d
  columns and all existing callers unchanged.

### Added (Phase 5 Stage 0 — strategy-enrichment indicator math)
- Six new indicator functions in `js/indicators.js`, standard/textbook
  formulas only (Appel MACD, Bollinger BBands, Wilder ADX, Lane slow
  Stochastic, Hosoda Ichimoku, no proprietary variants): `ema()`,
  `macd()`, `bollingerBands()`, `adx()` (reuses the existing
  `trueRange()`/`smma()` rather than reimplementing Wilder's smoothing),
  `stochastic()`, `ichimoku()` (snapshot-only, no forward-plotting — the
  `current*` fields are the -26-shifted read matching what a real chart
  overlays on today's candle), and `liquiditySweep()` (wick-rejection
  pattern modeled directly on the existing `divergentBar()`'s shape,
  reusing `fractals()`/`lastFractal()` — no new S/R notion).
- **Pure math only — this stage is deliberately inert.** Nothing wired
  into `analyzeTimeframe()`, `scoring.js`, `app.js`, or `render.js` yet;
  app behavior is unchanged. Matches the paused backlog plan's own
  staged build order (`~/.claude/plans/i-have-shifted-to-clever-hopcroft.md`
  section 4.4) — later stages fold these into 12 scoring strategies
  across the Continuation/Exhaustion/Reversal arms, which changes live
  signal output and deserves its own separate review pass.
- Verified directionally against synthetic uptrend/downtrend candles
  (MACD/ADX/Stochastic/Bollinger all behave correctly in both
  directions) and via hand-computed exact values (EMA seed value,
  Ichimoku tenkan/kijun window midpoints, MACD histogram identity). Full
  Wilder-published-worked-example cross-check for ADX specifically was
  not done — self-consistency and directional tests only.

### Added (Sloped regression-channel levels — v2 key levels)
- New `Indicators.linearRegression(points)` (pure OLS fit, returns
  `{slope, intercept, r2}`) and `Indicators.regressionChannelLevels()`,
  which fits a line through the last several fractal pivot highs/lows
  (up to 6, minimum 3) instead of taking just the nearest one, then
  projects that line to the current bar for a level that moves with the
  trend. Gated on fit quality (`r2 >= 0.6` default) — a poor fit returns
  `null`, meaning "not confident, don't show one," not a bad line.
- Deliberately **additive**, not a replacement for the existing flat
  `nearestLevels()` result — too much already depends on the flat level
  (breakout-proximity scoring shipped earlier this session, the modal's
  Key Levels display) to swap the underlying computation under them, on
  both the live site and the bot. New `resistanceSloped`/`supportSloped`
  snapshot fields sit alongside the unchanged `resistance`/`support`.
- Modal's Key Levels box shows the sloped channel as a secondary line
  under the flat value, with its r² so the reader can judge confidence,
  when a confident fit exists — otherwise no second line at all.
- Live-verified: a real coin's modal showed both a resistance channel
  (r²=0.90) and support channel (r²=0.60) computed from real fractal
  pivots, alongside the unchanged flat levels.

### Added (CoinPaprika fallback tier)
- Inserted as the middle tier in both `coingeckoGlobal()` and
  `coingeckoMarketCaps()`: CoinGecko → CoinPaprika (free, direct, no
  quota to protect) → CMC via the Supabase proxy (metered, last resort).
  Verified live in three ways: (1) direct browser `fetch()` to
  `api.coinpaprika.com` from this origin succeeds with a real
  `access-control-allow-origin: *` header — genuinely CORS-open, not
  just curl-reachable; (2) a real, unforced fallback fired during this
  session's own testing — `coingeckoGlobal()` hit CoinGecko's rate limit
  mid-scan and fell through to CoinPaprika automatically, and the UI's
  BTC Dominance/Market Cap tiles showed CoinPaprika's real values; (3)
  simulated a full CoinGecko+CoinPaprika outage to confirm the CMC proxy
  still answers as the final fallback. All three tiers reshape their
  response to CoinGecko's own field names, so no caller needs to change
  regardless of which source actually answered.

### Added (Phase 6 — Breakout-proximity)
- New Continuation scoring item evaluated on 15M: `Indicators.
  breakoutProximityPct(distance, atr)` (pure, unit-tested) measures how
  close price sits to its own fractal-based key level in ATR terms. A
  close already past the level scores "Confirmed breakout" (+14); within
  1 ATR of it (proximity >= 66%) scores "Approaching key level" (+10).
  Reuses the existing `resistance`/`support`/`atr`/`close` fields already
  on every per-TF snapshot — no new indicator plumbing needed.

### Added (Phase 7 — Heatmap)
- New "Heatmap" tab: every coin across the same 16-category set Flows
  uses, deduped by CoinGecko id (a coin can appear in multiple
  categories, highest-mktcap instance wins), tile size ~ sqrt(market cap)
  so one giant BTC tile can't swallow the grid, color = 24h% intensity
  (capped at 10% magnitude for full saturation). Shares Flows' data fetch
  — opening Heatmap first triggers the same `sectorPerformance7d()` call
  Flows uses, not a duplicate. No 1h-color toggle (that window isn't
  fetched anywhere else, and this is explicitly the lowest-priority tab
  on the roadmap — not worth a new CoinGecko window just for it).

### Added (Outcome-logging journal)
- New `journal.html` + `js/journal.js`, isolated from the main scanning
  page (own small theme-toggle copy, no dependency on `app.js`/
  `render.js`'s DOM assumptions). New shared `js/outcomes.js` module
  (`wicktor:outcomes` localStorage key, capped at 200 entries) used by
  both the main page's logging hook and the journal page's read/write.
- Logging hook: `openModal()` in `js/app.js` now logs `{key, band, score,
  side, entryPrice}` the first time a coin's detail modal opens (deduped
  per-key within a 1-hour window so repeat opens in one sitting don't
  spam duplicate entries) — purely additive, main page UI/behavior
  unchanged otherwise.
- Journal page: aggregate stats (logged/resolved/win rate/wins/losses/
  breakeven), full entry table, Win/Loss/Breakeven buttons per unresolved
  entry. Linked from the main page's Settings panel.
- New `priceRaw` numeric field added to the coin object (existing `price`
  field is a display-formatted string with thousands separators, not
  safely `parseFloat`-able) — purely additive.

### Added (Extended 7-timeframe panel)
- Detail modal now shows all 7 timeframes (1M/5M/15M/30M/1H/4H/1D): last
  close + last-candle % change, informational only — doesn't touch
  scoring. Lazy-fetched fresh on modal open (the scan pipeline doesn't
  retain raw candles per coin) via new `Api.fetchExtendedTimeframes()`;
  race-guarded so a closed/switched modal doesn't render stale data if
  the fetch resolves late.
- `INTERVAL_MAP` in `js/api.js` extended with 1m/30m/4h/1d (previously
  only 1h/15m/5m existed, matching the scan's own fixed 3 timeframes).

### Added (OI 15m%)
- New Continuation scoring item, perpetuals only: `Api.
  openInterestChange15m(symbol)` (Bybit `/v5/market/open-interest`,
  verified live) computes % open-interest change over the trailing 15
  minutes. `|change| >= 5%` (significance threshold) scores a soft
  confirmation (+8) — magnitude-based, not signed by bias, since a large
  swing in open interest either way means fresh capital is actively
  committing to the current move. `Scoring.evaluate()` gained an optional
  second `extras` parameter (`{oiChange15m}`) to thread this through
  without changing the existing single-argument call signature anywhere
  else. Spot-market coins pass `null` — no item, no crash.

### Added (Phase 2 — Market Flows)
- New "Flows" tab: sortable-by-market-cap category table (Artificial
  Intelligence, DePIN, RWA, Gaming, Layer 1/2, Meme, etc. — the same
  16-keyword set already used for the Top Sectors tile) with 24h/7d/30d
  market-cap-weighted % change per category. Click a row to expand its
  top-15 constituent coins with the same columns.
- `Api.sectorPerformance7d()` extended to fetch `price_change_percentage=
  24h,7d,30d` in the same request (verified live that CoinGecko accepts
  multiple comma-separated windows at no extra cost) instead of just 7d,
  and now also returns each category's total market cap (sum of the top
  50 coins fetched, not the full category — labeled as such in the UI).
  This made the roadmap's originally-planned daily-snapshot GitHub Actions
  workflow + new Supabase table unnecessary — real 24h/7d/30d numbers
  come from one existing request, no new infrastructure needed.
- Fully additive to existing callers (`topNarrativeCandidates()`, the
  Top Sectors top-strip tile) — neither reads the new fields, both
  continue working unchanged.

### Added (Phase 1 — Dashboard)
- New "Dashboard" tab alongside the existing Scanner view: BTC dominance,
  market cap + 24h%, Fear & Greed, Top Sectors (reused from the existing
  top strip), a new Top 5 by Market Cap tile, and Top 10 Gainers/Losers
  (vs. the compact strip's top 3). Lazily fetched on first visit, refreshed
  alongside subsequent scans once visited.
- `Api.topByMarketCap(n)` — new lightweight CoinGecko `/coins/markets` call
  (10-min cache) powering the Dashboard's Top 5 tile.
- Refresh-interval setting is now minutes-based (1-10 min, default 5,
  aligned to the 5M candle boundary) instead of raw seconds.

### Changed
- Default coin universe size raised from 30 to 120 (confirmed level per
  backlog); settings clamp raised from 10-80 to 10-120 to match.

### Investigated, not changed (flagged for owner review)
- **Priority-0 gating audit (the WIF case)**: confirmed the actual
  mechanism. `alignmentCeiling()` in `js/scoring.js` only checks
  `.alignment` (coarse -1/0/1 direction), never `.confidence` (the 5-tier
  state that drives the "weakening" arrow in the UI). A `weak_bull`/
  `weak_bear` 5M still satisfies the ceiling's alignment check, so
  EXCELLENT can still be reached with a visually "weakening" 5M —
  confidence only reduces point value inside `buildContinuation` (30→24
  pts), never the band cap itself. This may be working as designed (the
  score penalty already reflects weakness) or may be the actual bug the
  WIF case pointed at — genuine product-intent call, left for the owner
  rather than changed unilaterally since it affects live signal output.
- **wicktor-bot-cc scoring-drift audit**: confirmed real, non-trivial
  drift. The bot's `src/engine/scoring.js` is a manual snapshot from
  2026-08-09 (commit `48bf029`) with its own Phase-4 bug fixes layered on
  top (Buy/Sell RSI-threshold asymmetry fixes). The scanner's real
  `js/scoring.js` has since added combined AO+AC confirmation scoring (16
  vs 6 pts) and other changes the bot's copy doesn't have. `indicators.js`
  drift is much smaller (~15 diff lines). Check/flag only, per standing
  instruction not to touch `wicktor-bot-cc` without an explicit separate
  ask.
- **CMC proxy CORS cleanup**: removed the leftover `http://localhost:8000`
  origin from `supabase/functions/cmc-proxy/index.ts` in this branch's
  source, but did **not** run `supabase functions deploy` — that flips
  live production CORS behavior immediately regardless of git branch, so
  it's held for the owner to deploy after reviewing the diff.

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
