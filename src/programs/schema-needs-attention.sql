-- NEEDS ATTENTION — a first-class transactional email type.
-- Additive + idempotent. Run in the reporting-vini Supabase SQL editor (project qludnojfibguobgeeujw)
-- BEFORE deploying the /api/notify/needs-attention route: without step 1 every insert fails the
-- email_type CHECK and the route answers 500.
--
-- Why a real type rather than riding post_conversation (which is what 'chat' does): a
-- needs-attention email is a different job with a different audience and a different noise
-- profile, and the tracker has to be able to show "how often does Vini hand a thread back" as its
-- own number. Sharing post_conversation's grain would hide it inside conversation summaries.

-- 1) allow the new email_type on the event ledger + its SMS twin -------------------------------
alter table public.roi_event_emails drop constraint if exists roi_event_emails_type_check;
alter table public.roi_event_emails add constraint roi_event_emails_type_check
  check (email_type = any (array['post_appointment','post_conversation','action_item','action_item_overdue','needs_attention']));

-- roi_event_sms reuses the email_type vocabulary (schema-sms.sql). No SMS body exists for this
-- type yet, so nothing writes here — the constraint is widened only so it doesn't become the
-- blocker the day someone adds one.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'roi_event_sms')
     and exists (select 1 from information_schema.constraint_column_usage
                 where table_schema = 'public' and table_name = 'roi_event_sms' and constraint_name = 'roi_event_sms_type_check') then
    execute 'alter table public.roi_event_sms drop constraint roi_event_sms_type_check';
    execute $c$alter table public.roi_event_sms add constraint roi_event_sms_type_check
      check (email_type = any (array['post_appointment','post_conversation','action_item','action_item_overdue','needs_attention']))$c$;
  end if;
end $$;

-- 2) per-rooftop kill switch ---------------------------------------------------------------------
-- DEFAULT TRUE, matching chat_enabled: needs-attention is rare and high-intent (a thread the AI
-- could not finish), so it must not need per-rooftop enabling to work. Set false to opt a rooftop
-- out. The send path treats ONLY an explicit false as off, so a NULL on an old row still sends.
alter table public.roi_rooftop_config add column if not exists needs_attention_enabled boolean not null default true;

-- 3) recipient subscription cell -----------------------------------------------------------------
-- Nothing to migrate: roi_recipients.subscriptions is a jsonb matrix and a MISSING key means
-- "use the default" (server/roi-cron/subscriptions.cjs defaultSub) — email ON, SMS OFF for this
-- type, since it is in EMAIL_ONLY_TYPES. A recipient opts out with:
--   update roi_recipients
--      set subscriptions = jsonb_set(coalesce(subscriptions,'{}'::jsonb), '{needs_attention}', '{"email":false,"sms":false}'::jsonb, true)
--    where team_id = '<team>' and email = '<addr>';
-- Deliberately NOT ridden on the post_conversation cell: many seeded recipients carry an explicit
-- post_conversation:false (call-summary noise), and reusing that cell would silence needs-attention
-- for exactly the rooftops that muted conversation summaries — the same trap chat hit.

-- 4) verify -------------------------------------------------------------------------------------
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'roi_event_emails_type_check';
-- select count(*) from roi_rooftop_config where needs_attention_enabled;
