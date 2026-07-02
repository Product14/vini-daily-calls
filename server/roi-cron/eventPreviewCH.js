// Live transactional-email preview sourced DIRECTLY from production ClickHouse.
// The reporting-vini API never exposed /api/conversations or /api/action-items
// (they 404), so the tracker's "Latest design" preview reads the real data from
// ClickHouse instead — the same connection the agents dashboard uses.
//
// Join graph (validated):
//   endcallreports.leadId → leads.lead_id → leads.customer_id → customer.name/mobile_number
//   conversationQualities.callId  (AI score · grade · frustrated)
//   callTransferEvents.callId     (warm-transfer dept + reason)
//   report_overview (JSON)        (sentiment · intent · callOutcome · appointment · callback)
//   actionItems (curated tasks)   (the CRM action-item feed — system of record, grouped by lead)
//   meetings (source='spyne')     (Vini-booked appointments)
import { createRequire } from "node:module";
import { runClickhouse, hasClickhouseCreds } from "../agentMetrics.js";
const require = createRequire(import.meta.url);
const T = require("../../src/email/transactionalTemplates.cjs");

// SQL string literal escape (ClickHouse) — defends the team/key params.
const lit = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

// report_summary / report_actionItems arrive as JSON-array text (e.g. ["a","b"] or [""]).
function parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => x && String(x).trim()) : []; }
  catch { return []; }
}
function parseOverview(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function durationSec(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const a = Date.parse(startIso), b = Date.parse(endIso);
  return a && b && b > a ? Math.round((b - a) / 1000) : 0;
}
// human "When" + relative-day for an appointment, in the dealer's tz
function fmtWhen(dt, tz) {
  if (!dt) return { when: "", relDay: "", time: "" };
  const d = new Date(String(dt).replace(" ", "T") + (String(dt).endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return { when: String(dt), relDay: "", time: "" };
  const z = tz || "America/New_York";
  const day = (x) => new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  const today = day(new Date()), that = day(d);
  const tmr = day(new Date(Date.now() + 864e5));
  const relDay = that === today ? "Today" : that === tmr ? "Tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short", month: "short", day: "numeric" }).format(d);
  return { when: relDay + " · " + time, relDay, time };
}

// Identity resolution defends against SharedReplacingMergeTree duplicate rows: a plain any()
// can pick an empty version (lead with no customer_id, customer row with a blank name), which
// is why so many real customers surfaced as "Unknown". anyIf(..., notEmpty(...)) prefers a
// populated value across the duplicate versions.
const IDENTITY_JOINS =
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads GROUP BY lead_id) l ON e.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id";

// Placeholder names the source data stores for unidentified callers (~12k literal "unknown",
// plus "n/a"/"na"/"test"/etc.) — these are NOT real customer names, so treat them as no-name.
const JUNK_NAMES = new Set(["unknown", "unknown caller", "n/a", "na", "none", "null", "test", "-", "."]);
// Display label for a row: real name → phone number → null (a truly anonymous "junk" event with
// neither, which the list drops). Keeps bare "Unknown — Conversation" rows out of a customer-facing list.
const cleanName = (name, phone) => {
  const n = (name || "").trim();
  if (n && !JUNK_NAMES.has(n.toLowerCase())) return n;
  const p = (phone || "").trim();
  return p || null;
};
const displayName = (r) => cleanName(r.customer, r.phone);

async function one(sql) { const rows = await runClickhouse(sql); return rows && rows[0] ? rows[0] : null; }

// ── SMS support ──────────────────────────────────────────────────────────────
// Identity join for the conversations table (its own lead→customer resolution).
const CONV_IDENTITY =
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads GROUP BY lead_id) l ON cv.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer GROUP BY customer_id) cu ON l.cid=cu.customer_id";
const SMS_CONV_SELECT =
  "SELECT cv.conversationId conversationId, cv.leadId leadId, toString(cv.createdAt) at," +
  " ifNull(cv.summary,'') summary, cu.name customer, cu.mobile_number phone FROM dealer_leads.conversations cv" + CONV_IDENTITY;
