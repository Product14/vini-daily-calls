/* Transactional (event-driven) email templates — the per-event companions to the
 * daily/weekly/monthly digest. Sent by the frequent poll pass (not the daily cron):
 *
 *   renderPostAppointment   — a new appointment was booked
 *   renderPostConversation  — a call/SMS conversation happened       (TODO: needs a per-conversation feed)
 *   renderActionItem        — a new action item was created/assigned (TODO: needs a per-action-item feed)
 *   renderActionItemOverdue — an action item breached its SLA         (TODO: depends on the action-item feed)
 *
 * Self-contained on purpose (its own tiny style header) so it never couples to the
 * big digest template's internals; palette is kept identical so the two read as one
 * product. Email-safe: tables + inline styles only, absolute asset URLs.
 */

// ── palette (mirrors digestTemplate.cjs) ──
var BRAND = "#4600F2", BRAND2 = "#A21CAF", VIOLET = "#6D28D9";
var INK = "#0F172A", BODY = "#334155", MUTE = "#64748B", FAINT = "#94A3B8";
var LINE = "#E6E8EC", CARD = "#FFFFFF", WASH = "#F8FAFC", PAGE = "#EEF1F6";
var GREEN_BIG = "#15803D";
var POS = "#16A34A", POS_BG = "#DCFCE7", AMBER = "#B45309", AMBER_BG = "#FEF3C7", SLATE_BG = "#EEF2F7";

function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
// Anti-churn no-value marker — MUST stay byte-identical to emailValue.cjs NO_VALUE_MARK. The send
// chokepoints (eventRunner.sendMail, app.js roi-event-*) refuse to send a marked email unless the
// DANGER override is supplied; the marker is stripped off the wire so a customer never sees it. This
// module is required by the server (not bundled into the SPA), so it stamps the marker itself rather
// than requiring emailValue — the transactional gate was previously dead because nothing stamped it.
var NO_VALUE_MARK = "<!--vini:no-value-->";
function stampValue(html, hasValue) { return hasValue ? html : (String(html || "") + NO_VALUE_MARK); }
function fmtInt(n) { n = Number(n) || 0; return n.toLocaleString("en-US"); }
// Pretty-print a phone for display (batch SMS lines + the leadHeader email chip). Ported 1:1 from
// src/email/EmailerTracker.tsx's formatPhone — kept in sync manually, since this .cjs file (required
// server-side) can't import a .tsx module (this repo already duplicates small helpers this way, e.g.
// isRealEmail is defined identically in both runner.cjs and eventRunner.cjs). US numbers (10 digits,
// or 11 with a leading 1) -> "+1 (555) 123-4567". Anything else keeps a leading "+" and its digits,
// so international/partial numbers aren't mangled. Empty in -> empty out.
function formatPhone(raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  var hadPlus = s.charAt(0) === "+";
  var d = s.replace(/\D/g, "");
  if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
  if (d.length === 10) return "+1 (" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  return hadPlus ? "+" + d : d;
}
function money(n) { n = Number(n) || 0; return "$" + n.toLocaleString("en-US"); }
function btnPrimary(label, href) {
  return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:' + VIOLET + ';color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 22px;border-radius:10px;">' + esc(label) + " &nbsp;&#8599;</a>";
}
function pixel(url) { return url ? '<img src="' + esc(url) + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />' : ""; }

// Shared chrome: header band → body → footer. `eyebrow` is the small caps label,
// `title` the bold headline. `bodyHtml` is the card content.
function shell(opts, eyebrow, title, bodyHtml) {
  opts = opts || {};
  var dept = opts.dept === "service" ? "Service" : "Sales";
  var rooftop = esc(opts.rooftopName || "Your rooftop");
  var consoleUrl = (opts.links && opts.links.console) || "https://console.spyne.ai/converse-ai";
  return (
    '<!--[if mso]><style>body,table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->' +
    '<div style="background:' + PAGE + ';padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center" style="width:600px;max-width:600px;margin:0 auto;background:' + CARD + ';border-radius:20px;overflow:hidden;border:1px solid ' + LINE + ';">' +
    // header band
    '<tr><td style="padding:20px 28px;background:#0B1020;background:linear-gradient(120deg,#11163A 0%,#312E81 60%,' + BRAND + ' 130%);">' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="font-size:13px;font-weight:800;color:#fff;letter-spacing:.3px;">Vini · ' + dept + '</td>' +
        '<td align="right" style="font-size:12px;color:#C7CBE6;font-weight:600;">' + rooftop + "</td>" +
      "</tr></table></td></tr>" +
    // eyebrow + title
    '<tr><td style="padding:24px 28px 0;">' +
      '<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:' + BRAND + ';">' + esc(eyebrow) + "</div>" +
      '<div style="font-size:21px;font-weight:900;color:' + INK + ';margin-top:6px;line-height:1.25;">' + title + "</div>" +
    "</td></tr>" +
    // body
    "<tr><td style=\"padding:18px 28px 4px;\">" + bodyHtml + "</td></tr>" +
    // footer
    '<tr><td style="padding:22px 28px 26px;" align="center">' +
      '<div style="font-size:11px;color:' + FAINT + ';line-height:1.7;">Sent by Vini · ' + dept + ' for ' + rooftop + "<br/>© Spyne · Vini · 2026</div>" +
      '<div style="margin-top:12px;"><a href="' + esc(consoleUrl) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#0B1020;color:#fff;text-decoration:none;font-size:12px;font-weight:700;padding:9px 16px;border-radius:9px;">Open dashboard &nbsp;&#8594;</a></div>' +
    "</td></tr>" +
    "</table>" + pixel(opts.pixelUrl) + "</div>"
  );
}

// A labelled detail row inside the appointment card.
function detail(label, value) {
  if (!value) return "";
  return '<tr><td style="padding:7px 0;font-size:12px;color:' + MUTE + ';width:96px;vertical-align:top;">' + esc(label) + '</td>' +
    '<td style="padding:7px 0;font-size:13px;font-weight:700;color:' + INK + ';">' + esc(value) + "</td></tr>";
}

/**
 * Post-appointment email — fires when VINI books an appointment (source='spyne').
 * Customer-backwards: the manager needs to know WHO is coming, WHEN, for WHAT, and that
 * it's real (booked by the AI) — so they can staff/prep and trust it. Leads with the time.
 * opts: { rooftopName, dept, tz, mtdCount, links, pixelUrl, appointment:{
 *   customer,phone, when(preformatted), relDay('Today'|'Tomorrow'|'Fri, Sep 27'), time,
 *   type('Sales'|'Service'), intent, vehicle, transportation, status, byVini(bool),
 *   recordingUrl } }
 */
function renderPostAppointment(opts) {
  opts = opts || {};
  var a = opts.appointment || {};
  var L = opts.links || {};
  var apptUrl = L.appointment || L.console || "https://console.spyne.ai/converse-ai";
  var whenBig = a.relDay ? (a.relDay + (a.time ? " · " + a.time : "")) : (a.when || "");
  var statusOk = String(a.status || "scheduled").toLowerCase();
  var statusPill = statusOk === "scheduled" || statusOk === "" ? "" : pill(esc(a.status), statusOk.indexOf("cancel") >= 0 || statusOk.indexOf("noshow") >= 0 || statusOk.indexOf("no_show") >= 0 ? NEG : MUTE, statusOk.indexOf("cancel") >= 0 ? NEG_BG : SLATE_BG);

  var chips = "";
  if (a.byVini) chips += pill("&#10022; Booked by Vini", BRAND, "#EDE9FE");
  chips += pill((a.type || (opts.dept === "service" ? "Service" : "Sales")), MUTE, WASH);
  chips += statusPill;

  var card =
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #C7F0D8;border-radius:14px;background:#F0FDF4;"><tr><td style="padding:18px 20px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr><td valign="middle">' + avatar(a.customer, 40) +
        '<span style="display:inline-block;vertical-align:middle;margin-left:10px;">' +
          '<span style="display:block;font-size:16px;font-weight:800;color:' + INK + ';">' + esc(a.customer || "Customer") + "</span>" +
          (a.phone ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(a.phone) + "</span>" : "") +
        "</span></td></tr></table>" +
      (whenBig ? '<div style="margin-top:14px;font-size:20px;font-weight:900;color:' + GREEN_BIG + ';line-height:1.2;">&#128197; ' + esc(whenBig) + "</div>" : "") +
      '<div style="margin-top:12px;">' + chips + "</div>" +
      '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid #C7F0D8;">' +
        detail("For", a.intent ? humanizeIntent(a.intent) : "") +
        detail("Vehicle", a.vehicle && a.vehicle !== "—" ? a.vehicle : "") +
        detail("Transport", a.transportation) +
      "</table>" +
    "</td></tr></table>" +
    recordingRow(a.recordingUrl, null, null) +
    smsThread(opts.sms, opts.smsFailed) +
    '<div style="margin-top:16px;">' + btnPrimary("Confirm appointment", apptUrl) + "</div>";

  var title = (a.customer ? esc(a.customer) : "Appointment") + (a.relDay ? " — " + esc(a.relDay) + (a.time ? " " + esc(a.time) : "") : " is on the calendar");
  var hasValue = !!(a.customer || whenBig || a.intent || a.vehicle);
  return stampValue(shell(opts, a.byVini ? "Vini booked an appointment" : "New appointment", title, card + mtdStrip(opts.mtdCount, "appointments booked by Vini this month", apptUrl)), hasValue);
}

// ── intent humanizer (mirrors the digest template's labels) ──
var INTENT_LABELS = {
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointment to schedule", SERVICE_RECALL_FOLLOW_UP: "Recall follow-up",
  SERVICE_STATUS_UPDATE: "Pending status update", SERVICE_ESCALATE_TO_ADVISOR: "Escalate to advisor",
  SERVICE_SEND_ESTIMATE: "Estimate to send", SERVICE_PARTS_CALLBACK: "Parts callback",
  REQUEST_CALLBACK: "Callback requested", callback_request: "Callback requested", sms_takeover: "SMS takeover requested",
  failed_booking: "Failed booking to review", specific_salesperson: "Asked for a salesperson", CUSTOM: "Action item",
};
function humanizeIntent(k) { return INTENT_LABELS[k] || String(k || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }); }

