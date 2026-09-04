-- =============================================================================
-- VINI  ·  SALES OUTBOUND  ·  COMPLETE FUNNEL, UNIQUE LEADS, WEEKLY
-- =============================================================================
-- Produces one row per Monday-start week with every column behind the dashboard
-- at https://dashboard-six-omega-41.vercel.app and the workbook
-- Vini_Sales_Outbound_Funnel_2026-08-12.xlsx
--
-- Run against ClickHouse.  Change the two dates in the WINDOW block below.
--
-- BUILT ON the canonical conversation spine (reporting-vini/src/lib/reports/
-- agentBaseFact.sql @ origin/main d788743) with the callback-to-outbound
-- re-attribution from callbackAttribution.ts applied.
--
-- ─── NON-OBVIOUS RULES BAKED IN (do not "simplify" these) ────────────────────
--  1. FINAL + __deleted = 0 on every CDC table. Without FINAL, endcallreports
--     triplicates and inflates 1.5-2x.
--  2. "connected/spoke" is NOT report.connected='Yes'. The outbound dialer sets
--     that flag on voicemail-reached calls (inflates OB connected ~2x). Real
--     conversation = non-voicemail/machine endedReason AND the transcript
--     contains a role='user' message (the customer actually spoke).
--  3. Direction comes from teamAgentMappings -> agentTypes.agentCallType, NOT
--     from callDetails_callType. An inbound call that is a callback to an
--     outbound touch is credited to OUTBOUND.
--  4. Sales/Service split comes from the LEAD's service_type, never
--     report_useCase (useCase mis-buckets ~2,559 sales leads as service).
--  5. Appointments are AI-booked only (meetings.source='spyne'), counted
--     LEAD-distinct (reschedules create multiple meeting rows), and EXCLUDE
--     meta.source='warm_transfer' -- see rule 8.
--  6. Every count is window-distinct at the (lead x week) grain. Never sum
--     per-day distincts across days: a lead touched on 5 days would count 5x.
--  7. The buying-intent action-item list here is CORRECTED (see caveat E).
--  8. meta.source='warm_transfer' is EXCLUDED from appointments (locked
--     2026-08-18, canonical). `meetings.source` says who OWNS a booking;
--     `meta.source` says HOW the row came to exist -- 'warm_transfer' rows are
--     the customer's EXISTING appointments pulled in around a transfer, records
--     nobody just booked (their start times are often the customer's own PAST
--     visits). source='spyne' alone is NOT proof the AI booked it. Honda of
--     Downtown Los Angeles 2026-08-14: a manager was shown 7 "appointments" for
--     ONE customer, all 7 warm_transfer, start times Jul-2024 -> Jan-2026.
--     Fleet effect where measured: AI-booked -4.9% over 45d, all of it after
--     2026-08-11 (source='spyne' + warm_transfer only starts the week of
--     2026-08-10 -- a recent upstream regression). 'callback' meta.source rows
--     are deliberately left alone.
--
-- ─── KNOWN CAVEATS (state these with the numbers) ────────────────────────────
--  A. FAILED SMS ARE INVISIBLE. 29,437 of 29,588 failed outbound SMS sit in
--     conversations with status='failed', which the spine excludes (~9,658
--     leads over 6 weeks). So "leads reached" understates attempts and SMS
--     deliverability is not measured here.
--  B. THE CAMPAIGN OUTCOME HAS NO USABLE DATE. campaignLeadMappings holds ONE
--     current outcome per lead, overwritten in place, and updatedAt churns
--     under CDC. We apply each lead's CURRENT outcome to every week it engaged.
--     The engaged gate stops idle weeks counting, but the outcome can still
--     leak backwards into weeks before the intent was expressed. Fixing this
--     properly needs event history (outboundTaskAuditLogs, 14.7M rows).
--  C. STEPS 5, 6, 7 OVERLAP EACH OTHER (a lead can have an appointment AND be
--     hot). They are three lenses on the qualified pool, not a partition, and
--     they sum above step 4.
--  D. reached_call + reached_sms > reached, because many leads get both
--     channels in the same week.
--  E. The buying-intent action-item list here is CORRECTED. The shipped list in
--     agentBaseFact.sql omits SALES_SCHEDULE_APPOINTMENT (while including its
--     service twin), SALES_SEND_VEHICLE_INFO, SALES_FOLLOW_UP_BE_BACK,
--     SEND_VEHICLE_PHOTO and the SendVehicle* variants. That omission grew from
--     18 to 115 leads/week from late June as the AI's intent naming drifted.
--     VERIFIED against prod 2026-08-18: all 10 added labels are real.
--     SALES_SCHEDULE_APPOINTMENT first appears 2026-07-02 (493 leads to date)
--     and SEND_VEHICLE_PHOTO 2026-07-31 (75) -- those two are the drift. The
--     SendVehicle* camelCase variants are legacy/tiny (1-15 leads each, June
--     only). Fleet-wide the corrected list adds 33-39 leads/wk in early June,
--     rising to 163-299/wk from July.
--  F. QUALIFIED HERE IS THE CAMPAIGN-OUTCOME RULE (campaignLeadMappings.outcome
--     + engaged that week). As of 2026-08-18 reporting-vini's console implements
--     the SAME rule for Sales Outbound (agentBaseFact.sql ob_campaign_outcome),
--     so the two now agree -- see caveat G for the one remaining difference.
--     Sales Inbound and both Service agents still use the intent-based rule
--     (IRA primary_intent on calls / buying-intent action item on SMS), so the
--     old "same rule both channels" invariant no longer holds. Say which agent
--     you are quoting. See caveat B for why this rule's dating is weaker than it
--     looks.
--  G. RIGHT-EDGE SMS WINDOW -- the ONE reason this query and the console can
--     still differ. The `sm` CTE below bounds messages to [d_from, d_to), so a
--     thread created in-window whose reply lands AFTER d_to does not count as
--     engaged here. The spine bounds the CONVERSATION but aggregates each
--     conversation's messages across its whole life, so it does count. Verified
--     2026-08-18 over 2026-06-01..08-11: with the sm bound widened, the two
--     agree EXACTLY on all 11 weeks (incl. w/c 08-03 385 -> 390 and the partial
--     w/c 08-10 104 -> 120). Only the last week or two of any window are
--     affected; older weeks match either way. Do NOT "fix" the spine to match
--     this -- its message scope is shared with n_sms_messages / n_human_inbound
--     / reached_person / sms_replied, and narrowing it would move all of them.
--     Practical consequence: the current week's qualified here reads slightly
--     LOW and rises as late replies land.
--
-- ─── SELF-CHECKS: run these after, they must all hold ────────────────────────
--   spoke + picked_no_speech + voicemail + no_answer + call_failure
--       + no_disposition  =  reached_call        (exact partition)
--   hot + warm  =  hotwarm                       (mutually exclusive tiers)
--   appt <= qualified,  other <= qualified,  hotwarm <= qualified
--   qualified <= engaged <= reached
-- =============================================================================

