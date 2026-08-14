-- Vini SMS Drill-Down — Action Items / Tool Calls / Outcomes, DoD + WoW + MoM
--
-- The level below vini_sms_funnel_weekly.sql. That table tells you WHICH STEP moved;
-- this one tells you WHICH ITEM inside that step moved, and by how much versus the
-- previous period.
--
-- LONG FORMAT, one row per (grain, period_start, agent_bucket, family, item):
--
--   family = 'action_item'  item = dealerActionItems[].intent   e.g. SALES_LOST_LEAD
--   family = 'tool_call'    item = tool function name           e.g. sales_create_meeting
--   family = 'outcome'      item = conversationAnalytics.outcome e.g. Purchase Intent
--
-- All three families get identical treatment, so "same breakdown for tool calls" is
-- literally the same query with a different family filter.
--
-- ============================================================================
-- HOW TO RUN
--   Edit date_from / date_to_excl below.
--   Set team_filter to a team_id to drill into ONE rooftop; leave '' for all.
--   Then filter the result on the grain you want:
--       grain = 'day'    -> DoD
--       grain = 'week'   -> WoW   (weeks are Monday-start, UTC)
--       grain = 'month'  -> MoM
--   Single statement, no trailing semicolon.
--
--   Typical use: the weekly funnel shows qualified holding but booked falling, so
--       WHERE grain = 'week' AND family = 'tool_call' AND item = 'sales_create_meeting'
--   to see whether the booking tool simply stopped being called.
-- ============================================================================
--
-- ---------------------------------------------------------------------------
-- WHAT EACH COUNT MEANS  (they differ per family -- this matters)
-- ---------------------------------------------------------------------------
--   leads          distinct leads with >= 1 of that item in the period. Comparable to
--                  every count in vini_sms_funnel_weekly.sql, also distinct leads.
--   events         raw occurrences. For 'action_item' and 'tool_call' this is GREATER
--                  than leads -- one conversation can call inventory_search_vehicles_v3
--                  six times or carry three action items. For 'outcome' it is one per
--                  conversation, so events = conversations, not leads.
--   replied_leads  of those leads, how many the customer answered.
--   booked_leads   of those leads, how many produced a genuine appointment. Uses the
--                  SAME rules as the weekly funnel: source spyne-or-null, is_active,
--                  and the >30s pre-existing-appointment exclusion.
--
-- Every count is gated on a delivered outbound message, matching the weekly funnel, so
-- leads here reconcile with leads there.
--
-- Read leads for reach, events for load. A rise in events with flat leads means the
-- agent is retrying, not reaching more people -- which is usually a regression.
--
-- DO NOT SUM ACROSS agent_bucket. Every event is emitted twice: once under its real
-- bucket and once under 'All Agents'. Summing the column gives exactly 2x. Filter to
-- one agent_bucket value, or to 'All Agents' for the total. Same applies across
-- grain -- day, week and month rows all describe the same events.
--
-- DO NOT SUM booked_leads / leads ACROSS item EITHER. One lead can carry several tools
-- and several action items, so it appears under each. Summing booked_leads over items
-- gives ~4x the true booking count. Only the per-item rates are meaningful; for a
-- total, use vini_sms_funnel_weekly.sql. As a reconciliation point, the 'outcome'
-- family DOES sum correctly (one outcome per conversation) and its booked_leads total
-- matches the weekly funnel exactly: 1,195 over Jun-Aug 2026.
--
-- ---------------------------------------------------------------------------
-- DELTAS
-- ---------------------------------------------------------------------------
-- prev_events / prev_leads compare against the PREVIOUS ROW PRESENT for that
-- (grain, agent_bucket, family, item), not the previous calendar period.
--
-- For a sparse item -- a tool called on 3 days out of 30 -- that means the comparison
-- silently spans the gap, and delta_pct describes a jump between non-adjacent days.
-- periods_since_prev is emitted so you can see it: 1 means genuinely adjacent, > 1
-- means the item was absent in between. Ignore delta_pct where periods_since_prev > 1
-- unless you actually want "versus last time this happened".
--
-- ---------------------------------------------------------------------------
-- SOURCE GOTCHAS  (each of these cost real debugging time -- do not re-derive)
-- ---------------------------------------------------------------------------
-- 1. TOOL NAMES live on the ASSISTANT message, never reliably on the role:"tool"
--    message, and under TWO key spellings that must BOTH be read:
--        assistant.toolCalls[].function.name    camelCase  -- the dominant form
--        assistant.tool_calls[].function.name   snake_case -- ~5% of messages
--    Reading only snake_case finds ~5% of tool calls and makes tool names look
--    unavailable. Reading both gives 100% coverage (5,808 of 5,808 tool-bearing
--    conversations in Jul+). The role:"tool" message usually holds only
--    _ts/content/toolCallId -- no name at all.
--
-- 2. dealerActionItems IS POLYMORPHIC. ~75% are objects with an `intent`; ~25% are
--    bare free-text strings with no intent at all. The split is stable month over
--    month (84/86/70/75/76% objects, Apr-Aug 2026), so it is a second concurrent
--    shape, NOT legacy that will age out. String-form items are bucketed as
--    '(unstructured)' rather than dropped -- dropping them would understate action
--    item volume by a quarter.
--
-- 3. The action-item intent vocabulary mixes TWO naming conventions:
--    SCREAMING_SNAKE ('SALES_SCHEDULE_CALLBACK') and CamelCase ('ScheduleAppointment',
--    'RequestCallback', 'CheckVehicleAvailability'). These are two generations of the
--    same taxonomy and are NOT deduplicated here -- 'SALES_SCHEDULE_APPOINTMENT' and
--    'ScheduleAppointment' appear as separate items. Sum them yourself if comparing
--    across the boundary, and do not read either one's trend in isolation.
--
-- 4. SALES_LOST_LEAD is not agent activity, it is the agent giving up, and it is the
--    single largest action item by a wide margin (5,995 of 7,901 structured items in
--    July). It first appears in the week of 2026-06-29 -- before that it does not
--    exist at all, so its "growth" from zero is a behaviour change shipping, not a
--    trend. Exclude it before reading action item volume as productivity.
--
-- 5. conversationAnalytics only exists once a customer has replied, so the
--    'action_item' and 'outcome' families are implicitly scoped to REPLIED
--    conversations, and their leads should be compared against replied_leads in the
--    weekly funnel, never against leads_texted. 'tool_call' is NOT so scoped -- it
--    comes from smsChatCompletions and a tool can fire before the customer answers,
--    which is why replied_leads is emitted per row rather than assumed equal to leads.
--
-- 6. sequenceTasks does not support FINAL (SharedMergeTree, throws ILLEGAL_FINAL).
--    Everything else here needs FINAL + __deleted = 0 or CDC rows triplicate.
-- ============================================================================

