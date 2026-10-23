/* SMS-thread summaries follow the LEAD's department; held departments stay held for SMS and chat alike;
 * a lone "STOP" is not a conversation; and nothing is texted that its email refused (B3, B14, B16).
 *
 * Regression guard for:
 *   A3-03 / A5-23 — the once-per-team SMS poll ran inside whichever department row came first and every
 *     summary went to THAT department: 105 of 468 (22%) landed in the other team's inbox.
 *   A5-04 — chat took the visiting pass's dry_run, so 32 chats reached departments a CSM had held.
 *   A3-11 — 99 SMS summary emails were about an opt-out keyword and nothing else.
 *   A5-14 — an event SMS went out for a job whose email the no-value gate had held.
 *
 * Offline. Run: node --test server/roi-cron/__tests__/smsRouting.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, installFetch, quiet, config, recipient, rowsOf, inMinutes } from "./eventsHarness.mjs";

const TEAM = "teamsms01";
const ENV = { EVENT_SMS_EOD_HOUR: "0" }; // every pass is "end of day", so the daily SMS digest runs now
const bubble = (authorType, body, minsAgo) => ({ authorType, body, status: authorType === "human" ? "received" : "delivered", direction: authorType === "human" ? "inbound" : "outbound", at: inMinutes(-minsAgo) });
const thread = (id, leadId, o = {}) => ({ id, leadId, customer: `Customer ${leadId}`, phone: "+15175550111", channel: "sms", dept: "other",
  hasReply: true, sms: [bubble("ai", "Hi, this is Vini", 30), bubble("human", "Is the Civic still available?", 20)], at: inMinutes(-20), ...o });
const tablesFor = ({ serviceLive = true, serviceHeld = true, chat = false } = {}) => ({
  roi_live_departments: [
    { team_id: TEAM, department: "sales", dry_run: false, is_live: true },
    ...(serviceLive ? [{ team_id: TEAM, department: "service", dry_run: serviceHeld, is_live: true }] : []),
  ],
  roi_rooftop_config: [config(TEAM, { conv: true, chat })],
  roi_recipients: [recipient(TEAM, "sales@rooftoptest.com", { sales: true }), recipient(TEAM, "service@rooftoptest.com", { service: true })],
  roi_event_emails: [], roi_event_sms: [], roi_cron_runs: [],
});
const smsRows = (tables) => rowsOf(tables, "roi_event_emails", (r) => String(r.event_key).startsWith("sms:"));
const byLead = (tables, lead) => smsRows(tables).find((r) => r.event_key.startsWith(`sms:${lead}:`));

test("B3: each SMS summary is routed, held and recorded by its LEAD's department", async () => {
  const tables = tablesFor();
  const { runner, log } = load(tables, ENV);
  installFetch(log, {
    conversations: (team, channel) => (channel === "sms" ? { conversations: [
      thread("c1", "lead_sales", { dept: "sales" }),        // feed knows the department (WS-D contract)
      thread("c2", "lead_service"),                           // feed says "other" → ClickHouse lead lookup
      thread("c3", "lead_unknown"),                           // nowhere → the visiting department (sales)
    ], hasMore: false } : { conversations: [], hasMore: false }),
    chLeadDepts: { lead_service: "service" },
  });
  await quiet(() => runner.runOnce());
  const sales = byLead(tables, "lead_sales"), service = byLead(tables, "lead_service"), unknown = byLead(tables, "lead_unknown");
  assert.equal(sales.department, "sales");
  assert.equal(sales.status, "sent");
  assert.equal(service.department, "service", "a service lead is the service department's, whichever row polled it");
  assert.equal(service.status, "suppressed", "…and the service department is held, so it is held");
  assert.equal(service.reason, "dry_run");
  assert.equal(unknown.department, "sales");
  assert.equal(unknown.status, "sent");
  const to = log.mail.map((m) => m.to);
  assert.ok(to.every((t) => t === "sales@rooftoptest.com"), `only sales got mail: ${to}`);
  assert.equal(log.mail.length, 2);
  assert.match(log.mail[0].templateData.HTMLdata + log.mail[1].templateData.HTMLdata, /Vini · Sales/);
});

test("B3: a lead whose department is not live at the rooftop falls back to the live one, and the row says so", async () => {
  const tables = tablesFor({ serviceLive: false });
  const { runner, log } = load(tables, ENV);
  installFetch(log, {
    conversations: (team, channel) => (channel === "sms" ? { conversations: [thread("c2", "lead_service", { dept: "service" })], hasMore: false } : null),
  });
  const out = await quiet(() => runner.runOnce());
  const row = byLead(tables, "lead_service");
  assert.equal(row.status, "sent");
  assert.equal(row.department, "sales");
  assert.equal(row.reason, "dept_fallback:service_not_live");
  assert.equal(out.dept_fallback, 1);
  assert.match(log.mail[0].templateData.HTMLdata, /Vini · Service/, "still labelled with the lead's own department");
});

test("B3: a website chat for a HELD department is held by that department's dry_run, not the visiting pass's", async () => {
  const tables = tablesFor({ chat: true });
  const { runner, log } = load(tables, ENV);
  installFetch(log, {
    conversations: (team, channel) => (channel === "chat" ? { conversations: [{
      id: "chat1", leadId: "lead_chat", customer: "Visitor", channel: "chat", dept: "service", hasReply: true, status: "completed",
      sms: [bubble("ai", "Welcome!", 50), bubble("human", "Can I book an oil change?", 49)], at: inMinutes(-49) }], hasMore: false } : null),
  });
  await quiet(() => runner.runOnce());
  const row = rowsOf(tables, "roi_event_emails", (r) => String(r.event_key).startsWith("chat:"))[0];
  assert.equal(row.department, "service");
  assert.equal(row.status, "suppressed");
  assert.equal(row.reason, "dry_run");
  assert.equal(log.mail.length, 0, "the held service department got no chat email");
});

test("B14: a thread whose only customer reply is an opt-out keyword is not a conversation", async () => {
  const tables = tablesFor({ serviceLive: false });
  const { runner, log } = load(tables, ENV);
  installFetch(log, {
    conversations: (team, channel) => (channel === "sms" ? { conversations: [
      thread("c1", "lead_stop", { dept: "sales", sms: [bubble("ai", "Still shopping?", 30), bubble("human", " stop ", 25)] }),
      thread("c2", "lead_real", { dept: "sales", sms: [bubble("ai", "Still shopping?", 30), bubble("human", "STOP", 25), bubble("human", "actually what's the price?", 20)] }),
      thread("c3", "lead_noreply", { dept: "sales", hasReply: false, sms: [bubble("ai", "Still shopping?", 30)] }),
      thread("c4", "lead_feedsays", { dept: "sales", hasReply: false, sms: [bubble("human", "STOP", 30)] }), // WS-D: hasReply already excludes it
    ], hasMore: false } : null),
  });
  const out = await quiet(() => runner.runOnce());
  assert.equal(byLead(tables, "lead_stop"), undefined);
  assert.ok(byLead(tables, "lead_real"), "a real reply alongside a STOP still counts");
  assert.equal(byLead(tables, "lead_noreply"), undefined);
  assert.equal(byLead(tables, "lead_feedsays"), undefined);
  assert.equal(out.sms_reply_optout_only, 1);
  assert.equal(runner.smsThreadHasRealReply({ hasReply: true, sms: [] }), true, "no visible bubble → trust the feed");
  assert.equal(runner.isRealSmsReply({ authorType: "human", body: "No" }), false);
  assert.equal(runner.isRealSmsReply({ authorType: "human", body: "No thanks, I bought one" }), true);
});

test("B16: an appointment whose email is held as no-value is not texted either", async () => {
  const tables = {
    roi_live_departments: [{ team_id: TEAM, department: "sales", dry_run: false, is_live: true }],
    roi_rooftop_config: [config(TEAM, { appt: true, sms: true })],
    roi_recipients: [recipient(TEAM, "sales@rooftoptest.com", { sales: true, sms: true, phone: "+15175550199" })],
    roi_event_emails: [], roi_event_sms: [], roi_cron_runs: [],
  };
  const { runner, log } = load(tables, { SMS_DRY_RUN: "0" });
  installFetch(log, {
    meetings: () => [{ id: "meeting_empty", leadId: "", customer: "", when: "" }], // nothing to show → no-value
    chMeetings: () => [{ rowId: "6ac000000000000000000001", meetingId: "meeting_empty", leadId: "", source: "spyne", metaSource: "", status: "scheduled", serviceType: "sales", startTime: "", createdAt: "", isActive: 1, deleted: 0 }],
    twilio: () => ({ status: 201, body: { sid: "SM1" } }),
  });
  const out = await quiet(() => runner.runOnce());
  const row = rowsOf(tables, "roi_event_emails", (r) => r.event_key === "meeting_empty")[0];
  assert.equal(row.status, "not_sent");
  assert.equal(row.reason, "no_value");
  assert.equal(log.twilio.length, 0, "no text for an email the anti-churn gate refused");
  assert.equal(out.sms_held_no_value, 1);
});
