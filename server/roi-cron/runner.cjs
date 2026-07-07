#!/usr/bin/env node
/* ROI Email — complete local cron (one process, runs the whole flow).
 *
 * Flow (per the spec):
 *   Step 0&1  finalized set = roi_live_departments.is_live + roi_recipients (who receives)
 *   Step 2    fetch metrics from the Reporting API (reporting-vini, Supabase-backed) per team+dept
 *             → store in roi_digest_runs with status 'queued' (data fetched, not sent yet)
 *   Step 3    validate guardrails on the data
 *   Step 4    SEND via the mail curl IFF: team live ✔ · recipients added ✔ · guardrails pass ✔ ·
 *             send-hour reached ✔ · not already sent today ✔
 *   Loop      every hour
 *
 * SAFETY: DRY_RUN defaults to TRUE — it renders + records 'suppressed/dry_run' and sends NOTHING.
 *         Set DRY_RUN=false to actually email. A rooftop with roi_live_departments.dry_run=true is
 *         always held even when DRY_RUN=false.
 *
 *   node runner.cjs            # one pass
 *   node runner.cjs --loop     # run now, then every hour
 */
const { createClient } = require("@supabase/supabase-js");
// Single source of truth for the digest HTML — the SAME module the SPA preview
// (src/email/renderDigest.ts) imports, so the cron-sent bytes never drift from
// what the tracker shows.
const { renderDigestHtml } = require("../../src/email/digestTemplate.cjs");
// Anti-churn value gate — never email a no-value digest unless overridden (DANGER).
const emailValue = require("./emailValue.cjs");
// Terse digest SMS renderer (companion to the rich email) + the Twilio sender.
const T = require("../../src/email/transactionalTemplates.cjs");
const { sendSms, SMS_DRY_RUN } = require("./sendSms.cjs");
// Per-recipient subscription matrix (who gets which type on which channel).
const { isSubscribed } = require("./subscriptions.cjs");

