-- service_role bypasses RLS POLICIES but not table-level GRANTs.
--
-- The previous migration granted select to anon/authenticated and assumed
-- the scheduled job's service_role key would just work, since service_role
-- "bypasses RLS". It does — but a table created via raw SQL starts with no
-- base privileges for it either, so the first real write returned 42501
-- "permission denied for table sector_snapshot". Same shape as the bug the
-- watchlist table hit on its first star-toggle, and the reason
-- 20260825090000_signal_journal.sql carries explicit grants.

grant insert, update on public.sector_snapshot to service_role;
grant insert, update on public.coin_sector to service_role;
grant usage, select on sequence public.sector_snapshot_id_seq to service_role;

-- The coin_sector write is an UPSERT (on_conflict=symbol,sector), which has
-- to READ to detect the conflict — so insert/update alone still returned
-- 42501, this time naming SELECT. Granted on both tables for symmetry.
grant select on public.sector_snapshot to service_role;
grant select on public.coin_sector to service_role;
