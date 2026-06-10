-- ROI Email · ACTIVE CAMPAIGNS embedding — params: {{team_id}} + {{dept}} ('sales'|'service').
-- Returns ONE ROW PER running campaign of the matching type: name, dials, appts, conversion.
-- Publish as its own Metabase public card (the daily email has a list of campaigns).
-- Based on notification-service/queries/campaign-query.js.
WITH
  toStartOfDay(now('America/New_York') - INTERVAL 1 DAY)      AS s,
  (toStartOfDay(now('America/New_York')) - INTERVAL 1 SECOND) AS e,
  if({{dept}} = 'service', 'Service', 'Sales')                AS ctype
SELECT
  c.name AS name,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.outboundTasks ot
     WHERE ot.teamId={{team_id}} AND ot.campaignId=c.campaignId AND ot.leadId != '' AND ot.__deleted=0
       AND ot.createdAt BETWEEN s AND e) AS dials,
  (SELECT count(DISTINCT m.meeting_id) FROM dealer_leads.outboundTasks ot
     INNER JOIN dealer_leads.meetings m ON m.call_id = ot.callId
       AND m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN s AND e
     WHERE ot.teamId={{team_id}} AND ot.campaignId=c.campaignId AND ot.callId != '' AND ot.__deleted=0) AS appts
FROM dealer_leads.campaigns c
WHERE c.teamId={{team_id}} AND c.campaignStatus='running' AND c.campaignType=ctype AND c.__deleted=0
ORDER BY c.createdAt DESC