// Digest recipients for a channel, filtered by dept + per-channel master + the subscription matrix.
// Digests are rooftop summaries → NO role tiering (everyone subscribed gets them).
// GATE (r.verified_at): a rooftop only emails recipients a human verified for it — the guarantee
// against cross-rooftop leaks. Unverified rows are held; the daily audit alert surfaces them.
function subscribedEmails(recips, dept, type) {
  return (recips ?? [])
    .filter((r) => r.verified_at && (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled && isSubscribed(r, type, "email"))
    .map((r) => r.email);
}
function subscribedSmsRecips(recips, dept, type, rooftopSmsEnabled) {
  if (!rooftopSmsEnabled) return [];
  return (recips ?? [])
    .filter((r) => r.verified_at && (dept === "sales" ? r.receives_sales : r.receives_service) && r.sms_enabled && r.phone && isSubscribed(r, type, "sms"))
    .map((r) => ({ phone: r.phone, role: r.role }));
}
// Send a digest SMS with its own dedupe (roi_event_sms, one per team+dept+cadence+day). Never
// throws to the caller — a digest SMS failure must not break the email path.
async function sendDigestSms(sbc, base, cadence, localDate, smsRecips, body) {
  const eventKey = `${cadence}:${base.department}:${localDate}`;
  try {
    const { data, error } = await sbc.from("roi_event_sms").insert({ ...base, email_type: cadence, event_key: eventKey, status: "queued" }).select("id");
    if (error) { if ((error.code || "") === "23505") return { dupe: true }; throw error; }
    const id = data && data[0] ? data[0].id : null;
    const results = [];
    for (const r of smsRecips) {
      try { const msid = await sendSms(r.phone, body, { dryRun: false }); results.push({ phone: r.phone, role: r.role, sid: msid, sent: true }); }
      catch (e) { results.push({ phone: r.phone, role: r.role, error: String(e.message || e).slice(0, 200) }); }
    }
    const anySent = results.some((x) => x.sent);
    const firstSid = (results.find((x) => x.sid) || {}).sid || null;
    await sbc.from("roi_event_sms").update({ status: anySent ? "sent" : "error", reason: anySent ? null : "all_recipients_failed", body, message_sid: firstSid, sent_at: anySent ? new Date().toISOString() : null, recipients: results }).eq("id", id);
    return { sent: anySent, error: anySent ? null : ((results.find((x) => x.error) || {}).error || "all recipients failed") };
  } catch (e) { const msg = String(e && e.message ? e.message : e).slice(0, 200); console.warn("[roi-cron] digest sms skipped:", msg); return { error: msg }; }
}

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MAIL_URL = process.env.MAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
const MAIL_TEMPLATE = process.env.MAIL_TEMPLATE || "email-control-tower-report";
const MAIL_TOKEN = process.env.MAIL_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN !== "false";               // default ON
// Metrics source: the Reporting API (Supabase-backed) at reporting-vini. Metabase has been removed.
const REPORTING_API_BASE = process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app";
// The reporting-vini read API requires a credential (it returns PII). Forward the trusted service
// secret (preferred) or the Spyne token so server-to-server calls authorize; else they 401.
const REPORTING_AUTH = process.env.CRON_SECRET || process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";

// ── Per-appointment dollar value (whiteboard spec) ───────────────────────────
// Same per-category rates as the Programs dashboard (src/agents/AgentsDashboard.tsx):
//   Sales Inbound $200 · Sales Outbound $250 · Service Inbound $100 · Service Outbound $200.
// The digest is per-DEPARTMENT and the meetings API has no inbound/outbound split
// (see reporting-vini src/lib/spyne/meetings.ts), so the per-row "Est. value" uses the
// department average of its two directions: Sales = avg(200,250) = 225, Service =
// avg(100,200) = 150. Env vars still override for ad-hoc tuning.
const APPT_DOLLAR = { sales_inbound: 200, sales_outbound: 250, service_inbound: 100, service_outbound: 200 };
const DIGEST_DOLLAR_RATE_SALES = (APPT_DOLLAR.sales_inbound + APPT_DOLLAR.sales_outbound) / 2;     // 225
const DIGEST_DOLLAR_RATE_SERVICE = (APPT_DOLLAR.service_inbound + APPT_DOLLAR.service_outbound) / 2; // 150
function digestDollarRate(department) {
  return Number(department === "service"
    ? (process.env.DIGEST_DOLLAR_RATE_SERVICE || DIGEST_DOLLAR_RATE_SERVICE)
    : (process.env.DIGEST_DOLLAR_RATE_SALES || DIGEST_DOLLAR_RATE_SALES));
}

// --rerender only re-renders rendered_html from already-stored metrics → Supabase only, no Metabase.
const RERENDER_ONLY = process.argv.includes("--rerender");
// When run as a CLI we hard-fail on missing config; when imported (Vercel function, tests) we don't
// call process.exit — the caller surfaces the error instead.
const IS_CLI = require.main === module;
if (IS_CLI) {
  if (!SB_URL || !SB_KEY) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
}
const sb = createClient(SB_URL || "http://invalid.local", SB_KEY || "noop", { auth: { persistSession: false } });

// ── dealer-local "today"/"yesterday" + send hour + UTC windows (start/end/month) ──
const fmtUTC = (d) => d.toISOString().slice(0, 19).replace("T", " ");
function localToUTC(y, m, day, tz) {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(approx);
  const g = (t) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - asUTC.getTime()));
}
function localParts(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const Y = g("year"), M = g("month"), D = g("day"), H = g("hour") === 24 ? 0 : g("hour");
  const pad = (n) => String(n).padStart(2, "0");
  // "Yesterday" (the reported day) with calendar-safe month/year rollover. The old naive `D - 1`
  // produced a malformed `YYYY-MM-00` on the 1st of the month, corrupting the API window every month.
  const yd = new Date(Date.UTC(Y, M - 1, D - 1));
  const yY = yd.getUTCFullYear(), yM = yd.getUTCMonth() + 1, yD = yd.getUTCDate();
  const yStart = localToUTC(yY, yM, yD, tz);
  const yEnd = new Date(localToUTC(Y, M, D, tz).getTime() - 1000);
  const monthStart = localToUTC(yY, yM, 1, tz);   // first of the reported (yesterday's) month
  const localDate = `${yY}-${pad(yM)}-${pad(yD)}`;
  const dateLabel = new Date(yStart.getTime()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  // apiEnd stays "today" (exclusive end) → the day window is yesterday..today = the reported day,
  // and MTD is the first of yesterday's month..today.
  return { localHour: H, localDate, dateLabel, yStart: fmtUTC(yStart), yEnd: fmtUTC(yEnd), monthStart: fmtUTC(monthStart),
    apiStart: localDate, apiEnd: `${Y}-${pad(M)}-${pad(D)}`, apiMonthStart: `${yY}-${pad(yM)}-01` };
}

// ── Reporting API source (reporting-vini, Supabase-backed) — the only metrics source ──
// One team/window fetch returns all 4 agents (Sales/Service × Inbound/Outbound). We combine
// each dept's Inbound+Outbound into the same `m` shape the Metabase path produces.
const _apiCache = new Map(); // dedupe + memoize (team|start|end) within a run
async function apiReport(teamId, start, end) {
  const k = `${teamId}|${start}|${end}`;
  if (_apiCache.has(k)) return _apiCache.get(k);
  const p = (async () => {
    const res = await fetch(`${REPORTING_API_BASE}/api/reports?team_id=${encodeURIComponent(teamId)}&start=${start}&end=${end}`, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {} });
    if (!res.ok) throw new Error(`reporting-api ${res.status} (${teamId} ${start}..${end}): ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    // The reporting API returns a zeroed report with `degraded:true` on a backend read failure.
    // Treat that as a hard error so the digest holds (guardrail → no_data) instead of emailing
    // "0 calls, 0 appointments" — sending zeros during an outage is itself a churn risk.
    if (j && j.degraded) throw new Error(`reporting-api degraded (${teamId} ${start}..${end}) — holding digest`);
    const byName = {};
    for (const a of j.agents || []) byName[a.name] = a;
    return byName;
  })();
  _apiCache.set(k, p);
  return p;
}
const apiPickDept = (byName, dept) => {
  const D = dept === "service" ? "Service" : "Sales";
  return { ib: byName[`${D} Inbound`] || {}, ob: byName[`${D} Outbound`] || {} };
};
async function apiMetrics(teamId, dept, start, end) {
  const { ib, ob } = apiPickDept(await apiReport(teamId, start, end), dept);
  const n = (v) => Number(v) || 0;
  const im = ib.metrics || {}, om = ob.metrics || {}, ics = ib.channelSplit || {}, ocs = ob.channelSplit || {}, ir = ib.report || {}, or = ob.report || {};
  const sm = ir.summary || {};
  // SMS counts = MESSAGES (metrics.smsSent), matching the console / reporting-vini dashboard's
  // "Total SMS" — NOT channelSplit.sms (conversation threads), which undercounts (1 thread = many
  // messages). smsSent is scoped to real agent conversations, so automated blasts are excluded.
  // Verified: Dream Nissan Lawrence 6/25 console out 24 = om.smsSent 24; in 36 ≈ im.smsSent 37.
  // Calls keep channelSplit.voice (≈ one call per conversation).
  const callIn = n(ics.voice), smsIn = n(im.smsSent), callOut = n(ocs.voice), smsOut = n(om.smsSent);
  const obCalls = n(om.calls), obRate = n(om.connectRate), cf = ir.callFlow || {};
  const calls = n(im.calls), after = n(im.afterHours);
  // Leads WORKED = inbound + outbound (leadFunnel.contacted is the funnel top; falls back to the
  // report's leadsAttempted). On an outbound-heavy rooftop the inbound count is tiny, so the hero's
  // no-appointment fallback must include outbound or it collapses to ~0 (e.g. Corn Husker: 2 inbound
  // vs 1,830 outbound leads). "Warm" = qualified across both funnels.
  const ibf = ib.leadFunnel || {}, obf = ob.leadFunnel || {};
  const ibLeads = n(ibf.contacted) || n(ir.leadsAttempted);
  const obLeads = n(obf.contacted) || n(or.leadsAttempted);
  const totalLeadsWorked = ibLeads + obLeads;
  const warmWorked = n(ibf.qualified) + n(obf.qualified);
  return {
    appointmentsYesterday: n(im.appointments) + n(om.appointments), appointmentsInbound: n(im.appointments),
    inboundUniqueLeads: ibLeads, totalLeads: totalLeadsWorked,
    // Legacy inbound-leads value (report.leadsAttempted) — what the classic v1 email + its
    // guardrail used before the leadFunnel.contacted switch. Kept so a rooftop still on the
    // 'v1' (classic) daily template renders byte-for-byte the same numbers it does in prod.
    inboundUniqueLeadsLegacy: n(ir.leadsAttempted),
    // warm leads kept moving even when nothing booked (drives the no-appointment hero) — both funnels
    warmLeads: warmWorked || totalLeadsWorked,
    conversationsCall: callIn + callOut, conversationsSms: smsIn + smsOut, conversationsChat: 0, conversationsHandled: callIn + callOut + smsIn + smsOut,
    // DISPLAYED "Conversations" = reached/two-way conversations, deduped per lead (the funnel's
    // `connected` stage: a connected call OR an SMS that got a human reply). This is what the console's
    // Conversations metric counts. The channelSplit-based conversationsHandled above stays as raw
    // call/SMS activity (channel-breakdown bars + the send guardrail) — see Jun-2026 console-vs-digest bug.
    conversationsReached: n(ibf.connected) + n(obf.connected), conversationsInbound: n(ibf.connected),
    conversationsCallIn: callIn, conversationsSmsIn: smsIn, conversationsChatIn: 0,
    conversationsCallOut: callOut, conversationsSmsOut: smsOut, conversationsChatOut: 0,
    // ── redesign fields (Conversational AI 2.0) ──────────────────────────────
    agentPerson: sm.person || "",
    callsHandled: calls,                                   // "total calls handled"
    // "Leads Qualified" = distinct qualified LEADS (funnel stage), matching the console. Was
    // metrics.qualified = per-conversation qualified EVENTS, which over-counts a lead qualified on
    // multiple conversations (e.g. Covina Kia 6/27: console 31 = leadFunnel.qualified vs event 50).
    qualifiedLeads: ib.leadFunnel ? n(ibf.qualified) : n(im.qualified), qualifiedPct: n(ir.qualifiedPct),
    bookingRate: n(ir.abr != null ? ir.abr : sm.bookingRate), // ABR % for the booking-rate tile
    deltas: ir.deltas || {},                               // ▲▼ vs prior period
    intent: Array.isArray(ir.intent) ? ir.intent : [],     // query-resolution donut
    queries: Array.isArray(ir.queries) ? ir.queries : [],  // resolution rate (resolved/total)
    leadsBySource: Array.isArray(ir.leadsBySource) ? ir.leadsBySource : [], // lead activity
    leadFunnel: ib.leadFunnel || null,
    outcomes: Array.isArray(ob.outcomes) ? ob.outcomes : [], // outbound outcomes bars
    callingDuring: Math.max(0, calls - after), callingAfter: after, // calling hours during/after
    // ── outbound ──────────────────────────────────────────────────────────────
    outboundUniqueReached: n(om.conversations), outboundTotalCalls: obCalls, outboundConnected: Math.round((obCalls * obRate) / 100),
    outboundConnectRate: obRate, outboundAppointmentsSet: n(om.appointments),
    warmTransfers: n(cf.transferred), transferTotalCalls: n(cf.total), transferCount: n(cf.transferred), transferRate: 0,
    // Inbound "what the agent did" outputs (cf = INBOUND callFlow). Transfers feed the inbound outputs
    // row; callbacks the template derives from the action-item list (request_callback). cf.transferred
    // is console-aligned: reporting-vini derives it from endcallreports.callDetails_endedReason='transferred'
    // (matches the Calls tab, e.g. Honda DTLA 94≈93) — NOT the zero-filled endcallreports.callTransferred.
    inboundTransfers: n(cf.transferred), inboundTransferTotal: n(cf.total),
  };
}
async function apiActionItems(teamId, dept, start, end) {
  try {
    const { ib } = apiPickDept(await apiReport(teamId, start, end), dept);
    const items = ((ib.report || {}).intent || []).map((i) => ({ intent: i.label, count: Number(i.value) || 0 })).filter((i) => i.count > 0);
    return { total: items.reduce((s, i) => s + i.count, 0), items };
  } catch { return { total: 0, items: [] }; }
}
async function apiCampaigns(teamId, dept, start, end) {
  try {
    const { ob } = apiPickDept(await apiReport(teamId, start, end), dept);
    const mapped = ((ob.report || {}).activeCampaigns || []).map((c) => {
      const dials = Number(c.enrolled) || 0, appts = Number(c.appts) || 0;
      const conversion = c.apptRate != null ? `${Number(c.apptRate).toFixed(1)}%` : dials > 0 ? `${((appts * 100) / dials).toFixed(1)}%` : "0%";
      return { name: (c.name || "").trim() || "Campaign", dials, appts, conversion };
    }).filter((c) => c.dials > 0);
    // dedupe by name (keep the highest-enrolled row), then surface the most productive — sorted by
    // appts desc then enrolled desc, capped — so a long recall list can't bloat the email.
    const byName = new Map();
    for (const c of mapped) { const e = byName.get(c.name); if (!e || c.dials > e.dials) byName.set(c.name, c); }
    return [...byName.values()].sort((a, b) => b.appts - a.appts || b.dials - a.dials).slice(0, 8);
  } catch { return []; }
}
// metric fetchers — Reporting API only (day window = apiStart..apiEnd, MTD = apiMonthStart..apiEnd)
const getMetrics = (teamId, dept, w, win) => apiMetrics(teamId, dept, win === "mtd" ? w.apiMonthStart : w.apiStart, w.apiEnd);
const getActionItems = (teamId, dept, w) => apiActionItems(teamId, dept, w.apiStart, w.apiEnd);
const getCampaigns = (teamId, dept, w) => apiCampaigns(teamId, dept, w.apiStart, w.apiEnd);

// ── guardrails ──────────────────────────────────────────────────────────────
// Send whenever there is ANY activity — calls handled, leads, appointments,
// outbound dials or action items. A low-ABR / zero-appointment day is NOT
// suppressed: the email still goes out and leads the story with lead activity
// (warm leads, leads-by-source) instead of appointments. Only a truly empty
// day (no signal at all) is held back as no_data.
function guardrail(m) {
  const signal =
    (m.appointmentsYesterday || 0) +
    (m.conversationsHandled || 0) +
    (m.callsHandled || 0) +
    (m.inboundUniqueLeads || 0) +
    (m.outboundTotalCalls || 0) +
    (m.actionItemsTotal || 0);
  if (signal === 0) return { ok: false, reason: "no_data" };
  return { ok: true };
}

// Classic (v1) guardrail — the ORIGINAL production send rule: holds back both empty
// days (no_data) AND "not_actionable" days (no appts, no leads, no action items).
// A rooftop on the 'v1' daily template uses THIS so its send-cadence is unchanged.
// Reads inboundUniqueLeads (callers pass the legacy-shimmed metrics for v1).
function guardrailV1(m) {
  const signal = (m.appointmentsYesterday || 0) + (m.conversationsHandled || 0) + (m.inboundUniqueLeads || 0) + (m.actionItemsTotal || 0);
  if (signal === 0) return { ok: false, reason: "no_data" };
  if ((m.appointmentsYesterday || 0) === 0 && (m.actionItemsTotal || 0) === 0 && (m.inboundUniqueLeads || 0) === 0) return { ok: false, reason: "not_actionable" };
  return { ok: true };
}

// ── email HTML (email-safe table; real console links) ───────────────────────
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function links(ent, team, dept, localDate, tz) {
  const enc = encodeURIComponent;
  const start = `${localDate}T04:00:00.000Z`; // ET window for the deep links
  const [y, mo, d] = localDate.split("-").map(Number);
  const nd = new Date(Date.UTC(y, mo - 1, d + 1)); const endDate = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
  const end = `${endDate}T03:59:59.999Z`;
  const b = "https://console.spyne.ai/converse-ai";
  return {
    appts: `${b}/appointments?enterprise_id=${ent}&team_id=${team}&all_createdAtStart=${enc(start)}&all_createdAtEnd=${enc(end)}&all_createdAtDateValue=yesterday&page=1&serviceType=${dept}&tab=all`,
    conv: `${b}/conversations?enterprise_id=${ent}&team_id=${team}`,
    action: `${b}/action-items?enterprise_id=${ent}&team_id=${team}&serviceType=${dept}&createdAtStart=${enc(start)}&createdAtEnd=${enc(end)}&page=1`,
    // "Open console" deep-link → the rooftop's reports page. Was a bare base URL with no
    // enterprise_id/team_id, so the button dropped users on a generic page (Jun-2026 bug report).
    reports: `${b}/reports?enterprise_id=${ent}&team_id=${team}&serviceType=${dept}`,
  };
}
// Map raw action-item intent → human label (matches the v1 template wording).
const INTENT_LABELS = {
  sms_takeover: "SMS takeover requested", REQUEST_CALLBACK: "Callback requests", callback_request: "Callback requests",
  appt_confirmed: "Appointments confirmed today", failed_booking: "Failed bookings to review",
  specific_salesperson: "Customers asked for a salesperson", compliance_alert: "Compliance alerts",
  recall_response: "Recall responses", pending_status_update: "Pending repair-order status", no_show: "No-shows yesterday",
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointments to schedule", SERVICE_RECALL_FOLLOW_UP: "Recall follow-ups",
  SERVICE_STATUS_UPDATE: "Pending status updates", SERVICE_ESCALATE_TO_ADVISOR: "Escalations to advisor",
  SERVICE_SEND_ESTIMATE: "Estimates to send", SERVICE_PARTS_CALLBACK: "Parts callbacks", CUSTOM: "Other action items",
};
const humanizeIntent = (k) => INTENT_LABELS[k] || String(k || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Canonical email template — delegates to the shared, Figma-faithful renderer in
// src/email/digestTemplate.cjs (the SAME module the SPA preview uses, so the sent
// bytes never drift). This wrapper just builds the view-model: console deep links,
// the open-tracking pixel URL, and the enrichment that rides on the metrics object
// (upcoming appointments, top vehicles, $/appt) populated by processOne().
// ── Open-tracking pixel ───────────────────────────────────────────────────────
// Points at the track-open Edge Function on reporting-vini (qludn). Override the
// host with DIGEST_TRACK_BASE if it ever moves. Used by BOTH digest templates
// (v1 classic + v2 redesign) so every sent mail is trackable.
const TRACK_OPEN_URL = (process.env.DIGEST_TRACK_BASE || "https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open").replace(/\/$/, "");
function pixelUrlFor(team, dept, localDate, cadence) {
  const enc = encodeURIComponent;
  return `${TRACK_OPEN_URL}?t=${enc(team)}&d=${enc(dept)}&c=${enc(cadence || "daily")}&dt=${enc(localDate)}`;
}
function pixelImg(team, dept, localDate, cadence) {
  return `<img src="${pixelUrlFor(team, dept, localDate, cadence)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
}

function renderHtml(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence) {
  const L = links(ent, team, dept, localDate, tz);
  // First-party open pixel → the track-open Edge Function (always reachable from an
  // inbox; deterministic from team/dept/cadence/date so a re-render reproduces it).
  const pixelUrl = pixelUrlFor(team, dept, localDate, cadence);
  // Email images need ABSOLUTE URLs — DIGEST_ASSET_BASE (CDN/app URL) when configured.
  const assetBase = (process.env.DIGEST_ASSET_BASE || "").replace(/\/$/, "");
  const campaignImages = assetBase ? [`${assetBase}/digest-assets/campaign-honda.jpg`, `${assetBase}/digest-assets/campaign-tata.jpg`] : [];
  const mm = Object.assign({}, m, { campaigns: campaigns || m.campaigns || [] });
  return renderDigestHtml(mm, {
    rooftopName: name,
    dept: dept === "service" ? "service" : "sales",
    dateLabel,
    agentPerson: m.agentPerson || "",
    links: { appointments: L.appts, conversations: L.conv, actionItems: L.action, console: L.reports },
    appointments: Array.isArray(m.appointments) ? m.appointments : [],
    topVehicles: Array.isArray(m.topVehicles) ? m.topVehicles : [],
    dollarRate: Number(m.dollarRate) || 0,
    // Upsell banner is driven by agent deployment state when it's present on the
    // stored metrics; absent → the template falls back to the speed-to-lead CTA.
    deployment: m.deployment || undefined,
    // CONTENT FOCUS — 'appointment' (top closers) vs 'conversation' (the ~90%). Stable per rooftop,
    // resolved by pickFocus() from roi_rooftop_config.digest_focus and stamped onto the metrics.
    focus: m.digest_focus || m.focus || undefined,
    // daily → undefined ("yesterday" wording); weekly/monthly switch the template's period nouns.
    period: cadence === "weekly" || cadence === "monthly" ? cadence : undefined,
    pixelUrl, assetBase, campaignImages,
  });
}

// ── CLASSIC daily template (v1) ───────────────────────────────────────────────
// The ORIGINAL production email — self-contained email-safe HTML (colors #0369A1/
// #0891B2/#0D9488). Preserved verbatim so a rooftop on the 'v1' daily template keeps
// getting the exact email it gets today. Selected per-rooftop via roi_rooftop_config
// .daily_template; v2 is renderHtml() above (the Conversational-AI-2.0 redesign).
function renderHtmlV1(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns) {
  const L = links(ent, team, dept, localDate, tz);
  const isSvc = dept === "service";
  const camps = (campaigns || []).filter((c) => Number(c.dials) > 0); // drop zero-dial campaigns
  const items = (m.actionItems || []).slice(0, 6);
  const tv = m.topVehicles || [];
  // total conversations (hero "Conversations handled") + inbound-only split (channel breakdown)
  const call = m.conversationsCall || 0, sms = m.conversationsSms || 0, chat = m.conversationsChat || 0;
  const callIn = m.conversationsCallIn || 0, smsIn = m.conversationsSmsIn || 0, chatIn = m.conversationsChatIn || 0;
  const callOut = m.conversationsCallOut || 0, smsOut = m.conversationsSmsOut || 0, chatOut = m.conversationsChatOut || 0;
  // presence flags — drive section removal (HTML handling rules)
  const hasConv = (call + sms + chat) > 0;                 // hero (total)
  const hasInboundConv = (callIn + smsIn + chatIn) > 0;    // inbound channel breakdown
  const hasOutboundConv = (callOut + smsOut + chatOut) > 0; // outbound channel breakdown
  const hasOutbound = (m.outboundTotalCalls || 0) + (m.outboundUniqueReached || 0) + (m.outboundConnected || 0) + (m.outboundAppointmentsSet || 0) > 0;
  // channel bar + legend for any (call,sms,chat) triple
  const mkBar = (cc, ss, hh) => { const t = cc + ss + hh || 1; const p = (x) => `${(x / t) * 100}%`; return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:9999px;overflow:hidden;margin-top:8px;"><tr>${cc > 0 ? `<td style="width:${p(cc)};background:#0369A1;font-size:0;line-height:0;">&nbsp;</td>` : ""}${ss > 0 ? `<td style="width:${p(ss)};background:#0891B2;font-size:0;line-height:0;">&nbsp;</td>` : ""}${hh > 0 ? `<td style="width:${p(hh)};background:#0D9488;font-size:0;line-height:0;">&nbsp;</td>` : ""}</tr></table><div style="margin-top:8px;"><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0369A1;margin-right:5px;"></span>Call <span style="color:#525252;">${cc}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0891B2;margin-right:5px;"></span>Sms <span style="color:#525252;">${ss}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0D9488;margin-right:5px;"></span>Chat <span style="color:#525252;">${hh}</span></span></div>`; };
  const channelBar = mkBar(call, sms, chat); // hero = total
  const mini = (l, v, sub) => `<td class="col" width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(l)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(v)}</div><div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div></div></td>`;
  const btnP = (l, h) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#4600F2;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${l}</a>`;
  const btnS = (l, h) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:#4600F2;text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${l}</a>`;
  const sect = (t) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${t}</div>`;
  const rule = `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;}@media only screen and (max-width:600px){.wrap{width:100%!important;border-radius:0!important;}.col{display:block!important;width:100%!important;}.pad{padding-left:16px!important;padding-right:16px!important;}}</style></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table class="wrap" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td class="pad" style="padding:24px 28px 8px;"><table width="100%"><tr>
    <td valign="top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4600F2;font-weight:700;">Vini · Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isSvc ? "Service" : "Sales"} Daily Digest</div></td>
    <td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(name)}</div><div style="font-size:12px;color:#6B7280;">${esc(dateLabel)}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:8px 22px 0;"><table width="100%"><tr>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${(m.appointmentsYesterday || 0) > 0 ? "Appointments yesterday" : "Leads warmed"}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${(m.appointmentsYesterday || 0) > 0 ? (m.appointmentsYesterday || 0) : (m.inboundUniqueLeads || 0)}</div><div style="margin-top:12px;"><span style="display:inline-block;font-size:11px;font-weight:600;color:#4600F2;background:#EEF0FF;border-radius:9999px;padding:4px 10px;">${m.appointmentsYesterdayMTD || 0} ${(m.appointmentsYesterday || 0) > 0 ? "month to date" : "appointments MTD"}</span></div></div></td>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">Conversations handled</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${(m.conversationsReached != null ? m.conversationsReached : m.conversationsHandled) || 0}</div>${hasConv ? channelBar : `<div style="font-size:11px;color:#9CA3AF;margin-top:10px;">No conversations yesterday</div>`}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:14px 28px 4px;">${btnP("View appointments", L.appts)} ${btnS("Open conversation inbox", L.conv)}</td></tr>
  ${items.length ? `<tr><td class="pad" style="padding:4px 28px;">${rule}${sect("Action required")}<table width="100%">${items.map((it) => `<tr><td style="padding:7px 0;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${it.count}</span><span style="font-size:13px;color:#111827;margin-left:10px;">${esc(humanizeIntent(it.intent))}</span></td></tr>`).join("")}</table><div style="margin-top:12px;">${btnP("Review action items", L.action)}</div></td></tr>` : ""}
  <tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Inbound activity")}</div>
    <table width="100%"><tr>
      ${mini("Appointments", m.appointmentsYesterday || 0, `Yesterday · ${m.appointmentsYesterdayMTD || 0} MTD`)}
      ${mini("Unique leads", m.inboundUniqueLeads || 0, `Yesterday · ${m.inboundUniqueLeadsMTD || 0} MTD`)}
      ${mini("Warm transfers", m.warmTransfers || 0, `Yesterday · ${m.warmTransfersMTD || 0} MTD`)}
    </tr></table>
    <div style="padding:0 6px;">${hasInboundConv ? `${sect("Channel breakdown")}${mkBar(callIn, smsIn, chatIn)}` : ""}
      ${tv.length ? `${sect("Top vehicles of interest")}<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">${tv.map((v, i) => `<tr><td style="padding:12px 14px;${i ? "border-top:1px solid #E5E7EB;" : ""}"><table width="100%"><tr><td style="font-size:13px;color:#111827;">${esc(v.name)}</td><td align="right" style="font-size:13px;font-weight:700;color:#111827;">${v.count}</td></tr></table></td></tr>`).join("")}</table>` : ""}
    </div>
  </td></tr>
  ${hasOutbound ? `<tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Outbound activity")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Yesterday's activity</div></div>
    <table width="100%"><tr>
      ${mini("Unique reached", m.outboundUniqueReached || 0, `Yesterday · ${m.outboundUniqueReachedMTD || 0} MTD`)}
      ${mini("Connect rate", `${Math.round(Number(m.outboundConnectRate) || 0)}%`, `Yesterday · ${Math.round(Number(m.outboundConnectRateMTD) || 0)}% MTD`)}
      ${mini("Appointments set", m.outboundAppointmentsSet || 0, `Yesterday · ${m.outboundAppointmentsSetMTD || 0} MTD`)}
    </tr></table>
    ${hasOutboundConv ? `<div style="padding:0 6px;">${sect("Channel breakdown")}${mkBar(callOut, smsOut, chatOut)}</div>` : ""}
    ${camps.length ? `<div style="padding:0 6px;">${sect("Active campaigns")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Yesterday's activity</div>${camps.map((c) => `<div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin-top:8px;"><div><span style="font-size:13px;font-weight:600;color:#111827;">${esc(c.name)}</span><span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:#16A34A;background:#DCFCE7;border-radius:4px;padding:2px 6px;margin-left:8px;">ACTIVE</span></div><div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(c.dials)} dials · ${esc(c.appts)} appts · ${esc(c.conversion)} conversion</div></div>`).join("")}</div>` : ""}
  </td></tr>` : ""}
  <tr><td class="pad" style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;"><table width="100%"><tr>
    <td valign="top" style="font-size:11px;color:#9CA3AF;line-height:1.6;">Reporting period: ${esc(dateLabel)}<br/>Next report: tomorrow · 7:00 AM</td>
    <td valign="top" align="right" style="font-size:11px;color:#9CA3AF;">© Vini · 2026</td>
  </tr></table></td></tr>
</table></td></tr></table></body></html>`;
}

// ── Daily-template dispatch ───────────────────────────────────────────────────
// Pick the template for a given rooftop-config + cadence. Only the DAILY digest is
// switchable per-rooftop (redesign 'v2' vs classic 'v1'); weekly/monthly are new and
// only exist in v2. Default 'v2' — the redesigned "Conversational AI 2.0" digest is
// now the product default for EVERY rooftop (go-live Jul 2026). A rooftop gets the
// CLASSIC email only if it's explicitly opted back to 'v1' via the tracker.
function pickTemplate(cfg, cadence) {
  if (cadence === "weekly" || cadence === "monthly") return "v2";
  return (cfg && cfg.daily_template === "v1") ? "v1" : "v2";
}
// ── Content-focus dispatch (the appointment/conversation checker) ────────────
// Stable, per-rooftop choice of what the digest LEADS with:
//   • 'appointment' — appointments are the headline (the top closers: STL / during-hours / strong
//     daily booking cadence). This is the current redesign layout.
//   • 'conversation' — conversations handled are the headline and appointments demote to a down-funnel
//     widget. The ~90% of rooftops whose offering rarely books a daily appointment.
// Set explicitly per rooftop in the tracker (roi_rooftop_config.digest_focus); the explicit choice
// always wins. 'auto' (the default) resolves from the one console-aligned signal available across all
// send paths — APPOINTMENT CADENCE. (There is no clean per-rooftop STL/coverage feature flag upstream
// — verified in reporting-vini; STL/after-hours are per-event classifications, not enablement flags —
// so cadence is the honest auto signal.) Appointment-focus only for rooftops that actually book at a
// daily clip (≈2+/business-day, e.g. a busy service drive); the ~90% that rarely book get conversation.
// MTD-based, so it's STABLE day-to-day (never a daily flip on yesterday's count). Spans daily/weekly/monthly.
const FOCUS_APPT_PER_DAY = 2;           // appts/business-day above which 'auto' → appointment-focus
function pickFocus(cfg, m) {
  const f = cfg && cfg.digest_focus;
  if (f === "appointment" || f === "conversation") return f;   // explicit override wins
  const apptMTD = Number((m || {}).appointmentsYesterdayMTD) || 0;
  if (apptMTD / 22 >= FOCUS_APPT_PER_DAY) return "appointment"; // ~22 business days/month
  return "conversation";                                        // the safe 90% default (incl. unknown MTD)
}
// Render the right template. v1 shims inboundUniqueLeads back to its legacy value so
// the classic email stays byte-faithful to production.
function renderDigest(tpl, name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence) {
  let html, gateM = m;
  if (tpl === "v2") {
    html = renderHtml(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence);
  } else {
    const m1 = Object.assign({}, m, { inboundUniqueLeads: (m.inboundUniqueLeadsLegacy != null ? m.inboundUniqueLeadsLegacy : m.inboundUniqueLeads) });
    gateM = m1;   // gate v1 on the SAME shimmed metrics it renders from, so the no-value
                  // marker can't disagree with the numbers actually shown in the email.
    // v1 classic has no built-in pixel slot — inject the open-tracking pixel before </body>.
    html = renderHtmlV1(name, dept, dateLabel, ent, team, localDate, tz, m1, campaigns)
      .replace("</body></html>", `${pixelImg(team, dept, localDate, cadence)}</body></html>`);
  }
  // Stamp the no-value marker for the v1 path too (the v2 renderer self-stamps);
  // sendMail refuses a marked email unless overridden. Idempotent.
  return emailValue.digestHasValue(gateM) ? html : emailValue.markNoValue(html);
}
// Apply the matching guardrail. v1 uses the original (stricter) send rule on the
// legacy-shimmed leads value; v2 uses the permissive "any activity" rule.
function guardrailFor(tpl, m) {
  if (tpl === "v2") return guardrail(m);
  const m1 = Object.assign({}, m, { inboundUniqueLeads: (m.inboundUniqueLeadsLegacy != null ? m.inboundUniqueLeadsLegacy : m.inboundUniqueLeads) });
  return guardrailV1(m1);
}

async function sendMail(to, subject, html, opts) {
  // Anti-churn gate: refuse to send a no-value digest (stamped by the renderer)
  // unless the caller passes { force: true } (a deliberate DANGER override). The
  // marker is stripped so a customer never sees it.
  const force = opts && opts.force === true;
  if (emailValue.isNoValue(html)) {
    if (!force) { const e = new Error("This email shows no value — blocked to avoid churn. Override with the password to send."); e.code = "BLOCKED_NO_VALUE"; throw e; }
  }
  // SAFETY LOCK: the redesigned (v2) digest may ONLY reach @spyne.ai while in testing. Even if a
  // rooftop is live with real recipients, a v2 email is filtered to its @spyne.ai addresses (none →
  // nothing sent). Lift deliberately with V2_TO_CUSTOMERS=true. Not overridable by the DANGER force.
  const lock = emailValue.lockV2Recipients(html, to);
  if (lock.locked) {
    if (!lock.allowed.length) { const e = new Error("New (v2) template is @spyne.ai-only in testing — no @spyne.ai recipient for this rooftop, nothing sent."); e.code = "V2_SPYNE_ONLY"; throw e; }
    if (lock.allowed.length !== to.length) console.log(`  🔒 v2 spyne-only lock → recipients restricted to ${lock.allowed.join(", ")}`);
    to = lock.allowed;
  }
  html = emailValue.stripMarker(html); // strip no-value + v2 markers off the wire
  const body = JSON.stringify({ to: to.join(","), subject, template: MAIL_TEMPLATE, templateData: { HTMLdata: html } });
  let lastErr = "";
  // retry transient mail-gateway failures (5xx / 429) a couple times with backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(MAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(MAIL_TOKEN ? { Authorization: `Bearer ${MAIL_TOKEN}` } : {}) },
      body,
    });
    if (res.ok) { const j = await res.json().catch(() => ({})); return j.messageId ?? j.id ?? null; }
    lastErr = `mail ${res.status}: ${(await res.text()).slice(0, 120)}`;
    if (res.status < 500 && res.status !== 429) break; // non-transient (4xx) — don't retry
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error(lastErr);
}

// Slack breakage alert — shared with eventRunner.cjs (transactional emails) so BOTH pipelines alert the
// same way. Tiered warn/crit thresholds live in slackAlert.cjs (DIGEST_ALERT_WARN / DIGEST_ALERT_CRIT).
const { postBreakageAlert, postSystemicAlert } = require("./slackAlert.cjs");

// ── Dead-man's-switch for the TRANSACTIONAL events pipeline ────────────────────
// The events cron (/api/cron/roi-events) can stop producing entirely — a degraded feed, a crashed
// pass, or Vercel simply not firing it — and when it does, NOTHING in that job is running to alert us
// (that's exactly how the transactional pipeline went dark for 13 days unnoticed). So we pigg-back a
// staleness heartbeat on THIS digest cron, which is proven to run reliably every hour: if no
// roi_event_emails row has been written in far too long, shout. Gated to a few UTC hours so an ongoing
// outage pings a handful of times/day (not hourly), and a threshold wide enough (default 12h) that a
// quiet overnight window never false-alarms. Best-effort; never affects the digest send.
const EVENT_STALE_HOURS = Number(process.env.EVENT_STALE_HOURS || 12);
const EVENT_HEARTBEAT_UTC_HOURS = (process.env.EVENT_HEARTBEAT_UTC_HOURS || "16,20,23")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
async function eventPipelineHeartbeat() {
  try {
    if (!EVENT_HEARTBEAT_UTC_HOURS.includes(new Date().getUTCHours())) return; // only check a few times/day
    const { data, error } = await sb.from("roi_event_emails")
      .select("created_at").order("created_at", { ascending: false }).limit(1);
    if (error) return; // can't read → don't guess
    const last = data && data[0] && data[0].created_at ? new Date(data[0].created_at) : null;
    const ageH = last ? (Date.now() - last.getTime()) / 3600000 : Infinity;
    if (ageH < EVENT_STALE_HOURS) return; // healthy
    const lastStr = last ? `${ageH.toFixed(1)}h ago (${last.toISOString()})` : "never";
    await postSystemicAlert({
      source: "Transactional email",
      title: "events pipeline STALE — no transactional email in " + (last ? `${ageH.toFixed(0)}h` : "a very long time"),
      detail: `Last roi_event_emails row: ${lastStr} (threshold ${EVENT_STALE_HOURS}h). The 15-min /api/cron/roi-events job is likely not firing, crashing, or its reporting-vini feed is down. Check the Vercel cron + reporting-vini feed auth/ClickHouse.`,
      windowLabel: "events-pipeline heartbeat (from the hourly digest cron)",
    });
  } catch (e) { console.warn("[roi-cron] heartbeat skipped:", String(e).slice(0, 140)); }
}

// ── Recipient-verification audit ───────────────────────────────────────────────
// The other half of the cross-rooftop guard: the send gate HOLDS enabled-but-unverified
// recipients (a newly-added address stays unverified until a human confirms it for that rooftop).
// This surfaces them so they don't sit silently un-emailed — a daily Slack digest of every recipient
// that is enabled + subscribed-capable but not yet verified, grouped by rooftop. WARNING (no @channel):
// it's a to-do, not an outage. Rides this reliable hourly cron; gated to one UTC hour so it's daily.
const RECIPIENT_AUDIT_UTC_HOUR = Number(process.env.RECIPIENT_AUDIT_UTC_HOUR || 15);
async function recipientVerificationAudit() {
  try {
    if (new Date().getUTCHours() !== RECIPIENT_AUDIT_UTC_HOUR) return;
    const { data, error } = await sb.from("roi_recipients")
      .select("team_id,email,email_enabled,sms_enabled,verified_at")
      .is("verified_at", null);
    if (error) return;
    const pending = (data || []).filter((r) => r.email_enabled || r.sms_enabled);
    if (!pending.length) return; // all clear
    const byTeam = new Map();
    for (const r of pending) { const a = byTeam.get(r.team_id) || []; a.push(r.email); byTeam.set(r.team_id, a); }
    const failures = [...byTeam.entries()].map(([team, emails]) => ({
      rooftop: team, dept: "recipients", error: `${emails.length} unverified & held: ${emails.slice(0, 8).join(", ")}${emails.length > 8 ? "…" : ""}`,
    }));
    await postBreakageAlert({
      source: "Recipient verification",
      failures,
      sentOk: null,
      windowLabel: "daily recipient audit — verify each recipient belongs to its rooftop before it can be emailed",
    });
  } catch (e) { console.warn("[roi-cron] recipient audit skipped:", String(e).slice(0, 140)); }
}

async function runOnce() {
  const ts = new Date().toISOString();
  console.log(`\n── ROI cron pass @ ${ts} · DRY_RUN=${DRY_RUN} ──`);
  // FAIL LOUD: a misconfigured serverless function (missing ROI_SUPABASE_*) used to
  // silently return an all-zero summary because the Supabase error was swallowed. Surface it.
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY (set them as server env vars on Vercel — NOT VITE_-prefixed).");
  const [liveRes, cfgRes, recRes] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,digest_send_hour,daily_enabled,daily_template,digest_focus,sms_enabled"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) {
    const e = liveRes.error || cfgRes.error || recRes.error;
    throw new Error(`Supabase read failed (check ROI_SUPABASE_URL/ROI_SUPABASE_SERVICE_KEY): ${e.message}`);
  }
  const live = liveRes.data, cfg = cfgRes.data, rec = recRes.data;
  if (!live || live.length === 0) console.warn("[roi-cron] WARNING: roi_live_departments.is_live=true returned 0 rows — nothing to process (check data / env).");
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  // enterprise_id lives on roi_rooftop_config (not roi_live_departments) — attach it to each
  // live row so downstream (stored row, console links, enrichment) keeps working.
  for (const L of (live ?? [])) L.enterprise_id = cfgOf.get(L.team_id)?.enterprise_id || "";
  const recOf = new Map();
  for (const r of rec ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const out = { sent: 0, queued: 0, suppressed: 0, no_data: 0, before_hour: 0, no_recipients: 0, already_sent: 0, errors: 0 };
  const failures = []; // genuine send failures this pass → the Slack breakage alert (postSlackAlert)
  const smsFailures = []; // genuine digest-SMS send failures this pass → shared Slack breakage alert (SMS)
  // optional scoping for targeted dry-runs:
  //   ONLY_TEAMS=team1,team2   → run only these team_ids
  //   IGNORE_SEND_HOUR=true    → skip the local send-hour gate (render now regardless of time)
  const ONLY = (process.env.ONLY_TEAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const IGNORE_HOUR = process.env.IGNORE_SEND_HOUR === "true";
  // RUN_LOCAL_DATE=YYYY-MM-DD → report that specific dealer-local date instead of "yesterday".
  // FORCE_RESEND=true → re-send even if a 'sent' row already exists for that date (manual backfill send).
  const RUN_LOCAL_DATE = process.env.RUN_LOCAL_DATE || null;
  const FORCE_RESEND = process.env.FORCE_RESEND === "true";
  const targets = (live ?? []).filter((L) => !ONLY.length || ONLY.includes(L.team_id));
  if (ONLY.length) console.log(`  scope: ONLY_TEAMS → ${targets.length} dept-rows across ${ONLY.length} team(s)`);

  // Process ONE rooftop·dept. Independent per row → safe to run many in parallel.
  const processOne = async (L) => {
    const c = cfgOf.get(L.team_id);
    const tz = c?.timezone || "America/New_York";
    const name = c?.rooftop_name || L.team_id;
    if (c && c.daily_enabled === false) return;
    const w = RUN_LOCAL_DATE ? { ...windowsForDate(RUN_LOCAL_DATE, tz), localHour: localParts(tz).localHour } : localParts(tz);
    const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: w.localDate, dealer_timezone: tz, trigger: "cron" };
    // FAIL LOUD on write failure. The 'queued' upsert runs BEFORE the send, so if the DB write
    // is blocked (e.g. ROI_SUPABASE_SERVICE_KEY is the anon key → RLS denies the insert), this
    // throws and we NEVER send — preventing the silent "no row written → re-send every hour" loop.
    const upsert = async (extra) => {
      const { data, error } = await sb
        .from("roi_digest_runs")
        .upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" })
        .select("id");
      if (error) throw new Error(`roi_digest_runs write failed — is ROI_SUPABASE_SERVICE_KEY the service_role key (not anon)? ${error.message}`);
      if (!data || data.length === 0) throw new Error("roi_digest_runs write affected 0 rows (RLS blocked — service_role key required)");
    };
    try {
      // already sent today?
      const { data: done } = await sb.from("roi_digest_runs").select("id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", w.localDate).eq("status", "sent").maybeSingle();
      if (done && !FORCE_RESEND) { out.already_sent++; console.log(`  · ${name} [${L.department}] skipped → already sent for ${w.localDate}`); return; }
      // recipients (step 1 finalized) for this dept — email filtered by the subscription matrix.
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, "daily");
      if (!emails.length) { await upsert({ status: "not_sent", reason: "recipients_missing" }); out.no_recipients++; console.log(`  · ${name} [${L.department}] not_sent → recipients_missing (no enabled recipient for this dept)`); return; }
      // step 2 — fetch via embedding (daily window + MTD window) + action items, store queued
      const day = await getMetrics(L.team_id, L.department, w, "day");
      const mtd = await getMetrics(L.team_id, L.department, w, "mtd");
      const ai = await getActionItems(L.team_id, L.department, w);
      const m = {
        ...day, actionItemsTotal: ai.total,
        appointmentsYesterdayMTD: mtd.appointmentsYesterday,
        warmTransfersMTD: mtd.warmTransfers,
        inboundUniqueLeadsMTD: mtd.inboundUniqueLeads,
        outboundUniqueReachedMTD: mtd.outboundUniqueReached,
        outboundConnectRateMTD: mtd.outboundConnectRate,
        outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet,
        // redesign MTD figures (calling hours + qualified)
        callingDuringMTD: mtd.callingDuring,
        callingAfterMTD: mtd.callingAfter,
        qualifiedLeadsMTD: mtd.qualifiedLeads,
      };
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate };
      const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
      await upsert({ status: "queued", reason: null, metrics, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
      out.queued++;
      // daily-template selection (redesign v2 / classic v1) — per rooftop, default v2
      const tpl = pickTemplate(c, "daily");
      // step 3 — guardrails (v1 keeps the original stricter send rule)
      const g = guardrailFor(tpl, m);
      if (!g.ok) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; console.log(`  · ${name} [${L.department}] not_sent → ${g.reason} (appts ${m.appointmentsYesterday} · conv ${m.conversationsHandled} · leads ${m.inboundUniqueLeads} · actions ${m.actionItemsTotal})`); return; }
      // step 4 — send-hour gate
      const sendHour = c?.digest_send_hour ?? 7;
      if (!IGNORE_HOUR && w.localHour < sendHour) { await upsert({ status: "scheduled", reason: "before_send_hour", metrics, subject }); out.before_hour++; console.log(`  · ${name} [${L.department}] scheduled → before_send_hour (local ${tz} ${String(w.localHour).padStart(2, "0")}:00 < send ${String(sendHour).padStart(2, "0")}:00)`); return; }
      // active campaigns (3rd embedding) — only now, just before render
      const camps = await getCampaigns(L.team_id, L.department, w);
      // Enrichment: upcoming appointments (car + $ + schedule) + top vehicles — sourced from the
      // SAME Reporting service as every other metric (single source of truth), not a separate
      // ClickHouse query. Optional — degrades to empty (section omitted) when unavailable.
      const dollarRate = digestDollarRate(L.department);
      let enr = { appointments: [], topVehicles: [] };
      try {
        const { enrichRooftop } = await import("./digestEnrich.js");
        enr = await enrichRooftop(L.team_id, {
          dollarRate, dept: L.department, enterpriseId: L.enterprise_id, tz,
          start: w.apiStart, end: w.apiEnd,
          apiBase: REPORTING_API_BASE, token: process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || undefined,
        });
      } catch (e) { console.warn("[roi-cron] enrich skipped:", String(e).slice(0, 120)); }
      // canonical stored payload — carries everything the template reads so a later
      // re-render (and the SPA preview) reproduce the exact email.
      const metricsFull = { ...metrics, campaigns: camps, appointments: enr.appointments, topVehicles: enr.topVehicles, dollarRate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, "daily");
      // Digest SMS — terse headline + report link to subscribers with a phone (opt-in per type).
      // Runs BEFORE the email dry gate so held emails don't block SMS; own SMS_DRY_RUN + dedupe.
      const smsRecips = subscribedSmsRecips(recOf.get(L.team_id), L.department, "daily", c && c.sms_enabled);
      if (smsRecips.length && !(SMS_DRY_RUN || L.dry_run === true)) {
        const reportLink = links(L.enterprise_id, L.team_id, L.department, w.localDate, tz).reports;
        const smsRes = await sendDigestSms(sb, { team_id: L.team_id, enterprise_id: L.enterprise_id, department: L.department }, "daily", w.localDate, smsRecips, T.renderDigestSms({ cadence: "daily", rooftopName: name, dept: L.department, metrics: m, link: reportLink }));
        if (smsRes && smsRes.error) smsFailures.push({ rooftop: name, dept: L.department, error: smsRes.error });
      }
      const dry = DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: "dry_run", metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; console.log(`  · ${name} [${L.department}] suppressed (dry-run)`); return; }
      // ── ATOMIC SEND-CLAIM (idempotency: at-most-once per customer · dept · cadence · day) ──────────
      // The "already sent?" read above is a cheap early-out but races. This conditional UPDATE is the real
      // guarantee: it flips message_id from NULL → a per-row lock id in ONE atomic Postgres op, so exactly
      // one racer wins — even if the hourly cron overlaps itself OR the cron4-send edge backstop runs at
      // the same time. Lost the claim (0 rows) → someone else already owns this send → skip, never double.
      // On a send FAILURE the lock is deliberately KEPT (no same-day auto-retry) so we never double-send an
      // email that may have gone out; the failure surfaces as "Failed" + a Slack alert for manual retry.
      const sentAt = new Date().toISOString();
      const lockId = `cron-${L.team_id}-${L.department}-daily-${w.localDate}`;
      if (!FORCE_RESEND) {
        const { data: claim, error: claimErr } = await sb.from("roi_digest_runs")
          .update({ status: "sending", message_id: lockId })
          .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", w.localDate)
          .is("message_id", null)
          .select("id");
        if (claimErr) throw new Error(`send-claim failed: ${claimErr.message}`);
        if (!claim || !claim.length) { out.already_sent++; console.log(`  · ${name} [${L.department}] skipped → already sent/claimed for ${w.localDate}`); return; }
      }
      // SEND (we own the claim; message_id is now non-null so no other sender will re-send this row)
      const messageId = await sendMail(emails, subject, html);
      const finalId = messageId || lockId;
      await upsert({ status: "sent", reason: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: finalId, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++;
      console.log(`  ✓ SENT ${name} [${L.department}] → ${emails.join(", ")}`);
    } catch (e) {
      out.errors++;
      const code = e && e.code;
      // Deliberate business holds (no-value gate / v2 spyne-lock) are NOT failures — record as not_sent.
      // Anything else is a genuine send failure → status="error" so the tracker shows a red "Failed" and
      // it feeds the Slack breakage alert below.
      const isHold = code === "BLOCKED_NO_VALUE" || code === "V2_SPYNE_ONLY";
      const detail = String(e && e.message ? e.message : e).slice(0, 400);
      console.log(`  ✗ ${name} [${L.department}] ${isHold ? "held" : "FAILED"}: ${detail.slice(0, 160)}`);
      try {
        await upsert(isHold
          ? { status: "not_sent", reason: code === "BLOCKED_NO_VALUE" ? "no_value" : "v2_spyne_only", reason_detail: detail }
          : { status: "error", reason: "error", reason_detail: detail });
      } catch { /* swallow — one failure must not halt the pass */ }
      if (!isHold) failures.push({ rooftop: name, dept: L.department, error: detail.slice(0, 200) });
    }
  };
  // Concurrency pool — fit the whole pass inside the serverless time limit.
  const POOL = Number(process.env.CRON_POOL || 10);
  let _i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, targets.length)) }, async () => {
    while (_i < targets.length) { const L = targets[_i++]; await processOne(L); }
  }));
  console.log("  summary:", JSON.stringify(out));
  // Breakage alert → Slack when any digest genuinely failed to send this pass. Best-effort; never throws.
  await postBreakageAlert({ source: "Daily digest", failures, sentOk: out.sent, windowLabel: "daily digest send pass" })
    .catch((e) => console.warn("[roi-cron] slack alert skipped:", String(e).slice(0, 140)));
  // Same tiered warn/crit alert for the daily digest SMS channel.
  await postBreakageAlert({ source: "Digest SMS", failures: smsFailures, sentOk: null, windowLabel: "daily digest send pass" })
    .catch((e) => console.warn("[roi-cron] digest sms slack alert skipped:", String(e).slice(0, 140)));
  // Dead-man's-switch: ride this reliable hourly cron to catch a silently-dead events pipeline.
  await eventPipelineHeartbeat();
  // Daily audit: surface any enabled recipient still awaiting rooftop verification (held by the gate).
  await recipientVerificationAudit();
  return out;
}

