/* post_appointment decides "Vini booked this" from ClickHouse truth, fails CLOSED, and keys every meeting
 * by ONE id (B1, B2, B11 of the 2026-10-09 transactional fix).
 *
 * Regression guard for A3-01 / A5-03: the reporting-vini feed served the Supabase snapshot first (keyed by
 * meeting_id, carrying the dealer's own BDC bookings, no `source` field) and the live Spyne API otherwise
 * (keyed by Mongo _id). The gate `m.source && m.source !== 'spyne'` failed OPEN on the missing field, so
 * BDC bookings were announced as "New appointment", and the same meeting arriving under both ids was
 * emailed twice at 11 dealers.
 *
 * Offline. Run: node --test server/roi-cron/__tests__/eventsAppt.truth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, installFetch, quiet, config, recipient, rowsOf, inMinutes } from "./eventsHarness.mjs";

const TEAM = "teamappt01";
const MONGO = "6ac7f125fafc353322cdac38";
const MID = "meeting_c9c016018fa14c3597c5a97e3f8d4dfb";
const freshTables = () => ({
  roi_live_departments: [{ team_id: TEAM, department: "sales", dry_run: false, is_live: true }],
  roi_rooftop_config: [config(TEAM, { appt: true, name: "Honda of Test" })],
  roi_recipients: [recipient(TEAM, "bdc@hondaoftest.com", { sales: true })],
  roi_event_emails: [], roi_event_sms: [], roi_cron_runs: [],
});
const truthRow = (o = {}) => ({ rowId: MONGO, meetingId: MID, leadId: "lead_1", source: "spyne", metaSource: "", status: "scheduled",
  serviceType: "sales", startTime: inMinutes(60 * 26), createdAt: inMinutes(-3), isActive: 1, deleted: 0, ...o });
const feedRow = (id, o = {}) => ({ id, leadId: "lead_1", customer: "Ana Ruiz", phone: "+15175550100", when: inMinutes(60 * 26), status: "scheduled", ...o });
const chFrom = (rows) => (ids) => rows.filter((r) => ids.includes(r.rowId) || ids.includes(r.meetingId) || ids.includes(r.leadId));
const apptRows = (tables) => rowsOf(tables, "roi_event_emails", (r) => r.email_type === "post_appointment");

test("live-path id (Mongo _id) → emailed ONCE under the canonical meeting_id, the _id reserved as an alias", async () => {
  const tables = freshTables();
  const { runner, log } = load(tables);
  installFetch(log, { meetings: () => [feedRow(MONGO)], chMeetings: chFrom([truthRow()]) });
  await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 1);
  const rows = apptRows(tables);
  const sent = rows.find((r) => r.status === "sent");
  assert.equal(sent.event_key, MID, "canonical key is the meeting_id");
  const alias = rows.find((r) => r.event_key === MONGO);
  assert.ok(alias, "the Mongo _id is claimed too");
  assert.equal(alias.status, "suppressed");
  assert.equal(alias.reason, `alias_of:${MID}`);
  // B11: Vini-booked is now confirmed, so subject + chip say so.
  assert.equal(log.mail[0].subject, "Vini booked an appointment · Honda of Test");
  assert.match(log.mail[0].templateData.HTMLdata, /Booked by Vini/);
});

test("the same meeting arriving later under the OTHER id (snapshot path) is not emailed again", async () => {
  const tables = freshTables();
  const { runner, log } = load(tables);
  let pass = 0;
  installFetch(log, { meetings: () => [feedRow(pass === 0 ? MONGO : MID)], chMeetings: chFrom([truthRow()]) });
  await quiet(() => runner.runOnce());
  pass = 1;
  const out = await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 1, "one email across both id spaces");
  assert.ok(out.skipped_dupe >= 1);
});

test("a meeting emailed under its _id BEFORE this deploy is not re-sent under the meeting_id", async () => {
  const tables = freshTables();
  tables.roi_event_emails.push({ id: "old-1", team_id: TEAM, email_type: "post_appointment", event_key: MONGO, status: "sent", created_at: inMinutes(-10) });
  const { runner, log } = load(tables);
  installFetch(log, { meetings: () => [feedRow(MID)], chMeetings: chFrom([truthRow()]) });
  await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 0);
  assert.equal(apptRows(tables).length, 1, "no new row claimed");
});

test("FAIL CLOSED: a meeting ClickHouse can't find is not emailed and not claimed — the next pass sends it", async () => {
  const tables = freshTables();
  const { runner, log } = load(tables);
  let visible = false;
  installFetch(log, { meetings: () => [feedRow(MONGO)], chMeetings: (ids) => (visible ? chFrom([truthRow()])(ids) : []) });
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.appt_skipped_unverified, 1);
  assert.equal(log.mail.length, 0);
  assert.equal(apptRows(tables).length, 0, "nothing claimed, so nothing is burned");
  visible = true; // replication caught up
  await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 1);
});

test("FAIL CLOSED: ClickHouse unreachable → no appointment email, counted", async () => {
  const tables = freshTables();
  const { runner, log } = load(tables);
  installFetch(log, { meetings: () => [feedRow(MONGO)], chMeetingsFail: true });
  const out = await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 0);
  assert.equal(out.appt_truth_unavailable, 1);
  assert.equal(apptRows(tables).length, 0);
});

test("a BDC booking from the snapshot (no `source` on the feed) is skipped — source comes from ClickHouse", async () => {
  const tables = freshTables();
  const { runner, log } = load(tables);
  installFetch(log, { meetings: () => [feedRow(MID)], chMeetings: chFrom([truthRow({ source: "bdc" })]) });
  const out = await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 0);
  assert.equal(out.appt_skipped_not_spyne, 1);
});

test("meta.source warm_transfer AND callback rows are not Vini's bookings", async () => {
  for (const metaSource of ["warm_transfer", "callback"]) {
    const tables = freshTables();
    const { runner, log } = load(tables);
    installFetch(log, { meetings: () => [feedRow(MID)], chMeetings: chFrom([truthRow({ metaSource })]) });
    const out = await quiet(() => runner.runOnce());
    assert.equal(log.mail.length, 0, metaSource);
    assert.equal(out.appt_skipped_not_ours, 1, metaSource);
  }
});

test("B2: a cancelled row (ClickHouse status) and a past slot are never a new appointment", async () => {
  for (const [o, reason] of [[{ status: "cancellation_requested" }, "appt_skipped_cancelled"], [{ startTime: inMinutes(-60 * 24 * 400) }, "appt_skipped_past"]]) {
    const tables = freshTables();
    const { runner, log } = load(tables);
    const t = truthRow(o);
    installFetch(log, { meetings: () => [feedRow(MID, { when: t.startTime, status: "scheduled" })], chMeetings: chFrom([t]) });
    const out = await quiet(() => runner.runOnce());
    assert.equal(log.mail.length, 0, reason);
    assert.equal(out[reason], 1, reason);
  }
});

test("B2: a second booking row for the same lead + slot is a duplicate even in a LATER pass; a cancelled twin is a reschedule", async () => {
  const slot = inMinutes(60 * 30);
  const first = truthRow({ rowId: "6acaaaaaaaaaaaaaaaaaaaa1", meetingId: "meeting_first", startTime: slot, createdAt: inMinutes(-20) });
  const second = truthRow({ rowId: "6acaaaaaaaaaaaaaaaaaaaa2", meetingId: "meeting_second", startTime: slot, createdAt: inMinutes(-2) });
  // (a) twin still valid → the later row is skipped
  let tables = freshTables();
  let h = load(tables);
  installFetch(h.log, { meetings: () => [feedRow("meeting_second", { when: slot })], chMeetings: chFrom([first, second]) });
  let out = await quiet(() => h.runner.runOnce());
  assert.equal(h.log.mail.length, 0);
  assert.equal(out.appt_skipped_slot_dupe, 1);
  // (b) the earlier twin was cancelled → this one IS the booking
  tables = freshTables();
  h = load(tables);
  installFetch(h.log, { meetings: () => [feedRow("meeting_second", { when: slot })], chMeetings: chFrom([{ ...first, status: "cancelled" }, second]) });
  out = await quiet(() => h.runner.runOnce());
  assert.equal(h.log.mail.length, 1);
});
