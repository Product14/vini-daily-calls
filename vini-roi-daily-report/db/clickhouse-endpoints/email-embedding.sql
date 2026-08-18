-- ROI Email "public embedding" — ONE query, params: {{team_id}} + {{dept}} ('sales'|'service').
-- Window is computed in SQL (yesterday + month-to-date, America/New_York). No date params.
-- Publish as a Metabase public card (→ /api/public/card/<uuid>/query/json) OR a ClickHouse
-- Query API Endpoint. Returns ONE row the local cron maps to metrics.
-- ★ CANONICAL (2026-08-18): source='spyne' says we OWN the booking; meta.source says HOW the row
-- came to exist. meta.source='warm_transfer' rows are the customer's EXISTING appointments pulled in
-- around a transfer — records we did NOT create — so every meetings read below excludes them.
WITH
  toStartOfDay(now('America/New_York') - INTERVAL 1 DAY)            AS s,   -- start of yesterday (ET)
  (toStartOfDay(now('America/New_York')) - INTERVAL 1 SECOND)       AS e,   -- end of yesterday (ET)
  toStartOfMonth(now('America/New_York'))                           AS ms   -- 1st of this month (ET)
SELECT
  (SELECT count() FROM dealer_leads.meetings
     WHERE team_id={{team_id}} AND service_type={{dept}} AND source='spyne' AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer' AND is_active=1 AND __deleted=0
       AND created_at BETWEEN s AND e) AS appts,
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND lower(JSONExtractString(ifNull(m.meta,''),'source'))!='warm_transfer' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN s AND e AND m.call_id != ''
       AND m.call_id IN (SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={{team_id}} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType IN ('webCall','inboundPhoneCall'))) AS inbound_appts,
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND lower(JSONExtractString(ifNull(m.meta,''),'source'))!='warm_transfer' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN s AND e AND m.call_id != ''
       AND m.call_id IN (SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={{team_id}} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType='outboundPhoneCall')) AS outbound_appts,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='inboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN s AND e) AS leads,
  (SELECT count() FROM dealer_leads.actionItems
     WHERE team_id={{team_id}} AND service_type={{dept}} AND is_active=1 AND __deleted=0
       AND createdAt BETWEEN s AND e) AS action,
  (SELECT countIf(c.type='call') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND lower(at.agentType)={{dept}} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN s AND e) AS call,
  (SELECT countIf(c.type='sms') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND lower(at.agentType)={{dept}} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN s AND e) AS sms,
  (SELECT countIf(c.type='chat') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND lower(at.agentType)={{dept}} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN s AND e) AS chat,
  (SELECT count() FROM dealer_leads.meetings
     WHERE team_id={{team_id}} AND service_type={{dept}} AND source='spyne' AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer' AND is_active=1 AND __deleted=0
       AND created_at BETWEEN ms AND e) AS appts_mtd,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='inboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN ms AND e) AS leads_mtd,
  -- ── OUTBOUND ACTIVITY ──
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN s AND e) AS ob_reached,
  (SELECT count() FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN s AND e) AS ob_total,
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND lower(JSONExtractString(ifNull(m.meta,''),'source'))!='warm_transfer' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN s AND e AND m.call_id != ''
       AND m.call_id IN (SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={{team_id}} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType='outboundPhoneCall')) AS ob_appts,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN ms AND e) AS ob_reached_mtd,
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND lower(JSONExtractString(ifNull(m.meta,''),'source'))!='warm_transfer' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN ms AND e AND m.call_id != ''
       AND m.call_id IN (SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={{team_id}} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType='outboundPhoneCall')) AS ob_appts_mtd
