-- 0005 · Per-event transactional email log + dedupe.
--
-- The cadence digests live in roi_digest_runs (keyed by team·dept·cadence·local_date).
-- The 4 transactional emails (post_appointment, post_conversation, action_item,
-- action_item_overdue) fire per EVENT, so they need their own log keyed by the source
-- event id. The frequent poll pass writes one row per (team, email_type, event_key);
-- the unique constraint is the dedupe guard so an event is never emailed twice.
-- The internal tracker reads roi_digest_runs (digests only) — NOT this table.

create table if not exists public.roi_event_emails (
  id            uuid primary key default gen_random_uuid(),
  team_id       text not null,
  enterprise_id text,
  department    text not null,                 -- sales | service
  email_type    text not null,                 -- post_appointment | post_conversation | action_item | action_item_overdue
  event_key     text not null,                 -- meeting_id | conversation_id | action_item_id (the dedupe key)
  status        text not null default 'sent',  -- sent | suppressed | not_sent | error
  reason        text,
  recipients    jsonb,
  subject       text,
  rendered_html text,
  message_id    text,
  sent_at       timestamptz,
  opened_at     timestamptz,
  created_at    timestamptz not null default now(),
  constraint roi_event_emails_dedupe unique (team_id, email_type, event_key),
  constraint roi_event_emails_department_check check (department = any (array['sales','service'])),
  constraint roi_event_emails_type_check check (email_type = any (array['post_appointment','post_conversation','action_item','action_item_overdue'])),
  constraint roi_event_emails_status_check check (status = any (array['sent','suppressed','not_sent','error']))
);
create index if not exists roi_event_emails_team_idx on public.roi_event_emails (team_id, created_at desc);
create index if not exists roi_event_emails_type_idx on public.roi_event_emails (email_type, created_at desc);

alter table public.roi_event_emails enable row level security;
drop policy if exists roi_anon_read_event_emails on public.roi_event_emails;
drop policy if exists roi_read_event_emails      on public.roi_event_emails;
create policy roi_anon_read_event_emails on public.roi_event_emails for select to anon          using (true);
create policy roi_read_event_emails      on public.roi_event_emails for select to authenticated using (true);