// ── BACKFILL (record-only, NO emails) — one pass over a date range, all team·dept ──
function windowsForDate(localDate, tz) {
  const [y, m, d] = localDate.split("-").map(Number);
  const yStart = localToUTC(y, m, d, tz);
  const yEnd = new Date(localToUTC(y, m, d + 1, tz).getTime() - 1000);
  const monthStart = localToUTC(y, m, 1, tz);
  const dateLabel = new Date(yStart.getTime()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const apiEnd = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { localDate, dateLabel, yStart: fmtUTC(yStart), yEnd: fmtUTC(yEnd), monthStart: fmtUTC(monthStart),
    apiStart: localDate, apiEnd, apiMonthStart: `${y}-${String(m).padStart(2, "0")}-01` };
}
function dateRange(start, end) {
  const out = []; const d = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
async function backfill(start, end) {
  console.log(`\n── BACKFILL ${start}…${end} (record-only, NO emails) ──`);
  const [{ data: live }, { data: cfg }, { data: rec }] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,daily_enabled,daily_template,digest_focus"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at"),
  ]);
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  for (const L of (live ?? [])) L.enterprise_id = cfgOf.get(L.team_id)?.enterprise_id || ""; // enterprise_id is on cfg, not live
  const recOf = new Map();
  for (const r of rec ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const days = dateRange(start, end);
  const out = { sent: 0, not_sent: 0, preserved: 0, errors: 0 };
  const POOL = 8;
  const tasks = (live ?? []).filter((L) => (cfgOf.get(L.team_id)?.daily_enabled) !== false);

  async function worker(L) {
    const c = cfgOf.get(L.team_id); const tz = c?.timezone || "America/New_York";
    const name = c?.rooftop_name || L.team_id;
    const emails = subscribedEmails(recOf.get(L.team_id), L.department, "daily");
    for (const day of days) {
      const w = windowsForDate(day, tz);
      const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: day, dealer_timezone: tz, trigger: "backfill" };
      try {
        const dayM = await getMetrics(L.team_id, L.department, w, "day");
        const mtd = await getMetrics(L.team_id, L.department, w, "mtd");
        const ai = await getActionItems(L.team_id, L.department, w);
        const camps = await getCampaigns(L.team_id, L.department, w);
        const m = { ...dayM, actionItemsTotal: ai.total, appointmentsYesterdayMTD: mtd.appointmentsYesterday, warmTransfersMTD: mtd.warmTransfers, inboundUniqueLeadsMTD: mtd.inboundUniqueLeads, outboundUniqueReachedMTD: mtd.outboundUniqueReached, outboundConnectRateMTD: mtd.outboundConnectRate, outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet };
        const tpl = pickTemplate(c, "daily");
        const metrics = { ...m, actionItems: ai.items, campaigns: camps, reportDate: day, daily_template: tpl, digest_focus: pickFocus(c, m) };
        const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
        const g = guardrailFor(tpl, m);
        // backfill is historical → no future "upcoming appointments"; render from the
        // full metrics so follow-ups/campaigns still show.
        const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, day, tz, metrics, camps, "daily");
        // preserve a row already marked sent — just refresh its data
        const { data: ex } = await sb.from("roi_digest_runs").select("status,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day).maybeSingle();
        if (ex?.status === "sent") {
          // LOCK: a really-emailed row (message_id set) keeps its exact sent body — refresh metrics only.
          const upd = ex.message_id ? { metrics, subject } : { metrics, rendered_html: html, subject };
          await sb.from("roi_digest_runs").update(upd).eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day); out.preserved++; continue;
        }
        // FAIL LOUD: surface a denied/failed write (e.g. a publishable key that can't write
        // roi_digest_runs) instead of silently counting a row that never persisted.
        const up = async (extra) => {
          const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" });
          if (error) throw new Error(`roi_digest_runs write failed (service_role key required?): ${error.message}`);
        };
        if (!emails.length) { await up({ status: "not_sent", reason: "recipients_missing", metrics, subject }); out.not_sent++; }
        else if (!g.ok) { await up({ status: "not_sent", reason: g.reason, metrics, subject }); out.not_sent++; }
        else {
          // record-only "sent" — historical digest; recipients received, but NO mail is fired
          await up({ status: "sent", reason: null, metrics, subject, rendered_html: html, send_path: "raw_html", sent_at: new Date(`${day}T11:00:00Z`).toISOString(), recipients: emails.map((e) => ({ email: e, received: true })) });
          out.sent++;
        }
      } catch (e) { out.errors++; console.log(`  ✗ ${name} [${L.department}] ${day}: ${String(e).slice(0, 120)}`); }
    }
    console.log(`  ✓ ${name} [${L.department}] — ${days.length} days`);
  }

  // simple concurrency pool
  let i = 0;
  await Promise.all(Array.from({ length: POOL }, async () => { while (i < tasks.length) { const L = tasks[i++]; await worker(L); } }));
  console.log("  backfill summary:", JSON.stringify(out));
  return out;
}

