-- AGENT PERFORMANCE — CONVERSATION FACT (base for dashboard)
-- AUTO-SYNCED from Metabase card 12227 (live) + {START} date-floor; Metabase param
-- blocks stripped. Regenerate by re-downloading the card and re-running the transform.
-- =============================================================================
-- AGENT PERFORMANCE — CONVERSATION SPINE (FINAL)
-- + speed-to-lead columns: is_speed_to_lead, speed_to_lead_response_time
-- =============================================================================
WITH

customer_opt_out AS (
    SELECT
        JSONExtractString(toString(doc), 'customer_id') AS customer_id,
        JSONExtractString(toString(doc), 'team_id') AS team_id,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'call'), 0) AS opt_out_call,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'sms'), 0) AS opt_out_sms
    FROM dealer_leads_raw.customer FINAL
    WHERE _peerdb_is_deleted = 0
),

lead_canonical AS (
    SELECT
        l.lead_id      AS lead_id,
        l.team_id      AS team_id,
        argMax(l.enterprise_id, l.created_at) AS enterprise_id,
        argMax(l.service_type, l.created_at) AS service_type,
        argMax(l.customer_id, l.created_at)  AS customer_id,
        argMax(coalesce(l.external_created_at, l.created_at), l.created_at) AS lead_created_at,
        -- ★ STL: raw external lead timestamp for response-time calc
        argMax(l.external_created_at, l.created_at) AS lead_external_created_at,
        argMax(l.source, l.created_at) AS lead_source
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    LEFT JOIN eventila.enterprise_team_details etd FINAL
        ON l.enterprise_id = etd.enterprise_id AND l.team_id = etd.team_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type IN ('sales', 'service')
      AND ed.is_test_account = 0
      AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
      AND lower(ifNull(ed.name, '')) NOT LIKE '%pevej%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%testing%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%test %'
      AND lower(ifNull(ed.name, '')) NOT LIKE '% test%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%sandbox%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%spyne motors%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%spyne flip%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%khandelwal%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%used inventory%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%team 1%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%test %'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '% test%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%team 1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%demo%'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '%test %'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '% test%'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '%demo%'
    GROUP BY l.lead_id, l.team_id
),

service_intents AS (
    SELECT arrayJoin([
        'Appointment Booking/inquiry','Schedule Service Appointment','Reschedule Service Appointment',
        'Service appointment scheduling attempt failed','Cancel Service Appointment','Service department',
        'Service department transfer completed','Service person/Manager Request','Talk to service department',
        'General Service Inquiry','Check Repair Status','Check pickup/Delivery Status','Check Recall Status',
        'Schedule Recall','Schedule state inspection','Service Pricing/Estimate Inquiry',
        'Service pricing or estimate inquiry','Service special or coupon inquiry',
        'Service request could not be processed','Loaner Vehicle Inquiry',
        'Roadside assistance transfer completed','Talk to roadside assistance',
        'Vehicle service/ownership history inquiry','Vehicle service/ownership history provided',
        'Warranty Coverage Inquiry'
    ]) AS intent
),

sales_intents AS (
    SELECT arrayJoin([
        'Appointment Booking/inquiry','Test Drive Booking','Schedule Test Drive','Vehicle Inquiry',
        'Pricing Inquiry','Trade-in Inquiry','Financing Inquiry','Inventory Availability Inquiry',
        'Sales person/Manager Request','Sales department transfer completed','Lease Inquiry',
        'New Vehicle Inquiry','Used Vehicle Inquiry'
    ]) AS intent
),

appointment_intent_set AS (
    SELECT arrayJoin([
        'Appointment Booking/inquiry',
        'Schedule Service Appointment',
        'Reschedule Service Appointment',
        'Service appointment scheduling attempt failed',
        'Schedule Recall'
    ]) AS intent
),

