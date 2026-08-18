-- Vini Conversation Funnel — CHANNEL-AWARE spine (SMS + Calls)
--
-- Shared base for the /abr-trends dashboard. Emits one row per conversation with an
-- identical column set for both channels, so `channel` is a FILTER, not a branch:
--   channel, conv_id, tool_key, lead_id, team_id, ts, rooftop, svc, dir,
--   reached, engaged, booked, qualified, any_tool, depth_num
--
-- Append your own aggregate below. See vini_funnel_extract.sql for the three
-- extraction queries the dashboard is built from.
--
-- ============================================================================
-- WHY EACH CHANNEL DIFFERS  (all measured — see README)
-- ============================================================================
-- REACHED   SMS = outbound delivered/sent.  Calls = not voicemail/machine AND the
--           transcript has a role='user' turn.
-- ENGAGED   SMS = inbound authorType='human'. Calls = reached AND the transcript
--           carries a role='user' turn. That combination IS the TV Wall's `connected`
--           (agentBaseFact.sql is_connected), so the call Engaged row reconciles with
--           its "Call connection %".
--           Neither call condition implies the other, which is why both are required:
--           187,870 calls have a role='user' turn but only 113,643 are non-voicemail,
--           because voicemail transcripts also contain 'user' turns (the greeting).
--           Combined: 70,341. So Reached (48.6%) and Engaged (30.1%) are genuinely
--           distinct steps across all calls.
-- BOOKED    SMS = meetings.conversation_id AND the conversation invoked a BOOKING TOOL.
--           Calls = meetings.call_id, nothing else.
--           The asymmetry is load-bearing on the SMS side only. An equity-mining
--           campaign stamps conversation_id onto CRM-imported SERVICE appointments it
--           merely REFERENCES ("we'll see you Thursday" + an upgrade pitch), so the join
--           alone credited 810 meetings / 306 leads to conversations that booked nothing.
--           This is mis-attribution, NOT double counting: 810 meetings, 810 distinct
--           meeting_ids, 810 distinct lead+slot pairs, 0 also carrying a call_id. Each
--           appointment exists and is counted exactly once. The upstream defect is that
--           source='spyne' (the AI-booked convention) is set on CRM-imported
--           appointments no AI booked.
--           The booking-tool test is CAUSAL and cleanly separates them: 98.8% of genuine
--           SMS bookings invoked sales_create_meeting / service_create_appointment_v2
--           (1,245 of 1,260) vs 0 of 810 in the reference cohort. It supersedes an
--           earlier >30s timing proxy, which inferred the same split from timestamps and
--           produced an identical lead count (1,232) -- the causal test is just robust to
--           the campaign changing its timing.
--           DO NOT use external_crm_appointment_id to tell them apart. 45.2% of GENUINE
--           bookings also carry one, because Vini syncs its own bookings back to the
--           dealer CRM. It looks like a clean discriminator and is not.
--           Calls need neither test: call_id is only ever written by the booking flow,
--           so there is no reference-stamping artifact, and requiring the tool would drop
--           78 of 3,969 bookings where the AI warm-transferred and a human booked.
-- DEPTH     SMS = customer message count. Calls = talk minutes. Different units, never
--           averaged together — the dashboard shows two rows in the All view.
-- QUALIFIED Both use the SAME outcome allowlists. SMS reads
--           conversationAnalytics.outcome, calls read endcallreports.report.Outcome —
--           same vocabulary, plus call-only values that are all correctly not-qualified.
-- TOOLS     SMS = smsChatCompletions.messages (BOTH toolCalls and tool_calls spellings).
--           Calls = endcallreports.callDetails_messages (toolCalls ONLY — snake_case,
--           role:"tool" and tool_call_id are all absent on the call side).
--           Join key differs: conversationId for SMS, callId for calls. That is what
--           `tool_key` carries.
--
-- CALLBACK RE-ATTRIBUTION is applied to the call branch and ONLY the call branch:
-- inbound calls that are callbacks from an outbound campaign are credited to Outbound,
-- mirroring server/callbackAttribution.js. Omit it and the inbound/outbound split is
-- wrong in BOTH directions. It cannot affect SMS.
--
-- NOT USED, deliberately: vini_reporting.conversation_fact. It materializes all of this
-- already, but this dashboard's definitions diverge from the shared spine on purpose
-- (pre-existing appointments excluded, source IS NULL included, status='failed' kept so
-- delivery loss stays visible, outcome-allowlist qualification instead of the IRA one).
-- Mixing a shared-spine call funnel with a bespoke SMS one makes All Conversations
-- incoherent. Only the guard clauses are lifted from server/agentBaseFact.sql.
--
-- Reconciled against the TV Wall: call booked leads match appts_call EXACTLY on all 12
-- cells tested (Sales Inbound 39/41/44/47/35/23, Sales Outbound 17/13/12/17/17/20 for
-- the weeks of 6 Jul - 10 Aug 2026).
-- ============================================================================

