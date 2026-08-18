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
import { applyWarmTransferExclusion } from "./warmTransferExclusion.js";
import { applyQualifiedOutboundRule } from "./qualifiedOutboundRule.js";
import { injectDealerWebsite, classifyOemBrands } from "./oemBrands.js";

const here = dirname(fileURLToPath(import.meta.url));
// Load-time rewrites of the Metabase-synced spine, innermost first:
//   callbackOutboundAttribution — credit outbound-driven callbacks to the Outbound agent
//   warmTransferExclusion       — meta.source='warm_transfer' meetings aren't appointments we created
//   qualifiedOutboundRule       — Sales Outbound qualifies on the campaign outcome; corrected vocab
//   injectDealerWebsite         — dealer_website column for OEM-brand classification
// Identical to the Overall view's chain (agentMetrics.js), so the two views reconcile.
const SPINE = "agentBaseFact.sql";
const BASE_FACT = injectDealerWebsite(
  applyQualifiedOutboundRule(
    applyWarmTransferExclusion(
      applyCallbackOutboundAttribution(readFileSync(join(here, SPINE), "utf8"), SPINE),
      SPINE
    ),
    SPINE
  ),
  SPINE
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
  any(dealer_website)  AS dealer_website,
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
  -- canonical (matches reporting-vini's aggregate.ts _apptLeads set): AI-booked
  -- appointments counted as DISTINCT LEADS with >=1 booked meeting, not raw
  -- meeting rows — a lead with 2 meetings (reschedule/dupe) must count once,
  -- same as every other funnel column here.
  uniqExactIf(lead_id, appointment_booked = 1) AS appointments,
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

// ── Incremental refresh (today + a trailing buffer day) ─────────────────────
// `totals` is a uniqExact(lead_id) distinct count over the WHOLE window, not a
// sum of daily rows — it is NOT safe to derive from cached daily rows (that's
// the exact cross-day double-count the dashboard already warns about). Only
// `daily` rows are independently deduped per-day, so only `daily` can be
// correctly refreshed from a narrow time window. This lets us re-poll "today"
// on a tight cadence (cheap: 1-2 days of base_fact, not the full 120-day scan)
// while `totals` keeps coming from the full-window query below, on its own
// (slower) cadence. See server/app.js computeRooftopBundleIncremental/TotalsOnly.
const INCREMENTAL_WINDOW_DAYS = Number(process.env.AGENTS_INCREMENTAL_WINDOW_DAYS) || 2;

const dailyOnlySql = () => `SELECT ${DIM_COLS}, toString(activity_day) AS day, ${METRIC_COLS}
FROM ( ${BASE_FACT.replaceAll("{START}", `addDays(today(), -${INCREMENTAL_WINDOW_DAYS})`)} ) AS b
WHERE team_id != ''
GROUP BY team_id, agent_type, activity_day`;

const voucherDailyOnlySql = () => `
  SELECT team_id, toString(day) AS day, count() AS voucher_claims
  FROM (
    SELECT team_id, toDate(createdAt) AS day
    FROM dealer_leads.voucher FINAL
    WHERE __deleted = 0 AND createdAt >= addDays(today(), -${INCREMENTAL_WINDOW_DAYS})
  )
  GROUP BY team_id, day`;

// Full-window totals only (no daily grouping set) — same correctness as the
// combined query's totals grain, cheaper than it since it never materializes
// per-day rows.
const totalsOnlySql = () => `SELECT ${DIM_COLS}, ${METRIC_COLS}
FROM ( ${baseSql()} ) AS b
WHERE team_id != ''
GROUP BY team_id, agent_type`;

const voucherTotalsOnlySql = () => `
  SELECT team_id, count() AS voucher_claims
  FROM (
    SELECT team_id
    FROM dealer_leads.voucher FINAL
    WHERE __deleted = 0 AND createdAt >= addDays(today(), -${WINDOW_DAYS})
  )
  GROUP BY team_id`;

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

// Attaches oem_brands (string[]) to each row from its dealer_website /
// rooftop_name, then drops dealer_website — it was only scaffolding for the
// classifier, not a field the dashboard needs directly.
function enrichOemBrands(rows) {
  for (const r of rows) {
    r.oem_brands = classifyOemBrands(r.rooftop_name, r.dealer_website, r.team_id);
    delete r.dealer_website;
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
  enrichOemBrands(totals);
  enrichOemBrands(daily);
  return { totals, daily };
}

// Cheap: only today + INCREMENTAL_WINDOW_DAYS-1 of trailing buffer. Caller
// merges these rows into the cached `daily` array by (team_id, agent_type, day)
// — older cached days are left untouched.
export async function runAgentRooftopsIncremental() {
  const [daily, voucherDaily] = await Promise.all([
    runClickhouse(dailyOnlySql()),
    runClickhouse(voucherDailyOnlySql()),
  ]);
  mergeVoucherClaims(daily, voucherDaily, { keyed: true });
  enrichOemBrands(daily);
  return { daily };
}

// Full 120-day window, totals grain only. Caller replaces the cached `totals`
// array wholesale (it's a window-deduped distinct count, not a merge target).
export async function runAgentRooftopsTotalsOnly() {
  const [totals, voucherTotals] = await Promise.all([
    runClickhouse(totalsOnlySql()),
    runClickhouse(voucherTotalsOnlySql()),
  ]);
  mergeVoucherClaims(totals, voucherTotals, { keyed: false });
  enrichOemBrands(totals);
  return { totals };
}

export { hasClickhouseCreds };