agent_stage_override AS (
    SELECT team_id, service_type, direction, stage
    FROM (
        SELECT
            CAST(NULL AS Nullable(String)) AS team_id,
            CAST(NULL AS Nullable(String)) AS service_type,
            CAST(NULL AS Nullable(String)) AS direction,
            CAST(NULL AS Nullable(String)) AS stage
        WHERE 0
    )
),

conversation_spine AS (
    SELECT
        c.conversationId                  AS conversationId,
        c.callId                          AS callId,
        lower(c.type)                     AS conv_type,
        c.leadId                          AS lead_id,
        c.teamId                          AS team_id,
        c.enterpriseId                    AS enterprise_id,
        lc.service_type                   AS service_type,
        any(lower(at.agentCallType))      AS direction,
        toDate(c.createdAt)               AS activity_day,
        any(c.createdAt)                  AS activity_ts,
        any(lc.lead_created_at)           AS lead_created_at,
        any(lc.lead_external_created_at)  AS lead_external_created_at,
        any(lc.lead_source)               AS lead_source,
        -- ★ STL: fields needed to classify speed-to-lead SMS
        any(c.metadata)                   AS metadata,
        any(c.outboundTaskId)             AS outbound_task_id,
        any(c.followupId)                 AS followup_id
    FROM dealer_leads.conversations AS c FINAL
    JOIN lead_canonical lc
        ON lc.lead_id = c.leadId AND lc.team_id = c.teamId
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.leadId IS NOT NULL
      AND ifNull(c.isTest, 0) = 0 AND c.__deleted = 0
      AND c.status != 'failed'
      AND lower(c.type) IN ('sms', 'call')
      AND lower(at.agentCallType) IN ('inbound', 'outbound')
      AND toDate(c.createdAt) >= {START}
    GROUP BY
        c.conversationId, c.callId, lower(c.type),
        c.leadId, c.teamId, c.enterpriseId, lc.service_type, toDate(c.createdAt)
),

ecr_events AS (
    SELECT
        ecr.callId AS callId,
        ecr.teamId AS team_id,
        if(
            ifNull(co.opt_out_call, 0) = 0
            AND ifNull(co.opt_out_sms, 0) = 0
            AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
            AND (
                (
                    ira.sourceId IS NOT NULL
                    AND (
                        (lower(ecr.callDetails_agentInfo_agentType) = 'service'
                         AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                             IN (SELECT intent FROM service_intents))
                        OR
                        (lower(ecr.callDetails_agentInfo_agentType) = 'sales'
                         AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                             IN (SELECT intent FROM sales_intents))
                    )
                )
                -- Call-qualified = IRA buying-intent only. Outbound calls have no
                -- IRA records today, so qualified_via_call is structurally 0 for
                -- outbound (upstream pipeline gap — outbound qualification comes
                -- from the SMS-engagement rule + the booking guard, not here).
            ),
            1, 0
        ) AS is_qualifying_call,
        if(
            ira.sourceId IS NOT NULL
            AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                IN (SELECT intent FROM appointment_intent_set),
            1, 0
        ) AS has_appt_intent,
        if(
            ira.sourceId IS NOT NULL
            AND positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'transfer completed') > 0,
            1, 0
        ) AS has_transfer,
        if(
            ira.sourceId IS NOT NULL
            AND (
                positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'callback scheduled') > 0
                OR positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'callback arranged') > 0
            ),
            1, 0
        ) AS has_callback,
        if(
            ira.sourceId IS NOT NULL
            AND arrayExists(
                x -> trimBoth(JSONExtractString(x, 'intent_label'))
                       = trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                     AND JSONExtractBool(x, 'resolved'),
                JSONExtractArrayRaw(ifNull(ira.resolution_block, ''), 'intents')
            ),
            1, 0
        ) AS is_query_resolved,
        if(
            JSONExtractString(ecr.report, 'connected') = 'Yes'
            OR (
                lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
                AND arrayExists(
                    x -> JSONExtractString(x, 'role') = 'user',
                    JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]'))
                )
            ),
            1, 0
        ) AS is_connected,
        trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), '')) AS primary_intent,
        greatest(0, dateDiff('second',
            parseDateTimeBestEffortOrNull(ecr.callDetails_startedAt),
            parseDateTimeBestEffortOrNull(ecr.callDetails_endedAt))) AS talk_seconds
    FROM dealer_leads.endcallreports AS ecr FINAL
    JOIN lead_canonical lc ON lc.lead_id = ecr.leadId AND lc.team_id = ecr.teamId
    LEFT JOIN customer_opt_out co ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    LEFT JOIN dealer_leads.intentResolutionAnalysis AS ira FINAL
        ON ira.sourceId = ecr.callId AND ira.sourceType = 'call' AND ira.isActive = 1
    WHERE ecr.__deleted = 0 AND ecr.isTestCall = false
      AND JSONExtractString(ecr.report, 'spam') = 'No'
      AND lower(ecr.callDetails_agentInfo_agentType) IN ('sales', 'service')
      AND ecr.callDetails_callType IN ('webCall', 'inboundPhoneCall', 'outboundPhoneCall')
      AND toDate(ecr.createdAt) >= {START}
),

