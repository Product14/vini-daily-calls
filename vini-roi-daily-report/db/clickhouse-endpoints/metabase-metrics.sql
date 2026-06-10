-- ROI Daily Digest · METRICS card (Metabase public embedding).
-- Params (exactly 4): {{team_id}} (Text), {{start}} (Text 'YYYY-MM-DD HH:MM:SS' UTC),
--   {{end}} (Text UTC), {{dept}} (Text 'sales'|'service').
-- Faithful to notification-service/queries/{sales,service}-inbound-outbound.query.js
--   (enterprise_id dropped — team_id is globally unique; agentType title-cased for the
--    conversations join). Returns ONE row. MTD = call this same card with start = month 1st.
SELECT
  -- inbound unique leads  (countInboundUniqueLeads)
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND callDetails_callType='inboundPhoneCall'
       AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS inbound_unique_leads,
  -- all appointments  (countAll{Sales,Service}Appointments)
  (SELECT count() FROM dealer_leads.meetings
     WHERE team_id={{team_id}} AND service_type={{dept}} AND source='spyne' AND is_active=1 AND __deleted=0
       AND created_at BETWEEN {{start}} AND {{end}}) AS appts_all,
  -- inbound-attributed appointments  (countInbound{Sales,Service}Appointments)
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN {{start}} AND {{end}} AND m.lead_id != '' AND m.call_id != ''
       AND EXISTS (SELECT 1 FROM dealer_leads.endcallreports e
         WHERE e.callId=m.call_id AND e.teamId={{team_id}} AND e.isActive=1 AND e.isTestCall=0
           AND lower(e.callDetails_agentInfo_agentType)={{dept}} AND e.callDetails_callType='inboundPhoneCall'
           AND e.createdAt BETWEEN {{start}} AND {{end}} AND e.__deleted=0)) AS appts_inbound,
  -- outbound call stats  (get{Sales,Service}OutboundCallStats)
  (SELECT count() FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall'
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS ob_total_calls,
  (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall'
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS ob_unique_reached,
  (SELECT countIf(callDetails_endedReason IN ('customer-ended-call','voicemail','assistant-forwarded-call','assistant-ended-call-after-message-spoken','silence-timed-out','customer-ended-call-before-warm-transfer','assistant-ended-call','customer_hangup','call.in-progress.twilio-completed-call','customer-ended-call-after-warm-transfer-attempt','assistant_ended','exceeded-max-duration','transferred','silence_timeout'))
     FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND isActive=1 AND isTestCall=0 AND callDetails_callType='outboundPhoneCall'
       AND lower(callDetails_agentInfo_agentType)={{dept}} AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS ob_connected,
  -- outbound-attributed appointments  (countOutbound{Sales,Service}Appointments)
  (SELECT count() FROM dealer_leads.meetings m
     WHERE m.team_id={{team_id}} AND m.service_type={{dept}} AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
       AND m.created_at BETWEEN {{start}} AND {{end}} AND m.lead_id != '' AND m.call_id != ''
       AND EXISTS (SELECT 1 FROM dealer_leads.endcallreports e
         WHERE e.callId=m.call_id AND e.teamId={{team_id}} AND e.isTestCall=0
           AND lower(e.callDetails_agentInfo_agentType)={{dept}} AND e.callDetails_callType='outboundPhoneCall'
           AND e.createdAt BETWEEN {{start}} AND {{end}} AND e.__deleted=0)) AS ob_appts,
  -- conversations by channel  (getConversationCounts) — TOTAL (inbound + outbound).
  -- "Conversations handled" is the headline volume of every conversation the AI handled,
  -- both directions. (Outbound dial volume is also reported separately in Outbound activity.)
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='call' AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_call,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='sms' AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_sms,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='chat' AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_chat,
  -- INBOUND-only channel split (channel breakdown bar). Inbound = inboundPhoneCall for calls,
  -- and no outboundTaskId/campaignId for sms/chat. (Hero uses the totals above.)
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='call' AND c.callData_callType='inboundPhoneCall'
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_call_in,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='sms' AND ifNull(c.outboundTaskId,'')='' AND ifNull(c.campaignId,'')=''
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_sms_in,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='chat' AND ifNull(c.outboundTaskId,'')='' AND ifNull(c.campaignId,'')=''
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_chat_in,
  -- OUTBOUND-only channel split (outbound channel breakdown bar). Outbound = outboundPhoneCall
  -- for calls, and a non-empty outboundTaskId/campaignId for sms/chat.
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='call' AND c.callData_callType='outboundPhoneCall'
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_call_out,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='sms' AND (ifNull(c.outboundTaskId,'')!='' OR ifNull(c.campaignId,'')!='')
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_sms_out,
  (SELECT uniqExact(c.conversationId) FROM dealer_leads.conversations c
     INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
     INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
     WHERE c.teamId={{team_id}} AND at.agentType=if({{dept}}='service','Service','Sales') AND ifNull(c.isTest,0)=0
       AND c.type='chat' AND (ifNull(c.outboundTaskId,'')!='' OR ifNull(c.campaignId,'')!='')
       AND c.createdAt BETWEEN {{start}} AND {{end}} AND c.__deleted=0) AS conv_chat_out,
  -- warm transfers  (countWarmTransfers)
  (SELECT count() FROM dealer_leads.callTransferEvents
     WHERE teamId={{team_id}} AND department={{dept}} AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS warm_transfers,
  -- transfer stats  (getSalesTransferStats — inbound calls that were transferred)
  (SELECT count() FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND lower(callDetails_agentInfo_agentType)={{dept}} AND callDetails_callType='inboundPhoneCall'
       AND isActive=1 AND isTestCall=0 AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS transfer_total_calls,
  (SELECT countIf(callId IN (SELECT DISTINCT callId FROM dealer_leads.callTransferEvents WHERE teamId={{team_id}} AND __deleted=0))
     FROM dealer_leads.endcallreports
     WHERE teamId={{team_id}} AND lower(callDetails_agentInfo_agentType)={{dept}} AND callDetails_callType='inboundPhoneCall'
       AND isActive=1 AND isTestCall=0 AND createdAt BETWEEN {{start}} AND {{end}} AND __deleted=0) AS transfer_count
