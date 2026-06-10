# QUERIES.md — live metric queries (validate the numbers before payloads)

All tables are in the **`dealer_leads`** ClickHouse database. Substitute:
- `<TID>`  = team_id (e.g. `49a06313cf` = Covina Kia)
- `<S>` / `<E>` = dealer-local "yesterday" window as UTC, format `YYYY-MM-DD HH:MM:SS`
  (the backend computes this from `roi_rooftop_config.timezone`; for manual checks
  use the dealer's local 00:00:00→23:59:59 converted to UTC)
- `dept` = `'sales'` or `'service'`

> Run these for a few rooftops, confirm the numbers look right, then tell me
> "numbers look good" and I'll generate + store the 5-day payloads (dry-run, no sends).

---

## 1 · Inbound unique leads
```sql
SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports
WHERE enterpriseId=(SELECT any(enterpriseId) FROM dealer_leads.teamAgentMappings WHERE teamId='<TID>')
  AND teamId='<TID>' AND isActive=1 AND isTestCall=0
  AND lower(callDetails_agentInfo_agentType)='sales'   -- or 'service'
  AND callDetails_callType='inboundPhoneCall'
  AND createdAt BETWEEN '<S>' AND '<E>' AND __deleted=0;
```

## 2 · All appointments
```sql
SELECT count() FROM dealer_leads.meetings
WHERE team_id='<TID>' AND service_type='sales'   -- or 'service'
  AND source='spyne' AND created_at BETWEEN '<S>' AND '<E>' AND __deleted=0;
```

## 3 · Inbound appointments  (meetings linked to an inbound call)
```sql
SELECT count() FROM dealer_leads.meetings m
WHERE m.team_id='<TID>' AND m.service_type='sales' AND m.source='spyne'
  AND m.created_at BETWEEN '<S>' AND '<E>' AND m.__deleted=0
  AND m.lead_id!='' AND m.call_id!=''
  AND EXISTS (SELECT 1 FROM dealer_leads.endcallreports e
    WHERE e.callId=m.call_id AND e.teamId='<TID>' AND e.isActive=1 AND e.isTestCall=0
      AND lower(e.callDetails_agentInfo_agentType)='sales'
      AND e.callDetails_callType='inboundPhoneCall'
      AND e.createdAt BETWEEN '<S>' AND '<E>' AND e.__deleted=0);
```

## 4 · Outbound call stats (total / reached / connected)
```sql
SELECT count() total, count(DISTINCT leadId) reached,
  countIf(callDetails_endedReason IN ('customer-ended-call','voicemail','assistant-forwarded-call',
   'assistant-ended-call-after-message-spoken','silence-timed-out','customer-ended-call-before-warm-transfer',
   'assistant-ended-call','customer_hangup','call.in-progress.twilio-completed-call',
   'customer-ended-call-after-warm-transfer-attempt','assistant_ended','exceeded-max-duration',
   'transferred','silence_timeout')) connected
FROM dealer_leads.endcallreports
WHERE teamId='<TID>' AND isActive=1 AND isTestCall=0
  AND callDetails_callType='outboundPhoneCall'
  AND createdAt BETWEEN '<S>' AND '<E>' AND __deleted=0;
```

## 5 · Outbound appointments  (meetings linked to an outbound call)
Same as #3 but `e.callDetails_callType='outboundPhoneCall'`.

## 6 · Action items by intent
```sql
SELECT intent, count() cnt FROM dealer_leads.actionItems
WHERE team_id='<TID>' AND service_type='sales' AND is_active=1
  AND createdAt BETWEEN '<S>' AND '<E>' AND __deleted=0
GROUP BY intent ORDER BY cnt DESC;
```

## 7 · Conversations by channel
```sql
SELECT c.type, uniqExact(c.conversationId) cnt
FROM dealer_leads.conversations c
INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
WHERE c.teamId='<TID>' AND at.agentType='Sales'   -- or 'Service'
  AND ifNull(c.isTest,0)=0 AND c.createdAt BETWEEN '<S>' AND '<E>' AND c.__deleted=0
GROUP BY c.type;
```

## 8 · Transfer stats (inbound calls + how many transferred)
```sql
SELECT count() total_inbound,
  countIf(callId IN (SELECT DISTINCT callId FROM dealer_leads.callTransferEvents
                     WHERE teamId='<TID>' AND __deleted=0)) transferred
FROM dealer_leads.endcallreports
WHERE teamId='<TID>' AND lower(callDetails_agentInfo_agentType)='sales'
  AND callDetails_callType='inboundPhoneCall' AND isActive=1 AND isTestCall=0
  AND createdAt BETWEEN '<S>' AND '<E>' AND __deleted=0;
```

## 9 · Warm transfers
```sql
SELECT count() FROM dealer_leads.callTransferEvents
WHERE teamId='<TID>' AND department='sales'   -- or 'service'
  AND createdAt BETWEEN '<S>' AND '<E>' AND __deleted=0;
```

## 10 · Speed to lead (avg minutes lead→first SMS)
```sql
SELECT round(avg(delta_ms)/60000,1) avg_minutes FROM (
  SELECT (toUnixTimestamp(min(c.createdAt))-toUnixTimestamp(l.created_at))*1000 delta_ms
  FROM dealer_leads.leads l
  INNER JOIN dealer_leads.conversations c ON c.leadId=l.lead_id AND c.teamId='<TID>'
    AND c.type='sms' AND ifNull(c.campaignId,'')='' AND ifNull(c.isTest,0)=0
    AND c.createdAt BETWEEN '<S>' AND '<E>' AND c.__deleted=0
  WHERE l.team_id='<TID>' AND l.lead_id!='' AND l.service_type='sales'
    AND l.created_at BETWEEN '<S>' AND '<E>' AND l.__deleted=0
  GROUP BY l.lead_id, l.created_at HAVING delta_ms>=0);
```

## 11 · Campaigns (running) + dials/appts
```sql
SELECT campaignId, name FROM dealer_leads.campaigns
WHERE teamId='<TID>' AND campaignStatus='running' AND campaignType='Sales' AND __deleted=0;
-- dials: count(DISTINCT leadId) from dealer_leads.outboundTasks for those campaignIds
-- appts: outboundTasks.callId ⋈ dealer_leads.meetings (service_type, window)
```

---

## Bulk validation — all live teams, one day (recommended)
Instead of one team at a time, this returns yesterday's appointments + inbound leads
for **every live rooftop** in a single query — eyeball the spread:
```sql
SELECT m.team_id, count() appts
FROM dealer_leads.meetings m
WHERE m.service_type IN ('sales','service') AND m.source='spyne'
  AND m.created_at BETWEEN '<S>' AND '<E>' AND m.__deleted=0
  AND m.team_id IN (SELECT DISTINCT team_id FROM roi_live_departments)  -- supply the 73 ids
GROUP BY m.team_id ORDER BY appts DESC;
```

*(team_id IN list = the 73 live teams; I substitute it when I run the payload step.)*
