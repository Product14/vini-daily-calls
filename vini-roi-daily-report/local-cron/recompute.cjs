#!/usr/bin/env node
/* One-off DATA FIX — recompute the corrected conversation + campaign numbers for every
 * stored roi_digest_runs row and patch metrics in place. Mirrors the corrected
 * db/clickhouse-endpoints/metabase-metrics.sql (conversations = INBOUND only) and
 * metabase-campaigns.sql (dials = ACTUAL outbound calls). Runs ClickHouse via the
 * mcp-clickhouse HTTP endpoint (same data source the Metabase questions use).
 *
 * After this, run `node runner.cjs --rerender` to regenerate rendered_html from the
 * patched metrics. NO emails are sent. Reads:
 *   ROI_SUPABASE_URL, ROI_SUPABASE_SERVICE_KEY   (Supabase service)
 *   CH_MCP_URL, CH_MCP_AUTH                       (ClickHouse MCP endpoint + Authorization)
 */
const { createClient } = require("@supabase/supabase-js");

const SB_URL = process.env.ROI_SUPABASE_URL, SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MCP_URL = process.env.CH_MCP_URL, MCP_AUTH = process.env.CH_MCP_AUTH;
if (!SB_URL || !SB_KEY) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
if (!MCP_URL || !MCP_AUTH) { console.error("Set CH_MCP_URL + CH_MCP_AUTH"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── dealer-local date → UTC window (identical to runner.cjs windowsForDate) ──
const fmtUTC = (d) => d.toISOString().slice(0, 19).replace("T", " ");
function localToUTC(y, m, day, tz) {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(approx);
  const g = (t) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - asUTC.getTime()));
}
function windowsForDate(localDate, tz) {
  const [y, m, d] = localDate.split("-").map(Number);
  const yStart = localToUTC(y, m, d, tz);
  const yEnd = new Date(localToUTC(y, m, d + 1, tz).getTime() - 1000);
  return { start: fmtUTC(yStart), end: fmtUTC(yEnd) };
}

