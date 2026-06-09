// Email-safe (table layout, inline styles) render of the Daily Digest — the exact
// HTML the mailer sends, used for the tracker preview. CTA links are the real
// console.spyne.ai deep links. No flexbox (renders in any inbox / iframe).
import { buildConsoleLinks } from "./links";
import type { DeptKind, DigestMetrics } from "./mockData";

const PURPLE = "#4600F2";
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: unknown) => { const x = typeof v === "number" ? v : parseInt(String(v), 10); return Number.isFinite(x) ? x : 0; };

function fmtDate(reportDate?: string): string {
  const [y, m, d] = String(reportDate ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(reportDate ?? "");
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function channelBar(call: number, sms: number, chat: number) {
  const total = call + sms + chat || 1;
  const seg = (w: number, c: string) => (w > 0 ? `<td style="width:${(w / total) * 100}%;background:${c};font-size:0;line-height:0;">&nbsp;</td>` : "");
  return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:4px;overflow:hidden;margin-top:8px;"><tr>${seg(call, "#2563EB")}${seg(sms, "#7C3AED")}${seg(chat, "#16A34A")}</tr></table>`;
}
function legend(call: number, sms: number, chat: number) {
  const dot = (c: string, l: string, v: number) => `<span style="display:inline-block;margin-right:14px;font-size:11px;color:#374151;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px;"></span>${l} ${v}</span>`;
  return `<div style="margin-top:8px;">${dot("#2563EB", "Call", call)}${dot("#7C3AED", "Sms", sms)}${dot("#16A34A", "Chat", chat)}</div>`;
}
const hero = (label: string, val: number | string, extra: string) =>
  `<td width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${esc(val)}</div>${extra || ""}</div></td>`;
const mini = (label: string, val: number | string, sub: string) =>
  `<td width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(val)}</div>${sub ? `<div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div>` : ""}</div></td>`;
const title = (t: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${esc(t)}</div>`;
const divider = () => `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`;
const btn = (label: string, href: string, primary: boolean) =>
  primary
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${PURPLE};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${esc(label)}</a>`
    : `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:${PURPLE};text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${esc(label)}</a>`;

export type RenderOpts = { rooftopName: string; dept?: DeptKind; teamId?: string; enterpriseId?: string; reportDate?: string; timezone?: string };

export function renderDigestEmail(metrics: DigestMetrics, opts: RenderOpts): string {
  const dept = opts.dept === "service" ? "service" : "sales";
  const reportDate = (metrics.reportDate as string) || opts.reportDate;
  const L = buildConsoleLinks({ enterpriseId: opts.enterpriseId, teamId: opts.teamId, dept, reportDate, timezone: opts.timezone });
  const appts = n(metrics.appointmentsYesterday), leads = n(metrics.inboundUniqueLeads), action = n(metrics.actionItemsTotal);
  const apptsMtd = n(metrics.appointmentsYesterdayMTD) || appts, leadsMtd = n(metrics.inboundUniqueLeadsMTD) || leads;
  const call = n(metrics.conversationsCall), sms = n(metrics.conversationsSms), chat = n(metrics.conversationsChat);
  const conv = n(metrics.conversationsHandled) || call + sms + chat;
  const isService = dept === "service";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td style="padding:24px 28px 8px;"><table width="100%"><tr>
    <td valign="top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PURPLE};font-weight:700;">Vini &middot; Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isService ? "Service" : "Sales"} Daily Digest</div></td>
    <td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(opts.rooftopName)}</div><div style="font-size:12px;color:#6B7280;">${esc(fmtDate(reportDate))}</div></td>
  </tr></table></td></tr>
  <tr><td style="padding:8px 22px 0;"><table width="100%"><tr>
    ${hero("Appointments yesterday", appts, `<div style="font-size:12px;color:#6B7280;margin-top:6px;">${apptsMtd} month to date</div>`)}
    ${hero("Conversations handled", conv, channelBar(call, sms, chat) + legend(call, sms, chat))}
  </tr></table></td></tr>
  <tr><td style="padding:14px 28px 4px;">${btn("View today’s appointments", L.appointments, true)} ${btn("Open conversation inbox", L.conversations, false)}</td></tr>
  ${action > 0 ? `<tr><td style="padding:4px 28px;">${divider()}${title("Action required")}<table width="100%"><tr><td style="padding:7px 0;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${action}</span><span style="font-size:13px;color:#111827;margin-left:10px;">Callback requests</span></td></tr></table><div style="margin-top:12px;">${btn("Review action items", L.actionItems, true)}</div></td></tr>` : ""}
  <tr><td style="padding:4px 22px;">
    <div style="padding:0 6px;">${divider()}${title("Inbound activity")}</div>
    <table width="100%"><tr>
      ${mini("Appointments", appts, `Yesterday &middot; ${apptsMtd} MTD`)}
      ${mini("Unique leads", leads, `Yesterday &middot; ${leadsMtd} MTD`)}
      ${mini("Conversations", conv, `${call} call &middot; ${sms} sms &middot; ${chat} chat`)}
    </tr></table>
    <div style="padding:0 6px;">${title("Channel breakdown")}${channelBar(call, sms, chat)}${legend(call, sms, chat)}</div>
  </td></tr>
  <tr><td style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;">Reporting period: ${esc(reportDate ?? "")} &middot; Next report: Tomorrow 7:00 AM</td></tr>
</table></td></tr></table></body></html>`;
}
