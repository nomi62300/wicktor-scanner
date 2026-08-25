-- The scheduled scanner (tools/cron-scan.js) writes as service_role so the
-- journal no longer depends on someone having a signed-in browser tab open.
--
-- service_role bypasses RLS, but NOT table grants — those are separate
-- mechanisms, and the original migration granted only anon/authenticated.
-- The result was a 42501 "permission denied", the third time this exact
-- distinction has bitten this project (watchlist hit it first). Bypassing
-- row policies is not the same as being allowed to touch the table at all.
--
-- Delete stays ungranted deliberately: the cron resolves and expires rows,
-- it never removes them, and a scheduled process that could silently drop
-- unfavourable results would defeat the point of keeping a record.

grant select, insert, update on public.signal_journal to service_role;
grant usage, select on sequence public.signal_journal_id_seq to service_role;
