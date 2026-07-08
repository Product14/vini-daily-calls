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
 *   node server/roi-cron/backfillActionItems.cjs                 # dry-run, all daily runs
 *   node server/roi-cron/backfillActionItems.cjs --commit        # write
 *   node server/roi-cron/backfillActionItems.cjs --team=3d3deabc98 --since=2026-06-01 --commit
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
const argVal = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : undefined; };
const ONLY_TEAM = argVal("team");
const SINCE = argVal("since"); // YYYY-MM-DD inclusive
const CONCURRENCY = Math.max(1, Math.min(12, Number(argVal("concurrency")) || 6));

if (!SB_URL || !SB_KEY) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

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
  console.log(`[backfill] ${COMMIT ? "COMMIT" : "DRY-RUN"} · base=${REPORTING_API_BASE}${ONLY_TEAM ? ` · team=${ONLY_TEAM}` : ""}${SINCE ? ` · since=${SINCE}` : ""}`);
  const runs = await loadDailyRuns();
  console.log(`[backfill] ${runs.length} daily runs with metrics`);

  let changed = 0, unchanged = 0, errors = 0, written = 0;
  const changes = [];
  await pool(runs, async (r) => {
    let fresh;
    try { fresh = await recompute(r.team_id, r.department, r.local_date); }
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