// ── minimal MCP (streamable-HTTP) client for run_select_query ──
let SESSION = null, RID = 1;
async function mcpInit() {
  const res = await fetch(MCP_URL, { method: "POST", headers: { Authorization: MCP_AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: RID++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "roi-recompute", version: "1" } } }) });
  SESSION = res.headers.get("mcp-session-id");
  await res.text();
  await fetch(MCP_URL, { method: "POST", headers: { Authorization: MCP_AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": SESSION }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
}
function parseSSE(text) {
  // last `data: {…}` line carries the JSON-RPC response
  let out = null;
  for (const line of text.split("\n")) { const t = line.trim(); if (t.startsWith("data:")) { try { out = JSON.parse(t.slice(5).trim()); } catch { /* ignore */ } } }
  return out;
}
async function chQuery(sql, tries = 3) {
  if (!SESSION) await mcpInit();
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(MCP_URL, { method: "POST", headers: { Authorization: MCP_AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": SESSION },
        body: JSON.stringify({ jsonrpc: "2.0", id: RID++, method: "tools/call", params: { name: "run_select_query", arguments: { query: sql } } }) });
      if (res.status === 404 || res.status === 400) { SESSION = null; await mcpInit(); continue; }
      const msg = parseSSE(await res.text());
      const sc = msg?.result?.structuredContent;
      if (sc?.columns) return sc.rows.map((r) => Object.fromEntries(sc.columns.map((c, j) => [c, r[j]])));
      const txt = msg?.result?.content?.[0]?.text;
      if (txt) { const o = JSON.parse(txt); return o.rows.map((r) => Object.fromEntries(o.columns.map((c, j) => [c, r[j]]))); }
      if (msg?.error) throw new Error(JSON.stringify(msg.error).slice(0, 160));
      return [];
    } catch (e) { if (i === tries - 1) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
  return [];
}

// ── corrected queries (faithful to the updated .sql files) ──
const AT = (dept) => (dept === "service" ? "Service" : "Sales");
// TOTAL conversations (hero "Conversations handled") + INBOUND-only split (channel breakdown).
const convSQL = (team, dept, start, end) => `
SELECT
  uniqExactIf(c.conversationId, c.type='call') AS call_t,
  uniqExactIf(c.conversationId, c.type='sms')  AS sms_t,
  uniqExactIf(c.conversationId, c.type='chat') AS chat_t,
  uniqExactIf(c.conversationId, c.type='call' AND c.callData_callType='inboundPhoneCall') AS call_in,
  uniqExactIf(c.conversationId, c.type='sms'  AND ifNull(c.outboundTaskId,'')='' AND ifNull(c.campaignId,'')='') AS sms_in,
  uniqExactIf(c.conversationId, c.type='chat' AND ifNull(c.outboundTaskId,'')='' AND ifNull(c.campaignId,'')='') AS chat_in,
  uniqExactIf(c.conversationId, c.type='call' AND c.callData_callType='outboundPhoneCall') AS call_out,
  uniqExactIf(c.conversationId, c.type='sms'  AND (ifNull(c.outboundTaskId,'')!='' OR ifNull(c.campaignId,'')!='')) AS sms_out,
  uniqExactIf(c.conversationId, c.type='chat' AND (ifNull(c.outboundTaskId,'')!='' OR ifNull(c.campaignId,'')!='')) AS chat_out
FROM dealer_leads.conversations c
INNER JOIN dealer_leads.teamAgentMappings tam ON tam.teamAgentMappingId=c.teamAgentMappingId
INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId=tam.agentTypeId
WHERE c.teamId='${team}' AND at.agentType='${AT(dept)}' AND ifNull(c.isTest,0)=0
  AND c.createdAt BETWEEN '${start}' AND '${end}' AND c.__deleted=0`;
const campSQL = (team, dept, start, end) => `
WITH
  running AS (SELECT campaignId, name, createdAt FROM dealer_leads.campaigns
    WHERE teamId='${team}' AND campaignStatus='running' AND campaignType='${AT(dept)}' AND __deleted=0),
  dials AS (SELECT campaignId, count() AS dials FROM dealer_leads.endcallreports
    WHERE teamId='${team}' AND isActive=1 AND isTestCall=0 AND __deleted=0
      AND callDetails_callType='outboundPhoneCall' AND lower(callDetails_agentInfo_agentType)='${dept}'
      AND campaignId!='' AND createdAt BETWEEN '${start}' AND '${end}' GROUP BY campaignId),
  win_meetings AS (SELECT meeting_id, call_id FROM dealer_leads.meetings
    WHERE team_id='${team}' AND service_type='${dept}' AND source='spyne' AND is_active=1 AND __deleted=0
      -- canonical: meta.source='warm_transfer' rows are the customer's EXISTING appointments pulled in
      -- around a transfer — records we did not create, never an appointment this campaign booked.
      AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer'
      AND created_at BETWEEN '${start}' AND '${end}' AND call_id!=''),
  appts AS (SELECT ot.campaignId AS campaignId, count(DISTINCT m.meeting_id) AS appts
    FROM dealer_leads.outboundTasks ot INNER JOIN win_meetings m ON m.call_id=ot.callId
    WHERE ot.teamId='${team}' AND ot.callId!='' AND ot.__deleted=0 GROUP BY ot.campaignId)
SELECT if(trim(r.name)='', 'Unnamed campaign', trim(r.name)) AS name, ifNull(d.dials,0) AS dials, ifNull(a.appts,0) AS appts
FROM running r LEFT JOIN dials d ON d.campaignId=r.campaignId LEFT JOIN appts a ON a.campaignId=r.campaignId
ORDER BY r.createdAt DESC`;

const num = (v) => { const x = parseInt(String(v ?? 0), 10); return Number.isFinite(x) ? x : 0; };

async function main() {
  await mcpInit();
  console.log(`MCP session ${SESSION ? "ok" : "FAILED"}`);
  // pull all daily rows that carry metrics
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("roi_digest_runs")
      .select("team_id,department,cadence,local_date,dealer_timezone,metrics")
      .eq("cadence", "daily").not("metrics", "is", null)
      .order("local_date", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`rows to recompute: ${rows.length}`);

  const out = { patched: 0, convChanged: 0, campChanged: 0, errors: 0 };
  const POOL = 6; let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      try {
        const tz = r.dealer_timezone || "America/New_York";
        const { start, end } = windowsForDate(r.local_date, tz);
        const [cv] = await chQuery(convSQL(r.team_id, r.department, start, end));
        const camps = await chQuery(campSQL(r.team_id, r.department, start, end));
        const call = num(cv?.call_t), sms = num(cv?.sms_t), chat = num(cv?.chat_t);
        const callIn = num(cv?.call_in), smsIn = num(cv?.sms_in), chatIn = num(cv?.chat_in);
        const callOut = num(cv?.call_out), smsOut = num(cv?.sms_out), chatOut = num(cv?.chat_out);
        // drop campaigns with zero dials
        const campaigns = (camps || []).map((c) => { const dials = num(c.dials), appts = num(c.appts); return { name: c.name, dials, appts, conversion: dials > 0 ? `${((appts * 100) / dials).toFixed(1)}%` : "0%" }; }).filter((c) => c.dials > 0);
        const m = { ...(r.metrics || {}) };
        const beforeConv = `${m.conversationsCall}/${m.conversationsSms}/${m.conversationsChat}|${m.conversationsCallIn}/${m.conversationsSmsIn}/${m.conversationsChatIn}|${m.conversationsCallOut}/${m.conversationsSmsOut}/${m.conversationsChatOut}`;
        const beforeCamp = JSON.stringify(m.campaigns || []);
        m.conversationsCall = call; m.conversationsSms = sms; m.conversationsChat = chat; m.conversationsHandled = call + sms + chat;
        m.conversationsCallIn = callIn; m.conversationsSmsIn = smsIn; m.conversationsChatIn = chatIn;
        m.conversationsCallOut = callOut; m.conversationsSmsOut = smsOut; m.conversationsChatOut = chatOut;
        m.campaigns = campaigns;
        if (`${call}/${sms}/${chat}|${callIn}/${smsIn}/${chatIn}|${callOut}/${smsOut}/${chatOut}` !== beforeConv) out.convChanged++;
        if (JSON.stringify(campaigns) !== beforeCamp) out.campChanged++;
        const { error: ue } = await sb.from("roi_digest_runs").update({ metrics: m })
          .eq("team_id", r.team_id).eq("department", r.department).eq("cadence", "daily").eq("local_date", r.local_date);
        if (ue) { out.errors++; } else { out.patched++; }
      } catch (e) { out.errors++; if (out.errors <= 8) console.log(`  ✗ ${r.team_id} ${r.department} ${r.local_date}: ${String(e).slice(0, 120)}`); }
      if (out.patched % 100 === 0 && out.patched) console.log(`  …${out.patched} patched`);
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  console.log("recompute summary:", JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });
