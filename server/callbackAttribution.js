// Callback-from-outbound re-attribution.
//
// Business rule: an OUTBOUND campaign calls a lead; the lead later calls back —
// often on the very outbound number it was dialled from — and an INBOUND agent
// picks up and (often) books the appointment. That callback is outbound-driven
// effort, so the conversation — and every metric on it, incl. the appointment —
// must be credited to the OUTBOUND agent, not Inbound.
//
// Signal: the flattened dealer_leads.endcallreports columns isCallbackFromOutbound
// / callbackCampaignId / callbackOutboundTaskId, joined to the spine by callId.
// A row is a callback when isCallbackFromOutbound = 1 OR it carries a
// callbackCampaignId / callbackOutboundTaskId (the campaign + outbound-task ids
// that originated the outreach). We read these flattened columns rather than the
// raw doc JSON (callDetails.outboundCallbackContext.callbackFromOutbound): the
// flattened signal is ≈1:1 with the raw flag, far cheaper (no OOM-prone raw-doc
// FINAL scan), and additionally carries the originating campaign/task ids that
// the raw path lacks — kept here so callback-booked appointments can be
// campaign-attributed downstream. Mirrors reporting-vini's callbackAttribution.ts.
//
// Rather than fork the Metabase-synced SQL (server/agentBaseFact.sql and the 6
// queries in agentMetricsQueries.json are regenerated from card 12227), this
// module injects the same three edits into any of those SQL bodies at load time:
//   1. a `callback_from_outbound` CTE (callId + team_id + originating
//      campaign/task of callback calls),
//   2. a LEFT JOIN of that CTE onto the conversation spine, and
//   3. a direction / agent_type override that flips matched inbound rows to
//      Outbound.
// On re-sync the fix re-applies automatically. Anchors are asserted so any drift
// in the upstream SQL fails loudly instead of silently skipping the fix.

const CTE_ANCHOR = "customer_opt_out AS (";

// The CTE is floored to a fixed window so the endcallreports FINAL scan stays
// bounded (avoids an all-time scan / OOM). Unlike reporting-vini's spine, this
// repo's consumers don't share one {START}/{END} pair — the rooftop spine
// substitutes only {START} (−120d) and the 6 metrics queries carry their own
// per-grain floors (day −45d, week −84d, month ≈ −5mo) with no {END} — so we use
// a single conservative floor wide enough to cover the widest consumer (the month
// grain). Callback rows outside a given query's window simply never join.
const CALLBACK_FLOOR = "toStartOfMonth(addMonths(today(), -6))";

const CTE_BLOCK = `callback_from_outbound AS (
    -- Inbound calls the customer placed back in response to an outbound touch.
    -- Flattened signal on dealer_leads.endcallreports (joined by callId); floored
    -- to a fixed window to avoid an all-time endcallreports FINAL scan. Also
    -- carries the originating campaign/task so callback-booked appointments can
    -- be campaign-attributed downstream.
    SELECT
        ecr.callId AS callId,
        ecr.teamId AS team_id,
        toUInt8(1) AS is_callback,
        any(ecr.callbackCampaignId)     AS callback_campaign_id,
        any(ecr.callbackOutboundTaskId) AS callback_outbound_task_id
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0
      AND ecr.callId IS NOT NULL AND ecr.callId != ''
      AND toDate(ecr.createdAt) >= ${CALLBACK_FLOOR}
      AND ( ecr.isCallbackFromOutbound = 1
            OR ifNull(ecr.callbackCampaignId, '') != ''
            OR ifNull(ecr.callbackOutboundTaskId, '') != '' )
    GROUP BY ecr.callId, ecr.teamId
),

`;

const JOIN_ANCHOR = "LEFT JOIN eventila.enterprise_details ed FINAL";

const JOIN_BLOCK = `LEFT JOIN callback_from_outbound cbo
    ON cbo.callId = cs.callId AND cbo.team_id = cs.team_id
`;

const DIR_ANCHOR = `    cs.direction AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cs.direction='inbound','Inbound','Outbound')) AS agent_type,`;

// Preserve the original semantics (inbound -> Inbound, else -> Outbound) but
// force Outbound whenever the call is a callback-from-outbound.
const DIR_REPLACEMENT = `    -- Callback-from-outbound: flip inbound callbacks to Outbound (see callbackAttribution.js).
    if(cbo.is_callback = 1, 'outbound', cs.direction) AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cbo.is_callback = 1, 'Outbound',
              if(cs.direction='inbound','Inbound','Outbound'))) AS agent_type,`;

export function applyCallbackOutboundAttribution(sql, label = "sql") {
  if (sql.includes("callback_from_outbound")) return sql; // already applied
  for (const [name, anchor] of [
    ["CTE", CTE_ANCHOR],
    ["JOIN", JOIN_ANCHOR],
    ["DIR", DIR_ANCHOR],
  ]) {
    if (!sql.includes(anchor)) {
      throw new Error(
        `[callbackAttribution] ${label}: missing ${name} anchor — upstream SQL changed, fix needs review`
      );
    }
  }
  return sql
    .replace(CTE_ANCHOR, CTE_BLOCK + CTE_ANCHOR)
    .replace(JOIN_ANCHOR, JOIN_BLOCK + JOIN_ANCHOR)
    .replace(DIR_ANCHOR, DIR_REPLACEMENT);
}
