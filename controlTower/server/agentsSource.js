// ─── Agent performance source of truth (replaces the agents_v2 Metabase cards) ─
// Drop-in replacement for the old server/agentsMetabase.js. Instead of fetching
// two public Metabase cards over HTTP, this reads the SAME canonical ClickHouse
// conversation spine the dashboard + digest use, via the parent project's
// server/agentRooftop.js#runAgentRooftops(). One source of truth — the control
// tower's agent numbers now match /api/agents exactly.
//
// runAgentRooftops() returns { totals, daily } already grouped at
// (team_id × agent_type [× activity_day]) with the same snake_case field names
// the old cards used (touched_leads, qualified_leads, appointments, total_calls,
// leads_with_calls, leads_with_sms, transfer_leads, callback_leads, total_sms),
// and agent_type as "Sales Inbound" / "Sales Outbound" / "Service Inbound" /
// "Service Outbound" — identical to what the Metabase cards emitted. We only
// normalize two things the spine names differently / omits:
//   • total_sms → total_sms_conversations  (the daily aggregator reads that name)
//   • abr        derived per the ABR denominator policy below (totals card had it precomputed)
//
// Fields the spine doesn't carry are handled exactly as the cards' absence was:
//   • appointment_intent_leads (warm leads) → absent → 0 → "coming soon" stub
//   • call_failures            → absent → null → email shows "—" + 2% fallback

import { runAgentRooftops } from "../../server/agentRooftop.js";

// Fallback call-failure rate while the spine doesn't expose a failures column.
// 2% is the on-call team's known value; mirrors the old agentsMetabase.js.
const CALL_FAILURE_RATE_FALLBACK = 0.02;

// Demo / test rooftops to exclude — mirrors server/app.js:1253-1259. The spine's
// lead_canonical already drops test/demo accounts upstream, so this is now
// belt-and-suspenders (and still catches the few business-internal rooftops).
const AGENT_ROOFTOP_EXCLUDE = new Set([
  "team 1", "team1",
  "spyne motors", "spyne", "spyne auto group",
  "khandelwal", "prompt testing", "speed to lead", "approval genie",
  "onboardtest3", "onboardtest4",
  "used inventory",
  // Churned customers — removed from every tab (not test rooftops, real deals
  // that ended). Edwards auto group (all rooftops) + Watermark churned.
  "edwards chevrolet 280", "edwards chevrolet downtown",
  "edwards ford", "edwards honda", "edwards nissan",
  "watermark auto group_marion-il",
]);
// Rooftops whose SERVICE side alone is churned / never deployed — Sales stays,
// Service agent rows drop. Bridgeton Auto Mall: sales is live, service isn't.
const AGENT_ROOFTOP_EXCLUDE_SERVICE = new Set([
  "bridgeton auto mall",
]);
const isExcluded = (row) => {
  const name = String(row?.rooftop_name ?? "").trim().toLowerCase();
  if (AGENT_ROOFTOP_EXCLUDE.has(name)) return true;
  return (
    AGENT_ROOFTOP_EXCLUDE_SERVICE.has(name) &&
    String(row?.agent_type ?? "").trim().toLowerCase().startsWith("service")
  );
};

const AGENT_LABELS = {
  "Sales Inbound":    "Sales IB",
  "Sales Outbound":   "Sales OB",
  "Service Inbound":  "Service IB",
  "Service Outbound": "Service OB",
};

// team_id compatibility: the spine emits bare "team_id"; keep the pld.* fallback
// the old totals card used so callers/joins behave identically.
const readTeamId = (r) => {
  const v = r["team_id"] ?? r["pld.team_id"];
  return v == null ? "" : String(v);
};

// Try common aliases for the call-failures column. Returns null if absent.
function readCallFailures(r) {
  return (
    r.call_failures        ??
    r.total_call_failures  ??
    r.failed_calls         ??
    r.total_failures       ??
    null
  );
}

// Normalize a spine row to the field names the control-tower consumers expect.
// ABR denominator policy (single source for the whole control tower):
//   • Sales Inbound + Sales Outbound + Service Inbound → appts ÷ QUALIFIED leads
//     (their raw lead lists are huge / pre-filter heavily, so touched leads over-count)
//   • Service Outbound → appts ÷ touched leads
// Sales Inbound moved from touched to qualified on 2026-08-18, alongside its new qualified
// rule (report.qualified / conversationAnalytics.outcome — see server/qualifiedRules.js).
// agent_type here is the raw spine label ("Sales Outbound" / "Service Inbound").
//
// ⚠️ TWO CONSEQUENCES OF THE SALES-INBOUND SWITCH:
//  1. Its ABR jumps ~2.4% -> ~10% (a much smaller denominator), which crosses the
//     `abr: { good: 0.05, amber: 0.02 }` grading thresholds in agentsEmailTemplate.js —
//     Sales Inbound goes amber -> green without anything improving. Those thresholds were
//     calibrated when two of four agents used touched; three of four now use qualified, so
//     they likely want recalibrating per denominator.
//  2. Sales Inbound qualified is NOT nested inside engaged (report.qualified is a model
//     verdict, not a transcript test — ~3% of qualified leads never engaged), so this ABR
//     is not a clean funnel conversion. It is appts per qualified lead, nothing more.
const ABR_USES_QUALIFIED = new Set(["Sales Inbound", "Sales Outbound", "Service Inbound"]);
export function abrDenominator(r) {
  return ABR_USES_QUALIFIED.has(r.agent_type)
    ? Number(r.qualified_leads ?? 0)
    : Number(r.touched_leads ?? 0);
}

