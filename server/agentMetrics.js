// Live "Overall" agent-performance metrics — runs the aggregation SQL against
// Prod-ClickHouse on demand and assembles the day/week/month bundle the
// OverallView dashboard consumes. Ported from the Vini-Product-Metrics repo
// (api/metrics.js); the 6 final SQL strings live in agentMetricsQueries.json.
//
// Credentials come from env (server-side only; never sent to the browser):
//   CLICKHOUSE_HOST, CLICKHOUSE_PORT (default 8443), CLICKHOUSE_USER, CLICKHOUSE_PASSWORD
//
// When the env vars are absent the endpoint returns 503 and the frontend falls
// back to the bundled snapshot (public/agent-overall-snapshot.json).
import { createRequire } from "node:module";
import { applyCallbackOutboundAttribution } from "./callbackAttribution.js";
import { applyWarmTransferExclusion } from "./warmTransferExclusion.js";
import { applyQualifiedRules } from "./qualifiedRules.js";
import { applyResellerAllowlist } from "./resellerAllowlist.js";

const require = createRequire(import.meta.url);
// Inbound callbacks driven by an outbound touch are re-attributed to the
// Outbound agent so the Overall view reconciles with the Rooftop view.
const QUERIES_RAW = require("./agentMetricsQueries.json");
// Voucher queries are plain team_id/period scans against dealer_leads.voucher —
// no conversation-spine callback/direction logic to patch, so they're exempt
// from the anchor-based rewrite (which throws when its CTE/JOIN/DIR anchors
// are absent from the SQL).
// meta.source='warm_transfer' meetings are appointments we did not create and
// must not be counted — see warmTransferExclusion.js (same rule the event-email
// send path applies, so the dashboard and the emails agree).
// resellerAllowlist widens the enterprise screen so partner-sold rooftops that are real paying
// customers stop being filtered out of every metric — see resellerAllowlist.js.
const QUERIES = Object.fromEntries(
  Object.entries(QUERIES_RAW).map(([k, sql]) =>
    [k, k.endsWith("_vouchers") ? sql : applyResellerAllowlist(applyQualifiedRules(applyWarmTransferExclusion(applyCallbackOutboundAttribution(sql, k), k), k), k)])
);

export function hasClickhouseCreds() {
  return Boolean(process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_PASSWORD);
}

// Global concurrency cap across ALL ClickHouse queries (both /api/metrics and
// /api/agents). base_fact scans are memory-heavy; too many at once OOMs the
// cluster (Code 241 — it sits right at its 57.6 GiB ceiling). 4 leaves headroom
// while still finishing a cold /api/metrics (6 queries) in two waves. Extra
// queries queue. Tune via CH_MAX_CONCURRENCY.
const CH_MAX = Number(process.env.CH_MAX_CONCURRENCY) || 4;
let chActive = 0;
const chWaiters = [];
function chAcquire() {
  if (chActive < CH_MAX) { chActive++; return Promise.resolve(); }
  return new Promise((resolve) => chWaiters.push(resolve));
}
function chRelease() {
  const next = chWaiters.shift();
  if (next) next();           // hand the slot straight to the next waiter
  else chActive--;
}

export async function runClickhouse(sql) {
  await chAcquire();
  try {
    return await runClickhouseRaw(sql);
  } finally {
    chRelease();
  }
}

async function runClickhouseRaw(sql) {
  const host = process.env.CLICKHOUSE_HOST;
  const port = process.env.CLICKHOUSE_PORT || "8443";
  const user = process.env.CLICKHOUSE_USER || "default";
  const pass = process.env.CLICKHOUSE_PASSWORD;
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  // Memory safety: let heavy GROUP BY/ORDER BY spill to disk instead of blowing the per-query
  // memory limit (the /api/metrics bundle was intermittently 500ing with "memory limit exceeded:
  // would use 58 GiB" on a cache-miss live compute). Settings ride on the HTTP URL so the SQL is
  // untouched. 4 GiB thresholds → spill kicks in well before the limit.
  const settings = "max_bytes_before_external_group_by=4000000000&max_bytes_before_external_sort=4000000000";
  const r = await fetch(`https://${host}:${port}/?${settings}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "text/plain" },
    body: sql + "\nFORMAT JSONEachRow",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 300)}`);
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
}

