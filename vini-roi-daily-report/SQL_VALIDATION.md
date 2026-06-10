# SQL validation queries — copy-paste into Metabase / ClickHouse console
# Replace placeholders: <TEAM_ID>, <ENTERPRISE_ID>, <Y_START>, <Y_END>, <MTD_START>
#
# Date format:  'YYYY-MM-DD HH:MM:SS'   e.g. '2026-06-06 00:00:00'
# Yesterday:    Y_START = '2026-06-06 00:00:00'   Y_END = '2026-06-06 23:59:59'
# MTD start:    MTD_START = '2026-06-01 00:00:00'

-- ════════════════════════════════════════════════════════════════════════════
-- STEP 0 — ELIGIBILITY CHECKS
-- ════════════════════════════════════════════════════════════════════════════

-- [0-A] Which teams have onboarded + active Sales OR Service agents?
--        (Gate 2 — ClickHouse check)
SELECT DISTINCT
    tam.enterpriseId,
    tam.teamId,
    at.agentType
FROM teamAgentMappings tam
INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
WHERE tam.isOnboarded = 1
  AND ifNull(tam.isActive, 1) = 1
  AND ifNull(tam.__deleted, 0) = 0
  AND ifNull(at.__deleted, 0) = 0
  AND at.agentType IN ('Sales', 'Service')
ORDER BY tam.enterpriseId, tam.teamId;

-- [0-B] Check one specific team's agent status
SELECT tam.enterpriseId, tam.teamId, at.agentType,
       tam.isOnboarded, tam.isActive, tam.__deleted
FROM teamAgentMappings tam
INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
WHERE tam.teamId = '<TEAM_ID>'
  AND at.agentType IN ('Sales','Service');


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1-A — SALES METRICS  (replace dates with actual yesterday window)
-- ════════════════════════════════════════════════════════════════════════════

-- [1] Inbound unique leads (distinct leads who called IN to the sales agent)
SELECT count(DISTINCT leadId) AS inbound_unique_leads
FROM endcallreports
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND isActive     = 1
  AND isTestCall   = 0
  AND lower(callDetails_agentInfo_agentType) = 'sales'
  AND callDetails_callType = 'inboundPhoneCall'
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted = 0;

-- [2] All sales appointments (any source: inbound, outbound, or manual)
SELECT count() AS all_sales_appointments
FROM meetings
WHERE enterprise_id = '<ENTERPRISE_ID>'
  AND team_id       = '<TEAM_ID>'
  AND service_type  = 'sales'
  AND source        = 'spyne'
  AND created_at BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted = 0;

-- [3] Inbound sales appointments (appointments that came from an inbound call)
SELECT count() AS inbound_sales_appointments
FROM meetings m
WHERE m.enterprise_id = '<ENTERPRISE_ID>'
  AND m.team_id       = '<TEAM_ID>'
  AND m.service_type  = 'sales'
  AND m.source        = 'spyne'
  AND m.created_at BETWEEN '<Y_START>' AND '<Y_END>'
  AND m.__deleted = 0
  AND m.lead_id != ''
  AND m.call_id != ''
  AND EXISTS (
      SELECT 1 FROM endcallreports e
      WHERE e.callId          = m.call_id
        AND e.enterpriseId    = '<ENTERPRISE_ID>'
        AND e.teamId          = '<TEAM_ID>'
        AND e.isActive        = 1
        AND e.isTestCall      = 0
        AND lower(e.callDetails_agentInfo_agentType) = 'sales'
        AND e.callDetails_callType = 'inboundPhoneCall'
        AND e.createdAt BETWEEN '<Y_START>' AND '<Y_END>'
        AND e.__deleted = 0
  );

