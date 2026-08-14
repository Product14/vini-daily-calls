-- Extraction query for the /abr-trends dashboard.
-- PREPEND vini_funnel_base.sql before running. Emits grain x channel x bucket,
-- with 'all' rollup members for BOTH channel and bucket (arrayJoin) so the
-- distinct-lead counts are correct rather than summed.
-- DO NOT sum across channel, bucket or grain — every row is emitted under its
-- real value AND under 'all'.

, fx AS (SELECT g.1 AS grain, g.2 AS period,
      arrayJoin([channel,'all']) AS ch,
      arrayJoin([concat(svc,'_',dir),'all']) AS bucket,
      lead_id, reached, engaged, booked, qualified, any_tool, depth_num
    FROM conv ARRAY JOIN [('d',toDate(ts)),('w',toStartOfWeek(ts,1)),('m',toStartOfMonth(ts))] AS g)
SELECT grain AS g, toString(period) AS p, ch, bucket AS b,
  uniqExact(lead_id) AS att,
  uniqExactIf(lead_id, reached=1) AS rch,
  uniqExactIf(lead_id, engaged=1) AS eng,
  uniqExactIf(lead_id, qualified=1) AS qual,
  uniqExactIf(lead_id, any_tool=1) AS tool,
  uniqExactIf(lead_id, booked=1) AS bkd,
  round(sumIf(depth_num, engaged=1), 1) AS dnum
FROM fx GROUP BY g, p, ch, b ORDER BY g, p, ch, b
