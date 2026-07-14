-- 0018 · Operational-activity rollup on roi_rooftop_config. ORTHOGONAL to lifecycle_status:
-- lifecycle_status = where the account is in the billing lifecycle (contracting/onboarding/live/churn);
-- these = whether the AI is ACTUALLY handling calls/SMS right now (last 30 days), regardless of billing
-- stage or digest live-status. Lets the tracker flag "already active in onboarding/contracting" — a
-- pre-live rooftop the AI is already working (see the >50% of onboarding accounts already producing).
--
-- Populated daily by the sync-lifecycle cron (server/roi-cron/runner.cjs ACTIVITY_SQL) from ClickHouse
-- dealer_leads (calls = endcallreports deduped by callId; SMS = conversations type='sms'), last 30d.
-- Applied to prod via Supabase MCP on 2026-07-14.
alter table roi_rooftop_config
  add column if not exists calls_30d integer,
  add column if not exists sms_30d integer,
  add column if not exists last_activity_at timestamptz,
  add column if not exists activity_synced_at timestamptz;
