-- 0022 · Per-rooftop post-conversation email FORMAT selector.
--
-- Mirrors how `daily_template` already lets a rooftop take the v1 or v2 daily digest: some dealers
-- don't want a "conversation summary" at all, they want a LEAD SHEET they can key into their CRM by
-- hand. Superior Auto (team 27ec3720db) is the first — Eva never books for them (she captures
-- interest + a preferred time and promises a morning callback), and they have no CRM API, so the
-- BDC re-types each lead from the email. Their agreed field list, verbatim: Zipcode, Vehicle of
-- Interest, Appointment time, Phone Number, Financing Option Required (+ name/email/location).
--
--   null / 'default'  → renderPostConversation (unchanged; every existing rooftop)
--   'lead_capture'    → renderLeadCapture, enriched from ClickHouse (server/roi-cron/leadCaptureCH.cjs)
--
-- Format only: it does NOT change WHICH conversations email (post_conversation_mode /
-- outbound_requires_reply / the rollup + dedupe gates all still decide that).
alter table roi_rooftop_config
  add column if not exists post_conversation_template text;
