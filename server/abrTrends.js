// ABR Trends precompute — the /abr-trends dashboard's data path.
//
// Mirrors the agent-dashboard pattern exactly (server/agentRooftop.js +
// server/agentCache.js): a cron precomputes one JSON bundle into Postgres, and the
// route serves it. Never query ClickHouse on a page load — these scans are heavy and
// Vercel's scale-to-zero would make the first visitor after an idle period wait on a
// cold lambda plus a multi-second ClickHouse scan.
//
// The bundle is deliberately PRE-AGGREGATED and PRE-ALIGNED: every series is an array
// positionally matched to per[grain], so the client does no joining or bucketing. That
// is what keeps it ~150 KB for 3 grains x 3 channels x 9 agent buckets.
//
// Rollup members: every row is emitted under its real value AND under 'all', for both
// channel and agent bucket, via arrayJoin in SQL. That makes the 'all' slices correct
// DISTINCT-lead counts rather than sums — 25.5% of leads are touched on both channels
// in a month, so summing SMS + calls would double-count them. Consequence for any
// consumer: never sum across channel, bucket or grain.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClickhouse, hasClickhouseCreds } from "./agentMetrics.js";
import { writeAgentCache, readAgentCache, hasCacheDb } from "./agentCache.js";

const here = dirname(fileURLToPath(import.meta.url));

export const ABR_CACHE_KEY = "abr-trends";

// Window: 90 days back covers ~13 weeks and 4 months, enough for the weekly and monthly
// grains to show a trend. The daily grain is trimmed to DAYS below — a 90-column daily
// matrix is unreadable, and the extra days cost payload for nothing.
const WINDOW_DAYS = 90;
const DAYS = 28;

const BASE = readFileSync(join(here, "abrTrendsBase.sql"), "utf8");

// date_to_excl is exclusive and set to tomorrow so today's partial data is included.
// The UI marks trailing partial periods explicitly rather than hiding them.
const baseSql = () =>
  BASE.replaceAll("{START}", `toDate(addDays(today(), -${WINDOW_DAYS}))`)
      .replaceAll("{END}", `toDate(addDays(today(), 1))`);

// ── The three grains are produced in ONE pass per query via arrayJoin, rather than
// three separate scans. Keeps the ClickHouse cost to two scans total.
const GRAINS = `ARRAY JOIN [('d',toDate(ts)),('w',toStartOfWeek(ts,1)),('m',toStartOfMonth(ts))] AS g`;

const FUNNEL_SQL = () => `${baseSql()}
, fx AS (
  SELECT g.1 AS grain, g.2 AS period,
    arrayJoin([channel,'all']) AS ch,
    arrayJoin([concat(svc,'_',dir),'all']) AS bucket,
    lead_id, reached, engaged, booked, qualified, any_tool, depth_num
  FROM conv ${GRAINS})
SELECT grain AS g, toString(period) AS p, ch, bucket AS b,
  uniqExact(lead_id) AS att,
  uniqExactIf(lead_id, reached=1) AS rch,
  uniqExactIf(lead_id, engaged=1) AS eng,
  uniqExactIf(lead_id, qualified=1) AS qual,
  uniqExactIf(lead_id, any_tool=1) AS tool,
  uniqExactIf(lead_id, booked=1) AS bkd,
  round(sumIf(depth_num, engaged=1), 1) AS dnum
FROM fx GROUP BY g, p, ch, b`;

// Action items and tool calls, both enumerated rather than allowlisted, so a newly
// added intent or tool appears on its own row with no code change here.
const ITEMS_SQL = () => `${baseSql()}
, ai AS (
  SELECT JSONExtractString(assumeNotNull(meta),'conversationId') AS cid, intent
  FROM dealer_leads.actionItems FINAL
  WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
    AND ifNull(intent,'') != ''),
tl AS (
  SELECT conversationId AS cid,
    JSONExtractString(JSONExtractRaw(arrayJoin(arrayConcat(
      arrayFlatten(arrayMap(a->JSONExtractArrayRaw(a,'toolCalls'), JSONExtractArrayRaw(assumeNotNull(messages)))),
      arrayFlatten(arrayMap(a->JSONExtractArrayRaw(a,'tool_calls'), JSONExtractArrayRaw(assumeNotNull(messages))))
    )),'function'),'name') AS tool
  FROM dealer_leads.smsChatCompletions FINAL
  WHERE __deleted=0 AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 7
    AND (position(assumeNotNull(messages),'toolCalls')>0 OR position(assumeNotNull(messages),'tool_calls')>0)),
tc AS (
  SELECT callId AS cid,
    JSONExtractString(JSONExtractRaw(arrayJoin(arrayFlatten(arrayMap(
      a->JSONExtractArrayRaw(a,'toolCalls'), JSONExtractArrayRaw(assumeNotNull(callDetails_messages))))),'function'),'name') AS tool
  FROM dealer_leads.endcallreports FINAL
  WHERE __deleted=0 AND isTestCall=false
    AND JSONExtractString(ifNull(report,'{}'),'spam')='No'
    AND callDetails_callType IN ('webCall','inboundPhoneCall','outboundPhoneCall')
    AND toDate(createdAt) >= date_from - 1 AND toDate(createdAt) < date_to_excl + 1
    AND position(assumeNotNull(callDetails_messages),'toolCalls')>0),
ev AS (
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 'a' AS fam, ai.intent AS item
  FROM conv v INNER JOIN ai ON ai.cid = v.conv_id
  UNION ALL
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 't' AS fam, tl.tool AS item
  FROM conv v INNER JOIN tl ON tl.cid = v.conv_id WHERE v.channel='sms' AND tl.tool != ''
  UNION ALL
  -- calls join on callId, NOT conversationId — endcallreports is keyed on callId, which
  -- is what tool_key carries through the spine.
  SELECT v.ts, v.lead_id, v.channel, v.svc, v.dir, 't' AS fam, tc.tool AS item
  FROM conv v INNER JOIN tc ON tc.cid = v.tool_key WHERE v.channel='call' AND tc.tool != ''),
ex AS (SELECT g.1 AS grain, g.2 AS period, arrayJoin([channel,'all']) AS ch,
         arrayJoin([concat(svc,'_',dir),'all']) AS bucket, fam, item, lead_id
       FROM ev ${GRAINS})
SELECT grain AS g, toString(period) AS p, ch, bucket AS b, fam AS f, item AS i,
       uniqExact(lead_id) AS n
FROM ex GROUP BY g, p, ch, b, f, i`;