WITH
    toDate('2026-06-01') AS date_from,
    toDate('2026-08-13') AS date_to_excl,
    ''                   AS team_filter,   -- '' = all rooftops, else a single team_id

    -- Kept identical to vini_sms_funnel_weekly.sql so the two reconcile.
    ['Purchase Intent', 'Pricing Inquiry', 'Appointment', 'Financing Inquiry',
     'Trade Inquiry', 'Deposit Placed', 'Ancillary Inquiry', 'Purchase Closed',
     'Vehicle Inquiry', 'General Engagement'
    ] AS sales_qualified,
    ['Service Appointment Booked', 'Walk In Committed', 'Callback Requested',
     'Transferred To Service Team', 'No Slots Available', 'Customer Considering',
     'Customer Open To Return', 'Drop Off Details Shared', 'Price Estimate Shared',
     'Recall Information Shared', 'Service Package Information Shared',
     'General Engagement'
    ] AS service_qualified,

    ['91abddaec', 'f3e852d59', 'e44c9a35c', '42025c0d0', 'a4007d11f', '471dee49e',
     'cecb53a83', 'ef3a34a11', '5a42bf3dc', 'bed17d6d8', 'e5a5a9289', '59510d7b4',
     '62f962c8e'
    ] AS excluded_enterprises,

