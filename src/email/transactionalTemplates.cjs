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

// SMS thread preview — last few bubbles + delivery health
function smsThread(messages, failedCount) {
  var msgs = Array.isArray(messages) ? messages.slice(-4) : [];
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

// OUTCOME banner — the single "what do I do about this?" answer, shown first.
// Priority: booked > transferred > needs-follow-up > resolved > voicemail/no-answer > logged.
function outcomeBanner(c) {
  var box = function (col, bg, text, sub) {
    return '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;background:' + bg + ';margin-bottom:14px;"><tr><td style="padding:12px 16px;">' +
      '<div style="font-size:14px;font-weight:800;color:' + col + ';">' + text + "</div>" +
      (sub ? '<div style="font-size:12px;color:' + BODY + ';margin-top:3px;">' + sub + "</div>" : "") + "</td></tr></table>";
  };
  if (c.appointmentScheduled) return box(GREEN_BIG, POS_BG, "&#128197; Booked an appointment", "Vini set this up — confirm staffing & prep.");
  if (c.transfer && (c.transfer.department || c.transfer.reason)) return box(VIOLET, "#EDE9FE", "&#128222; Handed to your team", "Transferred to " + esc(c.transfer.department || "your team") + (c.transfer.reason ? " — " + esc(c.transfer.reason) : ""));
  if ((c.actionItems && c.actionItems.length) || c.hasActionItem) return box(AMBER, AMBER_BG, "&#9873; Needs human follow-up", (c.actionItems && c.actionItems.length ? fmtInt(c.actionItems.length) + " action item" + (c.actionItems.length === 1 ? "" : "s") + " below." : "Vini flagged a to-do below."));
  if (c.callbackScheduled) return box(AMBER, AMBER_BG, "&#8635; Callback scheduled", "Vini promised a call back — make sure it happens.");
  if (c.queryResolved) return box(GREEN_BIG, POS_BG, "&#10003; Resolved — no action needed", "Vini handled this end to end.");
  var er = String(c.endedReason || "").toLowerCase();
  if (er.indexOf("voicemail") >= 0) return box(MUTE, SLATE_BG, "&#9993; Left a voicemail", "No live contact — Vini will keep trying per cadence.");
  if (er.indexOf("no-answer") >= 0 || er.indexOf("no_answer") >= 0 || er.indexOf("hangup") >= 0) return box(MUTE, SLATE_BG, "No live conversation", "Call ended early — nothing to action.");
  return box(MUTE, SLATE_BG, "Conversation logged", "");
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
          (c.phone ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(c.phone) + "</span>" : "") +
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
        (lead.phone ? '<span style="display:block;font-size:12px;color:' + MUTE + ';margin-top:1px;">' + esc(lead.phone) + "</span>" : "") +
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
  var appts = Number(m.appointmentsYesterday) || 0;
  var conv = Number(m.conversationsReached != null ? m.conversationsReached : m.conversationsHandled) || 0;
  var qual = Number(m.qualifiedLeads) || 0;
  var open = Number(m.actionItemsTotal) || 0;
  var parts = [
    appts + " appt" + (appts === 1 ? "" : "s"),
    conv + " conversation" + (conv === 1 ? "" : "s"),
    qual + " qualified",
    open + " open action item" + (open === 1 ? "" : "s"),
  ];
  var head = (opts.rooftopName ? opts.rooftopName + " · " : "Vini · ") + cad + " report";
  return head + ":\n" + parts.join(" · ") + "\n" + url;
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
  _shell: shell,
};
