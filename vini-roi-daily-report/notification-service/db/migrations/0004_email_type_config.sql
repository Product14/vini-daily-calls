-- 0004 · Per-rooftop enable/disable for every email TYPE (rooftop-level config).
--
-- The three CADENCE digests already have flags on roi_rooftop_config
-- (daily_enabled / weekly_enabled / monthly_enabled). This adds the four
-- TRANSACTIONAL types plus the firing-policy knobs the requirements call for:
--   • post-conversation can fire on every conversation, or only when actionable
--   • outbound post-conversation should only fire once the customer replied
--     (so a cold-outreach blast of thousands doesn't email the dealer thousands of times)
--   • an action item escalates to an "overdue" email after an SLA window
--
-- Safe defaults: new transactional emails are OFF until a rooftop opts in.
-- Idempotent (add column if not exists) so it can be re-run.

alter table roi_rooftop_config
  add column if not exists post_appointment_enabled    boolean not null default false,
  add column if not exists post_conversation_enabled   boolean not null default false,
  add column if not exists action_item_enabled         boolean not null default false,
  add column if not exists action_item_overdue_enabled boolean not null default false,
  -- 'actionable' → only conversations with an action/outcome; 'all' → every conversation
  add column if not exists post_conversation_mode       text    not null default 'actionable',
  -- outbound: require a customer reply before a post-conversation email fires
  add column if not exists post_conversation_outbound_requires_reply boolean not null default true,
  -- minutes an action item may sit before the overdue/SLA-breach email fires
  add column if not exists action_item_sla_minutes      integer not null default 20;

-- guard the enum-like text column
do $$ begin
  alter table roi_rooftop_config
    add constraint roi_rooftop_config_post_conv_mode_chk
    check (post_conversation_mode in ('actionable','all'));
exception when duplicate_object then null; end $$;