lead_dim AS (
    SELECT lead_id, team_id,
           argMax(lower(ifNull(service_type, '')), created_at) AS lead_service_type
    FROM dealer_leads.leads FINAL
    WHERE is_deleted = 0 AND __deleted = 0 AND lead_id IS NOT NULL
    GROUP BY lead_id, team_id
),

-- Reply / delivery per conversation. Same definitions as vini_sms_funnel_weekly.sql.
msg_agg AS (
    SELECT
        conversationId AS conv_id,
        maxIf(1, lower(direction) = 'out' AND lower(ifNull(status, '')) IN ('delivered', 'sent')) AS delivered_out,
        maxIf(1, lower(direction) = 'in'  AND lower(ifNull(authorType, '')) = 'human')            AS replied
    FROM dealer_leads.smsMessages FINAL
    WHERE __deleted = 0
      AND toDate(createdAt) >= date_from
      AND toDate(createdAt) <  date_to_excl + 14
    GROUP BY conversationId
),

-- Bookings, carrying meeting timestamps so the pre-existing-appointment rule can be
-- applied per conversation. See the BOOKED note in vini_sms_funnel_weekly.sql: an
-- equity-mining campaign writes a meeting row in the same second as the conversation
-- for customers who ALREADY had a service appointment, with source = 'spyne'. Those
-- are not bookings. 30s cleanly separates them (genuine minimum observed gap: 46s).
appt_agg AS (
    SELECT conversation_id AS conv_id, groupArray(created_at) AS mtg_times
    FROM dealer_leads.meetings FINAL
    WHERE __deleted = 0
      AND is_active = 1
      AND (source = 'spyne' OR source IS NULL)
      AND conversation_id IS NOT NULL
      AND conversation_id != ''
    GROUP BY conversation_id
),

-- One row per SMS conversation, with the dimensions every family shares.
spine AS (
    SELECT
        c.conversationId AS conv_id,
        c.leadId         AS lead_id,
        c.teamId         AS team_id,
        c.createdAt      AS ts,
        concat(
            coalesce(nullIf(lower(ifNull(at.agentType, '')), ''),
                     nullIf(ld.lead_service_type, ''), 'unknown'),
            '_',
            coalesce(nullIf(lower(ifNull(at.agentCallType, '')), ''), 'unknown')
        ) AS agent_bucket,
        coalesce(nullIf(lower(ifNull(at.agentType, '')), ''),
                 nullIf(ld.lead_service_type, ''), 'unknown') AS agent_service,
        assumeNotNull(c.conversationAnalytics) AS ca,
        (c.conversationAnalytics IS NOT NULL
         AND c.conversationAnalytics NOT IN ('', '{}')) AS has_analytics,
        ifNull(m.replied, 0) AS replied,
        arrayExists(x -> dateDiff('second', c.createdAt, x) > 30, a.mtg_times) AS booked
    FROM dealer_leads.conversations AS c FINAL
    INNER JOIN msg_agg AS m
        ON m.conv_id = c.conversationId AND m.delivered_out = 1
    LEFT JOIN appt_agg AS a
        ON a.conv_id = c.conversationId
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    LEFT JOIN lead_dim AS ld
        ON c.leadId = ld.lead_id AND c.teamId = ld.team_id
    WHERE c.__deleted = 0
      AND lower(c.type) = 'sms'
      AND ifNull(c.isTest, 0) = 0
      AND c.leadId IS NOT NULL
      AND c.teamId IS NOT NULL
      AND toDate(c.createdAt) >= date_from
      AND toDate(c.createdAt) <  date_to_excl
      AND ifNull(c.enterpriseId, '') NOT IN excluded_enterprises
      AND (team_filter = '' OR c.teamId = team_filter)
),

