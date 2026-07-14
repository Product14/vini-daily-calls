-- 0019 · Stage-relevant owners alongside cs_poc (CSM). AE = Account Executive (owns the deal while
-- contracting); OB = Onboarding POC (owns the account while onboarding). The tracker's LifecycleList
-- shows the owner relevant to each rooftop's stage — AE on contracting rows, OB on onboarding rows,
-- CSM otherwise. Sourced from ClickHouse aggregated_data.aggregated_product_line_details
-- (ae_poc_email / ob_poc_email) by the sync-lifecycle cron. Applied to prod via Supabase MCP 2026-07-14.
alter table roi_rooftop_config
  add column if not exists ae_poc text,
  add column if not exists ob_poc text;
