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
// Requested-visit-time extractor — SAME one the cron send path uses (fetchApptAsksByLead/ByCall),
// so tracker previews can't drift from the real emails.
// Reason for service — the SAME lookup the cron send path uses, so a tracker preview can't word
// the appointment's "For" row differently from the email the dealer actually received.
const { pickApptRequest, fetchServiceReasonsByLead, countActionItemLeads, eventKeys, OPT_OUT_KEYWORDS, NON_ACTIONABLE_INTENTS } = require("./leadCaptureCH.cjs");
const { isNorthAmericanTz } = require("./resolveTz.cjs");

// ── CRON EVENT KEYS (2026-10-09, A4 F13) ─────────────────────────────────────────────────────────────
// Every drill-down row now carries `cronEventKey`: the EXACT ledger key the events cron uses for that
// event (roi_event_emails.event_key), built by the same pure functions the cron uses (leadCaptureCH
// eventKeys). `eventKey` keeps its old meaning (the id previewEventCH renders from), so preview/send keep
// working; the tracker matches sent rows on cronEventKey. Re-exported here for the tracker to import.
export { eventKeys };

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
// human "When" + relative-day for an appointment, in the dealer's tz.
// Off-year dates MUST carry the year and MUST NOT return a relDay: the appointment email leads with
// relDay, which has no year, so a 2024-12-21 slot rendered as "Sat, Dec 21 · 11:00 AM" and the dealer
// read it as a future date (Honda of Downtown LA, Aug 2026). Mirrors schedInfo() in eventRunner.cjs
// (ported from 5fd5046).
function fmtWhen(dt, tz) {
  if (!dt) return { when: "", relDay: "", time: "" };
  const d = new Date(String(dt).replace(" ", "T") + (String(dt).endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return { when: String(dt), relDay: "", time: "" };
  const z = tz || "America/New_York";
  const day = (x) => new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  const today = day(new Date()), that = day(d);
  const tmr = day(new Date(Date.now() + 864e5));
  const offYear = that.slice(0, 4) !== today.slice(0, 4);
  const dated = new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short", month: "short", day: "numeric", ...(offYear ? { year: "numeric" } : {}) }).format(d);
  const relDay = that === today ? "Today" : that === tmr ? "Tomorrow" : dated;
  return { when: (offYear ? dated : relDay) + " · " + time, relDay: offYear ? "" : relDay, time };
}

// Identity resolution defends against SharedReplacingMergeTree duplicate rows: a plain any()
// can pick an empty version (lead with no customer_id, customer row with a blank name), which
// is why so many real customers surfaced as "Unknown". anyIf(..., notEmpty(...)) prefers a
// populated value across the duplicate versions.
// TENANT-SCOPED identity joins. Unscoped, each of these re-aggregated the WHOLE fleet —
// dealer_leads.leads (1.37M rows) + customer (1.20M) — on every call, purely to attach a name and
// phone to one rooftop's rows; that hash-table build dominated the query's memory. Now functions of
// teamId so the predicate is pushed into both sides. Lossless: across the 8 busiest teams, zero
// leads resolve to a customer owned by another team. teamId=null keeps the old unscoped form for
// the by-conversationId lookups that have no team in scope.
const teamPred = (teamId) => (teamId ? " WHERE team_id=" + lit(teamId) : "");
const identityJoins = (teamId) =>
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id) l ON e.leadId=l.lead_id" +
  // `emails` rides along for the lead-capture email (unused by the other event types) so the
  // preview resolves identity from the SAME row shape the cron send path does.
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number," +
  " anyIf(emails, notEmpty(emails)) emails FROM dealer_leads.customer" + teamPred(teamId) + " GROUP BY customer_id) c ON l.cid=c.customer_id";

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
const convIdentity = (teamId) =>
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id) l ON cv.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer" + teamPred(teamId) + " GROUP BY customer_id) cu ON l.cid=cu.customer_id";
const smsConvSelect = (teamId) =>
  "SELECT cv.conversationId conversationId, cv.leadId leadId, toString(cv.createdAt) at," +
  " ifNull(cv.summary,'') summary, cu.name customer, cu.mobile_number phone FROM dealer_leads.conversations cv" + convIdentity(teamId);
// (The call-inferred per-lead department map is gone: SMS and chat follow the lead's own
// service_type, as the cron does — see LEAD_SVC below.)

// ── Structured action items (dealer_leads.actionItems) ───────────────────────────
// The curated CRM task feed is the SYSTEM OF RECORD for action items — NOT the raw per-call
// report_actionItems notes (uncurated, noisy, no due date / completion state). This matches the
// generator (eventRunner), which already sources action items from reporting-vini /api/action-items
// (the same underlying table). SharedReplacingMergeTree keeps duplicate physical rows, so every
// query collapses to the latest _version per _id BEFORE gating on open/overdue.
const AI_DEPT = "if(service_type='service','service','sales')"; // mirror meetings' dept split
// `m.source='spyne'` says Vini OWNS the booking; `meta.source` says HOW the row came to exist.
// 'warm_transfer' rows are the customer's EXISTING appointments pulled in around a transfer —
// records Vini did not create (start times are often the customer's own PAST visits). The send path
// drops them (eventRunner.cjs → leadCaptureCH.fetchMeetingMetaSource), so the tracker's candidate
// lists, volumes and funnel must drop them too — otherwise the tracker shows appointment emails that
// will never go out, and previews render an appointment nobody booked. Appended to every meetings
// WHERE in this file (alias `m`).
//
// 2026-10-09: the SAME gates the cron applies (eventRunner B1/B2), so the tracker never lists, counts or
// renders an appointment the cron would refuse: meta.source 'callback' joins 'warm_transfer'; cancelled
// rows (reporting-vini's list: cancelled, cancellation_requested) and inactive/deleted rows are out.
const APPT_NOT_WARM_TRANSFER =
  " AND lower(JSONExtractString(ifNull(m.meta,''),'source')) NOT IN ('warm_transfer','callback')" +
  " AND lower(ifNull(m.status,'')) NOT IN ('cancelled','cancellation_requested') AND m.__deleted=0";
// The cron's past-start gate, relative to when the booking was made: a row whose slot was already more
// than 6h gone when it was created is replayed history, never a "new appointment" (Honda DTLA, Aug 2026).
const APPT_NOT_PAST_AT_BOOKING = " AND (m.meeting_start_time IS NULL OR m.meeting_start_time >= m.created_at - INTERVAL 6 HOUR)";
// An appointment's department is its OWN service_type — never the tracker row it is viewed from.
// The cron gets this for free (the meetings API filters by serviceType); every tracker read has to
// apply it itself. Stillwell Ford, 2026-10-07: the Sales row's drill-down listed all 27 service
// appointments as eligible, five were sent from it, and the service bookings went to the sales team.
const APPT_DEPT = "if(m.service_type='service','service','sales')";
// "2021 Honda Odyssey EX-L" from meta.vehicle_details (year/make/model); '' when the task has none.
const aiVehicle = (col) =>
  "trimBoth(concat(JSONExtractString(" + col + ",'vehicle_details','year'),' '," +
  "JSONExtractString(" + col + ",'vehicle_details','make'),' ',JSONExtractString(" + col + ",'vehicle_details','model')))";