ecr_by_call AS (
    SELECT
        callId,
        team_id,
        max(is_qualifying_call) AS qualified_via_call,
        max(has_appt_intent)    AS had_appt_intent,
        max(has_transfer)       AS had_transfer,
        max(has_callback)       AS had_callback,
        max(is_query_resolved)  AS is_query_resolved,
        max(is_connected)       AS is_connected,
        any(primary_intent)     AS primary_intent,
        max(talk_seconds)       AS talk_seconds
    FROM ecr_events
    GROUP BY callId, team_id
),

sms_by_conv AS (
    SELECT
        c.conversationId AS conversationId,
        c.teamId         AS team_id,
        count()          AS n_sms_messages,
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in', 1, 0)) AS n_human_inbound,
        sum(if(lower(sm.direction) = 'out', 1, 0)) AS n_sms_outbound,
        max(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND ifNull(co.opt_out_call, 0) = 0
               AND ifNull(co.opt_out_sms, 0) = 0, 1, 0)) AS qualified_via_sms
    FROM dealer_leads.smsMessages AS sm FINAL
    JOIN dealer_leads.conversations AS c FINAL
        ON sm.conversationId = c.conversationId
       AND c.__deleted = 0 AND ifNull(c.isTest, 0) = 0
       AND c.status != 'failed' AND lower(c.type) = 'sms'
    JOIN lead_canonical lc ON lc.lead_id = c.leadId AND lc.team_id = c.teamId
    LEFT JOIN customer_opt_out co ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    WHERE sm.__deleted = 0
      AND c.conversationId IN (SELECT conversationId FROM conversation_spine)
    GROUP BY c.conversationId, c.teamId
),

lead_optout AS (
    SELECT
        lc.lead_id AS lead_id,
        lc.team_id AS team_id,
        max(ifNull(co.opt_out_sms, 0))  AS opt_out_sms,
        max(ifNull(co.opt_out_call, 0)) AS opt_out_call
    FROM lead_canonical lc
    LEFT JOIN customer_opt_out co
        ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    GROUP BY lc.lead_id, lc.team_id
),

