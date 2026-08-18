// SALES OUTBOUND qualified = the CAMPAIGN OUTCOME, not an inferred intent label.
// Plus: the buying-intent action-item vocabulary, which had silently decayed.
//
// Mirrors reporting-vini @ ac8e585 / ac631eb (src/lib/reports/agentBaseFact.sql). Both repos must apply
// the same rule or the console and this dashboard disagree on the same metric — which is exactly what
// happened when the change shipped to reporting-vini only and this dashboard kept reporting the old
// number (Sales Outbound leads_qualified = 39 for 2026-08-17 while the console said ~3x that).
//
// ── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────────────────
//  1. VOCABULARY (affects the SMS gate on every SALES agent). The shipped list was 15 action-item
//     intents and contained SERVICE_SCHEDULE_APPOINTMENT but NOT its sales twin
//     SALES_SCHEDULE_APPOINTMENT — and that label only starts appearing 2026-07-02 (493 leads by
//     2026-08-18). SEND_VEHICLE_PHOTO starts 2026-07-31. An unrecognised intent name reads as "no
//     buying intent", so qualified SAGGED through July while real qualification did not. Now 25 labels;
//     all verified present in prod dealer_leads.actionItems.intent. The SendVehicle* camelCase forms
//     are legacy (1-15 leads each, June only) but kept so history reads consistently.
//  2. SALES OUTBOUND qualified = campaignLeadMappings.outcome in a 20-value qualifying set AND the
//     customer engaged that period — spoke on a call, or sent a human SMS reply that is not merely an
//     opt-out keyword ("STOP" is the customer leaving, not replying; hence n_human_inbound_real).
//     Sales Inbound and BOTH Service agents keep the intent rule, so "same rule both channels" is
//     deliberately broken for outbound only.
//
// Weekly fleet Sales Outbound qualified, old vs new: agrees through mid-June (136/128, 254/237,
// 312/310) then diverges — 205/387 (w/c 07-06), 165/385 (w/c 08-03). The old rule was reporting
// roughly HALF the real qualified pool from July onward.
//
// ⚠️ CAVEAT to state with the number: campaignLeadMappings holds ONE CURRENT outcome per lead,
// overwritten in place, and updatedAt churns under CDC — there is no usable event date. The current
// outcome applies to every period the lead engaged in and can leak BACKWARDS. The number is therefore
// not perfectly reproducible: the same window re-run 40 minutes later moved by 1 lead in testing.
// Proper fix needs outboundTaskAuditLogs (14.7M rows).
//
// ── WHY INJECTION ────────────────────────────────────────────────────────────────────────────────────
// server/agentBaseFact.sql and the 6 spine queries in agentMetricsQueries.json are regenerated from
// Metabase card 12227, so they must not be forked. Same approach as callbackAttribution.js and
// warmTransferExclusion.js: anchor, assert, rewrite at load time. Every anchor is asserted to appear
// EXACTLY once, so any upstream drift fails loudly instead of half-applying.
//
// The two bodies are NOT identical in the final SELECT — agentBaseFact.sql (Rooftop view) computes
// qualified_via_sms inside sms_by_conv, while the JSON queries (Overall view) use sms_engaged plus a
// separate sms_buying_intent CTE. Hence two qualified variants below; the other three edits are shared.

// ── 1. vocabulary ───────────────────────────────────────────────────────────────────────────────────
const LIST_OLD = `        'ScheduleAppointment','RescheduleAppointment','SALES_SCHEDULE_SHOWROOM_VISIT',
        'CheckVehicleAvailability','CheckVehiclePrice','InquireFinanceStatus',
        'SALES_CONNECT_TO_FINANCE','InquireTradeInValue','SALES_TRADE_IN_FOLLOW_UP',
        'ScheduleTestDrive','SALES_SCHEDULE_TEST_DRIVE','InquireLeaseOptions',
        'SALES_FOLLOW_UP_WITH_QUOTE','SERVICE_SCHEDULE_APPOINTMENT','SERVICE_SEND_ESTIMATE'`;

const LIST_NEW = `${LIST_OLD},
        -- added 2026-08-18 (qualifiedOutboundRule.js): names the AI drifted to, plus legacy camelCase
        -- variants. When the AI emits a new intent name, ADD IT or the metric quietly sags again.
        'SALES_SCHEDULE_APPOINTMENT','SALES_SEND_VEHICLE_INFO','SALES_FOLLOW_UP_BE_BACK',
        'SEND_VEHICLE_PHOTO','SendVehicleImages','SendVehicleDetails','SendVehicleCatalog',
        'SendVehicleInformation','SendVehicleLink','CheckVehicleCondition'`;

