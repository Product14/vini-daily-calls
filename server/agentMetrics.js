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
const QUERIES = Object.fromEntries(
  Object.entries(QUERIES_RAW).map(([k, sql]) => [k, applyCallbackOutboundAttribution(sql, k)])
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
function assemble(R) {
  const grains = {
    day: ["day_metrics", "day_intent"],
    week: ["week_metrics", "week_intent"],
    month: ["month_metrics", "month_intent"],
  };
  const out = {};
  for (const g of Object.keys(grains)) {
    const [mk, ik] = grains[g];
    const data = {}, periodsSet = new Set();
    for (const row of R[mk]) {
      const p = row.period; if (!p) continue;            // skip ROLLUP grand-total
      periodsSet.add(p);
      const a = row.agent_type || "Total";               // '' rollup -> Total
      (data[p] = data[p] || {})[a] = row;
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