var NEG = "#DC2626", NEG_BG = "#FEE2E2", WARM = "#D97706";

// MTD context strip — the "additional value on every email" rule.
function mtdStrip(n, noun, href) {
  n = Number(n) || 0;
  if (n <= 0) return "";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid ' + LINE + ';"><tr><td style="padding-top:14px;font-size:12px;color:' + MUTE + ';">' +
    '<span style="font-weight:900;color:' + GREEN_BIG + ';font-size:15px;">' + fmtInt(n) + "</span> " + esc(noun) + " this month &nbsp;·&nbsp; " +
    '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="color:' + BRAND + ';font-weight:700;text-decoration:none;">View all &#8594;</a></td></tr></table>';
}

// ── rich building blocks (post-conversation + lead-level action items) ────────

// circular initial avatar (no fabricated headshot, matches the digest device card)
function avatar(name, size) {
  var s = size || 40, fs = Math.round(s * 0.42);
  var ini = String(name || "").trim() ? String(name).trim()[0].toUpperCase() : "?";
  return '<table cellpadding="0" cellspacing="0" style="display:inline-table;vertical-align:middle;"><tr>' +
    '<td align="center" valign="middle" style="width:' + s + "px;height:" + s + "px;border-radius:50%;background:" + BRAND + ";background:linear-gradient(135deg," + BRAND + " 0%," + BRAND2 + ' 100%);">' +
    '<span style="font-size:' + fs + "px;font-weight:800;color:#fff;line-height:" + s + 'px;">' + esc(ini) + "</span></td></tr></table>";
}

// pill helper
function pill(txt, col, bg) { return '<span style="display:inline-block;font-size:11px;font-weight:800;color:' + col + ";background:" + bg + ';border-radius:9999px;padding:3px 10px;margin:0 6px 6px 0;white-space:nowrap;">' + txt + "</span>"; }

// AI call-score pill — coloured by grade/score (the "94 · Poor/Excellent" chip)
function scorePill(score, grade) {
  var n = Number(score);
  if (!isFinite(n) && !grade) return "";
  var g = String(grade || "").toLowerCase();
  var good = g.indexOf("excellent") >= 0 || g.indexOf("good") >= 0 || (isFinite(n) && n >= 80);
  var bad = g.indexOf("poor") >= 0 || (isFinite(n) && n < 50);
  var col = good ? POS : bad ? NEG : AMBER, bg = good ? POS_BG : bad ? NEG_BG : AMBER_BG;
  var label = (isFinite(n) ? n : "") + (grade ? (isFinite(n) ? " · " : "") + esc(grade) : "");
  return pill("AI score " + label, col, bg);
}

// sentiment chip — positive/neutral/negative
function sentimentChip(sentiment, sscore) {
  var s = String(sentiment || "").toLowerCase();
  if (!s) return "";
  var col = s === "positive" ? POS : s === "negative" ? NEG : MUTE;
  var bg = s === "positive" ? POS_BG : s === "negative" ? NEG_BG : SLATE_BG;
  var dot = s === "positive" ? "☺" : s === "negative" ? "☹" : "•";
  var label = s.replace(/^\w/, function (x) { return x.toUpperCase(); }) + (isFinite(Number(sscore)) && Number(sscore) > 0 ? " " + Number(sscore) + "/10" : "");
  return pill(dot + " " + esc(label), col, bg);
}

// two-up stat row (Intent | Deal value), email-safe table columns
function statColumns(cells) {
  cells = (cells || []).filter(Boolean);
  if (!cells.length) return "";
  var w = Math.floor(100 / cells.length) + "%";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>' +
    cells.map(function (c) {
      return '<td width="' + w + '" valign="top" style="padding-right:12px;">' +
        '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">' + esc(c.label) + "</div>" +
        '<div style="font-size:15px;font-weight:800;color:' + (c.color || INK) + ';margin-top:4px;line-height:1.3;">' + esc(c.value) + "</div></td>";
    }).join("") + "</tr></table>";
}

// appointment sub-card (vehicle · date · time · type)
function apptCard(a) {
  if (!a) return "";
  var rows = detail("Vehicle", a.vehicle) + detail("When", a.when || (a.date && a.time ? a.date + " · " + a.time : a.date || a.time)) + detail("Type", a.type);
  if (!rows) return "";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid #C7F0D8;border-radius:12px;background:#F0FDF4;"><tr><td style="padding:12px 16px;">' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:' + GREEN_BIG + ';margin-bottom:4px;">&#128197; Appointment</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0">' + rows + "</table></td></tr></table>";
}

// bullet block (Key takeaways / Topics / What went well)
function bulletBlock(title, items, dotColor) {
  items = (Array.isArray(items) ? items : [items]).map(function (x) { return typeof x === "string" ? x : (x && (x.title || x.detail) ? (x.title ? "<b>" + esc(x.title) + "</b>" + (x.detail ? " — " + esc(x.detail) : "") : esc(x.detail)) : ""); }).filter(function (x) { return x && String(x).trim(); });
  if (!items.length) return "";
  return '<div style="margin-top:16px;">' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin-bottom:6px;">' + esc(title) + "</div>" +
    items.map(function (t) {
      return '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td width="14" valign="top" style="font-size:13px;color:' + (dotColor || BRAND) + ';line-height:1.6;">&bull;</td>' +
        '<td style="font-size:13px;color:' + BODY + ';line-height:1.6;padding-bottom:4px;">' + (/^<b>/.test(t) ? t : esc(t)) + "</td></tr></table>";
    }).join("") + "</div>";
}

// SMS thread preview — last few bubbles + delivery health. `cap` defaults to a 4-bubble PREVIEW
// (conversation-summary email, where the console link is the full record); the lead-capture sheet
// passes a real cap because the dealer works the lead from the email itself — a last-4 window can
// hide the message where the customer gave their ZIP or moved the time.
function smsThread(messages, failedCount, cap) {
  var n = Number(cap) > 0 ? Number(cap) : 4;
  var all = Array.isArray(messages) ? messages : [];
  var msgs = all.slice(-n);
  var hidden = all.length - msgs.length;
  if (!msgs.length && !failedCount) return "";
  var bubbles = msgs.map(function (m) {
    var inbound = m.direction === "in" || m.direction === "inbound";
    var col = inbound ? BODY : "#fff", bg = inbound ? CARD : BRAND, align = inbound ? "left" : "right", brd = inbound ? "border:1px solid " + LINE + ";" : "";
    return '<tr><td align="' + align + '" style="padding:3px 0;"><span style="display:inline-block;max-width:84%;font-size:12px;line-height:1.5;color:' + col + ";background:" + bg + ";border-radius:12px;padding:7px 11px;" + brd + 'text-align:left;">' + esc(m.body || "") + "</span></td></tr>";
  }).join("");
  var health = Number(failedCount) > 0
    ? '<div style="margin-top:8px;font-size:11px;color:' + NEG + ';font-weight:700;">&#9888; ' + fmtInt(failedCount) + " message" + (failedCount === 1 ? "" : "s") + " failed to deliver — check the number.</div>"
    : "";
  return '<div style="margin-top:16px;">' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin-bottom:6px;">Text thread</div>' +
    (hidden > 0 ? '<div style="font-size:11px;color:' + FAINT + ';margin-bottom:6px;">Showing the last ' + msgs.length + " of " + all.length + " messages — open the thread for the rest.</div>" : "") +
    '<table width="100%" cellpadding="0" cellspacing="0">' + bubbles + "</table>" + health + "</div>";
}

// action-item list (shared by post-conversation + lead-level action email)
function actionList(items, tz, accent) {
  items = (Array.isArray(items) ? items : []).map(function (it) { return typeof it === "string" ? { description: it } : (it || {}); });
  if (!items.length) return "";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">' +
    items.slice(0, 8).map(function (it) { return aiRow(it, accent || BRAND, tz); }).join("") + "</table>";
}