WITH
    toDate('2026-06-01') AS date_from,
    toDate('2026-08-14') AS date_to_excl,
    ['Purchase Intent','Pricing Inquiry','Appointment','Financing Inquiry','Trade Inquiry',
     'Deposit Placed','Ancillary Inquiry','Purchase Closed','Vehicle Inquiry','General Engagement'] AS sales_qualified,
    ['Service Appointment Booked','Walk In Committed','Callback Requested','Transferred To Service Team',
     'No Slots Available','Customer Considering','Customer Open To Return','Drop Off Details Shared',
     'Price Estimate Shared','Recall Information Shared','Service Package Information Shared',
     'General Engagement'] AS service_qualified,
    ['91abddaec','f3e852d59','e44c9a35c','42025c0d0','a4007d11f','471dee49e','cecb53a83','ef3a34a11',
     '5a42bf3dc','bed17d6d8','e5a5a9289','59510d7b4','62f962c8e'] AS excluded_enterprises,

team_dim AS (SELECT enterprise_id, team_id, coalesce(nullIf(dealer_name,''),team_name) AS rooftop_name
             FROM eventila.enterprise_team_details FINAL),
lead_dim AS (SELECT lead_id, team_id, argMax(lower(ifNull(service_type,'')),created_at) AS lst
             FROM dealer_leads.leads FINAL WHERE is_deleted=0 AND __deleted=0 AND lead_id IS NOT NULL
             GROUP BY lead_id, team_id),
-- meta.source='warm_transfer' is the DIRECT signal for one arm of the upstream defect noted above
-- (source='spyne' stamped on appointments no AI booked): those rows are the customer's EXISTING
-- appointments, pulled in around a transfer. Excluded on both branches. COMPLEMENTARY to the
-- booking-tool test, not a replacement — the equity-mining cohort carries no meta.source at all.
appt AS (SELECT conversation_id AS cid, groupArray(created_at) AS mt FROM dealer_leads.meetings FINAL
         WHERE __deleted=0 AND is_active=1 AND (source='spyne' OR source IS NULL)
           AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer'
           AND conversation_id IS NOT NULL AND conversation_id!='' GROUP BY conversation_id),
-- call bookings arrive via meetings.call_id -> conversations.callId
appt_call AS (SELECT call_id AS cid, groupArray(created_at) AS mt FROM dealer_leads.meetings FINAL
         WHERE __deleted=0 AND is_active=1 AND (source='spyne' OR source IS NULL)
           AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer'
           AND call_id IS NOT NULL AND call_id!='' GROUP BY call_id),

-- ---------- SMS branch ----------
msg AS (SELECT conversationId AS cid,
          maxIf(1, lower(direction)='out' AND lower(ifNull(status,'')) IN ('delivered','sent')) AS deliv,
          maxIf(1, lower(direction)='in' AND lower(ifNull(authorType,''))='human') AS replied,
          countIf(lower(direction)='in' AND lower(ifNull(authorType,''))='human') AS n_cust
        FROM dealer_leads.smsMessages FINAL WHERE __deleted=0
          AND toDate(createdAt) >= date_from AND toDate(createdAt) < date_to_excl + 14
        GROUP BY conversationId),
-- Conversations where the agent actually invoked a booking tool. This is the CAUSAL
-- test for "this conversation booked the appointment", and it replaces the old >30s
-- timing heuristic. Measured over Jun-Aug 2026: 98.8% of genuine SMS bookings have a
-- booking tool call (1,245 of 1,260) vs 0 of 810 in the CRM-reference cohort.
-- Note external_crm_appointment_id CANNOT be used to tell them apart -- 45.2% of genuine
-- bookings also carry one, because Vini syncs its own bookings back to the dealer CRM.
sms_booktool AS (SELECT DISTINCT conversationId AS cid FROM dealer_leads.smsChatCompletions FINAL
         WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
           AND (position(assumeNotNull(messages),'sales_create_meeting')>0
             OR position(assumeNotNull(messages),'service_create_appointment_v2')>0
             OR position(assumeNotNull(messages),'service_reschedule_appointment_v2')>0)),