WITH
-- ── WINDOW ───────────────────────────────────────────────────────────────────
'2026-06-01'::Date AS d_from,
'2026-08-11'::Date AS d_to,          -- exclusive upper bound

-- ── clean lead universe: sales only, test/demo/reseller accounts removed ─────
lc AS (
    SELECT l.lead_id AS lead_id, l.team_id AS team_id
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    LEFT JOIN eventila.enterprise_team_details etd FINAL
           ON l.enterprise_id = etd.enterprise_id AND l.team_id = etd.team_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type = 'sales'
      AND ed.is_test_account = 0
      -- Reseller screen + allowlist. Hardcoded because this file is a standalone extract run
      -- straight through `ch`/`ch-pack`, so it cannot use the load-time injection the server
      -- uses. Source of truth: server/resellerAllowlist.js (RESELLER_ALLOWLIST) — keep in step.
      AND (ed.reseller_id IS NULL OR ed.reseller_id = ''
           OR ed.enterprise_id IN ('62f962c8e'))  -- CallSource Auto
      AND lower(ifNull(ed.name,''))         NOT LIKE '%pevej%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%testing%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%test %'
      AND lower(ifNull(ed.name,''))         NOT LIKE '% test%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%demo%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%sandbox%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%spyne motors%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%spyne flip%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%khandelwal%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%used inventory%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%team 1%'
      AND lower(ifNull(ed.name,''))         NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name,''))   NOT LIKE '%test %'
      AND lower(ifNull(etd.team_name,''))   NOT LIKE '% test%'
      AND lower(ifNull(etd.team_name,''))   NOT LIKE '%team 1%'
      AND lower(ifNull(etd.team_name,''))   NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name,''))   NOT LIKE '%demo%'
      AND lower(ifNull(etd.dealer_name,'')) NOT LIKE '%test %'
      AND lower(ifNull(etd.dealer_name,'')) NOT LIKE '% test%'
      AND lower(ifNull(etd.dealer_name,'')) NOT LIKE '%demo%'
    GROUP BY l.lead_id, l.team_id
),

