/* The email-tracker watchdog must notice a silent breakage within hours, not when a dealer calls.
 *
 * Each detection (a)-(f) is checked against the failure that actually happened:
 *   (a) 2026-10-07: 130 daily-enabled departments got no row (38 live senders), nobody knew
 *   (b) 2026-10-01 monthly: 41 rows stuck "scheduled", 0 sent
 *   (c) passes killed at 300s leave rows in queued/sending, never retried
 *   (d) roi-email 504'd on every hourly run with no alert
 *   (e) a 13-day transactional blackout found by a CSM
 *   (f) SMS 401 / 20003 for a week from 2026-10-02
 * Plus the runner: one consolidated alert, a 6h dedupe kept in roi_cron_runs, paging past
 * PostgREST's 1000-row cap, and no writes beyond its own roi_cron_runs row.
 *
 * Fully offline: fake Supabase via require.cache, Slack routed to a fake fetch.
 * Run: node --test server/roi-cron/__tests__/watchdog.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const WATCHDOG = require.resolve("../watchdog.cjs");
const SLACK = require.resolve("../slackAlert.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [WATCHDOG] });
const W = require(WATCHDOG);

const H = 3_600_000, MIN = 60_000, DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 8, 15, 0); // Thu 2026-10-08 15:00 UTC = 11:00 ET = 08:00 PT
const iso = (t) => new Date(t).toISOString();
const ET = "America/New_York", PT = "America/Los_Angeles";
const recip = (team, extra = {}) => ({ id: `r-${team}`, team_id: team, email: `gm@${team}.example.com`, receives_sales: true, receives_service: true, email_enabled: true, verified_at: "2026-01-01", subscriptions: null, ...extra });
const cfg = (team, extra = {}) => ({ team_id: team, rooftop_name: `Rooftop ${team}`, timezone: ET, daily_enabled: true, digest_send_hour: 7, digest_send_minute: 0, lifecycle_status: "live", churn_date: null, ...extra });
const live = (team, extra = {}) => ({ team_id: team, department: "sales", is_live: true, dry_run: false, ...extra });
const keys = (ps) => ps.map((p) => p.key).sort();

// ── (a) ───────────────────────────────────────────────────────────────────────────────────────
test("(a) a live sending department with no daily row by 10:00 dealer-local is flagged; everything that should not be is not", () => {
  const teams = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
  const problems = W.detectMissingDaily({
    now: NOW,
    live: [live("t1"), live("t2"), live("t3"), live("t4", { dry_run: true }), live("t5"), live("t6"), live("t7"), live("t8")],
    cfgs: [cfg("t1"), cfg("t2"), cfg("t3", { timezone: PT }), cfg("t4"), cfg("t5", { lifecycle_status: "churn" }), cfg("t6"), cfg("t7", { daily_enabled: false }), cfg("t8")],
    recipients: [...teams.filter((t) => t !== "t6").map((t) => recip(t)), recip("t6", { verified_at: null })],
    dailyRows: [
      { team_id: "t2", department: "sales", cadence: "daily", local_date: "2026-10-07", status: "scheduled" },
      { team_id: "t8", department: "sales", cadence: "daily", local_date: "2026-10-06", status: "sent" },
    ],
  });
  // t1 missing · t2 has its row · t3 is 08:00 PT (before 10:00) · t4 dry-run · t5 churned ·
  // t6 no eligible (unverified) recipient · t7 daily paused · t8 has only YESTERDAY's report date
  assert.deepEqual(keys(problems), ["a:t1|sales|2026-10-07", "a:t8|sales|2026-10-07"]);
  assert.match(problems[0].detail, /Rooftop t\d \[sales\] has no daily digest row for 2026-10-07 \(11:00 America\/New_York\)/);
});

test("(a) a team with no config timezone falls back to the timezone its own digest rows were written in", () => {
  const problems = W.detectMissingDaily({
    now: NOW, live: [live("t1")], cfgs: [cfg("t1", { timezone: null })], recipients: [recip("t1")],
    dailyRows: [{ team_id: "t1", department: "service", cadence: "daily", local_date: "2026-10-07", dealer_timezone: PT }],
  });
  assert.equal(problems.length, 0, "08:00 Pacific is before the 10:00 deadline");
});

// ── (b) ───────────────────────────────────────────────────────────────────────────────────────
test("(b) weekly/monthly rows still scheduled/queued after their send day", () => {
  const row = (cadence, local_date, status) => ({ team_id: "t1", department: "sales", cadence, local_date, status, dealer_timezone: ET });
  const problems = W.detectOverdueCadence({
    now: NOW, cfgs: [cfg("t1", { monthly_send_day: 1 })],
    rows: [
      row("monthly", "2026-09-01", "scheduled"), // sent on 10-01 → overdue (the real 2026-10-01 incident)
      row("weekly", "2026-10-04", "queued"),     // send day Mon 10-05 → overdue
      row("weekly", "2026-10-07", "scheduled"),  // send day is TODAY → still allowed
      row("monthly", "2026-09-01", "sent"),
      row("daily", "2026-10-06", "scheduled"),   // not a cadence row
      row("monthly", "2026-08-01", "scheduled"), // send day 09-01: more than a week ago, aged out
    ],
  });
  assert.deepEqual(keys(problems), ["b:t1|sales|monthly|2026-09-01", "b:t1|sales|weekly|2026-10-04"]);
  assert.match(problems.find((p) => p.key.includes("monthly")).detail, /still "scheduled" \(send day was 2026-10-01\)/);
});

test("(b) monthly_send_day moves the deadline", () => {
  const problems = W.detectOverdueCadence({ now: NOW, cfgs: [cfg("t1", { monthly_send_day: 9 })],
    rows: [{ team_id: "t1", department: "sales", cadence: "monthly", local_date: "2026-09-01", status: "scheduled", dealer_timezone: ET }] });
  assert.equal(problems.length, 0, "due 10-09, today is 10-08");
});

// ── (c) ───────────────────────────────────────────────────────────────────────────────────────
test("(c) stuck rows: digest sending > 2h / queued > 1h (clock starts at the send time), event + SMS queued > 1h", () => {
  const d = (team, status, extra = {}) => ({ team_id: team, department: "sales", cadence: "daily", local_date: "2026-10-07", status, created_at: iso(NOW - 15 * H), dealer_timezone: ET, ...extra });
  const problems = W.detectStuck({
    now: NOW,
    cfgs: [cfg("s1"), cfg("s2", { digest_send_hour: 14, digest_send_minute: 30 }), cfg("s3", { digest_send_hour: 9 }), cfg("s4", { digest_send_hour: 10, digest_send_minute: 30 })],
    digestRows: [
      d("s1", "sending"), // send 07:00 ET = 11:00 UTC, 4h ago → stuck
      d("s2", "queued"),  // send 14:30 ET is still ahead → fine (created_at at midnight does not count)
      d("s3", "queued"),  // send 09:00 ET = 13:00 UTC, 2h ago → stuck
      d("s4", "sending"), // send 10:30 ET = 14:30 UTC, 30 min ago → still within 2h
      d("s1", "scheduled", { local_date: "2026-10-06" }),
    ],
    eventRows: [
      { team_id: "s1", email_type: "post_conversation", status: "queued", created_at: iso(NOW - 3 * H) },
      { team_id: "s2", email_type: "action_item", status: "queued", created_at: iso(NOW - 30 * MIN) },
      { team_id: "s3", email_type: "action_item", status: "queued", created_at: iso(NOW - 3 * DAY) }, // aged out
    ],
    smsRows: [{ team_id: "s1", email_type: "action_item", status: "queued", created_at: iso(NOW - 2 * H) }],
  });
  assert.deepEqual(keys(problems), [
    "c:digest|s1|sales|daily|2026-10-07|sending",
    "c:digest|s3|sales|daily|2026-10-07|queued",
    "c:roi_event_emails|queued",
    "c:roi_event_sms|queued",
  ]);
  const ev = problems.find((p) => p.key === "c:roi_event_emails|queued");
  assert.equal(ev.count, 1);
  assert.match(ev.detail, /1 roi_event_emails row\(s\) claimed but never finished \(oldest 3h ago; post_conversation; Rooftop s1\)/);
});

// ── (d) ───────────────────────────────────────────────────────────────────────────────────────
test("(d) a source that has reported before and has gone quiet for > 2x its schedule", () => {
  const latest = new Map([
    ["roi-email-daily", iso(NOW - 3 * H)],           // hourly → allowed ~2h → stale
    ["roi-digest-weekly", iso(NOW - 30 * MIN)],
    ["roi-events-shard-0-of-4", iso(NOW - 20 * MIN)], // 15:00 UTC is the 4-min regime → stale
    ["roi-events-shard-1-of-4", iso(NOW - 2 * MIN)],
    ["sync-live", iso(NOW - 30 * H)],                 // daily → allowed 48h
  ]);
  const problems = W.detectStaleSources({ latest, now: NOW });
  assert.deepEqual(keys(problems), ["d:roi-email-daily", "d:roi-events-shard-0-of-4"]);
  // never-written sources (roi-digest-monthly, the other shards) are skipped: not deployed yet
});

test("(d) the 15-min overnight events schedule is not paged as a 4-min one across the 12:00 UTC switch", () => {
  const at = Date.UTC(2026, 9, 8, 12, 10);
  assert.equal(W.detectStaleSources({ latest: { "roi-events-shard-0-of-4": iso(at - 20 * MIN) }, now: at }).length, 0);
  assert.equal(W.detectStaleSources({ latest: { "roi-events-shard-0-of-4": iso(at - 40 * MIN) }, now: at }).length, 1);
});

// ── (e) ───────────────────────────────────────────────────────────────────────────────────────
// `perDay` sends spread evenly across each of the 7 days before NOW's UTC day, plus `today` sends.
function sent(type, perDay, today = 0) {
  const dayStart = Date.UTC(2026, 9, 8);
  const rows = [];
  for (let d = 1; d <= 7; d++) for (let i = 0; i < perDay; i++) rows.push({ email_type: type, created_at: iso(dayStart - d * DAY + (i + 0.5) * (DAY / perDay)) });
  for (let i = 0; i < today; i++) rows.push({ email_type: type, created_at: iso(dayStart + (i + 1) * MIN) });
  return rows;
}
test("(e) an email type at 0 today while it averaged > 10/day is flagged; low-volume and still-sending types are not", () => {
  const rows = [...sent("post_appointment", 20), ...sent("action_item", 20, 3), ...sent("action_item_overdue", 5)];
  const problems = W.detectVolumeDrop({ sentRows: rows, now: NOW });
  assert.deepEqual(keys(problems), ["e:post_appointment:2026-10-08"]);
  assert.match(problems[0].detail, /0 sent today \(UTC\) by 15:00; the last 7 days averaged 20\.0\/day/);
});
test("(e) stays quiet early in the UTC day, before the type would normally have sent anything", () => {
  const at = Date.UTC(2026, 9, 8, 1, 0); // 9 pm ET: 20/day spread evenly ≈ 0.8 by now
  assert.equal(W.detectVolumeDrop({ sentRows: sent("post_appointment", 20), now: at }).length, 0);
});

// ── (f) ───────────────────────────────────────────────────────────────────────────────────────
test("(f) SMS failing on Twilio auth in the last 2h", () => {
  const authErr = [{ phone: "+15555550100", error: 'twilio 401: {"code":20003,"message":"Authenticate"}' }];
  const problems = W.detectSmsAuth({
    now: NOW, cfgs: [cfg("t1")],
    smsErrorRows: [
      { team_id: "t1", status: "error", reason: "all_recipients_failed", recipients: authErr, created_at: iso(NOW - 30 * MIN) },
      { team_id: "t1", status: "error", reason: "all_recipients_failed", recipients: authErr, created_at: iso(NOW - 3 * H) }, // outside window
      { team_id: "t1", status: "error", reason: "all_recipients_failed", recipients: [{ error: "twilio 400: invalid To" }], created_at: iso(NOW - 10 * MIN) },
    ],
  });
  assert.deepEqual(keys(problems), ["f:sms-auth"]);
  assert.equal(problems[0].count, 1);
  assert.equal(W.detectSmsAuth({ now: NOW, cfgs: [], smsErrorRows: [] }).length, 0);
});

// ── schedules stay in lockstep with vercel.json ──────────────────────────────────────────────
test("expected sources match the crons in vercel.json, and the watchdog itself is scheduled off the digest minutes", () => {
  const vercel = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"));
  const crons = vercel.crons.map((c) => c.path);
  const watched = new Set(W.EXPECTED_SOURCES.map((s) => s.source));
  assert.ok(crons.includes("/api/cron/roi-email") && watched.has("roi-email-daily"));
  for (const c of ["weekly", "monthly"]) assert.ok(crons.includes(`/api/cron/roi-digest/${c}`) && watched.has(`roi-digest-${c}`));
  const shardPaths = [...new Set(crons.filter((p) => p.startsWith("/api/cron/roi-events/shard/")))];
  assert.equal(shardPaths.length, W.EVENT_SHARDS, "shard count in vercel.json == watchdog EVENT_SHARDS");
  for (const p of shardPaths) { const [, i, n] = p.match(/shard\/(\d+)\/(\d+)$/); assert.ok(watched.has(`roi-events-shard-${i}-of-${n}`), p); }
  const ev = vercel.crons.filter((c) => c.path.startsWith("/api/cron/roi-events/shard/")).map((c) => c.schedule);
  assert.deepEqual([...new Set(ev)].sort(), ["*/15 3-11 * * *", "*/4 0-2,12-23 * * *"], "eventsIntervalMin() mirrors these two schedules");
  for (let h = 0; h < 24; h++) assert.equal(W.eventsIntervalMin(h), h >= 3 && h <= 11 ? 15 : 4);
  const wd = vercel.crons.find((c) => c.path === "/api/cron/roi-watchdog");
  assert.ok(wd, "watchdog cron registered");
  const mins = wd.schedule.split(" ")[0].split(",").map(Number);
  for (const m of mins) assert.ok(!(m <= 5 || (m >= 20 && m <= 25) || (m >= 40 && m <= 45)), `minute ${m} overlaps a digest pass`);
});

