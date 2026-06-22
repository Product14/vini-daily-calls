-- "Star" focus flag for each account (rooftop × agent).
-- Operator-controlled: star the rooftops you want to focus on right now to
-- highlight them and filter to them on the Account List + Path to Green tabs.
-- Mirrors the actual_live flag — per (rooftop × agent), keyed by account_key.
--
-- Run in the Supabase SQL editor (same project as the other programs_* tables).
-- Idempotent — safe to re-run.

alter table programs_account_state
  add column if not exists starred boolean not null default false;
