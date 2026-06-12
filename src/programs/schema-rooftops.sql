-- Rooftop-level tech-stack table.
--
-- CRM, Service Scheduler, and DMS are facts about the dealership rooftop, not
-- the agent product. The same rooftop running Sales-IB + Service-IB + Sales-OB
-- shares one CRM, one scheduler, one DMS. Storing these per (rooftop × agent)
-- meant entering the same value 4 times and risking drift; this table fixes
-- that by storing each once, keyed by rooftop.
--
-- rooftop_key format mirrors how accountKey is generated in the client:
--   • "tid:<team_id>"  when the rooftop has a Metabase team_id
--   • "name:<lower-rooftop-name>" fallback when there's no team_id
-- (Strip the "::AgentType" suffix from any existing accountKey to get this.)

create table if not exists programs_rooftops (
  rooftop_key             text primary key,
  crm_name                text not null default '',
  service_scheduler_name  text not null default '',
  dms_name                text not null default '',
  updated_at              timestamptz not null default now()
);

-- Match the permissive RLS pattern used by the other programs_* tables.
alter table programs_rooftops enable row level security;
drop policy if exists "programs_rooftops_all" on programs_rooftops;
create policy "programs_rooftops_all"
  on programs_rooftops
  for all
  to anon, authenticated
  using (true) with check (true);

-- ─── One-time data migration ────────────────────────────────────────────────
-- Collapses any existing per-(rooftop × agent) values on programs_account_state
-- into rooftop-level rows here. Picks the latest non-empty value seen for each
-- field so a partially-filled rooftop is fully populated.
insert into programs_rooftops (rooftop_key, crm_name, service_scheduler_name, dms_name)
select
  regexp_replace(account_key, '::.+$', '')                     as rooftop_key,
  coalesce(max(nullif(crm_name, '')),               '')        as crm_name,
  coalesce(max(nullif(service_scheduler_name, '')), '')        as service_scheduler_name,
  coalesce(max(nullif(dms_name, '')),               '')        as dms_name
from programs_account_state
where coalesce(crm_name, '') <> ''
   or coalesce(service_scheduler_name, '') <> ''
   or coalesce(dms_name, '') <> ''
group by rooftop_key
on conflict (rooftop_key) do update set
  crm_name               = coalesce(nullif(excluded.crm_name,               ''), programs_rooftops.crm_name),
  service_scheduler_name = coalesce(nullif(excluded.service_scheduler_name, ''), programs_rooftops.service_scheduler_name),
  dms_name               = coalesce(nullif(excluded.dms_name,               ''), programs_rooftops.dms_name),
  updated_at             = now();

-- After this migration the per-(rooftop × agent) columns on programs_account_state
-- are unused by the app — safe to leave them (acts as backup) or drop later:
--   alter table programs_account_state drop column crm_name;
--   alter table programs_account_state drop column service_scheduler_name;
--   alter table programs_account_state drop column dms_name;
