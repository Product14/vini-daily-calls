-- ============================================================
-- Dream Automotive · Emily Agent Health dashboard  (ClickHouse)
-- Source: Metabase question dc97f9c0-4a31-43ef-a7ac-66f339fc2620
-- Grain: one row per (lead × conversation × meeting × action_item)
-- The dashboard server (/api/dream) dedupes to one row per conversation_id.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- PUBLIC QUESTION QUERY  — paste this verbatim into Metabase
-- card dc97f9c0-4a31-43ef-a7ac-66f339fc2620.
-- The React dashboard reads these column names by literal string,
-- so don't rename them. Add columns at will; do not remove any.
-- ────────────────────────────────────────────────────────────
WITH
  base AS (
    SELECT
      l.lead_id                                  AS lead_id,
      l.team_id                                  AS team_id,
      l.enterprise_id                            AS enterprise_id,
      l.service_type                             AS service_type,
      l.source                                   AS lead_source,
      l.stage                                    AS stage,
      l.created_at                               AS lead_created_at,
      c.name                                     AS name,
      c.mobile_number                            AS mobile_number,
      conv.conversationId                        AS conversationId,
      conv.callId                                AS callId,
      conv.type                                  AS type,
      conv.createdAt                             AS conv_createdAt,
      conv.status                                AS conv_status,
      conv.isAI                                  AS isAI,
      conv.isTest                                AS isTest,
      conv.isEmpty                               AS isEmpty,
      conv.summary                               AS summary,
      conv.conversationAnalytics                 AS conversationAnalytics,
      conv.callData_transcript                   AS callData_transcript,
      conv.campaignId                            AS campaignId,
      ecr.callDetails_callType                   AS callDetails_callType,
      ecr.callDetails_endedReason                AS callDetails_endedReason,
      ecr.callDetails_agentInfo_agentName        AS agent_name,
      ecr.callDetails_agentInfo_agentType        AS agent_type,
      ecr.callDetails_analysis_summary           AS callDetails_analysis_summary,
      ecr.callDetails_transcript                 AS callDetails_transcript,
      ecr.callDetails_messages                   AS callDetails_messages,
      ecr.report                                 AS report,
      ecr.report_summary                         AS report_summary,
      ecr.report_appointmentPitched              AS report_appointmentPitched,
      ecr.report_overview_appointmentScheduled   AS report_overview_appointmentScheduled,
      ecr.report_aiScore_totalScore              AS report_aiScore_totalScore,
      ecr.isTestCall                             AS isTestCall,
      m.meeting_id                               AS meeting_id,
      m.created_at                               AS meeting_created_at,
      ai._id                                     AS action_item_id
    FROM dealer_leads.leads l
    LEFT JOIN dealer_leads.customer       c    ON c.customer_id = l.customer_id
    LEFT JOIN dealer_leads.conversations  conv ON conv.leadId   = l.lead_id AND conv.teamId = l.team_id
    LEFT JOIN dealer_leads.endcallreports ecr  ON ecr.leadId    = l.lead_id AND ecr.teamId  = l.team_id
    -- meta.source='warm_transfer' rows are the customer's EXISTING appointments pulled in around a
    -- transfer — records we did not create. Excluded so a lead isn't treated as having a meeting.
    LEFT JOIN dealer_leads.meetings       m    ON m.lead_id     = l.lead_id AND m.team_id   = l.team_id
                                              AND lower(JSONExtractString(ifNull(m.meta,''),'source')) != 'warm_transfer'
    LEFT JOIN dealer_leads.actionItems    ai   ON ai.lead_id    = l.lead_id AND ai.team_id  = l.team_id
    WHERE l.team_id IN ('7607d0e6f5','6730ea9132','3d3deabc98')
      AND l.service_type = 'sales'
      AND l.is_deleted   = 0
  ),
  flagged AS (
    SELECT
      b.*,
      toUInt8(multiSearchAnyCaseInsensitive(
        concat(
          ifNull(callDetails_analysis_summary,''),
          ifNull(summary,''),
          ifNull(callData_transcript,''),
          ifNull(callDetails_transcript,''),
          ifNull(callDetails_messages,''),
          ifNull(conversationAnalytics,''),
          ifNull(report_summary,''),
          ifNull(report,'')
        ),
        ['no longer available','already sold','been sold','that one is sold',
         'vehicle is sold','currently sold','has been sold']
      )) AS agent_said_sold,
      toUInt8(callDetails_endedReason IN
        ('voicemail','customer-did-not-answer','customer-busy',
         'silence-timed-out','twilio-failed-to-connect-call','no-answer'))
        AS no_customer_contact,
      toUInt8(match(
        concat(
          ifNull(callDetails_analysis_summary,''),
          ifNull(summary,''),
          ifNull(conversationAnalytics,''),
          ifNull(report_summary,'')
        ),
        '(?i)(\\$\\s?\\d|priced at|starting at|asking price|sale price|today''s price|sticker)'
      )) AS price_mentioned,
      toUInt8(match(
        concat(
          ifNull(callDetails_analysis_summary,''),
          ifNull(summary,''),
          ifNull(conversationAnalytics,''),
          ifNull(report_summary,'')
        ),
        '(?i)(out[- ]the[- ]door|\\botd\\b|drive[- ]off|all[- ]in price)'
      )) AS otd_mentioned
    FROM base AS b
  ),
  enriched AS (
    SELECT
      f.*,
      toUInt8(agent_said_sold = 1 AND no_customer_contact = 1) AS false_sold_bug,
      toUInt8(otd_mentioned = 1 AND meeting_id IS NOT NULL)    AS otd_after_appt
    FROM flagged AS f
  )