// ── RERENDER — refresh rendered_html from ALREADY-STORED metrics (Supabase-only) ──
// No Metabase, no email, no metric/data change — only re-templates rows that already
// carry rendered_html (sent/suppressed) so the stored bytes match the latest template.
async function rerender() {
  console.log("\n── RERENDER stored rendered_html from stored metrics (Supabase-only · NO emails · NO data change) ──");
  const { data: cfg } = await sb.from("roi_rooftop_config").select("team_id,rooftop_name,daily_template,digest_focus");
  const nameOf = new Map((cfg ?? []).map((c) => [c.team_id, c.rooftop_name]));
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  const out = { updated: 0, errors: 0 };
  const PAGE = 400;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sb.from("roi_digest_runs")
      .select("team_id,enterprise_id,department,cadence,local_date,dealer_timezone,metrics,rendered_html")
      .not("metrics", "is", null).not("rendered_html", "is", null)
      .is("message_id", null) // LOCK: never re-render rows that were really emailed (message_id set)
      .order("local_date", { ascending: false }).order("team_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("  read error:", error.message); break; }
    if (!rows || !rows.length) break;
    for (const r of rows) {
      try {
        const m = r.metrics || {};
        const tz = r.dealer_timezone || "America/New_York";
        const name = nameOf.get(r.team_id) || r.team_id;
        const dateLabel = new Date(`${r.local_date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
        const camps = Array.isArray(m.campaigns) ? m.campaigns : [];
        // re-render to the rooftop's CURRENT template choice (daily switchable; weekly/monthly always v2)
        const tpl = pickTemplate(cfgOf.get(r.team_id), r.cadence);
        const html = renderDigest(tpl, name, r.department, dateLabel, r.enterprise_id, r.team_id, r.local_date, tz, m, camps, r.cadence);
        const { error: ue } = await sb.from("roi_digest_runs").update({ rendered_html: html })
          .eq("team_id", r.team_id).eq("department", r.department).eq("cadence", r.cadence).eq("local_date", r.local_date);
        if (ue) out.errors++; else out.updated++;
      } catch { out.errors++; }
    }
    console.log(`  …${out.updated} updated`);
    if (rows.length < PAGE) break;
  }
  console.log("  rerender summary:", JSON.stringify(out));
  return out;
}

// ── Render ONE stored day in a CHOSEN template — render-only, NO send, NO write ──
// Powers the tracker's daily-digest "New / Classic" preview toggle: load the metrics already
// stored for (team, dept, cadence, local_date) and render them in the requested template, so any
// past day can be viewed under either design regardless of what actually went out. `tpl` ('v1'|'v2')
// overrides the rooftop's config; weekly/monthly are always v2. Returns null if no metrics are stored.
async function renderStoredDigest({ teamId, department, cadence = "daily", localDate, tpl }) {
  if (!teamId || !department || !localDate) throw new Error("teamId, department, localDate required");
  const dept = department === "service" ? "service" : "sales";
  const cad = cadence === "weekly" || cadence === "monthly" ? cadence : "daily";
  const { data: row, error } = await sb.from("roi_digest_runs")
    .select("enterprise_id,dealer_timezone,metrics")
    .eq("team_id", teamId).eq("department", dept).eq("cadence", cad).eq("local_date", localDate)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.metrics) return null;
  const { data: cfg } = await sb.from("roi_rooftop_config")
    .select("rooftop_name,daily_template,digest_focus").eq("team_id", teamId).maybeSingle();
  const m = row.metrics || {};
  const tz = row.dealer_timezone || "America/New_York";
  const name = (cfg && cfg.rooftop_name) || teamId;
  const dateLabel = new Date(`${localDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const camps = Array.isArray(m.campaigns) ? m.campaigns : [];
  // daily honors the requested template (falls back to the rooftop's config); weekly/monthly always v2.
  const chosen = cad === "daily" ? (tpl === "v1" || tpl === "v2" ? tpl : pickTemplate(cfg, cad)) : "v2";
  const html = renderDigest(chosen, name, dept, dateLabel, row.enterprise_id, teamId, localDate, tz, m, camps, cad);
  // strip the no-value marker AND the 1×1 open-tracking pixel — this is an on-screen preview, never a
  // send; leaving the pixel in fires the track-open Edge Function and inflates open_count on every preview.
  const preview = emailValue.stripMarker(html).replace(/<img[^>]*\/functions\/v1\/track-open[^>]*>/gi, "");
  return { html: preview, template: chosen };
}

// ── WEEKLY / MONTHLY cadence generation ─────────────────────────────────────
// The hourly cron also produces the weekly digest (sent Mondays) and the monthly
// digest (sent on the 1st), gated by roi_rooftop_config.weekly_enabled/monthly_enabled
// and the rooftop's send-hour. Reuses the SAME fetch + render pipeline as the daily
// pass; only the window + cadence + period wording differ. Idempotent: one row per
// (team, dept, cadence, local_date).
function localCadenceParts(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", weekday: "short", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { Y: +g("year"), M: +g("month"), D: +g("day"), H: (+g("hour")) === 24 ? 0 : +g("hour"), dow: g("weekday") };
}
const isoD = (d) => d.toISOString().slice(0, 10);
function cadenceWindow(tz, cadence) {
  const c = localCadenceParts(tz);
  if (cadence === "weekly") {
    const end = new Date(Date.UTC(c.Y, c.M - 1, c.D));           // today (exclusive)
    const start = new Date(Date.UTC(c.Y, c.M - 1, c.D - 7));     // 7 days back
    const ystr = new Date(Date.UTC(c.Y, c.M - 1, c.D - 1));      // yesterday → row local_date
    return { apiStart: isoD(start), apiEnd: isoD(end), apiMonthStart: `${c.Y}-${String(c.M).padStart(2, "0")}-01`,
      localDate: isoD(ystr), dateLabel: `Week of ${isoD(start)} – ${isoD(ystr)}`, localHour: c.H, sendDue: c.dow === "Mon" };
  }
  // monthly — previous calendar month, sent on the 1st
  const thisM1 = new Date(Date.UTC(c.Y, c.M - 1, 1)), prevM1 = new Date(Date.UTC(c.Y, c.M - 2, 1));
  return { apiStart: isoD(prevM1), apiEnd: isoD(thisM1), apiMonthStart: isoD(prevM1),
    localDate: isoD(prevM1), dateLabel: prevM1.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }), localHour: c.H, sendDue: c.D === 1 };
}

// On-demand window for the manual "generate & send now" path. Unlike the scheduled
// cron (calendar-anchored monthly), on-demand uses ROLLING windows ending yesterday:
// daily = yesterday · weekly = last 7 days · monthly = last 30 days. No send-day gate.
function onDemandWindow(tz, cadence) {
  if (cadence === "weekly") return cadenceWindow(tz, "weekly");
  if (cadence === "monthly") {
    const c = localCadenceParts(tz);
    const start = new Date(Date.UTC(c.Y, c.M - 1, c.D - 30));    // 30 days back
    const end = new Date(Date.UTC(c.Y, c.M - 1, c.D));           // today (exclusive)
    const ystr = new Date(Date.UTC(c.Y, c.M - 1, c.D - 1));      // yesterday → row local_date
    return { apiStart: isoD(start), apiEnd: isoD(end), apiMonthStart: `${c.Y}-${String(c.M).padStart(2, "0")}-01`,
      localDate: isoD(ystr), dateLabel: `Last 30 days · ${isoD(start)} – ${isoD(ystr)}`, localHour: c.H };
  }
  return localParts(tz); // daily — yesterday window (apiStart/apiEnd/apiMonthStart present)
}

// ── ON-DEMAND generate + send (manual "create in real time and send") ────────
// Powers the tracker's per-rooftop and bulk "Generate & send {cadence}" buttons.
// Reuses the SAME fetch → render → send → mark pipeline as the cron, but:
//   · bypasses the send-day (Mon/1st) + send-hour gates and the already-sent guard
//     (this is an explicit user action — regenerate + resend on demand),
//   · can target ONE rooftop (teamId + department) or ALL live rooftops (no filter),
//   · still respects dry-run: a send is real only when server DRY_RUN=false AND the
//     rooftop's dry_run=false (or pass dryRun:true to force a suppressed preview).
// opts: { cadence:'daily'|'weekly'|'monthly', teamId?, department?, dryRun? }
async function generateAndSendNow(opts) {
  opts = opts || {};
  const cadence = (opts.cadence === "weekly" || opts.cadence === "monthly") ? opts.cadence : "daily";
  // DANGER override: when true, send even a no-value digest (manual force-send).
  const force = opts.force === true;
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const onlyTeam = opts.teamId ? String(opts.teamId) : null;
  const onlyDept = opts.department === "service" ? "service" : opts.department === "sales" ? "sales" : null;
  const forceDry = opts.dryRun === true;

  const [liveRes, cfgRes, recRes] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,digest_send_hour,daily_template,digest_focus"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) throw new Error((liveRes.error || cfgRes.error || recRes.error).message);
  const cfgOf = new Map((cfgRes.data ?? []).map((c) => [c.team_id, c]));
  for (const L of (liveRes.data ?? [])) L.enterprise_id = cfgOf.get(L.team_id)?.enterprise_id || ""; // enterprise_id is on cfg, not live
  const recOf = new Map();
  for (const r of recRes.data ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }

  let targets = (liveRes.data ?? []);
  if (onlyTeam) targets = targets.filter((L) => L.team_id === onlyTeam);
  if (onlyDept) targets = targets.filter((L) => L.department === onlyDept);

  const out = { cadence, scope: onlyTeam ? "rooftop" : "all", sent: 0, suppressed: 0, no_recipients: 0, no_data: 0, errors: 0, details: [] };

  const process1 = async (L) => {
    const c = cfgOf.get(L.team_id); const tz = c?.timezone || "America/New_York"; const name = c?.rooftop_name || L.team_id;
    const w = onDemandWindow(tz, cadence);
    const Dep = L.department === "service" ? "Service" : "Sales";
    const Cad = cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : "Daily";
    const subject = `${Dep} ${Cad} Digest — ${name}`;
    const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence, local_date: w.localDate, dealer_timezone: tz, trigger: "manual" };
    const upsert = async (extra) => {
      const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" }).select("id");
      if (error) throw new Error(`roi_digest_runs write failed: ${error.message}`);
    };
    const note = (status, extra) => out.details.push({ team: L.team_id, dept: L.department, name, status, ...(extra || {}) });
    try {
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, cadence);
      if (!emails.length) { await upsert({ status: "not_sent", reason: "recipients_missing", subject }); out.no_recipients++; note("no_recipients"); return; }
      const day = await getMetrics(L.team_id, L.department, w, "day");
      const mtd = await getMetrics(L.team_id, L.department, w, "mtd");
      const ai = await getActionItems(L.team_id, L.department, w);
      const m = { ...day, actionItemsTotal: ai.total, appointmentsYesterdayMTD: mtd.appointmentsYesterday, warmTransfersMTD: mtd.warmTransfers, inboundUniqueLeadsMTD: mtd.inboundUniqueLeads, outboundUniqueReachedMTD: mtd.outboundUniqueReached, outboundConnectRateMTD: mtd.outboundConnectRate, outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet, callingDuringMTD: mtd.callingDuring, callingAfterMTD: mtd.callingAfter, qualifiedLeadsMTD: mtd.qualifiedLeads };
      const tpl = pickTemplate(c, cadence);
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      const g = guardrailFor(tpl, m);
      if (!g.ok && !force) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; note("no_data", { reason: g.reason }); return; }
      const camps = await getCampaigns(L.team_id, L.department, w);
      const dollarRate = digestDollarRate(L.department);
      let enr = { appointments: [], topVehicles: [] };
      try { const { enrichRooftop } = await import("./digestEnrich.js"); enr = await enrichRooftop(L.team_id, { dollarRate, dept: L.department, enterpriseId: L.enterprise_id, tz, start: w.apiStart, end: w.apiEnd, apiBase: REPORTING_API_BASE, token: process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || undefined }); } catch { /* degrade */ }
      const metricsFull = { ...metrics, campaigns: camps, appointments: enr.appointments, topVehicles: enr.topVehicles, dollarRate };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, cadence);
      const dry = forceDry || DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: forceDry ? "manual_dry_run" : (L.dry_run === true ? "dry_run" : "server_dry_run"), metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; note("suppressed"); return; }
      const sentAt = new Date().toISOString();
      const messageId = await sendMail(emails, subject, html, { force });
      await upsert({ status: "sent", reason: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: messageId || `manual-${cadence}-${sentAt}`, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++; note("sent", { recipients: emails.length });
      console.log(`  ✓ SENT (on-demand) ${cadence} ${name} [${L.department}]`);
    } catch (e) { out.errors++; note("error", { error: String(e).slice(0, 160) }); console.log(`  ✗ on-demand ${cadence} ${name} [${L.department}] error: ${String(e).slice(0, 160)}`); }
  };

  const POOL = Number(process.env.CRON_POOL || 10); let _i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, targets.length || 1)) }, async () => { while (_i < targets.length) { await process1(targets[_i++]); } }));
  console.log(`  on-demand ${cadence} summary:`, JSON.stringify({ ...out, details: undefined }));
  return out;
}

