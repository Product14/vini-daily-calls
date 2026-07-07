/* eslint-disable */
// ============================================================================
// SHARED DAILY-DIGEST EMAIL TEMPLATE  ·  Conversational AI 2.0  (Figma 9372-1862)
// ----------------------------------------------------------------------------
// ONE source of truth for the digest HTML, consumed by BOTH renderers:
//   • src/email/renderDigest.ts   (SPA preview + manual "send now")
//   • server/roi-cron/runner.cjs   (the hourly cron send)
// Plain CommonJS + pure string building so it bundles into the browser via Vite
// AND runs under node require.
//
// FINAL DESIGN — matches the Figma target + the agreed product spec:
//   · Centered spyne logo + gradient "Sales/Service Performance Report" title.
//   · HERO — scenic photo + white panel: one big GREEN headline metric (via the
//     shared fallback ladder so we never lead with a scary "0"), a data-driven
//     "what happened + so what + hope" line, and estimated pipeline influenced.
//   · A logic-driven UPSELL banner sits prominently right under the KPIs when the
//     rooftop's agent deployment + lead volume qualify; otherwise we fall back to
//     the always-on speed-to-lead CTA woven mid-email (Figma position).
//   · KPI row — 4 clean cards (Total leads · Calls handled · Qualified · Booking).
//   · Sections: Upcoming appointments · Action items · Top vehicles · INBOUND
//     activity (big metric + agent device card + channel + calling hours +
//     resolution callout) · OUTBOUND activity (reach/connect/appts + outcomes +
//     handle-rate callout) · Top campaign.
//   · Customer-backward + edge-safe: every section has an explicit empty-state and
//     omits itself when it has no data. No phone-mockup headshots — a brand-styled
//     "device card" carries the agent without fabricating a face.
// ============================================================================

