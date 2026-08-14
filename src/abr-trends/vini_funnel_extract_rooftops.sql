-- Rooftop breakdown — NOT used by /abr-trends any more.
-- Pulled out of that dashboard 2026-08-14; it is getting its own tab. Query kept ready
-- for that: weekly, per rooftop, per channel, per agent bucket, with reached / engaged /
-- qualified / booked lead counts.
--
-- Extraction query for the /abr-trends dashboard family.
-- PREPEND vini_funnel_base.sql before running. Emits grain x channel x bucket,
-- with 'all' rollup members for BOTH channel and bucket (arrayJoin) so the
-- distinct-lead counts are correct rather than summed.
-- DO NOT sum across channel, bucket or grain — every row is emitted under its
-- real value AND under 'all'.

, rx AS (SELECT toStartOfWeek(ts,1) AS period, ifNull(rooftop,'(unmapped)') AS rt,
         arrayJoin([channel,'all']) AS ch, arrayJoin([concat(svc,'_',dir),'all']) AS bucket,
         lead_id, reached, engaged, booked, qualified FROM conv)
SELECT toString(period) AS p, rt, ch, bucket AS b,
  uniqExactIf(lead_id, reached=1) AS rch, uniqExactIf(lead_id, engaged=1) AS eng,
  uniqExactIf(lead_id, qualified=1) AS qual, uniqExactIf(lead_id, booked=1) AS bkd
FROM rx GROUP BY p, rt, ch, b HAVING rch >= 5 ORDER BY p, rt, ch, b