-- ── callback-from-outbound: flips these inbound calls to Outbound (rule 3) ───
cbo AS (
    SELECT ecr.callId AS callId, ecr.teamId AS team_id, toUInt8(1) AS is_cb
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0 AND ecr.callId != ''
      AND toDate(ecr.createdAt) >= d_from AND toDate(ecr.createdAt) < d_to
      AND ( ecr.isCallbackFromOutbound = 1
            OR ifNull(ecr.callbackCampaignId, '')     != ''
            OR ifNull(ecr.callbackOutboundTaskId, '') != '' )
    GROUP BY callId, team_id
),

-- ── conversation spine ──────────────────────────────────────────────────────
cs AS (
    SELECT c.conversationId AS cvid, c.callId AS callId, lower(c.type) AS ct,
           c.leadId AS lead_id, c.teamId AS team_id,
           any(lower(at.agentCallType)) AS dir0,
           toDate(c.createdAt) AS d
    FROM dealer_leads.conversations AS c FINAL
    JOIN lc ON lc.lead_id = c.leadId AND lc.team_id = c.teamId
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
           ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
           ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.leadId IS NOT NULL AND ifNull(c.isTest,0) = 0 AND c.__deleted = 0
      AND c.status != 'failed'                 -- CAVEAT A: this drops failed-SMS leads
      AND lower(c.type) IN ('sms','call')
      AND lower(at.agentCallType) IN ('inbound','outbound')
      AND toDate(c.createdAt) >= d_from AND toDate(c.createdAt) < d_to
    GROUP BY cvid, callId, ct, lead_id, team_id, d
),

-- ── call dispositions, one row per call ─────────────────────────────────────
ecr AS (
    SELECT ecr.callId AS callId, ecr.teamId AS team_id,
        -- SPOKE = the customer actually said something (see rule 2 above)
        max(if(lower(ifNull(ecr.callDetails_endedReason,'')) NOT LIKE '%voicemail%'
           AND lower(ifNull(ecr.callDetails_endedReason,'')) NOT LIKE '%machine%'
           AND arrayExists(x -> JSONExtractString(x,'role') = 'user',
                           JSONExtractArrayRaw(ifNull(ecr.callDetails_messages,'[]'))), 1, 0)) AS spoke,
        max(if(lower(ifNull(ecr.callDetails_endedReason,''))
               IN ('voicemail','voicemail_full','machine_ivr'), 1, 0))                        AS vmail,
        -- line answered but no customer speech
        max(if(lower(ifNull(ecr.callDetails_endedReason,''))
               IN ('customer_hangup','customer_declined','silence_timeout','assistant_ended'), 1, 0)) AS picked,
        max(if(lower(ifNull(ecr.callDetails_endedReason,'')) IN ('no_answer','busy'), 1, 0))   AS noans,
        max(if(lower(ifNull(ecr.callDetails_endedReason,''))
               IN ('number_not_found','connection_failed','pipeline_error','config_error',
                   'invalid_number','provider_error','unknown'), 1, 0))                       AS cfail
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0 AND ecr.isTestCall = false
      AND JSONExtractString(ecr.report,'spam') = 'No'
      AND lower(ecr.callDetails_agentInfo_agentType) IN ('sales','service')
      AND ecr.callDetails_callType IN ('webCall','inboundPhoneCall','outboundPhoneCall')
      AND toDate(ecr.createdAt) >= d_from AND toDate(ecr.createdAt) < d_to
    GROUP BY callId, team_id
),