SELECT
  conversationId                              AS conversation_id,   -- ★ required for dedup
  conv_createdAt                              AS at,
  team_id,
  lead_id,
  lead_source,
  lead_created_at,
  name                                        AS customer,
  mobile_number,
  type                                        AS channel,
  callDetails_callType                        AS direction,
  callDetails_endedReason                     AS ended_reason,
  agent_name                                  AS agent,
  campaignId                                  AS campaign_id,
  stage,
  meeting_id,
  meeting_created_at,
  action_item_id,
  report_appointmentPitched                   AS appointment_pitched,
  report_overview_appointmentScheduled        AS appointment_scheduled,
  report_aiScore_totalScore                   AS ai_score,
  isAI,
  isTest,
  isTestCall,
  agent_said_sold,
  no_customer_contact,
  price_mentioned,
  otd_mentioned,
  false_sold_bug,
  otd_after_appt,
  if(false_sold_bug      = 1, 'FALSE-SOLD',     '') AS f1,
  if(otd_after_appt      = 1, 'OTD-AFTER-APPT', '') AS f2,
  if(price_mentioned     = 1, 'PRICE',          '') AS f3,
  if(no_customer_contact = 1, 'NO-CONTACT',     '') AS f4,
  substring(coalesce(callDetails_analysis_summary,
                     summary,
                     conversationAnalytics,
                     report_summary), 1, 280)       AS snippet
FROM enriched
ORDER BY conv_createdAt DESC;
-- ★ Do NOT add LIMIT here. The server caches the full result and dedupes
--    fanout (30k rows → ~7.6k conversations) before sending to the browser.
;


-- ────────────────────────────────────────────────────────────
-- WHAT CHANGED VS THE LAST VERSION YOU PASTED
--   • Added `conversation_id` to the final SELECT (was in `base` but
--     not surfaced — without it the server can't dedupe properly).
--   • Removed `LIMIT 500` — capped data before dedup; UI was missing rows.
--   • Added `lead_source`, `lead_created_at`, `campaign_id`,
--     `appointment_pitched`, `appointment_scheduled`, `ai_score`,
--     `isAI`, `isTest`, `isTestCall` — already filtered/grouped on by
--     the React dashboard.
-- ────────────────────────────────────────────────────────────