// ── PREVIEW-ONLY (render, return HTML; NO DB write, NO send) ──────────────────
// Powers the tracker's "Generate preview" step: build the SAME metrics + render
// the SAME HTML the on-demand send would produce, for ONE rooftop+dept+cadence,
// and hand it back so the drawer can show it BEFORE the user manually triggers a
// send. Read-only by construction — it touches none of the send/upsert paths, so
// it can never email or mutate roi_digest_runs. Mirrors process1's build steps.
// opts: { cadence:'daily'|'weekly'|'monthly', teamId, department }
async function previewDigestNow(opts) {
  opts = opts || {};
  const cadence = (opts.cadence === "weekly" || opts.cadence === "monthly") ? opts.cadence : "daily";
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const teamId = String(opts.teamId || "");
  const department = opts.department === "service" ? "service" : "sales";
  if (!teamId) throw new Error("teamId is required");

  const [liveRes, cfgRes] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,department").eq("team_id", teamId).eq("department", department).maybeSingle(),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,daily_template,digest_focus").eq("team_id", teamId).maybeSingle(),
  ]);
  const cfg = cfgRes.data || {};
  const tz = cfg.timezone || "America/New_York";
  const name = cfg.rooftop_name || teamId;
  const enterpriseId = cfg.enterprise_id || ""; // enterprise_id is on roi_rooftop_config, not roi_live_departments
  const w = onDemandWindow(tz, cadence);
  const Dep = department === "service" ? "Service" : "Sales";
  const Cad = cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : "Daily";
  const subject = `${Dep} ${Cad} Digest — ${name}`;

  // Same metric assembly as process1 (on-demand send), so the preview is byte-identical to what sends.
  const day = await getMetrics(teamId, department, w, "day");
  const mtd = await getMetrics(teamId, department, w, "mtd");
  const ai = await getActionItems(teamId, department, w);
  const m = { ...day, actionItemsTotal: ai.total, appointmentsYesterdayMTD: mtd.appointmentsYesterday, warmTransfersMTD: mtd.warmTransfers, inboundUniqueLeadsMTD: mtd.inboundUniqueLeads, outboundUniqueReachedMTD: mtd.outboundUniqueReached, outboundConnectRateMTD: mtd.outboundConnectRate, outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet, callingDuringMTD: mtd.callingDuring, callingAfterMTD: mtd.callingAfter, qualifiedLeadsMTD: mtd.qualifiedLeads };
  const tpl = pickTemplate(cfg, cadence);
  const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(cfg, m) };
  const g = guardrailFor(tpl, m);
  const camps = await getCampaigns(teamId, department, w);
  const dollarRate = digestDollarRate(department);
  let enr = { appointments: [], topVehicles: [] };
  try { const { enrichRooftop } = await import("./digestEnrich.js"); enr = await enrichRooftop(teamId, { dollarRate, dept: department, enterpriseId, tz, start: w.apiStart, end: w.apiEnd, apiBase: REPORTING_API_BASE, token: process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || undefined }); } catch { /* degrade */ }
  const metricsFull = { ...metrics, campaigns: camps, appointments: enr.appointments, topVehicles: enr.topVehicles, dollarRate };
  const html = renderDigest(tpl, name, department, w.dateLabel, enterpriseId, teamId, w.localDate, tz, metricsFull, camps, cadence);
  return { ok: true, cadence, teamId, department, name, subject, dateLabel: w.dateLabel, hasData: g.ok, reason: g.ok ? null : g.reason, metrics: metricsFull, html };
}