-- Campaign-exit signal per lead, for SMS qualification. A lead is "qualified via
-- SMS" only if it responded, didn't opt out (both already in sms_by_conv), AND
-- has not exited the campaign. We read the lead's MOST RECENT campaign mapping
-- (a stale closed campaign shouldn't disqualify a lead that's active again) and
-- treat it as exited when ANY of three signals says so:
--   • leadEngagementStatus ∈ CLOSED/PAUSED (lifecycle no longer active)
--   • status ∈ DNC / CANCELLED            (removed from cadence)
--   • outcome ∈ opted-out / disqualified  (Opt Out, Not Interested, Already
--     Purchased, Wrong Number) — NEGATIVE exits only; positive exits (booked)
--     are protected by the appointment guard on `qualified` below.
campaign_state AS (
    SELECT
        lead_id,
        team_id,
        if(
            latest_engagement IN ('CLOSED', 'PAUSED')
            OR latest_status IN ('DNC_REQUESTED', 'DNC_REGISTERED', 'CANCELLED')
            OR latest_outcome IN ('Opt Out', 'Not Interested', 'Already Purchased', 'Wrong Number'),
            1, 0
        ) AS campaign_exited
    FROM (
        SELECT
            leadId AS lead_id,
            teamId AS team_id,
            argMax(ifNull(leadEngagementStatus, ''), ifNull(updatedAt, createdAt)) AS latest_engagement,
            argMax(ifNull(status, ''),              ifNull(updatedAt, createdAt)) AS latest_status,
            argMax(ifNull(outcome, ''),             ifNull(updatedAt, createdAt)) AS latest_outcome
        FROM dealer_leads.campaignLeadMappings FINAL
        WHERE __deleted = 0 AND leadId IS NOT NULL AND teamId IS NOT NULL
        GROUP BY leadId, teamId
    )
),

quality_by_call AS (
    SELECT
        cq.sourceId AS callId,
        any(cq.scorePercentage) AS score_percentage
    FROM dealer_leads.conversationQualities AS cq
    WHERE cq.scorePercentage IS NOT NULL
    GROUP BY cq.sourceId
),

