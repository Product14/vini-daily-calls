// Canonical email template — reproduces public/digest-preview.html EXACTLY (same markup,
// colors #0369A1/#0891B2/#0D9488, sections). IDENTICAL to the cron's renderer
// (local-cron/runner.cjs). This is the single source for the on-the-fly preview and the
// /api/email/roi-send-now body. Sent rows display their stored rendered_html (same bytes).
import { buildConsoleLinks } from "./links";
import type { DeptKind, DigestMetrics } from "./mockData";

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: unknown) => { const x = typeof v === "number" ? v : parseInt(String(v), 10); return Number.isFinite(x) ? x : 0; };
const INTENT_LABELS: Record<string, string> = {
  sms_takeover: "SMS takeover requested", REQUEST_CALLBACK: "Callback requests", callback_request: "Callback requests",
  appt_confirmed: "Appointments confirmed today", failed_booking: "Failed bookings to review",
  specific_salesperson: "Customers asked for a salesperson", compliance_alert: "Compliance alerts",
  recall_response: "Recall responses", pending_status_update: "Pending repair-order status", no_show: "No-shows yesterday",
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointments to schedule", SERVICE_RECALL_FOLLOW_UP: "Recall follow-ups",
  SERVICE_STATUS_UPDATE: "Pending status updates", SERVICE_ESCALATE_TO_ADVISOR: "Escalations to advisor",
  SERVICE_SEND_ESTIMATE: "Estimates to send", SERVICE_PARTS_CALLBACK: "Parts callbacks", CUSTOM: "Other action items",
};
const humanize = (k: string) => INTENT_LABELS[k] || String(k || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
function fmtDate(reportDate?: string): string {
  const [y, m, d] = String(reportDate ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(reportDate ?? "");
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export type RenderOpts = { rooftopName: string; dept?: DeptKind; teamId?: string; enterpriseId?: string; reportDate?: string; timezone?: string };

export function renderDigestEmail(metrics: DigestMetrics, opts: RenderOpts): string {
  const m = metrics as Record<string, unknown>;
  const dept = opts.dept === "service" ? "service" : "sales";
  const isSvc = dept === "service";
  const reportDate = (m.reportDate as string) || opts.reportDate;
  const dateLabel = fmtDate(reportDate);
  const L = buildConsoleLinks({ enterpriseId: opts.enterpriseId, teamId: opts.teamId, dept, reportDate, timezone: opts.timezone });
  const call = n(m.conversationsCall), sms = n(m.conversationsSms), chat = n(m.conversationsChat);
  const conv = n(m.conversationsHandled) || call + sms + chat;
  const tot = call + sms + chat || 1; const pct = (x: number) => `${(x / tot) * 100}%`;
  // presence flags — drive section removal (HTML handling rules)
  const hasInboundConv = (call + sms + chat) > 0;
  const hasOutbound = n(m.outboundTotalCalls) + n(m.outboundUniqueReached) + n(m.outboundConnected) + n(m.outboundAppointmentsSet) > 0;
  const items = (Array.isArray(m.actionItems) ? m.actionItems : []) as Array<{ intent: string; count: number }>;
  const camps = (Array.isArray(m.campaigns) ? m.campaigns : []) as Array<{ name: string; dials: number; appts: number; conversion: string | number }>;
  const tv = (Array.isArray(m.topVehicles) ? m.topVehicles : []) as Array<{ name: string; count: number }>;

  const channelBar = `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:9999px;overflow:hidden;margin-top:8px;"><tr>${call > 0 ? `<td style="width:${pct(call)};background:#0369A1;font-size:0;line-height:0;">&nbsp;</td>` : ""}${sms > 0 ? `<td style="width:${pct(sms)};background:#0891B2;font-size:0;line-height:0;">&nbsp;</td>` : ""}${chat > 0 ? `<td style="width:${pct(chat)};background:#0D9488;font-size:0;line-height:0;">&nbsp;</td>` : ""}</tr></table><div style="margin-top:8px;"><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0369A1;margin-right:5px;"></span>Call <span style="color:#525252;">${call}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0891B2;margin-right:5px;"></span>Sms <span style="color:#525252;">${sms}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0D9488;margin-right:5px;"></span>Chat <span style="color:#525252;">${chat}</span></span></div>`;
  const mini = (l: string, v: number | string, sub: string) => `<td class="col" width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(l)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(v)}</div><div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div></div></td>`;
  const btnP = (l: string, h: string) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#4600F2;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${l}</a>`;
  const btnS = (l: string, h: string) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:#4600F2;text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${l}</a>`;
  const sect = (t: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${t}</div>`;
  const rule = `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;}@media only screen and (max-width:600px){.wrap{width:100%!important;border-radius:0!important;}.col{display:block!important;width:100%!important;}.pad{padding-left:16px!important;padding-right:16px!important;}}</style></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table class="wrap" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td class="pad" style="padding:24px 28px 8px;"><table width="100%"><tr>
    <td valign="top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4600F2;font-weight:700;">Vini · Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isSvc ? "Service" : "Sales"} Daily Digest</div></td>
    <td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(opts.rooftopName)}</div><div style="font-size:12px;color:#6B7280;">${esc(dateLabel)}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:8px 22px 0;"><table width="100%"><tr>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">Appointments yesterday</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${n(m.appointmentsYesterday)}</div><div style="margin-top:12px;"><span style="display:inline-block;font-size:11px;font-weight:600;color:#4600F2;background:#EEF0FF;border-radius:9999px;padding:4px 10px;">${n(m.appointmentsYesterdayMTD)} month to date</span></div></div></td>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">Conversations handled</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${conv}</div>${hasInboundConv ? channelBar : `<div style="font-size:11px;color:#9CA3AF;margin-top:10px;">No conversations yesterday</div>`}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:14px 28px 4px;">${btnP("View today’s appointments", L.appointments)} ${btnS("Open conversation inbox", L.conversations)}</td></tr>
  ${items.length ? `<tr><td class="pad" style="padding:4px 28px;">${rule}${sect("Action required")}<table width="100%">${items.slice(0, 6).map((it) => `<tr><td style="padding:7px 0;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${it.count}</span><span style="font-size:13px;color:#111827;margin-left:10px;">${esc(humanize(it.intent))}</span></td></tr>`).join("")}</table><div style="margin-top:12px;">${btnP("Review action items", L.actionItems)}</div></td></tr>` : ""}
  <tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Inbound activity")}</div>
    <table width="100%"><tr>
      ${mini("Appointments", n(m.appointmentsYesterday), `Yesterday · ${n(m.appointmentsYesterdayMTD)} MTD`)}
      ${mini("Unique leads", n(m.inboundUniqueLeads), `Yesterday · ${n(m.inboundUniqueLeadsMTD)} MTD`)}
      ${isSvc ? mini("Transfer rate", `${n(m.transferRate)}%`, `${n(m.transferCount)} transfers`) : mini("Avg response time", (m.avgResponseTime as string) || "—", (m.avgResponseTimeMTD as string) || "—")}
    </tr></table>
    <div style="padding:0 6px;">${hasInboundConv ? `${sect("Channel breakdown")}${channelBar}
      <table width="100%" style="margin-top:14px;"><tr>
        <td valign="top" width="50%"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">After-hours</div><div style="font-size:13px;margin-top:3px;"><b>${n(m.afterHoursLeads)}</b> leads engaged · <b>${n(m.afterHoursAppts)}</b> appts booked</div></td>
        <td valign="top" width="50%"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">Warm transfers</div><div style="font-size:13px;margin-top:3px;"><b>${n(m.warmTransfers)}</b> · ${n(m.warmTransfersMTD)} MTD</div></td>
      </tr></table>` : ""}
      ${tv.length ? `${sect("Top vehicles of interest")}<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">${tv.map((v, i) => `<tr><td style="padding:12px 14px;${i ? "border-top:1px solid #E5E7EB;" : ""}"><table width="100%"><tr><td style="font-size:13px;color:#111827;">${esc(v.name)}</td><td align="right" style="font-size:13px;font-weight:700;color:#111827;">${v.count}</td></tr></table></td></tr>`).join("")}</table>` : ""}
    </div>
  </td></tr>
  ${hasOutbound ? `<tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Outbound activity")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Yesterday's activity</div></div>
    <table width="100%"><tr>
      ${mini("Unique reached", n(m.outboundUniqueReached), `Yesterday · ${n(m.outboundUniqueReachedMTD)} MTD`)}
      ${mini("Connect rate", `${n(m.outboundConnectRate)}%`, `Yesterday · ${n(m.outboundConnectRateMTD)}% MTD`)}
      ${mini("Appointments set", n(m.outboundAppointmentsSet), `Yesterday · ${n(m.outboundAppointmentsSetMTD)} MTD`)}
    </tr></table>
    ${camps.length ? `<div style="padding:0 6px;">${sect("Active campaigns")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Yesterday's activity</div>${camps.map((c) => `<div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin-top:8px;"><div><span style="font-size:13px;font-weight:600;color:#111827;">${esc(c.name)}</span><span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:#16A34A;background:#DCFCE7;border-radius:4px;padding:2px 6px;margin-left:8px;">ACTIVE</span></div><div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(c.dials)} dials · ${esc(c.appts)} appts · ${esc(c.conversion)} conversion</div></div>`).join("")}</div>` : ""}
  </td></tr>` : ""}
  <tr><td class="pad" style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;"><table width="100%"><tr>
    <td valign="top" style="font-size:11px;color:#9CA3AF;line-height:1.6;">Reporting period: ${esc(dateLabel)}<br/>Next report: tomorrow · 7:00 AM</td>
    <td valign="top" align="right" style="font-size:11px;color:#9CA3AF;">© Vini · 2026</td>
  </tr></table></td></tr>
</table></td></tr></table></body></html>`;
}