// Per-lead dept, inferred from that lead's calls (SMS carries no dept of its own).
const LEAD_DEPT_MAP =
  "(SELECT leadId, if(countIf(lower(callDetails_agentInfo_agentType)='service') > countIf(lower(callDetails_agentInfo_agentType)='sales'),'service','sales') dept" +
  " FROM dealer_leads.endcallreports WHERE isTestCall=0 AND __deleted=0 AND createdAt >= now()-INTERVAL 180 DAY GROUP BY leadId)";

// ── Structured action items (dealer_leads.actionItems) ───────────────────────────
// The curated CRM task feed is the SYSTEM OF RECORD for action items — NOT the raw per-call
// report_actionItems notes (uncurated, noisy, no due date / completion state). This matches the
// generator (eventRunner), which already sources action items from reporting-vini /api/action-items
// (the same underlying table). SharedReplacingMergeTree keeps duplicate physical rows, so every
// query collapses to the latest _version per _id BEFORE gating on open/overdue.
const AI_DEPT = "if(service_type='service','service','sales')"; // mirror meetings' dept split
// "2021 Honda Odyssey EX-L" from meta.vehicle_details (year/make/model); '' when the task has none.
const aiVehicle = (col) =>
  "trimBoth(concat(JSONExtractString(" + col + ",'vehicle_details','year'),' '," +
  "JSONExtractString(" + col + ",'vehicle_details','make'),' ',JSONExtractString(" + col + ",'vehicle_details','model')))";
// Per-lead direction inferred from that lead's calls — action items carry no direction of their own
// (most rows have no callSid). Mirrors LEAD_DEPT_MAP; leads with no calls fall back to 'inbound'.
const LEAD_DIR_MAP =
  "(SELECT leadId, if(countIf(positionCaseInsensitive(ifNull(report_inOutType,''),'out')>0) >" +
  " countIf(positionCaseInsensitive(ifNull(report_inOutType,''),'out')=0),'outbound','inbound') dir" +
  " FROM dealer_leads.endcallreports WHERE isTestCall=0 AND __deleted=0 AND createdAt >= now()-INTERVAL 180 DAY GROUP BY leadId)";
// lead → customer identity for an actionItems subquery aliased `a` (exposes `leadId`).
const AI_IDENTITY =
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads GROUP BY lead_id) l ON a.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id";
// One deduped row per OPEN action item, optionally scoped to a team / dept / single lead, and to a
// createdAt window. scope: 'open' (is_completed=0) | 'overdue' (open AND real past due date).
function aiBaseSql({ teamId = null, dept = null, scope = "open", leadKey = null, since = null } = {}) {
  const overdue = scope === "overdue";
  return (
    "SELECT _id, lead_id leadId, team_id, service_type, description, toString(due_date) dueAt, intent, priority," +
    " " + aiVehicle("meta") + " vehicle, createdAt" + // raw DateTime — aliasing toString here would shadow the WHERE/ORDER column
    " FROM dealer_leads.actionItems" +
    " WHERE is_active=1 AND is_completed=0 AND __deleted=0" +
    // Overdue = real past due date. Exclude epoch/zero due_date ("no due date recorded" → not truly
    // overdue; counting those inflated overdue to ~= open).
    (overdue ? " AND due_date < now() AND due_date > '2000-01-01'" : "") +
    (teamId ? " AND team_id=" + lit(teamId) : "") +
    (dept ? " AND " + AI_DEPT + "=" + lit(dept) : "") +
    (leadKey ? " AND lead_id=" + lit(leadKey) : "") +
    // Recency window bounds OPEN items; for OVERDUE the bound is the (past) due_date above, NOT
    // createdAt. Overdue items are created long ago, so gating on createdAt silently dropped ~22% of
    // them (the worst, longest-overdue offenders) — the overdue-undercount bug.
    (since && !overdue ? " AND createdAt >= " + since : "") +
    " ORDER BY _version DESC LIMIT 1 BY _id"
  );
}

