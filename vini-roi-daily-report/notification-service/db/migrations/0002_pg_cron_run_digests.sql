-- ============================================================================
-- Schedule run-digests hourly via pg_cron + pg_net.
-- Apply AFTER `supabase functions deploy run-digests`.
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> (or read the key from Vault).
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any prior schedule of the same name (idempotent re-apply)
select cron.unschedule('roi-run-digests-hourly')
where exists (select 1 from cron.job where jobname = 'roi-run-digests-hourly');

-- Fire run-digests at the top of every hour. The function itself gates each
-- rooftop to its dealer-local send hour, so hourly is correct.
select cron.schedule(
  'roi-run-digests-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/run-digests',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);

-- Inspect:  select * from cron.job;
-- History:  select * from cron.job_run_details order by start_time desc limit 20;
