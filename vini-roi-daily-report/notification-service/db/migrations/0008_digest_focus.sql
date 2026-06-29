-- 0008 · Per-rooftop digest CONTENT FOCUS — appointment-led vs conversation-led.
--
-- Orthogonal to daily_template (0006, which is the v1/v2 DESIGN). digest_focus is
-- the content STRATEGY — what the digest leads with — and it spans daily, weekly
-- AND monthly (the offering doesn't change by cadence):
--   • 'conversation' — conversations handled are the headline; appointments demote
--     to a down-funnel widget. The ~90% of rooftops whose offering (after-hours /
--     overflow / outbound) rarely books a daily appointment. Leading with "0
--     appointments" on those reads as failure and drives churn — this fixes that.
--   • 'appointment'  — appointments are the headline (the current redesign layout).
--     The top closers: STL / during-hours / strong daily booking cadence.
--   • 'auto' (default) — resolver decides. Today it resolves to 'conversation' (the
--     safe 90% default); Phase 2 will auto-derive 'appointment' from the rooftop's
--     feature-enablement flags (STL / during-hours / outbound campaign).
--
-- The cron (runner.cjs pickFocus → renderDigest → digestTemplate.cjs opts.focus)
-- reads this column; the Email Tracker flips it per rooftop. Set per rooftop, stable
-- day-to-day (NOT recomputed from yesterday's appointment count).
--
-- Safe + additive + idempotent. Default 'auto' → conversation-led for the 90%.

alter table roi_rooftop_config
  add column if not exists digest_focus text not null default 'auto';

alter table roi_rooftop_config
  drop constraint if exists roi_rooftop_config_digest_focus_chk;
alter table roi_rooftop_config
  add constraint roi_rooftop_config_digest_focus_chk
  check (digest_focus in ('auto', 'conversation', 'appointment'));
