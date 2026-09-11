# MAE / time-exit live-data analysis

One-off analysis tools (Python, not JS like the rest of `tools/` --
kept as-is rather than ported, no functional reason to rewrite) built
2026-09-09 to test real v2.2-near-target signal_journal trades against
real Bybit candles: does the stop have slack to tighten, and does an
earlier time-based exit help. Run from this directory; each script
writes/reads its JSON output as a local file, in order:

```
python3 pull-model-version-rows.py        # -> v22_rows.json (edit the model_version/status filter inside for a different cut)
python3 mae-live-check.py                 # -> mae_results.json (real MAE/MFE + stop-fraction sweep per trade)
python3 mae-live-report.py                # prints the straight-up/dipped/stop/target breakdown
python3 mae-timeout-trace.py              # traces what happens to timeout-bucket trades specifically as the stop tightens
python3 time-exit-check.py                # -> time_exit_results.json (fixed-time-cutoff sweep, independent of stop distance)
python3 time-exit-report.py               # prints the time-cutoff sweep + timeout-trade trace
```

Supabase connection: `pull-model-version-rows.py` uses the same public
`sb_publishable_...` key already embedded in `js/signals-page.js` (real
public/publishable key, safe to reuse -- signal_journal is
public-select by design, see that file's own header comment). No
credentials needed.

## Findings

**Rerun 2026-09-10, n=6,604 resolved v2.2 trades** (up from 2,266-2,277
two days prior -- see `project-wicktor-mae-stop-analysis` memory for
full detail):

- Real `outcome_a` (the live partial+breakeven plan, straight from
  Supabase, no simulation) balanced edge narrowed to -0.0143R, CI
  [-0.0226,-0.0059] -- still significant, but ~1/4 the size of the
  -0.0608R reading two days ago. `outcome_b` similar: -0.0123R.
- Clean-subset (stop/target-only) stop-slack finding replicated and
  strengthened: now net POSITIVE even before tightening (+0.054R),
  climbing to +0.364R net at 0.2x stop fraction.
- Timeout bucket still gets worse under tightening, confirmed again
  (0% ever flip to target at any fraction).
- **The earlier time-based-exit finding REVERSED and is dead.** With
  3x the data, shortening the hold makes things worse, not better --
  240min (current) is now the best of everything tested (-0.0146R vs
  -0.0454R at 60min). The "~35% smaller bleed at 30min" result from
  2026-09-09 was noise from the smaller sample. Do not pursue a
  time-based exit further based on the old reading.
- **New, bigger finding**: 50.6% of trades (3,339/6,604) resolve via
  the real `breakeven` exit_reason -- the live system's actual
  `plan_a` (1/3 out at 1R, stop to breakeven, remainder rides).
  Neither `mae-live-check.py` nor `time-exit-check.py` models this
  partial-exit mechanic; both simulate a naive single-leg stop-or
  -target walk. This is why the scripts have always disagreed on
  timeout counts, and means the stop-tightening/time-exit sweep
  R-values (not `outcome_a`/`outcome_b`, which are real) describe a
  hypothetical system that isn't what's actually live. `breakeven`
  -exit trades net +0.0714R avg, 100% win rate in real `outcome_a` --
  the mechanic is already doing real protective work.

**Original findings, 2026-09-08/09, n=2,266-2,277** (superseded above
where they conflict, kept for the record): 94% of trades dip before
resolving, winners' MAE never exceeds ~0.99R, 90% stay under 0.42R.
The 1,175-vs-638 timeout-count discrepancy flagged then is now
explained -- it was never a walk-logic margin bug, it's that neither
script models the real partial+breakeven plan.

## Standing plan (per owner, 2026-09-09) -- status 2026-09-10

1. ~~Wait a few days~~ -- done.
2. ~~Rerun this whole pipeline on the bigger sample~~ -- done, this
   file + memory updated.
3. **NOT YET DECIDED, needs a real conversation.** The stop-tighten +
   trailing-SL plan should be re-scoped around the real partial
   +breakeven mechanic (finding above), not the naive single-leg walk
   these scripts use -- the naive sweep numbers don't describe the
   system that's actually live. Do not implement without an explicit
   go-ahead after that conversation.
4. Let that combination run 3-4 more days once implemented, check
   results, decide next step.

Do not start step 3 without an explicit go-ahead -- this file
documents the plan, it isn't itself the approval to implement it.
