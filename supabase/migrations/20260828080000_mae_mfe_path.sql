-- Maximum Adverse/Favorable Excursion, and the raw candle path a signal
-- resolved against, so stop placement can be studied from real recorded
-- trades later rather than only from fixture backtests.
--
-- MAE = the worst the trade ever looked before its final outcome, in R
-- against the trade's OWN stop distance (never against the stop that was
-- actually hit -- the point is to see how close price got, not just
-- whether it crossed). MFE is the mirror: the best it ever looked.
-- tools/analyze-mae.js does the same computation on fixture data; these
-- columns let the identical question be asked of real, live-logged trades,
-- which can carry things a backtest fixture cannot (real fills, a live
-- resolver's actual timing).
--
-- `path` stores the OHLC bars the resolver actually walked (up to
-- HOLD_BARS=48, each [t,o,h,l,c] -- volume dropped, not needed for this).
-- Keeping the real path means a specific trade can be re-examined later
-- even if Bybit's own history has since aged out, and means MAE/MFE are
-- re-derivable if the definition above is ever refined.

alter table public.signal_journal
  add column if not exists mae_r numeric,
  add column if not exists mfe_r numeric,
  add column if not exists path jsonb;