// Per-lead direction inferred from that lead's calls — action items carry no direction of their own
// (most rows have no callSid). Leads with no calls fall back to 'inbound'.
const LEAD_DIR_MAP =
  "(SELECT leadId, if(countIf(positionCaseInsensitive(ifNull(report_inOutType,''),'out')>0) >" +
  " countIf(positionCaseInsensitive(ifNull(report_inOutType,''),'out')=0),'outbound','inbound') dir" +
  " FROM dealer_leads.endcallreports WHERE isTestCall=0 AND __deleted=0 AND createdAt >= now()-INTERVAL 180 DAY GROUP BY leadId)";
// lead → customer identity for an actionItems subquery aliased `a` (exposes `leadId`).
const aiIdentity = (teamId) =>
  " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id) l ON a.leadId=l.lead_id" +
  " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer" + teamPred(teamId) + " GROUP BY customer_id) c ON l.cid=c.customer_id";
// One deduped row per OPEN action item, optionally scoped to a team / dept / single lead, and to a
// createdAt window. scope: 'open' (is_completed=0) | 'overdue' (open AND real past due date).
//
// DEDUPE FIRST, FILTER AFTER (2026-10-09, A5-25). The state predicates (is_active / is_completed /
// __deleted / intent) used to run BEFORE `LIMIT 1 BY _id`, so an item completed since it was created
// still surfaced through its older open version — and the manual "Send" path could email it. Only the
// immutable keys (team, lead, createdAt) bound the inner read; every state test runs on the latest
// version. The intent rules are the cron's: blank and 'custom' dropped (the feed's rule) and
// NON_ACTIONABLE_INTENTS dropped (the poller's rule). Raw PeerDB deletes, which never reach the typed
// mirror as tombstones, are excluded too.
const NON_ACTIONABLE_SQL = "(" + [...NON_ACTIONABLE_INTENTS].map(lit).join(",") + ")";
function aiBaseSql({ teamId = null, dept = null, scope = "open", leadKey = null, since = null } = {}) {
  const overdue = scope === "overdue";
  const latest =
    "SELECT _id, lead_id, team_id, service_type, description, due_date, intent, priority, meta, createdAt, is_active, is_completed, __deleted" +
    " FROM dealer_leads.actionItems WHERE 1=1" +
    (teamId ? " AND team_id=" + lit(teamId) : "") +
    (leadKey ? " AND lead_id=" + lit(leadKey) : "") +
    // Recency window bounds OPEN items; for OVERDUE the bound is the (past) due_date below, NOT
    // createdAt. Overdue items are created long ago, so gating on createdAt silently dropped ~22% of
    // them (the worst, longest-overdue offenders) — the overdue-undercount bug.
    (since && !overdue ? " AND createdAt >= " + since : "") +
    " ORDER BY _version DESC LIMIT 1 BY _id";
  return (
    "SELECT _id, lead_id leadId, team_id, service_type, description, toString(due_date) dueAt, intent, priority," +
    " " + aiVehicle("meta") + " vehicle, createdAt" + // raw DateTime — aliasing toString here would shadow the WHERE/ORDER column
    " FROM (" + latest + ")" +
    " WHERE ifNull(is_active,1)=1 AND ifNull(is_completed,0)=0 AND __deleted=0" +
    " AND notEmpty(ifNull(intent,'')) AND lower(ifNull(intent,''))!='custom' AND lower(ifNull(intent,'')) NOT IN " + NON_ACTIONABLE_SQL +
    " AND _id NOT IN (SELECT _id FROM dealer_leads_raw.actionItems WHERE _peerdb_is_deleted=1)" +
    // Overdue = real past due date. Exclude epoch/zero due_date ("no due date recorded" → not truly
    // overdue; counting those inflated overdue to ~= open).
    (overdue ? " AND due_date < now() AND due_date > '2000-01-01'" : "") +
    (dept ? " AND " + AI_DEPT + "=" + lit(dept) : "")
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
const smsConvLatest = (teamId) => one(smsConvSelect(teamId) + " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId) ORDER BY cv.createdAt DESC LIMIT 1");
const smsConvById = (conversationId) => one(smsConvSelect(null) + " WHERE cv.conversationId=" + lit(conversationId) + " LIMIT 1");
const smsConvByLead = (teamId, leadId) => (leadId ? one(smsConvSelect(teamId) + " WHERE cv.teamId=" + lit(teamId) + " AND cv.leadId=" + lit(leadId) + " AND cv.type='sms' AND cv.isTest=0 ORDER BY cv.createdAt DESC LIMIT 1") : Promise.resolve(null));

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

// ── CHAT (website chatbot) support ───────────────────────────────────────────
// type='chat' rows in the SAME conversations table, bubbles in the SAME smsMessages store —
// so smsThread() works verbatim. What differs is the analysis: the widget writes its own
// conversationAnalytics blob (chatSummary bullets, customerSentiment, appointmentDetails,
// dealerActionItems), and some rooftops' chats write a full endcallreports-style report JSON
// into `summary`. Identity falls back lead→customer, then the chat's own captured `number`
// (a visitor can leave a phone before any lead row exists).
const chatConvSelect = (teamId) =>
  "SELECT cv.conversationId conversationId, cv.leadId leadId, toString(cv.createdAt) at," +
  " ifNull(cv.summary,'') summaryJson, ifNull(cv.conversationAnalytics,'') analyticsJson," +
  " cu.name customer, coalesce(nullIf(cu.mobile_number,''), cv.number) phone FROM dealer_leads.conversations cv" + convIdentity(teamId);
const chatConvById = (conversationId) => one(chatConvSelect(null) + " WHERE cv.conversationId=" + lit(conversationId) + " AND cv.type='chat' LIMIT 1");
const chatConvLatest = (teamId) => one(chatConvSelect(teamId) + " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='chat' AND ifNull(cv.isTest,0)=0 AND (notEmpty(cv.leadId) OR notEmpty(ifNull(cv.number,''))) ORDER BY cv.createdAt DESC LIMIT 1");
// conversation opts for a chat conversation (channel:'chat' → same thread render, chat labels).
function chatConvOpts(cv, thread) {
  const report = parseOverview(cv.summaryJson);
  const analytics = parseOverview(cv.analyticsJson);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && String(x).trim()).map(String) : []);
  const ov = report.overview || {};
  // 'pending_confirmation' is NOT booked — only a confirmed/booked widget appointment (or an
  // explicit report Yes) may claim one, or the email announces appointments that never land.
  const apptStatus = String((analytics.appointmentDetails || {}).status || "").toLowerCase();
  return {
    id: cv.conversationId, channel: "chat", direction: "inbound",
    title: report.title || "Website chat", customer: cv.customer, phone: cv.phone, at: cv.at,
    summary: arr(report.summary).join(" ") || arr(analytics.chatSummary).join(" "),
    sentiment: (analytics.customerSentiment || {}).sentiment || (ov.overall || {}).sentiment,
    appointmentScheduled: ["confirmed", "booked", "scheduled"].includes(apptStatus) || String(ov.appointmentScheduled || "").toLowerCase() === "yes",
    queryResolved: String(report.queryResolved || "").toLowerCase() === "yes",
    actionItems: [...arr(analytics.dealerActionItems), ...arr(report.actionItems)],
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
    // the slot the customer asked for when nothing got booked (booked case = the appointment block)
    requestedTime: appt ? undefined : (pickApptRequest(apptDetails, takeaways) || undefined),
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
export async function previewEventCH({ teamId, department, emailType, eventKey, rooftopName, tz, strict = false, template = "" }) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server (set CLICKHOUSE_HOST/PASSWORD)");
  if (!teamId) throw new Error("teamId required");
  const dept = department === "service" ? "service" : "sales";
  const useCase = dept === "service" ? "Service" : "Sales";
  const name = rooftopName || "";
  const links = { console: "https://console.spyne.ai/converse-ai" };

  // Rooftops on the lead-capture format get the SAME email here that the cron sends them —
  // the tracker's preview and its "send now" both go through this function, so rendering the
  // standard conversation summary would show the dealer a design they'll never receive.
  const leadCapture = String(template || "") === "lead_capture";

  if (emailType === "post_conversation") {
    const base =
      "SELECT e.callId callId, e.leadId leadId, e.report_inOutType direction, e.report_title title," +
      " e.report_summary summary, e.report_overview overview, e.report_actionItems actionItems," +
      " e.callDetails_recordingUrl recordingUrl, e.callDetails_startedAt startedAt, e.callDetails_endedAt endedAt," +
      " e.callDetails_endedReason endedReason, e.report_queryResolved queryResolved, toString(e.createdAt) at," +
      // PARITY: these are exactly the extra columns leadFromRow() reads beyond what the standard
      // preview already selects. Add one here whenever leadCaptureCH.LEAD_FIELD_COLS grows, or the
      // preview silently renders a field the real email fills in (scratch-preview asserts equality).
      (leadCapture
        ? " ifNull(e.report_sales,'') sales, ifNull(e.callDetails_transcript,'') transcript," +
          " ifNull(e.callDetails_agentInfo_agentName,'') agentName, c.emails emails,"
        : "") +
      " c.name customer, c.mobile_number phone," +
      " q.scorePercentage score, q.overallGrade grade, q.customerFrustrated frustrated" +
      " FROM dealer_leads.endcallreports e" + identityJoins(teamId) +
      " LEFT JOIN (SELECT callId, any(scorePercentage) scorePercentage, any(overallGrade) overallGrade, any(customerFrustrated) customerFrustrated FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 30 DAY GROUP BY callId) q ON e.callId=q.callId" +
      " WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0 AND notEmpty(e.report_overview)";
    const renderSms = async (cv) => {
      const th = await smsThread(cv.conversationId);
      if (leadCapture) {
        // same builder the cron's SMS path uses: fields from the lead's own call, thread attached,
        // anything the customer typed (newer ZIP / moved time) overriding the carried-over value.
        const { fetchLeadFieldsByLead, buildSmsLead } = require("./leadCaptureCH.cjs");
        const byLead = cv.leadId ? await fetchLeadFieldsByLead(teamId, [cv.leadId]) : new Map();
        const lead = buildSmsLead(byLead.get(String(cv.leadId)) || null, { customer: cv.customer, phone: cv.phone, at: cv.at }, th.messages);
        return T.renderLeadCapture({ rooftopName: name, dept, tz, links, lead });
      }
      return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: smsConvOpts(cv, th), links });
    };
    const renderChat = async (cv) => {
      const th = await smsThread(cv.conversationId);
      return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: chatConvOpts(cv, th), links });
    };
    // explicit SMS event → render that text conversation's thread. Two key shapes: the drill-down's
    // `sms:<conversationId>` and the cron ledger's `sms:<leadId|conversationId>:<YYYY-MM-DD>[:…]`.
    if (String(eventKey || "").startsWith("sms:")) {
      const cronKey = /^sms:(.+?):(\d{4}-\d{2}-\d{2})(:.*)?$/.exec(eventKey);
      const id = cronKey ? cronKey[1] : eventKey.slice(4);
      const cv = (await smsConvById(id)) || (cronKey ? await smsConvByLead(teamId, id) : null);
      if (cv) return renderSms(cv);
      if (strict) return null; // explicit SMS event didn't resolve — never substitute another customer
    }
    // explicit CHAT event → render that website-chat thread (chat labels, widget analysis).
    // `chat:<conversationId>` (drill-down) or `chat:<conversationId>:<day>:s<sessionStart>` (ledger).
    if (String(eventKey || "").startsWith("chat:")) {
      const cv = await chatConvById(eventKey.slice(5).split(":")[0]);
      if (cv) return renderChat(cv);
      if (strict) return null; // explicit chat event didn't resolve — never substitute another customer
    }
    const keyed = eventKey && !eventKey.startsWith("sms:") && !eventKey.startsWith("chat:");
    // The cron ledger's call key `call:lead:<leadId|rowId>:<YYYY-MM-DD>:t<rank>` → that lead's latest call
    // of that day (±1 day of slack, since the day is dealer-local and this has no zone).
    const callKey = /^call:lead:(.+):(\d{4}-\d{2}-\d{2}):t\d$/.exec(String(eventKey || ""));
    // freshest non-call candidate (SMS thread or website chat) for the representative fallbacks
    const latestAlt = async () => {
      const [smsCv, chatCv] = await Promise.all([smsConvLatest(teamId), chatConvLatest(teamId)]);
      const alts = [smsCv && { at: smsCv.at, render: () => renderSms(smsCv) }, chatCv && { at: chatCv.at, render: () => renderChat(chatCv) }];
      return alts.filter(Boolean).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
    };
    const order = " ORDER BY e.createdAt DESC LIMIT 1";
    let row = callKey
      ? await one(base + " AND (e.leadId=" + lit(callKey[1]) + " OR e.id=" + lit(callKey[1]) + ")" +
          " AND e.createdAt >= toDateTime(" + lit(callKey[2]) + ") - INTERVAL 1 DAY AND e.createdAt < toDateTime(" + lit(callKey[2]) + ") + INTERVAL 2 DAY" + order)
      : keyed ? await one(base + " AND (e.callId=" + lit(eventKey) + " OR e.id=" + lit(eventKey) + ")" + order) : null;
    if (!row && !eventKey) {
      // no explicit event → show whichever is most recent: latest call, SMS thread, or website chat
      row = await one(base + order);
      const alt = await latestAlt();
      if (alt && (!row || Date.parse(alt.at) > Date.parse(row.at))) return alt.render();
    }
    if (!row) {
      if (eventKey && strict) return null; // requested event didn't resolve — don't email a different customer
      // matched key found no call, or rooftop has only SMS/chat — fall back to the latest thread
      const alt = await latestAlt();
      if (alt) return alt.render();
      return null;
    }
    if (leadCapture) {
      // same mapper the cron send path uses (server/roi-cron/leadCaptureCH.cjs) → identical output
      const { leadFromRow } = require("./leadCaptureCH.cjs");
      return T.renderLeadCapture({ rooftopName: name, dept, tz, links, lead: leadFromRow(row) });
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
      " LEFT JOIN (SELECT lead_id, anyIf(customer_id, notEmpty(customer_id)) cid FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id) l ON m.lead_id=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, anyIf(name, notEmpty(name)) name, anyIf(mobile_number, notEmpty(mobile_number)) mobile_number FROM dealer_leads.customer" + teamPred(teamId) + " GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne'" + APPT_NOT_WARM_TRANSFER + APPT_NOT_PAST_AT_BOOKING;
    const order = " ORDER BY m.created_at DESC LIMIT 1 BY m.meeting_id LIMIT 1";
    let row = eventKey ? await one(base + " AND (m.meeting_id=" + lit(eventKey) + " OR m._id=" + lit(eventKey) + ")" + order) : null;
    if (!row && !(eventKey && strict)) row = await one(base + order); // strict send path: don't substitute another appointment
    if (!row) return null;
    const w = fmtWhen(row.startTime, row.mtz || tz);
    // include the booking text thread when the appointment was set over SMS
    const cv = await smsConvByLead(teamId, row.leadId);
    const sms = cv ? await smsThread(cv.conversationId) : { messages: [], failed: 0 };
    const isService = (row.serviceType || dept) === "service";
    const svc = isService
      ? (await fetchServiceReasonsByLead(teamId, [row.leadId]).catch(() => new Map())).get(String(row.leadId || "")) || null
      : null;
    // Labelled with the APPOINTMENT's department, not the tracker row it was opened from: this is the
    // render behind the tracker's manual Send, and the Stillwell email (2026-10-07) said "Vini · Sales"
    // over a service booking because `dept` here was the row's.
    return T.renderPostAppointment({ rooftopName: name, dept: isService ? "service" : "sales", tz: row.mtz || tz, mtdCount: 0, links, sms: sms.messages, smsFailed: sms.failed, appointment: {
      customer: cleanName(row.customer, row.phone) || "Customer", phone: row.phone, when: w.when, relDay: w.relDay, time: w.time,
      type: isService ? "Service" : "Sales", intent: row.intent,
      transportation: row.transportation, status: row.status, byVini: true,
      services: svc ? svc.services : null, serviceIntent: svc ? svc.intent : "", serviceVehicle: svc ? svc.vehicleName : "",
    } });
  }

  // action_item_overdue is a ROOFTOP-WIDE digest in the cron (`rooftop:<team>:<dept>:overdue:<day>:<slot>`).
  // Render THAT, from the same predicates and the same lead-grain count, instead of a per-lead email the
  // cron never sends (A5-25). A legacy per-lead `lead:` key keeps the per-lead render below.
  if (emailType === "action_item_overdue" && String(eventKey || "").startsWith("rooftop:")) {
    const rows = await runClickhouse(
      "SELECT a.leadId leadId, argMin(a.description, a.dueAt) description, argMin(a.intent, a.dueAt) intent, min(a.dueAt) dueAt," +
      " any(a.vehicle) vehicle, any(c.name) customer, any(c.mobile_number) phone" +
      " FROM (" + aiBaseSql({ teamId, dept, scope: "overdue" }) + ") a" + aiIdentity(teamId) +
      " GROUP BY a.leadId ORDER BY dueAt ASC LIMIT 10");
    const counts = await countActionItemLeads(teamId, dept, NON_ACTIONABLE_INTENTS);
    const total = counts ? counts.overdue : rows.length;
    if (!total) return null;
    const topItems = rows.map((r) => ({ customer: cleanName(r.customer, r.phone) || "Customer", phone: r.phone, intent: r.intent, description: r.description, dueAt: r.dueAt, vehicle: r.vehicle || undefined }));
    return T.renderOverdueActionItemsDigest({ rooftopName: name, dept, tz, topItems, totalOverdueCount: total, totalPendingAllLeads: counts ? counts.open : 0, links });
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
    " FROM (" + aiBaseSql({ teamId, dept, scope, leadKey: lk }) + ") a" + aiIdentity(teamId) +
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
    "SELECT e.report_overview overview, ifNull(e.report_summary,'') summaryRaw, toString(e.createdAt) at," +
    " q.scorePercentage score, q.overallGrade grade" +
    " FROM dealer_leads.endcallreports e" +
    " LEFT JOIN (SELECT callId, any(scorePercentage) scorePercentage, any(overallGrade) overallGrade FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 90 DAY GROUP BY callId) q ON e.callId=q.callId" +
    " WHERE e.teamId=" + lit(teamId) + " AND e.leadId=" + lit(leadId) + " AND e.__deleted=0 AND notEmpty(e.report_overview)" +
    " ORDER BY e.createdAt DESC LIMIT 1");
  const ov = parseOverview(ctx && ctx.overview), overall = ov.overall || {};
  // The visit date/time the customer asked for — SAME extractor + sources as the cron send path
  // (leadCaptureCH.fetchApptAsksByLead), so the tracker preview can't drift from the real email.
  const apptDetails = Array.isArray(ov.appointmentDetails) ? ov.appointmentDetails.filter(Boolean) : [];
  const requestedTime = ctx ? pickApptRequest(apptDetails, parseJsonArray(ctx.summaryRaw)) : "";
  const first = rows[0];
  const lead = {
    customer: cleanName(first.customer, first.phone) || "Customer", phone: first.phone, vehicle: first.vehicle || undefined,
    aiScore: ctx && ctx.score != null ? Number(ctx.score) : undefined, grade: ctx ? ctx.grade : undefined,
    sentiment: overall.sentiment, sentimentScore: overall.sentimentScore,
    lastSummary: parseJsonArray(ov && ov.summary).join(" ") || undefined,
    requestedTime: requestedTime || undefined,
    requestedTimeAt: requestedTime ? String(ctx.at || "") : undefined,
    requestedTimeBooked: requestedTime ? String(ov.appointmentScheduled || "").toLowerCase() === "yes" : undefined,
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
//
// ELIGIBLE = WHAT THE CRON WOULD SEND (2026-10-09, A3-12 / B13). The lists and counts below apply the
// cron's own gates — voicemail, actionable, outbound-needs-a-reply, spam and substance for calls; a real
// (non-opt-out) reply and the LEAD's own department for SMS; Vini-booked, not cancelled / pulled-in /
// replayed history for appointments; the intent rules after the per-_id dedupe for action items — so
// "eligible vs sent" can finally reconcile. Every row also carries `cronEventKey` (see eventKeys).
//
// Direction classifiers (→ 'inbound'|'outbound'): calls use the call's own type plus the call-back flip
// (the spine's rule — report_inOutType is blank or 'inbound' on 48% of outbound calls, A3-16); SMS uses
// whether the conversation was agent-initiated (outboundTask/followup); website chats are always
// inbound; appointments inherit their booking call's.
const CALL_DIR = (col) => "if(positionCaseInsensitive(ifNull(" + col + ",''),'out')>0,'outbound','inbound')";
const CALL_DIR_CANON = (e) =>
  "if(ifNull(" + e + ".callDetails_callType,'')='outboundPhoneCall' OR " + e + ".isCallbackFromOutbound=1 OR notEmpty(ifNull(" + e + ".callbackCampaignId,'')),'outbound','inbound')";
const SMS_DIR = "if(notEmpty(cv.outboundTaskId) OR notEmpty(cv.followupId),'outbound','inbound')";
// A post_conversation SMS event requires a REAL customer reply — at least one human INBOUND message
// that is not just an opt-out keyword ("STOP" is the customer leaving — canonical rule). Chat keeps any
// visitor message (in a chat, "no" is an answer).
const OPT_OUT_SQL = "(" + [...OPT_OUT_KEYWORDS].map(lit).join(",") + ")";
const HUMAN_IN = "__deleted=0 AND lower(ifNull(authorType,''))='human' AND lower(ifNull(direction,''))='in'";
const SMS_HAS_REPLY =
  "cv.conversationId IN (SELECT conversationId FROM dealer_leads.smsMessages" +
  " WHERE " + HUMAN_IN + ")";
const APPT_DIR_JOIN =
  " LEFT JOIN (SELECT callId, any(" + CALL_DIR_CANON("e0") + ") dir FROM dealer_leads.endcallreports e0 WHERE e0.__deleted=0 GROUP BY callId) ecr ON ecr.callId=m.call_id";
// The lead's OWN department (leads.service_type, prefix rule) — what the cron routes SMS and chat by.
const LEAD_SVC = (teamId) =>
  "(SELECT lead_id, anyIf(lower(service_type), notEmpty(ifNull(service_type,''))) svc FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id)";
const LEAD_SVC_DEPT = "if(startsWith(ifNull(ls.svc,''),'service'),'service','sales')";
// Call gates, verbatim from the cron (eventRunner post_conversation · calls), for the default config:
// post_conversation_mode='actionable' and post_conversation_outbound_requires_reply=true.
const NO_CONV_SQL = "(" + T.NO_CONVERSATION_ENDED_REASONS.map(lit).join(",") + ")";
const CALL_HAS_AI = (e) => "ifNull(" + e + ".report_actionItems,'') NOT IN ('','[]','{}')";
const CALL_APPT = (e) => "lower(ifNull(" + e + ".report_overview_appointmentScheduled,''))='true'";
const CALL_RANK = (e) => "if(" + CALL_APPT(e) + ",2,if(" + CALL_HAS_AI(e) + ",1,0))";
function callEligibleSql(e, { mode = "actionable", outboundRequiresReply = true } = {}) {
  const ai = CALL_HAS_AI(e), appt = CALL_APPT(e);
  const unresolved = "lower(ifNull(" + e + ".report_queryResolved,''))='false'";
  const resolved = "lower(ifNull(" + e + ".report_queryResolved,''))='true'";
  const summary = "ifNull(" + e + ".report_summary, ifNull(" + e + ".callDetails_analysis_summary,''))";
  const er = "replaceAll(lower(ifNull(" + e + ".callDetails_endedReason,'')),'-','_')";
  return [
    e + ".isActive=1", e + ".__deleted=0", e + ".isTestCall=0",
    "NOT (" + er + " IN " + NO_CONV_SQL + " OR position(" + er + ",'voicemail')>0)",          // voicemail gate
    mode === "actionable" ? "(" + ai + " OR " + appt + " OR " + unresolved + ")" : "1",       // actionableOnly feed filter
    outboundRequiresReply ? "NOT (" + CALL_DIR_CANON(e) + "='outbound' AND NOT (" + ai + " OR " + appt + "))" : "1", // outbound reply gate
    "(match(" + summary + ",'[A-Za-z0-9]') OR " + ai + " OR " + appt + " OR " + resolved + ")", // substance (cleanSummary ≈ has a word)
    "lower(JSONExtractString(ifNull(" + e + ".report,'{}'),'spam'))!='yes'",                     // spam gate
  ].join(" AND ");
}
const CALL_LEAD_KEY = (e) => "if(notEmpty(ifNull(" + e + ".leadId,'')), " + e + ".leadId, " + e + ".id)";
// The cron's chat session gap (EVENT_CHAT_SESSION_GAP_MIN) — sessions decide the chat ledger key.
const CHAT_GAP_MIN = Number(process.env.EVENT_CHAT_SESSION_GAP_MIN || 30);

// The rooftop's zone for dealer-local keys when the caller didn't pass one: team settings in
// ClickHouse, US/Canada zones only (the cron's allowlist), else America/New_York. Pass `tz` (the
// rooftop's roi_rooftop_config.timezone, as the cron uses) whenever it is known.
async function zoneFor(teamId, tz) {
  if (tz && isNorthAmericanTz(tz)) return tz;
  try {
    const r = await one("SELECT timezone FROM eventila.enterprise_team_details FINAL WHERE _peerdb_is_deleted=0 AND team_id=" + lit(teamId) + " LIMIT 1");
    if (r && isNorthAmericanTz(r.timezone)) return String(r.timezone);
  } catch { /* fall through */ }
  return "America/New_York";
}

// The department an appointment belongs to ('sales' | 'service'), or null when the key doesn't
// resolve. The manual send path checks it against the tracker row the send came from (see
// /api/email/roi-event-generate-send): recipients are picked per department, so a mismatch puts one
// department's booking in the other department's inbox.
export async function meetingDeptCH(teamId, eventKey) {
  if (!teamId || !eventKey) return null;
  const row = await one("SELECT " + APPT_DEPT + " dept FROM dealer_leads.meetings m" +
    " WHERE m.team_id=" + lit(teamId) + " AND (m.meeting_id=" + lit(eventKey) + " OR m._id=" + lit(eventKey) + ")" +
    " ORDER BY m._version DESC LIMIT 1");
  return row ? row.dept : null;
}

// Chat ledger keys for one conversation's messages, exactly as the cron would build them: per dealer-
// local day, the day's last 12 bubbles, split into sessions on a CHAT_GAP_MIN lull, one key per session
// that had a visitor message. Newest first.
function chatKeysFor(conversationId, msgs, tz) {
  const byDay = new Map();
  for (const m of msgs) { const d = eventKeys.localDay(m.at, tz); const a = byDay.get(d) || []; a.push(m); byDay.set(d, a); }
  const keys = [];
  for (const [day, list] of byDay) {
    const last12 = list.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-12);
    for (const s of eventKeys.smsSessions(last12, CHAT_GAP_MIN)) if (s.hasReply) keys.push(eventKeys.chat(conversationId, day, s.startAt));
  }
  return keys.sort().reverse();
}