// "play recording" button + meta (duration / ended reason)
function recordingRow(url, durationSec, endedReason) {
  if (!url && !durationSec && !endedReason) return "";
  var mins = Number(durationSec) > 0 ? Math.floor(durationSec / 60) + "m " + (durationSec % 60) + "s" : "";
  var meta = [mins, endedReason ? String(endedReason).replace(/_/g, " ") : ""].filter(Boolean).join(" · ");
  var btn = url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:' + BRAND + ';color:#fff;text-decoration:none;font-size:12px;font-weight:800;padding:8px 16px;border-radius:9px;">&#9658; Play recording</a>' : "";
  return '<div style="margin-top:14px;">' + btn + (meta ? '<span style="font-size:11px;color:' + MUTE + ";margin-left:" + (btn ? "12px" : "0") + ';">' + esc(meta) + "</span>" : "") + "</div>";
}

// Shared outcome classification — same priority order used by the full banner (below) and the
// condensed batch row, so the two never drift on what counts as "needs follow-up" vs "logged".
// Priority: booked > transferred > needs-follow-up > callback > resolved > voicemail/no-answer > logged.
function classifyOutcome(c) {
  if (c.appointmentScheduled) return { col: GREEN_BIG, bg: POS_BG, text: "&#128197; Booked an appointment", sub: "Vini set this up — confirm staffing & prep." };
  if (c.transfer && (c.transfer.department || c.transfer.reason)) return { col: VIOLET, bg: "#EDE9FE", text: "&#128222; Handed to your team", sub: "Transferred to " + esc(c.transfer.department || "your team") + (c.transfer.reason ? " — " + esc(c.transfer.reason) : "") };
  if ((c.actionItems && c.actionItems.length) || c.hasActionItem) return { col: AMBER, bg: AMBER_BG, text: "&#9873; Needs human follow-up", sub: (c.actionItems && c.actionItems.length ? fmtInt(c.actionItems.length) + " action item" + (c.actionItems.length === 1 ? "" : "s") + " below." : "Vini flagged a to-do below.") };
  if (c.callbackScheduled) return { col: AMBER, bg: AMBER_BG, text: "&#8635; Callback scheduled", sub: "Vini promised a call back — make sure it happens." };
  if (c.queryResolved) return { col: GREEN_BIG, bg: POS_BG, text: "&#10003; Resolved — no action needed", sub: "Vini handled this end to end." };
  var er = String(c.endedReason || "").toLowerCase();
  if (er.indexOf("voicemail") >= 0) return { col: MUTE, bg: SLATE_BG, text: "&#9993; Left a voicemail", sub: "No live contact — Vini will keep trying per cadence." };
  if (er.indexOf("no-answer") >= 0 || er.indexOf("no_answer") >= 0 || er.indexOf("hangup") >= 0) return { col: MUTE, bg: SLATE_BG, text: "No live conversation", sub: "Call ended early — nothing to action." };
  return { col: MUTE, bg: SLATE_BG, text: "Conversation logged", sub: "" };
}
// OUTCOME banner — the single "what do I do about this?" answer, shown first.
function outcomeBanner(c) {
  var o = classifyOutcome(c);
  return '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;background:' + o.bg + ';margin-bottom:14px;"><tr><td style="padding:12px 16px;">' +
    '<div style="font-size:14px;font-weight:800;color:' + o.col + ';">' + o.text + "</div>" +
    (o.sub ? '<div style="font-size:12px;color:' + BODY + ';margin-top:3px;">' + o.sub + "</div>" : "") + "</td></tr></table>";
}

/**
 * Post-conversation email — fires after a call/SMS conversation (config-gated: mode
 * actionable|all, outbound-requires-reply). FINAL design is OUTCOME-FIRST: a manager sees
 * "what do I do?" in the banner, then the proof (who, score, sentiment, recording, summary,
 * action items, SMS thread). Every block omits when its data is absent. Backed only by fields
 * that reliably populate — no deal-value/trade-in/financing (those don't exist in the data).
 * opts: { rooftopName, dept, tz, mtdCalls, links, pixelUrl, conversation:{
 *   id,title,summary,direction,channel('call'|'sms'),customer,phone,at,
 *   aiScore,grade,frustrated, sentiment,sentimentScore, intent,callOutcome,
 *   appointmentScheduled,appointment{vehicle,date,time,when,type}, callbackScheduled,queryResolved,hasActionItem,
 *   transfer:{department,reason,name}, actionItems:[..], keyTakeaways:[..],
 *   recordingUrl,durationSec,endedReason, sms:[{direction,authorType,body,status,at}], smsFailed } }
 */
function renderPostConversation(opts) {
  opts = opts || {};
  var c = opts.conversation || {};
  var L = opts.links || {};
  var url = L.conversations || L.console || "https://console.spyne.ai/converse-ai";
  var tz = opts.tz;
  var summary = String(c.summary || "").replace(/^\[\s*"?|"?\s*\]$/g, "").replace(/^"|"$/g, "").trim();
  var isSms = c.channel === "sms";

  var when = "";
  try { if (c.at) when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz || "America/New_York" }).format(new Date(c.at)); } catch (e) { when = ""; }
  var headRow =
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle">' + avatar(c.customer, 40) +
        '<span style="display:inline-block;vertical-align:middle;margin-left:10px;">' +
          '<span style="display:block;font-size:15px;font-weight:800;color:' + INK + ';">' + esc(c.customer || "Customer") + "</span>" +
          (c.phone ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(formatPhone(c.phone)) + "</span>" : "") +
        "</span></td>" +
      (when ? '<td align="right" valign="top" style="font-size:11px;color:' + MUTE + ';white-space:nowrap;">' + esc(when) + "</td>" : "") +
    "</tr></table>";

  // health chips: channel, AI score, sentiment (and frustrated only when true)
  var chips = "";
  chips += pill((isSms ? "SMS" : "Call") + " · " + (c.direction === "outbound" ? "Outbound" : "Inbound"), MUTE, WASH);
  chips += scorePill(c.aiScore, c.grade);
  chips += sentimentChip(c.sentiment, c.sentimentScore);
  if (c.frustrated) chips += pill("&#9888; Customer frustrated", NEG, NEG_BG);
  if (c.intent) chips += pill(esc(humanizeIntent(c.intent)), BRAND, "#EDE9FE");

  var card =
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;background:' + CARD + ';"><tr><td style="padding:18px 20px;">' +
      headRow +
      '<div style="margin-top:12px;">' + chips + "</div>" +
      recordingRow(c.recordingUrl, c.durationSec, isSms ? null : c.endedReason) +
      '<div style="font-size:13px;color:' + BODY + ';line-height:1.6;margin-top:14px;">' + (summary ? esc(summary) : "No summary captured for this conversation.") + "</div>" +
      apptCard(c.appointmentScheduled ? (c.appointment || {}) : null) +
      (c.actionItems && c.actionItems.length ? '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:16px 0 0;">Action items</div>' + actionList(c.actionItems, tz, WARM) : "") +
      bulletBlock("Key takeaways", c.keyTakeaways, BRAND) +
      smsThread(c.sms, c.smsFailed) +
    "</td></tr></table>" +
    '<div style="margin-top:18px;">' + btnPrimary(isSms ? "Open thread" : "Listen & review", url) + "</div>";

  // No-value = the blank-summary placeholder with nothing else to show (no action items, no booked
  // appointment, no SMS thread, no takeaways, no recording) — exactly the empty email the gate exists for.
  var hasValue = !!(summary || (c.actionItems && c.actionItems.length) || c.appointmentScheduled || (c.sms && c.sms.length) || (c.keyTakeaways && c.keyTakeaways.length) || c.recordingUrl);
  return stampValue(shell(opts, isSms ? "Text conversation" : "Conversation summary", esc(c.title || "New conversation"), outcomeBanner(c) + card + mtdStrip(opts.mtdCalls, isSms ? "conversations handled" : "calls handled", url)), hasValue);
}

// One condensed row for the batch digest — avatar + name/phone/channel/time + a one-line outcome
// pill (same classifyOutcome() priority as the full banner, just not the big colored box).
function batchConvRow(c, tz) {
  var o = classifyOutcome(c);
  var isSms = c.channel === "sms";
  var when = "";
  try { if (c.at) when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz || "America/New_York" }).format(new Date(c.at)); } catch (e) { when = ""; }
  var label = o.text.replace(/&#\d+;\s*/, ""); // strip the leading icon entity — too busy repeated N times in a list
  return '<tr><td style="padding:10px 0;border-bottom:1px solid ' + LINE + ';">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle" style="width:38px;">' + avatar(c.customer, 32) + '</td>' +
      '<td valign="middle" style="padding-left:10px;">' +
        '<div style="font-size:13px;font-weight:800;color:' + INK + ';">' + esc(c.customer || "Customer") + "</div>" +
        '<div style="font-size:11px;color:' + MUTE + ';margin-top:1px;">' + esc(formatPhone(c.phone)) + (isSms ? " · SMS" : " · Call") + (when ? " · " + esc(when) : "") + "</div>" +
      "</td>" +
      '<td align="right" valign="middle">' + pill(esc(label), o.col, o.bg) + "</td>" +
    "</tr></table>" +
  "</td></tr>";
}

/**
 * Post-conversation BATCH email — one digest covering MULTIPLE leads' calls/texts for the same
 * rooftop+dept this pass, instead of one email per lead. Degrades to the IDENTICAL single-lead
 * message when there's exactly one conversation (delegates to renderPostConversation).
 * opts: { rooftopName, dept, tz, mtdCalls, conversations:[<same shape renderPostConversation takes>],
 *   links, detailCap(default 20) }
 */
