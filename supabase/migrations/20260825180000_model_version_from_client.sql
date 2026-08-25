-- model_version must be declared by the client, not defaulted by the table.
--
-- The previous default silently stamped 'v2.1-pricemove-target' onto every
-- insert, including rows written by a browser still running cached pre-fix
-- JavaScript. 57 such rows arrived carrying the old fixed-3R geometry
-- (target = 3x risk, one of them a 73% move) while claiming to be new-model
-- data. A version column that reports what the DATABASE believes rather
-- than what the CLIENT ran is worse than no column: it launders stale data
-- as current.
--
-- The default becomes a value that is obviously wrong instead, so an
-- un-stamped writer shows up as 'unknown-client' and can be filtered out
-- rather than blending in.

alter table public.signal_journal
  alter column model_version set default 'unknown-client';

-- Same geometry-based predicate as the earlier reset: anything whose target
-- is 3x its stop distance came from the superseded model regardless of how
-- it is labelled.
delete from public.signal_journal
where stop is distinct from entry
  and round((abs(target - entry) / abs(entry - stop))::numeric, 2) = 3.00;
