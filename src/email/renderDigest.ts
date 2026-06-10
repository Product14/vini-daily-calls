// Email-safe (table layout, inline styles) render of the Daily Digest — the exact
// HTML the mailer sends, used for the tracker preview. CTA links are the real
// console.spyne.ai deep links. Responsive (cards stack on mobile). No flexbox.
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

export type RenderOpts = { rooftopName: string; dept?: DeptKind; teamId?: string; enterpriseId?: string; reportDate?: string; timezone?: string };

export function renderDigestEmail(metrics: DigestMetrics, opts: RenderOpts): string {
  const m = metrics as Record<string, unknown>;
  const dept = opts.dept === "service" ? "service" : "sales";
  const reportDate = (m.reportDate as string) || opts.reportDate;
  const L = buildConsoleLinks({ enterpriseId: opts.enterpriseId, teamId: opts.teamId, dept, reportDate, timezone: opts.timezone });
  const appts = n(m.appointmentsYesterday), leads = n(m.inboundUniqueLeads), action = n(m.actionItemsTotal);
  const apptsMtd = n(m.appointmentsYesterdayMTD) || appts, leadsMtd = n(m.inboundUniqueLeadsMTD) || leads;
  const call = n(m.conversationsCall), sms = n(m.conversationsSms), chat = n(m.conversationsChat);
  const conv = n(m.conversationsHandled) || call + sms + chat;
  const obReached = n(m.outboundUniqueReached), obReachedMtd = n(m.outboundUniqueReachedMTD), obRate = n(m.outboundConnectRate), obAppts = n(m.outboundAppointmentsSet), obApptsMtd = n(m.outboundAppointmentsSetMTD);
  const camps = (Array.isArray(m.campaigns) ? m.campaigns : []) as Array<{ name: string; dials: number; appts: number; conversion: string | number }>;
  const isSvc = dept === "service";

  const bar = (c: number, s: number, ch: number) => { const t = c + s + ch || 1; const seg = (w: number, col: string) => (w > 0 ? `<td style="width:${(w / t) * 100}%;background:${col};font-size:0;">&nbsp;</td>` : ""); return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:4px;overflow:hidden;margin-top:8px;"><tr>${seg(c, "#2563EB")}${seg(s, "#7C3AED")}${seg(ch, "#16A34A")}</tr></table>`; };
  const leg = (c: number, s: number, ch: number) => `<div style="margin-top:8px;font-size:11px;color:#374151;"><span style="margin-right:14px;">Call ${c}</span><span style="margin-right:14px;">Sms ${s}</span><span>Chat ${ch}</span></div>`;
  const hero = (l: string, v: number | string, x: string) => `<td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(l)}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${esc(v)}</div>${x}</div></td>`;
  const mini = (l: string, v: number | string, sub: string) => `<td class="col" width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(l)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(v)}</div>${sub ? `<div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div>` : ""}</div></td>`;
  const btn = (l: string, h: string, pri: boolean) => pri ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${PURPLE};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${esc(l)}</a>` : `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:${PURPLE};text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${esc(l)}</a>`;
  const title = (t: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;">${esc(t)}</div>`;
  const divider = `<div style="border-top:1px solid #E5E7EB;margin:18px 0;"></div>`;
  const campaignBlock = camps.length ? `<tr><td class="pad" style="padding:4px 28px 16px;">${divider}${title("Active campaigns")}${camps.map((c) => `<div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin-top:8px;"><span style="font-size:13px;font-weight:600;color:#111827;">${esc(c.name)}</span><span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:#16A34A;background:#DCFCE7;border-radius:4px;padding:2px 6px;margin-left:8px;">ACTIVE</span><div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(c.dials)} dials &middot; ${esc(c.appts)} appts &middot; ${esc(c.conversion)} conversion</div></div>`).join("")}</td></tr>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;}@media only screen and (max-width:600px){.wrap{width:100%!important;border-radius:0!important;}.col{display:block!important;width:100%!important;}.pad{padding-left:16px!important;padding-right:16px!important;}}</style></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table class="wrap" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td class="pad" style="padding:24px 28px 8px;"><table width="100%"><tr><td valign="top"><div style="font-size:11px;text-transform:uppercase;color:${PURPLE};font-weight:700;">Vini &middot; Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isSvc ? "Service" : "Sales"} Daily Digest</div></td><td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(opts.rooftopName)}</div><div style="font-size:12px;color:#6B7280;">${esc(fmtDate(reportDate))}</div></td></tr></table></td></tr>
  <tr><td class="pad" style="padding:8px 22px 0;"><table width="100%"><tr>${hero("Appointments yesterday", appts, `<div style="font-size:12px;color:#6B7280;margin-top:6px;">${apptsMtd} month to date</div>`)}${hero("Conversations handled", conv, bar(call, sms, chat) + leg(call, sms, chat))}</tr></table></td></tr>
  <tr><td class="pad" style="padding:14px 28px 4px;">${btn("View today’s appointments", L.appointments, true)} ${btn("Open conversation inbox", L.conversations, false)}</td></tr>
  ${action > 0 ? `<tr><td class="pad" style="padding:4px 28px;">${divider}${title("Action required")}<div style="margin-top:8px;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${action}</span> <span style="font-size:13px;">Callback requests</span></div><div style="margin-top:12px;">${btn("Review action items", L.actionItems, true)}</div></td></tr>` : ""}
  <tr><td class="pad" style="padding:14px 28px;">${divider}${title("Inbound activity")}<table width="100%" style="margin-top:8px;"><tr>${mini("Appointments", appts, `${apptsMtd} MTD`)}${mini("Unique leads", leads, `${leadsMtd} MTD`)}${mini("Conversations", conv, `${call} call · ${sms} sms · ${chat} chat`)}</tr></table></td></tr>
  <tr><td class="pad" style="padding:4px 28px;">${divider}${title("Outbound activity")}<table width="100%" style="margin-top:8px;"><tr>${mini("Unique reached", obReached, `${obReachedMtd} MTD`)}${mini("Connect rate", `${obRate}%`, "")}${mini("Appointments set", obAppts, `${obApptsMtd} MTD`)}</tr></table></td></tr>
  ${campaignBlock}
  <tr><td class="pad" style="padding:16px 28px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;">Reporting period: ${esc(reportDate ?? "")} &middot; Next report: Tomorrow 7:00 AM</td></tr>
</table></td></tr></table></body></html>`;
}