-- ── SMS per conversation: real reply vs STOP, and outbound message volume ────
sm AS (
    SELECT conversationId AS cvid,
        max(if(lower(authorType) = 'human' AND lower(direction) = 'in'
           AND upper(trimBoth(ifNull(body,''))) NOT IN
               ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT',
                'OPTOUT','OPT OUT','REMOVE','NO'), 1, 0))                       AS reply_real,
        max(if(lower(authorType) = 'human' AND lower(direction) = 'in'
           AND upper(trimBoth(ifNull(body,''))) IN
               ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT',
                'OPTOUT','OPT OUT','REMOVE','NO'), 1, 0))                       AS reply_stop,
        sum(if(lower(direction) = 'out', 1, 0))                                 AS n_sms_out
    FROM dealer_leads.smsMessages FINAL
    WHERE __deleted = 0 AND createdAt >= d_from AND createdAt < d_to
    GROUP BY cvid
),

-- ── opt-outs: dated, conversation-scoped. 100% of these are SMS-channel ──────
oolog AS (
    SELECT conversationId AS cvid
    FROM dealer_leads.customerOptOutLogs FINAL
    WHERE __deleted = 0 AND ifNull(conversationId,'') != ''
      AND createdAt >= d_from AND createdAt < d_to
    GROUP BY cvid
),

-- ── AI-booked appointments, attributed to the conversation ──────────────────
-- rule 8: meta.source='warm_transfer' rows are appointments we did NOT create.
ap AS (
    SELECT cvid, team_id, uniqExact(lead_id) AS n FROM (
        SELECT m.conversation_id AS cvid, m.team_id AS team_id, m.lead_id AS lead_id
        FROM dealer_leads.meetings AS m FINAL
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND lower(JSONExtractString(ifNull(m.meta,''),'source')) != 'warm_transfer'
          AND ifNull(m.conversation_id,'') != ''
        UNION ALL
        SELECT c.conversationId, m.team_id, m.lead_id
        FROM dealer_leads.meetings AS m FINAL
        JOIN dealer_leads.conversations AS c FINAL ON c.callId = m.call_id AND c.__deleted = 0
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND lower(JSONExtractString(ifNull(m.meta,''),'source')) != 'warm_transfer'
          AND ifNull(m.call_id,'') != ''
    ) GROUP BY cvid, team_id
),

-- ── buying-intent action items (CORRECTED vocabulary, see caveat E) ──────────
ai AS (
    SELECT lead_id, team_id, toMonday(toDate(createdAt)) AS wk, toUInt8(1) AS buy_ai
    FROM dealer_leads.actionItems FINAL
    WHERE __deleted = 0
      AND createdAt >= d_from AND createdAt < d_to
      AND ifNull(intent,'') IN (
          -- the 15 currently shipped
          'ScheduleAppointment','RescheduleAppointment','SALES_SCHEDULE_SHOWROOM_VISIT',
          'CheckVehicleAvailability','CheckVehiclePrice','InquireFinanceStatus',
          'SALES_CONNECT_TO_FINANCE','InquireTradeInValue','SALES_TRADE_IN_FOLLOW_UP',
          'ScheduleTestDrive','SALES_SCHEDULE_TEST_DRIVE','InquireLeaseOptions',
          'SALES_FOLLOW_UP_WITH_QUOTE','SERVICE_SCHEDULE_APPOINTMENT','SERVICE_SEND_ESTIMATE',
          -- the omissions this analysis added back
          'SALES_SEND_VEHICLE_INFO','SALES_SCHEDULE_APPOINTMENT','SALES_FOLLOW_UP_BE_BACK',
          'SEND_VEHICLE_PHOTO','SendVehicleImages','SendVehicleDetails','SendVehicleCatalog',
          'SendVehicleInformation','SendVehicleLink','CheckVehicleCondition')
    GROUP BY lead_id, team_id, wk
),

-- ── campaign outcome: ONE current value per lead, most recent (caveat B) ─────
oc AS (
    SELECT clm.leadId AS lead_id,
           argMax(lower(trimBoth(ifNull(clm.outcome,''))), clm.updatedAt) AS outcome
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    WHERE clm.__deleted = 0
    GROUP BY clm.leadId
),

