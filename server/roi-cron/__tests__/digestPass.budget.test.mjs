/* The hourly digest passes must finish, and must not spend the hour re-fetching numbers they don't need.
 *
 * Regression guard for 2026-10-08: /api/cron/roi-email returned 504 (killed at Vercel's 300s) on every
 * hourly run. The daily pass fetched /api/reports (7-34s a call, up to 5 calls a department) for every
 * live department every hour, BEFORE checking whether it was even due, and the weekly/monthly passes
 * ran only after it in the same function. So:
 *   · the 2026-10-01 monthly never left "scheduled" (41 rows, 0 sent) and the 2026-10-05 weekly wrote nothing;
 *   · 130 daily-enabled departments got no daily row at all for 2026-10-07 (38 of them live senders),
 *     because the pass walked the same rows in the same order and died before the tail;
 *   · everything after the pool (heartbeat, verification + deliverability audits) never ran.
 *
 * Fully offline: fake Supabase via require.cache, fetch routed to fakes, DRY_RUN on.
 * Run: node --test server/roi-cron/__tests__/digestPass.budget.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RUNNER = require.resolve("../runner.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [RUNNER] });
const TZ = "America/New_York";

// Dealer-local clock, the same way the runner reads it.
function localNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return { Y: g("year"), M: g("month"), D: g("day"), H: g("hour") === 24 ? 0 : g("hour") };
}
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const L = localNow();
const YESTERDAY = iso(L.Y, L.M, L.D - 1);   // daily local_date
const PREV_MONTH_1ST = iso(L.Y, L.M - 1, 1); // monthly local_date (cron)
const BEFORE_SEND = { digest_send_hour: L.H + 1, digest_send_minute: 0 }; // send time still ahead
const AFTER_SEND = { digest_send_hour: 0, digest_send_minute: 0 };        // send time passed

// ── fake Supabase: in-memory tables, enough of the query builder for the runner ──
function fakeSupabase(db, log) {
  const key = (r) => `${r.team_id}|${r.department}|${r.cadence}|${r.local_date}`;
  let seq = 0;
  return {
    createClient: () => ({
      from(table) {
        const q = { table, op: "select", f: [], single: false };
        const b = {
          select() { return b; },
          eq(k, v) { q.f.push((r) => r[k] === v); return b; },
          neq(k, v) { q.f.push((r) => r[k] !== v); return b; },
          in(k, vs) { q.f.push((r) => vs.includes(r[k])); return b; },
          is(k, v) { q.f.push((r) => (r[k] ?? null) === v); return b; },
          gte(k, v) { q.f.push((r) => r[k] >= v); return b; },
          lte(k, v) { q.f.push((r) => r[k] <= v); return b; },
          lt(k, v) { q.f.push((r) => r[k] < v); return b; },
          not() { return b; }, filter() { return b; }, ilike() { return b; }, or() { return b; },
          order() { return b; }, limit() { return b; }, range() { return b; },
          maybeSingle() { q.single = true; return b; }, single() { q.single = true; return b; },
          upsert(row) { q.op = "upsert"; q.row = row; return b; },
          update(patch) { q.op = "update"; q.patch = patch; return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          delete() { q.op = "delete"; return b; },
          then(res, rej) {
            log.sb.push({ table, op: q.op });
            const rows = db[table] || [];
            let data;
            if (q.op === "upsert" && table === "roi_digest_runs") {
              const k = key(q.row);
              const i = rows.findIndex((r) => key(r) === k);
              if (i >= 0) rows[i] = { ...rows[i], ...q.row }; else rows.push({ id: `run-${++seq}`, message_id: null, ...q.row });
              log.writes.push({ ...q.row });
              data = [{ id: rows.find((r) => key(r) === k).id }];
            } else if (q.op === "update") {
              const hit = rows.filter((r) => q.f.every((fn) => fn(r)));
              for (const r of hit) Object.assign(r, q.patch);
              data = hit.map((r) => ({ id: r.id }));
            } else if (q.op === "insert") {
              data = [{ id: `ins-${++seq}` }];
            } else {
              data = rows.filter((r) => q.f.every((fn) => fn(r)));
              if (q.single) data = data[0] ?? null;
            }
            return Promise.resolve({ data, error: null }).then(res, rej);
          },
        };
        return b;
      },
    }),
  };
}

// fetch router: /api/reports is slow (delayMs) and reports activity so the guardrail passes.
// `failReports` 504s that many /api/reports calls first, like reporting-vini did from 2026-09-30.
function installFetch(log, { delayMs = 0, failReports = 0 } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("http://rv.test")) {
      const p = new URL(u);
      log.api.push(p.pathname + p.search);
      if (p.pathname === "/api/reports") {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (failReports > 0) { failReports--; return new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 }); }
        const agent = (name) => ({ name, metrics: { calls: 12, smsSent: 3, appointments: 2 }, channelSplit: { voice: 12 }, report: { summary: {} } });
        return json({ agents: [agent("Service Inbound"), agent("Service Outbound"), agent("Sales Inbound"), agent("Sales Outbound")] });
      }
      if (p.pathname === "/api/sync-health") return json({ ok: false }, 503); // unknown → fail-open
      return json({ actionItems: [], total: 0, overdue: 0, completed: 0 });
    }
    log.other.push(u);
    return json({ ok: true });
  };
}

function load({ teams, cfg = {}, runs = [], env = {} }) {
  Object.assign(process.env, {
    ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", REPORTING_API_BASE: "http://rv.test",
    CLICKHOUSE_HOST: "", CLICKHOUSE_PASSWORD: "", SPYNE_API_BASE: "http://spyne.test", MAIL_PROXY_URL: "http://mail.test/send",
    DRY_RUN: "true", SMS_DRY_RUN: "true", SLACK_BOT_TOKEN: "", DIGEST_SPYNE_TOKEN: "", SPYNE_API_TOKEN: "",
    CRON_POOL: "1", DIGEST_PASS_BUDGET_MS: "200000",
  }, env);
  const db = {
    roi_live_departments: teams.map((t) => ({ team_id: t, department: "service", dry_run: true, is_live: true })),
    roi_rooftop_config: teams.map((t) => ({
      team_id: t, enterprise_id: "ent", rooftop_name: `Rooftop ${t}`, timezone: TZ, daily_enabled: true,
      weekly_enabled: true, monthly_enabled: true, weekly_send_dow: 99, monthly_send_day: L.D, lifecycle_status: "live", churn_date: null,
      ...BEFORE_SEND, ...cfg,
    })),
    roi_recipients: teams.map((t) => ({ team_id: t, email: `gm@${t}.example.com`, receives_sales: true, receives_service: true, email_enabled: true, verified_at: "2026-01-01", subscriptions: null })),
    roi_digest_runs: runs.map((r, i) => ({ id: `seed-${i}`, message_id: null, ...r })),
  };
  const log = { sb: [], api: [], other: [], writes: [] };
  delete require.cache[RUNNER];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(db, log) };
  return { runner: require(RUNNER), db, log };
}
const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const reportsFor = (log) => log.api.filter((p) => p.startsWith("/api/reports")).map((p) => new URL("http://x" + p).searchParams.get("team_id"));

// ── weekly / monthly ──────────────────────────────────────────────────────────
test("monthly send day, before the send time: the row is scheduled without fetching any numbers", async () => {
  const { runner, db, log } = load({ teams: ["t1", "t2"] });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(reportsFor(log).length, 0, "no /api/reports call before the send time");
  assert.equal(out.before_hour, 2);
  const rows = db.roi_digest_runs.filter((r) => r.cadence === "monthly");
  assert.deepEqual(rows.map((r) => [r.local_date, r.status]), [[PREV_MONTH_1ST, "scheduled"], [PREV_MONTH_1ST, "scheduled"]]);
  assert.deepEqual(rows[0].recipients, [{ email: "gm@t1.example.com", received: false }]);
});

test("monthly send day, after the send time: a scheduled row is picked up and processed", async () => {
  const { runner, db, log } = load({ teams: ["t1"], cfg: AFTER_SEND,
    runs: [{ team_id: "t1", department: "service", cadence: "monthly", local_date: PREV_MONTH_1ST, status: "scheduled", reason: "before_send_hour" }] });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.ok(reportsFor(log).length > 0);
  assert.equal(out.suppressed, 1, "dry-run rooftop → generated and held");
  assert.equal(db.roi_digest_runs[0].status, "suppressed");
});

test("a run already claimed by a sender ('sending') is skipped without fetching", async () => {
  const { runner, log } = load({ teams: ["t1"], cfg: AFTER_SEND,
    runs: [{ team_id: "t1", department: "service", cadence: "monthly", local_date: PREV_MONTH_1ST, status: "sending", message_id: "cron-lock" }] });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(reportsFor(log).length, 0);
  assert.equal(out.already_sent, 1);
});

test("cadence pass stops launching rooftops at its budget and says how many it didn't reach", async () => {
  const { runner, log } = load({ teams: ["t1", "t2", "t3", "t4"], cfg: AFTER_SEND, env: { DIGEST_PASS_BUDGET_MS: "60" } });
  installFetch(log, { delayMs: 40 });
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.ok(out.unreached >= 1, `unreached=${out.unreached}`);
  assert.equal(out.unreached + out.suppressed + out.errors, 4);
});

// ── daily ─────────────────────────────────────────────────────────────────────
test("daily, before the send time: a department already scheduled today is not re-fetched", async () => {
  const { runner, log } = load({ teams: ["t1"],
    runs: [{ team_id: "t1", department: "service", cadence: "daily", local_date: YESTERDAY, status: "scheduled", reason: "before_send_hour" }] });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(reportsFor(log).length, 0);
  assert.equal(out.before_hour, 1);
});

test("daily, before the send time: the FIRST visit still fetches once (the tracker previews it)", async () => {
  const { runner, db, log } = load({ teams: ["t1"] });
  installFetch(log);
  await quiet(() => runner.runOnce());
  assert.ok(reportsFor(log).length > 0);
  assert.equal(db.roi_digest_runs[0].status, "scheduled");
  assert.ok(db.roi_digest_runs[0].metrics, "scheduled row carries metrics for the preview");
});

test("daily pass stops at its budget, reports unreached, and still runs its end-of-pass work", async () => {
  const { runner, log } = load({ teams: ["t1", "t2", "t3", "t4"], cfg: AFTER_SEND, env: { DIGEST_PASS_BUDGET_MS: "60" } });
  installFetch(log, { delayMs: 40 });
  const out = await quiet(() => runner.runOnce());
  assert.ok(out.unreached >= 1, `unreached=${out.unreached}`);
  assert.ok(log.sb.some((x) => x.table === "roi_recipients" && x.op === "select"), "pass reached its tail");
});

test("a reporting-api 504 is retried by the next pass on the same warm instance, not replayed from cache", async () => {
  const { runner, db, log } = load({ teams: ["t1"], cfg: AFTER_SEND });
  installFetch(log, { failReports: 1 });
  await quiet(() => runner.runOnce());
  assert.equal(db.roi_digest_runs[0].status, "error");
  const before = reportsFor(log).length;
  await quiet(() => runner.runOnce()); // next hourly pass, same module instance
  assert.ok(reportsFor(log).length > before, "the second pass asked reporting-api again");
  assert.equal(db.roi_digest_runs[0].status, "suppressed");
});

test("daily pass visits departments with no row today before re-checking ones already decided", async () => {
  // t1 was already evaluated today (not_sent / no_data); t2 has never been visited today. With room for
  // one department, the never-visited one must win, or the same head rows eat every hourly budget.
  const { runner, log } = load({ teams: ["t1", "t2"], cfg: AFTER_SEND, env: { DIGEST_PASS_BUDGET_MS: "1" },
    runs: [{ team_id: "t1", department: "service", cadence: "daily", local_date: YESTERDAY, status: "not_sent", reason: "no_data" }] });
  installFetch(log, { delayMs: 20 });
  await quiet(() => runner.runOnce());
  assert.equal(reportsFor(log)[0], "t2");
});