async function runCadence(cadence) {
  if (cadence !== "weekly" && cadence !== "monthly") return { skipped: true };
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const enabledCol = cadence === "weekly" ? "weekly_enabled" : "monthly_enabled";
  const [liveRes, cfgRes, recRes] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select(`team_id,enterprise_id,rooftop_name,timezone,digest_send_hour,daily_enabled,daily_template,digest_focus,sms_enabled,${enabledCol}`),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) throw new Error((liveRes.error || cfgRes.error || recRes.error).message);
  const cfgOf = new Map((cfgRes.data ?? []).map((c) => [c.team_id, c]));
  for (const L of (liveRes.data ?? [])) L.enterprise_id = cfgOf.get(L.team_id)?.enterprise_id || ""; // enterprise_id is on cfg, not live
  const recOf = new Map();
  for (const r of recRes.data ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const IGNORE_HOUR = process.env.IGNORE_SEND_HOUR === "true";
  const IGNORE_DAY = process.env.IGNORE_SEND_DAY === "true"; // testing: ignore the Mon/1st gate
  const ONLY = (process.env.ONLY_TEAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = { sent: 0, suppressed: 0, not_due: 0, already_sent: 0, no_recipients: 0, no_data: 0, before_hour: 0, errors: 0 };
  const smsFailures = []; // genuine weekly/monthly digest-SMS failures this pass → Slack breakage alert (SMS)

  const process1 = async (L) => {
    const c = cfgOf.get(L.team_id); const tz = c?.timezone || "America/New_York"; const name = c?.rooftop_name || L.team_id;
    if (!c || c[enabledCol] !== true) return;
    const w = cadenceWindow(tz, cadence);
    if (!IGNORE_DAY && !w.sendDue) { out.not_due++; return; }
    const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence, local_date: w.localDate, dealer_timezone: tz, trigger: "cron" };
    const upsert = async (extra) => {
      const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" }).select("id");
      if (error) throw new Error(`roi_digest_runs write failed: ${error.message}`);
    };
    try {
      const { data: done } = await sb.from("roi_digest_runs").select("id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate).eq("status", "sent").maybeSingle();
      if (done) { out.already_sent++; return; }
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, cadence);
      if (!emails.length) { await upsert({ status: "not_sent", reason: "recipients_missing" }); out.no_recipients++; return; }
      const day = await getMetrics(L.team_id, L.department, w, "day");
      const mtd = await getMetrics(L.team_id, L.department, w, "mtd");
      const ai = await getActionItems(L.team_id, L.department, w);
      const m = { ...day, actionItemsTotal: ai.total, appointmentsYesterdayMTD: mtd.appointmentsYesterday, warmTransfersMTD: mtd.warmTransfers, inboundUniqueLeadsMTD: mtd.inboundUniqueLeads, outboundUniqueReachedMTD: mtd.outboundUniqueReached, outboundConnectRateMTD: mtd.outboundConnectRate, outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet, callingDuringMTD: mtd.callingDuring, callingAfterMTD: mtd.callingAfter, qualifiedLeadsMTD: mtd.qualifiedLeads };
      const tpl = pickTemplate(c, cadence); // weekly/monthly → always v2
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      const subject = `${L.department === "service" ? "Service" : "Sales"} ${cadence === "weekly" ? "Weekly" : "Monthly"} Digest — ${name}`;
      await upsert({ status: "queued", reason: null, metrics, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
      const g = guardrailFor(tpl, m);
      if (!g.ok) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; return; }
      const sendHour = c?.digest_send_hour ?? 7;
      if (!IGNORE_HOUR && w.localHour < sendHour) { await upsert({ status: "scheduled", reason: "before_send_hour", metrics, subject }); out.before_hour++; return; }
      const camps = await getCampaigns(L.team_id, L.department, w);
      const dollarRate = digestDollarRate(L.department);
      let enr = { appointments: [], topVehicles: [] };
      try { const { enrichRooftop } = await import("./digestEnrich.js"); enr = await enrichRooftop(L.team_id, { dollarRate, dept: L.department, enterpriseId: L.enterprise_id, tz, start: w.apiStart, end: w.apiEnd, apiBase: REPORTING_API_BASE, token: process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || undefined }); } catch { /* degrade */ }
      const metricsFull = { ...metrics, campaigns: camps, appointments: enr.appointments, topVehicles: enr.topVehicles, dollarRate };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, cadence);
      // Digest SMS (weekly/monthly) — terse summary to subscribers with a phone. Before the email
      // dry gate so held emails don't block SMS; own SMS_DRY_RUN + dedupe.
      const smsRecips = subscribedSmsRecips(recOf.get(L.team_id), L.department, cadence, c && c.sms_enabled);
      if (smsRecips.length && !(SMS_DRY_RUN || L.dry_run === true)) {
        const reportLink = links(L.enterprise_id, L.team_id, L.department, w.localDate, tz).reports;
        const smsRes = await sendDigestSms(sb, { team_id: L.team_id, enterprise_id: L.enterprise_id, department: L.department }, cadence, w.localDate, smsRecips, T.renderDigestSms({ cadence, rooftopName: name, dept: L.department, metrics: m, link: reportLink }));
        if (smsRes && smsRes.error) smsFailures.push({ rooftop: name, dept: L.department, error: smsRes.error });
      }
      const dry = DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: "dry_run", metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; return; }
      // Atomic send-claim (at-most-once per customer · dept · cadence · period) — see runOnce for rationale.
      const sentAt = new Date().toISOString();
      const lockId = `cron-${L.team_id}-${L.department}-${cadence}-${w.localDate}`;
      const { data: claim, error: claimErr } = await sb.from("roi_digest_runs")
        .update({ status: "sending", message_id: lockId })
        .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate)
        .is("message_id", null)
        .select("id");
      if (claimErr) throw new Error(`send-claim failed: ${claimErr.message}`);
      if (!claim || !claim.length) { out.already_sent++; return; }
      const messageId = await sendMail(emails, subject, html);
      await upsert({ status: "sent", reason: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: messageId || lockId, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++;
      console.log(`  ✓ SENT ${cadence} ${name} [${L.department}]`);
    } catch (e) { out.errors++; console.log(`  ✗ ${cadence} ${name} [${L.department}] error: ${String(e).slice(0, 160)}`); }
  };
  const targets = (liveRes.data ?? []).filter((L) => !ONLY.length || ONLY.includes(L.team_id));
  const POOL = Number(process.env.CRON_POOL || 10); let _i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, targets.length || 1)) }, async () => { while (_i < targets.length) { await process1(targets[_i++]); } }));
  console.log(`  ${cadence} summary:`, JSON.stringify(out));
  // Slack breakage alert for the weekly/monthly digest SMS channel (same tiered thresholds).
  await postBreakageAlert({ source: `${cadence === "weekly" ? "Weekly" : "Monthly"} digest SMS`, failures: smsFailures, sentOk: null, windowLabel: `${cadence} digest send pass` })
    .catch((e) => console.warn("[roi-cron] cadence sms slack alert skipped:", String(e).slice(0, 140)));
  return out;
}

