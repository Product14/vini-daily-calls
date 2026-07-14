-- 0020 · Cron run log — "last synced" trail for every background sync job.
--
-- sync-live and sync-lifecycle (server/roi-cron/runner.cjs) and the agents-refresh
-- incremental/hourly/full tiers (server/app.js) have all been inserting into this
-- table already — but it was never actually created. Every insert has been silently
-- swallowed (all three call sites wrap it in a best-effort catch), so this has been a
-- complete no-op: no cron has ever actually logged a run here. Harmless (nothing reads
-- this table today, so nothing was broken), but it means "when did X last sync" has
-- never been answerable from this table until now.
create table if not exists roi_cron_runs (
    id         uuid primary key default gen_random_uuid(),
    source     text not null,
    ok         boolean not null default true,
    summary    jsonb,
    created_at timestamptz not null default now()
);
create index if not exists roi_cron_runs_source_idx
    on roi_cron_runs (source, created_at desc);

-- Same pattern as roi_config_audit_log (0016/0017): server/cron-only, written with the
-- service-role key (bypasses RLS/grants regardless), never read from the browser — no
-- RLS, no anon/authenticated grants.
