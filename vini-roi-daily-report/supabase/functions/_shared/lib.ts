// Shared helpers for the 4-cron ROI emailer pipeline (Deno Edge Functions).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Dept = "sales" | "service";

export function supa() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// ── ClickHouse via Query API Endpoint (HTTPS, key auth — no DB creds/proxy) ───
// Each saved endpoint is a fixed parameterized query. We call it with queryVariables
// and Basic auth (keyId:keySecret). Returns the result rows.
async function chEndpoint(url: string, vars: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const keyId = Deno.env.get("CLICKHOUSE_KEY_ID")!;
  const secret = Deno.env.get("CLICKHOUSE_KEY_SECRET")!;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${keyId}:${secret}`)}` },
    body: JSON.stringify({ queryVariables: vars, format: "JSONEachRow" }),
  });
  if (!res.ok) throw new Error(`ClickHouse endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  // JSONEachRow → newline-delimited objects; JSON → {data:[...]}. Handle both.
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : (j.data ?? [j]);
  } catch {
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

/** cron1: onboarded+active Sales/Service (team,dept) candidates. Returns [{e,t,d}]. */
export async function liveCandidates(): Promise<Record<string, unknown>[]> {
  return await chEndpoint(Deno.env.get("CLICKHOUSE_CANDIDATES_ENDPOINT")!);
}

// ── Dealer-local "yesterday" → UTC bounds + local hour ───────────────────────
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
function localToUTC(y: number, m: number, day: number, tz: string): Date {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(approx);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - asUTC.getTime()));
}
export function dealerWindows(tz: string) {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false }).formatToParts(now);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const Y = g("year"), M = g("month"), D = g("day"), H = g("hour") === 24 ? 0 : g("hour");
  const yStart = localToUTC(Y, M, D - 1, tz);
  const yEnd = new Date(localToUTC(Y, M, D, tz).getTime() - 1000);
  const monthStart = localToUTC(Y, M, 1, tz); // 1st of month, dealer-local → UTC (for MTD)
  const localDate = `${Y}-${String(M).padStart(2, "0")}-${String(D - 1).padStart(2, "0")}`;
  const dateLabel = new Date(yStart.getTime()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { localHour: H, yStart: fmt(yStart), yEnd: fmt(yEnd), monthStart: fmt(monthStart), localDate, dateLabel };
}

// ── Metrics for one (team, dept) — daily window + MTD, via the metrics endpoint ──
// monthStart enables MTD (sum from the 1st of the month through `e`).
export async function metrics(teamId: string, dept: Dept, s: string, e: string, monthStart?: string) {
  const rows = await chEndpoint(Deno.env.get("CLICKHOUSE_METRICS_ENDPOINT")!, {
    team_id: teamId, dept, start: s, end: e, month_start: monthStart ?? s,
  });
  const r = rows[0] ?? {};
  const num = (k: string) => parseInt(String(r[k] ?? 0), 10) || 0;
  const call = num("call"), sms = num("sms"), chat = num("chat");
  return {
    appointmentsYesterday: num("appts"),
    appointmentsInbound: num("inbound_appts"),
    appointmentsOutbound: num("outbound_appts"),
    inboundUniqueLeads: num("leads"),
    actionItemsTotal: num("action"),
    conversationsCall: call, conversationsSms: sms, conversationsChat: chat, conversationsHandled: call + sms + chat,
    appointmentsYesterdayMTD: num("appts_mtd"),
    inboundUniqueLeadsMTD: num("leads_mtd"),
  };
}

// ── Guardrails ───────────────────────────────────────────────────────────────
export function guardrail(m: Record<string, number>): { ok: boolean; reason?: string } {
  const signal = m.appointmentsYesterday + m.conversationsHandled + m.inboundUniqueLeads + m.actionItemsTotal;
  if (signal === 0) return { ok: false, reason: "no_data" };
  if (m.appointmentsYesterday === 0 && m.actionItemsTotal === 0 && m.inboundUniqueLeads === 0) return { ok: false, reason: "not_actionable" };
  return { ok: true };
}

// ── Previous-email template (full dealer-reporting design, email-safe inline HTML) ──
// Ported from notification-service/services/html-render.service.js so the deployed
// pipeline sends EXACTLY the "previous email" the tracker previews. MTD fields aren't
// stored per-run, so they mirror the daily value (same as the tracker's metricsToDailyDigest).
const PURPLE = "#4600F2";
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const nz = (v: unknown) => { const x = typeof v === "number" ? v : parseInt(String(v), 10); return Number.isFinite(x) ? x : 0; };

function channelBar(call: number, sms: number, chat: number): string {
  const total = call + sms + chat || 1;
  const seg = (w: number, color: string) => (w > 0 ? `<td style="width:${(w / total) * 100}%;background:${color};font-size:0;line-height:0;">&nbsp;</td>` : "");
  return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:4px;overflow:hidden;margin-top:8px;"><tr>${seg(call, "#2563EB")}${seg(sms, "#7C3AED")}${seg(chat, "#16A34A")}</tr></table>`;
}
function legend(call: number, sms: number, chat: number): string {
  const dot = (c: string, label: string, val: number) =>
    `<span style="display:inline-block;margin-right:14px;font-size:11px;color:#374151;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px;"></span>${label} ${val}</span>`;
  return `<div style="margin-top:8px;">${dot("#2563EB", "Call", call)}${dot("#7C3AED", "Sms", sms)}${dot("#16A34A", "Chat", chat)}</div>`;
}
function heroCard(label: string, value: number | string, extra: string): string {
  return `<td width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${esc(value)}</div>${extra || ""}</div></td>`;
}
function miniCard(label: string, value: number | string, sub: string): string {
  return `<td width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(label)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(value)}</div>${sub ? `<div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div>` : ""}</div></td>`;
}
const sectionTitle = (t: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${esc(t)}</div>`;
const divider = () => `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`;
const btn = (label: string, href: string, primary: boolean) =>
  primary
    ? `<a href="${esc(href || "#")}" style="display:inline-block;background:${PURPLE};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${esc(label)}</a>`
    : `<a href="${esc(href || "#")}" style="display:inline-block;color:${PURPLE};text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${esc(label)}</a>`;

export function renderHtml(name: string, dept: Dept, dateLabel: string, m: Record<string, number>): string {
  const isService = dept === "service";
  const appts = nz(m.appointmentsYesterday), apptsMtd = nz(m.appointmentsYesterdayMTD) || appts;
  const leads = nz(m.inboundUniqueLeads), leadsMtd = nz(m.inboundUniqueLeadsMTD) || leads;
  const conv = nz(m.conversationsHandled), call = nz(m.conversationsCall), sms = nz(m.conversationsSms), chat = nz(m.conversationsChat);
  const actions = nz(m.actionItemsTotal);
  const reached = nz(m.outboundUniqueReached);
  const actionItems = actions > 0
    ? `<tr><td style="padding:7px 0;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${actions}</span><span style="font-size:13px;color:#111827;margin-left:10px;">Callback requests</span></td></tr>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td style="padding:24px 28px 8px;"><table width="100%"><tr>
    <td valign="top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PURPLE};font-weight:700;">Vini &middot; Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isService ? "Service" : "Sales"} Daily Digest</div></td>
    <td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(name)}</div><div style="font-size:12px;color:#6B7280;">${esc(dateLabel)}</div></td>
  </tr></table></td></tr>
  <tr><td style="padding:8px 22px 0;"><table width="100%"><tr>
    ${heroCard("Appointments yesterday", appts, `<div style="font-size:12px;color:#6B7280;margin-top:6px;">${apptsMtd} month to date</div>`)}
    ${heroCard("Conversations handled", conv, channelBar(call, sms, chat) + legend(call, sms, chat))}
  </tr></table></td></tr>
  <tr><td style="padding:14px 28px 4px;">${btn("View today’s appointments", "#", true)} ${btn("Open conversation inbox", "#", false)}</td></tr>
  ${actions > 0 ? `<tr><td style="padding:4px 28px;">${divider()}${sectionTitle("Action required")}<table width="100%">${actionItems}</table><div style="margin-top:12px;">${btn("Review action items", "#", true)}</div></td></tr>` : ""}
  <tr><td style="padding:4px 22px;">
    <div style="padding:0 6px;">${divider()}${sectionTitle("Inbound activity")}</div>
    <table width="100%"><tr>
      ${miniCard("Appointments", appts, `Yesterday &middot; ${apptsMtd} MTD`)}
      ${miniCard("Unique leads", leads, `Yesterday &middot; ${leadsMtd} MTD`)}
      ${miniCard("Conversations", conv, `${call} call &middot; ${sms} sms &middot; ${chat} chat`)}
    </tr></table>
    <div style="padding:0 6px;">${sectionTitle("Channel breakdown")}${channelBar(call, sms, chat)}${legend(call, sms, chat)}
      <table width="100%" style="margin-top:14px;"><tr>
        <td valign="top" width="50%"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">After-hours</div><div style="font-size:13px;margin-top:3px;"><b>0</b> leads engaged &middot; <b>0</b> appts booked</div></td>
        <td valign="top" width="50%"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">Warm transfers</div><div style="font-size:13px;margin-top:3px;"><b>0</b> &middot; 0 MTD</div></td>
      </tr></table>
    </div>
  </td></tr>
  ${!isService ? `<tr><td style="padding:4px 22px;"><div style="padding:0 6px;">${divider()}${sectionTitle("Outbound activity")}</div><table width="100%"><tr>${miniCard("Unique reached", reached, "0 MTD")}${miniCard("Connect rate", "0%", "0% MTD")}${miniCard("Appointments set", 0, "0 MTD")}</tr></table></td></tr>` : ""}
  <tr><td style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;"><table width="100%"><tr>
    <td valign="top" style="font-size:11px;color:#9CA3AF;line-height:1.6;">Reporting period: ${esc(dateLabel)}<br/>Next report: Tomorrow 7:00 AM</td>
    <td valign="top" align="right" style="font-size:11px;color:#9CA3AF;"><a href="#" style="color:#9CA3AF;">Manage subscription</a><br/>&copy; Vini</td>
  </tr></table></td></tr>
</table></td></tr></table></body></html>`;
}

// ── CORS (tracker calls cron1 from the browser, cross-origin) ────────────────
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-mail-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/** Return a 204 preflight response for OPTIONS, else null. */
export const preflight = (req: Request): Response | null =>
  req.method === "OPTIONS" ? new Response("ok", { headers: CORS }) : null;

export const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