sms_tool AS (SELECT DISTINCT conversationId AS cid FROM dealer_leads.smsChatCompletions FINAL
         WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
           AND (position(assumeNotNull(messages),'toolCalls')>0 OR position(assumeNotNull(messages),'tool_calls')>0)),

sms_conv AS (
  SELECT 'sms' AS channel, c.conversationId AS conv_id, c.conversationId AS tool_key, c.leadId AS lead_id, c.teamId AS team_id,
    c.createdAt AS ts, tm.rooftop_name AS rooftop,
    coalesce(nullIf(lower(ifNull(at.agentType,'')),''), nullIf(ld.lst,''), 'unknown') AS svc,
    coalesce(nullIf(lower(ifNull(at.agentCallType,'')),''),'unknown') AS dir,
    toUInt8(m.deliv) AS reached,
    toUInt8(ifNull(m.replied,0)) AS engaged,
    -- BOOKED, SMS: the meeting must exist AND this conversation must have invoked a
    -- booking tool. The join alone is not enough: an equity-mining campaign stamps
    -- conversation_id onto CRM-imported SERVICE appointments it merely references,
    -- which credited 810 meetings (306 leads) to conversations that booked nothing.
    -- Those have a CRM id and no booking tool call; genuine bookings have the tool call
    -- 98.8% of the time. Replaces the earlier >30s timing proxy, which inferred the same
    -- thing from timestamps rather than testing it. Cost: drops the 1.2% of genuine
    -- bookings with no captured tool call.
    toUInt8(length(a.mt)>0 AND bt.cid != '') AS booked,
    toUInt8(multiIf(coalesce(nullIf(lower(ifNull(at.agentType,'')),''),nullIf(ld.lst,''),'?')='sales',
              has(sales_qualified, JSONExtractString(assumeNotNull(c.conversationAnalytics),'outcome')),
            coalesce(nullIf(lower(ifNull(at.agentType,'')),''),nullIf(ld.lst,''),'?')='service',
              has(service_qualified, JSONExtractString(assumeNotNull(c.conversationAnalytics),'outcome')), 0)) AS qualified,
    toUInt8(t.cid != '') AS any_tool,
    toFloat64(ifNull(m.n_cust,0)) AS depth_num
  FROM dealer_leads.conversations c FINAL
  INNER JOIN msg m ON m.cid = c.conversationId
  LEFT JOIN appt a ON a.cid = c.conversationId
  LEFT JOIN sms_tool t ON t.cid = c.conversationId
  LEFT JOIN sms_booktool bt ON bt.cid = c.conversationId
  LEFT JOIN dealer_leads.teamAgentMappings tam FINAL ON c.teamAgentMappingId=tam.teamAgentMappingId AND tam.__deleted=0
  LEFT JOIN dealer_leads.agentTypes at FINAL ON tam.agentTypeId=at.agentTypeId AND at.__deleted=0
  LEFT JOIN lead_dim ld ON c.leadId=ld.lead_id AND c.teamId=ld.team_id
  LEFT JOIN team_dim tm ON c.enterpriseId=tm.enterprise_id AND c.teamId=tm.team_id
  WHERE c.__deleted=0 AND lower(c.type)='sms' AND ifNull(c.isTest,0)=0
    AND c.leadId IS NOT NULL AND c.teamId IS NOT NULL
    AND toDate(c.createdAt) >= date_from AND toDate(c.createdAt) < date_to_excl
    AND ifNull(c.enterpriseId,'') NOT IN excluded_enterprises
),

