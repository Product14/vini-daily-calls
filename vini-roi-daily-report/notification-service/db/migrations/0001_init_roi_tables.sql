-- ============================================================================
-- ROI Daily Report — Supabase schema
-- Central store for: eligibility (live), runtime config, recipient routing,
-- full per-run payload log, and engagement events. Backs the CSM tracker UI.
-- ============================================================================

-- ── Gate 3: which (team, department) is ACTUALLY live (CSM-curated) ─────────
create table if not exists roi_live_departments (
    team_id     text not null,
    department  text not null check (department in ('sales','service')),
    is_live     boolean not null default false,
    updated_at  timestamptz not null default now(),
    primary key (team_id, department)
);

-- ── Req 2: per-rooftop runtime config (send hour configurable from UI) ──────
create table if not exists roi_rooftop_config (
    team_id            text primary key,
    enterprise_id      text,
    rooftop_name       text,
    digest_send_hour   smallint not null default 7  check (digest_send_hour between 0 and 23),
    digest_send_minute smallint not null default 0  check (digest_send_minute between 0 and 59),
    timezone           text,        -- optional override; else working-days API tz
    daily_enabled      boolean not null default true,
    weekly_enabled     boolean not null default false,
    monthly_enabled    boolean not null default false,
    updated_at         timestamptz not null default now()
);

-- ── Req 3: per-recipient department subscription (which comms they receive) ─
create table if not exists roi_recipients (
    id               uuid primary key default gen_random_uuid(),
    team_id          text not null,
    enterprise_id    text,
    email            text not null,
    name             text,
    receives_sales   boolean not null default false,
    receives_service boolean not null default false,
    email_enabled    boolean not null default true,   -- master opt-in
    updated_at       timestamptz not null default now(),
    unique (team_id, email)
);
create index if not exists roi_recipients_team_idx on roi_recipients (team_id);

-- ── Req 1 & 5: every digest run, sent or not, with full payload + HTML ──────
-- The tracker reads this table directly. status/reason map to the frontend
-- SendStatus / NotSentReason enums (see tracker mockData.ts).
create table if not exists roi_digest_runs (
    id              uuid primary key default gen_random_uuid(),
    enterprise_id   text not null,
    team_id         text not null,
    department      text not null check (department in ('sales','service')),
    cadence         text not null default 'daily' check (cadence in ('daily','weekly','monthly')),
    local_date      date not null,
    dealer_timezone text,

    -- maps to tracker SendStatus
    status          text not null check (status in
                        ('sent','not_sent','suppressed','scheduled','not_subscribed')),
    -- maps to tracker NotSentReason + backend-specific reasons (see digest-store.service.js)
    reason          text,
    reason_detail   text,

    metrics         jsonb,   -- full computed templateData (req 5: what was calculated)
    rendered_html   text,    -- the HTML that was / would have been sent (req 5)
    subject         text,
    mail_template   text,
    recipients      jsonb,   -- [{email,name,received,bounced}] per-recipient state
    bcc_confirmed   boolean  default false,  -- Step 3: independently confirmed via BCC track address
    bcc_confirmed_at timestamptz,            -- when the BCC delivery event arrived
    send_path       text default 'template' check (send_path in ('template','raw_html')),
    trigger         text not null default 'cron' check (trigger in ('cron','manual','backfill')),
    message_id      text,    -- provider id, joins to engagement events

    sent_at         timestamptz,
    created_at      timestamptz not null default now(),

    -- idempotency: one run per dept/cadence/local-day → upsert, no dedup race
    unique (team_id, department, cadence, local_date)
);
create index if not exists roi_digest_runs_lookup_idx
    on roi_digest_runs (team_id, local_date, cadence);
create index if not exists roi_digest_runs_message_idx
    on roi_digest_runs (message_id);

-- ── Req 7: communication engagement events ──────────────────────────────────
create table if not exists roi_engagement_events (
    id              uuid primary key default gen_random_uuid(),
    run_id          uuid references roi_digest_runs(id) on delete set null,
    message_id      text,
    team_id         text,
    recipient_email text,
    event_type      text not null check (event_type in
                        ('delivered','open','click','bounce','complaint','dropped','deferred','unsubscribe')),
    url             text,    -- for click events
    provider        text,
    raw             jsonb,
    occurred_at     timestamptz not null,
    created_at      timestamptz not null default now()
);
create index if not exists roi_engagement_message_idx on roi_engagement_events (message_id);
create index if not exists roi_engagement_run_idx on roi_engagement_events (run_id);

-- ===== config (RLS, grants, realtime, triggers) =====

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