function renderPostConversationBatch(opts) {
  opts = opts || {};
  var convos = (Array.isArray(opts.conversations) ? opts.conversations : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.conversations || L.console || "https://console.spyne.ai/converse-ai";
  if (convos.length <= 1) {
    return renderPostConversation({ rooftopName: opts.rooftopName, dept: opts.dept, tz: opts.tz, mtdCalls: opts.mtdCalls, links: L, conversation: convos[0] || {} });
  }
  var isSmsBatch = convos.every(function (c) { return c.channel === "sms"; });
  var cap = Number(opts.detailCap) || 20;
  var shown = convos.slice(0, cap);
  var hidden = convos.length - shown.length;
  var rows = shown.map(function (c) { return batchConvRow(c, opts.tz); }).join("");
  var noun = isSmsBatch ? "SMS conversations" : "calls";
  var body =
    '<div style="font-size:13px;color:' + BODY + ';margin-bottom:14px;">' + convos.length + " " + noun + ' today — condensed into one digest so it doesn\'t flood your inbox. Tap "View all" to open any of them.</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0">' + rows + "</table>" +
    (hidden > 0 ? '<div style="font-size:12px;color:' + MUTE + ';margin-top:10px;">+' + hidden + " more not shown here — view all in the console.</div>" : "") +
    '<div style="margin-top:18px;">' + btnPrimary("View all conversations", url) + "</div>";
  return stampValue(shell(opts, isSmsBatch ? "SMS digest" : "Conversation digest", convos.length + " " + noun + " — " + (opts.rooftopName || "your rooftop"), body), true);
}

// ── LEAD-CAPTURE email (per-rooftop custom format) ───────────────────────────────────────────
// A labelled lead field. Unlike detail(), a MISSING value renders as an explicit "not captured"
// placeholder instead of vanishing — for a lead sheet the BDC has to know which field to ask for
// on the confirmation call, and a silently-absent row reads as "nothing to chase".
function leadField(label, value, hint, note) {
  var has = value != null && String(value).trim() !== "";
  return '<tr><td style="padding:8px 0;border-bottom:1px solid ' + LINE + ';font-size:12px;color:' + MUTE + ';width:170px;vertical-align:top;">' + esc(label) + "</td>" +
    '<td style="padding:8px 0;border-bottom:1px solid ' + LINE + ';font-size:13px;font-weight:' + (has ? "700" : "600") + ";color:" + (has ? INK : FAINT) + ';">' +
    (has ? esc(value) : "not captured" + (hint ? ' <span style="font-weight:600;color:' + FAINT + ';">— ' + esc(hint) + "</span>" : "")) +
    (has && note ? '<div style="font-size:11px;font-weight:600;color:' + MUTE + ';margin-top:2px;">' + esc(note) + "</div>" : "") + "</td></tr>";
}
// Plain-text CRM block. This dealer's BDC enters every lead into their CRM BY HAND (no API), so the
// email has to carry one contiguous, label:value region they can select once and paste. Rendered in
// a <pre> because Outlook/Gmail preserve its line breaks on copy; an HTML table collapses to a
// single line in some clients.
function crmBlock(lines) {
  var txt = lines.map(function (p) { return p[0] + ": " + (p[1] == null || String(p[1]).trim() === "" ? "" : String(p[1])); }).join("\n");
  return '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:18px 0 6px;">Copy into CRM</div>' +
    '<pre style="margin:0;padding:14px 16px;background:' + WASH + ";border:1px dashed " + LINE + ";border-radius:12px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:12px;line-height:1.7;color:" + INK + ';white-space:pre-wrap;">' + esc(txt) + "</pre>";
}
// Full call transcript, speaker-labelled. This dealer asked for the transcript IN each lead email
// (not a console link) so whoever makes the callback can read exactly what was promised. Capped so a
// long call can't blow past provider size limits; the recording button stays the escape hatch.
function transcriptBlock(text, cap) {
  var t = String(text || "").trim();
  if (!t) return "";
  var lim = Number(cap) || 6000;
  var clipped = t.length > lim;
  if (clipped) t = t.slice(0, lim) + "\n…";
  return '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:18px 0 6px;">Transcript</div>' +
    '<div style="padding:14px 16px;background:' + CARD + ";border:1px solid " + LINE + ';border-radius:12px;font-size:12px;line-height:1.75;color:' + BODY + ';white-space:pre-wrap;">' + esc(t) + "</div>" +
    (clipped ? '<div style="font-size:11px;color:' + FAINT + ';margin-top:6px;">Transcript truncated — play the recording for the full call.</div>' : "");
}
/**
 * LEAD-CAPTURE email — a per-rooftop alternative to renderPostConversation for dealers who work
 * the AI's after-hours calls as a LEAD SHEET rather than a conversation summary. Selected via
 * roi_rooftop_config.post_conversation_template='lead_capture'.
 *
 * Built for the first rooftop on this format (Jul-2026 requirements call): their agent never books —
 * it captures interest + preferred time and promises a morning callback — so the email's job is
 * to hand the BDC everything needed to (a) create the lead by hand and (b) make that callback.
 * Field order and labels are the dealer's own, verbatim.
 *
 * Works for BOTH channels: a call renders its transcript, a text renders its thread (channel:'sms',
 * fields carried over from that lead's call — see leadCaptureCH.fetchLeadFieldsByLead). Same layout
 * either way, so the BDC never has to learn a second format.
 *
 * opts: { rooftopName, dept, tz, links, pixelUrl, lead:{
 *   customer, phone, email, zip, vehicle, vehicleType, apptWhen, location,
 *   financing('Yes'|'No'|''), prequalSent(bool), tradeIn('Yes'|'No'|''),
 *   at, intent, summary:[..], actionItems:[..], transcript, recordingUrl, durationSec, endedReason,
 *   channel('call'|'sms'), sms:[{direction,body,status}], smsFailed } }
 */
function renderLeadCapture(opts) {
  opts = opts || {};
  var d = opts.lead || {};
  var L = opts.links || {};
  var url = L.conversations || L.console || "https://console.spyne.ai/converse-ai";
  var tz = opts.tz;
  var when = "";
  try { if (d.at) when = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz || "America/New_York" }).format(new Date(d.at)); } catch (e) { when = ""; }

  var isSms = d.channel === "sms";
  // The assistant's own name, from the call record — never a literal. It's per-rooftop and can even
  // differ between calls on one rooftop, so a hardcoded name eventually tells a dealer their AI is
  // called something it isn't.
  var agent = String(d.agentName || "").trim() || "The AI";
  // Deliberately NOT "the AI didn't ask" — it may have asked and been refused. State the gap, not a
  // cause. leadField already prints "not captured", so the hint is only the instruction.
  var notAsked = "ask on the callback";
  var vehicle = [d.vehicleType, d.vehicle].filter(function (x) { return x && String(x).trim(); }).join(" ").trim();
  var financing = String(d.financing || "").trim();
  // Financing / trade-in: blank means the model saw no mention on the call — a DEFINITE "not
  // discussed", not a missing field, so it reads as an answer rather than a gap to chase.
  var financingTxt = /^y/i.test(financing) ? "Yes" + (d.prequalSent ? " — pre-qualification link texted" : "") : /^n/i.test(financing) ? "No" : "Not discussed";
  var trade = String(d.tradeIn || "");
  var tradeTxt = /^y/i.test(trade) ? "Yes" : /^n/i.test(trade) ? "No" : "Not mentioned";
  var phoneTxt = d.phone ? formatPhone(d.phone) : "";

  var headRow =
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle">' + avatar(d.customer, 40) +
        '<span style="display:inline-block;vertical-align:middle;margin-left:10px;">' +
          '<span style="display:block;font-size:15px;font-weight:800;color:' + INK + ';">' + esc(d.customer || "Caller — name not captured") + "</span>" +
          (phoneTxt ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(phoneTxt) + "</span>" : "") +
        "</span></td>" +
      (when ? '<td align="right" valign="top" style="font-size:11px;color:' + MUTE + ';white-space:nowrap;">' + esc(when) + "</td>" : "") +
    "</tr></table>";

  // The five fields the dealer asked for, in their order, plus the three they also need to build
  // the lead (name/email) and route the vehicle (location).
  var fields =
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">' +
      leadField("Name", d.customer, notAsked) +
      leadField("Phone Number", phoneTxt) +
      leadField("Email", d.email, notAsked) +
      leadField("Zipcode", d.zip, isSms ? "not stated" : "not stated on the call") +
      leadField("Vehicle of Interest", vehicle) +
      // apptWhenNote carries "customer moved this by text — the call said X", so the BDC can't
      // confirm the superseded slot (set by leadCaptureCH.buildSmsLead).
      leadField("Appointment time", d.apptWhen, "no time given", d.apptWhenNote) +
      leadField("Preferred location", d.location) +
      leadField("Financing Option Required", financingTxt) +
      leadField("Trade-in mentioned", tradeTxt) +
    "</table>";

  var banner =
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;background:' + AMBER_BG + ';margin-bottom:14px;"><tr><td style="padding:12px 16px;">' +
      '<div style="font-size:14px;font-weight:800;color:' + AMBER + ';">&#9873; ' + (isSms ? "This lead texted back" : "Call this lead back to confirm") + "</div>" +
      '<div style="font-size:12px;color:' + BODY + ';margin-top:3px;">' +
        (isSms
          ? "The customer replied by text — the thread is below. Details carried over from their call; nothing is booked."
          : esc(agent) + " captured the interest and told the customer someone would call in the morning to confirm the time and location. Nothing is booked.") +
      "</div>" +
    "</td></tr></table>";

  var card =
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;background:' + CARD + ';"><tr><td style="padding:18px 20px;">' +
      headRow +
      (d.intent ? '<div style="margin-top:12px;">' + pill(esc(humanizeIntent(d.intent)), BRAND, "#EDE9FE") + "</div>" : "") +
      fields +
      bulletBlock(isSms ? "What the customer said on the call" : "What the customer said", d.summary, BRAND) +
      (d.actionItems && d.actionItems.length
        ? '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:16px 0 0;">Follow-ups ' + esc(agent) + " logged</div>" +
          actionList(d.actionItems, tz, WARM) +
          // actionList caps at 8 — say so rather than silently dropping the 9th follow-up.
          (d.actionItems.length > 8 ? '<div style="font-size:11px;color:' + FAINT + ';margin-top:4px;">+' + (d.actionItems.length - 8) + " more follow-up" + (d.actionItems.length - 8 === 1 ? "" : "s") + " — open the lead in the dashboard.</div>" : "")
        : "") +
      // On a text email the recording belongs to the lead's earlier CALL — label it, so "customer
      // hangup · 2m 22s" isn't read as something that happened in the text thread.
      (isSms && d.recordingUrl ? '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:16px 0 -4px;">From their call</div>' : "") +
      recordingRow(d.recordingUrl, d.durationSec, d.endedReason) +
      smsThread(d.sms, d.smsFailed, 14) +
      crmBlock([
        ["Name", d.customer], ["Phone Number", phoneTxt], ["Email", d.email], ["Zipcode", d.zip],
        ["Vehicle of Interest", vehicle], ["Appointment time", d.apptWhen], ["Preferred location", d.location],
        ["Financing Option Required", financingTxt], ["Trade-in mentioned", tradeTxt],
        [isSms ? "Texted" : "Called", when],
      ]) +
      transcriptBlock(d.transcript, opts.transcriptCap) +
    "</td></tr></table>" +
    '<div style="margin-top:18px;">' + btnPrimary("Listen & review", url) + "</div>";

  // No-value = nothing a BDC could act on: no vehicle, no time, no zip, no summary, no transcript,
  // no text thread. (A bare "someone texted, contents unknown" email is exactly what the gate is for.)
  var hasValue = !!(vehicle || d.apptWhen || d.zip || (d.summary && d.summary.length) || String(d.transcript || "").trim() || (d.sms && d.sms.length));
  return stampValue(shell(opts, isSms ? "Lead replied by text" : "New lead", esc(d.customer || phoneTxt || "New lead") + (vehicle ? ' <span style="font-weight:700;color:' + MUTE + ';">· ' + esc(vehicle) + "</span>" : ""), banner + card), hasValue);
}