-- ---------- Call branch ----------
-- Guards lifted from agentBaseFact.sql, with the two MV fixes applied:
--   is_connected excludes %machine% (repo copy omits it)
--   talk_seconds gated on non-voicemail/machine (repo copy counts ring time)
-- report.connected is NOT read: the key does not exist on any of 451,526 rows.
ecr AS (
  SELECT callId AS cid,
    -- REACHED: the call was answered by something that was not a machine.
    max(if(lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%voicemail%'
       AND lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%machine%', 1, 0)) AS reached,
    -- ENGAGED: answered AND the transcript carries a customer turn. This is exactly the
    -- TV Wall's `connected` (agentBaseFact.sql is_connected), so the row reconciles with
    -- its "Call connection %".
    -- Both conditions are required and neither implies the other: 187,870 calls have a
    -- role='user' turn but only 113,643 are non-voicemail, because voicemail transcripts
    -- also contain 'user' turns (the greeting). Combined: 70,341.
    max(if(lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%voicemail%'
       AND lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%machine%'
       AND arrayExists(x->JSONExtractString(x,'role')='user',
             JSONExtractArrayRaw(ifNull(callDetails_messages,'[]'))), 1, 0)) AS engaged,
    max(if(lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%voicemail%'
       AND lower(ifNull(callDetails_endedReason,'')) NOT LIKE '%machine%',
       greatest(0, dateDiff('second', parseDateTimeBestEffortOrNull(callDetails_startedAt),
                                      parseDateTimeBestEffortOrNull(callDetails_endedAt))), 0)) AS talk_s,
    argMax(JSONExtractString(ifNull(report,'{}'),'Outcome'), createdAt) AS outcome,
    max(if(position(assumeNotNull(callDetails_messages),'toolCalls')>0,1,0)) AS any_tool,
    max(if(isCallbackFromOutbound = 1 OR ifNull(callbackCampaignId,'')!='' 
           OR ifNull(callbackOutboundTaskId,'')!='', 1, 0)) AS is_callback
  FROM dealer_leads.endcallreports FINAL
  WHERE __deleted=0 AND isTestCall=false
    AND JSONExtractString(ifNull(report,'{}'),'spam')='No'
    AND callDetails_callType IN ('webCall','inboundPhoneCall','outboundPhoneCall')
    AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 1
  GROUP BY callId
),
call_conv AS (
  SELECT 'call' AS channel, c.conversationId AS conv_id, c.callId AS tool_key, c.leadId AS lead_id, c.teamId AS team_id,
    c.createdAt AS ts, tm.rooftop_name AS rooftop,
    coalesce(nullIf(lower(ifNull(at.agentType,'')),''), nullIf(ld.lst,''), 'unknown') AS svc,
    -- callback-from-outbound flips inbound to outbound (callbackAttribution.js)
    if(e.is_callback = 1, 'outbound',
       coalesce(nullIf(lower(ifNull(at.agentCallType,'')),''),'unknown')) AS dir,
    toUInt8(e.reached) AS reached,
    toUInt8(e.engaged) AS engaged,
    -- No timing window on calls, unlike SMS. The SMS >30s rule exists to kill a
    -- specific artifact: an equity-mining campaign writes a meeting and an SMS
    -- conversation in the SAME SECOND for customers who already had a service
    -- appointment, and stamps conversation_id on the meeting -- so the join alone
    -- credited the agent with 306 of 1,513 "bookings" it never made.
    -- Calls need NEITHER a window NOR the booking-tool test. call_id is only ever
    -- written by the booking flow, so there is no reference-stamping artifact to filter.
    -- And requiring the tool would drop 78 of 3,969 bookings where the AI warm-
    -- transferred and a human booked -- a real AI contribution. 96.7% have the tool
    -- anyway; the join is already causal here.
    toUInt8(length(ac.mt) > 0) AS booked,
    toUInt8(multiIf(coalesce(nullIf(lower(ifNull(at.agentType,'')),''),nullIf(ld.lst,''),'?')='sales',
              has(sales_qualified, e.outcome),
            coalesce(nullIf(lower(ifNull(at.agentType,'')),''),nullIf(ld.lst,''),'?')='service',
              has(service_qualified, e.outcome), 0)) AS qualified,
    toUInt8(e.any_tool) AS any_tool,
    toFloat64(e.talk_s)/60 AS depth_num
  FROM dealer_leads.conversations c FINAL
  INNER JOIN ecr e ON e.cid = c.callId
  LEFT JOIN appt_call ac ON ac.cid = c.callId
  LEFT JOIN dealer_leads.teamAgentMappings tam FINAL ON c.teamAgentMappingId=tam.teamAgentMappingId AND tam.__deleted=0
  LEFT JOIN dealer_leads.agentTypes at FINAL ON tam.agentTypeId=at.agentTypeId AND at.__deleted=0
  LEFT JOIN lead_dim ld ON c.leadId=ld.lead_id AND c.teamId=ld.team_id
  LEFT JOIN team_dim tm ON c.enterpriseId=tm.enterprise_id AND c.teamId=tm.team_id
  WHERE c.__deleted=0 AND lower(c.type)='call' AND ifNull(c.isTest,0)=0
    AND c.leadId IS NOT NULL AND c.teamId IS NOT NULL AND c.callId IS NOT NULL AND c.callId != ''
    AND toDate(c.createdAt) >= date_from AND toDate(c.createdAt) < date_to_excl
    AND ifNull(c.enterpriseId,'') NOT IN excluded_enterprises
),
conv AS (SELECT * FROM sms_conv UNION ALL SELECT * FROM call_conv)