// ── Rooftop DISCOVERY (sync-live) ────────────────────────────────────────────
// Pull the onboarded+active Sales/Service rooftops from the ClickHouse candidates
// endpoint and ADD any new ones to roi_live_departments as is_live=true, dry_run=true
// — i.e. visible in the tracker and processed by the hourly send, but SUPPRESSED
// (dry_run) so NO email goes out until a human flips dry_run off. Additive only:
// ON CONFLICT DO NOTHING preserves every existing human-set is_live/dry_run flag,
// and we never auto-deactivate a rooftop (that stays a deliberate human action).
async function syncLive() {
  const ts = new Date().toISOString();
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const endpoint = process.env.CLICKHOUSE_CANDIDATES_ENDPOINT;
  const keyId = process.env.CLICKHOUSE_KEY_ID, keySecret = process.env.CLICKHOUSE_KEY_SECRET;
  if (!endpoint || !keyId || !keySecret) {
    throw new Error("Missing CLICKHOUSE_CANDIDATES_ENDPOINT / CLICKHOUSE_KEY_ID / CLICKHOUSE_KEY_SECRET (set them as Vercel env vars)");
  }

  // saved ClickHouse Query API endpoint: POST + Basic auth, returns rows {e,t,d}
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
    body: JSON.stringify({ queryVariables: {}, format: "JSONEachRow" }),
  });
  if (!res.ok) throw new Error(`ClickHouse candidates ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  let rows;
  try { const j = JSON.parse(text); rows = Array.isArray(j) ? j : (j.data ?? [j]); }
  catch { rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

  // normalize → {team_id, department}; held as is_live=true + dry_run=true
  const seen = new Set();
  const cand = [];
  for (const r of rows) {
    const team_id = String(r.t ?? r.team_id ?? "").trim();
    const department = String(r.d ?? r.department ?? "").trim().toLowerCase();
    if (!team_id || (department !== "sales" && department !== "service")) continue;
    const k = `${team_id}|${department}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // enterprise_id lives on roi_rooftop_config, not roi_live_departments (canonical schema) —
    // don't write it here or the upsert 400s on reporting-vini. Set at rooftop onboarding instead.
    cand.push({ team_id, department, is_live: true, dry_run: true });
  }

  // figure out which (team,dept) are genuinely new (for reporting)
  const { data: existing, error: exErr } = await sb.from("roi_live_departments").select("team_id,department");
  if (exErr) throw new Error(`read roi_live_departments failed: ${exErr.message}`);
  const have = new Set((existing ?? []).map((e) => `${e.team_id}|${e.department}`));
  const fresh = cand.filter((c) => !have.has(`${c.team_id}|${c.department}`));

  // insert — ignoreDuplicates so existing rows (and their human flags) are untouched
  for (let i = 0; i < cand.length; i += 500) {
    const { error } = await sb.from("roi_live_departments")
      .upsert(cand.slice(i, i + 500), { onConflict: "team_id,department", ignoreDuplicates: true });
    if (error) throw new Error(`upsert roi_live_departments failed: ${error.message}`);
  }

  const summary = { candidates: cand.length, new_rooftops: fresh.length, new_list: fresh.map((c) => `${c.team_id}:${c.department}`).slice(0, 100) };
  await sb.from("roi_cron_runs").insert({ source: "sync-live", ok: true, summary }).then(() => {}, () => {});
  console.log(`[sync-live] candidates=${cand.length} new=${fresh.length}`);
  return { ranAt: ts, ...summary };
}

// Importable surface for the Vercel serverless cron + tests.
module.exports = { runOnce, runCadence, generateAndSendNow, previewDigestNow, backfill, rerender, renderStoredDigest, renderHtml, renderHtmlV1, renderDigest, pickTemplate, sendMail, syncLive, apiMetrics, apiActionItems, apiCampaigns };

// CLI entrypoint — only runs when invoked directly (`node runner.cjs ...`), never on require.
if (IS_CLI) {
  (async () => {
    if (RERENDER_ONLY) { await rerender(); return; }
    const bf = process.argv.indexOf("--backfill");
    if (bf !== -1) {
      const start = process.argv[bf + 1], end = process.argv[bf + 2];
      if (!start || !end) { console.error("usage: node runner.cjs --backfill 2026-06-03 2026-06-09"); process.exit(1); }
      await backfill(start, end);
      return;
    }
    await runOnce();
    if (process.argv.includes("--loop")) {
      console.log("\n[loop] next pass in 60 min …");
      setInterval(() => { runOnce().catch((e) => console.error("pass failed:", e)); }, 60 * 60 * 1000);
    }
  })();
}
