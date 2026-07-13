-- 0016 · Config change log — "save change logs of configuration".
--
-- Every write through POST /api/rooftop-config or POST /api/csm now records one row per
-- changed field here (see server/app.js). Powers the ConfigDrawer's "History" panel.
--
-- No RLS: checked the live project directly (pg_class.relrowsecurity) — despite
-- 0001_init_roi_tables.sql defining RLS + authenticated-only policies, RLS is actually OFF on
-- roi_rooftop_config/roi_recipients/roi_live_departments/roi_digest_runs in production today
-- (the tracker reads/writes with the anon/publishable key, no real Supabase Auth session).
-- This table is only ever touched through the Express API (service-role key, bypasses
-- RLS/grants regardless) — never read directly from the browser — so it gets no anon/
-- authenticated grants at all, matching how it's actually used rather than the aspirational
-- RLS pattern in the original migration.
create table if not exists roi_config_audit_log (
    id         uuid primary key default gen_random_uuid(),
    team_id    text not null,
    actor      text,
    field      text not null,
    old_value  text,
    new_value  text,
    source     text not null default 'tracker',
    created_at timestamptz not null default now()
);
create index if not exists roi_config_audit_log_team_idx
    on roi_config_audit_log (team_id, created_at desc);