-- ---------------------------------------------------------------------------
-- FAMILY 1: action items. One row per item occurrence. String-form items become
-- '(unstructured)' -- see gotcha 2.
-- ---------------------------------------------------------------------------
ev_action_items AS (
    SELECT
        s.ts, s.lead_id, s.conv_id, s.agent_bucket, s.replied, s.booked,
        'action_item' AS family,
        if(JSONExtractString(item, 'intent') != '',
           JSONExtractString(item, 'intent'),
           '(unstructured)') AS item,
        JSONExtractString(item, 'priority') AS priority
    FROM spine AS s
    ARRAY JOIN JSONExtractArrayRaw(s.ca, 'dealerActionItems') AS item
    WHERE s.has_analytics
),

-- ---------------------------------------------------------------------------
-- FAMILY 2: tool calls. One row per call. BOTH key spellings -- see gotcha 1.
-- Not gated on has_analytics: tool calls live in a different table and exist
-- independently of whether analytics was written.
-- ---------------------------------------------------------------------------
tool_raw AS (
    SELECT
        conversationId AS conv_id,
        arrayConcat(
            arrayFlatten(arrayMap(a -> JSONExtractArrayRaw(a, 'toolCalls'),
                                  JSONExtractArrayRaw(assumeNotNull(messages)))),
            arrayFlatten(arrayMap(a -> JSONExtractArrayRaw(a, 'tool_calls'),
                                  JSONExtractArrayRaw(assumeNotNull(messages))))
        ) AS calls
    FROM dealer_leads.smsChatCompletions FINAL
    WHERE __deleted = 0
      AND toDate(createdAt) >= date_from - 1
      AND toDate(createdAt) <  date_to_excl + 7
      -- BOTH spellings must be tested explicitly. A single substring cannot cover
      -- them: 'oolCall' matches toolCalls but NOT tool_calls (which contains
      -- 'ool_ca'), which silently dropped every snake_case-only conversation.
      AND (position(assumeNotNull(messages), 'toolCalls') > 0
           OR position(assumeNotNull(messages), 'tool_calls') > 0)
),

ev_tool_calls AS (
    SELECT
        s.ts, s.lead_id, s.conv_id, s.agent_bucket, s.replied, s.booked,
        'tool_call' AS family,
        JSONExtractString(JSONExtractRaw(call, 'function'), 'name') AS item,
        '' AS priority
    FROM spine AS s
    INNER JOIN tool_raw AS t ON t.conv_id = s.conv_id
    ARRAY JOIN t.calls AS call
    WHERE JSONExtractString(JSONExtractRaw(call, 'function'), 'name') != ''
),

-- ---------------------------------------------------------------------------
-- FAMILY 3: outcomes. One row per conversation. counts_as_qualified shows which
-- outcomes are actually driving the qualified step in the weekly funnel.
-- ---------------------------------------------------------------------------
ev_outcomes AS (
    SELECT
        s.ts, s.lead_id, s.conv_id, s.agent_bucket, s.replied, s.booked,
        'outcome' AS family,
        JSONExtractString(s.ca, 'outcome') AS item,
        if(multiIf(s.agent_service = 'sales',   has(sales_qualified,   JSONExtractString(s.ca, 'outcome')),
                   s.agent_service = 'service', has(service_qualified, JSONExtractString(s.ca, 'outcome')),
                   0), 'qualified', 'not_qualified') AS priority
    FROM spine AS s
    WHERE s.has_analytics
      AND JSONExtractString(s.ca, 'outcome') != ''
),

all_events AS (
    SELECT * FROM ev_action_items
    UNION ALL SELECT * FROM ev_tool_calls
    UNION ALL SELECT * FROM ev_outcomes
),

