-- Grants for scan_stage, missed when the table was added minutes earlier.
--
-- Same trap scan_snapshot's migration already warns about, walked into again:
-- service_role bypasses RLS POLICIES but NOT table-level GRANTs, so a table
-- created with RLS on and no grants returns 42501 on its first write. Measured
-- here as `postgrest 403 {"code":"42501"}` on both half-scans.
--
-- UPDATE is needed as well as INSERT: the handoff upserts via PostgREST's
-- resolution=merge-duplicates, which is INSERT ... ON CONFLICT DO UPDATE.
grant select, insert, update, delete on public.scan_stage to service_role;

-- Not granted to anon/authenticated on purpose: the public site reads
-- scan_snapshot, never this. This is scan plumbing.

-- PostgREST caches the schema; a table it has never seen 404s until reloaded.
notify pgrst, 'reload schema';