// ── 2. the outcome CTEs ─────────────────────────────────────────────────────────────────────────────
// Inserted before sms_by_conv, which is always AFTER conversation_spine (verified in all 7 bodies) —
// required, because ob_campaign_outcome semi-joins the spine.
const CTE_ANCHOR = "sms_by_conv AS (";

const CTE_BLOCK = `ob_qualifying_outcomes AS (
    -- The 20 dispositions that count as qualified: the hot/warm buying + nurture tiers, plus leads
    -- already progressed PAST discussion (booked / self-booked / deposit / walk-in), plus human
    -- hand-offs. Declared before ob_campaign_outcome — a WITH clause may only reference earlier CTEs.
    SELECT arrayJoin([
        'purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
        'trade inquiry','ancillary inquiry',
        'customer considering','customer open to return','reconnect needed',
        'appointment','service appointment booked','meeting already scheduled',
        'customer already self booked','walk in committed','appointment rescheduled',
        'deposit placed',
        'callback requested','human requested','human transferred','transferred to service team'
    ]) AS outcome
),

ob_campaign_outcome AS (
    SELECT lead_id, outcome,
           if(outcome IN (SELECT outcome FROM ob_qualifying_outcomes), 1, 0) AS oc_q
    FROM (
        SELECT
            clm.leadId AS lead_id,
            -- most recent outcome wins; see the no-usable-date caveat at the top of this module.
            argMax(lower(trimBoth(ifNull(clm.outcome, ''))), clm.updatedAt) AS outcome
        FROM dealer_leads.campaignLeadMappings AS clm FINAL
        WHERE clm.__deleted = 0
          -- COST: the outcome has no date, so this scan cannot be date-bounded. Bound it instead to the
          -- leads this run touches — the only rows the join can use. Without this, reporting-vini's
          -- 120d reconcile went 28min -> 42min (it re-scans per chunk). Result-neutral, verified.
          AND clm.leadId IN (SELECT lead_id FROM conversation_spine)
        GROUP BY clm.leadId
    )
),

`;

// ── 3. STOP-aware SMS reply count ───────────────────────────────────────────────────────────────────
const SMS_ANCHOR =
  "        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in', 1, 0)) AS n_human_inbound,";

const SMS_BLOCK = `${SMS_ANCHOR}
        -- A human inbound reply whose ENTIRE body is an opt-out keyword is not engagement. Used only by
        -- the Sales-Outbound qualified gate; n_human_inbound above still counts them, so sms_replied /
        -- reached_person keep their existing meaning.
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND upper(trimBoth(ifNull(sm.body, ''))) NOT IN
                   ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT',
                    'OPTOUT','OPT OUT','REMOVE','NO'), 1, 0)) AS n_human_inbound_real,`;

// ── 4. join the CTE onto the spine ──────────────────────────────────────────────────────────────────
const JOIN_ANCHOR = "LEFT JOIN appt_by_conv_dedup ad";

const JOIN_BLOCK = `LEFT JOIN ob_campaign_outcome oco
    ON oco.lead_id = cs.lead_id
`;

// ── 5. the switch itself (two variants) ─────────────────────────────────────────────────────────────
// Keyed on \`agent_type\`, NOT cs.direction, so the callback->outbound flip that callbackAttribution.js
// injects is honoured: a lead that called the outbound line back is Sales Outbound and must be judged by
// the outbound rule. Both channel columns carry the switch, so \`qualified\` stays a plain greatest():
//   greatest(oc_q AND spoke, oc_q AND reply_real) == oc_q AND (spoke OR reply_real)
const OB_CALL = `    if(agent_type = 'Sales Outbound',
       if(ifNull(oco.oc_q, 0) = 1 AND ifNull(ec.is_connected, 0) = 1, 1, 0),
       ifNull(ec.qualified_via_call, 0))    AS qualified_via_call,`;

