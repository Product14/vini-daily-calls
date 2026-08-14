-- Extraction query for the /abr-trends dashboard.
-- PREPEND vini_funnel_base.sql before running. Emits grain x channel x bucket,
-- with 'all' rollup members for BOTH channel and bucket (arrayJoin) so the
-- distinct-lead counts are correct rather than summed.
-- DO NOT sum across channel, bucket or grain — every row is emitted under its
-- real value AND under 'all'.

, ai AS (
  SELECT JSONExtractString(assumeNotNull(meta),'conversationId') AS cid, intent
  FROM dealer_leads.actionItems FINAL
  WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
    AND ifNull(intent,'') != ''
),
tl AS (
  SELECT conversationId AS cid,
    JSONExtractString(JSONExtractRaw(arrayJoin(arrayConcat(
      arrayFlatten(arrayMap(a->JSONExtractArrayRaw(a,'toolCalls'), JSONExtractArrayRaw(assumeNotNull(messages)))),
      arrayFlatten(arrayMap(a->JSONExtractArrayRaw(a,'tool_calls'), JSONExtractArrayRaw(assumeNotNull(messages))))
    )),'function'),'name') AS tool
  FROM dealer_leads.smsChatCompletions FINAL
  WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
    AND (position(assumeNotNull(messages),'toolCalls')>0 OR position(assumeNotNull(messages),'tool_calls')>0)
),
tc AS (
  SELECT callId AS cid,
    JSONExtractString(JSONExtractRaw(arrayJoin(arrayFlatten(arrayMap(
      a->JSONExtractArrayRaw(a,'toolCalls'), JSONExtractArrayRaw(assumeNotNull(callDetails_messages))))),'function'),'name') AS tool
  FROM dealer_leads.endcallreports FINAL
  WHERE __deleted=0 AND isTestCall=false
    AND JSONExtractString(ifNull(report,'{}'),'spam')='No'
    AND callDetails_callType IN ('webCall','inboundPhoneCall','outboundPhoneCall')
    AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 1
    AND position(assumeNotNull(callDetails_messages),'toolCalls')>0
),
ev AS (
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 'a' AS fam, ai.intent AS item
  FROM conv v INNER JOIN ai ON ai.cid = v.conv_id
  UNION ALL
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 't' AS fam, tl.tool AS item
  FROM conv v INNER JOIN tl ON tl.cid = v.conv_id WHERE v.channel='sms' AND tl.tool != ''
  UNION ALL
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 't' AS fam, tc.tool AS item
  FROM conv v INNER JOIN tc ON tc.cid = v.tool_key WHERE v.channel='call' AND tc.tool != ''
),
ex AS (SELECT g.1 AS grain, g.2 AS period, arrayJoin([channel,'all']) AS ch,
         arrayJoin([concat(svc,'_',dir),'all']) AS bucket, fam, item, lead_id
       FROM ev ARRAY JOIN [('d',toDate(ts)),('w',toStartOfWeek(ts,1)),('m',toStartOfMonth(ts))] AS g)
SELECT grain AS g, toString(period) AS p, ch, bucket AS b, fam AS f, item AS i, uniqExact(lead_id) AS n
FROM ex GROUP BY g, p, ch, b, f, i ORDER BY g, p, ch, b, f, n DESC
