-- Account Programs · Path to Green
-- Run in Supabase SQL editor → New Query.
-- Project: https://zocdmtehlfeozrtitmej.supabase.co

create table if not exists programs_account_state (
  account_key   text primary key,
  rooftop_id    text,
  agent_type    text,
  account_dri   text not null default '',
  root_causes   text[] not null default '{}',
  notes         text not null default '',
  updated_at    timestamptz not null default now()
);

create table if not exists programs_tasks (
  id            uuid primary key default gen_random_uuid(),
  account_key   text not null,
  title         text not null default '',
  task_dri      text not null default '',
  "function"    text not null default 'CSM',
  due_date      date,
  status        text not null default 'Open',
  blocker_note  text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_programs_tasks_account_key on programs_tasks(account_key);

-- First-cut RLS: disabled so the publishable client key can read/write directly.
-- Lock this down (move to service-role proxy via Express) once the dashboard has
-- a wider audience.
alter table programs_account_state disable row level security;
alter table programs_tasks disable row level security;
