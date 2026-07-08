#!/usr/bin/env node
/* One-off backfill — recompute stored action-item metrics on historical digest runs.
 *
 * WHY: the daily digest used to source "action items" from ib.report.intent (inbound
 * conversation-intent), which under-counted real CRM action items 3-5x and read 0 on
 * quiet-inbound days. runner.cjs now reads the real actionItems table via
 * /api/action-items?scope=created. Past roi_digest_runs.metrics still hold the old
 * (wrong) actionItemsTotal + actionItems, so the tracker's HISTORY stays wrong until
 * we recompute. This does that, in place, preserving every other metric key.
 *
 * Scope: cadence='daily' only — its window is deterministic ([local_date, local_date+1)).
 * Weekly/monthly runs use different windows and are left untouched (logged).
 *
 * SAFETY: dry-run by default (prints the diff, writes nothing). Pass --commit to write.
 * Rows whose recompute FAILS (API error) are skipped, never zeroed — a good historical
 * value is never overwritten by a transient fetch failure.
 *
 * PREREQ: reporting-vini scope=created must be deployed (or point REPORTING_API_BASE at a
 * local dev server), else the endpoint degrades to scope=recent and produces wrong numbers.
 *
 *   node server/roi-cron/backfillActionItems.cjs                 # dry-run, all daily runs (API)
 *   node server/roi-cron/backfillActionItems.cjs --commit        # write (API)
 *   node server/roi-cron/backfillActionItems.cjs --team=3d3deabc98 --since=2026-06-01 --commit
 *
 * --direct : compute from ClickHouse in ONE aggregation instead of one API call per run.
 *   Mirrors the /api/action-items?scope=created WHERE exactly (created-in-window, is_active,
 *   non-deleted, non-blank intent, dept prefix, raw count) — validated to match the endpoint.
 *   Far faster + more reliable for the full-fleet backfill, and needs no reporting-vini deploy.
 *   Requires CLICKHOUSE_* env (host/port/user/password).
 *
 *   node server/roi-cron/backfillActionItems.cjs --direct            # dry-run, all (fast)
 *   node server/roi-cron/backfillActionItems.cjs --direct --commit   # write
 */
"use strict";
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const REPORTING_API_BASE = process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app";
const REPORTING_AUTH = process.env.REPORTING_CRON_SECRET || process.env.CRON_SECRET || process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const DIRECT = args.includes("--direct");
const argVal = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : undefined; };
const ONLY_TEAM = argVal("team");
const SINCE = argVal("since"); // YYYY-MM-DD inclusive
const CONCURRENCY = Math.max(1, Math.min(12, Number(argVal("concurrency")) || 6));

if (!SB_URL || !SB_KEY) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ClickHouse HTTP (--direct only)
const CH_HOST = process.env.CLICKHOUSE_HOST, CH_PORT = process.env.CLICKHOUSE_PORT || "8443";
const CH_USER = process.env.CLICKHOUSE_USER, CH_PASS = process.env.CLICKHOUSE_PASSWORD;
async function chQuery(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=TabSeparatedWithNames`, {
    method: "POST", headers: { "X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS }, body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 200)}`);
  const lines = text.trimEnd().split("\n");
  const cols = lines.shift().split("\t");
  return lines.filter(Boolean).map((ln) => { const v = ln.split("\t"); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
}
const chEsc = (s) => String(s).replace(/'/g, "''");

const nextDay = (d) => { const [y, m, day] = d.split("-").map(Number); const nd = new Date(Date.UTC(y, m - 1, day + 1)); return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`; };

// Recompute action items for one (team, dept, day) window — identical logic to runner.cjs apiActionItems.
const _cache = new Map();
async function recompute(teamId, dept, localDate) {
  const key = `${teamId}|${dept}|${localDate}`;
  if (_cache.has(key)) return _cache.get(key);
  const svc = dept === "service" ? "service" : "sales";
  const url = `${REPORTING_API_BASE}/api/action-items?team_id=${encodeURIComponent(teamId)}&serviceType=${svc}&scope=created&start=${localDate}&end=${nextDay(localDate)}&limit=200`;
  const res = await fetch(url, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {} });
  if (!res.ok) throw new Error(`action-items ${res.status} (${teamId} ${localDate})`);
  const j = await res.json();
  if (j && j.degraded) throw new Error(`action-items degraded (${teamId})`);
  if (j && j.scope !== "created") throw new Error(`scope degraded to '${j.scope}' — is reporting-vini deployed with scope=created?`);
  const byIntent = new Map();
  for (const it of j.actionItems || []) { const k = (it.intent || "").trim(); if (!k) continue; byIntent.set(k, (byIntent.get(k) || 0) + 1); }
  const items = [...byIntent.entries()].map(([intent, count]) => ({ intent, count })).sort((a, b) => b.count - a.count);
  const out = { total: items.reduce((s, i) => s + i.count, 0), items };
  _cache.set(key, out);
  return out;
}

async function loadDailyRuns() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from("roi_digest_runs").select("id,team_id,department,local_date,status,metrics").eq("cadence", "daily").not("metrics", "is", null).order("local_date", { ascending: true }).range(from, from + PAGE - 1);
    if (ONLY_TEAM) q = q.eq("team_id", ONLY_TEAM);
    if (SINCE) q = q.gte("local_date", SINCE);
    const { data, error } = await q;
    if (error) throw new Error(`supabase read: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

// --direct: one ClickHouse aggregation over the full run window → Map `team|dept|day` → {total,items}.
// WHERE mirrors /api/action-items?scope=created exactly (created-in-window, active, non-deleted,
// non-blank intent, dept prefix, raw count) so results match the endpoint / the live runner path.
async function computeDirect(runs) {
  const teams = [...new Set(runs.map((r) => r.team_id))];
  const dates = runs.map((r) => r.local_date).sort();
  const minD = dates[0], maxD = dates[dates.length - 1];
  const teamIn = teams.map((t) => `'${chEsc(t)}'`).join(",");
  const sql =
    `SELECT team_id,` +
    ` multiIf(lower(ifNull(service_type,'')) LIKE 'service%','service', lower(ifNull(service_type,'')) LIKE 'sales%','sales','other') AS dept,` +
    ` toString(toDate(createdAt)) AS day, ifNull(intent,'') AS intent, count() AS cnt` +
    ` FROM dealer_leads.actionItems` +
    ` WHERE ifNull(is_active,1)=1 AND __deleted=0 AND ifNull(intent,'')!=''` +
    ` AND (lower(ifNull(service_type,'')) LIKE 'sales%' OR lower(ifNull(service_type,'')) LIKE 'service%')` +
    ` AND team_id IN (${teamIn})` +
    ` AND createdAt >= toDateTime('${chEsc(minD)} 00:00:00') AND createdAt < toDateTime('${chEsc(nextDay(maxD))} 00:00:00')` +
    ` GROUP BY team_id, dept, day, intent`;
  const rows = await chQuery(sql);
  // team|dept|day → { intent → count }
  const buckets = new Map();
  for (const r of rows) {
    if (r.dept === "other") continue;
    const key = `${r.team_id}|${r.dept}|${r.day}`;
    let b = buckets.get(key); if (!b) { b = new Map(); buckets.set(key, b); }
    b.set(r.intent, (b.get(r.intent) || 0) + (Number(r.cnt) || 0));
  }
  const out = new Map();
  for (const [key, b] of buckets) {
    const items = [...b.entries()].map(([intent, count]) => ({ intent, count })).sort((a, b2) => b2.count - a.count);
    out.set(key, { total: items.reduce((s, i) => s + i.count, 0), items });
  }
  return out;
}

// Small concurrency pool.
async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; results[idx] = await worker(items[idx], idx); }
  }));
  return results;
}

