-- Run the scan every 5 minutes for real.
--
-- The Edge Function's own header has claimed since it was written that it is
-- "invoked by pg_cron (see the accompanying migration)". There was no such
-- migration: GitHub Actions was the only caller, and measured 2026-09-04 it
-- does NOT honour `*/5 * * * *`. Twenty consecutive scheduled runs spanning
-- ~2.8 days averaged 3.3 HOURS apart -- roughly one run in forty. GitHub
-- documents scheduled workflows as best-effort and drops high-frequency
-- schedules under load; this is that, not a misconfiguration.
--
-- Everything downstream assumed 5-minute cadence: the journal's sampling
-- rate (~7 scans/day instead of ~288), and now the scan snapshot the whole
-- UI reads. pg_cron runs inside Postgres on a real scheduler, so it actually
-- fires on the minute.
--
-- The GitHub workflow is deliberately left in place as a backstop -- if
-- pg_cron or pg_net breaks, an every-few-hours scan is much better than
-- none, and the snapshot/journal writes are idempotent enough that an extra
-- caller cannot corrupt anything (bar_time dedupes journal rows; snapshots
-- are append-and-prune).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: unschedule first so re-running this migration doesn't stack
-- duplicate jobs.
select cron.unschedule('wicktor-scan') where exists (
  select 1 from cron.job where jobname = 'wicktor-scan'
);

select cron.schedule(
  'wicktor-scan',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fpyfetynfobfrpunnnhv.supabase.co/functions/v1/cron-scan?universe_size=350',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Read from Supabase Vault, NOT from a GUC and NOT inlined here.
      -- ALTER DATABASE ... SET is refused for this role (42501), and
      -- inlining would put a service-role key in a public git repo. The
      -- secret is created out-of-band; this migration only references it by
      -- name, so the file is safe to commit.
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'wicktor_service_key'
      ),
      -- Not optional: Edge Functions route to the region nearest the caller,
      -- and Bybit blocks the US regions. See the function's header.
      'x-region', 'ap-northeast-1'
    ),
    timeout_milliseconds := 120000
  );
  $$
);
