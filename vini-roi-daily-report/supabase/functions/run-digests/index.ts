// ============================================================================
// run-digests — Supabase Edge Function (Deno)
// Replaces the entire Sails notification-service + Mongo. Triggered hourly by
// pg_cron. Reads config/recipients/live from Supabase, metrics from ClickHouse,
// renders the legacy digest HTML, sends via Resend (when dry_run=false), and
// records EVERY outcome to roi_digest_runs.
//
// Deploy:  supabase functions deploy run-digests
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLICKHOUSE_URL,
//          CLICKHOUSE_TOKEN, RESEND_API_KEY, RESEND_FROM
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CH_URL = Deno.env.get("CLICKHOUSE_URL")!;        // e.g. https://xxx.clickhouse.cloud:8443
const CH_TOKEN = Deno.env.get("CLICKHOUSE_TOKEN")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Vini <digests@spyne.ai>";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Dept = "sales" | "service";

// ── ClickHouse: run a SELECT, return rows ────────────────────────────────────
async function ch(sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(CH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${CH_TOKEN}`, "Content-Type": "text/plain" },
    body: `${sql} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? [];
}

// ── Dealer-local "yesterday" → UTC bounds 'YYYY-MM-DD HH:MM:SS' ───────────────
function fmt(d: Date) { return d.toISOString().slice(0, 19).replace("T", " "); }
function localToUTC(y: number, m: number, day: number, tz: string): Date {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(approx);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const localAsUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - localAsUTC.getTime()));
}
function dealerWindows(tz: string) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false }).formatToParts(now);
  const g = (t: string) => parseInt(parts.find((x) => x.type === t)?.value ?? "0");
  const Y = g("year"), M = g("month"), D = g("day"), H = g("hour") === 24 ? 0 : g("hour");
  const yStart = localToUTC(Y, M, D - 1, tz);
  const yEnd = new Date(localToUTC(Y, M, D, tz).getTime() - 1000);
  const localDate = `${Y}-${String(M).padStart(2, "0")}-${String(D - 1).padStart(2, "0")}`;
  return { localHour: H, yStart: fmt(yStart), yEnd: fmt(yEnd), localDate };
}

// ── Metrics for one (team, dept, yesterday) ─────────────────────────────────
async function metrics(teamId: string, dept: Dept, s: string, e: string) {
  const agent = dept; // 'sales' | 'service'
  const rows = await ch(`
    SELECT
      -- canonical: source='spyne' says we OWN the booking; meta.source='warm_transfer' rows are the
      -- customer's EXISTING appointments pulled in around a transfer — never counted as ours.
      (SELECT count() FROM dealer_leads.meetings WHERE team_id='${teamId}' AND service_type='${dept}' AND source='spyne' AND is_active=1 AND __deleted=0 AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer' AND created_at BETWEEN '${s}' AND '${e}') AS appts,
      (SELECT count(DISTINCT leadId) FROM dealer_leads.endcallreports WHERE teamId='${teamId}' AND isActive=1 AND isTestCall=0 AND lower(callDetails_agentInfo_agentType)='${agent}' AND callDetails_callType='inboundPhoneCall' AND __deleted=0 AND createdAt BETWEEN '${s}' AND '${e}') AS leads,
      (SELECT count() FROM dealer_leads.actionItems WHERE team_id='${teamId}' AND service_type='${dept}' AND is_active=1 AND __deleted=0 AND createdAt BETWEEN '${s}' AND '${e}') AS action,
      (SELECT countIf(c.type='call') FROM dealer_leads.conversations c INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId WHERE c.teamId='${teamId}' AND lower(at.agentType)='${agent}' AND ifNull(c.isTest,0)=0 AND c.__deleted=0 AND c.createdAt BETWEEN '${s}' AND '${e}') AS call,
      (SELECT countIf(c.type='sms') FROM dealer_leads.conversations c INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId WHERE c.teamId='${teamId}' AND lower(at.agentType)='${agent}' AND ifNull(c.isTest,0)=0 AND c.__deleted=0 AND c.createdAt BETWEEN '${s}' AND '${e}') AS sms,
      (SELECT countIf(c.type='chat') FROM dealer_leads.conversations c INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId WHERE c.teamId='${teamId}' AND lower(at.agentType)='${agent}' AND ifNull(c.isTest,0)=0 AND c.__deleted=0 AND c.createdAt BETWEEN '${s}' AND '${e}') AS chat`);
  const r = rows[0] ?? {};
  const num = (k: string) => parseInt(String(r[k] ?? 0), 10) || 0;
  const call = num("call"), sms = num("sms"), chat = num("chat");
  return {
    appointmentsYesterday: num("appts"),
    inboundUniqueLeads: num("leads"),
    actionItemsTotal: num("action"),
    conversationsCall: call, conversationsSms: sms, conversationsChat: chat,
    conversationsHandled: call + sms + chat,
  };
}