// One stacked action-item row (used by both the new-item and overdue emails).
// `tz` = the dealer's IANA timezone so the due time reads in THEIR local time, not the server's.
function aiRow(it, accent, tz) {
  var due = it.dueAt ? new Date(it.dueAt) : null;
  var dueTxt = "";
  try { if (due && !isNaN(due.getTime())) dueTxt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz || "America/New_York" }).format(due); } catch (e) { dueTxt = ""; }
  // Title prefers a human intent label; falls back to the description when there's no intent
  // (the end-call report's report_actionItems are free-text strings with no intent code).
  var hasIntent = it.intent && humanizeIntent(it.intent);
  var title = hasIntent ? humanizeIntent(it.intent) : (it.description || "Follow-up");
  var sub = hasIntent ? it.description : "";
  var pr = it.priority ? String(it.priority).toLowerCase() : "";
  var prCol = pr === "high" || pr === "urgent" ? NEG : pr === "medium" ? AMBER : MUTE;
  var meta = [
    it.priority ? '<span style="color:' + prCol + ';font-weight:700;">' + esc(String(it.priority)) + " priority</span>" : "",
    dueTxt ? "due " + esc(dueTxt) : "",
    it.conversationTitle ? "from “" + esc(it.conversationTitle) + "”" : "",
  ].filter(Boolean).join(" · ");
  return '<tr><td style="padding:11px 14px;border:1px solid ' + LINE + ';border-left:3px solid ' + (accent || BRAND) + ';border-radius:10px;background:' + CARD + ';">' +
    '<div style="font-size:13px;font-weight:800;color:' + INK + ';line-height:1.4;">' + esc(title) + "</div>" +
    (sub ? '<div style="font-size:12px;color:' + BODY + ';margin-top:3px;">' + esc(sub) + "</div>" : "") +
    (meta ? '<div style="font-size:11px;color:' + MUTE + ';margin-top:5px;">' + meta + "</div>" : "") +
    "</td></tr><tr><td style=\"height:8px;line-height:8px;\">&nbsp;</td></tr>";
}

// Lead context header — avatar + name + phone, then score/sentiment/source chips + vehicle.
function leadHeader(lead) {
  lead = lead || {};
  var chips = "";
  chips += scorePill(lead.aiScore, lead.grade);
  chips += sentimentChip(lead.sentiment, lead.sentimentScore);
  if (lead.stage) chips += pill(esc(lead.stage), VIOLET, "#EDE9FE");
  if (lead.source) chips += pill(esc(lead.source), MUTE, WASH);
  return '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;background:' + WASH + ';"><tr><td style="padding:16px 18px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td valign="middle">' + avatar(lead.customer, 42) +
      '<span style="display:inline-block;vertical-align:middle;margin-left:10px;">' +
        '<span style="display:block;font-size:16px;font-weight:800;color:' + INK + ';">' + esc(lead.customer || "Customer") + "</span>" +
        (lead.phone ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(formatPhone(lead.phone)) + "</span>" : "") +
      "</span></td></tr></table>" +
    (chips ? '<div style="margin-top:12px;">' + chips + "</div>" : "") +
    (lead.vehicle ? '<div style="font-size:12px;color:' + MUTE + ';margin-top:6px;"><b style="color:' + INK + ';">Vehicle of interest:</b> ' + esc(lead.vehicle) + "</div>" : "") +
    (lead.lastSummary ? '<div style="font-size:12px;color:' + BODY + ';line-height:1.6;margin-top:10px;border-top:1px solid ' + LINE + ';padding-top:10px;"><span style="font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:' + MUTE + ';">Last conversation</span><br/>' + esc(lead.lastSummary) + "</div>" : "") +
    "</td></tr></table>";
}

/**
 * Action-item email — LEAD LEVEL. Instead of one email per action item, this surfaces a
 * single customer (lead) with ALL of their open action items grouped together, plus lead
 * context (AI score, sentiment, vehicle, last conversation). One actionable view per person.
 * opts: { rooftopName, dept, tz, links, pixelUrl,
 *   lead:{ customer,phone,vehicle,source,stage, aiScore,grade, sentiment,sentimentScore, lastSummary },
 *   items:[{ intent,description,priority,dueAt,conversationTitle }],
 *   totalOpen, justArrived:int }
 * Back-compat: if `item`/`pending` (old per-item shape) are passed, they're folded into `items`.
 */
function renderActionItem(opts) {
  opts = opts || {};
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  var lead = opts.lead || {};
  // assemble the lead's items (new shape preferred; tolerate the legacy item/pending shape)
  var items = Array.isArray(opts.items) ? opts.items.slice() : [];
  if (!items.length && opts.item) items = [opts.item].concat(Array.isArray(opts.pending) ? opts.pending : []);
  items = items.filter(Boolean);
  var totalOpen = Number(opts.totalOpen) || items.length;
  var justArrived = Number(opts.justArrived) || 0;

  var heading =
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr><td style="padding:11px 16px;border-radius:12px;background:' + AMBER_BG + ';font-size:13px;font-weight:700;color:' + AMBER + ';">' +
    "&#9873; " + fmtInt(totalOpen) + " open action item" + (totalOpen === 1 ? "" : "s") + " for " + esc(lead.customer || "this lead") +
    (justArrived > 0 ? ' &nbsp;·&nbsp; <span style="font-weight:800;">' + fmtInt(justArrived) + " new</span>" : "") +
    "</td></tr></table>";

  var body =
    heading +
    leadHeader(lead) +
    '<div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';margin:18px 0 0;">To do for this customer</div>' +
    actionList(items, opts.tz, BRAND) +
    smsThread(opts.sms, opts.smsFailed) +
    '<div style="margin-top:10px;">' + btnPrimary("Work this lead", url) + "</div>" +
    mtdStrip(opts.mtdOpen, "open action items across all leads", url);

  var title = fmtInt(totalOpen) + " thing" + (totalOpen === 1 ? "" : "s") + " to do for " + esc(lead.customer || "a customer");
  return stampValue(shell(opts, "Action items · by lead", title, body), items.length > 0);
}

