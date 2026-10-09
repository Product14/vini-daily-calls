/* The digest crons: catch-up, explicit-period sends, row-level failure isolation, pause rows, the pass
 * trail, the orphan reaper, operator knobs, claim safety, backfill rows and SMS gating.
 * Regression guard for the 2026-10-08 audit (A1 F2/F6/F8/F9/F10/F18, A5-02/06/07/14..18):
 *   · a weekly/monthly period stays due after its send day until it is sent (bounded), and a monthly one
 *     that is never sent says so (missed_send_day) instead of sitting in 'scheduled';
 *   · generateAndSendNow({ localDate }) builds THAT period, respects the cadence toggle, skips a sent
 *     period unless forced, and takes the cron's own claim;
 *   · one malformed timezone fails its row, not the pass; a paused rooftop gets a not_sent/disabled row;
 *   · every pass writes roi_cron_runs (ok:false when it throws); orphaned rows are reaped, never resent;
 *   · FORCE_RESEND / ONLY_TEAMS & co. are ignored by the scheduled cron; a claimed row is never re-queued;
 *   · backfill records not_sent/backfilled, never a fake 'sent'; a digest SMS goes out only with its email.
 *
 * Fully offline: fake Supabase via require.cache, fetch routed to fakes (mail → http://mail.test).
 * Run: node --test server/roi-cron/__tests__/digestCron.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RUNNER = require.resolve("../runner.cjs");
const SEND_SMS = require.resolve("../sendSms.cjs");
const EMAIL_VALUE = require.resolve("../emailValue.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [RUNNER] });
const TZ = "America/New_York";

function localNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return { Y: g("year"), M: g("month"), D: g("day"), H: g("hour") === 24 ? 0 : g("hour") };
}
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const NOW = localNow();
const TODAY = iso(NOW.Y, NOW.M, NOW.D);
const YESTERDAY = iso(NOW.Y, NOW.M, NOW.D - 1);
const TODAY_DOW = new Date(`${TODAY}T00:00:00Z`).getUTCDay();
const daysAgo = (n) => iso(NOW.Y, NOW.M, NOW.D - n);
const AFTER_SEND = { digest_send_hour: 0, digest_send_minute: 0 };

function fakeSupabase(db, log) {
  let seq = 0;
  const runKey = (r) => `${r.team_id}|${r.department}|${r.cadence}|${r.local_date}`;
  const conflictKey = (table, r) => table === "roi_digest_runs" ? runKey(r) : table === "roi_rooftop_config" ? r.team_id : table === "roi_live_departments" ? `${r.team_id}|${r.department}` : null;
  return {
    createClient: () => ({
      from(table) {
        const q = { op: "select", f: [], single: false, opts: {} };
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
          upsert(row, opts) { q.op = "upsert"; q.row = row; q.opts = opts || {}; return b; },
          update(patch) { q.op = "update"; q.patch = patch; return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          delete() { q.op = "delete"; return b; },
          then(res, rej) {
            log.seq.push(`${table}:${q.op}`);
            if (db.__fail && db.__fail[table] && q.op === "select") return Promise.resolve({ data: null, error: { message: db.__fail[table] } }).then(res, rej);
            const rows = db[table] || (db[table] = []);
            let data;
            if (q.op === "upsert") {
              data = [];
              for (const row of Array.isArray(q.row) ? q.row : [q.row]) {
                const k = conflictKey(table, row);
                const hit = k != null ? rows.find((r) => conflictKey(table, r) === k) : null;
                if (hit) { if (!q.opts.ignoreDuplicates) Object.assign(hit, row); }
                else rows.push({ id: `${table}-${++seq}`, ...(table === "roi_digest_runs" ? { message_id: null } : {}), ...row });
                if (table === "roi_digest_runs") log.writes.push({ ...row });
                data.push({ id: (hit || rows[rows.length - 1]).id });
              }
            } else if (q.op === "update") {
              const hit = rows.filter((r) => q.f.every((fn) => fn(r)));
              for (const r of hit) Object.assign(r, q.patch);
              data = hit.map((r) => ({ id: r.id }));
            } else if (q.op === "insert") {
              data = [];
              for (const row of Array.isArray(q.row) ? q.row : [q.row]) { const r = { id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...row }; rows.push(r); data.push({ id: r.id }); }
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

const IDS = { "Sales Inbound": "sales_ib", "Sales Outbound": "sales_ob", "Service Inbound": "service_ib", "Service Outbound": "service_ob" };
function agent(name, o = {}) {
  return {
    id: IDS[name], name,
    metrics: { calls: o.calls ?? 0, smsSent: 0, appointments: o.appts ?? 0, appointmentsAssisted: 0, conversations: o.connected ?? 0, qualified: o.qualified ?? 0, connectRate: 50, afterHours: 0 },
    channelSplit: { voice: o.calls ?? 0, sms: 0 },
    leadFunnel: { contacted: o.contacted ?? 0, connected: o.connected ?? 0, qualified: o.qualified ?? 0 },
    report: { summary: {}, leadsAttempted: o.contacted ?? 0, callFlow: { transferred: 0, callbacks: 0, total: 0 }, deltas: {} },
  };
}
const BUSY = { agents: [agent("Service Inbound", { calls: 12, appts: 2, contacted: 9, connected: 6, qualified: 3 }), agent("Service Outbound"), agent("Sales Inbound", { calls: 12, appts: 1, contacted: 9, connected: 6, qualified: 3 }), agent("Sales Outbound")] };

function installFetch(log, { failReports = 0, syncHealth = null } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("http://rv.test")) {
      const p = new URL(u);
      log.api.push(p.pathname + p.search);
      if (p.pathname === "/api/reports") {
        if (failReports > 0) { failReports--; return new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 }); }
        return json(BUSY);
      }
      if (p.pathname === "/api/sync-health") return syncHealth ? json(syncHealth) : json({ ok: false }, 503);
      if (p.pathname === "/api/action-items") return json(p.searchParams.get("scope") === "stats" ? { scope: "stats", stats: { created: 0, completed: 0, open: 1, overdue: 0 } } : { actionItems: [], hasMore: false });
      return json({ vehicles: [] });
    }
    if (u.startsWith("http://mail.test")) { log.mail.push(JSON.parse(init.body)); log.seq.push("mail:post"); return json({ messageId: `mid-${log.mail.length}` }); }
    log.other.push(u);
    return json({ ok: true });
  };
}

function load({ teams = ["t1"], dept = "service", cfg = {}, cfgOf = {}, live = {}, runs = [], recip = {}, env = {} } = {}) {
  for (const k of ["FORCE_RESEND", "IGNORE_SEND_HOUR", "IGNORE_SEND_DAY", "ONLY_TEAMS", "RUN_LOCAL_DATE", "V2_TO_CUSTOMERS"]) delete process.env[k];
  Object.assign(process.env, {
    ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", REPORTING_API_BASE: "http://rv.test",
    CLICKHOUSE_HOST: "", CLICKHOUSE_PASSWORD: "", SPYNE_API_BASE: "http://spyne.test", MAIL_PROXY_URL: "http://mail.test/send",
    DRY_RUN: "true", SMS_DRY_RUN: "true", SLACK_BOT_TOKEN: "", DIGEST_SPYNE_TOKEN: "", SPYNE_API_TOKEN: "",
    TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_API_KEY_SECRET: "",
    CRON_POOL: "1", DIGEST_PASS_BUDGET_MS: "200000", DIGEST_SEND_WINDOW_HOURS: "24", MAIL_SEND_DELAY_MS: "0",
  }, env);
  const db = {
    roi_live_departments: teams.map((t) => ({ team_id: t, department: dept, dry_run: true, is_live: true, ...live })),
    roi_rooftop_config: teams.map((t) => ({
      team_id: t, enterprise_id: `ent-${t}`, rooftop_name: `Rooftop ${t}`, timezone: TZ, daily_enabled: true,
      weekly_enabled: true, monthly_enabled: true, weekly_send_dow: 99, monthly_send_day: 99, lifecycle_status: "live", churn_date: null,
      ...AFTER_SEND, ...cfg, ...(cfgOf[t] || {}),
    })),
    roi_recipients: teams.map((t) => ({ team_id: t, email: `gm@${t}.example.com`, receives_sales: true, receives_service: true, email_enabled: true, verified_at: "2026-01-01", subscriptions: null, ...recip })),
    roi_digest_runs: runs.map((r, i) => ({ id: `seed-${i}`, message_id: null, ...r })),
    roi_cron_runs: [], roi_event_sms: [],
  };
  const log = { seq: [], api: [], other: [], writes: [], mail: [] };
  for (const m of [RUNNER, SEND_SMS, EMAIL_VALUE]) delete require.cache[m];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(db, log) };
  return { runner: require(RUNNER), db, log };
}
const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const reportsCalls = (log) => log.api.filter((p) => p.startsWith("/api/reports"));
const rowsOf = (db, cadence) => db.roi_digest_runs.filter((r) => r.cadence === cadence);

// ── A18: the period window, pure ─────────────────────────────────────────────────────────────────
test("A18: windowForPeriod maps each cadence's period key to exactly the cron's window", () => {
  const { runner } = load();
  const d = runner.windowForPeriod("America/Chicago", "daily", "2026-10-07");
  assert.deepEqual([d.localDate, d.apiStart, d.apiEnd, d.apiMonthStart, d.lastDay], ["2026-10-07", "2026-10-07", "2026-10-08", "2026-10-01", "2026-10-07"]);
  const w = runner.windowForPeriod("America/Chicago", "weekly", "2026-10-04");
  assert.deepEqual([w.localDate, w.apiStart, w.apiEnd, w.lastDay, w.dateLabel], ["2026-10-04", "2026-09-28", "2026-10-05", "2026-10-04", "Week of 2026-09-28 – 2026-10-04"]);
  const wFirst = runner.windowForPeriod("America/Chicago", "weekly", "2026-08-31");
  assert.equal(wFirst.apiMonthStart, "2026-08-01", "MTD of the period's last day, not an empty window on the 1st");
  const mo = runner.windowForPeriod("America/Chicago", "monthly", "2026-09-01");
  assert.deepEqual([mo.localDate, mo.apiStart, mo.apiEnd, mo.lastDay, mo.dateLabel], ["2026-09-01", "2026-09-01", "2026-10-01", "2026-09-30", "September 2026"]);
  assert.equal(runner.windowForPeriod(TZ, "monthly", "2026-12-15").apiEnd, "2027-01-01");
  assert.equal(runner.windowForPeriod(TZ, "monthly", "2026-09-15").localDate, "2026-09-01");
  assert.throws(() => runner.windowForPeriod(TZ, "daily", "2026-02-30"));
  assert.throws(() => runner.windowForPeriod(TZ, "weekly", "10/04/2026"));
  // the scheduled pass and an explicit period agree
  const cw = runner.cadenceWindow(TZ, "weekly", { weekly_send_dow: TODAY_DOW });
  assert.equal(cw.lateDays, 0);
  assert.equal(cw.localDate, YESTERDAY);
  assert.equal(cw.apiStart, runner.windowForPeriod(TZ, "weekly", YESTERDAY).apiStart);
});

// ── A17: catch-up ─────────────────────────────────────────────────────────────────────────────────
test("A17: a weekly period missed on its send day is still sent two days later (same period, not a new one)", async () => {
  const sendDow = (TODAY_DOW - 2 + 7) % 7;
  const { runner, db, log } = load({ cfg: { weekly_send_dow: sendDow } });
  db.roi_cron_runs.push({ id: "c0", source: "roi-digest-weekly", ok: true, summary: {}, created_at: `${daysAgo(30)}T12:00:00.000Z` }); // catch-up existed then
  installFetch(log);
  const out = await quiet(() => runner.runCadence("weekly"));
  const rows = rowsOf(db, "weekly");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].local_date, daysAgo(3), "the period ending the day before its send day");
  assert.equal(rows[0].status, "suppressed", "processed (dry-run rooftop → held)");
  assert.equal(out.suppressed, 1);
  assert.ok(reportsCalls(log).some((p) => p.includes(`start=${daysAgo(9)}&end=${daysAgo(2)}`)), reportsCalls(log).join("\n"));
});

test("A17: on a catch-up day a period already decided on its send day is not re-fetched", async () => {
  const sendDow = (TODAY_DOW - 2 + 7) % 7;
  const { runner, db, log } = load({ cfg: { weekly_send_dow: sendDow },
    runs: [{ team_id: "t1", department: "service", cadence: "weekly", local_date: daysAgo(3), status: "not_sent", reason: "no_data" }] });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("weekly"));
  assert.equal(reportsCalls(log).length, 0);
  assert.equal(out.not_due, 1);
  assert.equal(rowsOf(db, "weekly")[0].status, "not_sent");
});

test("A17: a monthly period more than 10 days past its send day is recorded once as missed_send_day", async () => {
  const sendDay = NOW.D + 1 <= 28 ? NOW.D + 1 : NOW.D - 11; // previous month (≥ 27 days late) or 11 days late
  const { runner, db, log } = load({ cfg: { monthly_send_day: sendDay } });
  const w = runner.cadenceWindow(TZ, "monthly", { monthly_send_day: sendDay });
  assert.equal(w.gaveUp, true, `late ${w.lateDays}`);
  db.roi_digest_runs.push({ id: "s1", team_id: "t1", department: "service", cadence: "monthly", local_date: w.localDate, status: "scheduled", reason: "before_send_hour", message_id: null });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(out.missed, 1);
  assert.deepEqual([rowsOf(db, "monthly")[0].status, rowsOf(db, "monthly")[0].reason], ["not_sent", "missed_send_day"]);
  assert.equal(reportsCalls(log).length, 0);
  const writes = log.writes.length;
  const again = await quiet(() => runner.runCadence("monthly"));
  assert.equal(again.missed, 0, "recorded once");
  assert.equal(log.writes.length, writes);
});

test("A17: a weekly/monthly failure writes an error row and alerts, instead of only counting", async () => {
  const { runner, db, log } = load({ cfg: { monthly_send_day: NOW.D } });
  installFetch(log, { failReports: 99 });
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(out.errors, 1);
  const row = rowsOf(db, "monthly")[0];
  assert.equal(row.status, "error");
  assert.match(row.reason_detail, /reporting-api 504/);
});

test("A17: the weekly/monthly pass holds a period the aggregate hasn't fully reached (freshness gate)", async () => {
  const { runner, db, log } = load({ cfg: { weekly_send_dow: TODAY_DOW } });
  installFetch(log, { syncHealth: { ok: true, maxActivityDay: daysAgo(3), lastRunAt: "x" } });
  const out = await quiet(() => runner.runCadence("weekly"));
  assert.equal(out.stale_held, 1);
  assert.deepEqual([rowsOf(db, "weekly")[0].status, rowsOf(db, "weekly")[0].reason], ["not_sent", "aggregate_stale"]);
  assert.equal(reportsCalls(log).length, 0);
});

// ── A18: generateAndSendNow with a named period ──────────────────────────────────────────────────
test("A18: a named period already sent is skipped (no fetch) unless forced; a disabled cadence is respected", async () => {
  let { runner, log } = load({ runs: [{ team_id: "t1", department: "service", cadence: "weekly", local_date: "2026-10-04", status: "sent", message_id: "mid-x" }] });
  installFetch(log);
  let out = await quiet(() => runner.generateAndSendNow({ cadence: "weekly", teamId: "t1", department: "service", localDate: "2026-10-04" }));
  assert.equal(out.already_sent, 1);
  assert.equal(reportsCalls(log).length, 0);
  ({ runner, log } = load({ cfg: { weekly_enabled: false } }));
  installFetch(log);
  out = await quiet(() => runner.generateAndSendNow({ cadence: "weekly", teamId: "t1", department: "service", localDate: "2026-10-04" }));
  assert.equal(out.paused, 1);
  assert.equal(reportsCalls(log).length, 0);
});

test("A18: a named period is built for THAT window, upserted on THAT row, and sent under the cron's claim", async () => {
  const { runner, db, log } = load({ live: { dry_run: false }, env: { DRY_RUN: "false" } });
  installFetch(log);
  const out = await quiet(() => runner.generateAndSendNow({ cadence: "monthly", teamId: "t1", department: "service", localDate: "2026-09-01" }));
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.ok(reportsCalls(log).some((p) => p.includes("start=2026-09-01&end=2026-10-01")), reportsCalls(log).join("\n"));
  const row = rowsOf(db, "monthly").find((r) => r.local_date === "2026-09-01");
  assert.equal(row.status, "sent");
  assert.equal(row.trigger, "manual");
  assert.equal(log.mail.length, 1);
  assert.ok(log.writes.some((w) => w.status === "queued"), "row exists before the claim");
  assert.ok(log.seq.indexOf("roi_digest_runs:update") < log.seq.indexOf("mail:post"), "claimed before sending");
  // the cron for the same period now sees it as finished
  const again = await quiet(() => runner.generateAndSendNow({ cadence: "monthly", teamId: "t1", department: "service", localDate: "2026-09-01" }));
  assert.equal(again.already_sent, 1);
  assert.equal(log.mail.length, 1);
  // forced: the DANGER override re-sends
  const forced = await quiet(() => runner.generateAndSendNow({ cadence: "monthly", teamId: "t1", department: "service", localDate: "2026-09-01", force: true }));
  assert.equal(forced.sent, 1);
  assert.equal(log.mail.length, 2);
});

// ── A19 ───────────────────────────────────────────────────────────────────────────────────────────
// After integration with stab/events, resolveTz ignores a configured zone that isn't a valid US/Canada
// zone (it warns and resolves from team settings), so a malformed value never reaches the runner at
// all; the runner's own per-row guard stays as the second line. Either way the pass carries on.
test("A19: one malformed timezone never stops the pass, and never fails the other rooftops (daily and weekly)", async () => {
  const { runner, db, log } = load({ teams: ["bad", "good"], cfgOf: { bad: { timezone: "America/New York" } }, cfg: { weekly_send_dow: TODAY_DOW } });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.errors, 0);
  assert.equal(rowsOf(db, "daily").find((r) => r.team_id === "bad").status, "suppressed", "the bad zone is ignored, not used");
  assert.equal(rowsOf(db, "daily").find((r) => r.team_id === "good").status, "suppressed");
  const wk = await quiet(() => runner.runCadence("weekly"));
  assert.equal(wk.errors, 0);
  assert.equal(wk.suppressed, 2);
});

// ── A20 ───────────────────────────────────────────────────────────────────────────────────────────
test("A20: daily_enabled=false writes not_sent/disabled once per day, without fetching numbers", async () => {
  const { runner, db, log } = load({ cfg: { daily_enabled: false } });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.disabled, 1);
  assert.equal(reportsCalls(log).length, 0);
  const row = rowsOf(db, "daily")[0];
  assert.deepEqual([row.local_date, row.status, row.reason], [YESTERDAY, "not_sent", "disabled"]);
  const writes = log.writes.length;
  await quiet(() => runner.runOnce());
  assert.equal(log.writes.length, writes, "second pass the same day writes nothing");
});

// ── A21 ───────────────────────────────────────────────────────────────────────────────────────────
test("A21: every pass writes a roi_cron_runs row (ok:false when it throws); a CLI run does not", async () => {
  let { runner, db, log } = load();
  installFetch(log);
  await quiet(() => runner.runOnce());
  await quiet(() => runner.runCadence("monthly"));
  const [daily, monthly] = db.roi_cron_runs;
  assert.equal(daily.source, "roi-email-daily");
  assert.equal(daily.ok, true);
  for (const k of ["startedAt", "finishedAt", "elapsedMs", "targets", "unreached", "sent", "errors"]) assert.ok(k in daily.summary, k);
  assert.equal(daily.summary.targets, 1);
  assert.equal(monthly.source, "roi-digest-monthly");
  ({ runner, db, log } = load());
  db.__fail = { roi_live_departments: "boom" };
  installFetch(log);
  await assert.rejects(quiet(() => runner.runOnce()));
  assert.equal(db.roi_cron_runs.length, 1);
  assert.equal(db.roi_cron_runs[0].ok, false);
  assert.match(db.roi_cron_runs[0].summary.error, /boom/);
  ({ runner, db, log } = load());
  installFetch(log);
  await quiet(() => runner.runOnce({ cli: true }));
  assert.equal(db.roi_cron_runs.length, 0);
});

// ── A22 ───────────────────────────────────────────────────────────────────────────────────────────
test("A22: the daily pass reaps orphaned rows first and never resends a claimed one", async () => {
  const old = daysAgo(6);
  const stamp = (msAgo) => `claimed ${new Date(Date.now() - msAgo).toISOString()}`;
  const { runner, db, log } = load({ runs: [
    { team_id: "x1", department: "sales", cadence: "daily", local_date: old, status: "queued" },
    { team_id: "x2", department: "sales", cadence: "daily", local_date: old, status: "scheduled" },
    { team_id: "x3", department: "sales", cadence: "daily", local_date: YESTERDAY, status: "scheduled" },        // current: left alone
    { team_id: "x4", department: "sales", cadence: "daily", local_date: YESTERDAY, status: "sending", message_id: "cron-x4", reason_detail: stamp(3 * 3600e3) },
    { team_id: "x5", department: "sales", cadence: "daily", local_date: YESTERDAY, status: "sending", message_id: "cron-x5", reason_detail: stamp(10 * 60e3) },  // live claim
    { team_id: "x6", department: "sales", cadence: "daily", local_date: old, status: "sending", message_id: "cron-x6" },  // claimed before stamps existed
  ] });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  const by = (t) => db.roi_digest_runs.find((r) => r.team_id === t);
  assert.deepEqual([by("x1").status, by("x1").reason], ["not_sent", "pass_killed"]);
  assert.deepEqual([by("x2").status, by("x2").reason], ["not_sent", "pass_killed"]);
  assert.equal(by("x1").message_id, null);
  assert.equal(by("x3").status, "scheduled");
  assert.deepEqual([by("x4").status, by("x4").reason, by("x4").message_id], ["error", "pass_killed", "cron-x4"], "claim kept: never resent");
  assert.equal(by("x5").status, "sending");
  assert.deepEqual([by("x6").status, by("x6").message_id], ["error", "cron-x6"]);
  assert.deepEqual(out.reaped, { queued: 1, scheduled: 1, sending: 2 });
  assert.equal(log.mail.length, 0);
});

// ── A23 ───────────────────────────────────────────────────────────────────────────────────────────
test("A23: the scheduled pass ignores FORCE_RESEND / ONLY_TEAMS; only a CLI run honours them", async () => {
  const sent = { team_id: "t1", department: "service", cadence: "daily", local_date: YESTERDAY, status: "sent", message_id: "mid-1" };
  let { runner, log } = load({ teams: ["t1", "t2"], runs: [sent], env: { FORCE_RESEND: "true", ONLY_TEAMS: "t1" } });
  installFetch(log);
  let out = await quiet(() => runner.runOnce());
  assert.equal(out.already_sent, 1, "FORCE_RESEND ignored: the sent row is not redone");
  assert.equal(out.targets, 2, "ONLY_TEAMS ignored: the whole fleet is in scope");
  assert.deepEqual(out.ignoredEnv.sort(), ["FORCE_RESEND", "ONLY_TEAMS"]);
  ({ runner, log } = load({ teams: ["t1", "t2"], runs: [sent], env: { FORCE_RESEND: "true", ONLY_TEAMS: "t1" } }));
  installFetch(log);
  out = await quiet(() => runner.runOnce({ cli: true }));
  assert.equal(out.targets, 1);
  assert.equal(out.already_sent, 0);
  assert.ok(reportsCalls(log).length > 0, "the CLI re-does the sent day");
});

// ── A24 ───────────────────────────────────────────────────────────────────────────────────────────
test("A24: a row claimed by a failed send stays 'error' and is never flipped back to queued", async () => {
  const { runner, db, log } = load({ runs: [{ team_id: "t1", department: "service", cadence: "daily", local_date: YESTERDAY, status: "error", reason: "error", message_id: "cron-t1-service-daily-x" }] });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.already_sent, 1);
  assert.equal(reportsCalls(log).length, 0);
  assert.equal(db.roi_digest_runs[0].status, "error");
  assert.ok(!log.writes.some((w) => w.status === "queued"));
});

// ── A26 ───────────────────────────────────────────────────────────────────────────────────────────
test("A26: backfill records not_sent/backfilled (never a fake 'sent') and the day can still be sent", async () => {
  const { runner, db, log } = load();
  installFetch(log);
  await quiet(() => runner.backfill(YESTERDAY, YESTERDAY));
  const row = rowsOf(db, "daily")[0];
  assert.deepEqual([row.status, row.reason, row.trigger, row.message_id, row.sent_at], ["not_sent", "backfilled", "backfill", null, null]);
  assert.ok(row.rendered_html);
  assert.ok(row.recipients.every((r) => r.received === false));
  assert.equal(log.mail.length, 0);
  const before = reportsCalls(log).length;
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.already_sent, 0);
  assert.ok(reportsCalls(log).length > before, "the cron still works the day");
  assert.equal(row.status, "suppressed");
});

// ── A29 ───────────────────────────────────────────────────────────────────────────────────────────
const SMS_RECIP = { phone: "7752611534", sms_enabled: true, subscriptions: { daily: { sms: true } } };
test("A29: no digest SMS for a held email (dry-run rooftop, v2 lock); one SMS after a real send", async () => {
  let { runner, db, log } = load({ cfg: { sms_enabled: true }, recip: SMS_RECIP, env: { SMS_DRY_RUN: "false" } });
  installFetch(log);
  await quiet(() => runner.runOnce());
  assert.equal(rowsOf(db, "daily")[0].status, "suppressed");
  assert.equal(db.roi_event_sms.length, 0, "dry-run held email → no SMS");

  ({ runner, db, log } = load({ cfg: { sms_enabled: true }, recip: SMS_RECIP, live: { dry_run: false }, env: { SMS_DRY_RUN: "false", DRY_RUN: "false", V2_TO_CUSTOMERS: "false" } }));
  installFetch(log);
  await quiet(() => runner.runOnce());
  assert.deepEqual([rowsOf(db, "daily")[0].status, rowsOf(db, "daily")[0].reason], ["not_sent", "v2_spyne_only"]);
  assert.equal(db.roi_event_sms.length, 0, "email held by the v2 lock → no SMS");

  ({ runner, db, log } = load({ cfg: { sms_enabled: true }, recip: SMS_RECIP, live: { dry_run: false }, env: { SMS_DRY_RUN: "false", DRY_RUN: "false" } }));
  installFetch(log);
  await quiet(() => runner.runOnce());
  assert.equal(rowsOf(db, "daily")[0].status, "sent");
  assert.equal(db.roi_event_sms.length, 1);
  assert.ok(log.seq.indexOf("mail:post") < log.seq.indexOf("roi_event_sms:insert"), "SMS only after the email went out");
});

// ── Catch-up floor: periods missed BEFORE catch-up existed are never sent automatically ─────────────
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// a monthly_send_day that makes today exactly 8 days after the send day
const SEND_DAY_8_LATE = NOW.D > 8 ? NOW.D - 8 : dim(NOW.M === 1 ? NOW.Y - 1 : NOW.Y, NOW.M === 1 ? 12 : NOW.M - 1) - (8 - NOW.D);
const LIVE_SEND = { live: { dry_run: false }, env: { DRY_RUN: "false" } };

test("floor: first pass after deploy, a monthly 8 days late → no fetch, no send, the stuck row becomes missed_send_day", async () => {
  const { runner, db, log } = load({ cfg: { monthly_send_day: SEND_DAY_8_LATE }, ...LIVE_SEND });
  const w = runner.cadenceWindow(TZ, "monthly", { monthly_send_day: SEND_DAY_8_LATE });
  assert.equal(w.lateDays, 8);
  db.roi_digest_runs.push({ id: "s1", team_id: "t1", department: "service", cadence: "monthly", local_date: w.localDate, status: "scheduled", reason: "before_send_hour", message_id: null });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(out.catchupFloor, new Date().toISOString().slice(0, 10), "no trail yet → floor is today");
  assert.equal(reportsCalls(log).length, 0);
  assert.equal(log.mail.length, 0);
  const row = rowsOf(db, "monthly")[0];
  assert.deepEqual([row.status, row.reason], ["not_sent", "missed_send_day"]);
  assert.match(row.reason_detail, new RegExp(`missed before catch-up existed \\(send day ${w.sendDate}\\); not sent automatically`));
  const writes = log.writes.length;
  await quiet(() => runner.runCadence("monthly"));
  assert.equal(log.writes.length, writes, "recorded once");
  assert.equal(log.mail.length, 0);
});

test("floor: when catch-up already existed on the send day, the late period is caught up and sent", async () => {
  const { runner, db, log } = load({ cfg: { monthly_send_day: SEND_DAY_8_LATE }, ...LIVE_SEND });
  db.roi_cron_runs.push({ id: "c0", source: "roi-digest-monthly", ok: true, summary: {}, created_at: `${daysAgo(60)}T03:40:00.000Z` });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(out.catchupFloor, daysAgo(60));
  assert.equal(out.sent, 1);
  assert.equal(out.caught_up, 1);
  assert.equal(log.mail.length, 1);
  assert.equal(rowsOf(db, "monthly")[0].status, "sent");
  // the explicit human override works the same way
  const o2 = load({ cfg: { monthly_send_day: SEND_DAY_8_LATE }, ...LIVE_SEND, env: { DRY_RUN: "false", CADENCE_CATCHUP_NOT_BEFORE: daysAgo(20) } });
  installFetch(o2.log);
  assert.equal((await quiet(() => o2.runner.runCadence("monthly"))).sent, 1);
});

test("floor: an on-time send day is unaffected on the very first pass after deploy", async () => {
  const { runner, db, log } = load({ cfg: { monthly_send_day: NOW.D }, ...LIVE_SEND });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("monthly"));
  assert.equal(out.sent, 1);
  assert.equal(log.mail.length, 1);
  assert.equal(rowsOf(db, "monthly")[0].status, "sent");
});

test("floor: a sent (or claimed, or deliberately held) late period is never touched", async () => {
  const { runner, db, log } = load({ cfg: { monthly_send_day: SEND_DAY_8_LATE }, ...LIVE_SEND });
  const w = runner.cadenceWindow(TZ, "monthly", { monthly_send_day: SEND_DAY_8_LATE });
  const sent = { id: "s1", team_id: "t1", department: "service", cadence: "monthly", local_date: w.localDate, status: "sent", reason: null, message_id: "mid-old", sent_at: "x" };
  db.roi_digest_runs.push({ ...sent });
  installFetch(log);
  await quiet(() => runner.runCadence("monthly"));
  assert.deepEqual(rowsOf(db, "monthly")[0], sent);
  assert.equal(log.writes.length, 0);
  assert.equal(log.mail.length, 0);
  const held = load({ cfg: { monthly_send_day: SEND_DAY_8_LATE }, ...LIVE_SEND });
  held.db.roi_digest_runs.push({ id: "s2", team_id: "t1", department: "service", cadence: "monthly", local_date: w.localDate, status: "not_sent", reason: "no_data", message_id: null });
  installFetch(held.log);
  await quiet(() => held.runner.runCadence("monthly"));
  assert.equal(held.db.roi_digest_runs[0].reason, "no_data");
  assert.equal(held.log.writes.length, 0);
});

// ── Send window (2026-10-09, before the first prod pass of the fix) ─────────────────────────────────
// The first daily pass after deploy would otherwise have mailed ~50 departments their missed morning
// digest at 6 pm local, in one burst. Past the window nothing is fetched or sent.
test("send window: past it nothing is fetched or sent; an empty day is recorded, a failed row keeps its error", async () => {
  const { runner, db, log } = load({ teams: ["a", "b"], cfg: AFTER_SEND, env: { DIGEST_SEND_WINDOW_HOURS: "0.01" },
    runs: [{ team_id: "b", department: "service", cadence: "daily", local_date: YESTERDAY, status: "error", reason: "error", reason_detail: "reporting-api 504" }] });
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(reportsCalls(log).length, 0, "no numbers fetched");
  assert.equal(log.mail.length, 0, "nothing mailed");
  assert.equal(out.window_passed, 2);
  const a = rowsOf(db, "daily").find((r) => r.team_id === "a");
  assert.deepEqual([a.status, a.reason], ["not_sent", "send_window_passed"]);
  assert.equal(rowsOf(db, "daily").find((r) => r.team_id === "b").status, "error");
});
test("send window: a weekly due today but past the window is not sent and writes nothing", async () => {
  const { runner, db, log } = load({ cfg: { ...AFTER_SEND, weekly_send_dow: TODAY_DOW }, env: { DIGEST_SEND_WINDOW_HOURS: "0.01" } });
  installFetch(log);
  const out = await quiet(() => runner.runCadence("weekly"));
  assert.equal(reportsCalls(log).length, 0);
  assert.equal(log.mail.length, 0);
  assert.equal(out.window_passed, 1);
  assert.equal(rowsOf(db, "weekly").length, 0);
});