conv_hours AS (
    SELECT
        conversationId,
        team_id,
        after_hours
    FROM (
        SELECT
            cs.conversationId AS conversationId,
            cs.team_id        AS team_id,
            ifNull(etd.working_days, '') AS wd,
            parseDateTimeBestEffortOrNull(toString(cs.activity_ts)) AS ts,
            multiIf(
                etd.timezone = 'America/New_York',              toTimeZone(ts, 'America/New_York'),
                etd.timezone = 'Europe/London',                 toTimeZone(ts, 'Europe/London'),
                etd.timezone = 'America/Chicago',               toTimeZone(ts, 'America/Chicago'),
                etd.timezone = 'Europe/Berlin',                 toTimeZone(ts, 'Europe/Berlin'),
                etd.timezone = 'Europe/Rome',                   toTimeZone(ts, 'Europe/Rome'),
                etd.timezone = 'America/Los_Angeles',           toTimeZone(ts, 'America/Los_Angeles'),
                etd.timezone = 'America/Winnipeg',              toTimeZone(ts, 'America/Winnipeg'),
                etd.timezone = 'Australia/Sydney',              toTimeZone(ts, 'Australia/Sydney'),
                etd.timezone = 'Europe/Lisbon',                 toTimeZone(ts, 'Europe/Lisbon'),
                etd.timezone = 'Asia/Dubai',                    toTimeZone(ts, 'Asia/Dubai'),
                etd.timezone = 'America/Toronto',               toTimeZone(ts, 'America/Toronto'),
                etd.timezone = 'Asia/Calcutta',                 toTimeZone(ts, 'Asia/Calcutta'),
                etd.timezone = 'America/Phoenix',               toTimeZone(ts, 'America/Phoenix'),
                etd.timezone = 'Asia/Kolkata',                  toTimeZone(ts, 'Asia/Kolkata'),
                etd.timezone = 'Europe/Paris',                  toTimeZone(ts, 'Europe/Paris'),
                etd.timezone = 'America/Cancun',                toTimeZone(ts, 'America/Cancun'),
                etd.timezone = 'America/Edmonton',              toTimeZone(ts, 'America/Edmonton'),
                etd.timezone = 'America/Detroit',               toTimeZone(ts, 'America/Detroit'),
                etd.timezone = 'America/Kentucky/Monticello',   toTimeZone(ts, 'America/Kentucky/Monticello'),
                etd.timezone = 'Africa/Abidjan',                toTimeZone(ts, 'Africa/Abidjan'),
                etd.timezone = 'Africa/Algiers',                toTimeZone(ts, 'Africa/Algiers'),
                etd.timezone = 'Pacific/Honolulu',              toTimeZone(ts, 'Pacific/Honolulu'),
                etd.timezone = 'America/North_Dakota/Center',   toTimeZone(ts, 'America/North_Dakota/Center'),
                etd.timezone = 'America/Denver',                toTimeZone(ts, 'America/Denver'),
                etd.timezone = 'Atlantic/South_Georgia',        toTimeZone(ts, 'Atlantic/South_Georgia'),
                etd.timezone = 'Pacific/Apia',                  toTimeZone(ts, 'Pacific/Apia'),
                etd.timezone = 'America/Bahia_Banderas',        toTimeZone(ts, 'America/Bahia_Banderas'),
                etd.timezone = 'America/Cayman',                toTimeZone(ts, 'America/Cayman'),
                etd.timezone = 'Asia/Singapore',                toTimeZone(ts, 'Asia/Singapore'),
                etd.timezone = 'Asia/Seoul',                    toTimeZone(ts, 'Asia/Seoul'),
                etd.timezone = 'Pacific/Guam',                  toTimeZone(ts, 'Pacific/Guam'),
                etd.timezone = 'Europe/Helsinki',               toTimeZone(ts, 'Europe/Helsinki'),
                etd.timezone = 'America/Mexico_City',           toTimeZone(ts, 'America/Mexico_City'),
                etd.timezone = 'Europe/Copenhagen',             toTimeZone(ts, 'Europe/Copenhagen'),
                etd.timezone = 'Europe/Sofia',                  toTimeZone(ts, 'Europe/Sofia'),
                etd.timezone = 'Europe/Zagreb',                 toTimeZone(ts, 'Europe/Zagreb'),
                etd.timezone = 'America/Indiana/Vincennes',     toTimeZone(ts, 'America/Indiana/Vincennes'),
                etd.timezone = 'Europe/Prague',                 toTimeZone(ts, 'Europe/Prague'),
                etd.timezone = 'America/Indiana/Tell_City',     toTimeZone(ts, 'America/Indiana/Tell_City'),
                etd.timezone = 'America/Costa_Rica',            toTimeZone(ts, 'America/Costa_Rica'),
                etd.timezone = 'America/Vancouver',             toTimeZone(ts, 'America/Vancouver'),
                etd.timezone = 'Europe/Dublin',                 toTimeZone(ts, 'Europe/Dublin'),
                etd.timezone = 'America/Sao_Paulo',             toTimeZone(ts, 'America/Sao_Paulo'),
                etd.timezone = 'Asia/Qatar',                    toTimeZone(ts, 'Asia/Qatar'),
                etd.timezone = 'Africa/Maseru',                 toTimeZone(ts, 'Africa/Maseru'),
                etd.timezone = 'America/Indiana/Winamac',       toTimeZone(ts, 'America/Indiana/Winamac'),
                etd.timezone = 'America/Kentucky/Louisville',   toTimeZone(ts, 'America/Kentucky/Louisville'),
                etd.timezone = 'Pacific/Auckland',              toTimeZone(ts, 'Pacific/Auckland'),
                toTimeZone(ts, 'UTC')
            ) AS local_dt,
            lower(dateName('weekday', local_dt)) AS dn,
            toHour(local_dt) * 60 + toMinute(local_dt) AS cur_min,
            multiIf(
                dn = 'monday',    JSONExtractRaw(wd, 'monday'),
                dn = 'tuesday',   JSONExtractRaw(wd, 'tuesday'),
                dn = 'wednesday', JSONExtractRaw(wd, 'wednesday'),
                dn = 'thursday',  JSONExtractRaw(wd, 'thursday'),
                dn = 'friday',    JSONExtractRaw(wd, 'friday'),
                dn = 'saturday',  JSONExtractRaw(wd, 'saturday'),
                dn = 'sunday',    JSONExtractRaw(wd, 'sunday'),
                ''
            ) AS day_cfg,
            JSONExtractBool(day_cfg, 'is_working') AS is_working,
            toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'start_time'))[1]) * 60
              + toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'start_time'))[2]) AS start_min,
            toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'end_time'))[1]) * 60
              + toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'end_time'))[2]) AS end_min,
            if(wd = '', NULL,
               if(is_working AND cur_min >= start_min AND cur_min < end_min, 0, 1)) AS after_hours
        FROM conversation_spine cs
        LEFT JOIN eventila.enterprise_team_details etd FINAL
            ON cs.enterprise_id = etd.enterprise_id AND cs.team_id = etd.team_id
    )
),