-- ── conversation grain, restricted to Outbound (+ callbacks) ─────────────────
conv AS (
    SELECT cs.lead_id AS lid, cs.team_id AS tid, cs.d AS d, cs.ct AS ct,
           ifNull(e.spoke,0)  AS spoke,  ifNull(e.vmail,0) AS vmail,
           ifNull(e.picked,0) AS picked, ifNull(e.noans,0) AS noans,
           ifNull(e.cfail,0)  AS cfail,
           if(e.callId != '', 1, 0)             AS has_disp,
           ifNull(s.reply_real,0) AS reply_real, ifNull(s.reply_stop,0) AS reply_stop,
           ifNull(s.n_sms_out,0)  AS n_sms_out,
           if(oolog.cvid != '', 1, 0)           AS opted_out,
           if(ifNull(ap.n,0) > 0, 1, 0)         AS appt,
           ifNull(oc.outcome,'')                AS outcome
    FROM cs
    LEFT JOIN cbo    ON cbo.callId = cs.callId AND cbo.team_id = cs.team_id
    LEFT JOIN ecr e  ON e.callId   = cs.callId AND e.team_id   = cs.team_id
    LEFT JOIN sm  s  ON s.cvid     = cs.cvid
    LEFT JOIN oolog  ON oolog.cvid = cs.cvid
    LEFT JOIN ap     ON ap.cvid    = cs.cvid AND ap.team_id    = cs.team_id
    LEFT JOIN oc     ON oc.lead_id = cs.lead_id
    WHERE cs.dir0 = 'outbound' OR ifNull(cbo.is_cb,0) = 1
),

-- ── collapse to the (lead x week) grain: this is what makes counts distinct ──
lw AS (
    SELECT c.lid AS lid, c.tid AS tid, toMonday(c.d) AS wk,
           max(if(c.ct = 'call',1,0)) AS r_call,
           max(if(c.ct = 'sms', 1,0)) AS r_sms,
           countIf(c.ct = 'call')     AS calls_attempted,   -- activity, not unique leads
           sum(c.n_sms_out)           AS sms_sent,          -- activity, not unique leads
           max(c.spoke) AS spoke, max(c.picked) AS picked, max(c.vmail) AS vmail,
           max(c.noans) AS noans, max(c.cfail) AS cfail, max(c.has_disp) AS has_disp,
           max(c.reply_real) AS reply_real, max(c.reply_stop) AS reply_stop,
           max(c.opted_out)  AS opted_out, max(c.appt) AS appt,
           any(c.outcome)    AS outcome,
           max(ifNull(a.buy_ai,0)) AS buy_ai
    FROM conv AS c
    LEFT JOIN ai AS a ON a.lead_id = c.lid AND a.team_id = c.tid AND a.wk = toMonday(c.d)
    GROUP BY lid, tid, wk
),

-- ── derive the flags ────────────────────────────────────────────────────────
f AS (
    SELECT *,
        greatest(spoke, reply_real) AS eng,
        -- QUALIFIED: qualifying campaign outcome AND engaged that week (caveat F)
        if(outcome IN ('purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
                       'trade inquiry','ancillary inquiry',
                       'customer considering','customer open to return','reconnect needed',
                       'appointment','service appointment booked','meeting already scheduled',
                       'customer already self booked','walk in committed','appointment rescheduled',
                       'deposit placed','callback requested','human requested','human transferred',
                       'transferred to service team'), 1, 0) AS oc_q,
        if(outcome IN ('purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
                       'trade inquiry','ancillary inquiry'), 1, 0)                       AS hot,
        if(outcome IN ('customer considering','customer open to return',
                       'reconnect needed'), 1, 0)                                        AS warm
    FROM lw
)