-- [4] Outbound call stats (total calls, unique leads reached, connected calls)
SELECT
    count()                AS total_outbound_calls,
    count(DISTINCT leadId) AS unique_leads_reached,
    countIf(callDetails_endedReason IN (
        'customer-ended-call',
        'voicemail',
        'assistant-forwarded-call',
        'assistant-ended-call-after-message-spoken',
        'silence-timed-out',
        'customer-ended-call-before-warm-transfer',
        'assistant-ended-call',
        'customer_hangup',
        'call.in-progress.twilio-completed-call',
        'customer-ended-call-after-warm-transfer-attempt',
        'assistant_ended',
        'exceeded-max-duration',
        'transferred',
        'silence_timeout'
    )) AS connected_calls
FROM endcallreports
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND isActive     = 1
  AND isTestCall   = 0
  AND callDetails_callType = 'outboundPhoneCall'
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted = 0;

-- [5] Outbound sales appointments (appointments from outbound calls)
SELECT count() AS outbound_sales_appointments
FROM meetings m
WHERE m.enterprise_id = '<ENTERPRISE_ID>'
  AND m.team_id       = '<TEAM_ID>'
  AND m.service_type  = 'sales'
  AND m.source        = 'spyne'
  AND m.created_at BETWEEN '<Y_START>' AND '<Y_END>'
  AND m.__deleted = 0
  AND m.lead_id != ''
  AND m.call_id != ''
  AND EXISTS (
      SELECT 1 FROM endcallreports e
      WHERE e.callId       = m.call_id
        AND e.enterpriseId = '<ENTERPRISE_ID>'
        AND e.teamId       = '<TEAM_ID>'
        AND e.isTestCall   = 0
        AND lower(e.callDetails_agentInfo_agentType) = 'sales'
        AND e.callDetails_callType = 'outboundPhoneCall'
        AND e.createdAt BETWEEN '<Y_START>' AND '<Y_END>'
        AND e.__deleted = 0
  );

-- [6] Open action items by intent (what the human team needs to follow up on)
SELECT intent, count() AS cnt
FROM actionItems
WHERE enterprise_id = '<ENTERPRISE_ID>'
  AND team_id       = '<TEAM_ID>'
  AND service_type  = 'sales'
  AND is_active     = 1
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted = 0
GROUP BY intent
ORDER BY cnt DESC;

-- [7] All conversations by channel (call / sms / chat)
SELECT c.type, uniqExact(c.conversationId) AS cnt
FROM conversations c
INNER JOIN teamAgentMappings tam ON tam.teamAgentMappingId = c.teamAgentMappingId
INNER JOIN agentTypes at ON at.agentTypeId = tam.agentTypeId
WHERE c.enterpriseId = '<ENTERPRISE_ID>'
  AND c.teamId       = '<TEAM_ID>'
  AND at.agentType   = 'Sales'
  AND ifNull(c.isTest, 0) = 0
  AND c.createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND c.__deleted = 0
GROUP BY c.type;

-- [8] Transfer stats (how many inbound calls got transferred to a human)
SELECT
    count()   AS total_inbound_calls,
    countIf(callId IN (
        SELECT DISTINCT callId FROM callTransferEvents
        WHERE enterpriseId = '<ENTERPRISE_ID>'
          AND teamId       = '<TEAM_ID>'
          AND __deleted    = 0
    )) AS transferred_calls
FROM endcallreports
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND lower(callDetails_agentInfo_agentType) = 'sales'
  AND callDetails_callType = 'inboundPhoneCall'
  AND isActive     = 1
  AND isTestCall   = 0
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted    = 0;

-- [9] Warm transfers (calls handed off to human mid-conversation)
SELECT count() AS warm_transfers
FROM callTransferEvents
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND department   = 'sales'
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted = 0;