appt_attribution AS (
    SELECT
        meeting_id,
        team_id,
        argMax(conv_id, pri) AS conversationId
    FROM (
        SELECT m.meeting_id AS meeting_id, m.team_id AS team_id,
               m.conversation_id AS conv_id, 2 AS pri
        FROM dealer_leads.meetings AS m FINAL
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND m.conversation_id IS NOT NULL AND m.conversation_id != ''
        UNION ALL
        SELECT m.meeting_id AS meeting_id, m.team_id AS team_id,
               c.conversationId AS conv_id, 1 AS pri
        FROM dealer_leads.meetings AS m FINAL
        JOIN dealer_leads.conversations AS c FINAL
            ON c.callId = m.call_id AND c.__deleted = 0
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND m.call_id IS NOT NULL AND m.call_id != ''
    )
    WHERE conv_id IS NOT NULL AND conv_id != ''
    GROUP BY meeting_id, team_id
),

appt_by_conv_dedup AS (
    SELECT
        conversationId,
        team_id,
        countDistinct(meeting_id) AS n_appts
    FROM appt_attribution
    GROUP BY conversationId, team_id
)

SELECT
    cs.conversationId AS conversationId,
    cs.callId AS callId,
    cs.conv_type AS conv_type,
    cs.lead_id AS lead_id,
    cs.team_id AS team_id,
    cs.enterprise_id AS enterprise_id,
    ed.name AS enterprise_name,
    coalesce(nullIf(etd.dealer_name, ''), etd.team_name) AS rooftop_name,
    coalesce(aso.stage, etd.stage) AS rooftop_stage,
    cs.service_type AS service_type,
    cs.direction AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cs.direction='inbound','Inbound','Outbound')) AS agent_type,
    cs.activity_day AS activity_day,
    cs.activity_ts AS activity_ts,
    cs.lead_created_at AS lead_created_at,
    cs.lead_source AS lead_source,

    1                                       AS touched,
    if(cs.conv_type='call', 1, 0)           AS is_call,
    if(cs.conv_type='sms',  1, 0)           AS is_sms,

    ifNull(sb.n_sms_messages, 0)            AS n_sms_messages,
    ifNull(sb.n_human_inbound, 0)           AS n_human_inbound,
    ifNull(sb.n_sms_outbound, 0)            AS n_sms_outbound,

    ifNull(ec.qualified_via_call, 0)        AS qualified_via_call,
    -- SMS-qualified = responded + not opted out (from sb) AND not exited campaign.
    if(ifNull(sb.qualified_via_sms, 0) = 1 AND ifNull(cst.campaign_exited, 0) = 0, 1, 0) AS qualified_via_sms,
    -- Overall qualified. The appointment guard (appointment_booked) keeps every
    -- booked lead qualified so appts ⊆ qualified holds and ABR can't exceed 100%
    -- even when a converted lead's campaign has closed / has no IRA call intent.
    greatest(
        ifNull(ec.qualified_via_call, 0),
        if(ifNull(sb.qualified_via_sms, 0) = 1 AND ifNull(cst.campaign_exited, 0) = 0, 1, 0),
        if(ifNull(ad.n_appts, 0) > 0, 1, 0)
    ) AS qualified,

    if(ifNull(ad.n_appts, 0) > 0, 1, 0)     AS appointment_booked,
    ifNull(ad.n_appts, 0)                    AS appointments_count,

    ifNull(ec.is_connected, 0)              AS connected,
    if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0) AS sms_replied,
    greatest(ifNull(ec.is_connected, 0), if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0)) AS reached_person,

    ec.primary_intent                       AS primary_intent,
    ifNull(ec.is_query_resolved, 0)         AS query_resolved,
    ifNull(ec.had_appt_intent, 0)           AS had_appt_intent,
    ifNull(ec.had_transfer, 0)              AS had_transfer,
    ifNull(ec.had_callback, 0)              AS had_callback,
    ifNull(ec.talk_seconds, 0)              AS talk_seconds,
    q.score_percentage                      AS quality_score,

    ifNull(lo.opt_out_sms, 0)               AS opted_out_sms,
    ifNull(lo.opt_out_call, 0)              AS opted_out_call,
    ch.after_hours                          AS after_hours,

    -- ★ STL: speed-to-lead flag (0/1)
    if(
        cs.conv_type = 'sms'
        AND JSONExtractString(ifNull(cs.metadata, '{}'), 'smsFlowJourneySource') = 'speed_to_lead'
        AND nullIf(cs.outbound_task_id, '') IS NULL
        AND nullIf(cs.followup_id, '') IS NULL,
        1, 0
    ) AS is_speed_to_lead,

    -- ★ STL: seconds from lead.external_created_at -> conversation.createdAt
    if(
        cs.conv_type = 'sms'
        AND JSONExtractString(ifNull(cs.metadata, '{}'), 'smsFlowJourneySource') = 'speed_to_lead'
        AND nullIf(cs.outbound_task_id, '') IS NULL
        AND nullIf(cs.followup_id, '') IS NULL
        AND cs.lead_external_created_at IS NOT NULL,
        greatest(0, dateDiff(
            'second',
            parseDateTimeBestEffortOrNull(toString(cs.lead_external_created_at)),
            parseDateTimeBestEffortOrNull(toString(cs.activity_ts))
        )),
        NULL
    ) AS speed_to_lead_response_time

