-- Email recipients for the Account Programs daily snapshot.
-- Run in the Supabase SQL editor (same project as the other programs_* tables).

create table if not exists programs_email_recipients (
  id        uuid primary key default gen_random_uuid(),
  email     text not null unique,
  name      text not null default '',
  active    boolean not null default true,
  added_at  timestamptz not null default now()
);

create index if not exists idx_programs_recipients_active
  on programs_email_recipients(active);

-- First-cut RLS — match the rest of the programs_* tables.
alter table programs_email_recipients enable row level security;
drop policy if exists "programs_recipients_all" on programs_email_recipients;
create policy "programs_recipients_all"
  on programs_email_recipients
  for all
  to anon, authenticated
  using (true) with check (true);