// Number() the two we derive so string-typed UInt64s from ClickHouse behave.
function norm(r) {
  const appts = Number(r.appointments ?? 0);
  const denom = abrDenominator(r);
  return {
    ...r,
    total_sms_conversations: Number(r.total_sms ?? 0),
    abr: denom > 0 ? appts / denom : null,
  };
}

// One ClickHouse spine scan per process run, shared by totals + daily + history.
let _cache = null;
async function load() {
  if (_cache) return _cache;
  const { totals, daily } = await runAgentRooftops();
  _cache = {
    totals: (Array.isArray(totals) ? totals : []).filter(r => !isExcluded(r)).map(norm),
    daily:  (Array.isArray(daily)  ? daily  : []).filter(r => !isExcluded(r)).map(norm),
  };
  return _cache;
}

function yesterdayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

// ─── Totals: per (team × agent_type) — used for the ABR-driven RAG ──────────
export async function fetchAgentsTotals() {
  const { totals } = await load();
  return totals.map(r => ({
    teamId:           readTeamId(r),
    rooftop:          r.rooftop_name,
    enterprise:       r.enterprise_name,
    agentRaw:         r.agent_type,
    agentShort:       AGENT_LABELS[r.agent_type] || r.agent_type,
    leadsInteracted:  Number(r.touched_leads ?? 0),
    appointments:     Number(r.appointments  ?? 0),
    totalCalls:       Number(r.total_calls   ?? 0),
    abr:              r.abr != null ? Number(r.abr) : null,   // 0..1 decimal
    apptValue:        Number(r.appointment_value ?? 0),
    callFailures:     readCallFailures(r),
  }));
}

// ─── Daily: portfolio rollup for a single activity_date ─────────────────────
// Same contract as the old card-backed fetchAgentsDaily. Defaults to yesterday
// (IST), falling back to the most recent activity_day present in the spine.
export async function fetchAgentsDaily({ asOfDate } = {}) {
  const { daily: all } = await load();

  const allDates = [...new Set(all.map(r => r.day))].filter(Boolean).sort();
  const target = asOfDate ?? (allDates.includes(yesterdayIST()) ? yesterdayIST() : allDates[allDates.length - 1]);

  const rows = all.filter(r => r.day === target);

  let calls = 0, appts = 0, leads = 0, failures = 0, abrDenom = 0;
  let failuresSeen = false;
  const teamsActive = new Set();

  for (const r of rows) {
    calls += Number(r.total_calls   ?? 0);
    appts += Number(r.appointments  ?? 0);
    leads += Number(r.touched_leads ?? 0);
    // Portfolio ABR honors the same per-agent denominator policy: Sales OB +
    // Service IB contribute QUALIFIED calls to the denominator, the rest leads.
    abrDenom += abrDenominator(r);
    const f = readCallFailures(r);
    if (f != null) { failures += Number(f); failuresSeen = true; }
    if (readTeamId(r)) teamsActive.add(`${readTeamId(r)}::${r.agent_type}`);
  }

  const abr = abrDenom > 0 ? appts / abrDenom : null;

  let callFailureRate = null;
  let callFailureRateIsFallback = false;
  if (failuresSeen && calls > 0) {
    callFailureRate = failures / calls;
  } else if (CALL_FAILURE_RATE_FALLBACK != null) {
    callFailureRate = CALL_FAILURE_RATE_FALLBACK;
    callFailureRateIsFallback = true;
  }

  return {
    asOfDate:      target,
    rowCount:      rows.length,
    calls,
    appointments:  appts,
    leadsInteracted: leads,
    abr,
    callFailures:  failuresSeen ? failures : null,
    callFailureRate,
    callFailureRateIsFallback,
    agentsActive:  teamsActive.size,
  };
}

// ─── Daily rows: per (day × team × agent_type) — used by historicalAggregates ─
// Returns the normalized spine daily rows (same field names the old AGENTS_DAILY
// card returned, plus total_sms_conversations). Replaces that module's internal
// Metabase fetch.
export async function fetchDailyRows() {
  const { daily } = await load();
  return daily;
}