-- Expand each event into all three grains at once, plus an 'All Agents' rollup.
-- The rollup is arrayJoin'd rather than summed downstream so its distinct-lead count
-- is correct -- a lead active under two agent buckets must not be counted twice.
expanded AS (
    SELECT
        g.1 AS grain,
        g.2 AS period_start,
        arrayJoin([agent_bucket, 'All Agents']) AS agent_bucket,
        family, item, priority, lead_id, conv_id, replied, booked
    FROM all_events
    ARRAY JOIN [('day',   toDate(ts)),
                ('week',  toStartOfWeek(ts, 1)),
                ('month', toStartOfMonth(ts))] AS g
),

agg AS (
    SELECT
        grain,
        period_start,
        agent_bucket,
        family,
        item,
        count()                AS events,
        uniqExact(lead_id)     AS leads,
        uniqExact(conv_id)     AS conversations,
        uniqExactIf(lead_id, replied = 1) AS replied_leads,
        uniqExactIf(lead_id, booked)      AS booked_leads,
        -- Only meaningful per family: priority for action items, qualified flag for
        -- outcomes, empty for tool calls.
        anyIf(priority, priority != '') AS item_class
    FROM expanded
    GROUP BY grain, period_start, agent_bucket, family, item
)

SELECT
    grain,
    period_start,
    agent_bucket,
    family,
    item,
    item_class,
    events,
    leads,
    conversations,
    replied_leads,
    booked_leads,

    -- Per-item booking conversion. This is what makes the drill-down actionable rather
    -- than descriptive: it ranks items by whether they actually convert, not by volume.
    --   item_to_booked_pct     of leads carrying this item, how many booked
    --   replied_to_booked_pct  same denominator convention as the weekly funnel, so the
    --                          two can be compared directly
    -- In practice replied_leads ~= leads for ALL THREE families. Expected for
    -- action_item and outcome (analytics only exists after a reply), and measured for
    -- tool_call too: 13,810 replied of 13,811 lead-item pairs over Jun-Aug 2026. Tools
    -- fire in response to a customer message, so they effectively never precede one.
    -- Both rates are kept anyway, so the day that stops being true it is visible.
    round(100 * booked_leads / nullIf(leads, 0), 2)          AS item_to_booked_pct,
    round(100 * booked_leads / nullIf(replied_leads, 0), 2)  AS replied_to_booked_pct,

    -- Previous PRESENT period for this item -- see the DELTAS note in the header.
    any(events) OVER w AS prev_events,
    any(leads)  OVER w AS prev_leads,
    events - (any(events) OVER w) AS delta_events,
    leads  - (any(leads)  OVER w) AS delta_leads,
    round(100 * (events - (any(events) OVER w)) / nullIf(any(events) OVER w, 0), 1) AS delta_events_pct,
    round(100 * (leads  - (any(leads)  OVER w)) / nullIf(any(leads)  OVER w, 0), 1) AS delta_leads_pct,

    -- 1 = genuinely the adjacent period. > 1 = the item was absent in between, so
    -- the delta spans a gap and delta_pct is not a period-over-period change.
    multiIf(
        (any(period_start) OVER w) IS NULL, NULL,
        grain = 'day',   dateDiff('day',   any(period_start) OVER w, period_start),
        grain = 'week',  dateDiff('week',  any(period_start) OVER w, period_start),
                         dateDiff('month', any(period_start) OVER w, period_start)
    ) AS periods_since_prev,

    -- Share of the family within the same period/bucket, so an item's movement can be
    -- read as mix-shift versus real volume change.
    round(100 * events / nullIf(sum(events) OVER (PARTITION BY grain, period_start, agent_bucket, family), 0), 2) AS pct_of_family_events

FROM agg
WINDOW w AS (
    PARTITION BY grain, agent_bucket, family, item
    ORDER BY period_start
    ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING
)
ORDER BY grain, family, item, agent_bucket, period_start