// ── palette ──────────────────────────────────────────────────────────────────
var BRAND = "#4600F2", BRAND2 = "#A21CAF", VIOLET = "#6D28D9";
var INK = "#0F172A", BODY = "#334155", MUTE = "#64748B", FAINT = "#94A3B8";
var LINE = "#E6E8EC", CARD = "#FFFFFF", WASH = "#F8FAFC", PAGE = "#EEF1F6";
var POS = "#16A34A", POS_BG = "#DCFCE7", NEG = "#DC2626", NEG_BG = "#FEE2E2", WARM = "#D97706", WARM_BG = "#FEF3C7";
var GREEN_BIG = "#15803D";
var C_CALL = "#6366F1", C_SMS = "#F59E0B", C_CHAT = "#7C3AED";
var DONUT = ["#6366F1", "#813FED", "#10B981", "#F59E0B", "#0EA5E9", "#EC4899", "#94A3B8", "#14B8A6"];
var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ── utils ──────────────────────────────────────────────────────────────────
function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function num(v) { var x = typeof v === "number" ? v : parseFloat(String(v)); return Number.isFinite(x) ? x : 0; }
function arr(v) { return Array.isArray(v) ? v : []; }
function fmtInt(v) { return Math.round(num(v)).toLocaleString("en-US"); }
function money(v) { var x = num(v); if (x >= 1e6) return "$" + (x / 1e6).toFixed(x >= 1e7 ? 0 : 1) + "M"; if (x >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K"; return "$" + Math.round(x).toLocaleString("en-US"); }
function initial(name) { var s = String(name || "").trim(); return (s ? s[0] : "A").toUpperCase(); }
function plural(n, one, many) { return num(n) === 1 ? one : (many || one + "s"); }
function joinAnd(a) { return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
// canonical rate display — never headline a rounded "0%". When the rounded percent would read 0%
// (a real-but-small rate) surface the raw fraction ("1/32") instead. Turn/Close rates use this.
function rateFrac(numr, den) {
  var nn = num(numr), dd = num(den);
  if (!dd) return "—";
  var r = Math.round((nn / dd) * 100);
  return (nn > 0 && r === 0) ? nn + "/" + dd : r + "%";
}

// signed "▲27% vs prior" chip
function deltaChip(pct, opts) {
  opts = opts || {};
  if (pct == null || pct === "" || (typeof pct === "number" && !Number.isFinite(pct))) return "";
  var p = num(pct); if (p === 0 && opts.hideZero) return "";
  var flat = p === 0, up = p > 0;
  var color = flat ? MUTE : up ? POS : NEG, bg = flat ? "#EEF2F7" : up ? POS_BG : NEG_BG, glyph = flat ? "•" : up ? "▲" : "▼";
  var tail = opts.tail == null ? " vs prior" : opts.tail;
  return '<span style="display:inline-block;font-size:11px;font-weight:700;color:' + color + ";background:" + bg +
    ';border-radius:9999px;padding:3px 9px;white-space:nowrap;">' + glyph + " " + Math.abs(p) + "%" +
    (tail ? '<span style="font-weight:500;opacity:.8;">' + esc(tail) + "</span>" : "") + "</span>";
}

// stacked channel bar + legend
function channelBar(call, sms, chat) {
  var cc = num(call), ss = num(sms), hh = num(chat), t = cc + ss + hh || 1, p = function (x) { return (x / t) * 100 + "%"; };
  var seg = function (v, c) { return v > 0 ? '<td style="width:' + p(v) + ";background:" + c + ';font-size:0;line-height:0;">&nbsp;</td>' : ""; };
  var dot = function (c, l, v) { return '<span style="display:inline-block;margin-right:18px;font-size:12px;color:' + BODY + ';"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + c + ';margin-right:6px;"></span>' + esc(l) + ' <span style="color:' + MUTE + ';font-weight:700;">' + fmtInt(v) + "</span></span>"; };
  return '<table width="100%" cellpadding="0" cellspacing="0" style="height:10px;border-radius:9999px;overflow:hidden;margin-top:12px;background:#EEF2F7;"><tr>' + seg(cc, C_CALL) + seg(ss, C_SMS) + seg(hh, C_CHAT) + "</tr></table>" +
    '<div style="margin-top:12px;">' + dot(C_CALL, "Call", cc) + dot(C_SMS, "SMS", ss) + dot(C_CHAT, "Chat", hh) + "</div>";
}

// one horizontal labelled bar (outbound outcomes / funnel)
function barRow(label, value, maxVal, color) {
  var w = maxVal > 0 ? Math.max(2, Math.round((num(value) / maxVal) * 100)) : 0;
  return '<tr><td style="padding:6px 0;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="40%" style="font-size:12px;color:' + BODY + ';padding-right:12px;">' + esc(label) + "</td>" +
    '<td><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="background:#EEF2F7;border-radius:6px;"><table cellpadding="0" cellspacing="0" style="width:' + w + '%;min-width:6px;"><tr><td style="height:11px;background:' + color + ';border-radius:6px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td>' +
    '<td width="40" align="right" style="font-size:12px;font-weight:700;color:' + INK + ';padding-left:10px;">' + fmtInt(value) + "</td>" +
    "</tr></table></td></tr></table></td></tr>";
}

// Bordered white container for a section body — gives every subheading's content a consistent card
// (feedback #1). The eyebrow heading sits ABOVE it, matching the fleet-scorecard reference.
function panel(inner, pad) { return '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;background:' + CARD + ';"><tr><td style="padding:' + (pad || "18px 20px") + ';">' + inner + "</td></tr></table>"; }

function eyebrow(title, href, linkLabel) {
  var right = href ? '<td align="right" valign="bottom"><a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="font-size:11px;font-weight:700;color:' + BRAND + ';text-decoration:none;">' + esc(linkLabel || "View more") + ' &nbsp;&#8599;</a></td>' : "";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;"><tr>' +
    '<td style="font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:' + MUTE + ';">' + esc(title) + "</td>" + right + "</tr></table>";
}
function btnPrimary(label, href) { return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:' + VIOLET + ';color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 22px;border-radius:10px;">' + esc(label) + " &nbsp;&#8599;</a>"; }
// Compact primary button — used in the hero so the CTA never crowds the headline metric on narrow
// widths (feedback #2); on mobile the hero row stacks it below via the .hero-cta rule.
function btnPrimarySm(label, href) { return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:' + VIOLET + ';color:#fff;text-decoration:none;font-size:12px;font-weight:700;padding:9px 15px;border-radius:9px;white-space:nowrap;">' + esc(label) + " &nbsp;&#8599;</a>"; }
function btnLight(label, href) { return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#fff;color:' + BRAND + ';text-decoration:none;font-size:13px;font-weight:800;padding:11px 18px;border-radius:10px;">' + esc(label) + " &nbsp;&#8599;</a>"; }

// clean KPI card (Figma glance tier) — label · big number (+unit) · delta · sub
function kpiCard(label, big, unit, deltaPct, sub) {
  // Suppress the "vs prior" chip on a zero metric — a delta off zero is noise (Jul-2026 feedback #3).
  var isZero = num(String(big).replace(/[^0-9.\-]/g, "")) === 0;
  var showDelta = !isZero && deltaPct != null && deltaPct !== "";
  return '<td class="col" width="25%" valign="top" style="padding:6px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;background:' + CARD + ';"><tr><td style="padding:16px 16px;">' +
    '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:800;">' + esc(label) + "</div>" +
    '<div style="margin-top:9px;line-height:1;"><span style="font-size:26px;font-weight:900;color:' + INK + ';">' + esc(big) + "</span>" + (unit ? ' <span style="font-size:11px;color:' + MUTE + ';font-weight:700;">' + esc(unit) + "</span>" : "") + "</div>" +
    (showDelta ? '<div style="margin-top:11px;">' + deltaChip(deltaPct, { tail: " vs prior" }) + "</div>" : (sub ? '<div style="font-size:11px;color:' + MUTE + ';margin-top:11px;">' + esc(sub) + "</div>" : "")) +
    "</td></tr></table></td>";
}

// one inline "secondary metric" (used in the inbound/outbound big-number rows)
function miniMetric(label, value, deltaPct, w) {
  // Same zero-value rule as kpiCard — no "vs prior" chip when the number itself is 0 (feedback #3).
  var isZero = num(String(value).replace(/[^0-9.\-]/g, "")) === 0;
  var showDelta = !isZero && deltaPct != null && deltaPct !== "";
  return '<td class="col" width="' + (w || "33%") + '" valign="top" style="padding-right:14px;">' +
    '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">' + esc(label) + "</div>" +
    '<div style="margin-top:6px;line-height:1.1;"><span style="font-size:20px;font-weight:800;color:' + INK + ';">' + esc(value) + "</span></div>" +
    (showDelta ? '<div style="margin-top:6px;">' + deltaChip(deltaPct, { tail: "" }) + "</div>" : "") +
    "</td>";
}

// brand "agent card" — a clean, on-brand panel that carries the AI agent
// without a fabricated headshot or gimmicky phone frame. Matches the email's
// card language: bordered, branded header strip, gradient-initial avatar.
function deviceCard(person, role, statusLabel, responseLabel) {
  return '<td class="col device" width="168" valign="top" style="padding-left:8px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:16px;background:' + CARD + ';overflow:hidden;">' +
    // header strip: brand wordmark + live status
    '<tr><td style="padding:11px 14px;background:' + BRAND + ';background:linear-gradient(120deg,' + BRAND + ' 0%,' + BRAND2 + ' 130%);">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-size:11px;font-weight:900;letter-spacing:.16em;color:#fff;">VINI</td>' +
    '<td align="right"><span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:.05em;color:#fff;background:rgba(255,255,255,.18);border-radius:9999px;padding:3px 9px;"><span style="color:#86EFAC;">&#9679;</span> ' + esc(statusLabel || "LIVE") + "</span></td>" +
    "</tr></table></td></tr>" +
    // body: avatar · name · role
    '<tr><td align="center" style="padding:18px 14px 16px;">' +
    '<table cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td align="center" valign="middle" style="width:58px;height:58px;border-radius:50%;background:' + BRAND + ';background:linear-gradient(135deg,' + BRAND + ' 0%,' + BRAND2 + ' 100%);">' +
    '<span style="font-size:24px;font-weight:800;color:#fff;line-height:58px;">' + esc(initial(person)) + "</span></td></tr></table>" +
    '<div style="font-size:16px;font-weight:800;color:' + INK + ';margin-top:12px;">' + esc(person || "Vini") + "</div>" +
    '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;margin-top:4px;">' + esc(role || "AI Agent") + "</div>" +
    "</td></tr>" +
    // footer: avg response time (only when provided)
    (responseLabel ? '<tr><td style="border-top:1px solid ' + LINE + ';background:' + WASH + ';padding:11px 14px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Avg response</td>' +
      '<td align="right" style="font-size:14px;font-weight:800;color:' + POS + ';">' + esc(responseLabel) + "</td>" +
      "</tr></table></td></tr>" : "") +
    "</table></td>";
}

// soft callout box (resolution / AI-handle narrative). scheme: 'rose' | 'lavender'
function calloutBox(icon, title, bodyHtml, scheme) {
  var bg = scheme === "lavender"
    ? "background:#F5F3FF;background:linear-gradient(110deg,#F5F3FF 0%,#FDF2F8 100%);"
    : "background:#FFF1F2;background:linear-gradient(110deg,#FFF1F2 0%,#FDF4FF 100%);";
  var accent = scheme === "lavender" ? BRAND : "#E11D48";
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border:1px solid ' + (scheme === "lavender" ? "#E9E2FF" : "#FBD8DF") + ';border-radius:14px;' + bg + '"><tr><td style="padding:16px 18px;">' +
    '<div style="font-size:12px;font-weight:800;color:' + accent + ';">' + esc(icon) + " " + esc(title) + "</div>" +
    '<div style="font-size:13px;line-height:1.65;color:' + BODY + ';margin-top:7px;">' + bodyHtml + "</div>" +
    "</td></tr></table>";
}

// Canonical, human labels for the action-item / intent keys actually emitted in production
// (dealer_leads.actionItems.intent). Keys are matched case- and separator-insensitively
// (normKey strips everything but a-z), so "request_callback", "requestCallback", "REQUEST_CALLBACK"
// all map to one label — the raw taxonomy is inconsistent across agents.
var INTENT_LABELS = {
  // — generic —
  smstakeover: "SMS takeover requested", requestcallback: "Callback requests", callbackrequest: "Callback requests",
  apptconfirmed: "Appointments confirmed", failedbooking: "Failed bookings to review", custom: "Other action items", other: "Other action items",
  specificsalesperson: "Asked for a salesperson", askstaffmember: "Asked for a staff member", compliancealert: "Compliance alerts", askdealerlocation: "Location / hours questions",
  // — sales —
  checkvehicleavailability: "Vehicle availability", checkvehicleprice: "Pricing questions", inquiretradeinvalue: "Trade-in value",
  inquirefinancestatus: "Financing questions", salesconnecttofinance: "Finance hand-offs", scheduletestdrive: "Test-drive requests",
  scheduleappointment: "Appointments to schedule", salesscheduleshowroomvisit: "Showroom visits to schedule",
  salessendvehicleinfo: "Vehicle info to send", salesfollowupwithquote: "Quotes to follow up", saleslostlead: "Lost leads to review", salesescalatetomanager: "Manager escalations",
  // — service —
  servicescheduleappointment: "Service appointments to schedule", servicerecallfollowup: "Recall follow-ups", recallresponse: "Recall responses",
  servicestatusupdate: "Repair-status updates", pendingstatusupdate: "Pending repair-order status", serviceescalatetoadvisor: "Advisor escalations",
  servicesendestimate: "Estimates to send", servicepartscallback: "Parts callbacks", serviceloanerarrangement: "Loaner arrangements", noshow: "No-shows",
};
function normKey(k) { return String(k || "").toLowerCase().replace(/[^a-z]/g, ""); }
function humanize(k) { return INTENT_LABELS[normKey(k)] || String(k || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }); }

// ── primary-metric fallback ladder (Hero + Inbound) ──────────────────────────
//   1 Appointments today → 2 Leads warmed yesterday → 3 Qualified leads
// (We surface appointments whenever there are any; only on a true zero day do we
//  fall to warmed → qualified so we never lead with a scary "0".)
function primaryMetric(m, leads, pn) {
  pn = pn || "yesterday";
  var appts = num(m.appointmentsYesterday);
  if (appts > 0) return { n: appts, label: "Appointments — AI-booked", mode: "appts" };
  var warm = num(m.warmLeads) || leads;
  if (warm > 0) return { n: warm, label: "Leads warmed " + pn, mode: "warm" };
  return { n: num(m.qualifiedLeads), label: "Qualified leads", mode: "qual" };
}

// data-driven commentary — always an interpretation (what · so-what · hope)
function buildCommentary(m, mode, pn) {
  pn = pn || "yesterday";
  if (m && typeof m.commentary === "string" && m.commentary.trim()) return m.commentary.trim();
  var d = (m && m.deltas) || {};
  var leadsD = num(d.leadsAttempted), apptD = num(d.appointments), abrD = num(d.abr), qualD = num(d.leadsQualified);
  var leads = num(m.totalLeads != null ? m.totalLeads : m.inboundUniqueLeads), appts = num(m.appointmentsYesterday);
  var pct = function (v) { return (v > 0 ? "+" : "") + v + "%"; };
  if (leads === 0 && appts === 0) return "Quiet day — no new lead activity captured. Agents stayed live and ready for inbound.";
  if (mode === "warm" || mode === "qual") return "No appointments booked " + pn + ", but " + fmtInt(num(m.warmLeads) || leads) + " leads were warmed and kept moving (" + pct(leadsD) + " vs prior). The pipeline is alive — the gap is in closing, not volume.";
  if (leadsD > 5 && abrD < -5) return "Lead volume grew strongly (" + pct(leadsD) + "), but booking rate slipped " + Math.abs(abrD) + "% versus the prior period. Volume is healthy — the gap is in closing.";
  if (apptD > 5) return "Strong day — appointments up " + pct(apptD) + " vs prior on " + fmtInt(leads) + " leads worked. Momentum is building.";
  if (apptD < -5) return "Appointments dipped " + pct(apptD) + " vs prior. " + fmtInt(leads) + " " + plural(leads, "lead was", "leads were") + " still engaged" + (qualD > 0 ? " and qualification held up" : "") + " — focus follow-ups to recover the booking rate.";
  return fmtInt(appts) + " " + plural(appts, "appointment", "appointments") + " booked off " + fmtInt(leads) + " " + plural(leads, "lead", "leads") + " worked — holding steady versus the prior period.";
}

// ── logic-driven upsell (spec §7) ────────────────────────────────────────────
// Picks at most one upsell from the rooftop's agent deployment state + lead
// volume. Returns null when nothing qualifies (→ speed-to-lead CTA fallback).
//   deployment: { phone: 'after_hours'|'after_hours_overflow'|'24x7'|null,
//                 smartview: bool, stl: bool }
function pickUpsell(opts, m, dept, leadsPerDay) {
  if (opts.upsell === false) return null;          // explicit opt-out
  if (opts.upsell && typeof opts.upsell === "object") return opts.upsell; // explicit override
  var dep = opts.deployment || m.deployment;
  if (!dep || typeof dep !== "object") return null;
  var threshold = num(opts.upsellLeadThreshold) || 15;
  var low = leadsPerDay > 0 && leadsPerDay < threshold;
  var phone = dep.phone;
  if (phone === "after_hours" && low)
    return { eyebrow: "Unlock more coverage", title: "Your agent only answers after-hours", body: "You captured <b>" + fmtInt(leadsPerDay) + " leads/day</b> on after-hours alone. Turn on overflow + 24×7 so no inbound ever rings out — daytime spikes included.", cta: "Activate overflow + 24×7" };
  if (dept === "sales" && phone === "after_hours_overflow" && low && !dep.stl)
    return { eyebrow: "Reach further", title: "Work your marketplace leads automatically", body: "Phone coverage is fully deployed. <b>STL</b> engages your AutoTrader & Cars.com leads the second they land — before a human can.", cta: "Activate STL · marketplace leads" };
  return null;
}

// ============================================================================
// renderDigestHtml(metrics, opts)
//   opts: { rooftopName, dept, dateLabel, agentPerson, links:{...},
//           appointments:[...], topVehicles:[...], dollarRate, pixelUrl,
//           assetBase:"" , campaignImages:[urls],
//           deployment:{phone,smartview,stl}, upsell?, upsellLeadThreshold }
// ============================================================================
function renderDigestHtml(metrics, opts) {
  var m = metrics || {}; opts = opts || {};
  var dept = opts.dept === "service" ? "service" : "sales";
  var Dept = dept === "service" ? "Service" : "Sales";
  var person = esc(opts.agentPerson || m.agentPerson || (dept === "service" ? "Mia" : "Emily"));
  var L = opts.links || {}, consoleUrl = L.console || "https://console.spyne.ai/converse-ai";
  var d = m.deltas || {};
  var assetBase = (opts.assetBase || "").replace(/\/$/, "");
  var asset = function (p) { return assetBase + p; };

  // ── figures ────────────────────────────────────────────────────────────────
  // (bookingRate / hasAppts / est-pipeline figures dropped — booking-rate card + commentary +
  //  est-pipeline line were removed in the Jun-2026 review.)
  var leads = num(m.totalLeads != null ? m.totalLeads : m.inboundUniqueLeads);
  var qualified = num(m.qualifiedLeads != null ? m.qualifiedLeads : m.qualifiedLeadsYesterday);
  var callsHandled = num(m.callsHandled != null ? m.callsHandled : m.conversationsCall);
  var convHandled = num(m.conversationsHandled) || callsHandled;
  var dollarRate = num(opts.dollarRate != null ? opts.dollarRate : m.dollarRate);
  var apptMTD = num(m.appointmentsYesterdayMTD), leadsMTD = num(m.inboundUniqueLeadsMTD);

  // Period-aware wording: daily → "yesterday", weekly → "this week", monthly → "this month".
  var period = opts.period === "weekly" || opts.period === "monthly" ? opts.period : "daily";
  var pn = period === "weekly" ? "this week" : period === "monthly" ? "this month" : "yesterday";
  var nextReport = period === "weekly" ? "next Monday · 7:00 AM" : period === "monthly" ? "1st of next month · 7:00 AM" : "tomorrow · 7:00 AM";
  var primary = primaryMetric(m, leads, pn);

  // ── FOCUS — stable per-rooftop content strategy (set by digest_focus / the resolver, threaded via
  // opts.focus). 'appointment' (default; the top closers) leads with appointments. 'conversation' (the
  // ~90% of rooftops, whose offering rarely books a daily appointment) leads with conversations handled
  // and demotes appointments to a down-funnel widget shown only when there are any. SAME design — only
  // the hero metric, the KPI order and the section order change; appointment-focus is byte-identical.
  var focus = opts.focus === "conversation" ? "conversation" : "appointment";
  // canonical "Real conversations" = deduped CONNECTED leads (voicemail excluded), matching the console —
  // NOT conversationsHandled (raw call+SMS activity, which over-counts). Prefer conversationsReached;
  // fall back to the IB+OB reached sum, then (last resort) raw handled / calls so the hero never blanks.
  var convHero = num(m.conversationsReached) || (num(m.conversationsInbound) + num(m.outboundUniqueReached)) || num(m.conversationsHandled) || callsHandled;
  var convHeroMTD = num(m.conversationsReachedMTD) || num(m.conversationsHandledMTD);
  var apptsAny = num(m.appointmentsYesterday);

  // ── HERO (scenic photo bg + white inner panel) ──────────────────────────────
  var heroBg = "background:" + BRAND + ";background:" + BRAND + " url('" + asset("/digest-assets/hero.jpg") + "') center/cover no-repeat;";
  var heroNum = focus === "conversation" ? convHero : primary.n;
  var heroLabel = focus === "conversation" ? "Real conversations " + pn : primary.label;
  var heroBtn = focus === "conversation"
    ? btnPrimarySm("View conversations", L.conversations || consoleUrl)
    : btnPrimarySm("View appointments", L.appointments || consoleUrl);
  // MTD pop-out. appointment-focus → appts this month. conversation-focus → conversations this month
  // (falls back to leads worked), with any appointments shown as a small, demoted secondary so the
  // booking still surfaces without being the headline.
  var heroMTD;
  if (focus === "conversation") {
    var cm = convHeroMTD || leadsMTD;
    // canonical: always carry the month's booking win — even on a 0-appointment day surface
    // "N booked this month" (apptMTD) so a dry day still shows the month is producing.
    var bookedNote = apptMTD > 0 ? fmtInt(apptMTD) + " booked this month" : (apptsAny > 0 ? fmtInt(apptsAny) + " booked " + pn : "");
    heroMTD = (cm > 0 ? '<span style="font-size:22px;font-weight:900;color:' + GREEN_BIG + ';">' + fmtInt(cm) + '</span> <span style="font-size:12px;font-weight:700;color:' + MUTE + ';">' + (convHeroMTD ? "real conversations" : "leads worked") + ' this month</span>' : "") +
      (bookedNote ? '<span style="font-size:12px;font-weight:700;color:' + MUTE + ';">' + (cm > 0 ? " &nbsp;·&nbsp; " : "") + bookedNote + "</span>" : "");
  } else {
    heroMTD = apptMTD > 0 ? '<span style="font-size:22px;font-weight:900;color:' + GREEN_BIG + ';">' + fmtInt(apptMTD) + '</span> <span style="font-size:12px;font-weight:700;color:' + MUTE + ';">appointments booked this month</span>' : "";
  }
  // canonical "extra" for a dry day: a one-line "what happened · so-what" read so a 0-appointment
  // email still lands as valuable — never a bare "0". Gated to zero-appointment days only, so
  // non-zero days stay exactly as the Jun-2026 review left them (no commentary line).
  var heroComment = apptsAny === 0 ? buildCommentary(m, primary.mode, pn) : "";
  var hero =
    '<tr><td class="pad" style="padding:8px 26px 2px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:18px;overflow:hidden;"><tr><td style="' + heroBg + 'padding:20px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:' + CARD + ';border-radius:14px;padding:22px 24px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td class="col" valign="middle"><span style="font-size:52px;line-height:1;font-weight:900;color:' + GREEN_BIG + ';">' + fmtInt(heroNum) + "</span>" +
    '<span style="font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';">&nbsp;&nbsp;' + esc(heroLabel) + "</span></td>" +
    '<td class="col hero-cta" align="right" valign="middle" style="white-space:nowrap;">' + heroBtn + "</td>" +
    "</tr></table>" +
    (heroComment ? '<div style="margin-top:12px;font-size:13px;line-height:1.6;color:' + BODY + ';">' + esc(heroComment) + "</div>" : "") +
    (heroMTD ? '<div style="margin-top:16px;border-top:1px solid ' + LINE + ';padding-top:14px;">' + heroMTD + "</div>" : "") +
    "</td></tr></table></td></tr></table></td></tr>";

  // ── KPI CARDS (Figma glance tier) ───────────────────────────────────────────
  // Secondary metrics: Total leads · Calls handled · Qualified · Booking rate.
  // Spec edge: no appointments → drop the booking-rate (ABR) card, show 3.
  // Three cards: Engaged leads · Calls handled · Qualified. (Booking-rate card removed per Jun-2026 review.)
  // "Due action items" glance card — the open (pending) items the team owes a follow-up on; overdue
  // (past-due) shown as context WHEN available. Elevated to the KPI row per Jul-2026 feedback. Headlines
  // the OPEN count (actionItemsTotal — always populated) rather than overdue (actionItemsOverdue is not
  // yet wired in the digest pipeline, so it would read 0), so the card is real, not a hardcoded zero.
  var openAI = num(m.actionItemsTotal), overdueAI = num(m.actionItemsOverdue);
  var dueCard = kpiCard("Due action items", fmtInt(openAI), "", null, overdueAI > 0 ? fmtInt(overdueAI) + " overdue" : "");
  // canonical: AI-assisted (CRM) appointments are SECONDARY — shown as a small sub under the AI-booked
  // headline, NEVER folded into it. Only surfaced when there are any (field mapped in runner apiMetrics).
  var assisted = num(m.assistedAppointments);
  var apptSub = (apptMTD ? fmtInt(apptMTD) + " MTD" : "") + (assisted > 0 ? (apptMTD ? " · " : "") + "+" + fmtInt(assisted) + " AI-assisted (CRM)" : "");
  var cards, kpiRow, cardList;
  if (focus === "conversation") {
    // canonical glance funnel: Real conversations → Qualified leads → Appointments (AI-booked) → Due action items.
    cardList = [
      kpiCard("Real conversations", fmtInt(convHero), "", d.totalCalls, ""),
      kpiCard("Qualified leads", fmtInt(qualified), "", d.leadsQualified, ""),
      kpiCard("Appointments — AI-booked", fmtInt(apptsAny), "", null, apptSub),
      dueCard,
    ];
  } else {
    cardList = [
      kpiCard("Leads touched", fmtInt(leads), "", d.leadsAttempted, leadsMTD ? fmtInt(leadsMTD) + " MTD" : ""),
      kpiCard("Real conversations", fmtInt(convHero), "", d.totalCalls, ""),
      kpiCard("Qualified leads", fmtInt(qualified), "", d.leadsQualified, ""),
      kpiCard("Appointments — AI-booked", fmtInt(apptsAny), "", null, apptSub),
    ];
  }
  // kpiCard hardcodes width 25% (4-up); rewrite to an even split for the actual card count.
  cards = cardList.join("").replace(/width="25%"/g, 'width="' + Math.floor(100 / cardList.length) + '%"');
  kpiRow = '<tr><td class="pad" style="padding:14px 21px 4px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' + cards + "</tr></table></td></tr>";

  // ── SECONDARY canonical strip — the three metrics the Overview headlines that the glance cards don't:
  //   Hand-offs to team (= transfers + callbacks) · Turn rate (qualified ÷ conversations) · Close rate
  //   (appointments ÷ qualified). Fraction-aware; inbound-consistent basis (matches the Qualified card).
  var CB_KEYS = { requestcallback: 1, callbackrequest: 1 };
  var sTransfers = num(m.inboundTransfers != null ? m.inboundTransfers : m.warmTransfers);
  var sCallbacks = num(m.inboundCallbacks) || arr(m.actionItems).reduce(function (s, it) { return s + (CB_KEYS[normKey(it.intent)] ? num(it.count) : 0); }, 0);
  var sHandoffs = sTransfers + sCallbacks;
  var sConvos = num(m.conversationsInbound != null ? m.conversationsInbound : m.conversationsReached) || convHero;
  var rateTile = function (label, value, sub) {
    return '<td class="col" width="33%" valign="top" style="padding:6px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-left:3px solid ' + VIOLET + ';border-radius:12px;background:' + CARD + ';"><tr><td style="padding:13px 15px;">' +
      '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:800;">' + esc(label) + '</div>' +
      '<div style="font-size:20px;font-weight:900;color:' + INK + ';margin-top:6px;line-height:1;">' + esc(value) + '</div>' +
      '<div style="font-size:10px;color:' + FAINT + ';margin-top:5px;">' + esc(sub) + '</div>' +
      '</td></tr></table></td>';
  };
  var rateRow = '<tr><td class="pad" style="padding:2px 21px 4px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    rateTile("Hand-offs to team", fmtInt(sHandoffs), fmtInt(sTransfers) + " transfers · " + fmtInt(sCallbacks) + " callbacks") +
    rateTile("Turn rate", rateFrac(qualified, sConvos), "qualified ÷ conversations") +
    rateTile("Close rate", apptsAny > 0 ? rateFrac(apptsAny, qualified) : "—", apptsAny > 0 ? "appointments ÷ qualified" : (qualified > 0 ? fmtInt(qualified) + " qualified to close" : "no bookings yet")) +
    "</tr></table></td></tr>";

  // ── UPSELL banner — WEEKLY/MONTHLY ONLY. The daily report is "just the day's work":
  // no marketing (per the Jun-2026 review). The upsell funnel is handled on the weekly cadence.
  var upsell = period !== "daily" ? pickUpsell(opts, m, dept, leads) : null;
  var upsellSection = "";
  if (upsell) {
    upsellSection = '<tr><td class="pad" style="padding:18px 26px 2px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:16px;background:#0B1020;background:linear-gradient(120deg,#3B0A6E 0%,#4600F2 55%,#A21CAF 130%);"><tr><td style="padding:22px 24px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle"><div style="font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#E9D5FF;">' + esc(upsell.eyebrow || "Recommended") + "</div>" +
      '<div style="font-size:18px;font-weight:900;color:#fff;margin-top:8px;">' + esc(upsell.title) + "</div>" +
      '<div style="font-size:13px;line-height:1.6;color:#DDD6FE;margin-top:8px;">' + (upsell.body || "") + "</div></td>" +
      '<td width="20" style="font-size:0;">&nbsp;</td>' +
      '<td class="col" valign="middle" align="right" style="white-space:nowrap;"><div class="upsell-cta">' + btnLight(upsell.cta || "Learn more", upsell.href || consoleUrl) + "</div></td>" +
      "</tr></table></td></tr></table></td></tr>";
  }

  // ── UPCOMING APPOINTMENTS (spec §2) ─────────────────────────────────────────
  // Default: today's. Fallbacks degrade gracefully and the section omits itself
  // when there's nothing to show.
  // Dense TABLE (per the review: tables over cards — show 5–6 rows + a total, "view all" carries the rest).
  // canonical: the AI-booked appointments themselves — WHO booked, the vehicle, WHEN, and the reason
  // (intent). Sourced scope=window (booked in the report period) so the list reconciles with the
  // "Appointments — AI-booked" headline count. Section omits itself when there are none.
  var apptAll = arr(opts.appointments), appointments = apptAll.slice(0, 6), apptSection = "";
  if (appointments.length) {
    var apptTotal = num(m.appointmentsUpcomingTotal) || apptAll.length;
    var rows = appointments.map(function (a) {
      var est = a.estValue != null ? a.estValue : (dollarRate > 0 ? dollarRate : 0);
      var why = a.intent ? humanize(a.intent) : "";
      var sub = [a.vehicle && a.vehicle !== "—" ? esc(a.vehicle) : "", a.phone ? esc(a.phone) : "", why ? esc(why) : ""].filter(Boolean).join(" · ");
      return '<tr>' +
        '<td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;color:' + INK + ';"><span style="font-weight:700;">' + esc(a.customer || "Customer") + "</span>" + (sub ? '<div style="font-size:11px;color:' + MUTE + ';margin-top:2px;">' + sub + "</div>" : "") + "</td>" +
        '<td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:12px;font-weight:600;color:' + BODY + ';white-space:nowrap;">' + esc(a.sched || "") + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:12px;font-weight:800;color:' + INK + ';white-space:nowrap;">' + (est > 0 ? money(est) : "") + "</td></tr>";
    }).join("");
    apptSection = '<tr><td class="pad" style="padding:24px 28px 4px;">' + eyebrow("Appointments booked · " + pn, L.appointments || consoleUrl) +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:12px;border-collapse:separate;overflow:hidden;">' +
      '<tr><td style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Customer · vehicle · reason</td><td style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">When</td><td align="right" style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Est. value</td></tr>' +
      rows + "</table>" +
      '<div style="margin-top:8px;font-size:12px;color:' + MUTE + ';"><span style="font-weight:800;color:' + INK + ';">' + fmtInt(apptTotal) + "</span> AI-booked " + esc(pn) + " &nbsp;·&nbsp; " +
      '<a href="' + esc(L.appointments || consoleUrl) + '" target="_blank" rel="noopener noreferrer" style="color:' + BRAND + ';font-weight:700;text-decoration:none;">View all &#8594;</a></div></td></tr>';
  }

  // ── LEADS TO CALL NOW (warm/hot leads: buying intent on record, no appointment yet) ──────────
  // The workable pipeline — WHO to call to turn conversations into the next appointment. Mirrors the
  // console's "Work these now". Fed by opts.warmLeads (reporting-vini warmLeads); omits itself when empty.
  var warm = arr(opts.warmLeads).filter(function (w) { return (w.customer || "").trim() || (w.phone || "").trim(); });
  var warmSection = "";
  if (warm.length) {
    var wRows = warm.slice(0, 6).map(function (w) {
      var hot = w.tier === "hot";
      var chip = '<span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:.05em;color:' + (hot ? NEG : WARM) + ";background:" + (hot ? NEG_BG : WARM_BG) + ';border-radius:6px;padding:2px 7px;">' + (hot ? "HOT" : "WARM") + "</span>";
      var meta = [w.interest ? esc(w.interest) : "", w.phone ? esc(w.phone) : ""].filter(Boolean).join(" · ");
      return '<tr><td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;color:' + INK + ';"><span style="font-weight:700;">' + esc(w.customer || "Lead") + "</span>" + (meta ? '<div style="font-size:11px;color:' + MUTE + ';margin-top:2px;">' + meta + "</div>" : "") + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';white-space:nowrap;">' + chip + "</td></tr>";
    }).join("");
    warmSection = '<tr><td class="pad" style="padding:24px 28px 4px;">' + eyebrow("Leads to call now", L.conversations || consoleUrl, "Open inbox") +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:12px;border-collapse:separate;overflow:hidden;">' +
      '<tr><td style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Lead · what they want</td><td align="right" style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Priority</td></tr>' +
      wRows + "</table>" +
      '<div style="margin-top:8px;font-size:12px;color:' + MUTE + ';"><span style="font-weight:800;color:' + INK + ';">' + fmtInt(warm.length) + "</span> with buying intent · no appointment yet — call these first</div></td></tr>";
  }

  // ── ACTION ITEMS (spec §3) ──────────────────────────────────────────────────
  // Default: pending priority cards. Happy-note when none open but some closed
  // yesterday. Section omits itself when there's nothing at all.
  var items = arr(m.actionItems).filter(function (it) { return num(it.count) > 0; });
  var closedYesterday = num(m.actionItemsClosedYesterday);
  var fuSection = "";
  if (items.length) {
    // Dense TABLE grouped by intent (most action items first) — what the GM cares about.
    var sorted = items.slice().sort(function (a, b) { return num(b.count) - num(a.count); });
    var aiTotal = sorted.reduce(function (s, it) { return s + num(it.count); }, 0) || 1;
    var overdue = num(m.actionItemsOverdue);
    var aiRows = sorted.slice(0, 6).map(function (it) {
      // Numeric count only — percent share removed per Jun-2026 review.
      return '<tr><td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:600;color:' + INK + ';">' + esc(humanize(it.intent)) + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:800;color:' + INK + ';white-space:nowrap;">' + fmtInt(it.count) + "</td></tr>";
    }).join("");
    fuSection = '<tr><td class="pad" style="padding:24px 28px 4px;">' + eyebrow("Action items", L.actionItems || consoleUrl) +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:12px;border-collapse:separate;overflow:hidden;">' +
      '<tr><td style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Intent</td><td align="right" style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">Count</td></tr>' +
      aiRows + "</table>" +
      '<div style="margin-top:8px;font-size:12px;color:' + MUTE + ';"><span style="font-weight:800;color:' + INK + ';">' + fmtInt(aiTotal) + "</span> open" + (overdue > 0 ? ' &nbsp;·&nbsp; <span style="font-weight:800;color:' + NEG + ';">' + fmtInt(overdue) + " overdue</span>" : "") + (closedYesterday > 0 ? ' &nbsp;·&nbsp; ' + fmtInt(closedYesterday) + " closed " + pn : "") +
      "</div></td></tr>"; // "Take action →" link removed per Jun-2026 review
  } else if (closedYesterday > 0) {
    fuSection = '<tr><td class="pad" style="padding:24px 28px 4px;">' + eyebrow("Action items") +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #BBF7D0;border-radius:12px;background:#F0FDF4;"><tr><td style="padding:18px 20px;">' +
      '<div style="font-size:14px;font-weight:800;color:' + GREEN_BIG + ';">&#10003; All caught up</div>' +
      '<div style="font-size:13px;color:' + BODY + ';margin-top:6px;line-height:1.6;">Nothing pending — your team cleared <span style="font-weight:800;color:' + INK + ';">' + fmtInt(closedYesterday) + "</span> action item" + (closedYesterday === 1 ? "" : "s") + " " + pn + ". Nice work.</div>" +
      "</td></tr></table></td></tr>";
  }

  // ── TOP VEHICLES OF INTEREST (spec §4) ──────────────────────────────────────
  // Photo-less, email-safe ranked cards (rank chip · vehicle · leads/appts badge).
  var tv = arr(opts.topVehicles).length ? arr(opts.topVehicles) : arr(m.topVehicles), tvSection = "";
  if (tv.length) {
    // Dense TABLE (per review: not chip-pills / not bars — show 6–8 rows of real data).
    var tvLabel = (tv[0] && tv[0].label) || (dept === "service" ? "appts" : "leads");
    var tvTitle = dept === "service" ? "Top services" : "Top vehicles of interest";
    var tvRows = tv.slice(0, 8).map(function (v, i) {
      return '<tr><td width="34" align="center" style="padding:9px 6px;border-top:1px solid ' + LINE + ';font-size:12px;font-weight:800;color:' + BRAND + ';">' + (i + 1) + "</td>" +
        '<td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:700;color:' + INK + ';">' + esc(v.name) + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:800;color:' + INK + ';white-space:nowrap;">' + fmtInt(v.count) + ' <span style="font-size:11px;font-weight:600;color:' + MUTE + ';">' + esc(tvLabel) + "</span></td></tr>";
    }).join("");
    tvSection = '<tr><td class="pad" style="padding:24px 28px 4px;">' + eyebrow(tvTitle) +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:12px;border-collapse:separate;overflow:hidden;">' + tvRows + "</table></td></tr>";
  }

  // ── INBOUND ACTIVITY (spec §5) ──────────────────────────────────────────────
  var callIn = num(m.conversationsCallIn), smsIn = num(m.conversationsSmsIn), chatIn = num(m.conversationsChatIn);
  // "Conversations" = reached/two-way leads (connected call OR replied SMS), deduped per lead —
  // matches the console. Falls back to the channel-split sum only when the reached field is absent
  // (older stored metrics). callIn/smsIn still drive the channel-breakdown bar above.
  var inboundConv = (m.conversationsInbound != null) ? num(m.conversationsInbound) : ((callIn + smsIn + chatIn) || convHandled);
  var during = num(m.callingDuring), after = num(m.callingAfter), duringMTD = num(m.callingDuringMTD), afterMTD = num(m.callingAfterMTD);
  // resolution callout from queries[] (resolved/total) when present
  var queries = arr(m.queries);
  var resCallout = "";
  if (queries.length && (period !== "daily" || focus === "conversation")) { // weekly/monthly story — but for conversation-focus it's a PRIMARY daily proof ("we resolved the bulk without a human")
    var totQ = queries.reduce(function (s, q) { return s + num(q.total); }, 0) || 1;
    var resQ = queries.reduce(function (s, q) { return s + num(q.resolved); }, 0);
    var resPct = Math.round((resQ / totQ) * 100);
    var top2 = queries.slice().sort(function (a, b) { return num(b.total) - num(a.total); }).slice(0, 1)[0];
    var msg = resPct >= 70
      ? "<b>" + resPct + "% of queries resolved</b> without a human — agents handled the bulk of inbound on their own."
      : "<b>" + resPct + "% overall resolution.</b> The rest needed a human hand-off" + (top2 ? ", concentrated in <b>" + esc(top2.label) + "</b>" : "") + " — a clear place to tune the agent.";
    resCallout = calloutBox("◆", "Query resolution", msg, "rose");
  }
  // Inbound section leads with INBOUND-only appointments so inbound + outbound
  // reconcile to the headline total (Figma's 20 + 13 = 33 split).
  var inAppts = num(m.appointmentsInbound);
  // conversation-focus: lead inbound with conversations handled (never "Appointments booked").
  var inboundBig = focus === "conversation"
    ? { n: inboundConv, label: "Real conversations" }
    : (inAppts > 0
      ? { n: inAppts, label: "Appointments — AI-booked" }
      : (num(m.warmLeads) > 0 ? { n: num(m.warmLeads), label: "Leads warmed " + pn } : { n: qualified, label: "Qualified leads" }));
  var hasInAppts = focus !== "conversation" && inAppts > 0;
  // mini metrics under the inbound big number — canonical wordings (Leads reached / Real conversations /
  // Qualified leads). conversation-focus already leads with conversations, so its minis carry reach + qualified.
  var inboundMinis = focus === "conversation"
    ? miniMetric("Leads reached", fmtInt(leads), d.leadsAttempted, "50%") + miniMetric("Qualified leads", fmtInt(qualified), d.leadsQualified, "50%")
    : miniMetric("Real conversations", fmtInt(inboundConv), d.totalCalls, "50%") + miniMetric("Qualified leads", fmtInt(qualified), d.leadsQualified, "50%");
  // Two-column layout (Jun-2026 review): LEFT = the appointment-booked numbers; RIGHT = channel
  // engaged + during/after hours (moved over from the full-width strip). The "VINI" agent device
  // card was removed; booking-rate mini metric dropped along with the KPI card.
  var inChannel = (callIn + smsIn + chatIn) > 0 ? eyebrow("Channel engaged") + channelBar(callIn, smsIn, chatIn) : "";
  var hourCard = function (label, val, mtd) {
    // Borderless (WASH fill) — these tiles sit inside the section panel, so a border would double up.
    return '<div style="background:' + WASH + ';border-radius:12px;padding:14px 16px;"><div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">' + label + '</div><div style="font-size:22px;font-weight:800;color:' + INK + ';margin-top:6px;">' + fmtInt(val) + (mtd ? ' <span style="font-size:11px;font-weight:600;color:' + MUTE + ';">' + fmtInt(mtd) + " MTD</span>" : "") + "</div></div>";
  };
  var inHours = (during + after) > 0 ? '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:' + (inChannel ? "18px" : "0") + ';"><tr>' +
    '<td width="50%" valign="top" style="padding-right:6px;">' + hourCard("During Hours", during, duringMTD) + "</td>" +
    '<td width="50%" valign="top" style="padding-left:6px;">' + hourCard("After Hours", after, afterMTD) + "</td>" +
    "</tr></table>" : "";
  // ── INBOUND OUTPUTS — "what the agent did" with the conversations. These are the proof the agent
  // worked the funnel even on a no-appointment day: warm transfers to the team, callbacks it arranged,
  // and how much it resolved on its own. (Was missing for inbound: transfers only showed in OUTBOUND,
  // query-resolution was gated to weekly/monthly, callbacks lived only in the generic action-item list.)
  //   • Transfers — from m.inboundTransfers (reporting callFlow, inbound) — see runner.cjs apiMetrics.
  //   • Callbacks — derived from the action-item list (callbacks ARE actionItems: request_callback) so it
  //     can't drift from the Action items section; m.inboundCallbacks overrides if ever provided.
  //   • Queries resolved — resolved/total from queries[].
  var CALLBACK_KEYS = { requestcallback: 1, callbackrequest: 1 };
  var inTransfers = num(m.inboundTransfers != null ? m.inboundTransfers : m.warmTransfers);
  var callbacksArranged = num(m.inboundCallbacks);
  if (!callbacksArranged) callbacksArranged = arr(m.actionItems).reduce(function (s, it) { return s + (CALLBACK_KEYS[normKey(it.intent)] ? num(it.count) : 0); }, 0);
  var qTot = queries.reduce(function (s, q) { return s + num(q.total); }, 0);
  var qRes = queries.reduce(function (s, q) { return s + num(q.resolved); }, 0);
  var qResPct = qTot > 0 ? Math.round((qRes / qTot) * 100) : 0;
  var outCard = function (label, valStr, sub) {
    return '<td class="col" width="33%" valign="top" style="padding:0 6px;">' +
      '<div style="border-radius:12px;padding:14px 16px;background:' + WASH + ';">' +
      '<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">' + esc(label) + "</div>" +
      '<div style="font-size:24px;font-weight:900;color:' + INK + ';margin-top:6px;line-height:1;">' + esc(valStr) + "</div>" +
      (sub ? '<div style="font-size:11px;color:' + MUTE + ';margin-top:5px;">' + esc(sub) + "</div>" : "") +
      "</div></td>";
  };
  var hasInOutputs = inTransfers > 0 || callbacksArranged > 0 || qTot > 0;
  var inboundOutputs = hasInOutputs ? '<div style="margin-top:22px;">' + eyebrow("What the agent did") +
    panel('<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    outCard("Transfers to team", fmtInt(inTransfers), "warm hand-offs") +
    outCard("Callbacks arranged", fmtInt(callbacksArranged), "from requests") +
    outCard("Queries resolved", qTot > 0 ? qResPct + "%" : "—", qTot > 0 ? "of " + fmtInt(qTot) + " asked" : "") +
    "</tr></table>", "14px 8px") + "</div>" : "";

  // ── INBOUND INTENTS & OUTCOMES (feedback #6) — the intent mix behind inbound conversations plus a
  // one-line outcome summary (transfers · callbacks · AI-booked appts · resolution). Mirrors the fleet
  // scorecard's "call intents & how the AI handles them" table. This was missing for sales inbound: the
  // resolution story only rendered as a callout on weekly/conversation-focus, so daily appointment-focus
  // sales showed no intent breakdown at all. Renders whenever we have queries[].
  var inboundIntents = "";
  if (queries.length) {
    var qSorted = queries.slice().sort(function (a, b) { return num(b.total) - num(a.total); });
    var qSum = qSorted.reduce(function (s, q) { return s + num(q.total); }, 0) || 1;
    var qh = function (label, align) { return '<td ' + (align ? 'align="' + align + '" ' : "") + 'style="padding:8px 12px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;">' + esc(label) + "</td>"; };
    var qRows = qSorted.slice(0, 8).map(function (q) {
      var tot = num(q.total), res = Math.min(num(q.resolved), tot), share = Math.round((tot / qSum) * 100);
      return '<tr>' +
        '<td style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:600;color:' + INK + ';">' + esc(q.label) + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:800;color:' + INK + ';white-space:nowrap;">' + fmtInt(tot) + "</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:12px;color:' + MUTE + ';white-space:nowrap;">' + share + "%</td>" +
        '<td align="right" style="padding:9px 12px;border-top:1px solid ' + LINE + ';font-size:13px;font-weight:800;color:' + (res > 0 ? POS : FAINT) + ';white-space:nowrap;">' + (res > 0 ? fmtInt(res) : "&#8211;") + "</td></tr>";
    }).join("");
    var handledBits = [];
    if (inTransfers > 0) handledBits.push("<b>" + fmtInt(inTransfers) + " " + plural(inTransfers, "transfer") + "</b> to a human");
    if (callbacksArranged > 0) handledBits.push("<b>" + fmtInt(callbacksArranged) + " " + plural(callbacksArranged, "callback") + "</b>");
    if (inAppts > 0) handledBits.push("<b>" + fmtInt(inAppts) + " AI-booked " + plural(inAppts, "appointment") + "</b>");
    var qDefs = "Intent mix of the <b>" + fmtInt(inboundConv) + "</b> real inbound conversations." +
      (handledBits.length ? " The agent also completed " + joinAnd(handledBits) + "." : "") +
      " Resolved = query answered without a human.";
    inboundIntents = '<div style="margin-top:22px;">' + eyebrow(dept === "sales" ? "Inbound intents · how the AI handled them" : "Inbound service intents") +
      panel('<table width="100%" cellpadding="0" cellspacing="0">' +
        "<tr>" + qh("What the customer wanted") + qh("Convos", "right") + qh("Share", "right") + qh("Resolved", "right") + "</tr>" +
        qRows + "</table>" +
        '<div style="margin-top:12px;font-size:11px;line-height:1.6;color:' + MUTE + ';">' + qDefs + "</div>", "8px 10px 14px") + "</div>";
    // The intents table now carries the resolution story, so drop the redundant resolution callout.
    resCallout = "";
  }

  var inboundSection =
    '<tr><td class="pad" style="padding:26px 28px 4px;">' + eyebrow("Inbound " + Dept.toLowerCase() + " performance") +
    panel('<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    // LEFT — appointment-booked numbers
    '<td class="col" width="50%" valign="top" style="padding-right:16px;">' +
    '<div style="font-size:11px;color:' + MUTE + ';font-weight:700;">' + esc(inboundBig.label) + (hasInAppts ? " " + pn : "") + "</div>" +
    '<div style="margin-top:4px;line-height:1;"><span style="font-size:46px;font-weight:900;color:' + INK + ';">' + fmtInt(inboundBig.n) + "</span> &nbsp;" + (inboundBig.n > 0 ? (hasInAppts ? deltaChip(d.appointments) : (focus === "conversation" ? deltaChip(d.totalCalls) : "")) : "") + "</div>" +
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr>' +
    inboundMinis +
    "</tr></table></td>" +
    // RIGHT — channel engaged + during/after hours
    '<td class="col" width="50%" valign="top">' + (inChannel || inHours ? inChannel + inHours : "&nbsp;") + "</td>" +
    "</tr></table>") +
    inboundOutputs +
    inboundIntents +
    resCallout +
    "</td></tr>";

  // ── mid CTA (speed-to-lead) — WEEKLY/MONTHLY ONLY (no marketing in daily); also suppressed when an upsell already shows.
  var midCta = (period === "daily" || upsell) ? "" : '<tr><td class="pad" style="padding:24px 28px 6px;"><table width="100%" cellpadding="0" cellspacing="0" style="border-radius:16px;background:#0B1020;background:linear-gradient(120deg,#0B1020 0%,#312E81 60%,#4600F2 130%);"><tr><td align="center" style="padding:30px 26px;">' +
    '<div style="font-size:20px;font-weight:900;color:#fff;">Get every new lead a reply under a minute</div>' +
    '<div style="font-size:12px;color:#C7D2FE;margin:10px 0 18px;line-height:1.6;">Speed-to-lead is the single biggest lever on booking rate. Turn on instant response for every inbound.</div>' +
    btnLight("Speed up my response", consoleUrl) + "</td></tr></table></td></tr>";

  // ── OUTBOUND ACTIVITY (spec §6) ─────────────────────────────────────────────
  var callOut = num(m.conversationsCallOut), smsOut = num(m.conversationsSmsOut), chatOut = num(m.conversationsChatOut);
  var hasOutbound = num(m.outboundTotalCalls) + num(m.outboundUniqueReached) + num(m.outboundConnected) + num(m.outboundAppointmentsSet) > 0;
  var outboundSection = "";
  if (hasOutbound) {
    var obAppts = num(m.outboundAppointmentsSet);
    var obWarm = num((m.leadFunnel || {}).qualified) || num(m.warmLeads);
    var obBig = obAppts > 0 ? { n: obAppts, label: "Appointments — AI-booked" } : { n: obWarm, label: "Qualified leads" };
    var outcomes = arr(m.outcomes).filter(function (o) { return num(o.value) > 0; }), funnel = m.leadFunnel || null, outcomesHtml = "";
    if (outcomes.length) {
      var maxO = outcomes.reduce(function (mx, o) { return Math.max(mx, num(o.value)); }, 0);
      outcomesHtml = '<div style="margin-top:24px;">' + eyebrow("Outbound outcomes") + panel('<div style="font-size:11px;color:' + MUTE + ';margin:0 0 10px;">How outbound conversations ended</div><table width="100%" cellpadding="0" cellspacing="0">' + outcomes.slice(0, 7).map(function (o, i) { return barRow(o.label, o.value, maxO, o.color || DONUT[i % DONUT.length]); }).join("") + "</table>") + "</div>";
    } else if (funnel) {
      var fr = [["Leads dialed", funnel.contacted], ["Real conversations", funnel.connected], ["Qualified leads", funnel.qualified], ["Appointments — AI-booked", funnel.appt]], maxF = fr.reduce(function (mx, r) { return Math.max(mx, num(r[1])); }, 0);
      outcomesHtml = '<div style="margin-top:24px;">' + eyebrow("Outbound funnel") + panel('<table width="100%" cellpadding="0" cellspacing="0">' + fr.map(function (r, i) { return barRow(r[0], r[1], maxF, DONUT[i % DONUT.length]); }).join("") + "</table>") + "</div>";
    }
    // AI-handle callout — share of conversations the agent closed without a transfer
    var transfers = num(m.warmTransfers), transferTotal = num(m.transferTotalCalls);
    var handlePct = transferTotal > 0 ? Math.round(((transferTotal - transfers) / transferTotal) * 100) : 0;
    var handleMsg = handlePct > 0
      ? person + " resolved <b>" + handlePct + "% of conversations</b> without a human hand-off" + (transfers > 0 ? ", routing only <b>" + fmtInt(transfers) + "</b> warm transfer" + (transfers === 1 ? "" : "s") + " to your team." : ".")
      : "Outbound reached <b>" + fmtInt(num(m.outboundUniqueReached)) + "</b> unique leads at a <b>" + Math.round(num(m.outboundConnectRate)) + "%</b> connect rate.";
    var handleCallout = calloutBox("✦", "AI handle rate", handleMsg, "lavender");

    outboundSection = '<tr><td class="pad" style="padding:26px 28px 4px;">' + eyebrow("Outbound " + Dept.toLowerCase() + " performance") +
      panel('<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="top"><div style="font-size:11px;color:' + MUTE + ';font-weight:700;">' + esc(obBig.label) + "</div>" +
      '<div style="margin-top:4px;line-height:1;"><span style="font-size:46px;font-weight:900;color:' + INK + ';">' + fmtInt(obBig.n) + "</span> &nbsp;" + (obBig.n > 0 ? deltaChip(d.appointments) : "") + "</div>" +
      '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr>' +
      miniMetric("Real conversations", fmtInt(m.outboundUniqueReached), d.totalCalls, "34%") +
      miniMetric("Connect rate", Math.round(num(m.outboundConnectRate)) + "%", null, "33%") +
      miniMetric(obAppts > 0 ? "Appointments — AI-booked" : "Qualified leads", obAppts > 0 ? fmtInt(obAppts) : fmtInt(obWarm), null, "33%") +
      "</tr></table></td>" +
      // VINI agent device card removed per Jun-2026 review.
      "</tr></table>" +
      ((callOut + smsOut + chatOut) > 0 ? '<div style="margin-top:18px;">' + eyebrow("Channel engaged") + channelBar(callOut, smsOut, chatOut) + "</div>" : "")) +
      outcomesHtml + handleCallout + "</td></tr>";
  }

  // ── TOP CAMPAIGN (spec §6 — most appointments, fallback most warm) ──────────
  var camps = arr(m.campaigns).filter(function (c) { return num(c.dials || c.enrolled) > 0; });
  var campImgs = arr(opts.campaignImages), campSection = "";
  if (camps.length) {
    var best = camps.slice().sort(function (a, b) { return (num(b.appts) - num(a.appts)) || (num(b.warm) - num(a.warm)) || (num(b.enrolled || b.dials) - num(a.enrolled || a.dials)); })[0];
    var enrolled = num(best.enrolled || best.dials), cappts = num(best.appts), warm = num(best.warm);
    var rate = best.conversion != null ? best.conversion : (best.apptRate != null ? num(best.apptRate) + "%" : (enrolled > 0 ? ((cappts * 100) / enrolled).toFixed(1) + "%" : "0%"));
    var img = campImgs[0];
    var stat = function (val, lbl, col) { return '<td width="25%" valign="top"><div style="font-size:19px;font-weight:800;color:' + (col || INK) + ';">' + esc(val) + '</div><div style="font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:' + MUTE + ';font-weight:700;margin-top:3px;">' + esc(lbl) + "</div></td>"; };
    var imgCell = img ? '<td class="col" width="190" valign="top" style="font-size:0;line-height:0;"><img src="' + esc(img) + '" width="190" alt="" style="display:block;width:190px;max-width:190px;height:auto;border-radius:12px;" /></td><td width="16" class="col" style="font-size:0;">&nbsp;</td>' : "";
    campSection = '<tr><td class="pad" style="padding:26px 28px 4px;">' + eyebrow("Top campaign", consoleUrl) +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-radius:14px;"><tr><td style="padding:16px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      imgCell +
      '<td valign="middle"><div><span style="font-size:9px;font-weight:800;letter-spacing:.06em;color:' + POS + ";background:" + POS_BG + ';border-radius:6px;padding:2px 8px;">ACTIVE</span></div>' +
      '<div style="font-size:15px;font-weight:800;color:' + INK + ';margin-top:9px;">' + esc(best.name) + "</div>" +
      '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>' + stat(fmtInt(enrolled), "Enrolled", BRAND) + stat(fmtInt(cappts), "Appts", INK) + stat(rate, "Appt rate", POS) + stat(fmtInt(warm), "Warm", WARM) + "</tr></table>" +
      "</td></tr></table></td></tr></table></td></tr>";
  }

  // ── footer breakdown CTA (always-on, light) ─────────────────────────────────
  var breakdown = '<tr><td class="pad" style="padding:26px 28px 4px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:' + WASH + ";border:1px solid " + LINE + ';border-radius:12px;"><tr>' +
    '<td style="padding:16px 20px;font-size:12px;color:' + BODY + ';"><span style="font-weight:800;color:' + INK + ';">Want the full breakdown?</span> Conversation transcripts, lead history &amp; per-rep stats live in the console.</td>' +
    '<td align="right" style="padding:16px 20px;white-space:nowrap;">' + btnPrimary("Open console", consoleUrl) + "</td></tr></table></td></tr>";

  var pixel = opts.pixelUrl ? '<img src="' + esc(opts.pixelUrl) + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />' : "";

  // ── document ────────────────────────────────────────────────────────────────
  var __html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<style>body{margin:0;}@media only screen and (max-width:600px){.wrap{width:100%!important;border-radius:0!important;}.col{display:block!important;width:100%!important;}.device{padding-left:0!important;padding-top:14px!important;}.upsell-cta{margin-top:16px;}.hero-cta{text-align:left!important;padding-top:16px!important;}.pad{padding-left:18px!important;padding-right:18px!important;}}</style></head>" +
    '<body style="margin:0;background:' + PAGE + ";font-family:" + FONT + ";color:" + INK + ';">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:' + PAGE + ';padding:28px 0;"><tr><td align="center">' +
    '<table class="wrap" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:' + CARD + ';border-radius:20px;border:1px solid ' + LINE + ';overflow:hidden;">' +
    // slim header — one row (logo + report type · rooftop + date). The big centered title + button
    // were eating the whole first fold; the hero below carries the value, the footer carries the CTA.
    '<tr><td class="pad" style="padding:18px 28px 2px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td valign="middle"><span style="font-size:15px;font-weight:900;letter-spacing:.04em;color:' + BRAND + ';">spyne</span>' +
    '<span style="font-size:11px;font-weight:700;color:' + MUTE + ';">&nbsp;·&nbsp;' + Dept + " " + (period === "weekly" ? "weekly" : period === "monthly" ? "monthly" : "daily") + " report</span></td>" +
    '<td align="right" valign="middle"><div style="font-size:13px;font-weight:800;color:' + INK + ';">' + esc(opts.rooftopName) + "</div>" +
    '<div style="font-size:11px;color:' + MUTE + ';margin-top:1px;">' + esc(opts.dateLabel) + "</div></td>" +
    "</tr></table></td></tr>" +
    // glance
    hero + kpiRow + rateRow + upsellSection +
    // sections — appointment-focus leads with the appointment list; conversation-focus leads with the
    // work funnel (action items / intents → inbound conversations → outbound) and demotes appointments
    // to a down-funnel widget that only appears when there are any.
    (focus === "conversation"
      ? warmSection + fuSection + inboundSection + midCta + outboundSection + apptSection + tvSection + campSection
      : apptSection + warmSection + fuSection + tvSection + inboundSection + midCta + outboundSection + campSection) +
    breakdown +
    // footer
    '<tr><td class="pad" style="padding:24px 28px 28px;" align="center"><div style="font-size:11px;color:' + FAINT + ';line-height:1.7;">Reporting period: ' + esc(opts.dateLabel) + ' &nbsp;·&nbsp; Next report: ' + esc(nextReport) + '<br/>© Spyne · Vini · 2026</div></td></tr>' +
    "</table>" + pixel + "</td></tr></table></body></html>";

  // Anti-churn no-value marker (kept in sync with server/roi-cron/emailValue.cjs;
  // stripped before the email is sent). A digest with zero real activity has no
  // value to the customer, so stamp it here and EVERY send path refuses to send it
  // unless an override password is supplied.
  var __sig =
    num(m.appointmentsYesterday) +
    num(m.conversationsHandled) +
    num(m.callsHandled != null ? m.callsHandled : m.conversationsCall) +
    num(m.totalLeads != null ? m.totalLeads : m.inboundUniqueLeads) +
    num(m.outboundTotalCalls) +
    num(m.actionItemsTotal);
  if (!(__sig > 0)) __html += "<!--vini:no-value-->";
  // SAFETY: tag every render of the NEW (redesign) template. Send chokepoints use this marker to
  // restrict v2 emails to @spyne.ai while in testing (until V2_TO_CUSTOMERS=true). Stripped off the wire.
  __html += "<!--vini:v2-->";
  return __html;
}

module.exports = { renderDigestHtml: renderDigestHtml, buildCommentary: buildCommentary, pickUpsell: pickUpsell, deviceCard: deviceCard };
