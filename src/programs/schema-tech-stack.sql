-- Tech-stack columns for each account: CRM, service scheduler, DMS.
-- All free-text, editable from the dashboard's account drawer. The drawer
-- presents previously-typed values as dropdown suggestions but anything can
-- be typed in fresh — these are not enums so vendor additions don't need a
-- schema migration.
--
-- Run in Supabase SQL editor. Idempotent — safe to re-run.

alter table programs_account_state
  add column if not exists crm_name               text not null default '';
alter table programs_account_state
  add column if not exists service_scheduler_name text not null default '';
alter table programs_account_state
  add column if not exists dms_name               text not null default '';
