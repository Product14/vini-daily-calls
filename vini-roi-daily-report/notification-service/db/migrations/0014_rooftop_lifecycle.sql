-- 0014 · Rooftop LIFECYCLE stage (onboarding / contracting / live / churn).
--
-- Today the Email Tracker only ever shows a rooftop once it has an is_live=true row in
-- roi_live_departments (seeded by the sync-live cron from ClickHouse's "onboarded + active"
-- candidates query). Anything earlier in the customer lifecycle — contracted but not yet
-- technically onboarded, or mid-onboarding — is invisible, even though the onboarding team
-- needs to configure recipients/cadence for it ahead of go-live.
--
-- These columns are populated by a NEW sync job (sync-lifecycle, parallel to sync-live) from
-- the canonical ClickHouse ARR/lifecycle query (credit_v2.arrChangeEvents +
-- aggregated_data.aggregated_product_line_details), which computes a 6-value bucket:
--   Contract-Initiated → PWS → Onboarding → OB-Live → Live → Churned
-- mapped down to the 4 stages the tracker's UI shows:
--   Contract-Initiated, PWS  → 'contracting'
--   Onboarding, OB-Live      → 'onboarding'
--   Live                     → 'live'
--   Churned                  → 'churn'
--
-- Default 'live' means every rooftop that exists today keeps behaving exactly as now (visible,
-- counted in "Sent rate") until the sync job classifies it. The sync job's upsert payload only
-- ever contains THESE columns (never daily_enabled/recipients/etc.), so it can never clobber
-- human-set config — see server/roi-cron/runner.cjs syncLifecycle().
alter table roi_rooftop_config
  add column if not exists arr_bucket text,
  add column if not exists lifecycle_status text not null default 'live',
  add column if not exists contracted_date timestamptz,
  add column if not exists onboarding_date timestamptz,
  add column if not exists ob_live_date timestamptz,
  add column if not exists live_date timestamptz,
  add column if not exists churn_date timestamptz,
  add column if not exists lifecycle_synced_at timestamptz,
  add column if not exists enterprise_name text,
  add column if not exists team_name text;

alter table roi_rooftop_config
  drop constraint if exists roi_rooftop_config_lifecycle_status_chk;
alter table roi_rooftop_config
  add constraint roi_rooftop_config_lifecycle_status_chk
  check (lifecycle_status in ('onboarding', 'contracting', 'live', 'churn'));
