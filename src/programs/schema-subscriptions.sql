-- Per-recipient × per-type × per-channel subscription matrix for the ROI notification system.
-- Companion to schema-sms.sql. Additive + safe. Run in the reporting-vini Supabase SQL editor.
--
-- The matrix lets each recipient subscribe to any of the 7 email_types on email and/or SMS
-- independently, on top of the per-channel master kill-switches (roi_recipients.email_enabled /
-- sms_enabled) and the rooftop-level gates (roi_rooftop_config.<type>_enabled + sms_enabled).
--
-- Shape: { "<email_type>": { "email": bool, "sms": bool }, ... }
-- A MISSING key means "use the default" (see server/roi-cron/subscriptions.cjs defaultSub):
--   email, all types            -> ON   (preserves "email_enabled person gets every enabled type")
--   sms,  transactional types   -> ON   (post_appointment/post_conversation/action_item/action_item_overdue)
--   sms,  digest types          -> OFF  (daily/weekly/monthly — new, opt-in only; no surprise blasts)
-- So an empty '{}' backfill leaves every existing recipient's behavior unchanged.

alter table roi_recipients add column if not exists subscriptions jsonb not null default '{}'::jsonb;
