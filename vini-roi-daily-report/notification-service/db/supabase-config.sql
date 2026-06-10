-- ============================================================================
-- ROI Daily Report — Supabase operational config (run AFTER supabase-schema.sql)
-- RLS, grants, realtime, updated_at triggers. Review notes in db/SUPABASE-REVIEW.md
-- ============================================================================

-- ── 1 · updated_at auto-touch ───────────────────────────────────────────────
create or replace function roi_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

do $$
declare t text;
begin
  foreach t in array array['roi_live_departments','roi_rooftop_config','roi_recipients']
  loop
    execute format('drop trigger if exists trg_touch on %I;', t);
    execute format('create trigger trg_touch before update on %I
                    for each row execute function roi_touch_updated_at();', t);
  end loop;
end $$;

-- ── 2 · Row-level security ──────────────────────────────────────────────────
-- service_role (backend Sails service key) BYPASSES RLS automatically — it can
-- read/write everything. These policies only govern anon / authenticated
-- (the browser tracker).
alter table roi_live_departments  enable row level security;
alter table roi_rooftop_config    enable row level security;
alter table roi_recipients        enable row level security;
alter table roi_digest_runs       enable row level security;
alter table roi_engagement_events enable row level security;

-- READ: tracker (signed-in CSMs). Recommended: require an authenticated session,
-- NOT anon — roi_digest_runs.rendered_html + recipients contain dealer PII.
create policy roi_read_runs        on roi_digest_runs       for select to authenticated using (true);
create policy roi_read_engagement  on roi_engagement_events for select to authenticated using (true);
create policy roi_read_config      on roi_rooftop_config    for select to authenticated using (true);
create policy roi_read_recipients  on roi_recipients        for select to authenticated using (true);
create policy roi_read_live        on roi_live_departments  for select to authenticated using (true);

-- WRITE from the tracker: PREFER routing writes through the backend (service_role)
-- so RLS/audit stay centralized. If you want direct authenticated writes for
-- config/recipients/classification, uncomment:
-- create policy roi_write_config     on roi_rooftop_config   for all to authenticated using (true) with check (true);
-- create policy roi_write_recipients on roi_recipients       for all to authenticated using (true) with check (true);
-- create policy roi_write_live       on roi_live_departments for all to authenticated using (true) with check (true);

-- ⚠️ The prototype tracker has no Supabase Auth yet. If you wire it with the
--    ANON key (no auth), either (a) add anon SELECT policies below — accepting
--    that anyone with the anon key can read dealer PII — or (b) proxy reads
--    through the backend. Anon read policies (NOT recommended for prod):
-- create policy roi_anon_read_runs on roi_digest_runs for select to anon using (true);

-- ── 3 · Grants (Supabase needs table grants in addition to RLS) ─────────────
grant usage on schema public to authenticated;
grant select on roi_digest_runs, roi_engagement_events, roi_rooftop_config,
                roi_recipients, roi_live_departments to authenticated;

-- ── 4 · Realtime (tracker live-updates on new sends) ────────────────────────
alter publication supabase_realtime add table roi_digest_runs;
alter publication supabase_realtime add table roi_engagement_events;
