-- ============================================================================
-- 4-cron ROI emailer pipeline schedule (supersedes 0002).
-- pg_cron fires ONLY cron1-sync-live every hour; cron1 internally chains
--   cron1 → cron2-mark-ready → cron3-render → cron4-send.
-- Apply AFTER deploying all four functions:
--   supabase functions deploy cron1-sync-live
--   supabase functions deploy cron2-mark-ready
--   supabase functions deploy cron3-render
--   supabase functions deploy cron4-send
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> (or read the key from Vault).
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Retire the old monolithic schedule if it exists.
select cron.unschedule('roi-run-digests-hourly')
where exists (select 1 from cron.job where jobname = 'roi-run-digests-hourly');

-- Idempotent re-apply of the new schedule.
select cron.unschedule('roi-pipeline-hourly')
where exists (select 1 from cron.job where jobname = 'roi-pipeline-hourly');

-- Fire cron1 at the top of every hour. cron1 re-syncs the live candidate set
-- from ClickHouse, then orchestrates 2→3→4. Each rooftop is still gated to its
-- dealer-local send hour inside cron2, and to its dry_run flag inside cron4,
-- so running hourly + global is correct and safe.
select cron.schedule(
  'roi-pipeline-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron1-sync-live',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
  $$
);

-- Inspect:  select * from cron.job;
-- History:  select * from cron.job_run_details order by start_time desc limit 20;
