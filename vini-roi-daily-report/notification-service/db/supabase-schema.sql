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
    -- transactional email types (see migration 0004) — off until a rooftop opts in
    post_appointment_enabled    boolean not null default false,
    post_conversation_enabled   boolean not null default false,
    action_item_enabled         boolean not null default false,
    action_item_overdue_enabled boolean not null default false,
    post_conversation_mode       text    not null default 'actionable' check (post_conversation_mode in ('actionable','all')),
    post_conversation_outbound_requires_reply boolean not null default true,
    action_item_sla_minutes      integer not null default 20,
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
    recipients      jsonb,   -- [{email,name,received,bounced,opened,opened_at}] per-recipient state
    opened_at       timestamptz,            -- first open (open-rate tracking pixel; see /api/email/track-open)
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