const sameItems = (a, b) => { a = a || []; b = b || []; if (a.length !== b.length) return false; const norm = (x) => x.slice().map((it) => `${it.intent}=${it.count}`).sort().join(","); return norm(a) === norm(b); };

(async () => {
  console.log(`[backfill] ${COMMIT ? "COMMIT" : "DRY-RUN"} · ${DIRECT ? "direct=clickhouse" : `base=${REPORTING_API_BASE}`}${ONLY_TEAM ? ` · team=${ONLY_TEAM}` : ""}${SINCE ? ` · since=${SINCE}` : ""}`);
  const runs = await loadDailyRuns();
  console.log(`[backfill] ${runs.length} daily runs with metrics`);
  if (!runs.length) { console.log("[backfill] nothing to do"); process.exit(0); }

  // --direct precomputes every (team,dept,day) in one ClickHouse query.
  const directMap = DIRECT ? await computeDirect(runs) : null;
  if (DIRECT) console.log(`[backfill] clickhouse returned ${directMap.size} (team,dept,day) buckets`);

  let changed = 0, unchanged = 0, errors = 0, written = 0;
  const changes = [];
  await pool(runs, async (r) => {
    let fresh;
    try {
      fresh = DIRECT
        ? (directMap.get(`${r.team_id}|${r.department}|${r.local_date}`) || { total: 0, items: [] })
        : await recompute(r.team_id, r.department, r.local_date);
    }
    catch (e) { errors++; console.warn(`  ! skip ${r.team_id} ${r.department} ${r.local_date}: ${String(e.message).slice(0, 100)}`); return; }
    const oldTotal = Number(r.metrics.actionItemsTotal) || 0;
    if (oldTotal === fresh.total && sameItems(r.metrics.actionItems, fresh.items)) { unchanged++; return; }
    changed++;
    changes.push({ id: r.id, team: r.team_id, dept: r.department, date: r.local_date, old: oldTotal, new: fresh.total });
    if (COMMIT) {
      const metrics = { ...r.metrics, actionItemsTotal: fresh.total, actionItems: fresh.items };
      const { error } = await sb.from("roi_digest_runs").update({ metrics }).eq("id", r.id);
      if (error) { errors++; console.warn(`  ! write failed ${r.id}: ${error.message}`); return; }
      written++;
    }
  });

  changes.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40).forEach((c) => console.log(`  ${COMMIT ? "✎" : "·"} ${c.date} ${c.team} ${c.dept.padEnd(7)} ${c.old} → ${c.new}`));
  if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
  console.log(`[backfill] changed=${changed} unchanged=${unchanged} errors=${errors}${COMMIT ? ` written=${written}` : " (dry-run — pass --commit to write)"}`);
  process.exit(errors && !changed ? 1 : 0);
})();