// Deduped, chronological SMS thread for one conversation (latest status per message).
async function smsThread(conversationId) {
  if (!conversationId) return { messages: [], failed: 0 };
  const rows = await runClickhouse(
    "SELECT direction, body, status, at FROM (" +
    "SELECT direction, body, status, toString(createdAt) at," +
    " row_number() OVER (PARTITION BY ifNull(messageId, concat(direction,'|',body)) ORDER BY createdAt DESC) rn" +
    " FROM dealer_leads.smsMessages WHERE conversationId=" + lit(conversationId) + " AND notEmpty(body)) WHERE rn=1 ORDER BY at ASC LIMIT 20");
  const failed = rows.filter((r) => String(r.status) === "failed").length;
  return { messages: rows.map((r) => ({ direction: r.direction, body: r.body, status: r.status })), failed };
}
const smsConvLatest = (teamId) => one(SMS_CONV_SELECT + " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) ORDER BY cv.createdAt DESC LIMIT 1");
const smsConvById = (conversationId) => one(SMS_CONV_SELECT + " WHERE cv.conversationId=" + lit(conversationId) + " LIMIT 1");
const smsConvByLead = (teamId, leadId) => (leadId ? one(SMS_CONV_SELECT + " WHERE cv.teamId=" + lit(teamId) + " AND cv.leadId=" + lit(leadId) + " AND cv.type='sms' AND cv.isTest=0 ORDER BY cv.createdAt DESC LIMIT 1") : Promise.resolve(null));

// conversation opts for an SMS conversation (channel:'sms' → template renders the thread).
function smsConvOpts(cv, thread) {
  const firstDir = thread.messages[0] && thread.messages[0].direction;
  return {
    id: cv.conversationId, channel: "sms",
    direction: firstDir === "out" ? "outbound" : "inbound",
    title: "Text conversation", customer: cv.customer, phone: cv.phone, at: cv.at,
    summary: cv.summary || "",
    sms: thread.messages, smsFailed: thread.failed,
  };
}

// Build the conversation opts from a joined endcallreports row (+ quality + transfer).
function convOpts(row, transfer) {
  const ov = parseOverview(row.overview);
  const overall = ov.overall || {};
  const takeaways = parseJsonArray(row.summary);
  const actionItems = parseJsonArray(row.actionItems);
  const appt = ov.appointmentScheduled === "Yes";
  const apptDetails = Array.isArray(ov.appointmentDetails) ? ov.appointmentDetails.filter(Boolean) : [];
  return {
    id: row.callId, channel: "call",
    direction: String(row.direction || "").toLowerCase().indexOf("out") >= 0 ? "outbound" : "inbound",
    title: row.title || "Conversation", customer: cleanName(row.customer, row.phone) || "Customer", phone: row.phone, at: row.at,
    aiScore: row.score != null ? Number(row.score) : undefined, grade: row.grade || undefined, frustrated: Number(row.frustrated) === 1,
    sentiment: overall.sentiment, sentimentScore: overall.sentimentScore,
    intent: overall.customerIntent, callOutcome: ov.callOutcome,
    appointmentScheduled: appt, appointment: appt ? { vehicle: apptDetails[0], when: apptDetails.slice(1).join(" · "), type: ov.appointmentType } : null,
    callbackScheduled: ov.callbackScheduled === "Yes", queryResolved: row.queryResolved === "Yes",
    transfer: transfer ? { department: transfer.requestedDepartment, reason: transfer.reason, name: transfer.requestedName } : null,
    actionItems, keyTakeaways: takeaways,
    recordingUrl: row.recordingUrl || undefined, durationSec: durationSec(row.startedAt, row.endedAt), endedReason: row.endedReason,
  };
}

