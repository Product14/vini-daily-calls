-- 0009 · Per-rooftop SMS post-conversation CADENCE selector.
--
-- The SMS post-conversation email can now fire on one of three cadences, chosen per
-- rooftop ("configurable based on the dealer's ask"):
--   • 'daily'            = ONE end-of-day digest per lead/day (the behavior in production
--                          today) — default, so every existing rooftop is unchanged. A late
--                          same-day reply folds into that digest; the next day starts a fresh
--                          email.
--   • 'session'          = split a lead's thread on lulls > EVENT_SMS_SESSION_GAP_MIN
--                          (default 180 min); each settled burst that had a customer reply is
--                          its own email. Timelier, more emails.
--   • 'first_plus_digest'= an instant push on the lead's FIRST reply of the day, plus the EOD
--                          digest for the full thread.
--
-- The event cron (eventRunner.cjs) reads this column. Calls and multi-day behavior are
-- unaffected (every cadence stays day-scoped, so the next day always starts a new email).
--
-- Safe + additive: NOT NULL DEFAULT 'daily' means no rooftop changes behavior until a human
-- opts it into another cadence. Idempotent (add column if not exists) so it can be re-run.

alter table roi_rooftop_config
  add column if not exists sms_post_conversation_cadence text not null default 'daily';

-- guard the allowed values (idempotent: drop+add so a re-run is clean)
alter table roi_rooftop_config
  drop constraint if exists roi_rooftop_config_sms_cadence_chk;
alter table roi_rooftop_config
  add constraint roi_rooftop_config_sms_cadence_chk
  check (sms_post_conversation_cadence in ('daily', 'session', 'first_plus_digest'));
