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

const require = createRequire(import.meta.url);
// Inbound callbacks driven by an outbound touch are re-attributed to the
// Outbound agent so the Overall view reconciles with the Rooftop view.
const QUERIES_RAW = require("./agentMetricsQueries.json");
// Voucher queries are plain team_id/period scans against dealer_leads.voucher —
// no conversation-spine callback/direction logic to patch, so they're exempt
// from the anchor-based rewrite (which throws when its CTE/JOIN/DIR anchors
// are absent from the SQL).
const QUERIES = Object.fromEntries(
  Object.entries(QUERIES_RAW).map(([k, sql]) =>
    [k, k.endsWith("_vouchers") ? sql : applyCallbackOutboundAttribution(sql, k)])
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
// The day/week/month queries each carry their own conversation-spine floor
// (day -45d, week -84d, month ~-5mo, see agentMetricsQueries.json) baked into
// Metabase-synced SQL. day_metrics/day_intent/day_vouchers use that -45d floor
// EXACTLY ONCE per occurrence with no other meaning mixed in (verified: 4, 4,
// and 1 occurrences respectively, all identical) — safe to narrow. week_* and
// month_* mix their grain floor with an unrelated sub-scan's floor at a
// DIFFERENT value (week_metrics: three -84d + one -45d; month_metrics: three
// -5mo + one -45d) — a blind narrow there risks shrinking the wrong sub-scan,
// so those two grains are only ever refreshed via the full, unmodified query
// (see runAgentMetricsWeekMonth below).
const DAY_FLOOR = "addDays(today(), -45)";
const DAY_QUERIES = ["day_metrics", "day_intent", "day_vouchers"];
const DAY_FLOOR_OCCURRENCES = { day_metrics: 4, day_intent: 4, day_vouchers: 1 };
const WEEK_MONTH_QUERIES = ["week_metrics", "week_intent", "week_vouchers", "month_metrics", "month_intent", "month_vouchers"];

function narrowDayFloor(sql, key, days) {
  const count = sql.split(DAY_FLOOR).length - 1;
  if (count !== DAY_FLOOR_OCCURRENCES[key]) {
    throw new Error(`[agentMetrics] ${key}: expected ${DAY_FLOOR_OCCURRENCES[key]} occurrences of "${DAY_FLOOR}", found ${count} — upstream SQL changed (re-synced from Metabase?), review before narrowing`);
  }
  return sql.split(DAY_FLOOR).join(`addDays(today(), -${days})`);
}

const METRICS_INCREMENTAL_WINDOW_DAYS = Number(process.env.METRICS_INCREMENTAL_WINDOW_DAYS) || 2;

// Cheap: only the day grain, floored to a couple of days instead of 45. Caller
// merges the returned `day` periods into the cached bundle — older cached days
// (and the week/month grains) are left untouched.
export async function runAgentMetricsIncremental() {
  const R = {};
  await Promise.all(DAY_QUERIES.map(async (k) => {
    R[k] = await runClickhouse(narrowDayFloor(QUERIES[k], k, METRICS_INCREMENTAL_WINDOW_DAYS));
  }));
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