-- [10] After-hours leads (calls that came in outside working hours)
--      Replace 540=9:00AM and 1020=5:00PM with actual dealer hours in minutes
SELECT count() AS after_hours_leads
FROM endcallreports
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND lower(callDetails_agentInfo_agentType) = 'sales'
  AND isTestCall   = 0
  AND createdAt BETWEEN '<Y_START>' AND '<Y_END>'
  AND __deleted    = 0
  AND (
      toHour(toTimeZone(createdAt, 'America/New_York')) * 60
      + toMinute(toTimeZone(createdAt, 'America/New_York')) < 540   -- before 9AM
      OR
      toHour(toTimeZone(createdAt, 'America/New_York')) * 60
      + toMinute(toTimeZone(createdAt, 'America/New_York')) >= 1020  -- at/after 5PM
  );

-- [11] Speed to lead (avg minutes from lead created → first SMS reply)
SELECT round(avg(delta_ms) / 60000, 1) AS avg_minutes_to_first_reply
FROM (
    SELECT
        l.lead_id,
        (toUnixTimestamp(min(c.createdAt)) - toUnixTimestamp(l.created_at)) * 1000 AS delta_ms
    FROM leads l
    INNER JOIN conversations c ON c.leadId = l.lead_id
        AND c.enterpriseId = '<ENTERPRISE_ID>'
        AND c.teamId       = '<TEAM_ID>'
        AND c.type         = 'sms'
        AND ifNull(c.campaignId, '') = ''
        AND ifNull(c.isTest, 0)      = 0
        AND c.createdAt BETWEEN '<Y_START>' AND '<Y_END>'
        AND c.__deleted = 0
    WHERE l.enterprise_id = '<ENTERPRISE_ID>'
      AND l.team_id       = '<TEAM_ID>'
      AND l.lead_id       != ''
      AND l.service_type  = 'sales'
      AND l.created_at BETWEEN '<Y_START>' AND '<Y_END>'
      AND l.__deleted     = 0
    GROUP BY l.lead_id, l.created_at
    HAVING delta_ms >= 0
);


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1-B — CAMPAIGN METRICS
-- ════════════════════════════════════════════════════════════════════════════

-- [C1] Running campaigns for this team
SELECT campaignId, name, campaignStatus, campaignType
FROM campaigns
WHERE enterpriseId   = '<ENTERPRISE_ID>'
  AND teamId         = '<TEAM_ID>'
  AND campaignStatus = 'running'
  AND campaignType   = 'Sales'        -- change to 'Service' for service
  AND __deleted      = 0
ORDER BY createdAt DESC;

-- [C2] Campaign dials (distinct leads dialled per campaign)
-- Replace 'cid1','cid2' with actual campaign IDs from [C1]
SELECT campaignId, count(DISTINCT leadId) AS dials
FROM outboundTasks
WHERE enterpriseId = '<ENTERPRISE_ID>'
  AND teamId       = '<TEAM_ID>'
  AND campaignId   IN ('cid1', 'cid2')
  AND leadId       != ''
  AND __deleted    = 0
GROUP BY campaignId;

-- [C3] Campaign appointments (bookings from campaign outbound calls)
WITH campaign_calls AS (
    SELECT campaignId, callId
    FROM outboundTasks
    WHERE enterpriseId = '<ENTERPRISE_ID>'
      AND teamId       = '<TEAM_ID>'
      AND campaignId   IN ('cid1', 'cid2')
      AND callId       != ''
      AND __deleted    = 0
)
SELECT cc.campaignId, count(DISTINCT m.meeting_id) AS appts
FROM campaign_calls cc
INNER JOIN meetings m ON m.call_id = cc.callId
    AND m.enterprise_id = '<ENTERPRISE_ID>'
    AND m.team_id       = '<TEAM_ID>'
    AND m.service_type  = 'sales'
    AND m.source        = 'spyne'
    AND m.created_at BETWEEN '<Y_START>' AND '<Y_END>'
    AND m.__deleted     = 0
GROUP BY cc.campaignId;


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 2 — SUPABASE: CHECK WHAT WAS STORED
-- ════════════════════════════════════════════════════════════════════════════
-- Run these in Supabase SQL Editor (not ClickHouse/Metabase)

