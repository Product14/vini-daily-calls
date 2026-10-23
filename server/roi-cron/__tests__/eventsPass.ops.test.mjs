/* Events-pass operations: the overdue headline, closed days, the MTD strip window, the orphan reaper,
 * roi_cron_runs, feed paging, and the shared event keys (B5, B6, B7, B8, B9, B10, B12, B17).
 *
 * Regression guards (2026-10-09 audit):
 *   A3-07 — the overdue "N pending" was the length of up to 2,000 paged rows filtered after a per-lead
 *           collapse: I 40 Autos read 1,037 against 4,138 overdue leads.
 *   A3-17 — 28 overdue digests went out on a closed Sunday through the fallback hours.
 *   A3-10 — the appointment email's MTD strip excluded today (UTC month, exclusive end=today).
 *   A3-18 / A5-07 — a pass killed between claim and send left `queued` rows that consumed the event.
 *   A5-06 — no events pass wrote roi_cron_runs, so a dead pipeline was invisible.
 *   A3-05 — the call feed's LIMIT 50 dropped the older calls of a burst, silently.
 *   A4 F13 / A1 F23 — tracker keys never matched cron keys; the call key used the poll's day.
 *
 * Offline. Run: node --test server/roi-cron/__tests__/eventsPass.ops.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { load, installFetch, quiet, config, recipient, rowsOf, inMinutes } from "./eventsHarness.mjs";

const require = createRequire(import.meta.url);
const TEAM = "teamops01";
const TZ = "America/Chicago";
const localNow = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { weekday: g("weekday").toLowerCase(), hour: Number(g("hour")) % 24 };
};
const openTodayAtThisHour = () => { const { weekday, hour } = localNow(); return { [weekday]: { is_working: true, start_time: `${String(hour).padStart(2, "0")}:00`, end_time: "23:59" } }; };
const tablesFor = (cfg, extra = {}) => ({
  roi_live_departments: [{ team_id: TEAM, department: "sales", dry_run: false, is_live: true }],
  roi_rooftop_config: [config(TEAM, { timezone: TZ, ...cfg })],
  roi_recipients: [recipient(TEAM, "bdc@rooftoptest.com", { sales: true })],
  roi_event_emails: [], roi_event_sms: [], roi_cron_runs: [], ...extra,
});
const overdueItems = [
  { id: "ai1", leadId: "lead_1", customer: "Ana", intent: "SALES_SCHEDULE_APPOINTMENT", dueAt: "2026-10-01T15:00:00Z" },
  { id: "ai2", leadId: "lead_2", customer: "Ben", intent: "sales_left_voicemail", dueAt: "2026-10-02T15:00:00Z" },
  { id: "ai3", leadId: "lead_3", customer: "Cy", intent: "REQUEST_CALLBACK", dueAt: "2026-10-03T15:00:00Z" },
];

test("B5: the overdue headline is ONE uncapped lead count from ClickHouse, intent filter in SQL, labelled as leads", async () => {
  const tables = tablesFor({ overdue: true, working_hours: openTodayAtThisHour() });
  const { runner, log } = load(tables);
  installFetch(log, { actionItems: (t, d, scope) => (scope === "overdue" ? { actionItems: overdueItems, hasMore: false } : null), chCount: { overdue: 4138, open: 5012 } });
  await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 1);
  assert.equal(log.mail[0].subject, `Overdue follow-ups: 4138 leads pending · Rooftop ${TEAM}`);
  const html = log.mail[0].templateData.HTMLdata;
  assert.match(html, /4,138 leads with follow-ups past SLA/);
  assert.match(html, /5,012 leads with open action items rooftop-wide/);
  const countSql = log.ch.find((q) => q.includes("uniqExactIf(lead_id"));
  assert.ok(countSql.includes("NOT IN ('sales_lost_lead','sales_left_voicemail','service_left_voicemail')"), "intent filter is in the SQL");
  assert.ok(countSql.includes("_peerdb_is_deleted=1"), "raw PeerDB deletes are excluded");
  assert.ok(!log.api.some((a) => a.path.includes("scope=open")), "the open backlog is no longer paged just to count it");
  assert.doesNotMatch(html, /Ben/, "a voicemail-intent lead is not listed");
});

test("B5: without ClickHouse the paged feed count is the fallback", async () => {
  const tables = tablesFor({ overdue: true, working_hours: openTodayAtThisHour() });
  const { runner, log } = load(tables);
  installFetch(log, { actionItems: (t, d, scope) => ({ actionItems: scope === "overdue" ? overdueItems : overdueItems.slice(0, 1), hasMore: false }), chCount: null });
  await quiet(() => runner.runOnce());
  assert.equal(log.mail[0].subject, `Overdue follow-ups: 2 leads pending · Rooftop ${TEAM}`);
});

test("B6: no overdue digest on the dealer's CLOSED day; an unknown schedule still uses the fallback hour", async () => {
  const { weekday, hour } = localNow();
  const env = { EVENT_OVERDUE_MORNING_FALLBACK_HOUR: String(hour), EVENT_OVERDUE_EOD_FALLBACK_HOUR: "99" };
  let tables = tablesFor({ overdue: true, working_hours: { [weekday]: { is_working: false, start_time: "09:00", end_time: "17:00" } } });
  let h = load(tables, env);
  installFetch(h.log, { actionItems: () => ({ actionItems: overdueItems, hasMore: false }), chCount: { overdue: 3, open: 3 } });
  const out = await quiet(() => h.runner.runOnce());
  assert.equal(h.log.mail.length, 0);
  assert.equal(out.overdue_skipped_closed, 1);
  assert.ok(!h.log.api.some((a) => a.path.includes("scope=overdue")), "nothing fetched on a closed day");
  // unknown schedule (no config, ClickHouse doesn't know the rooftop) → fallback hour → sends
  tables = tablesFor({ overdue: true, working_hours: null });
  h = load(tables, env);
  installFetch(h.log, { actionItems: () => ({ actionItems: overdueItems, hasMore: false }), chCount: { overdue: 3, open: 3 } });
  await quiet(() => h.runner.runOnce());
  assert.equal(h.log.mail.length, 1);
});

test("B7: the MTD strip asks for the STORE-LOCAL month including today (end exclusive = local tomorrow)", async () => {
  const tables = tablesFor({ appt: true });
  const { runner, log } = load(tables);
  assert.deepEqual(runner.mtdWindow("America/Los_Angeles", "2026-10-01T05:00:00Z"), { start: "2026-09-01", end: "2026-10-01" }, "still Sep 30 in LA");
  assert.deepEqual(runner.mtdWindow("America/New_York", "2026-10-31T15:00:00Z"), { start: "2026-10-01", end: "2026-11-01" });
  assert.deepEqual(runner.mtdWindow("America/Chicago", "2026-10-01T06:00:00Z"), { start: "2026-10-01", end: "2026-10-02" }, "the 1st includes the 1st");
  installFetch(log, {
    meetings: () => [{ id: "meeting_m1", leadId: "lead_m1", customer: "Dee", when: inMinutes(600), status: "scheduled" }],
    chMeetings: () => [{ rowId: "6ac000000000000000000009", meetingId: "meeting_m1", leadId: "lead_m1", source: "spyne", metaSource: "", status: "scheduled", serviceType: "sales", startTime: inMinutes(600), createdAt: inMinutes(-1), isActive: 1, deleted: 0 }],
  });
  await quiet(() => runner.runOnce());
  const want = runner.mtdWindow(TZ);
  const call = log.api.find((a) => a.path.startsWith("/api/reports"));
  assert.ok(call.path.includes(`start=${want.start}&end=${want.end}`), call.path);
});

test("B8: queued rows older than 15 min are marked not_sent/pass_killed — never resent, other rooftops untouched", async () => {
  const old = new Date(Date.now() - 30 * 60000).toISOString(), fresh = new Date(Date.now() - 5 * 60000).toISOString();
  const tables = tablesFor({}, {
    roi_event_emails: [
      { id: "q-old", team_id: TEAM, email_type: "post_conversation", event_key: "call:lead:x:2026-10-07:t1", status: "queued", created_at: old },
      { id: "q-fresh", team_id: TEAM, email_type: "post_conversation", event_key: "call:lead:y:2026-10-07:t1", status: "queued", created_at: fresh },
      { id: "q-other", team_id: "someoneelse", email_type: "post_conversation", event_key: "call:lead:z:2026-10-07:t1", status: "queued", created_at: old },
      { id: "s-old", team_id: TEAM, email_type: "post_appointment", event_key: "meeting_x", status: "sent", created_at: old },
    ],
    roi_event_sms: [{ id: "sq-old", team_id: TEAM, email_type: "action_item", event_key: "lead:a:b", status: "queued", created_at: old }],
  });
  const { runner, log } = load(tables);
  installFetch(log, {});
  const out = await quiet(() => runner.runOnce());
  const by = (id) => [...tables.roi_event_emails, ...tables.roi_event_sms].find((r) => r.id === id);
  assert.deepEqual([by("q-old").status, by("q-old").reason], ["not_sent", "pass_killed"]);
  assert.equal(by("q-fresh").status, "queued");
  assert.equal(by("q-other").status, "queued", "another shard's rooftop is not touched");
  assert.equal(by("s-old").status, "sent");
  assert.equal(by("sq-old").status, "not_sent");
  assert.equal(out.reaped_orphans, 2);
  assert.equal(log.mail.length, 0, "nothing resent");
});

test("B9: every pass writes roi_cron_runs (per shard), and a crash writes ok:false", async () => {
  let tables = tablesFor({});
  let h = load(tables);
  installFetch(h.log, {});
  await quiet(() => h.runner.runOnce({ shard: 1, shards: 4 }));
  await quiet(() => h.runner.runOnce());
  const [a, b] = tables.roi_cron_runs;
  assert.equal(a.source, "roi-events-shard-1-of-4");
  assert.equal(b.source, "roi-events");
  assert.equal(b.ok, true);
  for (const k of ["startedAt", "finishedAt", "elapsedMs", "targets", "unreached", "sent", "errors", "capped"]) assert.ok(k in b.summary, k);
  tables = tablesFor({});
  tables.__selectError = { roi_live_departments: { message: "boom" } };
  h = load(tables);
  installFetch(h.log, {});
  await assert.rejects(quiet(() => h.runner.runOnce({ shard: 0, shards: 4 })));
  assert.equal(tables.roi_cron_runs[0].ok, false);
  assert.equal(tables.roi_cron_runs[0].source, "roi-events-shard-0-of-4");
  assert.match(tables.roi_cron_runs[0].summary.error, /boom/);
});

test("B10: a paging feed is read to the end; an old feed that fills its page is reported as capped", async () => {
  const call = (n, o = {}) => ({ id: `ecr${n}`, leadId: `lead_c${n}`, customer: `C${n}`, channel: "call", direction: "inbound", endedReason: "customer-ended-call",
    summary: "Asked about the Civic", hasActionItem: true, at: inMinutes(-1), ...o });
  let tables = tablesFor({ conv: true });
  let h = load(tables);
  installFetch(h.log, { conversations: (t, ch, p) => (ch !== "call" ? null : p.get("offset") === "50"
    ? { conversations: [call(2)], hasMore: false }
    : { conversations: [call(1)], hasMore: true, nextOffset: 50 }) });
  let out = await quiet(() => h.runner.runOnce());
  const offsets = h.log.api.filter((a) => a.path.includes("channel=call")).map((a) => new URL("http://x" + a.path).searchParams.get("offset"));
  assert.deepEqual(offsets, [null, "50"]);
  assert.equal(h.log.mail.length, 2, "both pages emailed");
  assert.deepEqual(out.feeds_capped, []);
  tables = tablesFor({ conv: true });
  h = load(tables);
  installFetch(h.log, { conversations: (t, ch) => (ch === "call" ? { conversations: Array.from({ length: 50 }, (_, i) => call(i + 10, { leadId: "lead_same" })) } : null) });
  out = await quiet(() => h.runner.runOnce());
  assert.deepEqual(out.feeds_capped, [`Rooftop ${TEAM} [sales] calls`]);
  assert.ok(tables.roi_cron_runs[0].summary.capped.length === 1, "capped feeds land in roi_cron_runs");
});

test("B12/B17: one key builder; the call key uses the CALL's own dealer-local day", async () => {
  const { eventKeys } = require("../leadCaptureCH.cjs");
  assert.equal(eventKeys.localDay("2026-10-09T04:30:00Z", "America/Chicago"), "2026-10-08");
  assert.equal(eventKeys.call("lead_1", eventKeys.localDay("2026-10-09 04:30:00", "America/Chicago"), eventKeys.callRank({ hasActionItem: true })), "call:lead:lead_1:2026-10-08:t1");
  assert.equal(eventKeys.callRank({ appointmentScheduled: true, hasActionItem: true }), 2);
  assert.equal(eventKeys.actionItem("lead_1", eventKeys.newestItemId(["6ac1", "6ac9", "6ac3"])), "lead:lead_1:6ac9");
  assert.equal(eventKeys.overdue("t1", "sales", "2026-10-09", "am"), "rooftop:t1:sales:overdue:2026-10-09:am");
  assert.equal(eventKeys.sms("lead_1", "2026-10-09"), "sms:lead_1:2026-10-09");
  assert.equal(eventKeys.sms("lead_1", "2026-10-09", "first"), "sms:lead_1:2026-10-09:first");
  assert.equal(eventKeys.chat("conv1", "2026-10-09", "2026-10-09T15:00:00Z"), "chat:conv1:2026-10-09:s2026-10-09T15:00:00Z");
  assert.equal(eventKeys.appointment("meeting_abc"), "meeting_abc");
  // …and the cron's ledger row carries exactly that key: a 11:58 PM call keyed to its own day.
  const tables = tablesFor({ conv: true });
  const { runner, log } = load(tables);
  const at = inMinutes(-1);
  installFetch(log, { conversations: (t, ch) => (ch === "call" ? { conversations: [{ id: "ecrX", leadId: "lead_k", customer: "K", channel: "call", direction: "inbound", summary: "Wants a quote", hasActionItem: true, at }], hasMore: false } : null) });
  await quiet(() => runner.runOnce());
  const row = rowsOf(tables, "roi_event_emails", (r) => r.email_type === "post_conversation")[0];
  assert.equal(row.event_key, eventKeys.call("lead_k", eventKeys.localDay(at, TZ), 1));
});

test("WS-D contract: excludeIntents / excludeSpam / repliedOnly are sent, and the feed's uncapped total backs up ClickHouse", async () => {
  const tables = tablesFor({ overdue: true, conv: true, working_hours: openTodayAtThisHour() });
  const { runner, log } = load(tables, { EVENT_SMS_EOD_HOUR: "0" });
  installFetch(log, {
    actionItems: (t, d, scope) => (scope === "overdue" ? { actionItems: overdueItems, total: 4138, hasMore: false } : { actionItems: [], total: 5012, hasMore: false }),
    chCount: null, // ClickHouse down → the feed's uncapped total is the headline
  });
  await quiet(() => runner.runOnce());
  const paths = log.api.map((a) => a.path);
  assert.ok(paths.filter((p) => p.startsWith("/api/action-items")).every((p) => p.includes("excludeIntents=sales_lost_lead%2Csales_left_voicemail%2Cservice_left_voicemail")));
  assert.ok(paths.some((p) => p.includes("channel=call") && p.includes("excludeSpam=1")));
  assert.ok(paths.some((p) => p.includes("channel=sms") && p.includes("repliedOnly=1")));
  assert.equal(log.mail[0].subject, `Overdue follow-ups: 4138 leads pending · Rooftop ${TEAM}`);
});

test("B19: the Spyne token travels in X-Spyne-Token, never the URL; one logged fallback if reporting-vini ignores the header", async () => {
  const tables = tablesFor({ appt: true });
  const env = { REPORTING_CRON_SECRET: "svc-secret", DIGEST_SPYNE_TOKEN: "spyne-tok" };
  let h = load(tables, env);
  installFetch(h.log, { meetings: () => [] });
  await quiet(() => h.runner.runOnce());
  const m = h.log.api.find((a) => a.path.startsWith("/api/meetings"));
  assert.ok(!m.path.includes("auth_key"), m.path);
  assert.equal(m.headers["X-Spyne-Token"], "spyne-tok");
  assert.equal(m.headers.Authorization, "Bearer svc-secret");
  // an older reporting-vini: degraded without ?auth_key, healthy with it → retried once, then kept
  h = load(tablesFor({ appt: true }), env);
  installFetch(h.log, { meetings: (t, d, p) => (p.get("auth_key") ? [] : { meetings: [], meetingsFeedDegraded: true, meetingsFeedError: "spyne 401" }) });
  const out = await quiet(() => h.runner.runOnce());
  assert.equal(out.meetings_feed_degraded, undefined, "the fallback recovered the feed");
  assert.deepEqual(h.log.api.filter((a) => a.path.startsWith("/api/meetings")).map((a) => a.path.includes("auth_key")), [false, true]);
  // no service secret → the token is the bearer itself (reporting-vini already reads it there)
  h = load(tablesFor({ appt: true }), { DIGEST_SPYNE_TOKEN: "spyne-tok" });
  installFetch(h.log, { meetings: () => [] });
  await quiet(() => h.runner.runOnce());
  const m3 = h.log.api.find((a) => a.path.startsWith("/api/meetings"));
  assert.equal(m3.headers.Authorization, "Bearer spyne-tok");
  assert.ok(!m3.path.includes("auth_key"));
});
