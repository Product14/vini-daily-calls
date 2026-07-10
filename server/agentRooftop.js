// Rooftop-grain agent metrics, straight off Q12227's base_fact on ClickHouse —
// the SAME raw layer the Overall view (/api/metrics) aggregates. Aggregating
// here at (team_id × agent_type [× activity_day]) makes the Rooftop view and the
// Overall view reconcile exactly (one source, identical definitions). Replaces
// the old Metabase agents_v2 cards.
//
// Distinct-count fields use uniqExact so the totals query is lead-deduped over
// the whole window and the daily query is deduped per day — never summed across
// days (the cross-day double-count the dashboard already warns about).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClickhouse, hasClickhouseCreds } from "./agentMetrics.js";
import { applyCallbackOutboundAttribution } from "./callbackAttribution.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_FACT = applyCallbackOutboundAttribution(
  readFileSync(join(here, "agentBaseFact.sql"), "utf8"),
  "agentBaseFact.sql"
);

// Trailing window the rooftop view covers (daily rows + totals). 120 days spans
// the dashboard's widest preset (Last 90D) with headroom; "All" then means
// "last N days". base_fact's {START} floors the underlying conversation scan.
const WINDOW_DAYS = Number(process.env.AGENTS_WINDOW_DAYS) || 120;
const baseSql = () => BASE_FACT.replaceAll("{START}", `addDays(today(), -${WINDOW_DAYS})`);

// Identity columns carried per rooftop. The dashboard reads team_id/enterprise_id
// bare (it also accepts the pld.* aliases the old totals card used).
const DIM_COLS = `
  team_id,
  any(enterprise_id)   AS enterprise_id,
  any(enterprise_name) AS enterprise_name,
  any(rooftop_name)    AS rooftop_name,
  any(rooftop_stage)   AS rooftop_stage,
  any(service_type)    AS service_type,
  any(direction)       AS direction,
  agent_type`;

// Metric columns matching the dashboard's AgentRowBase. appointment_value is not
// in Q12227 (ROI uses the cost-per-appt model, not $-value) → 0. new_leads_created
// / leads_contacted_from_new / capture_rate are top-of-funnel concepts absent from
// the conversation-grain base_fact and are already hidden in the UI → omitted.
const METRIC_COLS = `
  uniqExact(lead_id)                          AS touched_leads,
  uniqExactIf(lead_id, qualified = 1)         AS qualified_leads,
  uniqExactIf(lead_id, had_appt_intent = 1)   AS appointment_intent_leads,
  sum(appointments_count)                     AS appointments,
  toInt32(0)                                  AS appointment_value,
  sum(is_call)                                AS total_calls,
  sum(n_sms_messages)                         AS total_sms,
  uniqExactIf(lead_id, is_call = 1)           AS leads_with_calls,
  uniqExactIf(lead_id, is_sms = 1)            AS leads_with_sms,
  uniqExactIf(lead_id, had_transfer = 1)      AS transfer_leads,
  uniqExactIf(lead_id, had_transfer_failed = 1) AS transfer_failed_leads,
  uniqExactIf(lead_id, had_callback = 1)      AS callback_leads`;

// ONE query, BOTH grains. The base_fact scan (the entire ~17s / OOM-prone cost —
// the aggregation itself is nearly free) used to run TWICE: once for the totals
// query, once for the daily query. GROUPING SETS scans the subquery a single time
// and emits both grains — the (team_id, agent_type) rows are the window-deduped
// totals, the (team_id, agent_type, activity_day) rows are the per-day daily set.
// `GROUPING(activity_day)` is 1 on the totals-grain rows (activity_day rolled up),
// 0 on the daily-grain rows — we split on it below. Halves ClickHouse work and,
// more importantly, halves peak memory so the cron stops tripping the 57.6 GiB
// ceiling (Code 241) and the precompute cache stays reliably warm.
const combinedSql = () => `SELECT ${DIM_COLS}, toString(activity_day) AS day,
  GROUPING(activity_day) AS is_totals, ${METRIC_COLS}
FROM ( ${baseSql()} ) AS b
WHERE team_id != ''
GROUP BY GROUPING SETS (
  (team_id, agent_type),
  (team_id, agent_type, activity_day)
)`;

// Voucher claims — Service Outbound-only outcome, separate from base_fact since
// dealer_leads.voucher isn't lead-level (no lead_id to join on) and joining by
// team_id alone onto the lead-grain base_fact would fan out. Scanned once here,
// merged onto the Service Outbound rows below by (team_id[, day]).
const voucherSql = () => `
  SELECT team_id, toString(day) AS day, GROUPING(day) AS is_totals, count() AS voucher_claims
  FROM (
    SELECT team_id, toDate(createdAt) AS day
    FROM dealer_leads.voucher FINAL
    WHERE __deleted = 0 AND createdAt >= addDays(today(), -${WINDOW_DAYS})
  )
  GROUP BY GROUPING SETS ((team_id), (team_id, day))`;

// Merges voucher claim counts onto the Service Outbound row for each (team_id[, day]).
// Synthesizes a zero-filled Service Outbound row when a team claimed vouchers on a
// day with no other Service Outbound activity, so claims are never silently dropped.
function mergeVoucherClaims(rows, voucherRows, { keyed }) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.agent_type !== "Service Outbound") continue;
    const key = keyed ? `${r.team_id}|${r.day}` : r.team_id;
    byKey.set(key, r);
  }
  for (const v of voucherRows) {
    const key = keyed ? `${v.team_id}|${v.day}` : v.team_id;
    const claims = Number(v.voucher_claims) || 0;
    const existing = byKey.get(key);
    if (existing) {
      existing.voucher_claims = claims;
    } else {
      const zeroed = { team_id: v.team_id, agent_type: "Service Outbound", voucher_claims: claims };
      if (keyed) zeroed.day = v.day;
      rows.push(zeroed);
      byKey.set(key, zeroed);
    }
  }
  for (const r of rows) {
    if (r.agent_type === "Service Outbound" && r.voucher_claims === undefined) r.voucher_claims = 0;
  }
}

// Returns { daily, totals } in the exact shape /api/agents already serves.
// GROUP BY yields one row per key, so no client-side dedup is needed.
export async function runAgentRooftops() {
  const [rows, voucherRows] = await Promise.all([
    runClickhouse(combinedSql()),
    runClickhouse(voucherSql()),
  ]);
  const totals = [];
  const daily = [];
  const voucherTotals = [];
  const voucherDaily = [];
  for (const v of voucherRows) {
    if (Number(v.is_totals) === 1) voucherTotals.push({ team_id: v.team_id, voucher_claims: v.voucher_claims });
    else voucherDaily.push(v);
  }
  for (const r of rows) {
    const { is_totals, ...rest } = r;
    if (Number(is_totals) === 1) {
      // Totals grain: activity_day is rolled up (epoch default) — drop `day` so
      // the row shape matches the old totals query exactly.
      const { day, ...totalsRow } = rest;
      totals.push(totalsRow);
    } else {
      daily.push(rest);
    }
  }
  mergeVoucherClaims(totals, voucherTotals, { keyed: false });
  mergeVoucherClaims(daily, voucherDaily, { keyed: true });
  return { totals, daily };
}

export { hasClickhouseCreds };
