/* The tracker's drill-down rows carry the cron's own ledger key, and its "eligible" population applies the
 * cron's gates (B12, B13).
 *
 * Regression guard for A4 F13 (drill-down keys `<uuid>` / `sms:<uuid>` / `lead:<id>` never matched the
 * cron's `call:lead:…:t1` / `sms:<lead>:<day>` / `lead:<lead>:<item>`, so every row read "eligible" and
 * "Send to customer" duplicated sent email), A3-12 (eligible counted voicemails, unreplied and opt-out
 * threads, cancelled and callback appointments) and A5-25 (the manual action-item path filtered
 * is_completed BEFORE the per-_id dedupe and ignored the non-actionable intents).
 *
 * Offline: ClickHouse is a fake that records the SQL and answers by query shape.
 * Run: node --test server/roi-cron/__tests__/eventsPreview.keys.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
Object.assign(process.env, { CLICKHOUSE_HOST: "ch.test", CLICKHOUSE_PASSWORD: "fake", CLICKHOUSE_USER: "fake" });
const { eventKeys } = require("../leadCaptureCH.cjs");
const P = await import("../eventPreviewCH.js");

const TZ = "America/Chicago";
let sqls = [];
function installCH(answer) {
  sqls = [];
  globalThis.fetch = async (url, init = {}) => {
    const sql = String(init.body || "");
    sqls.push(sql);
    const rows = answer(sql) || [];
    return new Response(rows.map((r) => JSON.stringify(r)).join("\n"), { status: 200 });
  };
}

test("every post_conversation row (call, SMS, chat) carries the cron's exact key", async () => {
  installCH((sql) => {
    if (sql.includes("FROM dealer_leads.endcallreports e") && sql.includes(" rnk,")) {
      return [
        { eventKey: "call-uuid-1", leadKey: "lead_a", title: "Civic", createdAt: "2026-10-09 04:30:00", localDay: "2026-10-08", rnk: 1, direction: "inbound", customer: "Ana", phone: "+15175550100" },
        { eventKey: "call-uuid-2", leadKey: "ecr_row_9", title: "Quote", createdAt: "2026-10-08 20:00:00", localDay: "2026-10-08", rnk: 2, direction: "outbound", customer: "Ben", phone: "" },
      ];
    }
    if (sql.includes("type='sms'") && sql.includes("replyDay")) return [{ eventKey: "conv_s1", leadKey: "lead_s", createdAt: "2026-10-07 10:00:00", customer: "Sam", phone: "+15175550111", replyDay: "2026-10-08", direction: "outbound" }];
    if (sql.includes("type='chat'") && sql.includes("b.ats")) {
      return [{ eventKey: "conv_c1", createdAt: "2026-10-08 15:00:00", customer: "Vic", phone: "+15175550122",
        ats: ["2026-10-08T15:00:00Z", "2026-10-08T15:01:00Z", "2026-10-08T18:00:00Z"], atypes: ["ai", "human", "ai"], dirs: ["out", "in", "out"] }];
    }
    return [];
  });
  const rows = await P.listEventsCH({ teamId: "team1", department: "sales", emailType: "post_conversation", tz: TZ });
  const by = Object.fromEntries(rows.map((r) => [r.eventKey, r]));
  assert.equal(by["call-uuid-1"].cronEventKey, eventKeys.call("lead_a", "2026-10-08", 1));
  assert.equal(by["call-uuid-2"].cronEventKey, "call:lead:ecr_row_9:2026-10-08:t2", "a lead-less call keys on its row id, as the cron does");
  assert.equal(by["sms:conv_s1"].cronEventKey, "sms:lead_s:2026-10-08");
  // 15:00/15:01 is one session with a visitor reply; 18:00 (AI only, after a 3h lull) is not emailed.
  assert.equal(by["chat:conv_c1"].cronEventKey, "chat:conv_c1:2026-10-08:s2026-10-08T15:00:00Z");
  assert.deepEqual(by["chat:conv_c1"].cronEventKeys, ["chat:conv_c1:2026-10-08:s2026-10-08T15:00:00Z"]);
  // B13 — the call population is the cron's: voicemail, actionable, outbound-reply, substance, spam.
  const callSql = sqls.find((q) => q.includes(" rnk,"));
  for (const frag of ["'voicemail'", "position(", "report_actionItems", "='outbound' AND NOT", "match(", "'spam'", "isCallbackFromOutbound=1", "LIKE 'sales%'"]) {
    assert.ok(callSql.includes(frag), `call gate missing: ${frag}`);
  }
  // SMS: a real reply (opt-out keywords excluded) and the LEAD's own department, not a call-inferred one.
  const smsSql = sqls.find((q) => q.includes("replyDay"));
  assert.ok(smsSql.includes("'STOP'") && smsSql.includes("NOT IN"), "opt-out keywords excluded");
  assert.ok(smsSql.includes("FROM dealer_leads.leads") && smsSql.includes("svc"), "lead service_type decides the department");
  assert.ok(!smsSql.includes("callDetails_agentInfo_agentType"), "no call-inferred department");
});

test("appointments: the cron's gates (callback, cancelled, replayed history, one per slot) and a meeting_id key", async () => {
  installCH((sql) => (sql.includes("FROM dealer_leads.meetings AS m FINAL")
    ? [{ eventKey: "meeting_abc", rowId: "6ac000000000000000000001", startTime: "2026-10-12 15:00:00", intent: "schedule_appointment", serviceType: "sales", status: "scheduled", mtz: TZ, createdAt: "2026-10-08 15:00:00", direction: "inbound", customer: "Ana", phone: "+15175550100" }]
    : []));
  const rows = await P.listEventsCH({ teamId: "team1", department: "sales", emailType: "post_appointment", tz: TZ });
  assert.equal(rows[0].cronEventKey, "meeting_abc");
  const sql = sqls.find((q) => q.includes("dealer_leads.meetings AS m FINAL"));
  for (const frag of ["'warm_transfer','callback'", "'cancelled','cancellation_requested'", "INTERVAL 6 HOUR", "LIMIT 1 BY ifNull(m.lead_id, m._id), m.meeting_start_time"]) {
    assert.ok(sql.includes(frag), `appointment gate missing: ${frag}`);
  }
});

test("action items: keyed lead:<lead>:<newest item>; state and intent filters run AFTER the per-_id dedupe", async () => {
  installCH((sql) => (sql.includes("newestId") ? [{ leadId: "lead_q", nItems: 2, createdAt: "2026-10-08 12:00:00", newestId: "6ac9", direction: "inbound", customer: "Q", phone: "+15175550133" }] : []));
  const rows = await P.listEventsCH({ teamId: "team1", department: "sales", emailType: "action_item", tz: TZ });
  assert.equal(rows[0].cronEventKey, "lead:lead_q:6ac9");
  const sql = sqls.find((q) => q.includes("newestId"));
  const dedupe = sql.indexOf("LIMIT 1 BY _id"), completed = sql.indexOf("ifNull(is_completed,0)=0");
  assert.ok(dedupe > 0 && completed > dedupe, "is_completed is tested on the LATEST version of each item");
  assert.ok(sql.includes("NOT IN ('sales_lost_lead','sales_left_voicemail','service_left_voicemail')"));
  assert.ok(sql.includes("lower(ifNull(intent,''))!='custom'"));
  assert.ok(sql.includes("_peerdb_is_deleted=1"));
  // overdue rows point at the rooftop digest's keys for the dealer's today
  installCH((sql) => (sql.includes("newestId") ? [{ leadId: "lead_q", nItems: 1, createdAt: "2026-10-01 12:00:00", newestId: "6ac1", direction: "inbound", customer: "Q", phone: "" }] : []));
  const ov = await P.listEventsCH({ teamId: "team1", department: "sales", emailType: "action_item_overdue", tz: TZ });
  const today = eventKeys.localDay(null, TZ);
  assert.deepEqual(ov[0].cronEventKeys, [`rooftop:team1:sales:overdue:${today}:am`, `rooftop:team1:sales:overdue:${today}:eod`]);
});

test("the manual action-item render uses the same dedupe-then-filter population", async () => {
  installCH(() => []);
  const html = await P.previewEventCH({ teamId: "team1", department: "sales", emailType: "action_item", eventKey: "lead:lead_q:6ac9", tz: TZ, strict: true });
  assert.equal(html, null, "nothing open and actionable → nothing to send");
  const sql = sqls.find((q) => q.includes("dealer_leads.actionItems") && q.includes("lead_id='lead_q'"));
  assert.ok(sql.indexOf("LIMIT 1 BY _id") < sql.indexOf("ifNull(is_completed,0)=0"));
  assert.ok(sql.includes("sales_left_voicemail"));
});

test("the key builder is re-exported for the tracker", () => {
  assert.equal(P.eventKeys, eventKeys);
});
