-- SMS notification channel for dealer transactional alerts (action items + appointments).
-- Companion to the email path (roi_event_emails). Additive + safe: new nullable columns,
-- defaults off, and a parallel dedupe/tracking table so the SMS channel can never collide
-- with the email unique key. Run in the reporting-vini Supabase SQL editor.

-- 1) Recipients gain a phone + an independent SMS opt-in (+ an optional role for future routing).
--    Dept targeting reuses the existing receives_sales / receives_service flags.
alter table roi_recipients add column if not exists phone       text;
alter table roi_recipients add column if not exists sms_enabled  boolean not null default false;
alter table roi_recipients add column if not exists role         text;   -- 'salesperson' | 'bdc' | 'gm' | null

-- 2) Per-rooftop SMS master switch. SMS only fires for a rooftop when this is on AND the
--    relevant email event flag (action_item_enabled / post_appointment_enabled / …) is on.
alter table roi_rooftop_config add column if not exists sms_enabled boolean not null default false;

-- 3) SMS event ledger — mirrors roi_event_emails. The unique (team_id, email_type, event_key)
--    guarantees one SMS per event, independent of the email dedupe.
create table if not exists roi_event_sms (
  id            uuid primary key default gen_random_uuid(),
  team_id       text not null,
  enterprise_id text,
  department    text,
  email_type    text not null,          -- reuse the email_type vocabulary (action_item, post_appointment, …)
  event_key     text not null,
  status        text not null default 'queued',  -- queued | sent | suppressed | not_sent | error
  reason        text,
  recipients    jsonb,                   -- [{ phone, sid?, received? }]
  body          text,                    -- the plain-text message we sent
  message_sid   text,                    -- Twilio sid of the first/primary message
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (team_id, email_type, event_key)
);
create index if not exists idx_roi_event_sms_team on roi_event_sms(team_id, created_at desc);

-- RLS off / permissive to match the other roi_* tables (service-key access from the cron).
alter table roi_event_sms disable row level security;