// Mirror of build_dashboard.py assembly (per-period grouping + intent + Total).
// R may carry only a subset of the 6 query results (the incremental/partial
// refreshes below only run 3 of them) — grains whose queries weren't supplied
// are skipped rather than assembled from `undefined`.
function assemble(R) {
  const grains = {
    day: ["day_metrics", "day_intent", "day_vouchers"],
    week: ["week_metrics", "week_intent", "week_vouchers"],
    month: ["month_metrics", "month_intent", "month_vouchers"],
  };
  const out = {};
  for (const g of Object.keys(grains)) {
    const [mk, ik, vk] = grains[g];
    if (!R[mk]) continue;
    const data = {}, periodsSet = new Set();
    for (const row of R[mk]) {
      const p = row.period; if (!p) continue;            // skip ROLLUP grand-total
      periodsSet.add(p);
      const a = row.agent_type || "Total";               // '' rollup -> Total
      (data[p] = data[p] || {})[a] = row;
    }
    // Voucher claims — Service Outbound-only outcome (dealer_leads.voucher isn't
    // in the base_fact spine, queried separately). Merge onto the existing
    // Service Outbound row for the period, or synthesize one if that period had
    // no other Service Outbound activity, so claims are never silently dropped.
    for (const row of R[vk] || []) {
      const p = row.period; if (!p) continue;
      periodsSet.add(p);
      const bucket = (data[p] = data[p] || {});
      const existing = bucket["Service Outbound"];
      if (existing) existing.voucher_claims = row.voucher_claims;
      else bucket["Service Outbound"] = { period: p, agent_type: "Service Outbound", voucher_claims: row.voucher_claims };
    }
    for (const p of Object.keys(data)) {
      if (!data[p]["Service Outbound"]) continue;
      if (data[p]["Service Outbound"].voucher_claims === undefined) data[p]["Service Outbound"].voucher_claims = 0;
    }
    const intent = {}, totals = {};
    for (const row of R[ik]) {
      const p = row.period; if (!p) continue;
      const a = row.agent_type || "Total";
      (intent[p] = intent[p] || {});
      (intent[p][a] = intent[p][a] || []).push([row.primary_intent, row.calls]);
      (totals[p] = totals[p] || {});
      totals[p][row.primary_intent] = (totals[p][row.primary_intent] || 0) + row.calls;
    }
    for (const p of Object.keys(intent)) {
      intent[p].Total = Object.entries(totals[p] || {}).map(([k, v]) => [k, v]).sort((x, y) => y[1] - x[1]);
      for (const a of Object.keys(intent[p])) intent[p][a].sort((x, y) => y[1] - x[1]);
    }
    out[g] = { periods: [...periodsSet].sort().reverse(), data, intent };
  }
  return out;
}

// Runs all 6 aggregations in parallel and returns { bundle, meta }. Throws on
// any ClickHouse error so the route can surface it as a 500.
export async function runAgentMetrics() {
  const parts = Object.keys(QUERIES);
  const R = {};
  await Promise.all(parts.map(async (p) => { R[p] = await runClickhouse(QUERIES[p]); }));
  const today = new Date().toISOString().slice(0, 10);
  return {
    bundle: assemble(R),
    meta: {
      generated: today,
      windows: { day: "last 45 days", week: "last 12 weeks", month: "last 6 months" },
      source: "live ClickHouse query",
    },
  };
}

// ── Partial refreshes (cheaper than the full 6-query bundle above) ──────────
// Originally this narrowed day_metrics/day_intent's -45d floor down to a
// couple of days via a string patch (all 4 occurrences of the -45d literal
// looked identical, so it seemed safe to replace uniformly). A live
// full-vs-incremental cross-check against prod ClickHouse proved that wrong:
// one of those "identical" occurrences floors a LEAD-level buying-intent
// lookback (dealer_leads.actionItems, gating `qualified`) that must stay wide
// regardless of the caller's window — a lead can be qualified by an action
// item logged well before the narrow window, so narrowing it silently
// undercounted `leads_qualified` (verified: off by ~7-25% on a closed day).
// Two textually-identical SQL literals were NOT semantically interchangeable.
// Since day_metrics/day_intent are Metabase-auto-synced blobs (not something
// we can safely open-heart-surgery per-occurrence the way agentBaseFact.sql's
// single named CTE could be fixed at the source), the safe fix here is to NOT
// narrow the floor at all — just run these 3 UNCHANGED, full 45-day queries
// on their own (fast) cadence, decoupled from week/month below. Cheaper than
// running all 6 every tick, with none of the narrowing risk.
const DAY_QUERIES = ["day_metrics", "day_intent", "day_vouchers"];
const WEEK_MONTH_QUERIES = ["week_metrics", "week_intent", "week_vouchers", "month_metrics", "month_intent", "month_vouchers"];

// Caller merges the returned `day` periods into the cached bundle — older
// cached days (and the week/month grains) are left untouched.
export async function runAgentMetricsIncremental() {
  const R = {};
  await Promise.all(DAY_QUERIES.map(async (k) => { R[k] = await runClickhouse(QUERIES[k]); }));
  return { day: assemble(R).day };
}

// Full week/month queries (unmodified — see the narrowing note above), no day
// grain. Caller replaces the cached week/month grains wholesale.
export async function runAgentMetricsWeekMonth() {
  const R = {};
  await Promise.all(WEEK_MONTH_QUERIES.map(async (k) => { R[k] = await runClickhouse(QUERIES[k]); }));
  const out = assemble(R);
  return { week: out.week, month: out.month };
}