// "overdue by" age, from the oldest due date among a lead's items
function overdueAge(dueAt) {
  if (!dueAt) return "";
  var due = new Date(dueAt); if (isNaN(due.getTime())) return "";
  var ms = Date.now() - due.getTime(); if (ms <= 0) return "";
  var h = Math.floor(ms / 3.6e6);
  if (h < 24) return h + "h overdue";
  return Math.floor(h / 24) + "d overdue";
}

/**
 * Overdue / SLA-breach email — LEAD LEVEL. Urgent (red). Groups a customer's overdue items
 * together so the manager sees "who's been waiting too long" at a glance. Recipients (assignee
 * + BDC manager) are chosen by the send logic, not here. opts: { rooftopName, dept, tz, links,
 *   pixelUrl, lead:{customer,phone,vehicle,aiScore,grade,sentiment,stage,source,lastSummary},
 *   items:[{intent,description,priority,dueAt,conversationTitle}], oldestDueAt, totalOverdue } }
 * Back-compat: a bare `overdue:[items]` list is still accepted.
 */
function renderActionItemOverdue(opts) {
  opts = opts || {};
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  var lead = opts.lead || {};
  var items = Array.isArray(opts.items) ? opts.items.slice() : (Array.isArray(opts.overdue) ? opts.overdue.slice() : []);
  var count = items.length;
  var age = overdueAge(opts.oldestDueAt || (items[0] && items[0].dueAt));

  var banner = '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;background:' + NEG_BG + ';margin-bottom:16px;"><tr><td style="padding:12px 16px;font-size:13px;font-weight:800;color:' + NEG + ';">' +
    "&#9888; " + fmtInt(count) + " action item" + (count === 1 ? "" : "s") + " past SLA" + (lead.customer ? " for " + esc(lead.customer) : "") + (age ? " &nbsp;·&nbsp; oldest " + esc(age) : "") + " — resolve now.</td></tr></table>";
  var body = banner +
    (lead.customer ? leadHeader(lead) + '<div style="height:10px;line-height:10px;">&nbsp;</div>' : "") +
    '<table width="100%" cellpadding="0" cellspacing="0">' + items.slice(0, 8).map(function (it) { return aiRow(it, NEG, opts.tz); }).join("") + "</table>" +
    smsThread(opts.sms, opts.smsFailed) +
    '<div style="margin-top:6px;">' + btnPrimary("Resolve now", url) + "</div>";
  var title = lead.customer ? fmtInt(count) + " overdue for " + esc(lead.customer) : fmtInt(count) + " overdue action item" + (count === 1 ? "" : "s");
  return stampValue(shell(opts, "Overdue · by lead", title, body), count > 0);
}

/**
 * New-action-item BATCH email — one email covering MULTIPLE leads' fresh action items for the
 * same rooftop+dept this pass (mirrors renderActionItemBatchSms). Degrades to the IDENTICAL
 * single-lead email when there's exactly one lead (delegates to renderActionItem).
 * opts: { rooftopName, dept, tz, leads:[{customer,phone,vehicle,items,totalOpen,justArrived,
 *   source,stage,aiScore,grade,sentiment,sentimentScore,lastSummary}], mtdOpen, links, detailCap(default 20) }
 */
// Compact one-row-per-lead card for BATCH digests. leadHeader()+actionList() (a full avatar/chips
// header, then a separately-bordered card PER item) is right for a single customer's OWN email —
// repeated 8-20x in one digest it reads as disjointed noise (avatar block, then a line, then a
// boxed card, per lead). This collapses each lead to ONE scannable row: avatar + name + phone on
// one line, an optional status pill on the right, and every item as a single compact text line
// underneath instead of its own bordered box.
function batchLeadCard(ld, tz, rightPillHtml) {
  var items = ld.items || [];
  var lineItems = items.slice(0, 2).map(function (it) {
    var hasIntent = it.intent && humanizeIntent(it.intent);
    var title = hasIntent ? humanizeIntent(it.intent) : (it.description || "Follow-up");
    var pr = it.priority ? " (" + esc(String(it.priority).toLowerCase()) + ")" : "";
    return esc(title) + pr;
  });
  var extra = items.length > 2 ? " +" + (items.length - 2) + " more" : "";
  var firstDue = items.length && items[0].dueAt ? new Date(items[0].dueAt) : null;
  var dueTxt = "";
  try { if (firstDue && !isNaN(firstDue.getTime())) dueTxt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz || "America/New_York" }).format(firstDue); } catch (e) { dueTxt = ""; }
  return '<tr><td style="padding:11px 0;border-bottom:1px solid ' + LINE + ';">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle" style="width:38px;">' + avatar(ld.customer, 32) + '</td>' +
      '<td valign="middle" style="padding-left:10px;">' +
        '<div style="font-size:13px;font-weight:800;color:' + INK + ';">' + esc(ld.customer || "Customer") + "</div>" +
        '<div style="font-size:11px;color:' + MUTE + ';margin-top:1px;">' + esc(formatPhone(ld.phone)) + (ld.vehicle ? " · " + esc(ld.vehicle) : "") + "</div>" +
      "</td>" +
      (rightPillHtml ? '<td align="right" valign="middle">' + rightPillHtml + "</td>" : "") +
    "</tr></table>" +
    '<div style="font-size:12.5px;color:' + BODY + ';margin-top:6px;padding-left:48px;">' + lineItems.join(" · ") + esc(extra) + (dueTxt ? ' <span style="color:' + MUTE + ';">· due ' + esc(dueTxt) + "</span>" : "") + "</div>" +
  "</td></tr>";
}