/**
 * Render ONE transactional email live from ClickHouse. Matches eventKey when possible,
 * else falls back to the most-recent real item for the rooftop (a representative customer).
 * Returns HTML string, or null when no data exists.
 *
 * `strict` (SEND path): when an eventKey is given but doesn't resolve to that exact item, return null
 * instead of substituting a different customer. The "most-recent representative customer" fallback is
 * fine for a PREVIEW, but on the real send path it would email a dealer another customer's PII — so the
 * send endpoint passes strict:true and refuses (404) rather than send the wrong person's data.
 */
export async function previewEventCH({ teamId, department, emailType, eventKey, rooftopName, tz, strict = false }) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server (set CLICKHOUSE_HOST/PASSWORD)");
  if (!teamId) throw new Error("teamId required");
  const dept = department === "service" ? "service" : "sales";
  const useCase = dept === "service" ? "Service" : "Sales";
  const name = rooftopName || teamId;
  const links = { console: "https://console.spyne.ai/converse-ai" };

  if (emailType === "post_conversation") {
    const base =
      "SELECT e.callId callId, e.leadId leadId, e.report_inOutType direction, e.report_title title," +
      " e.report_summary summary, e.report_overview overview, e.report_actionItems actionItems," +
      " e.callDetails_recordingUrl recordingUrl, e.callDetails_startedAt startedAt, e.callDetails_endedAt endedAt," +
      " e.callDetails_endedReason endedReason, e.report_queryResolved queryResolved, toString(e.createdAt) at," +
      " c.name customer, c.mobile_number phone," +
      " q.scorePercentage score, q.overallGrade grade, q.customerFrustrated frustrated" +
      " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
      " LEFT JOIN (SELECT callId, any(scorePercentage) scorePercentage, any(overallGrade) overallGrade, any(customerFrustrated) customerFrustrated FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 30 DAY GROUP BY callId) q ON e.callId=q.callId" +
      " WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_overview)";
    const renderSms = async (cv) => {
      const th = await smsThread(cv.conversationId);
      return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: smsConvOpts(cv, th), links });
    };
    // explicit SMS event → render that text conversation's thread
    if (String(eventKey || "").startsWith("sms:")) {
      const cv = await smsConvById(eventKey.slice(4));
      if (cv) return renderSms(cv);
      if (strict) return null; // explicit SMS event didn't resolve — never substitute another customer
    }
    const order = " ORDER BY e.createdAt DESC LIMIT 1";
    let row = eventKey && !eventKey.startsWith("sms:") ? await one(base + " AND (e.callId=" + lit(eventKey) + " OR e.id=" + lit(eventKey) + ")" + order) : null;
    if (!row && !eventKey) {
      // no explicit event → show whichever is more recent: the latest call or the latest SMS thread
      row = await one(base + order);
      const cv = await smsConvLatest(teamId);
      if (cv && (!row || Date.parse(cv.at) > Date.parse(row.at))) return renderSms(cv);
    }
    if (!row) {
      if (eventKey && strict) return null; // requested event didn't resolve — don't email a different customer
      // matched key found no call, or rooftop has only SMS — fall back to the latest SMS thread
      const cv = await smsConvLatest(teamId);
      if (cv) return renderSms(cv);
      return null;
    }
    const transfer = row.callId ? await one("SELECT requestedDepartment, reason, requestedName FROM dealer_leads.callTransferEvents WHERE callId=" + lit(row.callId) + " ORDER BY createdAt DESC LIMIT 1") : null;
    return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: convOpts(row, transfer), links });
  }

  if (emailType === "post_appointment") {
    const base =
      "SELECT m.lead_id leadId, toString(m.meeting_start_time) startTime, m.intent intent, m.service_type serviceType," +
      " m.status status, m.transportation_option transportation, m.timezone mtz, m.proposed_vins vins, m.source source," +
      " c.name customer, c.mobile_number phone" +
      " FROM dealer_leads.meetings m" +
      " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads GROUP BY lead_id) l ON m.lead_id=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne'";
    const order = " ORDER BY m.created_at DESC LIMIT 1 BY m.meeting_id LIMIT 1";
    let row = eventKey ? await one(base + " AND (m.meeting_id=" + lit(eventKey) + " OR m._id=" + lit(eventKey) + ")" + order) : null;
    if (!row && !(eventKey && strict)) row = await one(base + order); // strict send path: don't substitute another appointment
    if (!row) return null;
    const w = fmtWhen(row.startTime, row.mtz || tz);
    // include the booking text thread when the appointment was set over SMS
    const cv = await smsConvByLead(teamId, row.leadId);
    const sms = cv ? await smsThread(cv.conversationId) : { messages: [], failed: 0 };
    return T.renderPostAppointment({ rooftopName: name, dept, tz: row.mtz || tz, mtdCount: 0, links, sms: sms.messages, smsFailed: sms.failed, appointment: {
      customer: cleanName(row.customer, row.phone) || "Customer", phone: row.phone, when: w.when, relDay: w.relDay, time: w.time,
      type: (row.serviceType || dept) === "service" ? "Service" : "Sales", intent: row.intent,
      transportation: row.transportation, status: row.status, byVini: true,
    } });
  }

  // action_item / action_item_overdue — lead level, from the curated dealer_leads.actionItems feed.
  // ONE email per lead carrying all of that lead's open (or overdue) tasks + lead context.
  const scope = emailType === "action_item_overdue" ? "overdue" : "open";
  const leadKey = String(eventKey || "").replace(/^lead:/, "").split(":")[0];
  // The rooftop's most-recently-created open/overdue item → its lead (fallback target).
  const newestLead = () => one("SELECT leadId FROM (" + aiBaseSql({ teamId, dept, scope }) + ") ORDER BY createdAt DESC LIMIT 1");
  // All of one lead's open/overdue tasks, earliest-due first, with resolved customer identity.
  const itemsForLead = (lk) => runClickhouse(
    "SELECT a.description description, a.dueAt dueAt, a.vehicle vehicle, c.name customer, c.mobile_number phone" +
    " FROM (" + aiBaseSql({ teamId, dept, scope, leadKey: lk }) + ") a" + AI_IDENTITY +
    " ORDER BY a.dueAt ASC");
  let leadId = leadKey || ((await newestLead()) || {}).leadId;
  let rows = leadId ? await itemsForLead(leadId) : [];
  if (!rows.length && leadKey && !strict) { // matched lead had nothing open — show the rooftop's most recent instead
    leadId = ((await newestLead()) || {}).leadId;
    rows = leadId ? await itemsForLead(leadId) : [];
  }
  if (!rows.length) return null;
  // Lead context (sentiment · score · grade · last summary) — best-effort from the lead's latest call.
  const ctx = await one(
    "SELECT e.report_overview overview, q.scorePercentage score, q.overallGrade grade" +
    " FROM dealer_leads.endcallreports e" +
    " LEFT JOIN (SELECT callId, any(scorePercentage) scorePercentage, any(overallGrade) overallGrade FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 90 DAY GROUP BY callId) q ON e.callId=q.callId" +
    " WHERE e.teamId=" + lit(teamId) + " AND e.leadId=" + lit(leadId) + " AND e.__deleted=0 AND notEmpty(e.report_overview)" +
    " ORDER BY e.createdAt DESC LIMIT 1");
  const ov = parseOverview(ctx && ctx.overview), overall = ov.overall || {};
  const first = rows[0];
  const lead = {
    customer: cleanName(first.customer, first.phone) || "Customer", phone: first.phone, vehicle: first.vehicle || undefined,
    aiScore: ctx && ctx.score != null ? Number(ctx.score) : undefined, grade: ctx ? ctx.grade : undefined,
    sentiment: overall.sentiment, sentimentScore: overall.sentimentScore,
    lastSummary: parseJsonArray(ov && ov.summary).join(" ") || undefined,
  };
  // If this lead also has a text conversation, include the chat snippet for context.
  const cv = await smsConvByLead(teamId, leadId);
  const sms = cv ? await smsThread(cv.conversationId) : { messages: [], failed: 0 };
  if (emailType === "action_item_overdue") {
    const items = rows.map((r) => ({ description: r.description, dueAt: r.dueAt }));
    const oldest = rows.map((r) => r.dueAt).filter(Boolean).sort()[0]; // dueAt is ISO text → lexical min
    return T.renderActionItemOverdue({ rooftopName: name, dept, tz, lead, items, oldestDueAt: oldest, totalOverdue: items.length, sms: sms.messages, smsFailed: sms.failed, links });
  }
  const items = rows.map((r) => ({ description: r.description, dueAt: r.dueAt }));
  return T.renderActionItem({ rooftopName: name, dept, tz, lead, items, totalOpen: items.length, justArrived: 0, sms: sms.messages, smsFailed: sms.failed, links });
}