// ── the runner, end to end against a fake Supabase ───────────────────────────────────────────
function fakeSupabase(db, log) {
  let seq = 0;
  return {
    createClient: () => ({
      from(table) {
        const q = { f: [], order: [], range: null, limit: null, op: "select" };
        const b = {
          select() { return b; },
          eq(k, v) { q.f.push((r) => r[k] === v); return b; },
          in(k, vs) { q.f.push((r) => vs.includes(r[k])); return b; },
          gte(k, v) { q.f.push((r) => r[k] >= v); return b; },
          lt(k, v) { q.f.push((r) => r[k] < v); return b; },
          order(k, o) { q.order.push([k, o?.ascending !== false]); return b; },
          range(a, z) { q.range = [a, z]; return b; },
          limit(n) { q.limit = n; return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          update() { q.op = "update"; return b; }, upsert() { q.op = "upsert"; return b; }, delete() { q.op = "delete"; return b; },
          then(res, rej) {
            log.push({ table, op: q.op });
            if (q.op === "insert") {
              (db[table] = db[table] || []).push({ id: `ins-${++seq}`, created_at: iso(Date.now()), ...q.row });
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            }
            if (q.op !== "select") return Promise.resolve({ data: null, error: { message: `unexpected ${q.op}` } }).then(res, rej);
            let rows = (db[table] || []).filter((r) => q.f.every((fn) => fn(r)));
            for (const [k, asc] of [...q.order].reverse()) rows = [...rows].sort((x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0) * (asc ? 1 : -1));
            if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
            if (q.limit != null) rows = rows.slice(0, q.limit);
            if (q.range && q.range[1] - q.range[0] + 1 > 1000) return Promise.reject(new Error("page larger than PostgREST allows"));
            return Promise.resolve({ data: rows.slice(0, 1000), error: null }).then(res, rej); // PostgREST cap
          },
        };
        return b;
      },
    }),
  };
}
function installSlack(posts) {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://slack.com/")) { posts.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true })); }
    throw new Error(`unexpected fetch ${url}`);
  };
}
function setup(db) {
  Object.assign(process.env, { ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", SLACK_BOT_TOKEN: "xoxb-fake", SLACK_ALERT_CHANNEL: "test" });
  const log = [];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(db, log) };
  delete require.cache[SLACK];
  return log;
}
const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };

test("runner: pages past 1000 rows, posts ONE consolidated alert, dedupes for 6h, and writes only its own roi_cron_runs row", async () => {
  // 1,200 recipients; the only eligible one for t1 sorts AFTER the first page.
  const recipients = Array.from({ length: 1199 }, (_, i) => recip(`zz${String(i).padStart(4, "0")}`, { id: `a-${String(i).padStart(4, "0")}`, verified_at: null }));
  recipients.push(recip("t1", { id: "z-last" }));
  const db = {
    roi_live_departments: [live("t1")],
    roi_rooftop_config: [cfg("t1")],
    roi_recipients: recipients,
    roi_digest_runs: [{ id: "d1", team_id: "t1", department: "sales", cadence: "monthly", local_date: "2026-09-01", status: "scheduled", created_at: iso(NOW - 8 * DAY), dealer_timezone: ET }],
    roi_event_emails: sent("post_appointment", 20).map((r, i) => ({ id: `e${i}`, status: "sent", ...r })),
    roi_event_sms: [],
    roi_cron_runs: [{ id: "c1", source: "roi-email-daily", ok: true, created_at: iso(NOW - 5 * H) }],
  };
  const log = setup(db);
  const posts = [];
  installSlack(posts);

  const r1 = await quiet(() => W.runWatchdog({ now: NOW }));
  assert.deepEqual(r1.problems.map((p) => p.check).sort(), ["a", "b", "d", "e"]);
  assert.equal(posts.length, 1, "one consolidated alert");
  assert.match(posts[0], /4 new email-tracker problems/);
  for (const s of ["Daily digest missing", "Weekly/monthly digest still pending", "Cron pass not reporting", "Email type went silent"]) assert.ok(posts[0].includes(s), s);
  const writes = log.filter((l) => l.op !== "select");
  assert.deepEqual(writes, [{ table: "roi_cron_runs", op: "insert" }], "read-only apart from its own row");
  const row1 = db.roi_cron_runs.at(-1);
  assert.equal(row1.source, "roi-watchdog");
  assert.equal(row1.ok, false);
  assert.equal(row1.summary.alerted.length, 4);
  assert.ok(row1.summary.fingerprint);

  // 30 minutes later, same problems → no new post, still recorded.
  row1.created_at = iso(NOW);
  const r2 = await quiet(() => W.runWatchdog({ now: NOW + 30 * MIN }));
  assert.equal(posts.length, 1, "deduped");
  assert.equal(r2.fresh, 0);
  assert.equal(r2.ongoing, 4);

  // A NEW problem appears → one post with only that problem.
  db.roi_event_sms.push({ id: "s1", team_id: "t1", email_type: "action_item", status: "error", reason: "all_recipients_failed", recipients: [{ error: "twilio 401 code 20003" }], created_at: iso(NOW + 50 * MIN) });
  db.roi_cron_runs.at(-1).created_at = iso(NOW + 30 * MIN);
  await quiet(() => W.runWatchdog({ now: NOW + 60 * MIN }));
  assert.equal(posts.length, 2);
  assert.match(posts[1], /1 new email-tracker problem\b/);
  assert.match(posts[1], /SMS failing on Twilio auth/);
  assert.match(posts[1], /Still open, already alerted in the last 6h: 4/);
  assert.ok(!posts[1].includes("Daily digest missing"));
});