function renderActionItemBatch(opts) {
  opts = opts || {};
  var leads = (Array.isArray(opts.leads) ? opts.leads : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  if (leads.length <= 1) {
    var only = leads[0] || {};
    return renderActionItem({
      rooftopName: opts.rooftopName, dept: opts.dept, tz: opts.tz, lead: only,
      items: only.items || [], totalOpen: only.totalOpen || (only.items || []).length,
      justArrived: only.justArrived || 0, mtdOpen: opts.mtdOpen, links: L,
    });
  }
  var totalOpen = leads.reduce(function (s, ld) { return s + (Number(ld.totalOpen) || (ld.items || []).length); }, 0);
  var cap = Number(opts.detailCap) || 20;
  var shown = leads.slice(0, cap);
  var hidden = leads.length - shown.length;

  var heading = '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr><td style="padding:11px 16px;border-radius:12px;background:' + AMBER_BG + ';font-size:13px;font-weight:700;color:' + AMBER + ';">' +
    "&#9873; " + fmtInt(totalOpen) + " open action item" + (totalOpen === 1 ? "" : "s") + " across " + fmtInt(leads.length) + " lead" + (leads.length === 1 ? "" : "s") + "</td></tr></table>";

  var cards = '<table width="100%" cellpadding="0" cellspacing="0">' + shown.map(function (ld) {
    var n = Number(ld.totalOpen) || (ld.items || []).length;
    return batchLeadCard(ld, opts.tz, pill(fmtInt(n) + " open", AMBER, AMBER_BG));
  }).join("") + "</table>";

  var moreCard = hidden > 0
    ? '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ' + LINE + ';border-radius:12px;"><tr><td style="padding:14px 16px;font-size:12px;color:' + MUTE + ';text-align:center;">+' + fmtInt(hidden) + " more lead" + (hidden === 1 ? "" : "s") + " with new action items — view the full list in the console.</td></tr></table>"
    : "";

  var body = heading + cards + moreCard +
    '<div style="margin-top:10px;">' + btnPrimary("Work these leads", url) + "</div>" +
    mtdStrip(opts.mtdOpen, "open action items across all leads", url);
  var title = fmtInt(totalOpen) + " thing" + (totalOpen === 1 ? "" : "s") + " to do across " + fmtInt(leads.length) + " leads";
  return stampValue(shell(opts, "Action items · batch", title, body), leads.length > 0);
}

/**
 * Overdue action-item BATCH email — one email covering MULTIPLE leads' SLA breaches for the same
 * rooftop+dept this pass (mirrors renderActionItemOverdueBatchSms). Degrades to the IDENTICAL
 * single-lead email when there's exactly one lead (delegates to renderActionItemOverdue).
 * opts: { rooftopName, dept, tz, leads:[{customer,phone,vehicle,items,oldestDueAt,totalOverdue,
 *   source,stage,aiScore,grade,sentiment,sentimentScore,lastSummary}], links, detailCap(default 20) }
 */
function renderActionItemOverdueBatch(opts) {
  opts = opts || {};
  var leads = (Array.isArray(opts.leads) ? opts.leads : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  if (leads.length <= 1) {
    var only = leads[0] || {};
    return renderActionItemOverdue({
      rooftopName: opts.rooftopName, dept: opts.dept, tz: opts.tz, lead: only,
      items: only.items || [], oldestDueAt: only.oldestDueAt,
      totalOverdue: only.totalOverdue || (only.items || []).length, links: L,
    });
  }
  // Oldest-overdue-first so the cap/truncation always keeps the MOST urgent leads visible.
  var sorted = leads.slice().sort(function (a, b) { return new Date(a.oldestDueAt || 0) - new Date(b.oldestDueAt || 0); });
  var totalItems = sorted.reduce(function (s, ld) { return s + (Number(ld.totalOverdue) || (ld.items || []).length); }, 0);
  var cap = Number(opts.detailCap) || 20;
  var shown = sorted.slice(0, cap);
  var hidden = sorted.length - shown.length;

  // One aggregate "total pending" line, rooftop-wide (not per-lead) — already excludes
  // non-actionable intents (e.g. sales_lost_lead), same as the overdue count above.
  var totalPending = Number(opts.totalPendingAllLeads) || 0;
  var banner = '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;background:' + NEG_BG + ';margin-bottom:16px;"><tr><td style="padding:12px 16px;font-size:13px;font-weight:800;color:' + NEG + ';">' +
    "&#9888; " + fmtInt(totalItems) + " action item" + (totalItems === 1 ? "" : "s") + " past SLA across " + fmtInt(sorted.length) + " lead" + (sorted.length === 1 ? "" : "s") + " — resolve now." +
    (totalPending > 0 ? '<div style="font-size:11.5px;font-weight:600;color:' + BODY + ';margin-top:4px;">' + fmtInt(totalPending) + " total pending action item" + (totalPending === 1 ? "" : "s") + " rooftop-wide</div>" : "") +
    "</td></tr></table>";

  var cards = '<table width="100%" cellpadding="0" cellspacing="0">' + shown.map(function (ld) {
    var age = overdueAge(ld.oldestDueAt);
    return batchLeadCard(ld, opts.tz, age ? pill(esc(age), NEG, NEG_BG) : "");
  }).join("") + "</table>";

  var moreCard = hidden > 0
    ? '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ' + LINE + ';border-radius:12px;"><tr><td style="padding:14px 16px;font-size:12px;color:' + MUTE + ';text-align:center;">+' + fmtInt(hidden) + " more lead" + (hidden === 1 ? "" : "s") + " past SLA — view the full list in the console.</td></tr></table>"
    : "";

  var body = banner + cards + moreCard + '<div style="margin-top:14px;">' + btnPrimary("Resolve now", url) + "</div>";
  var title = fmtInt(totalItems) + " overdue action item" + (totalItems === 1 ? "" : "s") + " across " + fmtInt(sorted.length) + " leads";
  return stampValue(shell(opts, "Overdue · batch", title, body), sorted.length > 0);
}

// ── SMS renderers ────────────────────────────────────────────────────────────
// Plain-text companions to the HTML emails above, for the Twilio SMS channel
// (sendSms.cjs). Same data shapes as the email renderers so the runner can build
// one job and deliver it either way. Kept short (a few segments): who, what to do,
// and a link back to the console. No HTML, no entities — GSM-7-friendly text.

// A concise one-line label for an action item: humanized intent, else its description.
function smsItemLabel(it) {
  it = it || {};
  var base = (it.intent && humanizeIntent(it.intent)) || it.description || "Follow-up";
  var pr = it.priority ? " (" + String(it.priority).toLowerCase() + ")" : "";
  return String(base).replace(/\s+/g, " ").trim() + pr;
}

/**
 * Action-item SMS — "N things to do for <customer>", top items + a link to work the lead.
 * opts: { rooftopName, dept, lead:{customer,vehicle}, items:[{intent,description,priority}],
 *   totalOpen, justArrived, links }
 */
function renderActionItemSms(opts) {
  opts = opts || {};
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  var lead = opts.lead || {};
  var items = (Array.isArray(opts.items) ? opts.items : []).filter(Boolean);
  var totalOpen = Number(opts.totalOpen) || items.length;
  var who = lead.customer || "a customer";
  var lines = [];
  lines.push("Vini" + (opts.rooftopName ? " · " + opts.rooftopName : ""));
  lines.push(totalOpen + " open action item" + (totalOpen === 1 ? "" : "s") + " for " + who +
    (lead.vehicle ? " (" + lead.vehicle + ")" : "") + ":");
  items.slice(0, 3).forEach(function (it) { lines.push("- " + smsItemLabel(it)); });
  if (totalOpen > 3) lines.push("+" + (totalOpen - 3) + " more");
  lines.push("Work this lead: " + url);
  return lines.join("\n");
}

/**
 * Appointment SMS — "Vini booked an appointment", who / when / vehicle + a link.
 * opts: { rooftopName, dept, appointment:{customer,when,vehicle,type,byVini}, links }
 */
function renderPostAppointmentSms(opts) {
  opts = opts || {};
  var L = opts.links || {};
  var url = L.appointment || L.console || "https://console.spyne.ai/converse-ai";
  var a = opts.appointment || {};
  var byVini = a.byVini !== false; // default to the Vini-booked headline
  var who = a.customer || "a customer";
  var lines = [];
  lines.push((byVini ? "Vini booked an appointment" : "New appointment") + (opts.rooftopName ? " · " + opts.rooftopName : ""));
  lines.push(who + (a.type ? " — " + a.type : (opts.dept === "service" ? " — Service" : " — Sales")));
  if (a.when) lines.push(a.when);
  if (a.vehicle) lines.push("Vehicle: " + a.vehicle);
  if (a.intent) lines.push(humanizeIntent(a.intent));
  lines.push("Details: " + url);
  return lines.join("\n");
}

/**
 * Overdue action-item SMS — urgent "past SLA" nudge. Same data shape as renderActionItemOverdue.
 * opts: { rooftopName, lead:{customer,vehicle}, items:[{intent,description,priority}],
 *   oldestDueAt, totalOverdue, links }
 */
function renderActionItemOverdueSms(opts) {
  opts = opts || {};
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  var lead = opts.lead || {};
  var items = (Array.isArray(opts.items) ? opts.items : []).filter(Boolean);
  var count = Number(opts.totalOverdue) || items.length;
  var age = overdueAge(opts.oldestDueAt || (items[0] && items[0].dueAt));
  var who = lead.customer || "a customer";
  var lines = [];
  lines.push("OVERDUE" + (opts.rooftopName ? " · " + opts.rooftopName : ""));
  lines.push(count + " action item" + (count === 1 ? "" : "s") + " past SLA for " + who +
    (age ? " (oldest " + age + ")" : "") + ":");
  items.slice(0, 3).forEach(function (it) { lines.push("- " + smsItemLabel(it)); });
  lines.push("Resolve now: " + url);
  return lines.join("\n");
}

// GSM 03.38 basic + extension character set. A message sends as cheap GSM-7 (~1600 usable chars
// across concatenated segments) ONLY if every character is in this set — one accented name ("José"),
// curly quote, or emoji anywhere in the message forces the WHOLE thing to UCS-2 (~70 chars/segment,
// roughly half the practical budget for the same cost), not just that one character.
var GSM_7BIT_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
var GSM_7BIT_EXT = "^{}\\[~]|€";
function needsUcs2(s) {
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (GSM_7BIT_BASIC.indexOf(ch) === -1 && GSM_7BIT_EXT.indexOf(ch) === -1) return true;
  }
  return false;
}

// Builds a capped, length-bounded multi-lead SMS body. `headerLines` and the trailing CTA/link
// line are NEVER dropped — only the per-lead detail rows shrink under length pressure, and the
// header always states the TRUE total count. So even in the worst case (maxChars forces zero
// detail rows to survive), the recipient still sees "N leads ... +N more — view all: <link>" —
// never a silent undercount. `maxChars` is treated as a GSM-7 budget; if the assembled text (at
// whatever length we're currently trying) contains any non-GSM-7 character, the EFFECTIVE cap for
// that candidate is halved to reflect the real UCS-2 cost — re-checked on every shrink, since
// dropping a line can remove the one character that triggered it.
function assembleBatchSms(headerLines, detailLines, ctaLabel, url, cap, maxChars, totalCount) {
  var baseMax = Number(maxChars) || 1500;
  function build(n) {
    var shown = detailLines.slice(0, n);
    var hidden = totalCount - shown.length;
    var out = headerLines.concat(shown);
    out.push(hidden > 0 ? ("+" + hidden + " more — view all: " + url) : (ctaLabel + ": " + url));
    return out.join("\n");
  }
  function effectiveMax(t) { return needsUcs2(t) ? Math.floor(baseMax / 2) : baseMax; }
  var n = Math.min(Number(cap) || 8, detailLines.length);
  var text = build(n);
  while (text.length > effectiveMax(text) && n > 0) { n -= 1; text = build(n); }
  return text;
}

/**
 * Overdue action-item BATCH SMS — one text covering MULTIPLE leads' SLA breaches for the same
 * rooftop+dept this pass (not per-day; the caller decides which leads are "fresh this pass").
 * Degrades to the IDENTICAL single-lead message when there's exactly one lead (delegates to
 * renderActionItemOverdueSms — guaranteed byte-identical to today, not a separate "1 lead:" path).
 * opts: { rooftopName, dept, leads:[{customer,phone,vehicle,items,oldestDueAt,totalOverdue}],
 *   links, detailCap(default 8), maxChars(default 1500) }
 */
function renderActionItemOverdueBatchSms(opts) {
  opts = opts || {};
  var leads = (Array.isArray(opts.leads) ? opts.leads : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  if (leads.length <= 1) {
    var only = leads[0] || {};
    return renderActionItemOverdueSms({
      rooftopName: opts.rooftopName, dept: opts.dept, lead: only,
      items: only.items || [], oldestDueAt: only.oldestDueAt,
      totalOverdue: only.totalOverdue || (only.items || []).length, links: L,
    });
  }
  // Oldest-overdue-first so the cap/truncation always keeps the MOST urgent leads visible.
  var sorted = leads.slice().sort(function (a, b) { return new Date(a.oldestDueAt || 0) - new Date(b.oldestDueAt || 0); });
  var header = [
    "OVERDUE" + (opts.rooftopName ? " · " + opts.rooftopName : ""),
    leads.length + " leads with action items past SLA:",
  ];
  var lines = sorted.map(function (ld) {
    var age = overdueAge(ld.oldestDueAt);
    var top = smsItemLabel((ld.items && ld.items[0]) || {});
    var phone = formatPhone(ld.phone);
    return "- " + (ld.customer || "Customer") + (phone ? " " + phone : "") + (age ? " · " + age : "") + " · " + top;
  });
  return assembleBatchSms(header, lines, "Resolve now", url,
    Number(opts.detailCap) || 8, Number(opts.maxChars) || 1500, leads.length);
}

/**
 * New-action-item BATCH SMS — one text covering MULTIPLE leads' fresh action items for the same
 * rooftop+dept this pass. Degrades to the IDENTICAL single-lead message when there's exactly one
 * lead (delegates to renderActionItemSms).
 * opts: { rooftopName, dept, leads:[{customer,phone,vehicle,items,totalOpen,justArrived}],
 *   links, detailCap(default 8), maxChars(default 1500) }
 */
function renderActionItemBatchSms(opts) {
  opts = opts || {};
  var leads = (Array.isArray(opts.leads) ? opts.leads : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.actionItems || L.console || "https://console.spyne.ai/converse-ai";
  if (leads.length <= 1) {
    var only = leads[0] || {};
    return renderActionItemSms({
      rooftopName: opts.rooftopName, dept: opts.dept, lead: only,
      items: only.items || [], totalOpen: only.totalOpen || (only.items || []).length,
      justArrived: only.justArrived || 0, links: L,
    });
  }
  var header = [
    "Vini" + (opts.rooftopName ? " · " + opts.rooftopName : ""),
    leads.length + " leads with new action items:",
  ];
  var lines = leads.map(function (ld) {
    var n = ld.totalOpen || (ld.items || []).length;
    var top = smsItemLabel((ld.items && ld.items[0]) || {});
    var phone = formatPhone(ld.phone);
    return "- " + (ld.customer || "Customer") + (phone ? " " + phone : "") + " · " + n + " open · " + top;
  });
  return assembleBatchSms(header, lines, "Work these leads", url,
    Number(opts.detailCap) || 8, Number(opts.maxChars) || 1500, leads.length);
}

/**
 * Post-conversation SMS — one terse line about a call/text + the strongest outcome + a link.
 * opts: { rooftopName, dept, conversation:{customer,channel,direction,summary,intent,
 *   appointmentScheduled,actionItems}, links }
 */
function renderPostConversationSms(opts) {
  opts = opts || {};
  var c = opts.conversation || {};
  var L = opts.links || {};
  var url = L.conversations || L.console || "https://console.spyne.ai/converse-ai";
  var isSms = c.channel === "sms";
  var who = c.customer || "a customer";
  var dir = c.direction === "outbound" ? "Outbound" : "Inbound";
  var summary = String(c.summary || "").replace(/^\[\s*"?|"?\s*\]$/g, "").replace(/^"|"$/g, "").replace(/\s+/g, " ").trim();
  var lines = [];
  lines.push("Vini" + (opts.rooftopName ? " · " + opts.rooftopName : ""));
  lines.push((isSms ? "Text" : "Call") + " · " + dir + " with " + who +
    (c.intent ? " — " + humanizeIntent(c.intent) : ""));
  // Lead with the strongest outcome; else a short summary snippet.
  if (c.appointmentScheduled) lines.push("→ Appointment booked");
  else if (c.actionItems && c.actionItems.length) lines.push("→ " + c.actionItems.length + " action item" + (c.actionItems.length === 1 ? "" : "s"));
  if (summary) lines.push(summary.length > 140 ? summary.slice(0, 137) + "…" : summary);
  lines.push((isSms ? "Open thread: " : "Review: ") + url);
  return lines.join("\n");
}

/**
 * Post-conversation BATCH SMS — one text covering MULTIPLE leads' calls/texts for the same
 * rooftop+dept this pass. Degrades to the IDENTICAL single-lead message when there's exactly one
 * conversation (delegates to renderPostConversationSms). This is the highest-volume/highest-risk
 * spot for the batch — the default 'daily' SMS cadence fires every replying lead's digest in the
 * SAME end-of-day pass, so an active rooftop's whole day of SMS replies otherwise lands as N
 * separate texts back-to-back.
 * opts: { rooftopName, dept, conversations:[<same shape renderPostConversationSms takes>],
 *   links, detailCap(default 8), maxChars(default 1500) }
 */
function renderPostConversationBatchSms(opts) {
  opts = opts || {};
  var convos = (Array.isArray(opts.conversations) ? opts.conversations : []).filter(Boolean);
  var L = opts.links || {};
  var url = L.conversations || L.console || "https://console.spyne.ai/converse-ai";
  if (convos.length <= 1) {
    return renderPostConversationSms({ rooftopName: opts.rooftopName, dept: opts.dept, conversation: convos[0] || {}, links: L });
  }
  var isSmsBatch = convos.every(function (c) { return c.channel === "sms"; });
  var header = [
    "Vini" + (opts.rooftopName ? " · " + opts.rooftopName : ""),
    convos.length + " " + (isSmsBatch ? "SMS conversations" : "calls") + " today:",
  ];
  var lines = convos.map(function (c) {
    var o = classifyOutcome(c);
    var label = o.text.replace(/&#\d+;\s*/, "");
    return "- " + (c.customer || "Customer") + " " + formatPhone(c.phone) + " · " + label;
  });
  return assembleBatchSms(header, lines, "View all", url, Number(opts.detailCap) || 8, Number(opts.maxChars) || 1500, convos.length);
}

/**
 * Digest SMS — terse headline summary of the daily/weekly/monthly report + a link. The full
 * report stays in the email; SMS is the at-a-glance nudge.
 * opts: { cadence:'daily'|'weekly'|'monthly', rooftopName, dept, metrics, link }
 * metrics uses the digest `m` field names (appointmentsYesterday, conversationsReached,
 * qualifiedLeads, actionItemsTotal).
 */
function renderDigestSms(opts) {
  opts = opts || {};
  var m = opts.metrics || {};
  var url = opts.link || "https://console.spyne.ai/converse-ai/reports";
  var cad = opts.cadence === "weekly" ? "Weekly" : opts.cadence === "monthly" ? "Monthly" : "Daily";
  var num = function (v) { return fmtInt(Number(v) || 0); };
  var n = function (v) { return Number(v) || 0; };
  // Uses the canonical Vini wordings; pulls the funnel from the same `m` the email reads.
  var conv = m.conversationsReached != null ? m.conversationsReached : m.conversationsHandled;
  var qual = n(m.qualifiedLeads);
  var qualPct = (m.qualifiedPct != null && !isNaN(Number(m.qualifiedPct))) ? " (" + Math.round(Number(m.qualifiedPct)) + "%)" : "";
  var appts = n(m.appointmentsYesterday);
  var apptsMtd = n(m.appointmentsYesterdayMTD);
  var lines = [];
  lines.push((opts.rooftopName || "Vini") + " — " + cad + " Vini report");
  lines.push("");
  // Inbound + outbound reach on one line when we have both.
  var reach = [];
  if (m.inboundUniqueLeads != null) reach.push(num(m.inboundUniqueLeads) + " reached");
  if (m.outboundUniqueReached != null) reach.push(num(m.outboundUniqueReached) + " OB reached");
  if (reach.length) lines.push("Leads: " + reach.join(" · "));
  lines.push("Real conversations: " + num(conv));
  lines.push("Qualified leads: " + num(qual) + qualPct);
  lines.push("Appointments (AI-booked): " + num(appts) + (apptsMtd ? " · " + num(apptsMtd) + " MTD" : ""));
  if (m.warmTransfers != null) lines.push("Hand-offs to team: " + num(m.warmTransfers));
  lines.push("Open action items: " + num(m.actionItemsTotal));
  lines.push("");
  lines.push("Full report: " + url);
  return lines.join("\n");
}

module.exports = {
  renderPostAppointment: renderPostAppointment,
  renderPostConversation: renderPostConversation,
  renderActionItem: renderActionItem,
  renderActionItemOverdue: renderActionItemOverdue,
  renderActionItemSms: renderActionItemSms,
  renderPostAppointmentSms: renderPostAppointmentSms,
  renderActionItemOverdueSms: renderActionItemOverdueSms,
  renderPostConversationSms: renderPostConversationSms,
  renderDigestSms: renderDigestSms,
  renderActionItemOverdueBatchSms: renderActionItemOverdueBatchSms,
  renderActionItemBatchSms: renderActionItemBatchSms,
  renderActionItemBatch: renderActionItemBatch,
  renderActionItemOverdueBatch: renderActionItemOverdueBatch,
  renderPostConversationBatch: renderPostConversationBatch,
  renderPostConversationBatchSms: renderPostConversationBatchSms,
  renderLeadCapture: renderLeadCapture,
  formatPhone: formatPhone,
  _shell: shell,
};