// ── LIST every real transactional event for a rooftop+type, live from ClickHouse ──
// This is the backfill + live source for the tracker's transactional drill-down: it
// returns ALL events in the window (history included), each with the event_key the
// generator/preview use, so the UI can preview + decide-to-send per event and overlay
// sent-status from roi_event_emails. Read-only. emailType: post_appointment |
// post_conversation | action_item | action_item_overdue.
// Direction classifiers (→ 'inbound'|'outbound'): calls use report_inOutType; SMS uses whether the
// conversation was agent-initiated (outboundTask/followup); appointments inherit their booking call's.
const CALL_DIR = (col) => "if(positionCaseInsensitive(ifNull(" + col + ",''),'out')>0,'outbound','inbound')";
const SMS_DIR = "if(notEmpty(cv.outboundTaskId) OR notEmpty(cv.followupId),'outbound','inbound')";
const APPT_DIR_JOIN =
  " LEFT JOIN (SELECT callId, any(report_inOutType) dir FROM dealer_leads.endcallreports WHERE __deleted=0 GROUP BY callId) ecr ON ecr.callId=m.call_id";

export async function listEventsCH({ teamId, department, emailType, direction, sinceDays = 120, limit = 200, offset = 0 }) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server");
  if (!teamId) throw new Error("teamId required");
  const dept = department === "service" ? "service" : "sales";
  const dir = direction === "inbound" || direction === "outbound" ? direction : null; // null = both (all agents in this dept)
  const since = "now() - INTERVAL " + (Number(sinceDays) || 120) + " DAY";
  const lim = Math.min(Number(limit) || 200, 500);
  const off = Math.max(0, Number(offset) || 0); // DB-level pagination: fetch only the requested page, newest first
  const dfilt = (expr) => (dir ? " AND " + expr + "=" + lit(dir) : "");

  if (emailType === "post_appointment") {
    const dx = CALL_DIR("ecr.dir");
    const sql =
      "SELECT toString(m.meeting_id) eventKey, toString(m.meeting_start_time) startTime, m.intent intent," +
      " m.service_type serviceType, m.status status, m.timezone mtz, toString(m.created_at) createdAt," +
      " " + dx + " direction, c.name customer, c.mobile_number phone" +
      " FROM dealer_leads.meetings m" + APPT_DIR_JOIN +
      " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON m.lead_id=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne' AND m.created_at >= " + since + dfilt(dx) +
      " ORDER BY m.created_at DESC LIMIT 1 BY m.meeting_id LIMIT " + lim + " OFFSET " + off;
    return (await runClickhouse(sql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      const w = fmtWhen(r.startTime, r.mtz || null);
      return { eventKey: r.eventKey, customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + (w.when ? " — " + w.when : ""),
        sub: (r.serviceType === "service" ? "Service" : "Sales") + " · " + (r.direction === "outbound" ? "Outbound" : "Inbound") + (r.intent ? " · " + String(r.intent).replace(/_/g, " ") : "") };
    }).filter(Boolean);
  }

  if (emailType === "post_conversation") {
    // calls (endcallreports, dept-tagged by agentType, direction from report_inOutType)
    const cdx = CALL_DIR("e.report_inOutType");
    const callSql =
      "SELECT toString(e.callId) eventKey, e.report_title title, toString(e.createdAt) createdAt," +
      " " + cdx + " direction, c.name customer, c.mobile_number phone" +
      " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
      " WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_overview)" +
      " AND lower(e.callDetails_agentInfo_agentType)=" + lit(dept) + " AND e.createdAt >= " + since + dfilt(cdx) +
      " ORDER BY e.createdAt DESC LIMIT 1 BY e.callId LIMIT " + (off + lim);
    const calls = (await runClickhouse(callSql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      return {
        eventKey: r.eventKey, customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + " — " + (r.title || "Conversation"),
        sub: r.direction === "outbound" ? "Call · Outbound" : "Call · Inbound",
      };
    }).filter(Boolean);
    // SMS conversations (dept via the lead's calls; direction = agent-initiated vs inbound)
    const smsSql =
      "SELECT toString(cv.conversationId) eventKey, toString(cv.createdAt) createdAt, cu.name customer, cu.mobile_number phone," +
      " coalesce(nullIf(dm.dept,''),'sales') dept, " + SMS_DIR + " direction FROM dealer_leads.conversations cv" + CONV_IDENTITY +
      " LEFT JOIN " + LEAD_DEPT_MAP + " dm ON cv.leadId=dm.leadId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) AND cv.createdAt >= " + since + dfilt(SMS_DIR) +
      " ORDER BY cv.createdAt DESC LIMIT 1 BY cv.conversationId LIMIT " + (off + lim);
    const sms = (await runClickhouse(smsSql)).filter((r) => r.dept === dept).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      return {
        eventKey: "sms:" + r.eventKey, customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + " — Text conversation", sub: r.direction === "outbound" ? "SMS · Outbound" : "SMS · Inbound",
      };
    }).filter(Boolean);
    return [...calls, ...sms].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(off, off + lim);
  }

  // action_item / action_item_overdue — lead level (matches the generator's lead:<id> grouping),
  // from the curated actionItems feed. One row per lead = one email; direction is inferred per-lead
  // from that lead's calls (action items carry none of their own), so the IB/OB filter still works.
  const aiScope = emailType === "action_item_overdue" ? "overdue" : "open";
  const dirExpr = "coalesce(nullIf(dirm.dir,''),'inbound')"; // LEFT JOIN misses fill '' (not NULL) for no-call leads
  const sql =
    "SELECT a.leadId leadId, count() nItems, max(a.createdAt) createdAt," +
    " " + dirExpr + " direction, any(c.name) customer, any(c.mobile_number) phone" +
    " FROM (" + aiBaseSql({ teamId, dept, scope: aiScope, since }) + ") a" +
    " LEFT JOIN " + LEAD_DIR_MAP + " dirm ON a.leadId=dirm.leadId" + AI_IDENTITY +
    " GROUP BY a.leadId, dirm.dir" + (dir ? " HAVING " + dirExpr + "=" + lit(dir) : "") +
    " ORDER BY createdAt DESC LIMIT " + lim + " OFFSET " + off;
  return (await runClickhouse(sql)).map((r) => {
    const who = displayName(r);
    if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
    const n = Number(r.nItems) || 0;
    return {
      eventKey: "lead:" + r.leadId, customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
      label: who + " — " + n + " action item" + (n === 1 ? "" : "s"),
      sub: r.direction === "outbound" ? "Outbound" : "Inbound",
    };
  }).filter(Boolean);
}

