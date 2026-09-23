-- Split the 5-minute scan into three scheduled parts.
--
-- WHY. Measured 2026-09-23, reproducibly: a full run at universe_size=350 is
-- killed with WORKER_RESOURCE_LIMIT. Instrumenting the function with
-- Deno.memoryUsage() settled which resource: peak heap 17MB, heapTotal 25MB,
-- external 4MB -- nowhere near any memory cap. It is the worker's CPU budget,
-- and scoring 699 coins (2,796 kline fetches, parsed into ~280k candle objects,
-- plus the indicator math) sits right on it. The kill lands in a different
-- place each time; one failure had already written a complete 699-coin
-- snapshot -- the very last step -- and still died before returning.
--
--   scan 699, no writes ................. passed 4/4
--   scan 239 + resolve  81 + snapshot ... passed
--   scan 699 + resolve 100 + snapshot ... killed 2/2
--   scan 699 + snapshot (resolve split) . killed 1/3   <- splitting resolve
--                                                          off was not enough
--
-- Shrinking the universe would "fix" this by changing the research dataset,
-- which is not acceptable. So the work is halved instead: one category per
-- invocation, each with its own worker and its own budget.
--
-- Offsets matter. Back-to-back invocations were measured to be killed SOONER
-- than cold ones (24s vs 41s), consistent with a warm worker carrying CPU
-- accounting over from the previous request. The three jobs are therefore
-- spread a minute apart rather than fired together.

-- The two half-scans hand off through this table: whichever runs second
-- stitches both halves into the one snapshot row the site reads. Exactly one
-- row per category, upserted, so there is nothing to prune.
create table if not exists public.scan_stage (
  category    text primary key,
  captured_at timestamptz not null default now(),
  coins       jsonb not null,
  scores      jsonb not null
);

-- Service-role only. This is scan plumbing, not something the public site
-- reads -- the site reads scan_snapshot. RLS on with no policy denies anon and
-- authenticated outright; service_role bypasses RLS.
alter table public.scan_stage enable row level security;
revoke all on public.scan_stage from anon, authenticated;

select cron.unschedule(j) from unnest(array[
  'wicktor-scan', 'wicktor-scan-spot', 'wicktor-scan-linear', 'wicktor-resolve'
]) as j
where exists (select 1 from cron.job where jobname = j);

-- Bodies are identical bar the stage; kept as separate literal statements
-- rather than a helper function so `select * from cron.job` shows exactly what
-- runs, key and all.
select cron.schedule(
  'wicktor-scan-spot',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fpyfetynfobfrpunnnhv.supabase.co/functions/v1/cron-scan?universe_size=350&stage=scan-spot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
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

select cron.schedule(
  'wicktor-scan-linear',
  '1-59/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fpyfetynfobfrpunnnhv.supabase.co/functions/v1/cron-scan?universe_size=350&stage=scan-linear',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'wicktor_service_key'
      ),
      'x-region', 'ap-northeast-1'
    ),
    timeout_milliseconds := 120000
  );
  $$
);

select cron.schedule(
  'wicktor-resolve',
  '2-59/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fpyfetynfobfrpunnnhv.supabase.co/functions/v1/cron-scan?stage=resolve',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'wicktor_service_key'
      ),
      'x-region', 'ap-northeast-1'
    ),
    timeout_milliseconds := 120000
  );
  $$
);