const KEYS = ["att", "rch", "eng", "qual", "tool", "bkd", "dnum"];

// A period is partial when it extends past the last fully-loaded day. The UI marks
// these and excludes them from the per-row median that drives the heat colour —
// otherwise the current (short) week reads as a collapse every time you open the page.
function periodEnd(grain, p) {
  const [y, m, d] = p.split("-").map(Number);
  if (grain === "d") return new Date(Date.UTC(y, m - 1, d));
  if (grain === "w") return new Date(Date.UTC(y, m - 1, d + 6));
  return new Date(Date.UTC(y, m, 0));
}

function pack(funnelRows, itemRows) {
  // Yesterday is the last day guaranteed fully loaded; today is still accumulating.
  const dataEnd = new Date(Date.now() - 86400000);
  dataEnd.setUTCHours(0, 0, 0, 0);

  const per = {};
  for (const g of ["d", "w", "m"]) {
    per[g] = [...new Set(funnelRows.filter((r) => r.g === g).map((r) => r.p))].sort();
  }
  per.d = per.d.slice(-DAYS);

  const idx = {};
  for (const g of ["d", "w", "m"]) {
    idx[g] = new Map(per[g].map((p, i) => [p, i]));
  }

  const partial = {};
  for (const g of ["d", "w", "m"]) {
    partial[g] = per[g].map((p) => periodEnd(g, p) > dataEnd);
  }

  const fun = {};
  for (const r of funnelRows) {
    const i = idx[r.g].get(r.p);
    if (i === undefined) continue;
    const k = `${r.g}|${r.ch}|${r.b}`;
    if (!fun[k]) fun[k] = per[r.g].map(() => KEYS.map(() => 0));
    fun[k][i] = KEYS.map((x) => Number(r[x]) || 0);
  }

  const items = {};
  for (const r of itemRows) {
    const i = idx[r.g].get(r.p);
    if (i === undefined) continue;
    const k = `${r.g}|${r.ch}|${r.b}|${r.f}`;
    if (!items[k]) items[k] = {};
    if (!items[k][r.i]) items[k][r.i] = per[r.g].map(() => 0);
    items[k][r.i][i] = Number(r.n) || 0;
  }

  const buckets = [...new Set(funnelRows.map((r) => r.b))].sort();
  const chans = [...new Set(funnelRows.map((r) => r.ch))].sort();

  return { partial, per, buckets, chans, keys: KEYS, fun, items, days: DAYS };
}

let _inflight = null;

export async function refreshAbrTrends() {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse creds not set");
  // Two scans, run together. They share the global ClickHouse concurrency cap inside
  // runClickhouse, so launching both just interleaves them.
  const [funnelRows, itemRows] = await Promise.all([
    runClickhouse(FUNNEL_SQL()),
    runClickhouse(ITEMS_SQL()),
  ]);
  const payload = pack(funnelRows, itemRows);
  const meta = {
    computedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    dailyDays: DAYS,
    periods: { d: payload.per.d.length, w: payload.per.w.length, m: payload.per.m.length },
    channels: payload.chans.length,
    buckets: payload.buckets.length,
    funnelSeries: Object.keys(payload.fun).length,
    itemSeries: Object.keys(payload.items).length,
  };
  payload.meta = meta;
  if (hasCacheDb()) await writeAgentCache(ABR_CACHE_KEY, payload);
  return payload;
}

// Single-flight: several clients hitting a cold cache at once must not each launch a
// ClickHouse scan.
export function refreshAbrTrendsOnce() {
  if (!_inflight) {
    _inflight = refreshAbrTrends().finally(() => {
      _inflight = null;
    });
  }
  return _inflight;
}

export async function getAbrTrends({ force = false } = {}) {
  if (!force && hasCacheDb()) {
    const cached = await readAgentCache(ABR_CACHE_KEY);
    if (cached?.payload?.fun) {
      return { payload: cached.payload, computedAt: cached.computedAt, source: "cache" };
    }
  }
  const payload = await refreshAbrTrendsOnce();
  return { payload, computedAt: payload?.meta?.computedAt ?? null, source: "live" };
}
