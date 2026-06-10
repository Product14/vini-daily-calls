-- ClickHouse Query API Endpoint: ROI daily metrics for one (team, dept).
-- Create in ClickHouse Cloud → SQL console → paste → Share → API Endpoint → make a key.
-- Then set Supabase secret CLICKHOUSE_METRICS_ENDPOINT = the endpoint's run URL.
--
-- queryVariables expected: team_id (String), dept (String, 'sales'|'service'),
--   start, end (DateTime, dealer-local "yesterday" window in UTC),
--   month_start (DateTime, 1st of month 00:00 local in UTC — for MTD).
-- Returns ONE row: appts, inbound_appts, outbound_appts, leads, action, call, sms, chat, appts_mtd, leads_mtd.
SELECT
  -- daily appointments (all Spyne-booked, active)
  (SELECT count() FROM dealer_leads.meetings
     WHERE team_id={team_id:String} AND service_type={dept:String} AND source='spyne' AND is_active=1 AND __deleted=0
       AND created_at BETWEEN {start:DateTime} AND {end:DateTime}) AS appts,
  -- inbound-attributed (call_id ties to a non-spam, non-test inbound/web call)
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={team_id:String} AND m.service_type={dept:String} AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN {start:DateTime} AND {end:DateTime}
       AND m.call_id != '' AND m.call_id IN (
         SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={team_id:String} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType IN ('webCall','inboundPhoneCall'))) AS inbound_appts,
  -- outbound-attributed
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={team_id:String} AND m.service_type={dept:String} AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN {start:DateTime} AND {end:DateTime}
       AND m.call_id != '' AND m.call_id IN (
         SELECT callId FROM dealer_leads.endcallreports
         WHERE teamId={team_id:String} AND isTestCall=0 AND __deleted=0 AND JSONExtractString(report,'spam')='No'
           AND callDetails_callType='outboundPhoneCall')) AS outbound_appts,
  -- inbound unique leads (daily)
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={team_id:String} AND isActive=1 AND isTestCall=0 AND callDetails_callType='inboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={dept:String}
       AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}) AS leads,
  -- action items (daily)
  (SELECT count() FROM dealer_leads.actionItems
     WHERE team_id={team_id:String} AND service_type={dept:String} AND is_active=1 AND __deleted=0
       AND createdAt BETWEEN {start:DateTime} AND {end:DateTime}) AS action,
  -- conversations by channel (daily)
  (SELECT countIf(c.type='call') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={team_id:String} AND lower(at.agentType)={dept:String} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}) AS call,
  (SELECT countIf(c.type='sms') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={team_id:String} AND lower(at.agentType)={dept:String} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}) AS sms,
  (SELECT countIf(c.type='chat') FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={team_id:String} AND lower(at.agentType)={dept:String} AND ifNull(c.isTest,0)=0 AND c.__deleted=0
       AND c.createdAt BETWEEN {start:DateTime} AND {end:DateTime}) AS chat,
  -- month-to-date (month_start → end)
  (SELECT count() FROM dealer_leads.meetings
     WHERE team_id={team_id:String} AND service_type={dept:String} AND source='spyne' AND is_active=1 AND __deleted=0
       AND created_at BETWEEN {month_start:DateTime} AND {end:DateTime}) AS appts_mtd,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={team_id:String} AND isActive=1 AND isTestCall=0 AND callDetails_callType='inboundPhoneCall' AND __deleted=0
       AND lower(callDetails_agentInfo_agentType)={dept:String}
       AND createdAt BETWEEN {month_start:DateTime} AND {end:DateTime}) AS leads_mtd