-- [S1] Latest 20 digest runs across all teams
SELECT team_id, enterprise_id, department, local_date,
       status, reason, trigger, send_path,
       bcc_confirmed, sent_at, created_at
FROM roi_digest_runs
ORDER BY created_at DESC
LIMIT 20;

-- [S2] All runs for one specific team
SELECT department, local_date, status, reason, sent_at, bcc_confirmed
FROM roi_digest_runs
WHERE team_id = '<TEAM_ID>'
ORDER BY local_date DESC, department;

-- [S3] Today's send results across all teams
SELECT team_id, department, status, reason, sent_at, bcc_confirmed
FROM roi_digest_runs
WHERE local_date = CURRENT_DATE
ORDER BY team_id;

-- [S4] All blocked (not_sent) runs — see why + what numbers were calculated
SELECT team_id, department, local_date, reason, reason_detail,
       metrics->>'appointmentsYesterday' AS appts,
       metrics->>'conversationsHandled'  AS convos,
       metrics->>'inboundUniqueLeads'    AS leads
FROM roi_digest_runs
WHERE status = 'not_sent'
ORDER BY created_at DESC
LIMIT 50;

-- [S5] Delivery gap — emails sent but BCC not confirmed after 1 hour
SELECT team_id, department, local_date, sent_at
FROM roi_digest_runs
WHERE status        = 'sent'
  AND bcc_confirmed = false
  AND sent_at       < now() - interval '1 hour'
ORDER BY sent_at DESC;

-- [S6] Engagement events for a specific team (opens, clicks, bounces)
SELECT e.event_type, e.recipient_email, e.occurred_at
FROM roi_engagement_events e
INNER JOIN roi_digest_runs r ON r.id = e.run_id
WHERE r.team_id = '<TEAM_ID>'
ORDER BY e.occurred_at DESC
LIMIT 50;

-- [S7] Send rate today (sent vs not_sent)
SELECT
    status,
    department,
    count(*) AS count
FROM roi_digest_runs
WHERE local_date = CURRENT_DATE
GROUP BY status, department
ORDER BY department, status;

-- [S8] Which teams are marked live in Supabase?
SELECT team_id, department, is_live, updated_at
FROM roi_live_departments
ORDER BY team_id, department;

-- [S9] Recipients configured per team and which dept they receive
SELECT team_id, email, receives_sales, receives_service, email_enabled
FROM roi_recipients
WHERE team_id = '<TEAM_ID>';

-- [S10] Per-rooftop send-hour config
SELECT team_id, rooftop_name, digest_send_hour, digest_send_minute,
       timezone, daily_enabled, weekly_enabled, monthly_enabled
FROM roi_rooftop_config
ORDER BY rooftop_name;


-- ════════════════════════════════════════════════════════════════════════════
-- SEED DATA (run once to test end-to-end with a real team)
-- ════════════════════════════════════════════════════════════════════════════

-- Mark a team live for both departments (Gate 3 of eligibility)
INSERT INTO roi_live_departments (team_id, department, is_live)
VALUES
    ('<TEAM_ID>', 'sales',   true),
    ('<TEAM_ID>', 'service', true)
ON CONFLICT (team_id, department) DO UPDATE SET is_live = true;

-- Set a custom send hour (8AM instead of 7AM default)
INSERT INTO roi_rooftop_config (team_id, enterprise_id, rooftop_name, digest_send_hour)
VALUES ('<TEAM_ID>', '<ENTERPRISE_ID>', 'My Dealership', 8)
ON CONFLICT (team_id) DO UPDATE SET digest_send_hour = 8;

-- Add a recipient who gets only service emails
INSERT INTO roi_recipients (team_id, email, name, receives_sales, receives_service, email_enabled)
VALUES ('<TEAM_ID>', 'manager@dealership.com', 'Service Manager', false, true, true)
ON CONFLICT (team_id, email) DO NOTHING;