export async function listEventsCH({ teamId, department, emailType, direction, sinceDays = 120, limit = 200, offset = 0, tz = null, convMode = "actionable", outboundRequiresReply = true }) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server");
  if (!teamId) throw new Error("teamId required");
  const dept = department === "service" ? "service" : "sales";
  const dir = direction === "inbound" || direction === "outbound" ? direction : null; // null = both (all agents in this dept)
  const since = "now() - INTERVAL " + (Number(sinceDays) || 120) + " DAY";
  const lim = Math.min(Number(limit) || 200, 500);
  const off = Math.max(0, Number(offset) || 0); // DB-level pagination: fetch only the requested page, newest first
  const dfilt = (expr) => (dir ? " AND " + expr + "=" + lit(dir) : "");
  const zone = await zoneFor(teamId, tz);
  const Z = lit(zone);

  if (emailType === "post_appointment") {
    const dx = CALL_DIR("ecr.dir");
    // One row per booked SLOT (lead + start time): the earliest valid row is the one the cron emails,
    // later duplicates are skipped by its slot gate. FINAL = the latest version of each meeting.
    const sql =
      "SELECT * FROM (SELECT toString(m.meeting_id) eventKey, toString(m._id) rowId, toString(m.meeting_start_time) startTime, m.intent intent," +
      " m.service_type serviceType, m.status status, m.timezone mtz, toString(m.created_at) createdAt," +
      " " + dx + " direction, c.name customer, c.mobile_number phone" +
      " FROM dealer_leads.meetings AS m FINAL" + APPT_DIR_JOIN +
      " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads" + teamPred(teamId) + " GROUP BY lead_id) l ON m.lead_id=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer" + teamPred(teamId) + " GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne'" + APPT_NOT_WARM_TRANSFER + APPT_NOT_PAST_AT_BOOKING +
      " AND " + APPT_DEPT + "=" + lit(dept) + " AND m.created_at >= " + since + dfilt(dx) +
      " ORDER BY m.created_at ASC LIMIT 1 BY ifNull(m.lead_id, m._id), m.meeting_start_time)" +
      " ORDER BY createdAt DESC LIMIT " + lim + " OFFSET " + off;
    return (await runClickhouse(sql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      const w = fmtWhen(r.startTime, r.mtz || zone);
      // cronEventKeys also carries the Mongo _id: rows the cron sent before 2026-10-09 are keyed by it.
      return { eventKey: r.eventKey, cronEventKey: eventKeys.appointment(r.eventKey || r.rowId),
        cronEventKeys: [...new Set([r.eventKey, r.rowId].filter(Boolean).map(String))], customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + (w.when ? " — " + w.when : ""),
        sub: (r.serviceType === "service" ? "Service" : "Sales") + " · " + (r.direction === "outbound" ? "Outbound" : "Inbound") + (r.intent ? " · " + String(r.intent).replace(/_/g, " ") : "") };
    }).filter(Boolean);
  }

  if (emailType === "post_conversation") {
    // calls (endcallreports, dept-tagged by agentType prefix as the feed does, only calls the cron's gates pass)
    const cdx = CALL_DIR_CANON("e");
    const callSql =
      "SELECT toString(e.callId) eventKey, toString(" + CALL_LEAD_KEY("e") + ") leadKey, e.report_title title, toString(e.createdAt) createdAt," +
      " toString(toDate(toTimeZone(e.createdAt, " + Z + "))) localDay, " + CALL_RANK("e") + " rnk," +
      " " + cdx + " direction, c.name customer, c.mobile_number phone" +
      " FROM dealer_leads.endcallreports e" + identityJoins(teamId) +
      " WHERE e.teamId=" + lit(teamId) + " AND " + callEligibleSql("e", { mode: convMode, outboundRequiresReply }) +
      " AND lower(ifNull(e.callDetails_agentInfo_agentType,'')) LIKE " + lit(dept + "%") + " AND e.createdAt >= " + since + dfilt(cdx) +
      " ORDER BY e.createdAt DESC LIMIT 1 BY e.callId LIMIT " + (off + lim);
    const calls = (await runClickhouse(callSql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      return {
        eventKey: r.eventKey, cronEventKey: eventKeys.call(r.leadKey, r.localDay, Number(r.rnk)),
        customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + " — " + (r.title || "Conversation"),
        sub: r.direction === "outbound" ? "Call · Outbound" : "Call · Inbound",
      };
    }).filter(Boolean);
    // SMS conversations with a REAL reply, in the LEAD's own department; keyed on the day of the latest
    // real reply (the cron's daily digest key: sms:<lead>:<day>).
    const smsSql =
      "SELECT toString(cv.conversationId) eventKey, toString(if(notEmpty(ifNull(cv.leadId,'')), cv.leadId, cv.conversationId)) leadKey," +
      " toString(cv.createdAt) createdAt, cu.name customer, cu.mobile_number phone," +
      " toString(toDate(toTimeZone(r.lastReplyAt, " + Z + "))) replyDay, " + SMS_DIR + " direction" +
      " FROM dealer_leads.conversations cv" + convIdentity(teamId) +
      " LEFT JOIN " + LEAD_SVC(teamId) + " ls ON cv.leadId=ls.lead_id" +
      " INNER JOIN (SELECT conversationId, max(createdAt) lastReplyAt FROM dealer_leads.smsMessages WHERE " + HUMAN_IN +
      " AND upper(trimBoth(ifNull(body,''))) NOT IN " + OPT_OUT_SQL + " AND createdAt >= " + since +
      " AND conversationId IN (SELECT conversationId FROM dealer_leads.conversations WHERE teamId=" + lit(teamId) + " AND type='sms')" +
      " GROUP BY conversationId) r ON r.conversationId=cv.conversationId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId)" +
      " AND " + LEAD_SVC_DEPT + "=" + lit(dept) + dfilt(SMS_DIR) +
      " ORDER BY r.lastReplyAt DESC LIMIT 1 BY cv.conversationId LIMIT " + (off + lim);
    const sms = (await runClickhouse(smsSql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      return {
        eventKey: "sms:" + r.eventKey, cronEventKey: eventKeys.sms(r.leadKey, r.replyDay),
        customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
        label: who + " — Text conversation", sub: r.direction === "outbound" ? "SMS · Outbound" : "SMS · Inbound",
      };
    }).filter(Boolean);
    // website chats (always inbound — the visitor opened the widget on the dealer's own site), in the
    // LEAD's department (the cron's rule since 65a308d), any visitor message. Keys per settled session.
    const chatSql =
      "SELECT toString(cv.conversationId) eventKey, toString(cv.createdAt) createdAt, cu.name customer," +
      " coalesce(nullIf(cu.mobile_number,''), cv.number) phone, b.ats ats, b.atypes atypes, b.dirs dirs" +
      " FROM dealer_leads.conversations cv" + convIdentity(teamId) +
      " LEFT JOIN " + LEAD_SVC(teamId) + " ls ON cv.leadId=ls.lead_id" +
      " INNER JOIN (SELECT conversationId, groupArray(500)(formatDateTime(createdAt,'%Y-%m-%dT%H:%i:%SZ')) ats," +
      " groupArray(500)(lower(ifNull(authorType,''))) atypes, groupArray(500)(lower(ifNull(direction,''))) dirs" +
      " FROM dealer_leads.smsMessages WHERE __deleted=0 AND createdAt >= " + since +
      " AND conversationId IN (SELECT conversationId FROM dealer_leads.conversations WHERE teamId=" + lit(teamId) + " AND type='chat')" +
      " GROUP BY conversationId HAVING countIf(" + HUMAN_IN.replace("__deleted=0 AND ", "") + ") > 0) b ON b.conversationId=cv.conversationId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='chat' AND ifNull(cv.isTest,0)=0" +
      " AND (notEmpty(cv.leadId) OR notEmpty(ifNull(cv.number,''))) AND " + LEAD_SVC_DEPT + "=" + lit(dept) +
      " ORDER BY cv.createdAt DESC LIMIT 1 BY cv.conversationId LIMIT " + (off + lim);
    const chats = dir === "outbound" ? [] : (await runClickhouse(chatSql)).map((r) => {
      const who = displayName(r);
      if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
      const ats = Array.isArray(r.ats) ? r.ats : [], types = Array.isArray(r.atypes) ? r.atypes : [], dirs = Array.isArray(r.dirs) ? r.dirs : [];
      const msgs = ats.map((at, i) => ({ at, authorType: types[i], direction: dirs[i] === "in" ? "inbound" : "outbound" }));
      const keys = chatKeysFor(r.eventKey, msgs, zone);
      return {
        eventKey: "chat:" + r.eventKey, cronEventKey: keys[0] || null, cronEventKeys: keys,
        customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: "inbound",
        label: who + " — Website chat", sub: "Chat · Inbound",
      };
    }).filter(Boolean);
    return [...calls, ...sms, ...chats].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(off, off + lim);
  }

  // action_item / action_item_overdue — lead level (matches the generator's lead:<id> grouping),
  // from the curated actionItems feed. One row per lead = one email; direction is inferred per-lead
  // from that lead's calls (action items carry none of their own), so the IB/OB filter still works.
  const aiScope = emailType === "action_item_overdue" ? "overdue" : "open";
  const dirExpr = "coalesce(nullIf(dirm.dir,''),'inbound')"; // LEFT JOIN misses fill '' (not NULL) for no-call leads
  const sql =
    "SELECT a.leadId leadId, count() nItems, max(a.createdAt) createdAt, toString(argMax(a._id, a.createdAt)) newestId, groupArray(50)(toString(a._id)) itemIds," +
    " " + dirExpr + " direction, any(c.name) customer, any(c.mobile_number) phone" +
    " FROM (" + aiBaseSql({ teamId, dept, scope: aiScope, since }) + ") a" +
    " LEFT JOIN " + LEAD_DIR_MAP + " dirm ON a.leadId=dirm.leadId" + aiIdentity(teamId) +
    " GROUP BY a.leadId, dirm.dir" + (dir ? " HAVING " + dirExpr + "=" + lit(dir) : "") +
    " ORDER BY createdAt DESC LIMIT " + lim + " OFFSET " + off;
  // Overdue rows belong to the rooftop digest, which has one key per local day and slot; the row lists
  // today's two (the tracker matches whichever went out).
  const today = eventKeys.localDay(null, zone);
  return (await runClickhouse(sql)).map((r) => {
    const who = displayName(r);
    if (!who) return null; // drop truly-anonymous junk (no name AND no phone)
    const n = Number(r.nItems) || 0;
    const keys = emailType === "action_item_overdue"
      ? { cronEventKey: eventKeys.overdue(teamId, dept, today, "am"), cronEventKeys: ["am", "eod"].map((slot) => eventKeys.overdue(teamId, dept, today, slot)) }
      // one email per arrived item: the newest is the latest email's key, the rest match earlier ones
      : { cronEventKey: eventKeys.actionItem(r.leadId, r.newestId),
          cronEventKeys: [...new Set([r.newestId, ...(Array.isArray(r.itemIds) ? r.itemIds : [])].filter(Boolean))].map((id) => eventKeys.actionItem(r.leadId, id)) };
    return {
      eventKey: "lead:" + r.leadId, ...keys, customer: who, phone: r.phone || "", createdAt: r.createdAt, direction: r.direction,
      label: who + " — " + n + " action item" + (n === 1 ? "" : "s"),
      sub: r.direction === "outbound" ? "Outbound" : "Inbound",
    };
  }).filter(Boolean);
}

