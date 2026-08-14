-- Vini SMS Pitch Sub-Funnel — PARKED UNTIL BACKFILL
--
-- Splits open the qualified -> booked gap that vini_sms_funnel_weekly.sql leaves as a
-- single step, using the LLM-graded appointment funnel:
--
--   reached -> intent is sales -> buyer qualified -> PITCHED -> customer AGREED
--            -> booking tool called -> CRM appointment written
--
-- This is the pitch-suppression view. When booked_leads falls but replied_leads and
-- qualified_leads hold, the cause is one of these steps, and this is where you see
-- which.
--
-- ============================================================================
-- ⚠️  TWO SEPARATE BLOCKERS. THE SECOND ONE IS NOT FIXED BY A BACKFILL.
--
-- BLOCKER 1 — coverage (a backfill DOES fix this)
--
-- dealer_leads.funnelEval only holds SMS data from ~2026-08-01. Measured coverage
-- against texted leads:
--
--     week of 2026-06-01 .. 2026-06-29    ~0.3% - 3.7%
--     week of 2026-07-06 .. 2026-07-20    ~1.4% - 3.1%
--     week of 2026-07-27                  ~32%
--     week of 2026-08-03                  ~93%
--     week of 2026-08-10                  ~56%   (partial week at time of writing)
--
-- Run over any window spanning that ramp and every pitch column rises steeply --
-- which reads as the agent getting better at pitching when it is purely coverage
-- arriving. That is why these columns were pulled OUT of the weekly query rather
-- than shipped with a caveat.
--
-- Once the backfill lands: re-run the COVERAGE CHECK at the bottom of this file
-- first. Only fold these columns into vini_sms_funnel_weekly.sql when coverage is
-- flat and high across the whole window you care about.
--
--
-- BLOCKER 2 — three steps are structurally DEAD for SMS (a backfill does NOT fix it)
--
-- Measured over all 60,994 SMS conversations that have an Appointment funnelEval.
-- Every step is PRESENT in funnelPipeline for all of them; these are pass counts:
--
--     step1_conversationReached      det        0   <-- DEAD
--     step2_intentIdentifiedAsSales  det    3,436
--     step3_buyerQualified           det+llm 1,119
--     step4_appointmentPitched       llm      347
--     step5_customerAgreed           llm      206
--     step6_bookingToolCalled        det        0   <-- DEAD
--     step7_crmAppointmentWritten    det        0   <-- DEAD
--
-- Note step1 passes ZERO times while step2 passes 3,436 -- a later step firing
-- without its own prerequisite. The funnel is internally inconsistent for SMS.
--
-- The pattern is the tell: the three dead steps are exactly the ones whose evidence
-- comes from deterministic checks, and those checks read voice-side artifacts.
-- step6 in particular reads conversation_ai.tool_invocation_events, which has ZERO
-- overlap with SMS conversationIds (verified) -- so it cannot ever pass for SMS.
-- The llm-graded steps (4, 5) work fine.
--
-- CONSEQUENCE: this is an eval-pipeline wiring bug, not a missing-data problem. No
-- amount of backfill will populate step1 / step6 / step7 for SMS. Until engineering
-- wires the deterministic checks to SMS sources, only step2 -> step5 carry signal,
-- which means this query can show you PITCH SUPPRESSION (step4/step5) but NOT
-- whether the booking tool fired or the CRM was written.
--
-- The three dead columns are still SELECTed below, deliberately, so that the day they
-- start returning non-zero you can see it rather than having to remember they exist.
-- ============================================================================
--
-- ---------------------------------------------------------------------------
-- THINGS THAT WILL BITE WHOEVER PICKS THIS UP
-- ---------------------------------------------------------------------------
-- 1. funnelEval.createdAt is eval-RUN time, NOT event time. This query therefore does
--    NOT date-filter funnelEval at all, and dates everything from
--    conversations.createdAt instead. Windowing funnelEval would silently drop
--    conversations whose eval ran after the window closed. It is also why June
--    conversations already carry some pitch data -- they were evaluated later.
--
-- 2. Join keys are channel-exclusive. SMS evals match conversations.conversationId
--    and have callId = ''. Call evals are the exact inverse. Never join SMS on callId.
--
-- 3. funnelEval is written for EVERY conversation, not just replied ones -- in Aug
--    only 19,385 of 80,675 appointment-funnel rows even passed
--    step1_conversationReached. So judge coverage against leads_texted, never against
--    replied_leads, which yields nonsense like 775%.
--
-- 4. funnelPipeline is Array(Tuple(key, order, passed, evidenceSource, evidenceQuote)) --
--    a NAMED tuple, so use x.key / x.passed in the lambda, not x.1 / x.3.
--
-- 5. step3_buyerQualified is the LLM's own judgement and does NOT have to agree with
--    the outcome allowlist in vini_sms_funnel_weekly.sql. Expect leads_pitched to
--    exceed qualified_leads on some rows. Neither number is wrong; they are different
--    definitions.
--
-- 6. All CDC tables need FINAL + __deleted = 0, or rows triplicate.
--
-- Dimensions and bucketing are kept deliberately identical to
-- vini_sms_funnel_weekly.sql so the two can be joined on
-- (week_start, team_id, agent_bucket) without reconciliation work.
-- ============================================================================

