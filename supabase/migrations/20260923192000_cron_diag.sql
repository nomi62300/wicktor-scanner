-- Read-only diagnostics for the scheduled scan.
--
-- Measured 2026-09-23: the schedule fired correctly for a while (5-20 min
-- spacing, 699 coins) and then simply stopped -- a 308-minute gap after
-- 13:05 UTC with no error visible anywhere, because cron.job_run_details
-- lives in the cron schema and PostgREST cannot see it. pg_cron reporting
-- success is also not proof of delivery: net.http_post only ENQUEUES, so a
-- stalled pg_net worker looks identical to a healthy one from cron's side.
-- Hence both halves are reported here.
--
-- SECURITY DEFINER because cron.* and net.* are owned by the superuser role.
-- EXECUTE is granted to service_role only, never to anon/authenticated.
create or replace function public.cron_diag()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  out_jobs jsonb;
  out_runs jsonb;
  out_resp jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'jobname', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
    into out_jobs from cron.job;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into out_runs from (
    select j.jobname, d.status, d.start_time,
           left(coalesce(d.return_message, ''), 200) as message
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
     order by d.start_time desc
     limit 30
  ) t;

  -- pg_net keeps delivered responses briefly; an empty/stale set while cron
  -- reports success is the signature of a stalled pg_net worker.
  begin
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into out_resp from (
      select id, status_code, created
        from net._http_response
       order by created desc
       limit 15
    ) r;
  exception when others then
    out_resp := jsonb_build_object('unavailable', SQLERRM);
  end;

  return jsonb_build_object('jobs', out_jobs, 'runs', out_runs, 'responses', out_resp);
end;
$$;

revoke all on function public.cron_diag() from public, anon, authenticated;
grant execute on function public.cron_diag() to service_role;

notify pgrst, 'reload schema';