// ── Guardrails (port of validateDigestPayload core) ──────────────────────────
function guardrail(m: Record<string, number>): { ok: boolean; reason?: string } {
  const signal = m.appointmentsYesterday + m.conversationsHandled + m.inboundUniqueLeads + m.actionItemsTotal;
  if (signal === 0) return { ok: false, reason: "no_data" };
  if (m.appointmentsYesterday === 0 && m.actionItemsTotal === 0 && m.inboundUniqueLeads === 0)
    return { ok: false, reason: "not_actionable" };
  return { ok: true };
}

// ── Legacy "previous daily emailer" HTML (compact port) ──────────────────────
function esc(v: unknown) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function renderHtml(name: string, dept: Dept, dateLabel: string, m: Record<string, number>): string {
  const card = (label: string, val: number | string, sub: string) =>
    `<td width="50%" valign="top" style="padding:6px"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600">${esc(label)}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px">${esc(val)}</div><div style="font-size:12px;color:#6B7280;margin-top:6px">${esc(sub)}</div></div></td>`;
  return `<!doctype html><html><body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827"><table width="100%" style="background:#F3F4F6;padding:24px 0"><tr><td align="center"><table width="640" style="background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden">
  <tr><td style="padding:24px 28px 8px"><table width="100%"><tr><td><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4600F2;font-weight:700">Vini · Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px">${dept === "service" ? "Service" : "Sales"} Daily Digest</div></td><td align="right"><div style="font-size:13px;font-weight:700">${esc(name)}</div><div style="font-size:12px;color:#6B7280">${esc(dateLabel)}</div></td></tr></table></td></tr>
  <tr><td style="padding:8px 22px 0"><table width="100%"><tr>${card("Appointments yesterday", m.appointmentsYesterday, `${m.inboundUniqueLeads} inbound leads`)}${card("Conversations handled", m.conversationsHandled, `${m.conversationsCall} call · ${m.conversationsSms} sms · ${m.conversationsChat} chat`)}</tr></table></td></tr>
  <tr><td style="padding:18px 28px"><div style="border-top:1px solid #E5E7EB;padding-top:14px;font-size:13px;color:#374151"><b>${m.actionItemsTotal}</b> action item(s) to review</div><a href="#" style="display:inline-block;margin-top:14px;background:#4600F2;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:13px;font-weight:600">Open console</a></td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF">Reporting period: ${esc(dateLabel)} · Next report: tomorrow 7:00 AM</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Resend send ──────────────────────────────────────────────────────────────
async function sendEmail(to: string[], subject: string, html: string): Promise<string | null> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.id ?? null;
}

// ── Record one run ───────────────────────────────────────────────────────────
async function record(row: Record<string, unknown>) {
  await sb.from("roi_digest_runs").upsert(row, { onConflict: "team_id,department,cadence,local_date" });
}

// ── Main ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const bypass = url.searchParams.get("bypass") === "true"; // manual "send now"
  const onlyTeam = url.searchParams.get("team");            // optional single-team
  const summary = { processed: 0, sent: 0, suppressed: 0, not_sent: 0, scheduled: 0, errors: 0 };

  // 1 · Work-list from Supabase (live ⋈ config ⋈ recipients)
  let live = sb.from("roi_live_departments").select("team_id,enterprise_id,department,is_live,dry_run").eq("is_live", true);
  if (onlyTeam) live = live.eq("team_id", onlyTeam);
  const { data: liveRows, error: liveErr } = await live;
  if (liveErr) return new Response(JSON.stringify({ error: liveErr.message }), { status: 500 });

  const { data: cfgRows } = await sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,digest_send_hour,daily_enabled");
  const { data: recRows } = await sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled");
  const cfg = new Map((cfgRows ?? []).map((c) => [c.team_id, c]));
  const recByTeam = new Map<string, typeof recRows>();
  for (const r of recRows ?? []) { const a = recByTeam.get(r.team_id) ?? []; a.push(r); recByTeam.set(r.team_id, a); }

  for (const L of liveRows ?? []) {
    summary.processed++;
    const dept = L.department as Dept;
    const c = cfg.get(L.team_id);
    const tz = c?.timezone ?? "America/New_York";
    const name = c?.rooftop_name ?? L.team_id;
    const { localHour, yStart, yEnd, localDate } = dealerWindows(tz);
    const base = {
      enterprise_id: L.enterprise_id, team_id: L.team_id, department: dept,
      cadence: "daily", local_date: localDate, dealer_timezone: tz, trigger: bypass ? "manual" : "cron",
    };
    try {
      // Gate 1 — daily enabled
      if (c && c.daily_enabled === false) { continue; }
      // Gate 2 — send hour passed (unless bypass)
      if (!bypass && localHour < (c?.digest_send_hour ?? 7)) {
        await record({ ...base, status: "scheduled", reason: "before_send_hour" }); summary.scheduled++; continue;
      }
      // Gate 2b — already sent today
      const { data: sent } = await sb.from("roi_digest_runs").select("id")
        .eq("team_id", L.team_id).eq("department", dept).eq("cadence", "daily").eq("local_date", localDate).eq("status", "sent").maybeSingle();
      if (sent && !bypass) { continue; }
      // Gate 3 — recipients
      const recips = (recByTeam.get(L.team_id) ?? [])
        .filter((r) => (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled)
        .map((r) => r.email);
      if (!recips.length) { await record({ ...base, status: "not_sent", reason: "recipients_missing" }); summary.not_sent++; continue; }
      // Gate 4 — metrics + guardrails
      const m = await metrics(L.team_id, dept, yStart, yEnd);
      const g = guardrail(m);
      const dateLabel = new Date(yStart + "Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      const html = renderHtml(name, dept, dateLabel, m);
      const metricsJson = { ...m, reportDate: dateLabel };
      if (!g.ok) {
        await record({ ...base, status: "not_sent", reason: g.reason, metrics: metricsJson, rendered_html: html }); summary.not_sent++; continue;
      }
      // Gate 5 — dry_run
      const subject = `${dept === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
      if (L.dry_run !== false) {
        await record({ ...base, status: "suppressed", reason: "dry_run", metrics: metricsJson, rendered_html: html,
          recipients: recips.map((e) => ({ email: e, received: false })) });
        summary.suppressed++; continue;
      }
      // SEND
      const messageId = await sendEmail(recips, subject, html);
      await record({ ...base, status: "sent", subject, metrics: metricsJson, rendered_html: html, send_path: "raw_html",
        message_id: messageId, sent_at: new Date().toISOString(),
        recipients: recips.map((e) => ({ email: e, received: true })) });
      summary.sent++;
    } catch (err) {
      summary.errors++;
      await record({ ...base, status: "not_sent", reason: "mail_error", reason_detail: String(err).slice(0, 500) }).catch(() => {});
    }
  }

  return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
});
