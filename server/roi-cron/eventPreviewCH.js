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
//   report_actionItems (JSON[])   (free-text action items, grouped by lead)
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

const IDENTITY_JOINS =
  " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON e.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id";

async function one(sql) { const rows = await runClickhouse(sql); return rows && rows[0] ? rows[0] : null; }

// ── SMS support ──────────────────────────────────────────────────────────────
// Identity join for the conversations table (its own lead→customer resolution).
const CONV_IDENTITY =
  " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON cv.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) cu ON l.cid=cu.customer_id";
const SMS_CONV_SELECT =
  "SELECT cv.conversationId conversationId, cv.leadId leadId, toString(cv.createdAt) at," +
  " ifNull(cv.summary,'') summary, cu.name customer, cu.mobile_number phone FROM dealer_leads.conversations cv" + CONV_IDENTITY;
// Per-lead dept, inferred from that lead's calls (SMS carries no dept of its own).
const LEAD_DEPT_MAP =
  "(SELECT leadId, if(countIf(lower(callDetails_agentInfo_agentType)='service') > countIf(lower(callDetails_agentInfo_agentType)='sales'),'service','sales') dept" +
  " FROM dealer_leads.endcallreports WHERE isTestCall=0 AND __deleted=0 AND createdAt >= now()-INTERVAL 180 DAY GROUP BY leadId)";

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
    title: row.title || "Conversation", customer: row.customer, phone: row.phone, at: row.at,
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
      " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON m.lead_id=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne'";
    const order = " ORDER BY m.created_at DESC LIMIT 1";
    let row = eventKey ? await one(base + " AND (m.meeting_id=" + lit(eventKey) + " OR m._id=" + lit(eventKey) + ")" + order) : null;
    if (!row && !(eventKey && strict)) row = await one(base + order); // strict send path: don't substitute another appointment
    if (!row) return null;
    const w = fmtWhen(row.startTime, row.mtz || tz);
    // include the booking text thread when the appointment was set over SMS
    const cv = await smsConvByLead(teamId, row.leadId);
    const sms = cv ? await smsThread(cv.conversationId) : { messages: [], failed: 0 };
    return T.renderPostAppointment({ rooftopName: name, dept, tz: row.mtz || tz, mtdCount: 0, links, sms: sms.messages, smsFailed: sms.failed, appointment: {
      customer: row.customer, phone: row.phone, when: w.when, relDay: w.relDay, time: w.time,
      type: (row.serviceType || dept) === "service" ? "Service" : "Sales", intent: row.intent,
      transportation: row.transportation, status: row.status, byVini: true,
    } });
  }

  // action_item / action_item_overdue — lead level
  const leadKey = String(eventKey || "").replace(/^lead:/, "").split(":")[0];
  const base =
    "SELECT e.leadId leadId, toString(max(e.createdAt)) at, groupArray(e.report_actionItems) aiArrays," +
    " any(e.report_overview) overview, anyLast(e.callId) callId, c.name customer, c.mobile_number phone" +
    " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
    " WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0" +
    " AND notEmpty(e.report_actionItems) AND e.report_actionItems NOT IN ('[]','[\"\"]')" +
    (leadKey ? " AND e.leadId=" + lit(leadKey) : "") +
    " GROUP BY e.leadId, c.name, c.mobile_number ORDER BY at DESC LIMIT 1";
  let row = await one(base);
  if (!row && leadKey && !strict) { // matched lead had nothing — show the rooftop's most recent instead
    row = await one(base.replace(" AND e.leadId=" + lit(leadKey), ""));
  }
  if (!row) return null;
  const descs = (Array.isArray(row.aiArrays) ? row.aiArrays : []).flatMap(parseJsonArray);
  if (!descs.length) return null;
  const ov = parseOverview(row.overview), overall = ov.overall || {};
  const q = row.callId ? await one("SELECT any(scorePercentage) score, any(overallGrade) grade FROM dealer_leads.conversationQualities WHERE callId=" + lit(row.callId) + " GROUP BY callId LIMIT 1") : null;
  const lead = {
    customer: row.customer, phone: row.phone,
    aiScore: q && q.score != null ? Number(q.score) : undefined, grade: q ? q.grade : undefined,
    sentiment: overall.sentiment, sentimentScore: overall.sentimentScore,
    lastSummary: parseJsonArray(ov && ov.summary).join(" ") || undefined,
  };
  // If this lead also has a text conversation, include the chat snippet for context.
  const cv = await smsConvByLead(teamId, row.leadId);
  const sms = cv ? await smsThread(cv.conversationId) : { messages: [], failed: 0 };
  if (emailType === "action_item_overdue") {
    // No SLA/due dates exist in ClickHouse — use the source call time as the "overdue since" proxy.
    const items = descs.map((d) => ({ description: d, dueAt: row.at }));
    return T.renderActionItemOverdue({ rooftopName: name, dept, tz, lead, items, oldestDueAt: row.at, totalOverdue: items.length, sms: sms.messages, smsFailed: sms.failed, links });
  }
  const items = descs.map((d) => ({ description: d }));
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
      " ORDER BY m.created_at DESC LIMIT " + lim + " OFFSET " + off;
    return (await runClickhouse(sql)).map((r) => {
      const w = fmtWhen(r.startTime, r.mtz || null);
      return { eventKey: r.eventKey, customer: r.customer || "Unknown", phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: (r.customer || "Unknown") + (w.when ? " — " + w.when : ""),
        sub: (r.serviceType === "service" ? "Service" : "Sales") + " · " + (r.direction === "outbound" ? "Outbound" : "Inbound") + (r.intent ? " · " + String(r.intent).replace(/_/g, " ") : "") };
    });
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
      " ORDER BY e.createdAt DESC LIMIT " + (off + lim);
    const calls = (await runClickhouse(callSql)).map((r) => ({
      eventKey: r.eventKey, customer: r.customer || "Unknown", phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
      label: (r.customer || "Unknown") + " — " + (r.title || "Conversation"),
      sub: r.direction === "outbound" ? "Call · Outbound" : "Call · Inbound",
    }));
    // SMS conversations (dept via the lead's calls; direction = agent-initiated vs inbound)
    const smsSql =
      "SELECT toString(cv.conversationId) eventKey, toString(cv.createdAt) createdAt, cu.name customer, cu.mobile_number phone," +
      " coalesce(nullIf(dm.dept,''),'sales') dept, " + SMS_DIR + " direction FROM dealer_leads.conversations cv" + CONV_IDENTITY +
      " LEFT JOIN " + LEAD_DEPT_MAP + " dm ON cv.leadId=dm.leadId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) AND cv.createdAt >= " + since + dfilt(SMS_DIR) +
      " ORDER BY cv.createdAt DESC LIMIT " + (off + lim);
    const sms = (await runClickhouse(smsSql)).filter((r) => r.dept === dept).map((r) => ({
      eventKey: "sms:" + r.eventKey, customer: r.customer || "Unknown", phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
      label: (r.customer || "Unknown") + " — Text conversation", sub: r.direction === "outbound" ? "SMS · Outbound" : "SMS · Inbound",
    }));
    return [...calls, ...sms].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(off, off + lim);
  }

  // action_item / action_item_overdue — lead level (matches the generator's lead:<id> grouping)
  const sql =
    "SELECT e.leadId leadId, toString(max(e.createdAt)) createdAt, any(c.name) customer, any(c.mobile_number) phone," +
    " " + CALL_DIR("anyLast(e.report_inOutType)") + " direction," +
    " sum(length(JSONExtractArrayRaw(ifNull(e.report_actionItems, '[]')))) nItems" +
    " FROM dealer_leads.endcallreports e" + IDENTITY_JOINS +
    " WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0" +
    " AND notEmpty(e.report_actionItems) AND e.report_actionItems NOT IN ('[]','[\"\"]')" +
    " AND lower(e.callDetails_agentInfo_agentType)=" + lit(dept) + dfilt(CALL_DIR("e.report_inOutType")) + " AND e.createdAt >= " + since +
    " GROUP BY e.leadId ORDER BY createdAt DESC LIMIT " + lim + " OFFSET " + off;
  return (await runClickhouse(sql)).map((r) => ({
    eventKey: "lead:" + r.leadId, customer: r.customer || "Unknown", phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
    label: (r.customer || "Unknown") + " — " + (Number(r.nItems) || 0) + " action item" + ((Number(r.nItems) || 0) === 1 ? "" : "s"),
    sub: r.direction === "outbound" ? "Outbound" : "Inbound",
  }));
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
    " " + CALL_DIR("ecr.dir") + " direction, count() total, toString(max(m.created_at)) last_at" +
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
    " " + CALL_DIR("e.report_inOutType") + " direction, count() total, toString(max(e.createdAt)) last_at" +
    " FROM dealer_leads.endcallreports e WHERE e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_overview)" +
    " AND lower(e.callDetails_agentInfo_agentType) IN ('sales','service') AND e.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "total");
  fold(await runClickhouse(
    "SELECT cv.teamId team_id, coalesce(nullIf(dm.dept,''),'sales') department," +
    " " + SMS_DIR + " direction, count() total, toString(max(cv.createdAt)) last_at" +
    " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_DEPT_MAP + " dm ON cv.leadId=dm.leadId" +
    " WHERE cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) AND cv.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "total");
  for (const [k, v] of convAgg) { const [team_id, department, direction] = k.split("::"); out.push({ team_id, department, direction, email_type: "post_conversation", total: v.total, last_at: v.last_at }); }
  push(await runClickhouse(
    "SELECT e.teamId team_id, if(lower(e.callDetails_agentInfo_agentType)='service','service','sales') department," +
    " " + CALL_DIR("e.report_inOutType") + " direction, uniqExact(e.leadId) total, toString(max(e.createdAt)) last_at" +
    " FROM dealer_leads.endcallreports e WHERE e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_actionItems)" +
    " AND e.report_actionItems NOT IN ('[]','[\"\"]') AND lower(e.callDetails_agentInfo_agentType) IN ('sales','service') AND e.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "action_item", "total");
  return out;
}
