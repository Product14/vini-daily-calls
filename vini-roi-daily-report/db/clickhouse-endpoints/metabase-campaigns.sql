-- ROI Daily Digest · ACTIVE CAMPAIGNS card (Metabase). Params: {{team_id}} {{start}} {{end}} {{dept}}.
-- Faithful to campaign-query.js (running campaigns of the dept's type + dials + appts in window).
-- Uses CTEs + LEFT JOINs (NOT correlated subqueries — ClickHouse doesn't support those).
-- ★ CANONICAL (2026-08-18): source='spyne' says we OWN the booking; meta.source says HOW the row
-- came to exist. meta.source='warm_transfer' rows are the customer's EXISTING appointments pulled in
-- around a transfer — records we did NOT create — so every meetings read below excludes them.
WITH
  running AS (
    SELECT campaignId, name, createdAt
    FROM dealer_leads.campaigns
    WHERE teamId = {{team_id}}
      AND campaignStatus = 'running'
      AND campaignType = if({{dept}} = 'service', 'Service', 'Sales')
      AND __deleted = 0
  ),
  -- dials = ACTUAL outbound calls placed per campaign (from endcallreports), NOT queued
  -- outboundTasks. This reconciles the campaign "dials" with the Outbound-activity numbers
  -- (unique reached / connect rate), which are also sourced from endcallreports. Using
  -- outboundTasks previously over-counted (queued-but-not-yet-dialed leads).
  dials AS (
    SELECT campaignId, count() AS dials
    FROM dealer_leads.endcallreports
    WHERE teamId = {{team_id}} AND isActive = 1 AND isTestCall = 0 AND __deleted = 0
      AND callDetails_callType = 'outboundPhoneCall'
      AND lower(callDetails_agentInfo_agentType) = {{dept}}
      AND campaignId != ''
      AND createdAt BETWEEN {{start}} AND {{end}}
    GROUP BY campaignId
  ),
  win_meetings AS (
    SELECT meeting_id, call_id
    FROM dealer_leads.meetings
    WHERE team_id = {{team_id}} AND service_type = {{dept}} AND source = 'spyne' AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer'
      AND is_active = 1 AND __deleted = 0 AND created_at BETWEEN {{start}} AND {{end}}
      AND call_id != ''
  ),
  appts AS (
    SELECT ot.campaignId AS campaignId, count(DISTINCT m.meeting_id) AS appts
    FROM dealer_leads.outboundTasks ot
    INNER JOIN win_meetings m ON m.call_id = ot.callId
    WHERE ot.teamId = {{team_id}} AND ot.callId != '' AND ot.__deleted = 0
    GROUP BY ot.campaignId
  )
SELECT
  if(trim(r.name) = '', 'Unnamed campaign', trim(r.name)) AS name,
  ifNull(d.dials, 0)     AS dials,
  ifNull(a.appts, 0)     AS appts
FROM running r
LEFT JOIN dials d ON d.campaignId = r.campaignId
LEFT JOIN appts a ON a.campaignId = r.campaignId
ORDER BY r.createdAt DESC