test("runner: with no Slack token the alert is logged but not marked sent, so it posts once a token is set", async () => {
  const db = { roi_live_departments: [], roi_rooftop_config: [], roi_recipients: [], roi_digest_runs: [], roi_event_emails: [], roi_event_sms: [],
    roi_cron_runs: [{ id: "c1", source: "roi-email-daily", ok: true, created_at: iso(NOW - 5 * H) }] };
  setup(db);
  process.env.SLACK_BOT_TOKEN = "";
  const posts = [];
  installSlack(posts);
  const r = await quiet(() => W.runWatchdog({ now: NOW }));
  assert.equal(posts.length, 0);
  assert.deepEqual(r.alerted, []);
  process.env.SLACK_BOT_TOKEN = "xoxb-fake";
  db.roi_cron_runs.at(-1).created_at = iso(NOW);
  await quiet(() => W.runWatchdog({ now: NOW + 30 * MIN }));
  assert.equal(posts.length, 1, "posted on the first run with a token");
});

test("runner: a table it cannot read becomes a reported problem instead of a crash", async () => {
  const db = { roi_live_departments: [], roi_rooftop_config: [], roi_recipients: [], roi_digest_runs: [], roi_event_emails: [], roi_cron_runs: [] }; // roi_event_sms missing
  setup(db);
  const fake = require.cache[SUPABASE].exports;
  require.cache[SUPABASE].exports = { createClient: () => { const c = fake.createClient(); const from = c.from; c.from = (t) => (t === "roi_event_sms" ? { select: () => { const b = { in: () => b, eq: () => b, gte: () => b, lt: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) }; return b; } } : from(t)); return c; } };
  const posts = [];
  installSlack(posts);
  const r = await quiet(() => W.runWatchdog({ now: NOW }));
  assert.ok(r.problems.some((p) => p.key === "w:roi_event_sms (queued)"));
  assert.match(posts[0], /Watchdog could not read/);
});
