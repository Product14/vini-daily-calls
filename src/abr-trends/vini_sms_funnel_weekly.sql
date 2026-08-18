-- Vini SMS Funnel — Weekly Diagnostics Time Series
--
-- Purpose: first place to look when appointment booking rates or reply rates move.
-- One row per week x rooftop x agent_bucket x capability. Scan DOWN the conversion
-- columns to find which step broke, ACROSS the weeks to find when it broke.
--
-- Funnel: leads texted -> replied -> action item -> qualified -> tool call -> booked
-- plus loss-reason columns that tell you whether the funnel broke or the INPUT got
-- worse (volume dilution).
--
-- SCOPE: this query deliberately uses ONLY conversations, smsMessages,
-- smsChatCompletions and meetings. It does NOT touch funnelEval, conversationEval or
-- conversationLeadEval -- those only hold data from 2026-08-01 and would put a fake
-- cliff in a time series that starts earlier. The pitch sub-funnel that needs them
-- lives in vini_sms_pitch_funnel.sql, to be folded in once the backfill lands.
--
-- ============================================================================
-- HOW TO RUN (ClickHouse MCP / routines)
--   Edit date_from / date_to_excl in the WITH block below.
--   date_from should be a MONDAY, otherwise the first bucket is a partial week.
--   date_to_excl is EXCLUSIVE.
--   Single statement, no trailing semicolon — what MCP run_query expects.
-- ============================================================================
--
-- ---------------------------------------------------------------------------
-- GRAIN AND SUMMABILITY  (read before aggregating anything)
-- ---------------------------------------------------------------------------
-- Every count is DISTINCT LEADS, not conversations.
--
--   Safe to sum across rooftops        -- lead_id is team-scoped, no overlap.
--   Safe to sum across agent_buckets   -- an agent bucket is fixed per conversation,
--                                         but note a lead texted by both a sales and
--                                         a service agent in one week appears in both.
--   NOT safe to sum across capability  -- but ONLY at lead level, and the effect is
--                                         small. Each conversation belongs to exactly
--                                         one capability, and each appointment maps to
--                                         exactly one conversation. The overlap is
--                                         that a LEAD can hold several conversations
--                                         in one week under different capabilities
--                                         (an STL text plus a follow-up text), and
--                                         these are distinct-LEAD counts, so that lead
--                                         appears in both rows.
--                                         Measured, sales_inbound Jun-Aug 2026:
--                                           leads_texted   36,509 summed vs 32,844 true (+11.2%)
--                                           replied_leads   8,910 summed vs  8,375 true (+6.4%)
--                                           booked_leads      706 summed vs    705 true (+0.1%)
--                                         So bookings are effectively unaffected; the
--                                         top of the funnel is not. Use the
--                                         pre-computed capability = 'All Capabilities'
--                                         row, which is deduped at every level.
--   NEVER average the _pct columns     -- re-derive them from the count columns.
--
-- ---------------------------------------------------------------------------
-- WHY EACH SOURCE  (all verified live 2026-08-13, not assumed)
-- ---------------------------------------------------------------------------
-- conversations.conversationAnalytics -- outcome + dealerActionItems. Only written
--   when a customer replies, so its raw fill rate looks like ~10%. Among REPLIED
--   conversations coverage is 99-100% every month since Nov 2025. It is the right
--   source; the low headline number is not a gap.
--
-- smsChatCompletions.messages -- SMS tool calls. This table IS replicated to
--   ClickHouse (658k rows, conversation grain); older repo notes calling it
--   Mongo-only are stale. conversation_ai.tool_invocation_events has ZERO overlap
--   with SMS conversationIds -- it is voice-only. Do not substitute it.
--
-- meetings -- the only trustworthy booking signal.
--   conversationAnalytics.appointmentDetails.status is NOT one: its most common
--   value is 'cancellation_requested' (17,798 since June, more than 'Opt Out').
--
-- The eval tables (funnelEval / conversationEval / conversationLeadEval) are NOT used
--   here -- see SCOPE above. Measured coverage of funnelEval over texted leads ran
--   ~1% in Jun 2026 rising to ~93% by 2026-08-03, so any pitch trend read across that
--   boundary is coverage ramping, not agent behaviour.
--
-- ---------------------------------------------------------------------------
-- BOOKED ATTRIBUTION  (deliberately strict)
-- ---------------------------------------------------------------------------
-- meetings.conversation_id = conversations.conversationId, source = 'spyne',
-- is_active = 1. The SAME conversation must be both the funnel conversation and the
-- meeting's source.
--
-- Consequence, known and accepted: sales_outbound reads LOW (2-21 bookings/week vs
-- 21-126 for sales_inbound), because an outbound-warmed lead is frequently closed on
-- a call, and that meeting carries a call_id instead. Treat sales_outbound booking
-- rate as a FLOOR, not the true rate. Trend within the bucket is still valid --
-- the undercount is structural and roughly constant.
--
-- is_active = 1 means a cancelled appointment is not counted as booked. Matches
-- apps/reporting-vini/vini_capability_split.sql. If you want gross bookings, drop that predicate.
--
-- PRE-EXISTING APPOINTMENTS ARE EXCLUDED, and this one is not obvious.
--
-- 306 of 1,513 "booked" SMS conversations over Jun-Aug 2026 had their meeting created
-- in the SAME SECOND as the conversation itself. Reading the message bodies makes it
-- plain what they are:
--     "Hi Patricia, it's Benjamin at Poughkeepsie Nissan. Thanks for trusting us with
--      your 2025 Nissan Rogue SV, we'll see you Thursday, August 13. Also ..."
--     "... we've got some strong upgrade offers right now, and you may have solid
--      trade value since you maintain it here ..."
-- That is an equity-mining / service-upsell campaign. The customer ALREADY had a
-- service appointment, booked by the service department. The campaign spawns an SMS
-- conversation and writes the meeting row at the same instant, and meetings.source is
-- 'spyne', so no source filter excludes it. Counting these as bookings credits the SMS
-- agent for appointments it did not make.
--
-- The timing separation is clean, which is why 30s is safe:
--     genuine bookings   min gap  46s, p1  93s, p50 1,178s   (sales_inbound)
--                        min gap  97s, p1 125s              (service_outbound)
--                        min gap 163s                       (sales_outbound)
--     pre-existing       p50 0s, p5 -1s, min -1,203,972s (one meeting predates its
--                        conversation by 14 days)
--
-- 306 of the 310 affected conversations sit in the `unknown_unknown` agent bucket
-- (98.7% of that bucket's bookings). sales_inbound, sales_outbound and service_outbound
-- contain ZERO of them. So the named buckets were always clean, and this fix mostly
-- empties unknown_unknown -- which is the correct outcome, since that bucket is this
-- campaign.
--
-- Consequence: booked_leads_unreplied should now be 0 everywhere. If it is not, a new
-- variant of this pattern has appeared. Do not "fix" it by widening the denominator.
--
-- ---------------------------------------------------------------------------
-- QUALIFIED  (two disjoint vocabularies -- edit the two arrays below, nowhere else)
-- ---------------------------------------------------------------------------
-- Sales and service outcome vocabularies have NO overlap in the SMS data. A single
-- allowlist scores every service conversation as 0% qualified, which reads as a real
-- collapse on a quick scan. Hence two arrays, selected by agent_service.
--
-- Deliberately EXCLUDED from service qualified, flip if you disagree:
--   'Customer Already Self Booked' (298 convs) -- customer wanted service but booked
--       it themselves. Arguably a qualified lead the AI failed to convert. It has its
--       own column, leads_self_booked, so it is visible either way.
--   'Location Shared', 'Operating Hours Shared' -- logistics, no service intent.
--   'Soft Decline', 'Could Not Conclude'        -- no intent expressed.
--
-- Any outcome string in neither the qualified nor the known list surfaces in
-- unmapped_outcome_leads. If that goes non-zero the vocabulary moved and these
-- arrays need updating -- it does NOT silently score as not-qualified.
--
-- HISTORY: the original allowlist excluded 'Vehicle Inquiry' and 'General
-- Engagement', which left ~58% of actual bookings sitting outside 'qualified'. Both
-- were added 2026-08-13 on measured booking rate (see the arrays below). That took
-- booked_not_qualified_leads from 783 of 1,416 bookings (58%) down to 355 (25%).
-- Excluding pre-existing appointments (see BOOKED ATTRIBUTION below) then took it to
-- 134 of 1,195 (11.2%) -- most of the residual 25% was never a definition problem at
-- all, it was the equity-mining campaign being counted as bookings.
-- What is left is genuinely outside the allowlist, chiefly service's
-- 'Customer Already Self Booked' (a customer who wanted service and booked it
-- themselves, deliberately excluded and separately exposed as leads_self_booked).
-- booked_not_qualified_leads stays on every row as the standing check.
-- qualified_to_booked_pct can therefore still exceed 100%. It is a RATIO -- bookings
-- per qualified lead -- not a share of a subset.
--
-- ---------------------------------------------------------------------------
-- CAPABILITY  (same bucketing as apps/reporting-vini/vini_capability_split.sql, so numbers reconcile)
-- ---------------------------------------------------------------------------
-- Resolved via conversations.followupId = sequenceTasks.taskId:
--   taskType IN ('STL','STL_FOLLOW_UP')      -> Speed to Lead
--   taskType  = 'FOLLOW_UP'                  -> Followup Sequence
--   taskType  = 'APPOINTMENT_REMINDER'       -> Appointment Reminder
--   taskType  = 'INVENTORY_EVENT'            -> Inventory Event
--   taskType empty AND followupId IS NULL    -> Speed to Lead      (legacy)
--   taskType empty AND followupId IS NOT NULL-> Followup Sequence  (legacy)
-- taskType shipped 2026-06-16 and was not backfilled, so the legacy fallback is
-- era-self-selecting and no date cutoff is needed. Without it this table would show
-- a fake capability shift at 2026-06-16.
--
-- Unlike apps/reporting-vini/vini_capability_split.sql, APPOINTMENT_REMINDER and INVENTORY_EVENT are
-- kept as their own rows rather than excluded. This is a diagnostics table; silently
-- dropping volume is the opposite of what it is for.
--
-- ---------------------------------------------------------------------------
-- TIME BUCKET
-- ---------------------------------------------------------------------------
-- toStartOfWeek(conversations.createdAt, 1) = Monday, UTC. Every funnel step is read
-- from inside the same conversation, so there is no cross-week attribution leakage
-- and a closed week never changes retroactively.
--
-- Weeks are UTC, NOT rooftop-local. At weekly grain the boundary effect is immaterial.
-- If you ever add local-day bucketing: ClickHouse multiIf returns the timezone of its
-- FIRST DateTime branch and renders every row in it. The toString(toTimeZone(...))
-- -then-parse workaround in apps/reporting-vini/vini_capability_split.sql is load-bearing, and
-- vini_reporting.rmv_conversation_fact.after_hours still has the broken version
-- (it buckets every rooftop in America/New_York). Do not copy that column.
-- ============================================================================

WITH
    toDate('2026-06-01')  AS date_from,
    toDate('2026-08-13')  AS date_to_excl,

    -- ---- QUALIFIED: sales -----------------------------------------------
    -- 'Vehicle Inquiry' and 'General Engagement' were added 2026-08-13 on measured
    -- conversion, having originally been classed not-qualified. Booking rate by
    -- outcome over Jun 1 - Aug 13, sales_inbound / sales_outbound:
    --     Appointment          94.12% /     -
    --     Purchase Intent      25.92% / 7.07%
    --     Trade Inquiry        20.12% / 12.26%
    --     Financing Inquiry     9.45% / 0.56%
    --     General Engagement    8.14% / 1.82%   <-- added
    --     Vehicle Inquiry       7.37% / 1.53%   <-- added
    --     Pricing Inquiry       1.49% / 0.62%
    -- Both additions out-convert Pricing Inquiry, which was already in the list, and
    -- Vehicle Inquiry alone contributed 142 bookings on sales_inbound -- more than
    -- Trade and Financing combined. Keeping them out understated qualified by ~2x.
    -- If you retune this again, retune on that table, not on how the label reads.
    ['Purchase Intent', 'Pricing Inquiry', 'Appointment', 'Financing Inquiry',
     'Trade Inquiry', 'Deposit Placed', 'Ancillary Inquiry', 'Purchase Closed',
     'Vehicle Inquiry', 'General Engagement'
    ] AS sales_qualified,

    -- ---- QUALIFIED: service ---------------------------------------------
    -- Same bar, service vocabulary. The '... Shared' outcomes are included because
    -- they are the service analogue of a sales '... Inquiry' -- the customer asked
    -- about a recall / package / estimate. 'Location Shared' and
    -- 'Operating Hours Shared' are not, being pure logistics.
    -- 'General Engagement' added 2026-08-13 for the same reason: it books at 7.12%
    -- on service_outbound and is that department's LARGEST single booking source
    -- (173 appointments off 2,430 replied leads) -- ahead of every outcome that was
    -- already in this list. 'Vehicle Inquiry' is not added here because it does not
    -- occur in the service outcome vocabulary at all.
    ['Service Appointment Booked', 'Walk In Committed', 'Callback Requested',
     'Transferred To Service Team', 'No Slots Available', 'Customer Considering',
     'Customer Open To Return', 'Drop Off Details Shared', 'Price Estimate Shared',
     'Recall Information Shared', 'Service Package Information Shared',
     'General Engagement'
    ] AS service_qualified,

    -- ---- Known-but-not-qualified: drift detector only --------------------
    -- Union of every outcome observed in SMS across both departments, including
    -- call-side strings that may leak in. Only used for unmapped_outcome_leads.
    ['Opt Out', 'Not Interested', 'Already Purchased',
     'Wrong Number', 'Reconnect Needed', 'Human Requested',
     'Human Transferred', 'Operating Hours', 'Operating Hours Shared',
     'Language Barrier', 'Decision Maker Unavailable', 'Could Not Conclude',
     'Not Connected', 'Lead Status Changed', 'Meeting Already Scheduled',
     'Customer Already Self Booked', 'Soft Decline', 'Location Shared',
     'Customer No Longer Owns Vehicle', 'Vehicle Sold Or Traded',
     'Customer Permanently Using Competitor', 'Customer Permanently Declined',
     'Customer Busy No Callback', 'Customer Relocated', 'Customer Deceased',
     'Vehicle Written Off', 'Appointment Cancelled'
    ] AS known_not_qualified,

    -- ---- Action items that are NOT dealer work -------------------------
    -- Edit here, nowhere else. An intent in this list means the agent CLOSED the lead
    -- rather than handing the dealer something to do, so counting it as "activity"
    -- inverts the metric.
    --
    -- MAINTENANCE WARNING, and this has already bitten once: the action-item intent
    -- taxonomy was REPLACED in the week of 2026-06-29. The CamelCase generation
    -- ('ScheduleAppointment', 'RequestCallback', 'CheckVehicleAvailability',
    -- 'CheckVehiclePrice', 'InquireFinanceStatus', 'InquireTradeInValue') stops dead
    -- that week and the SALES_*/SERVICE_* generation starts. Any list keyed on exact
    -- intent strings therefore silently goes stale when the taxonomy moves again.
    --
    -- Two things protect against that, and neither is this list:
    --   1. leads_action_item counts ALL action items with no allowlist at all, so it
    --      can never miss a new intent. It is the primary metric. The productive split
    --      below is secondary.
    --   2. vini_sms_drilldown.sql GROUPs BY the raw intent string, so a new intent
    --      appears as its own row automatically with zero code change. Check it after
    --      any taxonomy change.
    ['SALES_LOST_LEAD'] AS action_items_not_productive,

    -- Internal / test enterprises. Same list as apps/reporting-vini/vini_capability_split.sql and
    -- funnel-dashboard-query-open.sql.
    ['91abddaec', 'f3e852d59', 'e44c9a35c', '42025c0d0', 'a4007d11f', '471dee49e',
     'cecb53a83', 'ef3a34a11', '5a42bf3dc', 'bed17d6d8', 'e5a5a9289', '59510d7b4',
     '62f962c8e'
    ] AS excluded_enterprises,

-- ---------------------------------------------------------------------------
-- Dimensions. FINAL is REQUIRED on both: they are ReplacingMergeTree CDC replicas,
-- and without it stale row versions fan out (observed 3x for one enterprise) and
-- conflicting historical dealer_name values emit as separate rooftops.
-- ---------------------------------------------------------------------------
team_dim AS (
    SELECT
        enterprise_id,
        team_id,
        coalesce(nullIf(dealer_name, ''), team_name) AS rooftop_name
    FROM eventila.enterprise_team_details FINAL
),

enterprise_dim AS (
    SELECT
        enterprise_id,
        name AS enterprise_name,
        is_test_account
    FROM eventila.enterprise_details FINAL
),

-- Lead-level service_type, used ONLY as a fallback when a conversation has no agent
-- mapping (~1,400 leads/week). Without this those leads land in a bucket with no
-- qualified definition and read as 0% qualified forever.
lead_dim AS (
    SELECT
        lead_id,
        team_id,
        argMax(lower(ifNull(service_type, '')), created_at) AS lead_service_type
    FROM dealer_leads.leads FINAL
    WHERE is_deleted = 0
      AND __deleted = 0
      AND lead_id IS NOT NULL
    GROUP BY lead_id, team_id
),

-- sequenceTasks is SharedMergeTree and does NOT support FINAL (it throws
-- ILLEGAL_FINAL). Dedupe with argMax on _version instead.
task_dim AS (
    SELECT
        taskId,
        argMax(ifNull(taskType, ''), _version) AS task_type
    FROM dealer_leads.sequenceTasks
    WHERE __deleted = 0
    GROUP BY taskId
),

-- ---------------------------------------------------------------------------
-- One row per SMS conversation, classified. conversationAnalytics is parsed exactly
-- once here. assumeNotNull is REQUIRED: the column is Nullable(String) and
-- JSONLength / JSONExtractArrayRaw on a Nullable throws ILLEGAL_TYPE_OF_ARGUMENT.
-- ---------------------------------------------------------------------------
spine AS (
    SELECT
        c.conversationId AS conv_id,
        c.leadId         AS lead_id,
        c.teamId         AS team_id,
        c.enterpriseId   AS enterprise_id,
        toStartOfWeek(c.createdAt, 1) AS week_start,
        c.createdAt                   AS ts,   -- raw, for the booking-timing check

        -- Agent bucket: agentTypes is authoritative, lead.service_type is the
        -- fallback for direction-less / mapping-less conversations.
        coalesce(
            nullIf(lower(ifNull(at.agentType, '')), ''),
            nullIf(ld.lead_service_type, ''),
            'unknown'
        ) AS agent_service,
        coalesce(nullIf(lower(ifNull(at.agentCallType, '')), ''), 'unknown') AS agent_direction,

        multiIf(
            td.task_type IN ('STL', 'STL_FOLLOW_UP'), 'Speed to Lead',
            td.task_type =  'FOLLOW_UP',              'Followup Sequence',
            td.task_type =  'APPOINTMENT_REMINDER',   'Appointment Reminder',
            td.task_type =  'INVENTORY_EVENT',        'Inventory Event',
            -- legacy era: taskType not backfilled before 2026-06-16
            (c.followupId IS NULL OR c.followupId = ''), 'Speed to Lead',
            'Followup Sequence'
        ) AS capability,

        JSONExtractString(assumeNotNull(c.conversationAnalytics), 'outcome') AS outcome,

        -- dealerActionItems is POLYMORPHIC: ~75% structured objects carrying an
        -- `intent`, ~25% bare free-text strings with no intent. That split is stable
        -- month over month (84% / 86% / 70% / 75% / 76% Apr-Aug), so it is a second
        -- concurrent shape, NOT a legacy form that will age out. JSONExtractString on
        -- a string element returns '', which is why the lost-lead count below tests
        -- for a specific intent rather than testing NOT-lost-lead.
        JSONExtractArrayRaw(assumeNotNull(c.conversationAnalytics), 'dealerActionItems') AS ai_raw,
        length(ai_raw) AS n_action_items,
        arrayCount(x -> has(action_items_not_productive, JSONExtractString(x, 'intent')), ai_raw) AS n_lost_lead,
        n_action_items - n_lost_lead AS n_action_items_productive,
        (c.conversationAnalytics IS NOT NULL AND c.conversationAnalytics NOT IN ('', '{}')) AS has_analytics

    FROM dealer_leads.conversations AS c FINAL

    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON  c.teamAgentMappingId = tam.teamAgentMappingId
        AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON  tam.agentTypeId = at.agentTypeId
        AND at.__deleted = 0

    LEFT JOIN task_dim AS td ON c.followupId = td.taskId
    LEFT JOIN lead_dim AS ld ON c.leadId = ld.lead_id AND c.teamId = ld.team_id

    WHERE c.__deleted = 0
      AND lower(c.type) = 'sms'
      AND ifNull(c.isTest, 0) = 0
      -- NOTE: status = 'failed' is deliberately NOT excluded here, which differs from
      -- apps/reporting-vini/vini_capability_split.sql and the Metabase funnel query. That status IS the
      -- failed-delivery population: of 27,137 such conversations in July, 21,563 had
      -- a failed outbound message, 97.6% of their outbound messages failed, and only
      -- 394 had anything delivered at all. Excluding them here makes delivery_rate
      -- read ~99% and hides 14% of attempted volume -- the exact volume-dilution
      -- signal this table exists to catch.
      -- leads_texted stays comparable to those queries regardless, because it is
      -- gated on delivered_out, which is strictly narrower than status != 'failed'
      -- (it admits at most those 394 conversations).
      AND c.leadId IS NOT NULL
      AND c.teamId IS NOT NULL
      AND toDate(c.createdAt) >= date_from
      AND toDate(c.createdAt) <  date_to_excl
      AND ifNull(c.enterpriseId, '') NOT IN excluded_enterprises
),

-- ---------------------------------------------------------------------------
-- Per-conversation message rollup.
--   delivered_out gates leads_texted: an SMS conversation where nothing actually
--   left the building is not a texted lead. ~9% of July outbound messages have
--   status='failed', which silently shrinks the denominator -- hence the
--   delivery-failure columns below, so that shrinkage is visible rather than
--   mistaken for a reply-rate drop.
--   replied uses authorType='human' -- 'ai' is our own agent.
-- Window is widened forward: a conversation created on the last day can still have
-- messages land after date_to_excl. Messages never precede their conversation.
-- ---------------------------------------------------------------------------
msg_agg AS (
    SELECT
        conversationId AS conv_id,
        maxIf(1, lower(direction) = 'out' AND lower(ifNull(status, '')) IN ('delivered', 'sent')) AS delivered_out,
        maxIf(1, lower(direction) = 'in'  AND lower(ifNull(authorType, '')) = 'human')            AS replied,
        countIf(lower(direction) = 'out')                                        AS n_out_total,
        countIf(lower(direction) = 'out' AND lower(ifNull(status, '')) = 'failed') AS n_out_failed
    FROM dealer_leads.smsMessages FINAL
    WHERE __deleted = 0
      AND toDate(createdAt) >= date_from
      AND toDate(createdAt) <  date_to_excl + 14
    GROUP BY conversationId
),

-- ---------------------------------------------------------------------------
-- Tool calls. Presence of a role:"tool" message = the agent executed a tool.
--
-- This column is presence-of-any-tool-call only. Tool NAMES are fully available
-- (100% of tool-bearing conversations) but live on the ASSISTANT message, not the
-- role:"tool" message, under EITHER of two key spellings:
--     assistant.toolCalls[].function.name    (camelCase -- 3,897 msgs in Aug)
--     assistant.tool_calls[].function.name   (snake_case --   369 msgs in Aug)
-- Check BOTH. Reading only snake_case finds ~5% of them and makes tool names look
-- unavailable. The role:"tool" message usually carries only _ts/content/toolCallId,
-- so it is the wrong place to look for a name.
-- Per-tool breakdown lives in vini_sms_drilldown.sql.
--
-- position() on the raw string rather than JSON parsing: messages blobs run to
-- ~10KB and this is a presence test, not an extraction.
--
-- Testing for '"role":"tool"' here is EQUIVALENT to testing for a tool call on the
-- assistant side, verified: over Jun-Aug 2026 both find exactly the same 8,501
-- conversations, with zero conversations having one without the other. So this does
-- NOT need the two-spelling treatment described above -- that only matters when
-- extracting the name. Leave it alone.
-- ---------------------------------------------------------------------------
tool_agg AS (
    SELECT DISTINCT conversationId AS conv_id
    FROM dealer_leads.smsChatCompletions FINAL
    WHERE __deleted = 0
      AND position(assumeNotNull(messages), '"role":"tool"') > 0
      AND toDate(createdAt) >= date_from - 1
      AND toDate(createdAt) <  date_to_excl + 7
),

-- Not date-filtered: a booking's created_at sits at booking time, but bounding it
-- buys nothing and risks dropping late-written meetings. 497k rows, cheap.
-- source = 'spyne' OR source IS NULL. The "has a conversation_id" half of that rule is
-- already enforced by the conversation_id predicate below, and call_id is irrelevant
-- here (this is the SMS funnel; call_id attribution belongs to the call funnel).
--
-- Be aware the NULL-source branch is very nearly a no-op. Active meetings created
-- Jun 1 - Aug 20 2026, by source:
--     spyne   5,637 total -- 1,626 with a conversation_id, 3,946 with a call_id
--     (null) 21,496 total --     3 with a conversation_id,     0 with a call_id
--     bdc    19,497 total --     3 with a conversation_id, 2,663 with a call_id
--     eleads     66 total --     0 with either
-- So including NULL-source adds 3 meetings out of ~1,626. The 21k NULL-source meetings
-- are manual / CRM-imported with no AI linkage at all, which is why they cannot be
-- credited: there is nothing tying them to a conversation.
--
-- WORTH A SEPARATE LOOK: 'bdc' holds 2,663 meetings carrying a call_id. Those may be
-- AI-booked but labelled bdc. They are irrelevant to THIS query (only 3 have a
-- conversation_id) but could be materially undercounting the CALL funnel.
appt_agg AS (
    SELECT
        conversation_id AS conv_id,
        groupArray(created_at) AS mtg_times
    FROM dealer_leads.meetings FINAL
    WHERE __deleted = 0
      AND is_active = 1
      AND (source = 'spyne' OR source IS NULL)
      -- meta.source='warm_transfer' = the customer's EXISTING appointment, pulled in around a
      -- transfer; not a booking. The direct signal for one arm of the source='spyne' defect
      -- described above; complementary to the >30s / booking-tool separation, not a replacement.
      AND lower(JSONExtractString(ifNull(meta,''),'source')) != 'warm_transfer'
      AND conversation_id IS NOT NULL
      AND conversation_id != ''
    GROUP BY conversation_id
),

-- ---------------------------------------------------------------------------
-- Join, and expand each conversation into its own capability row plus an
-- 'All Capabilities' row. The arrayJoin is what makes the rollup row correctly
-- deduped at lead level -- summing the per-capability rows would double-count a
-- lead that got both an STL text and a follow-up text in the same week.
-- ---------------------------------------------------------------------------
enriched AS (
    -- Explicit aliases on every column are REQUIRED, not cosmetic: a bare `s.lead_id`
    -- is emitted from this subquery with the literal name `s.lead_id`, and the outer
    -- SELECT then cannot resolve `e.lead_id`.
    SELECT
        s.week_start    AS week_start,
        s.ts            AS ts,
        s.enterprise_id AS enterprise_id,
        s.team_id       AS team_id,
        concat(s.agent_service, '_', s.agent_direction) AS agent_bucket,
        arrayJoin([s.capability, 'All Capabilities'])   AS capability,
        s.lead_id        AS lead_id,
        s.conv_id        AS conv_id,
        s.outcome        AS outcome,
        s.n_action_items AS n_action_items,
        s.n_lost_lead    AS n_lost_lead,
        s.n_action_items_productive AS n_action_items_productive,
        s.has_analytics  AS has_analytics,
        ifNull(m.delivered_out, 0) AS delivered_out,
        ifNull(m.replied, 0)      AS replied,
        ifNull(m.n_out_total, 0)  AS n_out_total,
        ifNull(m.n_out_failed, 0) AS n_out_failed,
        (t.conv_id != '')         AS any_tool,

        -- A meeting created within 30s of the conversation starting cannot have been
        -- booked BY that conversation: there is no room for an outbound send, a
        -- customer reply, and a booking tool call. Those rows are a PRE-EXISTING
        -- appointment that the conversation was built around (see the note below), so
        -- they are excluded from `booked` and surfaced separately.
        arrayExists(x -> dateDiff('second', s.ts, x) >  30, a.mtg_times) AS booked,
        arrayExists(x -> dateDiff('second', s.ts, x) <= 30, a.mtg_times) AS booked_preexisting,

        -- Qualified, resolved against the department's own vocabulary.
        multiIf(
            s.agent_service = 'sales',   has(sales_qualified, s.outcome),
            s.agent_service = 'service', has(service_qualified, s.outcome),
            0
        ) AS qualified,

        -- Drift detector: an outcome we have never catalogued.
        (s.outcome != ''
         AND NOT has(sales_qualified, s.outcome)
         AND NOT has(service_qualified, s.outcome)
         AND NOT has(known_not_qualified, s.outcome)) AS unmapped_outcome

    FROM spine AS s
    INNER JOIN msg_agg AS m ON m.conv_id = s.conv_id
    LEFT  JOIN tool_agg  AS t ON t.conv_id = s.conv_id
    LEFT  JOIN appt_agg  AS a ON a.conv_id = s.conv_id
    -- Deliberately NOT filtered on delivered_out here. Conversations where delivery
    -- failed almost never contain a delivered message too (21,630 all-failed
    -- conversations vs 165,208 delivered ones in July), so filtering here would drop
    -- them entirely and the delivery-failure columns below would read 0.00 in every
    -- row -- measuring nothing, while the real ~9% failure rate silently shrank the
    -- funnel denominator. Instead delivered_out is carried through as a flag and
    -- every funnel metric is gated on it individually.
)

SELECT
    e.week_start                                    AS week_start,
    ifNull(ed.enterprise_name, '(unmapped)')        AS enterprise_name,
    ifNull(tm.rooftop_name, '(unmapped)')           AS rooftop_name,
    e.team_id                                       AS team_id,
    e.agent_bucket                                  AS agent_bucket,
    e.capability                                    AS capability,

    -- ---- top of funnel: attempted vs actually delivered -----------------
    -- leads_attempted is every lead we tried to text. leads_texted is those where
    -- something actually left the building. The GAP is the real top-of-funnel loss,
    -- and it moves independently of agent quality -- a carrier/number problem shows
    -- up here and nowhere else. Check this BEFORE concluding reply rate dropped.
    uniqExact(e.lead_id)                                      AS leads_attempted,
    uniqExactIf(e.lead_id, e.delivered_out = 1)               AS leads_texted,

    -- ---- funnel, distinct leads (all gated on delivery) -----------------
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.replied = 1)        AS replied_leads,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.n_action_items > 0) AS leads_action_item,

    -- ---- action items: composition, not a judgement --------------------
    -- leads_action_item above is the PRIMARY metric and has no allowlist, so it cannot
    -- miss a newly-added intent. These two split it so the composition is visible:
    -- SALES_LOST_LEAD alone is 76% of structured action items (5,995 of 7,901 in July)
    -- and means "mark this lead dead", so the primary column rises when the agent gives
    -- up MORE often. Read all three together, and read the drill-down for the
    -- per-intent story -- it enumerates intents rather than allowlisting them.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.n_action_items_productive > 0) AS leads_action_item_productive,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.n_lost_lead > 0)               AS leads_lost_lead_flagged,

    -- Absolute volumes, for load rather than reach: how much work landed on the
    -- dealer, and how thick each engaged lead's task list is.
    -- Safe to sum: the capability arrayJoin duplicates each conversation across
    -- DIFFERENT capability values, and capability is in the GROUP BY, so within any
    -- single output row each conversation is counted exactly once.
    sumIf(e.n_action_items,            e.delivered_out = 1) AS action_items_total,
    sumIf(e.n_action_items_productive, e.delivered_out = 1) AS action_items_productive_total,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.qualified)          AS qualified_leads,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.any_tool)           AS leads_tool_call,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.booked)             AS booked_leads,

    -- Leads that booked WITHOUT a qualified outcome. Not an error -- it measures how
    -- much of real conversion the qualified allowlist fails to capture. Across
    -- Jun-Aug 2026 this is ~58% of all bookings, concentrated in 'Vehicle Inquiry'
    -- (155), 'General Engagement' (275 across both departments) and service's
    -- 'Customer Already Self Booked' (99). Consequence: qualified_to_booked_pct
    -- routinely exceeds 100% and is a RATIO, not a share -- read it as "bookings per
    -- qualified lead", and read this column beside it before retuning the allowlist.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.booked AND NOT e.qualified) AS booked_not_qualified_leads,

    -- PRE-EXISTING appointments, excluded from booked_leads. See the long note in the
    -- header. Kept visible because the equity-mining programme is real volume -- it is
    -- just not the SMS agent booking anything.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.booked_preexisting) AS preexisting_appt_leads,

    -- Should be 0 for every named agent bucket. Non-zero means a new variant of the
    -- pre-existing-appointment pattern has appeared that the 30s rule does not catch.
    -- Treat it as a data-quality alarm, not a metric.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.booked AND e.replied = 0) AS booked_leads_unreplied,

    -- ---- conversion rates ----------------------------------------------
    round(100 * leads_texted       / nullIf(leads_attempted, 0), 2) AS delivery_rate,
    round(100 * replied_leads      / nullIf(leads_texted,   0), 2) AS reply_rate,
    round(100 * leads_action_item  / nullIf(replied_leads,  0), 2) AS reply_to_action_item_pct,
    -- The one to trust for "are conversations producing agent activity".
    round(100 * leads_action_item_productive / nullIf(replied_leads, 0), 2) AS reply_to_productive_action_item_pct,
    round(100 * leads_lost_lead_flagged      / nullIf(replied_leads, 0), 2) AS reply_to_lost_lead_pct,
    round(action_items_productive_total / nullIf(leads_action_item_productive, 0), 2) AS productive_items_per_lead,
    round(100 * qualified_leads    / nullIf(replied_leads,  0), 2) AS qualified_share_of_replies,
    round(100 * leads_tool_call    / nullIf(replied_leads,  0), 2) AS reply_to_tool_call_pct,
    -- Both denominators are now leak-free: since pre-existing appointments are
    -- excluded, 0 bookings sit outside replied_leads or leads_texted, so neither rate
    -- can exceed 100%. replied_to_booked_pct is the one to lead with (tightest to
    -- intent); texted_to_booked_pct includes the reply step, so it moves when either
    -- reply rate OR booking rate moves. booked_leads_unreplied guards the assumption.
    round(100 * booked_leads       / nullIf(leads_texted,   0), 2) AS texted_to_booked_pct,
    round(100 * booked_leads       / nullIf(replied_leads,  0), 2) AS replied_to_booked_pct,
    -- Can exceed 100% by design -- see the KNOWN LIMITATION note in the header.
    round(100 * booked_leads       / nullIf(qualified_leads,0), 2) AS qualified_to_booked_pct,

    -- ---- loss reasons: did the funnel break, or did the input get worse? -
    uniqExactIf(e.lead_id, e.outcome = 'Opt Out')                      AS leads_opt_out,
    uniqExactIf(e.lead_id, e.outcome = 'Not Interested')               AS leads_not_interested,
    uniqExactIf(e.lead_id, e.outcome = 'Already Purchased')            AS leads_already_purchased,
    uniqExactIf(e.lead_id, e.outcome = 'Wrong Number')                 AS leads_wrong_number,
    uniqExactIf(e.lead_id, e.outcome = 'Customer Already Self Booked') AS leads_self_booked,

    -- Not a loss reason -- General Engagement is a QUALIFIED outcome as of 2026-08-13.
    -- Broken out because it is the single largest qualified bucket and a catch-all
    -- label, so if qualified_leads moves, check here first to see whether the funnel
    -- changed or just the outcome-labelling mix did.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.outcome = 'General Engagement') AS leads_general_engagement,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.outcome = 'Vehicle Inquiry')    AS leads_vehicle_inquiry,

    -- Message-level view of the same loss as delivery_rate above. Both numerator and
    -- denominator are inflated 2x by the capability arrayJoin, so the RATIO is valid
    -- but the raw sums are not exposed and must not be re-derived from it.
    round(100 * sum(e.n_out_failed) / nullIf(sum(e.n_out_total), 0), 2) AS outbound_msg_failure_rate,

    -- ---- data-health guards --------------------------------------------
    -- Non-zero => the outcome vocabulary moved, update the arrays at the top.
    uniqExactIf(e.lead_id, e.unmapped_outcome) AS unmapped_outcome_leads,
    -- Should track replied_leads closely (99-100% historically). A gap means
    -- conversationAnalytics generation is lagging or failing, so qualified and
    -- action-item counts are understated for that week -- not a real funnel drop.
    -- Gated on delivery to stay comparable to replied_leads.
    -- It can sit 1 ABOVE replied_leads on a handful of rooftop-weeks: exactly 8
    -- conversations in Jun-Aug 2026 carry analytics with no inbound message at all.
    -- That is upstream noise, already checked -- not worth chasing again.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.has_analytics) AS leads_with_analytics

FROM enriched AS e

-- LEFT JOIN + is_test_account predicate: a test-account enterprise is not dropped,
-- it surfaces with enterprise_name = '(unmapped)'. Same convention as
-- apps/reporting-vini/vini_capability_split.sql -- volume stays visible.
LEFT JOIN enterprise_dim AS ed
    ON  e.enterprise_id = ed.enterprise_id
    AND ed.is_test_account = 0
LEFT JOIN team_dim AS tm
    ON  e.enterprise_id = tm.enterprise_id
    AND e.team_id       = tm.team_id

GROUP BY
    week_start,
    enterprise_name,
    rooftop_name,
    team_id,
    agent_bucket,
    capability

-- Chronological within a rooftop, so a trend reads as consecutive rows.
-- For an all-rooftop scan, filter to capability = 'All Capabilities' and sort by
-- week_start instead.
ORDER BY
    rooftop_name ASC,
    agent_bucket ASC,
    capability   ASC,
    week_start   ASC