// Variant A — server/agentBaseFact.sql (Rooftop view).
const A_OLD = `    ifNull(ec.qualified_via_call, 0)        AS qualified_via_call,
    -- canonical: SMS-qualified already carries the buying-intent + opt-out gate in sms_by_conv.
    ifNull(sb.qualified_via_sms, 0)         AS qualified_via_sms,
    -- canonical (matches reporting-vini): overall qualified = qualified on call OR on SMS.
    -- No appointment guard — a booked lead with neither a buying-intent call nor SMS is not
    -- counted as qualified (identical to the console).
    greatest(
        ifNull(ec.qualified_via_call, 0),
        ifNull(sb.qualified_via_sms, 0)
    ) AS qualified,`;

const A_NEW = `${OB_CALL}
    -- Sales Outbound: campaign outcome + a real (non-opt-out) reply. Others keep the buying-intent gate.
    if(agent_type = 'Sales Outbound',
       if(ifNull(oco.oc_q, 0) = 1 AND ifNull(sb.n_human_inbound_real, 0) > 0, 1, 0),
       ifNull(sb.qualified_via_sms, 0))     AS qualified_via_sms,
    greatest(qualified_via_call, qualified_via_sms) AS qualified,`;

// Variant B — the 6 spine queries in agentMetricsQueries.json (Overall view).
const B_OLD = `    ifNull(ec.qualified_via_call, 0)        AS qualified_via_call,
    if(ifNull(sb.sms_engaged, 0) = 1 AND ifNull(sbi.has_buying_intent, 0) = 1, 1, 0) AS qualified_via_sms,
    ifNull(sb.sms_engaged, 0)               AS sms_engaged,
    greatest(ifNull(ec.qualified_via_call, 0), if(ifNull(sb.sms_engaged, 0) = 1 AND ifNull(sbi.has_buying_intent, 0) = 1, 1, 0)) AS qualified,`;

const B_NEW = `${OB_CALL}
    -- Sales Outbound: campaign outcome + a real (non-opt-out) reply. Others keep sms_engaged AND intent.
    if(agent_type = 'Sales Outbound',
       if(ifNull(oco.oc_q, 0) = 1 AND ifNull(sb.n_human_inbound_real, 0) > 0, 1, 0),
       if(ifNull(sb.sms_engaged, 0) = 1 AND ifNull(sbi.has_buying_intent, 0) = 1, 1, 0)) AS qualified_via_sms,
    ifNull(sb.sms_engaged, 0)               AS sms_engaged,
    greatest(qualified_via_call, qualified_via_sms) AS qualified,`;

const countOf = (s, sub) => s.split(sub).length - 1;

/**
 * Applies the Sales-Outbound campaign-outcome qualified rule and the corrected buying-intent
 * vocabulary to a spine SQL body. SQL with no conversation spine (the voucher queries) is returned
 * untouched. Throws if any anchor is missing or ambiguous.
 */
export function applyQualifiedOutboundRule(sql, label = "sql") {
  if (sql.includes("ob_campaign_outcome")) return sql; // already applied
  if (!sql.includes("conversation_spine AS (")) return sql; // not a spine body (vouchers)

  const variant = countOf(sql, B_OLD) === 1 ? "B" : countOf(sql, A_OLD) === 1 ? "A" : null;
  if (!variant) {
    throw new Error(
      `[qualifiedOutboundRule] ${label}: final-SELECT qualified block matches neither known variant ` +
      `— upstream SQL changed, fix needs review`
    );
  }
  for (const [name, anchor] of [
    ["LIST", LIST_OLD],
    ["CTE", CTE_ANCHOR],
    ["SMS", SMS_ANCHOR],
    ["JOIN", JOIN_ANCHOR],
  ]) {
    const n = countOf(sql, anchor);
    if (n !== 1) {
      throw new Error(
        `[qualifiedOutboundRule] ${label}: expected exactly 1 ${name} anchor, found ${n} ` +
        `— upstream SQL changed, fix needs review`
      );
    }
  }
  // conversation_spine must precede sms_by_conv, or the injected CTE would reference it too early.
  if (sql.indexOf("conversation_spine AS (") > sql.indexOf(CTE_ANCHOR)) {
    throw new Error(`[qualifiedOutboundRule] ${label}: conversation_spine follows sms_by_conv — cannot inject`);
  }
  return sql
    .replace(LIST_OLD, LIST_NEW)
    .replace(CTE_ANCHOR, CTE_BLOCK + CTE_ANCHOR)
    .replace(SMS_ANCHOR, SMS_BLOCK)
    .replace(JOIN_ANCHOR, JOIN_BLOCK + JOIN_ANCHOR)
    .replace(variant === "B" ? B_OLD : A_OLD, variant === "B" ? B_NEW : A_NEW);
}
