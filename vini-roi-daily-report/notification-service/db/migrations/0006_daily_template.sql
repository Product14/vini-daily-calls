-- 0006 · Per-rooftop DAILY-digest template selector (classic v1 / redesign v2).
--
-- The daily digest can now render in one of two templates, chosen per rooftop:
--   • 'v1' = the CLASSIC email (the one in production today) — default, so every
--            existing rooftop keeps getting exactly the email it gets now.
--   • 'v2' = the redesigned "Conversational AI 2.0" email (digestTemplate.cjs).
--
-- The cron (runner.cjs pickTemplate/renderDigest/guardrailFor) reads this column;
-- the Email Tracker flips it per rooftop. Weekly/monthly digests are always v2
-- (they only exist in the new template) and are unaffected by this column.
--
-- Safe + additive: NOT NULL DEFAULT 'v1' means no rooftop changes behavior until a
-- human opts it into 'v2'. Idempotent (add column if not exists) so it can be re-run.

alter table roi_rooftop_config
  add column if not exists daily_template text not null default 'v1';

-- guard the allowed values (idempotent: drop+add so a re-run is clean)
alter table roi_rooftop_config
  drop constraint if exists roi_rooftop_config_daily_template_chk;
alter table roi_rooftop_config
  add constraint roi_rooftop_config_daily_template_chk
  check (daily_template in ('v1', 'v2'));
