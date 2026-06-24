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

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MAIL_URL = process.env.MAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
const MAIL_TEMPLATE = process.env.MAIL_TEMPLATE || "email-control-tower-report";
const MAIL_TOKEN = process.env.MAIL_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN !== "false";               // default ON
// Metrics source: the Reporting API (Supabase-backed) at reporting-vini. Metabase has been removed.
const REPORTING_API_BASE = process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app";

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
  const yStart = localToUTC(Y, M, D - 1, tz);
  const yEnd = new Date(localToUTC(Y, M, D, tz).getTime() - 1000);
  const monthStart = localToUTC(Y, M, 1, tz);
  const localDate = `${Y}-${String(M).padStart(2, "0")}-${String(D - 1).padStart(2, "0")}`;
  const dateLabel = new Date(yStart.getTime()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { localHour: H, localDate, dateLabel, yStart: fmtUTC(yStart), yEnd: fmtUTC(yEnd), monthStart: fmtUTC(monthStart),
    apiStart: localDate, apiEnd: `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`, apiMonthStart: `${Y}-${String(M).padStart(2, "0")}-01` };
}

// ── Reporting API source (reporting-vini, Supabase-backed) — the only metrics source ──
// One team/window fetch returns all 4 agents (Sales/Service × Inbound/Outbound). We combine
// each dept's Inbound+Outbound into the same `m` shape the Metabase path produces.
const _apiCache = new Map(); // dedupe + memoize (team|start|end) within a run
async function apiReport(teamId, start, end) {
  const k = `${teamId}|${start}|${end}`;
  if (_apiCache.has(k)) return _apiCache.get(k);
  const p = (async () => {
    const res = await fetch(`${REPORTING_API_BASE}/api/reports?team_id=${encodeURIComponent(teamId)}&start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`reporting-api ${res.status} (${teamId} ${start}..${end}): ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
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
  const im = ib.metrics || {}, om = ob.metrics || {}, ics = ib.channelSplit || {}, ocs = ob.channelSplit || {}, ir = ib.report || {};
  const callIn = n(ics.voice), smsIn = n(ics.sms), callOut = n(ocs.voice), smsOut = n(ocs.sms);
  const obCalls = n(om.calls), obRate = n(om.connectRate), cf = ir.callFlow || {};
  return {
    appointmentsYesterday: n(im.appointments) + n(om.appointments), appointmentsInbound: n(im.appointments),
    inboundUniqueLeads: n(ir.leadsAttempted),
    conversationsCall: callIn + callOut, conversationsSms: smsIn + smsOut, conversationsChat: 0, conversationsHandled: callIn + callOut + smsIn + smsOut,
    conversationsCallIn: callIn, conversationsSmsIn: smsIn, conversationsChatIn: 0,
    conversationsCallOut: callOut, conversationsSmsOut: smsOut, conversationsChatOut: 0,
    outboundUniqueReached: n(om.conversations), outboundTotalCalls: obCalls, outboundConnected: Math.round((obCalls * obRate) / 100),
    outboundConnectRate: obRate, outboundAppointmentsSet: n(om.appointments),
    warmTransfers: n(cf.transferred), transferTotalCalls: n(cf.total), transferCount: n(cf.transferred), transferRate: 0,
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
function guardrail(m) {
  const signal = m.appointmentsYesterday + m.conversationsHandled + m.inboundUniqueLeads + m.actionItemsTotal;
  if (signal === 0) return { ok: false, reason: "no_data" };
  if (m.appointmentsYesterday === 0 && m.actionItemsTotal === 0 && m.inboundUniqueLeads === 0) return { ok: false, reason: "not_actionable" };
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

// Canonical email template — reproduces public/digest-preview.html exactly (same markup,
// colors #0369A1/#0891B2/#0D9488, sections). Filled with real data; sections without a data
// source (avg response time, after-hours, top vehicles) degrade to —/0/omit.
function renderHtml(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns) {
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
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">Conversations handled</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${m.conversationsHandled || 0}</div>${hasConv ? channelBar : `<div style="font-size:11px;color:#9CA3AF;margin-top:10px;">No conversations yesterday</div>`}</div></td>
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
      ${mini("Connect rate", `${m.outboundConnectRate || 0}%`, `Yesterday · ${m.outboundConnectRateMTD || 0}% MTD`)}
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

async function sendMail(to, subject, html) {
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

async function runOnce() {
  const ts = new Date().toISOString();
  console.log(`\n── ROI cron pass @ ${ts} · DRY_RUN=${DRY_RUN} ──`);
  // FAIL LOUD: a misconfigured serverless function (missing ROI_SUPABASE_*) used to
  // silently return an all-zero summary because the Supabase error was swallowed. Surface it.
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY (set them as server env vars on Vercel — NOT VITE_-prefixed).");
  const [liveRes, cfgRes, recRes] = await Promise.all([
    sb.from("roi_live_departments").select("team_id,enterprise_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,rooftop_name,timezone,digest_send_hour,daily_enabled"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) {
    const e = liveRes.error || cfgRes.error || recRes.error;
    throw new Error(`Supabase read failed (check ROI_SUPABASE_URL/ROI_SUPABASE_SERVICE_KEY): ${e.message}`);
  }
  const live = liveRes.data, cfg = cfgRes.data, rec = recRes.data;
  if (!live || live.length === 0) console.warn("[roi-cron] WARNING: roi_live_departments.is_live=true returned 0 rows — nothing to process (check data / env).");
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  const recOf = new Map();
  for (const r of rec ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const out = { sent: 0, queued: 0, suppressed: 0, no_data: 0, before_hour: 0, no_recipients: 0, already_sent: 0, errors: 0 };
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
      // recipients (step 1 finalized) for this dept
      const emails = (recOf.get(L.team_id) ?? []).filter((r) => (L.department === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled).map((r) => r.email);
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
      };
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate };
      const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
      await upsert({ status: "queued", reason: null, metrics, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
      out.queued++;
      // step 3 — guardrails
      const g = guardrail(m);
      if (!g.ok) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; console.log(`  · ${name} [${L.department}] not_sent → ${g.reason} (appts ${m.appointmentsYesterday} · conv ${m.conversationsHandled} · leads ${m.inboundUniqueLeads} · actions ${m.actionItemsTotal})`); return; }
      // step 4 — send-hour gate
      const sendHour = c?.digest_send_hour ?? 7;
      if (!IGNORE_HOUR && w.localHour < sendHour) { await upsert({ status: "scheduled", reason: "before_send_hour", metrics, subject }); out.before_hour++; console.log(`  · ${name} [${L.department}] scheduled → before_send_hour (local ${tz} ${String(w.localHour).padStart(2, "0")}:00 < send ${String(sendHour).padStart(2, "0")}:00)`); return; }
      // active campaigns (3rd embedding) — only now, just before render
      const camps = await getCampaigns(L.team_id, L.department, w);
      const metricsFull = { ...metrics, campaigns: camps };
      const html = renderHtml(name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, m, camps);
      const dry = DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: "dry_run", metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; console.log(`  · ${name} [${L.department}] suppressed (dry-run)`); return; }
      // SEND
      const sentAt = new Date().toISOString();
      const messageId = await sendMail(emails, subject, html);
      // guarantee a non-null id so the "really emailed" lock (message_id IS NOT NULL) holds
      // even when the mail provider returns no id in its response.
      const lockId = messageId || `cron-${sentAt}`;
      await upsert({ status: "sent", reason: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: lockId, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++;
      console.log(`  ✓ SENT ${name} [${L.department}] → ${emails.join(", ")}`);
    } catch (e) {
      out.errors++;
      console.log(`  ✗ ${name} [${L.department}] error: ${String(e).slice(0, 160)}`);
      try { await upsert({ status: "not_sent", reason: "error", reason_detail: String(e).slice(0, 400) }); } catch { /* swallow — one failure must not halt the pass */ }
    }
  };
  // Concurrency pool — fit the whole pass inside the serverless time limit.
  const POOL = Number(process.env.CRON_POOL || 10);
  let _i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, targets.length)) }, async () => {
    while (_i < targets.length) { const L = targets[_i++]; await processOne(L); }
  }));
  console.log("  summary:", JSON.stringify(out));
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
    sb.from("roi_live_departments").select("team_id,enterprise_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,rooftop_name,timezone,daily_enabled"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled"),
  ]);
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  const recOf = new Map();
  for (const r of rec ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const days = dateRange(start, end);
  const out = { sent: 0, not_sent: 0, preserved: 0, errors: 0 };
  const POOL = 8;
  const tasks = (live ?? []).filter((L) => (cfgOf.get(L.team_id)?.daily_enabled) !== false);

  async function worker(L) {
    const c = cfgOf.get(L.team_id); const tz = c?.timezone || "America/New_York";
    const name = c?.rooftop_name || L.team_id;
    const emails = (recOf.get(L.team_id) ?? []).filter((r) => (L.department === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled).map((r) => r.email);
    for (const day of days) {
      const w = windowsForDate(day, tz);
      const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: day, dealer_timezone: tz, trigger: "backfill" };
      try {
        const dayM = await getMetrics(L.team_id, L.department, w, "day");
        const mtd = await getMetrics(L.team_id, L.department, w, "mtd");
        const ai = await getActionItems(L.team_id, L.department, w);
        const camps = await getCampaigns(L.team_id, L.department, w);
        const m = { ...dayM, actionItemsTotal: ai.total, appointmentsYesterdayMTD: mtd.appointmentsYesterday, warmTransfersMTD: mtd.warmTransfers, inboundUniqueLeadsMTD: mtd.inboundUniqueLeads, outboundUniqueReachedMTD: mtd.outboundUniqueReached, outboundConnectRateMTD: mtd.outboundConnectRate, outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet };
        const metrics = { ...m, actionItems: ai.items, campaigns: camps, reportDate: day };
        const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
        const g = guardrail(m);
        const html = renderHtml(name, L.department, w.dateLabel, L.enterprise_id, L.team_id, day, tz, m, camps);
        // preserve a row already marked sent — just refresh its data
        const { data: ex } = await sb.from("roi_digest_runs").select("status,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day).maybeSingle();
        if (ex?.status === "sent") {
          // LOCK: a really-emailed row (message_id set) keeps its exact sent body — refresh metrics only.
          const upd = ex.message_id ? { metrics, subject } : { metrics, rendered_html: html, subject };
          await sb.from("roi_digest_runs").update(upd).eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day); out.preserved++; continue;
        }
        const up = (extra) => sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" });
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
  const { data: cfg } = await sb.from("roi_rooftop_config").select("team_id,rooftop_name");
  const nameOf = new Map((cfg ?? []).map((c) => [c.team_id, c.rooftop_name]));
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
        const html = renderHtml(name, r.department, dateLabel, r.enterprise_id, r.team_id, r.local_date, tz, m, camps);
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

// Importable surface for the Vercel serverless cron (api/cron/roi-email.js) + tests.
module.exports = { runOnce, backfill, rerender, renderHtml, sendMail, apiMetrics, apiActionItems, apiCampaigns };

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
