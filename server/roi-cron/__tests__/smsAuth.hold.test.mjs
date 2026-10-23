/* A Twilio AUTH failure holds the SMS channel without burning the event, and SMS_DRY_RUN parses like
 * DRY_RUN (B4, B15).
 *
 * Regression guard for A3-02 / A5-05 / F5: every dealer SMS failed with Twilio 401 (code 20003) from
 * 2026-10-02, and because the roi_event_sms row was claimed before the send, each failed event's dedupe
 * key was consumed — fixing the credential would never have delivered any of them. And A5-13: the
 * documented `SMS_DRY_RUN=0` kept SMS dry while the same setting made email live.
 *
 * Offline. Run: node --test server/roi-cron/__tests__/smsAuth.hold.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { load, installFetch, quiet, config, recipient, rowsOf, inMinutes } from "./eventsHarness.mjs";

const require = createRequire(import.meta.url);
const TEAM = "teamsmsauth";
const tablesFor = () => ({
  roi_live_departments: [{ team_id: TEAM, department: "sales", dry_run: false, is_live: true }],
  roi_rooftop_config: [config(TEAM, { appt: true, sms: true })],
  roi_recipients: [recipient(TEAM, "gm@rooftoptest.com", { sales: true, sms: true, phone: "+15175550123" })],
  roi_event_emails: [], roi_event_sms: [], roi_cron_runs: [],
});
const meeting = (n) => ({ id: `meeting_${n}`, leadId: `lead_${n}`, customer: `Customer ${n}`, phone: "+15175550100", when: inMinutes(60 * 30 + n), status: "scheduled" });
const truth = (ids) => ids.filter((i) => i.startsWith("meeting_")).map((id) => ({ rowId: `6ac${id.slice(8).padStart(21, "0")}`, meetingId: id, leadId: `lead_${id.slice(8)}`,
  source: "spyne", metaSource: "", status: "scheduled", serviceType: "sales", startTime: inMinutes(60 * 30), createdAt: inMinutes(-2), isActive: 1, deleted: 0 }));
const AUTH_401 = () => ({ status: 401, body: { code: 20003, message: "Authenticate", more_info: "https://www.twilio.com/docs/errors/20003", status: 401 } });

test("B4: a 401 leaves the SMS re-claimable, stops texting for the pass, and the next pass delivers it", async () => {
  const tables = tablesFor();
  const { runner, log } = load(tables, { SMS_DRY_RUN: "0" });
  let twilio = AUTH_401;
  installFetch(log, { meetings: () => [meeting(1), meeting(2)], chMeetings: truth, twilio: (b) => twilio(b) });
  const out = await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 2, "email is unaffected");
  assert.equal(log.twilio.length, 1, "one 401, then the channel is held for the rest of the pass");
  assert.equal(out.sms_held_auth, 2);
  assert.equal(out.sms_errors, 0, "an auth hold is not counted as a failed send");
  const sms = rowsOf(tables, "roi_event_sms");
  assert.equal(sms.length, 1, "only the attempted event was claimed");
  assert.equal(sms[0].status, "error");
  assert.equal(sms[0].reason, "twilio_auth");
  assert.ok(log.slack.some((b) => /auth/i.test(b)), "the auth failure is alerted");

  // credential fixed → the very same events go out on the next pass (no re-send job: the feed still has them)
  twilio = () => ({ status: 201, body: { sid: "SMok" } });
  await quiet(() => runner.runOnce());
  assert.equal(log.mail.length, 2, "no duplicate email");
  const after = rowsOf(tables, "roi_event_sms");
  assert.equal(after.length, 2);
  assert.ok(after.every((r) => r.status === "sent"), JSON.stringify(after.map((r) => [r.event_key, r.status, r.reason])));
});

test("B4: any other Twilio failure still consumes the claim (no retry storm on a bad number)", async () => {
  const tables = tablesFor();
  const { runner, log } = load(tables, { SMS_DRY_RUN: "0" });
  let calls = 0;
  installFetch(log, { meetings: () => [meeting(1)], chMeetings: truth, twilio: () => { calls++; return { status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number" } }; } });
  const out = await quiet(() => runner.runOnce());
  assert.equal(out.sms_errors, 1);
  const row = rowsOf(tables, "roi_event_sms")[0];
  assert.equal(row.status, "error");
  assert.equal(row.reason, "all_recipients_failed");
  await quiet(() => runner.runOnce());
  assert.equal(calls, 1, "not retried");
});

test("B15: SMS_DRY_RUN accepts 0/false (any case) as live and defaults to dry", async () => {
  const SEND = require.resolve("../sendSms.cjs");
  const parse = (v) => {
    delete require.cache[SEND];
    if (v === undefined) delete process.env.SMS_DRY_RUN; else process.env.SMS_DRY_RUN = v;
    return require(SEND).SMS_DRY_RUN;
  };
  assert.equal(parse(undefined), true);
  assert.equal(parse(""), true);
  assert.equal(parse("1"), true);
  assert.equal(parse("true"), true);
  assert.equal(parse("0"), false);
  assert.equal(parse("false"), false);
  assert.equal(parse(" FALSE "), false);
  const { isAuthError } = require(SEND);
  assert.equal(isAuthError(new Error('twilio 401: {"code":20003,"message":"Authenticate"}')), true);
  assert.equal(isAuthError(new Error('twilio 400: {"code":21211}')), false);
  delete process.env.SMS_DRY_RUN;
  delete require.cache[SEND];
});