FROM conversation_spine cs
LEFT JOIN eventila.enterprise_details ed FINAL
    ON cs.enterprise_id = ed.enterprise_id
LEFT JOIN eventila.enterprise_team_details etd FINAL
    ON cs.enterprise_id = etd.enterprise_id AND cs.team_id = etd.team_id
LEFT JOIN agent_stage_override aso
    ON aso.team_id = cs.team_id
   AND aso.service_type = cs.service_type
   AND aso.direction = cs.direction
LEFT JOIN ecr_by_call ec
    ON ec.callId = cs.callId AND ec.team_id = cs.team_id
LEFT JOIN sms_by_conv sb
    ON sb.conversationId = cs.conversationId AND sb.team_id = cs.team_id
LEFT JOIN lead_optout lo
    ON lo.lead_id = cs.lead_id AND lo.team_id = cs.team_id
LEFT JOIN campaign_state cst
    ON cst.lead_id = cs.lead_id AND cst.team_id = cs.team_id
LEFT JOIN quality_by_call q
    ON q.callId = cs.callId
LEFT JOIN conv_hours ch
    ON ch.conversationId = cs.conversationId AND ch.team_id = cs.team_id
LEFT JOIN appt_by_conv_dedup ad
    ON ad.conversationId = cs.conversationId AND ad.team_id = cs.team_id
WHERE 1 = 1
ORDER BY cs.activity_ts DESC, cs.team_id, cs.conv_type