SELECT
    wk                                                                     AS period,

    -- 1. REACH  (calls_attempted / sms_sent are ACTIVITY counts, not unique leads)
    sum(f.calls_attempted)                                                  AS calls_attempted,
    sum(f.sms_sent)                                                         AS sms_sent,
    uniqExact(lid)                                                        AS reached,
    uniqExactIf(lid, r_call = 1)                                          AS reached_call,
    uniqExactIf(lid, r_sms  = 1)                                          AS reached_sms,

    -- 2a. CALL disposition — mutually exclusive by precedence, sums to reached_call
    uniqExactIf(lid, r_call=1 AND f.spoke=1)                                                        AS spoke,
    uniqExactIf(lid, r_call=1 AND f.spoke=0 AND picked=1)                                           AS picked_no_speech,
    uniqExactIf(lid, r_call=1 AND f.spoke=0 AND picked=0 AND vmail=1)                               AS voicemail,
    uniqExactIf(lid, r_call=1 AND f.spoke=0 AND picked=0 AND vmail=0 AND noans=1)                   AS no_answer,
    uniqExactIf(lid, r_call=1 AND f.spoke=0 AND picked=0 AND vmail=0 AND noans=0 AND cfail=1)       AS call_failure,
    uniqExactIf(lid, r_call=1 AND f.spoke=0 AND picked=0 AND vmail=0 AND noans=0 AND cfail=0)       AS no_disposition,

    -- 2b. SMS
    uniqExactIf(lid, r_sms=1 AND reply_real=1)                            AS sms_replied,
    uniqExactIf(lid, r_sms=1 AND reply_stop=1)                            AS sms_stop,
    uniqExactIf(lid, r_sms=1 AND opted_out=1)                             AS sms_optout,

    -- 3. ENGAGED  (via call + via SMS overlap: a lead can do both)
    uniqExactIf(lid, eng=1)                                               AS engaged,
    uniqExactIf(lid, f.spoke=1)                                             AS engaged_call,
    uniqExactIf(lid, reply_real=1)                                        AS engaged_sms,

    -- 4. QUALIFIED
    uniqExactIf(lid, eng=1 AND oc_q=1)                                    AS qualified,
    uniqExactIf(lid, f.spoke=1 AND oc_q=1)                                  AS qual_call,
    uniqExactIf(lid, reply_real=1 AND oc_q=1)                             AS qual_sms,

    -- 5. APPOINTMENT BOOKED  (nested inside qualified)
    uniqExactIf(lid, eng=1 AND oc_q=1 AND f.appt=1)                         AS appt,
    uniqExactIf(lid, eng=1 AND oc_q=1 AND f.appt=1 AND f.spoke=1)             AS appt_call,
    uniqExactIf(lid, eng=1 AND oc_q=1 AND f.appt=1 AND reply_real=1)        AS appt_sms,

    -- 6. OTHER OUTCOMES  (buying-intent action item, nested inside qualified)
    uniqExactIf(lid, eng=1 AND oc_q=1 AND buy_ai=1)                       AS other,
    uniqExactIf(lid, eng=1 AND oc_q=1 AND buy_ai=1 AND f.spoke=1)           AS other_call,
    uniqExactIf(lid, eng=1 AND oc_q=1 AND buy_ai=1 AND reply_real=1)      AS other_sms,

    -- 7. HOT / WARM IN DISCUSSION  (hot and warm are mutually exclusive)
    uniqExactIf(lid, eng=1 AND (f.hot=1 OR f.warm=1))                         AS hotwarm,
    uniqExactIf(lid, eng=1 AND (f.hot=1 OR f.warm=1) AND f.spoke=1)             AS hotwarm_call,
    uniqExactIf(lid, eng=1 AND (f.hot=1 OR f.warm=1) AND reply_real=1)        AS hotwarm_sms,
    uniqExactIf(lid, eng=1 AND f.hot=1)                                     AS hot,
    uniqExactIf(lid, eng=1 AND f.warm=1)                                    AS warm,

    -- RECONCILIATION: defects, not results. Excluded from 5-7 above.
    -- buying task logged but the campaign disposition says non-qualifying:
    uniqExactIf(lid, eng=1 AND buy_ai=1 AND oc_q=0)                       AS conflict_buyai,
    -- AI-booked meeting exists but the outcome was never written back:
    uniqExactIf(lid, eng=1 AND f.appt=1  AND oc_q=0)                        AS conflict_appt

FROM f
GROUP BY wk
ORDER BY wk;

-- =============================================================================
-- VARIANTS you may be asked for
-- =============================================================================
-- DAILY:    replace every toMonday(...) with toDate(...)      (3 places: ai, lw, SELECT)
-- MONTHLY:  replace every toMonday(...) with toStartOfMonth(...)
--           NOTE: the buying-intent action item is matched to the SAME bucket as
--           the touch, so widening the bucket widens that gate too. Expect
--           `other` to rise on a monthly grain. That is by construction.
--
-- EXCLUDE OPTED-OUT LEADS from qualified: add "AND opted_out = 0" to the
--   qualified / appt / other / hotwarm predicates. Moves the week of 3 Aug by
--   ~11 leads (402 -> 391-ish), ABR by ~0.15pp.
--
-- SALES INBOUND uses a DIFFERENT qualified rule by design and this query will
--   not produce it: inbound calls qualify on intentResolutionAnalysis buying
--   intent, inbound SMS on reply-and-not-opted-out. Do not point this at
--   inbound and expect valid numbers.
-- =============================================================================
