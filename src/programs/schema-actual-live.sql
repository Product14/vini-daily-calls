-- Per (rooftop × agent) "Actually Live" flag.
--
-- The funnel sheet's `Stage = Live` tells us the contract is live, but a
-- handful of those agents haven't fully gone-live in production (no traffic,
-- pending integration, etc.). This flag captures the operator's hand-curated
-- view of who is actually shipping today.
--
-- Source of truth long-term: the dashboard checkbox (per row in Account List).
-- Seeded once via `node scripts/import-actual-status.js` from the CSV in the
-- same folder. After that, the CSV is irrelevant.
--
-- All aggregate widgets (Overview RAG bar, per-agent KPI cards, By Cohort
-- breakdown, Email Report) filter to actual_live = true. The Account List
-- and Path to Green tabs continue to show every row so the operator can
-- toggle the flag and manage tasks on accounts that aren't live yet.

alter table programs_account_state
  add column if not exists actual_live boolean not null default false;

create index if not exists idx_programs_account_state_actual_live
  on programs_account_state(actual_live) where actual_live = true;