// ── COUNT real transactional events per (team × dept × type), live from ClickHouse ──
// Grouped scans → the tracker's grid totals reflect ALL real events (history + live), not just the
// sparse generated rows. Read-only. Since 2026-10-09 these count what the CRON would send, at the
// cron's grain: one per booked slot, one per (lead, day, outcome tier) call key, one per (lead, day)
// with a real SMS reply, one per (chat, day), one per lead with actionable open/overdue items. The
// fleet-wide grid buckets days in UTC (no single zone); the per-day drill-down uses the dealer's.
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
    " " + CALL_DIR("ecr.dir") + " direction, uniqExact(tuple(ifNull(m.lead_id, m._id), m.meeting_start_time)) total, toString(max(m.created_at)) last_at" +
    " FROM dealer_leads.meetings AS m FINAL" + APPT_DIR_JOIN +
    " WHERE m.is_active=1 AND m.source='spyne'" + APPT_NOT_WARM_TRANSFER + APPT_NOT_PAST_AT_BOOKING + " AND m.created_at >= " + since +
    " GROUP BY team_id, department, direction"), "post_appointment", "total");
  // post_conversation = calls + SMS + chats, merged per team×dept×direction.
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
    "SELECT e.teamId team_id, if(startsWith(lower(ifNull(e.callDetails_agentInfo_agentType,'')),'service'),'service','sales') department," +
    " " + CALL_DIR_CANON("e") + " direction, uniqExact(tuple(" + CALL_LEAD_KEY("e") + ", toDate(e.createdAt), " + CALL_RANK("e") + ")) total, toString(max(e.createdAt)) last_at" +
    " FROM dealer_leads.endcallreports e WHERE " + callEligibleSql("e") +
    " AND (startsWith(lower(ifNull(e.callDetails_agentInfo_agentType,'')),'sales') OR startsWith(lower(ifNull(e.callDetails_agentInfo_agentType,'')),'service'))" +
    " AND e.createdAt >= " + since +
    " GROUP BY team_id, department, direction"), "total");
  fold(await runClickhouse(
    "SELECT cv.teamId team_id, " + LEAD_SVC_DEPT + " department, " + SMS_DIR + " direction," +
    " uniqExact(tuple(if(notEmpty(ifNull(cv.leadId,'')), cv.leadId, cv.conversationId), r.d)) total, toString(max(r.at)) last_at" +
    " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_SVC(null) + " ls ON cv.leadId=ls.lead_id" +
    " INNER JOIN (SELECT conversationId, toDate(createdAt) d, max(createdAt) at FROM dealer_leads.smsMessages WHERE " + HUMAN_IN +
    " AND upper(trimBoth(ifNull(body,''))) NOT IN " + OPT_OUT_SQL + " AND createdAt >= " + since + " GROUP BY conversationId, d) r ON r.conversationId=cv.conversationId" +
    " WHERE cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId)" +
    " GROUP BY team_id, department, direction"), "total");
  fold(await runClickhouse(
    "SELECT cv.teamId team_id, " + LEAD_SVC_DEPT + " department, 'inbound' direction," +
    " uniqExact(tuple(cv.conversationId, r.d)) total, toString(max(r.at)) last_at" +
    " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_SVC(null) + " ls ON cv.leadId=ls.lead_id" +
    " INNER JOIN (SELECT conversationId, toDate(createdAt) d, max(createdAt) at FROM dealer_leads.smsMessages WHERE " + HUMAN_IN +
    " AND createdAt >= " + since + " GROUP BY conversationId, d) r ON r.conversationId=cv.conversationId" +
    " WHERE cv.type='chat' AND ifNull(cv.isTest,0)=0 AND (notEmpty(cv.leadId) OR notEmpty(ifNull(cv.number,'')))" +
    " GROUP BY team_id, department"), "total");
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