// ── COUNT real transactional events per (team × dept × type), live from ClickHouse ──
// Three grouped scans (one per category) → the tracker's grid totals reflect ALL real
// events (history + live), not just the sparse generated rows. Read-only.
export async function countEventsCH({ sinceDays = 120 } = {}) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server");
  const since = "now() - INTERVAL " + (Number(sinceDays) || 120) + " DAY";
  const out = [];
  const push = (rows, email_type, totalKey) => {
    for (const r of rows) out.push({ team_id: r.team_id, department: r.department, direction: r.direction || "inbound", email_type, total: Number(r[totalKey]) || 0, last_at: r.last_at || null });
  };
  // appointments — direction inherited from the booking call (meetings carry none of their own).
  push(await runClickhouse(
    "SELECT m.team_id team_id, if(m.service_type='service','service','sales') department," +
    " " + CALL_DIR("ecr.dir") + " direction, uniqExact(m.meeting_id) total, toString(max(m.created_at)) last_at" +
    " FROM dealer_leads.meetings m" + APPT_DIR_JOIN +
    " WHERE m.is_active=1 AND m.source='spyne' AND m.created_at >= " + since +
    " GROUP BY team_id, department, direction"), "post_appointment", "total");
  // post_conversation = calls (endcallreports) + SMS conversations, merged per team×dept×direction.
  const convAgg = new Map(); // `${team}::${dept}::${dir}` → { total, last_at }
  const fold = (rows, totalKey) => {
    for (const r of rows) {
      const k = `${r.team_id}::${r.department}::${r.direction || "inbound"}`;
      const cur = convAgg.get(k) || { total: 0, last_at: null };
      cur.total += Number(r[totalKey]) || 0;
      if (r.last_at && (!cur.last_at || r.last_at > cur.last_at)) cur.last_at = r.last_at;
      convAgg.set(k, cur);
    }
  };
  fold(await runClickhouse(
    "SELECT e.teamId team_id, if(lower(e.callDetails_agentInfo_agentType)='service','service','sales') department," +
    " " + CALL_DIR("e.report_inOutType") + " direction, uniqExact(e.callId) total, toString(max(e.createdAt)) last_at" +
    " FROM dealer_leads.endcallreports e WHERE e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_overview)" +
    " AND lower(e.callDetails_agentInfo_agentType) IN ('sales','service') AND e.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "total");
  fold(await runClickhouse(
    "SELECT cv.teamId team_id, coalesce(nullIf(dm.dept,''),'sales') department," +
    " " + SMS_DIR + " direction, uniqExact(cv.conversationId) total, toString(max(cv.createdAt)) last_at" +
    " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_DEPT_MAP + " dm ON cv.leadId=dm.leadId" +
    " WHERE cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) AND cv.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "total");
  for (const [k, v] of convAgg) { const [team_id, department, direction] = k.split("::"); out.push({ team_id, department, direction, email_type: "post_conversation", total: v.total, last_at: v.last_at }); }
  // action items (curated actionItems feed) — count distinct LEADS (one email per lead), split by the
  // lead's inferred call direction. Open and overdue (now that real due dates exist) are separate columns.
  const aiCount = async (scope, email_type) => push(await runClickhouse(
    "SELECT a.team_id team_id, if(a.service_type='service','service','sales') department," +
    " coalesce(nullIf(dirm.dir,''),'inbound') direction, uniqExact(a.leadId) total, toString(max(a.createdAt)) last_at" +
    " FROM (" + aiBaseSql({ scope, since }) + ") a" +
    " LEFT JOIN " + LEAD_DIR_MAP + " dirm ON a.leadId=dirm.leadId" +
    " GROUP BY team_id, department, direction"), email_type, "total");
  await aiCount("open", "action_item");
  await aiCount("overdue", "action_item_overdue");
  return out;
}
