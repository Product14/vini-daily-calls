// Callback-from-outbound re-attribution.
//
// Business rule: an outbound agent calls a lead; the lead later calls back and
// our INBOUND agent picks up and (often) books the appointment. That callback is
// outbound-driven effort, so the conversation — and every metric on it, incl. the
// appointment — must be credited to the OUTBOUND agent, not Inbound.
//
// The only signal for this lives in the raw endcallreports document at
// callDetails.outboundCallbackContext.callbackFromOutbound = true. It is NOT in
// the flattened dealer_leads.endcallreports table, so we read it from
// dealer_leads_raw.endcallreports (JSON `doc` column, ~169k rows, direct JSON
// path access is fast). Every such call is an inboundPhoneCall today.
//
// Rather than fork the Metabase-synced SQL (server/agentBaseFact.sql and the 6
// queries in agentMetricsQueries.json are regenerated from card 12227), this
// module injects the same three edits into any of those SQL bodies at load time:
//   1. a `callback_from_outbound` CTE (callId + team_id of callback calls),
//   2. a LEFT JOIN of that CTE onto the conversation spine, and
//   3. a direction / agent_type override that flips matched inbound rows to
//      Outbound.
// On re-sync the fix re-applies automatically. Anchors are asserted so any drift
// in the upstream SQL fails loudly instead of silently skipping the fix.

const CTE_ANCHOR = "customer_opt_out AS (";

const CTE_BLOCK = `callback_from_outbound AS (
    -- Inbound calls the customer placed back in response to an outbound touch.
    -- Signal lives only in the raw endcallreports doc; these arrive as
    -- inboundPhoneCall but are outbound-driven, so we re-attribute them.
    SELECT
        toString(doc.callId) AS callId,
        toString(doc.teamId) AS team_id,
        toUInt8(1)           AS is_callback
    FROM dealer_leads_raw.endcallreports
    WHERE _peerdb_is_deleted = 0
      AND doc.callDetails.outboundCallbackContext.callbackFromOutbound = true
    GROUP BY callId, team_id
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