// ── PER-DAY mini-report counts for ONE (team × dept × type), live from ClickHouse ──
// Powers the tracker drill-down's per-day header ("Created · Closed · Eligible" + Sent overlaid
// from Supabase in the endpoint). Days are bucketed in the DEALER's local zone (canonical
// windowing) so the header dates line up with the dealer's day, not UTC or the CSM's browser.
//   created  = source items that appeared that day (appointments booked / conversations had /
//              action items created). For action items this is the raw created count.
//   closed   = ACTION ITEMS ONLY — items marked complete that day (bucketed on updatedAt, when the
//              is_completed flag flipped). N/A (0) for appointments/conversations (no completion state).
//   eligible = what the CRON would send that day, at its key grain (see countEventsCH) — so the
//              header's Eligible and Sent are the same unit and can reconcile.
// Returns { 'YYYY-MM-DD': { created, closed, eligible } }. Sent is merged in by the endpoint.
export async function countEventsByDayCH({ teamId, department, emailType, tz = "America/New_York", sinceDays = 120, convMode = "actionable", outboundRequiresReply = true }) {
  if (!hasClickhouseCreds()) throw new Error("ClickHouse not configured on this server");
  if (!teamId) throw new Error("teamId required");
  const dept = department === "service" ? "service" : "sales";
  const since = "now() - INTERVAL " + (Number(sinceDays) || 120) + " DAY";
  const Z = lit(tz || "America/New_York");
  const day = (col) => "toString(toDate(toTimeZone(" + col + ", " + Z + ")))"; // dealer-local calendar date
  const days = new Map(); // 'YYYY-MM-DD' → { created, closed, eligible }
  const bump = (rows, field) => {
    for (const r of rows) {
      const d = String(r.day || "");
      if (!d || d === "1970-01-01") continue;
      const o = days.get(d) || { created: 0, closed: 0, eligible: 0 };
      o[field] += Number(r.n) || 0;
      days.set(d, o);
    }
  };

  if (emailType === "post_appointment") {
    const base = " FROM dealer_leads.meetings AS m FINAL WHERE m.team_id=" + lit(teamId) + " AND m.is_active=1 AND m.source='spyne'" +
      " AND if(m.service_type='service','service','sales')=" + lit(dept) + " AND m.created_at >= " + since;
    // created = Vini bookings that day (pulled-in rows are not bookings); eligible = what the cron sends.
    bump(await runClickhouse("SELECT " + day("m.created_at") + " day, uniqExact(m.meeting_id) n" + base +
      " AND lower(JSONExtractString(ifNull(m.meta,''),'source')) NOT IN ('warm_transfer','callback') GROUP BY day"), "created");
    bump(await runClickhouse("SELECT " + day("m.created_at") + " day, uniqExact(tuple(ifNull(m.lead_id, m._id), m.meeting_start_time)) n" + base +
      APPT_NOT_WARM_TRANSFER + APPT_NOT_PAST_AT_BOOKING + " GROUP BY day"), "eligible");
  } else if (emailType === "post_conversation") {
    // created = calls had that day; eligible = call keys the cron would claim.
    const callBase = " FROM dealer_leads.endcallreports e WHERE e.teamId=" + lit(teamId) + " AND e.isTestCall=0 AND e.__deleted=0" +
      " AND lower(ifNull(e.callDetails_agentInfo_agentType,'')) LIKE " + lit(dept + "%") + " AND e.createdAt >= " + since;
    bump(await runClickhouse("SELECT " + day("e.createdAt") + " day, uniqExact(e.callId) n" + callBase + " GROUP BY day"), "created");
    bump(await runClickhouse("SELECT " + day("e.createdAt") + " day, uniqExact(tuple(" + CALL_LEAD_KEY("e") + ", " + CALL_RANK("e") + ")) n" + callBase +
      " AND " + callEligibleSql("e", { mode: convMode, outboundRequiresReply }) + " GROUP BY day"), "eligible");
    // SMS: (lead, day) pairs with a real reply, in the lead's department — created == eligible.
    const sms = await runClickhouse(
      "SELECT r.d day, uniqExact(if(notEmpty(ifNull(cv.leadId,'')), cv.leadId, cv.conversationId)) n" +
      " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_SVC(teamId) + " ls ON cv.leadId=ls.lead_id" +
      " INNER JOIN (SELECT conversationId, " + day("createdAt") + " d FROM dealer_leads.smsMessages WHERE " + HUMAN_IN +
      " AND upper(trimBoth(ifNull(body,''))) NOT IN " + OPT_OUT_SQL + " AND createdAt >= " + since +
      " AND conversationId IN (SELECT conversationId FROM dealer_leads.conversations WHERE teamId=" + lit(teamId) + " AND type='sms')" +
      " GROUP BY conversationId, d) r ON r.conversationId=cv.conversationId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='sms' AND cv.isTest=0 AND notEmpty(cv.leadId)" +
      " AND " + LEAD_SVC_DEPT + "=" + lit(dept) + " GROUP BY day");
    bump(sms, "created"); bump(sms, "eligible");
    // chats: (conversation, day) pairs with a visitor message, in the lead's department.
    const chats = await runClickhouse(
      "SELECT r.d day, uniqExact(cv.conversationId) n" +
      " FROM dealer_leads.conversations cv LEFT JOIN " + LEAD_SVC(teamId) + " ls ON cv.leadId=ls.lead_id" +
      " INNER JOIN (SELECT conversationId, " + day("createdAt") + " d FROM dealer_leads.smsMessages WHERE " + HUMAN_IN +
      " AND createdAt >= " + since +
      " AND conversationId IN (SELECT conversationId FROM dealer_leads.conversations WHERE teamId=" + lit(teamId) + " AND type='chat')" +
      " GROUP BY conversationId, d) r ON r.conversationId=cv.conversationId" +
      " WHERE cv.teamId=" + lit(teamId) + " AND cv.type='chat' AND ifNull(cv.isTest,0)=0" +
      " AND (notEmpty(cv.leadId) OR notEmpty(ifNull(cv.number,''))) AND " + LEAD_SVC_DEPT + "=" + lit(dept) + " GROUP BY day");
    bump(chats, "created"); bump(chats, "eligible");
  } else {
    // action_item / action_item_overdue
    const aiScope = emailType === "action_item_overdue" ? "overdue" : "open";
    // created — raw items created that day (deduped to the latest _version per _id).
    const created = await runClickhouse(
      "SELECT " + day("createdAt") + " day, count() n FROM (" +
      "SELECT _id, createdAt, is_active, __deleted, service_type FROM dealer_leads.actionItems" +
      " WHERE team_id=" + lit(teamId) + " AND createdAt >= " + since +
      " ORDER BY _version DESC LIMIT 1 BY _id) WHERE ifNull(is_active,1)=1 AND __deleted=0 AND " + AI_DEPT + "=" + lit(dept) + " GROUP BY day");
    bump(created, "created");
    // closed — items completed that day (bucketed on updatedAt, when is_completed flipped).
    const closed = await runClickhouse(
      "SELECT " + day("updatedAt") + " day, count() n FROM (" +
      "SELECT _id, updatedAt, is_active, __deleted, is_completed, service_type FROM dealer_leads.actionItems" +
      " WHERE team_id=" + lit(teamId) + " AND updatedAt >= " + since +
      " ORDER BY _version DESC LIMIT 1 BY _id) WHERE ifNull(is_active,1)=1 AND __deleted=0 AND ifNull(is_completed,0)=1 AND " + AI_DEPT + "=" + lit(dept) + " GROUP BY day");
    bump(closed, "closed");
    // eligible — distinct open/overdue actionable leads, filed under the lead's latest item day (matches listEventsCH).
    const elig = await runClickhouse(
      "SELECT " + day("lastAt") + " day, uniqExact(leadId) n FROM (" +
      "SELECT leadId, max(createdAt) lastAt FROM (" + aiBaseSql({ teamId, dept, scope: aiScope, since }) + ") GROUP BY leadId) GROUP BY day");
    bump(elig, "eligible");
  }
  const outObj = {};
  for (const [d, o] of days) outObj[d] = o;
  return outObj;
}
