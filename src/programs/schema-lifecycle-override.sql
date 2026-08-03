-- Manual lifecycle-stage override for roi_rooftop_config.
--
-- WHY THIS EXISTS
-- roi_rooftop_config.lifecycle_status is derived every morning by the sync-lifecycle cron from the
-- ARR/billing ledger (aggregated_data.aggregated_product_line_details). It is authoritative about
-- BILLING and nothing else, and it lags operational reality badly in both directions:
--   • 35 rooftops sit at 'PWS' (tracker shows "Contracting") while the platform stamps them Live.
--   • paragonhonda ran 2,186 calls / 1,398 SMS in 30d while labeled 'contracting'.
--   • Superior Auto never got an onboarding_date stamped, so it showed Contracting while its OB
--     team had it in training and a sibling team record was taking live calls daily.
-- Setting lifecycle_status by hand does not survive: the sync OVERWRITES it on the next 05:10 run
-- (only churn is sticky). Four rooftops set to 'live' on 2026-07-30 were back to 'onboarding' by
-- 05:10 the next morning. This column is the durable place for a human's answer.
--
-- DESIGN
-- The override is a SEPARATE column, never written by the sync, so the ledger's own value stays
-- intact underneath for auditing and for the ledger-vs-reality comparisons that keep coming up.
-- Preservation is automatic and needs no cron change: syncLifecycle's upsert payload only ever
-- contains the columns it computes, and Postgres ON CONFLICT DO UPDATE touches only columns
-- present in the payload.
--   >>> Do NOT add lifecycle_status_override to that payload, or overrides start getting clobbered.
--
-- CHURN ALWAYS WINS. lifecycle_effective below refuses to let an override mask a churned rooftop:
-- mailing a cancelled dealer is the one failure worse than a mislabeled stage, and the send-side
-- churn gate (subscriptions.cjs isChurned) reads lifecycle_status/churn_date directly and is not
-- affected by this column at all. An override can move a rooftop among live/onboarding/contracting
-- and nothing else.
--
-- The past-churn_date rule deliberately lives in the cron and in isChurned, NOT here: a generated
-- column must be immutable, so it cannot compare against current_date. That is fine, because
-- syncLifecycle already forces lifecycle_status='churn' when churn_date has passed, so testing
-- lifecycle_status is sufficient for display purposes.

alter table roi_rooftop_config
  add column if not exists lifecycle_status_override text
    check (lifecycle_status_override is null
           or lifecycle_status_override in ('live', 'onboarding', 'contracting')),
  add column if not exists lifecycle_override_at timestamptz,
  add column if not exists lifecycle_override_by text;

comment on column roi_rooftop_config.lifecycle_status_override is
  'Human-set stage that survives the sync-lifecycle cron. NULL = follow the ledger. Cannot be '
  'set to churn and cannot mask a churned rooftop (see lifecycle_effective). Never written by the cron.';

-- The column every READ path should use. Stored + generated so PostgREST can filter on it directly
-- (.in("lifecycle_effective", [...])) — a coalesce cannot be expressed through the query builder.
alter table roi_rooftop_config
  add column if not exists lifecycle_effective text
    generated always as (
      case when lifecycle_status = 'churn' then 'churn'
           else coalesce(lifecycle_status_override, lifecycle_status) end
    ) stored;

comment on column roi_rooftop_config.lifecycle_effective is
  'Read this, not lifecycle_status: the human override applied over the ledger value, with churn '
  'always winning. Generated — never write to it.';

create index if not exists roi_rooftop_config_lifecycle_effective_idx
  on roi_rooftop_config (lifecycle_effective);
