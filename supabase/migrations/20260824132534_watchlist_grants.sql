-- Fix: the previous migration enabled RLS and wrote policies, but RLS
-- policies only take effect once the role already has the underlying
-- SQL-level GRANT on the table — creating a table via raw SQL (not the
-- Studio table editor, which auto-grants) leaves `authenticated` and
-- `anon` with zero base privileges. Confirmed live: a real signup +
-- star-toggle attempt failed with "permission denied for table
-- watchlist" (Postgres error 42501) before this fix.
--
-- select is granted to anon too so a not-yet-logged-in client doesn't
-- error touching the table (RLS still returns zero rows either way,
-- since there's no auth.uid() to match) — anon gets no insert/delete,
-- matching that only authenticated users can ever own rows.
grant select on public.watchlist to anon;
grant select, insert, delete on public.watchlist to authenticated;
