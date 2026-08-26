-- Whether each individual TP rung was ever touched, independent of which
-- exit plan actually banked it.
--
-- Plan A moves its stop to breakeven after TP1 and Plan B holds a single
-- fixed stop to TP3 only -- neither, on its own, answers "did price reach
-- TP2" as a plain fact about the market. These three flags are computed
-- with the ORIGINAL stop held fixed for the whole walk (never moved to
-- breakeven), so they describe what actually happened to price, not an
-- artifact of either plan's management. A bar that touches the stop and a
-- TP in the same bar counts as the stop, same tie-break the rest of the
-- resolution logic already uses -- see js/signals.js tpTouches().
--
-- Left false (not null) for rows still open; only set at resolution.

alter table public.signal_journal
  add column if not exists tp1_hit boolean not null default false,
  add column if not exists tp2_hit boolean not null default false,
  add column if not exists tp3_hit boolean not null default false;