WITH
    toDate('2026-08-01')  AS date_from,
    toDate('2026-08-13')  AS date_to_excl,

    ['91abddaec', 'f3e852d59', 'e44c9a35c', '42025c0d0', 'a4007d11f', '471dee49e',
     'cecb53a83', 'ef3a34a11', '5a42bf3dc', 'bed17d6d8', 'e5a5a9289', '59510d7b4',
     '62f962c8e'
    ] AS excluded_enterprises,

team_dim AS (
    SELECT enterprise_id, team_id,
           coalesce(nullIf(dealer_name, ''), team_name) AS rooftop_name
    FROM eventila.enterprise_team_details FINAL
),

enterprise_dim AS (
    SELECT enterprise_id, name AS enterprise_name, is_test_account
    FROM eventila.enterprise_details FINAL
),

lead_dim AS (
    SELECT lead_id, team_id,
           argMax(lower(ifNull(service_type, '')), created_at) AS lead_service_type
    FROM dealer_leads.leads FINAL
    WHERE is_deleted = 0 AND __deleted = 0 AND lead_id IS NOT NULL
    GROUP BY lead_id, team_id
),

-- sequenceTasks is SharedMergeTree: FINAL throws ILLEGAL_FINAL. argMax instead.
task_dim AS (
    SELECT taskId, argMax(ifNull(taskType, ''), _version) AS task_type
    FROM dealer_leads.sequenceTasks
    WHERE __deleted = 0
    GROUP BY taskId
),

spine AS (
    SELECT
        c.conversationId AS conv_id,
        c.leadId         AS lead_id,
        c.teamId         AS team_id,
        c.enterpriseId   AS enterprise_id,
        toStartOfWeek(c.createdAt, 1) AS week_start,
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
            (c.followupId IS NULL OR c.followupId = ''), 'Speed to Lead',
            'Followup Sequence'
        ) AS capability
    FROM dealer_leads.conversations AS c FINAL
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    LEFT JOIN task_dim AS td ON c.followupId = td.taskId
    LEFT JOIN lead_dim AS ld ON c.leadId = ld.lead_id AND c.teamId = ld.team_id
    WHERE c.__deleted = 0
      AND lower(c.type) = 'sms'
      AND ifNull(c.isTest, 0) = 0
      AND c.leadId IS NOT NULL
      AND c.teamId IS NOT NULL
      AND toDate(c.createdAt) >= date_from
      AND toDate(c.createdAt) <  date_to_excl
      AND ifNull(c.enterpriseId, '') NOT IN excluded_enterprises
),

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

-- Not date-filtered: see note 1 in the header.
pitch_agg AS (
    SELECT
        conversationId AS conv_id,
        max(arrayExists(x -> x.key = 'step1_conversationReached'   AND x.passed = 1, funnelPipeline)) AS reached,
        max(arrayExists(x -> x.key = 'step2_intentIdentifiedAsSales' AND x.passed = 1, funnelPipeline)) AS intent_sales,
        max(arrayExists(x -> x.key = 'step3_buyerQualified'        AND x.passed = 1, funnelPipeline)) AS buyer_qualified,
        max(arrayExists(x -> x.key = 'step4_appointmentPitched'    AND x.passed = 1, funnelPipeline)) AS pitched,
        max(arrayExists(x -> x.key = 'step5_customerAgreed'        AND x.passed = 1, funnelPipeline)) AS agreed,
        max(arrayExists(x -> x.key = 'step6_bookingToolCalled'     AND x.passed = 1, funnelPipeline)) AS booking_tool,
        max(arrayExists(x -> x.key = 'step7_crmAppointmentWritten' AND x.passed = 1, funnelPipeline)) AS crm_written
    FROM dealer_leads.funnelEval FINAL
    WHERE __deleted = 0
      AND funnelKey = 'Appointment'
      AND conversationId IS NOT NULL
      AND conversationId != ''
    GROUP BY conversationId
),

enriched AS (
    SELECT
        s.week_start    AS week_start,
        s.enterprise_id AS enterprise_id,
        s.team_id       AS team_id,
        concat(s.agent_service, '_', s.agent_direction) AS agent_bucket,
        arrayJoin([s.capability, 'All Capabilities'])   AS capability,
        s.lead_id        AS lead_id,
        ifNull(m.delivered_out, 0) AS delivered_out,
        ifNull(m.replied, 0)       AS replied,
        (p.conv_id != '')          AS has_eval,
        ifNull(p.reached, 0)         AS reached,
        ifNull(p.intent_sales, 0)    AS intent_sales,
        ifNull(p.buyer_qualified, 0) AS buyer_qualified,
        ifNull(p.pitched, 0)         AS pitched,
        ifNull(p.agreed, 0)          AS agreed,
        ifNull(p.booking_tool, 0)    AS booking_tool,
        ifNull(p.crm_written, 0)     AS crm_written
    FROM spine AS s
    INNER JOIN msg_agg  AS m ON m.conv_id = s.conv_id
    LEFT  JOIN pitch_agg AS p ON p.conv_id = s.conv_id
)

SELECT
    e.week_start                             AS week_start,
    ifNull(ed.enterprise_name, '(unmapped)') AS enterprise_name,
    ifNull(tm.rooftop_name, '(unmapped)')    AS rooftop_name,
    e.team_id                                AS team_id,
    e.agent_bucket                           AS agent_bucket,
    e.capability                             AS capability,

    -- COVERAGE FIRST. Read this before any column below it. While
    -- eval_coverage_pct is low or moving, every step count is understated and a
    -- rising trend is coverage arriving, not the agent improving.
    uniqExactIf(e.lead_id, e.delivered_out = 1)                   AS leads_texted,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.has_eval)    AS leads_evaled,
    round(100 * leads_evaled / nullIf(leads_texted, 0), 2)        AS eval_coverage_pct,

    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.replied = 1) AS replied_leads,

    -- ---- steps that WORK for SMS ---------------------------------------
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.intent_sales)    AS leads_intent_sales,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.buyer_qualified) AS leads_buyer_qualified,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.pitched)         AS leads_pitched,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.agreed)          AS leads_agreed,

    -- The usable conversions. This pair IS the pitch-suppression view.
    round(100 * leads_buyer_qualified / nullIf(leads_intent_sales, 0),    2) AS intent_to_qualified_pct,
    round(100 * leads_pitched         / nullIf(leads_buyer_qualified, 0), 2) AS qualified_to_pitched_pct,
    round(100 * leads_agreed          / nullIf(leads_pitched, 0),         2) AS pitched_to_agreed_pct,

    -- ---- steps that are DEAD for SMS (see BLOCKER 2 in the header) -------
    -- Expected to be 0 in every row. Kept so that the day the deterministic checks
    -- get wired to SMS sources, it shows up here instead of being forgotten.
    -- Do NOT build a rate on top of these while they are zero.
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.reached)       AS leads_reached_DEAD,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.booking_tool) AS leads_booking_tool_called_DEAD,
    uniqExactIf(e.lead_id, e.delivered_out = 1 AND e.crm_written)  AS leads_crm_written_DEAD

FROM enriched AS e
LEFT JOIN enterprise_dim AS ed
    ON e.enterprise_id = ed.enterprise_id AND ed.is_test_account = 0
LEFT JOIN team_dim AS tm
    ON e.enterprise_id = tm.enterprise_id AND e.team_id = tm.team_id

GROUP BY week_start, enterprise_name, rooftop_name, team_id, agent_bucket, capability
HAVING leads_evaled > 0
ORDER BY rooftop_name ASC, agent_bucket ASC, capability ASC, week_start ASC

-- ============================================================================
-- COVERAGE CHECK — run this FIRST after the backfill, before trusting anything above.
-- Fold the pitch columns into vini_sms_funnel_weekly.sql only when coverage_pct is
-- high AND flat across the whole window. A ramp means you are still looking at
-- backfill, not behaviour.
--
--   WITH
--       toDate('2026-06-01') AS date_from,
--       toDate('2026-08-13') AS date_to_excl,
--   conv AS (
--       SELECT conversationId AS cid, toStartOfWeek(createdAt, 1) AS wk
--       FROM dealer_leads.conversations FINAL
--       WHERE __deleted = 0 AND lower(type) = 'sms' AND ifNull(isTest, 0) = 0
--         AND leadId IS NOT NULL
--         AND toDate(createdAt) >= date_from AND toDate(createdAt) < date_to_excl
--   ),
--   ev AS (
--       SELECT DISTINCT conversationId AS cid
--       FROM dealer_leads.funnelEval FINAL
--       WHERE __deleted = 0 AND funnelKey = 'Appointment' AND conversationId != ''
--   )
--   SELECT c.wk AS week_start,
--          count() AS convs,
--          countIf(e.cid != '') AS evaled,
--          round(100 * countIf(e.cid != '') / count(), 1) AS coverage_pct
--   FROM conv AS c LEFT JOIN ev AS e ON e.cid = c.cid
--   GROUP BY week_start ORDER BY week_start
-- ============================================================================
